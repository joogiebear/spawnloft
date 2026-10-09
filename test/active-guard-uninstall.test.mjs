/**
 * The uninstaller and an orphaned server.
 *
 * <p>Its own file, with exactly one instance registered: uninstall.run walks every instance and
 * stops each one that is active, so any other fixture left "running" under this process's own pid
 * would have the uninstaller kill the test runner. That is the behaviour under test, which is why
 * it cannot share a registry with the fixtures in active-guard.test.mjs.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-uninstall-orphan-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance } = await import('../src/registry.mjs')
const { readState } = await import('../src/control.mjs')
const uninstall = await import('../src/uninstall.mjs')
const { INSTANCES_DIR, stateFile } = await import('../src/paths.mjs')
const { writeJson, pidAlive, sleep } = await import('../src/util.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('uninstall stops an orphaned server instead of skipping it and deleting its data', async () => {
  // A real process stands in for the orphaned java, because the point is that it gets killed.
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const name = 'orphan-uninstall'
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port: 41500, rcon: { port: 41501, password: 'p' } })
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  try {
    writeJson(stateFile(name), { name, running: true, daemonPid: dead, javaPid: orphan.pid })
    assert.equal(readState(name).status, 'orphaned')

    const res = await uninstall.run({ data: false })

    assert.ok(res.stopped.includes(name), 'the orphan was passed over')
    for (let i = 0; i < 50 && pidAlive(orphan.pid); i++) await sleep(100)
    assert.ok(!pidAlive(orphan.pid), 'the orphaned java is still running')
  } finally {
    try {
      orphan.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})
