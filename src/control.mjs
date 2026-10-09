import net from 'node:net'
import fs from 'node:fs'
import { controlPath, stateFile } from './paths.mjs'
import { readJson, pidAlive, sameProcess, UserError } from './util.mjs'

/** Send one request to an instance daemon and await its reply. */
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
    // A daemon that closes the connection without answering (it exited mid-request) would
    // otherwise leave this waiting out the whole timeout - two minutes, or longer for a stop.
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

/**
 * Resolve what is actually true about an instance right now, reconciling the
 * state file against live pids so a crashed daemon reports as stopped rather
 * than as running forever.
 *
 * <p>Alive AND still the same executable. A pid on its own is reused by Windows within minutes of
 * a process ending, so a state file left by a daemon that died could otherwise point at whatever
 * inherited its number and report "running" until someone deleted the file by hand.
 */
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

/**
 * Is anything of this instance still alive?
 *
 * <p>"running" is only one of three answers. A server in its shutdown, or in the pause before a
 * crash restart, is `stopping`: its daemon is up and can relaunch java into the directory at any
 * moment. A server whose daemon died is `orphaned`: nothing supervises it, but java still holds
 * the world and the port. Every one of them owns the files, so every guard in front of a deletion,
 * a restore or a rename asks this, not whether the status is exactly "running".
 *
 * <p>`running` alone stays right where the question is "can I talk to it" - sending a console
 * line, reading player counts, saying a change applies on restart.
 */
export const ACTIVE_STATUSES = ['running', 'stopping', 'orphaned']

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status)
}

/**
 * Why an operation on this instance's files has to wait, or null when it need not.
 *
 * <p>The way out differs by status, which is why the message is built here rather than at each
 * guard: an orphaned server cannot be stopped, only killed, and telling someone to "stop it first"
 * sends them to a command that refuses.
 *
 * @param verb what the caller was about to do, as in "deleting it" or "restoring"
 */
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
