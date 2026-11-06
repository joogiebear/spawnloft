#!/usr/bin/env node
// M1 CLI start and M6 daemon start (PLAN.md section 2.2). Fresh process per run, wall time from
// spawn to close, warm-up runs discarded; median and p90, and the bare runtime alongside so a
// number reads as a multiple of the floor.
import fs from 'node:fs'
import path from 'node:path'
import {
  parseCli, COMMON_USAGE, intList, benchRootFrom, benchEnv, removeRoot, writeFixture, cliSpec, floorSpec,
  runTimed, runCli, stats, round, nowMs, environment, writeResult, checkDoc, check, runMain,
} from './lib.mjs'

const USAGE = `node tools/perf/cli-start.mjs [options]

Times --help, list (with each --servers count registered), status and mcp (stdin closed), then,
unless --no-daemon, M6: spawnloft start <server> to the daemon having launched the server
(state file written) and to ready, against a fake JVM so the number is SpawnLoft's own.

  --runs <n>          timed runs per command (default 15)
  --warmup <n>        discarded runs first (default 3)
  --servers <list>    registered-server counts for list/status (default 0,10)
  --daemon-runs <n>   M6 runs (default 5)
  --no-daemon         skip M6
${COMMON_USAGE}`

const OPTIONS = {
  runs: { type: 'string' },
  warmup: { type: 'string' },
  servers: { type: 'string' },
  'daemon-runs': { type: 'string' },
  'no-daemon': { type: 'boolean', default: false },
}

async function timeMany(run, { runs, warmup }) {
  const times = []
  const failures = []
  for (let i = 0; i < warmup + runs; i++) {
    const r = await run()
    if (r.code !== 0) failures.push(`exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''}`)
    if (i >= warmup) times.push(r.ms)
  }
  return { ...stats(times), failures: failures.length ? failures.slice(0, 3) : undefined }
}

async function waitFor(check, timeoutMs) {
  const deadline = nowMs() + timeoutMs
  while (nowMs() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return check()
}

function readState(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'run', name, 'state.json'), 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), OPTIONS, USAGE)
  const self = values['self-test']
  const runs = Number(values.runs ?? (self ? 2 : 15))
  const warmup = Number(values.warmup ?? (self ? 0 : 3))
  const serverCounts = intList(values.servers, self ? [0, 2] : [0, 10])
  const daemonRuns = Number(values['daemon-runs'] ?? (self ? 1 : 5))
  const spec = cliSpec(values)
  const root = benchRootFrom(values, 'cli')
  const results = []

  try {
    const floor = floorSpec(spec)
    let floorMedian = null
    if (floor) {
      const s = await timeMany(() => runTimed(floor.cmd, floor.args, { env: { ...process.env, ...floor.env } }), { runs, warmup })
      floorMedian = s.median
      results.push({ id: 'floor', label: 'bare runtime (-e 0)', unit: 'ms', ...s })
    }
    const vsFloor = (s) => (floorMedian && s.median ? round(s.median / floorMedian, 2) : null)

    for (const count of serverCounts) {
      // one data root per count, so `list` reads exactly that many registered servers
      const sub = path.join(root, `servers-${count}`)
      fs.mkdirSync(sub, { recursive: true })
      await writeFixture(sub, { servers: count, prefix: 'cli' })
      const env = benchEnv(sub)
      const cases = count === serverCounts[0]
        ? [['help', ['--help']], ['list', ['list']], ['status', ['status']], ['mcp', ['mcp']]]
        : [['list', ['list']], ['status', ['status']]]
      for (const [id, args] of cases) {
        const s = await timeMany(() => runCli(spec, args, env), { runs, warmup })
        // `mcp` reads JSON-RPC from stdin and ends at EOF, so a closed stdin is a cold start and exit
        const label = id === 'mcp' ? 'mcp (stdin closed)' : `${args.join(' ')}`
        results.push({ id: `${id}-${count}`, label: `${label}, ${count} servers`, unit: 'ms', ...s, xFloor: vsFloor(s) })
      }
    }

    if (!values['no-daemon']) {
      const sub = path.join(root, 'daemon')
      fs.mkdirSync(sub, { recursive: true })
      const { names: [name] } = await writeFixture(sub, { servers: 1, prefix: 'm6' })
      const env = benchEnv(sub, { MCCTL_RESTART_DELAY_MS: '300' })
      const launched = []
      const ready = []
      const notes = []
      for (let i = 0; i < daemonRuns; i++) {
        const t0 = nowMs()
        let launchedAt = null
        // start waits for the ready line by default; watch the state file meanwhile
        const watcher = waitFor(() => {
          const st = readState(sub, name)
          if (st?.running && st.startedAt && launchedAt == null) launchedAt = nowMs()
          return launchedAt != null
        }, 60000)
        const r = await runCli(spec, ['start', name], env, { timeoutMs: 120000 })
        await watcher
        if (r.code === 0) {
          ready.push(r.ms)
          if (launchedAt != null) launched.push(launchedAt - t0)
        } else notes.push(`start exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]}`)
        const stop = await runCli(spec, ['stop', name], env, { timeoutMs: 60000 })
        if (stop.code !== 0) notes.push(`stop exit ${stop.code}`)
        await waitFor(() => !readState(sub, name)?.running, 15000)
      }
      results.push({ id: 'daemon-launched', label: 'start -> server launched (state file)', unit: 'ms', ...stats(launched), notes: notes.join('; ') || undefined })
      results.push({ id: 'daemon-ready', label: 'start -> ready (fake JVM)', unit: 'ms', ...stats(ready) })
    }

    const env = environment(values, spec)
    const { doc } = writeResult('cli-start', env, results, { settings: { runs, warmup, servers: serverCounts, daemonRuns } }, { outDir: values.out ?? (self ? path.join(root, 'out') : undefined) })

    if (self) {
      checkDoc(doc, 'cli-start')
      const ids = doc.results.map((r) => r.id)
      for (const id of ['help-0', 'list-0', 'status-0', 'mcp-0', 'list-2', 'daemon-launched', 'daemon-ready']) check(ids.includes(id), `has ${id}`)
      for (const r of doc.results) check(!r.failures, `${r.id} ran cleanly: ${JSON.stringify(r.failures)}`)
      check(doc.results.find((r) => r.id === 'daemon-ready').n === daemonRuns, 'every daemon start reached ready')
      process.stdout.write('cli-start self-test passed\n')
    }
    return 0
  } finally {
    if (!values.keep) removeRoot(root)
  }
}

runMain(main)
