import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'

/** Errors of this class print as a clean one-line message instead of a stack. */
export class UserError extends Error {}

export function fail(msg) {
  throw new UserError(msg)
}

/**
 * The process table, remembered briefly and refreshed in the background.
 *
 * <p>A pid alone cannot say whether a process is the one a state file remembers: Windows hands
 * pids out again quickly, so a daemon that died hours ago could have its number worn by anything
 * by now, and a status read that only asks "is this pid alive" reports a dead server as running
 * forever - and `kill` would taskkill a stranger. The image name is the cheap second question.
 *
 * <p>Cheap to ask, not cheap to answer: `tasklist` takes anything from a third of a second to
 * well over one on a machine that is also running a JVM. The first read is synchronous, because
 * a one-shot CLI call has nothing else to do and the answer has to be right the first time. Every
 * later refresh happens in the background: a read that finds the table stale hands back the table
 * it has and starts a new one, so the panel, which asks on every poll for as long as a server
 * runs, never stops answering requests or feeding the console while `tasklist` runs. Between one
 * table and the next a pid the table has not caught up with yet is trusted, which is the leniency
 * sameProcess already promises.
 */
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

/**
 * Refresh the table without blocking. Resolves once the new table is in place; a second call
 * while one is in flight joins it rather than starting another `tasklist`.
 */
export function refreshProcessTable() {
  if (refreshing) return refreshing
  const [cmd, args] = TABLE_COMMAND
  const queriedAt = Date.now()
  refreshing = new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      refreshing = null
      // A failed read keeps the previous table rather than replacing it with nothing: an old
      // answer about a pid beats no answer, and the next read will try again.
      if (!err && queriedAt >= processTable.at) processTable = { at: queriedAt, names: parseProcessTable(stdout) }
      resolve(processTable.names)
    })
  })
  return refreshing
}

/** The executable name behind a pid, or null when the table cannot be read or the pid is not in it. */
export function processImage(pid) {
  if (!pid) return null
  if (!processTable.names) {
    processTable = { at: Date.now(), names: readProcessTable() }
  } else if (Date.now() - processTable.at > PROCESS_TABLE_MS) {
    refreshProcessTable()
  }
  return processTable.names?.get(pid) ?? null
}

/**
 * On Linux, the file a pid is actually running, from /proc/<pid>/exe.
 *
 * <p>What `ps` calls a process's name there is not the name of its executable. It is a label on the
 * main thread that starts out as the executable's name and that the program is free to change, and
 * Node does: from version 23 it names its threads, so `ps` reports every Node 24 process as
 * "MainThread". The daemon recorded itself as `node`, was found wearing a different name, and every
 * server came up ORPHANED: running, healthy and refused by every command. The same verdict, for the
 * same kind of reason, as the fifteen-byte limit below - and again invisible from a checkout on the
 * Node that CI happened to use.
 *
 * <p>The link cannot be changed by the process, and is not truncated. It is tried first and only
 * ever says yes: when it cannot be read (another user's process), or names something else (Java
 * started through a link called java21 runs a file called java), the name in the table still gets
 * its say. Once the file has been replaced by an upgrade the kernel appends " (deleted)", which is
 * still the same program.
 */
export function executableName(pid, readlink = fs.readlinkSync) {
  try {
    return path.basename(String(readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ''))
  } catch {
    return null
  }
}

/**
 * Whether a live pid is still the process it was recorded as.
 *
 * <p>Lenient in every direction that is not an outright contradiction: no expected name recorded
 * (a state file from before this existed), a table that could not be read, or a pid the table has
 * not caught up with yet all answer true, because the pid IS alive and that was the whole test
 * until now. Only "alive, and wearing a different name" answers false.
 */
export function sameProcess(pid, expectedImage, startedAt = 0) {
  if (!expectedImage) return true
  if (process.platform === 'linux') {
    const exe = executableName(pid)
    if (exe && sameImage(exe, expectedImage)) return true
  }
  let actual = processImage(pid)
  // A cached PID may belong to an older process when Windows reuses its number.
  // Recheck a contradiction if that snapshot predates this launch; never reject a
  // newly started daemon using the previous owner's executable name.
  if (actual && startedAt > processTable.at && !sameImage(actual, expectedImage)) {
    const at = Date.now()
    const names = readProcessTable()
    if (names) { processTable = { at, names }; actual = names.get(pid) ?? null }
  }
  if (!actual) return true
  return sameImage(actual, expectedImage)
}

/**
 * Is this the name the process table would give that executable?
 *
 * <p>Linux keeps fifteen bytes of a process's name and no more, so `ps` reports the installed app,
 * spawnloft-desktop, as "spawnloft-deskt". Compared whole, that is a live process wearing a
 * different name - the one verdict sameProcess treats as a contradiction - and every server
 * started from the packaged app was declared orphaned the moment it came up: running, healthy, and
 * refused by every command. `node` and `java` are short, which is why nothing but a real install
 * showed it. A table name of exactly fifteen bytes therefore matches whatever it is the start of.
 */
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

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/**
 * A lock file other callers also create with the exclusive flag, so at most one of them holds it
 * at a time - across processes (CLI, panel, daemon), not just within one.
 *
 * <p>The file carries the holder's pid, so a lock left behind by a process that died while
 * holding it - killed, crashed, the machine lost power - is told apart from one a live process is
 * still using: both lock functions take it over the moment the pid is no longer alive, rather than
 * waiting out a fixed age that would either steal it from a slow but healthy holder or sit on a
 * dead one for too long.
 *
 * <p>Waits by blocking the thread, which only another *process* can be holding the lock while
 * this one does nothing else: the one JS thread cannot be both polling this loop and running the
 * code that would release the lock. Good for `withLock`'s synchronous critical sections (a quick
 * registry or player-list read-modify-write), wrong for anything that awaits while it holds the
 * lock - see `acquireLockAsync` for that.
 *
 * <p>`mode: 'wait'` (the default) retries quietly until it gets the lock or `timeoutMs` passes.
 * `mode: 'fail'` reports the conflict straight away instead, by returning null - for a start or
 * install where a second attempt queuing up silently is worse than being told to retry.
 */
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

