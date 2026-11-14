import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { configDir } from './settings.mjs'
import { protectPrivateFile } from './private-files.mjs'
import { UserError } from './util.mjs'

// Who may use the panel's HTTP API (rust/PANEL-AUTH-DESIGN.md). The same rule is written a second
// time in rust/crates/spawnloft-lib/src/panel_auth.rs for `spawnloft-core ui`; the shared fixture
// test/fixtures/contracts/panel-auth.json holds the two to one behaviour, so change both together.
//
// One key per install signs short tokens. The key itself is never put in a request, a URL, a
// cookie, an environment variable or a log: port 8770 is well known, and whatever a client sends
// there can be collected by another account that bound the port first.
//
//   v1.<purpose>.<port>.<issued ms>.<nonce>.<mac>     mac = HMAC-SHA256(key, everything before it)
//
//   login  one use, 5 minutes; GET /auth?t=<token> swaps it for a session cookie
//   api    60 seconds, no nonce; sent as `Authorization: SpawnLoft <token>` by callers that are not
//          a page (the shell, the proxy in front of this panel, the CLI, tests)
//
// A token names the port of the listener it is for, and a listener refuses one issued before it
// started, so nothing made for another panel, or for an earlier panel on the same port, works.

export const LOGIN_TTL_MS = 5 * 60 * 1000
export const API_TTL_MS = 60 * 1000
// Two processes on one machine read one clock, but not always the same reading of it (V8 on
// Windows keeps its own, a few milliseconds behind), so a token may be this far "in the future".
export const FUTURE_LEEWAY_MS = 2000
// A session with no request and no open connection for this long is forgotten.
export const SESSION_IDLE_MS = 15 * 60 * 1000
export const AUTH_SCHEME = 'SpawnLoft'
export const OPEN_ROUTES = Object.freeze(['/auth', '/api/client/accounts/login/callback'])
const LOGIN_TARGETS = Object.freeze(['/launcher', '/setup'])
const TOKEN_LIMIT = 256

export function keyFile() {
  return path.join(configDir(), 'panel.key')
}

const B64URL = /^[A-Za-z0-9_-]+$/

// 32 bytes from one line of unpadded base64url, or null for anything else
function parseKey(text) {
  const line = String(text).trim()
  if (line.length !== 43 || !B64URL.test(line)) return null
  const key = Buffer.from(line, 'base64url')
  return key.length === 32 && key.toString('base64url') === line ? key : null
}

// A key file that exists must be a plain file of this user. One that others can read (a restore
// or a copy can leave it so) is made private again before it is used. On Windows the ACL is set
// when the file is made, and `doctor` checks it.
function checkKeyFile(file) {
  // asked of the runtime, not of process.platform: Windows has no owner ids or modes to read
  if (typeof process.getuid !== 'function') return
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (!stat.isFile()) throw new Error('it is not a plain file; delete it and start the panel again')
  if (stat.uid !== process.getuid()) throw new Error('it belongs to another account; delete it and start the panel again')
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
}

function readKey(file) {
  let text
  try {
    checkKeyFile(file)
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true }
    throw err
  }
  return { key: parseKey(text) }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Makes panel.key if nobody has yet. The key is written to a private temporary file and
