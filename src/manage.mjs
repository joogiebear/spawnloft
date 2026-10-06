import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { BACKUPS_DIR, INSTANCES_DIR, runDir } from './paths.mjs'
import { getInstance, hasInstance, putInstance, removeInstance } from './registry.mjs'
import * as backup from './backup.mjs'
import * as supervisor from './supervisor.mjs'
import * as schedule from './schedule.mjs'
import { writeLaunchers } from './create.mjs'
import { readProps, worldDirs } from './props.mjs'
import { UserError, validateName } from './util.mjs'
import * as activity from './activity.mjs'
import * as files from './files.mjs'

/** Written once, because every editor and shell between here and the file mangles it. */
const NL = String.fromCharCode(10)

/**
 * Editing and destroying instances.
 *
 * <p>Everything here that destroys blocks takes a snapshot first, and none of it runs against a
 * live server. Both rules exist because the alternative was demonstrated: a plugin directory was
 * cleared by hand, a world went with it, and there was no snapshot to go back to.
 */

function assertStopped(name, verb) {
  if (supervisor.isRunning(name)) {
    throw new UserError(`"${name}" is running — stop it before ${verb}.`)
  }
}

/**
 * Rename an instance: registry key, directory, and runtime scratch.
 *
 * <p>The directory moves only when it sits where mcctl put it. An instance adopted from somewhere
 * else on disk keeps its path — moving a directory a person chose, because they renamed the entry
 * pointing at it, is not a rename, it is a surprise.
 */
export function rename(oldName, newName) {
  // The registry's rule, not a second one that happens to be looser. This used to accept names
  // like "_scratch" that putInstance then rejected - after removeInstance had already run and the
  // directory had already moved, which lost the instance from the registry entirely.
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

  // Snapshots first, while backing out is still free.
  //
  // They are keyed by instance name, so a rename that left them behind would empty the Backups tab
  // of a history that might be the only copy of a world - and nothing would say where it went. This
  // is also the one step worth refusing the rename over, which is why it happens before anything
  // else has moved.
  const oldBackups = path.join(BACKUPS_DIR, oldName)
  const newBackups = path.join(BACKUPS_DIR, newName)
  let movedBackups = false
  if (fs.existsSync(oldBackups)) {
    // Checked before trying, because renameSync onto an existing directory fails with the same
    // kind of error as a locked file, and "close anything using that folder" is the wrong advice
    // for a folder left behind by a server of this name that used to exist.
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
      // Put the snapshots back rather than leaving them filed under a name nothing else uses.
      if (movedBackups) {
        try {
          fs.renameSync(newBackups, oldBackups)
        } catch {
          /* nothing further to try; the message below names both places */
        }
      }
      throw new UserError(`could not move ${inst.dir} to ${dest}: ${err.message}`)
    }
    cfg.dir = dest
  }

  // The run directory holds the console log and the state file, both keyed by name. Moving it keeps
  // the history attached to the server it belongs to instead of stranding it under a dead name.
  const oldRun = runDir(oldName)
  if (fs.existsSync(oldRun)) {
    try {
      fs.renameSync(oldRun, runDir(newName))
    } catch {
      // A locked console log is not worth failing a rename over; a new one is created on start.
    }
  }

  removeInstance(oldName)
  putInstance(newName, cfg)

  // The mirror is keyed by name too. Left behind, retention deletions would go looking under the
  // new name and the old copies would sit there forever, unpruned and unfound.
  const mirror = backup.mirrorRoot()
  if (mirror && fs.existsSync(path.join(mirror, oldName)) && !fs.existsSync(path.join(mirror, newName))) {
    try {
      fs.renameSync(path.join(mirror, oldName), path.join(mirror, newName))
    } catch {
      /* the mirror is a second copy; a mirror that will not rename is not worth failing over */
    }
  }

  // The .bat launchers carry the instance name. Rewritten here rather than by each caller, because
  // the panel's rename forgot to and left a start.bat that started a server that no longer existed.
  try {
    writeLaunchers({ name: newName, dir: cfg.dir })
  } catch {
    /* launchers are a convenience; `mcctl launchers` repairs them */
  }

  // Scheduled tasks name the instance they act on. Left behind, they keep firing at a server that
  // no longer answers to that name - nightly, into a log, failing, with nothing to explain why.
  // Last, and not allowed to fail the rename: the instance has already moved, and a scheduling
  // problem is not a reason to leave it half renamed.
  let tasksMoved = 0
  try {
    tasksMoved = schedule.renameInstance(oldName, newName).moved
  } catch {
    /* reported through the scheduler screen, where the task will show as not in Windows */
  }
  // Its history goes with it, and says that it moved.
  activity.renameServer(oldName, newName)
  activity.record(newName, 'rename', { detail: `from ${oldName}` })
  return { name: newName, ...cfg, movedDir: wasDefaultDir, tasksMoved }
}

