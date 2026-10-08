import fs from 'node:fs'
import path from 'node:path'

import { readProps } from './props.mjs'
import { fail, writeJson, withLock } from './util.mjs'
import { rconExec, stripColors } from './rcon.mjs'
import * as supervisor from './supervisor.mjs'

/**
 * Who a world already knows about, and under which kind of identity.
 *
 * <p>Minecraft stores one `<uuid>.dat` per player who has joined, and the UUID it uses depends on
 * whether the server was in online mode at the time:
 *
 * <ul>
 *   <li><b>Online</b> - the account's real Mojang UUID, which is a random (version 4) UUID.</li>
 *   <li><b>Offline</b> - a UUID derived from the player's name by hashing it, which is a
 *       name-based (version 3) UUID.</li>
 * </ul>
 *
 * <p>The version is the first hex digit of a UUID's third group, so the two are told apart by
 * reading the filename. That distinction is the whole reason this exists: turning online mode on
 * for a world that has offline players in it does not migrate them, it gives everyone a different
 * identity. Permissions, homes, inventories and anything else a plugin keyed by UUID stay attached
 * to the old one, and the same person joins as a stranger.
 *
 * <p>Worth a warning before the switch rather than a support question after it.
 */

// The version digit is the first character of a UUID's third group. The extension varies by which
// directory the file came from - .dat for saved player state, .json for stats and advancements.
const UUID_FILE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f])([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})\.(dat|json)$/i

/**
 * Every directory a joined player might have left a file in.
 *
 * <p>Minecraft moved these. Up to and including the classic layout a server kept
 * `<level>/playerdata/<uuid>.dat` with `stats` and `advancements` as siblings; Paper 26.2 keeps all
 * three under `<level>/players/`, and nests the nether and the end inside `<level>/dimensions/`
 * rather than as `<level>_nether` beside it. Looking only in the old place is how the first version
 * of this reported zero players for a world that had one - and the online-mode warning it feeds
 * therefore never appeared.
 *
 * <p>All of them are read and unioned by UUID rather than picking a layout, because both exist in
 * the wild, and because a player who has joined but whose state has not been written yet still has
 * a stats file. The question being answered is "has this world seen this player", not "is there a
 * .dat".
 */
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

/**
 * The nil UUID. Minecraft writes a player file under it for the console and for singleplayer
 * conversions; it is not a person, and listing it as one has people trying to ban nobody.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** The four files a server keeps its people in, none of which is a complete list on its own. */
const OPS = 'ops.json'
const BANNED = 'banned-players.json'
const WHITELIST = 'whitelist.json'
const USERCACHE = 'usercache.json'

function readList(dir, file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Absent is normal on a server nobody has joined, and a half-written file during a save is
    // not worth failing a screen over - the next read gets it.
    return []
  }
}

function writeList(dir, file, rows) {
  // Atomic (temp file + rename): the panel and the CLI can both reach for this file, and a crash
  // mid-write must never leave ops.json / banned-players.json / whitelist.json half-written - that
  // reads back as empty, which is indistinguishable from "nobody is opped/banned/whitelisted".
  writeJson(path.join(dir, file), rows)
}

/**
 * Read, change, and write back one of the four files, as a single step a concurrent call cannot
 * land in the middle of. Without this, the panel and the CLI changing two different players at
 * the same moment can each read before the other writes, and the second write silently undoes the
 * first - no error, just one ban or op that never took.
 */
function updateList(dir, file, mutate) {
  return withLock(path.join(dir, `${file}.lock`), () => {
    const rows = mutate(readList(dir, file))
    writeList(dir, file, rows)
    return rows
  })
}

/**
 * Everyone this server knows about, from every place it records them.
 *
 * <p>No single file is the list. ops.json holds operators, banned-players.json holds the banned,
 * whitelist.json holds the allowed, usercache.json holds names the server has resolved, and the
 * world folder holds a .dat for anyone who has actually joined. Someone can be in one and none of
 * the others - a player who joined once is only in the world folder, and a name banned before it
 * ever connected is only in the ban list.
 *
 * <p>Unioned by UUID, because that is the only identifier all five agree on. Names are looked up
 * afterwards and can genuinely be missing: an offline-mode UUID is a hash of a name, not a
 * reversible encoding of it, so a player who joined an offline server and was never opped,
 * banned, whitelisted or cached has left a UUID and nothing else.
 */
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
    // "forever" is what Minecraft writes for a permanent ban. Showing that word as if it were a
    // date is worse than showing nothing.
    p.banExpires = row.expires && row.expires !== 'forever' ? row.expires : null
    if (row.name) p.name = row.name
  }
  for (const row of readList(dir, WHITELIST)) {
    const p = at(row.uuid)
    if (!p) continue
    p.whitelisted = true
    if (row.name) p.name = row.name
  }
  // Last, and allowed to win: the cache holds the name the server most recently resolved, which is
  // the one that matters after a rename.
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
        /* the file went away between listing and stat; it still counts as having joined */
      }
    }
  }

  return [...people.values()].sort((a, b) => {
    // Named before nameless, then alphabetical. A screen that opens with a column of UUIDs is not
    // a list of people.
    if (Boolean(a.name) !== Boolean(b.name)) return a.name ? -1 : 1
    return (a.name || a.uuid).localeCompare(b.name || b.uuid)
  })
}

