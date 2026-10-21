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
const { versionJson, versionDir, versionJar, LIBRARIES_DIR, ASSETS_DIR, nativesDir } = await import('../src/client-paths.mjs')
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

  const expected = 1 + distinctLibPaths + 1 + distinctAssetPaths
  assert.equal(result.downloaded, expected)
  assert.equal(calls.length, expected)

  assert.ok(calls.includes(fixture.downloads.client.url), 'client jar downloaded')
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
  assert.equal(fs.readFileSync(path.join(nDir, '.complete'), 'utf8'), mc)
})