// hard-linked to its name, which fails when the name exists: of two first starters (the core and
// this panel, or two test files) one wins and both then read the winner's key. A file system
// without hard links gets an exclusive create instead; a reader that meets the file before its
// line is in waits for it (loadKey).
function createKey(file) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const text = `${crypto.randomBytes(32).toString('base64url')}\n`
  const tmp = path.join(dir, `panel.key.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    writeNew(tmp, text)
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') return
      try {
        writeNew(file, text)
      } catch (second) {
        if (second.code === 'EEXIST') return
        // made here and not usable: do not leave an empty key file behind
        fs.rmSync(file, { force: true })
        throw second
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// created empty and owner-only (on Windows: its own one-user ACL) before the secret goes in
function writeNew(file, text) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    // no key in a file that could not be made private
    const made = protectPrivateFile(file)
    if (!made.ok) throw new Error(`could not make ${file} private: ${made.reason}`)
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// The install's key, made on first need. Always read back from the file, never taken from what
// this process just wrote, so every starter ends with the same one.
export function loadKey() {
  const file = keyFile()
  const deadline = Date.now() + 2000
  for (;;) {
    let found
    try {
      found = readKey(file)
      if (found.missing) {
        createKey(file)
        found = readKey(file)
      }
    } catch (err) {
      throw new UserError(`could not read or create the panel key ${file} (${err.message})`)
    }
    if (found.key) return found.key
    if (Date.now() > deadline) {
      throw new UserError(`the panel key ${file} is damaged; delete the file and start the panel again`)
    }
    pause(50)
  }
}

function mac(key, body) {
  return crypto.createHmac('sha256', key).update(body).digest()
}

export function makeToken(key, purpose, port, { now = Date.now(), nonce } = {}) {
  const n = purpose === 'login' ? (nonce ?? crypto.randomBytes(16).toString('base64url')) : ''
  const body = `v1.${purpose}.${port}.${now}.${n}`
  return `${body}.${mac(key, body).toString('base64url')}`
}

// { ok: true, issued, nonce } or { ok: false }. `started` is when the listener began (ms).
export function checkToken(key, token, { purpose, port, now, started }) {
  const no = { ok: false }
  if (typeof token !== 'string' || token.length > TOKEN_LIMIT) return no
  const parts = token.split('.')
  if (parts.length !== 6 || parts[0] !== 'v1' || parts[1] !== purpose) return no
  if (purpose !== 'login' && purpose !== 'api') return no
  if (!/^[1-9]\d{0,4}$/.test(parts[2]) || Number(parts[2]) !== port) return no
  if (!/^[1-9]\d{0,14}$/.test(parts[3])) return no
  const issued = Number(parts[3])
  const nonce = parts[4]
  if (purpose === 'login' ? !(nonce.length === 22 && B64URL.test(nonce)) : nonce !== '') return no
  if (parts[5].length !== 43 || !B64URL.test(parts[5])) return no
  const given = Buffer.from(parts[5], 'base64url')
  if (given.length !== 32 || given.toString('base64url') !== parts[5]) return no
  const want = mac(key, token.slice(0, token.length - 44))
  if (!crypto.timingSafeEqual(given, want)) return no
  if (issued < started || issued > now + FUTURE_LEEWAY_MS) return no
  if (now - issued > (purpose === 'login' ? LOGIN_TTL_MS : API_TTL_MS)) return no
  return { ok: true, issued, nonce }
}

// { url, nonce }: a one-use link for the panel on `port` of this machine, and the nonce it spends
export function loginLink(key, port, to = null, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('base64url')
  const token = makeToken(key, 'login', port, { now, nonce })
  return { url: `http://127.0.0.1:${port}/auth?t=${token}${LOGIN_TARGETS.includes(to) ? `&to=${to}` : ''}`, nonce }
}

export function cookieName(port) {
  return `spawnloft_${port}`
}

// sessions are kept under a hash of their id, so looking one up compares nothing secret
function sessionKey(id) {
  return crypto.createHash('sha256').update(id).digest('hex')
}

// The request rule of one listener: its key, its port, when it started, its sessions and the
// login tokens already used. `decide` is the whole rule; the server only acts on the answer.
export class PanelAuth {
  constructor({ key, port, started = Date.now() }) {
    this.key = key
    this.port = port
    this.started = started
    this.sessions = new Map() // sessionKey -> { seen (idle clock ms), active (open requests) }
    this.used = new Map() // login nonce -> { issued, spent (idle clock ms) }
  }

