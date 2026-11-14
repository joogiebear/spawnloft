import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { createProfile, listProfiles, getProfile, updateProfile, removeProfile, renameProfile, duplicateProfile, played, loadProfiles, saveProfiles } = await import('../src/client.mjs')
const { profileDir, clientRunDir, clientPlayed, clientLaunchLock, PROFILES_FILE } = await import('../src/client-paths.mjs')

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
  // the shape only: whether Mojang lists it is checked where a profile is saved from (V1b)
  for (const bad of ['1.21/x', '../1.21', '1.21.', '1.21 .', '-1.21', '1..21', '', 'a'.repeat(65)]) {
    assert.throws(() => createProfile('eps', { mc: bad }), /invalid Minecraft version/, bad)
  }
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

test('assistantAccount starts false for every profile and only set turns it on', () => {
  const p = createProfile('aa', { mc: '1.21.4', account: 'Someone' })
  assert.equal(p.assistantAccount, false)
  assert.equal(getProfile('aa').assistantAccount, false)
  assert.equal(listProfiles().find((x) => x.name === 'aa').assistantAccount, false)
  assert.equal(updateProfile('aa', { assistantAccount: true }).assistantAccount, true)
  assert.equal(getProfile('aa').assistantAccount, true)
  assert.throws(() => updateProfile('aa', { assistantAccount: 'yes' }), /assistantAccount must be true or false/)
  removeProfile('aa', { purge: true })
})

test('a profile written before assistantAccount existed reads as false', () => {
  const reg = loadProfiles()
  reg.profiles.legacy = { mc: '1.21.4', loader: 'vanilla', loaderVersion: null, java: null, memory: '2G', harness: false, server: null, account: 'Someone', createdAt: new Date().toISOString() }
  saveProfiles(reg)
  assert.equal(getProfile('legacy').assistantAccount, false)
  assert.equal(updateProfile('legacy', { memory: '3G' }).assistantAccount, false)
  removeProfile('legacy')
})

// ---- rename and duplicate ----

test('renameProfile moves the entry, the game folder and the run folder together', () => {
  createProfile('old-name', { mc: '1.21.4', memory: '3G' })
  createProfile('other', { mc: '1.21.4' })
  fs.mkdirSync(path.join(profileDir('old-name'), 'saves', 'World'), { recursive: true })
  fs.mkdirSync(clientRunDir('old-name'), { recursive: true })
  fs.writeFileSync(clientPlayed('old-name'), JSON.stringify({ lastPlayedAt: '2026-11-01T10:00:00.000Z', totalMs: 60000, launches: 2 }))
  const order = Object.keys(loadProfiles().profiles)

  const p = renameProfile('old-name', 'new-name')
  assert.equal(p.name, 'new-name')
  assert.equal(p.memory, '3G')
  assert.throws(() => getProfile('old-name'), /no profile named/)
  assert.ok(fs.existsSync(path.join(profileDir('new-name'), 'saves', 'World')), 'the worlds came along')
  assert.equal(fs.existsSync(profileDir('old-name')), false)
  assert.deepEqual(played('new-name'), { lastPlayedAt: '2026-11-01T10:00:00.000Z', totalMs: 60000, launches: 2 })
  assert.equal(fs.existsSync(clientRunDir('old-name')), false)
  assert.deepEqual(Object.keys(loadProfiles().profiles), order.map((k) => (k === 'old-name' ? 'new-name' : k)), 'the entry keeps its place')

  // refusals: a name in use (whatever its case), a bad name, a folder someone left behind
  assert.throws(() => renameProfile('new-name', 'OTHER'), (err) => err.code === 'name-taken')
  assert.throws(() => renameProfile('new-name', 'has space'), /invalid profile name/)
  fs.mkdirSync(profileDir('leftover'), { recursive: true })
  assert.throws(() => renameProfile('new-name', 'leftover'), (err) => err.code === 'name-taken')
  assert.ok(fs.existsSync(profileDir('new-name')), 'a refused rename moves nothing')
  // its own name in another case is a rename like any other; the same name is nothing to do
  assert.equal(renameProfile('new-name', 'New-Name').name, 'New-Name')
  assert.equal(renameProfile('New-Name', 'New-Name').name, 'New-Name')
  // not while it is being launched
  const lock = clientLaunchLock('New-Name')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, String(process.pid))
  assert.throws(() => renameProfile('New-Name', 'later'), (err) => err.code === 'launching')
  fs.rmSync(lock)
  removeProfile('New-Name', { purge: true })
  removeProfile('other', { purge: true })
  fs.rmSync(profileDir('leftover'), { recursive: true })
})

test('duplicateProfile copies the settings, mods and options, and leaves the worlds', () => {
  createProfile('src', { mc: '1.21.4', loader: 'fabric', memory: '4G', account: 'offline:Steve' })
  updateProfile('src', { assistantAccount: true })
  const dir = profileDir('src')
  fs.writeFileSync(path.join(dir, 'options.txt'), 'lang:nl_nl\nfov:0.5\n')
  fs.mkdirSync(path.join(dir, 'mods'))
  fs.writeFileSync(path.join(dir, 'mods', 'sodium.jar'), 'jar')
  fs.mkdirSync(path.join(dir, 'config', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'deep', 'a.toml'), 'x = 1')
  fs.mkdirSync(path.join(dir, 'saves', 'World'), { recursive: true })

  const copy = duplicateProfile('src', 'src-copy')
  assert.equal(copy.name, 'src-copy')
  for (const key of ['mc', 'loader', 'memory', 'account']) assert.equal(copy[key], getProfile('src')[key], key)
  assert.equal(copy.assistantAccount, false, 'a copy starts with it off, as every new profile does')
  const to = profileDir('src-copy')
  assert.equal(fs.readFileSync(path.join(to, 'options.txt'), 'utf8'), 'lang:nl_nl\nfov:0.5\n')
  assert.equal(fs.readFileSync(path.join(to, 'mods', 'sodium.jar'), 'utf8'), 'jar')
  assert.equal(fs.readFileSync(path.join(to, 'config', 'deep', 'a.toml'), 'utf8'), 'x = 1')
  assert.equal(fs.existsSync(path.join(to, 'saves')), false)
  assert.deepEqual(played('src-copy'), { lastPlayedAt: null, totalMs: 0, launches: 0 })
  assert.throws(() => duplicateProfile('src', 'SRC-copy'), (err) => err.code === 'name-taken')
  removeProfile('src', { purge: true })
  removeProfile('src-copy', { purge: true })
})
