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

// A folder name for a server or database, never something that could reach out of the parent
function plainName(name, p) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && p.basename(name) === name && !/[\\/]/.test(name)
}

function sameDir(a, b, p) {
  const norm = (d) => {
    const r = p.resolve(d)
    return p.sep === '\\' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// The backups folder is SpawnLoft's own only when it is the default one inside the data root.
// A folder the person chose (D:\Backups) may hold anything else, so there only the subfolders
// SpawnLoft writes are removed: one per server or database, named after it, and the client's
// exports. The folder itself goes only if that leaves it empty. The mirror folder is never touched.
export function backupTargets({ instances, layout, pathApi = path }) {
  const p = pathApi
  const root = layout.backupsDir
  if (!root) return { remove: [], removeIfEmpty: [] }
  if (sameDir(root, p.join(layout.dataRoot, 'backups'), p)) return { remove: [root], removeIfEmpty: [] }
  const remove = []
  for (const inst of instances) if (plainName(inst.name, p)) remove.push(p.join(root, inst.name))
  remove.push(p.join(root, 'client', 'exports'))
  return { remove, removeIfEmpty: [p.join(root, 'client'), root] }
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
  const removeIfEmpty = [...backups.removeIfEmpty, layout.instancesDir, layout.servicesDir, layout.dataRoot, p.dirname(settings), otherSettings && p.dirname(otherSettings)]
  return { remove: [...new Set(remove.filter(Boolean))], removeIfEmpty: [...new Set(removeIfEmpty.filter(Boolean))] }
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
