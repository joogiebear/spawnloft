#!/usr/bin/env node
// M4 backup of a real multi-gigabyte world (PLAN.md section 2.2). The world is COPIED into a bench
// instance under the bench data root; the source folder is only read. Per case and run: wall time
// of `spawnloft backup`, CPU of the CLI and of the archiver under it (tar/bsdtar/gzip), archive
// size, `verify` time and, for the stopped case, `restore` time. The panel case starts the same
// backup from the panel and records the panel's peak RSS, its stalls and /api/instances latency
// while the backup runs.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  reapedChildCpuMs, killTree, parseCli, COMMON_USAGE, benchRootFrom, benchEnv, removeRoot, writeFixture, writeBenchSettings, copyDir, treeSize,
  cliSpec, invocation, runCli, startPanel, stopPanel, timedFetch, panelStalls, treeSampler, workerPid, stats, round,
  nowMs, environment, writeResult, checkDoc, check, runMain,
} from './lib.mjs'
import { spawn } from 'node:child_process'

const USAGE = `node tools/perf/backup-bench.mjs --world <dir> [options]

  --world <dir>        a world folder (has level.dat) or a whole server folder (has
                       server.properties) to copy into the bench. Never written to. Refused if
                       it holds a session.lock touched in the last 5 minutes (a live world).
  --runs <n>           runs per case (default 3)
  --cases <list>       stopped,running,mirror,panel (default all that can run)
  --mirror <dir>       a folder on another drive for the mirror case (only <dir>/<bench server>
                       is written, and removed afterwards)
  --server-jar <file>  a real server jar for the running case (with --java)
  --java <path>        the Java that runs it
  --start-timeout <s>  how long the running case waits for ready (default 600)
${COMMON_USAGE}`

const OPTIONS = {
  world: { type: 'string' },
  runs: { type: 'string' },
  cases: { type: 'string' },
  mirror: { type: 'string' },
  'server-jar': { type: 'string' },
  java: { type: 'string' },
  'start-timeout': { type: 'string' },
}

const LIVE_LOCK_MS = 5 * 60 * 1000
const ARCHIVERS = /^(tar|bsdtar|gzip|pigz|gtar)(\.exe)?$/i

