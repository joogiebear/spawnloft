import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'

// The launcher's accounts and Microsoft sign-in routes, through a real panel on a random port.
// Microsoft and Mojang are a scripted fetch; the broker's timers are a list the test fires.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-login-'))
process.env.MCCTL_DATA_ROOT = scratch

const ui = await import('../src/ui.mjs')
const login = await import('../src/client-login.mjs')
const auth = await import('../src/client-auth.mjs')
const client = await import('../src/client.mjs')
const { LAYOUT } = await import('../src/paths.mjs')
const { ACCOUNTS_FILE } = await import('../src/client-paths.mjs')

const { MSA_CLIENT_ID, TOKEN_URL, XBL_URL, XSTS_URL, MC_LOGIN_URL, MC_PROFILE_URL } = auth

let server
let url
let port
before(async () => {
  const started = await ui.serve({ port: 0, open: false })
  server = started.server
  url = started.url
  port = started.port
})
after(() => {
  server?.close()
  login.resetLoginHooks()
  fs.rmSync(scratch, { recursive: true, force: true })
})

// --- the scripted outside world ---------------------------------------------------------

const ACCESS = 'mc-access-token-fixture-7f3a'
const REFRESH = 'msa-refresh-token-fixture-9c1d'
const tokenReply = { access_token: 'msa-access', refresh_token: REFRESH, expires_in: 3600 }
const xblReply = { Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'hash1' }] } }
const xstsReply = { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'hash1', xid: '2535' }] } }
const mcLoginReply = { access_token: ACCESS, expires_in: 86400 }
const profileReply = { id: '069a79f444e94726a5befca90e38aaf5', name: 'Joogiebear' }

const requests = []
let script = []
function scriptedFetch(steps) {
  script = steps.map((s) => (typeof s === 'function' ? s : () => s))
}
async function fakeFetch(reqUrl, init) {
  requests.push({ url: reqUrl, init })
  const step = script.shift()
  if (!step) throw new Error('unexpected request ' + reqUrl)
  const reply = await step(reqUrl, init)
  return { ok: reply.status < 300, status: reply.status, json: async () => reply.json ?? {} }
}

const timers = []
let fakeNow = 1_700_000_000_000
login.setLoginHooks({
  fetchImpl: fakeFetch,
  now: () => fakeNow,
  setTimer: (fn, ms) => { const t = { fn, ms, at: fakeNow + ms }; timers.push(t); return t },
  clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1) },
})
function advance(ms) {
  fakeNow += ms
  for (const t of timers.filter((x) => x.at <= fakeNow)) {
    timers.splice(timers.indexOf(t), 1)
    t.fn()
  }
}

// --- helpers ------------------------------------------------------------------------------

const origin = () => url.replace(/\/$/, '')
const api = (p, init = {}) => fetch(url + 'api/client/' + p, { ...init, headers: { origin: origin(), 'content-type': 'application/json', ...(init.headers ?? {}) } })
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body ?? {}) })

// Opens the login stream and collects its events; resolves `first` on the first event and
// `done` when the stream ends.
async function openStream(loginId) {
  const res = await fetch(url + `api/client/accounts/login/${loginId}/stream`, { headers: { origin: origin() } })
  const events = []
  let resolveFirst
  const first = new Promise((r) => { resolveFirst = r })
  const reader = res.body.getReader()
  const done = (async () => {
    let buf = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf += Buffer.from(value).toString('utf8')
      let at
      while ((at = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, at)
        buf = buf.slice(at + 2)
        if (chunk.startsWith('data: ')) {
          const ev = JSON.parse(chunk.slice(6))
          events.push(ev)
          if (events.length === 1) resolveFirst(ev)
        }
      }
    }
    return events
  })().catch(() => events)
  return { res, events, first, done, close: () => reader.cancel() }
}

function callback(query, extra = {}) {
  // a top-level navigation: Host only, no Origin, never followed
  return fetch(url + 'api/client/accounts/login/callback?' + new URLSearchParams(query), { redirect: 'manual', ...extra })
}

function rawRequest(method, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject)
    req.end()
  })
}

function stateOf(authorizeUrl) {
  return new URL(authorizeUrl).searchParams.get('state')
}

// --- tests --------------------------------------------------------------------------------

