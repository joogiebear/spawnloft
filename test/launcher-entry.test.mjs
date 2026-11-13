// The ways into the game launcher outside the launcher page itself: `spawnloft ui --launcher`, the
// panel's sidebar Play and card fallback, and the desktop app's window rules (desktop/*.test.js,
// run here too so CI covers them without Electron).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs, BOOLEAN_FLAGS } from '../src/args.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-launcher-entry-'))
const env = { ...process.env, MCCTL_DATA_ROOT: path.join(scratch, 'data'), APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

async function cli(args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(root, 'mcctl.mjs'), ...args], { env, encoding: 'utf8', timeout: 20000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}

// something already listening on 127.0.0.1, answering the launcher summary like a panel or not
async function listener(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

test('--launcher is a boolean flag', () => {
  assert.ok(BOOLEAN_FLAGS.includes('launcher'))
  assert.deepEqual(parseArgs(['--launcher', '--no-open'], { booleanFlags: BOOLEAN_FLAGS }).flags, { launcher: true, open: false })
})

// what this user's panel adds to a signed answer: proof that it holds the install's key
function prove(req, res) {
  const key = Buffer.from(fs.readFileSync(path.join(scratch, 'config', 'spawnloft', 'panel.key'), 'utf8').trim(), 'base64url')
  const proof = crypto.createHmac('sha256', key).update(`probe.v1.${req.headers['x-spawnloft-probe']}`).digest('base64url')
  res.setHeader('x-spawnloft-proof', proof)
}

test('ui --launcher with a panel already on the port points at that panel\'s launcher', async () => {
  const seen = []
  const { server, port } = await listener((req, res) => {
    seen.push([req.url, req.headers.authorization])
    prove(req, res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ profiles: [], accounts: [], servers: [] }))
  })
  try {
    const r = await cli(['ui', '--port', String(port), '--launcher', '--no-open'])
    assert.equal(r.code, 0, r.stderr)
    // a link that signs a browser in to that panel and lands on its launcher
    assert.match(r.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/auth\\?t=v1\\.login\\.${port}\\.\\d+\\.[\\w-]{22}\\.[\\w-]{43}&to=/launcher`))
    // the question "is that a panel" is asked with a token for that port, never with the key
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], '/api/client/launcher')
    assert.match(seen[0][1], new RegExp(`^SpawnLoft v1\\.api\\.${port}\\.\\d+\\.\\.[\\w-]{43}$`))
    const key = fs.readFileSync(path.join(scratch, 'config', 'spawnloft', 'panel.key'), 'utf8').trim()
    assert.ok(!seen[0][1].includes(key) && !r.stdout.includes(key))
  } finally {
    server.close()
  }
})

test('ui on a port something else holds says so instead of crashing', async () => {
  const { server, port } = await listener((req, res) => { res.writeHead(404); res.end() })
  try {
    for (const args of [['ui', '--port', String(port), '--launcher', '--no-open'], ['ui', '--port', String(port), '--no-open']]) {
      const r = await cli(args)
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, new RegExp(`port ${port} is already in use by another program\\. Pick another`))
      assert.doesNotMatch(r.stderr, /EADDRINUSE|at Server/)
    }
  } finally {
    server.close()
  }
})

test('ui without --launcher on a port a panel holds signs the browser in to that panel', async () => {
  const { server, port } = await listener((req, res) => {
    prove(req, res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ profiles: [] }))
  })
  try {
    const r = await cli(['ui', '--port', String(port), '--no-open'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`A SpawnLoft panel is already running on port ${port}`))
    assert.match(r.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/auth\\?t=v1\\.login\\.${port}\\.\\S+$`, 'm'))
  } finally {
    server.close()
  }
})

