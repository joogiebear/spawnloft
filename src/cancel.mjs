// Stopping a long job part way: a create that is downloading or building, a game launch that is
// installing.
//
// The job is run inside withCancel(signal, fn). The slow steps underneath it - a download, a child
// process, the gap between two stages - ask this module whether their job has been cancelled; they
// are not each handed the signal. Node carries the job's signal across awaits, timers and stream
// and process events (AsyncLocalStorage), so a step reached through five modules still finds it,
// and code run outside any job finds none and behaves as it always has.
//
// A cancelled step throws Cancelled. What it had made so far is its own to clear away (a .part
// file, a child process); what the job had made is the job's (a half-installed server folder),
// which the creates already do for any failure.
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { UserError } from './util.mjs'

const jobs = new AsyncLocalStorage()

export class Cancelled extends UserError {
  constructor(message = 'Cancelled') {
    super(message)
    this.code = 'cancelled'
  }
}

export const isCancelled = (err) => err instanceof Cancelled || err?.code === 'cancelled'

/** Run fn as a job that `signal` can cancel. */
export function withCancel(signal, fn) {
  return jobs.run(signal ?? null, fn)
}

/** The signal of the job this code is running in, or null outside one. */
export function cancelSignal() {
  return jobs.getStore() ?? null
}

/** Between two steps: stop here if the job has been cancelled. */
export function checkCancelled() {
  if (cancelSignal()?.aborted) throw new Cancelled()
}

/** A wait that cancelling ends: what `promise` settles to, or Cancelled, whichever is first. The
 *  work behind `promise` is not stopped by this; use it where leaving that work to finish is fine. */
export function orCancelled(promise) {
  const signal = cancelSignal()
  if (!signal) return promise
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {})
    return Promise.reject(new Cancelled())
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Cancelled())
    signal.addEventListener('abort', stop, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Ends a child process, and what it started, when the job is cancelled. Returns a function that
 *  says whether that happened, for the child's close handler to tell a cancel from a failure. */
export function stopOnCancel(child, { kill = killTree } = {}) {
  // (start the child with `...OWN_GROUP` so that, off Windows, what it starts can be ended with it)
  const signal = cancelSignal()
  if (!signal) return () => false
  let stopped = false
  const stop = () => {
    stopped = true
    kill(child)
  }
  if (signal.aborted) stop()
  else {
    signal.addEventListener('abort', stop, { once: true })
    child.once('close', () => signal.removeEventListener('abort', stop))
  }
  return () => stopped
}

// Spawn options for a child that a cancel must be able to end together with what it starts. Off
// Windows that takes a process group of its own, which the signal is then sent to; on Windows
// taskkill walks the tree by itself.
export const OWN_GROUP = process.platform === 'win32' ? {} : { detached: true }

// A build runs compilers and git under the Java that was started, and ending only that Java leaves
// them running, writing into the folder the next attempt will use. So the whole tree is ended: by
// taskkill on Windows, by a signal to the child's process group elsewhere (the child alone, if it
// was not given a group). It is asked first and told a few seconds on, on every system.
function killTree(child) {
  const alive = () => child.exitCode === null && child.signalCode === null
  if (!alive() || !child.pid) return
  const signal = (sig) => {
    if (process.platform !== 'win32' && child.spawnargs && isGroupLeader(child)) {
      try { process.kill(-child.pid, sig); return } catch { /* no such group: the child itself, below */ }
    }
    try { child.kill(sig) } catch { /* already gone */ }
  }
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    // taskkill missing, or refusing: the child at least is ended
    tk.on('error', () => signal())
    tk.on('exit', (code) => { if (code !== 0 && alive()) signal() })
  } else {
    signal('SIGTERM')
  }
  const hard = setTimeout(() => { if (alive()) signal('SIGKILL') }, 4000)
  hard.unref()
  child.once('exit', () => clearTimeout(hard))
}

// started with OWN_GROUP: its pid is then its group's id
const groups = new WeakSet()
export function inOwnGroup(child) {
  if (process.platform !== 'win32') groups.add(child)
  return child
}
const isGroupLeader = (child) => groups.has(child)
