// The differential rig (rust/PLAN-CORE-PORT.md section 6, layer 2). A scenario is a list of
// steps: files to put in place, and command lines to run through `spawnloft-core`. The rig runs
// it twice in the same scratch folder, once with SPAWNLOFT_CORE_IMPL=node (every ported command
// forwarded to the Node core) and once without (the ownership table in cli.rs decides), and
// compares what each command printed, its exit code, the requests it made of the fake hosts,
// and the data tree left behind.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startHosts } from './fake-host.mjs'
import { snapshot } from './tree.mjs'
import { normalizeText, machineNeutral } from './normalize.mjs'
import { applyDeclared } from '../declared-differences.mjs'
import { replay } from './panel.mjs'

export const SIDES = ['node', 'rust']
export const IMPL_ENV = 'SPAWNLOFT_CORE_IMPL'
const STEP_TIMEOUT_MS = 120000

// The core binary: SPAWNLOFT_CORE_BIN, else the newest of rust/target/{debug,release}.
export function findCore(repo, env = process.env) {
  if (env.SPAWNLOFT_CORE_BIN) return env.SPAWNLOFT_CORE_BIN
  const exe = process.platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core'
  const found = ['debug', 'release'].map(p => path.join(repo, 'rust', 'target', p, exe))
    .filter(p => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return found[0] ?? null
}

// The stand-in for the system scheduler (spawnloft-fakes fake-scheduler), built beside the core.
export function findFakeScheduler(core, env = process.env) {
  if (env.SPAWNLOFT_FAKE_SCHEDULER) return env.SPAWNLOFT_FAKE_SCHEDULER
  if (!core) return null
  const file = path.join(path.dirname(core), process.platform === 'win32' ? 'fake-scheduler.exe' : 'fake-scheduler')
  return fs.existsSync(file) ? file : null
}

// {run}, {data}, {home}, {repo} in a step's strings, as this side's real paths.
function expand(value, ctx) {
  // a process that is alive on every system for as long as the scenario runs: this one
  if (value === '{rig-pid}') return process.pid
  if (typeof value === 'string') return value.replace(/\{(run|data|home|repo)\}/g, (_, k) => ctx[k])
  if (Array.isArray(value)) return value.map(v => expand(v, ctx))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, ctx)]))
  return value
}

// Everything a side runs with. The machine's own SpawnLoft and Node settings never reach it; the
// data root and every per-user folder a core might write to point into the scratch folder.
export function sideEnv(ctx, side, { origins, extra = {} } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SPAWNLOFT_|MCCTL_)/.test(k) || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(k)) continue
    env[k] = v
  }
  const home = ctx.home
  Object.assign(env, {
    SPAWNLOFT_DATA_ROOT: ctx.data,
    MCCTL_DATA_ROOT: ctx.data,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    NODE_ENV: 'test',
    SPAWNLOFT_NODE: process.execPath,
    SPAWNLOFT_CORE_DIR: ctx.repo,
    SPAWNLOFT_HARNESS_INDEX_FETCH: 'off',
    // an empty map still refuses every host that is not on this machine: no scenario downloads
    // anything real, whether or not it fakes a host
    SPAWNLOFT_TEST_ORIGINS: origins ?? '{}',
    // the system scheduler's programs played by the fake (C6): no scenario reaches the machine's
    // own Task Scheduler, launchd or systemd, and a missing fake fails to start rather than
    // falling through to the real one
    SPAWNLOFT_TEST_SCHEDULER: ctx.scheduler ?? path.join(ctx.run, 'no-fake-scheduler'),
    FAKE_SCHEDULER_DIR: path.join(ctx.run, 'scheduler'),
    // `spawnloft ui` hands its page to $BROWSER; Node given an HTML file stops at once
    BROWSER: process.execPath,
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NO_COLOR: '1',
  })
  if (side === 'node') env[IMPL_ENV] = 'node'
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k]
    else env[k] = String(v)
  }
  return env
}

