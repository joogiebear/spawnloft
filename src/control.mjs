import net from 'node:net'
import fs from 'node:fs'
import { controlPath, stateFile } from './paths.mjs'
import { readJson, pidAlive, sameProcess, UserError } from './util.mjs'

export function controlRequest(name, req, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath(name))
    let buf = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new UserError(`control request "${req.op}" timed out for "${name}"`))
    }, timeout)

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      fn(arg)
    }

    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try {
        finish(resolve, JSON.parse(buf.slice(0, nl)))
      } catch (err) {
        finish(reject, new UserError(`bad response from daemon: ${err.message}`))
      }
    })
    // a daemon that closes without answering (exited mid-request) would otherwise leave this waiting out the whole timeout
    socket.on('close', () => {
      finish(reject, new UserError(`daemon for "${name}" closed the connection without replying to "${req.op}"`))
    })
    socket.on('error', (err) => {
      const notRunning = ['ENOENT', 'ECONNREFUSED'].includes(err.code)
      finish(
        reject,
        notRunning
          ? new UserError(`instance "${name}" is not running`)
          : new UserError(`control channel error: ${err.message}`),
      )
    })
  })
}

// Reconciles the state file against live pids, so a crashed daemon reads as stopped. The pid must be
// alive and still the same executable: Windows reuses pids within minutes, so a stale state file could
// point at an unrelated process.
export function readState(name) {
  const state = readJson(stateFile(name), null)
  if (!state) return { status: 'stopped', state: null }

  const daemonUp = pidAlive(state.daemonPid) && sameProcess(state.daemonPid, state.daemonExe, state.startedAt)
  const javaUp = pidAlive(state.javaPid) && sameProcess(state.javaPid, state.javaExe, state.startedAt)

  if (state.running && daemonUp && javaUp) return { status: 'running', state }
  if (state.running && !daemonUp && javaUp) return { status: 'orphaned', state }
  if (state.running && daemonUp && !javaUp) return { status: 'stopping', state }
  if (state.running && !daemonUp && !javaUp) return { status: 'stale', state }
  return { status: 'stopped', state }
}

// "running" is one of three active statuses. "stopping" (shutdown, or the pause before a crash restart)
// has a daemon that can relaunch java at any moment; "orphaned" has no daemon but java still holds the
// world and port. All of them own the files, so guards before a deletion, restore or rename use this.
// "running" alone is for "can I talk to it" (console line, player counts).
export const ACTIVE_STATUSES = ['running', 'stopping', 'orphaned']

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status)
}

// Why an operation on this instance's files has to wait, or null. The way out differs by status (an
// orphaned server can only be killed, so "stop it first" would send people to a command that refuses),
// hence one message builder. verb is what the caller was about to do, e.g. "deleting it".
export function activeBlock(name, verb) {
  const { status, state } = readState(name)
  if (status === 'running') return `"${name}" is running - stop it before ${verb}.`
  if (status === 'stopping') return `"${name}" is still shutting down - wait for it to finish before ${verb}.`
  if (status === 'orphaned') {
    return `"${name}" has an orphaned java process (pid ${state.javaPid}) with no daemon - run "mcctl kill ${name}" before ${verb}.`
  }
  return null
}

export function clearState(name) {
  try {
    fs.unlinkSync(stateFile(name))
  } catch {
    /* nothing to clear */
  }
}
