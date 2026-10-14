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
import { fail, UserError } from './util.mjs'

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
// What `bot setup` installs: an exact mineflayer and a lockfile for its whole tree, shipped with
// SpawnLoft. A version range here would hand each user whatever the registry served on the day
// they ran setup - about ninety packages none of us had tested - instead of the tree that was.
const PINNED_DIR = fileURLToPath(new URL('./bot-host/', import.meta.url))
const PINNED_FILES = ['package.json', 'package-lock.json']
// Written into HOST_DIR only after npm ci has finished, so an install cut short is not taken for a good one.
const PINNED_MARKER = '.spawnloft-pinned'
export const MINEFLAYER_VERSION = JSON.parse(fs.readFileSync(path.join(PINNED_DIR, 'package.json'), 'utf8')).dependencies.mineflayer
const HOST_SCRIPT = fileURLToPath(new URL('./bot-host.cjs', import.meta.url))
export const MAX_BOTS = 5
const STEP_KEYS = ['chat', 'command', 'expectMessage', 'waitWindow', 'click', 'closeWindow', 'expectItem', 'expectState', 'expectLog', 'leave']
const STEP_EXTRAS = ['bot', 'timeout', 'button']
const BOT_NAME_RE = /^[A-Za-z0-9_]{3,16}$/
// Commands that would take the server down behind the supervisor's back - it would read the exit
// as a crash - or run Bukkit's reload, which leaves plugins half-initialised. The run_command MCP
// tool refuses them, and so does a scenario, whether as setup (the console) or as a bot: an opped
// bot's "/stop" stops the server just as well.
export const REFUSED_CONSOLE = new Set(['stop', 'restart', 'reload', 'rl'])
// What the console answers when a setup command did nothing. Paper's words, with vanilla's.
const SETUP_FAILED_RE = /No player was found|Unknown or incomplete command|Unknown command|Incorrect argument|Expected whitespace|You do not have permission/i
// What the core and the host say to each other; see runHost and awaitSetup in the host.
const JOINED_LINE = '{"event":"joined"}'

/** The command word of a console or chat line: "/minecraft:stop now" is "stop". */
export function commandVerb(line) {
  return String(line).trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '')
}