function runProcess(bin, args, { cwd, env, stdin, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', (e) => err.push(Buffer.from(`spawn failed: ${e.message}\n`)))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin ?? '')
    let done = false
    const finish = (code, signal, held = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      // a process the command started that still holds its stdout or stderr is a finding, not a hang
      if (held) err.push(Buffer.from('rig: the command exited but its output stayed open (a process it started holds the pipe)\n'))
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, signal, timedOut })
    }
    let grace = null
    child.on('exit', (code, signal) => { grace = setTimeout(() => finish(code, signal, true), PIPE_GRACE_MS) })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

// How long after a command exits its pipes may stay open before the rig stops waiting for them.
const PIPE_GRACE_MS = 10000

// A step that puts something in place: identical on both sides unless it names one.
function applySetup(step, ctx, baseDir) {
  const target = (p) => {
    const abs = path.resolve(ctx.run, expand(p, ctx))
    if (abs !== ctx.run && !abs.startsWith(ctx.run + path.sep)) throw new Error(`step writes outside the scratch folder: ${p}`)
    return abs
  }
  if (step.mkdir !== undefined) {
    fs.mkdirSync(target(step.mkdir), { recursive: true })
  } else if (step.write !== undefined) {
    const file = target(step.write)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let body
    if (step.json !== undefined) body = JSON.stringify(expand(step.json, ctx), null, step.indent ?? 2) + '\n'
    else if (step.text !== undefined) body = expand(step.text, ctx)
    else if (step.base64 !== undefined) body = Buffer.from(step.base64, 'base64')
    else if (step.copy !== undefined) body = fs.readFileSync(path.resolve(baseDir, step.copy))
    else throw new Error(`write ${step.write}: give json, text, base64 or copy`)
    fs.writeFileSync(file, body)
    if (step.mode && process.platform !== 'win32') fs.chmodSync(file, parseInt(step.mode, 8))
    // a fixed modification time, for readers that sort by it (crash reports, snapshots)
    if (step.mtime) {
      const at = new Date(step.mtime)
      fs.utimesSync(file, at, at)
    }
  } else if (step.hardlink !== undefined) {
    // a second name for an existing file: `{ "hardlink": "new/name", "to": "existing/file" }`
    const file = target(step.hardlink)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.linkSync(target(step.to), file)
  } else if (step.remove !== undefined) {
    fs.rmSync(target(step.remove), { recursive: true, force: true })
  } else {
    throw new Error(`unknown step: ${JSON.stringify(step)}`)
  }
}

function stepLabel(i, step) {
  if (step.panel) return `step ${i + 1} (panel, ${step.panel.length} requests)`
  return `step ${i + 1} (${step.run.join(' ')})`
}

// How each side's panel is started for a `panel` step: `spawnloft ui` as a terminal runs it, on
// both sides (the Node side by SPAWNLOFT_CORE_IMPL). `"window": true` gives both sides what the
// desktop window gives its panel (SPAWNLOFT_SHELL), which is what serves /setup.
function panelArgs() {
  return ['ui', '--port', '0', '--no-open']
}

// What a step's output must show on both sides: a guard against a scenario that "passes" only
// because both sides failed the same way (a host not faked, a typo in the command).
function checkExpect(step, result, side, label) {
  const e = step.expect
  if (!e) return []
  const problems = []
  if (e.code !== undefined && result.code !== e.code) problems.push(`${side}: ${label} exited ${result.code}, the scenario expects ${e.code}\n${result.stderr.trim().slice(0, 2000)}`)
  for (const [key, stream] of [['stdoutIncludes', 'stdout'], ['stderrIncludes', 'stderr']]) {
    for (const want of [].concat(e[key] ?? [])) {
      if (!result[stream].includes(want)) problems.push(`${side}: ${label} ${stream} does not include ${JSON.stringify(want)}`)
    }
  }
  return problems
}