/**
 * Changing what a server thinks of somebody.
 *
 * <p>There are two ways to do this and only one of them is right at any moment.
 *
 * <p>A <b>running</b> server holds ops, bans and the whitelist in memory and writes them back over
 * the files when it feels like it - on shutdown, and after its own edits. Editing the file under a
 * live server therefore does nothing at best, and is silently reverted at worst. So while it runs,
 * the change goes through RCON as a console command, which is the server changing its own mind.
 *
 * <p>A <b>stopped</b> server has no console to talk to, and the files are then the whole truth. So
 * the change is written to the file.
 *
 * <p>Which one applies is decided here rather than by the caller, because getting it wrong is
 * invisible: the panel would say "opped" and the next start would quietly disagree.
 */

/** Ban entries record who did it. Anything a server writes itself says "Server". */
const BAN_SOURCE = 'mcctl'

function findPlayer(inst, uuid) {
  const who = listPlayers(inst).find((p) => p.uuid === String(uuid).toLowerCase())
  if (!who) fail(`"${inst.name}" has no record of a player with that id`)
  return who
}

/**
 * A console command needs a name, and an offline UUID is a hash rather than an encoding of one.
 *
 * <p>So a player who joined an offline server and was never opped, banned, whitelisted or cached
 * has left an identifier the server cannot turn back into a name. Saying so beats sending
 * `op undefined`.
 */
function requireName(who, verb) {
  if (who.name) return who.name
  fail(
    `SpawnLoft does not know the name behind ${who.uuid}, and ${verb} needs one. Offline-mode ids are `
      + 'made by hashing a name, so they cannot be turned back into one - have the player join '
      + 'once while the server is running, or type the name in yourself.',
  )
}

/**
 * Who is connected right now.
 *
 * <p>Nothing on disk answers this. Minecraft writes a player's .dat when they log out or when the
 * world saves, so someone who joined a minute ago has left no trace in the world folder at all -
 * and a screen that reads only files says "has never joined" about the person currently standing
 * in front of you.
 *
 * <p>So the server is asked. Failure is not an error: the list still means something without it,
 * and the alternative is a page that shows nothing because one extra question went unanswered.
 */
export async function onlineNow(inst) {
  if (!supervisor.isRunning(inst.name)) return []
  try {
    const [reply] = await rconExec(inst, ['list'])
    // "There are 1 of a max of 10 players online: Wunga_" - and with nobody on, the same sentence
    // ending in a colon and nothing after it.
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
        // Level 4 is what the `op` command grants. Anything less is a partial operator that the
        // console cannot create, so offering it here would be a setting only half the app honours.
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
    // Banning a player who is connected also kicks them, which is the point of doing it live.
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
        // The format Minecraft writes, so the file stays one the server can read back.
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

/** Minecraft's ban timestamps look like `2026-08-30 18:41:07 -0500`, not like ISO. */
function banStamp(d) {
  const two = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} `
    + `${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`
}

/**
 * Delete everything a world holds about one player: inventory, position, stats, advancements.
 *
 * <p>Refused while the server is running. A live server holds a joined player's state in memory
 * and writes it back on logout, so deleting the file underneath either achieves nothing or races
 * a write - and the panel would report a reset that did not happen.
 *
 * <p>Does not touch ops, bans or the whitelist. Those are about permission and survive the loss of
 * a player's things; wiping a banned player's inventory should not quietly unban them.
 */
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
      // .dat_old too: Minecraft keeps the previous save beside the current one, and leaving it
      // behind means the next start can restore what was just deleted.
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

  // Keyed by UUID: the same player appears in several of these directories, and counting files
  // would report one person three times.
  const seen = new Map()
  for (const dir of playerDirs(instDir, level)) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      // Absent is the normal case for most of these; nobody having joined is not an error.
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
