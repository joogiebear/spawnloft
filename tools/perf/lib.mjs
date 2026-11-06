// Shared pieces of the measurement scripts in tools/perf (see README.md there). Nothing here is
// part of the shipped core: tools/ is outside the desktop package's file list.
//
// Every script runs the CLI as a separate process, the way a user does, so the same script
// measures a source checkout (`node mcctl.mjs`) and an installed package (`spawnloft.cmd`, or the
// CLI package's bundled Node). They only ever touch a bench data root: a folder this file created
// and marked, never the data root someone's real servers live in.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
export const FAKE_JAVA = path.join(REPO, 'test', 'fixtures', 'fake-java.mjs')
export const MARKER = '.spawnloft-perf-bench'
export const IS_WIN = process.platform === 'win32'

// ------------------------------------------------------------------ arguments --------------

// Options every script takes. Per-script options are merged in by the caller.
export const COMMON_OPTIONS = {
  'self-test': { type: 'boolean', default: false },
  'data-root': { type: 'string' },
  cli: { type: 'string' },
  runtime: { type: 'string' },
  electron: { type: 'boolean', default: false },
  machine: { type: 'string' },
  commit: { type: 'string' },
  disk: { type: 'string' },
  note: { type: 'string' },
  out: { type: 'string' },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
}

