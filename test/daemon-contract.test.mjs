/**
 * What a daemon promises beyond the lifecycle suite, checked the same way against whichever
 * daemon SPAWNLOFT_DAEMON picks (CI runs this file under both): the ping reply, the crash webhook
 * and activity entry, metrics.log with the RCON tick readings, a stop inside the restart delay,
 * the crash guard giving up, an orphaned server after its daemon dies, and SIGTERM.
 *
 * Isolated by MCCTL_DATA_ROOT like lifecycle.test.mjs; only the JVM and RCON are faked.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-contract-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.MCCTL_RESTART_DELAY_MS = '300'

const { putInstance, removeInstance } = await import('../src/registry.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState, controlRequest } = await import('../src/control.mjs')
const { findFreePort, sleep, pidAlive } = await import('../src/util.mjs')
const { consoleLog, controlPath } = await import('../src/paths.mjs')
const { readActivity } = await import('../src/activity.mjs')
const { metricsFile } = await import('../src/metrics.mjs')
const { daemonChoice } = await import('../src/daemon-launch.mjs')
const { startFakeRcon } = await import('./fixtures/fake-rcon.mjs')

const FAKE_JAVA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-java.mjs')
const RUST = daemonChoice() === 'rust'
const made = []
const PREFIX = /\[(?:mcctl|spawnloft)\]/

async function makeInstance(suffix, extra = {}) {
  const name = `dc-${process.pid}-${suffix}`
  const dir = path.join(scratch, 'instances', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  const port = await findFreePort(35000 + Math.floor(Math.random() * 20000))
  const rconPort = await findFreePort(port + 1)
  putInstance(name, { dir, jar: 'server.jar', java: FAKE_JAVA, memory: '1G', port, rcon: { port: rconPort, password: 'test' }, ...extra })
  made.push(name)
  return name
}

async function until(check, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return check()
}

const consoleText = (name) => (fs.existsSync(consoleLog(name)) ? fs.readFileSync(consoleLog(name), 'utf8') : '')

after(async () => {
  for (const name of made) {
    try { await sup.kill(name) } catch { /* already down */ }
    try { removeInstance(name) } catch { /* already gone */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('ping answers the server pid, its start and that it is alive', { timeout: 30000 }, async () => {
  const name = await makeInstance('ping')
  await sup.start(name, { timeout: 15000 })
  const { state } = readState(name)
  const pong = await controlRequest(name, { op: 'ping' })
  assert.equal(pong.ok, true)
  assert.equal(pong.javaPid, state.javaPid)
  assert.equal(pong.startedAt, state.startedAt)
  assert.equal(pong.alive, true)
  if (RUST) {
    assert.equal(pong.daemon, 'rust')
    assert.equal(pong.protocol, 1)
    assert.match(state.daemonExe, /^spawnloft-core(\.exe)?$/)
    // (pid, creation time) identity, design section 4; macOS has no creation time to record
    if (process.platform !== 'darwin') assert.match(state.daemonStartTime, /^\d+$/)
  }
  const unknown = await controlRequest(name, { op: 'status' })
  assert.deepEqual(unknown, { ok: false, error: 'unknown op "status"' })
  await sup.stop(name)
})

test('a crash posts the webhook and goes into the activity history', { timeout: 30000 }, async () => {
  const bodies = []
  const hook = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, type: req.headers['content-type'], body })
      res.writeHead(204).end()
    })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  try {
    const name = await makeInstance('hook', { autoRestart: false, webhook: `http://127.0.0.1:${hook.address().port}/hook?wait=true` })
    await sup.start(name, { timeout: 15000 })
    await sup.sendConsole(name, 'crash')
    assert.ok(await until(() => bodies.length > 0, 10000), 'the webhook was never posted')
    assert.equal(bodies[0].method, 'POST')
    assert.equal(bodies[0].url, '/hook?wait=true')
    assert.equal(bodies[0].type, 'application/json')
    assert.deepEqual(JSON.parse(bodies[0].body), {
      content: `**${name}** — crashed (exit 3) and is staying down — auto-restart is off. Likely cause: something in the world crashed the server.`,
    })
    assert.ok(await until(() => readState(name).status === 'stopped'))
    const crash = readActivity({ server: name }).entries.find((e) => e.action === 'crash')
    assert.ok(crash, 'no crash entry in the activity history')
    assert.equal(crash.ok, false)
    assert.deepEqual(crash.by, { kind: 'spawnloft' })
    assert.match(crash.detail, /^crashed \(exit 3\) and is staying down/)
  } finally {
    await new Promise((r) => hook.close(r))
  }
})

test('metrics.log gets CPU, memory and the server\'s own TPS and player counts over RCON', { timeout: 60000 }, async () => {
  // strict: like Minecraft's RCON thread, it hangs up on a read holding two packets
  const rcon = await startFakeRcon({ password: 'pw', strict: true })
  try {
    const name = await makeInstance('metrics', { rcon: { port: rcon.port, password: 'pw' } })
    await sup.start(name, { timeout: 15000 })
    let cols = null
    // the first figure needs two readings ten seconds apart
    assert.ok(await until(() => {
      const lines = fs.existsSync(metricsFile(name)) ? fs.readFileSync(metricsFile(name), 'utf8').trim().split('\n').filter(Boolean) : []
      cols = lines.at(-1)?.split(' ') ?? null
      return cols?.length === 6
    }, 40000), `no full metrics line: ${JSON.stringify(cols)}`)
    const [at, cpu, rss, tps, online, max] = cols
    assert.ok(Math.abs(Number(at) - Date.now() / 1000) < 60, `time ${at}`)
    assert.match(cpu, /^\d+\.\d$/)
    assert.ok(Number(rss) > 0, `rss ${rss}`)
    assert.deepEqual([tps, online, max], ['20', '0', '20'])
    assert.equal(rcon.hangups(), 0, 'the sampler wrote two packets at once')
    // one standing connection, not one per reading
    assert.equal(rcon.connections(), 1)
    await sup.stop(name)
  } finally {
    await rcon.close()
  }
})

