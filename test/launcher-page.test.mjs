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
    [1, 0, 0, 2, 2, 2, 2, 2, 2, 3, 4, 4])
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

test('every server is marked for a setup: another version, and online servers blocked for offline players', () => {
  const { serverChoices } = lifted(['STOPPED', 'serverChoices'])
  const servers = [
    { name: 'survival', label: null, mc: '1.21.11', status: 'running', onlineMode: false },
    { name: 'public-smp', label: 'Public', mc: '1.21.11', status: 'stopped', onlineMode: true },
    { name: 'old', label: null, mc: '1.20.4', status: 'stopped', onlineMode: false },
    { name: 'mine', label: null, mc: '1.20.1', status: 'stale', onlineMode: null },
  ]
  const offline = serverChoices({ mc: '1.21.11', server: 'mine' }, servers, 'offline')
  assert.deepEqual(offline.map((c) => c.name), ['survival', 'public-smp', 'old', 'mine'])
  assert.equal(offline.find((c) => c.name === 'public-smp').blocked, 'needs a Microsoft account')
  assert.equal(offline.find((c) => c.name === 'survival').blocked, null)
  assert.equal(offline.find((c) => c.name === 'survival').otherVersion, null)
  assert.equal(offline.find((c) => c.name === 'old').otherVersion, '1.20.4')
  assert.equal(offline.find((c) => c.name === 'mine').stopped, true)
  assert.equal(offline.find((c) => c.name === 'survival').stopped, false)
  const signedIn = serverChoices({ mc: '1.21.11', server: null }, servers, 'microsoft')
  assert.equal(signedIn.find((c) => c.name === 'public-smp').blocked, null)
  // an account that is missing is not a Microsoft account either
  assert.equal(serverChoices({ mc: '1.21.11', server: null }, servers, null).find((c) => c.name === 'public-smp').blocked, 'needs a Microsoft account')
})

test('Join offers the servers on the setup\'s version, running ones first, and the one picked now', () => {
  const { serverChoices, joinChoices } = lifted(['STOPPED', 'serverChoices', 'joinChoices'])
  const servers = [
    { name: 'creative', label: null, mc: '1.21.11', status: 'stopped', onlineMode: false },
    { name: 'old', label: null, mc: '1.20.4', status: 'running', onlineMode: false },
    { name: 'survival', label: null, mc: '1.21.11', status: 'running', onlineMode: false },
    { name: 'unknown', label: null, mc: null, status: 'stopped', onlineMode: false },
  ]
  const choices = serverChoices({ mc: '1.21.11' }, servers, 'offline')
  const names = (list) => list.map((c) => c.name)
  // a server whose version is not known stays: it may well be the right one
  assert.deepEqual(names(joinChoices(choices, '1.21.11', null)), ['survival', 'creative', 'unknown'])
  // the server picked now is listed whatever it runs, so the menu shows what Join says
  assert.deepEqual(names(joinChoices(choices, '1.21.11', 'old')), ['old', 'survival', 'creative', 'unknown'])
  // the first run has no version yet
  assert.deepEqual(names(joinChoices(serverChoices({ mc: 'latest' }, servers, 'offline'), 'latest', null)), ['old', 'survival', 'creative', 'unknown'])
  // the menu ends in the two choices that are not servers, and says where the rest are
  assert.match(fnSource('joinMenu'), /id: 'joinOther'[^\n]*'Another address\\u2026'\)/)
  assert.match(fnSource('joinMenu'), /id: 'joinTitle'[^\n]*'Title screen'\)/)
  assert.match(fnSource('joinMenu'), /rest > 0 && h\('p', \{ class: 'note'/)
})

test('a server on another version stops Play until the player says where to go', () => {
  const { playState, playAccount, fixJoin } = lifted(['STRICT_CODES', 'sentence', 'blockReason', 'playState', 'playAccount', 'fixJoin'])
  const ms = { name: 'Joogiebear', uuid: 'u1', type: 'microsoft', refreshFailedAt: null }
  const setup = { name: '1-21-11', mc: '1.21.11', loader: 'vanilla', account: null, running: false }
  const old = { name: 'old', label: 'Old world', otherVersion: '1.20.4', blocked: null }
  const ctx = (over = {}) => ({ down: false, loaded: true, profile: setup, job: null, acct: playAccount(setup, [ms], 'u1'), picked: null, anyway: null, machineRefusal: null, busy: false, otherJob: false, refusal: null, crashed: false, ...over })
  const text = (parts) => parts.map((x) => (typeof x === 'string' ? x : x.b)).join('')
  const state = playState(ctx({ picked: old }))
  assert.equal(state.kind, 'blocked')
  assert.equal(text(state.reason), 'Old world runs Minecraft 1.20.4, and this setup is 1.21.11.')
  assert.deepEqual(state.fix, ['other-setup', 'title-screen', 'anyway'])
  assert.deepEqual(state.other, { mc: '1.20.4', server: 'old' })
  // "play anyway" is for that server only
  assert.equal(playState(ctx({ picked: old, anyway: 'old' })).kind, 'ready')
  assert.equal(playState(ctx({ picked: old, anyway: 'another' })).kind, 'blocked')
  assert.equal(playState(ctx({ picked: { name: 'survival', otherVersion: null, blocked: null } })).kind, 'ready')
  // the account comes first: that is what has to be fixed whichever server it is
  assert.deepEqual(playState(ctx({ picked: { ...old, blocked: 'needs a Microsoft account' }, acct: { name: null, type: 'offline' } })).fix, ['sign-in', 'title-screen'])
  // "A or B", "A, B, or C"
  assert.deepEqual([0, 1].map((i) => fixJoin(i, 2)), [' ', ' or '])
  assert.deepEqual([0, 1, 2].map((i) => fixJoin(i, 3)), [' ', ', ', ', or '])
  // the links do what they say
  assert.match(fnSource('fixButton'), /fix === 'other-setup' && other\) return link\(`use a \$\{other\.mc\} setup`, \(\) => takePrefill\(\{ mc: other\.mc, server: other\.server \}\)\)/)
  assert.match(fnSource('fixButton'), /setTarget\(p, \{ server: other\.server, anyway: other\.server \}\)/)
  // a server Play will not go to is not started, and the button does not say it would be
  assert.match(fnSource('launchPlan'), /const startsServer = Boolean\(picked\?\.stopped\) && !\(picked\.otherVersion && t\.anyway !== picked\.name\)/)
})

