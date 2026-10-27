import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-auth-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { MSA_CLIENT_ID, deviceCodeLogin, refreshAccount, loadAccounts, saveAccounts, accountFor, offlineAccount, upsertAccount, findAccount, DEVICECODE_URL, TOKEN_URL, XBL_URL, XSTS_URL, MC_LOGIN_URL, MC_PROFILE_URL } = await import('../src/client-auth.mjs')
const { ACCOUNTS_FILE } = await import('../src/client-paths.mjs')

function scripted(steps) {
  let i = 0
  return async (url, init) => {
    if (i >= steps.length) throw new Error('unexpected request ' + url)
    const step = steps[i++]
    step.match(url, init)
    return { ok: step.reply.status < 300, status: step.reply.status, json: async () => step.reply.json }
  }
}

const sleepCalls = []
const sleepImpl = (ms) => { sleepCalls.push(ms); return Promise.resolve() }
const now = () => 1_700_000_000_000

const dcReply = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/link', expires_in: 900, interval: 2 }
const tokenReply = { access_token: 'msa-access', refresh_token: 'msa-refresh', expires_in: 3600 }
const xblReply = { Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'hash1' }] } }
const xstsReply = { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'hash1', xid: '2535' }] } }
const mcLoginReply = { access_token: 'mc-token', expires_in: 86400 }
const profileReply = { id: '069a79f444e94726a5befca90e38aaf5', name: 'Joogiebear' }

function resetSleep() { sleepCalls.length = 0 }

test('deviceCodeLogin walks the six steps with the right bodies and yields an account', async () => {
  resetSleep()
  const onCodeArgs = []
  const steps = [
    {
      match(url, init) {
        assert.equal(url, DEVICECODE_URL)
        assert.ok(init.body.includes('client_id=' + MSA_CLIENT_ID))
        assert.ok(init.body.includes('scope=XboxLive.signin+offline_access'))
      },
      reply: { status: 200, json: dcReply },
    },
    {
      match(url, init) {
        assert.equal(url, TOKEN_URL)
        assert.ok(init.body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'))
        assert.ok(init.body.includes('device_code=dc'))
      },
      reply: { status: 400, json: { error: 'authorization_pending' } },
    },
    {
      match(url, init) {
        assert.equal(url, TOKEN_URL)
        assert.ok(init.body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'))
        assert.ok(init.body.includes('device_code=dc'))
      },
      reply: { status: 200, json: tokenReply },
    },
    {
      match(url, init) {
        assert.equal(url, XBL_URL)
        const parsed = JSON.parse(init.body)
        assert.equal(parsed.Properties.RpsTicket, 'd=msa-access')
      },
      reply: { status: 200, json: xblReply },
    },
    {
      match(url, init) {
        assert.equal(url, XSTS_URL)
        const parsed = JSON.parse(init.body)
        assert.equal(parsed.Properties.UserTokens[0], 'xbl-token')
        assert.equal(parsed.RelyingParty, 'rp://api.minecraftservices.com/')
      },
      reply: { status: 200, json: xstsReply },
    },
    {
      match(url, init) {
        assert.equal(url, MC_LOGIN_URL)
        const parsed = JSON.parse(init.body)
        assert.equal(parsed.identityToken, 'XBL3.0 x=hash1;xsts-token')
      },
      reply: { status: 200, json: mcLoginReply },
    },
    {
      match(url, init) {
        assert.equal(url, MC_PROFILE_URL)
        assert.equal(init.headers.authorization, 'Bearer mc-token')
        assert.ok(!init.body)
      },
      reply: { status: 200, json: profileReply },
    },
  ]
  const result = await deviceCodeLogin({
    onCode: (arg) => { onCodeArgs.push(arg) },
    fetchImpl: scripted(steps),
    sleepImpl,
    now,
  })
  assert.deepEqual(onCodeArgs, [{ verificationUri: 'https://microsoft.com/link', userCode: 'ABCD-1234', expiresIn: 900 }])
  assert.deepEqual(sleepCalls, [2000, 2000])
  assert.deepEqual(result, {
    type: 'microsoft',
    name: 'Joogiebear',
    uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    accessToken: 'mc-token',
    expiresAt: new Date(1_700_000_000_000 + 86400 * 1000).toISOString(),
    refreshToken: 'msa-refresh',
    xuid: '2535',
    userType: 'msa',
    clientId: MSA_CLIENT_ID,
  })
})

test('slow_down widens the polling interval', async () => {
  resetSleep()
  const steps = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 400, json: { error: 'slow_down' } } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url, init) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url, init) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: profileReply } },
  ]
  await deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(steps), sleepImpl, now })
  assert.deepEqual(sleepCalls, [2000, 7000])
})

