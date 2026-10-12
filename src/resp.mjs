import net from 'node:net'
import { UserError } from './util.mjs'

// Minimal Redis protocol client, enough for PING, SAVE and SHUTDOWN. Garnet ships no admin tool.

function encode(args) {
  let out = `*${args.length}\r\n`
  for (const a of args) {
    const s = String(a)
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`
  }
  return out
}

// returns { value, rest }, or null when the reply is incomplete
function parse(buf) {
  const nl = buf.indexOf('\r\n')
  if (nl === -1) return null
  const head = buf.slice(0, nl)
  const kind = head[0]
  const body = head.slice(1)
  if (kind === '+' || kind === ':') return { value: body, rest: buf.slice(nl + 2) }
  if (kind === '-') return { value: null, error: body, rest: buf.slice(nl + 2) }
  if (kind === '$') {
    const len = Number(body)
    if (len === -1) return { value: null, rest: buf.slice(nl + 2) }
    const end = nl + 2 + len
    if (buf.length < end + 2) return null
    return { value: buf.slice(nl + 2, end), rest: buf.slice(end + 2) }
  }
  if (kind === '*') {
    const n = Number(body)
    let rest = buf.slice(nl + 2)
    const items = []
    for (let i = 0; i < n; i++) {
      const r = parse(rest)
      if (!r) return null
      items.push(r.value)
      rest = r.rest
    }
    return { value: items, rest }
  }
  return { value: head, rest: buf.slice(nl + 2) }
}

// Sends commands in order and returns the last reply. AUTH goes first when a password is given.
export function respSend(host, port, commands, { password = null, timeout = 5000 } = {}) {
  const queue = [...(password ? [['AUTH', password]] : []), ...commands]
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let buf = ''
    let sent = 0
    let last = null
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(v)
    }
    const timer = setTimeout(() => done(reject, new UserError(`no reply from ${host}:${port} within ${timeout}ms`)), timeout)
    const next = () => {
      if (sent >= queue.length) return done(resolve, last)
      socket.write(encode(queue[sent++]))
    }
    socket.on('connect', next)
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        const r = parse(buf)
        if (!r) break
        buf = r.rest
        if (r.error) return done(reject, new UserError(`${host}:${port} refused: ${r.error}`))
        last = r.value
        next()
      }
    })
    socket.on('close', () => {
      // SHUTDOWN closes the socket instead of replying, so the close is the answer
      if (sent >= queue.length && queue[queue.length - 1]?.[0] === 'SHUTDOWN') done(resolve, last ?? 'OK')
      else done(reject, new UserError(`${host}:${port} closed the connection`))
    })
    socket.on('error', (err) => done(reject, new UserError(`could not reach ${host}:${port}: ${err.message}`)))
  })
}

export async function respPing(host, port, { password = null } = {}) {
  const reply = await respSend(host, port, [['PING']], { password })
  return reply === 'PONG' || (Array.isArray(reply) && reply[0] === 'PONG')
}
