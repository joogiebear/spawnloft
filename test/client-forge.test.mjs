// Forge in the launcher from Minecraft 1.13 on (Forge, NeoForge and Quilt plan, phase 3), on
// Forge's real lists and installers (test/fixtures/client/loaders/forge).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-forge-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const G = await import('../src/client-forge.mjs')
const { CLIENT_CACHE_DIR, versionJson } = await import('../src/client-paths.mjs')
const { stampFile, readInstaller, clientProcessors, KNOWN_SPECS } = await import('../src/client-forge-install.mjs')
const { mergeInherited, libraries, classpathRows } = await import('../src/client-meta.mjs')
const { javaRequirement } = await import('../src/client-version.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')
const { loaderFor } = await import('../src/client-loaders.mjs')
const { buildZip } = await import('./fixtures/zip-writer.mjs')
const { pickClientJava } = await import('../src/java.mjs')

const DIR = path.join(F.FIXTURE_DIR, 'loaders', 'forge')
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
const linux = { name: 'linux', arch: 'x64', version: '6.1.0' }
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const offline = async () => { throw new Error('network used') }

function seedLists() {
  fs.mkdirSync(CLIENT_CACHE_DIR, { recursive: true })
  for (const [from, to] of [['maven-metadata.json', 'forge-maven-metadata.json'], ['promotions_slim.json', 'forge-promotions.json']]) {
    fs.copyFileSync(path.join(DIR, from), path.join(CLIENT_CACHE_DIR, to))
    fs.writeFileSync(path.join(CLIENT_CACHE_DIR, `${to}.fetched-at`), String(Date.now()))
  }
}

const jarOf = (full) => buildZip([
  ['install_profile.json', fs.readFileSync(path.join(DIR, full, 'install_profile.json'))],
  ['version.json', fs.readFileSync(path.join(DIR, full, 'version.json'))],
])

test('Forge from 1.13 on: the versions with build steps in their installer', () => {
  for (const mc of ['1.13', '1.13.2', '1.16.5', '1.20.1', '1.21.11', '26.3', '26.1.2']) assert.equal(G.forgeModernMc(mc), true, mc)
  for (const mc of ['1.12.2', '1.7.10', '1.6.4', '1.2.5', '24w14a', '']) assert.equal(G.forgeModernMc(mc), false, mc)
})

test('Forge\'s lists from the real files: its versions, newest first, and the build a first Play takes', async () => {
  seedLists()
  const games = await G.forgeGameVersions({ fetchImpl: offline })
  assert.equal(games[0].version, '26.3')
  assert.ok(games.every((g) => G.forgeSupportedMc(g.version) && g.stable))
  assert.ok(G.forgeAvailable('1.20.1', games))
  assert.ok(G.forgeAvailable('1.16.5', games))
  assert.ok(G.forgeAvailable('1.12.2', games))
  assert.ok(G.forgeAvailable('1.7.10', games))
  assert.ok(G.forgeAvailable('1.6.4', games))
  assert.ok(!G.forgeAvailable('1.5.2', games), '1.5.2 and older patch the game jar')
  assert.ok(!G.forgeAvailable('1.7.10_pre4', games), 'only test builds')
  // the recommended build, though a newer one is out
  const b1201 = await G.forgeBuilds('1.20.1', { fetchImpl: offline })
  assert.equal(b1201[0].version, '47.4.29')
  assert.equal(G.pickForge(b1201).version, '47.4.28')
  assert.equal(b1201.filter((b) => b.recommended).length, 1)
  assert.ok(b1201.every((b) => b.stable))
  assert.equal(G.pickForge(await G.forgeBuilds('1.16.5')).version, '36.2.34')
  assert.equal(G.pickForge(await G.forgeBuilds('26.3')).version, '66.1.8')
  // newest first by number, not by text
  const b263 = await G.forgeBuilds('26.3')
  assert.deepEqual(b263.slice(0, 3).map((b) => b.version), ['66.1.8', '66.1.5', '66.1.4'])
  assert.equal(b263.at(-1).version, '66.0.0')
  // a build picked by hand, and one that is not published
  assert.equal(G.pickForge(b1201, '47.0.1').version, '47.0.1')
  assert.equal(G.pickForge([{ version: '10.13.4.1614-1.7.10' }], '10.13.4.1614').version, '10.13.4.1614-1.7.10')
  assert.throws(() => G.pickForge(b1201, '47.9.9'), /not published/)
  // a version with no recommended build: the newest
  assert.equal(G.pickForge([{ version: '1.0.2', stable: true, recommended: false }, { version: '1.0.1', stable: true, recommended: false }]).version, '1.0.2')
})

