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

test('a harness file from another process is ignored, and launch clears it', async () => {
  const { readHarnessFile } = await import('../src/client-harness.mjs')
  const file = path.join(profileDir('harn'), 'spawnloft-harness.json')
  fs.writeFileSync(file, JSON.stringify({ port: 1, pid: 999999, startedAt: new Date().toISOString(), version: 'stale' }))
  assert.ok(readHarnessFile('harn'), 'the file reads without a pid')
  assert.equal(readHarnessFile('harn', { pid: 4242 }), null, 'the file is ignored for another pid')
  await assert.rejects(connectHarness('harn', 'x', { pid: 4242 }), /no running harness/)

  const res = await launch('harn', { fakeJava })
  const found = readHarnessFile('harn', { pid: res.pid })
  assert.ok(found === null || found.version !== 'stale', 'launch removed the stale file before the game wrote its own')
  await stop('harn')
})

test('a harness profile on a version with no build asks the published list once, then refuses with a code', async () => {
  const crypto = await import('node:crypto')
  const { loadProfiles, saveProfiles } = await import('../src/client.mjs')
  const { CLIENT_CACHE_DIR } = await import('../src/client-paths.mjs')
  const idx = await import('../src/client-harness-index.mjs')
  fs.mkdirSync(versionDir('26.3'), { recursive: true })
  fs.copyFileSync(path.join(here, 'fixtures', 'client', 'versions', '26.3.json'), versionJson('26.3'))
  const reg = loadProfiles()
  reg.profiles.h263 = { mc: '26.3', loader: 'fabric', loaderVersion: '0.20.1', java: null, memory: '2G', harness: true, server: null, account: null, assistantAccount: false, createdAt: new Date().toISOString() }
  saveProfiles(reg)

  const fetched = []
  const realFetch = globalThis.fetch
  const gate = process.env.SPAWNLOFT_HARNESS_INDEX_FETCH
  delete process.env.SPAWNLOFT_HARNESS_INDEX_FETCH
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error('getaddrinfo ENOTFOUND github.com') }
  try {
    await assert.rejects(launch('h263', { fakeJava }), (err) => {
      assert.equal(err.code, 'harness-not-published')
      assert.match(err.message, /not published for Minecraft 26\.3 yet \(published: 1\.21\.11\) \(the published list could not be read: .*ENOTFOUND/)
      return true
    })
    assert.deepEqual([...new Set(fetched)], [idx.HARNESS_INDEX_URL])
    // a second launch within the hour does not ask again
    fetched.length = 0
    await assert.rejects(launch('h263', { fakeJava }), { code: 'harness-not-published' })
    assert.deepEqual(fetched, [])
  } finally {
    globalThis.fetch = realFetch
    if (gate !== undefined) process.env.SPAWNLOFT_HARNESS_INDEX_FETCH = gate
  }

  // once a list carrying 26.3 is in use, the launch gets past the check
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const keys = [{ name: 'primary', spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }]
  const bytes = Buffer.from(JSON.stringify({ format: 1, serial: 1, rows: [{ minecraft: ['26.3'], version: '0.2.0', tag: 'v0.2.0-mc26.3', file: 'spawnloft-harness-0.2.0+26.3.jar', sha256: 'ab'.repeat(32) }] }))
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(idx.SIGNATURE_DOMAIN), bytes]), privateKey).toString('base64')
  const answers = { [idx.HARNESS_INDEX_URL]: bytes, [idx.HARNESS_INDEX_SIG_URL]: Buffer.from(sig) }
  const fetchImpl = async (url) => ({ ok: true, status: 200, body: (async function* () { yield answers[url] })() })
  idx.forgetHarnessIndex()
  assert.equal(await idx.refreshHarnessIndex({ cacheDir: CLIENT_CACHE_DIR, keys, fetchImpl, force: true }), 'accepted')
  assert.equal(harnessFor('26.3').url, 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/v0.2.0-mc26.3/spawnloft-harness-0.2.0%2B26.3.jar')
  const stages = []
  await assert.rejects(launch('h263', { fakeJava, onStage: (s) => stages.push(s.stage), listFetchImpl: async () => { throw new Error('offline') }, fetchImpl: async () => { throw new Error('offline') } }),
    (err) => err.code !== 'harness-not-published')
  idx.forgetHarnessIndex()
})
