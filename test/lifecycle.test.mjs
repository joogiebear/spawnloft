/**
 * The lifecycle, end to end, against a real daemon.
 *
 * <p>Everything else in this suite tests pure modules. This one spawns the actual detached daemon,
 * talks to it over the actual control pipe, reads the actual console log and state file, and
 * drives the paths that were never covered: start-to-ready, console injection, graceful stop,
 * crash recovery, giving up, a forced stop, kill, and a launch that fails. The only thing faked is
 * the JVM - test/fixtures/fake-java.mjs prints what a server prints and obeys what a server obeys.
 *
 * <p>Isolated by MCCTL_DATA_ROOT, set before any module that resolves paths is imported, so the
 * registry, the run directory and the daemons all live in a scratch folder and never touch the
 * servers on the machine running the tests. The restart delay is shortened the same way, or the
 * crash tests would spend ten seconds apiece waiting for it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-lifecycle-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.MCCTL_RESTART_DELAY_MS = '300'

const { putInstance, removeInstance } = await import('../src/registry.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState } = await import('../src/control.mjs')
const { findFreePort, sleep, pidAlive, UserError } = await import('../src/util.mjs')
const { consoleLog } = await import('../src/paths.mjs')

const FAKE_JAVA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-java.mjs')
const made = []

async function makeInstance(suffix, extra = {}) {
  // Unique per run: the control channel is a named pipe keyed by instance name, and a leftover
  // daemon from an earlier run must never be mistaken for this one.
  const name = `lt-${process.pid}-${suffix}`
  const dir = path.join(scratch, 'instances', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  const port = await findFreePort(35000 + Math.floor(Math.random() * 20000))
  const rconPort = await findFreePort(port + 1)
  putInstance(name, {
    dir,
    jar: 'server.jar',
    java: FAKE_JAVA,
    memory: '1G',
    port,
    rcon: { port: rconPort, password: 'test' },
    ...extra,
  })
  made.push(name)
  return name
}

async function until(check, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(100)
  }
  return check()
}

const consoleText = (name) => (fs.existsSync(consoleLog(name)) ? fs.readFileSync(consoleLog(name), 'utf8') : '')

after(async () => {
  for (const name of made) {
    try {
      await sup.kill(name)
    } catch {
      /* already down */
    }
    try {
      removeInstance(name)
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('start waits for ready, a console line reaches the server, and stop is clean', { timeout: 30000 }, async () => {
  const name = await makeInstance('basic')
  const res = await sup.start(name, { timeout: 15000 })
  assert.equal(res.ready, true, `start did not reach ready: ${JSON.stringify(res)}`)
  assert.match(res.readyLine, /Done \(/)

  const { status, state } = readState(name)
  assert.equal(status, 'running')
  assert.ok(state.javaPid > 0)
  assert.ok(state.daemonPid > 0)
  assert.ok(state.daemonExe, 'the daemon records its executable for the pid-reuse check')
  assert.ok(state.javaExe, 'the daemon records the java executable for the pid-reuse check')

  await sup.sendConsole(name, 'hello there')
  assert.ok(await until(() => consoleText(name).includes('fake got: hello there')), 'the console line never reached the server')

  const stopped = await sup.stop(name, { timeout: 10000 })
  assert.equal(stopped.code, 0)
  assert.equal(stopped.forced, undefined)
  assert.equal(readState(name).status, 'stopped')
  assert.ok(consoleText(name).includes('[mcctl] server process exited (code=0)'))
})

test('a second start while running is refused; a stop of a stopped server is a no-op', { timeout: 30000 }, async () => {
  const name = await makeInstance('twice')
  await sup.start(name, { timeout: 15000 })
  await assert.rejects(sup.start(name), UserError)
  await sup.stop(name)
  const again = await sup.stop(name)
  assert.equal(again.alreadyStopped, true)
})

test('CLI Minecraft startup retains its Java pid and RCON port', { timeout: 30000 }, async () => {
  const name = await makeInstance('cli-ready')
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL('../spawnloft.mjs', import.meta.url)), 'start', name, '--timeout', '15'],
    { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(output, /Ready -/)
  assert.match(output, /java pid \d+\s+port \d+\s+rcon \d+/)
  assert.equal(readState(name).status, 'running')
  await sup.stop(name)
})

test('a crash with auto-restart on comes back, and the console says so', { timeout: 30000 }, async () => {
  const name = await makeInstance('recover', { autoRestart: true })
  await sup.start(name, { timeout: 15000 })
  const firstPid = readState(name).state.javaPid

  await sup.sendConsole(name, 'crash')
  const recovered = await until(() => {
    const { status, state } = readState(name)
    return status === 'running' && state.javaPid !== firstPid && state.restarts === 1
  }, 15000)
  assert.ok(recovered, `did not recover: ${JSON.stringify(readState(name))}`)
  assert.match(consoleText(name), /\[mcctl\] crash 1 of 3 allowed/)
  assert.match(consoleText(name), /likely cause: Something in the world crashed the server/)

  await sup.stop(name)
  assert.equal(readState(name).status, 'stopped')
})

test('a crash with auto-restart off stays down with its exit code', { timeout: 30000 }, async () => {
  const name = await makeInstance('staydown', { autoRestart: false })
  await sup.start(name, { timeout: 15000 })
  await sup.sendConsole(name, 'crash')
  assert.ok(await until(() => readState(name).status === 'stopped'), 'never reported stopped')
  assert.equal(readState(name).state.exitCode, 3)
})

test('a server that ignores stop is force-killed once the grace period passes', { timeout: 30000 }, async () => {
  const name = await makeInstance('hang')
  await sup.start(name, { timeout: 15000 })
  await sup.sendConsole(name, 'hang')
  await sleep(200)
  const res = await sup.stop(name, { timeout: 1500 })
  assert.equal(res.forced, true)
  assert.ok(await until(() => readState(name).status === 'stopped'), 'never reported stopped after the kill')
})

test('a force kill takes what the server forked along with it',
  { skip: process.platform === 'win32' ? 'Windows reaches the tree through taskkill /T' : false, timeout: 30000 }, async () => {
    const name = await makeInstance('forked')
    await sup.start(name, { timeout: 15000 })
    await sup.sendConsole(name, 'fork')
    let helper = null
    assert.ok(await until(() => {
      helper = Number(/forked helper pid (\d+)/.exec(consoleText(name))?.[1])
      return helper > 0
    }), 'the helper never reported its pid')
    assert.ok(pidAlive(helper))
    await sup.sendConsole(name, 'hang')
    await sleep(200)
    const res = await sup.stop(name, { timeout: 1500 })
    assert.equal(res.forced, true)
    // Signalling the JVM alone left this running, holding whatever it held.
    assert.ok(await until(() => !pidAlive(helper), 5000), 'the forked helper outlived the force kill')
  })

test('kill takes a running server down through the daemon', { timeout: 30000 }, async () => {
  const name = await makeInstance('kill')
  await sup.start(name, { timeout: 15000 })
  const res = await sup.kill(name)
  assert.equal(res.forced, true)
  assert.ok(await until(() => readState(name).status === 'stopped'), 'never reported stopped after kill')
})

test('a server that dies during startup is reported as failed, with the reason', { timeout: 30000 }, async () => {
  const name = await makeInstance('failstart')
  process.env.FAKE_JAVA_FAIL = 'start'
  try {
    const res = await sup.start(name, { timeout: 15000 })
    assert.equal(res.ready, false)
    assert.equal(res.failed, true)
    assert.match(res.reason, /Failed to start|exited/)
  } finally {
    delete process.env.FAKE_JAVA_FAIL
  }
})

test('a java that does not exist fails the start instead of hanging', { timeout: 30000 }, async () => {
  const name = await makeInstance('nojava', { java: 'no-such-java-binary-for-mcctl-tests' })
  // Either the daemon's spawn error is read from the state file during the launch wait, or the
  // exit is seen while waiting for ready. Both are a failure said out loud; neither is a hang.
  let outcome
  try {
    outcome = await sup.start(name, { timeout: 15000 })
  } catch (err) {
    assert.ok(err instanceof UserError)
    assert.match(err.message, /could not start|failed to launch/)
    return
  }
  assert.equal(outcome.ready, false)
  assert.equal(outcome.failed, true)
})
