import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { platformCapabilities, PREVIEW_LIMITS } from '../src/platform.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-platform-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { serve } = await import('../src/ui.mjs')
const { newInstance } = await import('../src/create.mjs')
const schedule = await import('../src/schedule.mjs')
const { DATA_ROOT, REGISTRY_FILE } = await import('../src/paths.mjs')
const servers = []
after(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('Windows keeps its capabilities and Mac supports scheduling, metrics, and managed databases', () => {
  assert.deepEqual(platformCapabilities('win32'), { scheduler: true, performance: true, managedDatabases: true })
  assert.deepEqual(platformCapabilities('darwin'), { scheduler: true, performance: true, managedDatabases: true })
  assert.deepEqual(platformCapabilities('linux'), { scheduler: true, performance: false, managedDatabases: false })
  assert.deepEqual(platformCapabilities('freebsd'), { scheduler: false, performance: false, managedDatabases: false })
})

test('Mac panel exposes scheduling and automatic backups without changing server data', async () => {
  // Exercise the platform branches on every runner, while Node's actual filesystem and
  // networking remain native. This does not claim to test a packaged Mac application.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  try {
    const jar = path.join(scratch, 'paper-test.jar')
    fs.writeFileSync(jar, 'fixture; never launched')
    const inst = await newInstance('preview-test', { jar, java: 'java', port: 25671, rconPort: 25672 })
    assert.equal(inst.name, 'preview-test')
    const registryBefore = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const panel = await serve({ port: 0, open: false })
    servers.push(panel.server)
    assert.match(await (await fetch(panel.url)).text(), /name="spawnloft-platform" content="darwin"/)
    const get = async route => (await fetch(panel.url + 'api/' + route)).json()
    const post = route => fetch(panel.url + 'api/' + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const base = 'instances/' + inst.name
    assert.deepEqual((await get('settings')).capabilities, platformCapabilities('darwin'))
    assert.equal(Array.isArray((await get(base + '/schedules')).tasks), true)
    const metrics = await get(base + '/metrics')
    assert.deepEqual(metrics.samples, [])
    assert.equal(metrics.everySeconds, 10)
    assert.ok(metrics.cores >= 1)
    assert.equal(metrics.running, false)
    const backups = await get(base + '/backups')
    assert.equal(backups.automaticAvailable, true)
    assert.deepEqual(backups.snapshots, [])
    const history = await get(base + '/backups/history')
    assert.deepEqual(history, Object.fromEntries(
      ['snapshots', 'dir', 'root', 'mirror', 'running'].map(key => [key, backups[key]]),
    ))
    assert.equal(fs.readFileSync(REGISTRY_FILE, 'utf8'), registryBefore)
    assert.equal(fs.existsSync(path.join(DATA_ROOT, 'tasks')), false)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