export function parseCli(argv, options, usage) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true, strict: true })
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage}\n`)
    process.exit(2)
  }
  if (parsed.values.help) {
    process.stdout.write(`${usage}\n`)
    process.exit(0)
  }
  return parsed
}

export const COMMON_USAGE = `Common options:
  --data-root <dir>   bench data root (or MCCTL_DATA_ROOT). Must be empty, missing, or made by
                      these scripts; a real data root is refused.
  --cli <path>        the CLI to measure: mcctl.mjs/spawnloft.mjs of a checkout or package
                      (run with --runtime, default this Node), spawnloft.cmd (Windows shim), or
                      the spawnloft executable. Default: this checkout's mcctl.mjs.
  --runtime <path>    the Node (or Electron binary) that runs a .mjs --cli
  --electron          the runtime is Electron: run it with ELECTRON_RUN_AS_NODE=1
  --machine <label>   name in the output file (default: this host's name)
  --commit <sha>      commit or beta version under test (default: git HEAD of this checkout)
  --disk <text>       disk type, recorded in the environment block (e.g. "NVMe SSD")
  --note <text>       free text recorded with the run (e.g. "Defender on")
  --out <dir>         where the JSON goes (default ./perf-results)
  --keep              leave the bench data root in place afterwards
  --self-test         run against a throwaway 0-server fixture and check the output shape`

export function intList(text, fallback) {
  if (text == null || text === '') return fallback
  return String(text).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
}

// ------------------------------------------------------------------ statistics -------------

// Nearest-rank percentile on a sorted copy. Empty input gives null so a missing case is visible.
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const rank = Math.ceil((p / 100) * v.length)
  return v[Math.min(v.length, Math.max(1, rank)) - 1]
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return { n: 0, min: null, median: null, p90: null, p95: null, max: null, mean: null }
  const sum = v.reduce((a, b) => a + b, 0)
  return {
    n: v.length,
    min: round(Math.min(...v)),
    median: round(percentile(v, 50)),
    p90: round(percentile(v, 90)),
    p95: round(percentile(v, 95)),
    max: round(Math.max(...v)),
    mean: round(sum / v.length),
  }
}

export function round(n, places = 1) {
  if (n == null || !Number.isFinite(n)) return null
  const f = 10 ** places
  return Math.round(n * f) / f
}

export const nowMs = () => Number(process.hrtime.bigint()) / 1e6

// ------------------------------------------------------------------ bench data root --------

// Where the core would put its data with no settings, mirroring settings.mjs defaultDataRoot().
export function defaultDataRoot(env = process.env) {
  const base = IS_WIN
    ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'mcctl')
}

// The user's real settings file, mirroring settings.mjs settingsFile().
function realSettingsFile(env = process.env) {
  const base = IS_WIN
    ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'mcctl', 'settings.json')
}

function sameDir(a, b) {
  const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(a) === norm(b)
}

// Returns the reason a folder may not be used as a bench root, or null if it may. A bench root is
// a folder that is missing, empty, or carries the marker these scripts write; anything else might
// hold someone's servers. The default and configured data roots and the checkout are refused even
// if someone put a marker in them.
export function refuseRoot(dir, env = process.env) {
  if (!dir) return 'no bench data root given: pass --data-root <empty folder> or set MCCTL_DATA_ROOT'
  const abs = path.resolve(dir)
  const forbidden = [defaultDataRoot(env), REPO, os.homedir(), path.parse(abs).root]
  try {
    const real = JSON.parse(fs.readFileSync(realSettingsFile(env), 'utf8'))
    if (real?.dataRoot) forbidden.push(real.dataRoot)
    if (real?.instancesDir) forbidden.push(real.instancesDir)
    if (real?.backupsDir) forbidden.push(real.backupsDir)
  } catch {
    /* no settings file: nothing more to refuse */
  }
  for (const f of forbidden) {
    if (sameDir(abs, f)) return `${abs} is a real SpawnLoft location (or the checkout/home); use an empty folder for the bench`
  }
  if (!fs.existsSync(abs)) return null
  if (!fs.statSync(abs).isDirectory()) return `${abs} is not a folder`
  if (fs.existsSync(path.join(abs, MARKER))) return null
  if (fs.readdirSync(abs).length === 0) return null
  return `${abs} is not empty and was not made by tools/perf (no ${MARKER} file); refusing in case it holds real servers`
}

export function prepareRoot(dir, env = process.env) {
  const why = refuseRoot(dir, env)
  if (why) throw new Error(why)
  const abs = path.resolve(dir)
  fs.mkdirSync(abs, { recursive: true })
  fs.writeFileSync(path.join(abs, MARKER), 'Made by tools/perf. Safe to delete.\n')
  fs.mkdirSync(path.join(abs, 'config', 'mcctl'), { recursive: true })
  return abs
}

// The bench root from flags, or a fresh temp folder for a self-test.
const tempRoots = new Set()
export function benchRootFrom(values, label) {
  if (values['self-test'] && !values['data-root']) {
    const dir = prepareRoot(fs.mkdtempSync(path.join(os.tmpdir(), `spawnloft-perf-${label}-`)))
    tempRoots.add(dir)
    return dir
  }
  const dir = path.resolve(values['data-root'] ?? process.env.MCCTL_DATA_ROOT ?? '')
  if (values['data-root'] || process.env.MCCTL_DATA_ROOT) refuseOutInside(values, dir)
  return prepareRoot(values['data-root'] ?? process.env.MCCTL_DATA_ROOT)
}

// Empties a bench root (only one carrying the marker). A folder someone named with --data-root
// is kept, empty; a self-test's temp folder goes entirely.
// The marker goes last, so a delete that fails half way (a file still held open on Windows) leaves
// a root the next run still accepts. A failure is reported, never thrown: it must not hide the
// error that ended the run.
export function removeRoot(root) {
  if (!fs.existsSync(path.join(root, MARKER))) return
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  try {
    for (const e of fs.readdirSync(root)) if (e !== MARKER) rm(path.join(root, e))
    if (tempRoots.has(root)) rm(root)
    else rm(path.join(root, MARKER))
  } catch (err) {
    process.stderr.write(`could not empty the bench root ${root}: ${err.message}\n`)
  }
}

// --out inside the bench root would be emptied with it at the end.
export function refuseOutInside(values, root) {
  if (values.keep) return
  const out = path.resolve(values.out ?? 'perf-results')
  if (out === root || out.startsWith(root + path.sep)) {
    throw new Error(`the results folder ${out} is inside the bench root, which is emptied at the end; pass --out <folder elsewhere> or --keep`)
  }
}

// Environment for every CLI/panel process: data root and settings both inside the bench root, so
// neither the user's registry nor their settings (a backups folder elsewhere, a mirror) is read.
export function benchEnv(root, extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.MCCTL_DATA_ROOT = root
  env.XDG_CONFIG_HOME = path.join(root, 'config')
  if (IS_WIN) env.APPDATA = path.join(root, 'config')
  env.SPAWNLOFT_HARNESS_INDEX_FETCH = 'off'
  return { ...env, ...extra }
}

export function writeBenchSettings(root, settings) {
  const file = path.join(root, 'config', 'mcctl', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

// ------------------------------------------------------------------ fixtures ---------------

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Writes servers straight into the bench registry rather than through `spawnloft new`, which
// would download a jar. `java` defaults to the test suite's fake JVM: the daemon runs a .mjs java
// with its own Node, so "running" servers cost nothing and print a ready line at once.
export async function writeFixture(root, { servers = 0, prefix = 'perf', java = FAKE_JAVA, jar = null, externalDb = false, dbTools = null } = {}) {
  const instances = {}
  const names = []
  const instDir = path.join(root, 'instances')
  fs.mkdirSync(instDir, { recursive: true })
  for (let i = 0; i < servers; i++) {
    // unique per run: Windows control pipes are keyed by name, and a leftover daemon must not answer
    const name = `${prefix}-${process.pid}-${i}`
    const dir = path.join(instDir, name)
    fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
    const port = await freePort()
    const rconPort = await freePort()
    const jarName = jar ? path.basename(jar) : 'server.jar'
    if (jar) fs.copyFileSync(jar, path.join(dir, jarName))
    else fs.writeFileSync(path.join(dir, jarName), '')
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
    fs.writeFileSync(path.join(dir, 'server.properties'),
      `server-port=${port}\nmotd=perf bench ${i}\nmax-players=20\nenable-rcon=true\nrcon.port=${rconPort}\nrcon.password=perf\nlevel-name=world\n`)
    // A placeholder level.dat is enough for the fake JVM; a real server jar must make its own world,
    // because Paper refuses to start on an unreadable level.dat.
    if (!jar) fs.writeFileSync(path.join(dir, 'world', 'level.dat'), Buffer.alloc(1024))
    instances[name] = {
      dir,
      jar: jarName,
      java,
      memory: '1G',
      loader: 'paper',
      port,
      rcon: { port: rconPort, password: 'perf' },
      createdAt: new Date().toISOString(),
    }
    names.push(name)
  }
  let db = null
  if (externalDb) {
    // An external MySQL on an address nothing answers (10.255.255.1 is unroutable on most
    // networks): the case where every database poll waits out its timeouts.
    db = `${prefix}-db-${process.pid}`
    instances[db] = {
      kind: 'database',
      engine: 'mysql',
      external: true,
      host: '10.255.255.1',
      port: 3306,
      root: { user: 'root', password: '' },
      attachments: {},
      createdAt: new Date().toISOString(),
      // without client tools the probe fails at once ("no client tools found") and never meets
      // the dead host; Windows and macOS find XAMPP/Program Files/Homebrew installs themselves
      ...(dbTools ? { tools: { dir: path.resolve(dbTools) } } : {}),
    }
  }
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ version: 1, instances }, null, 2))
  return { names, db }
}

// Fills <dir> with `count` small region-named files, flat, as a big world's region folder is:
// the Files tool lists one level, so this is what a listing of world/region has to walk.
export function fillFiles(dir, count, { size = 256 } = {}) {
  const buf = Buffer.alloc(size, 7)
  fs.mkdirSync(dir, { recursive: true })
  const side = Math.ceil(Math.sqrt(count))
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `r.${(i % side) - (side >> 1)}.${Math.floor(i / side) - (side >> 1)}.mca`), buf)
}

export function copyDir(src, dest, { skip = () => false } = {}) {
  fs.cpSync(src, dest, { recursive: true, filter: (s) => !skip(s), errorOnExist: false, force: true })
}

// Bytes and file count of a tree, plus how much of it is region files (.mca).
export function treeSize(dir) {
  let bytes = 0
  let files = 0
  let mca = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const s = fs.statSync(p).size
        bytes += s
        files++
        if (e.name.endsWith('.mca')) mca += s
      }
    }
  }
  walk(dir)
  return { bytes, files, mcaBytes: mca, mcaShare: bytes ? round(mca / bytes, 3) : 0 }
}

// ------------------------------------------------------------------ running the CLI --------

// How to start the CLI under test: { cmd, pre, env, shell } where args go after `pre`.
export function cliSpec(values) {
  const cli = values.cli ? path.resolve(values.cli) : path.join(REPO, 'mcctl.mjs')
  const runtime = values.runtime ? path.resolve(values.runtime) : process.execPath
  const electron = Boolean(values.electron)
  const runtimeEnv = electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  if (/\.(cmd|bat)$/i.test(cli)) {
    // The Windows shim users have on PATH. Run it through cmd.exe as a terminal would; the shim
    // sets ELECTRON_RUN_AS_NODE itself.
    return { cli, cmd: process.env.ComSpec || 'cmd.exe', pre: [], shim: cli, env: {}, label: 'cmd-shim', runtime: values.runtime ? runtime : null, runtimeEnv }
  }
  if (/\.m?js$/i.test(cli)) return { cli, cmd: runtime, pre: [cli], env: runtimeEnv, label: electron ? 'electron-as-node' : 'node', runtime, runtimeEnv }
  return { cli, cmd: cli, pre: [], env: {}, label: 'executable', runtime: values.runtime ? runtime : null, runtimeEnv }
}

// Bare-runtime floor: the same runtime doing nothing, so CLI numbers can be read as a multiple.
export function floorSpec(spec) {
  if (!spec.runtime) return null
  return { cmd: spec.runtime, args: ['-e', '0'], env: spec.runtimeEnv }
}

// [cmd, args, spawn options] for the CLI under test. The .cmd shim goes through cmd.exe with one
// quoted command line, as `shell: true` would build it, so a path with spaces survives.
export function invocation(spec, args) {
  if (spec.shim) {
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
    return [spec.cmd, ['/d', '/s', '/c', `"${[spec.shim, ...args].map(q).join(' ')}"`], { windowsVerbatimArguments: true }]
  }
  return [spec.cmd, [...spec.pre, ...args], {}]
}

// Runs a process to its end and times it from spawn to close. stdin is closed at once (EOF).
export function runTimed(cmd, args, { env, cwd, timeoutMs = 120000, input = '', spawnOpts = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = nowMs()
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...spawnOpts })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ms: nowMs() - t0, code: -1, stdout, stderr: String(err.message), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ms: nowMs() - t0, code, stdout, stderr, timedOut: code === null })
    })
  })
}

// Ends a child and what runs under it: through the .cmd shim the child is cmd.exe, and killing it
// alone leaves the runtime running.
export function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill()
}

export function runCli(spec, args, env, opts = {}) {
  const [cmd, argv, spawnOpts] = invocation(spec, args)
  return runTimed(cmd, argv, { ...opts, spawnOpts, env: { ...env, ...spec.env } })
}

// Starts the panel (`ui --port 0 --no-open`) as a child, resolves once it prints its URL.
export function startPanel(spec, env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = nowMs()
    const [cmd, argv, spawnOpts] = invocation(spec, ['ui', '--port', '0', '--no-open'])
    const child = spawn(cmd, argv, {
      env: { ...env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...spawnOpts,
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`the panel did not print its address within ${timeoutMs} ms:\n${out}`))
    }, timeoutMs)
    const onData = (d) => {
      out += d
      const m = /SpawnLoft panel: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)
      if (m) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stdout.resume()
        resolve({ child, url: m[1], startMs: nowMs() - t0 })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the panel exited (${code}) before it was listening:\n${out}`))
    })
  })
}

