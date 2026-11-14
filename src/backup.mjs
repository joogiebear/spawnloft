import { envVar } from './env.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKUPS_DIR } from './paths.mjs'
import { runTar, tarBinary, tarMember } from './tar.mjs'
import * as services from './services.mjs'
import { readProps, worldDirs } from './props.mjs'
import * as settings from './settings.mjs'
import { rconExec } from './rcon.mjs'
import { fail, stamp, humanBytes, writeJson, readJson, UserError, acquireLockAsync, safeRelativePath } from './util.mjs'
import * as activity from './activity.mjs'
import { beginRestore, restoreBlock, isRestoring as restoreInProgress } from './control.mjs'

// The mirror is a second location every snapshot is copied to. Read from settings on each call
// so enabling it needs no restart. A failed mirror copy is reported but never fails the backup.
export function mirrorRoot() {
  const dir = settings.load().backupsMirrorDir
  return dir ? path.resolve(dir) : null
}

function mirrorCopy(name, file) {
  const root = mirrorRoot()
  if (!root) return { mirrored: null, mirrorError: null }
  try {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, path.basename(file))
    fs.copyFileSync(file, dest)
    const manifest = file.replace(/\.tar\.gz$/, '.json')
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, dest.replace(/\.tar\.gz$/, '.json'))
    return { mirrored: dest, mirrorError: null }
  } catch (err) {
    return { mirrored: null, mirrorError: `the backup is safe, but its second copy could not be made: ${err.message}` }
  }
}

// deletions are mirrored too, so retention applies to both copies
function mirrorRemove(name, snapName) {
  const root = mirrorRoot()
  if (!root) return
  try {
    fs.rmSync(path.join(root, name, snapName), { force: true })
    fs.rmSync(path.join(root, name, snapName.replace(/\.tar\.gz$/, '.json')), { force: true })
  } catch {
    /* ignore: a mirror that can't be tidied is retried at the next copy */
  }
}

export const SCOPES = ['plugins', 'worlds', 'config', 'standard', 'full']

// session.lock is held open exclusively while the server runs, and bsdtar gives up on the whole
// archive (exit 1, zero-byte output) instead of skipping a file it can't read. It is regenerated
// on start, so it is never worth backing up.
export const EXCLUDE_ARGS = ['--exclude', 'session.lock']

// Files under `members` that can't be read right now, as archive paths. Plugins with an embedded
// database (LuckPerms' H2 store) hold their file locked like session.lock, and bsdtar stops
// writing at that file with exit 1, the same code it uses for harmless hot-snapshot warnings.
// These are excluded and named in the manifest warnings. Windows only: POSIX locks are advisory.
// Async so scanning thousands of world files doesn't stall the panel's event loop.
async function lockedFiles(cwd, members) {
  if (process.platform !== 'win32') return []
  const locked = []
  const probe = Buffer.alloc(1)
  const visit = async (rel) => {
    const full = path.join(cwd, rel)
    let stat
    try {
      stat = await fs.promises.lstat(full)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      let entries = []
      try {
        entries = await fs.promises.readdir(full)
      } catch {
        return
      }
      for (let i = 0; i < entries.length; i += 16) {
        await Promise.all(entries.slice(i, i + 16).map((e) => visit(path.join(rel, e))))
      }
      return
    }
    // open succeeds on a locked file, only the read fails
    if (!stat.isFile() || stat.size === 0 || path.basename(rel) === 'session.lock') return
    let handle
    try {
      handle = await fs.promises.open(full, 'r')
      await handle.read(probe, 0, 1, 0)
    } catch (err) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) locked.push(rel.split(path.sep).join('/'))
    } finally {
      await handle?.close()
    }
  }
  for (const member of members) await visit(member)
  return locked.sort()
}

