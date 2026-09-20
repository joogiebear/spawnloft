import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

/** Read the kernel's own account of a process. `stat` carries cumulative CPU time in clock ticks
 * and the start time that identifies the process, so a reused PID cannot silently continue its
 * graph. The command name sits in brackets and may itself hold spaces and brackets - "(Server
 * thread)" - so fields are counted from the LAST closing bracket, which is the only safe anchor.
 * `status` carries resident memory in KiB, which spares asking for the page size. */
export function parseProcSample(stat, status, ticksPerSecond) {
  const close = String(stat).lastIndexOf(')')
  const fields = close < 0 ? [] : String(stat).slice(close + 2).trim().split(/\s+/)
  // Field 3 (state) is the first after the name; utime is 14, stime 15, starttime 22.
  const [utime, stime, identity] = [fields[11], fields[12], fields[19]]
  const resident = /^VmRSS:\s+(\d+)\s+kB$/m.exec(String(status))
  if (!/^\d+$/.test(utime ?? '') || !/^\d+$/.test(stime ?? '') || !/^\d+$/.test(identity ?? '')) {
    throw new Error('Linux returned an unreadable process measurement')
  }
  // A zombie, and a kernel thread, have no VmRSS line: the process holds no memory to report.
  const bytes = resident ? Number(resident[1]) * 1024 : 0
  const seconds = (Number(utime) + Number(stime)) / ticksPerSecond
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(bytes)) throw new Error('Linux returned an invalid process measurement')
  return { seconds, bytes, identity }
}

/** Clock ticks per second. 100 on every mainstream kernel build, but it is a build option and the
 * wrong value scales the whole CPU graph, so it is asked once rather than assumed. */
let ticks = null
export function clockTicks() {
  if (ticks) return ticks
  const res = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 3000 })
  const said = Number(String(res.stdout ?? '').trim())
  ticks = Number.isInteger(said) && said > 0 ? said : 100
  return ticks
}

/** Two small file reads per interval. No child process, helper installation, elevated
 * permissions, or persistent service; a read finishes before the next is scheduled. */
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
      // The process is gone, or went between the two reads. That is the end of the graph, not a fault.
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') onError(error)
      return
    }
    timer = setTimeout(query, intervalMs)
  }

  timer = setTimeout(query, 0)
  return stop
}
