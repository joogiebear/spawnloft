/**
 * The R1 contract fixtures (test/fixtures/contracts/) held against a real daemon: every control
 * case marked "live", the exact field set of state.json in each situation the fixture names, the
 * webhook posts and the crash entries in the activity history, a database's record and replies,
 * and a daemon run on the fullest server record in instances.json. Runs against whichever daemon
 * SPAWNLOFT_DAEMON picks, so the Rust daemon is held to the same files.
 *
 * Isolated by MCCTL_DATA_ROOT like lifecycle.test.mjs; only the JVM, RCON-less, and Garnet are faked.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-contracts-live-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.MCCTL_RESTART_DELAY_MS = '300'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'contracts')
const load = (file) => JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'))

const { check } = await import('./fixtures/contracts/shape.mjs')
const { putInstance, updateInstance, removeInstance, getInstance } = await import('../src/registry.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState, controlRequest } = await import('../src/control.mjs')
const { findFreePort, sleep, readJson } = await import('../src/util.mjs')
const { stateFile, runDir, controlPath, ENGINES_DIR, REGISTRY_FILE } = await import('../src/paths.mjs')
const { readActivity } = await import('../src/activity.mjs')
const { formatDiscord } = await import('../src/notify.mjs')
const services = await import('../src/services.mjs')
const { daemonChoice, coreBinary, rustDaemonArgs } = await import('../src/daemon-launch.mjs')

const control = load('control-protocol.json')
const states = load('state.json')
const activityFx = load('activity.json')
const webhookFx = load('webhook.json')
const instancesFx = load('instances.json')

const FAKE_JAVA = path.join(HERE, 'fixtures', 'fake-java.mjs')
const DAEMON_MJS = path.join(HERE, '..', 'src', 'daemon.mjs')
const RUST = daemonChoice() === 'rust'
const made = []
const covered = new Set()

const kase = (id) => {
  const c = control.cases.find((x) => x.id === id)
  assert.ok(c, `no control case ${id}`)
  return c
}

function fits(value, spec, defs, what) {
  const problems = check(value, spec, '$', defs)
  assert.deepEqual(problems, [], `${what}:\n  ${problems.join('\n  ')}\n  value: ${JSON.stringify(value)}`)
}

/** Sends a case's request (or the request given) and checks the reply against the case. */
async function ask(name, id, request) {
  const c = kase(id)
  assert.equal(c.asserted, 'live', `${id} is not a live case`)
  const req = request ?? c.request
  const reply = await controlRequest(name, req, { timeout: 60000 })
  fits(reply, c.reply, {}, `reply to ${id}`)
  covered.add(id)
  return reply
}

/** The state file as the daemon wrote it, held to the named example's shape and exact field set. */
function stateLike(name, id) {
  const ex = states.examples.find((e) => e.id === id)
  assert.ok(ex, `no state example ${id}`)
  const state = readJson(stateFile(name), null)
  assert.ok(state, `no state.json for ${name}`)
  fits(state, states.shapes[ex.shape], states.shapes, `state.json as ${id}`)
  // daemonStartTime is the Rust daemon's alone (see the fieldNote); the examples are daemon.mjs's set
  const fields = Object.keys(state).filter((k) => !(k === 'daemonStartTime' && RUST))
  assert.deepEqual(fields.sort(), Object.keys(ex.state).sort(), `state.json fields as ${id}`)
  assert.equal(readState(name).status, ex.status, `status as ${id}`)
  return state
}

async function makeInstance(suffix, extra = {}) {
  const name = `ct-${process.pid}-${suffix}`
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

async function until(check, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return check()
}

// The daemon writes its last state and then exits; wait for both so the file is final.
async function settled(name) {
  assert.ok(await until(() => readState(name).status === 'stopped'), `${name} never stopped: ${readState(name).status}`)
  const pid = readJson(stateFile(name), {}).daemonPid
  assert.ok(await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 10000), `the daemon (pid ${pid}) did not exit`)
}

async function webhookServer() {
  const posts = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posts.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) })
      res.writeHead(204).end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    posts,
    url: `http://127.0.0.1:${server.address().port}/hook?wait=true`,
    close: () => new Promise((r) => server.close(r)),
  }
}