test('an expired code says to run login again', async () => {
  resetSleep()
  const stepsExpired = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 400, json: { error: 'expired_token' } } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(stepsExpired), sleepImpl, now }),
    /expired before it was entered/,
  )
  resetSleep()
  const stepsDeclined = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 400, json: { error: 'authorization_declined' } } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(stepsDeclined), sleepImpl, now }),
    /declined/,
  )
})

test('a child account and a missing Xbox profile are named', async () => {
  resetSleep()
  const stepsChild = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 401, json: { XErr: 2148916238 } } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(stepsChild), sleepImpl, now }),
    /child account/,
  )
  resetSleep()
  const stepsNoXbox = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 401, json: { XErr: 2148916233 } } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(stepsNoXbox), sleepImpl, now }),
    /no Xbox profile/,
  )
})

test('an unapproved client id is explained, and so is an account without Java Edition', async () => {
  resetSleep()
  const steps403 = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url, init) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 403, json: { errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information' } } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(steps403), sleepImpl, now }),
    (err) => {
      // both causes are named, with Mojang's own words when it sends them
      assert.match(err.message, /HTTP 403/)
      assert.match(err.message, /Mojang has not approved/)
      assert.match(err.message, /Allow public client flows/)
      assert.match(err.message, /"Invalid app registration/)
      assert.ok(err.message.includes(MSA_CLIENT_ID))
      return true
    },
  )
  resetSleep()
  const steps404 = [
    { match(url, init) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url, init) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url, init) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url, init) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 404, json: {} } },
  ]
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(steps404), sleepImpl, now }),
    /owns no Minecraft: Java Edition/,
  )
})

test('accounts are saved in a file only the owner can read', () => {
  saveAccounts([{ name: 'A', refreshToken: 'r' }])
  assert.deepEqual(loadAccounts(), [{ name: 'A', refreshToken: 'r' }])
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(ACCOUNTS_FILE).mode & 0o777, 0o600)
  }
  fs.rmSync(ACCOUNTS_FILE)
  assert.deepEqual(loadAccounts(), [])
})

test('accountFor refreshes a token about to expire and leaves a fresh one alone', async () => {
  const fresh = { type: 'microsoft', name: 'fresh', uuid: 'a'.repeat(32), accessToken: 'stale', expiresAt: new Date(1_700_000_000_000 + 3600000).toISOString(), refreshToken: 'msa-refresh', xuid: '', userType: 'msa', clientId: MSA_CLIENT_ID }
  const old = { type: 'microsoft', name: 'old', uuid: 'b'.repeat(32), accessToken: 'stale2', expiresAt: new Date(1_700_000_000_000 + 120000).toISOString(), refreshToken: 'msa-refresh', xuid: '', userType: 'msa', clientId: MSA_CLIENT_ID }
  saveAccounts([fresh, old])

  const gotFresh = await accountFor('fresh', { fetchImpl: scripted([]), now })
  assert.deepEqual(gotFresh, fresh)

  const refreshSteps = [
    {
      match(url, init) {
        assert.equal(url, TOKEN_URL)
        assert.ok(init.body.includes('grant_type=refresh_token'))
        assert.ok(init.body.includes('refresh_token=msa-refresh'))
      },
      reply: { status: 200, json: tokenReply },
    },
    { match(url, init) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url, init) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url, init) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url, init) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: profileReply } },
  ]
  const gotOld = await accountFor('OLD', { fetchImpl: scripted(refreshSteps), now })
  assert.equal(gotOld.accessToken, 'mc-token')
  assert.equal(gotOld.name, 'Joogiebear')

  const saved = loadAccounts()
  assert.deepEqual(saved[0], fresh)
  assert.equal(saved[1].accessToken, 'mc-token')
  assert.equal(saved[1].name, 'Joogiebear')

  const offline = await accountFor('offline:Steve', { now })
  assert.deepEqual(offline, offlineAccount('Steve'))

  await assert.rejects(accountFor('nobody', { fetchImpl: scripted([]), now }), /no Microsoft account named "nobody"/)
  await assert.rejects(accountFor('', { fetchImpl: scripted([]), now }), /offline:<player name>/)
})

