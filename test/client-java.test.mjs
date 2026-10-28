import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-java-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { platformKey, runtimeEntry, runtimePlan, ensureRuntime, runtimeDir, runtimeDamage, installedRuntimes, mojangJava, RUNTIME_INDEX_URL } = await import('../src/client-java.mjs')
const { pickClientJava } = await import('../src/java.mjs')
const { javaRequirement } = await import('../src/client-version.mjs')
const { RUNTIME_DIR } = await import('../src/client-paths.mjs')
const F = await import('./fixtures/client-fixtures.mjs')

const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', 'client', name))
const ALL = JSON.parse(fixture('java-runtime-all.json'))
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')

// What Mojang's hosts would answer: the two fixture manifests by their index URLs, every runtime
// file as "runtime file <path>". Checks the sha1 the way downloadFile does.
function stubFetch({ wrong = new Set() } = {}) {
  const bodies = new Map()
  for (const [platform, comp, file] of [['windows-x64', 'java-runtime-epsilon', 'java-runtime-epsilon-windows-x64.json'], ['mac-os', 'jre-legacy', 'jre-legacy-mac-os.json']]) {
    const text = fixture(file)
    bodies.set(ALL[platform][comp][0].manifest.url, text)
    for (const [rel, entry] of Object.entries(JSON.parse(text).files)) {
      if (entry.type === 'file') bodies.set(entry.downloads.raw.url, wrong.has(rel) ? 'tampered' : `runtime file ${rel}\n`)
    }
  }
  const calls = []
  const fetchImpl = async (url, dest, { expected } = {}) => {
    calls.push(url)
    if (!bodies.has(url)) throw new Error(`no such fixture URL ${url}`)
    const body = bodies.get(url)
    if (expected && sha1(body) !== expected) throw Object.assign(new Error(`sha1 mismatch for ${url}`), { name: 'UserError' })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, body)
  }
  return { fetchImpl, calls }
}

test('platform keys follow the arch the game runs as', () => {
  assert.equal(platformKey('windows', 'x64'), 'windows-x64')
  assert.equal(platformKey('windows', 'arm64'), 'windows-arm64')
  assert.equal(platformKey('windows', 'x86'), 'windows-x86')
  assert.equal(platformKey('osx', 'arm64'), 'mac-os-arm64')
  // Apple Silicon running an old version under Rosetta takes the x64 runtime
  assert.equal(platformKey('osx', 'x64'), 'mac-os')
  assert.equal(platformKey('linux', 'x64'), 'linux')
  assert.equal(platformKey('linux', 'x86'), 'linux-i386')
  assert.equal(platformKey('linux', 'arm64'), null)
})

test('the index row for a component, or null where Mojang publishes none', () => {
  assert.equal(runtimeEntry(ALL, 'java-runtime-epsilon', 'windows-x64').version, '25.0.1')
  assert.equal(runtimeEntry(ALL, 'java-runtime-epsilon', 'windows-x86'), null)
  assert.equal(runtimeEntry(ALL, 'jre-legacy', 'mac-os-arm64'), null)
  assert.equal(runtimeEntry(ALL, 'java-runtime-gamma', 'nowhere'), null)
  const bad = structuredClone(ALL)
  bad.linux['jre-legacy'][0].manifest.url = 'http://example.invalid/x.json'
  assert.throws(() => runtimeEntry(bad, 'jre-legacy', 'linux'), /malformed entry/)
})

test('a manifest is checked whole before anything is written', () => {
  const win = JSON.parse(fixture('java-runtime-epsilon-windows-x64.json'))
  const mac = JSON.parse(fixture('jre-legacy-mac-os.json'))
  assert.equal(runtimePlan(win, { platform: 'windows-x64' }).java, 'bin/java.exe')
  const macPlan = runtimePlan(mac, { platform: 'mac-os' })
  assert.equal(macPlan.java, 'jre.bundle/Contents/Home/bin/java', 'found through the manifest')
  assert.equal(macPlan.links.length, 1)
  assert.equal(macPlan.count, Object.keys(mac.files).length)

  const lzmaOnly = structuredClone(win)
  delete lzmaOnly.files['lib/modules'].downloads.raw
  assert.throws(() => runtimePlan(lzmaOnly, { platform: 'windows-x64' }), { code: 'runtime-format', message: /offers "lib\/modules" only compressed/ })
  const out = structuredClone(mac)
  out.files['jre.bundle/Contents/MacOS/escape'] = { type: 'link', target: '../../../../../etc/passwd' }
  assert.throws(() => runtimePlan(out, { platform: 'mac-os' }), /outside its folder/)
  const abs = structuredClone(mac)
  abs.files['jre.bundle/x'] = { type: 'link', target: '/etc/passwd' }
  assert.throws(() => runtimePlan(abs, { platform: 'mac-os' }), /outside its folder/)
  const winLink = structuredClone(win)
  winLink.files['bin/link'] = { type: 'link', target: 'java.exe' }
  assert.throws(() => runtimePlan(winLink, { platform: 'windows-x64' }), { code: 'runtime-format', message: /does not make on Windows/ })
  const traversal = structuredClone(win)
  traversal.files['../evil.dll'] = traversal.files.release
  assert.throws(() => runtimePlan(traversal, { platform: 'windows-x64' }), /would land outside its folder/)
  const through = structuredClone(mac)
  through.files['jre.bundle/Contents/MacOS/libjli.dylib/x'] = mac.files['jre.bundle/Contents/Home/lib/rt.jar']
  assert.throws(() => runtimePlan(through, { platform: 'mac-os' }), /under the link "jre\.bundle\/Contents\/MacOS\/libjli\.dylib"/)
  const odd = structuredClone(win)
  odd.files.weird = { type: 'socket' }
  assert.throws(() => runtimePlan(odd, { platform: 'windows-x64' }), { code: 'runtime-format' })
  const noJava = structuredClone(win)
  delete noJava.files['bin/java.exe']
  assert.throws(() => runtimePlan(noJava, { platform: 'windows-x64' }), /has no bin\/java\.exe/)
})

