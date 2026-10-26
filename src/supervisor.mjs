import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getInstance, assertInstanceDir, updateInstance, isDatabase } from './registry.mjs'
import * as java from './java.mjs'
import { mcVersionOf } from './plugins.mjs'
import { readState, clearState, controlRequest, isActiveStatus } from './control.mjs'
import { consoleLog, daemonLog, runDir, stateFile } from './paths.mjs'
import { readProps, writeProps } from './props.mjs'
import { fail, sleep, pidAlive, killProcessGroup, UserError, acquireLock } from './util.mjs'
import { patternsFor, scanConsole } from './ready.mjs'
import * as activity from './activity.mjs'

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')

// The registry is the source of truth for ports and RCON; pushed into server.properties on every launch.
export function syncProps(inst) {
  const file = path.join(inst.dir, 'server.properties')
  const updates = {
    'server-port': String(inst.port),
    'enable-rcon': 'true',
    'rcon.port': String(inst.rcon.port),
    'rcon.password': inst.rcon.password,
    'broadcast-rcon-to-ops': 'true',
  }
  if (inst.bind) updates['server-ip'] = inst.bind
  writeProps(file, updates)
}

export function assertEula(inst) {
  const eula = path.join(inst.dir, 'eula.txt')
  const text = fs.existsSync(eula) ? fs.readFileSync(eula, 'utf8') : ''
  if (!/^\s*eula\s*=\s*true\s*$/im.test(text)) {
    fail(
      `EULA not accepted for "${inst.name}".\n` +
        `  Read https://aka.ms/MinecraftEULA then set eula=true in ${eula}\n` +
        `  or re-create the instance with --accept-eula.`,
    )
  }
}

// Checked before the daemon is spawned, since a missing Java there only surfaces as "spawn java
// ENOENT" in the state file seconds later. A server on the bare name `java` that PATH no longer
// resolves is moved to the best Java found elsewhere (and the move is saved); one pointed at an
// explicit path that has gone is refused.
async function ensureJava(inst, { force = false } = {}) {
  const bin = inst.java || 'java'
  // A script standing in for the JVM (the lifecycle tests) is run by node, not asked its version.
  if (/\.m?js$/i.test(bin)) return inst
  const needs = java.requiredMajor(mcVersionOf(inst))
  const state = await java.probe(bin)
  if (state.found) {
    // Too old for this version: the class files won't load. A bare `java` is moved to one that
    // fits if installed; an explicit path is refused unless --force.
    if (!needs || state.major == null || state.major >= needs || force) return inst
    if (bin === 'java') {
      const fit = await java.javaFor(needs)
      if (fit && fit.path !== 'java') return updateInstance(inst.name, { java: fit.path })
    }
    fail(`"${inst.name}" runs Minecraft ${mcVersionOf(inst)}, which needs Java ${needs}, but ${bin} is Java ${state.major}.\n`
      + `  Pick another in the panel under Settings → Java, or: mcctl set ${inst.name} java=<path-to-java.exe>\n`
      + `  Install Java ${needs} from ${java.DOWNLOAD_URL}. To start on Java ${state.major} anyway: mcctl start ${inst.name} --force`)
  }
  if (bin !== 'java') {
    fail(`"${inst.name}" could not start: ${bin} could not be run (${state.message})\n`
      + `  Point it at another Java with: mcctl set ${inst.name} java=<path-to-java.exe>`)
  }
  const found = needs ? await java.javaFor(needs) : null
  const fallback = found?.path ?? (await java.defaultJava())
  if (!fallback || fallback === 'java') {
    fail(`"${inst.name}" could not start: Java was not found on PATH or in the usual install folders.\n`
      + `  Install it from ${java.DOWNLOAD_URL} - then restart SpawnLoft, which reads PATH once at launch.`)
  }
  return updateInstance(inst.name, { java: fallback })
}

// Only records activity once a daemon was actually launched; a refused start changed nothing.
export async function start(name, options = {}) {
  const attempt = { launched: false }
  try {
    const out = await launch(name, options, attempt)
    const failed = out.failed || out.timedOut
    activity.record(name, 'start', failed ? { ok: false, detail: out.reason ?? 'had not finished starting when SpawnLoft stopped waiting' } : {})
    return out
  } catch (err) {
    if (attempt.launched) activity.record(name, 'start', { ok: false, detail: err.message })
    throw err
  }
}

