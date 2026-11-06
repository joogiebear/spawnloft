#!/usr/bin/env node
// M5 memory per running server (PLAN.md section 2.2 and 4.7). Reads the run/<name>/state.json of
// every server in the data root, then samples each daemon, its helper children (the Windows
// PowerShell vitals sampler) and the JVM. Private and proportional sizes where the OS has them
// (Linux Pss/Private from smaps_rollup; Windows private bytes), RSS everywhere. SpawnLoft's own
// overhead per server is daemon + helpers; the JVM is recorded for context only.
//
// This script only reads. With --live-root it may read a real data root (the servers someone
// already has running), still without writing anything there.
import fs from 'node:fs'
import path from 'node:path'
import {
  parseCli, COMMON_USAGE, intList, benchRootFrom, benchEnv, removeRoot, writeFixture, cliSpec, runCli,
  processTable, descendants, stats, round, nowMs, environment, writeResult, checkDoc, check, runMain,
} from './lib.mjs'

const USAGE = `node tools/perf/memory.mjs [options]

  --live-root <dir>   read this real data root instead of a bench root (read-only: nothing is
                      started, stopped or written there)
  --start <n>         bench only: register and start n servers first (fake JVM unless --jar and
                      --java are given), stop them at the end
  --jar <file>        server jar for --start (a real Paper jar for the plan's numbers)
  --java <path>       Java for --start
  --at <list>         seconds after the first sample to sample again (default 0; the plan's
                      ready+60 s and ready+30 min is --at 60,1800 right after the servers are ready)
  --panel-pid <pid>   also sample this panel process (the desktop app's main process, or a
                      \`spawnloft ui\` process)
${COMMON_USAGE}`

const OPTIONS = {
  'live-root': { type: 'string' },
  start: { type: 'string' },
  jar: { type: 'string' },
  java: { type: 'string' },
  at: { type: 'string' },
  'panel-pid': { type: 'string' },
}

const pick = (r) => (r ? { pid: r.pid, name: r.name, rss: r.rss, private: r.private, pss: r.pss } : null)
const privOrRss = (r) => (r ? (r.private ?? r.rss) : 0)

function runningServers(root) {
  const runDir = path.join(root, 'run')
  const out = []
  let names = []
  try { names = fs.readdirSync(runDir) } catch { return out }
  for (const name of names) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(runDir, name, 'state.json'), 'utf8'))
      if (st.running && st.daemonPid) out.push({ name, kind: st.kind ?? 'server', daemonPid: st.daemonPid, javaPid: st.javaPid })
    } catch { /* no state file: never started */ }
  }
  return out
}

function sample(root, panelPid) {
  const servers = runningServers(root)
  const wanted = new Set()
  // helpers are found by walking the table first, so ask for detail on every descendant
  const rough = processTable({ detailPids: new Set() })
  for (const s of servers) {
    wanted.add(s.daemonPid)
    if (s.javaPid) wanted.add(s.javaPid)
    for (const d of descendants(rough, s.daemonPid)) wanted.add(d.pid)
  }
  if (panelPid) wanted.add(panelPid)
  const table = processTable({ detailPids: wanted })
  const rows = []
  for (const s of servers) {
    const daemon = table.get(s.daemonPid)
    if (!daemon) continue
    const javaTree = new Set(s.javaPid ? [s.javaPid, ...descendants(table, s.javaPid).map((r) => r.pid)] : [])
    const helpers = descendants(table, s.daemonPid).filter((r) => !javaTree.has(r.pid))
    const java = s.javaPid ? table.get(s.javaPid) : null
    rows.push({
      name: s.name,
      kind: s.kind,
      daemon: pick(daemon),
      helpers: helpers.map(pick),
      jvm: pick(java),
      overheadBytes: privOrRss(daemon) + helpers.reduce((a, h) => a + privOrRss(h), 0),
      overheadBasis: daemon.private != null ? 'private' : 'rss',
    })
  }
  const panel = panelPid ? pick(table.get(panelPid)) : null
  return { at: new Date().toISOString(), servers: rows, panel }
}

