// The game's own Multiplayer list (servers.dat in a profile's folder), kept in step with the
// SpawnLoft servers on the profile's version, so a game opened on the title screen still shows
// them. The file is the player's: every entry SpawnLoft did not write stays as it is, byte for
// byte, and an entry SpawnLoft wrote that the player then edited or deleted is theirs from then
// on. A file that cannot be read whole is never written.
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson } from './util.mjs'

// ---- NBT, as the game writes servers.dat: uncompressed, big-endian --------------------------
// A tag is { type, ... }. Strings and compound keys keep their bytes (Java's modified UTF-8), and
// arrays keep their payload, so what is not touched is written back exactly as it was read.

const END = 0, BYTE = 1, SHORT = 2, INT = 3, LONG = 4, FLOAT = 5, DOUBLE = 6, BYTES = 7, STRING = 8, LIST = 9, COMPOUND = 10, INTS = 11, LONGS = 12
const FIXED = { [BYTE]: 1, [SHORT]: 2, [INT]: 4, [LONG]: 8, [FLOAT]: 4, [DOUBLE]: 8 }
const ARRAY_UNIT = { [BYTES]: 1, [INTS]: 4, [LONGS]: 8 }
const MAX_DEPTH = 64
// the game's own list, icons included, is a few hundred KB at most
export const MAX_SERVERS_DAT = 16 * 1024 * 1024

class NbtError extends Error {}

export function readNbt(buf) {
  let at = 0
  const need = (n) => { if (n < 0 || at + n > buf.length) throw new NbtError('the file ends in the middle of a tag') }
  const take = (n) => { need(n); const out = buf.subarray(at, at + n); at += n; return out }
  const u16 = () => { need(2); const v = buf.readUInt16BE(at); at += 2; return v }
  const i32 = () => { need(4); const v = buf.readInt32BE(at); at += 4; return v }
  const payload = (type, depth) => {
    if (depth > MAX_DEPTH) throw new NbtError('tags nested too deep')
    if (FIXED[type]) return { type, raw: take(FIXED[type]) }
    if (ARRAY_UNIT[type]) { const n = i32(); return { type, count: n, raw: take(n * ARRAY_UNIT[type]) } }
    if (type === STRING) return { type, raw: take(u16()) }
    if (type === LIST) {
      const of = take(1)[0]
      const n = i32()
      if (n < 0 || (n > 0 && of === END)) throw new NbtError('a list of nothing with items in it')
      const items = []
      for (let i = 0; i < n; i++) items.push(payload(of, depth + 1))
      return { type, of, items }
    }
    if (type === COMPOUND) {
      const entries = []
      for (;;) {
        const t = take(1)[0]
        if (t === END) break
        const key = take(u16())
        entries.push({ key, tag: payload(t, depth + 1) })
      }
      return { type, entries }
    }
    throw new NbtError(`unknown tag type ${type}`)
  }
  const type = take(1)[0]
  if (type !== COMPOUND) throw new NbtError('not an NBT file (it does not start with a compound tag)')
  const name = take(u16())
  const root = payload(COMPOUND, 0)
  if (at !== buf.length) throw new NbtError('bytes left over after the last tag')
  return { name, root }
}

export function writeNbt({ name, root }) {
  const parts = []
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); parts.push(b) }
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b) }
  const payload = (tag) => {
    if (FIXED[tag.type]) parts.push(tag.raw)
    else if (ARRAY_UNIT[tag.type]) { i32(tag.count); parts.push(tag.raw) }
    else if (tag.type === STRING) { u16(tag.raw.length); parts.push(tag.raw) }
    else if (tag.type === LIST) {
      parts.push(Buffer.from([tag.of]))
      i32(tag.items.length)
      for (const item of tag.items) payload(item)
    } else if (tag.type === COMPOUND) {
      for (const { key, tag: child } of tag.entries) {
        parts.push(Buffer.from([child.type]))
        u16(key.length)
        parts.push(key)
        payload(child)
      }
      parts.push(Buffer.from([END]))
    } else throw new NbtError(`unknown tag type ${tag.type}`)
  }
  parts.push(Buffer.from([COMPOUND]))
  u16(name.length)
  parts.push(name)
  payload(root)
  return Buffer.concat(parts)
}

