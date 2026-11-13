// Writes test/fixtures/contracts/panel-auth.json: the panel's sign-in rule as data, run by
// test/panel-auth.test.mjs against src/panel-auth.mjs and by `cargo test` against
// rust/crates/spawnloft-lib/src/panel_auth.rs. The tokens need real HMACs, so the file is made
// here, with node:crypto alone and none of the code it tests. Run it again only when the rule
// changes on purpose, and change both implementations in the same commit.
//
//   node tools/make-panel-auth-fixture.mjs
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'contracts', 'panel-auth.json')

// test keys, written here in the open: they sign nothing outside this file
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const otherKey = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i))
const PORT = 8770
const T0 = 1800000000000
const NONCE_A = 'AAAAAAAAAAAAAAAAAAAAAA'
const NONCE_B = 'BBBBBBBBBBBBBBBBBBBBBB'
const NONCE_C = 'CCCCCCCCCCCCCCCCCCCCCC'

const sign = (body, k = key) => `${body}.${crypto.createHmac('sha256', k).update(body).digest('base64url')}`
const token = (purpose, port, issued, nonce = '', k = key) => sign(`v1.${purpose}.${port}.${issued}.${nonce}`, k)

// ---- tokens both sides must make exactly, from their parts -----------------------------------
const mint = [
  { name: 'login-a', purpose: 'login', port: PORT, issued: T0 + 1000, nonce: NONCE_A },
  { name: 'login-b', purpose: 'login', port: PORT, issued: T0 + 2000, nonce: NONCE_B },
  { name: 'login-c', purpose: 'login', port: PORT, issued: T0 + 3000, nonce: NONCE_C },
  { name: 'login-other-port', purpose: 'login', port: PORT + 1, issued: T0 + 1000, nonce: NONCE_A },
  { name: 'login-early', purpose: 'login', port: PORT, issued: T0 - 1, nonce: NONCE_A },
  { name: 'login-at-start', purpose: 'login', port: PORT, issued: T0, nonce: 'DDDDDDDDDDDDDDDDDDDDDD' },
  { name: 'api-a', purpose: 'api', port: PORT, issued: T0 + 1000, nonce: '' },
  { name: 'api-other-port', purpose: 'api', port: PORT + 1, issued: T0 + 1000, nonce: '' },
  { name: 'api-early', purpose: 'api', port: PORT, issued: T0 - 1, nonce: '' },
  { name: 'api-back', purpose: 'api', port: PORT, issued: T0 - 5000, nonce: '' },
  { name: 'api-late', purpose: 'api', port: PORT, issued: T0 + 3600000, nonce: '' },
].map((t) => ({ ...t, token: token(t.purpose, t.port, t.issued, t.nonce) }))
const named = Object.fromEntries(mint.map((t) => [t.name, t.token]))
// well signed by a key that is not this install's
named['login-wrong-key'] = token('login', PORT, T0 + 1000, NONCE_A, otherKey)
named['api-wrong-key'] = token('api', PORT, T0 + 1000, '', otherKey)

