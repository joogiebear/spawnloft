'use strict'

// Loads the Tailwind probe page (test/fixtures/tailwind-probe) in the web engine a SpawnLoft
// window uses on this system, and fails if the page says any of its checks failed. The probe is
// the panel's own Tailwind input built over a small page, loaded the way the panel's pages load
// their stylesheets; it checks itself (probe.js), so this only has to open it and read the answer.
//
//   edge       Microsoft Edge through msedgedriver: the Chromium that WebView2 is built from
//   safari     Safari through safaridriver: the system WebKit that WKWebView uses
//   webkitgtk  WebKitGTK's MiniBrowser through WebKitWebDriver: the library the Linux window links
//
// These are the engines, not the SpawnLoft window itself: on Linux the window is driven too
// (desktop/smoke-tauri.cjs), and there is no WebDriver for WKWebView at all.
//
// Usage: node desktop/smoke-css-engines.cjs <edge|safari|webkitgtk> <built probe css>
//   build it first: node tools/panel-css.mjs build test/fixtures/tailwind-probe/probe.css <file>
//   env CSS_ENGINE_DRIVER overrides the driver program
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')

const [engine, builtCss] = process.argv.slice(2)
const repo = path.resolve(__dirname, '..')
const probeDir = path.join(repo, 'test', 'fixtures', 'tailwind-probe')

function webkitMiniBrowser() {
  const found = ['x86_64-linux-gnu', 'aarch64-linux-gnu'].map((t) => `/usr/lib/${t}/webkit2gtk-4.1/MiniBrowser`)
    .concat(['/usr/libexec/webkit2gtk-4.1/MiniBrowser'])
    .find((p) => fs.existsSync(p))
  assert.ok(found, 'WebKitGTK MiniBrowser is not installed (Debian and Ubuntu: apt-get install webkit2gtk-driver)')
  return found
}

const ENGINES = {
  edge: () => ({
    driver: process.env.EDGEWEBDRIVER ? path.join(process.env.EDGEWEBDRIVER, process.platform === 'win32' ? 'msedgedriver.exe' : 'msedgedriver') : 'msedgedriver',
    args: (port) => [`--port=${port}`],
    capabilities: { browserName: 'MicrosoftEdge', 'ms:edgeOptions': { args: ['--headless=new'] } },
  }),
  safari: () => ({
    driver: '/usr/bin/safaridriver',
    args: (port) => ['--port', String(port)],
    capabilities: { browserName: 'safari' },
  }),
  webkitgtk: () => ({
    driver: 'WebKitWebDriver',
    args: (port) => [`--port=${port}`, '--host=127.0.0.1'],
    capabilities: { browserName: 'MiniBrowser', 'webkitgtk:browserOptions': { binary: webkitMiniBrowser(), args: ['--automation'] } },
  }),
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function freePort() {
  const s = http.createServer()
  const port = await listen(s)
  await new Promise((r) => s.close(r))
  return port
}

async function main() {
  assert.ok(ENGINES[engine] && builtCss, 'usage: smoke-css-engines.cjs <edge|safari|webkitgtk> <built probe css>')
  assert.ok(fs.existsSync(builtCss), `${builtCss} is not there: build it with tools/panel-css.mjs build`)
  const { driver, args, capabilities } = ENGINES[engine]()

  // the probe's four files and nothing else, under the names the page asks for
  const files = {
    '/probe.html': [path.join(probeDir, 'probe.html'), 'text/html; charset=utf-8'],
    '/probe.js': [path.join(probeDir, 'probe.js'), 'text/javascript; charset=utf-8'],
    '/tokens.css': [path.join(repo, 'src', 'panel', 'css', 'tokens.css'), 'text/css; charset=utf-8'],
    '/probe.out.css': [path.resolve(builtCss), 'text/css; charset=utf-8'],
  }
  const site = http.createServer((req, res) => {
    const hit = files[new URL(req.url, 'http://x').pathname]
    if (!hit) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-store' }).end(fs.readFileSync(hit[0]))
  })
  const sitePort = await listen(site)

  const driverPort = await freePort()
  const child = spawn(process.env.CSS_ENGINE_DRIVER || driver, args(driverPort), { stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  child.stdout.on('data', (c) => { said += c })
  child.stderr.on('data', (c) => { said += c })
  const started = new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve) })
  const base = `http://127.0.0.1:${driverPort}`
  let session = null
  async function wd(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(out.value || out).slice(0, 400)}`)
    return out.value
  }
  try {
    await started
    // the driver takes a moment to listen
    for (let i = 0; ; i++) {
      try { await wd('GET', '/status'); break } catch (e) {
        if (i > 80) throw new Error(`${driver} did not start listening: ${e.message}\n${said}`)
        await sleep(250)
      }
    }
    const made = await wd('POST', '/session', { capabilities: { alwaysMatch: capabilities } })
    session = made.sessionId
    const s = `/session/${session}`
    await wd('POST', `${s}/url`, { url: `http://127.0.0.1:${sitePort}/probe.html` })
    let title = ''
    for (let i = 0; i < 80; i++) {
      title = await wd('GET', `${s}/title`)
      if (title === 'probe: pass' || title === 'probe: fail') break
      await sleep(250)
    }
    const result = await wd('POST', `${s}/execute/sync`, { script: 'var r = document.getElementById("result"); return r ? r.textContent : ""', args: [] })
    console.log(result)
    assert.equal(title, 'probe: pass', `the probe did not pass in ${engine} (title: ${JSON.stringify(title)})`)
    assert.ok(/^ok {3}/m.test(result) && !/^FAIL/m.test(result), 'the probe listed its checks, none failed')
    console.log(`PASS: Tailwind's output draws as the panel expects in ${engine}`)
  } finally {
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {})
    child.kill()
    site.close()
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1) })
