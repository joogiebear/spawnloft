import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The panel is one document with no build step, so its logic cannot be imported. The pure
// functions are lifted out of the source by name instead (a const is one line, a function runs to
// its balanced closing brace) and throw if the file is reshaped, rather than testing nothing.
const html = fs.readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8')

function constSource(name) {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(html)
  assert.ok(m, `could not find "const ${name}" in ui.html`)
  return m[0]
}

function fnSource(name) {
  const at = html.indexOf(`function ${name}(`)
  assert.ok(at !== -1, `could not find "function ${name}" in ui.html`)
  let depth = 0
  for (let i = html.indexOf('{', at); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) return html.slice(html.slice(at - 6, at) === 'async ' ? at - 6 : at, i + 1)
  }
  assert.fail(`unbalanced braces after "function ${name}"`)
}

const lifted = (names) => new Function(
  `${names.map((n) => (/^[A-Z_]+$/.test(n) ? constSource(n) : fnSource(n))).join('\n')}
   return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} }`,
)()

test('the page script parses', () => {
  // A stray line in a generated edit left the boot block unclosed once; node --check never sees
  // the inline script, so this does.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length >= 1)
  for (const src of scripts) new Function(src)
})

const { levelOf } = lifted(['MCCTL_RE', 'LEVEL_RE', 'BARE_LEVEL_RE', 'CONT_RE', 'EXC_RE', 'levelOf'])
const { cleanConsoleText } = lifted(['ANSI_STRING_RE', 'ANSI_CSI_RE', 'ANSI_ESCAPE_RE', 'LOG_CONTROL_RE', 'cleanConsoleText'])

test('console strips ANSI colors before classification, search and copy', () => {
  const text = cleanConsoleText('\x1b[0m[12:34:56 \x1b[33mWARN\x1b[0m]: \x1b[38;2;255;90;0mwarning\x1b[m')
  assert.equal(text, '[12:34:56 WARN]: warning')
  assert.equal(levelOf(text), 'warn')
  assert.equal(cleanConsoleText('\x1b[38;5;123mindexed\x1b[0m'), 'indexed')
  assert.equal(cleanConsoleText('\x9b31mred\x9b0m'), 'red')
})

