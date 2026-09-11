/**
 * Instance daemon. Spawned detached by `mcctl start`.
 *
 * Its whole reason to exist: a Minecraft server is an interactive foreground
 * process. Running it directly from a CLI call means the call blocks forever,
 * stdin is unreachable, and console output is lost. The daemon owns the java
 * child, mirrors its output into a log file, and exposes a control socket so
 * short-lived CLI invocations can inject console lines and request shutdown.
 *
 * It also owns crash recovery, because it is the only thing alive at the
 * moment a server dies. With auto-restart on, a crash is relaunched in place
 * after a short delay; the rules live in crashguard.mjs.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getInstance, serverJarPath, jvmFlagsFor, isDatabase, kindOf } from './registry.mjs'
import { runDir, stateFile, consoleLog, daemonLog, controlPath } from './paths.mjs'
import { writeJson } from './util.mjs'
import { startSampler, metricsFile } from './metrics.mjs'
import { crashVerdict, CRASH_LIMIT, CRASH_WINDOW_MS } from './crashguard.mjs'
import { notifyInstance } from './notify.mjs'
import { diagnose } from './diagnose.mjs'
import { patternsFor } from './ready.mjs'
import * as mariadb from './mariadb.mjs'
import * as garnet from './garnet.mjs'
import { respSend } from './resp.mjs'

const name = process.argv[2]
if (!name) {
  process.stderr.write('daemon: missing instance name\n')
  process.exit(2)
}

const dir = runDir(name)
fs.mkdirSync(dir, { recursive: true })

const diag = fs.createWriteStream(daemonLog(name), { flags: 'a' })
function log(msg) {
  diag.write(`[${new Date().toISOString()}] ${msg}\n`)
}

/**
 * Die legibly.
 *
 * <p>Everything below runs while this module is still being evaluated, and a throw there produced
 * absolutely nothing: no state file, no daemon.log - the write stream above has not finished
 * opening yet - and no stderr, because this process is spawned detached with stdio ignored. All
 * the caller could report was that the daemon "never came up", which is true and useless. One bad
 * memory value in the registry was enough to reach it.
 *
 * <p>So the reason is written SYNCHRONOUSLY, to both places the caller looks: appendFileSync lands
 * even when the process is about to exit, and the state file is what `start` is already polling.
 */
function die(err) {
  const reason = err?.message ?? String(err)
  try {
    fs.appendFileSync(daemonLog(name), `[${new Date().toISOString()}] failed to start: ${reason}\n`)
  } catch {
    /* nothing left to try */
  }
  try {
    writeJson(stateFile(name), {
      name,
      daemonPid: process.pid,
      running: false,
      error: reason,
      failedAt: Date.now(),
    })
  } catch {
    /* nothing left to try */
  }
  process.exit(1)
}

process.on('uncaughtException', die)

// One console file per daemon, truncated once at the first start so `logs` shows this session
// only. A crash-restart APPENDS to the same file - the lines before the crash are the reason
// it crashed, and they must survive the recovery.
// Finish truncating before publishing this daemon's state. An asynchronous open can leave
// the previous session's ready line visible to a caller waiting for this launch.
const out = fs.createWriteStream(consoleLog(name), { fd: fs.openSync(consoleLog(name), 'w') })

// ---- one run of the server --------------------------------------------------

let child = null
let inst = null
let state = null
let stopping = false
let stopSent = false
let respawnTimer = null
let stopSampler = () => {}
let recent = ''
const stopWaiters = []
const crashes = []

// The last webhook in flight, so shutdown can give it a moment to land instead of exiting
// underneath it. Capped - a dead webhook must not hold a dead server's daemon open.
let lastNotify = Promise.resolve()
function tell(message) {
  lastNotify = notifyInstance(inst, message, { log })
}

/**
 * What to spawn for an instance's `java`.
 *
 * <p>Normally the binary named, with the JVM arguments as they are. A `java` that is a .mjs or .js
 * file is run by this same Node with the JVM arguments passed through untouched - a script standing
 * in for the JVM. That is what lets the lifecycle tests drive a real daemon, a real control pipe
 * and a real console log without a 50 MB server jar and a JVM on the CI runner. Node would reject
 * `-Xms4G` as a bad option if the script were named as `java` directly, which is why the daemon
 * does the routing rather than the registry.
 */
