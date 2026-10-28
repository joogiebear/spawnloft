import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The launcher's default account: who a launch plays as when nothing names an account, who
// ignores it (assistants), and the uuid-keyed profile account. Real fake-client launches.

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-default-'))
process.env.MCCTL_DATA_ROOT = scratch

const { launch, status, stop, createProfile, updateProfile, getProfile, loadProfiles, saveProfiles, getDefaultAccount, setDefaultAccount, accountLabel, accountInfo, LAUNCHED_BY } = await import('../src/client.mjs')
const { saveAccounts, loadAccounts, addOfflineAccount, removeAccount, offlineUuid, updateAccounts, upsertAccount } = await import('../src/client-auth.mjs')
const { readClientState } = await import('../src/client-launch.mjs')
const { versionDir, versionJson, PROFILES_FILE } = await import('../src/client-paths.mjs')
const { readJson } = await import('../src/util.mjs')

const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release
fs.mkdirSync(versionDir(mc), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', `${mc}.json`), versionJson(mc))

const far = () => new Date(Date.now() + 86400000).toISOString()
const MS_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5'
const msAccount = (name = 'Joogiebear') => ({ type: 'microsoft', name, uuid: MS_UUID, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: far(), xuid: '2535', userType: 'msa', clientId: 'c' })

createProfile('plain', { mc })

after(async () => {
  for (const p of ['plain', 'named']) { try { await stop(p) } catch { /* not running */ } }
  fs.rmSync(scratch, { recursive: true, force: true })
})

async function launchAs(name, opts = {}) {
  const res = await launch(name, { fakeJava, ...opts })
  const state = readClientState(name)
  await stop(name)
  return { res, state }
}

test('the default account is set and read by uuid, and a dangling one is dropped on the next save', () => {
  assert.equal(getDefaultAccount(), null)
  assert.throws(() => setDefaultAccount('11111111-1111-1111-1111-111111111111'), /no account with uuid/)
  saveAccounts([msAccount()])
  assert.equal(setDefaultAccount(MS_UUID.replace(/-/g, '').toUpperCase()), MS_UUID, 'stored in the file\'s own form')
  assert.equal(readJson(PROFILES_FILE).defaultAccount, MS_UUID)
  assert.equal(getDefaultAccount(), MS_UUID)
  // signed out: not an error, just gone, and the file is cleaned on the next save
  removeAccount(MS_UUID)
  assert.equal(getDefaultAccount(), null)
  assert.equal(readJson(PROFILES_FILE).defaultAccount, MS_UUID, 'not rewritten by a read')
  saveProfiles(loadProfiles())
  assert.equal(readJson(PROFILES_FILE).defaultAccount, undefined)
  assert.equal(setDefaultAccount(null), null)
})

test('precedence: --as beats --account beats the profile account beats the default; assistants ignore the default', async () => {
  saveAccounts([msAccount()])
  addOfflineAccount('Walker')
  setDefaultAccount(MS_UUID)

  // nothing names an account: the default plays
  let r = await launchAs('plain')
  assert.deepEqual(r.res.account, { type: 'microsoft', name: 'Joogiebear' })
  assert.equal(r.state.mode, 'microsoft')
  assert.equal(r.state.launchedBy, 'cli')

  // an assistant launch of the same profile plays offline with the derived name
  r = await launchAs('plain', { assistant: true })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'plain' })
  assert.equal(r.state.launchedBy, 'assistant')

  // --as is an offline player, and beats the default without being "both"
  r = await launchAs('plain', { playerName: 'Someone' })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'Someone' })

  // --account beats the default
  r = await launchAs('plain', { account: 'Walker' })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'Walker' })
  r = await launchAs('plain', { account: 'offline:Other' })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'Other' })

  // the profile's own account beats the default, and --as with it is still "not both"
  createProfile('named', { mc, account: 'Walker' })
  assert.equal(getProfile('named').account, offlineUuid('Walker'), 'stored as the uuid')
  assert.equal(accountLabel(getProfile('named').account), 'Walker')
  assert.deepEqual(accountInfo(getProfile('named').account), { name: 'Walker', type: 'offline' })
  r = await launchAs('named', { launchedBy: 'launcher' })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'Walker' })
  assert.equal(r.state.launchedBy, 'launcher')
  await assert.rejects(launch('named', { fakeJava, playerName: 'x' }), /not both/)
  // an assistant may launch an offline-account profile without assistantAccount
  r = await launchAs('named', { assistant: true })
  assert.deepEqual(r.res.account, { type: 'offline', name: 'Walker' })

  // a Microsoft account on the profile: the assistant rule, by type, whatever the key's form
  updateProfile('named', { account: 'joogiebear' })
  assert.equal(getProfile('named').account, MS_UUID)
  await assert.rejects(launch('named', { fakeJava, assistant: true }), /assistantAccount=true/)
  updateProfile('named', { assistantAccount: true })
  r = await launchAs('named', { assistant: true })
  assert.deepEqual(r.res.account, { type: 'microsoft', name: 'Joogiebear' })

  // an entry from before the type key existed is a Microsoft account to the assistant rule too
  saveAccounts([{ name: 'Joogiebear', uuid: MS_UUID, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: far(), xuid: '2535', userType: 'msa', clientId: 'c' }, { type: 'offline', name: 'Walker', uuid: offlineUuid('Walker') }])
  updateProfile('named', { assistantAccount: false })
  await assert.rejects(launch('named', { fakeJava, assistant: true }), /assistantAccount=true/)
  r = await launchAs('named')
  assert.deepEqual(r.res.account, { type: 'microsoft', name: 'Joogiebear' })
  assert.equal(r.state.mode, 'microsoft')

  // a default that points at a removed account falls through to offline
  removeAccount(MS_UUID)
  r = await launchAs('plain')
  assert.deepEqual(r.res.account, { type: 'offline', name: 'plain' })
  // the profile that named the removed account says so before anything downloads
  await assert.rejects(launch('named', { fakeJava }), /the account this profile names \(uuid .*\) is no longer in the list/)

  await assert.rejects(launch('plain', { fakeJava, launchedBy: 'web' }), /unknown launchedBy/)
  assert.deepEqual([...LAUNCHED_BY].sort(), ['assistant', 'cli', 'launcher', 'panel'])
  saveAccounts([])
})

