import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-harness-'))
process.env.MCCTL_DATA_ROOT = scratch

const { launch, status, stop, createProfile } = await import('../src/client.mjs')
const { readClientState } = await import('../src/client-launch.mjs')
const { versionDir, versionJson, profileDir } = await import('../src/client-paths.mjs')
const { harnessFor, ensureHarnessJar, waitForHarness, connectHarness } = await import('../src/client-harness.mjs')

const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')

fs.mkdirSync(versionDir('1.21.11'), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', '1.21.11.json'), versionJson('1.21.11'))
const fabricId = 'fabric-loader-0.19.5-1.21.11'
fs.mkdirSync(versionDir(fabricId), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', 'fabric-profile.json'), versionJson(fabricId))

createProfile('harn', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', harness: true })

let channel = null

after(async () => {
  try { if (channel) channel.close() } catch {}
  try { await stop('harn') } catch {}
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('harnessFor returns the pinned row and null for unlisted versions', () => {
  const row = harnessFor('1.21.11')
  assert.ok(row)
  assert.equal(row.sha256, '6e97b92cfde87bbd948f8ef4733979ba556337be79ed334b02c6942f2dae0d63')
  assert.equal(harnessFor('1.8.9'), null)
})

test('ensureHarnessJar rejects for an unlisted version', async () => {
  await assert.rejects(ensureHarnessJar('harn', '1.8.9'), /no harness mod is published/)
})

test('harness lifecycle: launch, connect, protocol ops, quit', async () => {
  const res = await launch('harn', { fakeJava })
  assert.ok(res.pid)

  const state = readClientState('harn')
  const token = state.harness.token
  assert.ok(token)

  const st = status('harn')
  assert.ok(st.harness)
  assert.ok(!('token' in st.harness))

  channel = await waitForHarness('harn', token, { timeout: 10000, alive: () => status('harn').running })
  assert.equal(channel.hello.minecraft, '1.21.11')

  const s1 = await channel.call('status')
  assert.equal(s1.screen, 'title')

  await assert.rejects(
    channel.call('join', { host: 'refused.invalid', port: 25565 }),
    /disconnected: Connection refused/,
  )

  const j1 = await channel.call('join', { host: '127.0.0.1', port: 25565 })
  assert.deepEqual(j1, { joined: true })
  const s2 = await channel.call('status')
  assert.equal(s2.screen, 'ingame')

  await channel.call('chat', { text: 'hi' })
  const msg = await channel.call('messages')
  const entry = msg.messages.find(m => m.text.endsWith(' hi') && m.kind === 'chat')
  assert.ok(entry)

  await channel.call('disconnect')
  let joinDone = false
  const j2 = channel.call('join', { host: '127.0.0.1', port: 25565 }).then(() => { joinDone = true })
  const s3 = await channel.call('status')
  assert.equal(joinDone, false)
  assert.equal(s3.screen, 'title')
  await j2
  assert.equal(joinDone, true)

  channel.close()
  channel = null
  await new Promise(r => setTimeout(r, 300))
  await assert.rejects(connectHarness('harn', 'wrong-token'), /refused the token/)

  channel = await connectHarness('harn', token, { timeout: 5000 })
  await channel.call('quit')
  channel.close()
  channel = null

  const deadline = Date.now() + 3000
  while (Date.now() < deadline && status('harn').running) {
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(status('harn').running, false)
  assert.ok(!fs.existsSync(path.join(profileDir('harn'), 'spawnloft-harness.json')))
})
