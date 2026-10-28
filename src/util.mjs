import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { writePrivateFile } from './private-files.mjs'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'

// Prints as a one-line message instead of a stack.
export class UserError extends Error {}

// code, when given, names the refusal for callers that act on it (the launcher page, MCP).
export function fail(msg, code = undefined) {
  const err = new UserError(msg)
  if (code !== undefined) err.code = code
  throw err
}

// Cached pid -> image name table. A pid alone can't say whether a process is the one a state
// file remembers (Windows reuses pids quickly, and `kill` would taskkill a stranger), so the
// image name is the cheap second check.
//
// `tasklist` is slow (a third of a second to over one). The first read is synchronous; later
// refreshes run in the background and a stale read returns the old table, so the panel's polling
// never blocks. A pid the table hasn't caught up with is trusted (see sameProcess).
let processTable = { at: 0, names: null }
let refreshing = null
const PROCESS_TABLE_MS = 2000

const TABLE_COMMAND = process.platform === 'win32'
  ? ['tasklist', ['/FO', 'CSV', '/NH']]
  : ['ps', ['-A', '-o', 'pid=,comm=']]

function parseProcessTable(stdout) {
  const names = new Map()
  if (process.platform === 'win32') {
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line)
      if (m) names.set(Number(m[2]), m[1])
    }
  } else {
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      if (m) names.set(Number(m[1]), path.basename(m[2]))
    }
  }
  return names
}

function readProcessTable() {
  try {
    const [cmd, args] = TABLE_COMMAND
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (r.error || r.status !== 0) return null
    return parseProcessTable(r.stdout)
  } catch {
    return null
  }
}

// Refreshes without blocking; a call while one is in flight joins it.
export function refreshProcessTable() {
  if (refreshing) return refreshing
  const [cmd, args] = TABLE_COMMAND
  const queriedAt = Date.now()
  refreshing = new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      refreshing = null
      // A failed read keeps the previous table; an old answer beats none.
      if (!err && queriedAt >= processTable.at) processTable = { at: queriedAt, names: parseProcessTable(stdout) }
      resolve(processTable.names)
    })
  })
  return refreshing
}

/** The executable name behind a pid, or null if the table can't be read or lacks it. */
export function processImage(pid) {
  if (!pid) return null
  if (!processTable.names) {
    processTable = { at: Date.now(), names: readProcessTable() }
  } else if (Date.now() - processTable.at > PROCESS_TABLE_MS) {
    refreshProcessTable()
  }
  return processTable.names?.get(pid) ?? null
}

// On Linux, the executable a pid is running, from /proc/<pid>/exe. The name `ps` shows is only a
// thread label the program may change (newer Node names its threads, so `ps` shows "MainThread"),
// whereas the link can't be changed or truncated. It is tried first and only ever says yes: if it
// can't be read or names something else (Java started through a link called java21 runs a file
// called java), the table name still gets its say. The kernel appends " (deleted)" once an
// upgrade replaces the file.
export function executableName(pid, readlink = fs.readlinkSync) {
  try {
    return path.basename(String(readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ''))
  } catch {
    return null
  }
}

// Whether a live pid is still the process it was recorded as. Lenient unless contradicted: no
// recorded name (old state file), an unreadable table, or a pid the table hasn't caught up with
// all answer true. Only "alive, and wearing a different name" answers false.
export function sameProcess(pid, expectedImage, startedAt = 0) {
  if (!expectedImage) return true
  if (process.platform === 'linux') {
    const exe = executableName(pid)
    if (exe && sameImage(exe, expectedImage)) return true
  }
  let actual = processImage(pid)
  // Windows reuses pids: if the snapshot predates this launch, recheck before trusting a
  // contradiction so a new daemon isn't rejected over the previous owner's name.
  if (actual && startedAt > processTable.at && !sameImage(actual, expectedImage)) {
    const at = Date.now()
    const names = readProcessTable()
    if (names) { processTable = { at, names }; actual = names.get(pid) ?? null }
  }
  if (!actual) return true
  return sameImage(actual, expectedImage)
}