// ---- single tokens, checked as `purpose` for `port` at `now` by a listener started at T0 -------
const apiA = named['api-a']
const loginA = named['login-a']
// the last character of a 43-character MAC carries two unused bits; a decoder that ignores them
// would take four spellings for one MAC
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const sloppy = (t) => t.slice(0, -1) + alphabet[alphabet.indexOf(t.at(-1)) ^ 1]
const flip = (t) => t.slice(0, -2) + (t.at(-2) === 'A' ? 'B' : 'A') + t.at(-1)
const check = (name, tok, purpose, now, ok, port = PORT) => ({ name, token: tok, purpose, port, started: T0, now, ok })
const checks = [
  check('a login token, the moment it was made', loginA, 'login', T0 + 1000, true),
  check('a login token at five minutes', loginA, 'login', T0 + 1000 + 300000, true),
  check('a login token past five minutes', loginA, 'login', T0 + 1000 + 300001, false),
  check('an api token at sixty seconds', apiA, 'api', T0 + 1000 + 60000, true),
  check('an api token past sixty seconds', apiA, 'api', T0 + 1000 + 60001, false),
  check('two seconds ahead of this clock is still the same machine', apiA, 'api', T0 + 1000 - 2000, true),
  check('further ahead than that is refused', apiA, 'api', T0 + 1000 - 2001, false),
  check('issued the millisecond the listener started', named['login-at-start'], 'login', T0, true),
  check('issued before the listener started', named['api-early'], 'api', T0, false),
  check('a login token before the listener started', named['login-early'], 'login', T0, false),
  check('a login token is not an api token', loginA, 'api', T0 + 1000, false),
  check('an api token is not a login token', apiA, 'login', T0 + 1000, false),
  check('made for another port', named['api-other-port'], 'api', T0 + 1000, false),
  check('the same token at the port it names', named['api-other-port'], 'api', T0 + 1000, true, PORT + 1),
  check('signed with another key', named['api-wrong-key'], 'api', T0 + 1000, false),
  check('a login token signed with another key', named['login-wrong-key'], 'login', T0 + 1000, false),
  check('one character of the MAC changed', flip(apiA), 'api', T0 + 1000, false),
  check('another spelling of the same MAC bytes', sloppy(apiA), 'api', T0 + 1000, false),
  check('the MAC cut short', apiA.slice(0, -1), 'api', T0 + 1000, false),
  check('no MAC', apiA.slice(0, apiA.lastIndexOf('.')), 'api', T0 + 1000, false),
  check('an empty MAC', apiA.slice(0, apiA.lastIndexOf('.') + 1), 'api', T0 + 1000, false),
  check('nothing', '', 'api', T0 + 1000, false),
  check('an unknown version', sign(`v2.api.${PORT}.${T0 + 1000}.`), 'api', T0 + 1000, false),
  check('the version in capitals', sign(`V1.api.${PORT}.${T0 + 1000}.`), 'api', T0 + 1000, false),
  check('an unknown purpose', sign(`v1.admin.${PORT}.${T0 + 1000}.`), 'admin', T0 + 1000, false),
  check('a port with a leading zero', sign(`v1.api.0${PORT}.${T0 + 1000}.`), 'api', T0 + 1000, false),
  check('a port with a sign', sign(`v1.api.+${PORT}.${T0 + 1000}.`), 'api', T0 + 1000, false),
  check('port zero', sign(`v1.api.0.${T0 + 1000}.`), 'api', T0 + 1000, false, 0),
  check('a time with a leading zero', sign(`v1.api.${PORT}.0${T0 + 1000}.`), 'api', T0 + 1000, false),
  check('a time with a fraction', sign(`v1.api.${PORT}.${T0 + 1000}.5.`), 'api', T0 + 1000, false),
  check('a time in exponent form', sign(`v1.api.${PORT}.18e11.`), 'api', T0 + 1000, false),
  check('a time of sixteen digits', sign(`v1.api.${PORT}.1800000000001000.`), 'api', T0 + 1000, false),
  check('an api token with a nonce', sign(`v1.api.${PORT}.${T0 + 1000}.${NONCE_A}`), 'api', T0 + 1000, false),
  check('a login token without a nonce', sign(`v1.login.${PORT}.${T0 + 1000}.`), 'login', T0 + 1000, false),
  check('a login token with a short nonce', sign(`v1.login.${PORT}.${T0 + 1000}.AAAA`), 'login', T0 + 1000, false),
  check('a login nonce outside the alphabet', sign(`v1.login.${PORT}.${T0 + 1000}.AAAAAAAAAAAAAAAAAAAA+/`), 'login', T0 + 1000, false),
  check('one part too many', sign(`v1.api.${PORT}.${T0 + 1000}..x`), 'api', T0 + 1000, false),
  check('a space in front', ` ${apiA}`, 'api', T0 + 1000, false),
  check('a line break behind', `${apiA}\n`, 'api', T0 + 1000, false),
  check('longer than any real token', sign(`v1.login.${PORT}.${T0 + 1000}.${'A'.repeat(300)}`), 'login', T0 + 1000, false),
]

// ---- whole requests, in order, against one listener per scenario ------------------------------
const HOST = ['Host', `127.0.0.1:${PORT}`]
const api = (name = 'api-a') => ['Authorization', `SpawnLoft {token:${name}}`]
const cookie = (s) => ['Cookie', `spawnloft_${PORT}={session:${s}}`]
const at = T0 + 1000
const step = (name, method, target, headers, expect, extra = {}) => ({ name, now: at, method, target, headers, expect, ...extra })