async function launch(name, { wait = true, timeout = 180000, sync = true, force = false } = {}, attempt = {}) {
  let inst = getInstance(name)
  if (inst.external) fail(`"${name}" is a database that runs elsewhere (${inst.host ?? '127.0.0.1'}:${inst.port}); it is not started or stopped from here`)
  assertInstanceDir(inst)
  // EULA, Java and server.properties are Minecraft's; a database's launch spec checks its engine.
  const database = isDatabase(inst)
  if (!database) {
    assertEula(inst)
    inst = await ensureJava(inst, { force })
  }

  fs.mkdirSync(runDir(name), { recursive: true })

  // Without this, two concurrent starts (CLI, panel, scheduler) could both read "not running"
  // and each spawn a daemon. Held from the status check until the daemon publishes its state,
  // and released before the much longer wait for ready.
  const release = acquireLock(path.join(runDir(name), 'start.lock'), { mode: 'fail' })
  if (!release) fail(`"${name}" is already being started by another request - wait for it to finish.`)

  let live
  try {
    const { status, state } = readState(name)
    if (status === 'running') fail(`instance "${name}" is already running (java pid ${state.javaPid})`)
    if (status === 'stopping') fail(`instance "${name}" is still shutting down - wait for it to finish`)
    if (status === 'orphaned') {
      fail(
        `instance "${name}" has an orphaned java process (pid ${state.javaPid}) with no daemon.\n` +
          `  Reattach is not possible; stop it with: mcctl kill ${name}`,
      )
    }
    if (status === 'stale') clearState(name)
    // A failure record from a previous attempt would be read as this attempt's failure.
    if (state?.error) clearState(name)

    if (sync && !database) syncProps(inst)

    const child = spawn(process.execPath, [DAEMON, name], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(DAEMON),
      // In the desktop app process.execPath is the Electron binary, not node; without this flag
      // the spawn would relaunch the whole app instead of the daemon. Plain node ignores it.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
    attempt.launched = true

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await sleep(150)
      const cur = readState(name)
      // On a quick restart the state file can still describe the previous launch; only this
      // child's state can acknowledge this start or report its failure.
      if (cur.state?.daemonPid !== child.pid) continue
      // A daemon that failed during startup writes its reason and nothing else.
      if (cur.state?.error) fail(`"${name}" could not start: ${cur.state.error}`)
      if (cur.state && cur.state.daemonPid && cur.state.startedAt) {
        live = cur
        break
      }
    }
    if (!live) {
      // Don't point at a log file that was never written.
      const log = daemonLog(name)
      fail(fs.existsSync(log)
        ? `"${name}" did not start - see ${log}`
        : `"${name}" did not start: the supervisor process never came up.`)
    }
    if (live.state.error) fail(`failed to launch "${name}": ${live.state.error}`)
  } finally {
    release()
  }

  if (!wait) return { started: true, javaPid: live.state.javaPid, ready: false }

  const ready = await waitForReady(name, timeout)
  return { started: true, javaPid: live.state.javaPid, ...ready }
}

// Tails the captured console until the server reports ready, dies, or we time out.
export async function waitForReady(name, timeout = 180000) {
  const file = consoleLog(name)
  const deadline = Date.now() + timeout
  let offset = 0
  let carry = ''
  let patterns
  try {
    patterns = patternsFor(getInstance(name))
  } catch {
    patterns = patternsFor(null)
  }

  while (Date.now() < deadline) {
    let text = ''
    try {
      const fd = fs.openSync(file, 'r')
      const size = fs.fstatSync(fd).size
      if (size > offset) {
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        offset = size
        text = buf.toString('utf8')
      }
      fs.closeSync(fd)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    if (text) {
      const found = scanConsole(carry, text, patterns)
      if (found.ready) return { ready: true, readyLine: found.ready }
      if (found.failed) return { ready: false, failed: true, reason: found.failed }
      carry = found.carry
    }

    const cur = readState(name)
    if (cur.status !== 'running' && cur.status !== 'stopping') {
      return { ready: false, failed: true, reason: `process exited (code ${cur.state?.exitCode ?? '?'})` }
    }
    await sleep(400)
  }
  return { ready: false, timedOut: true }
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    killProcessGroup(pid)
  }
}

async function waitForPidExit(pid, timeout = 15000) {
  if (!pid) return true
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(100)
  }
  return !pidAlive(pid)
}