// Linux keeps only fifteen bytes of a process name, so `ps` shows spawnloft-desktop as
// "spawnloft-deskt". A table name of exactly fifteen bytes therefore matches whatever it is the
// start of.
export function sameImage(actual, expected, platform = process.platform) {
  const strip = (s) => String(s).toLowerCase().replace(/\.exe$/, '')
  const [a, e] = [strip(actual), strip(expected)]
  if (a === e) return true
  return platform === 'linux' && Buffer.byteLength(a) === 15 && e.startsWith(a)
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

// Owner-only mode for files holding secrets (RCON and database passwords, webhook URLs, tokens).
// Windows ignores the mode, so there the file gets an explicit ACL (see private-files.mjs).
export const PRIVATE_FILE_MODE = 0o600

// The mode passed to a write only applies when it creates the file, so chmod covers a leftover
// temp file or an older, wider one; on Windows the file is protected before the data goes in.
// Returns { ok } or { ok: false, reason }; a mode that is not owner-only needs no Windows ACL.
export function writeFileWithMode(file, data, mode) {
  return writePrivateFile(file, data, mode)
}

// Writes through a temp file and a rename so a crash leaves the old file whole. `mode` is for
// secrets (PRIVATE_FILE_MODE); each write replaces the file, so wider permissions get tightened,
// and the temp file is protected before the rename, so the file is never there with wide
// permissions. With `strict`, a file that could not be protected is not written at all (the
// accounts file: a refresh token readable by every local user is worse than a failed sign-in).
export function writeJson(file, data, { mode, strict = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const text = `${JSON.stringify(data, null, 2)}\n`
  let protection = { ok: true }
  if (mode === undefined) fs.writeFileSync(tmp, text)
  else protection = writeFileWithMode(tmp, text, mode)
  if (strict && !protection.ok) {
    fs.rmSync(tmp, { force: true })
    throw new UserError(`could not make ${file} readable by you alone (${protection.reason}), so it was not written; it needs a drive with file permissions (NTFS on Windows), see spawnloft config set-root`)
  }
  renameOver(tmp, file)
  return protection
}

// Windows: a just-written file is often held by a virus scanner, indexer or sync client, so
// renaming over it fails with EPERM/EBUSY/EACCES. Retry with growing waits (about 1.5 s in
// total); a file still held after that is reported as a one-line error, not a stack trace.
export const RENAME_RETRIES = 5

export function renameOver(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      if (attempt >= RENAME_RETRIES) {
        throw Object.assign(new UserError(`could not replace ${to}: another program (a virus scanner, indexer or sync client) is holding it (${err.code}); try again in a moment`), { code: err.code, cause: err })
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt)
    }
  }
}

// Cross-process lock via an exclusively created file (CLI, panel and daemon all use it). The
// file carries the holder's pid, and a lock whose pid is no longer alive is taken over, which
// beats a fixed age that would steal from a slow holder or sit on a dead one.
//
// Waits by blocking the thread, so only another process can be holding the lock; fine for
// synchronous critical sections (withLock), wrong for anything that awaits while holding it
// (use acquireLockAsync).
//
// mode 'wait' retries until timeoutMs; 'fail' returns null immediately, for a start or install
// where a silently queued second attempt is worse than being told to retry.
export function acquireLock(lockFile, { mode = 'wait', timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = tryLock(lockFile)
    if (result.ok) return result.release
    if (mode === 'fail') return null
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockFile} (held by pid ${result.holder})`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}

// acquireLock's 'wait' mode, but awaiting a timer so another holder in this same process (a
// backup in one request, a second request waiting) can keep running and release the lock.
export async function acquireLockAsync(lockFile, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = tryLock(lockFile)
    if (result.ok) return result.release
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockFile} (held by pid ${result.holder})`)
    await sleep(20)
  }
}

