import { execFile } from 'node:child_process'

/** Read Apple's ps output without using its moving-average %cpu column. CPU time is
 * cumulative minutes:seconds.hundredths (minutes can exceed 59); RSS is in KiB.
 * lstart identifies the process so a reused PID cannot silently continue its graph. */
export function parsePsSample(text, pid) {
  const match = /^\s*(\d+)\s+(\d+):([0-5]\d(?:\.\d+)?)\s+(\d+)\s+(\S[^\r\n]*)\s*$/.exec(text)
  if (!match || Number(match[1]) !== pid) throw new Error('macOS returned an unreadable process measurement')
  const seconds = Number(match[2]) * 60 + Number(match[3])
  const bytes = Number(match[4]) * 1024
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(bytes)) throw new Error('macOS returned an invalid process measurement')
  return { seconds, bytes, identity: match[5].trim() }
}

/** One short, asynchronous native query per interval. A query finishes before the next
 * is scheduled, and stopping cancels both the timer and any query still in flight.
 * No shell, helper installation, elevated permissions, or persistent Mac service. */
export function startDarwinSampler(pid, {
  onSample, onError, intervalMs = 10000, execute = execFile,
  now = () => Date.now() / 1000,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    onError(new Error('Cannot measure a process without a valid PID'))
    return () => {}
  }
  let stopped = false
  let timer = null
  let child = null
  let identity = null

  function stop() {
    stopped = true
    clearTimeout(timer)
    child?.kill()
    child = null
  }

  function query() {
    if (stopped) return
    child = execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,time=,rss=,lstart='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 8192,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      child = null
      if (stopped) return
      // ps exits 1 with no rows when the process is gone. Any other failure needs a reason.
      if (error?.code === 1 && !String(stdout || '').trim() && !String(stderr || '').trim()) {
        stop()
        return
      }
      try {
        if (error) throw new Error(`macOS process measurement failed: ${error.message}`)
        const sample = parsePsSample(stdout, pid)
        if (identity !== null && sample.identity !== identity) { stop(); return }
        identity = sample.identity
        onSample({ at: now(), seconds: sample.seconds, bytes: sample.bytes })
      } catch (error) {
        stop()
        onError(error)
        return
      }
      timer = setTimeout(query, intervalMs)
    })
  }

  timer = setTimeout(query, 0)
  return stop
}
