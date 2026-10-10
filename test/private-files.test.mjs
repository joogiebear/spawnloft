import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Files that hold a secret are owner-only. Windows has no POSIX modes, so there is nothing to
// assert there; the writes still have to work, which the rest of the suite covers.
const posix = process.platform !== 'win32'
const skip = posix ? false : 'POSIX file modes do not exist on Windows'

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-private-'))
// Where the registry and settings live is resolved when the modules load, so point both at a
// scratch folder before importing them.
process.env.MCCTL_DATA_ROOT = path.join(scratchRoot, 'data')
process.env.APPDATA = path.join(scratchRoot, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratchRoot, 'config')
const { writeJson, PRIVATE_FILE_MODE } = await import('../src/util.mjs')
const { saveRegistry, loadRegistry } = await import('../src/registry.mjs')
const { REGISTRY_FILE } = await import('../src/paths.mjs')
const settings = await import('../src/settings.mjs')
const { writeProps } = await import('../src/props.mjs')
const { shareConsole } = await import('../src/mclogs.mjs')
after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }))

const scratch = () => fs.mkdtempSync(path.join(scratchRoot, 'case-'))
const modeOf = (file) => fs.statSync(file).mode & 0o777

test('the private mode is owner read/write only', () => {
  assert.equal(PRIVATE_FILE_MODE, 0o600)
})

test('writeJson with no mode behaves as before', { skip }, () => {
  const file = path.join(scratch(), 'plain.json')
  writeJson(file, { a: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file left behind')
  // Created with the process default, which is whatever the umask leaves - not forced private.
  assert.equal(modeOf(file) & 0o600, 0o600)
})

test('writeJson with a mode creates the file with it', { skip }, () => {
  const file = path.join(scratch(), 'secret.json')
  writeJson(file, { password: 'x' }, { mode: PRIVATE_FILE_MODE })
  assert.equal(modeOf(file), 0o600)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('writeJson with a mode tightens a file that was written world-readable', { skip }, () => {
  const file = path.join(scratch(), 'old.json')
  fs.writeFileSync(file, '{"old":true}\n', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  assert.equal(modeOf(file), 0o644)
  writeJson(file, { new: true }, { mode: PRIVATE_FILE_MODE })
  assert.equal(modeOf(file), 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { new: true })
})

test('a wider leftover temp file does not leak its mode into the result', { skip }, () => {
  const file = path.join(scratch(), 'leftover.json')
  fs.writeFileSync(`${file}.tmp`, 'stale', { mode: 0o666 })
  fs.chmodSync(`${file}.tmp`, 0o666)
  writeJson(file, { ok: true }, { mode: PRIVATE_FILE_MODE })
  assert.equal(modeOf(file), 0o600)
})

test('the registry is saved owner-only, and an older world-readable one is tightened', { skip }, () => {
  saveRegistry({ version: 1, instances: { a: { rcon: { password: 'hunter2' } } } })
  assert.equal(modeOf(REGISTRY_FILE), 0o600)

  fs.chmodSync(REGISTRY_FILE, 0o644)
  const data = loadRegistry()
  saveRegistry(data)
  assert.equal(modeOf(REGISTRY_FILE), 0o600)
  assert.equal(loadRegistry().instances.a.rcon.password, 'hunter2', 'contents survive the rewrite')
})

test('settings.json is saved owner-only, and an older world-readable one is tightened', { skip }, () => {
  const file = settings.settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  settings.save({ dataRoot: path.join(scratchRoot, 'data') })
  assert.equal(modeOf(file), 0o600)
  assert.equal(settings.load().dataRoot, path.join(scratchRoot, 'data'))
})

test('server.properties is written owner-only, and an older world-readable one is tightened', { skip }, () => {
  const file = path.join(scratch(), 'server.properties')
  fs.writeFileSync(file, 'server-port=25565\nrcon.password=\n', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  writeProps(file, { 'rcon.password': 'hunter2', 'enable-rcon': 'true' })
  assert.equal(modeOf(file), 0o600)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /rcon\.password=hunter2/)
  assert.match(text, /server-port=25565/)
  assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.tmp')), false)
})

test('the mclogs deletion-token file is owner-only', { skip }, async () => {
  const dir = scratch()
  const sourceFile = path.join(dir, 'console.log')
  fs.writeFileSync(sourceFile, '[12:00:00] [Server thread/INFO]: Done\n')
  const tokenFile = path.join(dir, 'mclogs.json')
  // An older token file from before the fix, readable by everyone.
  fs.writeFileSync(tokenFile, '[]', { mode: 0o644 })
  fs.chmodSync(tokenFile, 0o644)
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, id: 'abc', url: 'https://mclo.gs/abc', token: 'deadbeef' }),
    text: async () => '',
  })
  await shareConsole({ name: 'private-files-test-not-registered', dir }, { sourceFile, tokenFile, fetchImpl })
  assert.equal(modeOf(tokenFile), 0o600)
  assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).length, 1)
})
