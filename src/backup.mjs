import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKUPS_DIR } from './paths.mjs'
import { runTar, tarBinary } from './tar.mjs'
import * as services from './services.mjs'
import { readProps, worldDirs } from './props.mjs'
import * as settings from './settings.mjs'
import { rconExec } from './rcon.mjs'
import { fail, stamp, humanBytes, writeJson, readJson, UserError } from './util.mjs'

/**
 * The mirror: a second location every snapshot is copied to as it is taken.
 *
 * <p>This closes the oldest risk in the tool: servers and their snapshots on one drive
 * means one disk failure takes both the thing and its way back. Read live from settings
 * rather than resolved at startup, so turning it on needs no restart - and a mirror that
 * cannot be written never fails the backup that just succeeded: the primary snapshot is
 * real, and the failure to copy it is reported, loudly, as exactly that.
 */
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
    return { mirrored: null, mirrorError: `the snapshot is safe, but mirroring it failed: ${err.message}` }
  }
}

/** Deletions keep the mirror in step - a retention limit that only thins one side is not one. */
function mirrorRemove(name, snapName) {
  const root = mirrorRoot()
  if (!root) return
  try {
    fs.rmSync(path.join(root, name, snapName), { force: true })
    fs.rmSync(path.join(root, name, snapName.replace(/\.tar\.gz$/, '.json')), { force: true })
  } catch {
    /* a mirror that cannot be tidied is rediscovered at the next copy */
  }
}

export const SCOPES = ['plugins', 'worlds', 'config', 'standard', 'full']

/**
 * Things that must never go into a snapshot.
 *
 * <p>`session.lock` is the one that matters. Minecraft holds it open exclusively for as long as the
 * server runs, and bsdtar does not skip a file it cannot read - it gives up on the whole archive,
 * exits 1, and leaves a zero-byte .tar.gz behind. So every snapshot of a running server produced
 * nothing while reporting success.
 *
 * <p>Excluding it costs nothing: it is a lock, it is regenerated on the next start, and restoring
 * a stale one would be actively wrong.
 */
export const EXCLUDE_ARGS = ['--exclude', 'session.lock']

/**
 * Files under `members` that cannot be read right now, as archive paths.
 *
 * <p>session.lock is not the only one. Any plugin with an embedded database holds its file the
 * same way - LuckPerms' default H2 store is the common case - and bsdtar does not skip it either:
 * it stops writing at that file and exits 1, the code it also uses for harmless hot-snapshot
 * warnings. The result was an archive cut off partway through the plugins folder, with no world
 * in it, recorded as a successful backup of the right size to look plausible.
 *
 * <p>A file that cannot be read cannot be backed up by anything, so these are excluded and named
 * in the manifest's warnings: the rest of the server is still worth having, and the warning says
 * exactly what is missing. Windows only: POSIX locks are advisory and tar reads straight through
 * them. Asynchronous, because a world is thousands of files and the panel's event loop must not
 * stall on them.
 */
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
    // Opening succeeds on a locked file; it is the read that fails, so one byte is read.
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

// A literal path as a bsdtar pattern: the glob characters are bracketed so they match themselves.
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

/** Directories that are large, regenerable, and pointless to snapshot. */
const FULL_EXCLUDES = ['cache', 'libraries', 'versions', 'logs']

