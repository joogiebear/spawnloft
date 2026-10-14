import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DATA_ROOT, consoleLog } from './paths.mjs'
import { getInstance, isDatabase } from './registry.mjs'
import * as sup from './supervisor.mjs'
import { readProps } from './props.mjs'
import { rconExec, stripColors } from './rcon.mjs'
import { mcVersionOf } from './plugins.mjs'
import { boundAddress } from './exposure.mjs'
import { fail, readJson } from './util.mjs'

/**
 * Scripted test players for plugin testing: `spawnloft bot ...` and the `bot_*` MCP tools.
 *
 * <p>A scenario is a JSON file naming a server, some bots and an ordered list of steps. The bots
 * join the server as offline-mode players (a name and nothing else), send chat and commands,
 * click in plugin GUIs, and the steps assert on what comes back: a message, an item, a window, the
 * bot's own state, or a line in the server console. The first failing step ends the run, and the
 * report says which one and what the bot had seen by then.
 *
 * <p>The core does the part that needs SpawnLoft - find the server, refuse one that is not safe to
 * join, run the setup commands over RCON, know where the console log is - and hands everything
 * else to {@link ./bot-host.cjs}, the one process that loads mineflayer. Keeping mineflayer out
 * of the core is what keeps the core dependency-free; see `ensureHost` for where it lives.
 */

export const HOST_DIR = path.join(DATA_ROOT, 'bot-host')
export const MINEFLAYER_SPEC = '^4.39.0'
const HOST_SCRIPT = fileURLToPath(new URL('./bot-host.cjs', import.meta.url))
export const MAX_BOTS = 5
const STEP_KEYS = ['chat', 'command', 'expectMessage', 'waitWindow', 'click', 'closeWindow', 'expectItem', 'expectState', 'expectLog', 'leave']
const BOT_NAME_RE = /^[A-Za-z0-9_]{3,16}$/
// What run_command refuses, refused here too: a scenario's setup runs as the server console.
const REFUSED_SETUP = new Set(['stop', 'restart', 'reload', 'rl'])

/** Where mineflayer is, or null when `spawnloft bot setup` has not run on this machine. */
export function hostInstall() {
  const pkg = path.join(HOST_DIR, 'node_modules', 'mineflayer', 'package.json')
  const meta = readJson(pkg)
  return meta ? { dir: HOST_DIR, version: meta.version } : null
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * Install mineflayer into the data root, once.
 *
 * <p>Through npm, because that is the only honest way to get a package with a hundred and seventy
 * transitive dependencies onto a machine: pinning and re-downloading them by hand is a package
 * manager written badly. npm comes with Node, which a source checkout already has. The desktop app
 * bundles a runtime without npm, so there this fails with the way out spelled out; a prebuilt
 * download for that case is a later step.
 *
 * <p>The install is around 500 MB, most of it game data for every Minecraft version there has
 * been. That is mineflayer's shape, not a choice made here.
 */
export function ensureHost({ onProgress = () => {}, force = false } = {}) {
  const have = hostInstall()
  if (have && !force) return have
  fs.mkdirSync(HOST_DIR, { recursive: true })
  fs.writeFileSync(path.join(HOST_DIR, 'package.json'), JSON.stringify({
    name: 'spawnloft-bot-host', private: true, description: 'mineflayer, for spawnloft bot',
    dependencies: { mineflayer: MINEFLAYER_SPEC },
  }, null, 2) + '\n')
  const npm = npmCommand()
  const probe = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (probe.error || probe.status !== 0) {
    fail([
      'npm was not found, and it is what installs mineflayer.',
      '  Install Node.js from https://nodejs.org (npm comes with it), open a new terminal, and run: spawnloft bot setup',
      `  The install goes into ${HOST_DIR} and is about 500 MB.`,
    ].join('\n'))
  }
  onProgress(`Installing mineflayer ${MINEFLAYER_SPEC} into ${HOST_DIR} with npm ${probe.stdout.trim()} (about 500 MB, a few minutes)`)
  const res = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
    cwd: HOST_DIR, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    fail(`npm install failed (exit ${res.status}) in ${HOST_DIR}:\n${(res.stderr || res.stdout || '').trim().split('\n').slice(-15).join('\n')}`)
  }
  const installed = hostInstall()
  if (!installed) fail(`npm install finished but mineflayer is not in ${HOST_DIR}/node_modules`)
  return installed
}