/** Each post is the fixture's request, and its message one of the daemon's message shapes. */
function messageOf(name, post) {
  assert.equal(post.method, webhookFx.request.method)
  assert.equal(post.url, '/hook?wait=true')
  assert.equal(post.type, webhookFx.request.headers['content-type'])
  fits(post.body, webhookFx.request.body, {}, 'webhook body')
  const prefix = `**${name}** — `
  assert.ok(post.body.content.startsWith(prefix), post.body.content)
  const message = post.body.content.slice(prefix.length)
  assert.deepEqual(formatDiscord(name, message), post.body)
  const shape = webhookFx.daemonMessages.find((m) => new RegExp(m.regex).test(message))
  assert.ok(shape, `"${message}" fits none of the daemon's message shapes`)
  return { message, id: shape.id }
}

function crashEntries(name) {
  const entries = readActivity({ server: name }).entries.filter((e) => e.action === 'crash')
  for (const e of entries) fits(e, activityFx.daemon.entry, {}, 'the daemon\'s crash entry')
  return entries
}

// The supervisor's own way to start a daemon, for the cases it refuses to reach (an unknown
// instance, a java that does not exist).
function spawnDaemonDirect(name) {
  const [cmd, args] = RUST ? [coreBinary(), rustDaemonArgs(name)] : [process.execPath, [DAEMON_MJS, name]]
  fs.mkdirSync(runDir(name), { recursive: true })
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  return new Promise((resolve) => child.on('exit', resolve))
}

after(async () => {
  for (const name of made) {
    try { await sup.kill(name) } catch { /* already down */ }
    try { removeInstance(name) } catch { /* already gone */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('ping, send, unknown and malformed requests, and a graceful stop, as the fixture says', { timeout: 60000 }, async () => {
  const name = await makeInstance('basic')
  const res = await sup.start(name, { timeout: 15000 })
  assert.equal(res.ready, true, JSON.stringify(res))
  const state = stateLike(name, 'running')
  assert.equal(state.control, controlPath(name))
  const pong = await ask(name, 'ping')
  assert.equal(pong.javaPid, state.javaPid)
  assert.equal(pong.startedAt, state.startedAt)
  assert.equal(pong.alive, true)
  await ask(name, 'send')
  await ask(name, 'send-no-line')
  await ask(name, 'unknown-op')

  // a bad line is answered and the connection stays usable for the next
  const replies = await new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath(name))
    let buf = ''
    socket.on('connect', () => socket.write(`${kase('malformed').raw}\n${JSON.stringify({ op: 'ping' })}\n`))
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error(`no two replies, got ${JSON.stringify(buf)}`)) })
    socket.on('data', (c) => {
      buf += c
      // only whole lines: a reply can arrive in pieces
      const lines = buf.split('\n').slice(0, -1).filter(Boolean)
      if (lines.length >= 2) {
        socket.end()
        try { resolve(lines.map((l) => JSON.parse(l))) } catch (err) { reject(err) }
      }
    })
    socket.on('error', reject)
  })
  fits(replies[0], kase('malformed').reply, {}, 'reply to malformed')
  fits(replies[1], kase('ping').reply, {}, 'ping after a malformed line')
  covered.add('malformed')

  const stopped = await ask(name, 'stop')
  assert.equal(stopped.code, 0)
  await settled(name)
  stateLike(name, 'stopped')
})

test('a stop that times out is forced', { timeout: 60000 }, async () => {
  const name = await makeInstance('forced')
  await sup.start(name, { timeout: 15000 })
  await sup.sendConsole(name, 'hang')
  // "hang" and "stop" arriving in one read would both be taken as lines before the fake stops
  // reading (seen on Windows), so let "hang" land first, as lifecycle.test.mjs does
  await sleep(500)
  const reply = await ask(name, 'stop-forced')
  assert.equal(reply.forced, true)
  await settled(name)
})

test('kill takes a running server down and the state says how it died', { timeout: 60000 }, async () => {
  const name = await makeInstance('kill')
  await sup.start(name, { timeout: 15000 })
  await ask(name, 'kill')
  await settled(name)
  const state = readJson(stateFile(name))
  // Windows has no signal for taskkill /F: the exit is a code. Elsewhere it is SIGKILL with no code.
  stateLike(name, process.platform === 'win32' ? 'stopped' : 'stopped-killed')
  assert.equal(state.crashed, false)
})