async function runSide(scenario, side, o) {
  const run = path.join(o.scratch, 'run')
  fs.rmSync(run, { recursive: true, force: true })
  const ctx = { run, data: path.join(run, 'data'), home: path.join(run, 'home'), repo: o.repo, scheduler: findFakeScheduler(o.core) }
  fs.mkdirSync(ctx.data, { recursive: true })
  fs.mkdirSync(ctx.home, { recursive: true })
  const extra = scenario.normalize ?? []
  const commands = new Set()
  const steps = []
  const problems = []
  for (const [i, raw] of scenario.steps.entries()) {
    if (raw.side && raw.side !== side) continue
    if (raw.panel) {
      const step = expand(raw, ctx)
      commands.add('ui')
      const env = sideEnv(ctx, side, { origins: o.origins, extra: { ...scenario.env, ...(step.window ? { SPAWNLOFT_SHELL: 'tauri' } : {}), ...step.env } })
      const label = stepLabel(i, raw)
      const res = await replay(o.core, panelArgs(step, side, ctx), step.panel, { cwd: ctx.run, env, ctx })
      if (res.problem) problems.push(`${side}: ${label}: ${res.problem}`)
      for (const want of [].concat(step.expect?.includes ?? [])) {
        if (!res.text.includes(want)) problems.push(`${side}: ${label} answers do not include ${JSON.stringify(want)}`)
      }
      const text = applyDeclared(normalizeText(res.text.replace(/\r\n/g, '\n'), extra), 'ui')
      steps.push({ index: i, label, args: ['ui', 'replay'], golden: false, code: 0, signal: null, stdout: text, stderr: '', raw: { stdout: res.text, stderr: '' } })
      continue
    }
    if (!raw.run) { applySetup(raw, ctx, o.baseDir); continue }
    const step = expand(raw, ctx)
    const command = step.run[0]
    commands.add(command)
    const env = sideEnv(ctx, side, { origins: o.origins, extra: { ...scenario.env, ...step.env } })
    const res = await runProcess(o.core, step.run, { cwd: ctx.run, env, stdin: step.stdin, timeoutMs: step.timeoutMs ?? STEP_TIMEOUT_MS })
    const label = stepLabel(i, raw)
    if (res.timedOut) problems.push(`${side}: ${label} did not finish in ${step.timeoutMs ?? STEP_TIMEOUT_MS} ms`)
    problems.push(...checkExpect(step, res, side, label))
    const even = (t) => applyDeclared(normalizeText(t.replace(/\r\n/g, '\n'), extra), command)
    steps.push({ index: i, label, args: raw.run, golden: raw.golden !== false, code: res.code, signal: res.signal, stdout: even(res.stdout), stderr: even(res.stderr), raw: { stdout: res.stdout, stderr: res.stderr } })
  }
  // as a sorted list: parallel downloads (a modpack, a client's libraries) arrive in any order,
  // and what matters is that both sides asked for the same things
  const requests = o.takeRequests().map(r => ({ ...r, url: normalizeText(r.url, extra) }))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
  const tree = snapshot(run, {
    ignore: scenario.ignore ?? [],
    acl: Boolean(scenario.acl),
    normalizePath: (p) => normalizeText(p, extra),
    // a file's text is evened out as the output of every command the scenario ran would be
    normalize: (t) => [...commands].reduce((acc, c) => applyDeclared(acc, c), normalizeText(t, extra)),
  })
  if (o.keep) {
    const kept = path.join(o.scratch, side)
    fs.rmSync(kept, { recursive: true, force: true })
    fs.renameSync(run, kept)
  } else {
    fs.rmSync(run, { recursive: true, force: true })
  }
  return { steps, requests, tree, problems, ctx }
}

// The first lines where two texts part, with a little context, as `- node` / `+ rust` lines.
export function textDiff(a, b, { context = 2, labels = ['node', 'rust'] } = {}) {
  const x = String(a).split('\n')
  const y = String(b).split('\n')
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  let ex = x.length - 1
  let ey = y.length - 1
  while (ex >= i && ey >= i && x[ex] === y[ey]) { ex--; ey-- }
  const out = []
  for (let k = Math.max(0, i - context); k < i; k++) out.push(`  ${x[k]}`)
  const cap = 20
  for (let k = i; k <= ex && k < i + cap; k++) out.push(`- ${labels[0]}: ${x[k]}`)
  if (ex - i + 1 > cap) out.push(`- ${labels[0]}: ... ${ex - i + 1 - cap} more lines`)
  for (let k = i; k <= ey && k < i + cap; k++) out.push(`+ ${labels[1]}: ${y[k]}`)
  if (ey - i + 1 > cap) out.push(`+ ${labels[1]}: ... ${ey - i + 1 - cap} more lines`)
  for (let k = ex + 1; k <= Math.min(x.length - 1, ex + context); k++) out.push(`  ${x[k]}`)
  return out.join('\n')
}

