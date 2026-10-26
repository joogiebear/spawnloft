import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError, PRIVATE_FILE_MODE, renameOver } from './util.mjs'

export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Settings live in the user config dir, not next to the code: an installed program directory is
// read-only, and this file says where everything else lives.
export function settingsFile() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'mcctl', 'settings.json')
}

// kind 'content': read but unusable (empty, not JSON, not an object). kind 'io': could not be read
// (permissions, a lock, a folder in its place). Only content damage can be mended by setting the file aside.
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

// Defaults when there is no file or it is unusable. An unusable file warns on stderr (once per
// process while unchanged) because it holds the data folder: silently falling back to the default
// folder looks like lost servers.
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

// for doctor: { ok: true, exists } or { ok: false, file, error }
export function inspect() {
  const file = settingsFile()
  const found = read(file)
  return found.error ? { ok: false, file, error: found.error } : { ok: true, exists: found.exists }
}

// Merges patch into the settings via temp file + rename, so a crash leaves the old file whole.
// Refuses when the existing file is unreadable: merging into nothing would erase the data folder.
// replaceUnreadable is for deliberately choosing the data folder (first-run wizard, config set-root):
// a file with damaged content is copied aside (onSetAside is told where) and replaced. A file that
// cannot be read at all is never moved. The new file is written and flushed before the damaged one
// is copied, so no failure leaves no settings file. A symlinked file is changed where the link points.
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
    // owner-only; also tightens a file that was written earlier with wider permissions
    const fd = fs.openSync(tmp, 'w', PRIVATE_FILE_MODE)
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, PRIVATE_FILE_MODE)
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
    // undo whatever was half done; the old file is untouched
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

// a dotfile manager's symlink is written through, not replaced
function linkTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file
  } catch {
    return file
  }
}

// per-user and writable, unlike the program directory
export function defaultDataRoot() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'mcctl')
}

// Order: settings; the code directory if it already holds instances.json (keeps an existing
// checkout pointed at its servers); a per-user data directory. Servers can sit on another drive,
// since worlds and backups are what outgrow the install location.
export function resolveRoots(overrides = {}) {
  const s = { ...load(), ...overrides }

  const legacy = fs.existsSync(path.join(CODE_ROOT, 'instances.json'))
  // MCCTL_DATA_ROOT wins: lifecycle tests use it to keep daemons and registry in a scratch folder,
  // and spawned daemons inherit it.
  const forced = process.env.MCCTL_DATA_ROOT
  const dataRoot = forced ? path.resolve(forced) : s.dataRoot ? path.resolve(s.dataRoot) : legacy ? CODE_ROOT : defaultDataRoot()

  // off (default): servers live under the data root
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
    // snapshots are likeliest to outgrow the drive; changing this does not move existing ones, and the panel says so
    backupsDir: s.backupsDir ? path.resolve(s.backupsDir) : path.join(dataRoot, 'backups'),
    runDir: path.join(dataRoot, 'run'),
    // Database engines (one folder per engine version, shared) and the databases that run on them.
    enginesDir: path.join(dataRoot, 'engines'),
    servicesDir: path.join(dataRoot, 'services'),
    usingLegacyLayout: legacy && !s.dataRoot,
    settingsFile: settingsFile(),
  }
}

// Other registries on this machine, for when the data root in use has none. The desktop app resolves
// its data root once at launch while the CLI re-resolves on every run, so a changed settings.json makes
// servers look gone. Only checks the per-user default and the legacy checkout.
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

export function describeServersElsewhere(dataRoot) {
  return serversElsewhere(dataRoot).map(({ root, names }) =>
    `${names.length} server(s) (${names.join(', ')}) are registered in ${root}, which is not the data root in use. ` +
    `If they are yours: spawnloft config set-root "${root}"`)
}

// Checks by actually writing: permission bits and free space lie on network shares, read-only mounts
// and unplugged drives.
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
