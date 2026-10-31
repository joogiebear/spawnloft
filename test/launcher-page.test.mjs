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

test('the Join menu lists every server, notes another version and blocks online servers for offline players', () => {
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
  assert.match(html, /hash === 'profiles' \? 'version' : hash === 'accounts' \? 'account'/)
  // the storage keys the page and the panel's server cards share are unchanged
  for (const key of ['spawnloft.launcher.newProfile', 'spawnloft.launcher.job', 'spawnloft.launcher.profile']) assert.ok(html.includes(`'${key}'`), key)
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
  assert.deepEqual(versionFacts({ id: '1.21.1', harness: false }, null), ['harness not published'])
  assert.deepEqual(versionFacts({ id: '26.3', harness: false, fabric: true, javaNeeds: 25 }, { harness: true, emulated: true }), ['Java 25', 'Fabric available', 'harness published', 'runs under emulation'])
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
  for (const id of ['menuAccount', 'menuVersion', 'menuJoin', 'menuAsk']) assert.ok(html.includes(`id: '${id}'`), id)
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
  assert.deepEqual(prefillPick({ mc: 7, server: {} }, profiles), { mc: '', server: '', profile: profiles[0] })
  assert.doesNotMatch(fnSource('takePrefill'), /!p\.running/)
})

test('a game that was closed is not a crash: "Stopping!" at the end and nothing wrong before it', () => {
  const { cleanExit } = lifted(['cleanExit'])
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
})

test('what Join remembered in localStorage is cleaned before the page trusts it', () => {
  const { cleanTargets } = lifted(['cleanTargets'])
  assert.deepEqual(cleanTargets(null), {})
  assert.deepEqual(cleanTargets('survival'), {})
  assert.deepEqual(cleanTargets([{ server: 'survival' }]), {})
  assert.deepEqual(cleanTargets({ a: { server: 'survival' }, b: { address: 'play.example.net' }, c: {} }), {
    a: { server: 'survival', address: '' },
    b: { server: null, address: 'play.example.net' },
    c: { server: null, address: '' },
  })
  // junk values fall back, and an address is cut to the length the panel accepts
  assert.deepEqual(cleanTargets({ a: { server: 7, address: ['x'] }, b: null, c: 'x', d: { address: 'a'.repeat(300) } }), {
    a: { server: null, address: '' },
    d: { server: null, address: 'a'.repeat(260) },
  })
  assert.match(fnSource('loadTargets'), /return cleanTargets\(saved\)/)
})

test('the New sheet POSTs the fields the panel\'s route takes, named by the version unless a name was typed', () => {
  const { newProfileBody, editedProfile } = lifted(['nameBase', 'autoName', 'fieldText', 'newProfileBody', 'editedProfile'])
  const f = { name: '  ', mc: '1.21.11', loader: 'vanilla', loaderVersion: '0.17.3', memory: '2G', java: ' ', harness: false, server: '', account: null, assistantAccount: true }
  assert.deepEqual(newProfileBody(f, ['1-21-11']), {
    name: '1-21-11-2', mc: '1.21.11', loader: 'vanilla', loaderVersion: null, memory: '2G', java: null, harness: false, server: null, account: null,
  })
  // a typed name wins; a Fabric build only goes with Fabric; typed fields are trimmed
  const modded = { ...f, name: ' modded ', loader: 'fabric', loaderVersion: ' 0.17.3 ', java: ' /opt/jdk21 ', server: 'survival', account: 'u1' }
  assert.deepEqual(newProfileBody(modded, []), {
    name: 'modded', mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '2G', java: '/opt/jdk21', harness: false, server: 'survival', account: 'u1',
  })
  // the POST route does not take assistantAccount; the Edit form does
  assert.ok(!('assistantAccount' in newProfileBody(f, [])))
  assert.deepEqual(editedProfile(modded), {
    mc: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memory: '2G', java: '/opt/jdk21', harness: false, server: 'survival', account: 'u1', assistantAccount: true,
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
  assert.doesNotMatch(html, /role: '(menu|menuitem|menuitemradio|listbox|option|combobox)'/)
  assert.doesNotMatch(html, /aria-haspopup/)
  for (const id of ['menuAccount', 'menuVersion', 'menuJoin']) assert.match(html, new RegExp(`id: '${id}', role: 'group', 'aria-label'`), id)
  assert.match(html, /id: 'menuAsk', role: 'dialog'/)
  // every opener names what it opens, and every menu renders inside the pad
  for (const id of ['menuAccount', 'menuVersion', 'menuJoin']) assert.match(html, new RegExp(`'aria-expanded': String\\([^)]*\\), 'aria-controls': '${id}'`), id)
  assert.match(fnSource('accountChip'), /menuPad\(accountMenu\(def\), true\)/)
  assert.match(fnSource('playButton'), /menuPad\(versionMenu\(p\), true\)/)
  assert.match(fnSource('playButton'), /menuPad\(askMenu\(p\)\)/)
  assert.match(fnSource('joinField'), /menuPad\(joinMenu\(p, plan\)\)/)
  assert.match(fnSource('firstRunView'), /menuPad\(h\('div', \{ class: 'menu vmenu'/)
  assert.match(html, /querySelector\('\.menupad'\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)/)
  // the chosen setup carries a mark, the others an empty one, so the rows line up
  assert.match(fnSource('versionMenu'), /h\('span', \{ class: 'mark' \}, q === p && ico\('check'\)\)/)
  assert.match(html, /\.menupad \{ position: absolute; z-index: 6; top: calc\(100% \+ 6px\); left: 0; right: 0; padding-bottom: var\(--s-6\)/)
})
