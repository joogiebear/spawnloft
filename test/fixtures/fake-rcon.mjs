/**
 * An RCON server stand-in, for tests of what a client does when a server is slow or goes away.
 *
 * <p>It speaks the Source protocol the way Minecraft does and handles each connection's packets
 * one at a time, in order, like the per-client thread Minecraft gives it: a slow command holds up
 * the packet behind it, which is what keeps the client's end-of-reply marker last. It is not
 * Minecraft - it cannot say what a real server logs or when a real one drops a socket - so
 * everything it reports is a measurement of the CLIENT: what arrived, on which connection, in
 * what order.
 *
 * <ul>
 *   <li>`delays`    - `{ 'save-all flush': 800 }` holds that command's reply for 800 ms.</li>
 *   <li>`drop`      - `{ 'save-on': 1 }` closes the connection, without replying, the first time
 *       that command arrives; `Infinity` does it every time.</li>
 *   <li>`stopAfter` - a command after whose reply the server goes away entirely, so that the next
 *       connection is refused, the way it is once a server has stopped.</li>
 * </ul>
 */
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

function packet(id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  return buf
}

const REPLIES = {
  'save-off': 'Automatic saving is now disabled',
  'save-all flush': 'Saved the game',
  'save-on': 'Automatic saving is now enabled',
}

export async function startFakeRcon({ password = 'pw', delays = {}, drop = {}, stopAfter = null } = {}) {
  const live = new Set()
  const commands = []
  const dropped = {}
  let connections = 0
  let stopping = false

  const server = net.createServer((socket) => {
    const conn = ++connections
    live.add(socket)
    // Cancels a reply still being held for a client that has already gone.
    const gone = new AbortController()
    let buf = Buffer.alloc(0)
    let authed = false
    let queue = Promise.resolve()

    socket.on('error', () => {})
    socket.on('close', () => {
      live.delete(socket)
      gone.abort()
    })
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0)
        if (buf.length < size + 4) break
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const body = buf.subarray(12, 4 + size - 2).toString('utf8')
        buf = buf.subarray(4 + size)
        queue = queue.then(() => handle(id, type, body)).catch(() => {})
      }
    })

    async function handle(id, type, body) {
      if (socket.destroyed) return
      if (type === 3) {
        authed = body === password
        socket.write(packet(authed ? id : -1, 2, ''))
      } else if (type === 2 && authed) {
        commands.push({ conn, cmd: body })
        if ((dropped[body] ?? 0) < (drop[body] ?? 0)) {
          dropped[body] = (dropped[body] ?? 0) + 1
          socket.destroy()
          return
        }
        if (delays[body]) await sleep(delays[body], undefined, { signal: gone.signal, ref: false })
        socket.write(packet(id, 0, REPLIES[body] ?? ''))
        if (body === stopAfter) stopping = true
      } else {
        // What Minecraft answers to a packet type it does not know - which is how the client's
        // sentinel packet finds the end of a reply.
        socket.write(packet(id, 0, `Unknown request ${type.toString(16)}`))
        // Only once that marker is out: a client whose connection is cut before it has the whole
        // reply sees a dropped connection, not a server that answered and then stopped.
        if (stopping) setImmediate(() => stop())
      }
    }
  })

  function stop() {
    for (const socket of live) socket.destroy()
    return new Promise((resolve) => server.close(resolve))
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    /** Every command that reached the server, in arrival order: `{ conn, cmd }`. */
    commands,
    /** Just the command text, in arrival order. */
    sent: () => commands.map((c) => c.cmd),
    close: stop,
  }
}
