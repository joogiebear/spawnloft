import fs from 'node:fs'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { statusOf } from './supervisor.mjs'
import { readSamples, SAMPLE_SECONDS, CPU_CORES } from './metrics.mjs'
import { platformCapabilities } from './platform.mjs'
import { jsonLine, checkFlags, instanceName, UsageError } from './cli-output.mjs'

export function readMetrics(name, seconds) {
  const state = statusOf(name)
  const cutoff = seconds === undefined ? 0 : Date.now() / 1000 - seconds
  return {
    instance: name, runId: state.startedAt === null ? null : `${name}:${state.startedAt}`,
    startedAt: state.startedAt, running: state.status === 'running',
    samplingAvailable: platformCapabilities().performance,
    sampleSeconds: SAMPLE_SECONDS, cores: CPU_CORES, cpuScale: 'whole-machine',
    samples: readSamples(name, { strict: true }).filter(row => row.at >= cutoff).map(row => ({
      timestamp: new Date(row.at * 1000).toISOString(), at: row.at, cpuPercent: row.cpu, rssMiB: row.rss,
    })),
  }
}

const CSV_HEADER = 'instance,run_id,timestamp,cpu_percent,rss_mib,cores\n'
const csvField = value => '"' + String(value ?? '').replaceAll('"', '""') + '"'
export function metricsCsv(data, header = true) {
  return (header ? CSV_HEADER : '') + data.samples.map(row =>
    [csvField(data.instance), csvField(data.runId), row.timestamp, row.cpuPercent, row.rssMiB, data.cores].join(',') + '\n').join('')
}

/** A run change resets the cursor; trimming a history file does not. Timestamp is
 * unique at the sampler's ten-second cadence. It also handles a clock moving back. */
export function metricCursor() {
  let runId
  let lastAt = null
  let seen = new Set()
  return data => {
    const newest = data.samples.at(-1)?.at ?? null
    const reset = runId !== undefined && (runId !== data.runId || (newest !== null && lastAt !== null && newest < lastAt))
    if (runId === undefined || reset) { seen = new Set(); lastAt = null }
    const rows = data.samples.filter(row => !seen.has(row.at))
    // A trim briefly truncates the file before rewriting it. An empty read during
    // that window must not make every old row look new on the next poll.
    if (data.samples.length) seen = new Set(data.samples.map(row => row.at))
    runId = data.runId
    if (newest !== null) lastAt = newest
    return { reset, rows }
  }
}

export async function cmdMetrics(positional, flags) {
  checkFlags(flags, ['json', 'csv', 'follow', 'seconds', 'output'])
  const name = instanceName(positional, 'metrics')
  for (const key of ['json', 'csv', 'follow']) {
    if (flags[key] !== undefined && typeof flags[key] !== 'boolean') throw new UsageError(`--${key} does not take a value`)
  }
  if (flags.json && flags.csv) throw new UsageError('Choose --json or --csv, not both')
  const seconds = flags.seconds === undefined ? undefined : Number(flags.seconds)
  if (seconds !== undefined && (flags.seconds === true || !Number.isFinite(seconds) || seconds <= 0)) {
    throw new UsageError('--seconds must be a positive number')
  }
  if (flags.output !== undefined && (!flags.csv || flags.follow || typeof flags.output !== 'string' || !flags.output)) {
    throw new UsageError('--output <file> requires --csv without --follow')
  }
  const first = readMetrics(name, seconds)
  if (flags.output) {
    // Exclusive creation protects previous test runs and arbitrary existing files.
    fs.writeFileSync(flags.output, metricsCsv(first), { flag: 'wx' })
    process.stderr.write(`Exported ${first.samples.length} measurements to ${flags.output}\n`)
    return
  }
  const controller = new AbortController()
  const write = async text => {
    if (text && !controller.signal.aborted && !process.stdout.write(text)) {
      try { await once(process.stdout, 'drain', { signal: controller.signal }) }
      catch (error) { if (error.name !== 'AbortError') throw error }
    }
  }
  const textRows = data => data.samples.map(row => `${row.timestamp}  CPU ${row.cpuPercent.toFixed(1)}%  Memory ${row.rssMiB} MiB\n`).join('')
  if (!flags.follow) {
    await write(flags.json ? jsonLine('metrics', first) : flags.csv ? metricsCsv(first)
      : `Performance: ${name} (${first.cores} cores; CPU is a share of the whole machine)\n`
        + (first.samples.length ? textRows(first) : 'No measurements in this range.\n'))
    return
  }

  const interrupt = () => { process.exitCode = 130; controller.abort() }
  const terminate = () => { process.exitCode = 143; controller.abort() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const cursor = metricCursor()
    cursor(first)
    await write(flags.json ? jsonLine('metrics', first, { type: 'snapshot' })
      : flags.csv ? metricsCsv(first) : textRows(first))
    while (!controller.signal.aborted) {
      try { await sleep(1000, null, { signal: controller.signal }) }
      catch (error) { if (error.name === 'AbortError') break; throw error }
      const data = readMetrics(name, seconds)
      const { reset, rows } = cursor(data)
      if (reset && flags.json) await write(jsonLine('metrics', { ...data, samples: [] }, { type: 'reset' }))
      else if (reset && !flags.csv) await write('Server run changed; starting a fresh series.\n')
      for (const row of rows) {
        await write(flags.json ? jsonLine('metrics', { instance: name, runId: data.runId, cores: data.cores, ...row }, { type: 'sample' })
          : flags.csv ? metricsCsv({ ...data, samples: [row] }, false) : textRows({ samples: [row] }))
      }
    }
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
