import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import readline from 'node:readline'

import { fail, UserError, readJson, sleep } from './util.mjs'
import { profileDir } from './client-paths.mjs'
import { downloadFile } from './download.mjs'

export const HARNESS_FILE = 'spawnloft-harness.json'

export const HARNESS_RELEASES = [
  { minecraft: '1.21.11', version: '0.1.0', url: 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/v0.1.0-mc1.21.11/spawnloft-harness-0.1.0%2B1.21.11.jar', sha256: '6e97b92cfde87bbd948f8ef4733979ba556337be79ed334b02c6942f2dae0d63' },
]

export function harnessFor(mc) {
  return HARNESS_RELEASES.find(r => r.minecraft === mc) ?? null
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

  await downloadFile(row.url, dest, { hash: 'sha256', expected: row.sha256, onProgress, label: 'harness mod ' + row.version })
  return { installed: true, file: path.basename(dest) }
}

export function readHarnessFile(profileName) {
  const data = readJson(path.join(profileDir(profileName), HARNESS_FILE), null)
  if (data === null || typeof data !== 'object' || typeof data.port !== 'number') return null
  return data
}

export async function connectHarness(profileName, token, { timeout = 5000 } = {}) {
  const info = readHarnessFile(profileName)
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

  return { call, close, hello: helloResult }
}

export async function waitForHarness(profileName, token, { timeout = 90000, alive = () => true } = {}) {
  const start = Date.now()
  for (;;) {
    if (!alive()) {
      fail('the client exited before its harness answered')
    }
    const info = readHarnessFile(profileName)
    if (info) {
      try {
        return await connectHarness(profileName, token, { timeout: 2000 })
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
