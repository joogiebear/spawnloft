import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LAYOUT } from './paths.mjs'
import { listAll } from './registry.mjs'
import * as supervisor from './supervisor.mjs'
import * as schedule from './schedule.mjs'
import { settingsFile } from './settings.mjs'

/**
 * What the uninstaller runs before it removes the program.
 *
 * <p>The installer removes the program folder and nothing else, on purpose: someone uninstalling
 * to reinstall, or moving to a new version by hand, must not lose their worlds. But two kinds of
 * leftover are never wanted. A scheduled task that outlives the program fires forever at a batch
 * file whose program is gone, and a server left running keeps a port and a Java process alive with
 * nothing to stop it. Both are cleared here, always.
 *
 * <p>Deleting the data is the person's choice, asked by the uninstaller, and it is not "delete the
 * data folder": someone may have pointed that at a drive that holds other things. Only what this
 * program created goes - each server it created, its own store folders, its files - and a server
 * that was added from a folder the person already had is never touched. Folders are removed
 * afterwards only if that left them empty.
 */

/** Everything to delete when the person asks for their data to go. Pure, so it can be tested. */
export function purgeTargets({ instances, layout, settings, desktopDirs = [] }) {
  const remove = []
  for (const inst of instances) {
    // Adopted servers were the person's before this program saw them. They stay, whatever happens.
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

/**
 * Electron's own folder for the desktop app: the saved window position and the updater's cache.
 * Named here rather than found, because this runs as plain Node. Only a folder that actually holds
 * the window state is claimed, so something else that happens to share the name is left alone.
 */
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
    /* not empty, or in use: leave it */
  }
}

export async function run({ data = false, log = () => {} } = {}) {
  const result = { stopped: [], tasks: false, removed: [], failed: [] }

  // Servers first: a daemon that outlives the program is a Java process nobody can stop from here.
  for (const inst of listAll()) {
    if (!supervisor.isActive(inst.name)) continue
    log(`stopping ${inst.name}`)
    try {
      await supervisor.stop(inst.name, { timeout: 60000 })
    } catch {
      try {
        await supervisor.kill(inst.name)
      } catch {
        /* it may already be gone; the uninstall goes on either way */
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