// Parses a lock file into { pid, token }. A bare number is the legacy format. Null for an empty
// or unreadable file (a lock being written, or damaged).
function lockRecord(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return { pid: Number(t) }
  try {
    const rec = JSON.parse(t)
    return Number.isInteger(rec?.pid) && rec.pid > 0 ? rec : null
  } catch {
    return null
  }
}

// Only the pid is checked, not the program: a program check declared a live holder dead in the
// packaged Windows app. A reused pid keeps the lock held until that process exits.
function holderAlive(rec) {
  if (!rec) return false
  if (rec.pid === process.pid) return true
  return pidAlive(rec.pid)
}

// Windows leaves a just-deleted file unopenable until the last handle closes, which throws
// EPERM when several processes take over one abandoned lock at once.
const LOCK_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RM_RETRY = { force: true, maxRetries: 10, retryDelay: 10 }

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A lock file this young may still be between creation and write.
const LOCK_WRITE_GRACE_MS = 2000
// A break lock this old was left by a process that died while clearing a stale lock.
const LOCK_BREAK_STALE_MS = 10000

function fileAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs } catch { return Infinity }
}

// Two waiters seeing the same dead holder must not both delete, or the second removes the live
// lock the first just took. So clearing is itself exclusive (`.break`), and the lock is removed
// only if it still reads as it did when judged dead.
function breakStaleLock(lockFile, seen) {
  const breaker = `${lockFile}.break`
  try {
    fs.writeFileSync(breaker, String(process.pid), { flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST' && !LOCK_BUSY.has(err.code)) throw err
    if (err.code === 'EEXIST' && fileAgeMs(breaker) > LOCK_BREAK_STALE_MS) fs.rmSync(breaker, RM_RETRY)
    return false
  }
  try {
    if (readLockText(lockFile) === seen) fs.rmSync(lockFile, RM_RETRY)
    return true
  } finally {
    fs.rmSync(breaker, RM_RETRY)
  }
}

// Only removes the lock if it is still ours; one taken over since isn't ours to delete.
function releaseLock(lockFile, token) {
  if (lockRecord(readLockText(lockFile))?.token === token) fs.rmSync(lockFile, RM_RETRY)
}

function tryLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    // Bounded so an unopenable lock file is reported as held rather than spun on.
    if (attempt > 60) return { ok: false, holder: null }
    const token = crypto.randomUUID()
    const body = JSON.stringify({ pid: process.pid, token })
    try {
      fs.writeFileSync(lockFile, body, { flag: 'wx' })
      return { ok: true, release: () => releaseLock(lockFile, token) }
    } catch (err) {
      if (LOCK_BUSY.has(err.code)) { pauseSync(5); continue }
      if (err.code !== 'EEXIST') throw err
    }
    const seen = readLockText(lockFile)
    if (seen === null) { pauseSync(2); continue } // released between the create and the read, or briefly unreadable
    const rec = lockRecord(seen)
    if (holderAlive(rec)) return { ok: false, holder: rec.pid }
    // Empty: its owner is between creating and writing it. Not dead until it has had time to write.
    if (!rec && fileAgeMs(lockFile) < LOCK_WRITE_GRACE_MS) return { ok: false, holder: null }
    if (attempt >= 5 || !breakStaleLock(lockFile, seen)) return { ok: false, holder: rec?.pid ?? null }
  }
}

function readLockText(lockFile) {
  try {
    return fs.readFileSync(lockFile, 'utf8')
  } catch {
    return null
  }
}

// The pid holding a lock, or null if free (absent or stale). A just-created, not yet written
// lock reads as held by -1. Read-only: never takes the lock or clears a stale one.
export function lockHolder(lockFile) {
  const text = readLockText(lockFile)
  if (text === null) return null
  const rec = lockRecord(text)
  if (!rec) return fileAgeMs(lockFile) < LOCK_WRITE_GRACE_MS ? -1 : null
  return holderAlive(rec) ? rec.pid : null
}