for (const op of ['stop', 'kill']) {
  test(`a ${op} in the pause before a crash restart keeps it down`, { timeout: 60000 }, async () => {
    process.env.MCCTL_RESTART_DELAY_MS = '10000'
    let name
    try {
      name = await makeInstance(`delay-${op}`, { autoRestart: true })
      await sup.start(name, { timeout: 15000 })
    } finally {
      process.env.MCCTL_RESTART_DELAY_MS = '300'
    }
    await sup.sendConsole(name, 'crash')
    assert.ok(await until(() => readJson(stateFile(name), {}).restarting === true), 'never entered the restart delay')
    stateLike(name, 'restarting')
    await ask(name, 'send-not-running')
    const reply = await ask(name, `${op}-during-restart-delay`)
    assert.equal(reply.code, null)
    await settled(name)
    const state = stateLike(name, 'stopped-during-restart-delay')
    assert.equal(state.crashed, true)
    assert.equal(state.exitCode, null)
  })
}

test('a crash with auto-restart off posts the webhook and records the crash', { timeout: 60000 }, async () => {
  const hook = await webhookServer()
  try {
    const name = await makeInstance('down', { autoRestart: false, webhook: hook.url })
    await sup.start(name, { timeout: 15000 })
    await sup.sendConsole(name, 'crash')
    await settled(name)
    stateLike(name, 'crashed-staying-down')
    assert.ok(await until(() => hook.posts.length >= 1, 10000), 'no webhook post')
    const { message, id } = messageOf(name, hook.posts[0])
    assert.equal(id, 'crash-staying-down')
    const [entry] = crashEntries(name)
    assert.equal(entry.detail, message)
  } finally {
    await hook.close()
  }
})

test('a crash with auto-restart on restarts, says so, and says when it is back', { timeout: 60000 }, async () => {
  const hook = await webhookServer()
  try {
    const name = await makeInstance('back', { autoRestart: true, webhook: hook.url })
    const first = (await sup.start(name, { timeout: 15000 })) && readJson(stateFile(name))
    await sup.sendConsole(name, 'crash')
    assert.ok(await until(() => hook.posts.length >= 2, 20000), `posts: ${JSON.stringify(hook.posts)}`)
    // two posts in flight at once can land in either order
    assert.deepEqual(hook.posts.map((p) => messageOf(name, p).id).sort(), ['crash-restarting', 'recovered'])
    const state = stateLike(name, 'running-after-restart')
    assert.equal(state.restarts, 1)
    assert.notEqual(state.javaPid, first.javaPid)
    assert.ok(state.startedAt > first.startedAt, 'a restart writes a new startedAt')
    assert.deepEqual(crashEntries(name).map((e) => e.detail).sort(), hook.posts.map((p) => messageOf(name, p).message).sort())
    await sup.stop(name)
  } finally {
    await hook.close()
  }
})

test('the crash guard gives up after three crashes in its window', { timeout: 90000 }, async () => {
  const hook = await webhookServer()
  try {
    const name = await makeInstance('giveup', { autoRestart: true, webhook: hook.url })
    await sup.start(name, { timeout: 15000 })
    for (let i = 0; i < 3; i++) {
      assert.ok(await until(() => readState(name).status === 'running' && readJson(stateFile(name)).restarts === i), `not back up before crash ${i + 1}`)
      await sleep(300)
      await sup.sendConsole(name, 'crash')
    }
    await settled(name)
    const state = stateLike(name, 'crash-guard-gave-up')
    assert.equal(state.error, 'crashed 3 times in 10 minutes; auto-restart gave up')
    assert.ok(await until(() => hook.posts.some((p) => messageOf(name, p).id === 'crash-guard-gave-up'), 10000))
  } finally {
    await hook.close()
  }
})

test('an auto-restart that throws stays down, says why, and posts it', { timeout: 60000 }, async () => {
  const hook = await webhookServer()
  process.env.MCCTL_RESTART_DELAY_MS = '3000'
  try {
    const name = await makeInstance('gone', { autoRestart: true, webhook: hook.url })
    await sup.start(name, { timeout: 15000 })
    await sup.sendConsole(name, 'crash')
    assert.ok(await until(() => readJson(stateFile(name), {}).restarting === true), 'never entered the restart delay')
    // the restart re-reads the registry and finds nothing
    removeInstance(name)
    await settled(name)
    const state = stateLike(name, 'auto-restart-failed')
    assert.match(state.error, /^auto-restart failed: .*no instance named/)
    assert.ok(await until(() => hook.posts.length >= 2, 10000), `posts: ${JSON.stringify(hook.posts)}`)
    assert.deepEqual(hook.posts.map((p) => messageOf(name, p).id).sort(), ['auto-restart-failed', 'crash-restarting'])
    assert.equal(crashEntries(name).length, 2)
  } finally {
    process.env.MCCTL_RESTART_DELAY_MS = '300'
    await hook.close()
  }
})