  // `headers` is a list of [name, value] pairs as they came. `now` is the wall clock (tokens);
  // `idleNow` is a clock that only runs while this process does (session idle time), so a
  // machine that slept for an hour has not idled a session out.
  //
  // Answers one of
  //   { kind: 'forbidden' }                 not addressed to this panel from this panel (403)
  //   { kind: 'open' }                      a route that carries its own proof; route it
  //   { kind: 'login', session, to, nonce } /auth with a good token: set the cookie, go to `to`
  //   { kind: 'login-refused' }             /auth with a bad, used or expired token (401 page)
  //   { kind: 'allow', session }            route it; `session` goes to release() when it ends
  //   { kind: 'unauthorized', api }         401, JSON for /api/..., the page otherwise
  decide({ method, target, headers }, { now = Date.now(), idleNow = now } = {}) {
    // a clock set back since the start must not lock everyone out until it catches up
    if (now < this.started) this.started = now
    const all = (name) => headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => String(v).trim())
    const hosts = all('host')
    const origins = all('origin')
    const sites = all('sec-fetch-site')
    const auths = all('authorization')
    if (hosts.length !== 1 || origins.length > 1 || sites.length > 1 || auths.length > 1) return { kind: 'forbidden' }
    const host = hosts[0].toLowerCase()
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return { kind: 'forbidden' }
    if (origins.length && origins[0].toLowerCase() !== `http://${host}`) return { kind: 'forbidden' }

    const cut = target.indexOf('?')
    const route = cut < 0 ? target : target.slice(0, cut)
    const query = cut < 0 ? '' : target.slice(cut + 1)
    if (method === 'GET' && route === '/auth') return this.#login(query, now, idleNow)
    if (method === 'GET' && OPEN_ROUTES.includes(route)) return { kind: 'open' }

    if (sites.length && !['same-origin', 'none'].includes(sites[0].toLowerCase())) return { kind: 'forbidden' }

    if (auths.length) {
      const m = /^spawnloft (\S+)$/i.exec(auths[0])
      if (m && checkToken(this.key, m[1], { purpose: 'api', port: this.port, now, started: this.started }).ok) {
        return { kind: 'allow', session: null }
      }
    }
    const name = cookieName(this.port)
    for (const line of all('cookie')) {
      for (const pair of line.split(';')) {
        const eq = pair.indexOf('=')
        if (eq < 0 || pair.slice(0, eq).trim() !== name) continue
        const session = this.#live(pair.slice(eq + 1).trim(), idleNow)
        if (session) return { kind: 'allow', session }
      }
    }
    return { kind: 'unauthorized', api: route.startsWith('/api/') }
  }

  #login(query, now, idleNow) {
    let token = null
    let to = null
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const k = pair.slice(0, eq)
      if (k === 't' && token === null) token = pair.slice(eq + 1)
      if (k === 'to' && to === null) to = pair.slice(eq + 1)
    }
    const checked = checkToken(this.key, token, { purpose: 'login', port: this.port, now, started: this.started })
    if (!checked.ok) return { kind: 'login-refused' }
    // forgotten only when both clocks say the token is long dead: the wall clock alone can be
    // stepped forward and back again, which would make a spent link good a second time
    const keep = LOGIN_TTL_MS + FUTURE_LEEWAY_MS
    for (const [nonce, { issued, spent }] of this.used) {
      if (now - issued > keep && idleNow - spent > keep) this.used.delete(nonce)
    }
    if (this.used.has(checked.nonce)) return { kind: 'login-refused' }
    this.used.set(checked.nonce, { issued: checked.issued, spent: idleNow })
    return { kind: 'login', session: this.newSession(idleNow), to: LOGIN_TARGETS.includes(to) ? to : '/', nonce: checked.nonce }
  }

  newSession(idleNow) {
    const id = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(sessionKey(id), { seen: idleNow, active: 0 })
    return id
  }

  // the session's key when `id` names a live one, which is then in use until release()
  #live(id, idleNow) {
    for (const [key, s] of this.sessions) {
      if (s.active === 0 && idleNow - s.seen > SESSION_IDLE_MS) this.sessions.delete(key)
    }
    if (id.length !== 43 || !B64URL.test(id)) return null
    const key = sessionKey(id)
    const s = this.sessions.get(key)
    if (!s) return null
    s.seen = idleNow
    s.active += 1
    return key
  }

  // the request `decide` allowed on a session has ended (its connection closed)
  release(session, idleNow) {
    const s = session && this.sessions.get(session)
    if (!s) return
    s.active = Math.max(0, s.active - 1)
    s.seen = idleNow
  }

  apiToken(now = Date.now()) {
    return makeToken(this.key, 'api', this.port, { now })
  }

  // a link that signs one browser in, once, within five minutes; `to` is /launcher or /setup
  loginUrl(to = null, now = Date.now()) {
    return loginLink(this.key, this.port, to, now).url
  }
}

