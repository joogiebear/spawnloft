// NeoForge in the launcher (Forge, NeoForge and Quilt plan, phase 2), on the NeoForged maven's
// real files (test/fixtures/client/loaders/neoforge).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-neoforge-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const N = await import('../src/client-neoforge.mjs')
const { CLIENT_CACHE_DIR, versionJson } = await import('../src/client-paths.mjs')
const { stampFile } = await import('../src/client-forge-install.mjs')
const { mergeInherited, libraries, classpathRows } = await import('../src/client-meta.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')
const { loaderFor } = await import('../src/client-loaders.mjs')
const { buildZip } = await import('./fixtures/zip-writer.mjs')

const DIR = path.join(F.FIXTURE_DIR, 'loaders', 'neoforge')
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
const linux = { name: 'linux', arch: 'x64', version: '6.1.0' }
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')

function seedList() {
  fs.mkdirSync(CLIENT_CACHE_DIR, { recursive: true })
  fs.copyFileSync(path.join(DIR, 'versions.json'), path.join(CLIENT_CACHE_DIR, 'neoforge-versions.json'))
  fs.writeFileSync(path.join(CLIENT_CACHE_DIR, 'neoforge-versions.json.fetched-at'), String(Date.now()))
}

test('a NeoForge build names its Minecraft version, in both of NeoForge\'s schemes', () => {
  assert.equal(N.neoforgeMc('20.2.3-beta'), '1.20.2')
  assert.equal(N.neoforgeMc('20.4.253'), '1.20.4')
  assert.equal(N.neoforgeMc('21.0.167'), '1.21')
  assert.equal(N.neoforgeMc('21.1.266'), '1.21.1')
  assert.equal(N.neoforgeMc('21.11.4-beta'), '1.21.11')
  assert.equal(N.neoforgeMc('26.3.0.103'), '26.3')
  assert.equal(N.neoforgeMc('26.1.2.14'), '26.1.2')
  assert.equal(N.neoforgeMc('0.25w14craftmine.3-beta'), null)
  assert.equal(N.neoforgeMc('47.1.0'), null)
  assert.equal(N.neoforgeStable('21.1.266'), true)
  assert.equal(N.neoforgeStable('26.3.0.1-beta'), false)
})

test('NeoForge\'s lists from the real maven list: its versions, newest first, and the build a first Play takes', async () => {
  seedList()
  const games = await N.neoforgeGameVersions({ fetchImpl: async () => { throw new Error('network used') } })
  assert.equal(games[0].version, '26.3')
  assert.ok(N.neoforgeAvailable('1.20.4', games))
  assert.ok(N.neoforgeAvailable('1.21.1', games))
  assert.ok(!N.neoforgeAvailable('1.20.1', games), 'NeoForge for 1.20.1 is the old forge artifact, not this one')
  assert.ok(!N.neoforgeAvailable('1.12.2', games))
  // 1.20.3 had betas only
  assert.equal(games.find((g) => g.version === '1.20.3').stable, false)
  const builds = await N.neoforgeBuilds('1.21.1')
  assert.equal(builds[0].version, '21.1.266')
  assert.ok(builds.every((b, i) => i === 0 || builds[i - 1].version !== b.version))
  assert.equal(N.pickNeoforge(builds).version, '21.1.266')
  assert.equal(N.pickNeoforge(await N.neoforgeBuilds('26.3')).version, '26.3.0.103')
  // only betas: the newest beta
  const betas = await N.neoforgeBuilds('1.20.3')
  assert.ok(betas.every((b) => !b.stable))
  assert.equal(N.pickNeoforge(betas).version, betas[0].version)
  assert.equal(N.pickNeoforge(builds, '21.1.200').version, '21.1.200')
  assert.throws(() => N.pickNeoforge(builds, '21.1.9999'), /not published/)
  await assert.rejects(N.neoforgeBuilds('1.12.2'), (err) => err.code === 'loader-not-available' && /^NeoForge has no build for Minecraft 1\.12\.2\. Use None, or a version NeoForge supports\.$/.test(err.message))
  await assert.rejects(N.assertNeoforgeAvailable('1.12.2'), (err) => err.code === 'loader-not-available')
  await N.assertNeoforgeAvailable('1.21.1')
})