// bracket glob characters so a literal path works as a bsdtar pattern
const literalPattern = (p) => p.replace(/[[*?]/g, (c) => `[${c}]`)

const ROOT_CONFIG_FILES = [
  'server.properties',
  'bukkit.yml',
  'spigot.yml',
  'paper.yml',
  'paper-global.yml',
  'permissions.yml',
  'commands.yml',
  'help.yml',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'eula.txt',
]

// large, regenerable directories skipped by the full scope
const FULL_EXCLUDES = ['cache', 'libraries', 'versions', 'logs']

function backupDir(name) {
  const dir = path.join(BACKUPS_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function reserveSnapshot(dir, base) {
  // The .pending file is also tar's output; it never ends in .tar.gz, so history can't offer a
  // partial archive. Exclusive creation keeps the CLI, panel and scheduled tasks from colliding.
  for (let index = 0; ; index++) {
    const file = path.join(dir, `${base}${index ? `_${index + 1}` : ''}.tar.gz`)
    const pending = file + '.pending'
    const manifestFile = file.replace(/\.tar\.gz$/, '.json')
    let fd
    try { fd = fs.openSync(pending, 'wx') }
    catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
    fs.closeSync(fd)
    if (fs.existsSync(file) || fs.existsSync(manifestFile)) {
      fs.rmSync(pending, { force: true })
      continue
    }
    return { file, pending, manifestFile }
  }
}

// The folders at the top of a server folder that hold a world: the ones with a level.dat.
export function worldFolders(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    // not hidden folders: a world being imported is unpacked into one, and it is gone again
    // before a backup that listed it has finished
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(dir, e.name, 'level.dat')))
    .map((e) => e.name)
    .sort()
}

function membersFor(inst, scope) {
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const exists = (p) => fs.existsSync(path.join(inst.dir, p))

  // the plugins scope covers mods too (Fabric servers)
  const plugins = [...(exists('plugins') ? ['plugins'] : []), ...(exists('mods') ? ['mods'] : [])]
  // Every world in the folder, not only the one server.properties names: a server with a
  // multi-world plugin, or worlds brought in from the Worlds page, keeps the others beside it, and
  // "Standard" and "Worlds only" promise worlds. The active world's own folders come first, and
  // are kept even without a level.dat (a world that has never been saved).
  const worlds = [...new Set([...worldDirs(props).filter(exists), ...worldFolders(inst.dir)])]
  const config = [...ROOT_CONFIG_FILES.filter(exists), ...(exists('config') ? ['config'] : [])]

  switch (scope) {
    case 'plugins':
      return plugins
    case 'worlds':
      return worlds
    case 'config':
      return config
    case 'standard':
      return [...plugins, ...worlds, ...config]
    case 'full': {
      return fs
        .readdirSync(inst.dir)
        .filter((entry) => !FULL_EXCLUDES.includes(entry))
    }
    default:
      fail(`unknown backup scope "${scope}" - one of: ${SCOPES.join(', ')}`)
  }
}

export { runTar, tarBinary, tarMember } from './tar.mjs'

// two minutes: well past an ordinary command's eight seconds, but short enough that a hung server
// doesn't hold a backup for long. The env override is for tests.
export const FLUSH_TIMEOUT_MS = Number(envVar('FLUSH_TIMEOUT_MS')) > 0
  ? Number(envVar('FLUSH_TIMEOUT_MS'))
  : 120 * 1000

// Returns a warning when save-on could not be confirmed, else null. A refused connection means the
// server stopped mid-backup and has nothing to turn on; a server that is up but silent may still
// have saving off.
async function turnSavingBackOn(inst) {
  try {
    await rconExec(inst, ['save-on'])
    return null
  } catch (err) {
    if (err.refused) return null
    return `autosave may still be off: save-on was not confirmed (${err.message}). Type save-on in the server's console if it is`
  }
}

// The stack is updated along with the message because it is what gets printed for non-SpawnLoft
// errors. Engines differ on when the stack's first line is built, so read it first to fix it.
function appendToError(err, line) {
  const before = err.message
  const stack = typeof err.stack === 'string' ? err.stack : null
  err.message = `${before}\n  ${line}`
  if (stack && before) err.stack = stack.replace(before, () => err.message)
}

// A running server is flushed first (save-off, save-all flush, then save-on afterwards) so the
// copy isn't torn mid-write. A flush that can't be done (RCON down) is reported in the result and
// manifest rather than failing the snapshot.
export async function createSnapshot(inst, { scope = 'standard', label = null, running = false, taskId = null, flush = true, members: only = null, quiet = false, duringRestore = false, changeCopy = false } = {}) {
  // a copy of a folder that is halfway through being put back is a backup of nothing; the one
  // exception is the copy the restore itself takes before it starts
  if (!duringRestore) refuseWhileRestoring(inst.name, 'taking a new one')
  // `members` narrows a snapshot to named paths, e.g. one config file before it is changed. The
  // owner's leave-out list applies to every normal backup but not to a copy of named files.
  const leaveOut = only ? [] : excludePatterns(inst)
  const members = (only ?? membersFor(inst, scope)).filter((m) => !leaveOut.includes(m)).map(tarMember)
  if (!members.length) fail(`nothing to back up for scope "${scope}" in ${inst.dir}`)

  const slug = label ? `${label.replace(/[^a-z0-9_-]/gi, '-')}_` : ''
  const base = `${slug}${scope}_${stamp()}`
  const dir = backupDir(inst.name)
  // Said now, not after half an hour: a folder that cannot be written to looks, to the lock
  // below, exactly like a lock somebody else is holding, and it would wait out its whole timeout.
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    fail(`The backups folder cannot be written to, so no backup can be made. It is ${dir}`)
  }

  // Serialize snapshots per instance: if two overlapped, whichever finished first would turn
  // saving back on while the other's tar was still reading. The second one queues rather than
  // failing. The lock is async so a second request from this same process yields instead of
  // blocking the thread the first snapshot needs to finish.
  const release = await acquireLockAsync(path.join(dir, '.snapshot.lock'), { timeoutMs: 30 * 60 * 1000 })
  try {
    const made = await createSnapshotLocked(inst, { scope, label, running, taskId, flush, only, quiet, changeCopy }, { members, base, dir, leaveOut })
    // The clean-up a server turned on runs here, where something is being written anyway: never on
    // a read, never in the middle of a restore, and it cannot fail the snapshot just taken.
    if (inst.backupCleanCopies === true && !duringRestore) {
      try {
        cleanCopies(inst.name)
      } catch {
        // the next snapshot tries again
      }
    }
    return made
  } finally {
    release()
  }
}

