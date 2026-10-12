import fs from 'node:fs'
import path from 'node:path'

import { readProps } from './props.mjs'
import { fail, writeJson, withLock } from './util.mjs'
import { rconExec, stripColors } from './rcon.mjs'
import * as supervisor from './supervisor.mjs'

// Players a server knows about. Minecraft stores one <uuid>.dat per joined player; the UUID is
// v4 online and v3 (a hash of the name) offline, which is how the two are told apart. Turning on
// online mode for a world with offline players gives everyone a new identity, hence the warning.

// the version digit is the first character of the UUID's third group; .dat is player state,
// .json is stats and advancements
const UUID_FILE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f])([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})\.(dat|json)$/i

// Where a joined player may have left files. Older layouts use <level>/playerdata, stats and
// advancements; Paper 26.2 puts them under <level>/players/ and nests nether/end in dimensions/.
// All are unioned by UUID: the question is whether the world has seen the player, not whether a .dat exists.
function playerDirs(instDir, level) {
  return [
    path.join(instDir, level, 'players', 'data'),
    path.join(instDir, level, 'players', 'stats'),
    path.join(instDir, level, 'players', 'advancements'),
    path.join(instDir, level, 'playerdata'),
    path.join(instDir, level, 'stats'),
    path.join(instDir, level, 'advancements'),
  ]
}

// the nil UUID is written for the console and singleplayer conversions; it is not a person
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

// none of these is a complete list on its own
const OPS = 'ops.json'
const BANNED = 'banned-players.json'
const WHITELIST = 'whitelist.json'
const USERCACHE = 'usercache.json'

function readList(dir, file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // absent is normal, and a half-written file mid-save is picked up on the next read
    return []
  }
}

function writeList(dir, file, rows) {
  // atomic write: a half-written file reads back as empty, which looks like nobody is opped/banned/whitelisted
  writeJson(path.join(dir, file), rows)
}

// Read-modify-write under a lock, so two concurrent changes (panel and CLI) can't undo each other.
function updateList(dir, file, mutate) {
  return withLock(path.join(dir, `${file}.lock`), () => {
    const rows = mutate(readList(dir, file))
    writeList(dir, file, rows)
    return rows
  })
}

// Union of ops, bans, whitelist, usercache and the world's player files, keyed by UUID (the only id
// they share). Names can be missing: an offline UUID is a hash of a name, not reversible.
export function listPlayers(inst) {
  const dir = inst.dir
  const props = readProps(path.join(dir, 'server.properties'))
  const level = props.get('level-name') || 'world'

  const people = new Map()
  const at = (uuid) => {
    const key = String(uuid || '').toLowerCase()
    if (!key || key === NIL_UUID) return null
    if (!people.has(key)) {
      people.set(key, {
        uuid: key,
        name: null,
        op: false,
        opLevel: null,
        banned: false,
        banReason: null,
        banSource: null,
        banExpires: null,
        whitelisted: false,
        joined: false,
        lastSeen: null,
      })
    }
    return people.get(key)
  }

  for (const row of readList(dir, OPS)) {
    const p = at(row.uuid)
    if (!p) continue
    p.op = true
    p.opLevel = Number.isInteger(row.level) ? row.level : null
    if (row.name) p.name = row.name
  }
  for (const row of readList(dir, BANNED)) {
    const p = at(row.uuid)
    if (!p) continue
    p.banned = true
    p.banReason = row.reason || null
    p.banSource = row.source || null
    // "forever" is Minecraft's marker for a permanent ban, not a date
    p.banExpires = row.expires && row.expires !== 'forever' ? row.expires : null
    if (row.name) p.name = row.name
  }
  for (const row of readList(dir, WHITELIST)) {
    const p = at(row.uuid)
    if (!p) continue
    p.whitelisted = true
    if (row.name) p.name = row.name
  }
  // last so the cache wins: it holds the most recently resolved name, which matters after a rename
  for (const row of readList(dir, USERCACHE)) {
    const p = at(row.uuid)
    if (!p) continue
    if (row.name) p.name = row.name
  }

  for (const d of playerDirs(dir, level)) {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const m = UUID_FILE.exec(entry.name)
      if (!m) continue
      const p = at(entry.name.slice(0, 36))
      if (!p) continue
      p.joined = true
      try {
        const seen = fs.statSync(path.join(d, entry.name)).mtime.toISOString()
        if (!p.lastSeen || seen > p.lastSeen) p.lastSeen = seen
      } catch {
        /* file vanished between listing and stat; it still counts as joined */
      }
    }
  }

  return [...people.values()].sort((a, b) => {
    // named before nameless, then alphabetical
    if (Boolean(a.name) !== Boolean(b.name)) return a.name ? -1 : 1
    return (a.name || a.uuid).localeCompare(b.name || b.uuid)
  })
}

// A running server keeps ops, bans and the whitelist in memory and overwrites the files, so while
// it runs changes go through RCON; a stopped server has only the files. Decided here so the panel
// can't report "opped" and have the next start disagree.

// ban entries record who did it; the server itself writes "Server"
const BAN_SOURCE = 'mcctl'

