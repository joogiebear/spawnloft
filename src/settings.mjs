import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError } from './util.mjs'

/** Where the code lives. Distinct from where data lives — see below. */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where mcctl keeps its own settings.
 *
 * <p>Deliberately NOT next to the code. Once this ships as an installed application the program
 * directory is read-only for the person running it, and the one thing that must be findable before
 * anything else is the file that says where everything else lives.
 */
export function settingsFile() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'mcctl', 'settings.json')
}

/**
 * What the settings file holds: nothing when there is no file, and a reason when there is one that
 * cannot be used. `kind` says which sort of reason: 'content' when the file was read and is not
 * usable (empty, not JSON, not an object), 'io' when it could not be read at all (permissions, a
 * lock, a folder where the file should be). Only the first is damage that setting the file aside
 * could mend; the second is about the file's surroundings, and moving it would be a guess.
 */
function read(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return err.code === 'ENOENT' ? { settings: {}, exists: false } : { settings: {}, exists: true, error: err.message, kind: 'io' }
  }
  try {
    // Some Windows editors begin a UTF-8 file with a byte-order mark, which JSON.parse takes for garbage.
    const parsed = JSON.parse(text.replace(/^﻿/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { settings: {}, exists: true, error: 'it is not a JSON object', kind: 'content' }
    return { settings: parsed, exists: true }
  } catch (err) {
    return { settings: {}, exists: true, error: err.message, kind: 'content' }
  }
}

let lastWarning = null

/**
 * The settings, or the defaults when there is no file.
 *
 * <p>A file that exists and cannot be used also gives the defaults - the program has to start, and
 * doctor has to be able to run to say what is wrong - but not silently. This used to be `{}` with no
 * word, and the file is where the data folder is chosen: a settings file cut off by a crash sent
 * SpawnLoft back to the default folder, where the servers were not, and the only sign was an empty
 * list or the first-run wizard. Said once per process while it stays the same, since this is read on
 * most requests, and again if it is mended and then breaks.
 */
export function load() {
  const file = settingsFile()
  const found = read(file)
  if (!found.error) {
    lastWarning = null
    return found.settings
  }
  const said = `settings file ${file} could not be read (${found.error}); using the defaults until you fix it or delete it`
  if (said !== lastWarning) {
    lastWarning = said
    process.stderr.write(`spawnloft: ${said}\n`)
  }
  return found.settings
}

/** Whether the settings file can be used, for doctor: `{ ok: true, exists }`, or `{ ok: false, file, error }`. */
export function inspect() {
  const file = settingsFile()
  const found = read(file)
  return found.error ? { ok: false, file, error: found.error } : { ok: true, exists: found.exists }
}

/**
 * Change settings, keeping the rest.
 *
 * <p>Written to a file beside it and renamed into place, so a crash or a full disk leaves the old
 * file whole instead of a stump. And not at all when the old file cannot be read: merging the change
 * into nothing and writing that back would erase whatever it said, the data folder first of all.
 *
 * <p>`replaceUnreadable` is for a person choosing the data folder on purpose - the first-run wizard,
 * `config set-root` - where refusing would leave them stuck with a file they may not know how to
 * mend, and where the choice they are making is the one the file would have held. Not for a command
 * that changes something else: it would drop the data folder along with the damage. The damaged file
 * is kept, beside the new one, and `onSetAside` is told where. Only damage to the CONTENT is replaced;
 * a file that cannot be read at all (permissions, a lock) is not moved on a guess.
 *
 * <p>Nothing is ever moved before the replacement is safely written: the new file is written and
 * flushed first, the damaged one is copied, and only then does the new one take its place - so there
 * is no moment, and no failure, that leaves no settings file. A file that is a link is changed where
 * the link points.
 */
export function save(patch, { replaceUnreadable = false, onSetAside = null } = {}) {
  const file = linkTarget(settingsFile())
  const found = read(file)
  const damaged = Boolean(found.error)
  if (damaged && !(replaceUnreadable && found.kind === 'content')) {
    throw new UserError(`settings file ${file} could not be read (${found.error}), so it was not changed; fix it or delete it (a deleted file forgets your data folder: spawnloft config set-root <folder> sets it again), then try again`)
  }
  const merged = { ...found.settings, ...patch }
  const tmp = `${file}.${process.pid}.tmp`
  let aside = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(merged, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (damaged) {
      aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
      fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL)
    }
    renameOver(tmp, file)
  } catch (err) {
    // Whatever was half done is undone: the old file is as it was, and a copy of it is not wanted.
    for (const leftover of [tmp, aside]) {
      if (!leftover) continue
      try {
        fs.rmSync(leftover, { force: true })
      } catch { /* the error that matters is the one below */ }
    }
    throw err instanceof UserError ? err : new UserError(`could not write settings file ${file} (${err.message}); it was left as it was`)
  }
  if (aside && onSetAside) onSetAside(aside)
  return merged
}

