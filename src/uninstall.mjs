import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LAYOUT } from './paths.mjs'
import { listAll } from './registry.mjs'
import * as supervisor from './supervisor.mjs'
import * as schedule from './schedule.mjs'
import { settingsFile } from './settings.mjs'

// Runs before the uninstaller removes the program. The program folder is removed and nothing
// else, so reinstalling doesn't lose worlds, but scheduled tasks and running servers are always
// cleared: both would otherwise outlive the program with nothing to stop them.
//
// Deleting data is the person's choice and never "delete the data folder", which may sit on a
// drive with other things. Only what this program created is removed, never an adopted server,
// and folders only if that leaves them empty.

// pure, so it can be tested
export function purgeTargets({ instances, layout, settings, desktopDirs = [] }) {
  const remove = []
  for (const inst of instances) {
    // adopted servers were the person's before this program saw them
    if (inst.origin?.adopted) continue
    if (inst.dir) remove.push(inst.dir)
  }
  remove.push(
    layout.jarsDir,
    layout.backupsDir,
    layout.templatesDir,
    layout.runDir,
    layout.enginesDir,
    path.join(layout.dataRoot, 'tasks'),
    layout.registryFile,
    settings,
    ...desktopDirs,
  )
  const removeIfEmpty = [layout.instancesDir, layout.servicesDir, layout.dataRoot, path.dirname(settings)]
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
    desktopDirs: desktopDataDirs(),
  })
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