/** Where mineflayer is, or null when `spawnloft bot setup` has not run on this machine. */
export function hostInstall() {
  const pkg = path.join(HOST_DIR, 'node_modules', 'mineflayer', 'package.json')
  let meta
  // A half-written or unreadable package.json is "not installed" too: setup --force puts it right.
  try { meta = JSON.parse(fs.readFileSync(pkg, 'utf8')) } catch { return null }
  return meta?.version ? { dir: HOST_DIR, version: meta.version } : null
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** The shipped pin as one string, line endings evened out: a Windows checkout ships CRLF, a Linux one LF. */
function pinnedStamp() {
  return PINNED_FILES.map((f) => fs.readFileSync(path.join(PINNED_DIR, f), 'utf8').replace(/\r\n/g, '\n')).join('\0')
}

/** Whether the install in HOST_DIR is a finished install of the lockfile this SpawnLoft ships. */
export function hostIsPinned() {
  try { return fs.readFileSync(path.join(HOST_DIR, PINNED_MARKER), 'utf8') === pinnedStamp() } catch { return false }
}

/**
 * Install mineflayer into the data root, once.
 *
 * <p>Through npm, because that is the only honest way to get a package with ninety transitive
 * dependencies onto a machine. npm comes with Node, which a source checkout already has. The
 * desktop app bundles a runtime without npm, so there this fails with the way out spelled out; a
 * prebuilt download for that case is a later step.
 *
 * <p>What npm installs is not left to the registry: `npm ci` against the lockfile in src/bot-host
 * installs exactly that tree, checks every package against the lockfile's hash, and refuses if
 * anything disagrees. `--ignore-scripts` because nothing in the tree has an install script, so a
 * package that grew one later would be running code nobody reviewed. An install made from a
 * different lockfile (an older SpawnLoft's range), or one that npm did not finish, is replaced rather
 * than trusted.
 *
 * <p>The install is around 500 MB, most of it game data for every Minecraft version there has
 * been. That is mineflayer's shape, not a choice made here.
 */
export function ensureHost({ onProgress = () => {}, force = false } = {}) {
  const have = hostInstall()
  if (have && hostIsPinned() && !force) return have
  fs.mkdirSync(HOST_DIR, { recursive: true })
  fs.rmSync(path.join(HOST_DIR, PINNED_MARKER), { force: true })
  for (const f of PINNED_FILES) fs.copyFileSync(path.join(PINNED_DIR, f), path.join(HOST_DIR, f))
  const npm = npmCommand()
  const probe = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (probe.error || probe.status !== 0) {
    fail([
      'npm was not found, and it is what installs mineflayer.',
      '  Install Node.js from https://nodejs.org (npm comes with it), open a new terminal, and run: spawnloft bot setup',
      `  The install goes into ${HOST_DIR} and is about 500 MB.`,
    ].join('\n'))
  }
  onProgress(`Installing mineflayer ${MINEFLAYER_VERSION} and its locked dependencies into ${HOST_DIR} with npm ${probe.stdout.trim()} (about 500 MB, a few minutes)`)
  const res = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: HOST_DIR, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    fail(`npm ci failed (exit ${res.status}) in ${HOST_DIR}:\n${(res.stderr || res.stdout || '').trim().split('\n').slice(-15).join('\n')}`)
  }
  const installed = hostInstall()
  if (!installed) fail(`npm ci finished but mineflayer is not in ${HOST_DIR}/node_modules`)
  fs.writeFileSync(path.join(HOST_DIR, PINNED_MARKER), pinnedStamp())
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
 *
 * <p>`host` is where the bots connect: the bound address when there is one, because a server on
 * 192.168.1.5 alone does not answer on 127.0.0.1; loopback when the server listens everywhere.
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
  const everywhere = ['', '0.0.0.0', '::'].includes(bound)
  if (everywhere || !['127.0.0.1', 'localhost', '::1'].includes(bound)) {
    warnings.push(`"${name}" listens on ${everywhere ? 'every interface' : bound} in offline mode, so anyone who can reach port ${inst.port} can join under any name. For a test server, set server-ip=127.0.0.1.`)
  }
  return { inst, ok: problems.length === 0, problems, warnings, version: mcVersionOf(inst) ?? null, host: everywhere ? '127.0.0.1' : bound }
}

/** The scenario as a checked object, with the file's name as a fallback for its own. */
export function loadScenario(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (err) { fail(`cannot read scenario ${file}: ${err.message}`) }
  let data
  try { data = JSON.parse(raw) } catch (err) { fail(`${file} is not valid JSON: ${err.message}`) }
  return validateScenario(data, { name: path.basename(file, '.json') })
}

/**
 * A pattern is plain text, or `/.../flags` for a regular expression. Checked here so that a typo
 * fails the scenario before any bot joins, not in step 7 after thirty seconds of setup. The g and
 * y flags are refused because they make `test()` stateful: the same pattern would match a line
 * once and then miss it.
 */