// Signs that a server has this world open. Minecraft writes session.lock at start, so its age only
// catches a server that started recently; a running server also holds it locked (reading it fails
// on Windows), and on Linux a process working in the folder shows in /proc/<pid>/cwd.
function liveWorld(dir) {
  const lock = liveLock(dir)
  if (lock) return `${lock} is in use or was touched in the last 5 minutes`
  if (process.platform === 'linux') {
    const abs = fs.realpathSync(dir)
    // not this script, nor the shell that started it
    const mine = new Set([String(process.pid), String(process.ppid)])
    for (const pid of fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e) && !mine.has(e))) {
      let cwd
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`) } catch { continue }
      if (cwd === abs || cwd.startsWith(abs + path.sep) || abs.startsWith(cwd + path.sep) && fs.existsSync(path.join(cwd, 'server.properties'))) {
        return `process ${pid} is running in ${cwd}`
      }
    }
  }
  return null
}

function liveLock(dir, depth = 3) {
  const walk = (d, left) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isFile() && e.name === 'session.lock') {
        try {
          if (Date.now() - fs.statSync(p).mtimeMs < LIVE_LOCK_MS) return p
          fs.readFileSync(p)
        } catch { /* unreadable: a running server holds it locked (Windows) */ return p }
      }
      if (e.isDirectory() && left > 0) {
        const hit = walk(p, left - 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(dir, depth)
}

function setProps(file, patch) {
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { /* new file */ }
  const seen = new Set()
  lines = lines.map((l) => {
    const k = l.split('=')[0]
    if (Object.hasOwn(patch, k)) { seen.add(k); return `${k}=${patch[k]}` }
    return l
  })
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k)) lines.push(`${k}=${v}`)
  fs.writeFileSync(file, lines.filter((l, i) => l || i < lines.length - 1).join('\n') + '\n')
}

// A small world for the self-test: region files of random (incompressible) bytes and a level.dat.
function syntheticWorld(dir) {
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'level.dat'), crypto.randomBytes(2048))
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'region', `r.${i}.0.mca`), crypto.randomBytes(64 * 1024))
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'data', `map_${i}.dat`), Buffer.alloc(4096, i))
}

function lastJson(text) {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) } catch { /* not the JSON line */ }
  }
  return null
}

// Runs the CLI with a process-tree sampler on it: wall time plus CPU per process kind.
function runSampled(spec, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, argv, spawnOpts] = invocation(spec, args)
    const t0 = nowMs()
    const reaped0 = reapedChildCpuMs()
    const child = spawn(cmd, argv, { env: { ...env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...spawnOpts })
    const sampler = treeSampler(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = nowMs() - t0
      const procs = sampler.stop()
      // Linux: the exact total for the whole finished tree (other children of this script are
      // idle meanwhile); elsewhere the sampled sum, which misses each process's last interval
      const reaped1 = reapedChildCpuMs()
      const exactMs = reaped0 != null && reaped1 != null ? reaped1 - reaped0 : null
      const archiverCpuMs = procs.filter((p) => ARCHIVERS.test(p.name)).reduce((a, p) => a + p.cpuMs, 0)
      const totalCpuMs = procs.reduce((a, p) => a + p.cpuMs, 0)
      const total = exactMs ?? totalCpuMs
      resolve({ ms, code, stdout, stderr, cpu: { archiverMs: round(archiverCpuMs), otherMs: round(Math.max(0, total - archiverCpuMs)), totalMs: round(total), exact: exactMs != null, processes: procs.map((p) => `${p.name}:${p.cpuMs}`) } })
    })
  })
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), OPTIONS, USAGE)
  const self = values['self-test']
  if (!self && !values.world) throw new Error(`--world is required\n\n${USAGE}`)
  const runs = Number(values.runs ?? (self ? 1 : 3))
  const spec = cliSpec(values)
  const root = benchRootFrom(values, 'backup')
  const results = []
  const detail = []
  let mirror = values.mirror ? path.resolve(values.mirror) : null

  try {
    let source = values.world ? path.resolve(values.world) : null
    if (self) {
      source = path.join(root, 'source-world')
      syntheticWorld(source)
      mirror = path.join(root, 'mirror')
      fs.mkdirSync(mirror, { recursive: true })
    }
    if (!fs.existsSync(source)) throw new Error(`no such folder: ${source}`)
    const live = liveWorld(source)
    if (live) throw new Error(`${live}: a server looks to have this world open. Stop it, or copy the world somewhere first.`)
    if (path.resolve(source).startsWith(path.resolve(root) + path.sep) && !self) throw new Error('--world must not be inside the bench data root')

    const wholeServer = fs.existsSync(path.join(source, 'server.properties'))
    if (!wholeServer && !fs.existsSync(path.join(source, 'level.dat'))) throw new Error(`${source} has neither level.dat nor server.properties`)

    const realServer = Boolean(values['server-jar'] && values.java)
    const { names: [name] } = await writeFixture(root, {
      servers: 1, prefix: 'bb',
      java: realServer ? path.resolve(values.java) : undefined,
      jar: realServer ? path.resolve(values['server-jar']) : null,
    })
    const instDir = path.join(root, 'instances', name)
    const props = fs.readFileSync(path.join(instDir, 'server.properties'), 'utf8')
    const keep = Object.fromEntries(props.trim().split('\n').map((l) => l.split('=')).filter(([k]) => ['server-port', 'rcon.port', 'rcon.password', 'enable-rcon'].includes(k)))
    process.stdout.write(`Copying ${source} into the bench (${wholeServer ? 'whole server folder' : 'world folder'})...\n`)
    const copyT0 = nowMs()
    const skip = (p) => path.basename(p) === 'session.lock' || (wholeServer && /\.jar$/i.test(p) && path.dirname(p) === source)
    if (wholeServer) {
      fs.rmSync(path.join(instDir, 'world'), { recursive: true, force: true })
      copyDir(source, instDir, { skip })
      // the copy carries the live server's ports; the bench server must not collide with it
      setProps(path.join(instDir, 'server.properties'), { ...keep, 'query.port': keep['server-port'], 'enable-query': 'false' })
    } else {
      fs.rmSync(path.join(instDir, 'world'), { recursive: true, force: true })
      copyDir(source, path.join(instDir, 'world'), { skip })
    }
    const copyMs = nowMs() - copyT0
    const size = treeSize(instDir)
    process.stdout.write(`Bench server holds ${size.files} files, ${(size.bytes / 1e9).toFixed(2)} GB (${Math.round(size.mcaShare * 100)}% region files).\n`)

    const env = benchEnv(root, { MCCTL_RESTART_DELAY_MS: '300' })
    const backupsDir = path.join(root, 'backups', name)
    const clearBackups = () => fs.rmSync(backupsDir, { recursive: true, force: true })

    const wanted = new Set((values.cases ?? (self ? 'stopped,mirror,panel' : 'stopped,running,mirror,panel')).split(',').map((s) => s.trim()))
    const skipped = []
    if (wanted.has('running') && !realServer) { wanted.delete('running'); skipped.push('running: needs --server-jar and --java') }
    if (wanted.has('mirror') && !mirror) { wanted.delete('mirror'); skipped.push('mirror: needs --mirror <dir>') }

    const backupCase = async (id, label) => {
      const wall = []
      const archCpu = []
      const otherCpu = []
      const totalCpu = []
      const sizes = []
      const verify = []
      const restore = []
      const notes = []
      for (let i = 0; i < runs; i++) {
        clearBackups()
        const r = await runSampled(spec, ['backup', name, '--json'], env, 6 * 3600 * 1000)
        const doc = lastJson(r.stdout)
        if (r.code !== 0 || !doc?.ok) { notes.push(`backup exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]}`); continue }
        wall.push(r.ms)
        archCpu.push(r.cpu.archiverMs)
        otherCpu.push(r.cpu.otherMs)
        totalCpu.push(r.cpu.totalMs)
        sizes.push(doc.data.sizeBytes)
        if (id === 'mirror' && !doc.data.mirrored) notes.push(`no mirror copy: ${doc.data.mirrorError ?? 'mirror not set'}`)
        detail.push({ case: id, run: i, cpu: r.cpu, mirrored: doc.data.mirrored ?? null, warnings: doc.data.warnings ?? [] })
        const v = await runCli(spec, ['verify', name, 'latest'], env, { timeoutMs: 6 * 3600 * 1000 })
        if (v.code === 0) verify.push(v.ms)
        else notes.push(`verify exit ${v.code}`)
        if (id === 'stopped') {
          const rs = await runCli(spec, ['restore', name, 'latest', '--yes'], env, { timeoutMs: 6 * 3600 * 1000 })
          if (rs.code === 0) restore.push(rs.ms)
          else notes.push(`restore exit ${rs.code}: ${(rs.stderr || rs.stdout).trim().split('\n').slice(-1)[0]}`)
        }
      }
      const n = notes.length ? notes.slice(0, 3).join('; ') : undefined
      results.push({ id: `${id}-wall`, label: `${label}: backup wall time`, unit: 'ms', ...stats(wall), notes: n })
      results.push({ id: `${id}-archiver-cpu`, label: `${label}: archiver CPU (tar/gzip children)`, unit: 'ms', ...stats(archCpu) })
      results.push({ id: `${id}-other-cpu`, label: `${label}: CLI and other CPU`, unit: 'ms', ...stats(otherCpu) })
      results.push({ id: `${id}-total-cpu`, label: `${label}: total CPU of the backup${process.platform === 'linux' ? '' : ' (sampled)'}`, unit: 'ms', ...stats(totalCpu) })
      results.push({ id: `${id}-size`, label: `${label}: archive size`, unit: 'bytes', ...stats(sizes) })
      results.push({ id: `${id}-verify`, label: `${label}: verify`, unit: 'ms', ...stats(verify) })
      if (id === 'stopped') results.push({ id: 'stopped-restore', label: `${label}: restore --yes`, unit: 'ms', ...stats(restore) })
    }

    if (wanted.has('stopped')) await backupCase('stopped', 'stopped')

    if (wanted.has('running')) {
      const timeout = String(values['start-timeout'] ?? 600)
      // stopped in every case: a start that timed out can still leave the server running
      try {
        const st = await runCli(spec, ['start', name, '--timeout', timeout], env, { timeoutMs: (Number(timeout) + 60) * 1000 })
        if (st.code !== 0) skipped.push(`running: the server did not start: ${(st.stderr || st.stdout).trim().split('\n').slice(-1)[0]}`)
        else await backupCase('running', 'running idle')
      } finally {
        await runCli(spec, ['stop', name], env, { timeoutMs: 300000 })
      }
    }

    if (wanted.has('mirror')) {
      writeBenchSettings(root, { backupsMirrorDir: mirror })
      try { await backupCase('mirror', `mirror to ${values.mirror ? 'another folder' : 'a temp folder'}`) } finally {
        writeBenchSettings(root, {})
        fs.rmSync(path.join(mirror, name), { recursive: true, force: true })
      }
    }

    if (wanted.has('panel')) {
      const sinceMs = Date.now()
      const panel = await startPanel(spec, { ...env, SPAWNLOFT_PERF_LOG_MS: '50' })
      try {
        const peaks = []
        const wall = []
        const probe = []
        for (let i = 0; i < runs; i++) {
          clearBackups()
          const pid = workerPid(panel.child.pid)
          const sampler = treeSampler(pid)
          let done = false
          const probing = (async () => {
            while (!done) {
              probe.push((await timedFetch(`${panel.url}api/instances`, { timeoutMs: 60000 })).ms)
              await new Promise((r) => setTimeout(r, 500))
            }
          })()
          const r = await timedFetch(`${panel.url}api/instances/${encodeURIComponent(name)}/backups`, { method: 'POST', body: {}, timeoutMs: 6 * 3600 * 1000 })
          done = true
          await probing
          const procs = sampler.stop()
          peaks.push(procs.find((p) => p.pid === pid)?.peakRss ?? null)
          if (r.status === 200) wall.push(r.ms)
          else detail.push({ case: 'panel', run: i, error: r.error ?? r.text })
        }
        await new Promise((r) => setTimeout(r, 1200))
        const stalls = panelStalls(root, { sinceMs })
        results.push({ id: 'panel-wall', label: 'from the panel: POST backups wall time', unit: 'ms', ...stats(wall) })
        results.push({ id: 'panel-peak-rss', label: 'from the panel: panel peak RSS', unit: 'bytes', ...stats(peaks) })
        results.push({ id: 'panel-instances-during', label: 'from the panel: /api/instances during the backup', unit: 'ms', ...stats(probe) })
        results.push({ id: 'panel-stalls', label: 'from the panel: seconds with a stall >= 50 ms', unit: 'count', median: stalls.count, p90: null, max: stalls.max, over250: stalls.over250 })
      } finally {
        await stopPanel(panel)
      }
    }

    const envBlock = environment(values, spec)
    const { doc } = writeResult('backup-bench', envBlock, results, {
      world: { source: self ? '(synthetic)' : source, wholeServer, ...size, copyMs: round(copyMs) },
      settings: { runs, cases: [...wanted], skipped, realServer, mirror: Boolean(mirror) },
      detail,
    }, { outDir: values.out ?? (self ? path.join(root, 'out') : undefined) })

    if (self) {
      checkDoc(doc, 'backup-bench')
      const ids = doc.results.map((r) => r.id)
      for (const id of ['stopped-wall', 'stopped-archiver-cpu', 'stopped-size', 'stopped-verify', 'stopped-restore', 'mirror-wall', 'panel-wall', 'panel-peak-rss', 'panel-stalls']) check(ids.includes(id), `has ${id}`)
      for (const id of ['stopped-wall', 'stopped-verify', 'stopped-restore', 'mirror-wall', 'panel-wall']) {
        const r = doc.results.find((x) => x.id === id)
        check(r.n === runs, `${id} completed every run (${r.notes ?? ''})`)
      }
      check(doc.results.find((r) => r.id === 'stopped-size').median > 0, 'archive has a size')
      if (process.platform === 'linux') check(doc.results.find((r) => r.id === 'stopped-total-cpu').median > 0, 'the backup used measurable CPU')
      check(!doc.results.find((r) => r.id === 'mirror-wall').notes, 'mirror copy was made')
      process.stdout.write('backup-bench self-test passed\n')
    }
    return 0
  } finally {
    if (!values.keep) removeRoot(root)
  }
}

runMain(main)