async function createSnapshotLocked(inst, { scope, label, running, taskId, flush, only, quiet, changeCopy }, { members, base, dir, leaveOut }) {
  // Attached databases go in as a `databases/` member with one SQL dump each, dumped into a
  // scratch folder and added with -C so the server folder never holds them. Only for the standard
  // and full scopes. A database that isn't running becomes a manifest warning, not a failure.
  let dumps = { dumped: [], skipped: [] }
  let dumpDir = null
  if (scope === 'standard' || scope === 'full') {
    dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dump-'))
    try {
      dumps = await services.dumpAttachments(inst.name, dumpDir)
    } catch (err) {
      fs.rmSync(dumpDir, { recursive: true, force: true })
      throw err
    }
  }
  const dumpArgs = dumps.dumped.length ? ['-C', dumpDir, 'databases'] : []
  const archived = dumps.dumped.length ? [...members, 'databases'] : members

  // save-off may take effect even if its reply never arrives (timeout, cut socket), so this is
  // set before the call and saving is owed back from then on.
  let savingMayBeOff = false
  let saveOnWarning = null
  let flushed = false
  let flushWarning = null
  if (running && flush) {
    try {
      try {
        savingMayBeOff = true
        await rconExec(inst, ['save-off'])
      } catch (err) {
        // failed before anything was sent (no RCON, wrong password), so saving can't be off
        if (err.unsent) savingMayBeOff = false
        throw err
      }
      // longer timeout than ordinary commands, and no retry: a flush that timed out would only
      // make the backup wait as long again
      await rconExec(inst, ['save-all flush'], { timeout: FLUSH_TIMEOUT_MS, retryTimeouts: false })
      flushed = true
    } catch (err) {
      flushWarning = `could not flush the world before the snapshot (${err.message}); the copy may be torn`
    }
  }
  let reservation = null
  let published = false
  let skipped = []
  try {
    let stderr
    let code
    try {
      reservation = reserveSnapshot(dir, base)
      // after the flush, so files are checked in the state tar will find them
      skipped = await lockedFiles(inst.dir, members)
      const skipArgs = [...skipped.flatMap((f) => ['--exclude', literalPattern(f)]), ...leaveOut.flatMap((p) => ['--exclude', p])]
      ;({ stderr, code } = await runTar(['-czf', reservation.pending, ...EXCLUDE_ARGS, ...skipArgs, ...members, ...dumpArgs], inst.dir))
    } finally {
      // save-on even if tar or the flush failed; a live server left with saving off is worse
      // than a failed backup
      if (savingMayBeOff) saveOnWarning = await turnSavingBackOn(inst)
      if (dumpDir) fs.rmSync(dumpDir, { recursive: true, force: true })
    }

    const { file, pending, manifestFile } = reservation
    const size = fs.statSync(pending).size
    // Load-bearing: rebuild and delete take a snapshot first and are only safe if it exists. Exit 1
    // is tolerated above, so without this an empty result would be recorded as a good backup.
    if (size === 0) {
      const said = stderr.trim().split(/\r?\n/)[0]
      fail(
        `snapshot of "${inst.name}" came out empty and has been discarded.` +
          (said ? `\n  tar said: ${said}` : ''),
      )
    }
    // Exit 1 is also how bsdtar reports giving up partway (e.g. a file locked after the check), so
    // an archive written with warnings is read back before publishing. A clean exit skips this.
    if (code !== 0) {
      const check = await verifyArchive(reservation.pending, archived, dumps.dumped.map((d) => d.file))
      if (!check.ok) {
        const said = stderr.trim().split(/\r?\n/)[0]
        fail(
          `snapshot of "${inst.name}" came out incomplete and has been discarded: ${check.problems[0]}` +
            (said ? `\n  tar said: ${said}` : ''),
        )
      }
    }
    const manifest = {
      instance: inst.name,
      scope,
      label,
      // taken by SpawnLoft before a change, as against asked for: see isChangeCopy
      changeCopy: changeCopy === true,
      // scheduled task that produced this (its retention applies), null for manual snapshots
      taskId,
      members: archived,
      // dumps by file inside the archive
      databases: dumps.dumped,
      ...(leaveOut.length ? { excluded: leaveOut } : {}),
      sourceDir: inst.dir,
      createdAt: new Date().toISOString(),
      size,
      serverWasRunning: running,
      flushed,
      // locked files left out, by archive path
      skipped,
      // bsdtar prints a bare "tar: (null)" with exit 1 on a locked file; filtered out below
      warnings: [
        ...(flushWarning ? [flushWarning] : []),
        ...(saveOnWarning ? [saveOnWarning] : []),
        ...dumps.skipped.map((d) => `database ${d.database} on ${d.service} not included: ${d.reason}`),
        ...skipped.map((f) => `${f} not included: another program has it locked, usually the running server`),
        ...stderr
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^tar(\.exe)?:\s*\(null\)$/i.test(l.trim())),
      ].slice(0, 10),
    }
    writeJson(manifestFile, manifest)
    // same filesystem; history only sees the final name once tar is done and the manifest exists
    fs.renameSync(pending, file)
    published = true
    const { mirrored, mirrorError } = mirrorCopy(inst.name, file)
    // narrowed or quiet snapshots are taken before a change, and that change records itself
    if (!only && !quiet) activity.record(inst.name, 'backup', { detail: `${scope}${label ? ` (${label})` : ''}, ${humanBytes(size)}`, snapshot: path.basename(file) })
    return { file, size, members: archived, databases: dumps.dumped, databasesSkipped: dumps.skipped, skipped, manifest, mirrored, mirrorError, flushed, flushWarning, saveOnWarning }
  } catch (err) {
    // put the save-on warning in the error the person is about to read
    if (saveOnWarning && err instanceof Error) appendToError(err, saveOnWarning)
    throw err
  } finally {
    if (reservation && !published) {
      // keep the name reserved until its metadata is gone, so a concurrent backup can't claim it
      fs.rmSync(reservation.manifestFile, { force: true })
      fs.rmSync(reservation.manifestFile + '.tmp', { force: true })
      fs.rmSync(reservation.pending, { force: true })
    }
  }
}

