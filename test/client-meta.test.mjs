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
  nativesClassifier,
  platformRefusal,
  assetIndex,
  assetObjects,
  gameArguments,
  jvmArguments,
  nativesLibrarySubdir,
  loggingConfig,
  log4jNoLookupsNeeded,
  fetchManifest,
  fetchVersionJson,
} = await import('../src/client-meta.mjs')
const { versionJson } = await import('../src/client-paths.mjs')

const manifestFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'version_manifest_v2.json'), 'utf8'))
const mcVersion = manifestFixture.latest.release
const versionFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${mcVersion}.json`), 'utf8'))
const fabricFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-profile.json'), 'utf8'))
// Mojang's own JSONs for the older eras, as published (not trimmed)
const era = (id) => JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', `${id}.json`), 'utf8'))

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

const nativeNames = (os) => libraries(versionFixture, { os }).filter(r => r.native !== false).map(r => r.name).sort()

test('libraries(): exactly one arch of natives per machine', () => {
  const cases = [
    [{ name: 'osx', arch: 'arm64', version: '24.0' }, ['org.lwjgl:lwjgl:3.3.3:natives-macos-arm64']],
    [{ name: 'osx', arch: 'x64', version: '24.0' }, ['org.lwjgl:lwjgl:3.3.3:natives-macos']],
    // the old-style map row (pre-1.19 shape) is left as it was: its ${arch} is only 32 or 64
    [{ name: 'windows', arch: 'arm64', version: '10.0' }, ['org.lwjgl:lwjgl:3.3.3:natives-windows', 'org.lwjgl:lwjgl:3.3.3:natives-windows-arm64']],
    // the jtracy row is x64 only; the old-style map row adds natives-windows on x64 (and x86)
    [{ name: 'windows', arch: 'x64', version: '10.0' }, ['com.mojang:jtracy:1.0.37:natives-windows', 'org.lwjgl:lwjgl:3.3.3:natives-windows'].sort()],
    // the old-style map row has no ${arch} in it, and its jars carried 32 and 64 bit alike
    [{ name: 'windows', arch: 'x86', version: '10.0' }, ['org.lwjgl:lwjgl:3.3.3:natives-windows', 'org.lwjgl:lwjgl:3.3.3:natives-windows-x86']],
    [{ name: 'linux', arch: 'x64', version: '6.1' }, ['org.lwjgl:lwjgl:3.3.3:natives-linux']],
  ]
  for (const [os, expected] of cases) {
    assert.deepEqual(nativeNames(os), expected, `${os.name}/${os.arch}`)
  }
})

test('libraries(): another arch\'s natives are not put on the classpath either', () => {
  const rows = libraries(versionFixture, { os: { name: 'osx', arch: 'arm64', version: '24.0' } })
  assert.ok(!rows.some(r => r.name === 'org.lwjgl:lwjgl:3.3.3:natives-macos'))
  assert.ok(!rows.some(r => r.name.includes(':natives-') && !r.name.endsWith(':natives-macos-arm64')))
})

test('nativesClassifier: x64 has no suffix, arm64 and Windows x86 do, anything else has none', () => {
  assert.equal(nativesClassifier({ name: 'osx', arch: 'x64' }), 'natives-macos')
  assert.equal(nativesClassifier({ name: 'osx', arch: 'arm64' }), 'natives-macos-arm64')
  assert.equal(nativesClassifier({ name: 'windows', arch: 'x86' }), 'natives-windows-x86')
  assert.equal(nativesClassifier({ name: 'linux', arch: 'x86' }), null)
  assert.equal(nativesClassifier({ name: 'linux', arch: 'riscv64' }), null)
})

test('platformRefusal: Linux arm64 always, Windows arm64 only without arm64 natives', () => {
  const linuxArm = { name: 'linux', arch: 'arm64', version: '6.1' }
  const winArm = { name: 'windows', arch: 'arm64', version: '10.0' }
  assert.equal(platformRefusal(null, linuxArm), 'the Minecraft client has no Linux arm64 build; use bots on this machine')
  assert.equal(platformRefusal(versionFixture, linuxArm), 'the Minecraft client has no Linux arm64 build; use bots on this machine')
  assert.equal(platformRefusal(null, winArm), null)
  assert.equal(platformRefusal(versionFixture, winArm), null)
  for (const os of [
    { name: 'osx', arch: 'arm64', version: '24.0' },
    { name: 'windows', arch: 'x64', version: '10.0' },
    { name: 'linux', arch: 'x64', version: '6.1' },
  ]) assert.equal(platformRefusal(versionFixture, os), null, `${os.name}/${os.arch}`)

  const older = { ...versionFixture, id: '1.20.4', libraries: versionFixture.libraries.filter(l => !l.name.endsWith(':natives-windows-arm64')) }
  assert.equal(platformRefusal(older, winArm), '1.20.4 ships no Windows arm64 natives; use a newer Minecraft version on this machine')
  assert.equal(platformRefusal(older, { name: 'windows', arch: 'x64', version: '10.0' }), null)
  // a version with no natives rows at all is not judged
  assert.equal(platformRefusal({ id: 'x', libraries: [] }, winArm), null)
  // the old per-OS map never had arm64 builds: refused unless the machine runs x64 (archDecision)
  const legacy = { id: '1.18.2', libraries: [{ name: 'org.lwjgl:lwjgl:3.2.1', natives: { osx: 'natives-macos' } }] }
  assert.equal(platformRefusal(legacy, { name: 'osx', arch: 'arm64', version: '24.0' }), '1.18.2 ships no macOS arm64 natives; use a newer Minecraft version on this machine')
  // an arch Mojang names no natives for at all is refused like Linux arm64
  assert.equal(platformRefusal(null, { name: 'linux', arch: 'arm', version: '6.1' }), 'the Minecraft client has no Linux arm build; use bots on this machine')
  assert.equal(platformRefusal(null, { name: 'windows', arch: 'x86', version: '10.0' }), null)
})

test('libraries(): natives-macos-patch is the Intel Mac build, left out on Apple Silicon', () => {
  const version = { id: 'p', libraries: [
    { name: 'org.lwjgl:lwjgl-glfw:3.3.3:natives-macos-patch', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'g/p.jar', url: 'https://x/g/p.jar', sha1: null, size: 1 } } },
    { name: 'org.lwjgl:lwjgl-glfw:3.3.3:natives-macos', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'g/x.jar', url: 'https://x/g/x.jar', sha1: null, size: 1 } } },
    { name: 'org.lwjgl:lwjgl-glfw:3.3.3:natives-macos-arm64', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'g/a.jar', url: 'https://x/g/a.jar', sha1: null, size: 1 } } },
  ] }
  const names = (arch) => libraries(version, { os: { name: 'osx', arch, version: '24.0' } }).filter(r => r.native !== false).map(r => r.name.split(':')[3])
  assert.deepEqual(names('arm64'), ['natives-macos-arm64'])
  assert.deepEqual(names('x64'), ['natives-macos-patch', 'natives-macos'])
  assert.equal(platformRefusal(version, { name: 'osx', arch: 'arm64', version: '24.0' }), null)
})

test('libraries(): the 1.21.11 freetype rows give an Intel Mac the patch jar and Apple Silicon only arm64', () => {
  // as in Mojang's 1.21.11.json: freetype has a -patch row (macos/x64 files) and an arm64 row,
  // but no plain natives-macos row
  const row = (cls, file) => ({ name: `org.lwjgl:lwjgl-freetype:3.3.3:${cls}`, rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: `f/${file}.jar`, url: `https://x/f/${file}.jar`, sha1: null, size: 1 } } })
  const version = { id: '1.21.11', libraries: [row('natives-macos-patch', 'p'), row('natives-macos-arm64', 'a')] }
  const names = (arch) => libraries(version, { os: { name: 'osx', arch, version: '24.0' } }).map(r => r.name.split(':')[3])
  assert.deepEqual(names('arm64'), ['natives-macos-arm64'])
  assert.deepEqual(names('x64'), ['natives-macos-patch'])
  // the patch jar is an x64 build, so an Intel Mac is not refused for lacking plain natives-macos
  assert.equal(platformRefusal(version, { name: 'osx', arch: 'x64', version: '14' }), null)
  assert.equal(platformRefusal(version, { name: 'osx', arch: 'arm64', version: '14' }), null)
  // elsewhere a -patch suffix is not an arch build and is left to the rules
  const winPatch = { id: 'w', libraries: [{ ...row('natives-windows-patch', 'wp'), rules: [{ action: 'allow', os: { name: 'windows' } }] }] }
  assert.deepEqual(libraries(winPatch, { os: { name: 'windows', arch: 'arm64', version: '10.0' } }).map(r => r.name.split(':')[3]), ['natives-windows-patch'])
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

