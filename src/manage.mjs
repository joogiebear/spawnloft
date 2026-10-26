import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { BACKUPS_DIR, INSTANCES_DIR, runDir } from './paths.mjs'
import { getInstance, hasInstance, putInstance, removeInstance } from './registry.mjs'
import * as backup from './backup.mjs'
import { activeBlock } from './control.mjs'
import * as schedule from './schedule.mjs'
import { writeLaunchers } from './create.mjs'
import { readProps, worldDirs } from './props.mjs'
import { UserError, validateName } from './util.mjs'
import * as activity from './activity.mjs'
import * as files from './files.mjs'

// built from a char code so editors and shells can't mangle a literal newline
const NL = String.fromCharCode(10)

// Anything destructive here snapshots first and refuses to run against a live server.

function assertStopped(name, verb) {
  const why = activeBlock(name, verb)
  if (why) throw new UserError(why)
}

// The directory moves only when it sits where SpawnLoft put it; an adopted instance keeps its path.
export function rename(oldName, newName) {
  // validate with the registry's own rule up front: putInstance rejecting the name after the
  // directory had moved would lose the instance
  try {
    validateName(newName)
  } catch {
    throw new UserError(
      `"${newName}" is not a usable name - start with a letter or digit, then letters, digits, ` +
        'dash or underscore, up to 32 characters.',
    )
  }
  const inst = getInstance(oldName)
  if (hasInstance(newName)) throw new UserError(`"${newName}" already exists`)
  assertStopped(oldName, 'renaming it')

  const { name: _drop, ...cfg } = inst

  // Snapshots move first, while backing out is free. They are keyed by instance name, so leaving
  // them behind would empty the Backups tab, and this is the one step worth refusing the rename over.
  const oldBackups = path.join(BACKUPS_DIR, oldName)
  const newBackups = path.join(BACKUPS_DIR, newName)
  let movedBackups = false
  if (fs.existsSync(oldBackups)) {
    // checked first: renameSync onto an existing directory fails like a locked file, and "close
    // anything using that folder" would be the wrong advice
    if (fs.existsSync(newBackups)) {
      throw new UserError(
        `${newBackups} already holds snapshots - from an earlier server called "${newName}".` + NL +
          `  "${oldName}" has not been renamed. Move or delete that folder first, or pick another name.`,
      )
    }
    try {
      fs.renameSync(oldBackups, newBackups)
      movedBackups = true
    } catch (err) {
      throw new UserError(
        `could not move the snapshots from ${oldBackups} to ${newBackups}: ${err.message}\n` +
          `  "${oldName}" has not been renamed. Close anything reading that folder and try again.`,
      )
    }
  }

  const wasDefaultDir = path.resolve(inst.dir) === path.resolve(path.join(INSTANCES_DIR, oldName))
  if (wasDefaultDir) {
    const dest = path.join(INSTANCES_DIR, newName)
    try {
      fs.renameSync(inst.dir, dest)
    } catch (err) {
      if (movedBackups) {
        try {
          fs.renameSync(newBackups, oldBackups)
        } catch {
          /* nothing more to try */
        }
      }
      throw new UserError(`could not move ${inst.dir} to ${dest}: ${err.message}`)
    }
    cfg.dir = dest
  }

  // the run dir (console log, state file) is keyed by name
  const oldRun = runDir(oldName)
  if (fs.existsSync(oldRun)) {
    try {
      fs.renameSync(oldRun, runDir(newName))
    } catch {
      // a locked console log isn't worth failing over; a new one is created on start
    }
  }

  removeInstance(oldName)
  putInstance(newName, cfg)

  // the mirror is keyed by name too; otherwise retention would never find the old copies
  const mirror = backup.mirrorRoot()
  if (mirror && fs.existsSync(path.join(mirror, oldName)) && !fs.existsSync(path.join(mirror, newName))) {
    try {
      fs.renameSync(path.join(mirror, oldName), path.join(mirror, newName))
    } catch {
      /* the mirror is a second copy, not worth failing over */
    }
  }

  // the launchers carry the instance name; rewritten here so callers can't forget
  try {
    writeLaunchers({ name: newName, dir: cfg.dir })
  } catch {
    /* launchers are a convenience */
  }

  // Scheduled tasks name the instance. Done last and must not fail the rename: the instance has
  // already moved and a scheduling problem shouldn't leave it half renamed.
  let tasksMoved = 0
  try {
    tasksMoved = schedule.renameInstance(oldName, newName).moved
  } catch {
    /* shows up in the scheduler screen as a task missing from Windows */
  }
  activity.renameServer(oldName, newName)
  activity.record(newName, 'rename', { detail: `from ${oldName}` })
  return { name: newName, ...cfg, movedDir: wasDefaultDir, tasksMoved }
}