test('Forge refuses what it cannot set up, before any download', async () => {
  seedLists()
  await assert.rejects(G.assertForgeAvailable('1.5.2'), (err) => err.code === 'loader-not-available' && /^Forge for Minecraft 1\.5\.2 is older than SpawnLoft offers \(1\.6\.4 and newer\)\. Use None for it\.$/.test(err.message))
  await assert.rejects(G.assertForgeAvailable('1.6.2'), /older than SpawnLoft offers/)
  await G.assertForgeAvailable('1.7.10')
  await G.assertForgeAvailable('1.12.2')
  await assert.rejects(G.assertForgeAvailable('26.4-snapshot-6', { kind: 'snapshot' }), (err) => err.code === 'loader-not-available' && /no build for Minecraft 26\.4-snapshot-6 yet/.test(err.message))
  await G.assertForgeAvailable('1.20.1')
  await assert.rejects(G.forgeBuilds('1.5.2'), (err) => err.code === 'loader-not-available')
  await assert.rejects(G.forgeBuilds('1.99'), /Forge has no build for Minecraft 1\.99/)
  await assert.rejects(G.ensureForgeVersion('1.20.1', '../47.4.28', { fetchImpl: offline }), /not a valid version/)
  await assert.rejects(G.ensureForgeVersion('1.20.1', '47.4.28-beta', { fetchImpl: offline }), /not a Forge build/)
  await assert.rejects(G.ensureForgeVersion('1.5.2', '7.8.1.738', { fetchImpl: offline }), /older than SpawnLoft offers/)
  await assert.rejects(G.ensureForgeVersion('1.7.10', '10.13.4.1614-new', { fetchImpl: offline }), /not a Forge build/)
})

test('every captured installer from 1.16.5 to 26.3 is one the engine reads, with its build steps for the client', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'jars-'))
  for (const [full, steps] of [['1.16.5-36.2.34', 4], ['1.18.2-40.3.0', 6], ['1.20.1-47.4.28', 6], ['1.21.1-52.1.20', 3], ['26.3-66.1.8', 1]]) {
    const [mc, build] = [full.slice(0, full.indexOf('-')), full.slice(full.indexOf('-') + 1)]
    const jar = path.join(tmp, `${full}.jar`)
    fs.writeFileSync(jar, jarOf(full))
    const { profile, version } = readInstaller(jar, { mc, id: G.forgeVersionId(mc, build), who: 'Forge' })
    assert.ok(KNOWN_SPECS.includes(profile.spec ?? 0), full)
    assert.equal(version.id, `${mc}-forge-${build}`)
    assert.equal(clientProcessors(profile).length, steps, full)
  }
  // an installer for another version is refused
  const jar = path.join(tmp, 'wrong.jar')
  fs.writeFileSync(jar, jarOf('1.20.1-47.4.28'))
  assert.throws(() => readInstaller(jar, { mc: '1.20.2', id: G.forgeVersionId('1.20.2', '47.4.28'), who: 'Forge' }), (err) => err.code === 'loader-installer-unknown')
})

test('step 1: the installer from Forge\'s maven, checked, and its version file; set up only once stamped', async () => {
  const full = '1.20.1-47.4.28'
  const jar = jarOf(full)
  const urls = []
  const fetchImpl = async (url, dest) => { urls.push(url); fs.writeFileSync(dest, jar) }
  const id = await G.ensureForgeVersion('1.20.1', '47.4.28', { fetchImpl, sha1Impl: async () => sha1(jar) })
  assert.equal(id, '1.20.1-forge-47.4.28')
  assert.deepEqual(urls, ['https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar'])
  assert.deepEqual(JSON.parse(fs.readFileSync(versionJson(id), 'utf8')), read(`${full}/version.json`))
  const forge = loaderFor('forge')
  assert.equal(forge.isInstalled('1.20.1', '47.4.28'), false)
  fs.writeFileSync(stampFile(id), JSON.stringify({ format: 1, files: {} }))
  assert.equal(forge.isInstalled('1.20.1', '47.4.28'), true)
  assert.equal(await G.ensureForgeVersion('1.20.1', '47.4.28', { fetchImpl: offline, sha1Impl: offline }), id)
  // a damaged download is refused
  await assert.rejects(G.ensureForgeVersion('1.20.1', '47.4.27', { fetchImpl, sha1Impl: async () => '0'.repeat(40) }))
})

