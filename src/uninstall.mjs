import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LAYOUT } from './paths.mjs'
import { listAll } from './registry.mjs'
import * as supervisor from './supervisor.mjs'
import * as schedule from './schedule.mjs'
import { settingsFile, shadowedSettingsFile } from './settings.mjs'

// Runs before the uninstaller removes the program. The program folder is removed and nothing
// else, so reinstalling doesn't lose worlds, but scheduled tasks and running servers are always
// cleared: both would otherwise outlive the program with nothing to stop them.
//
// Deleting data is the person's choice and never "delete the data folder", which may sit on a
// drive with other things. Only what this program created is removed, never an adopted server,
// and folders only if that leaves them empty.

function sameDir(a, b, p) {
  const norm = (d) => {
    const r = p.resolve(d)
    return p.sep === '\\' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// The backups folder is SpawnLoft's own only when it is the default one inside the data root, and
// then it goes whole. A folder the person chose (D:\Backups, a drive root, their home folder) may
// hold anything, and a subfolder that happens to share a server's name may be theirs, so there
// nothing is removed by folder: sweepBackups deletes only files SpawnLoft provably wrote, then the
// folders that leaves empty. The mirror folder is never touched.
export function backupTargets({ instances, layout, pathApi = path }) {
  const root = layout.backupsDir
  if (!root) return { remove: [], sweep: null }
  if (sameDir(root, pathApi.join(layout.dataRoot, 'backups'), pathApi)) return { remove: [root], sweep: null }
  const names = [...new Set(instances.map((i) => i.name).filter((n) => typeof n === 'string' && n))]
  return { remove: [], sweep: { root, names } }
}

// what backup.mjs, services.mjs and the exports write: a timestamp from util.stamp() in the name
const STAMPED = /\d{4}-\d{2}-\d{2}_\d{6}/
const EXPORT_FILE = /_\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?\.(zip|log)$/i

function readManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    return m && typeof m === 'object' ? m : null
  } catch {
    return null
  }
}

function isFile(p) {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

// The files SpawnLoft wrote in one subfolder of a chosen backups folder. A snapshot or database
// backup is SpawnLoft's when its .json manifest names this folder; that holds for servers deleted
// long ago too. Leftovers with no manifest (an interrupted backup, the lock, exports) are claimed
// only in a folder named after a server or database SpawnLoft knows, and only by their exact shape.
export function sweepFiles(dir, folder, { known, caseless = process.platform === 'win32' }) {
  const same = (a, b) => (caseless ? String(a).toLowerCase() === String(b).toLowerCase() : a === b)
  const files = []
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return files
  }
  for (const f of entries) {
    const full = path.join(dir, f)
    if (!isFile(full)) continue
    const snap = /^(.+)\.tar\.gz$/i.exec(f)
    const dump = /^([\w.-]+)\.sql$/i.exec(f)
    if (snap || dump) {
      const m = readManifest(path.join(dir, `${(snap ?? dump)[1]}.json`))
      const owner = snap ? m?.instance : m?.database
      if ((owner && same(owner, folder)) || (known && STAMPED.test(f))) {
        files.push(full)
        if (m) files.push(path.join(dir, `${(snap ?? dump)[1]}.json`))
      }
    } else if (known && (f === '.snapshot.lock' || (/\.(tar\.gz|sql)\.pending$/i.test(f) && STAMPED.test(f)))) {
      files.push(full)
    }
  }
  const exportsDir = path.join(dir, 'exports')
  if (known && isDir(exportsDir)) {
    for (const f of fs.readdirSync(exportsDir)) {
      if (EXPORT_FILE.test(f) && isFile(path.join(exportsDir, f))) files.push(path.join(exportsDir, f))
    }
  }
  return [...new Set(files)]
}