/**
 * `acquireLock`'s `mode: 'wait'`, but waiting by awaiting a real timer instead of blocking the
 * thread - so another holder *in this same process* (a backup running in one request while a
 * second request for the same instance waits its turn) gets to keep running its own awaits
 * instead of being frozen out by this one spinning the thread it needs to finish and let go.
 */
export async function acquireLockAsync(lockFile, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = tryLock(lockFile)
    if (result.ok) return result.release
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockFile} (held by pid ${result.holder})`)
    await sleep(20)
  }
}

/**
 * What a lock file says about its holder: the pid, the executable it was running as, and a token
 * only this acquisition knows. A file holding just a number is one written before the rest existed.
 * Null for a file that is empty or unreadable, which is a lock being written or a damaged one.
 */
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

/**
 * Whether the process a lock names is still running. Only the pid is checked. Checking that the
 * pid is still the same *program* (so a pid reused after a crash does not keep the lock held) was
 * tried and taken out: in the packaged Windows app it declared a live holder dead, and the lock
 * was then taken from under it. A reused pid keeps a lock held until that process exits.
 */
function holderAlive(rec) {
  if (!rec) return false
  if (rec.pid === process.pid) return true
  return pidAlive(rec.pid)
}

/**
 * What Windows reports for a file that was just deleted while another process still has it open:
 * it stays, unopenable, until that handle closes - milliseconds, but long enough to throw. Seen
 * as EPERM when several processes took over one abandoned lock at the same moment.
 */
const LOCK_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** `rmSync` waits out a handle that is still closing, instead of throwing EPERM or EBUSY. */
const RM_RETRY = { force: true, maxRetries: 10, retryDelay: 10 }

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A lock file this young may still be between being created and being written. */
const LOCK_WRITE_GRACE_MS = 2000
/** A break lock this old was left by a process that died while clearing a stale lock. */
const LOCK_BREAK_STALE_MS = 10000

function fileAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs } catch { return Infinity }
}

/**
 * Clear a lock whose holder is gone - once, whoever else is trying. Two waiters that both see the
 * same dead holder must not both delete: the second delete would remove the live lock the first
 * had just taken. So clearing is itself exclusive (`.break`), and the lock is removed only if it
 * still reads exactly as it did when it was judged dead.
 */
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

/** Remove the lock only if it is still this acquisition's: a lock taken over since is not ours to delete. */
function releaseLock(lockFile, token) {
  if (lockRecord(readLockText(lockFile))?.token === token) fs.rmSync(lockFile, RM_RETRY)
}

function tryLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    // Bounded, so a lock file that stays unopenable is reported as held rather than spun on.
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

/** The lock file's text, or null when there is no file. */
function readLockText(lockFile) {
  try {
    return fs.readFileSync(lockFile, 'utf8')
  } catch {
    return null
  }
}

/** `acquireLock`, held for the duration of a synchronous `fn`. */
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

/**
 * Kill a process and everything it started, on POSIX.
 *
 * <p>The daemon starts each server as the leader of its own process group, so the negative pid
 * reaches the whole group at once: the JVM and any helper it forked, which a signal to the JVM
 * alone leaves running and holding the port. A server started by an older daemon leads no group,
 * and the group signal fails with ESRCH; the plain pid is the fallback for that and nothing else.
 * Windows has taskkill /T for the same job and does not come through here.
 */
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

/**
 * dirSize without holding the event loop.
 *
 * <p>Same walk, one directory at a time, with the stats of each directory's files issued together.
 * It costs the same number of syscalls; what it does not cost is every other request in the
 * process waiting while they run.
 */
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

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

export function validateName(name) {
  if (!NAME_RE.test(name)) {
    fail(`invalid instance name "${name}" - use letters, digits, dash, underscore (max 32 chars)`)
  }
  return name
}

/**
 * A display name, as typed, made safe to store: whitespace collapsed, control characters
 * dropped, at most 48 characters. Null when nothing is left.
 *
 * <p>The instance NAME is a folder, a registry key, a command-line argument and a scheduled-task
 * name, and each of those has rules; the label is none of them, so it can be anything a person
 * would call their server. "Survival (Season 3)" is a label; its name is survival-season-3.
 */
export function cleanLabel(raw) {
  if (raw == null) return null
  // eslint-disable-next-line no-control-regex
  const label = String(raw).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48).trim()
  return label || null
}

/**
 * The instance name a label suggests: the label with everything a name cannot hold turned into
 * dashes, trimmed and capped at the name limit. Never empty - a label made entirely of symbols
 * becomes "server". Case is kept, so "MyServer" stays readable as a folder.
 */
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