test('"Another address" is a choice of its own, with its own box', () => {
  const plan = fnSource('launchPlan')
  assert.match(plan, /const custom = !picked && \(t\.custom \|\| Boolean\(t\.address\.trim\(\)\)\)/)
  // nothing typed yet is a problem too: Play has nowhere to go, and says so instead of "title screen"
  assert.match(plan, /const addrProblem = custom \? addressProblem\(address\) : null/)
  assert.match(plan, /custom && addrProblem\s+\? \[address \? 'Fix the server address under Join/)
  assert.match(fnSource('startLaunch'), /if \(plan\.addrProblem\) \{\s+render\(\)\s+return \(\$\('joinAddress'\) \?\? \$\('join'\)\)\?\.focus\(\)/)
  const field = fnSource('joinField')
  assert.match(field, /custom && h\('div', \{ class: 'addr' \}/)
  assert.match(field, /id: 'joinAddress', 'aria-label': 'Server address'/)
  assert.match(field, /oninput: \(e\) => \{ setTarget\(p, \{ address: e\.target\.value, custom: true \}\)/)
  // the field itself takes no typing, so a picked server cannot turn into an address
  assert.doesNotMatch(field, /placeholder: 'Pick a server or type an address'/)
})

test('the setup sheet has the switch for the game\'s own server list, on unless turned off', () => {
  assert.match(html, /id: 'fServerList', role: 'switch', 'aria-checked': String\(f\.serverList\), 'aria-labelledby': 'fServerListLabel'/)
  assert.match(fnSource('openSheet'), /serverList: p\.serverList !== false/)
  assert.match(fnSource('profileFields'), /serverList: f\.serverList/)
})

test('the version picker shows releases, then snapshots too, then everything', () => {
  const { versionRows } = lifted(['versionRows'])
  const all = [{ id: '1.21.11', type: 'release' }, { id: '25w14a', type: 'snapshot' }, { id: 'b1.7.3', type: 'old_beta' }]
  assert.deepEqual(versionRows(all, 'release').map((v) => v.id), ['1.21.11'])
  assert.deepEqual(versionRows(all, 'snapshot').map((v) => v.id), ['1.21.11', '25w14a'])
  assert.deepEqual(versionRows(all, 'all').map((v) => v.id), ['1.21.11', '25w14a', 'b1.7.3'])
})

test('picker rows name their kind in words', () => {
  const { kindLabel } = lifted(['KIND_LABELS', 'kindLabel'])
  assert.equal(kindLabel({ type: 'snapshot', kind: 'release-candidate' }), 'release candidate')
  assert.equal(kindLabel({ type: 'snapshot', kind: 'pre-release' }), 'pre-release')
  assert.equal(kindLabel({ type: 'old_beta' }), 'beta', 'a panel without kinds')
  assert.equal(kindLabel({ type: 'something_new' }), 'something_new')
})

test('a refused launch says why in the words the launcher uses', () => {
  const { launchNotice } = lifted(['launchNotice', 'sentence'])
  const lock = launchNotice('profile "play" is being launched (pid 4242); wait for it to finish')
  assert.equal(lock.tone, 'warn')
  assert.equal(lock.busy, true)
  const online = launchNotice('strict requires a Microsoft account (online-mode=true); sign in or pick another server')
  assert.equal(online.title, 'Can\'t play: strict requires a Microsoft account (online-mode=true)')
  assert.equal(online.fix, 'sign-in')
  assert.deepEqual(launchNotice('no Java 21 found'), { tone: 'fault', title: 'Can\'t play', text: 'No Java 21 found' })
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

test('every watched game that goes without a Stop from this page is noticed, and an early one is marked', () => {
  const { watchedExits } = lifted(['CRASH_WINDOW_MS', 'watchedExits'])
  const t0 = Date.parse('2026-10-28T10:00:00Z')
  const watch = {}
  const running = (name, startedAt) => ({ name, running: true, startedAt })
  const gone = (name) => ({ name, running: false, startedAt: null })
  // running games join the watch from their own start time
  assert.deepEqual(watchedExits(watch, [running('a', '2026-10-28T10:00:00Z'), running('b', '2026-10-28T10:00:00Z'), running('c', '2026-10-28T09:00:00Z')], t0 + 5000), [])
  assert.deepEqual(Object.keys(watch).sort(), ['a', 'b', 'c'])
  watch.b.stopping = true
  // a gone 18 s in: early; b stopped from here: nothing; c ran an hour: noticed, the log decides
  assert.deepEqual(watchedExits(watch, [gone('a'), gone('b'), gone('c')], t0 + 18000), [{ name: 'a', seconds: 18, early: true }, { name: 'c', seconds: 3618, early: false }])
  assert.deepEqual(watch, {})
  // a removed profile is nothing either
  watch.d = { since: t0, stopping: false }
  assert.deepEqual(watchedExits(watch, [], t0 + 1000), [])
  // the log decides (readLog -> exitVerdict); exits wait their turn while one is shown
  assert.match(fnSource('readLog'), /if \(exitVerdict\(lines, c\.early\) === 'closed'\)/)
  assert.match(fnSource('noticeExits'), /S\.exits\.push\(\.\.\.watchedExits\(S\.watch, next\.profiles, Date\.now\(\)\)\)/)
  assert.match(fnSource('nextExit'), /if \(S\.crash \|\| !S\.exits\.length\) return/)
})

test('an exit the page did not ask for is a crash or a quit by what the log says, with a stricter first minute', () => {
  const { exitVerdict } = lifted(['crashSigns', 'saidStopping', 'cleanExit', 'exitVerdict'])
  const info = (t) => `[21:03:00] [Render thread/INFO]: ${t}`
  const quit = [info('Created: 512x512x0 minecraft:textures/atlas/chest.png-atlas'), '[21:03:01] [Render thread/INFO]: Stopping!']
  const fabric = ['[21:03:00] [main/ERROR]: Incompatible mods found!', '\tat net.fabricmc.loader.impl.discovery.ModDiscoverer.discoverMods(ModDiscoverer.java:155)']
  const routineError = ['[20:10:00] [Render thread/ERROR]: Couldn\'t load texture minecraft:textures/missing.png', ...Array.from({ length: 30 }, (_, i) => info(`tick ${i}`)), '[21:03:01] [Render thread/INFO]: Stopping!']
  const cutOff = [info('Loading 14 mods'), info('Rendering world')]
  // the first minute: anything but a clean quit is a crash
  assert.equal(exitVerdict(quit, true), 'closed')
  assert.equal(exitVerdict(fabric, true), 'crash')
  assert.equal(exitVerdict([...fabric, '[21:03:01] [Render thread/INFO]: Stopping!'], true), 'crash')
  assert.equal(exitVerdict(cutOff, true), 'crash')
  assert.equal(exitVerdict([], true), 'crash')
  // later: what counts is whether the game said it was stopping at the end
  assert.equal(exitVerdict(quit, false), 'closed')
  assert.equal(exitVerdict(routineError, false), 'closed')
  assert.equal(exitVerdict(fabric, false), 'crash')
  assert.equal(exitVerdict(cutOff, false), 'crash')
  assert.equal(exitVerdict([], false), 'crash')
  // "Stopping!" far from the end is not the end
  assert.equal(exitVerdict(['[21:03:00] [Render thread/INFO]: Stopping!', ...Array.from({ length: 12 }, (_, i) => info(`later ${i}`))], false), 'crash')
})

test('the crash notice says how long the game ran in the unit that fits', () => {
  const { ranFor } = lifted(['ranFor'])
  assert.equal(ranFor(1), '1 second')
  assert.equal(ranFor(18), '18 seconds')
  assert.equal(ranFor(119), '119 seconds')
  assert.equal(ranFor(120), '2 minutes')
  assert.equal(ranFor(1380), '23 minutes')
  assert.equal(ranFor(7200), '2 hours')
  assert.equal(ranFor(9000), '2 hours 30 minutes')
  assert.match(fnSource('crashNotice'), /Minecraft closed \$\{ranFor\(crash\.seconds\)\} after it started/)
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

test('a setup is named by its version unless someone gave it a name', () => {
  const { nameBase, autoName, givenName, setupTitle } = lifted(['nameBase', 'autoName', 'givenName', 'setupTitle'])
  assert.equal(autoName('1.21.11', 'vanilla', []), '1-21-11')
  assert.equal(autoName('1.21.11', 'fabric', []), '1-21-11-fabric')
  assert.equal(autoName('1.21.11', 'vanilla', ['1-21-11', '1-21-11-2']), '1-21-11-3')
  assert.equal(autoName('1.21.11', 'vanilla', ['1-21-11-FABRIC', '1-21-11'.toUpperCase()]), '1-21-11-2')
  // spaced and odd ids still make a profile name the panel accepts
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i
  for (const mc of ['1.14.2 Pre-Release 4', 'b1.7.3', '25w44a', 'rd-132211', '...', '1.21.11-rc1 '.repeat(4)]) {
    for (const loader of ['vanilla', 'fabric']) {
      const name = autoName(mc, loader, [nameBase(mc, loader)])
      assert.match(name, NAME_RE, `${mc} / ${loader} -> ${name}`)
    }
  }
  assert.equal(givenName({ name: '1-21-11', mc: '1.21.11', loader: 'vanilla' }), null)
  assert.equal(givenName({ name: '1-21-11-3', mc: '1.21.11', loader: 'vanilla' }), null)
  assert.equal(givenName({ name: '1-21-11-fabric', mc: '1.21.11', loader: 'fabric' }), null)
  assert.equal(givenName({ name: 'modded', mc: '1.21.1', loader: 'fabric' }), 'modded')
  // a setup whose version changed keeps the old name, which is now worth showing
  assert.equal(givenName({ name: '1-21-11', mc: '1.21.4', loader: 'vanilla' }), '1-21-11')
  assert.equal(setupTitle({ mc: '1.21.11', loader: 'vanilla' }), '1.21.11 · Vanilla')
  assert.equal(setupTitle({ mc: '1.21.1', loader: 'fabric' }), '1.21.1 · Fabric')
})

test('the sentence under Play says what will happen', () => {
  const { playSentence } = lifted(['playSentence'])
  const text = (parts) => parts.map((x) => (typeof x === 'string' ? x : `*${x.b}*`)).join('')
  assert.equal(text(playSentence({ mc: '1.21.11', who: 'Joogiebear', server: 'survival' })), 'Opens *Minecraft 1.21.11* and joins *survival* as *Joogiebear*.')
  assert.equal(text(playSentence({ mc: '1.21.1', fabric: true, who: 'Wunga_' })), 'Opens *Minecraft 1.21.1 (Fabric)* on the title screen as *Wunga_*.')
  assert.equal(text(playSentence({ mc: '1.21.11', who: null, address: 'mc.example.net:25566' })), 'Opens *Minecraft 1.21.11* and joins *mc.example.net:25566* as *an offline player*.')
  assert.equal(text(playSentence({ mc: '1.21.11', who: 'Joogiebear', server: 'creative', startsServer: true })),
    'Starts *creative* first (up to 2 minutes), then opens *Minecraft 1.21.11* and joins it as *Joogiebear*.')
})

test('the one screen keeps the old screens\' links and the card\'s pre-fill', () => {
  // #profiles and #accounts were screens; they now open the setups and the account menu
  assert.match(html, /hash === 'profiles' \? 'setups' : hash === 'accounts' \? 'account'/)
  // the storage keys the page and the panel's server cards share are unchanged
  for (const key of ['spawnloft.launcher.job', 'spawnloft.launcher.profile']) assert.ok(html.includes(`'${key}'`), key)
  // no sidebar, no screens
  assert.doesNotMatch(html, /class="rail"|data-go=/)
})

// The states of the one screen, forced from the summaries the launcher route answers.
test('the Play screen picks one state from what the panel says', () => {
  const { playState, playAccount } = lifted(['STRICT_CODES', 'sentence', 'blockReason', 'playState', 'playAccount'])
  const ms = { name: 'Joogiebear', uuid: 'u1', type: 'microsoft', refreshFailedAt: null }
  const off = { name: 'Wunga_', uuid: 'u2', type: 'offline', refreshFailedAt: null }
  const setup = { name: '1-21-11', mc: '1.21.11', loader: 'vanilla', account: null, running: false }
  const ctx = (over = {}) => {
    const profile = over.profile ?? setup
    const accounts = over.accounts ?? [ms]
    return { down: false, loaded: true, profile, job: null, acct: playAccount(profile, accounts, over.defaultAccount ?? 'u1'), picked: null, machineRefusal: null, busy: false, otherJob: false, refusal: null, crashed: false, ...over }
  }
  const text = (parts) => parts.map((x) => (typeof x === 'string' ? x : x.b)).join('')

  assert.equal(playState({ down: true }).kind, 'unreachable')
  assert.equal(playState({ down: false, loaded: false }).kind, 'loading')
  assert.equal(playState(ctx({ profile: null })).kind, 'first-run')
  assert.equal(playState(ctx()).kind, 'ready')
  assert.equal(playState(ctx({ job: { profile: '1-21-11' } })).kind, 'launching')
  assert.equal(playState(ctx({ profile: { ...setup, running: true } })).kind, 'running')
  assert.equal(playState(ctx({ crashed: true })).kind, 'closed-early')

  // blocked: the machine
  const machine = playState(ctx({ machineRefusal: 'Minecraft has no client for Linux on arm64 (aarch64)' }))
  assert.equal(machine.kind, 'blocked')
  assert.equal(text(machine.reason), 'Minecraft can\'t be launched on this computer: Minecraft has no client for Linux on arm64 (aarch64).')
  assert.deepEqual(machine.fix, [])
  // blocked: the setup's own account was signed out
  const gone = { ...setup, account: 'gone', accountName: 'OldName', accountType: null }
  const missing = playState(ctx({ profile: gone }))
  assert.equal(text(missing.reason), 'This setup plays as OldName, who is no longer signed in.')
  assert.deepEqual(missing.fix, ['pick-account', 'sign-in'])
  // blocked: the default account's refresh failed, and a setup's own account's
  const stale = { ...ms, refreshFailedAt: '2026-10-28T00:00:00Z' }
  const expiredDefault = playState(ctx({ accounts: [stale] }))
  assert.equal(text(expiredDefault.reason), 'You play as Joogiebear, whose saved sign-in no longer works.')
  assert.deepEqual(expiredDefault.fix, ['sign-in-again', 'switch-account'])
  const ownStale = { ...setup, account: 'u1', accountName: 'Joogiebear', accountType: 'microsoft', accountUuid: 'u1' }
  assert.deepEqual(playState(ctx({ profile: ownStale, accounts: [stale] })).fix, ['sign-in-again', 'pick-account'])
  // blocked: an online-mode server for an offline player
  const online = playState(ctx({ accounts: [off], defaultAccount: 'u2', picked: { name: 'public-smp', blocked: 'needs a Microsoft account' } }))
  assert.equal(text(online.reason), 'public-smp needs a Microsoft account, and this setup plays as Wunga_.')
  assert.deepEqual(online.fix, ['sign-in', 'title-screen'])
  // blocked: another launch of it, or of another setup
  assert.equal(playState(ctx({ busy: true })).kind, 'blocked')
  assert.match(text(playState(ctx({ otherJob: true })).reason), /Another setup is launching/)
  // blocked: the version itself was refused (strict mode); there is no "launch anyway"
  const strict = playState(ctx({ refusal: 'Minecraft 26.5 needs launcher format 22; this SpawnLoft knows 21. Update SpawnLoft.' }))
  assert.equal(strict.kind, 'blocked')
  assert.deepEqual(strict.fix, ['edit'])
  // the machine outranks everything else; a crash shown under a block stays a block
  assert.deepEqual(playState(ctx({ machineRefusal: 'x', profile: gone })).fix, [])
  assert.equal(playState(ctx({ crashed: true, busy: true })).kind, 'blocked')
})

test('a version the panel refuses outright is told apart from a launch that failed', () => {
  const { versionRefusal } = lifted(['STRICT_CODES', 'versionRefusal'])
  assert.equal(versionRefusal({ code: 'newer-launcher-format', message: 'x' }), true)
  assert.equal(versionRefusal({ code: 'unknown-variable', message: 'x' }), true)
  assert.equal(versionRefusal({ message: 'Minecraft X stores its assets in a way SpawnLoft does not know. Update SpawnLoft.' }), true)
  assert.equal(versionRefusal({ message: 'no Java 21 found' }), false)
  assert.equal(versionRefusal({ code: 'java-missing', message: 'no Java 21 found' }), false)
  assert.equal(versionRefusal(null), false)
})

test('the setup sheet\'s memory and facts', () => {
  const { memoryGb, memoryFromGb, defaultMemory, versionFacts } = lifted(['memoryGb', 'memoryFromGb', 'defaultMemory', 'versionFacts'])
  assert.equal(memoryGb('4G'), 4)
  assert.equal(memoryGb('1536M'), 1.5)
  assert.equal(memoryGb('4096m'), 4)
  assert.equal(memoryGb('lots'), null)
  assert.equal(memoryFromGb(4), '4G')
  assert.equal(memoryFromGb('2.5'), '2560M')
  assert.equal(memoryFromGb(0.2), '1G')
  // the slider and the panel agree on every half step
  for (let gb = 1; gb <= 64; gb += 0.5) assert.equal(memoryGb(memoryFromGb(gb)), gb)
  assert.equal(defaultMemory('vanilla'), '2G')
  assert.equal(defaultMemory('fabric'), '4G')
  // today's picker rows carry only the harness; the all-versions plan adds the rest
  assert.deepEqual(versionFacts({ id: '1.21.1', harness: false }, null), ['no helper mod yet'])
  assert.deepEqual(versionFacts({ id: '26.3', harness: false, fabric: true, javaNeeds: 25 }, { harness: true, emulated: true }), ['Java 25', 'Fabric available', 'helper mod available', 'runs under emulation'])
  assert.deepEqual(versionFacts(null, { fabric: false }), ['no Fabric'])
  assert.deepEqual(versionFacts(null, null), [])
  // a Java read from the id is said to be a guess until the version's file says
  assert.deepEqual(versionFacts({ id: '26.5', javaNeeds: 25, javaNeedsExact: false }, null), ['likely Java 25'])
  assert.deepEqual(versionFacts({ id: '26.5', javaNeeds: 25, javaNeedsExact: false }, { javaNeeds: 25, javaNeedsExact: true }), ['Java 25'])
})

test('on a fresh install, Enter in Join plays the way Play does, and a failed version list can be read again', () => {
  // the first-run draft is not a setup the panel knows: it must never be launched by name
  assert.match(fnSource('startLaunch'), /if \(p\.name === FIRST\) return firstPlay\(\)/)
  assert.match(fnSource('firstRunView'), /joinField\(draft, plan, false\)/)
  assert.match(fnSource('firstRunView'), /id: 'versionsAgain', onclick: loadVersions/)
})

test('a re-render keeps focus on the same row of an open menu', () => {
  const src = fnSource('render')
  assert.match(src, /closest\?\.\('\.menu\[id\]'\)/)
  assert.match(src, /menuItems\(menu\)/)
  for (const id of ['menuAccount', 'menuJoin', 'menuAsk']) assert.ok(html.includes(`id: '${id}'`), id)
})

test('an offline account a setup names by key is listed once in Play as', () => {
  const { accountValue } = lifted(['accountValue'])
  const steve = { uuid: 'u-steve', name: 'Steve', type: 'offline' }
  const alex = { uuid: 'u-alex', name: 'Alex', type: 'microsoft' }
  assert.equal(accountValue(steve, 'offline:Steve'), 'offline:Steve')
  assert.equal(accountValue(steve, 'u-steve'), 'u-steve')
  assert.equal(accountValue(steve, 'offline:Alex'), 'u-steve')
  assert.equal(accountValue(alex, 'offline:Alex'), 'u-alex')
  assert.equal(accountValue(steve, ''), 'u-steve')
})

test('a server card\'s pre-fill picks the setup that fits, running or not', () => {
  const { prefillPick } = lifted(['prefillPick'])
  const profiles = [
    { name: 'a', mc: '1.21.11', server: null, running: false },
    { name: 'b', mc: '1.21.11', server: 'survival', running: true },
    { name: 'c', mc: '1.20.1', server: null },
  ]
  assert.equal(prefillPick({ mc: '1.21.11', server: 'survival' }, profiles).profile.name, 'b')
  assert.equal(prefillPick({ mc: '1.21.11', server: 'creative' }, profiles).profile.name, 'a')
  assert.equal(prefillPick({ mc: '1.19.4', server: 'x' }, profiles).profile, null)
  assert.deepEqual(prefillPick({ mc: 7, server: {} }, profiles), { mc: '', server: '', profile: profiles[0], play: false })
  // the panel's Play names its setup, which wins over a fit; Play only goes with a setup that is there
  assert.deepEqual(prefillPick({ mc: '1.21.11', server: 'survival', profile: 'a', play: true }, profiles), { mc: '1.21.11', server: 'survival', profile: profiles[0], play: true })
  assert.equal(prefillPick({ mc: '1.21.11', server: 'survival', profile: 'gone', play: true }, profiles).play, false)
  assert.equal(prefillPick({ mc: '1.21.11', server: 'survival', profile: 'gone', play: true }, profiles).profile.name, 'b')
  assert.equal(prefillPick({ mc: '1.21.11', server: 'survival', profile: 'a', play: 'yes' }, profiles).play, false)
  assert.doesNotMatch(fnSource('takePrefill'), /!p\.running/)
})

test('a game that was closed is not a crash: "Stopping!" at the end and nothing wrong before it', () => {
  const { cleanExit, crashSigns } = lifted(['crashSigns', 'saidStopping', 'cleanExit'])
  const quit = ['[21:03:00] [Render thread/INFO]: Created: 512x512x0 minecraft:textures/atlas/chest.png-atlas', '[21:03:01] [Render thread/INFO]: Stopping!', '']
  assert.equal(cleanExit(quit), true)
  // the game may say a little more after Stopping!
  assert.equal(cleanExit([...quit, '[21:03:01] [Render thread/INFO]: Stopping worker threads']), true)
  assert.equal(cleanExit([]), false)
  assert.equal(cleanExit(['[21:03:01] [Render thread/INFO]: Loading 14 mods']), false)
  // an INFO line that mentions an error is not an error; a trace whose header scrolled away is
  assert.equal(cleanExit(['[21:03:00] [Render thread/INFO]: Realms error 401 ignored', '[21:03:01] [Render thread/INFO]: Stopping!']), true)
  assert.equal(cleanExit(['\tat net.minecraft.client.Minecraft.run(Minecraft.java:1)', 'Caused by: java.lang.NullPointerException', '[21:03:01] [Render thread/INFO]: Stopping!']), false)
  // a crash that stops cleanly afterwards is still a crash
  assert.equal(cleanExit(['[21:03:00] [main/ERROR]: Incompatible mods found!', '[21:03:01] [Render thread/INFO]: Stopping!']), false)
  assert.equal(cleanExit(['# A fatal error has been detected by the Java Runtime Environment:', '[21:03:01] [Render thread/INFO]: Stopping!']), false)
  assert.equal(cleanExit(['[21:03:00] [Render thread/INFO]: Stopping!', ...Array.from({ length: 12 }, (_, i) => `[21:03:0${i % 10}] [main/INFO]: later ${i}`)]), false)
  // the signs on their own, for a game that ran a while before it went
  assert.equal(crashSigns(['[21:03:00] [main/ERROR]: Incompatible mods found!', '\tat net.fabricmc.loader.impl.discovery.ModDiscoverer.discoverMods(ModDiscoverer.java:155)']), true)
  assert.equal(crashSigns(['[21:03:00] [Render thread/WARN]: Realms error 401 ignored', '[21:03:01] [Render thread/INFO]: Stopping!']), false)
  assert.equal(crashSigns([]), false)
})

test('what Join remembered in localStorage is cleaned before the page trusts it', () => {
  const { cleanTargets } = lifted(['cleanTargets'])
  assert.deepEqual(cleanTargets(null), {})
  assert.deepEqual(cleanTargets('survival'), {})
  assert.deepEqual(cleanTargets([{ server: 'survival' }]), {})
  assert.deepEqual(cleanTargets({ a: { server: 'survival' }, b: { address: 'play.example.net' }, c: {} }), {
    a: { server: 'survival', address: '', custom: false, anyway: null },
    b: { server: null, address: 'play.example.net', custom: true, anyway: null },
    c: { server: null, address: '', custom: false, anyway: null },
  })
  // "Another address" with nothing typed yet is still the choice; "anyway" goes with its server
  assert.deepEqual(cleanTargets({ a: { address: '', custom: true }, b: { server: 'old', anyway: 'old' }, c: { server: 'old', anyway: 'other' }, d: { server: 'x', custom: true } }), {
    a: { server: null, address: '', custom: true, anyway: null },
    b: { server: 'old', address: '', custom: false, anyway: 'old' },
    c: { server: 'old', address: '', custom: false, anyway: null },
    d: { server: 'x', address: '', custom: false, anyway: null },
  })
  // junk values fall back, and an address is cut to the length the panel accepts
  assert.deepEqual(cleanTargets({ a: { server: 7, address: ['x'] }, b: null, c: 'x', d: { address: 'a'.repeat(300) } }), {
    a: { server: null, address: '', custom: false, anyway: null },
    d: { server: null, address: 'a'.repeat(260), custom: true, anyway: null },
  })
  // a key that would set the prototype is not a setup
  const odd = cleanTargets(JSON.parse('{"__proto__": {"server": "x", "address": ""}, "a": {}}'))
  assert.deepEqual(Object.keys(odd), ['a'])
  assert.equal(odd.server, undefined)
  assert.match(fnSource('loadTargets'), /return cleanTargets\(saved\)/)
})

test('the New sheet POSTs the fields the panel\'s route takes, named by the version unless a name was typed', () => {
  const { newProfileBody, editedProfile } = lifted(['nameBase', 'autoName', 'fieldText', 'profileFields', 'newProfileBody', 'editedProfile'])
  const f = { name: '  ', mc: '1.21.11', loader: 'vanilla', loaderVersion: '0.17.3', memory: '2G', java: ' ', harness: false, server: '', account: null, assistantAccount: true, serverList: true }
  assert.deepEqual(newProfileBody(f, ['1-21-11']), {
    name: '1-21-11-2', mc: '1.21.11', loader: 'vanilla', loaderVersion: null, memory: '2G', java: null, harness: false, server: null, account: null, serverList: true,
  })
  // a typed name wins; a Fabric build only goes with Fabric; typed fields are trimmed
  const modded = { ...f, name: ' modded ', loader: 'fabric', loaderVersion: ' 0.17.3 ', java: ' /opt/jdk21 ', server: 'survival', account: 'u1' }
  assert.deepEqual(newProfileBody(modded, []), {
    name: 'modded', mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '2G', java: '/opt/jdk21', harness: false, server: 'survival', account: 'u1', serverList: true,
  })
  // the POST route does not take assistantAccount; the Edit form does
  assert.ok(!('assistantAccount' in newProfileBody(f, [])))
  assert.deepEqual(editedProfile(modded), {
    mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '2G', java: '/opt/jdk21', harness: false, server: 'survival', account: 'u1', serverList: true, assistantAccount: true,
  })
  assert.equal(editedProfile(f).loaderVersion, null)
  // and saveSheet sends exactly those
  const save = fnSource('saveSheet')
  assert.match(save, /const body = newProfileBody\(f, profilesNow\(\)\.map\(\(q\) => q\.name\)\)/)
  assert.match(save, /api\('client\/profiles', \{ method: 'POST', body \}\)/)
  assert.match(save, /profilePatch\(before \?\? \{\}, editedProfile\(f\)\)/)
})

test('on a fresh install Play makes a vanilla setup for the latest release and keeps where Join pointed', () => {
  const { firstProfileBody } = lifted(['nameBase', 'autoName', 'defaultMemory', 'firstProfileBody'])
  assert.deepEqual(firstProfileBody('1.21.11', []), { name: '1-21-11', mc: '1.21.11', loader: 'vanilla', memory: '2G' })
  assert.deepEqual(firstProfileBody('1.21.11', ['1-21-11']).name, '1-21-11-2')
  const src = fnSource('firstPlay')
  assert.match(src, /body: firstProfileBody\(mc, profilesNow\(\)\.map\(\(q\) => q\.name\)\)/)
  // the draft's Join target moves to the setup that was made, then that setup is picked and launched
  assert.match(src, /if \(S\.targets\[FIRST\]\) S\.targets\[made\.name\] = S\.targets\[FIRST\]\s+delete S\.targets\[FIRST\]\s+saveTargets\(\)\s+pickProfile\(made\.name\)/)
  assert.match(src, /if \(p\) startLaunch\(p\)/)
  // a failed POST shows the fault and lets Play be pressed again
  assert.match(src, /S\.firstRun = false\s+if \(!made\) return render\(\)/)
})

test('menus are disclosures over groups of plain buttons, each in a pad with a bottom margin', () => {
  // no ARIA menu or listbox: the panels hold headings, notes and an input, which those roles forbid
  assert.doesNotMatch(html, /role: '(menu|menuitem|menuitemradio|listbox|option)'/)
  assert.doesNotMatch(html, /'aria-haspopup': '(menu|listbox|true)'/)
  for (const id of ['menuAccount']) assert.match(html, new RegExp(`id: '${id}', role: 'group', 'aria-label'`), id)
  // Join is a button that opens a dialog of choices; nothing is typed into it
  assert.match(html, /class: 'joinbox', id: 'join', 'aria-haspopup': 'dialog', 'aria-expanded': String\(open\), 'aria-controls': 'menuJoin', 'aria-labelledby': 'joinLabel joinNow'/)
  assert.doesNotMatch(html, /role: 'combobox'/)
  assert.match(html, /id: 'menuJoin', role: 'dialog'/)
  assert.match(html, /id: 'menuAsk', role: 'dialog'/)
  // every opener names what it opens, and every menu renders inside the pad
  for (const id of ['menuAccount', 'menuJoin']) assert.match(html, new RegExp(`'aria-expanded': String\\([^)]*\\), 'aria-controls': '${id}'`), id)
  assert.match(fnSource('accountChip'), /menuPad\(accountMenu\(def\)\)/)
  assert.match(fnSource('playButton'), /menuPad\(askMenu\(p\)\)/)
  assert.match(fnSource('joinField'), /menuPad\(joinMenu\(p, plan\)\)/)
  // the setups are not a menu any more: a list always in view, which the first run shares and
  // which says there are none yet
  assert.match(fnSource('playView'), /setupsPanel\(p\)/)
  assert.match(fnSource('firstRunView'), /setupsPanel\(draft\)/)
  assert.match(fnSource('setupsPanel'), /!list\.length && h\('p', \{ class: 'note', text: 'No setups yet/)
  assert.doesNotMatch(html, /menuVersion|verBtn/)
  assert.match(html, /querySelector\('\.menupad'\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)/)
  // the chosen setup is marked for the eye and for a screen reader, and every control in the
  // list has an id, which is what lets a re-render keep focus on it
  assert.match(fnSource('setupsPanel'), /class: q === p \? 'srow cur' : 'srow'/)
  assert.match(fnSource('setupsPanel'), /id: `setup-\$\{q\.name\}`, 'aria-current': q === p \? 'true' : null/)
  assert.match(fnSource('setupsPanel'), /id: `edit-\$\{q\.name\}`/)
  // the pad is positioned where the menu was and keeps a margin under it; alignment is the pad's
  assert.match(html, /\.menupad \{[^}]*position: absolute;[^}]*padding-bottom: var\(--s-6\)/)
  assert.match(html, /\.menupad:has\(> \.who\) \{ justify-content: flex-end; \}/)
})

test('removing a setup puts focus on the safe answer, and the button says when worlds go too', () => {
  const { removeLabel } = lifted(['removeLabel'])
  assert.equal(removeLabel(false), 'Remove setup')
  assert.equal(removeLabel(true), 'Remove and delete worlds')
  assert.ok(!/\$\('confirmRemove'\)\?\.focus\(\)/.test(html), 'the destructive button must not take focus when the strip opens')
  assert.match(html, /keep\?\.focus\(\)/)
})

test('what the core says for a terminal is said for the launcher', () => {
  const from = html.indexOf('const PLAIN = [')
  const to = html.indexOf('\n  ]', from)
  assert.ok(from > 0 && to > from)
  const { plain, plainStatus } = new Function(
    `${html.slice(from, to + 4)}\n${fnSource('plain')}\n${fnSource('plainStatus')}\nreturn { plain, plainStatus }`)()

  assert.equal(plain('profile "main" is running; stop it first: spawnloft client stop main'),
    '“main” is running. Close the game first, then try again.')
  assert.equal(plain('profile "main" is being launched (pid 4242); wait for it'),
    '“main” is already starting. Give it a moment, then try again.')
  assert.match(plain('invalid profile name "a b" - use letters, digits, dash, underscore (max 32 chars)'), /^That name will not work\./)
  assert.match(plain('the saved sign-in for Alex no longer works; run spawnloft client login again'), /Sign in again from the account menu\.$/)
  assert.equal(plain('the code expired before it was entered; run spawnloft client login again'), 'The sign-in ran out of time. Try again.')
  assert.equal(plain('the account could not be saved; see panel.log'), 'The account could not be saved. Try signing in again.')
  // nothing a person is told names a command or a log file
  for (const said of [
    'profile "x" is running; stop it before changing its version: spawnloft client stop x',
    'the sign-in failed inside SpawnLoft; see panel.log',
    'Minecraft refused the sign-in (HTTP 403): app not allowed',
  ]) assert.ok(!/spawnloft client|panel\.log|HTTP 403/.test(plain(said)), said)
  // and anything not listed is passed on as it is
  assert.equal(plain('Java 21 is needed for 1.21.'), 'Java 21 is needed for 1.21.')
  assert.equal(plain(null), '')

  // the busy notice still knows a launch in progress once it is said in plain words
  const { launchNotice } = lifted(['sentence', 'launchNotice'])
  assert.equal(launchNotice(plain('profile "main" is being launched (pid 4242); wait for it')).busy, true)

  assert.match(plainStatus(401), /no longer signed in/)
  assert.match(plainStatus(503), /error 503/)
  assert.match(plainStatus(418), /error 418/)

  assert.ok(!/CALLBACK_URI/.test(html))
  assert.match(html, /SpawnLoft could not open the launcher/)
})

test('a launch can be cancelled, and the page says what that left', () => {
  const { cancelledNotice } = lifted(['cancelledNotice'])
  assert.deepEqual(cancelledNotice({ startsServer: false, reached: 2 }), { tone: '', title: 'Launch cancelled', text: 'The game was not started. What was downloaded is kept for next time.' })
  // the server it had started by then is not stopped for it, and that is said
  assert.match(cancelledNotice({ startsServer: true, reached: 3 }).text, /Its server had already been asked to start, and is left to\.$/)
  assert.doesNotMatch(cancelledNotice({ startsServer: true, reached: 2 }).text, /server/)
  // the card has the button, off once the game itself is starting or the cancel is under way
  assert.match(fnSource('launchingCard'), /id: 'cancelLaunch', disabled: Boolean\(job\.cancelling\) \|\| stepOf\(job\.stage\) >= 4, onclick: \(\) => cancelLaunch\(job\)/)
  assert.match(fnSource('cancelLaunch'), /api\(`jobs\/\$\{enc\(job\.id\)\}\/cancel`, \{ method: 'POST', body: \{\} \}\)/)
  // a cancelled launch is not shown as a fault
  assert.match(fnSource('finishJob'), /ev\?\.stage === 'cancelled' \|\| ev\?\.code === 'cancelled'\) \{\s+S\.notice = \{ profile: job\.profile, \.\.\.cancelledNotice\(job\)/)
})

test('when a setup was last played, and for how long, in words', () => {
  const { dayWords, playedWords, playedLine } = lifted(['dayWords', 'playedWords', 'playedLine'])
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  assert.equal(dayWords(new Date(2026, 10, 14, 0, 5).toISOString(), now), 'today')
  assert.equal(dayWords(new Date(2026, 10, 13, 23, 55).toISOString(), now), 'yesterday')
  assert.equal(dayWords(new Date(2026, 10, 9, 12, 0).toISOString(), now), '5 days ago')
  assert.match(dayWords(new Date(2026, 5, 1, 12, 0).toISOString(), now), /2026/)
  assert.equal(dayWords('nonsense', now), '')
  assert.equal(playedWords(30000), '')
  assert.equal(playedWords(12 * 60000), '12 min')
  assert.equal(playedWords(200 * 60000), '3 h 20 min')
  assert.equal(playedWords(180 * 60000), '3 h')
  assert.equal(playedWords(41.5 * 3600000), '41 h')
  assert.equal(playedLine({ running: true, played: null }), 'Running now')
  // no record is not "never played": setups older than the record have none
  assert.equal(playedLine({ running: false, played: { lastPlayedAt: null, totalMs: 0 } }), '')
  assert.equal(playedLine({ running: false }), '')
  assert.match(playedLine({ running: false, played: { lastPlayedAt: new Date().toISOString(), totalMs: 200 * 60000 } }), /^Played today · 3 h 20 min in all$/)
})

test('your servers: the setup\'s version first, the rest behind Show all, and a search across all', () => {
  const { shownServers } = lifted(['shownServers'])
  const servers = [
    { name: 'survival', label: 'Survival', mc: '1.21.11', status: 'running', onlineMode: false },
    { name: 'creative', label: 'Creative build', mc: '1.21.11', status: 'stopped', onlineMode: false },
    { name: 't-1-20-4', label: null, mc: '1.20.4', status: 'stopped', onlineMode: false },
    { name: 't-1-8-9', label: 'Old PvP', mc: '1.8.9', status: 'stopped', onlineMode: false },
    { name: 'unknown', label: null, mc: null, status: 'stopped', onlineMode: false },
  ]
  // as serverChoices marks them: a server on another version carries that version
  const choices = servers.map((v) => ({ ...v, otherVersion: v.mc && v.mc !== '1.21.11' ? v.mc : null }))
  const names = (list) => list.map((c) => c.name)
  // a server whose version is not known is not hidden: it may well be the right one
  assert.deepEqual(names(shownServers(choices)), ['survival', 'creative', 'unknown'])
  assert.deepEqual(names(shownServers(choices, { all: true })), ['survival', 'creative', 't-1-20-4', 't-1-8-9', 'unknown'])
  // by name, by label, by version; whatever the case
  assert.deepEqual(names(shownServers(choices, { all: true, find: 'pvp' })), ['t-1-8-9'])
  assert.deepEqual(names(shownServers(choices, { all: true, find: ' 1.20 ' })), ['t-1-20-4'])
  assert.deepEqual(names(shownServers(choices, { all: true, find: 'CREAT' })), ['creative'])
  assert.deepEqual(shownServers(choices, { all: true, find: 'nothing like it' }), [])
  // a search on the page looks through every server, and the row gets its box from seven up
  assert.match(fnSource('serversRow'), /const wide = S\.serversAll \|\| p\.mc === 'latest' \|\| Boolean\(find\)/)
  assert.match(fnSource('serversRow'), /shownServers\(all, \{ all: wide, find \}\)/)
  // what was typed counts only while the box is on the page
  assert.match(fnSource('serversRow'), /const find = all\.length >= FIND_FROM \? S\.serverFind\.trim\(\) : ''/)
  assert.match(fnSource('serversRow'), /all\.length >= FIND_FROM && h\('input'/)
  // a server on another version offers a setup of that version instead of a Play that would fail
  assert.match(fnSource('serversRow'), /takePrefill\(\{ mc: c\.otherVersion, server: c\.name \}\)/)
})

test('a setup\'s badge is its version as far as the minor', () => {
  const { setupBadge } = lifted(['setupBadge'])
  assert.equal(setupBadge({ mc: '1.21.11' }), '1.21')
  assert.equal(setupBadge({ mc: '1.20' }), '1.20')
  assert.equal(setupBadge({ mc: '26.3' }), '26.3')
  assert.equal(setupBadge({ mc: '26.4-snapshot-6' }), '26.4')
  assert.equal(setupBadge({ mc: 'b1.7.3' }), 'b1.7')
})

test('a server card\'s Play is off when Play could not start for any server', () => {
  const { cardsBlocked } = lifted(['cardsBlocked'])
  const ready = { state: { kind: 'ready' }, picked: null }
  assert.equal(cardsBlocked(ready, null), false)
  assert.equal(cardsBlocked(ready, 'Linux arm64 is not supported'), true)
  // blocked by the account, say: no card can help
  assert.equal(cardsBlocked({ state: { kind: 'blocked' }, picked: null }, null), true)
  assert.equal(cardsBlocked({ state: { kind: 'blocked' }, picked: { name: 'a', blocked: null, otherVersion: null } }, null), true)
  // blocked by the server now picked: another card is the way out
  assert.equal(cardsBlocked({ state: { kind: 'blocked' }, picked: { name: 'a', blocked: 'needs a Microsoft account' } }, null), false)
  assert.equal(cardsBlocked({ state: { kind: 'blocked' }, picked: { name: 'a', otherVersion: '1.20.4' } }, null), false)
})

test('two setups of one version are told apart in the list', () => {
  const { setupSub, setupName } = lifted(['nameBase', 'givenName', 'setupTitle', 'dayWords', 'setupName', 'setupSub'])
  const first = { name: '1-21-11', mc: '1.21.11', loader: 'vanilla' }
  const second = { name: '1-21-11-2', mc: '1.21.11', loader: 'vanilla' }
  assert.equal(setupName(first), setupName(second))
  assert.equal(setupSub(first), 'not played yet')
  assert.equal(setupSub(second), '1-21-11-2 \u00b7 not played yet')
  const named = { name: 'Modded survival', mc: '1.21.1', loader: 'fabric' }
  assert.equal(setupName(named), 'Modded survival')
  assert.match(setupSub(named), /^1\.21\.1 \u00b7 Fabric.* \u00b7 not played yet$/)
})

test('the first Play makes no setup on a machine Minecraft cannot run on', () => {
  assert.match(fnSource('firstPlay'), /if \(!mc \|\| S\.firstRun \|\| S\.summary\?\.machineRefusal\) return/)
})

test('focus goes back to what opened the sheet', () => {
  assert.match(fnSource('openSheet'), /S\.sheetFrom = document\.activeElement\?\.id \|\| null/)
  assert.match(fnSource('closeSheet'), /backFromSheet\(\)/)
  assert.match(fnSource('saveSheet'), /if \(!S\.sheet\) backFromSheet\(\)/)
  assert.match(fnSource('duplicateProfile'), /if \(!S\.sheet\) backFromSheet\(\)/)
})

test('the page is a fixed size, not a share of the window', () => {
  assert.match(html, /\.playgrid \{ width: min\(1120px, 100%\);[^}]*grid-template-columns: minmax\(0, 1fr\) 312px;/)
  assert.doesNotMatch(html, /\.playbox \{[^}]*vw/)
  assert.doesNotMatch(html, /\.playrow \.play \{[^}]*vw/)
})
