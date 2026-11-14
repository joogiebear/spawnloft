import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// every path is redirected before importing the core, so the key made here is never the real one
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-panel-auth-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const auth = await import('../src/panel-auth.mjs')
const { serve } = await import('../src/ui.mjs')
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'contracts', 'panel-auth.json'), 'utf8'))
const key = Buffer.from(fixture.key, 'base64url')

const servers = []
after(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

// ---- the shared fixture (the Rust side runs the same file) -----------------------------------

test('the constants are the fixture\'s', () => {
  assert.equal(auth.LOGIN_TTL_MS, fixture.loginTtlMs)
  assert.equal(auth.API_TTL_MS, fixture.apiTtlMs)
  assert.equal(auth.FUTURE_LEEWAY_MS, fixture.futureLeewayMs)
  assert.equal(auth.SESSION_IDLE_MS, fixture.sessionIdleMs)
  assert.deepEqual([...auth.OPEN_ROUTES], fixture.openRoutes)
  assert.equal(auth.cookieName(fixture.port), fixture.cookie)
})

test('tokens are made exactly as the fixture spells them', () => {
  for (const t of fixture.mint) {
    assert.equal(auth.makeToken(key, t.purpose, t.port, { now: t.issued, nonce: t.nonce }), t.token, t.name)
    assert.equal(fixture.tokens[t.name], t.token)
  }
  // a login token made without a nonce gets a fresh one each time
  const a = auth.makeToken(key, 'login', 1, { now: 5 })
  const b = auth.makeToken(key, 'login', 1, { now: 5 })
  assert.notEqual(a, b)
  assert.match(a, /^v1\.login\.1\.5\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
  assert.match(auth.makeToken(key, 'api', 1, { now: 5 }), /^v1\.api\.1\.5\.\.[A-Za-z0-9_-]{43}$/)
})

test('single tokens are accepted and refused as the fixture says', () => {
  for (const c of fixture.checks) {
    const got = auth.checkToken(key, c.token, { purpose: c.purpose, port: c.port, now: c.now, started: c.started })
    assert.equal(got.ok, c.ok, c.name)
  }
})

function fill(text, sessions) {
  return text
    .replace(/\{token:([\w-]+)\}/g, (_, name) => fixture.tokens[name] ?? assert.fail(`no token ${name}`))
    .replace(/\{session:([\w-]+)\}/g, (_, name) => sessions[name] ?? assert.fail(`no session ${name}`))
}

test('whole requests are answered as the fixture says', () => {
  for (const scenario of fixture.scenarios) {
    const rule = new auth.PanelAuth({ key, port: fixture.port, started: fixture.started })
    const sessions = {}
    for (const step of scenario.steps) {
      const what = `${scenario.name}: ${step.name}`
      const got = rule.decide(
        { method: step.method, target: fill(step.target, sessions), headers: step.headers.map(([k, v]) => [k, fill(v, sessions)]) },
        { now: step.now, idleNow: step.now },
      )
      const said = got.kind === 'unauthorized' ? `unauthorized-${got.api ? 'api' : 'page'}` : got.kind
      assert.equal(said, step.expect, what)
      assert.ok(fixture.expectations.includes(said), what)
      if (got.kind === 'login') {
        assert.equal(got.to, step.to, what)
        assert.match(got.session, /^[A-Za-z0-9_-]{43}$/, what)
        sessions[step.save] = got.session
      }
      if (got.kind === 'allow') rule.release(got.session, step.now)
    }
  }
})

// ---- what the fixture cannot say ------------------------------------------------------------

test('a session with an open request does not idle out, and does once it closed', () => {
  const rule = new auth.PanelAuth({ key, port: 9, started: 0 })
  const login = rule.decide({ method: 'GET', target: `/auth?t=${auth.makeToken(key, 'login', 9, { now: 1 })}`, headers: [['host', 'localhost:9']] }, { now: 1, idleNow: 0 })
  const req = (idleNow) => rule.decide({ method: 'GET', target: '/api/x', headers: [['host', 'localhost:9'], ['cookie', `spawnloft_9=${login.session}`]] }, { now: 1, idleNow })
  const stream = req(0)
  assert.equal(stream.kind, 'allow')
  // an event stream held open for a day: no new request, but the page is plainly there
  const day = 24 * 3600 * 1000
  const poll = req(day)
  assert.equal(poll.kind, 'allow')
  rule.release(poll.session, day)
  rule.release(stream.session, day + 1000)
  assert.equal(req(day + 1000 + auth.SESSION_IDLE_MS).kind, 'allow')
  rule.release(stream.session, day + 1000 + auth.SESSION_IDLE_MS)
  assert.equal(req(day + 1001 + 2 * auth.SESSION_IDLE_MS).kind, 'unauthorized')
  // a release for a session that is gone, or for a token caller, is nothing
  rule.release(stream.session, 0)
  rule.release(null, 0)
})

test('used login nonces are forgotten once their token has expired anyway', () => {
  const rule = new auth.PanelAuth({ key, port: 9, started: 0 })
  const link = (now, nonce) => ({ method: 'GET', target: `/auth?t=${auth.makeToken(key, 'login', 9, { now, nonce })}`, headers: [['host', 'localhost:9']] })
  const go = (now, idleNow, nonce) => rule.decide(link(now, nonce), { now, idleNow })
  assert.equal(go(1000, 0, 'A'.repeat(22)).kind, 'login')
  assert.equal(rule.used.size, 1)
  const later = 1000 + auth.LOGIN_TTL_MS + auth.FUTURE_LEEWAY_MS + 1
  // the wall clock alone jumping ahead forgets nothing: it can jump back
  assert.equal(go(later, 0, 'B'.repeat(22)).kind, 'login')
  assert.equal(rule.used.size, 2)
  assert.equal(rule.decide(link(1000, 'A'.repeat(22)), { now: 1001, idleNow: 0 }).kind, 'login-refused')
  // once this process has also lived that long, it does
  assert.equal(go(later, auth.LOGIN_TTL_MS + auth.FUTURE_LEEWAY_MS + 1, 'C'.repeat(22)).kind, 'login')
  assert.deepEqual([...rule.used.keys()].sort(), ['B'.repeat(22), 'C'.repeat(22)])
})

test('sessions are kept under a hash, never under their id', () => {
  const rule = new auth.PanelAuth({ key, port: 9, started: 0 })
  const id = rule.newSession(0)
  assert.ok(![...rule.sessions.keys()].includes(id))
  assert.match([...rule.sessions.keys()][0], /^[0-9a-f]{64}$/)
})

// ---- the key file ----------------------------------------------------------------------------

test('the key file is made once, owner-only, and read back', () => {
  const file = auth.keyFile()
  assert.equal(file, path.join(scratch, 'config', 'spawnloft', 'panel.key'))
  fs.rmSync(file, { force: true })
  const first = auth.loadKey()
  assert.equal(first.length, 32)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^[A-Za-z0-9_-]{43}\n$/)
  assert.deepEqual(Buffer.from(text.trim(), 'base64url'), first)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(auth.loadKey(), first)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp')), [], 'no temporary file is left')
})

test('several first starters end with one key', () => {
  const config = path.join(scratch, 'race')
  const script = `const a = await import(${JSON.stringify(new URL('../src/panel-auth.mjs', import.meta.url).href)}); process.stdout.write(a.loadKey().toString('hex'))`
  const env = { ...process.env, APPDATA: config, XDG_CONFIG_HOME: config }
  // started together, each sees no file; exactly one hard link wins
  const runs = Array.from({ length: 8 }, () => import('node:child_process').then(({ spawn }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))))
  })))
  return Promise.all(runs).then((keys) => {
    assert.equal(new Set(keys).size, 1, 'every starter read the same key')
    assert.match(keys[0], /^[0-9a-f]{64}$/)
    assert.deepEqual(fs.readdirSync(path.join(config, 'spawnloft')), ['panel.key'])
  })
})

