#!/usr/bin/env node
// M3 console pane (PLAN.md section 2.2). Node has no DOM, so this drives the real panel page in
// the desktop app over the Chrome DevTools Protocol, with Node's built-in WebSocket (Node 22+) and
// no Playwright: it starts the app with --remote-debugging-port, opens a bench server's console,
// feeds 5,000 synthetic lines through the page's own pushLine(), then times 2,000 more in batches
// of 50, without and with a search filter. CommonJS so it runs from anywhere without a package.json.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { parseArgs } = require('node:util')

const REPO = path.resolve(__dirname, '..', '..')

const USAGE = `node tools/perf/console-bench.cjs (--app <path> | --checkout | --browser <path>) --data-root <dir> [options]

  --app <path>        the installed desktop app (SpawnLoft.exe, SpawnLoft.app/Contents/MacOS/SpawnLoft)
  --checkout          run this checkout's desktop app instead (desktop/: electron . --core ..)
  --browser <path>    no desktop app: serve the panel from this checkout (node mcctl.mjs ui) and
                      open it in this Chrome/Chromium, headless. For a Linux box without a
                      desktop; the number is Chromium's, not the app's, so label it as such.
  --data-root <dir>   bench data root: empty, missing or made by tools/perf (one stopped server
                      is registered there so the console has something to open)
  --lines <n>         lines fed before timing (default 5000)
  --timed <n>         lines timed (default 2000)
  --batch <n>         lines per batch, one frame between batches (default 50)
  --filter <text>     search text for the filtered pass (default WARN)
  --timeout <min>     give up after this many minutes (default 30; a slow machine can take long:
                      every unfiltered line forces a layout of the whole console)
  --machine, --commit, --note, --out   as for the other scripts
  --self-test         check the in-page benchmark against a stub page (no Electron needed)

Close SpawnLoft first: the app allows one copy, and a second one quits at once.`

// ------------------------------------------------------------------ lines ------------------

// Deterministic mix of what a busy server prints: mostly INFO, some WARN and ERROR, and a stack
// trace now and then (continuation lines inherit the level above them in the panel).
function makeLines(count) {
  const out = []
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const plugins = ['LuckPerms', 'EssentialsX', 'WorldEdit', 'Vault', 'CoreProtect']
  for (let i = 0; out.length < count; i++) {
    const t = `[${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`
    const r = rnd()
    if (r < 0.02) {
      out.push(`${t} ERROR]: Could not pass event PlayerMoveEvent to ${plugins[i % plugins.length]}`)
      out.push('java.lang.NullPointerException: Cannot invoke "Object.toString()" because "value" is null')
      for (let k = 0; k < 4 && out.length < count; k++) out.push(`\tat com.example.plugin.Listener.onMove(Listener.java:${40 + k})`)
    } else if (r < 0.1) {
      out.push(`${t} WARN]: Can't keep up! Is the server overloaded? Running ${Math.round(rnd() * 3000)}ms or ${Math.round(rnd() * 60)} ticks behind`)
    } else {
      out.push(`${t} INFO]: Player${i % 40} issued server command: /home ${i % 7} [${plugins[i % plugins.length]}] chunk ${Math.round(rnd() * 1e5)}`)
    }
  }
  return out.slice(0, count)
}

// ------------------------------------------------------------------ the page side ----------

