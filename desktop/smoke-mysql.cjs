'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { authorization } = require('./smoke-panel-auth.cjs')

// One of the managed engine's own tools (bin/mysql, bin/mysqldump), connected over TCP as `who`
// the way the core connects (spawnloft-lib mariadb.rs root_args, the password in MYSQL_PWD):
// its stdout, or a rejection with what it said. `input` is a file for its stdin, `out` one for
// its stdout.
function tool(engine, toolName, db, who, args, { input = null, out = null } = {}) {
  const exe = path.join(engine, 'bin', toolName + (process.platform === 'win32' ? '.exe' : ''))
  const all = ['--no-defaults', '--protocol=TCP', `--host=${db.host || '127.0.0.1'}`, `--port=${db.port}`, `--user=${who.user || 'root'}`, ...args]
  return new Promise((resolve, reject) => {
    const stdout = out ? fs.openSync(out, 'w') : 'pipe'
    const stdin = input ? fs.openSync(input, 'r') : 'ignore'
    const child = spawn(exe, all, { env: { ...process.env, MYSQL_PWD: who.password ?? '' }, stdio: [stdin, stdout, 'pipe'], windowsHide: true })
    let text = ''
    let said = ''
    child.stdout?.on('data', c => { text += c })
    child.stderr.on('data', c => { said += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (typeof stdout === 'number') fs.closeSync(stdout)
      if (typeof stdin === 'number') fs.closeSync(stdin)
      code === 0 ? resolve(text) : reject(Error(`${toolName} exit ${code}: ${said || text}`))
    })
  })
}

// native Oracle binaries, created through the packaged GUI from an empty engine store
module.exports = async function smokeMySQL({ page, api, cli, env, data, name, output, record, openDatabaseSettings }) {
  const dbName = `${name}-db`
  await openDatabaseSettings()
  const create = page.locator('#settingsBody').getByRole('button', { name: 'Create a database', exact: true })
  await create.scrollIntoViewIfNeeded()
  assert.equal(await create.isEnabled(), true)
  const config = path.join(data, 'instances', name, 'plugins', 'LuckPerms', 'config.yml')
  const configBefore = fs.readFileSync(config, 'utf8')
  assert.deepEqual(fs.readdirSync(path.join(data, 'engines')), [], 'GUI must exercise the first download')
  await create.click()
  // even initialization must yield to the panel so progress, console and other servers keep working
  const deadline = Date.now() + 600000
  let created = false, polls = 0, answeredAt = Date.now()
  while (Date.now() < deadline) {
    // One slow answer while MySQL initializes is a busy Windows runner, not a stuck panel: what
    // fails the test is the panel going quiet, so it is judged over a window, not a single poll.
    let rows
    try {
      const target = new URL('/api/databases', page.url())
      const response = await fetch(target, {
        signal: AbortSignal.timeout(4000),
        headers: { Authorization: authorization(path.join(env.APPDATA, 'spawnloft'), target.port) },
      })
      rows = await response.json()
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err
      if (Date.now() - answeredAt > 30000) throw Error('Panel stopped answering for 30 seconds during database setup')
      continue
    }
    answeredAt = Date.now()
    polls++
    if (rows.some(row => row.name === dbName && row.status === 'running' && row.attachments[name])) { created = true; break }
    const hint = await create.locator('..').textContent().catch(() => '')
    if (await create.isEnabled().catch(() => false)) throw Error(`GUI database setup failed: ${hint}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(created, 'GUI database creation must finish within ten minutes')
  assert.ok(polls > 1, 'Panel must answer requests while download and setup run')
  await page.locator('#dlg .creds').waitFor({ state: 'visible' })
  await page.locator('#dlgCancel').click()
  const show = page.locator('#settingsBody').getByRole('button', { name: 'Show credentials', exact: true }).last()
  await show.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, '09-managed-mysql-settings.png') })
  assert.equal(fs.readFileSync(config, 'utf8'), configBefore)
  assert.equal(fs.existsSync(path.join(data, 'services', dbName, 'bootstrap.sql')), false)
  record('PASS: managed MySQL downloaded, verified, initialized and attached through the native GUI; panel stayed responsive and plugin configs stayed manual')

  // the registry record the panel wrote, read as any program reads instances.json, and the
  // engine store's one MySQL, which holds the tools the core runs for it
  const engines = path.join(data, 'engines')
  const statements = async phase => {
    const db = JSON.parse(fs.readFileSync(path.join(data, 'instances.json'), 'utf8')).instances[dbName]
    const engine = path.join(engines, `mysql-${db.version}-${process.platform}-${process.arch}`)
    assert.deepEqual(fs.readdirSync(engines).filter(e => e.startsWith('mysql-') || e.startsWith('mariadb-')), [path.basename(engine)], 'the engine store holds the managed MySQL alone')
    const attached = db.attachments[name]
    const user = { user: attached.user, password: attached.password }
    const root = { user: db.root.user, password: db.root.password }
    const sql = (who, statement) => tool(engine, 'mysql', db, who, ['--batch', '--skip-column-names', '--execute', statement])
    const table = '`' + attached.database + '`.spawnloft_smoke'
    if (phase === 'write') {
      await sql(user, 'CREATE TABLE ' + table + " (id INT PRIMARY KEY, value VARCHAR(32)); INSERT INTO " + table + " VALUES (1, 'persisted');")
      await assert.rejects(sql(user, 'SELECT User FROM mysql.user'), /denied/i)
      await assert.rejects(sql({ ...user, password: 'wrong-password' }, 'SELECT 1'), /denied/i)
    } else {
      assert.equal((await sql(user, 'SELECT value FROM ' + table)).trim(), 'persisted')
      const dump = path.join(output, 'mysql-roundtrip.sql')
      await tool(engine, 'mysqldump', db, root, ['--single-transaction', '--routines', '--triggers', '--events', '--databases', attached.database], { out: dump })
      await sql(user, 'DELETE FROM ' + table)
      await tool(engine, 'mysql', db, root, [], { input: dump })
      assert.equal((await sql(user, 'SELECT value FROM ' + table)).trim(), 'persisted')
    }
    record('PASS: MySQL ' + phase + ' and scoped credentials')
  }
  await statements('write')
  await api(`instances/${dbName}/stop`, {})
  assert.equal((await api('databases')).find(row => row.name === dbName).status, 'stopped')
  await api(`instances/${dbName}/start`, {})
  await statements('read')
  await cli(['stop', dbName], 45000)
  const started = await cli(['start', dbName, '--timeout', '40'], 45000)
  assert.match(started, /Ready -/)
  assert.match(started, /database pid \d+\s+port \d+/)
  assert.doesNotMatch(started, /java pid|rcon|TypeError/i)
  assert.equal((await api('databases')).find(row => row.name === dbName).status, 'running')
  const restarted = await cli(['restart', dbName, '--timeout', '40'], 90000)
  assert.match(restarted, /Ready -/)
  assert.doesNotMatch(restarted, /java pid|rcon|TypeError/i)
  await statements('read')
  await cli(['stop', dbName], 45000)
  assert.equal((await api('databases')).find(row => row.name === dbName).status, 'stopped')
  assert.equal(fs.readFileSync(config, 'utf8'), configBefore)
  record('PASS: real MySQL SQL writes and backup/restore persist across GUI and CLI start/restart; bundled CLI exits successfully, reports a database pid, and stops gracefully; plugin configs unchanged')
}