function checkPattern(where, field, pattern) {
  if (typeof pattern !== 'string' || !pattern) fail(`${where}: "${field}" must be text or /a regular expression/`)
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern)
  if (!m) return
  if (/[gy]/.test(m[2])) fail(`${where}: "${field}" uses the ${m[2].includes('g') ? 'g' : 'y'} flag, which has no meaning for a match here; drop it`)
  try { new RegExp(m[1], m[2]) } catch (err) { fail(`${where}: "${field}" is not a valid regular expression: ${err.message}`) }
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
    const verb = commandVerb(cmd)
    if (REFUSED_CONSOLE.has(verb)) fail(`setup command "${verb}" would take the server down or half-reload it; a scenario cannot run it`)
  }
  if (!Array.isArray(scenario.steps) || !scenario.steps.length) fail('"steps" must list at least one step')
  scenario.steps.forEach((step, i) => {
    const where = `step ${i + 1}`
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`${where} is not an object`)
    const keys = Object.keys(step).filter((k) => STEP_KEYS.includes(k))
    if (keys.length !== 1) fail(`${where} must have exactly one of ${STEP_KEYS.join(', ')}; it has ${keys.length ? keys.join(', ') : 'none'}`)
    const unknown = Object.keys(step).filter((k) => !STEP_KEYS.includes(k) && !STEP_EXTRAS.includes(k))
    if (unknown.length) fail(`${where} has ${unknown.map((k) => JSON.stringify(k)).join(', ')}, which is not a step key; the keys are ${[...STEP_KEYS, ...STEP_EXTRAS].join(', ')}`)
    const [kind] = keys
    if (kind !== 'expectLog' && !scenario.bots.includes(step.bot)) fail(`${where} (${kind}) names bot ${JSON.stringify(step.bot ?? null)}, which is not in "bots"`)
    if (step.timeout !== undefined && !(Number.isInteger(step.timeout) && step.timeout > 0 && step.timeout <= 300000)) fail(`${where}: "timeout" is milliseconds, 1 to 300000`)
    if (kind === 'chat' || kind === 'command') {
      const text = step[kind]
      if (typeof text !== 'string' || !text.trim()) fail(`${where}: "${kind}" must be text`)
      // A chat line starting with "/" is a command too: the server does not know the difference.
      const verb = kind === 'command' || text.trimStart().startsWith('/') ? commandVerb(text) : null
      if (verb && REFUSED_CONSOLE.has(verb)) fail(`${where}: "${verb}" would take the server down or half-reload it; a bot cannot run it`)
    }
    if (kind === 'expectMessage' || kind === 'waitWindow') checkPattern(where, kind, step[kind])
    if (kind === 'expectLog') {
      const want = step.expectLog
      if (!want || typeof want !== 'object' || (want.present === undefined) === (want.absent === undefined)) {
        fail(`${where}: expectLog takes {"present": pattern} or {"absent": pattern}`)
      }
      checkPattern(where, want.present !== undefined ? 'present' : 'absent', want.present ?? want.absent)
    }
    if (kind === 'click' && !Number.isInteger(step.click)) fail(`${where}: "click" is a slot number`)
    if (kind === 'expectItem') {
      const want = step.expectItem
      const ok = typeof want === 'string' ? Boolean(want) : (want && typeof want === 'object' && typeof want.name === 'string' && (want.count === undefined || Number.isInteger(want.count)))
      if (!ok) fail(`${where}: expectItem is an item name such as "minecraft:diamond", or {"name": ..., "count": n}`)
    }
    if (kind === 'expectState' && (!step.expectState || typeof step.expectState !== 'object' || Array.isArray(step.expectState))) {
      fail(`${where}: expectState is an object of what to wait for (gameMode, minHealth, maxHealth, dimension, near, nearBot, seesPlayer)`)
    }
  })
  return scenario
}

