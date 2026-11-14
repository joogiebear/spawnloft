/**
 * The Players routes: what is refused, and what the activity log is told. Own file: it starts a
 * panel and stands a real process in for a server that is out of reach.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-panel-players-'))
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance } = await import('../src/registry.mjs')
const { readState } = await import('../src/control.mjs')
const { INSTANCES_DIR, stateFile } = await import('../src/paths.mjs')
const { writeJson } = await import('../src/util.mjs')
const { readProps } = await import('../src/props.mjs')
const activity = await import('../src/activity.mjs')
const { serve } = await import('../src/ui.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')

const name = 'guest-list'
const dir = path.join(INSTANCES_DIR, name)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'server.jar'), '')
fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\nonline-mode=false\n')
putInstance(name, { dir, jar: 'server.jar', memory: '1G', port: 41620, rcon: { port: 41621, password: 'p' } })

const panel = await serve({ port: 0 })
const base = `${panel.url}api/instances/${name}/players`
const send = (verb, body) => panelFetch(`${base}/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const whitelist = () => readProps(path.join(dir, 'server.properties')).get('white-list')
const recorded = () => activity.readActivity({ server: name }).entries.map((e) => e.action)
after(async () => {
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('where the server can be joined from is answered from this computer alone', async () => {
  const at = `${panel.url}api/instances/${name}/join`
  const info = await (await panelFetch(at)).json()
  assert.equal(info.port, 41620)
  assert.equal(info.here, 'localhost')
  assert.ok(Array.isArray(info.lan) && Array.isArray(info.public))
  assert.equal((await panelFetch(at, { method: 'POST' })).status, 405)
})

test('the whitelist switch has to be told on or off', async () => {
  for (const body of [{}, { on: 'false' }, { on: 1 }]) {
    const res = await send('whitelist-mode', body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal(whitelist(), undefined)
  assert.deepEqual(recorded(), [])

  assert.equal((await send('whitelist-mode', { on: true })).status, 200)
  assert.equal(whitelist(), 'true')
  assert.equal((await send('whitelist-mode', { on: false })).status, 200)
  assert.equal(whitelist(), 'false')
  assert.deepEqual(recorded(), ['whitelist-off', 'whitelist-on'])

  const seen = await (await panelFetch(base)).json()
  assert.equal(seen.whitelistOn, false)
  assert.equal(seen.whitelistEnforced, false)
})

test('someone is added by name on a stopped server, and the log says so', async () => {
  const res = await send('add', { name: 'Notch', as: 'whitelist' })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8'))[0].name, 'Notch')
  assert.equal(recorded()[0], 'player-whitelist')
  assert.equal((await send('add', { name: 'two words', as: 'whitelist' })).status, 400)
})

test('a server out of reach owns its lists: nothing is written behind its back', async () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  try {
    writeJson(stateFile(name), { name, running: true, daemonPid: dead, javaPid: orphan.pid })
    assert.equal(readState(name).status, 'orphaned')
    const before = recorded().length
    for (const [verb, body] of [['whitelist-mode', { on: true }], ['add', { name: 'Alex', as: 'op' }]]) {
      const res = await send(verb, body)
      assert.equal(res.status, 409, verb)
      assert.match((await res.json()).error, /cannot be changed right now/)
    }
    assert.equal(whitelist(), 'false')
    assert.ok(!fs.existsSync(path.join(dir, 'ops.json')))
    assert.equal(recorded().length, before)
  } finally {
    orphan.kill('SIGKILL')
    fs.rmSync(stateFile(name), { force: true })
  }
})
