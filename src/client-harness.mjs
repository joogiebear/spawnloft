import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import readline from 'node:readline'

import { fail, UserError, readJson, sleep } from './util.mjs'
import { profileDir } from './client-paths.mjs'
import { downloadFile } from './download.mjs'
import { indexRows, harnessJarUrl } from './client-harness-index.mjs'

export const HARNESS_FILE = 'spawnloft-harness.json'

// The builds this SpawnLoft ships knowing, in the signed list's row shape (client-harness-index.mjs).
// More arrive through that list without a release; these win on a conflict, so the list can add a
// version but never swap the jar of one listed here.
export const HARNESS_RELEASES = [
  { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', file: 'spawnloft-harness-0.1.0+1.21.11.jar', sha256: '6e97b92cfde87bbd948f8ef4733979ba556337be79ed334b02c6942f2dae0d63' },
]

// The build for one Minecraft id, { minecraft: mc, version, url, sha256 }, or null. Never waits for
// the network: the signed list is the copy already verified and cached (refreshHarnessIndex fetches).
export function harnessFor(mc, { listed = indexRows() } = {}) {
  const row = HARNESS_RELEASES.find(r => r.minecraft.includes(mc)) ?? listed.find(r => r.minecraft.includes(mc))
  return row ? { minecraft: mc, version: row.version, url: harnessJarUrl(row), sha256: row.sha256 } : null
}

// Every id a harness build is published for, built-in and listed, for messages.
export function publishedHarnessIds({ listed = indexRows() } = {}) {
  return [...new Set([...HARNESS_RELEASES, ...listed].flatMap(r => r.minecraft))]
}

export async function ensureHarnessJar(profileName, mc, { onProgress } = {}) {
  const row = harnessFor(mc)
  if (!row) {
    fail('no harness mod is published for Minecraft ' + mc + '; the profile can still launch without the harness')
  }
  const modsDir = path.join(profileDir(profileName), 'mods')
  const dest = path.join(modsDir, 'spawnloft-harness-' + row.version + '+' + row.minecraft + '.jar')

  if (fs.existsSync(dest)) {
    const buf = fs.readFileSync(dest)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    if (hash === row.sha256) {
      return { installed: false, file: path.basename(dest) }
    }
  }

  fs.mkdirSync(modsDir, { recursive: true })
  const entries = fs.readdirSync(modsDir)
  for (const entry of entries) {
    if (entry === path.basename(dest)) continue
    if (/^spawnloft-harness-.*\.jar$/i.test(entry)) {
      fs.rmSync(path.join(modsDir, entry), { force: true })
    }
  }

  // downloadFile reports { received, total } per chunk; the launch's progress is { phase, done, total, bytes } per file
  await downloadFile(row.url, dest, { hash: 'sha256', expected: row.sha256, label: 'harness mod ' + row.version })
  onProgress?.({ phase: 'harness mod', done: 1, total: 1, bytes: fs.statSync(dest).size })
  return { installed: true, file: path.basename(dest) }
}

// With `pid`, a file left by an earlier run of the game (a crash skips the mod's cleanup) is
// treated as absent: its port may belong to another program by now, and the token must not go there.
export function readHarnessFile(profileName, { pid = null } = {}) {
  const data = readJson(path.join(profileDir(profileName), HARNESS_FILE), null)
  if (data === null || typeof data !== 'object' || typeof data.port !== 'number') return null
  if (pid !== null && data.pid !== pid) return null
  return data
}

export function removeHarnessFile(profileName) {
  fs.rmSync(path.join(profileDir(profileName), HARNESS_FILE), { force: true })
}

export async function connectHarness(profileName, token, { timeout = 5000, pid = null } = {}) {
  const info = readHarnessFile(profileName, { pid })
  if (!info) {
    fail('profile "' + profileName + '" has no running harness')
  }

  const socket = net.connect({ host: '127.0.0.1', port: info.port })

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', (err) => reject(err))
    })
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      fail('connection to the harness was refused: ' + err.message)
    }
    throw err
  }

  let closed = false
  const pending = new Map()
  let nextId = 1

  function rejectAll(msg) {
    if (closed) return
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new UserError(msg))
    }
    pending.clear()
  }

  socket.on('error', () => rejectAll("the client's harness went away"))
  socket.on('close', () => rejectAll("the client's harness went away"))

  const rl = readline.createInterface({ input: socket })
  rl.on('line', (line) => {
    let reply
    try { reply = JSON.parse(line) } catch { return }
    if (!Number.isInteger(reply.id)) return
    const entry = pending.get(reply.id)
    if (!entry) return
    pending.delete(reply.id)
    clearTimeout(entry.timer)
    if (reply.ok === false) {
      entry.reject(new UserError(reply.error))
    } else {
      const { id, ok, ...result } = reply
      entry.resolve(result)
    }
  })

  function call(op, args = {}, { timeout: callTimeout = 10000 } = {}) {
    if (closed) return Promise.reject(new UserError("the client's harness went away"))
    const id = nextId++
    socket.write(JSON.stringify({ id, op, ...args }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new UserError('the harness did not answer ' + op + ' within ' + callTimeout + ' ms'))
      }, callTimeout)
      pending.set(id, { resolve, reject, timer })
    })
  }

  function close() {
    socket.destroy()
  }

  const helloResult = await new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new UserError('the harness did not answer hello within ' + timeout + ' ms'))
    }, timeout)
    pending.set(id, { resolve, reject, timer })
    socket.write(JSON.stringify({ id, op: 'hello', token }) + '\n')
  }).catch(err => {
    socket.destroy()
    if (err instanceof UserError && /went away/.test(err.message)) {
      throw new UserError('the harness refused the token')
    }
    throw err
  })

  // An idle channel must not keep an MCP server alive after its client closes stdin; a pending
  // call still holds the process through its timer.
  socket.unref()

  return { call, close, hello: helloResult }
}

export async function waitForHarness(profileName, token, { timeout = 90000, alive = () => true, pid = null } = {}) {
  const start = Date.now()
  for (;;) {
    if (!alive()) {
      fail('the client exited before its harness answered')
    }
    const info = readHarnessFile(profileName, { pid })
    if (info) {
      try {
        return await connectHarness(profileName, token, { timeout: 2000, pid })
      } catch (err) {
        if (err instanceof UserError) {
          if (/refused the token/.test(err.message)) throw err
          if (/refused|went away/.test(err.message)) {
            // the file can be written a moment before the socket accepts
          } else {
            throw err
          }
        } else {
          throw err
        }
      }
    }
    if (Date.now() - start > timeout) {
      fail('the harness did not answer within ' + Math.round(timeout / 1000) + ' s; see spawnloft client logs ' + profileName)
    }
    await sleep(500)
  }
}