test('the launch follows Forge\'s version file: its main class, module path and arguments', () => {
  for (const [full, mc, main] of [['1.16.5-36.2.34', '1.16.5', 'cpw.mods.modlauncher.Launcher'], ['1.18.2-40.3.0', '1.18.2', 'cpw.mods.bootstraplauncher.BootstrapLauncher'], ['26.3-66.1.8', '26.3', 'net.minecraftforge.bootstrap.ForgeBootstrap']]) {
    const merged = mergeInherited(read(`${full}/version.json`), F.loadVersion(mc))
    const cmd = buildCommand({ version: merged, profile: { mc, loader: 'forge', memory: '4G', server: null }, profileName: 'f', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
    assert.ok(cmd.args.includes(main), full)
    assert.ok(!cmd.args.some((a) => /\$\{/.test(a)), `${full}: every launch value is filled in`)
    const cp = classpathRows(libraries(merged, { os: linux })).map((r) => r.name)
    assert.equal(new Set(cp).size, cp.length, full)
    if (mc === '1.18.2') {
      const p = cmd.args.indexOf('-p')
      assert.ok(p > 0 && cmd.args[p + 1].includes('bootstraplauncher'), full)
    }
    if (mc !== '26.3') assert.ok(cmd.args.includes('--fml.forgeVersion'), full)
  }
})

test('Forge on a version Mojang ships with Java 8 runs on Java 8 only; later versions keep their own rule', () => {
  const j1165 = javaRequirement(F.loadVersion('1.16.5'))
  assert.equal(j1165.max, 17)
  assert.deepEqual(G.forgeJava(j1165), { ...j1165, max: 8, prefer: 8, mojangFirst: true })
  const j1182 = javaRequirement(F.loadVersion('1.18.2'))
  assert.deepEqual(G.forgeJava(j1182), j1182)
  assert.equal(loaderFor('forge').narrowJava(j1165).max, 8)
  assert.equal(loaderFor('neoforge').narrowJava, undefined)
})

test('with the Java 8 rule, a Java 17 on the machine is passed over for Java 8, or Mojang\'s Java 8, and used only with a warning', async () => {
  const req = G.forgeJava(javaRequirement(F.loadVersion('1.16.5')))
  const j17 = { path: '/jdk17/bin/java', major: 17, arch: 'x64' }
  const j8 = { path: '/jdk8/bin/java', major: 8, arch: 'x64' }
  assert.equal((await pickClientJava({ requirement: req, arch: 'x64', found: [j17, j8] })).path, j8.path)
  // vanilla 1.16.5 would take the 17; Forge gets Mojang's Java 8 instead
  assert.equal((await pickClientJava({ requirement: javaRequirement(F.loadVersion('1.16.5')), arch: 'x64', found: [j17] })).path, j17.path)
  const mojang = await pickClientJava({ requirement: req, arch: 'x64', found: [j17], runtime: async () => ({ path: '/runtime/jre-legacy/bin/java' }) })
  assert.equal(mojang.source, 'mojang-runtime')
  // offline: the 17, with a warning
  const offlineErr = Object.assign(new Error('offline'), { code: 'runtime-offline' })
  const fallback = await pickClientJava({ requirement: req, arch: 'x64', found: [j17], runtime: async () => { throw offlineErr } })
  assert.equal(fallback.path, j17.path)
  assert.match(fallback.warning, /wants Java 8; using Java 17/)
})

test('Forge behind the loader list: its id, its build steps and nothing for the mods folder', () => {
  const forge = loaderFor('forge')
  assert.equal(forge.name, 'Forge')
  assert.equal(forge.versionId('26.3', '66.1.8'), '26.3-forge-66.1.8')
  assert.equal(typeof forge.finishInstall, 'function')
  assert.equal(forge.afterInstall, null)
})

test('a Forge setup on a Java 8 version takes Mojang\'s Java 8 before an installed one, and falls back when it cannot be had', async () => {
  const client = await import('../src/client.mjs')
  const java = javaRequirement(F.loadVersion('1.16.5'))
  const resolved = { java, arch: 'x64', os: linux }
  const j8 = { path: '/jdk8u400/bin/java', major: 8, arch: 'x64' }
  const j17 = { path: '/jdk17/bin/java', major: 17, arch: 'x64' }
  // Mojang's runtime, as a list fetch that names none for this machine: the installed Java 8
  const none = async () => ({ linux: {} })
  const fell = await client.javaFor({ mc: '1.16.5', loader: 'forge', java: null }, resolved, { foundJavas: [j17, j8], listFetchImpl: none })
  assert.equal(fell.path, j8.path)
  assert.deepEqual([fell.requirement.min, fell.requirement.max], [8, 8])
  // only a Java 17, and no Mojang Java: the 17, with the louder warning
  const warned = await client.javaFor({ mc: '1.16.5', loader: 'forge', java: null }, resolved, { foundJavas: [j17], listFetchImpl: none })
  assert.equal(warned.path, j17.path)
  assert.match(warned.warning, /wants Java 8; using Java 17.*Mods often fail on a newer Java\.$/)
  // vanilla is not narrowed: the 17 fits, nothing downloaded
  const plain = await client.javaFor({ mc: '1.16.5', loader: 'vanilla', java: null }, resolved, { foundJavas: [j17], listFetchImpl: async () => { throw new Error('network used') } })
  assert.equal(plain.path, j17.path)
  assert.equal(plain.warning, null)
})

test('Forge\'s version list holds without its recommended builds; the newest is picked then', async () => {
  fs.rmSync(path.join(CLIENT_CACHE_DIR, 'forge-promotions.json'), { force: true })
  fs.rmSync(path.join(CLIENT_CACHE_DIR, 'forge-promotions.json.fetched-at'), { force: true })
  const fetchImpl = async (url) => { if (url.includes('promotions')) throw new Error('unreachable'); throw new Error('network used') }
  const games = await G.forgeGameVersions({ fetchImpl })
  assert.ok(G.forgeAvailable('1.20.1', games))
  assert.equal(G.pickForge(await G.forgeBuilds('1.20.1', { fetchImpl })).version, '47.4.29')
  await assert.rejects(G.forgeBuilds('1.5.2', { fetchImpl }), /older than SpawnLoft offers/)
  seedLists()
})

// ---- the older installer (phase 4) ------------------------------------------------------------

const L = await import('../src/client-forge-legacy.mjs')
const { stampHolds } = await import('../src/client-forge-install.mjs')
const { LIBRARIES_DIR } = await import('../src/client-paths.mjs')

// an old installer as Forge built them: install_profile.json at the root, the universal jar beside
const UNIVERSAL = Buffer.from('a stand-in for the Forge universal jar')
const legacyJar = (full, extra = {}) => {
  const profile = read(`${full}/install_profile.json`)
  return buildZip([['install_profile.json', Buffer.from(JSON.stringify({ ...profile, ...extra }))], [profile.install.filePath, UNIVERSAL]])
}

test('builds with a version tail are Forge\'s; test builds are not; the recommended one is found by its number', async () => {
  seedLists()
  for (const b of ['10.13.4.1614-1.7.10', '12.18.0.2000-1.10.0', '13.19.1.2189-1.11.x', '10.12.2.1147-mc172', '14.23.5.2864', '47.4.28']) assert.ok(G.isForgeBuild(b), b)
  for (const b of ['10.13.4.1614-new', '12.17.0.1909-EHUnit', '1.0-prerelease', '14.23.5.2847-4627']) assert.ok(!G.isForgeBuild(b), b)
  const b1710 = await G.forgeBuilds('1.7.10', { fetchImpl: offline })
  assert.equal(G.pickForge(b1710).version, '10.13.4.1614-1.7.10')
  assert.ok(b1710.every((b) => !b.version.endsWith('-new')))
  assert.equal(G.pickForge(await G.forgeBuilds('1.12.2')).version, '14.23.5.2859')
  assert.equal(G.pickForge(await G.forgeBuilds('1.6.4')).version, '9.11.1.1345')
  assert.equal(G.forgeVersionId('1.7.10', '10.13.4.1614-1.7.10'), '1.7.10-forge-10.13.4.1614-1.7.10')
  for (const mc of ['1.7.10', '1.12.2', '1.13', '26.3']) assert.equal(G.forgeTested(mc), true, mc)
  for (const mc of ['1.6.4', '1.8.9', '1.10.2', '1.12.1']) assert.equal(G.forgeTested(mc), false, mc)
})

test('the old installer is read into the newer shape: https Forge maven, the client\'s rows, the Forge jar from the installer', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'legacy-'))
  for (const [full, mc, build] of [['1.7.10-10.13.4.1614-1.7.10', '1.7.10', '10.13.4.1614-1.7.10'], ['1.12.2-14.23.0.2486', '1.12.2', '14.23.0.2486']]) {
    const jar = path.join(tmp, `${full}.jar`)
    fs.writeFileSync(jar, legacyJar(full))
    const id = G.forgeVersionId(mc, build)
    assert.throws(() => readInstaller(jar, { mc, id, who: 'Forge' }), /the old installer format/)
    const { profile, version, pending } = readInstaller(jar, { mc, id, who: 'Forge', legacy: true })
    assert.equal(version.id, id)
    assert.equal(version.inheritsFrom, mc)
    assert.equal(version.mainClass, 'net.minecraft.launchwrapper.Launch')
    assert.match(version.minecraftArguments, /--tweakClass/)
    assert.equal(profile.processors.length, 0)
    const forge = version.libraries[0]
    assert.equal(forge.downloads.artifact.url, '')
    assert.equal(forge.downloads.artifact.sha1, sha1(UNIVERSAL))
    assert.equal(profile.installerFiles[forge.downloads.artifact.path], read(`${full}/install_profile.json`).install.filePath)
    for (const lib of version.libraries.slice(1)) {
      assert.match(lib.downloads.artifact.url, /^https:\/\/(libraries\.minecraft\.net|maven\.minecraftforge\.net)\//, lib.name)
      assert.ok(lib.downloads.artifact.url.endsWith(lib.downloads.artifact.path))
    }
    // the server-only row is left out; every other row waits for its checksum
    assert.ok(!version.libraries.some((l) => l.name === 'jline:jline:2.13'))
    assert.equal(pending.length, version.libraries.length - 1)
    assert.ok(!('optionals' in version))
  }
  // an installer for another version
  const jar = path.join(tmp, 'wrong.jar')
  fs.writeFileSync(jar, legacyJar('1.12.2-14.23.0.2486'))
  assert.throws(() => readInstaller(jar, { mc: '1.12.1', id: '1.12.1-forge-14.23.0.2486', who: 'Forge', legacy: true }), (err) => err.code === 'loader-installer-unknown')
  // an old maven address is made today's
  assert.equal(L.legacyBaseUrl('http://files.minecraftforge.net/maven/'), 'https://maven.minecraftforge.net/')
  assert.equal(L.legacyBaseUrl('https://maven.minecraftforge.net'), 'https://maven.minecraftforge.net/')
  assert.equal(L.legacyBaseUrl(undefined), 'https://libraries.minecraft.net/')
  // a version file that does not inherit is made to
  const jar2 = path.join(tmp, 'noparent.jar')
  const p = read('1.7.10-10.13.4.1614-1.7.10/install_profile.json')
  delete p.versionInfo.inheritsFrom
  // as 1.6.4's lists the game's own libraries, native and per-OS rows among them
  p.versionInfo.libraries.push({ name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.0', natives: { linux: 'natives-linux' } }, { name: 'org.lwjgl.lwjgl:lwjgl:2.9.0', rules: [{ action: 'allow' }] }, { name: 'argo:argo:2.25_fixed' })
  fs.writeFileSync(jar2, buildZip([['install_profile.json', Buffer.from(JSON.stringify(p))], [p.install.filePath, UNIVERSAL]]))
  const own = readInstaller(jar2, { mc: '1.7.10', id: 'x-forge', who: 'Forge', legacy: true }).version
  assert.equal(own.inheritsFrom, '1.7.10')
  assert.ok(!own.libraries.some((l) => l.name.startsWith('org.lwjgl')), 'the game\'s own native rows are left to vanilla')
  // and its unmarked copies of the game's libraries; Forge's own rows stay
  assert.ok(!own.libraries.some((l) => l.name === 'argo:argo:2.25_fixed'))
  assert.ok(own.libraries.some((l) => l.name === 'com.google.guava:guava:17.0'), 'guava is a row Forge marks')
  assert.ok(own.libraries.some((l) => l.name === 'net.minecraft:launchwrapper:1.12'))
  // in a file that inherits, such a row is one SpawnLoft does not know
  p.versionInfo.inheritsFrom = '1.7.10'
  fs.writeFileSync(jar2, buildZip([['install_profile.json', Buffer.from(JSON.stringify(p))], [p.install.filePath, UNIVERSAL]]))
  assert.throws(() => readInstaller(jar2, { mc: '1.7.10', id: 'x-forge', who: 'Forge', legacy: true }), (err) => err.code === 'loader-installer-unknown')
  // a host the allowlist does not have
  const p3 = read('1.7.10-10.13.4.1614-1.7.10/install_profile.json')
  p3.versionInfo.libraries[3].url = 'https://evil.example/'
  fs.writeFileSync(jar2, buildZip([['install_profile.json', Buffer.from(JSON.stringify(p3))], [p3.install.filePath, UNIVERSAL]]))
  assert.throws(() => readInstaller(jar2, { mc: '1.7.10', id: 'x-forge', who: 'Forge', legacy: true }), /evil\.example/)
})

test('checksums of the old installer\'s rows come from their mavens and must be ones the installer lists', async () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'sums-'))
  const jar = path.join(tmp, 'i.jar')
  fs.writeFileSync(jar, legacyJar('1.12.2-14.23.0.2486'))
  const read2 = () => readInstaller(jar, { mc: '1.12.2', id: '1.12.2-forge-14.23.0.2486', who: 'Forge', legacy: true })
  // the maven's own sum for each row: the installer's first, where it lists any
  const listed = Object.fromEntries(read('1.12.2-14.23.0.2486/install_profile.json').versionInfo.libraries.map((l) => [l.name, l.checksums?.[0]]))
  const maven = async (url) => {
    const r = read2().version.libraries.find((l) => l.downloads.artifact.url === url)
    return listed[r.name] ?? sha1(Buffer.from(r.name))
  }
  let { version, pending } = read2()
  await L.fillLegacyChecksums(version, pending, { sha1Impl: maven })
  assert.ok(version.libraries.every((l) => /^[0-9a-f]{40}$/.test(l.downloads.artifact.sha1)))
  assert.equal(version.libraries.find((l) => l.name === 'org.ow2.asm:asm-all:5.2').downloads.artifact.sha1, '2ea49e08b876bbd33e0a7ce75c8f371d29e1f10a')
  // a maven file that is not the one the installer lists
  ;({ version, pending } = read2())
  await assert.rejects(L.fillLegacyChecksums(version, pending, { sha1Impl: async () => '0'.repeat(40) }), (err) => err.code === 'loader-installer-unknown')
  // a maven without checksum files: the file itself, which must be one the installer lists; a row
  // the installer lists none for is refused
  const got = []
  ;({ version, pending } = read2())
  await assert.rejects(L.fillLegacyChecksums(version, pending, { sha1Impl: async () => { throw new Error('404') }, fileSha1Impl: async (url) => { got.push(url); return maven(url) } }), /Could not read the checksum of net\.minecraft:launchwrapper:1\.12 .*lists none/)
  ;({ version, pending } = read2())
  const listedOnly = pending.filter((p) => p.sums.length)
  await L.fillLegacyChecksums(version, listedOnly, { sha1Impl: async () => { throw new Error('404') }, fileSha1Impl: maven })
  assert.ok(listedOnly.every((p) => p.sums.includes(version.libraries[p.index].downloads.artifact.sha1)))
  ;({ version, pending } = read2())
  await assert.rejects(L.fillLegacyChecksums(version, listedOnly, { sha1Impl: async () => { throw new Error('404') }, fileSha1Impl: async () => 'f'.repeat(40) }), (err) => err.code === 'loader-installer-unknown')
})

