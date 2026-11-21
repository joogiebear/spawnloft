/**
 * Renames that only change capitals. Windows and a default macOS disk treat "gamma" and "Gamma"
 * as one name, which broke two things: the scheduled task was deleted, and a server with backups
 * could not be renamed because its own backups folder looked like someone else's.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-rename-case-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance, getInstance, hasInstance } = await import('../src/registry.mjs')
const manage = await import('../src/manage.mjs')
const { swapRegistration, caseOnlyChange } = await import('../src/schedule.mjs')
const { INSTANCES_DIR, BACKUPS_DIR } = await import('../src/paths.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A scheduler that ignores case, like Task Scheduler or launchd plists on APFS. */
function caseBlindScheduler() {
  const tasks = new Map()
  const log = []
  return {
    tasks,
    log,
    has: (id) => tasks.has(id.toLowerCase()),
    ops: {
      write: (id) => { log.push(`write ${id}`); tasks.set(id.toLowerCase(), id) },
      remove: (id) => { log.push(`remove ${id}`); tasks.delete(id.toLowerCase()) },
    },
  }
}

test('only a change of capitals counts as a case-only change', () => {
  assert.equal(caseOnlyChange('gamma-backup', 'Gamma-backup'), true)
  assert.equal(caseOnlyChange('gamma-backup', 'gamma-backup'), false)
  assert.equal(caseOnlyChange('gamma-backup', 'delta-backup'), false)
})

test('a capitals-only task move keeps the task on a scheduler that ignores case', () => {
  const s = caseBlindScheduler()
  s.ops.write('gamma-backup')
  swapRegistration('gamma-backup', 'Gamma-backup', s.ops)
  assert.ok(s.has('Gamma-backup'), 'the task was deleted from the scheduler')
  assert.equal(s.tasks.get('gamma-backup'), 'Gamma-backup', 'the task kept its old capitals')
  assert.deepEqual(s.log.slice(1), ['remove gamma-backup', 'write Gamma-backup'])
})

test('a capitals-only move whose write fails puts the old task back', () => {
  const s = caseBlindScheduler()
  s.ops.write('gamma-backup')
  const ops = { ...s.ops, write: (id) => { if (id === 'Gamma-backup') throw new Error('schtasks failed'); s.ops.write(id) } }
  assert.throws(() => swapRegistration('gamma-backup', 'Gamma-backup', ops), /schtasks failed/)
  assert.equal(s.tasks.get('gamma-backup'), 'gamma-backup', 'the old task was not restored')
})

test('a move to a different name still adds the new task before removing the old one', () => {
  const s = caseBlindScheduler()
  s.ops.write('gamma-backup')
  swapRegistration('gamma-backup', 'delta-backup', s.ops)
  assert.deepEqual(s.log.slice(1), ['write delta-backup', 'remove gamma-backup'])
  assert.ok(s.has('delta-backup') && !s.has('gamma-backup'))
})

test('a different-name move whose remove fails takes the new task back out', () => {
  const s = caseBlindScheduler()
  s.ops.write('gamma-backup')
  const ops = { ...s.ops, remove: (id) => { if (id === 'gamma-backup') throw new Error('running'); s.ops.remove(id) } }
  assert.throws(() => swapRegistration('gamma-backup', 'delta-backup', ops), /running/)
  assert.ok(s.has('gamma-backup') && !s.has('delta-backup'))
})

test('sameEntry knows one folder by two paths and tells two folders apart', () => {
  const a = path.join(scratch, 'same-a')
  const b = path.join(scratch, 'same-b')
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  assert.equal(manage.sameEntry(a, a), true)
  assert.equal(manage.sameEntry(a, b), false)
  assert.equal(manage.sameEntry(a, path.join(scratch, 'missing')), false)
  const link = path.join(scratch, 'same-link')
  try { fs.symlinkSync(a, link, 'junction') } catch { return } // no symlink rights on this Windows
  assert.equal(manage.sameEntry(a, link), true)
})

function makeInstance(name, port) {
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n')
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port, rcon: { port: port + 1, password: 'p' } })
  return getInstance(name)
}

// On Windows CI this is the reported failure: backups\gamma "already holds snapshots"
test('a capitals-only rename goes through when the server has backups', () => {
  makeInstance('gamma', 40200)
  fs.mkdirSync(path.join(BACKUPS_DIR, 'gamma'), { recursive: true })
  fs.writeFileSync(path.join(BACKUPS_DIR, 'gamma', 'snap.tar.gz'), 'gz')

  const res = manage.rename('gamma', 'Gamma')

  assert.ok(hasInstance('Gamma') && !hasInstance('gamma'))
  assert.equal(path.basename(res.dir), 'Gamma')
  assert.ok(fs.readdirSync(BACKUPS_DIR).includes('Gamma'), 'the backups folder did not take the new capitals')
  assert.ok(fs.existsSync(path.join(BACKUPS_DIR, 'Gamma', 'snap.tar.gz')), 'the snapshot was lost')
  assert.ok(fs.readdirSync(INSTANCES_DIR).includes('Gamma'), 'the server folder did not take the new capitals')
})

test("another server's leftover backups folder still stops a rename", () => {
  makeInstance('epsilon', 40210)
  fs.mkdirSync(path.join(BACKUPS_DIR, 'epsilon'), { recursive: true })
  fs.mkdirSync(path.join(BACKUPS_DIR, 'zeta'), { recursive: true })
  assert.throws(() => manage.rename('epsilon', 'zeta'), /already holds snapshots/)
  assert.ok(hasInstance('epsilon'))
})

test('a capitals-only move whose removal fails part way puts the old task back', () => {
  const s = caseBlindScheduler()
  s.ops.write('gamma-backup')
  const ops = { ...s.ops, remove: (id) => { s.ops.remove(id); throw new Error('launchctl refused') } }
  assert.throws(() => swapRegistration('gamma-backup', 'Gamma-backup', ops), /launchctl refused/)
  assert.equal(s.tasks.get('gamma-backup'), 'gamma-backup', 'the old task was not restored')
})

test('a rename to the capitals of another server is refused', () => {
  makeInstance('eta', 40220)
  makeInstance('theta', 40230)
  assert.throws(() => manage.rename('theta', 'ETA'), /differs from it only in capitals/)
  assert.ok(hasInstance('theta') && hasInstance('eta'))
})