export function withLock(lockFile, fn, opts) {
  const release = acquireLock(lockFile, opts)
  if (!release) fail(`could not get a lock on ${lockFile}`)
  try {
    return fn()
  } finally {
    release()
  }
}

/** Signal 0 is a liveness probe on both Windows and POSIX. */
export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// POSIX only (Windows uses taskkill /T). The daemon makes each server a process group leader, so
// the negative pid reaches the JVM and any helper it forked. A server that leads no group fails
// the group signal with ESRCH; the plain pid is the fallback for that.
export function killProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    /* no such group - not a leader, or already gone */
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

export async function findFreePort(start, taken = new Set()) {
  for (let port = start; port < start + 500; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  fail(`no free port found in range ${start}-${start + 500}`)
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function humanBytes(n) {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function humanDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Renders rows as an aligned text table. rows[0] is the header. */
export function table(rows) {
  if (!rows.length) return ''
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  return rows
    .map((r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd())
    .join('\n')
}

export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* raced with a delete */
        }
      }
    }
  }
  return total
}

// dirSize without blocking the event loop.
export async function dirSizeAsync(dir) {
  const fsp = fs.promises
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    const files = []
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) files.push(full)
    }
    const sizes = await Promise.all(files.map((f) => fsp.stat(f).then((st) => st.size, () => 0)))
    for (const n of sizes) total += n
  }
  return total
}

// Versions from a modpack index or command line end up in a jar file name and a download URL, so
// a value like `1/../x` must not get through: only real version characters, and never `..`.
const SAFE_VERSION = /^\w[\w.+-]*$/
export function assertSafeVersion(value, label) {
  const v = typeof value === 'string' ? value : String(value ?? '')
  if (!SAFE_VERSION.test(v) || v.includes('..') || v.length > 64) {
    fail(`${label} "${v.slice(0, 40)}" is not a valid version`)
  }
  return v
}

/** Hides the value after --password or --requirepass so the args can be logged. */
export function maskSecretArgs(args) {
  return args.map((arg, i) => {
    if (/^--(?:password|requirepass)$/i.test(args[i - 1] ?? '')) return '[redacted]'
    return String(arg).replace(/^(--(?:password|requirepass)=).*$/is, '$1[redacted]')
  })
}

/** Whether `child` is `parent` or under it, judged on the paths as written. */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// For paths from files we didn't write (pack index, snapshot manifest): normalised to forward
// slashes, or null if absolute, a drive letter, a `..` segment, a NUL, or empty.
export function safeRelativePath(raw) {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(/\\/g, '/')
  if (!clean || clean.includes('\0') || clean.startsWith('/') || /^[a-z]:/i.test(clean)) return null
  const parts = clean.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

export function validateName(name) {
  if (!NAME_RE.test(name)) {
    fail(`invalid instance name "${name}" - use letters, digits, dash, underscore (max 32 chars)`)
  }
  return name
}

// The display label: whitespace collapsed, control characters dropped, at most 48 chars, null if
// empty. Unlike the instance name (a folder, registry key, argument), it is free text:
// "Survival (Season 3)" is a label, survival-season-3 its name.
export function cleanLabel(raw) {
  if (raw == null) return null
  // eslint-disable-next-line no-control-regex
  const label = String(raw).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48).trim()
  return label || null
}

// A name suggested by a label: invalid characters become dashes, capped at the name limit. Case
// is kept, and a label of only symbols becomes "server".
export function slugFor(label) {
  const slug = String(label ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/g, '')
  return slug || 'server'
}

/** Timestamp usable in filenames: 2026-08-16_142530 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function randomPassword(len = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  let out = ''
  for (const b of crypto.randomBytes(len)) out += alphabet[b % alphabet.length]
  return out
}
