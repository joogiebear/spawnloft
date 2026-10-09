/**
 * Every guard in front of a deletion, a restore, a rename or a rebuild, against every status.
 *
 * <p>The guards used to ask "is the status exactly running". Two other statuses own the files just
 * as much: `stopping`, which includes the pause before a crash restart - the daemon is up and
 * relaunches java into the directory it is being deleted from - and `orphaned`, a java process
 * whose daemon died, still holding the world and the port. Rebuild, rename, delete and purge walked
 * straight through both.
 *
 * <p>No daemon is spawned. The status is read from a state file, so the statuses are written
 * directly with real pids: this process for "alive", and a child that has already exited for "dead".
 * Neither state names an executable, which sameProcess takes as "no contradiction".
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-active-'))
process.env.MCCTL_DATA_ROOT = scratch
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance, getInstance, hasInstance } = await import('../src/registry.mjs')
const { readState, activeBlock, isActiveStatus, ACTIVE_STATUSES } = await import('../src/control.mjs')
const sup = await import('../src/supervisor.mjs')
const manage = await import('../src/manage.mjs')
const services = await import('../src/services.mjs')
const worlds = await import('../src/worlds.mjs')
const { INSTANCES_DIR, stateFile } = await import('../src/paths.mjs')
const { writeJson, UserError } = await import('../src/util.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A pid that belonged to a process and no longer does. */
const DEAD = spawnSync(process.execPath, ['-e', '0']).pid
const ALIVE = process.pid

// What each status is made of, per readState: the daemon and java pids and whether the file says running.
const STATUSES = {
  stopped: { running: false, daemonPid: DEAD, javaPid: DEAD },
  stale: { running: true, daemonPid: DEAD, javaPid: DEAD },
  running: { running: true, daemonPid: ALIVE, javaPid: ALIVE },
  stopping: { running: true, daemonPid: ALIVE, javaPid: DEAD },
  orphaned: { running: true, daemonPid: DEAD, javaPid: ALIVE },
}
const BLOCKED = ['running', 'stopping', 'orphaned']
const FREE = ['stopped', 'stale']

function setStatus(name, status) {
  writeJson(stateFile(name), { name, ...STATUSES[status] })
  assert.equal(readState(name).status, status, `the fixture did not produce "${status}"`)
}

let seq = 0
function makeServer() {
  const name = `ag${++seq}`
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'nbt')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n')
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port: 41000 + seq * 2, rcon: { port: 41001 + seq * 2, password: 'p' } })
  return { name, dir }
}

function makeDatabase() {
  const name = `agdb${++seq}`
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  putInstance(name, { kind: 'database', engine: 'mariadb', dir, port: 41000 + seq * 2 })
  return { name, dir }
}

test('exactly running, stopping and orphaned count as active', () => {
  assert.deepEqual([...ACTIVE_STATUSES].sort(), [...BLOCKED].sort())
  for (const status of Object.keys(STATUSES)) {
    assert.equal(isActiveStatus(status), BLOCKED.includes(status), status)
  }
  assert.equal(isActiveStatus(undefined), false)
})

for (const status of Object.keys(STATUSES)) {
  test(`isActive and isRunning agree with the "${status}" state file`, () => {
    const { name } = makeServer()
    setStatus(name, status)
    assert.equal(sup.isActive(name), BLOCKED.includes(status))
    // isRunning is the "can I talk to it" question and must not widen.
    assert.equal(sup.isRunning(name), status === 'running')
  })
}

test('the reason names the way out, which differs for an orphan', () => {
  const { name } = makeServer()

  setStatus(name, 'running')
  assert.match(activeBlock(name, 'deleting it'), /is running - stop it before deleting it/)

  setStatus(name, 'stopping')
  assert.match(activeBlock(name, 'deleting it'), /shutting down - wait.*before deleting it/)

  setStatus(name, 'orphaned')
  const orphan = activeBlock(name, 'deleting it')
  assert.match(orphan, /orphaned java process \(pid \d+\)/)
  assert.match(orphan, new RegExp(`mcctl kill ${name}`), '"stop it" would send them to a command that refuses an orphan')

  for (const status of FREE) {
    setStatus(name, status)
    assert.equal(activeBlock(name, 'deleting it'), null, status)
  }
})

for (const status of BLOCKED) {
  test(`rebuild, rename and delete refuse a "${status}" server and touch nothing`, async () => {
    const { name, dir } = makeServer()
    setStatus(name, status)

    await assert.rejects(manage.rebuild(name, { snapshot: false }), UserError)
    assert.throws(() => manage.rename(name, `${name}-new`), UserError)
    await assert.rejects(manage.destroy(name, { purge: true, snapshot: false }), UserError)

    assert.ok(fs.existsSync(path.join(dir, 'world', 'level.dat')), 'the world was removed')
    assert.ok(hasInstance(name), 'the registry entry went')
    assert.ok(!hasInstance(`${name}-new`), 'the rename went through')
    assert.ok(fs.existsSync(dir), 'the directory moved or was deleted')
  })
}

for (const status of FREE) {
  test(`rename and delete go ahead on a "${status}" server`, async () => {
    const { name } = makeServer()
    setStatus(name, status)

    manage.rename(name, `${name}-new`)
    assert.ok(hasInstance(`${name}-new`))
    assert.ok(!hasInstance(name))

    await manage.destroy(`${name}-new`, { purge: true, snapshot: false })
    assert.ok(!hasInstance(`${name}-new`))
  })
}

for (const status of BLOCKED) {
  test(`removing a database refuses a "${status}" one and leaves its folder`, () => {
    const { name, dir } = makeDatabase()
    setStatus(name, status)

    assert.throws(() => services.removeDatabase(name, { purge: true }), UserError)
    assert.ok(fs.existsSync(dir), 'a live database lost its data directory')
    assert.ok(hasInstance(name))
  })
}

for (const status of FREE) {
  test(`removing a database goes ahead on a "${status}" one`, () => {
    const { name, dir } = makeDatabase()
    setStatus(name, status)

    services.removeDatabase(name, { purge: true })
    assert.ok(!fs.existsSync(dir))
    assert.ok(!hasInstance(name))
  })
}

for (const status of BLOCKED) {
  test(`world switching and deletion refuse a "${status}" server`, () => {
    const inst = makeServer()
    fs.mkdirSync(path.join(inst.dir, 'spare'), { recursive: true })
    fs.writeFileSync(path.join(inst.dir, 'spare', 'level.dat'), 'nbt')
    setStatus(inst.name, status)
    const full = getInstance(inst.name)

    assert.throws(() => worlds.activateWorld(full, 'spare'), UserError)
    assert.throws(() => worlds.deleteWorld(full, 'spare'), UserError)

    assert.ok(fs.existsSync(path.join(inst.dir, 'spare', 'level.dat')), 'a world was deleted under a live server')
    assert.match(fs.readFileSync(path.join(inst.dir, 'server.properties'), 'utf8'), /level-name=world/)
  })
}