test('something that only answers like a panel is not called one, and gets no sign-in link', async () => {
  // any program can hold the port and answer 200; without the key it cannot prove anything
  const { server, port } = await listener((req, res) => {
    res.setHeader('x-spawnloft-proof', 'A'.repeat(43))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ profiles: [] }))
  })
  try {
    for (const args of [['ui', '--port', String(port), '--launcher', '--no-open'], ['ui', '--port', String(port), '--no-open']]) {
      const r = await cli(args)
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, new RegExp(`port ${port} is already in use by another program\\. Pick another`))
      assert.doesNotMatch(r.stdout + r.stderr, /auth\?t=|v1\.login|SpawnLoft panel/)
    }
  } finally {
    server.close()
  }
})

test('the panel has a sidebar Play that shows the Play page, and the card falls back to it', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
  assert.match(html, /<button type="button" class="side-new side-play" id="bLauncher" title="Play">/)
  assert.match(html, /\$\('#bLauncher'\)\.onclick = \(\) => showPlay\(\);/)
  // the page is /launcher in a frame of the panel, loaded the first time Play is pressed
  assert.match(html, /<iframe id="playFrame" title="Play"><\/iframe>/)
  assert.match(html, /function showPlay\(\) \{[\s\S]*?frame\.src = '\/launcher';[\s\S]*?show\('play'\)/)
  assert.match(html, /play: '#vPlay'/)
  // and the panel opens no launcher window of its own any more
  const code = html.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  const opens = [...code.matchAll(/window\.open\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a.includes('launcher'))
  assert.deepEqual(opens, [])
  assert.match(html, /function openLauncherFor\(row\) \{[\s\S]*?showPlay\(\)/)
})

test('inside the Play page the launcher is a page, not a window: a title for the brand, "leaving" for "closing"', () => {
  const launcher = fs.readFileSync(path.join(root, 'src', 'launcher.html'), 'utf8')
  assert.match(launcher, /const EMBEDDED = window\.self !== window\.top/)
  assert.match(launcher, /const CLOSING = EMBEDDED \? 'Leaving this page' : 'Closing this window'/)
  assert.doesNotMatch(launcher.replace(/const CLOSING = .*/, ''), /Closing this window/)
  assert.match(launcher, /<h1 class="pagetitle">Play<\/h1>/)
  assert.match(launcher, /:root\[data-embedded\] \.brand \{ display: none; \}/)
  // the desktop app lets the preload into that frame and no other, and keeps every frame on the panel
  const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8')
  assert.match(preload, /if \(window\.self !== window\.top && window\.location\.pathname !== '\/launcher'\) return/)
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /nodeIntegrationInSubFrames: true/)
  assert.match(main, /on\('will-frame-navigate'/)
})

test('an open launcher takes a card\'s prefill from the storage event', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'launcher.html'), 'utf8')
  assert.match(html, /window\.addEventListener\('storage', \(e\) => \{\s*if \(e\.key !== NEW_PROFILE_KEY/)
})

test('the desktop window rules pass their own tests', () => {
  const desktop = path.join(root, 'desktop')
  // without the runner's own context variable, or the child reports to this runner instead of stdout
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'launcher-window.test.js', 'login-window.test.js'], { cwd: desktop, env: childEnv, encoding: 'utf8', timeout: 30000 })
  assert.match(out, /# fail 0/)
})

test('the desktop app exposes exactly the two launcher calls, and packages their modules', () => {
  const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8')
  assert.match(preload, /openProfileFolder: \(name\) => ipcRenderer\.invoke\('spawnloft:openProfileFolder', String\(name \?\? ''\)\)/)
  assert.match(preload, /openMicrosoftLogin: \(url\) => ipcRenderer\.invoke\('spawnloft:openMicrosoftLogin', String\(url \?\? ''\)\)/)
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  for (const channel of ['spawnloft:openProfileFolder', 'spawnloft:openMicrosoftLogin']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}', async \\(e, \\w+\\) => \\{\\r?\\n  if \\(!fromPanel\\(e\\)\\) return \\{ ok: false \\}`))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  for (const file of ['launcher-window.js', 'login-window.js']) assert.ok(pkg.build.files.includes(file), file)
})
