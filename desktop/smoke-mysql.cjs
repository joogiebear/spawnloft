'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')

/** Native Oracle binaries, created through the packaged GUI from an empty engine store. */
module.exports = async function smokeMySQL({ page, api, cli, core, executable, env, data, name, output, record }) {
  const dbName = `${name}-db`
  await page.locator('#tabSettings').click()
  const create = page.locator('#settingsBody').getByRole('button', { name: 'Create a database', exact: true })
  await create.scrollIntoViewIfNeeded()
  assert.equal(await create.isEnabled(), true)
  const config = path.join(data, 'instances', name, 'plugins', 'LuckPerms', 'config.yml')
  const configBefore = fs.readFileSync(config, 'utf8')
  assert.deepEqual(fs.readdirSync(path.join(data, 'engines')), [], 'GUI must exercise the first download')
  await create.click()
  // Even initialization must yield to the panel so progress, console, and other servers work.
  const deadline = Date.now() + 600000
  let created = false, polls = 0
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/api/databases', page.url()), { signal: AbortSignal.timeout(4000) })
    const rows = await response.json()
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

  const script = path.join(output, 'mysql-statements.mjs')
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [core, name, server, phase, output] = process.argv.slice(2);
const mysql = await import(pathToFileURL(path.join(core, 'src/mysql.mjs')));
const maria = await import(pathToFileURL(path.join(core, 'src/mariadb.mjs')));
const registry = await import(pathToFileURL(path.join(core, 'src/registry.mjs')));
const db = registry.getInstance(name);
const record = db.attachments[server];
const user = { ...db, root: { user: record.user, password: record.password } };
assert.equal(maria.findTools(), mysql.engineDir(db.version), 'external tools discovery finds the managed engine');
const table = String.fromCharCode(96) + record.database + String.fromCharCode(96) + '.spawnloft_smoke';
if (phase === 'write') {
  mysql.sql(user, 'CREATE TABLE ' + table + ' (id INT PRIMARY KEY, value VARCHAR(32)); INSERT INTO ' + table + " VALUES (1, 'persisted');");
  assert.throws(() => mysql.sql(user, 'SELECT User FROM mysql.user'), /denied/i);
  assert.throws(() => mysql.sql({ ...user, root: { ...user.root, password: 'wrong-password' } }, 'SELECT 1'), /denied/i);
} else {
  assert.equal(mysql.sql(user, 'SELECT value FROM ' + table).trim(), 'persisted');
  const dump = path.join(output, 'mysql-roundtrip.sql');
  await mysql.dump(db, record.database, dump);
  mysql.sql(user, 'DELETE FROM ' + table);
  await mysql.importSql(db, dump);
  assert.equal(mysql.sql(user, 'SELECT value FROM ' + table).trim(), 'persisted');
}
console.log('PASS: MySQL ' + phase + ' and scoped credentials');
`)
  const statements = phase => new Promise((resolve, reject) => {
    const child = spawn(executable, [script, core, dbName, name, phase, output], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout.on('data', c => { text += c })
    child.stderr.on('data', c => { text += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); if (code === 0) { record(text.trim()); resolve() } else reject(Error(text)) })
  })
  await statements('write')
  await api(`instances/${dbName}/stop`, {})
  assert.equal((await api('databases')).find(row => row.name === dbName).status, 'stopped')
  await api(`instances/${dbName}/start`, {})
  await statements('read')
  await cli(['stop', dbName], 45000)
  assert.equal(fs.readFileSync(config, 'utf8'), configBefore)
  record('PASS: real MySQL scoped SQL writes persist across GUI stop/start; dump and restore round-trip; bundled CLI stops the server gracefully')
}