function javaCommand(inst, args) {
  const bin = inst.java || 'java'
  if (/\.m?js$/i.test(bin)) {
    return { cmd: process.execPath, args: [bin, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { cmd: bin, args, env: process.env }
}

/**
 * What this instance runs: the command, where, and how it is asked to stop.
 *
 * <p>A Minecraft server is Java with the jar, stopped by writing `stop` to its console. A database
 * is its engine's server binary, stopped by the engine's admin tool over TCP because it takes no
 * console input. Everything after this point - capture, state, crash handling - is the same.
 */
let program = null

function programFor(inst) {
  if (isDatabase(inst)) return inst.engine === 'garnet' ? garnet.launchSpec(inst) : mariadb.launchSpec(inst)
  const jar = serverJarPath(inst)
  const flags = inst.jvmFlags?.length ? inst.jvmFlags : jvmFlagsFor(inst.memory)
  const jvmArgs = [`-Xms${inst.memory}`, `-Xmx${inst.memory}`, ...flags, '-jar', path.basename(jar), '--nogui']
  const { cmd, args, env } = javaCommand(inst, jvmArgs)
  return { cmd, args, env, cwd: inst.dir, stop: { stdin: 'stop\n' } }
}

function launch({ first }) {
  // Re-read the registry on every launch, not just the first: memory edits, an auto-restart
  // toggle or a new webhook should apply at the next respawn without a manual cycle.
  inst = getInstance(name)
  program = programFor(inst)
  const { cmd, args, env, cwd } = program

  log(`starting ${cmd} ${args.join(' ')} (cwd=${cwd})${first ? '' : ' [auto-restart]'}`)

  child = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })

  child.stdout.pipe(out, { end: false })
  child.stderr.pipe(out, { end: false })

  // A ring of the child's last output, kept so the moment it dies the daemon can say WHY -
  // the child is gone by then, and the daemon is the only thing still holding its last words.
  recent = ''
  const remember = (chunk) => {
    recent = (recent + chunk.toString()).slice(-32768)
  }
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  // Watch this run's output until the server reports ready, so a recovery can say "back up"
  // rather than merely "trying". Only recoveries notify - a person starting their own server
  // does not need a message saying they did.
  if (!first) {
    let tail = ''
    let seen = false
    const { ready } = patternsFor(inst)
    // Both streams: a database with --console reports ready on stderr.
    const watch = (chunk) => {
      if (seen) return
      tail = (tail + chunk.toString('utf8')).slice(-4096)
      if (ready.test(tail)) {
        seen = true
        child.stdout.removeListener('data', watch)
        child.stderr.removeListener('data', watch)
        log('recovered: reports ready')
        tell(`back up after a crash — restart ${crashes.length} of ${CRASH_LIMIT} allowed per ${CRASH_WINDOW_MS / 60000} minutes.`)
      }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
  }

  state = {
    name,
    kind: kindOf(inst),
    daemonPid: process.pid,
    // "java" by history: the pid and executable of the child, whatever it runs.
    javaPid: child.pid,
    // The executables behind the pids, so a status read can tell a reused pid from a live one.
    daemonExe: path.basename(process.execPath),
    javaExe: path.basename(cmd),
    startedAt: Date.now(),
    dir: inst.dir,
    jar: inst.jar ?? null,
    memory: inst.memory ?? null,
    port: inst.port,
    rconPort: inst.rcon?.port ?? null,
    control: controlPath(name),
    running: true,
    restarts: crashes.length,
  }
  writeJson(stateFile(name), state)
  log(`child pid ${child.pid}`)

  // Performance history starts empty every run. The old file describes a process that no longer
  // exists, and a graph that silently splices two runs together is worse than one that starts blank.
  try {
    fs.rmSync(metricsFile(name), { force: true })
  } catch {
    /* a leftover file only costs a stale first sample */
  }
  // A graph is worth less than the thing it graphs, so a sampler that cannot start says so in the
  // daemon log and the server carries on without one.
  stopSampler = startSampler(name, child.pid, {
    onError: (err) => log(`performance sampling unavailable: ${err.message}`),
  })

  child.on('exit', (code, signal) => onExit(code, signal))

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`)
    out.write(`\n[mcctl] failed to launch server: ${err.message}\n`)
    state.running = false
    state.error = err.message
    writeJson(stateFile(name), state)
    setTimeout(() => process.exit(1), 250)
  })
}

/** Write the final state and let the daemon end. The one exit path for a server staying down. */
function shutDown(code, signal, error) {
  state.running = false
  delete state.restarting
  state.exitCode = code
  state.exitSignal = signal
  state.stoppedAt = Date.now()
  if (error) state.error = error
  writeJson(stateFile(name), state)
  for (const resolve of stopWaiters) resolve(code)
  try {
    server.close()
  } catch {
    /* already closed */
  }
  // Give the log stream - and a webhook in flight - a moment to land before the process goes
  // away, without letting either hold it open.
  const grace = new Promise((r) => setTimeout(r, 4000))
  Promise.race([lastNotify, grace]).finally(() => setTimeout(() => process.exit(0), 250))
}

function onExit(code, signal) {
  log(`java exited code=${code} signal=${signal}`)
  stopSampler()
  out.write(`\n[mcctl] server process exited (code=${code}${signal ? `, signal=${signal}` : ''})\n`)

  const crashed = (code !== 0 && code !== null) || Boolean(signal)
  if (crashed && !stopping) crashes.push(Date.now())

  // Name the likely cause while the evidence is at hand. One finding, in the console and on
  // the webhook - a person woken by "crashed" should not have to open a log to learn "out of
  // memory" when the daemon already knows.
  let cause = ''
  // The diagnoses are Minecraft's failure shapes; a database's log has its own, and running
  // Minecraft's over it would name causes that are not there.
  if (crashed && !stopping && !isDatabase(inst)) {
    const finding = diagnose(recent.split(/\r?\n/), { port: inst.port, memory: inst.memory, dir: inst.dir })[0]
    if (finding) {
      cause = ` Likely cause: ${finding.title.toLowerCase()}.`
      out.write(`[mcctl] likely cause: ${finding.title} — ${finding.advice}\n`)
    }
  }

  // Freshly read, so flipping auto-restart off in the panel counts from the very next exit
  // rather than from the next manual start.
  let enabled = Boolean(inst.autoRestart)
  try {
    inst = getInstance(name)
    enabled = Boolean(inst.autoRestart)
  } catch {
    /* the registry answered at launch; keep what it said then */
  }

  const verdict = crashVerdict({ enabled, stopping, code, signal, crashes })

  if (verdict.kind === 'restart') {
    const wait = Math.round(verdict.delayMs / 1000)
    out.write(`[mcctl] crash ${verdict.recent} of ${CRASH_LIMIT} allowed per ${CRASH_WINDOW_MS / 60000} minutes — restarting in ${wait}s\n`)
    tell(`crashed (exit ${signal || code}).${cause} Restarting in ${wait}s.`)
    // The state keeps running:true while the timer runs, so readState reports "stopping" rather
    // than "stopped" - a start racing into this window would collide with the respawn.
    state.restarting = true
    writeJson(stateFile(name), state)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (stopping) return shutDown(code, signal)
      try {
        launch({ first: false })
      } catch (err) {
        log(`auto-restart failed: ${err.message}`)
        out.write(`\n[mcctl] auto-restart failed: ${err.message}\n`)
        tell(`auto-restart failed: ${err.message}`)
        shutDown(code, signal, `auto-restart failed: ${err.message}`)
      }
    }, verdict.delayMs)
    return
  }

  if (verdict.kind === 'give-up') {
    const why = `crashed ${verdict.recent} times in ${CRASH_WINDOW_MS / 60000} minutes; auto-restart gave up`
    out.write(`[mcctl] ${why}. See the lines above for the reason it keeps dying.\n`)
    tell(`${why}. It is staying down until someone looks at it.`)
    return shutDown(code, signal, why)
  }

  // Staying down. A crash with auto-restart off is still worth a message - it is the one case
  // where the server is dead and nothing is going to do anything about it.
  if (crashed && !stopping) {
    tell(`crashed (exit ${signal || code}) and is staying down — auto-restart is off.${cause}`)
  }
  shutDown(code, signal)
}

try {
  launch({ first: true })
} catch (err) {
  die(err)
}

function forceKill() {
  if (!child || child.exitCode !== null) return
  log('force killing')
  if (process.platform === 'win32') {
    // Kill the whole tree - the JVM may have spawned helpers.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function waitForExit(timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null)
  return new Promise((resolve) => {
    stopWaiters.push(resolve)
    if (timeoutMs > 0) setTimeout(() => resolve(null), timeoutMs)
  })
}

async function handleStop(timeoutMs) {
  stopping = true
  // A stop that lands during the respawn delay cancels the respawn - the person asked for a
  // stopped server, and "stopped" must not mean "back in ten seconds".
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
    log('stop received during restart delay; staying down')
    shutDown(state.exitCode ?? null, state.exitSignal ?? null)
    return { ok: true, code: state.exitCode ?? null, already: true }
  }
  if (child.exitCode !== null) return { ok: true, code: child.exitCode, already: true }
  if (!stopSent) {
    stopSent = true
    if (program?.stop?.stdin) {
      log('sending stop to console')
      try {
        child.stdin.write(program.stop.stdin)
      } catch (err) {
        log(`stdin write failed: ${err.message}`)
      }
    } else if (program?.stop?.cmd) {
      // A database is asked over TCP by its own admin tool. Its outcome is not awaited: the
      // process exiting, or not, is what the wait below is watching.
      log(`asking for shutdown: ${program.stop.cmd} ${program.stop.args.join(' ')}`)
      try {
        const ask = spawn(program.stop.cmd, program.stop.args, { env: program.stop.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        ask.stderr.on('data', (c) => log(`shutdown tool: ${c.toString().trim()}`))
        ask.on('error', (err) => log(`shutdown tool failed to run: ${err.message}`))
      } catch (err) {
        log(`shutdown tool failed to run: ${err.message}`)
      }
    } else if (program?.stop?.resp) {
      // A Redis-speaking engine is asked in its own protocol: checkpoint, then shut down.
      const r = program.stop.resp
      log(`asking for shutdown over the Redis protocol at ${r.host}:${r.port}`)
      respSend(r.host, r.port, r.commands, { password: r.password || null }).catch((err) => log(`shutdown request: ${err.message}`))
    } else {
      log('no graceful stop for this program; waiting, then killing')
    }
  }
  const code = await waitForExit(timeoutMs)
  if (code === null) {
    log('graceful stop timed out')
    forceKill()
    await waitForExit(10000)
    return { ok: true, forced: true, code: child.exitCode }
  }
  return { ok: true, code }
}

// --- control socket ---------------------------------------------------------

const controlAddr = controlPath(name)
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(controlAddr)
  } catch {
    /* no stale socket */
  }
}

const server = net.createServer((socket) => {
  let buf = ''
  socket.on('data', async (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: 'malformed request' })}\n`)
        continue
      }
      let res
      try {
        res = await handle(req)
      } catch (err) {
        res = { ok: false, error: err.message }
      }
      socket.write(`${JSON.stringify(res)}\n`)
    }
  })
  socket.on('error', () => socket.destroy())
})

