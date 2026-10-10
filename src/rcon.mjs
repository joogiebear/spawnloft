import net from 'node:net'
import { UserError, sleep } from './util.mjs'

const TYPE_AUTH = 3
const TYPE_AUTH_RESPONSE = 2
const TYPE_COMMAND = 2
const TYPE_RESPONSE = 0

// A packet's length field counts id (4) + type (4) + body + two terminator bytes, so the smallest
// legal packet is 10. Minecraft caps a body at 4096 bytes, which makes 4110 the largest. Anything
// outside that is not RCON: a negative or tiny length used to leave the read loop spinning on the
// same bytes forever, and a huge one made it buffer without end waiting for a packet that never came.
const MIN_PACKET_SIZE = 10
const MAX_PACKET_SIZE = 4110

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

// How long an ordinary command may take to answer. The override exists for the tests, which would
// otherwise spend eight seconds every time they need a command to be too slow.
export const RCON_TIMEOUT_MS = Number(process.env.MCCTL_RCON_TIMEOUT_MS) > 0
  ? Number(process.env.MCCTL_RCON_TIMEOUT_MS)
  : 8000

/**
 * Minimal RCON client. Speaks the Source protocol Minecraft uses.
 *
 * Responses larger than 4096 bytes arrive split across packets with no length
 * hint, so after each command we send a sentinel packet with a distinct id and
 * treat its echo as end-of-response.
 *
 * <p>The sentinel goes out once the server has begun to answer, never along with the command.
 * Minecraft's RCON thread reads one packet at a time and hangs up on a read that holds two, and
 * two packets written back to back land in one read often enough to matter. Against a real server
 * (Advanced Slime Paper 26.3, on Windows) between one and seventeen commands in a hundred were
 * hung up on, depending on the run, and a command and its marker forced into one segment were hung
 * up on every time. Sent after the first reply packet, the marker is alone in the socket when the
 * thread reads it, and the server answers it after the rest of the reply, as before.
 *
 * <p>That makes the first reply packet the proof that the command was read. Minecraft always
 * sends one, an empty one for a command with nothing to say. A server that sent none would now
 * time out where the marker's echo used to complete the command.
 */
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
          // Nothing is listening: a server that is down, as opposed to one that is up and not
          // answering. Callers that must tell the two apart read `refused`, not the message. Not
          // `code`: that is what the CLI's JSON errors and the panel's error bodies hand to
          // whoever is calling, and it has been COMMAND_FAILED for this.
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

  /** The peer is not speaking RCON. Drop the connection and fail whatever was waiting on it. */
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
      const body = this.buffer.subarray(12, 4 + size - 2).toString('utf8')
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

    // Sentinel echo closes whichever command is waiting on it.
    for (const [cmdId, entry] of this.pending) {
      if (id === entry.sentinelId) {
        this.pending.delete(cmdId)
        entry.resolve(entry.chunks.join(''))
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
      // Nothing tells a socket that was closed earlier about what is written to it afterwards, so
      // a command sent on one would wait out the whole timeout for an answer that cannot come.
      // Closed by the server, or by close() here: neither can be written to.
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
          // A response may have partially arrived; return what we have.
          if (entry.chunks.length) entry.resolve(entry.chunks.join(''))
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

/** Errors that mean "the socket died", as opposed to "the server said no". */
const TRANSIENT = /connection closed|ECONNRESET|EPIPE|ECONNABORTED|timed out/i
/** The same without the slow ones: a socket that was cut, not a server that took too long. */
const DROPPED = /connection closed|ECONNRESET|EPIPE|ECONNABORTED/i

/**
 * Connect, run one or more commands, disconnect.
 *
 * A fresh connection succeeds where a dropped one did not, so transient socket
 * failures are retried. That used to be needed far more than it should have been:
 * a burst of one-shot commands reliably lost one partway through, which looked like
 * Paper dropping sockets under churn and was the client hanging up on itself (see
 * Rcon). What is retried now is a server that really did drop one. Auth failures and
 * command errors are not retried; they would fail identically.
 *
 * <p>`timeout` is how long a command may take to answer, for one that is expected to be slow.
 * `retryTimeouts: false` is for the same commands: a second attempt after a timeout does not make
 * a slow command faster, it asks again and waits again. A socket that was cut is still retried.
 *
 * <p>An error thrown from here has `unsent: true` when it came before anything could have been
 * written, on any attempt: no port, a refused connection, a wrong password. A caller that has to
 * know whether a command may have run - `save-off`, say - needs that, because a timeout after the
 * write says nothing about what the server did, and one before it says the server did nothing.
 */
export async function rconExec(inst, commands, { attempts = 3, timeout = RCON_TIMEOUT_MS, retryTimeouts = true } = {}) {
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
      if (attempt === attempts || !retryable.test(err.message)) throw Object.assign(err, { unsent: !connected })
      await sleep(120 * attempt)
    } finally {
      rcon.close()
    }
  }
  throw lastErr
}

/**
 * Strip section-sign formatting for terminal display. Covers legacy codes
 * (§a, §l, §r) and Paper's hex form, which is §x followed by six §<hexdigit>
 * pairs - every part of that sequence matches the same character class.
 */
export function stripColors(text) {
  return text.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '')
}