function backupDir(name) {
  const dir = path.join(BACKUPS_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function reserveSnapshot(dir, base) {
  // The reservation is also tar's output. It never ends in .tar.gz, so history
  // cannot offer a partially written archive to restore. Exclusive creation
  // coordinates the CLI, panel, and scheduled tasks even in the same second.
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

function membersFor(inst, scope) {
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const exists = (p) => fs.existsSync(path.join(inst.dir, p))

  // Mods are plugins' sibling on a Fabric server; the plugins scope covers both, because the
  // scope names the ROLE (the server's content) rather than the folder.
  const plugins = [...(exists('plugins') ? ['plugins'] : []), ...(exists('mods') ? ['mods'] : [])]
  const worlds = worldDirs(props).filter(exists)
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

export { runTar, tarBinary } from './tar.mjs'

/**
 * Take a snapshot.
 *
 * <p>A RUNNING server is flushed first: `save-off` stops it writing chunks mid-archive, `save-all
 * flush` pushes everything it holds in memory to disk, and `save-on` afterwards hands the world
 * back. Without that a hot snapshot is a torn copy of a world mid-write. This lives here, not in
 * the callers, because it used to live in exactly one caller - the CLI's `backup` command - while
 * the panel's "back up now", the nightly scheduled backup, and the pre-upgrade snapshot all took
 * unflushed copies and the README promised otherwise. A flush that cannot be done (RCON down) is
 * reported in the result and the manifest rather than failing the snapshot: an unflushed copy is
 * still worth more than none.
 */
export async function createSnapshot(inst, { scope = 'standard', label = null, running = false, taskId = null, flush = true } = {}) {
  const members = membersFor(inst, scope)
  if (!members.length) fail(`nothing to back up for scope "${scope}" in ${inst.dir}`)

  const slug = label ? `${label.replace(/[^a-z0-9_-]/gi, '-')}_` : ''
  const base = `${slug}${scope}_${stamp()}`
  const dir = backupDir(inst.name)

  /*
    The databases this server is attached to go in too, as a `databases/` member holding one SQL
    dump per database. Dumped into a scratch folder and added from there with -C, so the server's
    own folder never holds a copy of its database. Only for the scopes that mean "the data":
    plugins, worlds and config each name one kind of file, and a dump is none of them.

    A database that is not running cannot be dumped. That is a warning in the manifest, not a
    failed backup: the worlds are still worth taking, and the warning says what is missing.
  */
  let dumps = { dumped: [], skipped: [] }
  let dumpDir = null
  if (scope === 'standard' || scope === 'full') {
    dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-dump-'))
    try {
      dumps = await services.dumpAttachments(inst.name, dumpDir)
    } catch (err) {
      fs.rmSync(dumpDir, { recursive: true, force: true })
      throw err
    }
  }
  const dumpArgs = dumps.dumped.length ? ['-C', dumpDir, 'databases'] : []
  const archived = dumps.dumped.length ? [...members, 'databases'] : members

  let flushed = false
  let flushWarning = null
  if (running && flush) {
    try {
      await rconExec(inst, ['save-off', 'save-all flush'])
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
      // After the flush, so the files are checked in the state tar will find them.
      skipped = await lockedFiles(inst.dir, members)
      const skipArgs = skipped.flatMap((f) => ['--exclude', literalPattern(f)])
      ;({ stderr, code } = await runTar(['-czf', reservation.pending, ...EXCLUDE_ARGS, ...skipArgs, ...members, ...dumpArgs], inst.dir))
    } finally {
      // save-on whether or not tar succeeded: leaving a live server with saving off is worse than
      // any failed backup.
      if (flushed) {
        try {
          await rconExec(inst, ['save-on'])
        } catch {
          /* the server may have stopped mid-backup; nothing is left to turn back on */
        }
      }
      if (dumpDir) fs.rmSync(dumpDir, { recursive: true, force: true })
    }

    const { file, pending, manifestFile } = reservation
    const size = fs.statSync(pending).size
    // An empty archive is not a snapshot, and this one is load-bearing: rebuild and delete both take
    // one "first" and both are safe only if it exists. bsdtar reports a locked file as exit 1, which
    // is deliberately tolerated above because a hot snapshot legitimately skips things - so without
    // this check a failure that produced nothing at all would be recorded as a successful backup.
    if (size === 0) {
      const said = stderr.trim().split(/\r?\n/)[0]
      fail(
        `snapshot of "${inst.name}" came out empty and has been discarded.` +
          (said ? `\n  tar said: ${said}` : ''),
      )
    }
    // Exit 1 is tolerated above, but it is also how bsdtar reports giving up partway through - a
    // file that became locked after the check, or anything else it could not read. So an archive
    // written with warnings is read back before it is published. A clean exit means tar read
    // everything, and a large world is not read twice for nothing.
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
      // Which scheduled task produced this, so its retention limit governs its own snapshots
      // and nobody else's. Null for anything a person asked for directly.
      taskId,
      members: archived,
      // The dumps, by file inside the archive, so a restore knows what to import and verify knows
      // what to look for. Empty when the server is attached to nothing.
      databases: dumps.dumped,
      sourceDir: inst.dir,
      createdAt: new Date().toISOString(),
      size,
      serverWasRunning: running,
      flushed,
      // Files left out because another program held them locked, by archive path.
      skipped,
      // bsdtar emits an undescribed "tar: (null)" (or "tar.exe: (null)") alongside exit 1 when it
      // meets a locked file. That carries no signal.
      warnings: [
        ...(flushWarning ? [flushWarning] : []),
        ...dumps.skipped.map((d) => `database ${d.database} on ${d.service} not included: ${d.reason}`),
        ...skipped.map((f) => `${f} not included: another program has it locked, usually the running server`),
        ...stderr
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^tar(\.exe)?:\s*\(null\)$/i.test(l.trim())),
      ].slice(0, 10),
    }
    writeJson(manifestFile, manifest)
    // Both are on the same filesystem. History sees the final filename only after
    // tar has closed it and its complete manifest is already available.
    fs.renameSync(pending, file)
    published = true
    const { mirrored, mirrorError } = mirrorCopy(inst.name, file)
    return { file, size, members: archived, databases: dumps.dumped, databasesSkipped: dumps.skipped, skipped, manifest, mirrored, mirrorError, flushed, flushWarning }
  } finally {
    if (reservation && !published) {
      // Keep the name reserved until its metadata is gone. Releasing it first
      // lets a simultaneous CLI backup claim the name while this cleanup runs.
      fs.rmSync(reservation.manifestFile, { force: true })
      fs.rmSync(reservation.manifestFile + '.tmp', { force: true })
      fs.rmSync(reservation.pending, { force: true })
    }
  }
}

export function listSnapshots(name) {
  const dir = backupDir(name)
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
        databases: manifest.databases ?? [],
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

export function resolveSnapshot(name, ref) {
  const all = listSnapshots(name)
  if (!all.length) fail(`no snapshots exist for "${name}"`)
  if (!ref || ref === 'latest') return all[0]
  const exact = all.find((s) => s.name === ref || s.name === `${ref}.tar.gz`)
  if (exact) return exact
  const partial = all.filter((s) => s.name.includes(ref))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    fail(`snapshot "${ref}" is ambiguous:\n  ${partial.map((s) => s.name).join('\n  ')}`)
  }
  fail(`no snapshot matching "${ref}" for "${name}"`)
}

/**
 * Whether a snapshot would restore: the whole archive read back and checked against its manifest.
 *
 * <p>Separate from restoreSnapshot so a preview can say it before anyone confirms.
 */
export function checkRestorable(snapshot) {
  return verifyArchive(snapshot.path, snapshot.members ?? [], (snapshot.databases ?? []).map((d) => d.file))
}

export async function restoreSnapshot(inst, snapshot) {
  if (!fs.existsSync(inst.dir)) fail(`instance directory is missing: ${inst.dir}`)

  // Checked before a single file is touched. Extraction overwrites in place and cannot be undone,
  // so an archive that stops partway - as every hot snapshot of a server with a locked plugin
  // database did before that was fixed, and as a disk error can do to any archive - would replace
  // the start of the server with its old copy and leave the rest as it was: a server that is
  // neither the backup nor what it replaced. "latest" makes that the default choice whenever the
  // newest snapshot is the broken one.
  const check = await checkRestorable(snapshot)
  if (!check.ok) {
    fail(`${snapshot.name} would not restore cleanly, so nothing was changed.\n  ` +
      check.problems.join('\n  ') +
      `\n  Choose an older snapshot; "spawnloft verify ${inst.name} --all" checks every one.`)
  }

  // runTar accepts exit 1 because bsdtar uses it for warnings while creating an archive. Reading
  // one, it means the archive did not read, so here it is a failure like any other.
  const { code, stderr } = await runTar(['-xzf', snapshot.path], inst.dir)
  if (code !== 0) {
    fail(`restoring ${snapshot.name} stopped partway (tar exited ${code}` +
      `${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ''}). ` +
      `Some files in ${inst.dir} may already have been replaced; restore another snapshot before starting it.`)
  }

  // The dumps came out with everything else, under databases/ in the server folder. Imported
  // into the databases they came from, then removed from the folder; a dump that cannot be
  // imported - its database gone, or stopped - is left where it is and named, so it can be
  // imported by hand rather than lost.
  let databases = { imported: [], skipped: [] }
  const dumps = snapshot.databases ?? []
  if (dumps.length) {
    databases = await services.importDumps(inst.name, dumps, inst.dir)
    for (const d of databases.imported) fs.rmSync(path.join(inst.dir, d.file), { force: true })
    const folder = path.join(inst.dir, 'databases')
    try {
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    } catch {
      /* a folder that will not go is not worth failing a restore that already happened */
    }
  }
  return { restored: snapshot.name, into: inst.dir, members: snapshot.members, databases }
}

/**
 * Read one archive back, end to end, and check it holds what it is supposed to.
 *
 * <p>A backup only actually exists at restore time - until then it is a file nothing has read
 * since the day it was written. Listing with -t decompresses every block, so the gzip checksums
 * are genuinely checked: this is not a stricter test than restoring, it IS restoring, minus the
 * writes. Any complaint here is the complaint a restore would make on the day it mattered.
 *
 * <p>The listing is then compared against the manifest's top-level members. That catches the
 * other way a snapshot lies: an archive that reads back perfectly but is missing a world,
 * because something held it locked on the night it was taken.
 *
 * <p>Unlike creation, a non-zero exit here is always a failure. runTar tolerates exit 1 because
 * bsdtar uses it for hot-snapshot warnings; on a read, exit 1 is how corruption reports itself.
 */
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
  // Every entry, kept only when a caller asked about specific files: the database dumps have to
  // be there by name, not merely under a folder that exists.
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
      child.on('exit', (code) => {
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
    // Only checked when the walk succeeded: a truncated archive's partial listing would report
    // every later member missing, which buries the actual finding under its consequences.
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
  // No manifest means the member check was vacuous, not that it passed. Said, so an "ok" on a
  // manifest-less archive is read at its actual strength.
  const hasManifest = fs.existsSync(snap.path.replace(/\.tar\.gz$/, '.json'))
  return { snapshot: snap, hasManifest, ...result }
}

/**
 * Delete one snapshot, and the manifest that describes it.
 *
 * <p>Both or neither: a manifest without its archive is a row in the history that cannot be
 * restored, and an archive without its manifest loses the record of what is inside it.
 */
export function removeSnapshot(name, ref) {
  const snap = resolveSnapshot(name, ref)
  fs.rmSync(snap.path, { force: true })
  fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
  mirrorRemove(name, snap.name)
  return { removed: snap.name, size: snap.size }
}

/**
 * Trim a server's snapshots down to a limit.
 *
 * <p>`only` narrows it to snapshots carrying one label, and the scheduler always passes it.
 * Retention is a rule about the automatic backups a schedule produces, not a licence to delete
 * everything else in the folder - and everything else is where the important ones live. A
 * `pre-rebuild` snapshot is the single copy of a world taken before it was wiped, and a `manual`
 * one was taken because somebody was about to try something. An hourly task set to keep 5 would
 * have deleted both within five hours of them being made.
 */
export function pruneSnapshots(name, keep, { only = null, taskId = null } = {}) {
  const all = listSnapshots(name).filter((s) => {
    if (only && s.label !== only) return false
    // A limit belongs to the task that set it. Two scheduled backups on one server - a nightly
    // keeping 7 and a weekly archive keeping 8 - were drawing from the same pool, so whichever ran
    // next applied its own number to the other's snapshots and the smaller limit always won. The
    // weekly archive could never accumulate eight weeks of anything.
    if (taskId && s.taskId !== taskId) return false
    return true
  })
  const remove = all.slice(keep)
  for (const snap of remove) {
    fs.rmSync(snap.path, { force: true })
    fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
    mirrorRemove(name, snap.name)
  }
  return remove
}