test('a key file that already exists is never replaced', () => {
  const config = path.join(scratch, 'kept')
  fs.mkdirSync(path.join(config, 'spawnloft'), { recursive: true })
  const mine = Buffer.alloc(32, 7).toString('base64url')
  fs.writeFileSync(path.join(config, 'spawnloft', 'panel.key'), `${mine}\n`)
  const script = `const a = await import(${JSON.stringify(new URL('../src/panel-auth.mjs', import.meta.url).href)}); process.stdout.write(a.loadKey().toString('base64url'))`
  const run = (dir) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APPDATA: dir, XDG_CONFIG_HOME: dir }, encoding: 'utf8' })
  assert.equal(run(config).stdout, mine)
  if (process.platform !== 'win32') {
    // it was written readable by others here, as a restore or a copy can leave it
    assert.equal(fs.statSync(path.join(config, 'spawnloft', 'panel.key')).mode & 0o777, 0o600, 'made private again before use')
    // a link in its place is not followed
    const linked = path.join(scratch, 'linked')
    fs.mkdirSync(path.join(linked, 'spawnloft'), { recursive: true })
    fs.symlinkSync(path.join(config, 'spawnloft', 'panel.key'), path.join(linked, 'spawnloft', 'panel.key'))
    const res = run(linked)
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /panel\.key \(it is not a plain file/)
  }

  // a damaged one is reported, with its path, and left as it is
  const bad = path.join(scratch, 'damaged')
  fs.mkdirSync(path.join(bad, 'spawnloft'), { recursive: true })
  fs.writeFileSync(path.join(bad, 'spawnloft', 'panel.key'), 'not a key\n')
  const res = run(bad)
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /panel\.key is damaged; delete the file/)
  assert.equal(fs.readFileSync(path.join(bad, 'spawnloft', 'panel.key'), 'utf8'), 'not a key\n')
})