// Runs inside the panel page. Uses only the page's own globals (select, stopStream, showPane,
// clearLines, renderLog, pushLine, state) so it measures exactly what a streamed line costs.
async function pageBench(o) {
  const lines = makeLines(o.warm + o.timed)
  const out = {}
  const long = []
  let po = null
  try {
    po = new PerformanceObserver((list) => { for (const e of list.getEntries()) long.push(e.duration) })
    po.observe({ type: 'longtask' })
  } catch (_) { /* no long-task support: counts stay empty */ }
  // one frame between batches, so layout and paint land between them as they would live; capped
  // in case the window is hidden and frames stop
  const frame = () => new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish)
    setTimeout(finish, 100)
  })
  for (const filter of o.filters) {
    stopStream()
    select(o.name)
    stopStream()
    showPane('console')
    clearLines()
    state.paused = false
    state.search = filter
    renderLog()
    for (let i = 0; i < o.warm; i++) pushLine(lines[i])
    if (typeof flushConsole === 'function') flushConsole()
    await frame()
    long.length = 0
    let worst = 0
    let scriptMs = 0
    let batchMax = 0
    const t0 = performance.now()
    for (let i = o.warm; i < o.warm + o.timed; i += o.batch) {
      const b0 = performance.now()
      const end = Math.min(i + o.batch, o.warm + o.timed)
      for (let j = i; j < end; j++) {
        const s = performance.now()
        pushLine(lines[j])
        const d = performance.now() - s
        scriptMs += d
        if (d > worst) worst = d
      }
      // A panel that draws once a frame (flushConsole) does its DOM work here, not in pushLine;
      // time it with the batch so before and after measure the same work.
      if (typeof flushConsole === 'function') {
        const s = performance.now()
        flushConsole()
        // the layout the browser would otherwise do after the timer stops, during the frame
        void document.getElementById('log').scrollHeight
        const d = performance.now() - s
        scriptMs += d
        if (d > worst) worst = d
      }
      batchMax = Math.max(batchMax, performance.now() - b0)
      await frame()
    }
    out[filter ? 'filtered' : 'unfiltered'] = {
      filter,
      msPer1000: (scriptMs / o.timed) * 1000,
      wallMs: performance.now() - t0,
      longestPushLineMs: worst,
      longestBatchMs: batchMax,
      longTasks: long.length,
      longestTaskMs: long.length ? Math.max(...long) : 0,
      linesHeld: state.lines.length,
      nodesInLog: document.querySelectorAll('#log > *').length,
    }
  }
  if (po) po.disconnect()
  state.search = ''
  clearLines()
  renderLog()
  return out
}

const PAGE_SOURCE = `${makeLines.toString()}\n${pageBench.toString()}`

