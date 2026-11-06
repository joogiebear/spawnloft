// The measurement scripts in tools/perf (PLAN P0). Each has a --self-test that runs it against a
// throwaway fixture and checks the shape of its result file; running them here keeps them from
// rotting on Windows and Linux. No benchmark number is asserted: CI runners are too noisy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-perf-tools-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const perf = await import('../tools/perf/lib.mjs')
const { lagLogMs } = await import('../src/ui.mjs')

test('SPAWNLOFT_PERF_LOG_MS sets the panel stall threshold; anything unusable keeps 250', () => {
  assert.equal(lagLogMs({}), 250)
  assert.equal(lagLogMs({ SPAWNLOFT_PERF_LOG_MS: '' }), 250)
  assert.equal(lagLogMs({ SPAWNLOFT_PERF_LOG_MS: '50' }), 50)
  assert.equal(lagLogMs({ SPAWNLOFT_PERF_LOG_MS: ' 75 ' }), 75)
  for (const bad of ['0', '-5', '12.5', 'fast', '1e9', '60001']) assert.equal(lagLogMs({ SPAWNLOFT_PERF_LOG_MS: bad }), 250, bad)
})

test('percentiles are nearest-rank and ignore non-numbers', () => {
  const s = perf.stats([5, 1, 4, 2, 3, NaN, 10])
  assert.equal(s.n, 6)
  assert.equal(s.median, 3)
  assert.equal(s.p90, 10)
  assert.equal(s.min, 1)
  assert.deepEqual(perf.stats([]).median, null)
  assert.equal(perf.psTimeMs('01:02'), 62000)
  assert.equal(perf.psTimeMs('1-00:00:01'), 86401000)
})

test('a bench root must be empty, missing or marked; real locations are refused', () => {
  const env = { ...process.env, LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'local') }
  const empty = path.join(scratch, 'empty')
  fs.mkdirSync(empty)
  assert.equal(perf.refuseRoot(empty, env), null)
  assert.equal(perf.refuseRoot(path.join(scratch, 'missing'), env), null)

  const busy = path.join(scratch, 'busy')
  fs.mkdirSync(busy)
  fs.writeFileSync(path.join(busy, 'instances.json'), '{}')
  assert.match(perf.refuseRoot(busy, env), /not empty/)
  fs.writeFileSync(path.join(busy, perf.MARKER), '')
  assert.equal(perf.refuseRoot(busy, env), null)

  assert.match(perf.refuseRoot(perf.defaultDataRoot(env), env), /real SpawnLoft location/)
  assert.match(perf.refuseRoot(REPO, env), /real SpawnLoft location/)
  assert.match(perf.refuseRoot(os.homedir(), env), /real SpawnLoft location/)
  assert.match(perf.refuseRoot(undefined, env), /no bench data root/)

  // the configured data root is refused even when someone put a marker in it
  const configured = path.join(scratch, 'configured')
  fs.mkdirSync(configured)
  fs.writeFileSync(path.join(configured, perf.MARKER), '')
  fs.mkdirSync(path.join(scratch, 'config', 'mcctl'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'config', 'mcctl', 'settings.json'), JSON.stringify({ dataRoot: configured }))
  try {
    assert.match(perf.refuseRoot(configured, env), /real SpawnLoft location/)
  } finally {
    fs.rmSync(path.join(scratch, 'config', 'mcctl', 'settings.json'))
  }
})

test('removing a bench root leaves anything without the marker alone', () => {
  const dir = path.join(scratch, 'unmarked')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
  perf.removeRoot(dir)
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')))
})

test('bench processes get the bench data root and settings, never the real ones', () => {
  const env = perf.benchEnv('/bench')
  assert.equal(env.MCCTL_DATA_ROOT, '/bench')
  assert.equal(env.XDG_CONFIG_HOME, path.join('/bench', 'config'))
  if (process.platform === 'win32') assert.equal(env.APPDATA, path.join('/bench', 'config'))
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
})

test('the process-tree sampler sees a busy child and its CPU', { timeout: 60000 }, async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'const end = Date.now() + 2500; while (Date.now() < end) {}'], { stdio: 'ignore' })
  const sampler = perf.treeSampler(child.pid, { intervalMs: 300 })
  await new Promise((resolve) => child.on('exit', resolve))
  const rows = sampler.stop()
  const row = rows.find((r) => r.pid === child.pid)
  assert.ok(row, `the child was sampled: ${JSON.stringify(rows)}`)
  assert.ok(row.cpuMs > 0, `it used CPU: ${JSON.stringify(row)}`)
  assert.ok(row.peakRss > 0, 'it had a resident size')
})

test('an output folder inside the bench root is refused unless --keep', () => {
  const root = path.join(scratch, 'outroot')
  assert.throws(() => perf.refuseOutInside({ out: path.join(root, 'results') }, root), /inside the bench root/)
  assert.doesNotThrow(() => perf.refuseOutInside({ out: path.join(root, 'results'), keep: true }, root))
  assert.doesNotThrow(() => perf.refuseOutInside({ out: path.join(scratch, 'elsewhere') }, root))
})

const SCRIPTS = ['compare.mjs', 'console-bench.cjs', 'cli-start.mjs', 'memory.mjs', 'backup-bench.mjs', 'panel-latency.mjs']
for (const script of SCRIPTS) {
  test(`tools/perf/${script} --self-test`, { timeout: 240000 }, () => {
    const env = { ...process.env }
    delete env.MCCTL_DATA_ROOT
    const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'perf', script), '--self-test', '--machine', 'ci'], {
      cwd: REPO, env, encoding: 'utf8', timeout: 230000, windowsHide: true,
    })
    assert.equal(r.status, 0, `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`)
    assert.match(r.stdout, /self-test passed/)
  })
}

test('cleanup', () => {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})
