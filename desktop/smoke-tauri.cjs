'use strict'

// Drives the Tauri window (rust/crates/spawnloft-shell) through WebDriver: tauri-driver in front
// of WebKitWebDriver on Linux or msedgedriver on Windows (macOS has no WebDriver for WKWebView).
// It checks what the shell adds over the panel itself (PLAN-2.0-REMAINING.md section 3C): the
// first-run wizard and the core restart after it, the bridge and its refusals, the interface size
// and its file, the navigation guard, the console and launcher windows, downloads, Microsoft
// sign-in in the system browser, the window's saved place, and that a killed core leaves no Node
// panel behind. And the panel's lock (rust/PANEL-AUTH-DESIGN.md): the window is signed in through
// its login link, its console and launcher windows share that session, and nothing without a
// credential gets an answer from either listener. Optional screenshots at a given screen size (Linux: run under Xvfb at that size).
//
// Usage: node desktop/smoke-tauri.cjs <SpawnLoft executable> <spawnloft-core executable> <core dir> <artifacts dir>
//   env TAURI_DRIVER (default tauri-driver on PATH), SMOKE_SCREENSHOT=<name> to save screenshots
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { authorization, provesItself } = require('./smoke-panel-auth.cjs')

const [shellExe, coreExe, coreDir, outDir] = process.argv.slice(2).map((p) => p && path.resolve(p))
assert.ok(shellExe && coreExe && coreDir && outDir, 'usage: smoke-tauri.cjs <shell> <core> <core dir> <artifacts>')
fs.mkdirSync(outDir, { recursive: true })
const isWin = process.platform === 'win32'

const scratch = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'slt-'))
const home = path.join(scratch, 'h')
const config = path.join(scratch, 'c')
const downloads = path.join(home, 'Downloads')
const opened = path.join(scratch, 'opened.txt')
const bin = path.join(scratch, 'bin')
for (const d of [home, config, downloads, bin]) fs.mkdirSync(d, { recursive: true })
// the system browser and file manager, recorded instead of opened
if (!isWin) {
  for (const name of ['xdg-open', 'gio', 'gnome-open', 'kde-open']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`, { mode: 0o755 })
  }
}
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: config,
  LOCALAPPDATA: path.join(scratch, 'l'),
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: path.join(scratch, 'share'),
  XDG_DOWNLOAD_DIR: downloads,
  PATH: isWin ? process.env.PATH : `${bin}:${process.env.PATH}`,
  SPAWNLOFT_CORE_BIN: coreExe,
  SPAWNLOFT_CORE_DIR: coreDir,
  SPAWNLOFT_SPIKE_LOG: path.join(outDir, 'shell-spike.log'),
}
delete env.SPAWNLOFT_DATA_ROOT
delete env.MCCTL_DATA_ROOT
const configDir = path.join(config, 'spawnloft')
const dataRoot = path.join(scratch, 'Data folder')
const log = []
const record = (m) => { console.log(m); log.push(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(250)
  }
  throw new Error(`timed out: ${what}${last instanceof Error ? ` (${last.message})` : ''}`)
}

// ---- a minimal W3C WebDriver client --------------------------------------------------------
const DRIVER = 'http://127.0.0.1:4444'
let sid = null
async function wd(method, url, body) {
  const res = await fetch(`${DRIVER}${sid && !url.startsWith('/session ') ? `/session/${sid}` : ''}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url}: ${JSON.stringify(out.value ?? out).slice(0, 400)}`)
  return out.value
}
const js = (script, ...args) => wd('POST', '/execute/sync', { script, args })
const jsAsync = (script, ...args) => wd('POST', '/execute/async', { script, args })
const url = () => wd('GET', '/url')
// the status of a GET made by the page itself, with whatever credential the window holds
const pageGet = (route) => jsAsync(`const done = arguments[arguments.length - 1]; fetch(${JSON.stringify(route)}).then((r) => done(r.status), (e) => done(String(e)))`)
// the port a process listens on (Linux), to reach the Node panel behind the core directly
function listeningPort(pid) {
  try {
    const line = execFileSync('ss', ['-Hltnp']).toString().split('\n').find((l) => l.includes(`pid=${pid},`))
    return line ? Number(/:(\d+)\s/.exec(line)?.[1]) : null
  } catch { return null }
}
// a bridge call from the page, awaited
const bridge = (expr) => jsAsync(`const done = arguments[arguments.length - 1]; Promise.resolve().then(() => ${expr}).then((v) => done({ v }), (e) => done({ e: String(e && e.message || e) }))`)

// whole argument runs, so a shell that only mentions them (a wrapper script) does not match
const CORE_UI = 'spawnloft-core ui --port 0 --exit-with-stdin'
const NODE_PANEL = 'spawnloft.mjs ui --port 0 --no-open --exit-with-stdin'
function pids(pattern) {
  if (isWin) {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`]).toString()
    return out.split(/\s+/).filter(Boolean).map(Number)
  }
  try { return execFileSync('pgrep', ['-f', pattern]).toString().split(/\s+/).filter(Boolean).map(Number) } catch { return [] }
}

