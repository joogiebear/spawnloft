import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { runDir } from './paths.mjs'
import { startDarwinSampler } from './metrics-darwin.mjs'
import { startLinuxSampler } from './metrics-linux.mjs'

// CPU and memory history of the java process. Windows has no cheap native API, so one
// long-lived PowerShell loop runs Get-Process for the life of the server instead of one launch
// per sample. macOS uses a short /bin/ps query (its %cpu is a moving average, so cumulative CPU
// time is used instead); Linux reads /proc. Samples go to a file in the run directory because
// the panel reads them from another process.

const INTERVAL_SEC = 10

// five hours, so the four-hour view is always full
const KEEP = 1800

// trimmed in batches rather than rewriting the file every sample
const TRIM_AT = KEEP + 600

export function metricsFile(name) {
  return path.join(runDir(name), 'metrics.log')
}

// CPU is a share of the whole machine (like Task Manager), so one pinned core of sixteen looks
// quiet; the core count is reported alongside.
const CORES = Math.max(1, os.cpus()?.length || 1)

// Returns a stop function. A sampler that can't start reports and gives up rather than
// taking the daemon down.
export function startSampler(name, pid, { onError = () => {}, extra = () => null } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
    onError(new Error('performance sampling is only implemented on Windows, macOS and Linux'))
    return () => {}
  }

  const file = metricsFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  let written = 0
  const record = sampleRecorder((sample) => {
    fs.appendFileSync(file, sampleLine(sample, extra()))
    if (++written % 60 === 0) trim(file)
  })
  if (process.platform === 'darwin') {
    return startDarwinSampler(pid, { onSample: record, onError, intervalMs: INTERVAL_SEC * 1000 })
  }
  if (process.platform === 'linux') {
    return startLinuxSampler(pid, { onSample: record, onError, intervalMs: INTERVAL_SEC * 1000 })
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    // invariant culture: otherwise a German Windows prints "29,765", which parses as 29
    '$inv = [System.Globalization.CultureInfo]::InvariantCulture',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if (-not $p) { exit 0 }',
    'while ($true) {',
    '  try { $p.Refresh() } catch { break }',
    '  if ($p.HasExited) { break }',
    // ToUnixTimeSeconds because Get-Date -UFormat %s is culture-formatted too. The line is
    // concatenated rather than built with -f: a cast in `[int][double]::Parse(x), a, b` binds
    // to the whole comma list and the format silently produced nothing.
    '  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
    '  $c = $p.CPU',
    '  if ($null -eq $c) { $c = 0 }',
    // through [Console] and flushed: PowerShell's own output pipeline buffers and delivers samples late
    '  [Console]::Out.WriteLine($t.ToString($inv) + " " + $c.ToString($inv) + " " + $p.WorkingSet64.ToString($inv))',
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Seconds ${INTERVAL_SEC}`,
    '}',
  ].join('\n')

  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let buf = ''
  let stopped = false

  ps.stdout.on('data', (chunk) => {
    if (stopped) return
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const [ts, cpuSec, rss] = line.trim().split(/\s+/)
      const at = Number(ts)
      const seconds = Number(cpuSec)
      const bytes = Number(rss)
      try { record({ at, seconds, bytes }) }
      catch (error) { onError(error) }
    }
  })

  ps.on('error', error => { if (!stopped) onError(error) })
  return () => {
    stopped = true
    try { ps.kill() } catch { /* already gone */ }
  }
}

// Collectors supply cumulative CPU seconds and resident bytes. A reset counter, clock
// adjustment or long sleep starts a new baseline instead of producing a spike.
export function sampleRecorder(write, cores = CORES) {
  let previous = null
  return ({ at, seconds, bytes }) => {
    if (![at, seconds, bytes].every(Number.isFinite) || at <= 0 || seconds < 0 || bytes < 0) return
    const prior = previous
    previous = { at, seconds }
    if (!prior) return
    const wall = at - prior.at
    if (wall <= 0 || wall > INTERVAL_SEC * 3 || seconds < prior.seconds) return
    const cpu = Math.max(0, Math.min(100, ((seconds - prior.seconds) / (wall * Math.max(1, cores))) * 100))
    write({ at: Math.floor(at), cpu, rss: Math.round(bytes / 1048576) })
  }
}

// Columns: time, cpu, rss, then optional tps, players online, player limit ("-" when unknown).
// Extra columns are only appended so readers of the first three still work.
export function sampleLine(sample, server) {
  const base = `${sample.at} ${sample.cpu.toFixed(1)} ${sample.rss}`
  if (!server) return base + '\n'
  const col = (v) => (Number.isFinite(v) ? String(v) : '-')
  return `${base} ${col(server.tps)} ${col(server.online)} ${col(server.max)}\n`
}

function trim(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= TRIM_AT) return
    fs.writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n')
  } catch {
    /* worst case is a gap in the graph */
  }
}

// Oldest first and unfiltered: the caller windows it, and needs to tell "nothing recorded"
// from "nothing in this range".
export function readSamples(name, { strict = false } = {}) {
  let text
  try {
    text = fs.readFileSync(metricsFile(name), 'utf8')
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const [ts, cpu, rss, tps, online, max] = line.split(' ')
    const at = Number(ts)
    const row = { at, cpu: Number(cpu), rss: Number(rss) }
    if (!Object.values(row).every(Number.isFinite) || row.at <= 0 || row.cpu < 0 || row.cpu > 100 || row.rss < 0) continue
    // "-" marks a figure the server didn't answer; leave it off the row
    if (figure(tps) !== null) row.tps = figure(tps)
    if (figure(online) !== null) row.players = figure(online)
    if (figure(max) !== null) row.maxPlayers = figure(max)
    rows.push(row)
  }
  return rows
}

function figure(text) {
  if (text === undefined || text === '' || text === '-') return null
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Newest sample, read from the tail of the file; the panel polls this for every server every
// four seconds. Async because it's on the request path. Null if older than three intervals.
export async function latestSample(name, { now = Date.now() } = {}) {
  let handle
  try {
    handle = await fs.promises.open(metricsFile(name), 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, 512)
    if (!length) return null
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    const [ts, cpu, rss, tps, online, max] = (lines.at(-1) ?? '').split(' ')
    const at = Number(ts)
    if (!Number.isFinite(at) || now / 1000 - at > INTERVAL_SEC * 3) return null
    const row = { at, cpu: Number(cpu), rss: Number(rss) }
    if (!Number.isFinite(row.cpu) || !Number.isFinite(row.rss)) return null
    if (figure(tps) !== null) row.tps = figure(tps)
    if (figure(online) !== null) row.players = figure(online)
    if (figure(max) !== null) row.maxPlayers = figure(max)
    return row
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export const SAMPLE_SECONDS = INTERVAL_SEC
export const CPU_CORES = CORES
