// Stand-in RCON server for testing what a client does when the server is slow or goes away.
// Packets on a connection are handled one at a time, in order, like Minecraft's per-client thread,
// so a slow command holds up the packet behind it and the end-of-reply marker stays last. It
// cannot say what a real server logs or when it drops a socket: what it reports (commands,
// connections, hangups) is a measurement of the client.
//
// Options:
//   delays     { 'save-all flush': 800 } holds that command's reply for 800 ms.
//   drop       { 'save-on': 1 } closes the connection without replying the first time that
//              command arrives; Infinity does it every time.
//   stopAfter  a command after whose reply the server goes away, so the next connection is refused.
//   strict     reads like Minecraft's RCON thread: one read() at a time, expecting exactly one
//              packet, hanging up on a read that holds more. On a real machine whether two packets
//              written back to back share a read is a race; here the thread wakes a few ms after
//              the first byte, so they always do and a client that writes two at once is hung up on.
//   replies    replies by command, over the defaults. A reply over 4096 bytes goes out in several
//              packets, as Minecraft sends it.
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

function packet(id, type, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
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
  tps: '\u00a76TPS from last 1m, 5m, 15m: \u00a7a*20.0\u00a7r, \u00a7a*20.0\u00a7r, \u00a7a*20.0',
  mspt: '\u00a76Server tick times (avg/min/max) from last 5s, 10s, 1m:\n\u00a7a2.1/1.0/9.9',
  list: 'There are 0 of a max of 20 players online: ',
}

// How long Minecraft's RCON thread takes to wake after the first byte of a packet arrives; a second
// packet written straight after it lands in the same read.
const WAKE_MS = 3
// Size of the single read it does.
const READ_BYTES = 1460

export async function startFakeRcon({ password = 'pw', delays = {}, drop = {}, stopAfter = null, strict = false, replies = {} } = {}) {
  const live = new Set()
  const commands = []
  const dropped = {}
  const answers = { ...REPLIES, ...replies }
  let connections = 0
  let hangups = 0
  let stopping = false

  const server = net.createServer((socket) => {
    const conn = ++connections
    live.add(socket)
    // Cancels a held reply when the client has gone.
    const gone = new AbortController()
    let buf = Buffer.alloc(0)
    let authed = false
    let queue = Promise.resolve()

    socket.on('error', () => {})
    socket.on('close', () => {
      live.delete(socket)
      gone.abort()
    })
    let waking = false
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!strict) return parse()
      if (!waking) {
        waking = true
        setTimeout(read, WAKE_MS)
      }
    })

    function parse() {
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0)
        if (buf.length < size + 4) break
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const body = buf.subarray(12, 4 + size - 2).toString('utf8')
        buf = buf.subarray(4 + size)
        queue = queue.then(() => handle(id, type, body)).catch(() => {})
      }
    }

    // One read of whatever has arrived. It must be exactly one packet, as the length at its front
    // says, or the connection ends.
    function read() {
      waking = false
      if (socket.destroyed || !buf.length) return
      const got = Math.min(buf.length, READ_BYTES)
      if (got < 10 || buf.readInt32LE(0) !== got - 4) {
        hangups++
        socket.destroy()
        return
      }
      parse()
    }

    // Minecraft splits a reply into pieces of at most 4096 bytes; an empty reply is one empty piece.
    function respond(id, text) {
      let rest = Buffer.from(text, 'utf8')
      do {
        socket.write(packet(id, 0, rest.subarray(0, 4096)))
        rest = rest.subarray(4096)
      } while (rest.length)
    }

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
        respond(id, answers[body] ?? '')
        if (body === stopAfter) stopping = true
      } else {
        // Minecraft's answer to an unknown packet type, which is how the client's sentinel packet
        // finds the end of a reply.
        socket.write(packet(id, 0, `Unknown request ${type.toString(16)}`))
        // Stop only once the marker is out, so a client never sees a cut connection mid-reply.
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
    // Every command that reached the server, in arrival order: { conn, cmd }.
    commands,
    sent: () => commands.map((c) => c.cmd),
    connections: () => connections,
    // Times a strict server hung up on a read that held more than one packet.
    hangups: () => hangups,
    close: stop,
  }
}
