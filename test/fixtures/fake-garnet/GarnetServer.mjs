/**
 * Stands in for GarnetServer: takes the flags the real one takes, listens on loopback, speaks
 * enough of the Redis protocol for AUTH, PING, SAVE, SET/GET and SHUTDOWN, and says it is ready
 * the way Redis does. FAKE_GARNET_FAIL=start makes it die on the port the way a taken one does.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const argv = process.argv
const flag = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1] }
const port = Number(flag('--port'))
const bind = flag('--bind') ?? '127.0.0.1'
const password = flag('--password')
const checkpoints = flag('--checkpointdir')
const say = (l) => process.stdout.write(`[${new Date().toISOString()}] ${l}\n`)

say(`fake Garnet starting: ${argv.slice(2).join(' ')}`)
if (process.env.FAKE_GARNET_FAIL === 'start') {
  process.stdout.write('Unhandled exception. System.Net.Sockets.SocketException: Address already in use\n')
  process.exit(1)
}

const store = new Map()
function parse(buf) {
  if (!buf.startsWith('*')) return null
  const nl = buf.indexOf('\r\n')
  if (nl === -1) return null
  const n = Number(buf.slice(1, nl))
  let rest = buf.slice(nl + 2)
  const items = []
  for (let i = 0; i < n; i++) {
    if (!rest.startsWith('$')) return null
    const e = rest.indexOf('\r\n')
    if (e === -1) return null
    const len = Number(rest.slice(1, e))
    if (rest.length < e + 2 + len + 2) return null
    items.push(rest.slice(e + 2, e + 2 + len))
    rest = rest.slice(e + 2 + len + 2)
  }
  return { items, rest }
}

const server = net.createServer((socket) => {
  let buf = ''
  let authed = !password
  socket.on('data', (c) => {
    buf += c.toString()
    for (;;) {
      const r = parse(buf)
      if (!r) break
      buf = r.rest
      const [cmd, ...args] = r.items
      const op = String(cmd).toUpperCase()
      if (op === 'AUTH') {
        authed = args[args.length - 1] === password
        socket.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n')
      } else if (!authed) {
        socket.write('-NOAUTH Authentication required.\r\n')
      } else if (op === 'PING') socket.write('+PONG\r\n')
      else if (op === 'SET') { store.set(args[0], args[1]); socket.write('+OK\r\n') }
      else if (op === 'GET') { const v = store.get(args[0]); socket.write(v == null ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`) }
      else if (op === 'SAVE' && checkpoints && fs.existsSync(path.join(checkpoints, 'fail-save'))) socket.write('-ERR checkpoint failed\r\n')
      else if (op === 'SAVE') { if (checkpoints) { fs.mkdirSync(checkpoints, { recursive: true }); fs.writeFileSync(path.join(checkpoints, 'checkpoint.txt'), String(Date.now())) } socket.write('+OK\r\n') }
      else if (op === 'SHUTDOWN') { say('User requested shutdown...'); socket.end(); setTimeout(() => process.exit(0), 50) }
      else socket.write(`-ERR unknown command '${cmd}'\r\n`)
    }
  })
  socket.on('error', () => {})
})
server.listen(port, bind, () => setTimeout(() => say('Ready to accept connections'), 150))
server.on('error', (err) => { process.stdout.write(`Unhandled exception: ${err.message}\n`); process.exit(1) })
setInterval(() => {}, 1 << 30)