test('nativesLibrarySubdir follows the java.library.path argument', () => {
  const win = { name: 'windows', arch: 'x64', version: '10' }
  const withJvm = (jvm) => ({ arguments: { game: [], jvm } })
  assert.equal(nativesLibrarySubdir(versionFixture, { os: win }), '')
  assert.equal(nativesLibrarySubdir(withJvm(['-Djava.library.path=${natives_directory}/java']), { os: win }), 'java')
  assert.equal(nativesLibrarySubdir(withJvm(['-Djava.library.path=${natives_directory}\\a\\b']), { os: win }), 'a/b')
  assert.equal(nativesLibrarySubdir(withJvm(['-Djava.library.path=${natives_directory}/../x']), { os: win }), '')
  assert.equal(nativesLibrarySubdir(withJvm(['-Djava.library.path=${natives_directory}x']), { os: win }), '')
  assert.equal(nativesLibrarySubdir(withJvm([]), { os: win }), '')
  assert.equal(nativesLibrarySubdir({}, { os: win }), '')
})

test('loggingConfig: the Log4Shell config of each era, none before 1.7, and a loader profile inherits it', () => {
  assert.deepEqual(loggingConfig(era('1.7.10')), {
    id: 'client-1.7.xml',
    url: 'https://launcher.mojang.com/v1/objects/50c9cc4af6d853d9fc137c84bcd153e2bd3a9a82/client-1.7.xml',
    sha1: '50c9cc4af6d853d9fc137c84bcd153e2bd3a9a82',
    size: 966,
    argument: '-Dlog4j.configurationFile=${path}',
  })
  for (const id of ['1.12.2', '1.17.1']) assert.equal(loggingConfig(era(id)).id, 'client-1.12.xml', id)
  assert.equal(loggingConfig(versionFixture).id, 'client-1.21.2.xml')
  assert.equal(loggingConfig({ id: '1.5.2', libraries: [] }), null)
  assert.equal(loggingConfig(mergeInherited(fabricFixture, versionFixture)).id, 'client-1.21.2.xml')
})

