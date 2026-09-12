import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mysql-'))
process.env.MCCTL_DATA_ROOT = scratch
const mysql = await import('../src/mysql.mjs')
const maria = await import('../src/mariadb.mjs')
const services = await import('../src/services.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('managed engines are explicit per platform and Mac archives are pinned by architecture', () => {
  assert.equal(services.canManage('mysql', 'darwin'), true)
  assert.equal(services.canManage('mariadb', 'darwin'), false)
  assert.equal(services.canManage('garnet', 'darwin'), true)
  assert.equal(services.canManage('mysql', 'win32'), true)
  assert.equal(services.canManage('mariadb', 'win32'), false)
  assert.equal(services.canManage('garnet', 'win32'), true)
  for (const arch of ['arm64', 'x64']) {
    assert.doesNotThrow(() => mysql.assertSupported({ platform: 'darwin', arch, release: '24.0.0' }))
    const archive = mysql.archiveFor(mysql.VERSION, arch, 'darwin')
    assert.match(archive.sha256, /^[a-f0-9]{64}$/)
    assert.match(archive.url, /^https:\/\/cdn\.mysql\.com\/Downloads\/MySQL-8\.4\//)
  }
  assert.throws(() => mysql.archiveFor('../../bad', 'x64'), /No verified/)
  assert.throws(() => mysql.archiveFor(mysql.VERSION, '__proto__'), /No verified/)
  assert.throws(() => mysql.assertSupported({ platform: 'darwin', arch: 'arm64', release: '23.0.0' }), /macOS 15/)
  assert.doesNotThrow(() => mysql.assertSupported({ platform: 'win32', arch: 'x64' }))
  assert.match(mysql.archiveFor(mysql.VERSION, 'x64', 'win32').url, /winx64\.zip$/)
  assert.equal(services.defaultEngine(), 'mysql')
  assert.deepEqual(services.NEW_ENGINES, ['mysql', 'garnet'])
  assert.throws(() => services.assertNewEngine('mariadb'), /not offered/)
  assert.throws(() => services.assertNewEngine('mongodb'), /Choose MySQL/)
})

test('configuration isolates TCP and sockets, disables X Protocol, and quotes paths with spaces', () => {
  const inst = { version: mysql.VERSION, dir: path.join(scratch, 'App data', 'db'), port: 3345 }
  const text = mysql.iniFor(inst, '/tmp/private/mysql.sock', 'darwin')
  assert.match(text, /^datadir=".*App data.*data"$/m)
  assert.match(text, /^socket="\/tmp\/private\/mysql.sock"$/m)
  assert.match(text, /^bind-address=127\.0\.0\.1$/m)
  assert.match(text, /^mysqlx=0$/m)
  assert.match(text, /^port=3345$/m)
  assert.ok(!text.includes('password'))
})

test('interrupted or corrupt installs leave no usable engine, staging folder, or lock', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  t.mock.method(os, 'release', () => '24.0.0')
  const engines = path.join(scratch, 'engines')
  const engine = mysql.engineDir(mysql.VERSION)
  try {
    t.mock.method(globalThis, 'fetch', async () => new Response('corrupted-download'))
    await assert.rejects(mysql.fetchEngine(mysql.VERSION), /checksum mismatch/)
    assert.equal(mysql.hasEngine(mysql.VERSION), false)
    assert.deepEqual(fs.readdirSync(engines), [])
    fs.mkdirSync(engine)
    fs.writeFileSync(path.join(engine, 'existing-data'), 'keep this')
    await assert.rejects(mysql.fetchEngine(mysql.VERSION), /incomplete MySQL engine/)
    assert.equal(fs.readFileSync(path.join(engine, 'existing-data'), 'utf8'), 'keep this')
    assert.equal(fs.existsSync(`${engine}.install-lock`), false)
    fs.writeFileSync(`${engine}.install-lock`, 'other installer')
    await assert.rejects(mysql.fetchEngine(mysql.VERSION), /already in progress/)
    assert.equal(fs.readFileSync(`${engine}.install-lock`, 'utf8'), 'other installer')
  } finally { Object.defineProperty(process, 'platform', platform) }
})

test('Mac external tool discovery finds mysql on PATH without an explicit tools setting', t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const oldPath = process.env.PATH
  const bin = path.join(scratch, 'client tools', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'mysql'), '')
  const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => String(file).startsWith(bin + path.sep) && exists(file))
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  process.env.PATH = bin
  try { assert.equal(maria.findTools(), bin) }
  finally { Object.defineProperty(process, 'platform', platform); process.env.PATH = oldPath }
})