const scenarios = [
  {
    name: 'no credential',
    steps: [
      step('the API', 'GET', '/api/instances', [HOST], 'unauthorized-api'),
      step('the API with a query', 'GET', '/api/instances?x=1', [HOST], 'unauthorized-api'),
      step('a write, from the panel\'s own origin', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT}`]], 'unauthorized-api'),
      step('the panel page', 'GET', '/', [HOST], 'unauthorized-page'),
      step('the launcher page', 'GET', '/launcher', [HOST], 'unauthorized-page'),
      step('the setup page', 'GET', '/setup', [HOST], 'unauthorized-page'),
      step('a path that is not under /api/', 'GET', '/api', [HOST], 'unauthorized-page'),
      step('any other method', 'DELETE', '/api/instances/x', [HOST], 'unauthorized-api'),
    ],
  },
  {
    name: 'Host names this machine',
    steps: [
      step('no Host', 'GET', '/api/instances', [api()], 'forbidden'),
      step('another name for a loopback address (DNS rebinding)', 'GET', '/api/instances', [['Host', `evil.example:${PORT}`], api()], 'forbidden'),
      step('another loopback address', 'GET', '/api/instances', [['Host', `127.0.0.2:${PORT}`], api()], 'forbidden'),
      step('a LAN address', 'GET', '/api/instances', [['Host', `192.168.1.20:${PORT}`], api()], 'forbidden'),
      step('localhost', 'GET', '/api/instances', [['Host', `localhost:${PORT}`], api()], 'allow'),
      step('the IPv6 loopback', 'GET', '/api/instances', [['Host', `[::1]:${PORT}`], api()], 'allow'),
      step('no port', 'GET', '/api/instances', [['Host', 'localhost'], api()], 'allow'),
      step('another local port (an ssh tunnel): the token names the real one', 'GET', '/api/instances', [['Host', 'LOCALHOST:9000'], api()], 'allow'),
      step('spaces around the value', 'GET', '/api/instances', [['Host', ` 127.0.0.1:${PORT} `], api()], 'allow'),
      step('a colon and no port', 'GET', '/api/instances', [['Host', '127.0.0.1:'], api()], 'forbidden'),
      step('a port that is not a number', 'GET', '/api/instances', [['Host', '127.0.0.1:80a'], api()], 'forbidden'),
      step('a user in front', 'GET', '/api/instances', [['Host', `evil@127.0.0.1:${PORT}`], api()], 'forbidden'),
      step('two Host headers', 'GET', '/api/instances', [HOST, ['host', 'evil.example'], api()], 'forbidden'),
    ],
  },
  {
    name: 'Origin, when there is one, is this panel',
    steps: [
      step('the panel\'s own origin', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT}`], api()], 'allow'),
      step('capitals', 'POST', '/api/instances', [['Host', `localhost:${PORT}`], ['Origin', `HTTP://LOCALHOST:${PORT}`], api()], 'allow'),
      step('another loopback port (a plugin web map)', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT + 1}`], api()], 'forbidden'),
      step('localhost is not 127.0.0.1', 'POST', '/api/instances', [HOST, ['Origin', `http://localhost:${PORT}`], api()], 'forbidden'),
      step('a site', 'POST', '/api/instances', [HOST, ['Origin', 'https://evil.example'], api()], 'forbidden'),
      step('null (a sandboxed frame, a local file)', 'POST', '/api/instances', [HOST, ['Origin', 'null'], api()], 'forbidden'),
      step('https on the same host and port', 'POST', '/api/instances', [HOST, ['Origin', `https://127.0.0.1:${PORT}`], api()], 'forbidden'),
      step('a trailing slash', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT}/`], api()], 'forbidden'),
      step('two Origin headers', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT}`], ['Origin', 'https://evil.example'], api()], 'forbidden'),
      step('a foreign origin on an open route', 'GET', '/api/client/accounts/login/callback?code=x&state=y', [HOST, ['Origin', 'https://evil.example']], 'forbidden'),
    ],
  },
  {
    name: 'Sec-Fetch-Site, when there is one, says same-origin or none',
    steps: [
      step('same-origin', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'same-origin'], api()], 'allow'),
      step('none (typed, a bookmark, the window itself)', 'GET', '/', [HOST, ['Sec-Fetch-Site', 'none'], api()], 'allow'),
      step('capitals', 'GET', '/', [HOST, ['sec-fetch-site', 'Same-Origin'], api()], 'allow'),
      step('same-site: every loopback port is one site', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'same-site'], api()], 'forbidden'),
      step('cross-site', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'cross-site'], api()], 'forbidden'),
      step('anything else', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'same-origin, none'], api()], 'forbidden'),
      step('two of them', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'same-origin'], ['Sec-Fetch-Site', 'none'], api()], 'forbidden'),
      step('refused before the credential is looked at', 'GET', '/api/instances', [HOST, ['Sec-Fetch-Site', 'cross-site']], 'forbidden'),
      step('Microsoft\'s redirect arrives cross-site', 'GET', '/api/client/accounts/login/callback?code=x&state=y', [['Host', `localhost:${PORT}`], ['Sec-Fetch-Site', 'cross-site']], 'open'),
      step('a login link opened from a local file', 'GET', '/auth?t={token:login-a}', [HOST, ['Sec-Fetch-Site', 'cross-site']], 'login', { to: '/', save: 's' }),
    ],
  },
  {
    name: 'the two open routes, and nothing near them',
    steps: [
      step('the sign-in callback', 'GET', '/api/client/accounts/login/callback', [HOST], 'open'),
      step('with its query', 'GET', '/api/client/accounts/login/callback?code=x&state=y', [HOST], 'open'),
      step('as a POST', 'POST', '/api/client/accounts/login/callback', [HOST], 'unauthorized-api'),
      step('as a HEAD', 'HEAD', '/api/client/accounts/login/callback', [HOST], 'unauthorized-api'),
      step('with a trailing slash', 'GET', '/api/client/accounts/login/callback/', [HOST], 'unauthorized-api'),
      step('with dot segments after it', 'GET', '/api/client/accounts/login/callback/../../../instances', [HOST], 'unauthorized-api'),
      step('with dot segments before it', 'GET', '/x/../api/client/accounts/login/callback', [HOST], 'unauthorized-page'),
      step('percent-encoded', 'GET', '/api/client/accounts/login/callbac%6b', [HOST], 'unauthorized-api'),
      step('in capitals', 'GET', '/API/client/accounts/login/callback', [HOST], 'unauthorized-page'),
      step('with a second slash', 'GET', '//api/client/accounts/login/callback', [HOST], 'unauthorized-page'),
      step('with a backslash', 'GET', '/api\\client/accounts/login/callback', [HOST], 'unauthorized-page'),
      step('as a whole address', 'GET', `http://127.0.0.1:${PORT}/api/client/accounts/login/callback`, [HOST], 'unauthorized-page'),
      step('the other login routes', 'GET', '/api/client/accounts/login/abc/stream', [HOST], 'unauthorized-api'),
      step('/auth with no token', 'GET', '/auth', [HOST], 'login-refused'),
      step('/auth as a POST', 'POST', '/auth?t={token:login-a}', [HOST], 'unauthorized-page'),
      step('/auth with a trailing slash', 'GET', '/auth/?t={token:login-a}', [HOST], 'unauthorized-page'),
      step('/auth in capitals', 'GET', '/AUTH?t={token:login-a}', [HOST], 'unauthorized-page'),
      step('the token was not spent by any of those', 'GET', '/auth?t={token:login-a}', [HOST], 'login', { to: '/', save: 's' }),
    ],
  },
  {
    name: 'a login link works once and gives a session',
    steps: [
      step('the link', 'GET', '/auth?t={token:login-a}', [HOST], 'login', { to: '/', save: 'one' }),
      step('the page, with the cookie', 'GET', '/', [HOST, cookie('one')], 'allow'),
      step('the API, with the cookie', 'POST', '/api/instances', [HOST, ['Origin', `http://127.0.0.1:${PORT}`], ['Sec-Fetch-Site', 'same-origin'], cookie('one')], 'allow'),
      step('the link a second time', 'GET', '/auth?t={token:login-a}', [HOST], 'login-refused'),
      step('a second time, from the browser that has the session', 'GET', '/auth?t={token:login-a}', [HOST, cookie('one')], 'login-refused'),
      step('another link, to the launcher', 'GET', '/auth?t={token:login-b}&to=/launcher', [HOST], 'login', { to: '/launcher', save: 'two' }),
      step('the first session still works', 'GET', '/api/instances', [HOST, cookie('one')], 'allow'),
      step('and the second', 'GET', '/api/instances', [HOST, cookie('two')], 'allow'),
      step('among other cookies', 'GET', '/api/instances', [HOST, ['Cookie', `theme=dark; spawnloft_${PORT}={session:one}; x=y`]], 'allow'),
      step('no space after the semicolon', 'GET', '/api/instances', [HOST, ['Cookie', `a=b;spawnloft_${PORT}={session:one}`]], 'allow'),
      step('a stale cookie of the same name in front', 'GET', '/api/instances', [HOST, ['Cookie', `spawnloft_${PORT}=${'x'.repeat(43)}; spawnloft_${PORT}={session:one}`]], 'allow'),
      step('in a second Cookie header', 'GET', '/api/instances', [HOST, ['Cookie', 'a=b'], cookie('one')], 'allow'),
      step('under another port\'s name', 'GET', '/api/instances', [HOST, ['Cookie', `spawnloft_${PORT + 1}={session:one}`]], 'unauthorized-api'),
      step('under a longer name', 'GET', '/api/instances', [HOST, ['Cookie', `xspawnloft_${PORT}={session:one}`]], 'unauthorized-api'),
      step('a session nobody was given', 'GET', '/api/instances', [HOST, ['Cookie', `spawnloft_${PORT}=${'A'.repeat(43)}`]], 'unauthorized-api'),
      step('an empty cookie', 'GET', '/', [HOST, ['Cookie', `spawnloft_${PORT}=`]], 'unauthorized-page'),
      step('the session id as an api token', 'GET', '/api/instances', [HOST, ['Authorization', 'SpawnLoft {session:one}']], 'unauthorized-api'),
    ],
  },
  {
    name: 'what a login link may carry',
    steps: [
      step('to the setup wizard', 'GET', '/auth?t={token:login-a}&to=/setup', [HOST], 'login', { to: '/setup', save: 's' }),
      step('to anywhere else: the panel', 'GET', '/auth?t={token:login-b}&to=//evil.example/', [HOST], 'login', { to: '/', save: 's' }),
      step('an encoded target is not decoded', 'GET', '/auth?to=%2Flauncher&t={token:login-c}', [HOST], 'login', { to: '/', save: 's' }),
      step('the first t is the token', 'GET', '/auth?t=x&t={token:login-at-start}', [HOST], 'login-refused'),
      step('which the line above did not spend', 'GET', '/auth?x&t={token:login-at-start}&to=/launcher&to=/setup', [HOST], 'login', { to: '/launcher', save: 's' }),
    ],
  },
  {
    name: 'login tokens that are refused',
    steps: [
      step('for another port', 'GET', '/auth?t={token:login-other-port}', [HOST], 'login-refused'),
      step('issued before this listener started', 'GET', '/auth?t={token:login-early}', [HOST], 'login-refused'),
      step('signed with another key', 'GET', '/auth?t={token:login-wrong-key}', [HOST], 'login-refused'),
      step('an api token', 'GET', '/auth?t={token:api-a}', [HOST], 'login-refused'),
      step('an empty one', 'GET', '/auth?t=', [HOST], 'login-refused'),
      { ...step('past five minutes', 'GET', '/auth?t={token:login-a}', [HOST], 'login-refused'), now: T0 + 1000 + 300001 },
      { ...step('a later one still works then', 'GET', '/auth?t={token:login-b}', [HOST], 'login', { to: '/', save: 's' }), now: T0 + 2000 + 300000 },
    ],
  },
  {
    name: 'api tokens',
    steps: [
      step('the header', 'GET', '/api/instances', [HOST, api()], 'allow'),
      step('again: an api token is not single use', 'POST', '/api/instances', [HOST, api()], 'allow'),
      step('the scheme in lower case', 'GET', '/api/instances', [HOST, ['authorization', 'spawnloft {token:api-a}']], 'allow'),
      step('as a Bearer token', 'GET', '/api/instances', [HOST, ['Authorization', 'Bearer {token:api-a}']], 'unauthorized-api'),
      step('with no scheme', 'GET', '/api/instances', [HOST, ['Authorization', '{token:api-a}']], 'unauthorized-api'),
      step('two spaces', 'GET', '/api/instances', [HOST, ['Authorization', 'SpawnLoft  {token:api-a}']], 'unauthorized-api'),
      step('something after it', 'GET', '/api/instances', [HOST, ['Authorization', 'SpawnLoft {token:api-a} x']], 'unauthorized-api'),
      step('in the query instead', 'GET', '/api/instances?t={token:api-a}', [HOST], 'unauthorized-api'),
      step('in the cookie instead', 'GET', '/api/instances', [HOST, ['Cookie', `spawnloft_${PORT}={token:api-a}`]], 'unauthorized-api'),
      step('for another port', 'GET', '/api/instances', [HOST, api('api-other-port')], 'unauthorized-api'),
      step('issued before this listener started', 'GET', '/api/instances', [HOST, api('api-early')], 'unauthorized-api'),
      step('signed with another key', 'GET', '/api/instances', [HOST, api('api-wrong-key')], 'unauthorized-api'),
      step('a login token', 'GET', '/api/instances', [HOST, api('login-a')], 'unauthorized-api'),
      step('which that did not spend', 'GET', '/auth?t={token:login-a}', [HOST], 'login', { to: '/', save: 'one' }),
      step('a bad token beside a good session', 'GET', '/api/instances', [HOST, api('api-wrong-key'), cookie('one')], 'allow'),
      step('two Authorization headers', 'GET', '/api/instances', [HOST, api(), api()], 'forbidden'),
      { ...step('past sixty seconds', 'GET', '/api/instances', [HOST, api()], 'unauthorized-api'), now: T0 + 1000 + 60001 },
      { ...step('a page asked for with a stale token', 'GET', '/', [HOST, api()], 'unauthorized-page'), now: T0 + 1000 + 60001 },
    ],
  },
  {
    name: 'a session nobody uses for fifteen minutes ends',
    steps: [
      step('sign in', 'GET', '/auth?t={token:login-a}', [HOST], 'login', { to: '/', save: 'one' }),
      { ...step('fifteen minutes later, to the millisecond', 'GET', '/', [HOST, cookie('one')], 'allow'), now: at + 900000 },
      { ...step('which counted as use', 'GET', '/', [HOST, cookie('one')], 'allow'), now: at + 1800000 },
      { ...step('a millisecond past fifteen idle minutes', 'GET', '/', [HOST, cookie('one')], 'unauthorized-page'), now: at + 2700001 },
      { ...step('and it does not come back', 'GET', '/api/instances', [HOST, cookie('one')], 'unauthorized-api'), now: at + 2700002 },
      { ...step('a fresh api token works at any age of the listener', 'GET', '/api/instances', [HOST, api('api-late')], 'allow'), now: T0 + 3600000 },
    ],
  },
  {
    name: 'a clock set back after the start locks nobody out',
    steps: [
      { ...step('a token from the new, earlier time', 'GET', '/api/instances', [HOST, api('api-back')], 'allow'), now: T0 - 5000 },
      { ...step('the start has moved back with the clock', 'GET', '/api/instances', [HOST, api('api-early')], 'allow'), now: T0 - 1 },
    ],
  },
]

const doc = {
  about: 'The panel sign-in rule (rust/PANEL-AUTH-DESIGN.md) as data. Made by tools/make-panel-auth-fixture.mjs; run by test/panel-auth.test.mjs and by cargo test (panel_auth). The keys are test keys.',
  key: key.toString('base64url'),
  port: PORT,
  started: T0,
  loginTtlMs: 300000,
  apiTtlMs: 60000,
  futureLeewayMs: 2000,
  sessionIdleMs: 900000,
  openRoutes: ['/auth', '/api/client/accounts/login/callback'],
  cookie: `spawnloft_${PORT}`,
  expectations: ['forbidden', 'open', 'login', 'login-refused', 'allow', 'unauthorized-api', 'unauthorized-page'],
  mint,
  tokens: named,
  checks,
  scenarios,
}
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
console.log(`${out}: ${mint.length} tokens to make, ${checks.length} to check, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} requests in ${scenarios.length} scenarios`)
