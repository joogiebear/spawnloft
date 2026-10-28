import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-install-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'client')

const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release

const BODY = 'spawnloft fixture body'
const bodySha = crypto.createHash('sha1').update(BODY).digest('hex')
const bodySize = BODY.length
const INDEX = JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: bodySha, size: bodySize } } })
const indexSha = crypto.createHash('sha1').update(INDEX).digest('hex')
const indexSize = INDEX.length

const { PARALLEL, needsDownload, ensureVersion, extractNatives } = await import('../src/client-install.mjs')
const { versionJson, versionDir, versionJar, LIBRARIES_DIR, ASSETS_DIR, nativesDir, logConfigPath } = await import('../src/client-paths.mjs')
const { libraries, assetObjects } = await import('../src/client-meta.mjs')
const { createZip } = await import('../src/zip.mjs')

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${mc}.json`), 'utf8'))
fixture.downloads.client.sha1 = bodySha
fixture.downloads.client.size = bodySize
for (const lib of fixture.libraries) {
  if (lib.downloads?.artifact) {
    lib.downloads.artifact.sha1 = bodySha
    lib.downloads.artifact.size = bodySize
  }
  if (lib.downloads?.classifiers) {
    for (const cls of Object.values(lib.downloads.classifiers)) {
      cls.sha1 = bodySha
      cls.size = bodySize
    }
  }
}
fixture.assetIndex.sha1 = indexSha
fixture.assetIndex.size = indexSize
fixture.logging.client.file.sha1 = bodySha
fixture.logging.client.file.size = bodySize

fs.mkdirSync(versionDir(mc), { recursive: true })
fs.writeFileSync(versionJson(mc), JSON.stringify(fixture))

const assetIndexUrl = fixture.assetIndex.url
const winOs = { name: 'windows', arch: 'x64', version: '10' }

function makeStub() {
  const calls = []
  const fetchImpl = async (url, dest, opts = {}) => {
    calls.push(url)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, url === assetIndexUrl ? INDEX : BODY)
  }
  return { calls, fetchImpl }
}

test('first ensureVersion downloads everything', async () => {
  const { calls, fetchImpl } = makeStub()
  const result = await ensureVersion(mc, { os: winOs, fetchImpl })

  const libRows = libraries(fixture, { os: winOs })
  const distinctLibPaths = new Set(libRows.map(r => r.path)).size

  const indexJson = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'indexes', `${fixture.assetIndex.id}.json`), 'utf8'))
  const objRows = assetObjects(indexJson)
  const distinctAssetPaths = new Set(objRows.map(r => r.path)).size

  // the client jar, the log config, the libraries, the asset index and the assets
  const expected = 1 + 1 + distinctLibPaths + 1 + distinctAssetPaths
  assert.equal(result.downloaded, expected)
  assert.equal(calls.length, expected)

  assert.ok(calls.includes(fixture.downloads.client.url), 'client jar downloaded')
  assert.ok(calls.includes(fixture.logging.client.file.url), 'log config downloaded')
  assert.equal(fs.readFileSync(logConfigPath(fixture.logging.client.file.id), 'utf8'), BODY)
  assert.equal(result.logConfig, fixture.logging.client.file.id)
  for (const row of libRows) {
    assert.ok(calls.includes(row.url), `library ${row.name} downloaded`)
  }
  assert.ok(calls.includes(assetIndexUrl), 'asset index downloaded')

  for (const row of objRows) {
    assert.ok(calls.includes(row.url), `asset ${row.hash} downloaded`)
  }

  assert.equal(result.libraries, libRows.length)
  assert.equal(result.natives, libRows.filter(r => r.native !== false).length)
  assert.equal(result.assets, objRows.length)
  assert.equal(result.bytes, (expected - 1) * bodySize + indexSize)
})

test('second ensureVersion downloads nothing', async () => {
  const { calls, fetchImpl } = makeStub()
  const result = await ensureVersion(mc, { os: winOs, fetchImpl })
  assert.equal(result.downloaded, 0)
  assert.equal(calls.length, 0)
})

test('corrupted library is re-downloaded', async () => {
  const libRows = libraries(fixture, { os: winOs })
  const target = libRows.find(r => r.native === false)
  const targetPath = path.join(LIBRARIES_DIR, target.path)
  fs.writeFileSync(targetPath, 'corrupted data')

  const { calls, fetchImpl } = makeStub()
  const result = await ensureVersion(mc, { os: winOs, fetchImpl })

  assert.equal(result.downloaded, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], target.url)
})

test('a loader profile links the parent jar instead of downloading it again', async () => {
  const fabric = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-profile.json'), 'utf8'))
  for (const lib of fabric.libraries) {
    lib.sha1 = bodySha
    lib.size = bodySize
  }
  fs.mkdirSync(versionDir(fabric.id), { recursive: true })
  fs.writeFileSync(versionJson(fabric.id), JSON.stringify(fabric))

  const { calls, fetchImpl } = makeStub()
  const result = await ensureVersion(fabric.id, { os: winOs, fetchImpl })
  assert.ok(!calls.includes(fixture.downloads.client.url), 'the client jar is not fetched a second time')
  assert.equal(calls.length, fabric.libraries.length)
  assert.equal(result.jar, versionJar(fabric.id))
  assert.equal(fs.readFileSync(versionJar(fabric.id), 'utf8'), BODY)

  const again = await ensureVersion(fabric.id, { os: winOs, fetchImpl })
  assert.equal(again.downloaded, 0)
})

test('extractNatives skips META-INF and excluded prefixes', async () => {
  const cwd = fs.mkdtempSync(path.join(scratch, 'zip-src-'))
  fs.writeFileSync(path.join(cwd, 'a.dll'), 'native dll content')
  fs.mkdirSync(path.join(cwd, 'META-INF'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'META-INF', 'MANIFEST.MF'), 'manifest content')
  fs.mkdirSync(path.join(cwd, 'skip'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'skip', 'b.txt'), 'skip content')

  const libPath = 'org/test/natives/1.0/test-natives-1.0-natives-windows.jar'
  const libDest = path.join(LIBRARIES_DIR, libPath)
  fs.mkdirSync(path.dirname(libDest), { recursive: true })
  await createZip(libDest, cwd, ['a.dll', 'META-INF/MANIFEST.MF', 'skip/b.txt'])

  const nativeRows = [{
    path: libPath,
    native: { extract: { exclude: ['skip/'] } },
  }]

  // the same jar listed twice (plain row and natives classifier) is extracted once
  const result = await extractNatives(mc, [...nativeRows, ...nativeRows], { os: winOs })

  const nDir = nativesDir(mc)
  const entries = fs.readdirSync(nDir)
  assert.ok(entries.includes('a.dll'), 'a.dll extracted')
  assert.ok(entries.includes('.complete'), '.complete written')
  assert.ok(!entries.includes('META-INF'), 'META-INF skipped')
  assert.ok(!entries.includes('skip'), 'skip/ prefix excluded')
  assert.equal(result.files, 1)
  assert.equal(fs.readFileSync(path.join(nDir, '.complete'), 'utf8'), `${mc} windows x64 natives-v4`)
})

test('ensureVersion refuses natives this machine cannot load before the first download', async () => {
  const older = JSON.parse(JSON.stringify(fixture))
  older.id = '1.20.4-noarm'
  older.libraries = older.libraries.filter(l => !l.name.endsWith(':natives-windows-arm64'))
  fs.mkdirSync(versionDir(older.id), { recursive: true })
  fs.writeFileSync(versionJson(older.id), JSON.stringify(older))

  const { calls, fetchImpl } = makeStub()
  await assert.rejects(ensureVersion(older.id, { os: { name: 'windows', arch: 'arm64', version: '10' }, fetchImpl }),
    { message: '1.20.4-noarm ships no Windows arm64 natives; use a newer Minecraft version on this machine' })
  await assert.rejects(ensureVersion(older.id, { os: { name: 'linux', arch: 'arm64', version: '6.1' }, fetchImpl }),
    { message: 'the Minecraft client has no Linux arm64 build; use bots on this machine' })
  assert.deepEqual(calls, [])
  assert.equal(fs.existsSync(versionJar(older.id)), false)
})

test('26.x natives go to the java/ folder its java.library.path names, and old installs are redone', async () => {
  // a real natives jar laid out like LWJGL's: windows/x64/org/lwjgl/lwjgl.dll
  const cwd = fs.mkdtempSync(path.join(scratch, 'zip-src-'))
  fs.mkdirSync(path.join(cwd, 'windows', 'x64', 'org', 'lwjgl'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'windows', 'x64', 'org', 'lwjgl', 'lwjgl.dll'), 'lwjgl dll')
  const libPath = 'org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-windows.jar'
  const libDest = path.join(LIBRARIES_DIR, libPath)
  fs.mkdirSync(path.dirname(libDest), { recursive: true })
  await createZip(libDest, cwd, ['windows/x64/org/lwjgl/lwjgl.dll'])
  const jar = fs.readFileSync(libDest)

  const v26 = JSON.parse(JSON.stringify(fixture))
  v26.id = '26.3-test'
  v26.libraries = [{
    name: 'org.lwjgl:lwjgl:3.4.3:natives-windows',
    downloads: { artifact: {
      path: libPath,
      url: `https://libraries.minecraft.net/${libPath}`,
      sha1: crypto.createHash('sha1').update(jar).digest('hex'),
      size: jar.length,
    } },
    rules: [{ action: 'allow', os: { name: 'windows' } }],
  }]
  v26.arguments.jvm = [
    '-Djava.library.path=${natives_directory}/java',
    '-Djna.tmpdir=${natives_directory}/jna',
    '-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl',
    '-Dio.netty.native.workdir=${natives_directory}/netty',
    '-cp',
    '${classpath}',
  ]
  fs.mkdirSync(versionDir(v26.id), { recursive: true })
  fs.writeFileSync(versionJson(v26.id), JSON.stringify(v26))

  // what 1.6.0-beta.2 left behind: the jar extracted to the top of the folder, stamped v3
  const nDir = nativesDir(v26.id)
  fs.mkdirSync(path.join(nDir, 'windows', 'x64', 'org', 'lwjgl'), { recursive: true })
  fs.writeFileSync(path.join(nDir, 'windows', 'x64', 'org', 'lwjgl', 'lwjgl.dll'), 'lwjgl dll')
  fs.writeFileSync(path.join(nDir, '.complete'), `${v26.id} windows x64 natives-v3`)

  const { calls, fetchImpl } = makeStub()
  await ensureVersion(v26.id, { os: winOs, fetchImpl })
  assert.ok(!calls.some(u => u.endsWith(libPath)), 'the natives jar was already in place')
  assert.equal(fs.readFileSync(path.join(nDir, 'java', 'windows', 'x64', 'org', 'lwjgl', 'lwjgl.dll'), 'utf8'), 'lwjgl dll')
  assert.equal(fs.existsSync(path.join(nDir, 'windows')), false, 'the old top-level copy is gone')
  assert.equal(fs.readFileSync(path.join(nDir, '.complete'), 'utf8'), `${v26.id} windows x64 natives-v4`)
})