// Java's modified UTF-8: one UTF-16 unit at a time (so a character outside the basic plane is two
// three-byte halves), and U+0000 as two bytes.
export function mutf8(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0x01 && c <= 0x7f) out.push(c)
    else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return Buffer.from(out)
}

export function fromMutf8(raw) {
  let out = ''
  for (let i = 0; i < raw.length;) {
    const a = raw[i]
    if (a < 0x80) { out += String.fromCharCode(a); i += 1 }
    else if ((a & 0xe0) === 0xc0 && i + 1 < raw.length) { out += String.fromCharCode(((a & 0x1f) << 6) | (raw[i + 1] & 0x3f)); i += 2 }
    else if ((a & 0xf0) === 0xe0 && i + 2 < raw.length) { out += String.fromCharCode(((a & 0x0f) << 12) | ((raw[i + 1] & 0x3f) << 6) | (raw[i + 2] & 0x3f)); i += 3 }
    else { out += '�'; i += 1 }
  }
  return out
}

const stringTag = (text) => ({ type: STRING, raw: mutf8(text) })
const child = (compound, key) => compound.entries.find((e) => fromMutf8(e.key) === key)?.tag ?? null
const text = (compound, key) => { const t = child(compound, key); return t?.type === STRING ? fromMutf8(t.raw) : null }
function setText(compound, key, value) {
  const at = compound.entries.findIndex((e) => fromMutf8(e.key) === key)
  if (at === -1) compound.entries.push({ key: mutf8(key), tag: stringTag(value) })
  else compound.entries[at] = { key: compound.entries[at].key, tag: stringTag(value) }
}

// ---- the list itself -------------------------------------------------------------------------

// Two spellings of one place: the port the game assumes, and this machine by either name.
export function addressKey(ip) {
  const raw = String(ip ?? '').trim().toLowerCase()
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw)
  let host = raw
  let port = '25565'
  if (v6) { host = v6[1]; port = v6[2] ?? port } else if (raw.split(':').length === 2) { [host, port] = raw.split(':') }
  if (host === 'localhost' || host === '::1') host = '127.0.0.1'
  return `${host.replace(/\.$/, '')}:${Number(port) || port}`
}

// An address typed into "Direct Connection" is kept in the file but is not on the list.
const hidden = (entry) => { const t = child(entry, 'hidden'); return t?.type === BYTE && t.raw[0] !== 0 }

/**
 * Brings the list in step with `wanted` ([{ key, name, ip }], key = the SpawnLoft server's name).
 * `entries` is the file's list (changed in place); `state` is what SpawnLoft remembers having
 * written ({ [key]: { ip, name, state } }, state 'ours' | 'theirs' | 'dismissed').
 * Returns the state to remember and what was done.
 */