async function waitRunning(root, names, timeoutMs) {
  const deadline = nowMs() + timeoutMs
  while (nowMs() < deadline) {
    const up = new Set(runningServers(root).map((s) => s.name))
    if (names.every((n) => up.has(n))) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), OPTIONS, USAGE)
  const self = values['self-test']
  if (values['live-root'] && (values.start || self)) throw new Error('--live-root is read-only: it does not take --start or --self-test')
  const at = intList(values.at, [0])
  const panelPid = values['panel-pid'] ? Number(values['panel-pid']) : (self ? process.pid : null)
  const spec = cliSpec(values)
  const live = values['live-root'] ? path.resolve(values['live-root']) : null
  const root = live ?? benchRootFrom(values, 'memory')
  const toStart = Number(values.start ?? (self ? 1 : 0))
  const started = []
  let env = null

  try {
    if (!live && toStart > 0) {
      const { names } = await writeFixture(root, { servers: toStart, prefix: 'mem', java: values.java ? path.resolve(values.java) : undefined, jar: values.jar ? path.resolve(values.jar) : null })
      env = benchEnv(root, { MCCTL_RESTART_DELAY_MS: '300' })
      for (const name of names) {
        // recorded first, so the finally stops it even if this start fails or times out
        started.push(name)
        const r = await runCli(spec, ['start', name, '--timeout', '600'], env, { timeoutMs: 660000 })
        if (r.code !== 0) throw new Error(`could not start ${name}: ${(r.stderr || r.stdout).trim()}`)
      }
      if (!(await waitRunning(root, names, 30000))) throw new Error('servers did not show as running')
    }

    const t0 = nowMs()
    const samples = []
    for (const s of [...at].sort((a, b) => a - b)) {
      const wait = s * 1000 - (nowMs() - t0)
      if (wait > 0) {
        process.stdout.write(`next sample in ${Math.round(wait / 1000)} s...\n`)
        await new Promise((r) => setTimeout(r, wait))
      }
      samples.push({ offsetS: s, ...sample(root, panelPid) })
    }

    const results = []
    for (const s of samples) {
      const tag = `t${s.offsetS}`
      const n = s.servers.length
      const per = s.servers.map((r) => r.overheadBytes)
      results.push({ id: `overhead-per-server-${tag}`, label: `SpawnLoft overhead per server (daemon + helpers), ${n} running, +${s.offsetS} s`, unit: 'bytes', ...stats(per), basis: s.servers[0]?.overheadBasis ?? null })
      results.push({ id: `daemon-${tag}`, label: `daemon alone, +${s.offsetS} s`, unit: 'bytes', ...stats(s.servers.map((r) => r.daemon.private ?? r.daemon.rss)) })
      results.push({ id: `daemon-rss-${tag}`, label: `daemon RSS, +${s.offsetS} s`, unit: 'bytes', ...stats(s.servers.map((r) => r.daemon.rss)) })
      results.push({ id: `helpers-${tag}`, label: `helper processes per daemon (Windows sampler), +${s.offsetS} s`, unit: 'bytes', ...stats(s.servers.map((r) => r.helpers.reduce((a, h) => a + privOrRss(h), 0))) })
      const total = per.reduce((a, b) => a + b, 0)
      const jvm = s.servers.reduce((a, r) => a + privOrRss(r.jvm), 0)
      results.push({ id: `total-overhead-${tag}`, label: `total SpawnLoft overhead, ${n} servers, +${s.offsetS} s`, unit: 'bytes', median: total, p90: null, n })
      results.push({ id: `jvm-total-${tag}`, label: `JVMs total (context), +${s.offsetS} s`, unit: 'bytes', median: jvm, p90: null, n, share: jvm ? round(total / jvm, 3) : null })
      if (s.panel) results.push({ id: `panel-${tag}`, label: `panel process, ${n} servers, +${s.offsetS} s`, unit: 'bytes', median: s.panel.private ?? s.panel.rss, p90: null, rss: s.panel.rss })
    }

    const envBlock = environment(values, spec)
    const { doc } = writeResult('memory', envBlock, results, { settings: { at, liveRoot: Boolean(live), started: started.length, panelPid }, samples },
      { outDir: values.out ?? (self ? path.join(root, 'out') : undefined) })

    if (self) {
      checkDoc(doc, 'memory')
      check(doc.samples.length === 1 && doc.samples[0].servers.length === 1, 'sampled the one running server')
      const srv = doc.samples[0].servers[0]
      check(srv.daemon.rss > 0, 'daemon has a resident size')
      check(srv.jvm && srv.jvm.rss > 0, 'the fake JVM was found under its daemon')
      check(doc.results.some((r) => r.id === 'panel-t0' && r.median > 0), 'panel (this process) sampled')
      process.stdout.write('memory self-test passed\n')
    }
    return 0
  } finally {
    if (env) for (const name of started) await runCli(spec, ['stop', name], env, { timeoutMs: 300000 })
    if (!live && !values.keep) removeRoot(root)
  }
}

runMain(main)
