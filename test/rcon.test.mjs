import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon, rconExec } from '../src/rcon.mjs'
import { startFakeRcon } from './fixtures/fake-rcon.mjs'
import { startTickSampler } from '../src/tick.mjs'

// Minecraft's RCON thread reads one packet at a time and hangs up on a read that holds two. The
// fake server's `strict` mode does the same, so these tests fail for a client that writes a
// command and its end-of-reply marker back to back - which loses the race on a real server a few
// times in a hundred, on a machine at rest.

const instance = (rcon) => ({ name: 'strict', rcon: { port: rcon.port, password: 'pw' } })

async function connected(t, options) {
  const server = await startFakeRcon({ strict: true, ...options })
  t.after(() => server.close())
  const client = new Rcon({ port: server.port, password: 'pw', timeout: 600 })
  await client.connect()
  t.after(() => client.close())
  return { server, client }
}

test('the strict server hangs up on two packets in one read, as a real one does', async (t) => {
  const server = await startFakeRcon({ strict: true })
  t.after(() => server.close())
  const packet = (id, type, body) => {
    const buf = Buffer.alloc(14 + body.length)
    buf.writeInt32LE(10 + body.length, 0)
    buf.writeInt32LE(id, 4)
    buf.writeInt32LE(type, 8)
    buf.write(body, 12)
    return buf
  }
  const socket = net.createConnection({ host: '127.0.0.1', port: server.port })
  const closed = new Promise((resolve) => socket.on('close', resolve))
  socket.on('error', () => {})
  socket.write(packet(1, 3, 'pw'))
  await new Promise((resolve) => socket.once('data', resolve))
  socket.setNoDelay(true)
  socket.write(Buffer.concat([packet(2, 2, 'list'), packet(3, 0, '')]))
  await Promise.race([closed, sleep(3000, undefined, { ref: false }).then(() => assert.fail('the strict server never hung up'))])
  assert.equal(server.hangups(), 1)
  assert.deepEqual(server.sent(), [], 'it hung up before running anything, so a retry is safe')
})

test('sixty commands in a row go over one connection without being hung up on', async (t) => {
  const { server, client } = await connected(t)
  for (let i = 0; i < 60; i++) assert.match(await client.send('list'), /There are 0 of a max of 20/)
  assert.equal(server.connections(), 1)
  assert.equal(server.hangups(), 0)
})

test('a reply in several packets arrives whole, and the connection is good for the next command', async (t) => {
  const long = 'x'.repeat(10000)
  const { client } = await connected(t, { replies: { big: long } })
  assert.equal((await client.send('big')).length, 10000)
  assert.match(await client.send('list'), /There are 0 of a max of 20/)
})

test('a command with no reply text completes, and so does the one after it', async (t) => {
  const { client } = await connected(t)
  assert.equal(await client.send('say hello'), '')
  assert.match(await client.send('list'), /There are 0 of a max of 20/)
})

test('a command sent on a connection the server has closed fails at once, not after the timeout', async (t) => {
  const { client } = await connected(t, { drop: { tps: 1 } })
  await assert.rejects(client.send('tps'), /connection closed/)
  const started = Date.now()
  await assert.rejects(client.send('mspt'), /connection closed/)
  assert.ok(Date.now() - started < 300, 'a dead socket is not waited on for the 600 ms a live one would get')
})

test('a command sent after close() fails at once too: closing is not the server hanging up, but it ends the same', async (t) => {
  const { client } = await connected(t)
  client.close()
  const started = Date.now()
  await assert.rejects(client.send('list'), /connection closed/)
  assert.ok(Date.now() - started < 300)
})

test('one-shot commands against a strict server need no retries', async (t) => {
  const server = await startFakeRcon({ strict: true })
  t.after(() => server.close())
  for (let i = 0; i < 20; i++) assert.match((await rconExec(instance(server), ['list']))[0], /There are 0 of a max of 20/)
  assert.equal(server.connections(), 20, 'one connection per call: none opened again after a hang-up')
  assert.equal(server.hangups(), 0)
})

test('the tick sampler keeps its one connection across many readings', async (t) => {
  const server = await startFakeRcon({ strict: true })
  t.after(() => server.close())
  const sampler = startTickSampler(instance(server), { intervalMs: 100, timeoutMs: 600 })
  t.after(() => sampler.stop())
  // Until it has read six times and holds a fresh reading, not for as long as that ought to take: a
  // slow runner is given the time, and a sampler that never gets there fails at the deadline.
  const lists = () => server.sent().filter((c) => c === 'list').length
  const deadline = Date.now() + 8000
  let reading = null
  while (Date.now() < deadline) {
    reading = sampler.latest()
    if (reading && lists() >= 6) break
    await sleep(25)
  }
  assert.deepEqual(reading && { tps: reading.tps, online: reading.online, max: reading.max }, { tps: 20, online: 0, max: 20 })
  assert.ok(lists() >= 6, 'it kept reading')
  assert.equal(server.connections(), 1)
  assert.equal(server.hangups(), 0)
})

// A length field outside what RCON allows is not a packet. With -4 the read loop used to keep
// slicing nothing off the buffer for ever, freezing the event loop - timers included - so no
// timeout could rescue the caller. These servers send the bad length and nothing else.
async function badLengthServer(t, size, { afterAuth = false } = {}) {
  const bad = Buffer.alloc(16)
  bad.writeInt32LE(size, 0)
  const ok = Buffer.alloc(14)
  ok.writeInt32LE(10, 0)
  ok.writeInt32LE(0, 4)
  ok.writeInt32LE(2, 8) // auth response, id 0
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => {
      if (afterAuth) {
        socket.write(ok)
        socket.once('data', () => socket.write(bad))
      } else {
        socket.write(bad)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server.address().port
}

for (const size of [-4, 0, 9, 4111, 0x7fffffff]) {
  test(`a length of ${size} fails the connection instead of hanging the client`, async (t) => {
    const port = await badLengthServer(t, size)
    const client = new Rcon({ port, password: 'pw', timeout: 2000 })
    t.after(() => client.close())
    await assert.rejects(client.connect(), /invalid packet length/)
  })
}

test('a bad length after a good login fails the waiting command and drops the socket', async (t) => {
  const port = await badLengthServer(t, -4, { afterAuth: true })
  const client = new Rcon({ port, password: 'pw', timeout: 2000 })
  t.after(() => client.close())
  await client.connect()
  await assert.rejects(client.send('list'), /invalid packet length/)
  await assert.rejects(client.send('list'), /connection closed/)
})

test('the largest legal packet still gets through', async (t) => {
  const big = 'y'.repeat(4096)
  const { client } = await connected(t, { replies: { big } })
  assert.equal(await client.send('big'), big)
})
