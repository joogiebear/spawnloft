/**
 * Everything that needs a registry behind it: rebuild, rename, port checks, the snapshot flush,
 * the pid-reuse check and the panel's status codes.
 *
 * <p>Isolated the way lifecycle.test.mjs is - MCCTL_DATA_ROOT points every path at a scratch
 * folder before the first module that resolves paths is imported - so putInstance writes into a
 * registry nobody else reads and rmSync never meets a real world.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-manage-'))
process.env.MCCTL_DATA_ROOT = scratch
// The mirror test saves settings, and MCCTL_DATA_ROOT does not move the settings file: without
// these it rewrote the developer's own settings.json on every run.
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance, getInstance, assertPortUsable, hasInstance } = await import('../src/registry.mjs')
const manage = await import('../src/manage.mjs')
const backup = await import('../src/backup.mjs')
const { sameProcess, UserError, findFreePort } = await import('../src/util.mjs')
const { INSTANCES_DIR } = await import('../src/paths.mjs')
const ui = await import('../src/ui.mjs')

function world(dir, name) {
  fs.mkdirSync(path.join(dir, name, 'region'), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'level.dat'), 'nbt')
}

/** An instance where mcctl would have put it, so rename moves the folder the way it does for real. */
function makeInstance(name, { level = 'world', port = 40000, rconPort = 40001 } = {}) {
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), `level-name=${level}\nmotd=x\n`)
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port, rcon: { port: rconPort, password: 'p' } })
  return getInstance(name)
}

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// ---- rebuild ----------------------------------------------------------------

test('rebuild wipes the worlds level-name names, not "world"', async () => {
  const inst = makeInstance('rb', { level: 'rpg' })
  world(inst.dir, 'rpg')
  world(inst.dir, 'rpg_nether')
  world(inst.dir, 'keepme')
  fs.writeFileSync(path.join(inst.dir, 'ops.json'), '[]')

  const res = await manage.rebuild('rb', { snapshot: false })

  assert.deepEqual(res.removed.sort(), ['ops.json', 'rpg', 'rpg_nether'].sort())
  assert.ok(!fs.existsSync(path.join(inst.dir, 'rpg')), 'the active world was not removed')
  assert.ok(!fs.existsSync(path.join(inst.dir, 'rpg_nether')), 'the companion dimension was not removed')
  assert.ok(fs.existsSync(path.join(inst.dir, 'keepme')), 'a world that is not active must survive')
  assert.ok(fs.existsSync(path.join(inst.dir, 'server.jar')), 'the jar must survive')
})

// ---- rename -----------------------------------------------------------------

test('rename rewrites the launchers under the new name and moves the mirror folder', async () => {
  const inst = makeInstance('before', { port: 40010, rconPort: 40011 })
  const starter = process.platform === 'linux' ? 'start.sh' : 'start.bat'
  fs.writeFileSync(path.join(inst.dir, starter), 'stale start before\r\n')
  const mirror = path.join(scratch, 'mirror')
  const settings = await import('../src/settings.mjs')
  settings.save({ backupsMirrorDir: mirror })
  fs.mkdirSync(path.join(mirror, 'before'), { recursive: true })
  fs.writeFileSync(path.join(mirror, 'before', 'x.tar.gz'), 'gz')

  const res = manage.rename('before', 'after')
  settings.save({ backupsMirrorDir: null })

  assert.equal(res.movedDir, true)
  assert.ok(hasInstance('after') && !hasInstance('before'))
  const bat = fs.readFileSync(path.join(res.dir, starter), 'utf8')
  assert.match(bat, /start '?after/, 'the start launcher still starts the old name')
  assert.doesNotMatch(bat, /before/)
  assert.ok(fs.existsSync(path.join(mirror, 'after', 'x.tar.gz')), 'the mirror folder did not follow the rename')
  assert.ok(!fs.existsSync(path.join(mirror, 'before')))
})

// ---- ports ------------------------------------------------------------------

test('a port is refused when it is not a port or belongs to another instance', () => {
  makeInstance('porta', { port: 40020, rconPort: 40021 })
  makeInstance('portb', { port: 40030, rconPort: 40031 })
  assert.equal(assertPortUsable('porta', 40040), 40040)
  assert.equal(assertPortUsable('porta', 40020), 40020, 'an instance may keep its own port')
  assert.throws(() => assertPortUsable('porta', NaN), UserError)
  assert.throws(() => assertPortUsable('porta', 70000), UserError)
  assert.throws(() => assertPortUsable('porta', 40030), /already used by "portb"/)
  assert.throws(() => assertPortUsable('porta', 40031), /already used by "portb"/, 'an RCON port counts too')
})

// ---- the pid-reuse check ----------------------------------------------------

test('a live pid is the recorded process only when the executable name agrees', () => {
  const me = path.basename(process.execPath)
  assert.equal(sameProcess(process.pid, me), true)
  assert.equal(sameProcess(process.pid, me.replace(/\.exe$/i, '')), true, 'the .exe suffix is not significant')
  assert.equal(sameProcess(process.pid, 'java'), false, 'this process is not a JVM')
  assert.equal(sameProcess(process.pid, null), true, 'a state file from before the check is trusted as before')
})

// ---- the snapshot flush -----------------------------------------------------

test('a hot snapshot whose flush fails is still taken, and says so', async () => {
  // RCON on a port nothing listens on: the flush cannot happen, the snapshot must.
  const rconPort = await findFreePort(40100)
  const inst = makeInstance('flush', { port: 40090, rconPort })
  fs.mkdirSync(path.join(inst.dir, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'a.jar'), 'jar')

  const res = await backup.createSnapshot(inst, { scope: 'plugins', running: true })

  assert.ok(fs.statSync(res.file).size > 0)
  assert.equal(res.flushed, false)
  assert.match(res.flushWarning, /could not flush/)
  assert.equal(res.manifest.flushed, false)
  assert.match(res.manifest.warnings[0], /could not flush/)

  const cold = await backup.createSnapshot(inst, { scope: 'plugins', running: false })
  assert.equal(cold.flushWarning, null, 'a stopped server has nothing to flush')
})

// ---- the panel's status codes -----------------------------------------------

test('the panel answers a refusal with 400, an unknown server with 404, and never leaks the RCON password', async () => {
  makeInstance('panel', { port: 40050, rconPort: 40051 })
  const { server, url } = await ui.serve({ port: 0, open: false })
  try {
    const post = (p, body) => fetch(`${url}api/${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url.replace(/\/$/, '') },
      body: JSON.stringify(body),
    })

    const bad = await post('instances/panel/settings', { port: 'abc' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /not a port number/)

    const missing = await post('instances/nope/start', {})
    assert.equal(missing.status, 404)

    const list = await (await fetch(`${url}api/instances`)).json()
    const row = list.find((r) => r.name === 'panel')
    assert.ok(row)
    assert.equal(row.rcon, undefined, 'the password object must be stripped')
    assert.equal(row.rconPort, 40051)

    const foreign = await fetch(`${url}api/instances`, { headers: { origin: 'http://127.0.0.1:1' } })
    assert.equal(foreign.status, 403, 'another loopback port is not first-party')
  } finally {
    server.close()
  }
})
