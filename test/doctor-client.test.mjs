import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-doctor-client-'))
const data = path.join(scratch, 'data')
fs.mkdirSync(path.join(data, 'instances'), { recursive: true })
fs.mkdirSync(path.join(data, 'run'), { recursive: true })
process.env.MCCTL_DATA_ROOT = data
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const client = await import('../src/client.mjs')
const { profileDir, versionDir, versionJson, versionJar } = await import('../src/client-paths.mjs')
const { checkClientProfiles } = await import('../src/doctor-client.mjs')
const { runDoctor } = await import('../src/doctor.mjs')

const mc = '1.21.11'
const javas21 = [{ path: 'java', major: 21, version: '21.0.4' }]

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('no profiles means nothing to say', () => {
  const result = checkClientProfiles({ javas: javas21 })
  assert.deepEqual(result, { problems: [], notes: [] })
})

test('a vanilla profile notes its version, whether it is installed and whether it runs', () => {
  client.createProfile('v', { mc, loader: 'vanilla' })
  try {
    const r1 = checkClientProfiles({ javas: javas21 })
    assert.equal(r1.problems.length, 0)
    assert.equal(r1.notes[0], `client v: Minecraft ${mc} vanilla, not installed yet: spawnloft client install v, stopped`)

    fs.mkdirSync(versionDir(mc), { recursive: true })
    fs.writeFileSync(versionJson(mc), '')
    fs.writeFileSync(versionJar(mc), '')

    const r2 = checkClientProfiles({ javas: javas21 })
    assert.equal(r2.notes[0], `client v: Minecraft ${mc} vanilla, installed, stopped`)
  } finally {
    client.removeProfile('v', { purge: true })
  }
})

test('a Java too old for the profile is a problem naming the major needed', () => {
  client.createProfile('v', { mc, loader: 'vanilla' })
  try {
    const r1 = checkClientProfiles({ javas: [{ path: 'java', major: 17, version: '17.0.2' }] })
    assert.equal(r1.problems.length, 1)
    assert.match(r1.problems[0], /client v:/)
    assert.match(r1.problems[0], /Java 21/)
    assert.match(r1.problems[0], /adoptium/)

    const r2 = checkClientProfiles({ javas: javas21 })
    assert.equal(r2.problems.length, 0)
  } finally {
    client.removeProfile('v', { purge: true })
  }
})

test('a pinned Java that does not exist is a problem naming the way out', () => {
  client.createProfile('pin', { mc, loader: 'vanilla', java: path.join(scratch, 'nope', 'java.exe') })
  try {
    const r = checkClientProfiles({ javas: javas21 })
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /pinned Java/)
    assert.match(r.problems[0], /client set pin java=/)
  } finally {
    client.removeProfile('pin', { purge: true })
  }
})

test('a harness profile on a version without a published harness is a problem', () => {
  client.createProfile('h', { mc: '1.20.1', loader: 'fabric', harness: true })
  try {
    const r = checkClientProfiles({ javas: [{ path: 'java', major: 21, version: '21' }] })
    assert.ok(r.problems.some(p => p.includes('no harness mod is published for Minecraft 1.20.1') && p.includes('harness=false')))
  } finally {
    client.removeProfile('h', { purge: true })
  }
})

test('a harness jar that is not the published one is a problem, and a missing Fabric API too', () => {
  client.createProfile('h', { mc, loader: 'fabric', harness: true })
  try {
    const modsDir = path.join(profileDir('h'), 'mods')
    fs.mkdirSync(modsDir, { recursive: true })
    fs.writeFileSync(path.join(modsDir, `spawnloft-harness-0.1.0+${mc}.jar`), 'not a jar')

    const r1 = checkClientProfiles({ javas: javas21 })
    assert.ok(r1.problems.some(p => p.includes('is not the published harness mod 0.1.0')))
    assert.ok(r1.problems.some(p => p.includes('Fabric API is not')))

    fs.unlinkSync(path.join(modsDir, `spawnloft-harness-0.1.0+${mc}.jar`))
    const r2 = checkClientProfiles({ javas: javas21 })
    assert.equal(r2.problems.length, 0)
  } finally {
    client.removeProfile('h', { purge: true })
  }
})

test('a Fabric API put in mods/ by hand counts as installed', async () => {
  const { createZip } = await import('../src/zip.mjs')
  client.createProfile('h', { mc, loader: 'fabric', harness: true })
  try {
    const modsDir = path.join(profileDir('h'), 'mods')
    fs.mkdirSync(modsDir, { recursive: true })
    fs.writeFileSync(path.join(modsDir, `spawnloft-harness-0.1.0+${mc}.jar`), 'not a jar')
    const src = path.join(scratch, 'fapi-src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'fabric.mod.json'), JSON.stringify({ id: 'fabric-api', version: '0.140.0' }))
    // no .spawnloft-mods.json, and a name that does not say what it is
    await createZip(path.join(modsDir, 'my-api.jar'), src, ['fabric.mod.json'])

    const r = checkClientProfiles({ javas: javas21 })
    assert.ok(!r.problems.some(p => p.includes('Fabric API is not')), r.problems.join('\n'))
  } finally {
    client.removeProfile('h', { purge: true })
  }
})

test('a stale harness file is reported, and removed with repair', () => {
  client.createProfile('h', { mc, loader: 'fabric', harness: true })
  try {
    fs.mkdirSync(profileDir('h'), { recursive: true })
    const harnessFilePath = path.join(profileDir('h'), 'spawnloft-harness.json')
    fs.writeFileSync(harnessFilePath, JSON.stringify({ port: 1, pid: 1 }))

    const r1 = checkClientProfiles({ javas: javas21 })
    assert.ok(r1.problems.some(p => p.includes('stale spawnloft-harness.json')))

    const r2 = checkClientProfiles({ repair: true, javas: javas21 })
    assert.ok(!r2.problems.some(p => p.includes('stale spawnloft-harness.json')))
    assert.ok(r2.notes.some(n => n.includes('cleared stale spawnloft-harness.json')))
    assert.equal(fs.existsSync(harnessFilePath), false)
  } finally {
    client.removeProfile('h', { purge: true })
  }
})

test('runDoctor carries the client lines', async () => {
  client.createProfile('v', { mc, loader: 'vanilla' })
  try {
    const result = await runDoctor()
    assert.ok(result.notes.some(n => n.startsWith('client v:')))
  } finally {
    client.removeProfile('v', { purge: true })
  }
})
