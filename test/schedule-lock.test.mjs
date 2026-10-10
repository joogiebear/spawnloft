import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-schedlock-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const schedule = await import('../src/schedule.mjs')
const { DATA_ROOT } = await import('../src/paths.mjs')
const lockFile = path.join(DATA_ROOT, 'schedules.lock')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** Another process (a live pid that is not this one) holding the tasks lock for `ms`. */
function holdLockElsewhere(ms) {
  const util = new URL('../src/util.mjs', import.meta.url).href
  const code = `import { acquireLock } from ${JSON.stringify(util)}
    const release = acquireLock(${JSON.stringify(lockFile)}, { mode: 'fail' })
    console.log(release ? 'held' : 'busy')
    setTimeout(() => { release?.(); process.exit(0) }, ${ms})`
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env, stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => (String(d).trim() === 'held' ? resolve(child) : reject(new Error('could not take the lock'))))
    child.once('error', reject)
  })
}

test('a change to the scheduled tasks waits for one already in progress in another process', async () => {
  const child = await holdLockElsewhere(1200)
  const started = Date.now()
  assert.throws(() => schedule.remove('nothing-here'), /no scheduled task/)
  const waited = Date.now() - started
  assert.ok(waited >= 900, `did not wait for the lock, returned after ${waited}ms`)
  await new Promise((resolve) => child.once('exit', resolve))
})

test('a change that makes other changes does not wait on itself', () => {
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  fs.writeFileSync(path.join(DATA_ROOT, 'schedules.json'), JSON.stringify({
    version: 1,
    tasks: { 'smp-backup': { instance: 'smp', name: 'b', action: { type: 'backup' }, schedule: { kind: 'daily', at: '03:00' }, enabled: false } },
  }))
  const started = Date.now()
  schedule.removeAll() // calls remove() for each task while already holding the lock
  assert.ok(Date.now() - started < 5000, 'nested change waited for the lock it already held')
  assert.equal(fs.existsSync(lockFile), false, 'lock released afterwards')
})

test('the lock is released when a change fails', () => {
  assert.throws(() => schedule.remove('nothing-here'))
  assert.equal(fs.existsSync(lockFile), false)
  assert.throws(() => schedule.remove('nothing-here'))
})