test('a log config that cannot be fetched refuses the version instead of leaving it open to Log4Shell', async () => {
  const old = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', '1.12.2.json'), 'utf8'))
  fs.mkdirSync(versionDir(old.id), { recursive: true })
  fs.writeFileSync(versionJson(old.id), JSON.stringify(old))

  const calls = []
  const fetchImpl = async (url, dest) => {
    calls.push(url)
    if (url === old.logging.client.file.url) throw new Error('HTTP 503')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, BODY)
  }
  await assert.rejects(ensureVersion(old.id, { os: winOs, fetchImpl }), {
    message: `could not download the log config client-1.12.xml from ${old.logging.client.file.url}: HTTP 503; without it 1.12.2 would run open to Log4Shell, so it is not launched`,
  })
  assert.ok(!calls.some(u => u.includes('/org/')), 'no library was fetched before the refusal')
  assert.equal(fs.existsSync(logConfigPath('client-1.12.xml')), false)
})

test('1.7.10 installs: every download is a URL the JSON names, and the natives-only jars are extracted', async () => {
  const old = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', '1.7.10.json'), 'utf8'))
  const named = new Set([old.downloads.client.url, old.logging.client.file.url, old.assetIndex.url])
  for (const lib of old.libraries) {
    if (lib.downloads?.artifact) { lib.downloads.artifact.sha1 = bodySha; lib.downloads.artifact.size = bodySize; named.add(lib.downloads.artifact.url) }
    for (const cls of Object.values(lib.downloads?.classifiers ?? {})) { cls.sha1 = bodySha; cls.size = bodySize; named.add(cls.url) }
  }
  old.downloads.client.sha1 = bodySha
  old.downloads.client.size = bodySize
  old.logging.client.file.sha1 = bodySha
  old.logging.client.file.size = bodySize
  old.assetIndex.sha1 = indexSha
  old.assetIndex.size = indexSize
  fs.mkdirSync(versionDir(old.id), { recursive: true })
  fs.writeFileSync(versionJson(old.id), JSON.stringify(old))

  const calls = []
  const fetchImpl = async (url, dest) => {
    calls.push(url)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, url === old.assetIndex.url ? INDEX : BODY)
  }
  const result = await ensureVersion(old.id, { os: winOs, fetchImpl })
  const unnamed = calls.filter(u => !named.has(u))
  assert.deepEqual(unnamed, [], 'no made-up URL was fetched')
  assert.ok(!calls.some(u => u.endsWith('/lwjgl-platform-2.9.1.jar')), 'no plain lwjgl-platform jar')
  assert.ok(calls.some(u => u.endsWith('/lwjgl-platform-2.9.1-natives-windows.jar')), 'the Windows natives jar')
  assert.ok(calls.some(u => u.endsWith('/twitch-platform-5.16-natives-windows-64.jar')), 'the ${arch} natives key is resolved')
  assert.equal(result.natives, 4)
  assert.equal(result.logConfig, 'client-1.7.xml')
  assert.ok(fs.existsSync(path.join(nativesDir(old.id), '.complete')), 'natives extracted')
})
