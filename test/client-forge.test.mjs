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
  assert.ok(games.every((g) => G.forgeModernMc(g.version) && g.stable))
  assert.ok(G.forgeAvailable('1.20.1', games))
  assert.ok(G.forgeAvailable('1.16.5', games))
  assert.ok(!G.forgeAvailable('1.12.2', games), '1.12.2 and older come in a later SpawnLoft')
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
  assert.throws(() => G.pickForge(b1201, '47.9.9'), /not published/)
  // a version with no recommended build: the newest
  assert.equal(G.pickForge([{ version: '1.0.2', stable: true, recommended: false }, { version: '1.0.1', stable: true, recommended: false }]).version, '1.0.2')
})

test('Forge refuses what it cannot set up, before any download', async () => {
  seedLists()
  await assert.rejects(G.assertForgeAvailable('1.12.2'), (err) => err.code === 'loader-not-available' && /^Forge for Minecraft 1\.12\.2 is coming in a later SpawnLoft\. Use None for now\.$/.test(err.message))
  await assert.rejects(G.assertForgeAvailable('1.7.10'), /coming in a later SpawnLoft/)
  await assert.rejects(G.assertForgeAvailable('26.4-snapshot-6', { kind: 'snapshot' }), (err) => err.code === 'loader-not-available' && /no build for Minecraft 26\.4-snapshot-6 yet/.test(err.message))
  await G.assertForgeAvailable('1.20.1')
  await assert.rejects(G.forgeBuilds('1.12.2'), (err) => err.code === 'loader-not-available')
  await assert.rejects(G.forgeBuilds('1.99'), /Forge has no build for Minecraft 1\.99/)
  await assert.rejects(G.ensureForgeVersion('1.20.1', '../47.4.28', { fetchImpl: offline }), /not a valid version/)
  await assert.rejects(G.ensureForgeVersion('1.20.1', '47.4.28-beta', { fetchImpl: offline }), /not a Forge build/)
  await assert.rejects(G.ensureForgeVersion('1.12.2', '14.23.5.2864', { fetchImpl: offline }), /coming in a later SpawnLoft/)
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
  assert.deepEqual(G.forgeJava(j1165), { ...j1165, max: 8, prefer: 8 })
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