// What is wrong with a snapshot that someone restoring it needs to know, in plain words, read from
// the warnings its manifest recorded. Only the two that change what the backup holds: a world
// copied while the server was still writing, and a database that is not in it. A file the running
// server held locked is routine on Windows and is not one of these.
export function snapshotProblems(warnings) {
  const out = []
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const text = String(w)
    if (/^could not flush the world before the snapshot/.test(text)) {
      out.push('Taken while the server was running and it could not be asked to save first, so the world in it may be incomplete.')
      continue
    }
    const db = /^database (.+?) on (.+?) not included: ([\s\S]*)$/.exec(text)
    // an engine that is never dumped (it keeps its own checkpoints) is not something that went wrong
    if (db && /keeps its own checkpoints/.test(db[3])) continue
    if (db) out.push(`Does not include the database ${db[1]} (${db[2]}): ${db[3].trim().replace(/\.$/, '')}.`)
  }
  return out
}

// A small copy: part of a server (its plugins, its config, or named files) that SpawnLoft took by
// itself before a change, so the change can be undone. The page keeps these out of the way of the
// backups, and they are the only thing the clean-up below ever looks at. The call that takes one
// says so (changeCopy), and the manifest records the answer either way, so a backup someone asked
// for is theirs whatever they labelled it. A manifest from before that was recorded is told by the
// labels SpawnLoft wrote then. A deleted world's copy (world-delete) is not one: it can be the only
// copy of that world there is.
const CHANGE_COPY_LABELS = new Set(['pre-install', 'pre-update', 'before-edit', 'file-edit', 'file-replace', 'file-delete'])
const PARTIAL_SCOPES = new Set(['plugins', 'config', 'files'])
export function isChangeCopy(manifest) {
  if (!manifest || !PARTIAL_SCOPES.has(manifest.scope) || manifest.taskId) return false
  if (typeof manifest.changeCopy === 'boolean') return manifest.changeCopy
  return CHANGE_COPY_LABELS.has(manifest.label)
}