const entryText = (e) => e.text ?? e.zip ?? e.tar ?? (e.sha256 ? `${e.size} bytes, sha256 ${e.sha256}` : '')

// Every way side `b` differs from side `a`, as { what, detail }.
export function compareSides(a, b, labels = ['node', 'rust']) {
  const diffs = []
  const n = Math.max(a.steps.length, b.steps.length)
  for (let i = 0; i < n; i++) {
    const x = a.steps[i]
    const y = b.steps[i]
    if (!x || !y) { diffs.push({ what: `step ${i + 1}`, detail: `ran on one side only` }); continue }
    if (x.code !== y.code || x.signal !== y.signal) diffs.push({ what: `${x.label}: exit code`, detail: `${labels[0]}: ${x.code ?? x.signal}, ${labels[1]}: ${y.code ?? y.signal}` })
    for (const stream of ['stdout', 'stderr']) {
      if (x[stream] !== y[stream]) diffs.push({ what: `${x.label}: ${stream}`, detail: textDiff(x[stream], y[stream], { labels }) })
    }
  }
  const ra = JSON.stringify(a.requests, null, 1)
  const rb = JSON.stringify(b.requests, null, 1)
  if (ra !== rb) diffs.push({ what: 'requests to the fake hosts', detail: textDiff(ra, rb, { labels }) })
  const paths = [...new Set([...a.tree.keys(), ...b.tree.keys()])].sort()
  for (const p of paths) {
    const x = a.tree.get(p)
    const y = b.tree.get(p)
    if (!x) { diffs.push({ what: `data tree: ${p}`, detail: `only on ${labels[1]} (${y.kind})` }); continue }
    if (!y) { diffs.push({ what: `data tree: ${p}`, detail: `only on ${labels[0]} (${x.kind})` }); continue }
    if (JSON.stringify(x) === JSON.stringify(y)) continue
    const parts = []
    for (const k of ['kind', 'mode', 'target']) if (x[k] !== y[k]) parts.push(`${k}: ${labels[0]} ${x[k]}, ${labels[1]} ${y[k]}`)
    if (x.acl !== y.acl) parts.push(`acl:\n${textDiff(x.acl, y.acl, { labels })}`)
    const tx = entryText(x)
    const ty = entryText(y)
    if (tx !== ty) parts.push(textDiff(tx, ty, { labels }))
    diffs.push({ what: `data tree: ${p}`, detail: parts.join('\n') })
  }
  return diffs
}

// A recorded side, with this machine's paths replaced, for a golden file.
export function goldenOf(side, paths) {
  const neutral = (t) => machineNeutral(t, paths)
  return {
    steps: side.steps.filter(s => s.golden).map(s => ({ args: s.args, code: s.code, stdout: neutral(s.stdout), stderr: neutral(s.stderr) })),
    requests: side.requests,
  }
}

function compareGolden(side, golden, paths) {
  const now = goldenOf(side, paths)
  const diffs = []
  const n = Math.max(now.steps.length, golden.steps.length)
  for (let i = 0; i < n; i++) {
    const x = golden.steps[i]
    const y = now.steps[i]
    if (!x || !y) { diffs.push({ what: `golden step ${i + 1}`, detail: 'missing on one side' }); continue }
    const label = `golden step ${i + 1} (${y.args.join(' ')})`
    if (JSON.stringify(x.args) !== JSON.stringify(y.args)) diffs.push({ what: label, detail: `golden runs ${x.args.join(' ')}` })
    if (x.code !== y.code) diffs.push({ what: `${label}: exit code`, detail: `golden ${x.code}, now ${y.code}` })
    for (const s of ['stdout', 'stderr']) if (x[s] !== y[s]) diffs.push({ what: `${label}: ${s}`, detail: textDiff(x[s], y[s], { labels: ['golden', 'now'] }) })
  }
  const ra = JSON.stringify(golden.requests, null, 1)
  const rb = JSON.stringify(now.requests, null, 1)
  if (ra !== rb) diffs.push({ what: 'golden requests', detail: textDiff(ra, rb, { labels: ['golden', 'now'] }) })
  return diffs
}