test('a refresh that no longer works says to sign in again', async () => {
  await assert.rejects(
    refreshAccount({ name: 'old', refreshToken: 'dead' }, {
      fetchImpl: scripted([{ match() {}, reply: { status: 400, json: { error: 'invalid_grant' } } }]),
      now,
    }),
    /sign-in for old no longer works/,
  )
})

test('the South Korean age-verification XErrs are named', async () => {
  for (const xerr of [2148916236, 2148916237]) {
    resetSleep()
    const steps = [
      { match(url) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
      { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
      { match(url) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
      { match(url) { assert.equal(url, XSTS_URL) }, reply: { status: 401, json: { XErr: xerr } } },
    ]
    await assert.rejects(deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(steps), sleepImpl, now }), /age verification/)
  }
})

test('a login replaces the entry with the same uuid and drops a stale one holding its name', () => {
  const a = { name: 'Alpha', uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accessToken: '1' }
  const b = { name: 'Beta', uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', accessToken: '2' }
  // Alpha renamed itself Gamma at Mojang: same uuid, new name, same place in the list
  const renamed = upsertAccount([a, b], { ...a, name: 'Gamma', accessToken: '3' })
  assert.deepEqual(renamed.map((x) => x.name), ['Gamma', 'Beta'])
  assert.equal(renamed[0].accessToken, '3')
  // a new account that now owns the name "Beta" pushes out the stale entry under that name
  const c = { name: 'beta', uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', accessToken: '4' }
  assert.deepEqual(upsertAccount(renamed, c).map((x) => x.uuid), [a.uuid, c.uuid])
  assert.deepEqual(upsertAccount([], a), [a])
  // a stale same-name entry ahead of the uuid's entry does not shift the replacement's place
  const x = { name: 'Delta', uuid: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }
  const d = { name: 'Other', uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
  assert.deepEqual(upsertAccount([x, a, b, d], { ...b, name: 'Delta' }).map((y) => y.name), ['Alpha', 'Delta', 'Other'])
})

test('accounts are found by uuid (with or without dashes) or by name', async () => {
  const a = { type: 'microsoft', name: 'Alpha', uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accessToken: 't', expiresAt: new Date(1_700_000_000_000 + 3600000).toISOString(), refreshToken: 'r' }
  const list = [a]
  assert.equal(findAccount(list, 'alpha'), 0)
  assert.equal(findAccount(list, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), 0)
  assert.equal(findAccount(list, 'a'.repeat(32)), 0)
  assert.equal(findAccount(list, 'nobody'), -1)
  saveAccounts(list)
  assert.deepEqual(await accountFor(a.uuid, { fetchImpl: scripted([]), now }), a)
  fs.rmSync(ACCOUNTS_FILE)
})

test('a refresh keeps an account signed in by another process meanwhile', async () => {
  const old = { type: 'microsoft', name: 'Joogiebear', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: 'stale', expiresAt: new Date(1_700_000_000_000).toISOString(), refreshToken: 'msa-refresh' }
  const other = { type: 'microsoft', name: 'Other', uuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd', accessToken: 'o', expiresAt: new Date(1_700_000_000_000 + 3600000).toISOString(), refreshToken: 'r' }
  saveAccounts([old])
  const steps = [
    // the token request is where the refresh waits on the network; a login lands during it
    { match() { saveAccounts([old, other]) }, reply: { status: 200, json: tokenReply } },
    { match(url) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: profileReply } },
  ]
  const got = await accountFor('Joogiebear', { fetchImpl: scripted(steps), now })
  assert.equal(got.accessToken, 'mc-token')
  const saved = loadAccounts()
  assert.deepEqual(saved.map((x) => x.name), ['Joogiebear', 'Other'])
  assert.equal(saved[0].accessToken, 'mc-token')
  fs.rmSync(ACCOUNTS_FILE)
})

test('a refresh does not bring back an account signed out meanwhile', async () => {
  const old = { type: 'microsoft', name: 'Gone', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: 'stale', expiresAt: new Date(1_700_000_000_000).toISOString(), refreshToken: 'msa-refresh' }
  saveAccounts([old])
  const steps = [
    { match() { saveAccounts([]) }, reply: { status: 200, json: tokenReply } },
    { match() {}, reply: { status: 200, json: xblReply } },
    { match() {}, reply: { status: 200, json: xstsReply } },
    { match() {}, reply: { status: 200, json: mcLoginReply } },
    { match() {}, reply: { status: 200, json: profileReply } },
  ]
  await accountFor('Gone', { fetchImpl: scripted(steps), now })
  assert.deepEqual(loadAccounts(), [])
})
