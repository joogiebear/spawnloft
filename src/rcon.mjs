import net from 'node:net'
import { UserError, sleep } from './util.mjs'

const TYPE_AUTH = 3
const TYPE_AUTH_RESPONSE = 2
const TYPE_COMMAND = 2
const TYPE_RESPONSE = 0

// The length field counts id (4) + type (4) + body + two terminator bytes, so the smallest legal
// packet is 10. Minecraft caps a body at 4096 bytes, making 4110 the largest. Anything outside
// that is not RCON, and must not be waited on.
const MIN_PACKET_SIZE = 10
const MAX_PACKET_SIZE = 4110

// A reply over 4096 bytes is split on a byte boundary that can fall inside a multi-byte
// character, so decode after joining, not per packet.
function decodeChunks(chunks) {
  return Buffer.concat(chunks).toString('utf8')
}

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0) // length excludes the length field
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeInt16LE(0, 12 + payload.length) // body terminator + packet terminator
  return buf
}

// How long a command may take to answer. The env override is for tests.
export const RCON_TIMEOUT_MS = Number(process.env.MCCTL_RCON_TIMEOUT_MS) > 0
  ? Number(process.env.MCCTL_RCON_TIMEOUT_MS)
  : 8000

// Minimal RCON client for the Source protocol Minecraft uses.
//
// Replies over 4096 bytes arrive split across packets with no length hint, so after each command
// a sentinel packet with a distinct id is sent and its echo marks the end of the response.
//
// The sentinel is sent only after the first reply packet, never with the command: Minecraft's
// RCON thread reads one packet at a time and hangs up on a read holding two, which back-to-back
// writes often produce. The first reply packet therefore proves the command was read; Minecraft
// always sends one, empty if there is nothing to say.
export class Rcon {
  constructor({ host = '127.0.0.1', port, password, timeout = RCON_TIMEOUT_MS }) {
    this.host = host
    this.port = port
    this.password = password
    this.timeout = timeout
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      socket.setTimeout(this.timeout)

      const onError = (err) => {
        socket.destroy()
        if (err.code === 'ECONNREFUSED') {
          // Nothing listening (server down), as opposed to up and not answering. Callers read
          // `refused` to tell them apart; not `code`, which the CLI and panel expose as COMMAND_FAILED.
          reject(Object.assign(new UserError(`RCON refused on ${this.host}:${this.port} - is the server running with enable-rcon=true?`), { refused: true }))
        } else {
          reject(new UserError(`RCON connection failed: ${err.message}`))
        }
      }
      socket.once('error', onError)
      socket.once('timeout', () => onError(new Error('connection timed out')))

      socket.once('connect', () => {
        socket.removeListener('error', onError)
        socket.on('error', (err) => this.#failAll(err))
        socket.on('timeout', () => this.#failAll(new Error('RCON timed out')))
        socket.on('data', (chunk) => this.#onData(chunk))
        socket.on('close', () => this.#failAll(new Error('RCON connection closed')))
        this.#auth().then(resolve, reject)
      })
    })
  }

  #failAll(err) {
    const wrapped = err instanceof UserError ? err : new UserError(`RCON error: ${err.message}`)
    for (const { reject } of this.pending.values()) reject(wrapped)
    this.pending.clear()
  }

  // The peer is not speaking RCON: drop the connection and fail whatever was waiting on it.
  #protocolError(size) {
    const err = new UserError(`RCON error: invalid packet length ${size} from ${this.host}:${this.port}`)
    this.buffer = Buffer.alloc(0)
    if (this.authPending) {
      const { reject } = this.authPending
      this.authPending = null
      reject(err)
    }
    this.#failAll(err)
    this.socket?.destroy()
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0)
      if (size < MIN_PACKET_SIZE || size > MAX_PACKET_SIZE) return this.#protocolError(size)
      if (this.buffer.length < size + 4) break
      const id = this.buffer.readInt32LE(4)
      const type = this.buffer.readInt32LE(8)
      const body = Buffer.from(this.buffer.subarray(12, 4 + size - 2))
      this.buffer = this.buffer.subarray(4 + size)
      this.#dispatch(id, type, body)
    }
  }

  #dispatch(id, type, body) {
    if (this.authPending) {
      const { resolve, reject } = this.authPending
      if (type === TYPE_AUTH_RESPONSE || id === -1) {
        this.authPending = null
        if (id === -1) reject(new UserError('RCON authentication failed - wrong rcon.password'))
        else resolve()
        return
      }
    }

    // The sentinel echo closes whichever command is waiting on it.
    for (const [cmdId, entry] of this.pending) {
      if (id === entry.sentinelId) {
        this.pending.delete(cmdId)
        entry.resolve(decodeChunks(entry.chunks))
        return
      }
      if (id === cmdId) {
        entry.chunks.push(body)
        if (!entry.markerSent) {
          entry.markerSent = true
          if (this.socket.writable) this.socket.write(encodePacket(entry.sentinelId, TYPE_RESPONSE, ''))
        }
        return
      }
    }
  }

  #auth() {
    return new Promise((resolve, reject) => {
      this.authPending = { resolve, reject }
      this.socket.write(encodePacket(0, TYPE_AUTH, this.password))
      setTimeout(() => {
        if (this.authPending) {
          this.authPending = null
          reject(new UserError('RCON authentication timed out'))
        }
      }, this.timeout).unref?.()
    })
  }

  send(command) {
    return new Promise((resolve, reject) => {
      // A command written to an already-closed socket would otherwise wait out the whole timeout.
      if (!this.socket || !this.socket.writable) {
        return reject(new UserError('RCON error: RCON connection closed'))
      }
      const id = this.nextId++
      const sentinelId = this.nextId++
      this.pending.set(id, { resolve, reject, chunks: [], sentinelId, markerSent: false })
      this.socket.write(encodePacket(id, TYPE_COMMAND, command))
      setTimeout(() => {
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          // Return a partial response rather than failing.
          if (entry.chunks.length) entry.resolve(decodeChunks(entry.chunks))
          else reject(new UserError(`RCON command timed out: ${command}`))
        }
      }, this.timeout).unref?.()
    })
  }

  close() {
    this.socket?.end()
    this.socket?.unref?.()
  }
}