export async function stop(name, { timeout = 90000 } = {}) {
  const { status, state } = readState(name)
  if (status === 'stopped' || status === 'stale') {
    clearState(name)
    return { alreadyStopped: true }
  }
  if (status === 'orphaned') {
    fail(`instance "${name}" is orphaned (java pid ${state.javaPid}, no daemon). Use: mcctl kill ${name}`)
  }
  const res = await controlRequest(name, { op: 'stop', timeout }, { timeout: timeout + 30000 })
  if (!res.ok) fail(res.error || 'stop failed')

  // The daemon outlives its java child briefly; wait for it, or a following start races it
  // for the control pipe name.
  await waitForPidExit(state.daemonPid)
  activity.record(name, 'stop')
  return res
}

export async function kill(name) {
  const out = await forceStop(name)
  if (!out.alreadyStopped) activity.record(name, 'kill')
  return out
}

async function forceStop(name) {
  const { status, state } = readState(name)
  if (status === 'stopped' || status === 'stale') {
    clearState(name)
    return { alreadyStopped: true }
  }
  if (status === 'orphaned') {
    killTree(state.javaPid)
    await waitForPidExit(state.javaPid)
    clearState(name)
    return { forced: true, orphan: true }
  }

  // Ask the daemon first so it can clean up; fall back to the pids if the channel is unreachable.
  try {
    const res = await controlRequest(name, { op: 'kill' }, { timeout: 30000 })
    if (res.ok) {
      await waitForPidExit(state.daemonPid)
      return res
    }
  } catch {
    /* control channel is gone; fall through to killing the pids */
  }

  killTree(state.javaPid)
  killTree(state.daemonPid)
  await waitForPidExit(state.javaPid)
  await waitForPidExit(state.daemonPid)
  clearState(name)
  return { forced: true, viaPid: true }
}

export async function sendConsole(name, line) {
  const res = await controlRequest(name, { op: 'send', line })
  if (!res.ok) throw new UserError(res.error || 'send failed')
  activity.record(name, 'command', { detail: line })
  return res
}

/** Up and answering a command; not a check for whether it is safe to delete. */
export function isRunning(name) {
  return readState(name).status === 'running'
}

/** Running, shutting down or orphaned: anything that still owns the instance's files. */
export function isActive(name) {
  return isActiveStatus(readState(name).status)
}

export function tailLog(name, count = 60) {
  const file = consoleLog(name)
  if (!fs.existsSync(file)) return []
  const size = fs.statSync(file).size
  const readBytes = Math.min(size, Math.max(64 * 1024, count * 512))
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(readBytes)
  fs.readSync(fd, buf, 0, readBytes, size - readBytes)
  fs.closeSync(fd)
  const lines = buf.toString('utf8').split(/\r?\n/)
  if (size > readBytes && lines.length) lines.shift() // drop a partial first line
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-count)
}

export function followLog(name, onLine, { from = null } = {}) {
  const file = consoleLog(name)
  let offset = from ?? (fs.existsSync(file) ? fs.statSync(file).size : 0)
  let carry = ''
  let stopped = false

  const poll = () => {
    if (stopped) return
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size < offset) {
        offset = 0 // log was truncated by a restart
        carry = ''
      }
      if (size > offset) {
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset = size
        carry += buf.toString('utf8')
        const parts = carry.split(/\r?\n/)
        carry = parts.pop() ?? ''
        for (const line of parts) onLine(line)
      }
    } catch {
      /* transient read race; retry next tick */
    }
    setTimeout(poll, 250)
  }
  poll()
  return () => {
    stopped = true
  }
}

export function statusOf(name) {
  const inst = getInstance(name)
  const { status, state } = readState(name)
  return {
    ...inst,
    status,
    javaPid: state?.javaPid ?? null,
    daemonPid: state?.daemonPid ?? null,
    startedAt: state?.startedAt ?? null,
    exitCode: state?.exitCode ?? null,
    // True once the last run ended in a crash nobody asked for; the next start clears it.
    crashed: Boolean(state?.crashed),
    // Crash-guard relaunches since start; startedAt is the latest launch.
    restarts: state?.restarts ?? 0,
    stoppedAt: state?.stoppedAt ?? null,
    lastError: state?.error ?? null,
    uptimeMs: status === 'running' && state?.startedAt ? Date.now() - state.startedAt : null,
    stateFile: stateFile(name),
    consoleLog: consoleLog(name),
    javaAlive: state ? pidAlive(state.javaPid) : false,
  }
}