test('a damaged accounts.json does not take the profiles with it', () => {
  fs.writeFileSync(path.join(scratch, 'client', 'accounts.json'), '{not json')
  assert.doesNotThrow(() => createProfile('damaged', { mc, account: 'Someone' }))
  assert.equal(getProfile('damaged').account, 'Someone', 'stored as typed')
  assert.deepEqual(accountInfo('Someone'), { name: 'Someone', type: null })
  assert.equal(getDefaultAccount(), null)
  assert.doesNotThrow(() => saveProfiles(loadProfiles()))
  fs.rmSync(path.join(scratch, 'client', 'accounts.json'))
  assert.doesNotThrow(() => updateProfile('damaged', { account: null }))
})

test('a profile account stored by uuid survives a Mojang name change, and an old name key still resolves', async () => {
  saveAccounts([msAccount('OldName')])
  updateProfile('named', { account: 'OldName', assistantAccount: false })
  assert.equal(getProfile('named').account, MS_UUID)
  // the name changed at Mojang: the next login replaces the entry under the same uuid
  updateAccounts((list) => upsertAccount(list, msAccount('NewName')))
  let r = await launchAs('named')
  assert.equal(r.res.account.name, 'NewName')
  // a key written by an older SpawnLoft as a name keeps working
  const reg = loadProfiles()
  reg.profiles.named.account = 'newname'
  saveProfiles(reg)
  r = await launchAs('named')
  assert.equal(r.res.account.name, 'NewName')
  // and a launch of it reports the launcher's status fields
  assert.equal(status('named').launchedBy, null, 'stopped: nothing to report')
  assert.equal(loadAccounts().length, 1)
  saveAccounts([])
})
