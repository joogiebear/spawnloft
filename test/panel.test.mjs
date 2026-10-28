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
  // ...but never from an mcctl system line, which is not a server error.
  assert.equal(levelOf('\tat com.example.Fine(Fine.java:1)', 'sys'), 'info')
})

test('mcctl speaking for itself is sys, never a server level', () => {
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
  assert.deepEqual(tokensOf('../src/ui.html'), tokensOf('../desktop/setup.html'))
})

test('the website palette stays consistent between the panel and setup wizard', () => {
  assert.deepEqual(tokensOf('../src/ui.html', true), tokensOf('../desktop/setup.html', true))
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
