import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

// `stat` has cumulative CPU in clock ticks and the start time, which identifies the process so a
// reused PID can't continue the graph. The command name may contain spaces and brackets, so
// fields are counted from the last ")". `status` has resident memory in KiB.
export function parseProcSample(stat, status, ticksPerSecond) {
  const close = String(stat).lastIndexOf(')')
  const fields = close < 0 ? [] : String(stat).slice(close + 2).trim().split(/\s+/)
  // field 3 (state) is the first after the name; utime is 14, stime 15, starttime 22
  const [utime, stime, identity] = [fields[11], fields[12], fields[19]]
  const resident = /^VmRSS:\s+(\d+)\s+kB$/m.exec(String(status))
  if (!/^\d+$/.test(utime ?? '') || !/^\d+$/.test(stime ?? '') || !/^\d+$/.test(identity ?? '')) {
    throw new Error('Linux returned an unreadable process measurement')
  }
  // zombies and kernel threads have no VmRSS line
  const bytes = resident ? Number(resident[1]) * 1024 : 0
  const seconds = (Number(utime) + Number(stime)) / ticksPerSecond
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(bytes)) throw new Error('Linux returned an invalid process measurement')
  return { seconds, bytes, identity }
}

// Usually 100, but it's a kernel build option and a wrong value scales the whole CPU graph.
let ticks = null
export function clockTicks() {
  if (ticks) return ticks
  const res = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 3000 })
  const said = Number(String(res.stdout ?? '').trim())
  ticks = Number.isInteger(said) && said > 0 ? said : 100
  return ticks
}

export function startLinuxSampler(pid, {
  onSample, onError, intervalMs = 10000, read = fs.promises.readFile,
  ticksPerSecond = clockTicks(), now = () => Date.now() / 1000,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    onError(new Error('Cannot measure a process without a valid PID'))
    return () => {}
  }
  let stopped = false
  let timer = null
  let identity = null

  function stop() {
    stopped = true
    clearTimeout(timer)
  }

  async function query() {
    if (stopped) return
    try {
      const [stat, status] = await Promise.all([read(`/proc/${pid}/stat`, 'utf8'), read(`/proc/${pid}/status`, 'utf8')])
      if (stopped) return
      const sample = parseProcSample(stat, status, ticksPerSecond)
      if (identity !== null && sample.identity !== identity) { stop(); return }
      identity = sample.identity
      onSample({ at: now(), seconds: sample.seconds, bytes: sample.bytes })
    } catch (error) {
      if (stopped) return
      stop()
      // process exited, possibly between the two reads
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') onError(error)
      return
    }
    timer = setTimeout(query, intervalMs)
  }

  timer = setTimeout(query, 0)
  return stop
}