// ---- a real panel -------------------------------------------------------------------------------

async function panel(port = 0) {
  const p = await serve({ port, open: false })
  servers.push(p.server)
  return p
}
const closeNow = async (p) => {
  p.server.closeAllConnections()
  await new Promise((resolve) => p.server.close(resolve))
  servers.splice(servers.indexOf(p.server), 1)
}

test('a panel answers nobody without a credential', async () => {
  const p = await panel()
  for (const route of ['api/instances', 'api/settings', 'api/client/launcher', 'api/setup', 'api/nothing']) {
    const res = await fetch(p.url + route)
    assert.equal(res.status, 401, route)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    assert.equal(body.code, 'auth')
    assert.match(body.error, /spawnloft ui/)
  }
  const write = await fetch(p.url + 'api/appearance', { method: 'POST', headers: { 'content-type': 'application/json', origin: p.url.slice(0, -1) }, body: '{"theme":"spawnloft"}' })
  assert.equal(write.status, 401)
  for (const route of ['', 'launcher', 'setup', 'anything']) {
    const res = await fetch(p.url + route)
    assert.equal(res.status, 401, `/${route}`)
    assert.match(res.headers.get('content-type'), /^text\/html/)
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
    const html = await res.text()
    assert.match(html, /Open SpawnLoft from the app, or run <code>spawnloft ui<\/code>/)
    assert.doesNotMatch(html, /<script/i)
  }
  // the rule that was there before still comes first
  assert.equal((await fetch(p.url + 'api/instances', { headers: { origin: 'http://127.0.0.1:1', authorization: p.auth.apiToken() } })).status, 403)
})

test('an api token in the header opens the API, for its own port only', async () => {
  const p = await panel()
  const other = await panel()
  const header = { authorization: `SpawnLoft ${p.auth.apiToken()}` }
  assert.equal((await fetch(p.url + 'api/instances', { headers: header })).status, 200)
  assert.equal((await fetch(p.url, { headers: header })).status, 200)
  assert.equal((await fetch(other.url + 'api/instances', { headers: header })).status, 401)
  // what any caller that can read the key file sends
  assert.equal((await fetch(other.url + 'api/instances', { headers: { authorization: auth.apiAuthorization(other.port) } })).status, 200)
  // the key itself is not a credential
  const raw = fs.readFileSync(auth.keyFile(), 'utf8').trim()
  for (const value of [`SpawnLoft ${raw}`, `Bearer ${raw}`, raw]) {
    assert.equal((await fetch(p.url + 'api/instances', { headers: { authorization: value } })).status, 401)
  }
  assert.equal((await fetch(p.url + 'api/instances', { headers: { cookie: `spawnloft_${p.port}=${raw}` } })).status, 401)
})