// ------------------------------------------------------------------ CDP --------------------

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.next = 1
    this.waiting = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = (e) => reject(new Error(`DevTools connection failed: ${e.message ?? e.type}`))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      const w = msg.id && this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      if (msg.error) w.reject(new Error(msg.error.message))
      else w.resolve(msg.result)
    }
  }

  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }

  close() {
    try { this.ws.close() } catch (_) { /* gone */ }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function panelTarget(port, app, deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (app.exitCode !== null) throw new Error('the app exited at once. Is SpawnLoft already running? Close it (it allows one copy) and try again.')
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/(?:$|[?#])/.test(t.url))
      if (page) return page
    } catch (_) { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('no panel page showed up over DevTools within the time allowed')
}

// ------------------------------------------------------------------ bench root -------------

// Same rules as the other scripts (lib.mjs refuseRoot): empty, missing or marked, and never a real
// SpawnLoft location. The app gets its settings from inside the root too, with dataRoot saved, or
// it opens its first-run setup instead of the panel (desktop/main.js needsSetup ignores
// MCCTL_DATA_ROOT).
async function benchRoot(values) {
  const lib = await import('./lib.mjs')
  const dir = values['data-root']
  if (!dir) throw new Error('--data-root is required (an empty folder, or one made by tools/perf)')
  const abs = path.resolve(dir)
  lib.refuseOutInside(values, abs)
  lib.prepareRoot(abs)
  fs.writeFileSync(path.join(abs, 'config', 'mcctl', 'settings.json'), JSON.stringify({ dataRoot: abs }, null, 2))
  const name = 'console-bench'
  const inst = path.join(abs, 'instances', name)
  fs.mkdirSync(inst, { recursive: true })
  fs.writeFileSync(path.join(inst, 'server.jar'), '')
  fs.writeFileSync(path.join(inst, 'server.properties'), 'server-port=25999\n')
  fs.writeFileSync(path.join(abs, 'instances.json'), JSON.stringify({
    version: 1,
    instances: { [name]: { dir: inst, jar: 'server.jar', java: 'java', memory: '1G', loader: 'paper', port: 25999, rcon: { port: 26999, password: 'perf' }, createdAt: new Date().toISOString() } },
  }, null, 2))
  return { root: abs, name }
}

function appCommand(values, port, extra = {}) {
  const flag = `--remote-debugging-port=${port}`
  if (values.browser) {
    return {
      cmd: path.resolve(values.browser),
      args: ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu', `--user-data-dir=${extra.profile}`, flag, extra.url],
      cwd: undefined,
    }
  }
  if (values.checkout) {
    const desktop = path.join(REPO, 'desktop')
    let electron
    try { electron = require(path.join(desktop, 'node_modules', 'electron')) } catch (_) {
      throw new Error('desktop/node_modules has no electron: run npm ci in desktop/ first, or pass --app')
    }
    return { cmd: electron, args: ['.', '--core', '..', flag, `--user-data-dir=${extra.profile}`], cwd: desktop }
  }
  if (!values.app) throw new Error(`pass --app <path>, --checkout or --browser <path>\n\n${USAGE}`)
  // its own Electron profile, so the bench does not rewrite the real app's window size, zoom or
  // update channel (on macOS those live in userData whatever APPDATA/XDG say)
  return { cmd: path.resolve(values.app), args: [flag, `--user-data-dir=${extra.profile}`], cwd: undefined }
}

// ------------------------------------------------------------------ results ----------------

function rowsFrom(out, o) {
  const rows = []
  for (const key of ['unfiltered', 'filtered']) {
    const r = out[key]
    if (!r) continue
    const tag = key === 'filtered' ? `filter "${r.filter}"` : 'no filter'
    rows.push({ id: `${key}-ms-per-1000`, label: `pushLine time per 1,000 lines, ${tag} (${o.warm} held)`, unit: 'ms', median: round(r.msPer1000), p90: null, n: o.timed })
    rows.push({ id: `${key}-longest-pushline`, label: `longest single pushLine or frame flush, ${tag}`, unit: 'ms', median: round(r.longestPushLineMs), p90: null })
    rows.push({ id: `${key}-longest-batch`, label: `longest batch of ${o.batch}, ${tag}`, unit: 'ms', median: round(r.longestBatchMs), p90: null })
    rows.push({ id: `${key}-long-tasks`, label: `long tasks (> 50 ms), ${tag}`, unit: 'count', median: r.longTasks, p90: null, max: round(r.longestTaskMs) })
  }
  return rows
}

function round(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10
}

function gitHead() {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return (r.stdout || '').trim() || null
}

function writeDoc(values, rows, extra) {
  const env = {
    machine: values.machine ?? os.hostname(),
    commit: values.commit ?? gitHead(),
    cliVersion: null,
    app: values.app ?? (values.checkout ? 'checkout' : values.browser ? `browser: ${values.browser}` : null),
    benchNode: process.version,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    cpu: { model: os.cpus()[0]?.model ?? null, count: os.cpus().length },
    ramBytes: os.totalmem(),
    note: values.note ?? null,
    selfTest: Boolean(values['self-test']),
  }
  const doc = { tool: 'spawnloft-perf', format: 1, metric: 'console-bench', takenAt: new Date().toISOString(), environment: env, results: rows, ...extra }
  const dir = path.resolve(values.out ?? 'perf-results')
  fs.mkdirSync(dir, { recursive: true })
  const slug = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  const file = path.join(dir, `perf-console-bench-${slug(env.machine)}-${slug(env.commit)}-${new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z')}.json`)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  const table = ['| case | value |', '| --- | --- |', ...rows.map((r) => `| ${r.label} | ${r.median ?? '-'}${r.unit === 'ms' ? ' ms' : ''} |`)].join('\n')
  process.stdout.write(`\n${table}\n\nWrote ${file}\n`)
  return { file, doc }
}

// ------------------------------------------------------------------ self-test --------------

// Runs pageBench in a vm context with a stub of the panel page: checks the contract it relies on
// (which page functions it calls, in what order, how many lines) and the shape of its result.
async function selfTest(values) {
  const calls = []
  const stub = {
    state: { lines: [], search: '', paused: true },
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    setTimeout,
    document: { querySelectorAll: () => ({ length: 7 }) },
    select: (n) => calls.push(`select:${n}`),
    stopStream: () => calls.push('stopStream'),
    showPane: (p) => calls.push(`showPane:${p}`),
    clearLines: () => { stub.state.lines = [] },
    renderLog: () => {},
    pushLine: (t) => {
      if (typeof t !== 'string' || !t) throw new Error('pushLine got a non-line')
      stub.state.lines.push(t)
      if (stub.state.lines.length > 5000) stub.state.lines.shift()
    },
  }
  stub.globalThis = stub
  vm.createContext(stub)
  vm.runInContext(PAGE_SOURCE, stub)
  const o = { name: 'x', warm: 300, timed: 120, batch: 50, filters: ['', 'WARN'] }
  const out = await vm.runInContext(`pageBench(${JSON.stringify(o)})`, stub)
  const fail = (m) => { throw new Error(`self-test: ${m}`) }
  if (!out.unfiltered || !out.filtered) fail('both passes ran')
  for (const k of ['unfiltered', 'filtered']) {
    const r = out[k]
    for (const f of ['msPer1000', 'wallMs', 'longestPushLineMs', 'longestBatchMs', 'longTasks', 'linesHeld', 'nodesInLog']) {
      if (!Number.isFinite(r[f])) fail(`${k}.${f} is a number`)
    }
    if (r.linesHeld !== o.warm + o.timed) fail(`${k} fed warm + timed lines (held ${r.linesHeld})`)
  }
  if (out.filtered.filter !== 'WARN') fail('the filtered pass used the filter')
  if (calls.filter((c) => c === 'select:x').length !== 2 || !calls.includes('showPane:console')) fail(`page calls: ${calls.join(', ')}`)
  const lines = makeLines(5000)
  if (lines.length !== 5000 || !lines.some((l) => l.includes('WARN]')) || !lines.some((l) => l.startsWith('\tat '))) fail('line mix has WARN lines and stack traces')
  if (makeLines(50).join() !== makeLines(50).join()) fail('lines are deterministic')
  const rows = rowsFrom(out, o)
  if (rows.length !== 8 || new Set(rows.map((r) => r.id)).size !== 8) fail('eight result rows with unique ids')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-perf-console-'))
  try {
    const { doc } = writeDoc({ ...values, out: outDir }, rows, { settings: o, raw: out })
    if (doc.metric !== 'console-bench' || doc.results.length !== 8) fail('result file shape')
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  process.stdout.write('console-bench self-test passed (stub page; the DevTools path is run by hand against the app)\n')
}

// ------------------------------------------------------------------ main -------------------

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      app: { type: 'string' }, checkout: { type: 'boolean', default: false }, browser: { type: 'string' }, 'data-root': { type: 'string' },
      lines: { type: 'string' }, timed: { type: 'string' }, batch: { type: 'string' }, filter: { type: 'string' }, timeout: { type: 'string' },
      machine: { type: 'string' }, commit: { type: 'string' }, note: { type: 'string' }, out: { type: 'string' },
      'self-test': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  if (values['self-test']) { await selfTest(values); return 0 }
  if (typeof WebSocket !== 'function') throw new Error(`this needs Node 22 or later for its built-in WebSocket (this is ${process.version})`)

  const o = {
    warm: Number(values.lines ?? 5000), timed: Number(values.timed ?? 2000), batch: Number(values.batch ?? 50),
    filters: ['', values.filter ?? 'WARN'],
  }
  const { root, name } = await benchRoot(values)
  o.name = name
  const port = await freePort()
  const env = { ...process.env, MCCTL_DATA_ROOT: root, XDG_CONFIG_HOME: path.join(root, 'config'), SPAWNLOFT_HARNESS_INDEX_FETCH: 'off' }
  delete env.ELECTRON_RUN_AS_NODE
  if (process.platform === 'win32') env.APPDATA = path.join(root, 'config')
  let panel = null
  const extra = { profile: path.join(root, 'app-profile') }
  if (values.browser) {
    panel = await startCheckoutPanel(env)
    extra.url = panel.url
  }
  const { cmd, args, cwd } = appCommand(values, port, extra)
  const app = spawn(cmd, args, { cwd, env, stdio: 'ignore' })
  let cdp = null
  try {
    const target = await panelTarget(port, app, 60000)
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    // wait until the page has its server list (the first 4 s poll) and the console functions
    const end = Date.now() + 30000
    let ok = false
    while (Date.now() < end && !ok) {
      ok = await cdp.evaluate(`typeof pushLine === 'function' && typeof rowOf === 'function' && !!rowOf(${JSON.stringify(name)})`).catch(() => false)
      if (!ok) await sleep(250)
    }
    if (!ok) throw new Error('the panel page never listed the bench server; is --data-root reaching the app?')
    await cdp.evaluate(PAGE_SOURCE + '\n;true')
    process.stdout.write(`Feeding ${o.warm} lines, then timing ${o.timed}, without and with the filter "${o.filters[1]}"...\n`)
    const limitMs = Number(values.timeout ?? 30) * 60000
    let timer = null
    const out = await Promise.race([
      cdp.evaluate(`pageBench(${JSON.stringify(o)})`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`gave up after ${values.timeout ?? 30} minutes; try fewer --lines`)), limitMs) }),
    ]).finally(() => clearTimeout(timer))
    writeDoc(values, rowsFrom(out, o), { settings: o, raw: out })
    return 0
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {})
      cdp.close()
    }
    await sleep(1500)
    for (const child of [app, panel?.child]) {
      if (!child || child.exitCode !== null) continue
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill()
    }
  }
}

// `node mcctl.mjs ui` from this checkout, for --browser
function startCheckoutPanel(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'mcctl.mjs'), 'ui', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the panel did not start:\n${out}`)) }, 30000)
    child.stdout.on('data', (d) => {
      out += d
      const m = /SpawnLoft panel: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }) }
    })
    child.stderr.on('data', (d) => { out += d })
  })
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
