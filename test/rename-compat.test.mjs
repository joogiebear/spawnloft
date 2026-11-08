import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The rename from mcctl to spawnloft: new names win, old names keep working.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-rename-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
const { envVar } = await import('../src/env.mjs')

test('SPAWNLOFT_ names are read first and MCCTL_ names still work', () => {
  assert.equal(envVar('DATA_ROOT', { MCCTL_DATA_ROOT: 'old' }), 'old')
  assert.equal(envVar('DATA_ROOT', { SPAWNLOFT_DATA_ROOT: 'new' }), 'new')
  assert.equal(envVar('DATA_ROOT', { SPAWNLOFT_DATA_ROOT: 'new', MCCTL_DATA_ROOT: 'old' }), 'new')
  assert.equal(envVar('DATA_ROOT', { SPAWNLOFT_DATA_ROOT: '', MCCTL_DATA_ROOT: 'old' }), 'old')
  assert.equal(envVar('DATA_ROOT', {}), undefined)
})

function fresh(name) {
  const dir = path.join(scratch, name)
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = path.join(dir, 'config')
  process.env.LOCALAPPDATA = process.env.XDG_DATA_HOME = path.join(dir, 'local')
  return dir
}
const put = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}') }

test('a new install uses the spawnloft folders; an existing one keeps mcctl', async () => {
  const s = await import('../src/settings.mjs')
  let dir = fresh('new')
  assert.equal(s.settingsFile(), path.join(dir, 'config', 'spawnloft', 'settings.json'))
  assert.equal(s.defaultDataRoot(), path.join(dir, 'local', 'spawnloft'))

  dir = fresh('upgraded')
  put(path.join(dir, 'config', 'mcctl', 'settings.json'))
  fs.mkdirSync(path.join(dir, 'local', 'mcctl'), { recursive: true })
  assert.equal(s.settingsFile(), path.join(dir, 'config', 'mcctl', 'settings.json'))
  assert.equal(s.defaultDataRoot(), path.join(dir, 'local', 'mcctl'))
  assert.equal(s.shadowedSettingsFile(), null)
})

test('when both settings files exist the spawnloft one wins and the other is reported', async () => {
  const s = await import('../src/settings.mjs')
  const dir = fresh('both')
  put(path.join(dir, 'config', 'mcctl', 'settings.json'))
  put(path.join(dir, 'config', 'spawnloft', 'settings.json'))
  fs.mkdirSync(path.join(dir, 'local', 'mcctl'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'local', 'spawnloft'), { recursive: true })
  assert.equal(s.settingsFile(), path.join(dir, 'config', 'spawnloft', 'settings.json'))
  assert.equal(s.shadowedSettingsFile(), path.join(dir, 'config', 'mcctl', 'settings.json'))
  assert.equal(s.defaultDataRoot(), path.join(dir, 'local', 'spawnloft'))
})

test('uninstall --data removes the ignored settings file as well', async () => {
  const { purgeTargets } = await import('../src/uninstall.mjs')
  const layout = { jarsDir: 'j', backupsDir: 'b', templatesDir: 't', runDir: 'r', enginesDir: 'e', dataRoot: 'd', registryFile: 'd/i.json', instancesDir: 'd/instances', servicesDir: 'd/services' }
  const t = purgeTargets({ instances: [], layout, settings: '/c/spawnloft/settings.json', otherSettings: '/c/mcctl/settings.json' })
  assert.ok(t.remove.includes('/c/spawnloft/settings.json') && t.remove.includes('/c/mcctl/settings.json'))
  assert.ok(t.removeIfEmpty.includes('/c/mcctl'))
})