// What was deleted in Files exists nowhere else, so its copy is kept out of the way like the
// others but is never removed for being old.
const neverCleaned = (snap) => snap.label === 'file-delete'

export function listSnapshots(name) {
  // a listing makes nothing: the panel answers it on a GET (test/panel-get-writes.test.mjs)
  const dir = path.join(BACKUPS_DIR, name)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const full = path.join(dir, f)
      const manifest = readJson(full.replace(/\.tar\.gz$/, '.json'), {})
      const st = fs.statSync(full)
      return {
        name: f,
        path: full,
        size: st.size,
        sizeHuman: humanBytes(st.size),
        mtime: st.mtime,
        scope: manifest.scope ?? '?',
        label: manifest.label ?? '',
        taskId: manifest.taskId ?? null,
        members: manifest.members ?? [],
        locked: manifest.locked === true,
        note: manifest.note ?? null,
        copy: isChangeCopy(manifest),
        excluded: manifest.excluded ?? [],
        databases: manifest.databases ?? [],
        problems: snapshotProblems(manifest.warnings),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

// Newest snapshot time and how many there are. Used by the panel overview for every server at
// once, so it only stats archives: no manifests, no folder created, async.
// A snapshot that holds part of a server (its plugins, its config, or named files) is a copy
// taken before a change, not a backup of the server: a plugin install must not read as "backed up
// just now". Told from the file name (label_scope_stamp), since the overview stats archives for
// every server at once and opens no manifest. A name that does not say is counted as a backup.
const PARTIAL_SCOPE_RE = /(?:^|_)(?:plugins|config|files)_\d{4}-\d{2}-\d{2}[_.]/
export function isPartialSnapshotName(file) {
  return PARTIAL_SCOPE_RE.test(String(file))
}

export async function snapshotSummary(name) {
  const dir = path.join(BACKUPS_DIR, name)
  let files
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.tar.gz'))
  } catch {
    return { newestAt: null, newestBackupAt: null, count: 0 }
  }
  const times = await Promise.all(files.map((f) => fs.promises.stat(path.join(dir, f)).then((s) => s.mtimeMs, () => 0)))
  const newest = Math.max(0, ...times)
  // newestBackupAt: the newest one that holds the worlds
  const newestBackup = Math.max(0, ...times.filter((_, i) => !isPartialSnapshotName(files[i])))
  return { newestAt: newest || null, newestBackupAt: newestBackup || null, count: times.filter(Boolean).length }
}

export async function newestSnapshotAt(name) {
  return (await snapshotSummary(name)).newestAt
}

export function resolveSnapshot(name, ref) {
  const all = listSnapshots(name)
  if (!all.length) fail(`no snapshots exist for "${name}"`)
  // "latest" is the newest backup someone would mean: not the copy a restore kept of what it
  // replaced, or restoring "latest" twice would undo the first restore
  if (!ref || ref === 'latest') return all.find((s) => s.label !== 'pre-restore') ?? all[0]
  const exact = all.find((s) => s.name === ref || s.name === `${ref}.tar.gz`)
  if (exact) return exact
  const partial = all.filter((s) => s.name.includes(ref))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    fail(`snapshot "${ref}" is ambiguous:\n  ${partial.map((s) => s.name).join('\n  ')}`)
  }
  fail(`no snapshot matching "${ref}" for "${name}"`)
}

// separate from restoreSnapshot so a preview can check before anyone confirms
export function checkRestorable(snapshot) {
  return verifyArchive(snapshot.path, snapshot.members ?? [], (snapshot.databases ?? []).map((d) => d.file))
}

// A restore marks the server for as long as it runs (control.mjs): a second restore, a delete, a
// new backup or a start on top of one refuses until it has finished, from any process.
export function isRestoring(name) {
  return restoreInProgress(name)
}
export function refuseWhileRestoring(name, verb) {
  const why = restoreBlock(name, verb)
  if (why) fail(why)
}

export async function restoreSnapshot(inst, snapshot, options = {}) {
  const done = beginRestore(inst.name)
  try {
    return await restoreSnapshotLocked(inst, snapshot, options)
  } finally {
    done()
  }
}