test('step 1: the installer is fetched, checked, and its version file written; the loader is not set up until stamped', async () => {
  const build = '21.1.266'
  const jar = buildZip([
    ['install_profile.json', fs.readFileSync(path.join(DIR, build, 'install_profile.json'))],
    ['version.json', fs.readFileSync(path.join(DIR, build, 'version.json'))],
  ])
  const urls = []
  const fetchImpl = async (url, dest) => { urls.push(url); fs.writeFileSync(dest, jar) }
  const id = await N.ensureNeoforgeVersion('1.21.1', build, { fetchImpl, sha1Impl: async () => sha1(jar) })
  assert.equal(id, 'neoforge-21.1.266')
  assert.deepEqual(urls, ['https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.266/neoforge-21.1.266-installer.jar'])
  assert.deepEqual(JSON.parse(fs.readFileSync(versionJson(id), 'utf8')), read(`${build}/version.json`))
  const neo = loaderFor('neoforge')
  assert.equal(neo.isInstalled('1.21.1', build), false)
  fs.writeFileSync(stampFile(id), JSON.stringify({ format: 1, files: {} }))
  assert.equal(neo.isInstalled('1.21.1', build), true)
  // set up: a Play needs neither the installer nor the network
  assert.equal(await N.ensureNeoforgeVersion('1.21.1', build, { fetchImpl: async () => { throw new Error('network used') }, sha1Impl: async () => { throw new Error('network used') } }), id)
  // a build for another version, or a name that is no build, is refused before any download
  await assert.rejects(N.ensureNeoforgeVersion('1.20.4', build, { fetchImpl }), /not a build for Minecraft 1\.20\.4/)
  await assert.rejects(N.ensureNeoforgeVersion('1.21.1', '../21.1.266', { fetchImpl }), /not a valid version/)
  assert.equal(urls.length, 1)
})

test('the launch follows the installer\'s version file: module path, NeoForge\'s main class and its own arguments', () => {
  for (const [build, mc, main] of [['20.4.253', '1.20.4', 'cpw.mods.bootstraplauncher.BootstrapLauncher'], ['26.3.0.103', '26.3', 'net.neoforged.fml.startup.Client']]) {
    const merged = mergeInherited(read(`${build}/version.json`), F.loadVersion(mc))
    const cmd = buildCommand({ version: merged, profile: { mc, loader: 'neoforge', memory: '4G', server: null }, profileName: 'n', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
    assert.ok(cmd.args.includes(main), build)
    assert.ok(cmd.args.includes('--fml.neoForgeVersion') && cmd.args.includes(build), build)
    assert.ok(!cmd.args.some((a) => /\$\{/.test(a)), `${build}: every launch value is filled in`)
    const cp = classpathRows(libraries(merged, { os: linux })).map((r) => r.name)
    assert.equal(new Set(cp).size, cp.length, build)
  }
  const merged = mergeInherited(read('20.4.253/version.json'), F.loadVersion('1.20.4'))
  const cmd = buildCommand({ version: merged, profile: { mc: '1.20.4', loader: 'neoforge', memory: '4G', server: null }, profileName: 'n', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  const p = cmd.args.indexOf('-p')
  assert.ok(p > 0 && cmd.args[p + 1].includes('bootstraplauncher-1.1.2.jar'))
  assert.ok(cmd.args.some((a) => a.startsWith('-DignoreList=') && a.endsWith(',neoforge-20.4.253.jar')))
})

test('NeoForge behind the loader list: its id, its build steps and nothing for the mods folder', () => {
  const neo = loaderFor('neoforge')
  assert.equal(neo.name, 'NeoForge')
  assert.equal(neo.versionId('26.3', '26.3.0.103'), 'neoforge-26.3.0.103')
  assert.equal(typeof neo.finishInstall, 'function')
  assert.equal(neo.afterInstall, null)
})
