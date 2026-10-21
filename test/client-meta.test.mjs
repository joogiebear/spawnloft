import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-meta-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'client')

const {
  currentOs,
  ruleAllows,
  mergeInherited,
  libraryPath,
  libraries,
  assetIndex,
  assetObjects,
  gameArguments,
  jvmArguments,
  fetchManifest,
  fetchVersionJson,
} = await import('../src/client-meta.mjs')
const { versionJson } = await import('../src/client-paths.mjs')

const manifestFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'version_manifest_v2.json'), 'utf8'))
const mcVersion = manifestFixture.latest.release
const versionFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${mcVersion}.json`), 'utf8'))
const fabricFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-profile.json'), 'utf8'))

test('ruleAllows: last matching rule wins, no-match is disallow', () => {
  const rules = [
    { action: 'allow' },
    { action: 'disallow', os: { name: 'osx' } },
  ]
  assert.equal(ruleAllows(rules, { os: { name: 'osx', arch: 'x64', version: '1' } }), false)
  assert.equal(ruleAllows(rules, { os: { name: 'linux', arch: 'x64', version: '1' } }), true)
  assert.equal(ruleAllows(rules, { os: { name: 'windows', arch: 'x64', version: '1' } }), true)
})

test('libraryPath: plain, classifier, and @ext forms', () => {
  assert.equal(libraryPath('org.lwjgl:lwjgl:3.3.3'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar')
  assert.equal(libraryPath('a:b:1:natives-windows'), 'a/b/1/b-1-natives-windows.jar')
  assert.equal(libraryPath('a:b:1@zip'), 'a/b/1/b-1.zip')
})

test('mergeInherited: mainClass from child, assetIndex from parent, child libraries first', () => {
  const merged = mergeInherited(fabricFixture, versionFixture)
  assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
  assert.deepEqual(merged.assetIndex, versionFixture.assetIndex)
  assert.equal(merged.libraries[0].name, 'org.ow2.asm:asm:9.10.1')
  assert.equal(merged.libraries.length, fabricFixture.libraries.length + versionFixture.libraries.length)
  assert.ok(!('inheritsFrom' in merged))
})

test('mergeInherited: minecraftArguments carried across when neither side has arguments', () => {
  const parent = { minecraftArguments: 'a b c' }
  const child = {}
  const merged = mergeInherited(child, parent)
  assert.equal(merged.minecraftArguments, 'a b c')
  assert.ok(!('arguments' in merged))
  assert.deepEqual(gameArguments(merged), ['a', 'b', 'c'])
})

test('libraries(): native row only for windows', () => {
  const winOs = { name: 'windows', arch: 'x64', version: '10.0' }
  const linuxOs = { name: 'linux', arch: 'x64', version: '5.10' }

  const winRows = libraries(versionFixture, { os: winOs })
  const linuxRows = libraries(versionFixture, { os: linuxOs })

  const winNative = winRows.filter(r => r.native !== false)
  assert.ok(winNative.length > 0, 'expected native rows on windows')

  const linuxNative = linuxRows.filter(r => r.native !== false)
  assert.equal(linuxNative.length, 0, 'no native rows on linux')
})

test('assetObjects: two-character prefix in path and url', () => {
  const index = {
    objects: {
      'textures/blocks.png': { hash: 'abcdef1234567890abcdef1234567890abcdef12', size: 1234 },
    },
  }
  const rows = assetObjects(index)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, 'objects/ab/abcdef1234567890abcdef1234567890abcdef12')
  assert.equal(rows[0].url, 'https://resources.download.minecraft.net/ab/abcdef1234567890abcdef1234567890abcdef12')
  assert.equal(rows[0].hash, 'abcdef1234567890abcdef1234567890abcdef12')
  assert.equal(rows[0].size, 1234)
})

test('fetchManifest: fresh cache is used without calling the network', async () => {
  const cacheDir = fs.mkdtempSync(path.join(scratch, 'cache-fresh-'))
  const manifestPath = path.join(cacheDir, 'version_manifest_v2.json')
  const fetchedAtPath = `${manifestPath}.fetched-at`
  fs.writeFileSync(manifestPath, JSON.stringify(manifestFixture))
  fs.writeFileSync(fetchedAtPath, String(Date.now()))

  const result = await fetchManifest({
    cacheDir,
    fetchImpl: () => {
      throw new Error('network used')
    },
  })
  assert.deepEqual(result, manifestFixture)
})

test('fetchManifest: stale cache triggers a fetch and rewrites both files', async () => {
  const cacheDir = fs.mkdtempSync(path.join(scratch, 'cache-stale-'))
  const manifestPath = path.join(cacheDir, 'version_manifest_v2.json')
  const fetchedAtPath = `${manifestPath}.fetched-at`
  fs.writeFileSync(manifestPath, JSON.stringify(manifestFixture))
  fs.writeFileSync(fetchedAtPath, String(Date.now() - 86400000))

  const marker = { versions: [], marker: true }
  let called = false
  const result = await fetchManifest({
    cacheDir,
    fetchImpl: async () => {
      called = true
      return marker
    },
  })
  assert.equal(called, true)
  assert.deepEqual(result, marker)
  const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(rewritten, marker)
  const newFetchedAt = Number(fs.readFileSync(fetchedAtPath, 'utf8'))
  assert.ok(Date.now() - newFetchedAt < 5000)
})

test('fetchVersionJson: downloads once, skips when sha1 matches', async () => {
  const cacheDir = fs.mkdtempSync(path.join(scratch, 'verjson-'))
  const fixturePath = path.join(fixtureDir, `${mcVersion}.json`)
  const fixtureSha1 = crypto.createHash('sha1').update(fs.readFileSync(fixturePath)).digest('hex')
  const testManifest = {
    ...manifestFixture,
    versions: manifestFixture.versions.map(v =>
      v.id === mcVersion ? { ...v, sha1: fixtureSha1 } : v,
    ),
  }
  let callCount = 0

  const stubFetch = async (_url, dest) => {
    callCount++
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(fixturePath, dest)
  }

  const result1 = await fetchVersionJson(mcVersion, {
    manifest: testManifest,
    cacheDir,
    fetchImpl: stubFetch,
  })
  assert.equal(callCount, 1)
  assert.equal(result1.id, mcVersion)

  const result2 = await fetchVersionJson(mcVersion, {
    manifest: testManifest,
    cacheDir,
    fetchImpl: stubFetch,
  })
  assert.equal(callCount, 1)
  assert.equal(result2.id, mcVersion)
})

test('argument lists follow the os and feature flags they are given', () => {
  const osx = { name: 'osx', arch: 'arm64', version: '14' }
  const win = { name: 'windows', arch: 'x64', version: '10' }
  const jvmOsx = jvmArguments(versionFixture, { os: osx })
  const jvmWin = jvmArguments(versionFixture, { os: win })
  assert.ok(jvmOsx.includes('-XstartOnFirstThread'))
  assert.ok(!jvmWin.includes('-XstartOnFirstThread'))
  const demo = gameArguments(versionFixture, { os: win, features: { is_demo_user: true } })
  const plain = gameArguments(versionFixture, { os: win })
  assert.ok(demo.includes('--demo'))
  assert.ok(!plain.includes('--demo'))
})

test('a macOS native library is marked native although the rules say osx', () => {
  const lib = { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'p', url: 'u', sha1: 'x', size: 1 } } }
  const rows = libraries({ libraries: [lib] }, { os: { name: 'osx', arch: 'x64', version: '14' } })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].native)
})
