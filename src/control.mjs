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

export function clearState(name) {
  try {
    fs.unlinkSync(stateFile(name))
  } catch {
    /* nothing to clear */
  }
}
