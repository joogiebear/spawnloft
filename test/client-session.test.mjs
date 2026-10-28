import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-session-'))
process.env.MCCTL_DATA_ROOT = scratch
// the fake game shows "connecting" this long after a join answers, as the real one loads terrain
process.env.FAKE_CLIENT_LOAD_MS = '700'

const { launch, status, stop, createProfile, session, join, chat, messages, screenshot, player, screen, disconnect, waitUntilLoaded, tailClientLog } = await import('../src/client.mjs')
const { putInstance } = await import('../src/registry.mjs')
const { stateFile, INSTANCES_DIR } = await import('../src/paths.mjs')
const { writeJson } = await import('../src/util.mjs')
const { versionDir, versionJson, profileDir } = await import('../src/client-paths.mjs')

const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')

fs.mkdirSync(versionDir('1.21.11'), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', '1.21.11.json'), versionJson('1.21.11'))
const fabricId = 'fabric-loader-0.19.5-1.21.11'
fs.mkdirSync(versionDir(fabricId), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', 'fabric-profile.json'), versionJson(fabricId))

createProfile('harn', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', harness: true })

function makeServer(name, port, props) {
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), props)
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port, rcon: { port: port + 1, password: 'x' } })
  writeJson(stateFile(name), { name, running: true, daemonPid: process.pid, javaPid: process.pid })
}

makeServer('online', 45631, 'online-mode=true\nserver-ip=\n')
makeServer('offline', 45633, 'online-mode=false\nserver-ip=127.0.0.1\n')

