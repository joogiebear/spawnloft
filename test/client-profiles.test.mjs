import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { createProfile, listProfiles, getProfile, updateProfile, removeProfile, loadProfiles, saveProfiles } = await import('../src/client.mjs')
const { profileDir, PROFILES_FILE } = await import('../src/client-paths.mjs')

test('loadProfiles on a fresh root gives the empty registry', () => {
  const reg = loadProfiles()
  assert.deepEqual(reg, { version: 1, profiles: {} })
})

test('createProfile stores the profile and writes options.txt with lang:en_us', () => {
  const p = createProfile('alpha', { mc: '1.21.4' })
  assert.equal(p.name, 'alpha')
  assert.equal(p.mc, '1.21.4')
  assert.equal(p.loader, 'vanilla')
  assert.equal(p.loaderVersion, null)
  assert.equal(p.java, null)
  assert.equal(p.memory, '2G')
  assert.equal(p.harness, false)
  assert.equal(p.server, null)
  assert.equal(p.account, null)
  assert.match(p.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  const optionsFile = path.join(profileDir('alpha'), 'options.txt')
  assert.equal(fs.readFileSync(optionsFile, 'utf8'), 'lang:en_us\n')
})

test('listProfiles returns sorted entries with name', () => {
  createProfile('beta', { mc: '1.21.4' })
  const list = listProfiles()
  assert.ok(list.length >= 2)
  assert.equal(list[0].name, 'alpha')
  assert.equal(list[1].name, 'beta')
})

test('getProfile returns the stored profile', () => {
  const p = getProfile('alpha')
  assert.equal(p.name, 'alpha')
  assert.equal(p.mc, '1.21.4')
})

test('updateProfile patches and validates the merged result', () => {
  const p = updateProfile('alpha', { memory: '4G', loader: 'fabric', loaderVersion: '0.16.9' })
  assert.equal(p.memory, '4G')
  assert.equal(p.loader, 'fabric')
  assert.equal(p.loaderVersion, '0.16.9')
})

test('removeProfile without purge leaves the folder', () => {
  createProfile('gamma', { mc: '1.21.4' })
  removeProfile('gamma')
  assert.ok(fs.existsSync(profileDir('gamma')))
  assert.throws(() => getProfile('gamma'), /no profile named "gamma"/)
})

test('removeProfile with purge removes the folder', () => {
  createProfile('delta', { mc: '1.21.4' })
  removeProfile('delta', { purge: true })
  assert.ok(!fs.existsSync(profileDir('delta')))
})

test('refusals name what is wrong and the way out', () => {
  assert.throws(() => createProfile('bad name!', { mc: '1.21.4' }), /invalid profile name/)
  assert.throws(() => createProfile('eps', { mc: '1.21.x' }), /invalid Minecraft version/)
  assert.throws(() => createProfile('eps', { mc: '1.21.4', memory: 'lots' }), /invalid memory value/)
  assert.throws(() => createProfile('eps', { mc: '1.21.4', loader: 'modrinth' }), /unknown loader/)
  assert.throws(() => createProfile('eps', { mc: '1.21.4', harness: true }), /the harness mod needs the fabric loader/)
  assert.throws(() => updateProfile('alpha', { bogus: true }), /unknown profile key/)
  assert.throws(() => createProfile('Alpha', { mc: '1.21.4' }), /names must differ in more than case/)
  assert.throws(() => getProfile('nope'), /no profile named "nope"/)
  assert.throws(() => updateProfile('alpha', { java: 42 }), /java must be text or null/)
  assert.throws(() => updateProfile('alpha', { harness: 'yes' }), /harness must be true or false/)
})

test('the registry survives a round trip through the file', () => {
  const before = loadProfiles()
  saveProfiles(before)
  const onDisk = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'))
  assert.deepEqual(onDisk, before)
  assert.deepEqual(loadProfiles(), before)
  assert.equal(onDisk.version, 1)
  assert.ok(Object.hasOwn(onDisk.profiles, 'alpha'))
})

test('a profile may name an account, and an empty one means offline', () => {
  const p = createProfile('signed', { mc: '1.21.4', account: 'Joogiebear' })
  assert.equal(p.account, 'Joogiebear')
  assert.equal(updateProfile('signed', { account: null }).account, null)
  assert.throws(() => updateProfile('signed', { account: '' }), /account must be text or null/)
})

test('memory must be a whole number of M or G', () => {
  assert.throws(() => createProfile('mem', { mc: '1.21.11', memory: '1.5G' }), /whole number/)
  assert.throws(() => createProfile('mem', { mc: '1.21.11', memory: '2 G' }), /whole number/)
  createProfile('mem', { mc: '1.21.11', memory: '1536M' })
  removeProfile('mem')
})

test('loaderVersion is a plain version string', () => {
  createProfile('lv', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.16.9' })
  assert.throws(() => updateProfile('lv', { loaderVersion: '../../x' }), /loaderVersion/)
  assert.throws(() => updateProfile('lv', { loaderVersion: 'a/b' }), /loaderVersion/)
  removeProfile('lv')
})