/**
 * Whether bots may join this server, and why not.
 *
 * <p>Offline mode is required, not optional: a bot has no account, and an online-mode server
 * would turn it away at the door. It is not switched on here either - it changes the server's
 * UUIDs for every player, which is the owner's call, made where the rest of server.properties is.
 *
 * <p>Binding to loopback is advised rather than required. SpawnLoft creates servers listening on
 * every interface, so requiring loopback would refuse every server made with it until a file was
 * edited by hand. The warning names the actual risk: an offline server reachable from the network
 * lets anyone on it join under any name.
 */
export function checkInstance(name) {
  const inst = getInstance(name)
  if (isDatabase(inst)) fail(`"${name}" is a database, not a Minecraft server`)
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const problems = []
  const warnings = []
  if (props.get('online-mode') !== 'false') {
    problems.push(`"${name}" runs in online mode, and bots have no account to log in with. Set online-mode=false in ${path.join(inst.dir, 'server.properties')} on a server kept for testing, then restart it.`)
  }
  if (!sup.isRunning(name)) problems.push(`"${name}" is not running. Start it first: spawnloft start ${name}`)
  const bound = boundAddress(inst.dir)
  if (!['127.0.0.1', 'localhost', '::1'].includes(bound)) {
    warnings.push(`"${name}" listens on every interface in offline mode, so anyone who can reach port ${inst.port} can join under any name. For a test server, set server-ip=127.0.0.1.`)
  }
  return { inst, ok: problems.length === 0, problems, warnings, version: mcVersionOf(inst) ?? null }
}

/** The scenario as a checked object, with the file's name as a fallback for its own. */
export function loadScenario(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (err) { fail(`cannot read scenario ${file}: ${err.message}`) }
  let data
  try { data = JSON.parse(raw) } catch (err) { fail(`${file} is not valid JSON: ${err.message}`) }
  return validateScenario(data, { name: path.basename(file, '.json') })
}

export function validateScenario(data, { name = null } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('a scenario is a JSON object')
  const scenario = { name: data.name ?? name ?? 'scenario', instance: data.instance ?? null, bots: data.bots, setup: data.setup ?? [], steps: data.steps }
  if (!Array.isArray(scenario.bots) || !scenario.bots.length) fail('"bots" must list at least one bot name')
  if (scenario.bots.length > MAX_BOTS) fail(`"bots" lists ${scenario.bots.length} bots; the limit is ${MAX_BOTS}`)
  for (const b of scenario.bots) {
    if (typeof b !== 'string' || !BOT_NAME_RE.test(b)) fail(`bot name ${JSON.stringify(b)} is not a Minecraft name (3 to 16 letters, digits or underscores)`)
  }
  if (new Set(scenario.bots.map((b) => b.toLowerCase())).size !== scenario.bots.length) fail('bot names must differ')
  if (!Array.isArray(scenario.setup) || scenario.setup.some((s) => typeof s !== 'string')) fail('"setup" must be a list of console commands')
  for (const cmd of scenario.setup) {
    const verb = cmd.trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '')
    if (REFUSED_SETUP.has(verb)) fail(`setup command "${verb}" would take the server down or half-reload it; a scenario cannot run it`)
  }
  if (!Array.isArray(scenario.steps) || !scenario.steps.length) fail('"steps" must list at least one step')
  scenario.steps.forEach((step, i) => {
    const where = `step ${i + 1}`
    if (!step || typeof step !== 'object') fail(`${where} is not an object`)
    const keys = Object.keys(step).filter((k) => STEP_KEYS.includes(k))
    if (keys.length !== 1) fail(`${where} must have exactly one of ${STEP_KEYS.join(', ')}; it has ${keys.length ? keys.join(', ') : 'none'}`)
    const [kind] = keys
    if (kind !== 'expectLog' && !scenario.bots.includes(step.bot)) fail(`${where} (${kind}) names bot ${JSON.stringify(step.bot ?? null)}, which is not in "bots"`)
    if (step.timeout !== undefined && !(Number.isInteger(step.timeout) && step.timeout > 0 && step.timeout <= 300000)) fail(`${where}: "timeout" is milliseconds, 1 to 300000`)
    if (kind === 'expectLog' && (typeof step.expectLog !== 'object' || (step.expectLog.present === undefined) === (step.expectLog.absent === undefined))) {
      fail(`${where}: expectLog takes {"present": pattern} or {"absent": pattern}`)
    }
    if (kind === 'click' && !Number.isInteger(step.click)) fail(`${where}: "click" is a slot number`)
  })
  return scenario
}

