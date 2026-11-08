/** The forty-line Redis client, against the fake Garnet. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { respSend, respPing } from '../src/resp.mjs'
import { findFreePort, sleep, UserError } from '../src/util.mjs'

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-garnet', 'GarnetServer.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-resp-'))
const port = await findFreePort(46000 + Math.floor(Math.random() * 5000))
const child = spawn(process.execPath, [FAKE, '--port', String(port), '--bind', '127.0.0.1', '--auth', 'Password', '--password', 'pw', '--checkpointdir', dir], { stdio: 'ignore' })
await sleep(500)
after(() => { try { child.kill() } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }) })

test('PING with the password answers PONG; without it, the refusal is said', async () => {
  assert.equal(await respPing('127.0.0.1', port, { password: 'pw' }), true)
  await assert.rejects(respSend('127.0.0.1', port, [['PING']]), /NOAUTH/)
  await assert.rejects(respSend('127.0.0.1', port, [['PING']], { password: 'nope' }), /WRONGPASS/)
})

test('a bulk reply and a nil come back as themselves', async () => {
  assert.equal(await respSend('127.0.0.1', port, [['SET', 'k', 'hello there'], ['GET', 'k']], { password: 'pw' }), 'hello there')
  assert.equal(await respSend('127.0.0.1', port, [['GET', 'missing']], { password: 'pw' }), null)
})

test('a port nobody listens on is a UserError naming the address', async () => {
  const dead = await findFreePort(port + 1)
  await assert.rejects(respSend('127.0.0.1', dead, [['PING']], { timeout: 2000 }), (e) => e instanceof UserError && /could not reach 127\.0\.0\.1/.test(e.message))
})

test('SAVE then SHUTDOWN checkpoints and takes the server down; the close is the answer', async () => {
  const reply = await respSend('127.0.0.1', port, [['SAVE'], ['SHUTDOWN']], { password: 'pw' })
  assert.equal(reply, 'OK')
  assert.ok(fs.existsSync(path.join(dir, 'checkpoint.txt')))
  await sleep(300)
  assert.equal(child.exitCode, 0)
})
