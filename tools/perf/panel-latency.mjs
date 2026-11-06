#!/usr/bin/env node
// M2 panel response times and stalls, M7 headless panel first load (PLAN.md section 2.2).
// Each case gets its own bench data root with N registered servers, R of them running on the fake
// JVM, and a panel started as `spawnloft ui --port 0 --no-open` with SPAWNLOFT_PERF_LOG_MS set so
// stalls down to that size land in panel.log, where this script counts them.
import fs from 'node:fs'
import path from 'node:path'
import {
  parseCli, COMMON_USAGE, intList, benchRootFrom, benchEnv, removeRoot, writeFixture, fillFiles, copyDir,
  cliSpec, runCli, startPanel, stopPanel, timedFetch, panelStalls, processTable, workerPid, stats, round,
  nowMs, environment, writeResult, checkDoc, check, runMain,
} from './lib.mjs'

const USAGE = `node tools/perf/panel-latency.mjs [options]

  --cases <list>        servers:running pairs (default 0:0,3:0,3:1,3:3,10:0,10:1,10:3)
  --requests <n>        sequential requests per route (default 50)
  --perf-log-ms <n>     stall threshold handed to the panel (default 50)
  --plugins-from <dir>  copy the .jar files of this folder into the first server's plugins/
                        (e.g. a Modrinth pack's mods; 200 jars for the plan's case)
  --world-files <n>     small files to create under the first server's world/region (default 20000)
  --external-db         add a case with an external MySQL on an unroutable address (dead host):
                        3 requests to /api/databases, each capped at 90 s
  --db-tools <dir>      folder holding the mysql/mariadb client for that case. Without one found
                        (Linux never searches PATH) the probe fails at once and the case measures
                        nothing; a dead-host answer under 1 s is flagged in the notes.
  --mixed-seconds <n>   length of the mixed-load case: the panel's 4 s poll against the dead host
                        while a console stream takes 200 lines/s (default 60; 0 skips it).
                        Needs --external-db and a case with a running server.
${COMMON_USAGE}`

const OPTIONS = {
  cases: { type: 'string' },
  requests: { type: 'string' },
  'perf-log-ms': { type: 'string' },
  'plugins-from': { type: 'string' },
  'world-files': { type: 'string' },
  'external-db': { type: 'boolean', default: false },
  'db-tools': { type: 'string' },
  'mixed-seconds': { type: 'string' },
}

function parseCases(text, fallback) {
  if (!text) return fallback
  return text.split(',').map((pair) => {
    const [s, r] = pair.split(':').map(Number)
    if (!Number.isInteger(s) || !Number.isInteger(r ?? 0) || (r ?? 0) > s) throw new Error(`bad case "${pair}": use servers:running`)
    return [s, r ?? 0]
  })
}

// `started` is filled before each start, so a caller's finally can stop whatever got going even
// when a later start fails.
async function fixtureFor(root, servers, running, values, spec, started, { externalDb = false } = {}) {
  fs.mkdirSync(root, { recursive: true })
  const { names, db } = await writeFixture(root, { servers, prefix: 'pl', externalDb, dbTools: values['db-tools'] ?? null })
  if (names.length) {
    const first = path.join(root, 'instances', names[0])
    const worldFiles = Number(values['world-files'] ?? (values['self-test'] ? 50 : 20000))
    if (worldFiles > 0) fillFiles(path.join(first, 'world', 'region'), worldFiles)
    if (values['plugins-from']) {
      const src = path.resolve(values['plugins-from'])
      for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.jar'))) {
        copyDir(path.join(src, f), path.join(first, 'plugins', f))
      }
    }
  }
  const env = benchEnv(root, { MCCTL_RESTART_DELAY_MS: '300' })
  started.env = env
  for (const name of names.slice(0, running)) {
    started.push(name)
    const r = await runCli(spec, ['start', name], env, { timeoutMs: 120000 })
    if (r.code !== 0) throw new Error(`could not start ${name}: ${(r.stderr || r.stdout).trim()}`)
  }
  return { names, db, env, started }
}

async function stopAll(spec, started) {
  for (const name of started) await runCli(spec, ['stop', name], started.env, { timeoutMs: 60000 })
}

function routesFor(names) {
  const routes = [['/', 'GET /'], ['/api/instances', 'instances'], ['/api/databases', 'databases']]
  if (names.length) {
    const n = encodeURIComponent(names[0])
    routes.push(
      [`/api/instances/${n}/plugins`, 'plugins'],
      [`/api/instances/${n}/files?path=world/region`, 'files world/region'],
      // the fake JVM has no RCON, so this times the refused RCON connection plus the file reads
      [`/api/instances/${n}/players`, 'players'],
      [`/api/instances/${n}/diagnose`, 'diagnose'],
    )
  }
  return routes
}

