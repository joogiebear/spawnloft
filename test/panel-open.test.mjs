import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// `spawnloft ui` handing a browser its sign-in link (rust/PANEL-AUTH-DESIGN.md 3.7): through a
// private page in the config folder, never a command line; `--link` for a panel already running.
// The whole flow in a real browser is desktop/smoke-panel.cjs.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-panel-open-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'mcctl.mjs')
const open = await import('../src/panel-open.mjs')
const auth = await import('../src/panel-auth.mjs')
const { serve } = await import('../src/ui.mjs')

const servers = []
after(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

const nonce = (c) => c.repeat(22)

test('the page is private, named after its nonce, and sends the browser on without a script', () => {
  const url = `http://127.0.0.1:8770/auth?t=v1.login.8770.1.${nonce('A')}.x&to=/launcher`
  const file = open.writeOpenFile(url, nonce('A'))
  assert.equal(path.dirname(file), open.openDir())
  assert.equal(path.basename(file), open.openFileName(nonce('A')))
  assert.match(path.basename(file), /^[0-9a-f]{32}\.html$/)
  // the name gives nothing of the token away
  assert.ok(!path.basename(file).includes(nonce('A')))
  const html = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /<meta http-equiv="refresh" content="0; url=http:\/\/127\.0\.0\.1:8770\/auth\?t=v1\.login\.8770\.1\.A{22}\.x&#38;to=\/launcher">/)
  assert.match(html, /<meta name="referrer" content="no-referrer">/)
  if (typeof process.getuid === 'function') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(open.openDir()).mode & 0o777, 0o700)
  }
  // made exclusively: the same name twice is refused, not overwritten
  assert.throws(() => open.writeOpenFile(url, nonce('A')), { code: 'EEXIST' })
  open.removeOpenFile(nonce('A'))
  assert.ok(!fs.existsSync(file))
})

test('a folder of another kind or made loose is put right or refused', { skip: typeof process.getuid !== 'function' }, () => {
  fs.chmodSync(open.openDir(), 0o755)
  open.writeOpenFile('http://127.0.0.1:1/auth?t=x', nonce('B'))
  assert.equal(fs.statSync(open.openDir()).mode & 0o777, 0o700)
  open.removeOpenFile(nonce('B'))
  const real = open.openDir()
  fs.rmSync(real, { recursive: true })
  fs.mkdirSync(path.join(scratch, 'elsewhere'))
  fs.symlinkSync(path.join(scratch, 'elsewhere'), real)
  assert.throws(() => open.writeOpenFile('http://127.0.0.1:1/auth?t=x', nonce('C')), /is not a folder/)
  fs.rmSync(real)
})

test('pages older than a link lives are swept; others and foreign files stay', () => {
  const fresh = open.writeOpenFile('http://127.0.0.1:1/auth?t=x', nonce('D'))
  const old = open.writeOpenFile('http://127.0.0.1:1/auth?t=x', nonce('E'))
  const foreign = path.join(open.openDir(), 'notes.html')
  fs.writeFileSync(foreign, 'mine')
  const long = (Date.now() - auth.LOGIN_TTL_MS - auth.FUTURE_LEEWAY_MS - 1000) / 1000
  fs.utimesSync(old, long, long)
  fs.utimesSync(foreign, long, long)
  open.sweepOpenFiles()
  assert.ok(fs.existsSync(fresh))
  assert.ok(!fs.existsSync(old))
  assert.ok(fs.existsSync(foreign))
  // a nonce that is not one removes nothing
  open.removeOpenFile('../../x')
  open.removeOpenFile(nonce('D'))
  assert.ok(!fs.existsSync(fresh))
  fs.rmSync(foreign)
})

