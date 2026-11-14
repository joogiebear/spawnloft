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
    `const panelPlatform = 'linux';\n${constSource('DAY_NAMES')}\n  FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };\n${fnSource('describeSchedule')}\n${fnSource('singleFileOf')}\n${fnSource('isWholeBackup')}\n${fnSource('keepProblem')}\n${fnSource('scheduledBackupWords')}\n${fnSource('backupsMoveWords')}
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