async function restoreSnapshotLocked(inst, snapshot, { quiet = false, clean = false, safety: keepCopy = true } = {}) {
  if (!fs.existsSync(inst.dir)) fail(`instance directory is missing: ${inst.dir}`)
  if (clean && !(snapshot.members ?? []).some((m) => m !== 'databases')) {
    fail(`${snapshot.name} does not record what it holds, so there is nothing it can safely clear first`)
  }
  // a clean restore deletes what the manifest names, so a manifest listing "../x" must not be trusted
  const outside = clean ? (snapshot.members ?? []).find((m) => m !== 'databases' && safeRelativePath(m) === null) : undefined
  if (outside !== undefined) {
    fail(`${snapshot.name} lists "${outside}", which is not inside the server folder, so it cannot clear anything first; nothing was changed`)
  }

  // Check before touching any file: extraction overwrites in place, so an archive that stops
  // partway would leave a server that is neither the backup nor what it replaced.
  const check = await checkRestorable(snapshot)
  if (!check.ok) {
    fail(`${snapshot.name} would not restore cleanly, so nothing was changed.\n  ` +
      check.problems.join('\n  ') +
      `\n  Choose an older snapshot; "spawnloft verify ${inst.name} --all" checks every one.`)
  }

  // What the snapshot is about to overwrite is snapshotted first (whole, including leave-out
  // paths), so a restore of the wrong backup can itself be undone. A clean restore then clears
  // those members, since an ordinary restore only adds and overwrites. A caller that is itself
  // undoing something (putting deleted files back) passes safety: false; a clean restore always
  // keeps its copy, because it deletes.
  let safety = null
  if (clean || keepCopy) {
    const present = (snapshot.members ?? [])
      .filter((m) => m !== 'databases' && safeRelativePath(m) !== null)
      .filter((m) => fs.existsSync(path.join(inst.dir, ...m.split(/[\\/]/))))
    if (present.length) {
      let res
      try {
        res = await createSnapshot(inst, { scope: 'files', label: 'pre-restore', members: present, flush: false, duringRestore: true })
      } catch (err) {
        // A full disk is one of the times people restore. A clean restore deletes, so it stops
        // here; an ordinary one can go ahead without the copy, but only when asked to.
        fail(`Could not keep a copy of how things are now, so nothing was changed (${err.message}).` +
          (clean ? '' : ' It can be restored without that copy, which cannot be undone.'), clean ? undefined : 'no-copy')
      }
      safety = path.basename(res.file)
      if (clean) for (const m of present) await fs.promises.rm(path.join(inst.dir, ...m.split(/[\\/]/)), { recursive: true, force: true })
    }
  }

  // runTar tolerates exit 1 (a warning when creating), but when reading it means a bad archive
  const { code, stderr } = await runTar(['-xzf', snapshot.path], inst.dir)
  if (code !== 0) {
    fail(`restoring ${snapshot.name} stopped partway (tar exited ${code}` +
      `${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ''}). ` +
      `Some files in ${inst.dir} may already have been replaced; restore another snapshot before starting it.`)
  }

  // The dumps were extracted under databases/ in the server folder. Import them and remove them;
  // a dump that can't be imported stays in place so it can be imported by hand.
  let databases = { imported: [], skipped: [] }
  const dumps = snapshot.databases ?? []
  if (dumps.length) {
    databases = await services.importDumps(inst.name, dumps, inst.dir)
    for (const d of databases.imported) {
      const rel = safeRelativePath(d.file)
      if (rel !== null) fs.rmSync(path.join(inst.dir, ...rel.split('/')), { force: true })
    }
    const folder = path.join(inst.dir, 'databases')
    try {
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    } catch {
      /* ignore: not worth failing a restore that already happened */
    }
  }
  if (!quiet) activity.record(inst.name, 'restore', { detail: snapshot.name + (safety ? `${clean ? ', cleared first' : ''}; how it was is kept as ${safety}` : ''), snapshot: safety })
  return { restored: snapshot.name, into: inst.dir, members: snapshot.members, databases, safety }
}

function manifestOf(snap) {
  return readJson(snap.path.replace(/\.tar\.gz$/, '.json'), {})
}

function updateManifest(snap, patch) {
  const file = snap.path.replace(/\.tar\.gz$/, '.json')
  // older snapshots have no manifest; create one for the lock/note
  writeJson(file, { ...readJson(file, {}), ...patch })
}

// a locked snapshot is never deleted by retention or the Delete button until unlocked
export function setSnapshotLocked(name, ref, locked) {
  const snap = resolveSnapshot(name, ref)
  updateManifest(snap, { locked: Boolean(locked) })
  activity.record(name, locked ? 'backup-lock' : 'backup-unlock', { detail: snap.name })
  return { name: snap.name, locked: Boolean(locked) }
}