after(async () => {
  for (const name of ['harn', 'boot', 'qp']) {
    try { await stop(name) } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('session before launch rejects', async () => {
  await assert.rejects(session('harn'), /not running/)
})

test('launch rejects for an unlisted mc version', async () => {
  createProfile('old', { mc: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5', harness: true })
  await assert.rejects(launch('old', { fakeJava }), /published for Minecraft 1\.21\.11, not 1\.20\.1/)
})

test('session resolves and caches after launch', async () => {
  await launch('harn', { fakeJava })
  const ch1 = await session('harn')
  const ch2 = await session('harn')
  assert.equal(ch1, ch2)
})

test('chat refuses /stop', async () => {
  await assert.rejects(chat('harn', '/stop'), /would take the server down/)
  const m = await messages('harn')
  assert.equal(m.messages.length, 0)
})

test('chat sends and messages reflect it', async () => {
  const res = await chat('harn', 'hello')
  assert.deepEqual(res, { sent: 'hello' })
  const m = await messages('harn')
  assert.equal(m.messages.length, 1)
  assert.ok(m.messages[0].text.endsWith(' hello'))
})

test('join refuses an online-mode server in client wording, not the bots\' wording', async () => {
  await assert.rejects(join('harn', 'online'), (err) => {
    assert.match(err.message, /server "online" runs in online mode and .+ is an offline player.*spawnloft client login/)
    assert.doesNotMatch(err.message, /bots/)
    return true
  })
})

test('harness calls refuse a profile name that is not one, before any path is built from it', async () => {
  // run/<name> sits two levels under the data root, so this name reaches <data root>/x
  const outside = path.join(process.env.MCCTL_DATA_ROOT, 'x')
  fs.mkdirSync(outside, { recursive: true })
  // a state file there, with this process as its live pid
  writeJson(path.join(outside, 'state.json'), { pid: process.pid, startedAt: new Date().toISOString(), harness: { token: 't', port: 1 } })
  const bad = '../../x'
  for (const call of [() => session(bad), () => messages(bad), () => chat(bad, 'hi'), () => screenshot(bad), () => disconnect(bad), () => join(bad, 'offline')]) {
    await assert.rejects(call(), (err) => {
      assert.doesNotMatch(err.message, /not running|harness/)
      assert.match(err.message, /name/)
      return true
    })
  }
  await assert.rejects(session('nosuch'), /nosuch/)
})

test('join succeeds on an offline server, once the world has loaded', async () => {
  const started = Date.now()
  const res = await join('harn', 'offline')
  assert.deepEqual(res, { joined: true, server: 'offline', host: '127.0.0.1', port: 45633, loaded: true, screen: 'ingame' })
  assert.ok(Date.now() - started >= 900, 'join returned before the loading screen went away')
})

test('player name matches account', async () => {
  const p = await player('harn')
  const st = status('harn')
  assert.equal(p.name, st.account.name)
})

test('screen returns kind none', async () => {
  const s = await screen('harn')
  assert.equal(s.kind, 'none')
})

test('screenshot returns an existing file', async () => {
  const s = await screenshot('harn')
  assert.ok(fs.existsSync(s.file))
})

test('disconnect resolves', async () => {
  await disconnect('harn')
})

test('join says the world is still loading when it outlasts the wait', async () => {
  const res = await join('harn', 'offline', { loadWaitMs: 100 })
  assert.equal(res.loaded, false)
  assert.equal(res.screen, 'connecting')
  await disconnect('harn')
})

test('launch warns before the game starts when the server is stopped, and refuses an offline player against an online-mode server', async () => {
  makeServer('down', 45635, 'online-mode=false\nserver-ip=127.0.0.1\n')
  fs.rmSync(stateFile('down'), { force: true })
  createProfile('warn', { mc: '1.21.11' })
  try {
    const early = []
    const res = await launch('warn', { fakeJava, server: 'down', playerName: 'tester', onWarning: (w) => early.push({ w, running: status('warn').running }) })
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /server "down" is not running.*spawnloft start down/)
    // told before the game was started, so a terminal shows it above the launch line
    assert.deepEqual(early, [{ w: res.warnings[0], running: false }])
    await stop('warn')
    // refused before anything runs: the server would refuse the join for sure
    await assert.rejects(launch('warn', { fakeJava, server: 'online', playerName: 'tester' }), /server "online" runs in online mode and tester is an offline player, so the server would refuse the join; sign in \(spawnloft client login\)/)
    assert.equal(status('warn').running, false)
    // a profile-level account selector counts as offline when it says so, and the player name is the one after the colon
    await assert.rejects(launch('warn', { fakeJava, server: 'online', account: 'offline:Bob' }), /online mode and Bob is an offline player/)
    // a signed-in account is not refused for online mode (the sign-in itself is not on file here, so the account lookup fails instead)
    await assert.rejects(launch('warn', { fakeJava, server: 'online', account: 'Wunga_' }), /no Microsoft account named "Wunga_" is signed in/)
    const fine = await launch('warn', { fakeJava, server: 'offline', playerName: 'tester' })
    assert.deepEqual(fine.warnings, [])
    await stop('warn')
    // a database is refused before anything is looked up or started
    const dbDir = path.join(INSTANCES_DIR, 'db')
    fs.mkdirSync(dbDir, { recursive: true })
    putInstance('db', { dir: dbDir, kind: 'database', engine: 'mysql', port: 45637 })
    await assert.rejects(launch('warn', { fakeJava, server: 'db', playerName: 'tester' }), /"db" is a database/)
    assert.equal(status('warn').running, false)
  } finally {
    await stop('warn')
  }
})

test('status harness port is a number', () => {
  const st = status('harn')
  assert.ok(typeof st.harness.port === 'number')
})

test('stop resolves and cleans up', async () => {
  const res = await stop('harn')
  assert.deepEqual(res, { stopped: true, wasRunning: true })
  assert.equal(status('harn').running, false)
  assert.ok(!fs.existsSync(path.join(profileDir('harn'), 'spawnloft-harness.json')))
})

test('session rejects after stop', async () => {
  await assert.rejects(session('harn'), /not running/)
})

// The fake game reads these when it starts, so each test sets them around its own launch.
async function launchWith(name, env, opts = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return await launch(name, { fakeJava, ...opts })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('waitUntilLoaded waits past the resource load for the title screen', async () => {
  createProfile('boot', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', harness: true })
  try {
    await launchWith('boot', { FAKE_CLIENT_BOOT_MS: '800' })
    assert.equal((await session('boot').then((ch) => ch.call('status'))).screen, 'other')
    const st = await waitUntilLoaded('boot', { fadeMs: 0 })
    assert.equal(st.loaded, true)
    assert.equal(st.screen, 'title')
    // and one that outlasts the wait says so
    await stop('boot')
    await launchWith('boot', { FAKE_CLIENT_BOOT_MS: '5000' })
    const early = await waitUntilLoaded('boot', { timeoutMs: 200, fadeMs: 0 })
    assert.equal(early.loaded, false)
    assert.equal(early.screen, 'other')
  } finally {
    await stop('boot')
  }
})

test('a launch with a server: waitUntilLoaded waits for the world, and join waits for that connect instead of racing it', async () => {
  makeServer('other', 45639, 'online-mode=false\nserver-ip=127.0.0.1\n')
  createProfile('qp', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', harness: true, server: 'offline' })
  try {
    await launchWith('qp', { FAKE_CLIENT_QUICKPLAY_MS: '1500' })
    const loaded = await waitUntilLoaded('qp', { server: 'offline', fadeMs: 0 })
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.screen, 'ingame')
    assert.deepEqual(loaded.connected, { host: '127.0.0.1', port: 45633 })
    // already in the world on that server: nothing to do
    const again = await join('qp', 'offline')
    assert.equal(again.already, true)
    assert.equal(again.loaded, true)
    await stop('qp')

    await launchWith('qp', { FAKE_CLIENT_QUICKPLAY_MS: '1500' })
    const ch = await session('qp')
    const until = Date.now() + 5000
    while ((await ch.call('status')).screen !== 'connecting') {
      assert.ok(Date.now() < until, 'the fake game never showed the connect screen')
      await new Promise((r) => setTimeout(r, 50))
    }
    // another server while the launch's connect is under way is refused, not raced
    await assert.rejects(join('qp', 'other'), /"qp" is still connecting to a server; wait until client_status shows it in the world, then disconnect before joining other/)
    const res = await join('qp', 'offline')
    assert.deepEqual(res, { joined: true, already: true, server: 'offline', host: '127.0.0.1', port: 45633, loaded: true, screen: 'ingame' })
    assert.ok(!tailClientLog('qp', 200).some((l) => /already connecting/.test(l)), 'join started a second connect')
    await stop('qp')

    // asked while resources still load (client_launch with wait false), join waits too. The
    // launch plus the session connect must finish inside the boot window: 600 ms was missed
    // twice on the self-hosted runner, so it is 3 s.
    await launchWith('qp', { FAKE_CLIENT_BOOT_MS: '3000', FAKE_CLIENT_QUICKPLAY_MS: '600' })
    assert.equal((await session('qp').then((c) => c.call('status'))).screen, 'other')
    const early = await join('qp', 'offline')
    assert.equal(early.already, true)
    assert.equal(early.loaded, true)
    assert.ok(!tailClientLog('qp', 200).some((l) => /already connecting/.test(l)), 'join started a second connect')
    await stop('qp')

    // a refused launch join that lands back on the title screen ends the wait, not 90 s later
    await launchWith('qp', { FAKE_CLIENT_QUICKPLAY_MS: '600', FAKE_CLIENT_QUICKPLAY_FAIL: '1' })
    const started = Date.now()
    const refused = await waitUntilLoaded('qp', { server: 'offline', fadeMs: 0, timeoutMs: 10000 })
    assert.equal(refused.loaded, true)
    assert.equal(refused.screen, 'title')
    assert.ok(Date.now() - started < 5000)
  } finally {
    await stop('qp')
  }
})

test('waitUntilLoaded counts a titled screen of its own (a fresh profile\'s accessibility screen) as loaded', async () => {
  try {
    await launchWith('boot', { FAKE_CLIENT_BOOT_MS: '300', FAKE_CLIENT_SCREEN_TITLE: 'Accessibility Menu' })
    const started = Date.now()
    const st = await waitUntilLoaded('boot', { fadeMs: 0, timeoutMs: 10000 })
    assert.equal(st.loaded, true)
    assert.equal(st.screen, 'other')
    assert.equal(st.screenTitle, 'Accessibility Menu')
    assert.ok(Date.now() - started < 5000)
  } finally {
    await stop('boot')
  }
})