// Errors that mean the socket died, as opposed to the server saying no.
const TRANSIENT = /connection closed|ECONNRESET|EPIPE|ECONNABORTED|timed out/i
// The same without timeouts: a cut socket, not a slow server.
const DROPPED = /connection closed|ECONNRESET|EPIPE|ECONNABORTED/i

// Connect, run the commands, disconnect. Transient socket failures are retried on a fresh
// connection; auth failures and command errors are not, since they would fail identically.
//
// `timeout` is for commands expected to be slow; pair it with `retryTimeouts: false`, since
// asking again after a timeout just waits again. A cut socket is still retried.
//
// `retrySent: false` is for typed commands: once connected, a failure is not retried because the
// server may already have run it (`give` or `kill` twice). Failures before that still retry.
//
// Errors carry `unsent: true` when nothing could have been written (no port, refused, wrong
// password). Callers like `save-off` need it: a timeout after the write says nothing about what
// the server did.
export async function rconExec(inst, commands, { attempts = 3, timeout = RCON_TIMEOUT_MS, retryTimeouts = true, retrySent = true } = {}) {
  if (!inst.rcon?.port) {
    throw Object.assign(new UserError(`instance "${inst.name}" has no RCON port configured`), { unsent: true })
  }

  const retryable = retryTimeouts ? TRANSIENT : DROPPED
  let lastErr
  let connected = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const rcon = new Rcon({ port: inst.rcon.port, password: inst.rcon.password, timeout })
    try {
      await rcon.connect()
      connected = true
      const out = []
      for (const cmd of commands) out.push(await rcon.send(cmd))
      return out
    } catch (err) {
      lastErr = err
      if (attempt === attempts || (connected && !retrySent) || !retryable.test(err.message)) throw Object.assign(err, { unsent: !connected })
      await sleep(120 * attempt)
    } finally {
      rcon.close()
    }
  }
  throw lastErr
}

// Strips section-sign codes: legacy (§a, §l, §r) and Paper's hex form (§x then six §<hexdigit>
// pairs), all of which match the same character class.
export function stripColors(text) {
  return text.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '')
}
