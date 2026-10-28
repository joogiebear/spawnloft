import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The launcher page (src/launcher.html), like the panel, is one document with no build step. Its
// pure helpers are lifted out by name (the same way test/panel.test.mjs does it) and the rest is
// checked as text: the script compiles, nothing parses markup, and the CSP is there.
const html = fs.readFileSync(new URL('../src/launcher.html', import.meta.url), 'utf8')

function constSource(name) {
  const m = new RegExp(`^ *const ${name} = .*$`, 'm').exec(html)
  assert.ok(m, `could not find "const ${name}" in launcher.html`)
  return m[0]
}

function fnSource(name) {
  const at = html.indexOf(`function ${name}(`)
  assert.ok(at !== -1, `could not find "function ${name}" in launcher.html`)
  let depth = 0
  for (let i = html.indexOf('{', at); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1)
  }
  assert.fail(`unbalanced braces after "function ${name}"`)
}

const lifted = (names) => new Function(
  `${names.map((n) => (/^[A-Z_]+$/.test(n) ? constSource(n) : fnSource(n))).join('\n')}
   return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} }`,
)()

test('the launcher script parses', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length >= 2)
  for (const src of scripts) new Function(src)
})

test('the launcher never builds DOM from markup', () => {
  // names, version ids and log lines come from Mojang, the manifest, the person and the game
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser']) {
    assert.equal(html.includes(sink), false, `launcher.html uses ${sink}`)
  }
  assert.doesNotMatch(html, /\beval\(|new Function\(/)
})

test('the launcher page carries a Content-Security-Policy that keeps it on the panel', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)
  assert.ok(m, 'no CSP meta')
  const csp = Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  assert.deepEqual(csp['default-src'], ["'self'"])
  assert.deepEqual(csp['connect-src'], ["'self'"])
  assert.deepEqual(csp['object-src'], ["'none'"])
  assert.deepEqual(csp['base-uri'], ["'none'"])
  assert.deepEqual(csp['form-action'], ["'none'"])
  // it must come before the first script to apply to it
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>'))
})

test('the launch strip puts every job stage on a step', () => {
  const { stepOf, splitMessage } = lifted(['stepOf', 'splitMessage'])
  assert.deepEqual(['java', 'manifest', 'version', 'client', 'libraries', 'assets', 'natives', 'fabric', 'harness', 'server', 'spawn', 'running'].map(stepOf),
    [0, 1, 1, 2, 2, 2, 2, 2, 2, 3, 4, 4])
  assert.equal(stepOf('start'), -1)
  assert.equal(stepOf('something-new'), -1)
  assert.deepEqual(splitMessage('Downloading libraries · 212 of 1,049 files · 143 MB'), ['Downloading libraries', '212 of 1,049 files · 143 MB'])
  assert.deepEqual(splitMessage('Finding Java'), ['Finding Java', ''])
  assert.deepEqual(splitMessage(undefined), ['', ''])
})

test('the address field agrees with the panel on what a server address is', async () => {
  const { addressProblem } = lifted(['HOSTNAME_RE', 'addressProblem'])
  const { parseServerAddress } = await import('../src/client.mjs')
  const cases = ['play.example.net', 'play.example.net:25565', '192.168.1.20:25566', '[::1]:25565', '[::1]', 'localhost',
    'play example net', '-oops', 'a:b:c', 'host:0', 'host:70000', 'host:', 'http://x', '[nothex]', '', '   ', 'x'.repeat(300)]
  for (const text of cases) {
    let panelOk = true
    try { parseServerAddress(text) } catch { panelOk = false }
    assert.equal(addressProblem(text) === null, panelOk, `"${text.slice(0, 40)}": page and panel disagree`)
  }
  assert.match(addressProblem(''), /Type the address/)
  assert.match(addressProblem('host:0'), /port/)
})

test('Play names the account a launch uses, the profile\'s own before the default', () => {
  const { playAccount } = lifted(['playAccount'])
  const accounts = [
    { name: 'Wunga_', uuid: 'u1', type: 'microsoft', refreshFailedAt: null },
    { name: 'BuildBot', uuid: 'u2', type: 'offline', refreshFailedAt: null },
    { name: 'Old', uuid: 'u3', type: 'microsoft', refreshFailedAt: '2026-10-01T00:00:00Z' },
  ]
  assert.deepEqual(playAccount({ account: null }, accounts, 'u1'), { name: 'Wunga_', type: 'microsoft', expired: false })
  assert.deepEqual(playAccount({ account: 'u2', accountName: 'BuildBot', accountType: 'offline' }, accounts, 'u1'), { name: 'BuildBot', type: 'offline', expired: false })
  assert.deepEqual(playAccount({ account: null }, accounts, 'u3'), { name: 'Old', type: 'microsoft', expired: true })
  assert.deepEqual(playAccount({ account: 'gone', accountName: 'gone', accountType: null }, accounts, 'u1'), { name: 'gone', type: null, missing: true })
  // no account and no default: the panel plays an offline player it names itself
  assert.deepEqual(playAccount({ account: null }, accounts, null), { name: null, type: 'offline' })
  assert.deepEqual(playAccount({ account: null }, accounts, 'no-such-uuid'), { name: null, type: 'offline' })
})

