import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * The panel is one document with no build step, so its logic cannot be imported. The pure
 * functions worth testing are lifted out of the source by name instead: a const is one line,
 * a function runs to its balanced closing brace. If someone reshapes the file these throw
 * loudly rather than testing nothing.
 */
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
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1)
  }
  assert.fail(`unbalanced braces after "function ${name}"`)
}

const lifted = (names) => new Function(
  `${names.map((n) => (/^[A-Z_]+$/.test(n) ? constSource(n) : fnSource(n))).join('\n')}
   return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} }`,
)()

// ---- the console level classifier ------------------------------------------

const { levelOf } = lifted(['MCCTL_RE', 'LEVEL_RE', 'BARE_LEVEL_RE', 'CONT_RE', 'EXC_RE', 'levelOf'])

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

// ---- the memory ceiling reader ---------------------------------------------

const { memoryCeilingMb } = lifted(['memoryCeilingMb'])

test('the memory graph ceiling accepts both units and refuses junk', () => {
  assert.equal(memoryCeilingMb('2G'), 2048)
  assert.equal(memoryCeilingMb('3072M'), 3072)
  assert.equal(memoryCeilingMb(' 4g '), 4096)
  assert.equal(memoryCeilingMb('4'), 4096)
  assert.equal(memoryCeilingMb('*G'), null)
  assert.equal(memoryCeilingMb(''), null)
})

// ---- the duplicated token block --------------------------------------------

/**
 * The design tokens are deliberately duplicated between the panel and the setup wizard -
 * "change both or neither". verify-build checks this too, but only during a packaged build;
 * this catches the half-edit the day it happens.
 */
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
