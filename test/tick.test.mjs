import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tick-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { parseTps, parseList, readTick, startTickSampler } = await import('../src/tick.mjs')
const { sampleLine, readSamples, latestSample, metricsFile } = await import('../src/metrics.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('Paper TPS is the one-minute figure, capped values included', () => {
  assert.equal(parseTps({ tps: 'TPS from last 1m, 5m, 15m: 19.87, 20.0, 20.0' }), 19.87)
  assert.equal(parseTps({ tps: 'TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0' }), 20)
})

test('vanilla tick query becomes TPS: the target when ticks fit, slower when they do not', () => {
  const query = (ms) => `The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: ${ms}ms (Target: 50.0ms)`
  assert.equal(parseTps({ 'tick query': query('3.2') }), 20)
  assert.equal(parseTps({ 'tick query': query('80.0') }), 12.5)
  assert.equal(parseTps({ 'tick query': 'The game is frozen\nTarget tick rate: 20.0 per second.' }), 0)
  assert.equal(parseTps({ 'tick query': 'something else entirely' }), null)
  assert.equal(parseTps({}), null)
})

test('the player count reads vanilla and Essentials, and guesses at nothing else', () => {
  assert.deepEqual(parseList('There are 2 of a max of 20 players online: Alex, Steve'), { online: 2, max: 20 })
  assert.deepEqual(parseList('There are 0 of a max of 10 players online: '), { online: 0, max: 10 })
  assert.deepEqual(parseList('§6There are §c3§6 out of maximum §c50§6 players online.'), { online: 3, max: 50 })
  assert.equal(parseList('Unknown command'), null)
  assert.equal(parseList(''), null)
})

test('a server that knows tps is not also asked tick query, and a refusal is not an answer', async () => {
  const asked = []
  const paper = await readTick(async (cmd) => {
    asked.push(cmd)
    return { tps: '§6TPS from last 1m, 5m, 15m: §a20.0, §a20.0, §a20.0', mspt: 'Server tick times ...' }[cmd]
  })
  assert.deepEqual(asked, ['tps', 'mspt'])
  assert.equal(paper.tps, 20)
  assert.equal(paper.replies.tps, 'TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0')

  const vanilla = await readTick(async (cmd) => (cmd === 'tick query'
    ? 'Target tick rate: 20.0 per second.\nAverage time per tick: 1.0ms (Target: 50.0ms)'
    : 'Unknown or incomplete command, see below for error'))
  assert.deepEqual(Object.keys(vanilla.replies), ['tick query'])
  assert.equal(vanilla.tps, 20)

  const broken = await readTick(async () => { throw new Error('RCON connection closed') })
  assert.deepEqual(broken, { replies: {}, tps: null })
})

test('server figures are appended columns that an old reading of the file ignores', () => {
  assert.equal(sampleLine({ at: 100, cpu: 12.25, rss: 512 }, null), '100 12.3 512\n')
  assert.equal(sampleLine({ at: 100, cpu: 1, rss: 512 }, { tps: 19.5, online: 3, max: 20 }), '100 1.0 512 19.5 3 20\n')
  assert.equal(sampleLine({ at: 100, cpu: 1, rss: 512 }, { tps: null, online: 3, max: 20 }), '100 1.0 512 - 3 20\n')

  const file = metricsFile('figures')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '100 1.0 512\n110 2.0 520 19.5 3 20\n120 3.0 530 - 4 20\n')
  assert.deepEqual(readSamples('figures'), [
    { at: 100, cpu: 1, rss: 512 },
    { at: 110, cpu: 2, rss: 520, tps: 19.5, players: 3, maxPlayers: 20 },
    { at: 120, cpu: 3, rss: 530, players: 4, maxPlayers: 20 },
  ])
})

test('the newest sample is read from the end of the file, and only while it is current', async () => {
  const file = metricsFile('newest')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = Array.from({ length: 400 }, (_, i) => `${1000 + i * 10} 1.5 600`)
  lines.push('5000 4.5 700 18.2 7 40')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  assert.deepEqual(await latestSample('newest', { now: 5010 * 1000 }),
    { at: 5000, cpu: 4.5, rss: 700, tps: 18.2, players: 7, maxPlayers: 40 })
  assert.equal(await latestSample('newest', { now: 5100 * 1000 }), null, 'A stopped server is not still using memory')
  assert.equal(await latestSample('never-ran'), null)
})

/**
 * Just enough of Minecraft's RCON listener to count connections: authenticates any password,
 * answers tps and list, and echoes the empty sentinel packet the client uses to find the end of a
 * reply.
 */
function fakeRconServer(replies) {
  const state = { connections: 0, commands: [], sockets: new Set() }
  const packet = (id, type, body) => {
    const payload = Buffer.from(body, 'utf8')
    const buf = Buffer.alloc(14 + payload.length)
    buf.writeInt32LE(10 + payload.length, 0)
    buf.writeInt32LE(id, 4)
    buf.writeInt32LE(type, 8)
    payload.copy(buf, 12)
    return buf
  }
  const server = net.createServer((socket) => {
    state.connections++
    state.sockets.add(socket)
    socket.on('close', () => state.sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const size = buffer.readInt32LE(0)
        const id = buffer.readInt32LE(4)
        const type = buffer.readInt32LE(8)
        const body = buffer.subarray(12, 4 + size - 2).toString('utf8')
        buffer = buffer.subarray(4 + size)
        if (type === 3) socket.write(packet(id, 2, ''))
        else if (type === 2) {
          state.commands.push(body)
          socket.write(packet(id, 0, replies[body] ?? 'Unknown or incomplete command'))
        } else socket.write(packet(id, 0, ''))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })))
}

test('the sampler keeps one connection for many readings, and opens another only when it drops', async () => {
  const { server, state, port } = await fakeRconServer({
    tps: 'TPS from last 1m, 5m, 15m: 19.9, 20.0, 20.0',
    mspt: 'Server tick times',
    list: 'There are 1 of a max of 20 players online: Alex',
  })
  // readings further apart than the client's timeout: the connection has to survive sitting idle
  const ticks = startTickSampler({ rcon: { port, password: 'x' } }, { intervalMs: 90, timeoutMs: 40 })
  try {
    const deadline = Date.now() + 3000
    while (state.commands.filter((c) => c === 'list').length < 3 && Date.now() < deadline) await sleep(10)
    assert.ok(state.commands.filter((c) => c === 'list').length >= 3, 'Several readings were taken')
    assert.equal(state.connections, 1, 'Every reading used the same connection')
    const now = ticks.latest()
    assert.equal(now.tps, 19.9)
    assert.equal(now.online, 1)
    assert.equal(now.max, 20)

    for (const socket of state.sockets) socket.destroy()
    while (state.connections < 2 && Date.now() < deadline + 2000) await sleep(10)
    assert.equal(state.connections, 2, 'A dropped connection is replaced')
  } finally {
    ticks.stop()
    server.close()
  }
})

test('a server without RCON is not asked anything', () => {
  const ticks = startTickSampler({ name: 'no-rcon' })
  assert.equal(ticks.latest(), null)
  ticks.stop()
})