test('a login link signs a browser in once, with a cookie only that panel takes', async () => {
  const p = await panel()
  const other = await panel()
  const link = p.auth.loginUrl()
  assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${p.port}/auth\\?t=v1\\.login\\.${p.port}\\.`))
  // on the wrong panel it is refused, and not spent
  assert.equal((await fetch(link.replace(`:${p.port}/`, `:${other.port}/`))).status, 401)
  const res = await fetch(link, { redirect: 'manual' })
  assert.equal(res.status, 200, 'a page with a refresh, not a redirect')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const html = await res.text()
  assert.match(html, /<meta http-equiv="refresh" content="0; url=\/">/)
  assert.doesNotMatch(html, /<script/i)
  const set = res.headers.get('set-cookie')
  const m = new RegExp(`^spawnloft_${p.port}=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Strict; Path=/$`).exec(set)
  assert.ok(m, set)
  const cookie = `spawnloft_${p.port}=${m[1]}`
  assert.equal((await fetch(p.url + 'api/instances', { headers: { cookie } })).status, 200)
  assert.match(await (await fetch(p.url, { headers: { cookie } })).text(), /<html lang="en" data-theme=/)
  // as a page on another loopback port would send it: the cookie rides along, the request is refused
  assert.equal((await fetch(p.url + 'api/instances', { headers: { cookie, 'sec-fetch-site': 'same-site' } })).status, 403)
  // the link again; the session on the other panel
  const again = await fetch(link)
  assert.equal(again.status, 401)
  assert.equal(again.headers.get('set-cookie'), null)
  assert.equal((await fetch(other.url + 'api/instances', { headers: { cookie: `spawnloft_${other.port}=${m[1]}` } })).status, 401)
  // to the launcher
  assert.match(await (await fetch(p.auth.loginUrl('/launcher'))).text(), /content="0; url=\/launcher"/)
  assert.match(await (await fetch(p.auth.loginUrl('https://evil.example/'))).text(), /content="0; url=\/"/)
})

test('nothing made for a panel works on the one that takes its port next', async () => {
  const first = await panel()
  const port = first.port
  const link = first.auth.loginUrl()
  const header = { authorization: `SpawnLoft ${first.auth.apiToken()}` }
  const signedIn = await fetch(first.auth.loginUrl())
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(first.url + 'api/instances', { headers: { cookie } })).status, 200)
  await closeNow(first)
  await new Promise((r) => setTimeout(r, 20))
  const second = await panel(port)
  assert.equal(second.port, port)
  assert.equal((await fetch(link)).status, 401, 'the unused login link')
  assert.equal((await fetch(second.url + 'api/instances', { headers: header })).status, 401, 'the api token')
  assert.equal((await fetch(second.url + 'api/instances', { headers: { cookie } })).status, 401, 'the session')
  assert.equal((await fetch(second.url + 'api/instances', { headers: { authorization: `SpawnLoft ${second.auth.apiToken()}` } })).status, 200)
})

test('the Microsoft sign-in callback needs no credential, and gives nothing away', async () => {
  const p = await panel()
  const res = await fetch(p.url + 'api/client/accounts/login/callback?code=x&state=nope')
  assert.equal(res.status, 400)
  assert.match(await res.text(), /not valid any more/)
  assert.equal((await fetch(p.url + 'api/client/accounts/login/callback?code=x&state=nope', { method: 'POST' })).status, 401)
})

test('a panel proves itself to a caller that holds the key, and to nobody else', async () => {
  const p = await panel()
  const nonce = auth.probeNonce()
  const signed = await fetch(p.url + 'api/client/launcher', { headers: { authorization: auth.apiAuthorization(p.port), [auth.PROBE_HEADER]: nonce } })
  assert.equal(signed.status, 200)
  const proof = signed.headers.get(auth.PROOF_HEADER)
  assert.ok(auth.proofMatches(auth.loadKey(), nonce, proof))
  assert.ok(!auth.proofMatches(auth.loadKey(), auth.probeNonce(), proof), 'for that nonce only')
  assert.ok(!auth.proofMatches(Buffer.alloc(32, 1), nonce, proof), 'with that key only')
  // what is signed can never be a token: not the text, and nothing but a nonce is signed
  assert.equal(auth.probeProof(key, `v1.api.${p.port}.1.`), null)
  assert.equal(auth.probeProof(key, ''), null)
  assert.ok(!auth.proofMatches(key, nonce, null))
  // no proof for a caller without a credential, or for a malformed or repeated nonce
  assert.equal((await fetch(p.url + 'api/client/launcher', { headers: { [auth.PROBE_HEADER]: nonce } })).headers.get(auth.PROOF_HEADER), null)
  const bad = await fetch(p.url + 'api/client/launcher', { headers: { authorization: auth.apiAuthorization(p.port), [auth.PROBE_HEADER]: 'x' } })
  assert.equal(bad.status, 200)
  assert.equal(bad.headers.get(auth.PROOF_HEADER), null)
})

test('a session is released when its connection drops with requests still queued', async () => {
  const p = await panel()
  const signedIn = await fetch(p.auth.loginUrl())
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  const state = [...p.auth.sessions.values()][0]
  assert.equal(state.active, 0)
  // one request that stays open (an event stream), and more queued behind it on the connection
  const net = await import('node:net')
  const socket = net.connect(p.port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  const one = (route) => `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nCookie: ${cookie}\r\n\r\n`
  socket.write(one('/api/jobs/any/stream') + one('/api/instances').repeat(4))
  const until = async (cond, what) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(cond(), what)
  }
  await until(() => state.active >= 1, 'the open request holds the session')
  await new Promise((r) => setTimeout(r, 100))
  socket.destroy()
  await until(() => state.active === 0, `every request let go of the session (${state.active} still held)`)
})

// ---- the command line ---------------------------------------------------------------------------

// `spawnloft ui` as a process, until `stop()`; resolves once it printed its address
function cliPanel(args, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'mcctl.mjs'), 'ui', '--port', '0', ...args], {
    env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  const stop = () => new Promise((resolve) => { child.once('close', resolve); child.kill() })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no address from spawnloft ui: ${out}`)) }, 30000)
    child.stderr.on('data', (c) => { out += c })
    child.stdout.on('data', (c) => {
      out += c
      // the last line it prints about itself
      if (!/Ctrl\+C to stop the panel/.test(out)) return
      clearTimeout(timer)
      resolve({ out, stop })
    })
    child.once('error', reject)
  })
}