/**
 * Run one scenario end to end and return its report.
 *
 * <p>`instance` on the command line beats the file's, so one scenario file serves several test
 * servers. Setup runs first, as the console, and its replies are in the report: a setup command
 * that fails ("Unknown command") is the usual reason a later step times out, so it is in plain
 * view rather than swallowed.
 */
export async function runScenario(scenario, { instance = null, onProgress = () => {} } = {}) {
  const name = instance ?? scenario.instance
  if (!name) fail('no server named: put "instance" in the scenario or pass --instance <name>')
  const check = checkInstance(name)
  if (!check.ok) fail(check.problems.join('\n'))
  for (const w of check.warnings) onProgress(`warning: ${w}`)
  const host = hostInstall()
  if (!host) fail(`mineflayer is not installed. Run once: spawnloft bot setup (about 500 MB into ${HOST_DIR})`)

  const { inst } = check
  const log = consoleLog(name)
  let logOffset = 0
  try { logOffset = fs.statSync(log).size } catch { /* no console yet: read it from the start */ }

  const setup = []
  if (scenario.setup.length) {
    onProgress(`running ${scenario.setup.length} setup command(s) as the console`)
    const replies = await rconExec(inst, scenario.setup.map((c) => c.replace(/^\//, '')))
    scenario.setup.forEach((command, i) => setup.push({ command, reply: stripColors(replies[i] ?? '').trim() }))
  }

  const job = {
    name: scenario.name, hostDir: host.dir, host: '127.0.0.1', port: inst.port, version: check.version,
    bots: scenario.bots, steps: scenario.steps, consoleLog: log, logOffset,
  }
  const jobFile = path.join(HOST_DIR, `job-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(jobFile, JSON.stringify(job))
  onProgress(`${scenario.bots.length} bot(s) joining ${name} on 127.0.0.1:${inst.port}` + (check.version ? ` (Minecraft ${check.version})` : ''))
  let report
  try {
    report = await runHost(jobFile, { onProgress })
  } finally {
    try { fs.unlinkSync(jobFile) } catch { /* already gone */ }
  }
  return { ...report, instance: name, setup, mineflayer: host.version, warnings: check.warnings }
}

function runHost(jobFile, { onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_SCRIPT, jobFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => {
      stderr += d
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) onProgress(line.trim())
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop()
      let report = null
      try { report = line ? JSON.parse(line) : null } catch { /* not a report */ }
      if (report) return resolve(report)
      reject(new Error(`the bot host exited with code ${code} and no report${stderr.trim() ? `:\n${stderr.trim().split('\n').slice(-10).join('\n')}` : ''}`))
    })
  })
}

/** One line per step, for a terminal. */
export function formatReport(report) {
  const out = []
  if (report.error) out.push(`error: ${report.error}`)
  for (const s of report.setup ?? []) out.push(`setup  ${s.command}${s.reply ? `  -> ${s.reply.split('\n')[0]}` : ''}`)
  for (const s of report.steps ?? []) {
    const { bot, timeout, ...rest } = s.step
    const what = (bot ? `${bot} ` : '') + JSON.stringify(rest)
    const mark = s.status === 'passed' ? 'ok   ' : s.status === 'failed' ? 'FAIL ' : 'skip '
    out.push(`${mark} ${String(s.index + 1).padStart(2)}. ${what}${s.durationMs != null ? `  (${s.durationMs} ms)` : ''}`)
    if (s.error) out.push(`       ${s.error.split('\n').join('\n       ')}`)
  }
  const passed = (report.steps ?? []).filter((s) => s.status === 'passed').length
  out.push(`${report.ok ? 'PASSED' : 'FAILED'}: ${passed} of ${(report.steps ?? []).length} steps passed in ${report.durationMs ?? 0} ms`)
  return out.join('\n')
}