/**
 * Return an instance to a fresh server, keeping its identity.
 *
 * <p>Deletes worlds and generated state; keeps the jar, the port, the memory and the name. What
 * counts as "generated" is listed explicitly rather than inferred, because a rebuild that guesses
 * wrong deletes something a person spent a week on.
 *
 * <p>`keepPlugins` is the difference between "reset the world" and "start over". Plugins are
 * usually the thing under development, so they survive by default.
 */
export async function rebuild(name, { keepPlugins = true, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'rebuilding it')

  let snapshotFile = null
  if (snapshot) {
    // Before, not after. A rebuild is the moment someone most wants an undo and least expects to
    // need one.
    const res = await backup.createSnapshot(inst, { label: 'pre-rebuild', quiet: true })
    snapshotFile = res?.file ?? res?.path ?? null
  }

  // The worlds are whatever level-name says they are, not "world". This list used to hardcode
  // the default names, so a server running any other world - a downloaded map, say - was
  // "rebuilt" with nothing removed and reported as such. The pre-rebuild snapshot above already
  // read level-name; the wipe now reads the same line.
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

  // Clear the captured console too, so the first line after a rebuild belongs to the rebuilt server.
  const log = path.join(runDir(name), 'console.log')
  if (fs.existsSync(log)) fs.rmSync(log, { force: true })

  activity.record(name, 'rebuild', { detail: keepPlugins ? 'fresh worlds, plugins kept' : 'fresh worlds and plugins', snapshot: snapshotFile ? path.basename(snapshotFile) : null })
  return { name, removed, keptPlugins: keepPlugins, snapshot: snapshotFile }
}

/**
 * Delete an instance, optionally its files.
 *
 * <p>Always snapshots first when files are going. The registry entry is cheap to recreate; the
 * directory is not.
 */
export async function destroy(name, { purge = false, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'deleting it')

  let snapshotFile = null
  if (purge && snapshot) {
    const res = await backup.createSnapshot(inst, { label: 'pre-delete', quiet: true })
    snapshotFile = res?.file ?? res?.path ?? null
  }
  // Files first, registry second. The other order loses the instance from mcctl and leaves the
  // directory on disk when the delete fails - a locked world file is enough - and the person is
  // then holding a folder mcctl no longer knows about.
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
  // A trigger that outlives its server is the worst kind of leftover: it fires forever, fails every
  // time, and turns up months later in Task Scheduler with nothing to say what put it there.
  let tasksRemoved = 0
  try {
    tasksRemoved = schedule.removeForInstance(name).removed
  } catch {
    /* the instance is gone either way; a stuck task is not a reason to refuse that */
  }
  activity.record(name, 'delete', { detail: purge ? 'files deleted' : 'unregistered, files kept', snapshot: snapshotFile ? path.basename(snapshotFile) : null })
  return { name, purged: purge, snapshot: snapshotFile, tasksRemoved }
}

/** Open an instance's folder (or one named subfolder of it) in the system file manager. */
export function reveal(name, sub = null, folder = null) {
  const inst = getInstance(name)
  // A fixed allowlist, not a path: sub arrives over HTTP, and "open a folder in Explorer"
  // must never become "open anything on the machine". `folder` is the Files tool's current folder:
  // it is confined to the server's folder by files.resolvePath and must be a real directory.
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
  // explorer.exe exits non-zero even when it succeeds, so its result is deliberately not checked.
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    throw new UserError(`could not open ${target}: ${err.message}`)
  }
  return target
}