/** Where a settings file that may be a link really is: a dotfile manager's link is changed through, not replaced. */
function linkTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file
  } catch {
    return file
  }
}

/**
 * Rename over an existing file. On Windows a file written a moment ago is often still held by a
 * virus scanner or a sync client, and renaming over it fails with EPERM, EBUSY or EACCES until it lets
 * go; a few short waits are what the usual atomic-write libraries do. Only on that failure does this
 * block, and for no more than about 350 ms.
 */
function renameOver(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt)
    }
  }
}

/** The default data location for a fresh install: per-user, writable, and not inside the program. */
export function defaultDataRoot() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'mcctl')
}

/**
 * Resolve every location mcctl uses.
 *
 * <p>Three sources, in order:
 *
 * <ol>
 *   <li><b>Settings</b>, if the person has chosen locations.</li>
 *   <li><b>The code directory</b>, when it already holds an {@code instances.json}. This is what
 *       keeps an existing checkout working after this change: its registry, worlds and backups stay
 *       exactly where they are rather than the tool waking up one day pointed at an empty folder and
 *       reporting no servers.</li>
 *   <li><b>A per-user data directory</b>, for a fresh install.</li>
 * </ol>
 *
 * <p>Servers can live on a different drive from everything else. That is the one split worth
 * supporting directly: worlds and backups are the large, growing things, and the reason to move
 * them is usually that they no longer fit where the program was installed.
 */
export function resolveRoots(overrides = {}) {
  const s = { ...load(), ...overrides }

  const legacy = fs.existsSync(path.join(CODE_ROOT, 'instances.json'))
  // MCCTL_DATA_ROOT wins over everything: it is how the lifecycle tests keep a real daemon, registry
  // and run directory inside a scratch folder instead of the person's own servers. It is inherited
  // by the daemons this process spawns, so they land in the same place.
  const forced = process.env.MCCTL_DATA_ROOT
  const dataRoot = forced ? path.resolve(forced) : s.dataRoot ? path.resolve(s.dataRoot) : legacy ? CODE_ROOT : defaultDataRoot()

  // separateInstances is the toggle: off (default) means servers live with everything else.
  const instancesDir = s.separateInstances && s.instancesDir
    ? path.resolve(s.instancesDir)
    : path.join(dataRoot, 'instances')

  return {
    dataRoot,
    instancesDir,
    separateInstances: Boolean(s.separateInstances && s.instancesDir),
    registryFile: path.join(dataRoot, 'instances.json'),
    templatesDir: path.join(dataRoot, 'templates'),
    jarsDir: path.join(dataRoot, 'jars'),
    // Snapshots are the thing most likely to outgrow the drive everything else is on, so they get
    // the same escape hatch the instances directory has. Changing it does not move what already
    // exists - the panel says so rather than letting history appear to vanish.
    backupsDir: s.backupsDir ? path.resolve(s.backupsDir) : path.join(dataRoot, 'backups'),
    runDir: path.join(dataRoot, 'run'),
    // Database engines (one folder per engine version, shared) and the databases that run on them.
    enginesDir: path.join(dataRoot, 'engines'),
    servicesDir: path.join(dataRoot, 'services'),
    usingLegacyLayout: legacy && !s.dataRoot,
    settingsFile: settingsFile(),
  }
}

/**
 * Other places on this machine that hold a registry with servers in it, when the data root in use
 * holds none.
 *
 * <p>The desktop app resolves its data root once, at launch; the CLI and the MCP server resolve it
 * on every run. So if settings.json changes under a running app - a second copy of SpawnLoft on the
 * same account, a development checkout, a hand edit - the app keeps showing the servers it started
 * with while every fresh process looks somewhere else and reports that nothing exists. That reads
 * as "my servers are gone" when they are one folder away. Checked only where SpawnLoft itself would
 * have put them: the per-user default and the legacy checkout layout.
 */
export function serversElsewhere(dataRoot) {
  const here = path.resolve(dataRoot)
  const found = []
  for (const root of new Set([defaultDataRoot(), CODE_ROOT].map((r) => path.resolve(r)))) {
    if (root === here) continue
    let names = []
    try {
      names = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf8')).instances ?? {})
    } catch {
      continue
    }
    if (names.length) found.push({ root, names })
  }
  return found
}

/** One line per other location, for the places that report an empty data root. */
export function describeServersElsewhere(dataRoot) {
  return serversElsewhere(dataRoot).map(({ root, names }) =>
    `${names.length} server(s) (${names.join(', ')}) are registered in ${root}, which is not the data root in use. ` +
    `If they are yours: spawnloft config set-root "${root}"`)
}

/**
 * Whether a directory can be written to, checked by actually writing.
 *
 * <p>Permission bits and free-space numbers both lie — a network share, a read-only mount, or a
 * drive that has been unplugged all look fine until the first write. The picker needs a real answer
 * before someone points their servers at a location that cannot hold them.
 */
export function checkWritable(dir) {
  const probe = path.join(dir, '.mcctl-write-test')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