export function sweepBackups({ root, names }, { log = () => {}, result = { removed: [], failed: [] }, caseless = process.platform === 'win32' } = {}) {
  const key = (n) => (caseless ? n.toLowerCase() : n)
  const known = new Set([...names, 'client'].map(key))
  let subs
  try {
    subs = fs.readdirSync(root)
  } catch {
    return result
  }
  for (const sub of subs) {
    const dir = path.join(root, sub)
    if (!isDir(dir)) continue
    for (const file of sweepFiles(dir, sub, { known: known.has(key(sub)), caseless })) {
      log(`deleting ${file}`)
      try {
        fs.rmSync(file, { force: true })
        result.removed.push(file)
      } catch (err) {
        result.failed.push(`${file}: ${err.message}`)
      }
    }
    rmdirIfEmpty(path.join(dir, 'exports'))
    rmdirIfEmpty(dir)
  }
  rmdirIfEmpty(root)
  return result
}

// pure, so it can be tested
export function purgeTargets({ instances, layout, settings, otherSettings = null, desktopDirs = [], pathApi = path }) {
  const p = pathApi
  const remove = []
  for (const inst of instances) {
    // adopted servers were the person's before this program saw them
    if (inst.origin?.adopted) continue
    if (inst.dir) remove.push(inst.dir)
  }
  const backups = backupTargets({ instances, layout, pathApi: p })
  remove.push(
    layout.jarsDir,
    ...backups.remove,
    layout.templatesDir,
    layout.runDir,
    layout.enginesDir,
    p.join(layout.dataRoot, 'tasks'),
    layout.registryFile,
    settings,
    otherSettings,
    ...desktopDirs,
  )
  // inner folders first, so a backups folder inside the data root can empty it
  const removeIfEmpty = [layout.instancesDir, layout.servicesDir, layout.dataRoot, p.dirname(settings), otherSettings && p.dirname(otherSettings)]
  // deepest first, so a folder emptied by its children's removal goes too
  const depth = (d) => p.resolve(d).split(/[\\/]+/).filter(Boolean).length
  const ordered = [...new Set(removeIfEmpty.filter(Boolean))].sort((a, b) => depth(b) - depth(a))
  return { remove: [...new Set(remove.filter(Boolean))], removeIfEmpty: ordered, sweep: backups.sweep }
}

// Electron's folder for the desktop app (window position, updater cache), named here because this
// runs as plain Node. Only claimed if it holds window-state.json, in case another app shares the name.
function desktopDataDirs() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return ['SpawnLoft', 'mcctl-desktop']
    .map((name) => path.join(base, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'window-state.json')))
}

function rmdirIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* in use: leave it */
  }
}

// deletes what purgeTargets planned; separate so a test can run it on a temp folder
export function applyTargets(targets, { log = () => {}, result = { removed: [], failed: [] } } = {}) {
  for (const target of targets.remove) {
    log(`deleting ${target}`)
    try {
      fs.rmSync(target, { recursive: true, force: true })
      result.removed.push(target)
    } catch (err) {
      result.failed.push(`${target}: ${err.message}`)
    }
  }
  // before the empty-folder pass, so a chosen backups folder inside the data root can empty it
  if (targets.sweep) sweepBackups(targets.sweep, { log, result })
  for (const dir of targets.removeIfEmpty) rmdirIfEmpty(dir)
  return result
}

export async function run({ data = false, log = () => {} } = {}) {
  const result = { stopped: [], tasks: false, removed: [], failed: [] }

  // servers first: a daemon that outlives the program is a Java process nobody can stop
  for (const inst of listAll()) {
    if (!supervisor.isActive(inst.name)) continue
    log(`stopping ${inst.name}`)
    try {
      await supervisor.stop(inst.name, { timeout: 60000 })
    } catch {
      try {
        await supervisor.kill(inst.name)
      } catch {
        /* may already be gone */
      }
    }
    result.stopped.push(inst.name)
  }

  log('removing scheduled tasks')
  try {
    schedule.removeAll()
    result.tasks = true
  } catch (err) {
    result.failed.push(`scheduled tasks: ${err.message}`)
  }

  if (!data) return result

  const targets = purgeTargets({
    instances: listAll(),
    layout: LAYOUT,
    settings: settingsFile(),
    otherSettings: shadowedSettingsFile(),
    desktopDirs: desktopDataDirs(),
  })
  applyTargets(targets, { log, result })
  return result
}