// How a caller that holds the key tells this user's panel from anything else that answers on
// the port: it sends a fresh nonce in PROBE_HEADER with a signed request, and only a panel with
// the same key can answer with this in PROOF_HEADER. A token alone proves the caller to the
// panel, not the panel to the caller.
export const PROBE_HEADER = 'x-spawnloft-probe'
export const PROOF_HEADER = 'x-spawnloft-proof'

export function probeNonce() {
  return crypto.randomBytes(16).toString('base64url')
}

// null unless `nonce` is one well-formed nonce; the text signed cannot be a token's
export function probeProof(key, nonce) {
  if (typeof nonce !== 'string' || nonce.length !== 22 || !B64URL.test(nonce)) return null
  return mac(key, `probe.v1.${nonce}`).toString('base64url')
}

export function proofMatches(key, nonce, proof) {
  const want = probeProof(key, nonce)
  if (!want || typeof proof !== 'string' || proof.length !== want.length) return false
  return crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(want))
}

// `Authorization` for a caller that can read the key, for the panel on `port` of this machine
export function apiAuthorization(port) {
  return `${AUTH_SCHEME} ${makeToken(loadKey(), 'api', port)}`
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#bbb}a{color:#9cf}code{color:#eee}'

function page(title, body, extraHead = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${extraHead}<title>${title}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

const pageHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': PAGE_CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

export const UNAUTHORIZED_ERROR = 'this panel needs a sign-in: open SpawnLoft from the app, or run `spawnloft ui` to get a new link'

// What the server sends for each answer of `decide` that ends the request here. Returns true
// when it answered.
//
// `opts.shell` says the panel runs under the desktop window, which can sign a window in again by
// itself: it watches for a move to AGAIN_PATH and answers it with a new one-use link. `opts.path`
// is what was asked for, so a window that was on the launcher comes back to the launcher.
export const AGAIN_PATH = '/auth/again'

export function signInPage(verdict, opts = {}) {
  const title = 'This page is not signed in to SpawnLoft'
  if (!opts.shell) {
    return page(title, 'Open SpawnLoft from the app, or run <code>spawnloft ui</code> to get a new link.')
  }
  const path = String(opts.path ?? '').split('?')[0]
  const again = AGAIN_PATH + (LOGIN_TARGETS.includes(path) ? `?to=${path}` : '')
  // A page that was never signed in, or whose sign-in ran out, goes straight through. One whose
  // link was refused does not: going round again by itself would never end.
  const auto = verdict.kind === 'unauthorized' && path !== AGAIN_PATH
  return page(title,
    `SpawnLoft restarted, or this window sat unused for a while. <a href="${again}">Sign in again</a>`,
    auto ? `<meta http-equiv="refresh" content="0; url=${again}">` : '')
}

export function answer(res, verdict, port, opts = {}) {
  if (verdict.kind === 'forbidden') {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'this panel only answers requests addressed to localhost' }))
    return true
  }
  if (verdict.kind === 'login') {
    // a page with a refresh, not a 303: the link is often opened from outside this origin, a
    // redirect would stay that cross-site navigation, and a SameSite=Strict cookie is not sent
    // on one. The refresh starts a new navigation from this page.
    res.writeHead(200, {
      ...pageHeaders,
      'set-cookie': `${cookieName(port)}=${verdict.session}; HttpOnly; SameSite=Strict; Path=/`,
    })
    res.end(page('Opening SpawnLoft', `<a href="${verdict.to}">Continue to SpawnLoft</a>`, `<meta http-equiv="refresh" content="0; url=${verdict.to}">`))
    return true
  }
  if (verdict.kind === 'login-refused' || (verdict.kind === 'unauthorized' && !verdict.api)) {
    res.writeHead(401, { ...pageHeaders, 'www-authenticate': AUTH_SCHEME })
    res.end(signInPage(verdict, opts))
    return true
  }
  if (verdict.kind === 'unauthorized') {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': AUTH_SCHEME })
    res.end(JSON.stringify({ error: UNAUTHORIZED_ERROR, code: 'auth' }))
    return true
  }
  return false
}