test('an old Forge build is set up end to end: its version file with every checksum, the Forge jar taken out of the installer, the stamp', async () => {
  seedLists()
  const full = '1.12.2-14.23.0.2486'
  const jarBytes = legacyJar(full)
  const id = '1.12.2-forge-14.23.0.2486'
  const urls = []
  const fetchImpl = async (url, dest) => { urls.push(url); fs.writeFileSync(dest, jarBytes) }
  const listed = Object.fromEntries(read(`${full}/install_profile.json`).versionInfo.libraries.map((l) => [l.name, l.checksums?.[0]]))
  const { libraryPath } = await import('../src/client-meta.mjs')
  const libSha1Impl = async (url) => {
    const name = Object.keys(listed).find((n) => url.endsWith(`/${libraryPath(n)}`))
    return listed[name] ?? sha1(Buffer.from(url))
  }
  assert.equal(await G.ensureForgeVersion('1.12.2', '14.23.0.2486', { fetchImpl, sha1Impl: async () => sha1(jarBytes), libSha1Impl }), id)
  assert.deepEqual(urls, ['https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.0.2486/forge-1.12.2-14.23.0.2486-installer.jar'])
  const written = JSON.parse(fs.readFileSync(versionJson(id), 'utf8'))
  assert.ok(written.libraries.every((l) => l.downloads.artifact.sha1))
  // steps 2 to 5: no build steps, the Forge jar from the installer, the stamp
  const stages = []
  const r = await G.finishForge('1.12.2', '14.23.0.2486', { name: 'old', java: 'java', fetchImpl, sha1Impl: async () => sha1(jarBytes), onStage: (s) => stages.push(s.message) })
  assert.deepEqual(r, { built: true, steps: 0 })
  const forgeFile = path.join(LIBRARIES_DIR, 'net/minecraftforge/forge/1.12.2-14.23.0.2486/forge-1.12.2-14.23.0.2486.jar')
  assert.deepEqual(fs.readFileSync(forgeFile), UNIVERSAL)
  assert.ok(await stampHolds(id))
  assert.equal(loaderFor('forge').isInstalled('1.12.2', '14.23.0.2486'), true)
  assert.ok(!stages.some((m) => /step \d+ of/.test(m)))
  // the launch: launchwrapper, the tweaker, the Forge jar on the classpath
  const merged = mergeInherited(written, F.loadVersion('1.12.2'))
  const cmd = buildCommand({ version: merged, profile: { mc: '1.12.2', loader: 'forge', memory: '4G', server: null }, profileName: 'old', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  assert.ok(cmd.args.includes('net.minecraft.launchwrapper.Launch'))
  assert.ok(cmd.args.includes('--tweakClass'))
  assert.ok(!cmd.args.some((a) => /\$\{/.test(a)))
  const cp = cmd.args[cmd.args.indexOf('-cp') + 1]
  assert.ok(cp.includes('forge-1.12.2-14.23.0.2486.jar'))
  const names = classpathRows(libraries(merged, { os: linux })).map((x) => x.name)
  assert.equal(new Set(names).size, names.length)
})

test('1.7.10 launches on launchwrapper with Forge\'s arguments, every value filled in', async () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'l1710-'))
  const jar = path.join(tmp, 'i.jar')
  fs.writeFileSync(jar, legacyJar('1.7.10-10.13.4.1614-1.7.10'))
  const { version } = readInstaller(jar, { mc: '1.7.10', id: '1.7.10-forge-10.13.4.1614-1.7.10', who: 'Forge', legacy: true })
  const merged = mergeInherited(version, F.loadVersion('1.7.10'))
  const cmd = buildCommand({ version: merged, profile: { mc: '1.7.10', loader: 'forge', memory: '4G', server: null }, profileName: 'o', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  assert.ok(cmd.args.includes('cpw.mods.fml.common.launcher.FMLTweaker'))
  assert.ok(!cmd.args.some((a) => /\$\{/.test(a)), cmd.args.filter((a) => /\$\{/.test(a)).join(' '))
  const names = classpathRows(libraries(merged, { os: linux })).map((x) => x.name)
  assert.equal(new Set(names).size, names.length)
  // Java 8, Mojang's first
  assert.deepEqual([G.forgeJava(javaRequirement(F.loadVersion('1.7.10'))).max, G.forgeJava(javaRequirement(F.loadVersion('1.7.10'))).mojangFirst], [8, true])
})
