// The installer engine (Forge, NeoForge and Quilt plan, phase 2) against a fake Java that records
// each build step and writes its outputs (fixtures/fake-processor.mjs), and against the real
// NeoForge and Forge install profiles (test/fixtures/client/loaders).
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-forge-install-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const E = await import('../src/client-forge-install.mjs')
const P = await import('../src/client-paths.mjs')
const { withCancel, isCancelled } = await import('../src/cancel.mjs')
const { buildZip, toolJar } = await import('./fixtures/zip-writer.mjs')

const FAKE = path.join(here, 'fixtures', 'fake-processor.mjs')
const LOADERS = path.join(here, 'fixtures', 'client', 'loaders')
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const made = (main) => sha1(`made by ${main}`)
const lib = (rel) => path.join(P.LIBRARIES_DIR, rel)

const MC = '1.21.1'
const ID = 'testloader-1'
const TOOLS = { 'test:split:1': 't.Split', 'test:patch:1': 't.Patch', 'test:final:1': 't.Final', 'test:serveronly:1': 't.Server' }
const HELPER = buildZip([['h.txt', 'helper']])

// A small installer in the shape of the real ones: its tools ship inside it under maven/, one
// helper is downloaded, one server-only step, three client steps.
function syntheticProfile(over = {}) {
  const libs = Object.entries(TOOLS).map(([name, main]) => {
    const [g, a, v] = name.split(':')
    return { name, downloads: { artifact: { path: `${g}/${a}/${v}/${a}-${v}.jar`, url: '', sha1: sha1(toolJar(main)), size: toolJar(main).length } } }
  })
  libs.push({ name: 'test:helper:1', downloads: { artifact: { path: 'test/helper/1/helper-1.jar', url: 'https://maven.neoforged.net/releases/test/helper/1/helper-1.jar', sha1: sha1(HELPER), size: HELPER.length } } })
  return {
    spec: 1,
    minecraft: MC,
    json: '/version.json',
    data: {
      SLIM: { client: '[test:slim:1]', server: '[test:slim-server:1]' },
      SLIM_SHA: { client: `'${made('t.Split')}'`, server: "''" },
      PATCHED: { client: '[test:patched:1]', server: '[test:patched-server:1]' },
      BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
      MCV: { client: "'1.21.1-x'", server: "'1.21.1-x'" },
    },
    processors: [
      { sides: ['server'], jar: 'test:serveronly:1', classpath: [], args: ['--output', '{ROOT}/server.jar'] },
      { jar: 'test:split:1', classpath: [], args: ['--input', '{MINECRAFT_JAR}', '--slim', '{SLIM}', '--ver', '{MCV}', '--side', '{SIDE}'], outputs: { '{SLIM}': '{SLIM_SHA}' } },
      { sides: ['client'], jar: 'test:patch:1', classpath: ['test:helper:1'], args: ['--clean', '{SLIM}', '--output', '{PATCHED}', '--apply', '{BINPATCH}'] },
      { jar: 'test:final:1', classpath: ['test:helper:1'], args: ['--input', '[test:patched:1]', '--output', '{ROOT}/libraries/test/final/1/final-1.jar'] },
    ],
    libraries: libs,
    ...over,
  }
}

function syntheticVersion(over = {}) {
  return {
    id: ID,
    inheritsFrom: MC,
    mainClass: 'test.Main',
    libraries: [{ name: 'test:patched:1', downloads: { artifact: { path: 'test/patched/1/patched-1.jar', url: '', sha1: made('t.Patch'), size: Buffer.byteLength(`made by t.Patch`) } } }],
    ...over,
  }
}

function writeInstaller(profile = syntheticProfile(), version = syntheticVersion(), { file = path.join(scratch, 'installer.jar') } = {}) {
  const entries = [['install_profile.json', JSON.stringify(profile)], ['version.json', JSON.stringify(version)], ['data/client.lzma', 'client patches'], ['data/server.lzma', 'server patches']]
  for (const [name, main] of Object.entries(TOOLS)) {
    const [g, a, v] = name.split(':')
    entries.push([`maven/${g}/${a}/${v}/${a}-${v}.jar`, toolJar(main)])
  }
  fs.writeFileSync(file, buildZip(entries))
  return { path: file, sha1: sha1(fs.readFileSync(file)) }
}