test('the server picker offers the profile\'s version and blocks online servers for offline players', () => {
  const { serverChoices } = lifted(['STOPPED', 'serverChoices'])
  const servers = [
    { name: 'survival', label: null, mc: '1.21.11', status: 'running', onlineMode: false },
    { name: 'public-smp', label: 'Public', mc: '1.21.11', status: 'stopped', onlineMode: true },
    { name: 'old', label: null, mc: '1.20.4', status: 'stopped', onlineMode: false },
    { name: 'mine', label: null, mc: '1.20.1', status: 'stale', onlineMode: null },
  ]
  const offline = serverChoices({ mc: '1.21.11', server: 'mine' }, servers, 'offline')
  assert.deepEqual(offline.map((c) => c.name), ['survival', 'public-smp', 'mine'])
  assert.equal(offline.find((c) => c.name === 'public-smp').blocked, 'needs a Microsoft account')
  assert.equal(offline.find((c) => c.name === 'survival').blocked, null)
  assert.equal(offline.find((c) => c.name === 'mine').otherVersion, '1.20.1')
  assert.equal(offline.find((c) => c.name === 'mine').stopped, true)
  assert.equal(offline.find((c) => c.name === 'survival').stopped, false)
  const signedIn = serverChoices({ mc: '1.21.11', server: null }, servers, 'microsoft')
  assert.equal(signedIn.find((c) => c.name === 'public-smp').blocked, null)
  // an account that is missing is not a Microsoft account either
  assert.equal(serverChoices({ mc: '1.21.11', server: null }, servers, null).find((c) => c.name === 'public-smp').blocked, 'needs a Microsoft account')
})

test('the version picker shows releases, then snapshots too, then everything', () => {
  const { versionRows } = lifted(['versionRows'])
  const all = [{ id: '1.21.11', type: 'release' }, { id: '25w14a', type: 'snapshot' }, { id: 'b1.7.3', type: 'old_beta' }]
  assert.deepEqual(versionRows(all, 'release').map((v) => v.id), ['1.21.11'])
  assert.deepEqual(versionRows(all, 'snapshot').map((v) => v.id), ['1.21.11', '25w14a'])
  assert.deepEqual(versionRows(all, 'all').map((v) => v.id), ['1.21.11', '25w14a', 'b1.7.3'])
})

test('a refused launch says why in the words the launcher uses', () => {
  const { launchNotice } = lifted(['launchNotice', 'sentence'])
  const lock = launchNotice('profile "play" is being launched (pid 4242); wait for it to finish')
  assert.equal(lock.tone, 'warn')
  assert.equal(lock.busy, true)
  const online = launchNotice('strict requires a Microsoft account (online-mode=true); sign in or pick another server')
  assert.equal(online.title, 'Can\'t launch: strict requires a Microsoft account (online-mode=true)')
  assert.equal(online.go, 'accounts')
  assert.deepEqual(launchNotice('no Java 21 found'), { tone: 'fault', title: 'Can\'t launch', text: 'No Java 21 found' })
})

test('small display helpers', () => {
  const { memoryText, initials, tileClass, loaderText } = lifted(['memoryText', 'initials', 'tileClass', 'loaderText'])
  assert.equal(memoryText('4G'), '4 GB')
  assert.equal(memoryText('1536M'), '1536 MB')
  assert.equal(memoryText('weird'), 'weird')
  assert.equal(initials('_Wunga'), 'W')
  assert.equal(initials('__'), '?')
  assert.match(tileClass('069a79f4-44e9-4726-a5be-fca90e38aaf5'), /^t[1-4]$/)
  assert.equal(tileClass('same'), tileClass('same'))
  assert.equal(loaderText({ loader: 'vanilla' }), 'Vanilla')
  assert.equal(loaderText({ loader: 'fabric', loaderVersion: '0.17.3' }), 'Fabric 0.17.3')
  assert.equal(loaderText({ loader: 'fabric', loaderVersion: null }), 'Fabric')
})

test('a game gone within a minute of starting is a crash, unless this page stopped it', () => {
  const { earlyExits } = lifted(['CRASH_WINDOW_MS', 'earlyExits'])
  const t0 = Date.parse('2026-10-28T10:00:00Z')
  const watch = {}
  const running = (name, startedAt) => ({ name, running: true, startedAt })
  const gone = (name) => ({ name, running: false, startedAt: null })
  // running games join the watch from their own start time
  assert.deepEqual(earlyExits(watch, [running('a', '2026-10-28T10:00:00Z'), running('b', '2026-10-28T10:00:00Z'), running('c', '2026-10-28T09:00:00Z')], t0 + 5000), [])
  assert.deepEqual(Object.keys(watch).sort(), ['a', 'b', 'c'])
  watch.b.stopping = true
  // a gone 18 s in: a crash; b stopped from here: none; c ran an hour: none
  assert.deepEqual(earlyExits(watch, [gone('a'), gone('b'), gone('c')], t0 + 18000), [{ name: 'a', seconds: 18 }])
  assert.deepEqual(watch, {})
  // a removed profile is no crash either
  watch.d = { since: t0, stopping: false }
  assert.deepEqual(earlyExits(watch, [], t0 + 1000), [])
})

test('the Edit form sends only what changed, and nothing a running game cannot change', () => {
  const { profilePatch } = lifted(['profilePatch'])
  const before = { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '4G', java: null, harness: true, server: 'survival', account: 'u1', assistantAccount: false, running: false }
  const same = { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '4G', java: null, harness: true, server: 'survival', account: 'u1', assistantAccount: false }
  assert.deepEqual(profilePatch(before, same), {})
  assert.deepEqual(profilePatch(before, { ...same, server: null, memory: '6G' }), { server: null, memory: '6G' })
  // a new version leaves the loader build to the panel
  assert.deepEqual(profilePatch(before, { ...same, mc: '1.21.4' }), { mc: '1.21.4' })
  assert.deepEqual(profilePatch(before, { ...same, mc: '1.21.4', loaderVersion: '0.16.9' }), { mc: '1.21.4', loaderVersion: '0.16.9' })
  // running: only the next-launch keys go
  assert.deepEqual(profilePatch({ ...before, running: true }, { ...same, memory: '8G', harness: false, account: 'u2', assistantAccount: true }), { account: 'u2', assistantAccount: true })
})