// Runs one scenario on the given sides. Returns { name, ok, diffs, problems, sides }.
//   expect: 'same' (the default) passes when the sides agree; 'differ' is a self-test of the rig
//   and passes only when it finds a difference. Steps marked `side` (the seeded difference) are
//   allowed only in a 'differ' scenario, so no real scenario can run different steps per side.
export async function runScenario(scenario, { core, repo, scratch, sides = SIDES, keep = false, baseDir = repo, golden = 'check' }) {
  const expect = scenario.expect ?? 'same'
  if (!['same', 'differ'].includes(expect)) throw new Error(`${scenario.name}: expect is "same" or "differ"`)
  if (expect !== 'differ' && scenario.steps.some(s => s.side)) throw new Error(`${scenario.name}: a step for one side only is allowed only in a self-test (expect: "differ")`)
  if (!scenario.steps.some(s => s.run || s.panel)) throw new Error(`${scenario.name}: no step runs a command`)
  // the switch and the host map are the rig's to set: a scenario that set them could make both
  // sides the same core, or let one side reach the network
  for (const env of [scenario.env, ...scenario.steps.map(s => s.env)]) {
    for (const k of Object.keys(env ?? {})) if ([IMPL_ENV, 'SPAWNLOFT_TEST_ORIGINS', 'SPAWNLOFT_TEST_SCHEDULER', 'FAKE_SCHEDULER_DIR'].includes(k)) throw new Error(`${scenario.name}: a scenario may not set ${k}`)
  }
  fs.mkdirSync(scratch, { recursive: true })
  const hosts = await startHosts(scenario.hosts ?? {}, { baseDir })
  const results = {}
  try {
    for (const side of sides) {
      results[side] = await runSide(scenario, side, { core, repo, scratch, keep, baseDir, origins: hosts.env, takeRequests: () => hosts.take() })
    }
  } finally {
    await hosts.close()
  }
  const problems = sides.flatMap(s => results[s].problems)
  const diffs = sides.length === 2 ? compareSides(results[sides[0]], results[sides[1]], sides) : []
  const paths = { run: path.join(scratch, 'run'), repo, node: process.execPath, core }
  let goldenDiffs = []
  const goldenFile = scenario.golden && path.resolve(repo, scenario.golden)
  const goldenHere = goldenFile && (!scenario.goldenPlatforms || scenario.goldenPlatforms.includes(process.platform))
  if (goldenHere && results.node) {
    if (golden === 'update') {
      fs.mkdirSync(path.dirname(goldenFile), { recursive: true })
      fs.writeFileSync(goldenFile, JSON.stringify({ about: scenario.goldenAbout ?? `What the Node core prints for scenario ${scenario.name} (tools/parity/). Regenerate with node tools/parity/run.mjs --update-golden; a change here is a change to the CLI's contract.`, scenario: scenario.name, platform: process.platform, ...goldenOf(results.node, paths) }, null, 2) + '\n')
    } else if (!fs.existsSync(goldenFile)) {
      problems.push(`golden file ${scenario.golden} is missing: run with --update-golden`)
    } else {
      goldenDiffs = compareGolden(results.node, JSON.parse(fs.readFileSync(goldenFile, 'utf8')), paths)
    }
  }
  // a self-test names the differences it seeded, so finding some other difference is not a pass
  if (expect === 'differ') {
    for (const want of scenario.expectDifferences ?? []) {
      if (!diffs.some(d => d.what.includes(want))) problems.push(`self-test: no reported difference matches "${want}" (found: ${diffs.map(d => d.what).join('; ') || 'none'})`)
    }
  }
  const allDiffs = [...diffs, ...goldenDiffs]
  const ok = problems.length === 0 && (expect === 'differ' ? diffs.length > 0 && goldenDiffs.length === 0 : allDiffs.length === 0)
  return { name: scenario.name, expect, ok, diffs: allDiffs, problems, sides: results }
}
