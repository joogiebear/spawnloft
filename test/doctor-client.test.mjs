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

test('a Java too old for the profile is a note: the launch downloads Mojang\'s (plan V2)', () => {
  client.createProfile('v', { mc, loader: 'vanilla' })
  try {
    const r1 = checkClientProfiles({ javas: [{ path: 'java', major: 17, version: '17.0.2' }] })
    assert.equal(r1.problems.length, 0)
    const note = r1.notes.find((n) => /Java 21/.test(n))
    assert.match(note, /client v:/)
    assert.match(note, /first launch downloads Mojang's/)
    assert.match(note, /adoptium/)

    const r2 = checkClientProfiles({ javas: javas21 })
    assert.equal(r2.problems.length, 0)
  } finally {
    client.removeProfile('v', { purge: true })
  }
})

test('java=mojang is not a missing path, and a damaged runtime is a problem', async () => {
  client.createProfile('moj', { mc, loader: 'vanilla', java: 'mojang' })
  const { RUNTIME_DIR } = await import('../src/client-paths.mjs')
  try {
    assert.equal(checkClientProfiles({ javas: [] }).problems.length, 0)
    // a recorded runtime whose one file is the wrong size
    const body = 'runtime file bin/java\n'
    const manifest = { files: { bin: { type: 'directory' }, 'bin/java': { type: 'file', executable: true, downloads: { raw: { sha1: 'a'.repeat(40), size: body.length, url: 'https://example.invalid/java' } } } } }
    fs.mkdirSync(path.join(RUNTIME_DIR, 'jre-legacy', 'linux', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(RUNTIME_DIR, 'jre-legacy', 'linux.manifest.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(RUNTIME_DIR, 'index.json'), JSON.stringify({ runtimes: { 'jre-legacy/linux': { component: 'jre-legacy', platform: 'linux', version: '8u202', javaPath: 'bin/java', manifestSha1: 'b'.repeat(40) } } }))
    fs.writeFileSync(path.join(RUNTIME_DIR, 'jre-legacy', 'linux', 'bin', 'java'), body)
    assert.ok(checkClientProfiles({ javas: [] }).notes.includes('client Java runtime jre-legacy 8u202 (linux): whole'))
    fs.writeFileSync(path.join(RUNTIME_DIR, 'jre-legacy', 'linux', 'bin', 'java'), 'x')
    const r = checkClientProfiles({ javas: [] })
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /^client Java runtime jre-legacy \(linux\): 1 file\(s\) missing or the wrong size, such as bin\/java/)
  } finally {
    client.removeProfile('moj', { purge: true })
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true })
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

test('runDoctor reports a secret-bearing file other users can read, and makes it owner-only when asked', { skip: process.platform === 'win32' }, async () => {
  const { ACCOUNTS_FILE } = await import('../src/client-paths.mjs')
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true })
  fs.writeFileSync(ACCOUNTS_FILE, '{"version":1,"accounts":[]}\n')
  fs.chmodSync(ACCOUNTS_FILE, 0o644)
  try {
    const seen = await runDoctor()
    const problem = seen.problems.find(p => p.startsWith('accounts file (Microsoft sign-in tokens): other users on this computer can read '))
    assert.ok(problem, 'the doctor names the file and who can read it: ' + JSON.stringify(seen.problems))
    assert.match(problem, /\(its permissions are 644, not 600\); run doctor without --json to make it owner-only$/)
    const fixed = await runDoctor({ repair: true })
    assert.ok(fixed.notes.some(n => n.startsWith('accounts file (Microsoft sign-in tokens): made owner-only')))
    assert.equal(fs.statSync(ACCOUNTS_FILE).mode & 0o777, 0o600)
    const clean = await runDoctor()
    assert.ok(!clean.problems.some(p => p.includes('accounts file')))
  } finally {
    fs.rmSync(ACCOUNTS_FILE, { force: true })
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