/**
 * Run one scenario end to end and return its report.
 *
 * <p>`instance` on the command line beats the file's, so one scenario file serves several test
 * servers. The bots join first; then setup runs as the console and its replies are in the report:
 * a setup command that fails ("Unknown command") is the usual reason a later step times out, so
 * it is in plain view rather than swallowed.
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

  // Setup waits for the bots to be on the server (see awaitSetup in the host): most of what it
  // does - op, gamemode, give, tp - names a bot, and the server answers "No player was found" for
  // one that has not joined. A reply that says so is a failed setup, not a line to scroll past.
  const setup = []
  async function runSetup() {
    if (!scenario.setup.length) return null
    onProgress(`running ${scenario.setup.length} setup command(s) as the console`)
    const replies = await rconExec(inst, scenario.setup.map((c) => c.replace(/^\//, '')))
    scenario.setup.forEach((command, i) => {
      const reply = stripColors(replies[i] ?? '').trim()
      setup.push({ command, reply, ok: !SETUP_FAILED_RE.test(reply) })
    })
    const bad = setup.find((s) => !s.ok)
    return bad ? `setup command "${bad.command}" failed: ${bad.reply}` : null
  }

  const job = {
    name: scenario.name, hostDir: host.dir, host: check.host, port: inst.port, version: check.version,
    bots: scenario.bots, steps: scenario.steps, consoleLog: log, logOffset, waitForSetup: true,
  }
  const jobFile = path.join(HOST_DIR, `job-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(jobFile, JSON.stringify(job))
  onProgress(`${scenario.bots.length} bot(s) joining ${name} on ${check.host}:${inst.port}` + (check.version ? ` (Minecraft ${check.version})` : ''))
  let report
  try {
    report = await runHost(jobFile, { onProgress, onJoined: runSetup })
  } finally {
    try { fs.unlinkSync(jobFile) } catch { /* already gone */ }
  }
  return { ...report, instance: name, setup, mineflayer: host.version, warnings: check.warnings }
}

/**
 * Start the host and wait for its report.
 *
 * <p>The host speaks JSON lines on stdout: `{event: "joined"}` once the bots are in, then the
 * report as its last line. The one word it takes back on stdin is whether to go on after setup.
 * `onJoined` runs setup and resolves to a problem (abort) or null (go); a throw aborts too.
 *
 * <p>The host can die at any point - a server that kicks the bots, a crash in mineflayer - and
 * the core must come out with a readable error rather than go down with it. So stdin errors are
 * swallowed (writing to a dead child is EPIPE, which would otherwise crash the core), "joined" is
 * acted on once even if it arrives split across chunks, and the report is whichever stdout line
 * parses as one, so a stray line printed after it does not hide it.
 *
 * <p>`script` is for tests, which stand in a small script for the real host.
 */
export function runHost(jobFile, { onProgress = () => {}, onJoined = async () => null, script = HOST_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE: under the desktop app process.execPath is Electron, which would open a
    // window instead of running the script. The supervisor and daemon spawn themselves the same way.
    const child = spawn(process.execPath, [script, jobFile], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.stdin.on('error', () => { /* the host is gone; its exit code says so below */ })
    const tell = (word) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(word) + '\n') }
    let stdout = ''
    let stderr = ''
    let signalled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      stdout += d
      if (signalled || !stdout.includes(JOINED_LINE)) return
      signalled = true
      stdout = stdout.replace(JOINED_LINE, '')
      Promise.resolve().then(onJoined).then(
        (problem) => tell(problem ? { abort: String(problem) } : { go: true }),
        (err) => tell({ abort: err.message }),
      )
    })
    child.stderr.on('data', (d) => {
      stderr += d
      for (const line of d.split(/\r?\n/)) if (line.trim()) onProgress(line.trim())
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const report = parseReport(stdout)
      if (report) return resolve(report)
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-10).join('\n')
      reject(new UserError(`the bot host exited with code ${code} and no report${tail ? `:\n${tail}` : ''}\nIf this keeps happening, reinstall it: spawnloft bot setup --force`))
    })
  })
}

/** The last stdout line that is a report, searching from the end past anything printed after it. */
function parseReport(stdout) {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line)
      if (obj && Array.isArray(obj.steps)) return obj
    } catch { /* not a report */ }
  }
  return null
}

/** One line per step, for a terminal. */
export function formatReport(report) {
  const out = []
  if (report.error) out.push(`error: ${report.error}`)
  for (const s of report.setup ?? []) out.push(`${s.ok === false ? 'FAIL ' : 'setup'}  ${s.command}${s.reply ? `  -> ${s.reply.split('\n')[0]}` : ''}`)
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