async function main() {
  const driver = spawn(process.env.TAURI_DRIVER || 'tauri-driver', [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  driver.stdout.on('data', (c) => log.push(`[driver] ${c}`))
  driver.stderr.on('data', (c) => log.push(`[driver] ${c}`))
  try {
    await until(() => fetch(`${DRIVER}/status`).then((r) => r.ok), 'tauri-driver')
    const session = await (await fetch(`${DRIVER}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { alwaysMatch: { 'tauri:options': { application: shellExe } } } }),
    })).json()
    sid = session.value?.sessionId
    assert.ok(sid, `no WebDriver session: ${JSON.stringify(session).slice(0, 400)}`)
    record('window: open')

    // 1. a machine with no settings gets the first-run wizard, served by the panel at /setup
    await until(async () => /^http:\/\/127\.0\.0\.1:\d+\/setup$/.test(await url()), 'the first-run wizard', 60000)
    const first = new URL(await url())
    record(`setup: shown at ${first.pathname}`)
    const setup = (await bridge('window.spawnloftDesktop.getSetup()')).v
    assert.equal(setup.needed, true)
    assert.ok(setup.defaultDataRoot, 'the wizard gets a default location')
    if (process.env.SMOKE_SCREENSHOT) {
      await until(() => js('return Boolean(document.querySelector("#root") && document.querySelector("#root").value)'), 'the wizard filled in')
      await fill()
      await shot(`${process.env.SMOKE_SCREENSHOT}-first-run`)
    }
    // Saving restarts the core, and the window navigates to the new panel. When that navigation
    // wins the race with the call's answer, WebDriver reports the page gone ("Callback was not
    // called before the unload event"): the save went through, and the checks below prove it.
    let saved
    try {
      saved = await bridge(`window.spawnloftDesktop.saveSetup(${JSON.stringify({ dataRoot, separate: false })})`)
    } catch (err) {
      if (!/before the unload event|no such frame/.test(err.message)) throw err
      saved = { ok: true }
      record('setup: the window moved on before the save answered')
    }
    assert.deepEqual(saved.v ?? saved, { ok: true })
    // the core restarts on the new location: a new port, and the panel itself
    await until(async () => { const u = new URL(await url()); return u.port !== first.port && u.pathname === '/' }, 'the panel after setup', 60000)
    const panel = new URL(await url())
    assert.ok(fs.existsSync(path.join(configDir, 'settings.json')), 'settings.json written')
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).dataRoot, dataRoot)
    record(`setup: saved, core restarted on port ${panel.port}`)
    await until(() => js('return document.readyState === "complete" && !!document.querySelector("#uiSize")'), 'the panel page')

    // 1b. the lock. The window came in through /auth and holds a session the page cannot read;
    // nobody without a credential gets an answer, from the core or from the Node panel behind it
    assert.equal(await pageGet('/api/setup'), 200, 'the window is signed in')
    assert.equal(await js('return document.cookie'), '', 'the session cookie is HttpOnly')
    for (const route of ['/api/instances', '/api/setup', '/api/update', '/api/client/launcher']) {
      const res = await fetch(`http://127.0.0.1:${panel.port}${route}`)
      assert.equal(res.status, 401, `${route} without a credential`)
      assert.equal((await res.json()).code, 'auth')
    }
    assert.equal((await fetch(`http://127.0.0.1:${panel.port}/`)).status, 401, 'the page without a credential')
    assert.equal((await fetch(`http://127.0.0.1:${panel.port}/api/setup`, { headers: { authorization: authorization(configDir, panel.port) } })).status, 200, 'a token signed with the install\'s key')
    // a page on another loopback port could make the browser send the cookie; such a request is refused
    assert.equal((await fetch(`http://127.0.0.1:${panel.port}/api/setup`, { headers: { authorization: authorization(configDir, panel.port), 'sec-fetch-site': 'same-site' } })).status, 403)
    // through the proxy too, the panel proves it holds the key to a caller that asks
    assert.ok(await provesItself(configDir, `http://127.0.0.1:${panel.port}/api/client/launcher`), 'the panel proves itself')
    const nodePort = isWin ? null : listeningPort(pids(NODE_PANEL)[0])
    if (nodePort) {
      assert.notEqual(nodePort, Number(panel.port))
      assert.equal((await fetch(`http://127.0.0.1:${nodePort}/api/instances`)).status, 401, 'the Node panel, called directly')
      // the window's token is for the core's port, not this one
      assert.equal((await fetch(`http://127.0.0.1:${nodePort}/api/instances`, { headers: { authorization: authorization(configDir, panel.port) } })).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${nodePort}/api/instances`, { headers: { authorization: authorization(configDir, nodePort) } })).status, 200)
      record(`lock: no credential, no answer, on the core (${panel.port}) and on the Node panel behind it (${nodePort})`)
    } else {
      record(`lock: no credential, no answer, on the core (${panel.port}); the Node panel's port was not found, so it was not called directly`)
    }

    // 1c. a window whose sign-in ran out. The cookie is taken away (what the panel's idle time
    // does on its side); the page's next request is refused and it says its session has ended,
    // with a button. The button reloads; the panel answers with its sign-in page, which under
    // the window moves itself to /auth/again; the window answers that with a new one-use link,
    // and the page is back, signed in.
    await wd('DELETE', '/cookie')
    await js('fetch("/api/setup").catch(() => {})')
    await until(() => js('const b = document.querySelector("#sessionEnded button"); return !!b && b.textContent === "Sign in again"'), 'the session-ended notice with its button')
    if (process.env.SMOKE_SCREENSHOT) await shot(`${process.env.SMOKE_SCREENSHOT}-session-ended`)
    await js('setTimeout(() => document.querySelector("#sessionEnded button").click(), 0)')
    await until(async () => new URL(await url()).pathname === '/' && await js('return document.readyState === "complete" && !!document.querySelector("#uiSize") && !document.getElementById("sessionEnded")'), 'the panel after signing in again', 30000)
    assert.equal(new URL(await url()).port, panel.port)
    assert.equal(await pageGet('/api/setup'), 200, 'signed in again')
    record('sign-in: a window whose session ended is signed in again from its notice')

    if (process.env.SMOKE_SCREENSHOT) {
      await fill()
      await sleep(1500)
      const z = (await bridge('window.spawnloftDesktop.getZoom()')).v
      record(`screenshot: Auto picks ${Math.round(z.zoom * 100)}% on this screen`)
      await shot(`${process.env.SMOKE_SCREENSHOT}-panel`)
      await js('typeof showPlay === "function" && showPlay()')
      await sleep(3000)
      await shot(`${process.env.SMOKE_SCREENSHOT}-play`)
      await js('location.reload()')
      await until(() => js('return document.readyState === "complete" && !!document.querySelector("#uiSize")'), 'the panel page again')
    }

    // 2. the bridge, and its refusals
    const shape = await js('const d = window.spawnloftDesktop; return d && { shell: d.shell, keys: Object.keys(d).sort(), frozen: Object.isFrozen(d) }')
    assert.equal(shape.shell, 'tauri')
    assert.ok(shape.frozen)
    for (const k of ['pickFolder', 'pickFile', 'getZoom', 'setZoom', 'openExternal', 'openProfileFolder', 'openMicrosoftLogin', 'focusWindow', 'getSetup', 'saveSetup', 'checkJava']) assert.ok(shape.keys.includes(k), k)
    assert.deepEqual((await bridge('window.spawnloftDesktop.focusWindow()')).v, { ok: true })
    assert.ok(!shape.keys.includes('appInfo'), 'no Electron updater calls')
    assert.deepEqual((await bridge('window.spawnloftDesktop.openExternal("file:///etc/passwd")')).v, { ok: false })
    assert.deepEqual((await bridge('window.spawnloftDesktop.openMicrosoftLogin("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x")')).v, { ok: false })
    assert.deepEqual((await bridge('window.spawnloftDesktop.openProfileFolder("no-such-profile")')).v, { ok: false })
    // an app command the bridge does not grant, called straight through Tauri's IPC
    const raw = await bridge('window.__TAURI_INTERNALS__.invoke("plugin:dialog|open", { options: {} })')
    assert.ok(raw.e, `the dialog plugin's own command must be refused, got ${JSON.stringify(raw)}`)
    record('bridge: present, frozen, refuses bad input and ungranted commands')
    const java = (await bridge('window.spawnloftDesktop.checkJava()')).v
    assert.ok(java && 'downloadUrl' in java, 'checkJava answers')

    // 3. interface size: the call, the keyboard and the file
    const z0 = (await bridge('window.spawnloftDesktop.getZoom()')).v
    assert.equal(z0.setting, 'auto')
    record(`zoom: auto is ${z0.zoom * 100}% on this display`)
    const z1 = (await bridge('window.spawnloftDesktop.setZoom(1.25)')).v
    assert.deepEqual(z1, { setting: 1.25, zoom: 1.25 })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'ui-zoom.json'), 'utf8')), { zoom: 1.25 })
    await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal", ctrlKey: true, bubbles: true }))')
    await until(async () => (await bridge('window.spawnloftDesktop.getZoom()')).v.zoom === 1.5, 'Ctrl+= steps up')
    await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", code: "Digit0", ctrlKey: true, bubbles: true }))')
    await until(async () => (await bridge('window.spawnloftDesktop.getZoom()')).v.zoom === 1, 'Ctrl+0 resets')
    assert.deepEqual((await bridge('window.spawnloftDesktop.setZoom("auto")')).v.setting, 'auto')
    record('zoom: setZoom, Ctrl+= and Ctrl+0 work and are saved')

    // 4. the navigation guard
    for (const target of ['https://example.com/', `http://127.0.0.1:${Number(panel.port) === 65535 ? 1 : Number(panel.port) + 1}/`, 'file:///etc/hosts']) {
      await js(`location.href = ${JSON.stringify(target)}`)
      await sleep(800)
      assert.equal(new URL(await url()).origin, panel.origin, `navigating to ${target} must be refused`)
    }
    record('guard: https, another loopback port and file: are refused')

    // 5. window.open: a console window, the launcher, and https to the browser
    const before = await wd('GET', '/window/handles')
    // a real click each: webviews block window.open without a user gesture, as browsers do
    await clickOpen('/?console=smoke%20server', 'spawnloft-console-smoke')
    await clickOpen('/launcher', 'spawnloft-launcher')
    await clickOpen('http://127.0.0.1:1/elsewhere', '_blank')
    const handles = await until(async () => { const h = await wd('GET', '/window/handles'); return h.length >= before.length + 2 && h }, 'the console and launcher windows')
    assert.equal(handles.length, before.length + 2, 'exactly two windows: the refused one never opens')
    const main = await wd('GET', '/window')
    const seen = []
    for (const h of handles.filter((h) => h !== main)) {
      await wd('POST', '/window', { handle: h })
      const u = new URL(await until(() => url().then((v) => v.startsWith('http') && v), 'child window url'))
      seen.push(u.pathname + u.search)
      const has = await until(() => js('return document.readyState === "complete" && typeof window.spawnloftDesktop'), 'child page')
      assert.equal(has, 'object', 'child windows get the bridge')
      // built by the shell, not by the page: signed in only because the app's windows share cookies
      assert.equal(await pageGet('/api/setup'), 200, `${u.pathname + u.search} shares the main window's session`)
      assert.ok(await js('return !!document.querySelector("#uiSize, #app, main, body > *")') && !/not signed in to SpawnLoft/.test(await wd('GET', '/title')), 'the child shows its page, not the sign-in page')
    }
    assert.deepEqual(seen.sort(), ['/?console=smoke%20server', '/launcher'])
    await wd('POST', '/window', { handle: main })
    // the same console again focuses the open one
    await clickOpen('/?console=smoke%20server', 'spawnloft-console-smoke')
    await sleep(1000)
    assert.equal((await wd('GET', '/window/handles')).length, handles.length, 'a second open of the same console opens nothing new')
    record('windows: console and launcher open with the bridge and the session; other addresses do not')

    // 6. a download from the panel goes to Downloads
    await js('const a = document.createElement("a"); a.href = "/api/setup"; a.download = "../setup check.json"; document.body.append(a); a.click(); a.remove()')
    const file = await until(() => fs.readdirSync(downloads).find((f) => f.includes('setup check')), 'the download in Downloads')
    assert.equal(file, 'setup check.json')
    assert.ok(JSON.parse(fs.readFileSync(path.join(downloads, file), 'utf8')).defaultDataRoot)
    record(`download: saved as Downloads/${file}`)

    // 7. Microsoft sign-in goes to the system browser, coming back through the window's port
    if (!isWin) {
      const made = await jsAsync('const done = arguments[0]; fetch("/api/client/accounts/login", { method: "POST" }).then((r) => r.json()).then(done, (e) => done({ error: String(e) }))')
      assert.ok(made.authorizeUrl, `the panel makes a sign-in: ${JSON.stringify(made)}`)
      const redirect = new URL(made.authorizeUrl).searchParams.get('redirect_uri')
      assert.equal(redirect, `http://localhost:${panel.port}/api/client/accounts/login/callback`)
      assert.deepEqual((await bridge(`window.spawnloftDesktop.openMicrosoftLogin(${JSON.stringify(made.authorizeUrl)})`)).v, { ok: true, external: true })
      await until(() => fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').includes('login.microsoftonline.com'), 'the browser asked to open Microsoft\'s page')
      // the callback reaches the panel through the proxy (a forged code is refused, but answered)
      const cb = await fetch(`http://localhost:${panel.port}/api/client/accounts/login/callback?code=x&state=nope`).catch(() => fetch(`http://127.0.0.1:${panel.port}/api/client/accounts/login/callback?code=x&state=nope`))
      assert.equal(cb.status, 400)
      await fetch(`http://127.0.0.1:${panel.port}/api/client/accounts/login/${made.loginId}`, { method: 'DELETE', headers: { origin: panel.origin, authorization: authorization(configDir, panel.port) } }).catch(() => {})
      record('sign-in: system browser, redirect through the window\'s own port')
    }

    // 8. the window's place is saved
    await wd('POST', '/window', { handle: main })
    await wd('POST', '/window/rect', { width: 1111, height: 777 }).catch(() => {})
    await sleep(1200)

    // 9. a killed core takes its Node panel with it
    const cores = pids(CORE_UI)
    const nodes = pids(NODE_PANEL)
    assert.ok(cores.length >= 1 && nodes.length >= 1, `a core (${cores}) and a Node panel (${nodes}) are running`)
    for (const p of cores) process.kill(p, 'SIGKILL')
    await until(() => !pids(NODE_PANEL).some((p) => nodes.includes(p)), 'the Node panel to end with its core', 15000)
    record('orphans: the Node panel ended with its killed core')
    // and the window starts the core again and shows the panel on its new port
    await until(async () => { const u = new URL(await url()); return u.port !== panel.port && u.pathname === '/' }, 'the panel again after the core was killed', 60000)
    record(`restart: the window started the core again (port ${new URL(await url()).port})`)
    // a new port is a new listener: the window was signed in there again, the old session is gone
    await until(() => js('return document.readyState === "complete" && !!document.querySelector("#uiSize")'), 'the panel page after the restart')
    assert.equal(await pageGet('/api/setup'), 200, 'the window is signed in to the restarted core')
    // a Node panel that dies takes its core along, and the window brings both back
    const second = new URL(await url())
    const node2 = await until(() => { const n = pids(NODE_PANEL); return n.length && n }, 'the new Node panel')
    for (const p of node2) process.kill(p, 'SIGKILL')
    await until(async () => { const u = new URL(await url()); return u.port !== second.port && u.pathname === '/' }, 'the panel again after the Node panel was killed', 60000)
    record(`restart: a killed Node panel brought the core down and the window started both again (port ${new URL(await url()).port})`)

    // 10. a core that keeps stopping: the window says so itself, in words for a person, and
    // Try again starts it. (Killed four times in all by now, one more than the window retries.)
    for (let i = 0; i < 4; i++) {
      // each core is killed once it serves the window, as the two above were: one killed before
      // it printed its address is a start that failed, which is said differently
      const at = await until(async () => { const u = await url(); return (/[?&]failed=/.test(u) || (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(u) && await js('return document.readyState === "complete" && !!document.querySelector("#uiSize")'))) && u }, 'the panel, or the failure state', 60000)
      if (/[?&]failed=/.test(at)) break
      for (const p of pids(CORE_UI)) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
      await until(async () => (await url()) !== at, 'the window to leave the killed core', 30000)
    }
    await until(async () => /[?&]failed=/.test(await url()), 'the window to say it could not start', 60000)
    const said = await until(() => js('const f = document.getElementById("failed"); return f && !f.hidden && { h: f.querySelector("h1").textContent, said: document.getElementById("said").textContent, detail: document.getElementById("detail").textContent, links: [...f.querySelectorAll("a")].map((a) => a.textContent) }'), 'the failure state')
    assert.equal(said.h, 'SpawnLoft could not start')
    assert.match(said.said, /background service keeps stopping/)
    assert.match(said.detail, /panel\.log/)
    assert.deepEqual(said.links, ['Try again', 'Open the log folder', 'Quit'])
    if (process.env.SMOKE_SCREENSHOT) await shot(`${process.env.SMOKE_SCREENSHOT}-could-not-start`)
    record(`failure: the window says "${said.said}"`)
    // the log folder goes to the file manager, and the page stays where it is
    if (!isWin) {
      const before = fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : ''
      await js('document.querySelector("#failed a[href*=\\"do=log\\"]").click()')
      await until(() => fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').length > before.length, 'the log folder to be opened')
      assert.match(await url(), /[?&]failed=/)
    }
    await js('setTimeout(() => document.getElementById("retry").click(), 0)')
    await until(async () => { const u = new URL(await url()); return /^127\.0\.0\.1$/.test(u.hostname) && u.pathname === '/' }, 'the panel after Try again', 60000)
    await until(() => js('return document.readyState === "complete" && !!document.querySelector("#uiSize")'), 'the panel page after Try again')
    assert.equal(await pageGet('/api/setup'), 200, 'signed in after Try again')
    record('failure: Try again started the core and opened the panel')

    await wd('DELETE', '')
    sid = null
    const state = await until(() => fs.existsSync(path.join(configDir, 'window-state.json')) && JSON.parse(fs.readFileSync(path.join(configDir, 'window-state.json'), 'utf8')), 'window-state.json')
    assert.ok(state.width > 0 && state.height > 0, JSON.stringify(state))
    record(`window state: saved ${JSON.stringify(state)}`)
    record('PASS')
  } finally {
    if (sid) await wd('DELETE', '').catch(() => {})
    driver.kill()
    // The driver's output pipes are inherited by what it started (WebKitWebDriver, the window, the
    // cores). When one of those outlives the driver by a moment the pipes stay open, and this
    // script sat there after PASS with nothing left to do until the job's time ran out.
    driver.stdout.destroy()
    driver.stderr.destroy()
    driver.unref()
    fs.writeFileSync(path.join(outDir, 'smoke-tauri.log'), log.join('\n') + '\n')
    // every run folder: the chosen root's, and the default one the first core used before setup
    for (const p of fs.readdirSync(scratch, { recursive: true }).map((r) => path.join(scratch, r))) {
      if (!/^(shell|panel)\.log$/.test(path.basename(p)) || path.basename(path.dirname(p)) !== 'run') continue
      const name = path.relative(scratch, p).replace(/[\\/ ]+/g, '_')
      try { fs.copyFileSync(p, path.join(outDir, name)) } catch { /* gone with its folder */ }
    }
  }
}

// a button that calls window.open, clicked through WebDriver (a trusted click)
async function clickOpen(target, name) {
  await js(`document.getElementById('smoke-open')?.remove();
    const b = document.createElement('button'); b.id = 'smoke-open'; b.textContent = 'open';
    b.style.cssText = 'position:fixed;left:0;top:0;width:80px;height:40px;z-index:2147483647';
    b.onclick = () => { window.open(${JSON.stringify(target)}, ${JSON.stringify(name)}); b.remove() };
    document.body.append(b)`)
  const el = await wd('POST', '/element', { using: 'css selector', value: '#smoke-open' })
  await wd('POST', `/element/${Object.values(el)[0]}/click`, {})
  await sleep(400)
}

// the window filling the screen (SMOKE_SCREEN=<w>x<h>; Xvfb has no window manager to maximise it)
async function fill() {
  const m = /^(\d+)x(\d+)$/.exec(process.env.SMOKE_SCREEN || '')
  if (m) await wd('POST', '/window/rect', { x: 0, y: 0, width: Number(m[1]), height: Number(m[2]) }).catch(() => {})
  else await wd('POST', '/window/maximize', {}).catch(() => {})
  await sleep(1000)
}

// the page as the window shows it
async function shot(name) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(await wd('GET', '/screenshot'), 'base64'))
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