export function reconcile(entries, state, wanted) {
  const want = new Map(wanted.map((w) => [w.key, w]))
  const next = {}
  const did = { added: 0, updated: 0, removed: 0 }
  const shown = () => entries.filter((e) => e.type === COMPOUND && !hidden(e))
  for (const [key, was] of Object.entries(state ?? {})) {
    const w = want.get(key)
    if (was?.state === 'ours') {
      const mine = shown().find((e) => text(e, 'ip') === was.ip && text(e, 'name') === was.name)
      if (!mine) {
        // edited in the game, or deleted there: the player's call either way, and not undone
        if (w) next[key] = { ip: w.ip, name: w.name, state: shown().some((e) => addressKey(text(e, 'ip')) === addressKey(was.ip)) ? 'theirs' : 'dismissed' }
        continue
      }
      if (!w) {
        entries.splice(entries.indexOf(mine), 1)
        did.removed++
        continue
      }
      if (w.ip !== was.ip || w.name !== was.name) {
        setText(mine, 'name', w.name)
        setText(mine, 'ip', w.ip)
        did.updated++
      }
      next[key] = { ip: w.ip, name: w.name, state: 'ours' }
    } else if (w && was && addressKey(w.ip) === addressKey(was.ip)) {
      // theirs or dismissed stays so while the server stays where it was
      next[key] = { ip: was.ip, name: was.name, state: was.state === 'theirs' ? 'theirs' : 'dismissed' }
    }
  }
  for (const w of wanted) {
    if (next[w.key]) continue
    if (shown().some((e) => addressKey(text(e, 'ip')) === addressKey(w.ip))) {
      // the player already lists this address under a name of their own
      next[w.key] = { ip: w.ip, name: w.name, state: 'theirs' }
      continue
    }
    entries.push({ type: COMPOUND, entries: [{ key: mutf8('name'), tag: stringTag(w.name) }, { key: mutf8('ip'), tag: stringTag(w.ip) }] })
    next[w.key] = { ip: w.ip, name: w.name, state: 'ours' }
    did.added++
  }
  return { next, ...did, changed: did.added + did.updated + did.removed > 0 }
}

function emptyFile() {
  return { name: Buffer.alloc(0), root: { type: COMPOUND, entries: [{ key: mutf8('servers'), tag: { type: LIST, of: COMPOUND, items: [] } }] } }
}

/**
 * Reads `file` (servers.dat), reconciles it with `wanted`, and writes it back only if something
 * changed. `stateFile` is where what SpawnLoft wrote is remembered. Never throws for a file it
 * cannot use: that is { skipped: reason } and the file is left alone.
 */
export function syncServerList({ file, stateFile, wanted }) {
  const state = readJson(stateFile, null)?.entries ?? {}
  // nothing to add and nothing of ours in the file: not a file to open at all
  if (!wanted.length && !Object.keys(state).length) return { changed: false, added: 0, updated: 0, removed: 0, skipped: null }
  let doc
  let stat = null
  try { stat = fs.statSync(file) } catch { /* no list yet */ }
  if (!stat) doc = emptyFile()
  else {
    if (!stat.isFile() || stat.size > MAX_SERVERS_DAT) return { changed: false, skipped: 'servers.dat is not a file SpawnLoft can read' }
    try {
      doc = readNbt(fs.readFileSync(file))
    } catch (err) {
      return { changed: false, skipped: `servers.dat could not be read (${err.message})` }
    }
  }
  let list = child(doc.root, 'servers')
  if (!list) {
    list = { type: LIST, of: COMPOUND, items: [] }
    doc.root.entries.push({ key: mutf8('servers'), tag: list })
  }
  if (list.type !== LIST || (list.items.length && list.of !== COMPOUND)) return { changed: false, skipped: 'servers.dat does not hold a list of servers' }
  list.of = COMPOUND
  const out = reconcile(list.items, state, wanted)
  if (out.changed) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.spawnloft.tmp`
      fs.writeFileSync(tmp, writeNbt(doc))
      fs.renameSync(tmp, file)
    } catch (err) {
      return { changed: false, skipped: `servers.dat could not be written (${err.message})` }
    }
  }
  if (Object.keys(out.next).length) writeJson(stateFile, { version: 1, entries: out.next })
  else fs.rmSync(stateFile, { force: true })
  return { changed: out.changed, added: out.added, updated: out.updated, removed: out.removed, skipped: null }
}

// The file has had this shape since the multiplayer list was reworked for 1.7; older games are
// left alone rather than guessed at.
export const SERVER_LIST_SINCE = Date.parse('2013-10-22T00:00:00Z')
export function versionKeepsServerList(version) {
  const at = Date.parse(version?.releaseTime ?? '')
  return Number.isFinite(at) && at >= SERVER_LIST_SINCE
}