test('a stop during the restart delay keeps the server down', { timeout: 30000 }, async () => {
  process.env.MCCTL_RESTART_DELAY_MS = '3000'
  let name
  try {
    name = await makeInstance('delay', { autoRestart: true })
    await sup.start(name, { timeout: 15000 })
  } finally {
    process.env.MCCTL_RESTART_DELAY_MS = '300'
  }
  const first = readState(name).state.javaPid
  await sup.sendConsole(name, 'crash')
  assert.ok(await until(() => readState(name).state?.restarting === true), 'never entered the restart delay')
  assert.equal(readState(name).status, 'stopping')
  const res = await sup.stop(name)
  assert.equal(res.ok, true)
  assert.equal(res.already, true)
  await sleep(3500)
  const { status, state } = readState(name)
  assert.equal(status, 'stopped')
  assert.equal(state.javaPid, first, 'no new server was started')
  assert.equal(state.restarting, undefined)
})

test('three crashes inside the window make the crash guard give up', { timeout: 60000 }, async () => {
  const name = await makeInstance('giveup', { autoRestart: true })
  await sup.start(name, { timeout: 15000 })
  for (let n = 1; n <= 3; n++) {
    const before = readState(name).state.javaPid
    assert.ok(await until(() => consoleText(name).split('\n').filter((l) => l.includes('Done (')).length >= n, 10000), `launch ${n} never got ready`)
    await sup.sendConsole(name, 'crash')
    if (n < 3) {
      assert.ok(await until(() => {
        const { status, state } = readState(name)
        return status === 'running' && state.javaPid !== before && state.restarts === n
      }, 15000), `crash ${n} did not restart: ${JSON.stringify(readState(name))}`)
    }
  }
  assert.ok(await until(() => readState(name).status === 'stopped', 10000))
  const { state } = readState(name)
  assert.match(state.error, /crashed 3 times in 10 minutes; auto-restart gave up/)
  assert.equal(state.crashed, true)
  assert.match(consoleText(name), new RegExp(`${PREFIX.source} crash 2 of 3 allowed`))
  assert.match(consoleText(name), /auto-restart gave up\. See the lines above/)
})

test('a server outlives its dead daemon as orphaned, and kill still takes it down',
  { skip: process.platform === 'win32' ? 'the Node daemon\'s server dies with it on Windows (libuv job object)' : false, timeout: 30000 }, async () => {
    const name = await makeInstance('orphan')
    await sup.start(name, { timeout: 15000 })
    const { state } = readState(name)
    process.kill(state.daemonPid, 'SIGKILL')
    assert.ok(await until(() => !pidAlive(state.daemonPid)), 'the daemon did not die')
    assert.equal(readState(name).status, 'orphaned')
    assert.ok(pidAlive(state.javaPid))
    const res = await sup.kill(name)
    assert.equal(res.orphan, true)
    assert.ok(await until(() => !pidAlive(state.javaPid)), 'the orphan survived kill')
    assert.equal(readState(name).status, 'stopped')
  })

test('SIGTERM to the daemon stops the server gracefully and ends the daemon',
  { skip: process.platform === 'win32' ? 'Windows has no SIGTERM' : false, timeout: 30000 }, async () => {
    const name = await makeInstance('sigterm')
    await sup.start(name, { timeout: 15000 })
    const { state } = readState(name)
    process.kill(state.daemonPid, 'SIGTERM')
    assert.ok(await until(() => !pidAlive(state.daemonPid), 15000), 'the daemon is still up')
    assert.ok(!pidAlive(state.javaPid))
    assert.match(consoleText(name), /Stopping server/)
    assert.equal(readState(name).state.exitCode, 0)
  })

test('SIGINT is ignored', { skip: process.platform === 'win32' ? 'Windows has no SIGINT for a detached process' : false, timeout: 30000 }, async () => {
  const name = await makeInstance('sigint')
  await sup.start(name, { timeout: 15000 })
  const { state } = readState(name)
  process.kill(state.daemonPid, 'SIGINT')
  await sleep(500)
  assert.equal(readState(name).status, 'running')
  await sup.stop(name)
})

test('the Rust daemon\'s control socket is its owner\'s alone',
  { skip: !RUST ? 'Rust daemon only' : process.platform === 'win32' ? 'the pipe DACL is checked by the Rust tests' : false, timeout: 30000 }, async () => {
    const name = await makeInstance('mode')
    await sup.start(name, { timeout: 15000 })
    assert.equal(fs.statSync(controlPath(name)).mode & 0o777, 0o600)
    await sup.stop(name)
  })

test('a server that stops reading its console cannot wedge the daemon', { timeout: 60000 }, async () => {
  const name = await makeInstance('wedge')
  await sup.start(name, { timeout: 15000 })
  assert.equal((await controlRequest(name, { op: 'send', line: 'hang' })).ok, true)
  // far past any pipe buffer (4 KiB on Windows, 64 KiB on Linux) with nobody reading
  const line = 'say ' + 'x'.repeat(1000)
  for (let i = 0; i < 300; i++) {
    const r = await controlRequest(name, { op: 'send', line })
    assert.equal(typeof r.ok, 'boolean')
  }
  const pong = await controlRequest(name, { op: 'ping' })
  assert.equal(pong.ok, true)
  const killed = await controlRequest(name, { op: 'kill' })
  assert.equal(killed.ok, true)
  assert.ok(await until(() => readState(name).state?.running === false, 15000))
})
