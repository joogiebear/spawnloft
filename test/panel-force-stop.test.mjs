/**
 * The panel's force stop: the way out for a server that is running with no daemon. Own file: the
 * orphan is a real process, and it is killed.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-force-stop-'))
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance } = await import('../src/registry.mjs')
const { readState } = await import('../src/control.mjs')
const { INSTANCES_DIR, stateFile } = await import('../src/paths.mjs')
const { writeJson, pidAlive, sleep } = await import('../src/util.mjs')
const { serve, settingWords } = await import('../src/ui.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')

const name = 'out-of-reach'
const dir = path.join(INSTANCES_DIR, name)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'server.jar'), '')
putInstance(name, { dir, jar: 'server.jar', memory: '1G', port: 41600, rcon: { port: 41601, password: 'p' } })

const panel = await serve({ port: 0 })
const at = `${panel.url}api/instances/${name}/kill`
after(async () => {
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('a server that can be stopped the usual way is not force stopped', async () => {
  const res = await panelFetch(at, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /does not need a force stop/)
  // and never by a GET
  assert.equal((await panelFetch(at)).status, 405)
})

test('a server out of reach is ended, and reads as stopped after', async () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  try {
    writeJson(stateFile(name), { name, running: true, daemonPid: dead, javaPid: orphan.pid })
    assert.equal(readState(name).status, 'orphaned')

    const res = await panelFetch(at, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, 'stopped')
    for (let i = 0; i < 50 && pidAlive(orphan.pid); i++) await sleep(100)
    assert.ok(!pidAlive(orphan.pid), 'the process is still running')
  } finally {
    try {
      orphan.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('a changed setting is recorded under the name the Settings page gives it', () => {
  assert.equal(settingWords('difficulty', 'hard'), 'Difficulty: hard')
  assert.equal(settingWords('online-mode', 'false'), 'Require a Minecraft account: off')
  assert.equal(settingWords('autoRestart', true), 'Restart it automatically: on')
  assert.equal(settingWords('label', ''), 'Display name: cleared')
  // a key with no label is still said
  assert.equal(settingWords('something-new', 3), 'something-new: 3')
})
