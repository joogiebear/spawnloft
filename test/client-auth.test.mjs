import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-auth-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { MSA_CLIENT_ID, SCOPES, deviceCodeLogin, refreshAccount, loadAccounts, saveAccounts, accountFor, offlineAccount, offlineUuid, upsertAccount, findAccount, startBrowserLogin, finishBrowserLogin, addOfflineAccount, removeAccount, updateAccounts, publicAccount, peekAccount, AUTHORIZE_URL, DEVICECODE_URL, TOKEN_URL, XBL_URL, XSTS_URL, MC_LOGIN_URL, MC_PROFILE_URL } = await import('../src/client-auth.mjs')
const crypto = await import('node:crypto')
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

test('a few unreadable token answers in a row are polled through', async () => {
  resetSleep()
  const steps = [
    { match(url) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } },
    { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 502, json: undefined } },
    { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 503, json: { error: 'temporarily_unavailable' } } },
    { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 400, json: { error: 'authorization_pending' } } },
    { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 500, json: {} } },
    { match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 200, json: tokenReply } },
    { match(url) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: profileReply } },
  ]
  // a body that is not JSON, as an HTML error page would be
  const fetchImpl = scripted(steps)
  const withHtml = async (url, init) => {
    const res = await fetchImpl(url, init)
    return res.status === 502 ? { ...res, json: async () => { throw new SyntaxError('Unexpected token <') } } : res
  }
  const account = await deviceCodeLogin({ onCode: () => {}, fetchImpl: withHtml, sleepImpl, now })
  assert.equal(account.name, 'Joogiebear')
})

test('a token endpoint that keeps failing ends the poll with what it answered, not "undefined"', async () => {
  resetSleep()
  const steps = [{ match(url) { assert.equal(url, DEVICECODE_URL) }, reply: { status: 200, json: dcReply } }]
  for (let i = 0; i < 5; i++) steps.push({ match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 503, json: {} } })
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: scripted(steps), sleepImpl, now }),
    (err) => {
      assert.match(err.message, /stopped answering \(HTTP 503\).*client login again/)
      assert.doesNotMatch(err.message, /undefined/)
      return true
    },
  )
  // a dropped connection counts the same way and is named
  let calls = 0
  const dropping = async (url) => {
    if (calls++ === 0) return { ok: true, status: 200, json: async () => dcReply }
    throw new TypeError('fetch failed')
  }
  await assert.rejects(deviceCodeLogin({ onCode: () => {}, fetchImpl: dropping, sleepImpl, now }), /connection failed: fetch failed/)
  assert.equal(calls, 6)
})

test('the poll stops at the code\'s own expiry even while Microsoft keeps saying pending', async () => {
  resetSleep()
  let clock = 1_700_000_000_000
  const ticking = () => clock
  const sleepTick = (ms) => { clock += ms; return Promise.resolve() }
  let polls = 0
  const pendingForever = async (url) => {
    if (url === DEVICECODE_URL) return { ok: true, status: 200, json: async () => ({ ...dcReply, expires_in: 10, interval: 2 }) }
    polls++
    return { ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) }
  }
  await assert.rejects(
    deviceCodeLogin({ onCode: () => {}, fetchImpl: pendingForever, sleepImpl: sleepTick, now: ticking }),
    /expired before it was entered/,
  )
  // polls at 2, 4, 6 and 8 s; the wake at 10 s is the deadline
  assert.equal(polls, 4)
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

// ---------------------------------------------------------------- launcher sign-in (auth code + PKCE)

const REDIRECT = 'http://localhost:8770/api/client/accounts/login/callback'

test('startBrowserLogin builds the authorize URL with PKCE, state and the account picker', () => {
  const { state, verifier, authorizeUrl } = startBrowserLogin({ redirectUri: REDIRECT })
  const u = new URL(authorizeUrl)
  assert.equal(u.origin + u.pathname, AUTHORIZE_URL)
  const q = u.searchParams
  assert.equal(q.get('client_id'), MSA_CLIENT_ID)
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('redirect_uri'), REDIRECT)
  assert.equal(q.get('scope'), SCOPES)
  assert.equal(q.get('response_mode'), 'query')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('code_challenge'), crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'))
  assert.equal(q.get('state'), state)
  assert.equal(q.get('prompt'), 'select_account')
  // RFC 7636: 43 to 128 unreserved characters; 32 random bytes in base64url are 43
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(state, /^[A-Za-z0-9_-]{22}$/)
  // the verifier is not in the URL; two sign-ins never share a state or verifier
  assert.ok(!authorizeUrl.includes(verifier))
  const again = startBrowserLogin({ redirectUri: REDIRECT })
  assert.notEqual(again.state, state)
  assert.notEqual(again.verifier, verifier)
  // only the panel's own callback address is accepted as the redirect
  for (const bad of ['http://localhost:8770/', 'https://localhost:8770/api/client/accounts/login/callback', 'http://127.0.0.1:8770/api/client/accounts/login/callback', 'http://evil.example/api/client/accounts/login/callback', REDIRECT + '?x=1']) {
    assert.throws(() => startBrowserLogin({ redirectUri: bad }), /callback address/)
  }
})

