// The Microsoft sign-in window's checks, without Electron: the one URL the page may ask to open,
// and where the window's top frame may go. Run: node --test login-window.test.js (or npm test,
// from desktop/)
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { isAllowedNavigation, isCallback, isAuthorizeUrl, centredOn, CALLBACK_PATH } = require('./login-window')

const PORT = 51234
const CLIENT_ID = '946097b5-241d-4f83-9981-c6d0778e5507'
const AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'
const CALLBACK = `http://localhost:${PORT}${CALLBACK_PATH}`
const opts = { authorizeUrl: AUTHORIZE, clientId: CLIENT_ID, port: PORT }

function authorize(params = {}) {
  const u = new URL(AUTHORIZE)
  const all = {
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: CALLBACK,
    scope: 'XboxLive.signin offline_access',
    response_mode: 'query',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 'xyz',
    prompt: 'select_account',
    ...params,
  }
  for (const [k, v] of Object.entries(all)) if (v !== undefined) u.searchParams.set(k, v)
  return u.href
}

test('the callback path is the panel\'s', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.mjs'), 'utf8')
  assert.ok(ui.includes(`http://localhost:\${panelPort}${CALLBACK_PATH}`))
})

test('the panel\'s authorize URL is accepted', () => {
  assert.equal(isAuthorizeUrl(authorize(), opts), true)
})

test('any other URL is refused before a window exists', () => {
  const refused = [
    authorize({ client_id: 'someone-else' }),
    authorize({ client_id: undefined }),
    authorize({ redirect_uri: `http://localhost:${PORT + 1}${CALLBACK_PATH}` }),
    authorize({ redirect_uri: `http://127.0.0.1:${PORT}${CALLBACK_PATH}` }),
    authorize({ redirect_uri: `http://localhost:${PORT}/api/client/accounts/login/callbackx` }),
    authorize({ redirect_uri: `https://evil.example/${CALLBACK_PATH}` }),
    authorize({ redirect_uri: undefined }),
    authorize({ response_type: 'token' }),
    authorize().replace('/consumers/', '/common/'),
    authorize().replace('https://login.microsoftonline.com', 'https://login.microsoftonline.com.evil.example'),
    authorize().replace('https://login.microsoftonline.com', 'http://login.microsoftonline.com'),
    authorize().replace('https://login.microsoftonline.com', 'https://login.microsoftonline.com:8443'),
    authorize().replace('https://', 'https://user:pw@'),
    authorize() + '#x',
    authorize() + '&client_id=someone-else',
    authorize() + '&redirect_uri=' + encodeURIComponent('https://evil.example/'),
    'https://evil.example/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    '',
    'not a url',
    'https://x/' + 'a'.repeat(9000),
  ]
  for (const url of refused) assert.equal(isAuthorizeUrl(url, opts), false, url.slice(0, 200))
  for (const v of [null, undefined, 42, {}, [authorize()]]) assert.equal(isAuthorizeUrl(v, opts), false)
})

test('the sign-in\'s top frame may move between Microsoft\'s sign-in hosts', () => {
  for (const url of [
    authorize(),
    'https://login.live.com/oauth20_authorize.srf?x=1',
    'https://account.live.com/proofs/Add',
    'https://login.microsoft.com/consumers/',
    'https://account.microsoft.com/',
    'https://something.microsoftonline.com/path',
  ]) assert.equal(isAllowedNavigation(url, PORT), true, url)
})

test('the callback is allowed only as an exact scheme, host, port and path', () => {
  assert.equal(isAllowedNavigation(`${CALLBACK}?code=c&state=s`, PORT), true)
  assert.equal(isAllowedNavigation(CALLBACK, PORT), true)
  for (const url of [
    `http://localhost:${PORT + 1}${CALLBACK_PATH}?code=c`,
    `http://127.0.0.1:${PORT}${CALLBACK_PATH}?code=c`,
    `https://localhost:${PORT}${CALLBACK_PATH}?code=c`,
    `http://localhost:${PORT}/`,
    `http://localhost:${PORT}/launcher`,
    `http://localhost:${PORT}/api/client/accounts`,
    `http://localhost:${PORT}${CALLBACK_PATH}/x`,
    `http://user@localhost:${PORT}${CALLBACK_PATH}`,
    `http://localhost${CALLBACK_PATH}`,
  ]) assert.equal(isAllowedNavigation(url, PORT), false, url)
})

test('everything else is blocked', () => {
  for (const url of [
    'https://evil.example/',
    'https://microsoftonline.com.evil.example/',
    'https://evilmicrosoftonline.com/',
    'https://evil-live.com/',
    'https://live.com.evil.example/',
    'https://login.live.com.evil.example/',
    'https://login.live.com:444/',
    'https://user:pw@login.live.com/',
    'http://login.live.com/',
    'http://login.microsoftonline.com/',
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'about:blank',
    'ms-settings:privacy',
    '',
    'nope',
  ]) assert.equal(isAllowedNavigation(url, PORT), false, url)
  assert.equal(isAllowedNavigation(null, PORT), false)
})

test('isCallback takes a string or a parsed URL', () => {
  assert.equal(isCallback(CALLBACK + '?code=1', PORT), true)
  assert.equal(isCallback(new URL(CALLBACK), PORT), true)
  assert.equal(isCallback('http://localhost:1/x', PORT), false)
  assert.equal(isCallback(null, PORT), false)
})

test('the window is centred on the one that asked', () => {
  assert.deepEqual(centredOn({ x: 100, y: 50, width: 1200, height: 800 }, 480, 720), { x: 460, y: 90 })
  assert.deepEqual(centredOn({ x: 0, y: 0, width: 400, height: 500 }, 480, 720), { x: -40, y: 0 })
  assert.deepEqual(centredOn(null, 480, 720), {})
})