async function measureRoutes(url, routes, requests) {
  const out = []
  for (const [route, label] of routes) {
    const times = []
    const errors = new Set()
    for (let i = 0; i < requests; i++) {
      const r = await timedFetch(url.replace(/\/$/, '') + route)
      if (r.status !== 200) errors.add(r.error ?? `HTTP ${r.status}`)
      times.push(r.ms)
    }
    out.push({ route, label, ...stats(times), errors: errors.size ? [...errors] : undefined })
  }
  return out
}

function panelRss(panel) {
  try {
    const pid = workerPid(panel.child.pid)
    return processTable({ detailPids: new Set([pid]) }).get(pid)?.rss ?? null
  } catch {
    return null
  }
}

// The panel page's refresh(): every 4 s, unless the last one is still out, fetch /instances and
// /databases together; three failures in a row raise "Lost contact". A console stream is open
// meanwhile and 200 lines/s are appended to that server's console log (the path a busy server's
// output takes), and a faster probe of /api/instances runs every 500 ms.
async function mixedLoad(url, root, name, seconds) {
  const base = url.replace(/\/$/, '')
  const consoleFile = path.join(root, 'run', name, 'console.log')
  const ac = new AbortController()
  let streamed = 0
  const stream = fetch(`${base}/api/instances/${encodeURIComponent(name)}/stream`, { signal: ac.signal })
    .then(async (res) => {
      for await (const chunk of res.body) streamed += String(Buffer.from(chunk)).split('\n\n').length - 1
    })
    .catch(() => {})
  let lineNo = 0
  const writer = setInterval(() => {
    let text = ''
    for (let i = 0; i < 20; i++) text += `[12:00:00 INFO]: perf line ${++lineNo} ${'x'.repeat(60)}\n`
    try { fs.appendFileSync(consoleFile, text) } catch { /* daemon rotating */ }
  }, 100)
  const pollTimes = []
  const probeTimes = []
  let inFlight = false
  let skipped = 0
  let missed = 0
  let lostContact = false
  const end = nowMs() + seconds * 1000
  const poller = setInterval(async () => {
    if (inFlight) { skipped++; return }
    inFlight = true
    const t0 = nowMs()
    const [a, b] = await Promise.all([timedFetch(`${base}/api/instances`, { timeoutMs: 120000 }), timedFetch(`${base}/api/databases`, { timeoutMs: 120000 })])
    pollTimes.push(nowMs() - t0)
    if (a.status !== 200 || b.status !== 200) { if (++missed >= 3) lostContact = true } else missed = 0
    inFlight = false
  }, 4000)
  while (nowMs() < end) {
    const r = await timedFetch(`${base}/api/instances`, { timeoutMs: 30000 })
    probeTimes.push(r.ms)
    await new Promise((res) => setTimeout(res, 500))
  }
  clearInterval(poller)
  clearInterval(writer)
  ac.abort()
  await stream
  return { probe: stats(probeTimes), poll: stats(pollTimes), skippedPolls: skipped, lostContact, linesWritten: lineNo, linesStreamed: streamed }
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), OPTIONS, USAGE)
  const self = values['self-test']
  const cases = parseCases(values.cases, self ? [[0, 0], [1, 1]] : [[0, 0], [3, 0], [3, 1], [3, 3], [10, 0], [10, 1], [10, 3]])
  const requests = Number(values.requests ?? (self ? 3 : 50))
  const perfLogMs = String(values['perf-log-ms'] ?? 50)
  const mixedSeconds = Number(values['mixed-seconds'] ?? (self ? 0 : 60))
  const spec = cliSpec(values)
  const root = benchRootFrom(values, 'panel')
  const results = []
  const detail = []

  try {
    let idx = 0
    for (const [servers, running] of cases) {
      const sub = path.join(root, `case-${idx++}-${servers}s-${running}r`)
      const started = []
      let panel = null
      try {
        const fx = await fixtureFor(sub, servers, running, values, spec, started)
        const sinceMs = Date.now()
        panel = await startPanel(spec, { ...fx.env, SPAWNLOFT_PERF_LOG_MS: perfLogMs })
        // M7 headless: spawn to listening (includes module load), then the first GET / in full
        const first = await timedFetch(panel.url)
        const routes = await measureRoutes(panel.url, routesFor(fx.names), requests)
        const rss = panelRss(panel)
        // the watcher reports once a second; let the last second land
        await new Promise((r) => setTimeout(r, 1200))
        const stalls = panelStalls(sub, { sinceMs })
        const key = `${servers}s-${running}r`
        results.push({ id: `listen-${key}`, label: `panel spawn -> listening, ${servers} servers / ${running} running`, unit: 'ms', median: round(panel.startMs), p90: null, n: 1 })
        results.push({ id: `first-get-${key}`, label: `first GET /, ${key}`, unit: 'ms', median: round(first.ms), p90: null, n: 1 })
        for (const r of routes) {
          results.push({ id: `${r.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'root'}-${key}`, label: `${r.label}, ${key}`, unit: 'ms', median: r.median, p90: r.p90, p95: r.p95, max: r.max, n: r.n, errors: r.errors })
        }
        results.push({ id: `stalls-${key}`, label: `seconds with a stall >= ${perfLogMs} ms, ${key}`, unit: 'count', median: stalls.count, p90: null, max: stalls.max, over250: stalls.over250 })
        results.push({ id: `rss-${key}`, label: `panel RSS after the run, ${key}`, unit: 'bytes', median: rss, p90: null })
        detail.push({ servers, running, routes, stalls })
      } finally {
        await stopPanel(panel)
        await stopAll(spec, started)
      }
    }

    if (values['external-db'] || self) {
      // Dead external database host. Today a poll holds for the client's own timeout, so few
      // requests with a long cap; the self-test runs it with a 1-request, short-capped probe only
      // to check the plumbing.
      const sub = path.join(root, 'case-dead-db')
      const runningCase = cases.find(([, r]) => r > 0)
      const servers = runningCase ? runningCase[0] : 3
      const running = mixedSeconds > 0 ? Math.max(1, runningCase?.[1] ?? 1) : 0
      const started = []
      let panel = null
      try {
        const fx = await fixtureFor(sub, servers, running, values, spec, started, { externalDb: true })
        const sinceMs = Date.now()
        panel = await startPanel(spec, { ...fx.env, SPAWNLOFT_PERF_LOG_MS: perfLogMs })
        const times = []
        const errors = new Set()
        for (let i = 0; i < (self ? 1 : 3); i++) {
          const r = await timedFetch(`${panel.url}api/databases`, { timeoutMs: self ? 20000 : 90000 })
          if (r.status !== 200) errors.add(r.error ?? `HTTP ${r.status}`)
          times.push(r.ms)
        }
        const dead = stats(times)
        // a dead host holds the probe for its connect timeout; an answer in under a second means
        // the probe failed before reaching it (usually: no client tools found)
        const fast = dead.median != null && dead.median < 1000
        results.push({ id: 'databases-dead-host', label: `databases, external DB host unreachable, ${servers} servers`, unit: 'ms', ...dead, errors: errors.size ? [...errors] : undefined,
          notes: fast ? 'ANSWERED UNDER 1 s: the probe never reached the host (no client tools? pass --db-tools)' : undefined })
        const inst = await timedFetch(`${panel.url}api/instances`)
        results.push({ id: 'instances-dead-host', label: 'instances, with the dead DB registered', unit: 'ms', median: round(inst.ms), p90: null, n: 1 })
        if (mixedSeconds > 0 && fx.started.length) {
          const m = await mixedLoad(panel.url, sub, fx.started[0], mixedSeconds)
          results.push({ id: 'mixed-instances-probe', label: `mixed load: instances every 500 ms (${mixedSeconds} s)`, unit: 'ms', ...m.probe })
          results.push({ id: 'mixed-poll', label: 'mixed load: the 4 s poll (instances + databases)', unit: 'ms', ...m.poll, notes: `skipped polls ${m.skippedPolls}, lost contact ${m.lostContact ? 'YES' : 'no'}, lines ${m.linesStreamed}/${m.linesWritten}` })
          detail.push({ mixed: m })
        }
        await new Promise((r) => setTimeout(r, 1200))
        const stalls = panelStalls(sub, { sinceMs })
        results.push({ id: 'stalls-dead-host', label: `seconds with a stall >= ${perfLogMs} ms, dead DB host case`, unit: 'count', median: stalls.count, p90: null, max: stalls.max, over250: stalls.over250 })
      } finally {
        await stopPanel(panel)
        await stopAll(spec, started)
      }
    }

    const env = environment(values, spec)
    const { doc } = writeResult('panel-latency', env, results, { settings: { cases, requests, perfLogMs: Number(perfLogMs), mixedSeconds, pluginsFrom: values['plugins-from'] ?? null }, detail },
      { outDir: values.out ?? (self ? path.join(root, 'out') : undefined) })

    if (self) {
      checkDoc(doc, 'panel-latency')
      const ids = doc.results.map((r) => r.id)
      for (const id of ['listen-0s-0r', 'first-get-0s-0r', 'get-0s-0r', 'instances-0s-0r', 'databases-0s-0r', 'stalls-0s-0r', 'rss-0s-0r',
        'instances-1s-1r', 'plugins-1s-1r', 'files-world-region-1s-1r', 'players-1s-1r', 'diagnose-1s-1r', 'databases-dead-host']) {
        check(ids.includes(id), `has ${id} (got ${ids.join(', ')})`)
      }
      for (const r of doc.results.filter((r) => /-(0s-0r|1s-1r)$/.test(r.id) && r.unit === 'ms')) check(!r.errors, `${r.id} answered 200: ${JSON.stringify(r.errors)}`)
      check(doc.results.find((r) => r.id === 'instances-1s-1r').n === requests, 'every request was timed')
      process.stdout.write('panel-latency self-test passed\n')
    }
    return 0
  } finally {
    if (!values.keep) removeRoot(root)
  }
}

runMain(main)