test('finishBrowserLogin exchanges the code with the verifier and the same redirect URI, then runs the chain', async () => {
  const steps = [
    {
      match(url, init) {
        assert.equal(url, TOKEN_URL)
        const body = new URLSearchParams(init.body)
        assert.equal(body.get('grant_type'), 'authorization_code')
        assert.equal(body.get('client_id'), MSA_CLIENT_ID)
        assert.equal(body.get('code'), 'the-code')
        assert.equal(body.get('redirect_uri'), REDIRECT)
        assert.equal(body.get('code_verifier'), 'v'.repeat(43))
      },
      reply: { status: 200, json: tokenReply },
    },
    { match(url) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: profileReply } },
  ]
  const account = await finishBrowserLogin({ code: 'the-code', verifier: 'v'.repeat(43), redirectUri: REDIRECT, fetchImpl: scripted(steps), now })
  assert.equal(account.name, 'Joogiebear')
  assert.equal(account.type, 'microsoft')
  assert.equal(account.refreshToken, 'msa-refresh')
})

test('finishBrowserLogin maps an expired code, a refusal and a lost connection, naming no code', async () => {
  const expired = scripted([{ match() {}, reply: { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS70008: expired' } } }])
  await assert.rejects(finishBrowserLogin({ code: 'c0de', verifier: 'v', redirectUri: REDIRECT, fetchImpl: expired, now }), (err) => {
    assert.match(err.message, /the sign-in expired; try again/)
    assert.ok(!err.message.includes('c0de'))
    return true
  })
  const refused = scripted([{ match() {}, reply: { status: 400, json: { error: 'invalid_client', error_description: 'AADSTS7000218: something\nline two' } } }])
  await assert.rejects(finishBrowserLogin({ code: 'c0de', verifier: 'v', redirectUri: REDIRECT, fetchImpl: refused, now }), /Microsoft refused the sign-in: AADSTS7000218: something$/)
  const lost = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(finishBrowserLogin({ code: 'c0de', verifier: 'v', redirectUri: REDIRECT, fetchImpl: lost, now }), /lost the connection to Microsoft; start the sign-in again/)
  await assert.rejects(finishBrowserLogin({ code: '', verifier: 'v', redirectUri: REDIRECT, fetchImpl: lost, now }), /no sign-in code/)
  const html = scripted([{ match() {}, reply: { status: 502, json: undefined } }])
  await assert.rejects(finishBrowserLogin({ code: 'c0de', verifier: 'v', redirectUri: REDIRECT, fetchImpl: html, now }), /HTTP 502/)
})

test('deviceCodeLogin stops at once when its signal is aborted', async () => {
  resetSleep()
  const abort = new AbortController()
  let polls = 0
  const pendingForever = async (url) => {
    if (url === DEVICECODE_URL) return { ok: true, status: 200, json: async () => dcReply }
    polls++
    return { ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) }
  }
  // a sleep that never ends on its own: only the abort can wake the poll
  const stuck = () => new Promise(() => {})
  const login = deviceCodeLogin({ onCode: () => {}, fetchImpl: pendingForever, sleepImpl: stuck, now, signal: abort.signal })
  setTimeout(() => abort.abort(), 20)
  await assert.rejects(login, /the sign-in was cancelled/)
  assert.equal(polls, 0)
  // already aborted: no request at all
  let calls = 0
  await assert.rejects(deviceCodeLogin({ onCode: () => {}, fetchImpl: async () => { calls++ }, sleepImpl, now, signal: abort.signal }), /cancelled/)
  assert.equal(calls, 0)
})

// ---------------------------------------------------------------- the accounts file

test('offline accounts live in the file without tokens, by the uuid an offline server derives', () => {
  saveAccounts([])
  const a = addOfflineAccount('Tester_1')
  assert.deepEqual(a, { type: 'offline', name: 'Tester_1', uuid: offlineUuid('Tester_1') })
  assert.deepEqual(loadAccounts(), [a])
  assert.throws(() => addOfflineAccount('no spaces'), /3 to 16 letters/)
  // adding it again, in any case, is the same entry; a Microsoft account of that name wins the name
  addOfflineAccount('Tester_1')
  assert.deepEqual(addOfflineAccount('tester_1'), a)
  assert.equal(loadAccounts().length, 1)
  saveAccounts([{ type: 'microsoft', name: 'Joogiebear', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(now() + 86400000).toISOString() }])
  assert.throws(() => addOfflineAccount('joogiebear'), /is a signed-in Microsoft account/)
  assert.equal(loadAccounts().length, 1)
  // what leaves the process about each kind
  assert.deepEqual(publicAccount(loadAccounts()[0]), { name: 'Joogiebear', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', type: 'microsoft', expiresAt: loadAccounts()[0].expiresAt, refreshFailedAt: null })
  assert.deepEqual(publicAccount(a), { name: 'Tester_1', uuid: a.uuid, type: 'offline', expiresAt: null, refreshFailedAt: null })
  // an entry written before the type key existed reads as a Microsoft account
  assert.equal(publicAccount({ name: 'Old', uuid: 'u', expiresAt: 'e' }).type, 'microsoft')
  saveAccounts([])
})

test('accountFor plays a stored offline account offline and resolves it by uuid too', async () => {
  saveAccounts([])
  const a = addOfflineAccount('Tester_1')
  const byName = await accountFor('Tester_1', { fetchImpl: scripted([]), now })
  assert.deepEqual(byName, offlineAccount('Tester_1'))
  const byUuid = await accountFor(a.uuid.replace(/-/g, ''), { fetchImpl: scripted([]), now })
  assert.equal(byUuid.name, 'Tester_1')
  assert.equal(peekAccount(a.uuid).type, 'offline')
  assert.equal(peekAccount('offline:Someone').type, 'offline')
  assert.throws(() => peekAccount('nobody'), /no Microsoft account named "nobody"/)
  saveAccounts([])
})

test('removeAccount drops one entry by uuid and leaves the rest, whatever form the uuid takes', () => {
  const far = new Date(now() + 86400000).toISOString()
  saveAccounts([
    { type: 'microsoft', name: 'A', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: 'x', refreshToken: 'y', expiresAt: far },
    { type: 'offline', name: 'B', uuid: offlineUuid('B') },
  ])
  assert.equal(removeAccount('11111111-1111-1111-1111-111111111111'), null)
  assert.equal(loadAccounts().length, 2)
  const gone = removeAccount('069A79F444E94726A5BEFCA90E38AAF5')
  assert.deepEqual(gone, { name: 'A', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', type: 'microsoft', expiresAt: far, refreshFailedAt: null })
  assert.deepEqual(loadAccounts().map((a) => a.name), ['B'])
  saveAccounts([])
})

test('a failed refresh marks the account with refreshFailedAt and a new login clears it', async () => {
  const soon = new Date(1_700_000_000_000 + 60000).toISOString()
  saveAccounts([{ type: 'microsoft', name: 'tired', uuid: 'c'.repeat(32), accessToken: 'stale', expiresAt: soon, refreshToken: 'dead', xuid: '', userType: 'msa', clientId: MSA_CLIENT_ID }])
  const refused = scripted([{ match(url) { assert.equal(url, TOKEN_URL) }, reply: { status: 400, json: { error: 'invalid_grant' } } }])
  await assert.rejects(accountFor('tired', { fetchImpl: refused, now }), /sign-in for tired no longer works/)
  const marked = loadAccounts()[0]
  assert.equal(marked.refreshFailedAt, new Date(1_700_000_000_000).toISOString())
  assert.equal(marked.refreshToken, 'dead', 'the entry keeps its tokens; only the mark is added')
  assert.equal(publicAccount(marked).refreshFailedAt, marked.refreshFailedAt)
  // a later successful login (same uuid) replaces the entry, mark included
  const fresh = { type: 'microsoft', name: 'tired', uuid: 'c'.repeat(32), accessToken: 'new', expiresAt: new Date(now() + 86400000).toISOString(), refreshToken: 'alive', xuid: '', userType: 'msa', clientId: MSA_CLIENT_ID }
  updateAccounts((list) => upsertAccount(list, fresh))
  assert.equal(loadAccounts()[0].refreshFailedAt, undefined)
  assert.equal(loadAccounts()[0].refreshToken, 'alive')
  saveAccounts([])
})

test('a refresh and a login interleaved: both accounts survive (the re-read-and-upsert rule)', async () => {
  const soon = new Date(1_700_000_000_000 + 60000).toISOString()
  const refreshing = { type: 'microsoft', name: 'first', uuid: 'd'.repeat(32), accessToken: 'stale', expiresAt: soon, refreshToken: 'r1', xuid: '', userType: 'msa', clientId: MSA_CLIENT_ID }
  saveAccounts([refreshing])
  const steps = [
    {
      match(url) {
        assert.equal(url, TOKEN_URL)
        // while the refresh waits on Microsoft, a sign-in in another process writes a second account
        updateAccounts((list) => upsertAccount(list, { type: 'microsoft', name: 'second', uuid: 'e'.repeat(32), accessToken: 'tok2', refreshToken: 'r2', expiresAt: new Date(now() + 86400000).toISOString() }))
      },
      reply: { status: 200, json: tokenReply },
    },
    { match(url) { assert.equal(url, XBL_URL) }, reply: { status: 200, json: xblReply } },
    { match(url) { assert.equal(url, XSTS_URL) }, reply: { status: 200, json: xstsReply } },
    { match(url) { assert.equal(url, MC_LOGIN_URL) }, reply: { status: 200, json: mcLoginReply } },
    { match(url) { assert.equal(url, MC_PROFILE_URL) }, reply: { status: 200, json: { ...profileReply, id: 'd'.repeat(32), name: 'first' } } },
  ]
  const got = await accountFor('first', { fetchImpl: scripted(steps), now })
  assert.equal(got.accessToken, 'mc-token')
  const names = loadAccounts().map((a) => a.name).sort()
  assert.deepEqual(names, ['first', 'second'])
  assert.equal(loadAccounts().find((a) => a.name === 'first').accessToken, 'mc-token')
  saveAccounts([])
})