test('an auto-restart whose program cannot be spawned writes the spawn error, and posts nothing more', { timeout: 60000 }, async () => {
  const hook = await webhookServer()
  process.env.MCCTL_RESTART_DELAY_MS = '3000'
  try {
    const name = await makeInstance('lostjava', { autoRestart: true, webhook: hook.url })
    await sup.start(name, { timeout: 15000 })
    await sup.sendConsole(name, 'crash')
    assert.ok(await until(() => readJson(stateFile(name), {}).restarting === true), 'never entered the restart delay')
    updateInstance(name, { java: path.join(scratch, 'no-such-java') })
    await settled(name)
    const state = stateLike(name, 'spawn-error')
    assert.equal(state.restarts, 1)
    assert.match(state.error, /ENOENT|cannot find|not found/i)
    await sleep(1000)
    assert.deepEqual(hook.posts.map((p) => messageOf(name, p).id), ['crash-restarting'])
  } finally {
    process.env.MCCTL_RESTART_DELAY_MS = '300'
    await hook.close()
  }
})

test('a daemon for an instance that does not exist writes only why it failed', { timeout: 30000 }, async () => {
  const name = `ct-${process.pid}-ghost`
  await spawnDaemonDirect(name)
  const state = stateLike(name, 'failed-to-start')
  assert.match(state.error, /no instance named/)
})

test('a java that cannot be spawned leaves the launched state with the spawn error', { timeout: 30000 }, async () => {
  const name = await makeInstance('nojava', { java: path.join(scratch, 'no-such-java') })
  await spawnDaemonDirect(name)
  const state = stateLike(name, 'spawn-error')
  assert.match(state.error, /ENOENT|cannot find|not found/i)
})

test('the fullest server record in instances.json runs under the daemon', { timeout: 60000 }, async () => {
  const hook = await webhookServer()
  try {
    const full = structuredClone(instancesFx.example.instances.survival)
    const name = await makeInstance('full')
    const base = getInstance(name)
    // only what must differ on this machine: where it lives, what runs, its ports and webhook
    putInstance(name, { ...full, dir: base.dir, jar: base.jar, java: base.java, port: base.port, rcon: base.rcon, webhook: hook.url })
    const stored = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).instances[name]
    fits(stored, instancesFx.shapes.server, instancesFx.shapes, 'the record under test')
    const res = await sup.start(name, { timeout: 15000 })
    assert.equal(res.ready, true, JSON.stringify(res))
    const state = stateLike(name, 'running')
    assert.equal(state.memory, full.memory)
    assert.equal(state.rconPort, base.rcon.port)
    await sup.stop(name)
    await settled(name)
  } finally {
    await hook.close()
  }
})

test('a database: its record, its state and its refusal of console input', { timeout: 60000 }, async () => {
  const VERSION = '0.0.0-fake'
  fs.mkdirSync(path.join(ENGINES_DIR, `garnet-${VERSION}`), { recursive: true })
  fs.cpSync(path.join(HERE, 'fixtures', 'fake-garnet'), path.join(ENGINES_DIR, `garnet-${VERSION}`), { recursive: true })
  const name = `ct-${process.pid}-db`
  const port = await findFreePort(46500 + Math.floor(Math.random() * 3000))
  await services.createDatabase(name, { engine: 'garnet', version: VERSION, port })
  made.push(name)
  const stored = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).instances[name]
  fits(stored, instancesFx.shapes.database, instancesFx.shapes, 'a created database')
  const res = await sup.start(name, { timeout: 15000 })
  assert.equal(res.ready, true, JSON.stringify(res))
  const state = stateLike(name, 'database-running')
  assert.equal(state.kind, 'database')
  await ask(name, 'send-database')
  const reply = await ask(name, 'stop')
  assert.equal(reply.ok, true)
  await settled(name)
})

test('every live control case was exercised', () => {
  const live = control.cases.filter((c) => c.asserted === 'live').map((c) => c.id).sort()
  assert.deepEqual([...covered].sort(), live)
})