test('loggingConfig refuses a config it cannot fetch and place safely', () => {
  const withFile = (file, rest = {}) => ({
    id: 'x',
    logging: { client: { type: 'log4j2-xml', argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml', sha1: 'bd65e7d2e3c237be76cfbef4c2405033d7f91521', size: 888, url: 'https://piston-data.mojang.com/v1/objects/x/client-1.12.xml', ...file }, ...rest } },
  })
  assert.equal(loggingConfig(withFile({})).id, 'client-1.12.xml')
  for (const id of ['../client.xml', 'a/b.xml', 'a\\b.xml', '..', '', 'c:d.xml']) {
    assert.throws(() => loggingConfig(withFile({ id })), /names a file outside log_configs/, id)
  }
  assert.throws(() => loggingConfig(withFile({ sha1: 'abc' })), /has no sha1/)
  assert.throws(() => loggingConfig(withFile({ sha1: undefined })), /has no sha1/)
  assert.throws(() => loggingConfig(withFile({ url: 'http://piston-data.mojang.com/client-1.12.xml' })), /has no https URL/)
  assert.throws(() => loggingConfig(withFile({}, { type: 'log4j-properties' })), /unknown type "log4j-properties"/)
  assert.throws(() => loggingConfig(withFile({}, { argument: '-Dlog4j.configurationFile=client.xml' })), /has the unknown argument/)
  assert.throws(() => loggingConfig(withFile({}, { argument: '-Dfoo=${path}' })), /has the unknown argument/)
  assert.throws(() => loggingConfig(withFile({}, { argument: '-Dlog4j.configurationFile=${path} ${other}' })), /has the unknown argument/)
})

test('mergeInherited: a loader profile with an empty logging block keeps the parent\'s Log4Shell config', () => {
  const parent = era('1.12.2')
  const child = { id: '1.12.2-forge', inheritsFrom: '1.12.2', mainClass: 'x', libraries: [], logging: {} }
  assert.equal(loggingConfig(mergeInherited(child, parent)).id, 'client-1.12.xml')
  const own = { ...child, logging: { client: { ...parent.logging.client, file: { ...parent.logging.client.file, id: 'client-other.xml' } } } }
  assert.equal(loggingConfig(mergeInherited(own, parent)).id, 'client-other.xml')
  assert.equal(loggingConfig(mergeInherited({ ...child, logging: undefined }, { ...parent, logging: undefined })), null)
})

test('log4jNoLookupsNeeded: log4j-core 2.0-beta9, 2.8.1 and 2.14.1 need the switch, newer and no log4j do not', () => {
  for (const id of ['1.7.10', '1.12.2', '1.17.1']) assert.equal(log4jNoLookupsNeeded(era(id)), true, id)
  assert.equal(log4jNoLookupsNeeded(versionFixture), false)
  assert.equal(log4jNoLookupsNeeded({ libraries: [] }), false)
  const core = (v) => ({ libraries: [{ name: `org.apache.logging.log4j:log4j-core:${v}` }, { name: 'org.apache.logging.log4j:log4j-api:2.14.1' }] })
  assert.equal(log4jNoLookupsNeeded(core('2.15.0')), true)
  assert.equal(log4jNoLookupsNeeded(core('2.16.0')), false)
  assert.equal(log4jNoLookupsNeeded(core('2.17.0')), false)
  assert.equal(log4jNoLookupsNeeded(core('3.0.0')), false)
})

const ERA_OS = {
  windows: { name: 'windows', arch: 'x64', version: '10' },
  linux: { name: 'linux', arch: 'x64', version: '6' },
  osx: { name: 'osx', arch: 'x64', version: '24.0' },
}

test('libraries(): before 1.13 the natives-only rows (lwjgl-platform, jinput-platform, twitch) are extracted, never put on the classpath', () => {
  const expectedNatives = {
    '1.5.2': {
      windows: ['lwjgl-platform:2.9.0:natives-windows', 'jinput-platform:2.0.5:natives-windows'],
      linux: ['lwjgl-platform:2.9.0:natives-linux', 'jinput-platform:2.0.5:natives-linux'],
      osx: ['lwjgl-platform:2.9.0:natives-osx', 'jinput-platform:2.0.5:natives-osx'],
    },
    '1.7.10': {
      windows: ['lwjgl-platform:2.9.1:natives-windows', 'jinput-platform:2.0.5:natives-windows', 'twitch-platform:5.16:natives-windows-64', 'twitch-external-platform:4.5:natives-windows-64'],
      linux: ['lwjgl-platform:2.9.1:natives-linux', 'jinput-platform:2.0.5:natives-linux'],
      osx: ['lwjgl-platform:2.9.1:natives-osx', 'jinput-platform:2.0.5:natives-osx', 'twitch-platform:5.16:natives-osx'],
    },
    '1.12.2': {
      windows: ['lwjgl-platform:2.9.4-nightly-20150209:natives-windows', 'jinput-platform:2.0.5:natives-windows', 'text2speech:1.10.3:natives-windows'],
      linux: ['lwjgl-platform:2.9.4-nightly-20150209:natives-linux', 'jinput-platform:2.0.5:natives-linux', 'text2speech:1.10.3:natives-linux'],
      osx: ['lwjgl-platform:2.9.2-nightly-20140822:natives-osx', 'jinput-platform:2.0.5:natives-osx', 'java-objc-bridge:1.0.0:natives-osx'],
    },
  }
  for (const [id, perOs] of Object.entries(expectedNatives)) {
    const version = era(id)
    const artifactUrls = new Set()
    const classifierUrls = new Set()
    for (const lib of version.libraries) {
      if (lib.downloads?.artifact) artifactUrls.add(lib.downloads.artifact.url)
      for (const c of Object.values(lib.downloads?.classifiers ?? {})) classifierUrls.add(c.url)
    }
    for (const [osName, os] of Object.entries(ERA_OS)) {
      const rows = libraries(version, { os })
      const label = `${id} on ${osName}`
      for (const row of rows.filter(r => r.native === false)) {
        assert.ok(artifactUrls.has(row.url), `${label}: classpath row ${row.name} has the JSON's artifact URL, not ${row.url}`)
        assert.ok(row.sha1, `${label}: classpath row ${row.name} is hash-checked`)
      }
      for (const row of rows.filter(r => r.native !== false)) {
        assert.ok(classifierUrls.has(row.url), `${label}: natives row ${row.name} has the JSON's classifier URL`)
      }
      // one natives jar per row; 1.5.2 lists jinput-platform twice and both rows are kept, as before
      const natives = rows.filter(r => r.native !== false).map(r => r.name.split(':').slice(1).join(':'))
      assert.deepEqual([...new Set(natives)], perOs[osName], label)
      assert.ok(rows.filter(r => r.native === false).length >= 7, `${label}: the real jars are still on the classpath`)
    }
  }
})

test('libraries(): a row with downloads but no artifact and no natives for this OS is left out altogether', () => {
  // twitch-external-platform has Windows natives only; its rules allow Linux
  const version = era('1.7.10')
  const linux = libraries(version, { os: ERA_OS.linux }).map(r => r.name)
  assert.ok(!linux.some(n => n.includes('twitch-platform') || n.includes('twitch-external')), `no twitch natives row on Linux: ${linux.filter(n => n.includes('twitch'))}`)
  assert.ok(linux.includes('tv.twitch:twitch:5.16'), 'the plain twitch jar stays')
  // a legacy row with no downloads block at all (a loader profile's) still gets its Maven URL
  const legacy = libraries({ libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.0', url: 'https://maven.fabricmc.net/' }] }, { os: ERA_OS.linux })
  assert.deepEqual(legacy.map(r => r.url), ['https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.0/fabric-loader-0.16.0.jar'])
})

test('libraries(): 1.13+ rows that carry both an artifact and natives keep the jar on the classpath (1.17.1, 1.21.11 unchanged)', () => {
  const v17 = era('1.17.1')
  const rows = libraries(v17, { os: ERA_OS.windows })
  // 1.17.1 lists org.lwjgl:lwjgl:3.2.2 twice: a plain row and one with an artifact plus natives
  const lwjgl = rows.filter(r => r.name.startsWith('org.lwjgl:lwjgl:3.2.2'))
  assert.deepEqual([...new Set(lwjgl.map(r => `${r.name} ${r.native !== false}`))], ['org.lwjgl:lwjgl:3.2.2 false', 'org.lwjgl:lwjgl:3.2.2:natives-windows true'])
  for (const row of rows) assert.ok(row.url.startsWith('https://libraries.minecraft.net/') && row.sha1, row.name)
  const latest = libraries(versionFixture, { os: ERA_OS.windows })
  assert.equal(latest.filter(r => r.native === false).length, versionFixture.libraries.filter(l => ruleAllows(l.rules, { os: ERA_OS.windows }) && !l.name.includes(':natives-')).length)
})
