import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-lifecycle-'))
process.env.MCCTL_DATA_ROOT = scratch

const { launch, status, stop, tailClientLog, createProfile, removeProfile } = await import('../src/client.mjs')
const { readClientState } = await import('../src/client-launch.mjs')
const { clientStateFile, clientRunDir, clientLaunchLock, versionDir, versionJson, ASSETS_DIR, profileDir } = await import('../src/client-paths.mjs')

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
  // what the launch was decided from, for diagnose
  const facts = JSON.parse(fs.readFileSync(clientStateFile('life'), 'utf8')).launch
  assert.equal(facts.id, mc)
  assert.equal(facts.java.major, 21)
  assert.equal(facts.java.chosenPath, fakeJava)
  assert.equal(facts.emulated, false)
  assert.equal(facts.loggingConfig, 'client-1.21.2.xml')

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

test('state.json is owner-only and the launch lock is gone once the client runs', async () => {
  const res = await launch('life', { fakeJava })
  assert.ok(res.pid)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(clientStateFile('life')).mode & 0o777, 0o600)
  }
  assert.equal(fs.existsSync(clientLaunchLock('life')), false, 'the lock is released after state.json is written')
  await stop('life')
})

test('two concurrent launches: exactly one wins and its state and log are intact', async () => {
  const results = await Promise.allSettled([
    launch('life', { playerName: 'winner', fakeJava }),
    launch('life', { playerName: 'loser', fakeJava }),
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const failed = results.filter((r) => r.status === 'rejected')
  assert.equal(ok.length, 1)
  assert.equal(failed.length, 1)
  assert.match(failed[0].reason.message, /profile "life" is being launched \(pid (\d+|\?)\)/)
  const st = status('life')
  assert.equal(st.running, true)
  assert.equal(st.pid, ok[0].value.pid)
  assert.equal(st.account.name, 'winner')
  const deadline = Date.now() + 3000
  let lines = []
  while (Date.now() < deadline && !lines.some((l) => l.includes('Setting user: winner'))) {
    lines = tailClientLog('life')
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(lines.some((l) => l.includes('Setting user: winner')), 'the winner wrote the log')
  assert.ok(!lines.some((l) => l.includes('Setting user: loser')), 'the loser never started')
  assert.equal(fs.existsSync(clientLaunchLock('life')), false)
  await stop('life')
})

test('a launch lock left by a dead process is replaced', async () => {
  fs.mkdirSync(clientRunDir('life'), { recursive: true })
  fs.writeFileSync(clientLaunchLock('life'), JSON.stringify({ pid: 999999999, token: 'old', startedAt: new Date().toISOString() }))
  const res = await launch('life', { fakeJava })
  assert.ok(res.pid)
  assert.equal(fs.existsSync(clientLaunchLock('life')), false)
  await stop('life')
})

test('a launch lock held by a live process refuses launch and remove, and the lock is left alone', async () => {
  fs.mkdirSync(clientRunDir('life'), { recursive: true })
  fs.writeFileSync(clientLaunchLock('life'), JSON.stringify({ pid: process.pid, token: 'theirs' }))
  await assert.rejects(launch('life', { fakeJava }), new RegExp(`profile "life" is being launched \\(pid ${process.pid}\\)`))
  assert.throws(() => removeProfile('life'), /is being launched/)
  assert.ok(fs.existsSync(clientLaunchLock('life')))
  fs.rmSync(clientLaunchLock('life'))
})

test('the lock is released when the launch fails', async () => {
  createProfile('nojava', { mc, java: path.join(scratch, 'no-such-java') })
  await assert.rejects(launch('nojava', {}))
  assert.equal(fs.existsSync(clientLaunchLock('nojava')), false)
})

test('Linux arm64 is refused before Java is looked for or anything downloads', async () => {
  createProfile('armless', { mc: '1.21.4' })
  const fetches = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { fetches.push(String(url)); throw new Error('no network in this test') }
  try {
    await assert.rejects(launch('armless', { os: { name: 'linux', arch: 'arm64', version: '6.1' } }),
      { message: 'the Minecraft client has no Linux arm64 build; use bots on this machine' })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(fetches, [])
  assert.equal(fs.existsSync(versionJson('1.21.4')), false)
  assert.equal(fs.existsSync(clientLaunchLock('armless')), false)
})

test('Windows arm64 is refused for a version without arm64 natives, and launches with them', async () => {
  const older = JSON.parse(fs.readFileSync(versionJson(mc), 'utf8'))
  older.id = '1.20.4'
  older.libraries = older.libraries.filter((l) => !l.name.endsWith(':natives-windows-arm64'))
  fs.mkdirSync(versionDir('1.20.4'), { recursive: true })
  fs.writeFileSync(versionJson('1.20.4'), JSON.stringify(older))
  createProfile('winarm', { mc: '1.20.4' })
  const winArm = { name: 'windows', arch: 'arm64', version: '10.0' }
  await assert.rejects(launch('winarm', { fakeJava, os: winArm }),
    { message: '1.20.4 ships no Windows arm64 natives; use a newer Minecraft version on this machine' })
  assert.equal(status('winarm').running, false)

  const res = await launch('life', { fakeJava, os: winArm })
  assert.ok(res.pid)
  await stop('life')
})

test('MCCTL_FAKE_CLIENT is honoured only under NODE_ENV=test', async () => {
  const { fakeClientJava } = await import('../src/client.mjs')
  assert.equal(fakeClientJava({ MCCTL_FAKE_CLIENT: '/x/fake.mjs' }), null)
  assert.equal(fakeClientJava({ MCCTL_FAKE_CLIENT: '/x/fake.mjs', NODE_ENV: 'production' }), null)
  assert.equal(fakeClientJava({ MCCTL_FAKE_CLIENT: '/x/fake.mjs', NODE_ENV: 'test' }), '/x/fake.mjs')
  assert.equal(fakeClientJava({ NODE_ENV: 'test' }), null)
})

test('a version with no arm64 natives runs as x64 on an arm64 machine that can emulate it (review N-4)', async () => {
  const old = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', 'versions', '1.16.5.json'), 'utf8'))
  fs.mkdirSync(versionDir(old.id), { recursive: true })
  fs.writeFileSync(versionJson(old.id), JSON.stringify(old))
  createProfile('emu', { mc: old.id })
  try {
    const mac = { name: 'osx', arch: 'arm64', version: '23.6.0' }
    await assert.rejects(launch('emu', { fakeJava, os: mac, hostCaps: { x64: false } }), { code: 'no-natives-for-this-machine', message: /install Rosetta/ })
    await launch('emu', { fakeJava, os: mac, hostCaps: { x64: true } })
    const facts = readClientState('emu').launch
    assert.equal(facts.arch, 'x64')
    assert.equal(facts.emulated, true)
    assert.equal(facts.java.major, 8)
    await stop('emu')
    // Windows 11 on arm64 runs it too, said to be experimental (review N4)
    const res = await launch('emu', { fakeJava, os: { name: 'windows', arch: 'arm64', version: '10.0.22631' }, hostCaps: { x64: true } })
    assert.deepEqual(res.warnings, ['running under Windows x64 emulation (experimental)'])
  } finally {
    try { await stop('emu') } catch { /* not running */ }
    removeProfile('emu')
  }
})

test('an older asset layout is laid out by launch and handed to the game (V1c review S-2)', async () => {
  const base = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', 'versions', '1.12.2.json'), 'utf8'))
  const win = { name: 'windows', arch: 'x64', version: '10.0.19045' }
  for (const [file, layout] of [['pre-1.6.json', 'resources'], ['legacy.json', 'virtual']]) {
    const version = JSON.parse(JSON.stringify(base))
    version.id = `launch-${layout}`
    const indexText = fs.readFileSync(path.join(here, 'fixtures', 'client', 'assets', file))
    version.assetIndex = { id: `${layout}-test`, url: `https://example.invalid/indexes/${file}`, sha1: crypto.createHash('sha1').update(indexText).digest('hex'), size: indexText.length }
    fs.mkdirSync(versionDir(version.id), { recursive: true })
    fs.writeFileSync(versionJson(version.id), JSON.stringify(version))
    const fetchImpl = async (url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, url === version.assetIndex.url ? indexText : 'spawnloft fixture body')
    }
    createProfile(layout, { mc: version.id })
    try {
      const stages = []
      await launch(layout, { fakeJava, os: win, fetchImpl, onStage: (s) => stages.push(s.stage) })
      assert.ok(stages.includes('assets'), `${layout}: the assets stage ran`)
      const facts = readClientState(layout).launch
      const tree = layout === 'resources' ? path.join(profileDir(layout), 'resources') : path.join(ASSETS_DIR, 'virtual', version.assetIndex.id)
      assert.equal(facts.assetsLayout, layout)
      assert.equal(facts.assetsDir, tree)
      assert.equal(fs.readFileSync(path.join(tree, '.complete'), 'utf8'), version.assetIndex.sha1)
      const [name, entry] = Object.entries(JSON.parse(indexText).objects)[0]
      const object = path.join(ASSETS_DIR, 'objects', entry.hash.slice(0, 2), entry.hash)
      assert.equal(fs.statSync(path.join(tree, name), { bigint: true }).ino === fs.statSync(object, { bigint: true }).ino, layout === 'virtual', `${layout}: ${layout === 'virtual' ? 'linked' : 'copied'}`)
    } finally {
      try { await stop(layout) } catch { /* not running */ }
      removeProfile(layout)
    }
  }
})
