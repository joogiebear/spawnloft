/**
 * A database, end to end, against the real daemon and a fake MariaDB.
 *
 * <p>The engine store gets test/fixtures/fake-mariadb as version 0.0.0-fake, so nothing is
 * downloaded: the four scripts stand in for mariadb-install-db, mariadbd, mariadb-admin and the
 * client, and everything else - the registry entry, my.ini, the daemon, the console log, the
 * control pipe, ready detection, the TCP shutdown, attach and detach - is the real thing.
 *
 * <p>Isolated by MCCTL_DATA_ROOT the way lifecycle.test.mjs is.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-databases-'))
process.env.MCCTL_DATA_ROOT = scratch

const { putInstance, updateInstance, listInstances, listServices, listAll, isDatabase, usedPorts } = await import('../src/registry.mjs')
const services = await import('../src/services.mjs')
const mariadb = await import('../src/mariadb.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState } = await import('../src/control.mjs')
const { ENGINES_DIR, INSTANCES_DIR } = await import('../src/paths.mjs')
const { UserError, findFreePort, isPortFree } = await import('../src/util.mjs')
const ui = await import('../src/ui.mjs')
const backup = await import('../src/backup.mjs')

const VERSION = '0.0.0-fake'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mariadb')
fs.mkdirSync(path.join(ENGINES_DIR, `mariadb-${VERSION}`), { recursive: true })
fs.cpSync(FIXTURE, path.join(ENGINES_DIR, `mariadb-${VERSION}`), { recursive: true })

const DB = `dbt-${process.pid}`
const SRV = `srv-${process.pid}`

after(async () => {
  try { await sup.kill(DB) } catch { /* down */ }
  try { await sup.kill(`${SRV}-db`) } catch { /* down */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('the fake engine is found through the same lookup the real one uses', () => {
  assert.ok(mariadb.hasEngine(VERSION))
  assert.equal(mariadb.binary(mariadb.engineDir(VERSION), 'server').script, true)
  assert.equal(mariadb.binary(mariadb.engineDir(VERSION), 'dump').script, true)
  assert.equal(mariadb.binary(mariadb.engineDir(VERSION), 'init').script, true)
})

test('creating a database lays out its folder, picks a free port, and registers it apart from the servers', async () => {
  const port = await findFreePort(43000 + Math.floor(Math.random() * 10000))
  const db = await services.createDatabase(DB, { version: VERSION, port, label: 'Test DB' })
  assert.equal(db.kind, 'database')
  assert.equal(db.engine, 'mariadb')
  assert.equal(db.port, port)
  assert.equal(db.label, 'Test DB')
  assert.ok(db.root.password.length >= 20)

  const ini = fs.readFileSync(mariadb.iniFile(db), 'utf8')
  assert.match(ini, new RegExp(`^port=${port}$`, 'm'))
  assert.match(ini, /^bind-address=127\.0\.0\.1$/m)
  assert.equal(fs.readFileSync(path.join(mariadb.dataDir(db), 'root.txt'), 'utf8'), db.root.password)

  assert.ok(!listInstances().some((i) => i.name === DB), 'a database must not be listed as a server')
  assert.ok(listServices().some((i) => i.name === DB))
  assert.ok(listAll().some((i) => i.name === DB))
  assert.ok(usedPorts().has(port), 'its port must count as taken')
})

test('a second create with the same name, or on the server side, is refused', async () => {
  await assert.rejects(services.createDatabase(DB, { version: VERSION }), UserError)
  fs.mkdirSync(path.join(INSTANCES_DIR, SRV), { recursive: true })
  putInstance(SRV, { dir: path.join(INSTANCES_DIR, SRV), jar: 'paper.jar', memory: '4G', port: 25565 })
  assert.throws(() => services.getDatabase(SRV), UserError)
  assert.throws(() => services.assertServer(DB), UserError)
  assert.ok(isDatabase(services.getDatabase(DB)))
})

test('attach before the database runs is refused with the way out', () => {
  assert.throws(() => services.attach(DB, SRV), /start it first/)
})

test('start waits for the engine to report ready, over stderr, without a jar, EULA or Java', { timeout: 30000 }, async () => {
  const res = await sup.start(DB, { timeout: 15000 })
  assert.equal(res.ready, true, JSON.stringify(res))
  assert.match(res.readyLine, /ready for connections/)
  const { status, state } = readState(DB)
  assert.equal(status, 'running')
  assert.equal(state.kind, 'database')
  assert.ok(state.javaPid > 0)
  await assert.rejects(sup.sendConsole(DB, 'hello'), /no console input/)
})

test('attach creates the database and user for the server, and the credentials come back', () => {
  const creds = services.attach(DB, SRV)
  assert.equal(creds.database, SRV)
  assert.equal(creds.user, SRV)
  assert.equal(creds.host, '127.0.0.1')
  assert.ok(creds.password.length >= 20)
  assert.match(creds.jdbc, new RegExp(`^jdbc:mysql://127\\.0\\.0\\.1:\\d+/${SRV}$`))

  const log = fs.readFileSync(path.join(mariadb.dataDir(services.getDatabase(DB)), 'sql.log'), 'utf8')
  assert.ok(log.includes(`CREATE DATABASE IF NOT EXISTS \`${SRV}\``), log)
  assert.ok(log.includes(`GRANT ALL PRIVILEGES ON \`${SRV}\`.* TO '${SRV}'@'localhost', '${SRV}'@'127.0.0.1'`), log)
  assert.ok(log.includes(`IDENTIFIED BY '${creds.password}'`))

  // Again: the same credentials, not new ones.
  assert.deepEqual(services.attach(DB, SRV), creds)
  assert.deepEqual(services.credentials(DB, SRV), creds)

  const fromServer = services.serverAttachments(SRV)
  assert.equal(fromServer.length, 1)
  assert.equal(fromServer[0].service, DB)
  assert.equal(fromServer[0].password, undefined, 'the server-side list must not carry the password')
})

test('apply writes the credentials into a plugin config and records it on the attachment', () => {
  const srvDir = path.join(INSTANCES_DIR, SRV)
  fs.mkdirSync(path.join(srvDir, 'plugins', 'LuckPerms'), { recursive: true })
  fs.writeFileSync(path.join(srvDir, 'plugins', 'LuckPerms', 'config.yml'), 'storage-method: h2\ndata:\n  address: localhost\n  database: minecraft\n  username: root\n  password: \'\'\n')
  const helpers = services.helpersFor(SRV)
  assert.equal(helpers.find((h) => h.id === 'luckperms').configPresent, true)

  const res = services.applyToPlugin(DB, SRV, 'luckperms')
  assert.equal(res.restartNeeded, true)
  assert.deepEqual(res.written, ['storage-method', 'data.address', 'data.database', 'data.username', 'data.password'])
  const creds = services.credentials(DB, SRV)
  const text = fs.readFileSync(path.join(srvDir, 'plugins', 'LuckPerms', 'config.yml'), 'utf8')
  assert.match(text, /^storage-method: 'mariadb'$/m)
  assert.match(text, new RegExp(`^  address: '127\\.0\\.0\\.1:${creds.port}'$`, 'm'))
  assert.match(text, new RegExp(`^  password: '${creds.password}'$`, 'm'))
  assert.ok(services.serverAttachments(SRV)[0].applied.luckperms, 'the attachment must remember the plugin it was written to')
  assert.throws(() => services.applyToPlugin(DB, SRV, 'coreprotect'), /has not written its config yet/)
})

test('the panel lists databases apart from servers and never sends a password', async () => {
  const { server, url } = await ui.serve({ port: 0, open: false })
  try {
    const dbs = await (await fetch(`${url}api/databases`)).json()
    const row = dbs.find((r) => r.name === DB)
    assert.ok(row, 'the database is missing from /api/databases')
    assert.equal(row.status, 'running')
    assert.equal(row.root, undefined)
    assert.equal(row.attachments[SRV].password, undefined)
    assert.equal(row.attachments[SRV].user, SRV)

    const servers = await (await fetch(`${url}api/instances`)).json()
    assert.ok(!servers.some((r) => r.name === DB), 'a database must not appear in /api/instances')

    const mine = await (await fetch(`${url}api/instances/${SRV}/databases`)).json()
    assert.equal(mine[0].service, DB)
    assert.equal(mine[0].password, undefined)
    const helpers = await (await fetch(`${url}api/instances/${SRV}/databases/helpers`)).json()
    assert.equal(helpers.find((h) => h.id === 'luckperms').configPresent, true)

    const creds = await (await fetch(`${url}api/databases/${DB}/credentials?server=${SRV}`)).json()
    assert.equal(creds.password, services.credentials(DB, SRV).password)
  } finally {
    server.close()
  }
})

test('a server can have a database of its own made in one step: game port plus one, started, attached', { timeout: 60000 }, async () => {
  const srv = services.assertServer(SRV)
  const wanted = Number(srv.port) + 1
  const wantedFree = !usedPorts().has(wanted) && await isPortFree(wanted)

  const { server, url } = await ui.serve({ port: 0, open: false })
  let out
  try {
    const res = await fetch(`${url}api/instances/${SRV}/databases/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: VERSION }),
    })
    out = await res.json()
    assert.equal(res.status, 200, JSON.stringify(out))
  } finally {
    server.close()
  }
  const name = `${SRV}-db`
  assert.equal(out.database.name, name)
  assert.equal(out.database.status, 'running')
  assert.equal(out.database.root, undefined, 'the panel answer must not carry the root password')
  if (wantedFree) assert.equal(out.database.port, wanted, 'the port after the game port, when free')
  else assert.ok(out.database.port > wanted)
  assert.equal(out.credentials.database, SRV)
  assert.equal(out.credentials.port, out.database.port)
  assert.ok(services.serverAttachments(SRV).some((a) => a.service === name), 'attached from the same call')
  assert.equal(readState(name).status, 'running')

  // The name stays within the 32 characters a name may have, suffix included, and is made unique.
  assert.equal(services.nameForServer('a'.repeat(32)), 'a'.repeat(29) + '-db')
  assert.equal(services.nameForServer(SRV), `${SRV}-db-2`, 'the first one exists, so the next is numbered')

  // Put it away, so the snapshot tests below see the one database they expect.
  await sup.stop(name, { timeout: 10000 })
  services.detach(name, SRV)
  services.removeDatabase(name, { purge: true })
  assert.ok(!listServices().some((i) => i.name === name))
})

test('a snapshot of an attached server carries a dump of its database, and verify checks for it', { timeout: 30000 }, async () => {
  const srv = { name: SRV, dir: path.join(INSTANCES_DIR, SRV) }
  fs.writeFileSync(path.join(srv.dir, 'server.properties'), 'level-name=world\n')
  fs.mkdirSync(path.join(srv.dir, 'world'), { recursive: true })
  fs.writeFileSync(path.join(srv.dir, 'world', 'level.dat'), 'nbt')

  const res = await backup.createSnapshot(srv, { scope: 'standard', label: 'with-db', running: false })
  assert.equal(res.databases.length, 1, JSON.stringify(res.databasesSkipped))
  const d = res.databases[0]
  assert.equal(d.service, DB)
  assert.equal(d.database, SRV)
  assert.equal(d.file, `databases/${DB}__${SRV}.sql`)
  assert.ok(d.bytes > 0)
  assert.ok(res.members.includes('databases'))
  assert.ok(!fs.existsSync(path.join(srv.dir, 'databases')), 'the server folder must not hold the dump')

  const check = await backup.verifySnapshot(SRV, 'with-db')
  assert.equal(check.ok, true, check.problems.join('; '))
  assert.ok(check.snapshot.databases.length === 1)

  // A dump the manifest promises but the archive lacks is named, like a missing world is.
  const lie = await backup.verifyArchive(check.snapshot.path, ['world'], ['databases/nope__x.sql'])
  assert.equal(lie.ok, false)
  assert.match(lie.problems.join('\n'), /database dump "databases\/nope__x.sql"/)

  // Only the scopes that mean "the data" carry dumps.
  const plugins = await backup.createSnapshot({ ...srv }, { scope: 'worlds', label: 'worlds-only', running: false })
  assert.equal(plugins.databases.length, 0)
  assert.ok(!plugins.members.includes('databases'))
})

test('restore imports the dump into the database it came from, and leaves nothing behind', { timeout: 30000 }, async () => {
  const srv = { name: SRV, dir: path.join(INSTANCES_DIR, SRV) }
  const snap = backup.resolveSnapshot(SRV, 'with-db')
  const log = () => fs.readFileSync(path.join(mariadb.dataDir(services.getDatabase(DB)), 'sql.log'), 'utf8')
  const before = log()
  const res = await backup.restoreSnapshot(srv, snap)
  assert.equal(res.databases.imported.length, 1, JSON.stringify(res.databases))
  assert.deepEqual(res.databases.skipped, [])
  const after = log().slice(before.length)
  assert.match(after, new RegExp(`-- MariaDB dump \\(fake\\) of ${SRV}`))
  assert.match(after, new RegExp(`USE \`${SRV}\``))
  assert.ok(!fs.existsSync(path.join(srv.dir, 'databases')), 'the extracted dump folder must be cleaned up')
  assert.ok(fs.existsSync(path.join(srv.dir, 'world', 'level.dat')))
})

test('stop goes through the admin tool over TCP and is clean, not forced', { timeout: 30000 }, async () => {
  const res = await sup.stop(DB, { timeout: 10000 })
  assert.equal(res.forced, undefined, JSON.stringify(res))
  assert.equal(res.code, 0)
  assert.equal(readState(DB).status, 'stopped')
})

test('with the database stopped, a snapshot still succeeds and says what it lacks; restore leaves the dump in place', { timeout: 30000 }, async () => {
  const srv = { name: SRV, dir: path.join(INSTANCES_DIR, SRV) }
  const res = await backup.createSnapshot(srv, { scope: 'standard', label: 'db-down', running: false })
  assert.equal(res.databases.length, 0)
  assert.equal(res.databasesSkipped.length, 1)
  assert.match(res.manifest.warnings.join('\n'), new RegExp(`database ${SRV} on ${DB} not included: the database is not running`))

  const snap = backup.resolveSnapshot(SRV, 'with-db')
  const out = await backup.restoreSnapshot(srv, snap)
  assert.equal(out.databases.imported.length, 0)
  assert.equal(out.databases.skipped.length, 1)
  assert.match(out.databases.skipped[0].reason, /not running/)
  const left = path.join(srv.dir, `databases/${DB}__${SRV}.sql`)
  assert.ok(fs.existsSync(left), 'a dump that could not be imported must stay on disk')
  fs.rmSync(path.join(srv.dir, 'databases'), { recursive: true, force: true })
})

test('detach while stopped keeps the record consistent, and dropping needs the database up', () => {
  assert.throws(() => services.detach(DB, SRV, { drop: true }), /not running/)
  const res = services.detach(DB, SRV)
  assert.equal(res.dropped, false)
  assert.deepEqual(services.serverAttachments(SRV), [])
  assert.throws(() => services.credentials(DB, SRV), /not attached/)
})

test('a database that dies during startup is reported as failed, with the engine\'s reason', { timeout: 30000 }, async () => {
  // Auto-restart is on for a database by default; off here, or the daemon would spend the next
  // half minute retrying a start that is scripted to fail.
  updateInstance(DB, { autoRestart: false })
  process.env.FAKE_MARIADB_FAIL = 'start'
  try {
    const res = await sup.start(DB, { timeout: 15000 })
    assert.equal(res.ready, false)
    assert.equal(res.failed, true)
    assert.match(res.reason, /Can't start server|exited/)
  } finally {
    delete process.env.FAKE_MARIADB_FAIL
    updateInstance(DB, { autoRestart: true })
  }
})

test('remove refuses a running database, then deletes a stopped one with its folder', { timeout: 30000 }, async () => {
  // The daemon from the failed start above lingers a few seconds to flush; wait it out.
  const deadline = Date.now() + 10000
  while (readState(DB).status !== 'stopped' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await sup.start(DB, { timeout: 15000 })
  assert.throws(() => services.removeDatabase(DB), /stop it/)
  await sup.stop(DB, { timeout: 10000 })
  const dir = services.getDatabase(DB).dir
  services.removeDatabase(DB, { purge: true })
  assert.ok(!fs.existsSync(dir))
  assert.ok(!listServices().some((i) => i.name === DB))
})
