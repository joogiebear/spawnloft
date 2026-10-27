import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-quick-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.MCCTL_FAKE_CLIENT = path.resolve(process.cwd(), 'test', 'fixtures', 'fake-client.mjs')
const { serve } = await import('../src/ui.mjs')
const registry = await import('../src/registry.mjs')
const { UserError } = await import('../src/util.mjs')
const client = await import('../src/client.mjs')
const clientPaths = await import('../src/client-paths.mjs')

const dir = path.join(scratch, 'data', 'instances', 'quick')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'paper.jar'), '')
fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Hello\n')
registry.putInstance('quick', { dir, jar: 'paper.jar', memory: '4G', port: 45901, rcon: { port: 45902, password: 'x' } })

const panel = await serve({ port: 0, open: false })
after(async () => {
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})
const api = (route, body) => fetch(panel.url + 'api/' + route, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

/** Enough of a PNG for the check the endpoint makes: the signature, then IHDR's width and height. */
function png(width, height) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return 'data:image/png;base64,' + b.toString('base64')
}

test('Java arguments: memory and the jar stay SpawnLoft\'s, the rest is the owner\'s', () => {
  assert.deepEqual(registry.cleanJvmFlags('-XX:+UseZGC\n  -XX:+ZGenerational  -Dfile.encoding=UTF-8 '), ['-XX:+UseZGC', '-XX:+ZGenerational', '-Dfile.encoding=UTF-8'])
  assert.equal(registry.cleanJvmFlags('   '), null)
  assert.equal(registry.cleanJvmFlags(null), null)
  for (const bad of ['-Xmx8G', '-Xms1G', '-jar other.jar', 'UseZGC', '-cp x']) assert.throws(() => registry.cleanJvmFlags(bad), UserError, bad)
  assert.throws(() => registry.cleanJvmFlags(Array.from({ length: 61 }, () => '-Dx=1')), /more than 60/)
})

test('Java arguments save through the panel, and empty goes back to the recommended set', async () => {
  let res = await api('instances/quick/settings', { jvmFlags: '-XX:+UseZGC -Dx=1' })
  assert.equal(res.status, 200)
  assert.deepEqual(registry.getInstance('quick').jvmFlags, ['-XX:+UseZGC', '-Dx=1'])
  res = await api('instances/quick/settings', { jvmFlags: '-Xmx9G' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Memory setting/)
  await api('instances/quick/settings', { jvmFlags: null })
  assert.equal(registry.getInstance('quick').jvmFlags, null)
  const listed = (await (await api('instances')).json()).find((r) => r.name === 'quick')
  assert.ok(listed.defaultJvmFlags.includes('-XX:+UseG1GC'))
})

test('the server icon must be a 64 by 64 PNG, and can be taken away again', async () => {
  assert.equal((await api('instances/quick/icon')).status, 404)
  assert.equal((await api('instances/quick/icon', { png: png(32, 32) })).status, 400)
  assert.equal((await api('instances/quick/icon', { png: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') })).status, 400)
  const ok = await api('instances/quick/icon', { png: png(64, 64) })
  assert.equal(ok.status, 200)
  const got = await api('instances/quick/icon')
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await got.arrayBuffer()).readUInt32BE(16), 64)
  assert.ok(fs.existsSync(path.join(dir, 'server-icon.png')))
  assert.equal((await api('instances/quick/icon/remove', {})).status, 200)
  assert.ok(!fs.existsSync(path.join(dir, 'server-icon.png')))
})

test('diagnostics: POST writes the zip, GET streams it with attachment', async () => {
  const res = await api('instances/quick/diag', {})
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.file.endsWith('.zip'))
  assert.ok(fs.existsSync(body.file))
  assert.ok(body.sizeHuman)
  assert.ok(Array.isArray(body.findings.server))
  assert.ok(Array.isArray(body.findings.client))

  const basename = body.file.split(/[\\/]/).pop()
  const dl = await fetch(panel.url + 'api/instances/quick/diag/download?file=' + encodeURIComponent(basename))
  assert.equal(dl.status, 200)
  assert.match(dl.headers.get('content-disposition'), /^attachment/)
})

test('diagnostics download refuses path traversal', async () => {
  const r1 = await fetch(panel.url + 'api/instances/quick/diag/download?file=' + encodeURIComponent('../instances.json'))
  assert.equal(r1.status, 400)

  const r2 = await fetch(panel.url + 'api/instances/quick/diag/download?file=' + encodeURIComponent('..\\instances.json'))
  assert.equal(r2.status, 400)
})

test('the panel lists, launches, reports and stops a client profile', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'test', 'fixtures', 'client', 'version_manifest_v2.json'), 'utf8'))
  const mc = manifest.latest.release
  fs.mkdirSync(clientPaths.versionDir(mc), { recursive: true })
  fs.copyFileSync(path.resolve(process.cwd(), 'test', 'fixtures', 'client', `${mc}.json`), clientPaths.versionJson(mc))
  client.createProfile('pp', { mc, server: 'quick' })

  const listRes = await fetch(panel.url + 'api/client/profiles')
  assert.equal(listRes.status, 200)
  const listData = await listRes.json()
  assert.equal(listData.length, 1)
  assert.equal(listData[0].name, 'pp')
  assert.equal(listData[0].mc, mc)
  assert.equal(listData[0].server, 'quick')
  assert.equal(listData[0].running, false)

  const launchRes = await fetch(panel.url + 'api/client/profiles/pp/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(launchRes.status, 200)
  const launchData = await launchRes.json()
  assert.equal(typeof launchData.pid, 'number')

  const statusRes = await fetch(panel.url + 'api/client/profiles/pp/status')
  assert.equal(statusRes.status, 200)
  const statusData = await statusRes.json()
  assert.equal(statusData.running, true)

  const stopRes = await fetch(panel.url + 'api/client/profiles/pp/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(stopRes.status, 200)
  const stopData = await stopRes.json()
  assert.equal(stopData.stopped, true)

  const statusRes2 = await fetch(panel.url + 'api/client/profiles/pp/status')
  assert.equal(statusRes2.status, 200)
  const statusData2 = await statusRes2.json()
  assert.equal(statusData2.running, false)

  const badStatus = await fetch(panel.url + 'api/client/profiles/nosuch/status')
  assert.equal(badStatus.status, 400)

  const stopRes2 = await fetch(panel.url + 'api/client/profiles/pp/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(stopRes2.status, 200)
  const stopData2 = await stopRes2.json()
  assert.equal(stopData2.stopped, false)
})

test('the panel shows the Linux arm64 refusal as the launch error', async () => {
  // currentOs() reads these on every call; the refusal comes before anything else is touched
  const real = { platform: process.platform, arch: process.arch }
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
  let res
  try {
    res = await fetch(panel.url + 'api/client/profiles/pp/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  } finally {
    Object.defineProperty(process, 'platform', { value: real.platform, configurable: true })
    Object.defineProperty(process, 'arch', { value: real.arch, configurable: true })
  }
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'the Minecraft client has no Linux arm64 build; use bots on this machine' })
  assert.equal(client.status('pp').running, false)
})
