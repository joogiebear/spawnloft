import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { runDir } from './paths.mjs'
import { startDarwinSampler } from './metrics-darwin.mjs'

/**
 * How hard a server is working, over time.
 *
 * <p>Node can measure its own CPU and nothing else's, and the thing worth measuring is the java
 * process the daemon started. Windows will report it, but only through a tool: Get-Process gives
 * total processor seconds and working set for any pid.
 *
 * <p>Calling that once per sample would mean spawning PowerShell every ten seconds for as long as
 * the server runs, which is a process launch per sample to read two numbers. Instead one PowerShell
 * is started with the server and left running, refreshing the same process object in a loop and
 * printing a line each time. One extra process for the life of the server, not one per reading.
 * macOS supplies the same cumulative CPU time and resident memory through a short asynchronous
 * /bin/ps query. Its moving-average %cpu field has a different time window, so it is not used.
 *
 * <p>Samples go to a plain text file in the run directory rather than being held in memory,
 * because the thing that reads them is the panel, in a different process, possibly started after
 * the server was.
 */

/** Ten seconds. Four hours of history is 1440 samples, which is a file of about thirty kilobytes. */
const INTERVAL_SEC = 10

/** Five hours kept, so the four-hour view is always full rather than filling up as you watch. */
const KEEP = 1800

/** Trimmed in batches; rewriting the file every ten seconds to drop one line is not worth it. */
const TRIM_AT = KEEP + 600

export function metricsFile(name) {
  return path.join(runDir(name), 'metrics.log')
}

/**
 * CPU as a share of the whole machine, the way Task Manager counts it.
 *
 * <p>Per-core would read above 100% and invite the question of how many cores there are. This does
 * not, at the cost of a server pinning one core of sixteen looking quiet - so the core count is
 * reported alongside and the panel says what the number is a share of.
 */
const CORES = Math.max(1, os.cpus()?.length || 1)

/**
 * Watch a process until it exits.
 *
 * <p>Returns a function that stops watching. Failure to start the sampler is not failure to start
 * the server: a graph is worth less than the thing it graphs, so this reports and gives up rather
 * than taking the daemon down with it.
 */
export function startSampler(name, pid, { onError = () => {} } = {}) {
  if (!['win32', 'darwin'].includes(process.platform)) {
    onError(new Error('performance sampling is only implemented on Windows and macOS'))
    return () => {}
  }

  const file = metricsFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  let written = 0
  const record = sampleRecorder((sample) => {
    fs.appendFileSync(file, `${sample.at} ${sample.cpu.toFixed(1)} ${sample.rss}\n`)
    if (++written % 60 === 0) trim(file)
  })
  if (process.platform === 'darwin') {
    return startDarwinSampler(pid, { onSample: record, onError, intervalMs: INTERVAL_SEC * 1000 })
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    // Every number is printed in the invariant culture. PowerShell formats a double with the
    // machine's decimal separator otherwise, so on a German Windows the CPU figure arrives as
    // "29,765" and parses as 29 - a wrong graph rather than a missing one.
    '$inv = [System.Globalization.CultureInfo]::InvariantCulture',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if (-not $p) { exit 0 }',
    'while ($true) {',
    '  try { $p.Refresh() } catch { break }',
    '  if ($p.HasExited) { break }',
    // ToUnixTimeSeconds, not Get-Date -UFormat %s: that is culture-formatted too. And the line
    // is concatenated rather than built with -f, because the cast in `[int][double]::Parse(x), a, b`
    // binds to the whole comma list instead of the first item and the format silently produced
    // nothing at all.
    '  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
    '  $c = $p.CPU',
    '  if ($null -eq $c) { $c = 0 }',
    // Written through [Console] and flushed: PowerShell buffers its own output pipeline, and a
    // sample that arrives in a batch ten minutes later is not a sample of anything useful.
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
    try { ps.kill() } catch { /* already gone with the server */ }
  }
}

/** Both native collectors supply cumulative CPU seconds and resident bytes. Keep the
 * conversion shared so the same workload has the same scale on Mac and Windows.
 * A reset counter, clock adjustment, or long sleep starts a new baseline, not a spike. */
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

function trim(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= TRIM_AT) return
    fs.writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n')
  } catch {
    /* a sample lost to a locked file is one gap in a graph */
  }
}

/**
 * Every sample kept for this server, oldest first.
 *
 * <p>Unfiltered on purpose. Windowing happens in the caller, which needs to know both what falls
 * inside the range and whether anything falls outside it - a stopped server whose history is older
 * than the chosen window has plenty recorded, and telling someone "nothing recorded" because they
 * were looking at the last five minutes is a lie about their own data.
 */
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
    const [ts, cpu, rss] = line.split(' ')
    const at = Number(ts)
    const row = { at, cpu: Number(cpu), rss: Number(rss) }
    if (!Object.values(row).every(Number.isFinite) || row.at <= 0 || row.cpu < 0 || row.cpu > 100 || row.rss < 0) continue
    rows.push(row)
  }
  return rows
}

export const SAMPLE_SECONDS = INTERVAL_SEC
export const CPU_CORES = CORES