// short note shown beside the snapshot name, e.g. "before the 1.21 upgrade"
export function setSnapshotNote(name, ref, note) {
  const snap = resolveSnapshot(name, ref)
  const clean = String(note ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || null
  updateManifest(snap, { note: clean })
  activity.record(name, 'backup-note', { detail: clean ? `${snap.name}: ${clean}` : `${snap.name} (note removed)` })
  return { name: snap.name, note: clean }
}

export function excludePatterns(inst) {
  return Array.isArray(inst.backupExclude) ? inst.backupExclude : []
}

// Leave-out list: paths inside the server folder, one per line, optional * wildcards
// ("plugins/dynmap/web", "*.log"). No absolute paths, no "..", not the whole folder.
export function cleanExcludePatterns(input) {
  const lines = (Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/))
    .map((l) => String(l).trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter((l) => l && !l.startsWith('#'))
  if (lines.length > 40) fail('keep the list to 40 lines')
  for (const l of lines) {
    if (l.length > 200) fail(`"${l.slice(0, 40)}..." is too long`)
    if (l.startsWith('/') || /^[a-z]:/i.test(l) || l.split('/').includes('..')) fail(`"${l}" must be a path inside the server folder`)
    if (l === '*' || l === '**' || l === '.') fail(`"${l}" would leave out everything`)
  }
  return [...new Set(lines)]
}

// Reads the archive back with -t, which decompresses every block and so checks the gzip
// checksums, then compares the listing to the manifest's top-level members (catches an archive
// that reads fine but lacks a world). Any non-zero exit is a failure here, unlike creation.
export async function verifyArchive(file, expectedMembers = [], expectedFiles = []) {
  const problems = []
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return { ok: false, size: 0, entries: 0, missing: [], problems: ['the archive file is missing'] }
  }
  if (size === 0) {
    return { ok: false, size, entries: 0, missing: [], problems: ['the archive is zero bytes'] }
  }

  let entries = 0
  const roots = new Set()
  // every entry, kept only when specific files are expected (database dumps must be there by name)
  const files = expectedFiles.length ? new Set() : null
  const sawEntry = (line) => {
    const entry = line.trim().replace(/\\/g, '/')
    if (!entry) return
    entries++
    roots.add(entry.split('/')[0])
    if (files) files.add(entry.replace(/\/$/, ''))
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(tarBinary(), ['-tzf', file], { windowsHide: true })
      let stderr = ''
      let tail = ''
      child.stderr.on('data', (c) => {
        stderr += c.toString()
      })
      child.stdout.on('data', (c) => {
        const lines = (tail + c.toString()).split('\n')
        tail = lines.pop()
        for (const line of lines) sawEntry(line)
      })
      child.on('error', (err) =>
        reject(new Error(err.code === 'ENOENT'
          ? 'tar was not found on PATH (Windows 10/11 ships tar.exe in System32)'
          : err.message)))
      // 'close', not 'exit': exit can fire while the listing is still in the stdout pipe
      child.on('close', (code) => {
        sawEntry(tail)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split(/\r?\n/)[0] || `tar exited ${code}`))
      })
    })
  } catch (err) {
    problems.push(`the archive does not read back: ${err.message}`)
  }

  let missing = []
  if (!problems.length) {
    if (!entries) problems.push('the archive reads back but holds no entries')
    // skipped when the read failed: a truncated listing would report every later member missing
    missing = expectedMembers.filter((m) => !roots.has(String(m).replace(/\\/g, '/').split('/')[0]))
    for (const member of missing) {
      problems.push(`the manifest lists "${member}" but the archive does not contain it`)
    }
    for (const f of expectedFiles) {
      const want = String(f).replace(/\\/g, '/')
      if (!files.has(want)) {
        missing.push(want)
        problems.push(`the manifest lists the database dump "${want}" but the archive does not contain it`)
      }
    }
  }
  return { ok: problems.length === 0, size, entries, missing, problems }
}

export async function verifySnapshot(name, ref) {
  const snap = resolveSnapshot(name, ref)
  const result = await verifyArchive(snap.path, snap.members, (snap.databases ?? []).map((d) => d.file))
  // without a manifest the member check proves nothing, so report that
  const hasManifest = fs.existsSync(snap.path.replace(/\.tar\.gz$/, '.json'))
  return { snapshot: snap, hasManifest, ...result }
}

