import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-session-'))
process.env.MCCTL_DATA_ROOT = scratch

const { launch, status, stop, createProfile, session, join, chat, messages, screenshot, player, screen, disconnect } = await import('../src/client.mjs')
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
  try { await stop('harn') } catch {}
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

test('join refuses an online-mode server', async () => {
  await assert.rejects(join('harn', 'online'), /online mode/)
})

test('join succeeds on an offline server', async () => {
  const res = await join('harn', 'offline')
  assert.deepEqual(res, { joined: true, server: 'offline', host: '127.0.0.1', port: 45633 })
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
