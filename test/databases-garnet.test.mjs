/**
 * Redis by way of Garnet, and databases that run elsewhere, against the real daemon and the
 * fakes. Isolated by MCCTL_DATA_ROOT like the other lifecycle suites.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-garnet-'))
process.env.MCCTL_DATA_ROOT = scratch

const { putInstance, listServices } = await import('../src/registry.mjs')
const services = await import('../src/services.mjs')
const garnet = await import('../src/garnet.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState } = await import('../src/control.mjs')
const { ENGINES_DIR, INSTANCES_DIR } = await import('../src/paths.mjs')
const { findFreePort, UserError } = await import('../src/util.mjs')
const ui = await import('../src/ui.mjs')

const VERSION = '0.0.0-fake'
const FIX = path.dirname(fileURLToPath(import.meta.url))
fs.mkdirSync(path.join(ENGINES_DIR, `garnet-${VERSION}`), { recursive: true })
fs.cpSync(path.join(FIX, 'fixtures', 'fake-garnet'), path.join(ENGINES_DIR, `garnet-${VERSION}`), { recursive: true })
fs.mkdirSync(path.join(ENGINES_DIR, `mariadb-${VERSION}`), { recursive: true })
fs.cpSync(path.join(FIX, 'fixtures', 'fake-mariadb'), path.join(ENGINES_DIR, `mariadb-${VERSION}`), { recursive: true })

const RD = `rd-${process.pid}`
const SRV = `srv-${process.pid}`
const EXT = `ext-${process.pid}`
fs.mkdirSync(path.join(INSTANCES_DIR, SRV, 'plugins', 'LuckPerms'), { recursive: true })
putInstance(SRV, { dir: path.join(INSTANCES_DIR, SRV), jar: 'paper.jar', memory: '4G', port: 25565 })

async function settle(name) {
  const deadline = Date.now() + 10000
  while (readState(name).status !== 'stopped' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
}

after(async () => {
  for (const n of [RD]) { try { await sup.kill(n) } catch { /* down */ } }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('a Garnet database is created on the Redis port range and starts to "ready"', { timeout: 30000 }, async () => {
  const port = await findFreePort(46500 + Math.floor(Math.random() * 3000))
  const db = await services.createDatabase(RD, { engine: 'garnet', version: VERSION, port })
  assert.equal(db.engine, 'garnet')
  assert.ok(fs.existsSync(garnet.dataDir(db)))
  const res = await sup.start(RD, { timeout: 15000 })
  assert.equal(res.ready, true, JSON.stringify(res))
  assert.match(res.readyLine, /Ready to accept connections/)
  assert.equal(await garnet.probe(services.getDatabase(RD)), true)
})

test('attaching a server to Redis hands out the shared password, a URL and a key prefix, with no user made', () => {
  const c = services.attach(RD, SRV)
  assert.equal(c.kind, 'redis')
  assert.equal(c.database, null)
  assert.equal(c.user, null)
  assert.equal(c.password, services.getDatabase(RD).root.password)
  assert.match(c.url, /^redis:\/\/:.+@127\.0\.0\.1:\d+$/)
  assert.equal(c.keyPrefix, `${SRV}:`)
  assert.match(c.note, /shares this password/)
  assert.equal(services.serverAttachments(SRV)[0].kind, 'redis')
})

test('only the Redis helpers are offered for a Redis database, and LuckPerms messaging is written', () => {
  fs.writeFileSync(path.join(INSTANCES_DIR, SRV, 'plugins', 'LuckPerms', 'config.yml'),
    'storage-method: h2\nmessaging-service: auto\nredis:\n  enabled: false\n  address: localhost\n  password: \'\'\n')
  const offered = services.helpersFor(SRV, { engine: 'garnet' })
  assert.deepEqual(offered.map((h) => h.id), ['luckperms-redis'])
  assert.throws(() => services.applyToPlugin(RD, SRV, 'luckperms'), /takes a mariadb connection/)
  const res = services.applyToPlugin(RD, SRV, 'luckperms-redis')
  const text = fs.readFileSync(path.join(INSTANCES_DIR, SRV, 'plugins', 'LuckPerms', 'config.yml'), 'utf8')
  assert.match(text, /^messaging-service: 'redis'$/m)
  assert.match(text, /^  enabled: true$/m)
  assert.match(text, /^storage-method: h2$/m, 'the storage line is not this helper\'s to touch')
  assert.deepEqual(res.written, ['messaging-service', 'redis.enabled', 'redis.address', 'redis.password'])
})

test('a snapshot skips a Redis database with the reason, rather than pretending to dump it', async () => {
  const dumps = await services.dumpAttachments(SRV, scratch)
  assert.deepEqual(dumps.dumped, [])
  assert.equal(dumps.skipped.length, 1)
  assert.match(dumps.skipped[0].reason, /not dumped/)
})

test('an external database is registered only if it answers, and attaches like one run here', { timeout: 30000 }, async () => {
  const live = services.getDatabase(RD)
  await assert.rejects(services.registerExternal(EXT, { engine: 'garnet', port: live.port, password: 'wrong' }), /WRONGPASS/)
  await assert.rejects(services.registerExternal(EXT, { engine: 'garnet', port: 1 }), UserError)
  const ext = await services.registerExternal(EXT, { engine: 'garnet', host: '127.0.0.1', port: live.port, password: live.root.password, label: 'The other one' })
  assert.equal(ext.external, true)
  assert.equal(ext.dir, undefined)
  assert.equal(await services.externalStatus(services.getDatabase(EXT)), 'reachable')
  await assert.rejects(sup.start(EXT), /runs elsewhere/)

  const c = services.attach(EXT, SRV)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.port, live.port)
  assert.equal(services.serverAttachments(SRV).find((a) => a.service === EXT).external, true)

  const { server, url } = await ui.serve({ port: 0, open: false })
  try {
    const rows = await (await fetch(`${url}api/databases`)).json()
    const row = rows.find((r) => r.name === EXT)
    assert.equal(row.status, 'reachable')
    assert.equal(row.external, true)
    assert.equal(row.root, undefined)
    assert.equal(rows.find((r) => r.name === RD).status, 'running')
  } finally {
    server.close()
  }
  services.removeDatabase(EXT, { purge: true })
  assert.ok(!listServices().some((d) => d.name === EXT))
})

test('stop goes SAVE then SHUTDOWN over the protocol and is clean; the checkpoint lands', { timeout: 30000 }, async () => {
  const res = await sup.stop(RD, { timeout: 10000 })
  assert.equal(res.forced, undefined, JSON.stringify(res))
  assert.equal(res.code, 0)
  assert.ok(fs.existsSync(path.join(garnet.dataDir(services.getDatabase(RD)), 'checkpoint.txt')))
  await settle(RD)
  assert.equal(await services.externalStatus({ ...services.getDatabase(RD), external: true }), 'unreachable')
})

test('a Garnet that dies on its port is reported with its reason', { timeout: 30000 }, async () => {
  const { updateInstance } = await import('../src/registry.mjs')
  updateInstance(RD, { autoRestart: false })
  process.env.FAKE_GARNET_FAIL = 'start'
  try {
    const res = await sup.start(RD, { timeout: 15000 })
    assert.equal(res.ready, false, JSON.stringify(res))
    assert.equal(res.failed, true)
    assert.match(res.reason, /Unhandled exception|Address already in use|exited/)
  } finally {
    delete process.env.FAKE_GARNET_FAIL
  }
})