test('a runtime is downloaded once, recorded, and repaired by size', async () => {
  const entry = runtimeEntry(ALL, 'java-runtime-epsilon', 'windows-x64')
  const { fetchImpl, calls } = stubFetch()
  const progress = []
  const r = await ensureRuntime('java-runtime-epsilon', 'windows-x64', { entry, fetchImpl, onProgress: (p) => progress.push(p) })
  const dir = runtimeDir('java-runtime-epsilon', 'windows-x64')
  assert.equal(r.javaPath, path.join(dir, 'bin', 'java.exe'))
  assert.equal(r.version, '25.0.1')
  assert.equal(r.downloaded, 4)
  assert.equal(calls.length, 5, 'the manifest and four files')
  assert.ok(calls.every((u) => !/lzma/.test(u)))
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'modules'), 'utf8'), 'runtime file lib/modules\n')
  assert.deepEqual(progress.at(-1), { phase: 'java', done: 4, total: 4, bytes: progress.at(-1).bytes })
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.javaPath).mode & 0o111, 0o111, 'executable from the manifest')
    assert.equal(fs.statSync(path.join(dir, 'release')).mode & 0o111, 0)
  }
  assert.deepEqual(installedRuntimes(), [{ component: 'java-runtime-epsilon', platform: 'windows-x64', version: '25.0.1', javaPath: 'bin/java.exe', manifestSha1: entry.manifest.sha1 }])

  // a second call downloads nothing
  calls.length = 0
  assert.equal((await ensureRuntime('java-runtime-epsilon', 'windows-x64', { entry, fetchImpl })).downloaded, 0)
  assert.deepEqual(calls, [])
  // a truncated file is found by its size and fetched again
  fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'x')
  assert.deepEqual(runtimeDamage('java-runtime-epsilon', 'windows-x64'), ['lib/modules'])
  assert.equal((await ensureRuntime('java-runtime-epsilon', 'windows-x64', { entry, fetchImpl })).downloaded, 1)
  assert.deepEqual(runtimeDamage('java-runtime-epsilon', 'windows-x64'), [])
  // a new manifest checks every file by its sha1: one changed at the same size is fetched again
  fs.writeFileSync(path.join(dir, 'release'), 'runtime file releasX\n')
  const moved = { ...entry, manifest: { ...entry.manifest } }
  const index = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'index.json'), 'utf8'))
  index.runtimes['java-runtime-epsilon/windows-x64'].manifestSha1 = 'c'.repeat(40)
  fs.writeFileSync(path.join(RUNTIME_DIR, 'index.json'), JSON.stringify(index))
  assert.equal((await ensureRuntime('java-runtime-epsilon', 'windows-x64', { entry: moved, fetchImpl })).downloaded, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'release'), 'utf8'), 'runtime file release\n')
  // offline (no index row), a recorded runtime serves as it is
  calls.length = 0
  assert.equal((await ensureRuntime('java-runtime-epsilon', 'windows-x64', { entry: null, fetchImpl })).javaPath, r.javaPath)
  assert.deepEqual(calls, [])
})

test('a file whose sha1 does not match refuses the runtime and records nothing', async () => {
  const entry = runtimeEntry(ALL, 'jre-legacy', 'mac-os')
  const { fetchImpl } = stubFetch({ wrong: new Set(['jre.bundle/Contents/Home/lib/rt.jar']) })
  await assert.rejects(ensureRuntime('jre-legacy', 'mac-os', { entry, fetchImpl }), /sha1 mismatch/)
  assert.equal(installedRuntimes().some((r) => r.component === 'jre-legacy'), false)
  await assert.rejects(ensureRuntime('jre-legacy', 'linux', { entry: null, fetchImpl }), /could not be read, and jre-legacy for Linux x64 is not downloaded yet/)
})