test('every accounts route refuses a foreign origin and a non-loopback host', async () => {
  const foreign = { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' }
  const routes = [
    ['GET', 'accounts'],
    ['POST', 'accounts/offline', { name: 'Evil' }],
    ['POST', 'accounts/default', { uuid: null }],
    ['POST', 'accounts/login'],
    ['DELETE', 'accounts/login/' + 'a'.repeat(32)],
    ['GET', 'accounts/login/' + 'a'.repeat(32) + '/stream'],
    ['DELETE', 'accounts/' + '0'.repeat(32)],
    ['GET', 'accounts/login/callback?state=x&code=y'],
  ]
  for (const [method, p, body] of routes) {
    const res = await fetch(url + 'api/client/' + p, { method, headers: foreign, body: body ? JSON.stringify(body) : undefined })
    assert.equal(res.status, 403, `${method} ${p}`)
    // fetch will not send a foreign Host header; a raw request does (DNS rebinding looks like this)
    const bad = await rawRequest(method, '/api/client/' + p, { host: 'panel.example:' + port })
    assert.equal(bad.status, 403, `${method} ${p} with a foreign host`)
  }
  // the callback too: a page on another port cannot even hit it with a fetch
  const cb = await fetch(url + 'api/client/accounts/login/callback?state=x&code=y', { headers: { origin: 'http://127.0.0.1:1' } })
  assert.equal(cb.status, 403)
  assert.equal(auth.loadAccounts().length, 0)
})

test('the list, offline accounts, the default and sign-out', async () => {
  let res = await api('accounts')
  assert.deepEqual(await res.json(), { accounts: [], defaultAccount: null })

  res = await post('accounts/offline', { name: 'Tester_1' })
  assert.equal(res.status, 200)
  const added = await res.json()
  assert.deepEqual(added.account, { name: 'Tester_1', uuid: auth.offlineUuid('Tester_1'), type: 'offline', expiresAt: null, refreshFailedAt: null })
  // the first account becomes the default
  assert.equal(added.defaultAccount, added.account.uuid)

  res = await post('accounts/offline', { name: 'bad name!' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /3 to 16 letters/)

  res = await post('accounts/offline', { name: 'Second' })
  const second = (await res.json()).account
  res = await api('accounts')
  const listed = await res.json()
  assert.deepEqual(listed.accounts.map((a) => a.name), ['Tester_1', 'Second'])
  assert.equal(listed.defaultAccount, added.account.uuid, 'a second account does not take the default')

  res = await post('accounts/default', { uuid: second.uuid })
  assert.deepEqual(await res.json(), { defaultAccount: second.uuid })
  res = await post('accounts/default', { uuid: '11111111-1111-1111-1111-111111111111' })
  assert.equal(res.status, 400)
  res = await post('accounts/default', { uuid: 'Tester_1' })
  assert.equal(res.status, 400, 'the default is set by uuid, not by name')
  res = await post('accounts/default', { uuid: null })
  assert.deepEqual(await res.json(), { defaultAccount: null })
  res = await post('accounts/default', { uuid: second.uuid })

  // signing out the default clears it; an unknown uuid is a 404
  res = await api('accounts/' + second.uuid, { method: 'DELETE' })
  assert.equal(res.status, 200)
  const removed = await res.json()
  assert.equal(removed.removed.name, 'Second')
  assert.equal(removed.defaultAccount, null)
  assert.equal(client.loadProfiles().defaultAccount, undefined, 'the dangling default is gone from profiles.json')
  res = await api('accounts/' + second.uuid, { method: 'DELETE' })
  assert.equal(res.status, 404)
  res = await api('accounts/' + added.account.uuid, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(auth.loadAccounts(), [])
})

test('a full sign-in: stream first, authorize URL, callback answered before Microsoft replies, account saved, stream done', async () => {
  requests.length = 0
  let releaseToken
  const tokenHeld = new Promise((r) => { releaseToken = r })
  let tokenAsked = false
  scriptedFetch([
    async (reqUrl, init) => {
      assert.equal(reqUrl, TOKEN_URL)
      tokenAsked = true
      await tokenHeld
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('code'), 'the-code')
      assert.equal(body.get('redirect_uri'), `http://localhost:${port}/api/client/accounts/login/callback`)
      assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/)
      return { status: 200, json: tokenReply }
    },
    { status: 200, json: xblReply },
    { status: 200, json: xstsReply },
    { status: 200, json: mcLoginReply },
    { status: 200, json: profileReply },
  ])

  let res = await post('accounts/login')
  assert.equal(res.status, 200)
  const { loginId, authorizeUrl, ...rest } = await res.json()
  assert.deepEqual(rest, {}, 'the answer is the id and the URL, nothing else')
  assert.match(loginId, /^[0-9a-f]{32}$/)
  const q = new URL(authorizeUrl).searchParams
  assert.equal(q.get('client_id'), MSA_CLIENT_ID)
  assert.equal(q.get('redirect_uri'), `http://localhost:${port}/api/client/accounts/login/callback`)
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('prompt'), 'select_account')
  assert.equal(q.get('scope'), 'XboxLive.signin offline_access')
  const state = q.get('state')

  const stream = await openStream(loginId)
  assert.equal(stream.res.status, 200)
  assert.equal(stream.res.headers.get('content-type'), 'text/event-stream')
  assert.deepEqual(await stream.first, { status: 'pending' })

  // Microsoft redirects the window: the panel answers before it has even asked for the token
  const cb = await callback({ code: 'the-code', state })
  assert.equal(cb.status, 200)
  assert.match(cb.headers.get('content-type'), /text\/html/)
  assert.match(cb.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(cb.headers.get('cache-control'), 'no-store')
  const page = await cb.text()
  assert.match(page, /Finishing the sign-in in SpawnLoft/)
  assert.ok(!/<script/i.test(page))
  assert.ok(!page.includes('the-code') && !page.includes(state))
  for (let i = 0; i < 100 && stream.events.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stream.events, [{ status: 'pending' }, { status: 'finishing' }], 'only that the state was used')
  // the exchange was started, not finished
  for (let i = 0; i < 100 && !tokenAsked; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(tokenAsked, true)
  assert.equal(auth.loadAccounts().length, 0)

  // a replay of the same callback is refused from the moment the state was consumed
  const replay = await callback({ code: 'the-code', state })
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /not valid any more/)

  releaseToken()
  const events = await stream.done
  assert.deepEqual(events, [
    { status: 'pending' },
    { status: 'finishing' },
    { status: 'done', account: { name: 'Joogiebear', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', type: 'microsoft', expiresAt: new Date(fakeNow + 86400 * 1000).toISOString(), refreshFailedAt: null } },
  ])
  const saved = auth.loadAccounts()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].accessToken, ACCESS)
  assert.equal(saved[0].refreshToken, REFRESH)
  if (process.platform !== 'win32') assert.equal(fs.statSync(ACCOUNTS_FILE).mode & 0o777, 0o600)
  assert.equal(client.getDefaultAccount(), saved[0].uuid, 'the first signed-in account is the default')
  assert.equal(login.liveLoginCount(), 0, 'the record is gone once the chain ended')

  // the stream of a finished sign-in is a 404, so is a late cancel
  res = await fetch(url + `api/client/accounts/login/${loginId}/stream`, { headers: { origin: origin() } })
  assert.equal(res.status, 404)
  res = await api(`accounts/login/${loginId}`, { method: 'DELETE' })
  assert.deepEqual(await res.json(), { cancelled: false })

  // the panel log names the account and nothing from the exchange
  const log = fs.existsSync(path.join(LAYOUT.runDir, 'panel.log')) ? fs.readFileSync(path.join(LAYOUT.runDir, 'panel.log'), 'utf8') : ''
  assert.match(log, /signed in Joogiebear/)
  for (const secret of ['the-code', state, ACCESS, REFRESH, 'msa-access', 'code_verifier']) assert.ok(!log.includes(secret), secret)
})

test('a chain that fails after the callback reaches the stream as failed, with the mapped message', async () => {
  scriptedFetch([
    { status: 200, json: tokenReply },
    { status: 200, json: xblReply },
    { status: 401, json: { XErr: 2148916238 } },
  ])
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const stream = await openStream(loginId)
  await stream.first
  const cb = await callback({ code: 'c', state: stateOf(authorizeUrl) })
  assert.equal(cb.status, 200)
  const events = await stream.done
  assert.deepEqual(events.map((e) => e.status), ['pending', 'finishing', 'failed'])
  assert.match(events[2].message, /child account/)
  assert.equal(auth.loadAccounts().length, 1, 'the earlier account is untouched')
  assert.equal(login.liveLoginCount(), 0)

  // an expired code and a lost connection, the same way
  scriptedFetch([{ status: 400, json: { error: 'invalid_grant' } }])
  const second = await (await post('accounts/login')).json()
  const s2 = await openStream(second.loginId)
  await s2.first
  await callback({ code: 'c', state: stateOf(second.authorizeUrl) })
  assert.match((await s2.done)[2].message, /the sign-in expired; try again/)

  scriptedFetch([async () => { throw new TypeError('fetch failed') }])
  const third = await (await post('accounts/login')).json()
  const s3 = await openStream(third.loginId)
  await s3.first
  await callback({ code: 'c', state: stateOf(third.authorizeUrl) })
  assert.match((await s3.done)[2].message, /lost the connection to Microsoft/)
})

test('a wrong, missing or foreign state is a 400 that leaves the live sign-in untouched; Microsoft errors are mapped', async () => {
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const state = stateOf(authorizeUrl)
  const stream = await openStream(loginId)
  await stream.first
  for (const query of [{ code: 'c' }, { code: 'c', state: '' }, { code: 'c', state: 'nope' }, { code: 'c', state: state + 'x' }, { code: 'c', state: state.slice(0, -1) }]) {
    const res = await callback(query)
    assert.equal(res.status, 400, JSON.stringify(query))
    assert.match(await res.text(), /not valid any more/)
  }
  assert.equal(login.liveLoginCount(), 1)
  assert.equal(stream.events.length, 1)

  // the person pressed Cancel on Microsoft's page
  const denied = await callback({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent', state })
  assert.equal(denied.status, 200)
  const events = await stream.done
  assert.deepEqual(events[1], { status: 'failed', message: 'the sign-in was cancelled on Microsoft\'s page' })
  assert.equal(login.liveLoginCount(), 0)

  // another error: Microsoft's first line, trimmed, with no markup of ours around it
  const again = await (await post('accounts/login')).json()
  const s2 = await openStream(again.loginId)
  await s2.first
  await callback({ error: 'server_error', error_description: 'AADSTS90002: Tenant not found\nTrace ID: 1', state: stateOf(again.authorizeUrl) })
  assert.deepEqual((await s2.done)[1], { status: 'failed', message: 'Microsoft refused the sign-in: AADSTS90002: Tenant not found' })
})

test('cancel through DELETE ends the stream and frees the slot', async () => {
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const stream = await openStream(loginId)
  await stream.first
  const res = await api(`accounts/login/${loginId}`, { method: 'DELETE' })
  assert.deepEqual(await res.json(), { cancelled: true })
  const events = await stream.done
  assert.deepEqual(events[1], { status: 'cancelled', message: 'the sign-in was cancelled' })
  assert.equal(login.liveLoginCount(), 0)
  // the state of a cancelled sign-in is worthless
  const late = await callback({ code: 'c', state: stateOf(authorizeUrl) })
  assert.equal(late.status, 400)
})

test('a cancel while Microsoft is still answering keeps the account out of the file', async () => {
  let release
  const held = new Promise((r) => { release = r })
  scriptedFetch([
    async () => { await held; return { status: 200, json: tokenReply } },
    { status: 200, json: xblReply },
    { status: 200, json: xstsReply },
    { status: 200, json: mcLoginReply },
    { status: 200, json: { ...profileReply, id: 'f'.repeat(32), name: 'LateComer' } },
  ])
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const stream = await openStream(loginId)
  await stream.first
  assert.equal((await callback({ code: 'c', state: stateOf(authorizeUrl) })).status, 200)
  assert.deepEqual(await (await api(`accounts/login/${loginId}`, { method: 'DELETE' })).json(), { cancelled: true })
  assert.deepEqual((await stream.done).map((e) => e.status), ['pending', 'finishing', 'cancelled'])
  release()
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!auth.loadAccounts().some((a) => a.name === 'LateComer'))
  const log = fs.readFileSync(path.join(LAYOUT.runDir, 'panel.log'), 'utf8')
  assert.match(log, /finished after it was cancelled/)
  assert.ok(!log.includes('signed in LateComer'))
})

test('a second sign-in is refused while the first has a listener, and replaces an orphan', async () => {
  const first = await (await post('accounts/login')).json()
  const stream = await openStream(first.loginId)
  await stream.first
  const busy = await post('accounts/login')
  assert.equal(busy.status, 409)
  assert.match((await busy.json()).error, /already open in another window/)

  // the launcher tab closes: the stream drops, and 10 s later so does the record
  const closedAt = fakeNow
  await stream.close()
  await new Promise((r) => setTimeout(r, 30))
  advance(9_000)
  assert.equal(login.liveLoginCount(), 1)
  advance(1_000)
  assert.equal(login.liveLoginCount(), 0, `dropped at ${fakeNow - closedAt} ms`)
  const late = await callback({ code: 'c', state: stateOf(first.authorizeUrl) })
  assert.equal(late.status, 400)

  // a record nobody ever listened to is replaced by the next POST straight away
  const orphan = await (await post('accounts/login')).json()
  const replacing = await post('accounts/login')
  assert.equal(replacing.status, 200)
  const replacement = await replacing.json()
  assert.notEqual(replacement.loginId, orphan.loginId)
  assert.equal(login.liveLoginCount(), 1)
  const orphanCb = await callback({ code: 'c', state: stateOf(orphan.authorizeUrl) })
  assert.equal(orphanCb.status, 400)
  assert.equal((await fetch(url + `api/client/accounts/login/${orphan.loginId}/stream`, { headers: { origin: origin() } })).status, 404)
  await api(`accounts/login/${replacement.loginId}`, { method: 'DELETE' })
})

test('a sign-in expires 10 minutes after it was made even with a live stream', async () => {
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const stream = await openStream(loginId)
  await stream.first
  advance(9 * 60 * 1000)
  assert.equal(login.liveLoginCount(), 1)
  advance(60 * 1000)
  const events = await stream.done
  assert.match(events[1].message, /longer than 10 minutes/)
  assert.equal(events[1].status, 'failed')
  assert.equal((await callback({ code: 'c', state: stateOf(authorizeUrl) })).status, 400)
})

test('the stream and the cancel of an unknown or malformed id are 404', async () => {
  for (const id of ['zz', 'a'.repeat(31), '../x', 'A'.repeat(32)]) {
    const res = await fetch(url + `api/client/accounts/login/${encodeURIComponent(id)}/stream`, { headers: { origin: origin() } })
    assert.equal(res.status, 404, id)
  }
  const res = await fetch(url + `api/client/accounts/login/${'b'.repeat(32)}/stream`, { headers: { origin: origin() } })
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /start it again/)
})

test('no token, code, verifier or state leaves the panel through any client route', async () => {
  // a signed-in account with known token strings, a profile that names it, and a live sign-in
  const far = new Date(fakeNow + 86400000).toISOString()
  auth.saveAccounts([{ type: 'microsoft', name: 'Joogiebear', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', accessToken: ACCESS, refreshToken: REFRESH, expiresAt: far, xuid: '2535', userType: 'msa', clientId: MSA_CLIENT_ID }])
  client.createProfile('leaky', { mc: '1.21.11', account: 'Joogiebear' })
  const { loginId, authorizeUrl } = await (await post('accounts/login')).json()
  const state = stateOf(authorizeUrl)
  const forbidden = [ACCESS, REFRESH, 'accessToken', 'refreshToken', 'device_code', 'verifier', 'code_verifier']
  const bodies = []
  for (const p of ['accounts', 'profiles', 'profiles/leaky/status']) {
    const res = await api(p)
    assert.equal(res.status, 200, p)
    bodies.push([p, await res.text()])
  }
  bodies.push(['offline', await (await post('accounts/offline', { name: 'Walker' })).text()])
  bodies.push(['default', await (await post('accounts/default', { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' })).text()])
  bodies.push(['login', JSON.stringify({ loginId, authorizeUrl })])
  bodies.push(['cancel', await (await api(`accounts/login/${loginId}`, { method: 'DELETE' })).text()])
  bodies.push(['callback', await (await callback({ code: 'c', state })).text()])
  for (const [p, text] of bodies) {
    for (const bad of forbidden) assert.ok(!text.includes(bad), `${p} carries ${bad}`)
    // the state is only in the authorize URL the page hands to the window
    if (p !== 'login') assert.ok(!text.includes(state), `${p} carries the state`)
  }
  // the whole JSON of the list, key by key
  const walk = (v) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!/token|device_code|verifier/i.test(k), k); walk(x) }
  }
  walk(JSON.parse(bodies[0][1]))
  assert.equal(JSON.parse(bodies[0][1]).accounts[0].expiresAt, far)
  client.removeProfile('leaky', { purge: true })
  auth.saveAccounts([])
})

test('a sign-in with a profiles registry from before the launcher reads and writes cleanly', async () => {
  // profiles.json without a defaultAccount, the file as 1.5 wrote it
  client.saveProfiles({ version: 1, profiles: {} })
  assert.equal(client.getDefaultAccount(), null)
  auth.saveAccounts([{ type: 'microsoft', name: 'Older', uuid: crypto.randomUUID(), accessToken: 'a', refreshToken: 'r', expiresAt: new Date(fakeNow + 86400000).toISOString() }])
  const res = await api('accounts')
  const body = await res.json()
  assert.equal(body.accounts[0].type, 'microsoft')
  assert.equal(body.defaultAccount, null, 'nothing is made default behind the person\'s back')
  auth.saveAccounts([])
})