// removes the archive and its manifest together
export function removeSnapshot(name, ref) {
  refuseWhileRestoring(name, 'deleting a backup')
  const snap = resolveSnapshot(name, ref)
  if (manifestOf(snap).locked) fail(`${snap.name} is locked. Unlock it first if it really should go.`)
  fs.rmSync(snap.path, { force: true })
  fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
  mirrorRemove(name, snap.name)
  activity.record(name, 'backup-delete', { detail: snap.name })
  return { removed: snap.name, size: snap.size }
}

// `only` limits pruning to one label and the scheduler always passes it: retention covers the
// automatic backups a schedule makes, not pre-rebuild or manual snapshots.
export function pruneSnapshots(name, keep, { only = null, taskId = null } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new UserError('keep must be a whole number of at least 1')
  const all = listSnapshots(name).filter((s) => {
    if (only && s.label !== only) return false
    // a limit applies only to the task that set it
    if (taskId && s.taskId !== taskId) return false
    return true
  })
  // locked snapshots neither count toward the limit nor get removed by it
  const remove = all.filter((s) => !s.locked).slice(keep)
  for (const snap of remove) {
    fs.rmSync(snap.path, { force: true })
    fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
    mirrorRemove(name, snap.name)
  }
  if (remove.length) activity.record(name, 'backup-prune', { detail: `${remove.length} removed, the newest ${keep} kept` })
  return remove
}

// Removes one archive with its manifest and its second copy. Answers false when the archive would
// not go (on Windows, a file someone is downloading stays), and then leaves its manifest too.
function removeFiles(name, snap) {
  try {
    fs.rmSync(snap.path, { force: true })
  } catch {
    return false
  }
  fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
  mirrorRemove(name, snap.name)
  return true
}

// Several at once, by their exact names as the history lists them: no "latest", no part of a name,
// since a delete of many must not guess at any of them. A locked one, one that is no longer there
// or one that is open somewhere is left and said; the rest still go. One line in the activity for
// what went.
export const REMOVE_MANY_LIMIT = 500
export function removeSnapshots(name, refs) {
  refuseWhileRestoring(name, 'deleting backups')
  if (!Array.isArray(refs) || !refs.length) fail('which backups?')
  if (refs.length > REMOVE_MANY_LIMIT) fail(`at most ${REMOVE_MANY_LIMIT} backups at a time`)
  const byName = new Map(listSnapshots(name).map((s) => [s.name, s]))
  const removed = []
  const skipped = []
  let size = 0
  for (const ref of [...new Set(refs.map(String))]) {
    const snap = byName.get(ref)
    const reason = !snap ? 'missing' : snap.locked ? 'locked' : removeFiles(name, snap) ? null : 'busy'
    if (reason) {
      skipped.push({ name: ref, reason })
      continue
    }
    removed.push(snap.name)
    size += snap.size
  }
  if (removed.length === 1) activity.record(name, 'backup-delete', { detail: removed[0] })
  else if (removed.length) activity.record(name, 'backup-delete', { detail: `${removed.length} backups, ${humanBytes(size)}` })
  return { removed, size, skipped }
}

// The clean-up a server can turn on (registry: backupCleanCopies). It removes small copies, as
// isChangeCopy defines them, once they are older than COPY_DAYS. Never a backup, a locked one, one
// somebody put a note on, or the copy of something deleted in Files. Off unless turned on.
// `only` narrows it to named ones: what the page listed when it asked.
export const COPY_DAYS = 30
export function oldCopies(name, { now = Date.now(), days = COPY_DAYS } = {}) {
  const before = now - days * 24 * 3600 * 1000
  return listSnapshots(name).filter((s) => s.copy && !neverCleaned(s) && !s.locked && !s.note && new Date(s.mtime).getTime() < before)
}

export function cleanCopies(name, { now = Date.now(), days = COPY_DAYS, only = null } = {}) {
  if (isRestoring(name)) return { removed: [], size: 0 }
  const names = only ? new Set(only.map(String)) : null
  const gone = []
  let size = 0
  for (const snap of oldCopies(name, { now, days })) {
    if (names && !names.has(snap.name)) continue
    // one that will not go now is tried again by the next clean-up
    if (!removeFiles(name, snap)) continue
    gone.push(snap.name)
    size += snap.size
  }
  if (gone.length) {
    activity.record(name, 'backup-prune', { detail: `${gone.length} small ${gone.length === 1 ? 'copy' : 'copies'} older than ${days} days, ${humanBytes(size)}` })
  }
  return { removed: gone, size }
}

// The archives a server has, by name and nothing else: for asking whether a copy is still there.
export function snapshotNames(name) {
  try {
    return new Set(fs.readdirSync(path.join(BACKUPS_DIR, name)).filter((f) => f.endsWith('.tar.gz')))
  } catch {
    return new Set()
  }
}