function findPlayer(inst, uuid) {
  const who = listPlayers(inst).find((p) => p.uuid === String(uuid).toLowerCase())
  if (!who) fail(`"${inst.name}" has no record of a player with that id`)
  return who
}

// A console command needs a name, and an offline UUID can't be turned back into one.
function requireName(who, verb) {
  if (who.name) return who.name
  fail(
    `SpawnLoft does not know the name behind ${who.uuid}, and ${verb} needs one. Offline-mode ids are `
      + 'made by hashing a name, so they cannot be turned back into one - have the player join '
      + 'once while the server is running, or type the name in yourself.',
  )
}

// Nothing on disk says who is connected (a .dat is written on logout or world save), so ask the
// server. Failure returns an empty list rather than breaking the page.
export async function onlineNow(inst) {
  if (!supervisor.isRunning(inst.name)) return []
  try {
    const [reply] = await rconExec(inst, ['list'])
    // "There are 1 of a max of 10 players online: Wunga_"; with nobody on, the same sentence ends at the colon
    const after = stripColors(reply || '').split(':').slice(1).join(':')
    return after.split(',').map((n) => n.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function setOp(inst, uuid, on) {
  const who = findPlayer(inst, uuid)
  if (supervisor.isRunning(inst.name)) {
    const name = requireName(who, on ? 'opping' : 'deopping')
    const [reply] = await rconExec(inst, [`${on ? 'op' : 'deop'} ${name}`])
    return { uuid: who.uuid, op: on, via: 'console', reply: stripColors(reply || '').trim() }
  }
  updateList(inst.dir, OPS, (rows) => {
    const filtered = rows.filter((r) => String(r.uuid).toLowerCase() !== who.uuid)
    if (on) {
      filtered.push({
        uuid: who.uuid,
        name: who.name || '',
        // level 4 is what the op command grants; lower levels can't be created from the console
        level: 4,
        bypassesPlayerLimit: false,
      })
    }
    return filtered
  })
  return { uuid: who.uuid, op: on, via: 'file' }
}

export async function setBan(inst, uuid, on, reason) {
  const who = findPlayer(inst, uuid)
  const why = String(reason || '').trim().slice(0, 200)
  if (supervisor.isRunning(inst.name)) {
    const name = requireName(who, on ? 'banning' : 'pardoning')
    // banning a connected player also kicks them
    const cmd = on ? `ban ${name}${why ? ' ' + why : ''}` : `pardon ${name}`
    const [reply] = await rconExec(inst, [cmd])
    return { uuid: who.uuid, banned: on, via: 'console', reply: stripColors(reply || '').trim() }
  }
  updateList(inst.dir, BANNED, (rows) => {
    const filtered = rows.filter((r) => String(r.uuid).toLowerCase() !== who.uuid)
    if (on) {
      filtered.push({
        uuid: who.uuid,
        name: who.name || '',
        // Minecraft's own timestamp format, so the server can read it back
        created: banStamp(new Date()),
        source: BAN_SOURCE,
        expires: 'forever',
        reason: why || 'Banned by an operator.',
      })
    }
    return filtered
  })
  return { uuid: who.uuid, banned: on, via: 'file' }
}

// ban timestamps look like 2026-08-30 18:41:07 -0500, not ISO
function banStamp(d) {
  const two = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} `
    + `${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`
}

// Deletes a player's inventory, position, stats and advancements. Refused while the server runs,
// since it writes player state back on logout. Ops, bans and the whitelist are left alone so
// wiping a banned player doesn't unban them.
export function forgetPlayer(inst, uuid) {
  if (supervisor.isRunning(inst.name)) {
    fail(
      `"${inst.name}" is running. Stop it before deleting player data - a running server holds `
        + 'that player\'s state in memory and writes it back over whatever is deleted.',
    )
  }
  const who = findPlayer(inst, uuid)
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const level = props.get('level-name') || 'world'
  const removed = []
  for (const d of playerDirs(inst.dir, level)) {
    let entries
    try {
      entries = fs.readdirSync(d)
    } catch {
      continue
    }
    for (const entry of entries) {
      // also matches .dat_old, the previous save, which could otherwise be restored
      if (!entry.toLowerCase().startsWith(who.uuid)) continue
      fs.rmSync(path.join(d, entry), { force: true })
      removed.push(path.join(path.basename(path.dirname(d)), path.basename(d), entry))
    }
  }
  return { uuid: who.uuid, name: who.name, removed: removed.length, files: removed }
}

export function storedPlayers(instDir) {
  const props = readProps(path.join(instDir, 'server.properties'))
  const level = props.get('level-name') || 'world'

  // keyed by UUID: one player appears in several of these directories
  const seen = new Map()
  for (const dir of playerDirs(instDir, level)) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      // absent is normal
      continue
    }
    for (const entry of entries) {
      const m = UUID_FILE.exec(entry)
      if (!m) continue
      seen.set(entry.slice(0, 36).toLowerCase(), m[3].toLowerCase())
    }
  }

  let offline = 0
  let online = 0
  let unknown = 0
  for (const version of seen.values()) {
    if (version === '3') offline++
    else if (version === '4') online++
    else unknown++
  }
  return { count: seen.size, offline, online, unknown }
}