test('spawnloft ui prints a link that signs a browser in, and never the key', async () => {
  const p = await cliPanel(['--no-open'])
  try {
    const url = /^SpawnLoft panel: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(p.out)?.[1]
    assert.ok(url, p.out)
    const link = /^\s+(http:\/\/127\.0\.0\.1:\d+\/auth\?t=v1\.login\.\S+)$/m.exec(p.out)?.[1]
    assert.ok(link && link.startsWith(url), p.out)
    assert.ok(!p.out.includes(fs.readFileSync(auth.keyFile(), 'utf8').trim()))
    assert.equal((await fetch(url + 'api/instances')).status, 401)
    const signedIn = await fetch(link)
    assert.equal(signedIn.status, 200)
    const cookie = signedIn.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(url + 'api/instances', { headers: { cookie } })).status, 200)
    assert.equal((await fetch(link)).status, 401)
  } finally {
    await p.stop()
  }
})

test('the panel behind the desktop window prints no link', async () => {
  // what spawnloft-core's proxy starts; it signs its own requests with the key it can read
  const p = await cliPanel(['--no-open', '--exit-with-stdin'])
  try {
    assert.match(p.out, /^SpawnLoft panel: http:\/\/127\.0\.0\.1:\d+\/$/m)
    assert.doesNotMatch(p.out, /auth\?t=|v1\.login/)
  } finally {
    await p.stop()
  }
})

test('spawnloft ui --launcher finds this user\'s panel already on the port', async () => {
  const p = await panel()
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, '..', 'mcctl.mjs'), 'ui', '--port', String(p.port), '--launcher', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.once('close', (status) => resolve({ status, out }))
  })
  assert.equal(res.status, 0, res.out)
  const link = /^\s+(http:\/\/127\.0\.0\.1:\d+\/auth\?t=v1\.login\.\S+&to=\/launcher)$/m.exec(res.out)?.[1]
  assert.ok(link, res.out)
  assert.match(await (await fetch(link)).text(), /content="0; url=\/launcher"/)
})

test('in the app, a page that lost its sign-in is sent to get a new one', async () => {
  const { signInPage, AGAIN_PATH } = await import('../src/panel-auth.mjs')
  assert.equal(AGAIN_PATH, '/auth/again')
  // a browser has nobody to ask: the command stays
  const browser = signInPage({ kind: 'unauthorized' }, { path: '/' })
  assert.match(browser, /run <code>spawnloft ui<\/code>/)
  assert.doesNotMatch(browser, /http-equiv/)
  // the window answers a move to AGAIN_PATH, so the page goes there by itself, with where it was
  const app = signInPage({ kind: 'unauthorized' }, { shell: true, path: '/' })
  assert.match(app, /<meta http-equiv="refresh" content="0; url=\/auth\/again">/)
  assert.match(app, /<a href="\/auth\/again">Sign in again<\/a>/)
  assert.match(signInPage({ kind: 'unauthorized' }, { shell: true, path: '/launcher?x=1' }), /url=\/auth\/again\?to=\/launcher"/)
  // nothing from the address is echoed into the page but the two known targets
  assert.doesNotMatch(signInPage({ kind: 'unauthorized' }, { shell: true, path: '/"><script>x</script>' }), /script/)
  // a refused link, or the path itself coming back unanswered, offers the link and does not loop
  assert.doesNotMatch(signInPage({ kind: 'login-refused' }, { shell: true, path: '/auth?t=x' }), /http-equiv/)
  assert.doesNotMatch(signInPage({ kind: 'unauthorized' }, { shell: true, path: '/auth/again?to=/launcher' }), /http-equiv/)
  for (const page of [browser, app]) assert.doesNotMatch(page, /<script/i)
})