test('the opener gets the page\'s path and nothing else', () => {
  const file = '/home/me/.config/spawnloft/open/0123.html'
  assert.deepEqual(open.opener(file, {}, 'linux'), ['xdg-open', [file]])
  assert.deepEqual(open.opener(file, {}, 'darwin'), ['open', [file]])
  assert.deepEqual(open.opener('C:\\Users\\me\\AppData\\Roaming\\spawnloft\\open\\0123.html', { SystemRoot: 'D:\\Win' }, 'win32'),
    ['D:\\Win\\explorer.exe', ['C:\\Users\\me\\AppData\\Roaming\\spawnloft\\open\\0123.html']])
  assert.deepEqual(open.opener(file, { BROWSER: ' firefox ' }, 'linux'), ['firefox', [file]])
})

test('with no display there is no browser to open, unless BROWSER names one', () => {
  assert.equal(open.canOpen({}, 'linux'), false)
  assert.equal(open.canOpen({ DISPLAY: ':0' }, 'linux'), true)
  assert.equal(open.canOpen({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true)
  assert.equal(open.canOpen({ BROWSER: 'w3m' }, 'linux'), true)
  assert.equal(open.canOpen({}, 'darwin'), true)
  assert.equal(open.canOpen({}, 'win32'), true)
})

test('a panel deletes the page whose link it took', async () => {
  const p = await serve({ port: 0 })
  servers.push(p.server)
  const link = auth.loginLink(p.auth.key, p.port)
  const file = open.writeOpenFile(link.url, link.nonce)
  const res = await fetch(link.url)
  assert.equal(res.status, 200)
  assert.ok(!fs.existsSync(file))
})

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const linkIn = (text) => /(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)/.exec(text)?.[1]

test('ui --link prints a fresh link for the panel already running, and starts nothing', async () => {
  const p = await serve({ port: 0 })
  servers.push(p.server)
  const before = fs.readdirSync(open.openDir())
  const res = await cli(['ui', '--link', '--port', String(p.port)])
  assert.equal(res.code, 0, res.stderr)
  const link = linkIn(res.stdout)
  assert.ok(link, res.stdout)
  assert.deepEqual(fs.readdirSync(open.openDir()), before, '--link opens nothing')
  assert.equal((await fetch(link)).status, 200)
  assert.equal((await fetch(link)).status, 401, 'it works once')
  const launcher = await cli(['ui', '--link', '--launcher', '--port', String(p.port)])
  assert.match(linkIn(launcher.stdout), /&to=\/launcher$/)
})

test('ui --link refuses a port with no panel of this user on it', async () => {
  const p = await serve({ port: 0 })
  const port = p.port
  p.server.closeAllConnections()
  await new Promise((resolve) => p.server.close(resolve))
  const res = await cli(['ui', '--link', '--port', String(port)])
  assert.equal(res.code, 1)
  assert.match(res.stderr, new RegExp(`no SpawnLoft panel of yours is running on port ${port}`))
  assert.equal(linkIn(res.stdout + res.stderr), undefined)
})

test('ui onto a running panel signs a browser in to it; --no-open only prints', async () => {
  const p = await serve({ port: 0 })
  servers.push(p.server)
  // the "browser" is Node, given the page; it stops at the first line, having done nothing
  const env = { BROWSER: process.execPath }
  const before = new Set(fs.readdirSync(open.openDir()))
  const opened = await cli(['ui', '--port', String(p.port)], env)
  assert.equal(opened.code, 0, opened.stderr)
  assert.match(opened.stdout, /already running/)
  const made = fs.readdirSync(open.openDir()).filter((f) => !before.has(f))
  assert.equal(made.length, 1)
  assert.match(fs.readFileSync(path.join(open.openDir(), made[0]), 'utf8'), new RegExp(linkIn(opened.stdout).replace(/[.?]/g, '\\$&')))
  // using the link removes the page
  assert.equal((await fetch(linkIn(opened.stdout))).status, 200)
  assert.deepEqual(fs.readdirSync(open.openDir()).filter((f) => !before.has(f)), [])
  const printed = await cli(['ui', '--no-open', '--port', String(p.port)], env)
  assert.equal(printed.code, 0)
  assert.ok(linkIn(printed.stdout))
  assert.deepEqual(fs.readdirSync(open.openDir()).filter((f) => !before.has(f)), [])
})
