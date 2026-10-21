import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-lifecycle-'))
process.env.MCCTL_DATA_ROOT = scratch

const { launch, status, stop, tailClientLog, createProfile, removeProfile } = await import('../src/client.mjs')
const { readClientState } = await import('../src/client-launch.mjs')
const { clientStateFile, clientRunDir, versionDir, versionJson } = await import('../src/client-paths.mjs')

const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')

// Seed one installed version without any download
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release
fs.mkdirSync(versionDir(mc), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', `${mc}.json`), versionJson(mc))

createProfile('life', { mc })

after(async () => {
  try { await stop('life') } catch { /* already dead */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('launch, status, log, stop', async () => {
  const res = await launch('life', { fakeJava })
  assert.ok(res.pid)
  const st = status('life')
  assert.equal(st.running, true)
  assert.equal(st.pid, res.pid)

  const deadline = Date.now() + 3000
  let found = false
  while (Date.now() < deadline && !found) {
    found = tailClientLog('life').some(l => l.includes('Setting user: life'))
    if (!found) await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(found, 'Setting user: life should appear in the log')

  const stopRes = await stop('life')
  assert.deepEqual(stopRes, { stopped: true, wasRunning: true })
  assert.equal(status('life').running, false)
  assert.equal(fs.existsSync(clientStateFile('life')), false)
})

test('the process log holds the current run only', async () => {
  const res = await launch('life', { playerName: 'secondrun', fakeJava })
  assert.ok(res.pid)
  const deadline = Date.now() + 3000
  let lines = []
  while (Date.now() < deadline && !lines.some(l => l.includes('Setting user: secondrun'))) {
    lines = tailClientLog('life')
    await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(lines.some(l => l.includes('Setting user: secondrun')), 'the new run is in the log')
  assert.ok(!lines.some(l => l.includes('Setting user: life')), 'the earlier run is gone')
  await stop('life')
})

test('launching twice is refused', async () => {
  await launch('life', { fakeJava })
  await assert.rejects(launch('life', { fakeJava }), /already running/)
  await stop('life')
})

test('a fake client that dies at once', async () => {
  process.env.FAKE_CLIENT_FAIL = 'window'
  try {
    await launch('life', { fakeJava })
  } finally {
    delete process.env.FAKE_CLIENT_FAIL
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && status('life').running) {
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(status('life').running, false)
  assert.ok(tailClientLog('life').some(l => l.includes('GLFW error')))
})

test('a profile cannot be removed while it runs, and purge clears its run folder', async () => {
  await launch('life', { fakeJava })
  assert.throws(() => removeProfile('life'), /running/)
  await stop('life')
  createProfile('gone', { mc })
  await launch('gone', { fakeJava })
  await stop('gone')
  removeProfile('gone', { purge: true })
  assert.ok(!fs.existsSync(clientRunDir('gone')))
})

test('a state file whose pid now belongs to another program reads as stopped', () => {
  // this test process is alive but is not "java"
  fs.mkdirSync(path.dirname(clientStateFile('life')), { recursive: true })
  fs.writeFileSync(clientStateFile('life'), JSON.stringify({ pid: process.pid, javaExe: 'java', startedAt: new Date(Date.now() - 86400000).toISOString() }))
  assert.equal(readClientState('life'), null)
  assert.ok(!fs.existsSync(clientStateFile('life')))
})

test('the default player name is derived from the profile name', async () => {
  createProfile('my-client', { mc })
  const res = await launch('my-client', { fakeJava })
  assert.equal(res.account.name, 'my_client')
  await stop('my-client')
})

test('readClientState removes the file when the pid is dead', async () => {
  fs.mkdirSync(path.dirname(clientStateFile('life')), { recursive: true })
  fs.writeFileSync(clientStateFile('life'), JSON.stringify({
    pid: 999999999,
    startedAt: new Date().toISOString(),
    mode: 'offline',
    account: { type: 'offline', name: 'life' },
    javaPid: 999999999,
    harness: null,
  }))
  const state = readClientState('life')
  assert.equal(state, null)
  assert.equal(fs.existsSync(clientStateFile('life')), false)
})

test('stop when nothing runs', async () => {
  const res = await stop('life')
  assert.deepEqual(res, { stopped: false, wasRunning: false })
})

test('a fabric profile launches via fakeJava with the Knot main class', async () => {
  createProfile('fab', { mc, loader: 'fabric', loaderVersion: '0.19.5' })
  const fabricId = `fabric-loader-0.19.5-${mc}`
  fs.mkdirSync(versionDir(fabricId), { recursive: true })
  fs.copyFileSync(path.join(here, 'fixtures', 'client', 'fabric-profile.json'), versionJson(fabricId))
  const res = await launch('fab', { fakeJava })
  assert.equal(res.version, fabricId)
  const stopRes = await stop('fab')
  assert.deepEqual(stopRes, { stopped: true, wasRunning: true })
})
