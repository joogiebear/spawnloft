'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

module.exports = async function smokeRedis({ page, api, cli, core, executable, env, data, name, output, record }) {
  const dbName = `${name}-cache`
  const engines = await api('databases/engines')
  assert.deepEqual(engines.map(e => e.id).sort(), ['garnet', 'mysql'])
  assert.ok(engines.every(e => e.managed))
  await page.locator('#bNew').click()
  await page.locator('#vAdd [data-tab="db"]').click()
  await page.waitForFunction(() => document.querySelectorAll('#dEngine option').length === 2)
  assert.deepEqual(await page.locator('#dEngine option').evaluateAll(opts => opts.map(o => o.value).sort()), ['garnet', 'mysql'])
  await page.locator('#dEngine').selectOption('garnet')
  assert.equal(await page.locator('#dEngine option:checked').isDisabled(), false)
  await page.locator('#bAddClose').click()
  const config = path.join(data, 'instances', name, 'plugins', 'LuckPerms', 'config.yml')
  const before = fs.readFileSync(config, 'utf8')
  const versions = await api('databases/versions?engine=garnet')
  assert.ok(versions.length, 'Redis has a native version available')
  await api('databases', { name: dbName, engine: 'garnet', version: versions[0].version }, 600000)
  const script = path.join(output, 'redis-statements.mjs')
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [core, name, phase] = process.argv.slice(2);
const registry = await import(pathToFileURL(path.join(core, 'src/registry.mjs')));
const { respSend } = await import(pathToFileURL(path.join(core, 'src/resp.mjs')));
const db = registry.getInstance(name);
const send = commands => respSend('127.0.0.1', db.port, commands, { password: db.root.password });
assert.equal(await send([['PING']]), 'PONG');
await assert.rejects(respSend('127.0.0.1', db.port, [['PING']], { password: 'incorrect' }), /WRONGPASS|invalid|auth/i);
await assert.rejects(respSend('127.0.0.1', db.port, [['GET', 'spawnloft-smoke']]), /NOAUTH|auth/i);
if (phase === 'write') assert.equal(await send([['SET', 'spawnloft-smoke', 'persisted']]), 'OK');
else assert.equal(await send([['GET', 'spawnloft-smoke']]), 'persisted');
console.log('PASS: Redis ' + phase + ', password enforced');
`)
  const statements = phase => new Promise((resolve, reject) => {
    const child = spawn(executable, [script, core, dbName, phase], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout.on('data', c => { text += c }); child.stderr.on('data', c => { text += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.once('error', err => { clearTimeout(timer); reject(err) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(text)) })
  })
  try {
    await cli(['start', dbName, '--timeout', '60'], 75000)
    await cli(['db', 'attach', dbName, name])
    await statements('write')
    await cli(['stop', dbName], 60000)
    await api(`instances/${dbName}/start`, {})
    await statements('read')
    await cli(['restart', dbName, '--timeout', '60'], 90000)
    await statements('read')
    assert.equal(fs.readFileSync(config, 'utf8'), before)
    record('PASS: native Redis (Garnet) downloaded and verified; authenticated writes survive stop/start and restart; plugin configs unchanged')
  } finally { await cli(['stop', dbName], 60000) }
}