export async function stopPanel(panel) {
  if (!panel?.child || panel.child.exitCode !== null) return
  await new Promise((resolve) => {
    panel.child.once('exit', resolve)
    killTree(panel.child)
    setTimeout(resolve, 5000).unref()
  })
}

// One timed request: wall time to the full body.
export async function timedFetch(url, { timeoutMs = 90000, method = 'GET', body } = {}) {
  const t0 = nowMs()
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { ms: nowMs() - t0, status: res.status, bytes: Buffer.byteLength(text), text }
  } catch (err) {
    return { ms: nowMs() - t0, status: 0, error: err.name === 'TimeoutError' ? 'timeout' : String(err.message) }
  }
}

// Stall lines the panel's event-loop watcher wrote (src/ui.mjs, threshold SPAWNLOFT_PERF_LOG_MS).
export function panelStalls(root, { sinceMs = 0 } = {}) {
  let text = ''
  try { text = fs.readFileSync(path.join(root, 'run', 'panel.log'), 'utf8') } catch { /* none */ }
  const stalls = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([^\]]+)\] event loop held for (\d+)ms/.exec(line)
    if (m && Date.parse(m[1]) >= sinceMs) stalls.push(Number(m[2]))
  }
  return { count: stalls.length, max: stalls.length ? Math.max(...stalls) : 0, over250: stalls.filter((s) => s >= 250).length, values: stalls }
}