let procLog
let fetched
const fetchImpl = async (url, dest) => {
  fetched.push(url)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, HELPER)
}
const calls = () => (fs.existsSync(procLog) ? fs.readFileSync(procLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const mains = () => calls().map((c) => c.main)

beforeEach(() => {
  for (const d of [P.LIBRARIES_DIR, P.versionsDir(), path.join(P.CLIENT_ROOT, 'run'), E.INSTALLERS_DIR, path.join(P.CLIENT_CACHE_DIR, 'verified.json')]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(P.versionDir(MC), { recursive: true })
  fs.writeFileSync(P.versionJar(MC), 'vanilla game')
  procLog = path.join(scratch, `proc-${crypto.randomBytes(3).toString('hex')}.log`)
  process.env.SL_FAKE_PROC_LOG = procLog
  for (const k of ['SL_FAKE_PROC_FAIL', 'SL_FAKE_PROC_WRONG', 'SL_FAKE_PROC_HANG']) delete process.env[k]
  fetched = []
})

const run = (installer, opts = {}) => E.runInstaller({ id: ID, mc: MC, who: 'TestLoader', build: '1', stage: 'test', name: 'setup-a', installer, java: process.execPath, javaArgs: [FAKE], fetchImpl, ...opts })

test('the build steps run in order on the given Java, with every value filled in, and the stamp is written last', async () => {
  const inst = writeInstaller()
  const stages = []
  const result = await run(inst, { onStage: (s) => stages.push(s) })
  assert.deepEqual(result, { built: true, steps: 3 })
  // the server-only step is left out
  assert.deepEqual(mains(), ['t.Split', 't.Patch', 't.Final'])
  const [split, patch, fin] = calls()
  assert.deepEqual(split.args, ['--input', P.versionJar(MC), '--slim', lib('test/slim/1/slim-1.jar'), '--ver', '1.21.1-x', '--side', 'client'])
  assert.equal(patch.args[1], lib('test/slim/1/slim-1.jar'))
  assert.equal(patch.args[3], lib('test/patched/1/patched-1.jar'))
  assert.equal(patch.args[5], path.join(E.INSTALLERS_DIR, `${ID}-data`, 'data', 'client.lzma'))
  assert.deepEqual(patch.classpath, [lib('test/patch/1/patch-1.jar'), lib('test/helper/1/helper-1.jar')])
  assert.equal(fin.args[1], lib('test/patched/1/patched-1.jar'))
  assert.equal(fin.args[3], path.join(P.CLIENT_ROOT, 'libraries', 'test', 'final', '1', 'final-1.jar'))
  // each in a working folder of its own, removed after
  for (const c of calls()) {
    assert.ok(!c.cwd.startsWith(P.CLIENT_ROOT))
    assert.ok(!fs.existsSync(c.cwd))
  }
  // the tools came out of the installer; the helper was downloaded from an allowed host
  assert.equal(fs.readFileSync(lib('test/split/1/split-1.jar')).equals(toolJar('t.Split')), true)
  assert.deepEqual(fetched, ['https://maven.neoforged.net/releases/test/helper/1/helper-1.jar'])
  assert.ok(stages.some((s) => s.stage === 'test' && s.message === 'Setting up TestLoader 1 (step 2 of 3)'))
  assert.ok(E.isStamped(ID))
  assert.equal(await E.stampHolds(ID), true)
  const stamp = JSON.parse(fs.readFileSync(E.stampFile(ID), 'utf8'))
  assert.equal(stamp.installer, inst.sha1)
  assert.ok(Object.keys(stamp.files).includes('libraries/test/patched/1/patched-1.jar'))
  assert.ok(!fs.existsSync(path.join(P.versionDir(ID), '.loader-steps.json')))
  assert.ok(!fs.existsSync(path.join(E.INSTALLERS_DIR, `${ID}-data`)))
  const log = fs.readFileSync(path.join(P.clientRunDir('setup-a'), 'loader-install.log'), 'utf8')
  assert.match(log, /-- step 3 of 3: done/)
  assert.match(log, /t\.Final done/)
  // set up: a second Play runs nothing
  assert.deepEqual(await run(inst), { built: false })
  assert.equal(calls().length, 3)
})

test('a failed step says where it stopped with its last lines, keeps the finished ones, and the next try carries on', async () => {
  const inst = writeInstaller()
  process.env.SL_FAKE_PROC_FAIL = 't.Patch'
  await assert.rejects(run(inst), (err) => {
    assert.equal(err.code, 'loader-install-failed')
    assert.match(err.message, /^Setting up TestLoader stopped at step 2 of 3 \(its tool ended with code 3\)\.\n/)
    assert.match(err.message, /java\.lang\.IllegalStateException: t\.Patch broke/)
    assert.match(err.message, /The whole output is in .*loader-install\.log$/)
    return true
  })
  assert.equal(E.isStamped(ID), false)
  delete process.env.SL_FAKE_PROC_FAIL
  await run(inst)
  // step 1's output matched, so only the rest ran again
  assert.deepEqual(mains(), ['t.Split', 't.Patch', 't.Patch', 't.Final'])
  assert.ok(E.isStamped(ID))
})

test('an output that does not match the installer\'s checksum stops the setup and is removed', async () => {
  const inst = writeInstaller()
  process.env.SL_FAKE_PROC_WRONG = 't.Split'
  await assert.rejects(run(inst), (err) => err.code === 'loader-install-failed' && /stopped at step 1 of 3: slim-1\.jar did not come out as the installer says it should/.test(err.message))
  assert.ok(!fs.existsSync(lib('test/slim/1/slim-1.jar')))
  assert.equal(E.isStamped(ID), false)
})

test('cancel stops a running step; nothing is stamped, and the next Play carries on from the finished steps', async () => {
  const inst = writeInstaller()
  process.env.SL_FAKE_PROC_HANG = 't.Final'
  const ctrl = new AbortController()
  const onStage = (s) => { if (/step 3 of 3/.test(s.message)) setTimeout(() => ctrl.abort(), 400) }
  await assert.rejects(withCancel(ctrl.signal, () => run(inst, { onStage })), (err) => isCancelled(err))
  assert.equal(E.isStamped(ID), false)
  delete process.env.SL_FAKE_PROC_HANG
  await run(inst)
  // a restart with no stamp: steps 1 and 2 are not run again (2 by its record, 1 by its output)
  assert.deepEqual(mains(), ['t.Split', 't.Patch', 't.Final', 't.Final'])
  assert.ok(E.isStamped(ID))
})

test('a step without outputs runs again when the files it left were changed', async () => {
  const inst = writeInstaller()
  process.env.SL_FAKE_PROC_FAIL = 't.Final'
  await assert.rejects(run(inst))
  delete process.env.SL_FAKE_PROC_FAIL
  fs.writeFileSync(lib('test/patched/1/patched-1.jar'), 'tampered')
  await run(inst)
  assert.deepEqual(mains(), ['t.Split', 't.Patch', 't.Final', 't.Patch', 't.Final'])
})

test('a patched file damaged after the setup sets the loader up again, with a line saying so', async () => {
  const inst = writeInstaller()
  await run(inst)
  fs.writeFileSync(lib('test/patched/1/patched-1.jar'), 'damaged')
  assert.equal(await E.stampHolds(ID), false)
  const notes = []
  assert.deepEqual(await run(inst, { onNote: (n) => notes.push(n) }), { built: true, steps: 3 })
  assert.match(notes[0], /^TestLoader 1's files were changed or removed since it was set up, so it is set up again$/)
  assert.equal(await E.stampHolds(ID), true)
})

test('two setups on the same build at once: the second waits and builds nothing', async () => {
  const inst = writeInstaller()
  const [a, b] = await Promise.all([run(inst), run(inst, { name: 'setup-b' })])
  assert.deepEqual([a.built, b.built].sort(), [false, true])
  assert.deepEqual(mains(), ['t.Split', 't.Patch', 't.Final'])
})

test('a version-file row the steps were to make, still missing at the end, stops the setup', async () => {
  const version = syntheticVersion({ libraries: [...syntheticVersion().libraries, { name: 'test:never:1', downloads: { artifact: { path: 'test/never/1/never-1.jar', url: '', sha1: 'b'.repeat(40), size: 3 } } }] })
  const inst = writeInstaller(syntheticProfile(), version)
  await assert.rejects(run(inst), (err) => err.code === 'loader-install-failed' && /finished without making test:never:1/.test(err.message))
  assert.equal(E.isStamped(ID), false)
})

test('refusals: an unknown format, another game version or id, a host off the list, a path out of the folder', async () => {
  const refuses = async (profile, version, pattern, code = 'loader-installer-unknown') => {
    const inst = writeInstaller(profile, version)
    await assert.rejects(run(inst), (err) => {
      assert.equal(err.code, code, err.message)
      assert.match(err.message, pattern)
      return true
    })
    assert.equal(E.isStamped(ID), false)
    assert.deepEqual(mains(), [])
  }
  await refuses(syntheticProfile({ spec: 2 }), syntheticVersion(), /^This TestLoader build needs a newer SpawnLoft \(installer format 2\)\. Update SpawnLoft, or pick an older TestLoader build in Advanced\.$/)
  await refuses({ install: {}, versionInfo: {} }, syntheticVersion(), /the old installer format/)
  await refuses(syntheticProfile({ minecraft: '1.20.1' }), syntheticVersion(), /is for Minecraft 1\.20\.1, not 1\.21\.1/)
  await refuses(syntheticProfile(), syntheticVersion({ id: 'other-1' }), /names its version "other-1", not testloader-1/)
  await refuses(syntheticProfile(), syntheticVersion({ inheritsFrom: '1.20.1' }), /inherits from 1\.20\.1, not Minecraft 1\.21\.1/)
  const offList = syntheticProfile()
  offList.libraries.at(-1).downloads.artifact.url = 'https://example.net/helper-1.jar'
  await refuses(offList, syntheticVersion(), /not one of the places SpawnLoft takes mod loader files from/, 'loader-host-refused')
  const climbing = syntheticProfile()
  climbing.data.PATCHED.client = '[test:..:1]'
  await refuses(climbing, syntheticVersion(), /cannot place in its libraries folder/)
  const climbingRow = syntheticProfile()
  climbingRow.libraries.at(-1).downloads.artifact.path = '../../evil.jar'
  await refuses(climbingRow, syntheticVersion(), /outside the libraries folder/)
  const hole = syntheticProfile()
  hole.processors[1].args.push('{NOT_GIVEN}')
  await refuses(hole, syntheticVersion(), /use a value \{NOT_GIVEN\} it does not give/)
  const badFile = syntheticProfile()
  badFile.data.BINPATCH.client = '/../outside.lzma'
  await refuses(badFile, syntheticVersion(), /cannot take out of it/)
  assert.ok(!fs.existsSync(path.join(scratch, 'outside.lzma')))
})

test('the installer is downloaded once, checked against the maven\'s checksum, and checked again from the cache', async () => {
  const body = Buffer.from('an installer jar')
  let downloads = 0
  const fetchJar = async (url, dest, opts) => {
    downloads++
    assert.equal(opts.expected, sha1(body))
    fs.writeFileSync(dest, body)
  }
  const url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.266/neoforge-21.1.266-installer.jar'
  const a = await E.fetchInstaller(url, { name: 'neoforge-21.1.266-installer.jar', label: 'NeoForge 21.1.266 installer', fetchImpl: fetchJar, sha1Impl: async () => sha1(body) })
  assert.equal(a.cached, false)
  const b = await E.fetchInstaller(url, { name: 'neoforge-21.1.266-installer.jar', label: 'NeoForge 21.1.266 installer', fetchImpl: fetchJar, sha1Impl: async () => sha1(body) })
  assert.equal(b.cached, true)
  assert.equal(downloads, 1)
  // a cached jar that changed is fetched again
  fs.writeFileSync(a.path, 'changed')
  await E.fetchInstaller(url, { name: 'neoforge-21.1.266-installer.jar', label: 'NeoForge 21.1.266 installer', fetchImpl: fetchJar, sha1Impl: async () => sha1(body) })
  assert.equal(downloads, 2)
  await assert.rejects(E.fetchInstaller('https://example.net/x.jar', { name: 'x.jar', label: 'X installer', fetchImpl: fetchJar }), (err) => err.code === 'loader-host-refused')
  await assert.rejects(E.fetchInstaller(url, { name: '../x.jar', label: 'X installer', fetchImpl: fetchJar }), /not one SpawnLoft can use/)
})

test('the real NeoForge and Forge profiles: their client steps, values and outputs fill in', () => {
  const realInstaller = (dir) => {
    const file = path.join(scratch, `${path.basename(dir)}.jar`)
    fs.writeFileSync(file, buildZip([
      ['install_profile.json', fs.readFileSync(path.join(dir, 'install_profile.json'))],
      ['version.json', fs.readFileSync(path.join(dir, 'version.json'))],
      ['data/client.lzma', 'patches'],
    ]))
    return file
  }
  const cases = [
    ['neoforge/20.4.253', '1.20.4', 'neoforge-20.4.253', 6],
    ['neoforge/21.1.266', '1.21.1', 'neoforge-21.1.266', 6],
    ['neoforge/26.3.0.103', '26.3', 'neoforge-26.3.0.103', 1],
    ['forge/1.16.5-36.2.34', '1.16.5', '1.16.5-forge-36.2.34', 4],
    ['forge/1.20.1-47.4.28', '1.20.1', '1.20.1-forge-47.4.28', 6],
    ['forge/1.21.1-52.1.20', '1.21.1', '1.21.1-forge-52.1.20', 3],
    ['forge/26.3-66.1.8', '26.3', '26.3-forge-66.1.8', 1],
  ]
  for (const [rel, mc, id, count] of cases) {
    const file = realInstaller(path.join(LOADERS, rel))
    const { profile } = E.readInstaller(file, { mc, id, who: 'X' })
    const dataDir = path.join(scratch, 'data', id)
    const data = E.resolveData(profile, { installerPath: file, mc, dataDir, who: 'X' })
    assert.equal(fs.readFileSync(data.BINPATCH, 'utf8'), 'patches', rel)
    const steps = E.clientProcessors(profile).map((p) => E.planStep(p, data, 'X'))
    assert.equal(steps.length, count, rel)
    for (const s of steps) {
      for (const a of s.args) assert.ok(!/[{}]/.test(a) && !/^\[.*\]$/.test(a), `${rel}: ${a}`)
      for (const c of s.classpath) assert.ok(c.startsWith(P.LIBRARIES_DIR), `${rel}: ${c}`)
    }
    // the patched game jar is where the version file (or the loader) looks for it
    assert.ok(steps.some((s) => s.args.includes(data.PATCHED)), rel)
  }
  // NeoForge 21.1: the binary patcher writes neoforge-21.1.266-client.jar
  const nf = realInstaller(path.join(LOADERS, 'neoforge/21.1.266'))
  const { profile } = E.readInstaller(nf, { mc: '1.21.1', id: 'neoforge-21.1.266', who: 'NeoForge' })
  const data = E.resolveData(profile, { installerPath: nf, mc: '1.21.1', dataDir: path.join(scratch, 'data', 'nf'), who: 'NeoForge' })
  assert.equal(data.PATCHED, lib('net/neoforged/neoforge/21.1.266/neoforge-21.1.266-client.jar'))
  assert.equal(data.MCP_VERSION, '1.21.1-20240808.144430')
  assert.equal(data.SIDE, 'client')
  // Forge 1.20.1: its declared outputs are checked against the sum in its data table
  const forge = realInstaller(path.join(LOADERS, 'forge/1.20.1-47.4.28'))
  const fp = E.readInstaller(forge, { mc: '1.20.1', id: '1.20.1-forge-47.4.28', who: 'Forge' }).profile
  const fd = E.resolveData(fp, { installerPath: forge, mc: '1.20.1', dataDir: path.join(scratch, 'data', 'f'), who: 'Forge' })
  const outs = E.clientProcessors(fp).map((p) => E.planStep(p, fd, 'Forge')).flatMap((s) => s.outputs)
  assert.deepEqual(outs, [
    { file: lib('net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-slim.jar'), sha1: 'de86b035d2da0f78940796bb95c39a932ed84834' },
    { file: lib('net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-extra.jar'), sha1: '8c5a95cbce940cfdb304376ae9fea47968d02587' },
  ])
})

test('a tool jar\'s main class comes from its manifest, a continued line included', () => {
  const file = path.join(scratch, 'tool.jar')
  fs.writeFileSync(file, buildZip([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\nMain-Class: net.minecraftforge.binarypatcher.Consol\r\n eTool\r\n\r\n']]))
  assert.equal(E.mainClassOf(file), 'net.minecraftforge.binarypatcher.ConsoleTool')
  fs.writeFileSync(file, buildZip([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\n']]))
  assert.equal(E.mainClassOf(file), null)
  assert.equal(E.fillArgument('a\\{b}{SIDE}', { SIDE: 'client' }, 'X'), 'a{b}client')
})