test('terminal hyperlinks retain their label without URL or OSC sequences', () => {
  assert.equal(cleanConsoleText('\x1b]8;;https://example.com\x07docs\x1b]8;;\x07'), 'docs')
  assert.equal(cleanConsoleText('\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\'), 'docs')
  assert.equal(cleanConsoleText('\x9d8;;https://example.com\x9cdocs\x9d8;;\x9c'), 'docs')
  assert.equal(cleanConsoleText('\x1b]0;terminal title\x07message'), 'message')
})

test('console removes cursor commands and control strings without losing ordinary text', () => {
  assert.equal(cleanConsoleText('\x1b[2K\x1b[1Gmessage\x1b[?25h\r\x07'), 'message')
  assert.equal(cleanConsoleText('\x1b7saved\x1b8'), 'saved')
  assert.equal(cleanConsoleText('\x1bPignored terminal data\x1b\\message'), 'message')
  assert.equal(cleanConsoleText('message\x1b[33'), 'message')
  assert.equal(cleanConsoleText('\tat plugin.方法(File.java:42) — §aGreen [brackets]'), '\tat plugin.方法(File.java:42) — §aGreen [brackets]')
  assert.equal(cleanConsoleText(''), '')
})

// Exercise the real refresh function with an already-rendered history. Any attempt to
// rebuild the form reaches an unstubbed DOM method and fails instead of hiding lost edits.
function backupRefreshFixture(api) {
  const state = { current: 'test-server' }
  const status = { textContent: '' }
  const history = {
    isConnected: true, dataset: { backupHistory: '' }, replacements: 0,
    replaceWith(next) { this.dataset.backupHistory = next; this.replacements++ },
  }
  const body = {
    dataset: { for: state.current },
    querySelector(selector) { return selector === '[data-backup-history]' ? history : status },
  }
  const render = new Function('state', 'body', 'api', `
    let backupRequest = 0;
    let backupPending = null;
    const $ = () => body;
    const rowOf = name => ({ name });
    const renderBackupHistory = (row, data, signature) => signature;
    return ${fnSource('renderBackups')};
  `)(state, body, api)
  return { render, state, body, history, status }
}

test('backup history refreshes external changes without rebuilding unchanged history or forms', async () => {
  const data = { snapshots: [], running: false, dir: '/backups/test-server', root: '/backups', mirror: null }
  const fixture = backupRefreshFixture(async route => {
    assert.equal(route, '/instances/test-server/backups/history')
    return data
  })
  await fixture.render()
  await fixture.render()
  assert.equal(fixture.history.replacements, 1)
  data.snapshots.push({ name: 'cli-backup.tar.gz' })
  await fixture.render()
  assert.equal(fixture.history.replacements, 2)
  data.running = true
  await fixture.render()
  assert.equal(fixture.history.replacements, 3, 'Restore availability must follow server state')
})

test('backup polling does not overlap, and discards an answer after selecting another server', async () => {
  let answer
  let calls = 0
  const fixture = backupRefreshFixture(() => {
    calls++
    return new Promise(resolve => { answer = resolve })
  })
  const pending = fixture.render()
  await fixture.render()
  assert.equal(calls, 1)
  fixture.state.current = 'another-server'
  answer({ snapshots: [] })
  await pending
  assert.equal(fixture.history.replacements, 0)
})

test('a failed backup refresh preserves history, reports stale data, and recovers', async () => {
  let fail = true
  const fixture = backupRefreshFixture(async () => {
    if (fail) throw new Error('connection unavailable')
    return { snapshots: [] }
  })
  await fixture.render()
  assert.equal(fixture.history.replacements, 0)
  assert.match(fixture.status.textContent, /could not refresh: connection unavailable/)
  fail = false
  await fixture.render()
  assert.equal(fixture.status.textContent, '')
  assert.equal(fixture.history.replacements, 1)
})

// Paper does not have one log format, it has four; all of them appear in a single session.
test('every format Paper actually emits classifies by its level', () => {
  assert.equal(levelOf('[00:42:27 INFO]: [bootstrap] Running Java 25'), 'info')
  assert.equal(levelOf('[12:42:11 ERROR]: Exception loading blah'), 'error')
  assert.equal(levelOf('[13:37:00 WARN]: [EcoItems] no supported recipe'), 'warn')
  assert.equal(levelOf('[12:34:56] [Server thread/INFO]: Done (3.1s)!'), 'info')
  assert.equal(levelOf('[12:34:56] [Server thread/WARN]: legacy format'), 'warn')
  assert.equal(levelOf('2026-08-31T05:42:27.5Z ServerMain WARN Advanced terminal features'), 'warn')
  assert.equal(levelOf('Starting org.bukkit.craftbukkit.Main'), 'info')
})

test('SEVERE and FATAL are errors; WARNING is a warning', () => {
  assert.equal(levelOf('[12:00:00 SEVERE]: it broke'), 'error')
  assert.equal(levelOf('[12:00:00 FATAL]: it really broke'), 'error')
  assert.equal(levelOf('[12:00:00 WARNING]: old spelling'), 'warn')
})

// A stack trace carries no level of its own; filtering to errors must show the twenty lines
// that say what broke, not just the one-line summary.
test('a stack trace inherits the level of the line that introduced it', () => {
  assert.equal(levelOf('java.lang.ClassCastException: ServerProfile', 'error'), 'error')
  assert.equal(levelOf('\tat com.willfp.eco.ProfileHandler.get(ProfileHandler.kt:41)', 'error'), 'error')
  assert.equal(levelOf('Caused by: java.lang.NullPointerException', 'error'), 'error')
  assert.equal(levelOf('... 12 more', 'error'), 'error')
  assert.equal(levelOf('\tat com.example.Fine(Fine.java:1)', 'warn'), 'warn')
  // ...but never from a spawnloft system line, which is not a server error.
  assert.equal(levelOf('\tat com.example.Fine(Fine.java:1)', 'sys'), 'info')
})

test('spawnloft speaking for itself is sys, never a server level', () => {
  assert.equal(levelOf('[spawnloft] server process exited (code=0)'), 'sys')
  // consoles written before the rename, and daemons still running from the old version, say [mcctl]
  assert.equal(levelOf('[mcctl] server process exited (code=0)'), 'sys')
})

const { memoryCeilingMb } = lifted(['memoryCeilingMb'])

test('the memory graph ceiling accepts both units and refuses junk', () => {
  assert.equal(memoryCeilingMb('2G'), 2048)
  assert.equal(memoryCeilingMb('3072M'), 3072)
  assert.equal(memoryCeilingMb(' 4g '), 4096)
  assert.equal(memoryCeilingMb('4'), 4096)
  assert.equal(memoryCeilingMb('*G'), null)
  assert.equal(memoryCeilingMb(''), null)
})

// The design tokens are deliberately duplicated between the panel and the setup wizard (change
// both or neither). verify-build checks this only in a packaged build; this catches a half-edit sooner.
function tokensOf(file, website = false) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  const block = (website ? /:root\[data-theme="spawnloft"\]\s*\{([\s\S]*?)\n {2}\}/ : /:root\s*\{([\s\S]*?)\n {2}\}/).exec(src)
  assert.ok(block, `no :root block in ${file}`)
  const map = {}
  for (const m of block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim()
  assert.ok(Object.keys(map).length > 20, `only ${Object.keys(map).length} tokens found in ${file}`)
  return map
}

test('the panel and the setup wizard share one token block, values included', () => {
  assert.deepEqual(tokensOf('../src/ui.html'), tokensOf('../src/setup.html'))
})

test('the website palette stays consistent between the panel and setup wizard', () => {
  assert.deepEqual(tokensOf('../src/ui.html', true), tokensOf('../src/setup.html', true))
})

test('the game launcher carries the same token block as the panel, both palettes', () => {
  assert.deepEqual(tokensOf('../src/launcher.html'), tokensOf('../src/ui.html'))
  assert.deepEqual(tokensOf('../src/launcher.html', true), tokensOf('../src/ui.html', true))
})

test('the overview feed folds a run of the same thing into one line, and only a run', () => {
  const { groupActivity } = lifted(['FEED_RUN_GAP_MS', 'actorKey', 'groupActivity'])
  const you = { kind: 'panel' }
  const at = (min) => new Date(Date.UTC(2026, 9, 17, 12, 0) - min * 60000).toISOString()
  const del = (min, by = you) => ({ at: at(min), server: 'RoyalSkyblock', action: 'backup-delete', by, detail: `b${min}.tar.gz` })
  const runs = groupActivity([
    del(0), del(1), del(2),
    // the same action by someone else is not the same run
    del(3, { kind: 'assistant', name: 'Claude' }),
    { at: at(4), server: 'RoyalSkyblock', action: 'schedule-remove', by: you, detail: 'Automatic backup' },
    del(5), del(6),
    // more than half an hour after the one before it: a new run
    del(60),
    { at: at(61), server: 'Lobby', action: 'backup-delete', by: you, detail: 'x.tar.gz' },
  ])
  assert.deepEqual(runs.map((r) => r.entries.length), [3, 1, 1, 2, 1, 1])
  assert.equal(runs[0].entries[0].detail, 'b0.tar.gz', 'newest first, inside a run too')
  assert.notEqual(runs[3].key, runs[5].key, 'another server is another run')
})

const { playProfileFor } = lifted(['playProfileFor'])

test('Play picks the profile for the server\'s version, preferring the one pointed at it', () => {
  const profiles = [{ name: 'a', mc: '1.21.11', server: null }, { name: 'b', mc: '1.21.11', server: 'surv' }, { name: 'c', mc: '1.20.1', server: 'surv' }]
  assert.equal(playProfileFor({ name: 'surv', mcVersion: '1.21.11' }, profiles).name, 'b')
  assert.equal(playProfileFor({ name: 'other', mcVersion: '1.21.11' }, profiles).name, 'a')
  assert.equal(playProfileFor({ name: 'x', mcVersion: '1.19.4' }, profiles), null)
  assert.equal(playProfileFor({ name: 'x', mcVersion: null }, profiles).name, 'a')
  assert.equal(playProfileFor({ name: 'x', mcVersion: '1.21.11' }, []), null)
})

test('deleting in Files names what goes, and asks for the server name when the server itself would go', () => {
  const { deleteConfirm } = lifted(['deleteConfirm'])
  const entries = [
    { path: 'world', type: 'dir' }, { path: 'plugins', type: 'dir' }, { path: 'server.jar', type: 'file' },
    { path: 'server.properties', type: 'file' }, { path: 'eula.txt', type: 'file' }, { path: 'notes.txt', type: 'file' },
    { path: 'logs', type: 'dir' }, { path: 'crash-reports', type: 'dir' }, { path: 'rpg', type: 'dir' },
  ]
  const one = deleteConfirm('survival', ['plugins/Old.jar'], entries)
  assert.deepEqual(one, { what: 'Old.jar', text: 'A copy is kept first, so Backups can put it back.', typeToConfirm: null })

  // routine cleanup is not the server going, and is not described as if it were
  const tidy = deleteConfirm('survival', ['logs', 'crash-reports'], entries)
  assert.equal(tidy.typeToConfirm, null)
  assert.equal(tidy.text, 'This deletes logs, crash-reports. A copy is kept first, so Backups can put them back.')

  const all = deleteConfirm('survival', entries.map((e) => e.path), entries)
  assert.equal(all.what, '9 items')
  assert.equal(all.typeToConfirm, 'survival')
  assert.match(all.text, /^This deletes world, plugins, server\.jar, server\.properties, eula\.txt, notes\.txt and 3 more\. The server cannot run as it is without world, plugins, server\.jar, server\.properties\. /)

  // one thing can be the server too: the world on its own is asked about the same way
  const world = deleteConfirm('survival', ['world'], entries)
  assert.equal(world.typeToConfirm, 'survival')
  assert.match(world.text, /^The server cannot run as it is without world\. A copy is kept first/)
  // the world is whatever level-name says, not the word "world"
  assert.equal(deleteConfirm('survival', ['rpg'], entries, 'rpg').typeToConfirm, 'survival')
  assert.equal(deleteConfirm('survival', ['rpg'], entries).typeToConfirm, null)
  // inside a subfolder nothing is "the server": the copy in Backups is enough
  assert.equal(deleteConfirm('survival', ['plugins/A', 'plugins/B.jar'], [{ path: 'plugins/A', type: 'dir' }]).typeToConfirm, null)
})

test('the Restore dialog promises a copy only when one can be kept, and says the databases are not in it', () => {
  const { restoreWords } = lifted(['restoreWords'])
  assert.deepEqual(restoreWords({ members: ['world', 'plugins'], databases: [] }),
    { copy: 'A copy of the files as they are now is kept in this list first.', note: '' })
  assert.match(restoreWords({ members: [], databases: [] }).copy, /no copy of how things are now can be kept/)
  assert.match(restoreWords({ members: ['databases'] }).copy, /no copy/)
  assert.match(restoreWords({ members: ['world', 'databases'], databases: [{ database: 'x' }] }).note, /databases are not part of the copy/)
})

test('copying a secret never spells it out in a label, a tooltip or a toast', () => {
  const { copyWords } = lifted(['copyWords'])
  const secret = copyWords('hunter2', 'password', true)
  assert.ok(!JSON.stringify(secret).includes('hunter2'))
  assert.deepEqual(secret, { title: 'Copy the password', label: 'Copy the password', said: 'the password' })
  assert.deepEqual(copyWords('127.0.0.1:25565', 'address', false),
    { title: 'Copy 127.0.0.1:25565', label: 'Copy address 127.0.0.1:25565', said: '127.0.0.1:25565' })
  // the admin password and the URL that carries it are the two rows marked secret
  assert.match(html, /\['Password', c\.password, 'password', true\], \['URL', c\.url, 'URL', true\]/)
})

test('forgetting an external database says nothing was deleted', () => {
  const { forgetWords } = lifted(['forgetWords'])
  const words = forgetWords('Shared MySQL', ['survival'])
  assert.equal(words.title, 'Forget Shared MySQL?')
  assert.match(words.text, /keeps running where it is/)
  assert.match(words.text, /Attached: survival\./)
  assert.ok(!/delet/i.test(words.text + words.done))
})

test('an upload stays in the folder it started in, and unsaved editor text is noticed', () => {
  const { uploadUrl, unsavedFiles } = lifted(['uploadUrl', 'unsavedFiles'])
  assert.equal(uploadUrl('/api/x/files/upload', 'plugins/My Plugin', 'a b.yml', false), '/api/x/files/upload?dir=plugins%2FMy%20Plugin&name=a%20b.yml')
  assert.equal(uploadUrl('/u', '', 'a', true), '/u?dir=&name=a&overwrite=1')
  // view.dir is read once, before the first file goes: later reads would follow the person to another folder
  const body = fnSource('uploadFiles').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(body.split('view.dir').length - 1, 1)

  const views = new Map([
    ['clean', { editing: { text: 'a', original: 'a' } }],
    ['dirty', { editing: { text: 'b', original: 'a' } }],
    ['closed', { editing: null }],
  ])
  assert.deepEqual(unsavedFiles(views), ['dirty'])
  assert.match(html, /addEventListener\('beforeunload'/)
  assert.match(html, /window\.addEventListener\('drop'/)
})

test('a restore locks its list: every button off, and the row says it is restoring', () => {
  // a few elements, enough for the function to run for real
  const button = () => ({ disabled: false, title: '' })
  const line = (name) => {
    const attrs = new Map()
    const when = { textContent: 'Nov 14', setAttribute: (k, v) => attrs.set('when.' + k, v) }
    return { dataset: { backupName: name }, attrs, when,
      hasAttribute: (k) => attrs.has(k), setAttribute: (k, v) => attrs.set(k, v), querySelector: () => when }
  }
  const scopeOf = (buttons, lines) => ({ querySelectorAll: (sel) => (sel === 'button' ? buttons : lines) })
  const { lockRestoring, restoring } = new Function(`${constSource('restoring')}\n${fnSource('lockRestoring')}\nreturn { lockRestoring, restoring }`)()

  const buttons = [button(), button(), button()]
  const lines = [line('a.tar.gz'), line('b.tar.gz')]
  lockRestoring(scopeOf(buttons, lines), 'survival')
  assert.ok(buttons.every((b) => !b.disabled), 'nothing is locked when nothing is restoring')

  restoring.set('survival', 'b.tar.gz')
  lockRestoring(scopeOf(buttons, lines), 'creative')
  assert.ok(buttons.every((b) => !b.disabled), 'another server restoring locks nothing here')
  lockRestoring(scopeOf(buttons, lines), 'survival')
  assert.ok(buttons.every((b) => b.disabled && b.title === 'Wait for the restore to finish'))
  assert.equal(lines[0].attrs.has('data-restoring'), false)
  assert.equal(lines[1].attrs.get('aria-busy'), 'true')
  assert.match(lines[1].when.textContent, /^Restoring this one/)
  // drawn again during the restore: still locked, the row not written twice
  lines[1].when.textContent = 'x'
  lockRestoring(scopeOf(buttons, lines), 'survival')
  assert.equal(lines[1].when.textContent, 'x')

  // both pages mark the restore before sending it and clear the mark whatever happens
  assert.equal(html.split('restoring.set(row.name,').length - 1, 2)
  assert.equal(html.split('restoring.delete(row.name);').length - 1, 2)
})

test('the Backups strip counts only backups of the server, and a custom schedule or a bad keep number is not saved as something else', () => {
  const { isWholeBackup, keepProblem, scheduledBackupWords, backupsMoveWords } = new Function(
    `const panelPlatform = 'linux';\nconst CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });\n${fnSource('clockWords')}\n${constSource('DAY_NAMES')}\n  FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };\n${fnSource('describeSchedule')}\n${fnSource('singleFileOf')}\n${fnSource('isWholeBackup')}\n${fnSource('keepProblem')}\n${fnSource('scheduledBackupWords')}\n${fnSource('backupsMoveWords')}
     return { isWholeBackup, keepProblem, scheduledBackupWords, backupsMoveWords }`)()
  assert.equal(isWholeBackup({ scope: 'standard', members: ['world', 'plugins'] }), true)
  assert.equal(isWholeBackup({ scope: 'worlds', members: ['world'] }), true)
  assert.equal(isWholeBackup({ scope: 'full', members: ['a', 'b'] }), true)
  // a copy of the plugins before an install, or of the config, is not "backed up just now"
  assert.equal(isWholeBackup({ scope: 'plugins', members: ['plugins'] }), false)
  assert.equal(isWholeBackup({ scope: 'config', members: ['server.properties', 'config'] }), false)
  assert.equal(isWholeBackup({ scope: 'files', members: ['a', 'b'] }), false)

  for (const bad of ['', ' ', '0', '-3', '2.5', 'abc', '366']) assert.equal(keepProblem(bad), 'Use a whole number from 1 to 365.', bad)
  for (const good of ['1', '7', '365', ' 14 ']) assert.equal(keepProblem(good), null, good)
  // a task that keeps everything may go on doing so, with the box left empty
  assert.equal(keepProblem('', true), null)
  assert.equal(keepProblem('0', true), 'Use a whole number from 1 to 365.')

  assert.equal(scheduledBackupWords([{ name: 'Weekly world backup', schedule: { kind: 'weekly', day: 'SUN', at: '03:00' } }]),
    '“Weekly world backup” runs every Sunday at 03:00. Change it in Schedule.')
  assert.match(scheduledBackupWords([{ name: 'A', schedule: { kind: 'daily', at: '04:30' } }, { name: 'B', schedule: { kind: 'hourly', every: 1 } }]), /every day at 04:30, and 1 more\./)

  const words = backupsMoveWords('/old/backups', '/new/backups')
  for (const text of [words.before, words.after]) assert.match(text, /not moved|nothing was moved/)
  assert.match(words.pending, /^Changes to \/new\/backups when SpawnLoft restarts\./)
  // the choice that keeps a schedule made elsewhere exists, and is what Apply sends for it
  assert.match(html, /every\.value === KEEP_SCHEDULE \? \{ schedule: known\.auto\.schedule \}/)
})

test('a tool drawn for a stopped server is drawn again when the server starts, unless that would lose typing', () => {
  const { followPlan, playersDue } = lifted(['PLAYERS_EVERY_MS', 'followPlan', 'playersDue'])
  const stale = ['players', 'plugins', 'worlds', 'files', 'scheduler']
  // the open tool is redrawn; the hidden ones are forgotten, so they read afresh when opened
  const none = () => false
  assert.deepEqual(followPlan(stale, 'worlds', none), { redraw: 'worlds', forget: ['players', 'plugins', 'files', 'scheduler'], keep: [] })
  // somebody is typing in it: left as it is, and kept for the next look
  assert.deepEqual(followPlan(stale, 'scheduler', (t) => t === 'scheduler'), { redraw: null, forget: ['players', 'plugins', 'worlds', 'files'], keep: ['scheduler'] })
  // a hidden tool with an import path typed into it is not thrown away either
  assert.deepEqual(followPlan(stale, 'players', (t) => t === 'worlds'), { redraw: 'players', forget: ['plugins', 'files', 'scheduler'], keep: ['worlds'] })
  // the console, or a tool that does not depend on the server being up, is open
  assert.deepEqual(followPlan(stale, null, none).forget, stale)
  assert.equal(followPlan(stale, 'backups', none).redraw, null)
  // a server's tools are followed from the moment it is chosen, and a tool asked for with the
  // server is opened once the server is, including after the question about unsaved settings
  assert.match(html, /if \(chosen\) followFrom\(chosen\);/)
  assert.match(html, /select\(name, \{ then: \(\) => showPane\(tool\) \}\)/)
  assert.match(html, /if \(ok\) select\(name, \{ discard: true, then \}\)/)

  // an open Players list is read again while people can still come and go, and not otherwise
  const up = { status: 'running' }
  assert.equal(playersDue(up, 'players', 0, 20000), true)
  assert.equal(playersDue(up, 'players', 0, 19999), false)
  assert.equal(playersDue(up, 'worlds', 0, 60000), false)
  assert.equal(playersDue({ status: 'stopped' }, 'players', 0, 60000), false)
  assert.equal(playersDue(null, 'players', 0, 60000), false)

  // Players and Schedule read afresh each time they are opened, and Run now looks more than once
  assert.match(html, /if \(t === 'scheduler'\) renderScheduler\(\{ force: !paneHolds\(/)
  assert.match(html, /if \(t === 'players'\) renderPlayers\(\{ force: !paneHolds\(/)
  assert.match(html, /RUN_CHECKS_MS = \[2500, 10000, 30000, 60000\]/)
  assert.ok(!/setTimeout\(\(\) => \{ if \(!editor\.restore\) again\(\); \}, 2500\)/.test(html))
})

test('Settings asks for a restart only when a changed setting needs one, and never shows an empty save bar', () => {
  const { needsRestart, savedWords } = lifted(['needsRestart', 'savedWords'])
  assert.equal(needsRestart([{ live: true }]), false)
  assert.equal(needsRestart([{ live: true }, {}]), true)
  assert.equal(needsRestart([]), false)
  const on = { running: true, name: 'Hub' }
  assert.equal(savedWords(1, { ...on, needsRestart: false }), 'Saved 1 setting. In force now.')
  assert.equal(savedWords(3, { ...on, needsRestart: true }), 'Saved 3 settings. Restart Hub to apply.')
  assert.equal(savedWords(3, { ...on, needsRestart: true, restarting: true }), 'Saved 3 settings.')
  assert.equal(savedWords(2, { running: false, needsRestart: true, name: 'Hub' }), 'Saved 2 settings.')
  // the two the supervisor reads again at every exit are the ones marked
  assert.match(html, /kind: 'own', key: 'autoRestart', live: true/)
  assert.match(html, /kind: 'own', key: 'webhook', live: true/)
  assert.equal((html.match(/live: true/g) || []).length, 2)
  // only update() shows or hides the bar
  const hides = [...html.matchAll(/\bbar\.hidden = ([^;]+);/g)].map((m) => m[1])
  assert.deepEqual(hides, ['true', '!n && !saving'])
})

test('unsaved Settings are asked about before another server is chosen, and survive an upgrade or a database change', () => {
  const { leaveSettingsWords } = lifted(['leaveSettingsWords'])
  const one = leaveSettingsWords({ name: 'hub', count: 1 }, 'Hub Lobby')
  assert.equal(one.title, 'Leave Hub Lobby without saving?')
  assert.equal(one.text, '1 change in its Settings has not been saved, and will be lost.')
  assert.equal(one.confirmLabel, 'Discard the change')
  assert.equal(leaveSettingsWords({ name: 'hub', count: 4 }, 'Hub').text, '4 changes in its Settings have not been saved, and will be lost.')
  // nothing redraws the whole of Settings after an attach, a detach or a new database
  const dbs = html.slice(html.indexOf('async function renderServerDatabases('), html.indexOf('async function renderDatabaseBackups('))
  assert.ok(dbs.length > 1000)
  assert.ok(!/renderServerSettings\(\)/.test(dbs))
  assert.equal((dbs.match(/await again\(\)/g) || []).length, 3)
  // a page with unsaved settings asks before it closes, like one with an unsaved file
  assert.match(html, /!unsavedFiles\(filesByServer\)\.length && !settingsWaiting\(\)/)
  // a form left behind by a server that was renamed or removed holds nobody up
  assert.match(html, /state\.current !== row\.name \|\| !rowOf\(row\.name\)\) return null;/)
})

test('a change to a player is reported from what the server did, not from what it said', () => {
  const { playerChangeWords } = lifted(['playerChangeWords'])
  assert.deepEqual(playerChangeWords({ via: 'console', reply: 'Made Steve a server operator', took: true }, 'Steve is now an operator.'),
    { text: 'Steve is now an operator.', tone: 'good' })
  assert.deepEqual(playerChangeWords({ via: 'console', reply: 'That player does not exist', took: false }, 'Steve is now an operator.'),
    { text: 'The server’s own list does not show that change. It answered: That player does not exist', tone: '' })
  // not a success and not called a refusal: a ban plugin keeps a list of its own
  assert.equal(playerChangeWords({ via: 'console', reply: '', took: false }, 'x').text, 'The server’s own list does not show that change. It gave no answer.')
  // a stopped server's files were written by SpawnLoft itself: there is no reply to doubt
  assert.deepEqual(playerChangeWords({ via: 'file' }, 'Steve is banned.'), { text: 'Steve is banned.', tone: 'good' })
})

test('the update check says what it covered instead of an all-clear for nothing', () => {
  const { updateCheckWords } = lifted(['updateCheckWords'])
  const none = { updates: [], checked: 0, byHand: 3, off: 0, pack: 0, unknown: 0, unreachable: [] }
  assert.equal(updateCheckWords({ ...none, byHand: 0, checked: 2, unknown: 1 }, 'plugin'),
    'Checked 2: all already the newest build. 1 plugin could not be matched to a listing, so nothing is known about it.')
  assert.equal(updateCheckWords(none, 'plugin'), 'Nothing was checked. 3 plugins added by hand cannot be checked.')
  assert.equal(updateCheckWords({ ...none, checked: 6, byHand: 0 }, 'plugin'), 'Checked 6: all already the newest build.')
  assert.equal(updateCheckWords({ ...none, checked: 1, byHand: 0 }, 'mod'), 'Checked 1: it is already the newest build.')
  assert.equal(updateCheckWords({ updates: [{}, {}], checked: 5, byHand: 1, off: 1, pack: 2, unreachable: ['EssentialsX'] }, 'mod'),
    'Checked 5. 2 updates ready. No answer about EssentialsX, so try again later. 1 mod added by hand cannot be checked. '
    + '2 mods from the modpack are updated with the pack. 1 mod turned off was skipped.')
  assert.ok(!html.includes('Everything SpawnLoft installed is already the newest build'))
})

test('the Schedule title says tasks run while signed in, and the assistant options do not pose as settings', () => {
  const { scheduleSubtitle } = lifted(['scheduleSubtitle'])
  assert.match(scheduleSubtitle('win32', undefined), /run by Windows while you are signed in to this computer, even with SpawnLoft closed\.$/)
  assert.match(scheduleSubtitle('darwin', undefined), /run by macOS while you are signed in/)
  assert.match(scheduleSubtitle('linux', false), /run by your system while you are logged in to this computer/)
  assert.match(scheduleSubtitle('linux', true), /even with SpawnLoft closed and after you log out\.$/)
  assert.ok(!html.includes('whether or not this is open'))
  const options = html.slice(html.indexOf('<fieldset id="mcpOptions"'), html.indexOf('</fieldset>', html.indexOf('<fieldset id="mcpOptions"')))
  assert.match(options, /not saved here/)
  assert.ok(!/class="switch"/.test(options))
  assert.equal((options.match(/type="checkbox"/g) || []).length, 2)
})

test('a stop or a restart asks first when it takes something from somebody, and only then', () => {
  const { stopQuestion, taskDisconnects, operatorQuestion } = lifted(['stopQuestion', 'taskDisconnects', 'operatorQuestion'])
  const smp = { name: 'smp', label: 'Survival SMP', status: 'running', latest: { players: 3 } }
  assert.deepEqual(stopQuestion('stop', smp, []), {
    title: 'Stop Survival SMP?', confirmLabel: 'Stop', text: '3 players are online and will be disconnected.',
  })
  assert.equal(stopQuestion('restart', { ...smp, latest: { players: 1 } }, []).text, '1 player is online and will be disconnected. They can join again once it is back.')
  // nobody on, nothing known, not running, or a start: the button acts at once, as before
  assert.equal(stopQuestion('stop', { ...smp, latest: { players: 0 } }, []), null)
  assert.equal(stopQuestion('stop', { ...smp, latest: null }, []), null)
  assert.equal(stopQuestion('stop', { ...smp, status: 'stopped' }, []), null)
  assert.equal(stopQuestion('start', smp, []), null)
  assert.equal(stopQuestion(null, smp, []), null)

  // a database is asked about for the running servers that keep their data in it
  const db = { name: 'main-db', label: 'Main MySQL', kind: 'database', status: 'running', attachments: { smp: {}, hub: {}, old: {} } }
  const rows = [smp, { name: 'hub', status: 'running' }, { name: 'old', status: 'stopped' }]
  const q = stopQuestion('stop', db, rows)
  assert.equal(q.title, 'Stop Main MySQL?')
  assert.equal(q.text, 'Survival SMP and hub are running and keep data in this database. Until it is started again, whatever reads or writes it there will fail.')
  assert.match(stopQuestion('restart', db, [smp]).text, /^Survival SMP is running and keeps data in this database\. While it restarts/)
  assert.equal(stopQuestion('stop', db, [{ name: 'smp', status: 'stopped' }]), null)
  assert.equal(stopQuestion('stop', { ...db, attachments: {} }, rows), null)

  // "Run now" on a task that stops or restarts is the same act
  assert.equal(taskDisconnects({ action: { type: 'restart', warnMinutes: 5 } }), 'restart')
  assert.equal(taskDisconnects({ action: { type: 'stop' } }), 'stop')
  assert.equal(taskDisconnects({ action: { type: 'steps', steps: [{ do: 'say', text: 'x' }, { do: 'restart' }] } }), 'restart')
  assert.equal(taskDisconnects({ action: { type: 'backup' } }), null)
  assert.equal(taskDisconnects({ action: { type: 'steps', steps: [{ do: 'backup' }] } }), null)

  assert.equal(taskDisconnects({ action: { type: 'command', line: '/stop' } }), 'stop')
  assert.equal(taskDisconnects({ action: { type: 'command', line: 'say stop the lag' } }), null)
  assert.equal(taskDisconnects({ action: { type: 'steps', steps: [{ do: 'command', line: 'restart' }] } }), 'restart')

  // each way in asks before it acts: the question's "no" returns ahead of the request
  const between = (from, to) => { const i = html.indexOf(from); assert.ok(i > 0, from); const j = html.indexOf(to, i); assert.ok(j > i, to); return html.slice(i, j) }
  const asks = /if \(question && !\(await ask\(/
  assert.match(between("const act = (what, { sure = false } = {}) => async () => {", 'state.busy = true;'), asks)
  assert.match(between('async function cardAct(name, what) {', 'overview.acting[name] = verb.what;'), asks)
  assert.match(between('saveRestart.onclick = async () => {', 'doSave({ restart: true });'), asks)
  assert.match(between('runNow.onclick = async () => {', 'busy(true);'), asks)
  assert.match(between('opBtn.onclick = async () => {', "on: true }"), /if \(!\(await ask\(operatorQuestion\(label\)\)\)\) return;/)
  const { stillUp } = lifted(['stillUp'])
  assert.equal(stillUp({ status: 'running' }), true)
  assert.equal(stillUp({ status: 'stopped' }), false)
  assert.equal(stillUp(null), false)

  // a caller that asked already does not ask twice, and every other way to stop goes through the question
  assert.equal((html.match(/act\('(?:stop|restart)', \{ sure: true \}\)/g) || []).length, 3)
  assert.equal((html.match(/act\('(?:stop|restart)'\)\(\)/g) || []).length, 0)
  assert.match(html, /const question = stopQuestion\(verb\.what, row, state\.rows\);/)

  const op = operatorQuestion('Alex')
  assert.equal(op.title, 'Make Alex an operator?')
  assert.match(op.text, /every command/)
  assert.ok(!/'Make op'/.test(html))
})

test('a failed request is said in words someone can act on', () => {
  const { plainFailure, plainMessage } = lifted(['plainFailure', 'plainMessage'])
  // no answer at all: never the browser's own "Failed to fetch"
  assert.match(plainFailure(0), /did not answer/)
  assert.match(plainFailure(401), /no longer signed in/)
  assert.match(plainFailure(403), /no longer signed in/)
  assert.match(plainFailure(413), /too large/)
  assert.match(plainFailure(502), /error 502/)
  assert.match(plainFailure(418), /error 418/)
  assert.ok(!/Failed to fetch/.test(plainFailure(0)))

  assert.equal(plainMessage('could not reach api.modrinth.com: getaddrinfo ENOTFOUND api.modrinth.com'),
    'Could not reach api.modrinth.com. Check this computer’s internet connection, then try again.')
  assert.equal(plainMessage('could not reach 127.0.0.1:3306: connect ECONNREFUSED'),
    'Could not reach 127.0.0.1:3306. Nothing answered at that address.')
  assert.equal(plainMessage('a version is required - see: spawnloft db versions'), 'Choose a version first.')
  assert.equal(plainMessage('"main" is not running, so its data cannot be dropped - start it first, or detach without --drop'),
    'main is not running, so its data cannot be dropped. Start it first, or detach and keep the data.')
  // a program on this computer that could not be run is not an internet problem
  assert.equal(plainMessage('could not reach schtasks to delete "nightly": spawn ENOENT'), 'could not reach schtasks to delete "nightly": spawn ENOENT')
  // everything else is passed on untouched
  assert.equal(plainMessage('That port is taken by "lobby".'), 'That port is taken by "lobby".')

  // the one place every request goes through uses both
  assert.match(html, /err\.network = true/)
  assert.match(html, /plainMessage\(/)
})

test('toasts stay while work runs, and the stack is capped', () => {
  const { toastStays, toastsToDrop } = lifted(['toastStays', 'toastsToDrop'])
  assert.equal(toastStays('Saved.', 'ok'), false)
  assert.equal(toastStays('Nope', 'bad'), true)
  assert.equal(toastStays('Restoring…', 'ok'), true)
  assert.equal(toastStays('Restoring... ', 'ok'), true)
  assert.equal(toastStays('Copied to /tmp/x.zip', 'ok', { stay: true }), true)

  const t = (id, working) => ({ id, working })
  assert.deepEqual(toastsToDrop([t(1), t(2)], 4), [])
  // the oldest idle ones go first; one that says work is under way is never dropped
  assert.deepEqual(toastsToDrop([t(1, true), t(2), t(3), t(4), t(5), t(6)], 4).map((x) => x.id), [2, 3])
  assert.deepEqual(toastsToDrop([t(1, true), t(2, true), t(3, true), t(4, true), t(5, true)], 4), [])
  // the one just shown is never the one dropped
  assert.deepEqual(toastsToDrop([t(1, true), t(2, true), t(3, true), t(4, true), t(5)], 4), [])
  assert.match(html, /const TOAST_MAX = 4;/)
})

test('a dialog that saves keeps what was typed when the save is refused', () => {
  const { askBlocked } = lifted(['askBlocked'])
  assert.equal(askBlocked({ typeToConfirm: 'lobby' }, 'lobb'), true)
  assert.equal(askBlocked({ typeToConfirm: 'lobby' }, 'lobby'), false)
  assert.equal(askBlocked({ input: { required: true } }, '   '), true)
  assert.equal(askBlocked({ input: { required: true } }, 'notes.txt'), false)
  assert.equal(askBlocked({ input: {} }, ''), false)
  assert.equal(askBlocked({}, ''), false)

  // the refusal is shown in the dialog, and the next asking starts clean
  assert.match(html, /<p class="hint bad" id="dlgError"/)
  assert.match(html, /getElementById\('dlg'\)\.addEventListener\('close'/)
  // the dialogs that used to close and then toast the refusal now save inside
  for (const title of ['New file', 'New folder']) {
    const at = html.indexOf(`title: '${title} in '`)
    assert.ok(at > 0, title)
    assert.match(html.slice(at, at + 900), /submit:/, title)
  }

  const { editPlan } = lifted(['editPlan'])
  const row = { name: 'lobby', label: 'Lobby', memory: '2G', port: 25565 }
  assert.deepEqual(editPlan(row, { name: 'lobby', label: 'Lobby', memory: '2G', port: '25565' }), { rename: null, patch: null })
  assert.deepEqual(editPlan(row, { name: 'hub', label: 'Lobby', memory: '2G', port: '25565' }), { rename: 'hub', patch: null })
  assert.deepEqual(editPlan(row, { name: 'hub', label: '', memory: '4G', port: '25566' }),
    { rename: 'hub', patch: { label: '', memory: '4G', port: '25566' } })
  assert.deepEqual(editPlan({ name: 'a', port: 1 }, { name: 'a', label: '', memory: '', port: '' }), { rename: null, patch: null })
})

test('an upload says how far it has got', () => {
  const { uploadWords } = lifted(['uploadWords'])
  assert.equal(uploadWords(1, 1, 50, 200, 'plugins'), 'Uploading to plugins · 25%')
  assert.equal(uploadWords(2, 3, 200, 200, 'plugins'), 'Uploading 2 of 3 to plugins · 100%')
  assert.equal(uploadWords(1, 2, 0, 0, 'world'), 'Uploading 1 of 2 to world…')
  assert.equal(uploadWords(1, 1, 999, 200, 'x'), 'Uploading to x · 100%')
  // sent with progress and a way to stop, not one silent fetch
  assert.match(html, /function sendFile\(url, file, onProgress, hold\)/)
  assert.match(html, /xhr\.upload\.onprogress/)
})

test('a search that failed never says nothing matches', () => {
  const at = html.indexOf('const searchFailed = (reasons, again = true) => {')
  assert.ok(at > 0)
  assert.match(html.slice(at, at + 1400), /Try again/)
})

test('the Add sheet holds its tabs while a create runs', () => {
  assert.match(html, /function lockAddTabs\(on\)/)
  assert.equal((html.match(/lockAddTabs\(true\);/g) || []).length, 2)
  assert.equal((html.match(/lockAddTabs\(false\);/g) || []).length, 4)
})

test('the header offers a 2.x update that is ready, and nothing else', () => {
  const { headerUpdateWords } = lifted(['headerUpdateWords'])
  assert.equal(headerUpdateWords(null), null)
  assert.equal(headerUpdateWords({ installed: '2.0.0', pending: null }), null)
  // going back to an older version is chosen in Preferences, never offered from the header
  assert.equal(headerUpdateWords({ pending: { version: '2.0.0', rollback: true } }), null)
  const words = headerUpdateWords({ pending: { version: '2.1.0' } })
  assert.equal(words.label, 'Update to 2.1.0')
  assert.match(words.title, /Preferences/)
  // About names the version in the 2.x app, which has no appInfo
  assert.match(html, /info\.unshift\(\['Version', 'v' \+ coreUpd\.status\.installed/)
})

test('the Java chip asks again once Java may have been installed', () => {
  assert.match(html, /window\.addEventListener\('focus', \(\) => \{ if \(javaMissing\(\)\) recheckJava\(\); \}\);/)
  assert.match(html, /setInterval\(\(\) => \{ if \(javaMissing\(\) && document\.hasFocus\(\)\) recheckJava\(\); \}, 60000\);/)
  // not for a Java that merely runs older versions: that chip stays for good
  assert.match(html, /const javaMissing = \(\) => Boolean\(state\.health && state\.health\.java && !state\.health\.java\.ok\);/)
})

test('the first-run Java row says what was found', () => {
  const setup = fs.readFileSync(new URL('../src/setup.html', import.meta.url), 'utf8')
  const at = setup.indexOf('function javaWords(')
  assert.ok(at > 0)
  let depth = 0, end = -1
  for (let i = setup.indexOf('{', at); i < setup.length; i++) {
    if (setup[i] === '{') depth++
    else if (setup[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  const javaWords = new Function(`${setup.slice(at, end)}; return javaWords`)()

  const url = 'https://adoptium.net/temurin/releases/?version=25'
  const fine = javaWords({ ok: true, found: true, reason: 'ok', version: 'openjdk version "25"', message: 'Java 25 is installed.', downloadUrl: url })
  assert.deepEqual([fine.state, fine.title, fine.get], ['ok', 'Java is installed', false])
  // a Java whose version could not be read is reported as fine by the check, and is said so
  const unknown = javaWords({ ok: true, found: true, reason: 'unknown-version', message: 'Found weird 1.', downloadUrl: url })
  assert.deepEqual([unknown.state, unknown.title, unknown.get], ['ok', 'Java is installed', false])
  // one that runs older versions works: no "servers will not start"
  const old = javaWords({ ok: true, found: true, reason: 'old', message: 'Java 21 will run older Minecraft versions, but current Paper needs 25.', downloadUrl: url })
  assert.equal(old.state, 'warn')
  assert.ok(!/needs updating/.test(old.title) && !/will not start/.test(old.why))
  // The check answers with health(): with no usable Java, `reason` is the PATH probe's and the
  // message is its own. A Java 8 in a folder it searched is `found` whatever PATH said.
  const tooOld = javaWords({ ok: false, found: true, reason: 'not-installed', message: 'Java 8 was found at C:\\java8, but a Minecraft server needs 17 or newer.', downloadUrl: url })
  assert.deepEqual([tooOld.state, tooOld.title], ['bad', 'Java needs updating'])
  assert.match(tooOld.why, /Java 8 was found[\s\S]*will not start/)
  // there, but would not run: not "not installed", and not the message that says it is not
  const broken = javaWords({ ok: false, found: false, reason: 'unusable', message: 'Java is not installed, or is somewhere SpawnLoft did not look.', downloadUrl: url })
  assert.match(broken.title, /did not run/)
  assert.ok(!/not installed/.test(broken.why))
  const none = javaWords({ ok: false, found: false, reason: 'not-installed', message: 'Java is not installed, or is somewhere SpawnLoft did not look.', downloadUrl: url })
  assert.deepEqual([none.state, none.title, none.get], ['bad', 'Java is not installed', true])
  // no link to open, no button that does nothing
  assert.equal(javaWords({ ok: false, found: false, reason: 'not-installed', message: 'x' }).get, false)
  assert.equal(javaWords(null).title, 'Could not check for Java')
  // an answer that is not about Java (this window's sign-in ran out) is not "not installed"
  assert.equal(javaWords({ error: 'this panel needs a sign-in', code: 'auth' }).title, 'Could not check for Java')

  assert.match(setup, /id="javaAgain"/)
  assert.match(setup, /window\.addEventListener\('focus'/)
})

// a const object written over several lines, which constSource (one line) cannot lift
function tableSource(name) {
  const at = html.indexOf(`const ${name} = {`)
  assert.ok(at !== -1, `could not find "const ${name}" in ui.html`)
  return html.slice(at, html.indexOf('\n};', at) + 3)
}

test('an archive name in a sentence is said as when the backup was taken', () => {
  const backupNamesToWords = new Function(`const stamp = (d) => d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes();
    ${fnSource('backupNamesToWords')}; return backupNamesToWords`)()
  assert.equal(backupNamesToWords('standard_2026-11-03_041500.tar.gz'), 'the backup from 2026/11/3 4:15')
  // the names the core really writes: a label, a scope, and a number when two fall in one second
  assert.equal(backupNamesToWords('kept scheduled_standard_2026-11-03_041500_2.tar.gz and more'), 'kept the backup from 2026/11/3 4:15 and more')
  assert.equal(backupNamesToWords('before-1.21_full_2026-11-03_041500.tar.gz: before the upgrade'), 'the backup from 2026/11/3 4:15: before the upgrade')
  // what stands around a name is kept
  assert.equal(backupNamesToWords('(standard_2026-11-03_041500.tar.gz)'), '(the backup from 2026/11/3 4:15)')
  // somebody's own file in a folder is not a backup, and neither is a time that does not exist
  assert.equal(backupNamesToWords('plugins/old/world_2024-01-01_120000.tar.gz (3 MB)'), 'plugins/old/world_2024-01-01_120000.tar.gz (3 MB)')
  assert.equal(backupNamesToWords('standard_2026-13-03_999999.tar.gz'), 'standard_2026-13-03_999999.tar.gz')
  // nothing that is not an archive's name is touched
  assert.equal(backupNamesToWords('3 removed, the newest 7 kept'), '3 removed, the newest 7 kept')
  assert.equal(backupNamesToWords(undefined), 'undefined')
})

test('an activity entry is a sentence: the verb, then what it was done to', () => {
  const activityWords = new Function(`${tableSource('ACTIVITY_TEXT')}\n${tableSource('ACTIVITY_BARE')}
    const backupNamesToWords = (s) => s.replace(/[^ ]+[.]tar[.]gz/, 'the backup from then');
    ${fnSource('activityWords')}; return activityWords`)()
  // a backup in the detail is said as when it was taken; a file that only looks like one is not
  assert.deepEqual(activityWords({ action: 'backup-lock', detail: 'standard_2026-11-03_041500.tar.gz' }), { verb: 'Locked', detail: 'the backup from then' })
  assert.deepEqual(activityWords({ action: 'file-upload', detail: 'world_2024-01-01_120000.tar.gz (3 MB)' }), { verb: 'Uploaded', detail: 'world_2024-01-01_120000.tar.gz (3 MB)' })
  // a note taken off is not "Put a note on ... (note removed)"
  assert.deepEqual(activityWords({ action: 'backup-note', detail: 'standard_2026-11-03_041500.tar.gz (note removed)' }), { verb: 'Took the note off', detail: 'the backup from then' })
  assert.deepEqual(activityWords({ action: 'backup-note', detail: 'standard_2026-11-03_041500.tar.gz: before 1.21' }), { verb: 'Put a note on', detail: 'the backup from then: before 1.21' })
  assert.deepEqual(activityWords({ action: 'delete', detail: 'files kept' }), { verb: 'Removed this server:', detail: 'files kept' })
  // the colon stays when something follows it, and goes when nothing does
  assert.deepEqual(activityWords({ action: 'settings', detail: 'Difficulty: hard' }), { verb: 'Changed settings:', detail: 'Difficulty: hard' })
  assert.equal(activityWords({ action: 'backup-prune' }).verb, 'Cleared old backups')
  // a start that failed does not say "Started" under a Failed pill
  assert.deepEqual(activityWords({ action: 'start', ok: false, detail: 'port 25565 is in use' }), { verb: 'Could not start:', detail: 'port 25565 is in use' })
  assert.deepEqual(activityWords({ action: 'start', ok: false }), { verb: 'Could not start', detail: '' })
  assert.deepEqual(activityWords({ action: 'start' }), { verb: 'Started', detail: '' })
  // a verb with nothing recorded after it is a whole sentence
  assert.equal(activityWords({ action: 'restore' }).verb, 'Restored a backup')
  assert.deepEqual(activityWords({ action: 'crash', detail: 'crashed 3 times, not restarted' }), { verb: 'Crashed 3 times, not restarted', detail: '' })
  // an action the page has no words for still shows
  assert.deepEqual(activityWords({ action: 'new-thing', detail: 'x' }), { verb: 'new-thing', detail: 'x' })
})

test('examples of a path look like the computer the panel runs on', () => {
  const { examplePath } = lifted(['examplePath'])
  assert.equal(examplePath('win32', 'map'), 'C:\\Users\\you\\Downloads\\amazing-map.zip')
  assert.equal(examplePath('darwin', 'map'), '/Users/you/Downloads/amazing-map.zip')
  assert.equal(examplePath('linux', 'map'), '/home/you/Downloads/amazing-map.zip')
  assert.match(examplePath('win32', 'java'), /java\.exe$/)
  assert.match(examplePath('darwin', 'java'), /\/bin\/java$/)
  assert.match(examplePath('linux', 'java'), /^\/usr\/.*\/bin\/java$/)
  assert.equal(examplePath('win32', 'backups'), 'D:\\spawnloft-backups')
  assert.doesNotMatch(examplePath('linux', 'backups') + examplePath('darwin', 'backups'), /\\|[A-Z]:/)
  // no Windows example is left written into the page
  assert.doesNotMatch(html, /placeholder(?:="| = ')[A-Z]:\\/)
  assert.doesNotMatch(html, /in Explorer\./)
})

test('the Java picker says which Java is the default, and when one is too old', () => {
  const { javaOptionWords, javaTooOldWords } = lifted(['javaOptionWords', 'javaTooOldWords'])
  assert.equal(javaOptionWords({ path: 'java', major: 21 }, 21), 'Java 21  ·  this computer’s default')
  assert.equal(javaOptionWords({ path: '/opt/jdk-17/bin/java', major: 17 }, 21), 'Java 17  ·  /opt/jdk-17/bin/java  ·  too old for this server')
  assert.equal(javaOptionWords({ path: '/opt/jdk-17/bin/java', major: 17 }, null), 'Java 17  ·  /opt/jdk-17/bin/java')
  const list = [{ path: 'java', major: 21 }, { path: '/opt/jdk-17/bin/java', major: 17 }]
  assert.equal(javaTooOldWords(list, 'java', 21), '')
  assert.match(javaTooOldWords(list, '/opt/jdk-17/bin/java', 21), /^Java 17 is too old: this server needs Java 21 or newer/)
  // a path typed by hand is not one SpawnLoft has measured, and a server with no known need has no "too old"
  assert.equal(javaTooOldWords(list, '/somewhere/else/java', 21), '')
  assert.equal(javaTooOldWords(list, '/opt/jdk-17/bin/java', null), '')
  assert.equal(javaTooOldWords(undefined, 'java', 21), '')
})

test('the words a person does not need are gone from the page', () => {
  // what a person reads, not what the code says in its comments
  const said = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const word of ['Orphaned', 'Stale state', 'has no supervisor', 'over RCON', 'max heap', 'heap limit', 'Loopback only', 'root is for you',
    'Dumping', 'the registry stores', 'update feed', 'name-derived', 'on PATH', ' Javas', 'spawnloft kill', 'spawnloft client new', 'A path of my own', 'RCON password', 'Mirroring', 'a mirror',
    'old snapshot', 'Add a mirror']) {
    assert.ok(!said.includes(word), `"${word}" is still said on the page`)
  }
  // the server out of reach has a button where it had a terminal command
  assert.match(html, /label: 'Force stop', run: \(\) => forceStop\(row\.name, row\.label \|\| row\.name\)/)
  assert.match(fnSource('forceStop'), /post\('\/instances\/' \+ encodeURIComponent\(name\) \+ '\/kill'\)/)
  assert.match(fnSource('forceStop'), /danger: true/)
  // the update's notice for it goes once it has been stopped, where it stayed and offered a stop that is refused
  assert.match(fnSource('forceStop'), /forceStopped\.add\(name\)/)
  assert.match(html, /e\.stop === 'orphaned' && !forceStopped\.has\(e\.name\)/)
})

test('a time of day is written the way the computer writes it, everywhere', () => {
  const { clockWords } = new Function(`const CLOCK = null;\n${fnSource('clockWords')}; return { clockWords }`)()
  const us = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
  const de = new Intl.DateTimeFormat('de-DE', { hour: 'numeric', minute: '2-digit' })
  assert.equal(clockWords('03:00', us).replace(/\s/g, ' '), '3:00 AM')
  assert.equal(clockWords('15:30', us).replace(/\s/g, ' '), '3:30 PM')
  assert.equal(clockWords('15:30', de), '15:30')
  // what is not a time of day is left as it was written
  for (const odd of ['', '25:00', '03:75', 'noon', null]) assert.equal(clockWords(odd, us), String(odd || ''))
  // no schedule sentence writes the stored "03:00" straight out
  assert.doesNotMatch(html, /' at ' \+ s\.at\b/)
  assert.doesNotMatch(html, /backups at 03:00, keeping/)
  // and one clock: nothing formats a time of day by itself
  assert.doesNotMatch(html, /toLocaleTimeString\(/)
})

test('the header and the page count the same age in the same units', () => {
  const { shortAgo } = lifted(['shortAgo'])
  const { ago } = lifted(['ago'])
  const H = 3600000
  for (const [ms, short, long] of [[20000, 'just now', 'just now'], [12 * 60000, '12m', '12m ago'], [23 * H, '23h', '23h ago'], [30 * H, '1d', '1 day ago'], [72 * H, '3d', '3 days ago']]) {
    assert.equal(shortAgo(Date.now() - ms), short)
    assert.equal(ago(new Date(Date.now() - ms).toISOString()), long)
  }
})

test('Escape is about the box it was pressed in before it closes anything', () => {
  const { escapeMove, typedField } = lifted(['TYPED_INPUTS', 'escapeMove', 'typedField'])
  const tool = { view: 'server', tool: 'plugins', inTool: true }
  // a dialog first, whatever else is true
  assert.equal(escapeMove({ ...tool, dialog: true, field: { search: true, value: 'x' } }), 'dialog')
  // a search with something in it is cleared; from any other box focus steps out
  assert.equal(escapeMove({ ...tool, field: { search: true, value: 'essentials' } }), 'clear')
  assert.equal(escapeMove({ ...tool, field: { search: true, value: '' } }), 'leave')
  assert.equal(escapeMove({ ...tool, field: { search: false, value: '/home/you/map.zip' } }), 'leave')
  assert.equal(escapeMove({ ...tool, field: null }), 'tool')
  // the command box under an open tool is not in the tool
  assert.equal(escapeMove({ view: 'server', tool: 'plugins', inTool: false, field: { search: false, value: 'say hi' } }), null)
  assert.equal(escapeMove({ view: 'server', tool: null, inTool: false, field: null }), null)
  // sheets close from anywhere but a box, and Add stays while a server is being made
  assert.equal(escapeMove({ view: 'settings', field: null }), 'back')
  assert.equal(escapeMove({ view: 'add', field: { search: true, value: 'all the mods' } }), 'clear')
  assert.equal(escapeMove({ view: 'add', field: null }), 'back')
  // out of a box in a sheet focus goes to the sheet, not to the stage that holds every page
  assert.match(html, /target\.closest\('\.view\.sheet'\)/)
  assert.equal(escapeMove({ view: 'overview', field: null }), null)

  const input = (type, value) => ({ tagName: 'INPUT', type: type || 'text', value, getAttribute: () => type })
  assert.deepEqual(typedField(input('search', 'x')), { search: true, value: 'x' })
  assert.deepEqual(typedField(input(null, 'x')), { search: false, value: 'x' })
  assert.deepEqual(typedField({ tagName: 'TEXTAREA', value: 'y' }), { search: false, value: 'y' })
  assert.deepEqual(typedField({ tagName: 'SELECT', value: 'z' }), { search: false, value: 'z' })
  // a checkbox, a button and nothing at all are not boxes
  assert.equal(typedField(input('checkbox', 'on')), null)
  assert.equal(typedField({ tagName: 'BUTTON' }), null)
  assert.equal(typedField(null), null)
  // a tip is put away by itself: its Escape stops there
  assert.match(html, /if \(showing\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); \}/)
})

test('after a redraw focus goes back to the control it was on', () => {
  const { focusChoice } = lifted(['focusChoice'])
  const rows = ['BUTTON|Disable', 'BUTTON|Delete', 'BUTTON|Disable', 'BUTTON|Delete', 'BUTTON|Disable', 'BUTTON|Delete']
  // the same control on the same row
  assert.equal(focusChoice(rows, { name: 'BUTTON|Delete', nth: 1, at: 3 }), 3)
  // its row was deleted: the same button on the row that took its place, or the last one
  assert.equal(focusChoice(rows.slice(0, 4), { name: 'BUTTON|Delete', nth: 1, at: 3 }), 3)
  assert.equal(focusChoice(rows.slice(0, 4), { name: 'BUTTON|Delete', nth: 2, at: 5 }), 3)
  // it changed its name (Disable became Enable): what stands where it stood
  const toggled = ['BUTTON|Disable', 'BUTTON|Delete', 'BUTTON|Enable', 'BUTTON|Delete']
  assert.equal(focusChoice(toggled, { name: 'BUTTON|Disable', nth: 1, at: 2 }), 2)
  // one that is turned off is passed over for the nearest that is not
  assert.equal(focusChoice(rows, { name: 'BUTTON|Delete', nth: 1, at: 3 }, [true, true, true, false, true, true]), 4)
  assert.equal(focusChoice([], { name: 'BUTTON|Delete', nth: 0, at: 0 }), -1)

  // focus is put back only where the redraw took it
  const { focusLost } = lifted(['focusLost'])
  assert.equal(focusLost({ connected: false, disabled: false }, { nowhere: true }), true)
  assert.equal(focusLost({ connected: true, disabled: true }, { nowhere: true }), true)
  // the control is still there: a poll that redrew around it moves nothing, and neither does one
  // that runs after the person clicked away from it
  assert.equal(focusLost({ connected: true, disabled: false }, { nowhere: true }), false)
  assert.equal(focusLost({ connected: true, disabled: false }, { nowhere: false }), false)
  // the person went somewhere else while the request ran (a dialog, the console)
  assert.equal(focusLost({ connected: false, disabled: false }, { nowhere: false }), false)
  assert.equal(focusLost(null, { nowhere: true }), false)
  // a click away from a control forgets it; a button turned off under the person is kept
  assert.match(html, /if \(e\.target === lastInTool && !e\.relatedTarget && e\.target\.isConnected && !e\.target\.disabled\) lastInTool = null;/)
  // the stats ranges keep the name that is written on them
  assert.doesNotMatch(html, /setAttribute\('aria-label', r\.say\)/)
  // every tool that draws itself whole is wrapped
  for (const draw of ['renderPlayers', 'renderPlugins', 'renderWorlds', 'renderFiles', 'renderScheduler', 'renderBackups', 'renderActivity', 'paintPerformance']) {
    assert.ok(html.includes(`${draw} = holdingFocus(${draw});`), draw)
  }
})

test('a chart says in words what its line shows', () => {
  const { chartWords } = new Function(`${html.slice(html.indexOf('const RANGES = ['), html.indexOf('];', html.indexOf('const RANGES = [')) + 2)}\n${fnSource('chartWords')}; return { chartWords }`)()
  assert.equal(chartWords('Processor', '3.1%', 'peak 12%  ·  share of all 4 cores', 300), 'Processor, last 5 minutes: 3.1%, peak 12%, share of all 4 cores')
  assert.equal(chartWords('Memory', 'no readings yet', '', 60), 'Memory, last minute: no readings yet')
  assert.equal(chartWords('TPS', '19.9', '', 7), 'TPS: 19.9')
})

test('the whitelist says what its state means, and a player can be added by name', () => {
  const { whitelistWords, addPlayerQuestion, addedWords, emptyWhitelistQuestion } = lifted(['whitelistWords', 'addPlayerQuestion', 'playerChangeWords', 'addedWords', 'emptyWhitelistQuestion'])
  assert.equal(whitelistWords(false, 0), 'Off. Anyone can join.')
  assert.equal(whitelistWords(false, 3), 'Off. Anyone can join; the 3 on the list are not checked.')
  // operators get in without being listed, so no line says "only the list"
  assert.equal(whitelistWords(true, 1), 'On. Only the one player on the list, and operators, can join.')
  assert.equal(whitelistWords(true, 4), 'On. Only the 4 players on the list, and operators, can join.')
  assert.match(whitelistWords(true, 0), /only operators can join/)
  // what happens to people connected depends on the server, and a stopped one has nobody connected
  assert.equal(emptyWhitelistQuestion({ running: false }).text, 'Only operators will be able to join until someone is added.')
  assert.match(emptyWhitelistQuestion({ running: true, whitelistEnforced: false }).text, /stay until they leave/)
  assert.match(emptyWhitelistQuestion({ running: true, whitelistEnforced: true }).text, /are removed from the server/)

  const stopped = addPlayerQuestion({ running: false, onlineMode: true, whitelistOn: false })
  assert.match(stopped.text, /looked up with Mojang/)
  assert.deepEqual(stopped.choices.map((c) => c.value), ['whitelist', 'op', 'ban'])
  assert.match(stopped.choices[0].hint, /once the whitelist is turned on/)
  assert.equal(stopped.input.required, true)
  assert.match(addPlayerQuestion({ running: true, whitelistOn: true }).text, /server finds them/)
  assert.equal(addPlayerQuestion({ running: true, whitelistOn: true }).choices[0].hint, 'They can join.')
  assert.match(addPlayerQuestion({ running: false, onlineMode: false }).text, /exactly the one they will join with/)

  assert.deepEqual(addedWords({ as: 'whitelist', name: 'Alex' }), { text: 'Alex is on the whitelist.', tone: 'good' })
  assert.deepEqual(addedWords({ as: 'ban', name: 'Griefer', took: true }), { text: 'Griefer is banned.', tone: 'good' })
  // a running server that did not do it is not a success
  const refused = addedWords({ as: 'op', name: 'Ghost', took: false, reply: 'That player does not exist' })
  assert.equal(refused.tone, '')
  assert.match(refused.text, /That player does not exist/)
  // Settings no longer sends anyone to the console for this
  assert.ok(!html.includes('whitelist add <name>'))
})

test('how friends join: an address for each place someone can be, and none that is made up', () => {
  const { joinWays, joinLead } = lifted(['joinWays', 'joinLead'])
  const home = joinWays({ port: 25565, here: 'localhost', loopbackOnly: false, lan: ['192.168.1.24'], public: [] })
  assert.deepEqual(home.map((w) => w.who), ['On this computer', 'On your home network', 'Over the internet'])
  assert.deepEqual(home.map((w) => w.addresses), [['localhost:25565'], ['192.168.1.24:25565'], []])
  // the internet row gives no address, says what is needed, and says nothing was looked up
  assert.match(home[2].note, /port forwarding/)
  assert.match(home[2].note, /port 25565 \(TCP\)/)
  assert.match(home[2].note, /does not look up your public address/)

  // no network: said, with no address
  const alone = joinWays({ port: 25565, here: 'localhost', loopbackOnly: false, lan: [], public: [] })
  assert.deepEqual(alone[1].addresses, [])
  assert.match(alone[1].note, /no home network address right now/)
  // two networks: both, and no promise about which
  assert.match(joinWays({ port: 1, here: 'localhost', lan: ['10.0.0.2', '192.168.1.24'], public: [] })[1].note, /if one does not work, try the next/)
  // the commonest reason a neighbour cannot connect is said
  assert.match(home[1].note, /firewall may be blocking Java/)
  // a machine with only a public address is not told to join a Wi-Fi
  const vps = joinWays({ port: 25565, here: 'localhost', lan: [], public: ['203.0.114.7'] })
  assert.deepEqual(vps.map((w) => w.who), ['On this computer', 'Over the internet'])
  assert.deepEqual(vps[1].addresses, ['203.0.114.7:25565'])
  assert.match(vps[1].note, /firewall/)
  // listening on this computer only
  const closed = joinWays({ port: 25565, here: 'localhost', loopbackOnly: true, lan: [], public: [] })
  assert.deepEqual(closed.map((w) => w.who), ['On this computer', 'Anyone else'])
  assert.match(closed[1].note, /nobody else can reach it\. Clearing server-ip/)
  // set by SpawnLoft itself: editing the file would be undone at the next start, so it is not suggested
  assert.ok(!joinWays({ port: 25565, loopbackOnly: true, bindFixed: true })[1].note.includes('Clearing'))
  // one address only: that address, no localhost, and what kind it is
  const one = joinWays({ port: 25565, here: '192.168.1.24', only: '192.168.1.24', onlyKind: 'lan', lan: ['192.168.1.24'], public: [] })
  assert.deepEqual(one.map((w) => w.addresses), [['192.168.1.24:25565']])
  assert.match(one[0].note, /same Wi-Fi or router/)
  assert.match(joinWays({ port: 25565, only: '192.168.1.99', onlyKind: 'unknown' })[0].note, /not one of this computer’s addresses right now/)
  assert.deepEqual(joinWays({ port: 25565, only: '2001:db8::5', onlyKind: 'here' })[0].addresses, ['[2001:db8::5]:25565'])
  // the internet row owns up to the case forwarding cannot fix
  assert.match(home[2].note, /share one public address/)
  // a port that is not known gives no address anywhere: "localhost:?" could be copied before
  const unknown = joinWays({ port: null, here: 'localhost', lan: ['192.168.1.24'], public: [] })
  assert.deepEqual(unknown.flatMap((w) => w.addresses), [])
  assert.match(joinLead({ port: null }, 'stopped'), /port is not known yet/)
  assert.match(joinLead({ port: 25565 }, 'stopped'), /not running/)
  assert.match(joinLead({ port: 25565 }, 'running'), /Add Server/)
  assert.ok(!html.includes("'localhost:' + (row.port || '?')"))
  // the shared dialog is emptied of the list by everything that opens it
  assert.equal(html.split('clearDlgDetail();').length - 1, 3)
})

test('installing a plugin asks about a wrong version and about what it needs, and says what happened', () => {
  const { mismatchQuestion, dependencyQuestion, installedWords } = lifted(['mismatchQuestion', 'dependencyQuestion', 'installedWords'])
  // a build that lists this version is not asked about
  assert.equal(mismatchQuestion('Chunky', { exactMatch: true, builtFor: null }, '1.21.4'), null)
  const wrong = mismatchQuestion('Chunky', { exactMatch: false, builtFor: '1.20.4' }, '1.21.4')
  assert.match(wrong.text, /lists Minecraft 1\.20\.4, and this server runs 1\.21\.4/)
  assert.equal(wrong.confirmLabel, 'Install anyway')

  // nothing missing: nothing asked
  assert.equal(dependencyQuestion('Shop', { requires: [{ title: 'Vault', installed: true }] }, 'plugin'), null)
  assert.equal(dependencyQuestion('Shop', { requires: [] }, 'plugin'), null)
  // one missing: offered by name, with a way to decline
  const one = dependencyQuestion('Shop', { requires: [{ title: 'Vault', installed: false, id: 'v', source: 'modrinth' }, { title: 'Here', installed: true }] }, 'plugin')
  assert.equal(one.title, 'Shop needs another plugin')
  assert.match(one.text, /will not load without Vault\./)
  assert.deepEqual(one.choices.map((c) => [c.value, c.label]), [['with', 'Install Vault too'], ['alone', 'Only Shop']])
  assert.deepEqual(one.fetch.map((d) => d.id), ['v'])
  // several, one of which lives elsewhere: it is named with where, and not offered
  const some = dependencyQuestion('Shop', { requires: [
    { title: 'Vault', installed: false, id: 'v' }, { title: 'ProtocolLib', installed: false, id: 'p' },
    { title: 'Citizens', installed: false, id: 'c', external: 'https://ci.citizensnpcs.co' },
  ] }, 'mod')
  assert.equal(some.title, 'Shop needs 2 other mods')
  assert.match(some.text, /Citizens is not on Hangar or Modrinth: get it from https:\/\/ci\.citizensnpcs\.co/)
  assert.deepEqual(some.fetch.map((d) => d.id), ['v', 'p'])
  // only things it cannot fetch: no choice to make but whether to go on
  const none = dependencyQuestion('Shop', { requires: [{ title: 'Citizens', installed: false, external: 'https://x' }] }, 'plugin')
  assert.equal(none.choices, undefined)
  assert.deepEqual(none.fetch, [])
  assert.equal(none.confirmLabel, 'Install Shop anyway')

  assert.deepEqual(installedWords({ installed: 'Shop.jar', version: '3.1' }, [], []), { text: 'Installed Shop.jar (3.1).', tone: 'good' })
  assert.equal(installedWords({ installed: 'Shop.jar', version: '3.1' }, [{ title: 'Vault' }, { title: 'ProtocolLib' }], []).text, 'Installed Shop.jar (3.1), with Vault and ProtocolLib.')
  const partly = installedWords({ installed: 'Shop.jar', version: '3.1' }, [], [{ title: 'Vault', why: 'download failed: 503' }])
  assert.equal(partly.tone, '')
  assert.match(partly.text, /Could not install Vault \(download failed: 503\)\./)
  // the search is kept: an install no longer redraws the whole pane
  assert.match(html, /await refreshInstalled\(\);/)
})