test('the macOS runtime: java inside jre.bundle, its link made inside the folder', { skip: process.platform === 'win32' && 'links are not made on Windows' }, async () => {
  const entry = runtimeEntry(ALL, 'jre-legacy', 'mac-os')
  const { fetchImpl } = stubFetch()
  const r = await ensureRuntime('jre-legacy', 'mac-os', { entry, fetchImpl })
  const dir = runtimeDir('jre-legacy', 'mac-os')
  assert.equal(r.javaPath, path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java'))
  const link = path.join(dir, 'jre.bundle', 'Contents', 'MacOS', 'libjli.dylib')
  assert.equal(fs.readlinkSync(link), '../Home/lib/jli/libjli.dylib')
  assert.equal(fs.readFileSync(link, 'utf8'), 'runtime file jre.bundle/Contents/Home/lib/jli/libjli.dylib\n')
})

test("Mojang's Java for a version: the list, the platform, and where none is published", async () => {
  const { fetchImpl } = stubFetch()
  const listFetchImpl = async (url) => {
    assert.equal(url, RUNTIME_INDEX_URL)
    return ALL
  }
  const got = await mojangJava({ component: 'java-runtime-epsilon', major: 25, osName: 'windows', arch: 'x64', fetchImpl, listFetchImpl })
  assert.equal(got.path, path.join(RUNTIME_DIR, 'java-runtime-epsilon', 'windows-x64', 'bin', 'java.exe'))
  await assert.rejects(mojangJava({ component: 'java-runtime-epsilon', major: 25, osName: 'windows', arch: 'x86', fetchImpl, listFetchImpl }), {
    code: 'no-runtime-for-this-machine', message: 'Mojang publishes no Java 25 (java-runtime-epsilon) for Windows x86',
  })
  await assert.rejects(mojangJava({ component: 'java-runtime-delta', major: 21, osName: 'linux', arch: 'arm64', fetchImpl, listFetchImpl }), {
    code: 'no-runtime-for-this-machine', message: 'Mojang publishes no Java for linux arm64',
  })
})

test('the picker: installed first, then Mojang, then a newer Java with a warning', async () => {
  const javas = (...rows) => rows.map(([major, arch = 'x64']) => ({ path: `/jvm/${major}-${arch}/bin/java`, major, arch }))
  const req = javaRequirement(F.loadVersion('1.12.2'))
  let asked = 0
  const runtime = async () => { asked++; return { path: '/rt/java', version: '8u202' } }
  assert.deepEqual(await pickClientJava({ requirement: req, arch: 'x64', found: javas([8], [21]), runtime }), { path: '/jvm/8-x64/bin/java', warning: null, source: 'installed' })
  assert.equal(asked, 0, 'an installed Java that fits downloads nothing')
  assert.deepEqual(await pickClientJava({ requirement: req, arch: 'x64', found: javas([21]), runtime }), { path: '/rt/java', warning: null, source: 'mojang-runtime' })
  assert.equal(asked, 1)
  // java: "mojang" takes it even with a fitting Java installed
  assert.equal((await pickClientJava({ explicit: 'mojang', requirement: req, arch: 'x64', found: javas([8]), runtime })).source, 'mojang-runtime')

  const offline = async () => { const e = new (await import('../src/util.mjs')).UserError("Mojang's Java runtime list could not be read"); throw e }
  const fell = await pickClientJava({ requirement: req, arch: 'x64', what: 'Minecraft 1.12.2', found: javas([21]), runtime: offline })
  assert.equal(fell.source, 'fallback')
  assert.match(fell.warning, /^Minecraft 1\.12\.2 wants Java 8; using Java 21 at \/jvm\/21-x64\/bin\/java, which is newer, so the game may not start\. Mojang's Java could not be had: Mojang's Java runtime list could not be read\. Install Java 8/)
  await assert.rejects(pickClientJava({ requirement: req, arch: 'x64', found: [], runtime: offline }), { code: 'java-missing', message: /no Java was found on this machine\. Mojang's Java could not be had either/ })
  await assert.rejects(pickClientJava({ explicit: 'mojang', requirement: req, arch: 'x64', found: javas([21]), runtime: offline }), /could not be read/)

  const none = async () => { const { fail } = await import('../src/util.mjs'); fail('Mojang publishes no Java 21 (java-runtime-delta) for Windows x86', 'no-runtime-for-this-machine') }
  await assert.rejects(pickClientJava({ requirement: javaRequirement(F.loadVersion('1.21.11')), arch: 'x86', what: 'Minecraft 1.21.11', found: javas([17, 'x86']), runtime: none }), {
    code: 'no-runtime-for-this-machine',
    message: 'Mojang publishes no Java 21 (java-runtime-delta) for Windows x86. Minecraft 1.21.11 needs Java 21 or newer. Install Java 21 from https://adoptium.net/temurin/releases/?version=21, or point the profile at one.',
  })
})