// Deletes worlds and generated state, keeps jar, port, memory and name. The wipe list is explicit
// rather than inferred so a wrong guess can't delete something valuable. Plugins survive by
// default (`keepPlugins`), since they're usually what is under development.
export async function rebuild(name, { keepPlugins = true, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'rebuilding it')

  let snapshotFile = null
  if (snapshot) {
    const res = await backup.createSnapshot(inst, { label: 'pre-rebuild', quiet: true })
    snapshotFile = res?.file ?? res?.path ?? null
  }

  // worlds are whatever level-name says, not necessarily "world"
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const wipe = [...worldDirs(props), 'logs', 'cache', 'crash-reports',
    'usercache.json', 'usernamecache.json', 'banned-ips.json', 'banned-players.json', 'ops.json',
    'whitelist.json', 'session.lock']
  if (!keepPlugins) wipe.push('plugins')

  const removed = []
  for (const entry of wipe) {
    const target = path.join(inst.dir, entry)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(entry)
    }
  }

  // clear the console log so the first line after a rebuild belongs to the new server
  const log = path.join(runDir(name), 'console.log')
  if (fs.existsSync(log)) fs.rmSync(log, { force: true })

  activity.record(name, 'rebuild', { detail: keepPlugins ? 'fresh worlds, plugins kept' : 'fresh worlds and plugins', snapshot: snapshotFile ? path.basename(snapshotFile) : null })
  return { name, removed, keptPlugins: keepPlugins, snapshot: snapshotFile }
}

// snapshots first when files are going: the registry entry is cheap to recreate, the directory isn't
export async function destroy(name, { purge = false, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'deleting it')

  let snapshotFile = null
  if (purge && snapshot) {
    const res = await backup.createSnapshot(inst, { label: 'pre-delete', quiet: true })
    snapshotFile = res?.file ?? res?.path ?? null
  }
  // files first, registry second: if the delete fails (a locked world file), the instance must stay registered
  if (purge) {
    try {
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch (err) {
      throw new UserError(
        `could not delete ${inst.dir}: ${err.message}\n` +
          `  "${name}" is still registered. Close anything using that folder and try again.`,
      )
    }
  }
  removeInstance(name)
  // a task that outlives its server would keep firing and failing in Task Scheduler
  let tasksRemoved = 0
  try {
    tasksRemoved = schedule.removeForInstance(name).removed
  } catch {
    /* the instance is gone either way */
  }
  activity.record(name, 'delete', { detail: purge ? 'files deleted' : 'unregistered, files kept', snapshot: snapshotFile ? path.basename(snapshotFile) : null })
  return { name, purged: purge, snapshot: snapshotFile, tasksRemoved }
}

export function reveal(name, sub = null, folder = null) {
  const inst = getInstance(name)
  // `sub` arrives over HTTP, so it is matched against an allowlist, never used as a path.
  // `folder` is confined to the server folder by files.resolvePath.
  const SUBS = new Set(['crash-reports', 'plugins', 'mods', 'logs'])
  let target = sub && SUBS.has(sub) ? path.join(inst.dir, sub) : inst.dir
  if (folder) {
    const r = files.resolvePath(inst, folder, { allowRoot: true })
    if (!r.stat.isDirectory()) throw new UserError(`${r.rel} is not a folder`)
    target = r.full
  }
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]]
  // explorer.exe exits non-zero even on success, so the exit code is ignored
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    throw new UserError(`could not open ${target}: ${err.message}`)
  }
  return target
}