async function handle(req) {
  switch (req.op) {
    case 'ping':
      return { ok: true, javaPid: child?.pid ?? null, startedAt: state.startedAt, alive: Boolean(child) && child.exitCode === null }
    case 'send':
      if (isDatabase(inst)) return { ok: false, error: 'a database has no console input - use its client, or the panel' }
      if (!child || child.exitCode !== null) return { ok: false, error: 'server process is not running' }
      if (typeof req.line !== 'string') return { ok: false, error: 'send requires a line' }
      child.stdin.write(`${req.line.replace(/\r?\n$/, '')}\n`)
      log(`console <- ${req.line}`)
      return { ok: true }
    case 'stop':
      return handleStop(Number(req.timeout) > 0 ? Number(req.timeout) : 90000)
    case 'kill':
      stopping = true
      if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
        shutDown(state.exitCode ?? null, state.exitSignal ?? null)
        return { ok: true, code: state.exitCode ?? null, forced: true }
      }
      forceKill()
      await waitForExit(10000)
      return { ok: true, code: child?.exitCode ?? null, forced: true }
    default:
      return { ok: false, error: `unknown op "${req.op}"` }
  }
}

/**
 * Bind the control channel, retrying while a previous daemon for this instance
 * still holds the pipe. A restart can spawn us milliseconds after the outgoing
 * daemon's java child exited but before that daemon has released the name.
 *
 * If the channel can never be bound, the server would run unmanageable - no
 * stdin, no graceful stop. That is worse than not running, so we refuse to
 * stay up rather than silently logging the failure.
 */
const LISTEN_RETRY_MS = 250
const LISTEN_TIMEOUT_MS = 15000

function listenWithRetry(deadline = Date.now() + LISTEN_TIMEOUT_MS) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && Date.now() < deadline) {
      log(`control socket busy at ${controlAddr}, retrying`)
      setTimeout(() => listenWithRetry(deadline), LISTEN_RETRY_MS)
      return
    }
    log(`control socket fatal: ${err.message}`)
    out.write(`\n[mcctl] control channel unavailable (${err.message}); stopping the server\n`)
    state.running = false
    state.error = `control channel unavailable: ${err.message}`
    writeJson(stateFile(name), state)
    forceKill()
    setTimeout(() => process.exit(1), 1000)
  })
  server.listen(controlAddr, () => log(`control socket listening on ${controlAddr}`))
}

listenWithRetry()

// Keep the daemon alive even if the terminal that spawned it goes away.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {
  handleStop(90000).then(() => process.exit(0))
})