// ------------------------------------------------------------------ processes --------------

// One snapshot of the process table: Map pid -> { pid, ppid, name, rss, private, pss, cpuMs }.
// Bytes for memory; private/pss are null where the OS gives no cheap reading (macOS).
export function processTable({ detailPids = null } = {}) {
  if (process.platform === 'linux') return linuxTable(detailPids)
  if (IS_WIN) return windowsTable()
  return psTable()
}

let clkTck = null
let pageSize = null
function getconf(name, fallback) {
  try { return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || fallback } catch { return fallback }
}
function linuxTable(detailPids) {
  if (clkTck == null) clkTck = getconf('CLK_TCK', 100)
  if (pageSize == null) pageSize = getconf('PAGESIZE', 4096)
  const page = pageSize
  const table = new Map()
  for (const ent of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(ent)) continue
    try {
      const stat = fs.readFileSync(`/proc/${ent}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const name = stat.slice(stat.indexOf('(') + 1, close)
      const f = stat.slice(close + 2).split(' ')
      // fields after the name: state(0) ppid(1) ... utime(11) stime(12) ... rss(21)
      const row = { pid: Number(ent), ppid: Number(f[1]), name, rss: Number(f[21]) * page, private: null, pss: null, cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / clkTck }
      if (!detailPids || detailPids.has(row.pid)) {
        try {
          const roll = fs.readFileSync(`/proc/${ent}/smaps_rollup`, 'utf8')
          const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(roll)?.[1] ?? NaN) * 1024
          row.pss = kb('Pss')
          row.private = kb('Private_Clean') + kb('Private_Dirty')
        } catch { /* kernel without smaps_rollup, or the process left */ }
      }
      table.set(row.pid, row)
    } catch { /* exited while we read */ }
  }
  return table
}

// One PowerShell call per snapshot: a few hundred ms, so callers poll no faster than once a second.
const WIN_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.PrivatePageCount),$($_.KernelModeTime),$($_.UserModeTime),$($_.Name)" }'
const WIN_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT]
const WIN_OPTS = { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }

function windowsTable() {
  return parseWindowsTable(execFileSync('powershell', WIN_ARGS, WIN_OPTS))
}

// The same snapshot without blocking this process's event loop, for samplers that run while
// this process is also timing requests.
export function processTableAsync() {
  if (process.platform === 'linux') return Promise.resolve(processTable({ detailPids: new Set() }))
  return new Promise((resolve, reject) => {
    if (IS_WIN) execFile('powershell', WIN_ARGS, WIN_OPTS, (err, out) => (err ? reject(err) : resolve(parseWindowsTable(out))))
    else execFile('ps', PS_ARGS, PS_OPTS, (err, out) => (err ? reject(err) : resolve(parsePsTable(out))))
  })
}

// CPU this process has collected from children it waited for, which on Linux includes their own
// waited-for children: the exact CPU of a whole finished tree, where sampling misses the tail.
export function reapedChildCpuMs() {
  if (process.platform !== 'linux') return null
  if (clkTck == null) clkTck = getconf('CLK_TCK', 100)
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // after the name: cutime(13) cstime(14)
    return ((Number(f[13]) + Number(f[14])) * 1000) / clkTck
  } catch {
    return null
  }
}

function parseWindowsTable(out) {
  const table = new Map()
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d*),(\d*),(\d*),(\d*),(.*)$/.exec(line.trim())
    if (!m) continue
    // PrivatePageCount is bytes despite its name (the same figure as PrivateMemorySize64);
    // Kernel/UserModeTime are 100 ns units
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: m[7], rss: Number(m[3]) || 0, private: Number(m[4]) || null, pss: null, cpuMs: ((Number(m[5]) || 0) + (Number(m[6]) || 0)) / 1e4 })
  }
  return table
}

const PS_ARGS = ['-axo', 'pid=,ppid=,rss=,time=,comm=']
const PS_OPTS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
function psTable() {
  return parsePsTable(execFileSync('ps', PS_ARGS, PS_OPTS))
}

function parsePsTable(out) {
  const table = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[5]), rss: Number(m[3]) * 1024, private: null, pss: null, cpuMs: psTimeMs(m[4]) })
  }
  return table
}

// ps cputime: [[dd-]hh:]mm:ss[.ff]
export function psTimeMs(t) {
  let days = 0
  let rest = t
  if (rest.includes('-')) [days, rest] = [Number(rest.split('-')[0]), rest.split('-')[1]]
  const parts = rest.split(':').map(Number)
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return (days * 86400 + secs) * 1000
}

export function descendants(table, rootPid) {
  const kids = new Map()
  for (const row of table.values()) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, [])
    kids.get(row.ppid).push(row)
  }
  const found = []
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length) {
    const pid = queue.shift()
    for (const k of kids.get(pid) ?? []) {
      if (seen.has(k.pid) || k.pid === rootPid) continue
      seen.add(k.pid)
      found.push(k)
      queue.push(k.pid)
    }
  }
  return found
}

// Samples a process tree until stopped. Keeps each pid's last-seen CPU time and peak memory, so a
// child that exits between samples still counts what it used up to its last sample.
export function treeSampler(rootPid, { intervalMs = IS_WIN ? 1000 : 200 } = {}) {
  const seen = new Map()
  let stopped = false
  let timer = null
  const take = async () => {
    try {
      const table = await processTableAsync()
      const root = table.get(rootPid)
      const rows = [...(root ? [root] : []), ...descendants(table, rootPid)]
      for (const r of rows) {
        const prev = seen.get(r.pid)
        seen.set(r.pid, { name: r.name, cpuMs: Math.max(prev?.cpuMs ?? 0, r.cpuMs), peakRss: Math.max(prev?.peakRss ?? 0, r.rss) })
      }
    } catch { /* a failed snapshot only loses one sample */ }
  }
  const loop = async () => {
    if (stopped) return
    await take()
    if (!stopped) timer = setTimeout(loop, intervalMs)
  }
  loop()
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      return [...seen.entries()].map(([pid, v]) => ({ pid, ...v, cpuMs: round(v.cpuMs) }))
    },
  }
}

// The process that does the work under a launcher: with the .cmd shim the spawned pid is cmd.exe
// and the panel is its child. Picks the largest descendant by memory, or the pid itself.
export function workerPid(pid) {
  const table = processTable({ detailPids: new Set() })
  const rows = [table.get(pid), ...descendants(table, pid)].filter(Boolean).filter((r) => !/^(cmd|conhost)(\.exe)?$/i.test(r.name))
  if (!rows.length) return pid
  return rows.sort((a, b) => b.rss - a.rss)[0].pid
}

// ------------------------------------------------------------------ environment & output ---

function gitHead() {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function cliVersion(spec) {
  try {
    const dir = path.dirname(spec.cli)
    for (const p of [path.join(dir, 'package.json'), path.join(dir, '..', 'core', 'package.json'), path.join(dir, 'resources', 'core', 'package.json')]) {
      if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
        if (v) return v
      }
    }
  } catch { /* unknown */ }
  return null
}

function runtimeVersions(spec) {
  if (!spec.runtime) return null
  const r = spawnSync(spec.runtime, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron??null})'], { env: { ...process.env, ...spec.runtimeEnv }, encoding: 'utf8', windowsHide: true })
  try { return JSON.parse(r.stdout.trim()) } catch { return null }
}

function defenderOn() {
  if (!IS_WIN) return null
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpComputerStatus).RealTimeProtectionEnabled'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const t = (r.stdout ?? '').trim()
  return t === 'True' ? true : t === 'False' ? false : null
}

export function environment(values, spec) {
  const cpus = os.cpus()
  return {
    machine: values.machine ?? os.hostname(),
    commit: values.commit ?? gitHead(),
    cliVersion: spec ? cliVersion(spec) : null,
    cli: spec ? { path: spec.cli, how: spec.label, runtime: runtimeVersions(spec) } : null,
    benchNode: process.version,
    os: { platform: process.platform, release: os.release(), version: os.version?.() ?? null, arch: process.arch },
    cpu: { model: cpus[0]?.model ?? null, count: cpus.length },
    ramBytes: os.totalmem(),
    disk: values.disk ?? null,
    defenderRealTime: values['self-test'] ? null : defenderOn(),
    note: values.note ?? null,
    selfTest: Boolean(values['self-test']),
  }
}

function slug(s) {
  return String(s ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
}

// Writes perf-<metric>-<machine>-<commit>-<date>.json and prints the Markdown table.
// `results` rows: { id, label, unit, median, p90, ...anything else }.
export function writeResult(metric, env, results, extra = {}, { outDir } = {}) {
  const date = new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z')
  const doc = { tool: 'spawnloft-perf', format: 1, metric, takenAt: new Date().toISOString(), environment: env, results, ...extra }
  const dir = path.resolve(outDir ?? 'perf-results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `perf-${metric}-${slug(env.machine)}-${slug(env.commit)}-${date}.json`)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  process.stdout.write(`\n${resultsTable(results)}\n\nWrote ${file}\n`)
  return { file, doc }
}

export function fmt(v, unit) {
  if (v == null) return '-'
  if (unit === 'bytes') return humanBytes(v)
  if (unit === 'ms') return `${round(v)} ms`
  if (unit === 's') return `${round(v, 2)} s`
  if (unit === 'x') return `${round(v, 2)}x`
  return String(v)
}

export function humanBytes(n) {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${round(v, i ? 1 : 0)} ${units[i]}`
}

export function mdTable(rows) {
  if (!rows.length) return ''
  const head = rows[0]
  const line = (r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.slice(1).map(line)].join('\n')
}

export function resultsTable(results) {
  return mdTable([
    ['case', 'median', 'p90', 'n', 'notes'],
    ...results.map((r) => [r.label ?? r.id, fmt(r.median, r.unit), fmt(r.p90, r.unit), r.n ?? '', r.notes ?? '']),
  ])
}

// ------------------------------------------------------------------ self-test checks -------

export function check(cond, message) {
  if (!cond) throw new Error(`self-test: ${message}`)
}

// The shape every result file must have; compare.mjs relies on it.
export function checkDoc(doc, metric) {
  check(doc.tool === 'spawnloft-perf' && doc.format === 1, 'tool/format header')
  check(doc.metric === metric, `metric is ${metric}`)
  check(doc.environment && typeof doc.environment.machine === 'string', 'environment block')
  check(Array.isArray(doc.results) && doc.results.length > 0, 'results is a non-empty array')
  for (const r of doc.results) {
    check(typeof r.id === 'string' && r.id, 'every result has an id')
    check(['ms', 'bytes', 's', 'count', 'x', 'ratio'].includes(r.unit), `unit of ${r.id}`)
    check(r.median === null || Number.isFinite(r.median), `median of ${r.id} is a number or null`)
  }
  const ids = doc.results.map((r) => r.id)
  check(new Set(ids).size === ids.length, 'result ids are unique')
}

// Runs main(), turning a thrown error into a clear message and exit 1.
export function runMain(main) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`${err?.stack ?? err}\n`)
      process.exit(1)
    },
  )
}
