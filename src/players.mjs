import fs from 'node:fs'
import path from 'node:path'

import { readProps, writeProps } from './props.mjs'
import { fail, writeJson, withLock } from './util.mjs'
import { offlineUuid } from './client-auth.mjs'
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
// A name read from the server's files goes into a console command as it is, so one that would
// be read as something else is refused: "@a" is everyone, and a space starts the next argument.
// Not held to Mojang's alphabet, because a Bedrock player's name through Floodgate starts with a dot.
function requireName(who, verb) {
  if (who.name) {
    if (/^@|[\s\u0000-\u001f\u007f]/.test(who.name)) fail(`"${who.name}" is not a name the server's console can take, so ${verb} has to be done with the server stopped.`)
    return who.name
  }
  fail(
    `SpawnLoft does not know the name behind ${who.uuid}, and ${verb} needs one. Offline-mode ids are `
      + 'made by hashing a name, so they cannot be turned back into one - have the player join '
      + 'once while the server is running, or add them by name with "Add a player".',
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

/**
 * Whether one of the server's own lists names this player now.
 *
 * Asked after a console command, because the console's answer is a sentence and not a result:
 * "That player does not exist" comes back the same way "Made Steve a server operator" does. The
 * server writes the list before it answers, so the file is the result. Matched by name as well as
 * id, since an offline-mode server files the same person under an id of its own making.
 */
function listed(dir, file, who) {
  const name = String(who.name || '').toLowerCase()
  return readList(dir, file).some((r) =>
    String(r.uuid).toLowerCase() === who.uuid || (name && String(r.name || '').toLowerCase() === name))
}

// `running` and `exec` are the server's state and its console, named so a test can stand in for both.
export async function setOp(inst, uuid, on, opts) {
  return applyOp(inst, findPlayer(inst, uuid), on, opts)
}

// `who` is { uuid, name }: someone the server has a record of, or someone just looked up by name
async function applyOp(inst, who, on, { running = supervisor.isRunning(inst.name), exec = rconExec } = {}) {
  if (running) {
    const name = requireName(who, on ? 'opping' : 'deopping')
    const [reply] = await exec(inst, [`${on ? 'op' : 'deop'} ${name}`])
    return { uuid: who.uuid, op: on, via: 'console', reply: stripColors(reply || '').trim(), took: listed(inst.dir, OPS, who) === on }
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

export async function setBan(inst, uuid, on, reason, opts) {
  return applyBan(inst, findPlayer(inst, uuid), on, reason, opts)
}

async function applyBan(inst, who, on, reason, { running = supervisor.isRunning(inst.name), exec = rconExec } = {}) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (running) {
    const name = requireName(who, on ? 'banning' : 'pardoning')
    // banning a connected player also kicks them
    const cmd = on ? `ban ${name}${why ? ' ' + why : ''}` : `pardon ${name}`
    const [reply] = await exec(inst, [cmd])
    return { uuid: who.uuid, banned: on, via: 'console', reply: stripColors(reply || '').trim(), took: listed(inst.dir, BANNED, who) === on }
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

// On or off the whitelist. Being on it only matters while the whitelist itself is on (below).
export async function setWhitelisted(inst, uuid, on, opts) {
  return applyWhitelist(inst, findPlayer(inst, uuid), on, opts)
}

async function applyWhitelist(inst, who, on, { running = supervisor.isRunning(inst.name), exec = rconExec } = {}) {
  if (running) {
    const name = requireName(who, on ? 'whitelisting' : 'taking someone off the whitelist')
    const [reply] = await exec(inst, [`whitelist ${on ? 'add' : 'remove'} ${name}`])
    return { uuid: who.uuid, whitelisted: on, via: 'console', reply: stripColors(reply || '').trim(), took: listed(inst.dir, WHITELIST, who) === on }
  }
  updateList(inst.dir, WHITELIST, (rows) => {
    const filtered = rows.filter((r) => String(r.uuid).toLowerCase() !== who.uuid)
    if (on) filtered.push({ uuid: who.uuid, name: who.name || '' })
    return filtered
  })
  return { uuid: who.uuid, whitelisted: on, via: 'file' }
}

const propsFile = (inst) => path.join(inst.dir, 'server.properties')

/** Whether only listed players can join. */
export function whitelistOn(inst) {
  return readProps(propsFile(inst)).get('white-list') === 'true'
}

/** Whether turning the whitelist on also removes people who are connected and not on it. */
export function whitelistEnforced(inst) {
  return readProps(propsFile(inst)).get('enforce-whitelist') === 'true'
}

// The switch itself. A running server is told, and the file is written as well once it says it
// did: Paper turns the whitelist on or off in memory and leaves server.properties as it was, so
// the change was gone at the next start and this page went on showing the old state. A stopped
// server has only the file. `enforce-whitelist` is left as it is: it decides whether people
// already connected are removed, which is the owner's call in Settings.
export async function setWhitelistOn(inst, on, { running = supervisor.isRunning(inst.name), exec = rconExec } = {}) {
  if (running) {
    const [raw] = await exec(inst, [`whitelist ${on ? 'on' : 'off'}`])
    const reply = stripColors(raw || '').trim()
    // "Whitelist is now turned on", or "Whitelist is already turned on": both are the state asked for
    const took = new RegExp(`(now|already) turned ${on ? 'on' : 'off'}`, 'i').test(reply)
    if (took) writeProps(propsFile(inst), { 'white-list': on ? 'true' : 'false' })
    return { on, via: 'console', reply, took }
  }
  writeProps(propsFile(inst), { 'white-list': on ? 'true' : 'false' })
  return { on, via: 'file' }
}

// What a player name can be. Mojang's own are 3 to 16 of these; older accounts and offline-mode
// servers have shorter ones, so only the characters and the upper length are held to.
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/
const ADD_AS = ['whitelist', 'op', 'ban']

/**
 * Mojang's public answer to "whose name is this": { uuid, name } with the name as the account
 * spells it, or null when no account has it. Only the name typed is sent.
 */
export async function mojangLookup(name, { fetchImpl = fetch } = {}) {
  // a redirect would be a second place contacted, and nothing but Mojang is to be
  const res = await fetchImpl(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000), redirect: 'error' })
  if (res.status === 204 || res.status === 404) return null
  if (!res.ok) throw new Error(`Mojang answered ${res.status}`)
  const unreadable = () => new Error('Mojang sent an answer SpawnLoft could not read')
  let body
  try { body = await res.json() } catch { throw unreadable() }
  if (!body || typeof body !== 'object') throw unreadable()
  const hex = String(body.id || '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw unreadable()
  // the name is kept in the server's files and later typed into its console: it has to be the
  // name asked for, in the account's own capitals, and nothing else
  const spelled = body.name === undefined ? name : String(body.name)
  if (!PLAYER_NAME.test(spelled) || spelled.toLowerCase() !== String(name).toLowerCase()) throw unreadable()
  return { uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, name: spelled }
}

/**
 * Whitelist, op or ban someone by name, whether or not they have ever joined.
 *
 * A running server is told the name and finds the player itself, as it does for a command typed
 * in its console. A stopped one cannot: on a server that checks accounts the name is looked up
 * with Mojang, and on one that does not the id is the one such a server makes from the name.
 */
export async function addByName(inst, rawName, as, { reason, running = supervisor.isRunning(inst.name), exec = rconExec, lookup = mojangLookup } = {}) {
  const name = String(rawName ?? '').trim()
  if (!PLAYER_NAME.test(name)) fail('A player name is up to 16 letters, digits or underscores, with no spaces.')
  if (!ADD_AS.includes(as)) fail(`unknown way to add a player: ${as}`)
  const apply = (who, opts) => (as === 'whitelist' ? applyWhitelist(inst, who, true, opts)
    : as === 'op' ? applyOp(inst, who, true, opts)
      : applyBan(inst, who, true, reason, opts))

  // Someone the server already knows keeps the id it knows them by, as long as it is the kind
  // of id this server gives out now. After a switch between checking accounts and not, the old
  // record's id is one nobody will join with again, and adding it would add nobody.
  const checksAccounts = readProps(propsFile(inst)).get('online-mode') !== 'false'
  const fits = (p) => running || p.uuid.charAt(14) === (checksAccounts ? '4' : '3')
  const known = listPlayers(inst).find((p) => (p.name || '').toLowerCase() === name.toLowerCase() && fits(p))
  let who = known ? { uuid: known.uuid, name: known.name } : null
  if (!who && running) who = { uuid: '', name }
  if (!who) {
    if (!checksAccounts) who = { uuid: offlineUuid(name), name }
    else {
      let found
      try {
        found = await lookup(name)
      } catch (err) {
        fail(`Could not look up "${name}" with Mojang (${err?.message ?? err}). Check the connection, or start the server and add them again: a running server finds players itself.`)
      }
      if (!found) fail(`No Minecraft account is called "${name}". Check the spelling.`)
      who = found
    }
  }
  const out = await apply(who, { running, exec })
  return { ...out, name: who.name, as }
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
