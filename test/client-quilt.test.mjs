// Quilt (Forge, NeoForge and Quilt plan, phase 1), on Quilt meta's real files
// (test/fixtures/client/loaders/quilt).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-quilt-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const Q = await import('../src/client-quilt.mjs')
const { loaderHostAllowed } = await import('../src/client-loader-hosts.mjs')
const { versionJson } = await import('../src/client-paths.mjs')
const { mergeInherited, libraries, classpathRows } = await import('../src/client-meta.mjs')
const { resolveVersion, resolvedRefusal } = await import('../src/client-version.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')
const { loaderFor } = await import('../src/client-loaders.mjs')

const DIR = path.join(F.FIXTURE_DIR, 'loaders', 'quilt')
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
const linux = { name: 'linux', arch: 'x64', version: '6.1.0' }

function fakeMeta(mc, loader) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url === `${Q.QUILT_META}/versions/loader/${encodeURIComponent(mc)}/${loader}/profile/json`) return read(`profile-${mc}-${loader}.json`)
    if (url === `${Q.QUILT_META}/versions/loader/${encodeURIComponent(mc)}`) return read(`loader-${mc}.json`)
    throw new Error(`unexpected ${url}`)
  }
  const sums = read(`sidecars-${mc}-${loader}.json`)
  const fetchSha1Impl = async (url) => {
    calls.push(`${url}.sha1`)
    const row = Object.values(sums).find((s) => s.url === url)
    if (!row) throw new Error(`no sidecar for ${url}`)
    return row.sha1
  }
  return { calls, fetchImpl, fetchSha1Impl }
}

test('Quilt\'s builds: newest first, a -beta is a beta, and the first Play takes the newest that is not', async () => {
  const { fetchImpl } = fakeMeta('26.3', '0.30.2')
  const builds = await Q.quiltBuilds('26.3', { fetchImpl })
  assert.equal(builds[0].version, '0.31.0-beta.6')
  assert.equal(builds[0].stable, false)
  assert.deepEqual(Q.pickQuilt(builds), { version: '0.30.2', stable: true })
  assert.equal(Q.pickQuilt(builds, '0.31.0-beta.6').version, '0.31.0-beta.6')
  assert.throws(() => Q.pickQuilt(builds, '9.9.9'), /Quilt loader 9\.9\.9 is not published/)
  // only betas: the newest beta
  assert.deepEqual(Q.pickQuilt([{ version: '0.31.0-beta.2', stable: false }, { version: '0.31.0-beta.1', stable: false }]), { version: '0.31.0-beta.2', stable: false })
  assert.throws(() => Q.pickQuilt([]), { code: 'loader-not-available' })
  for (const [v, stable] of [['0.30.2', true], ['0.30.2-beta.1', false], ['1.0.0-rc.1', false], ['0.17.0-pre.3', false], ['0.29.0+local', true], ['0.20.0-pre1', false], ['0.18.0-rc2', false], ['0.19.0-SNAPSHOT', false]]) {
    assert.equal(Q.quiltBuildStable(v), stable, v)
  }
})

test('Quilt\'s game list: what it builds for, and a version it does not is refused before anything downloads', async () => {
  const list = read('game-versions.json')
  assert.equal(Q.quiltAvailable('1.20.1', list), true)
  assert.equal(Q.quiltAvailable('1.12.2', list), false)
  const cacheDir = fs.mkdtempSync(path.join(scratch, 'cache-'))
  fs.writeFileSync(path.join(cacheDir, 'quilt-game-versions.json'), JSON.stringify(list))
  fs.writeFileSync(path.join(cacheDir, 'quilt-game-versions.json.fetched-at'), String(Date.now()))
  await Q.assertQuiltAvailable('1.20.1', { cacheDir })
  await assert.rejects(Q.assertQuiltAvailable('1.12.2', { cacheDir, fetchImpl: async () => list }), { code: 'loader-not-available', message: 'Quilt has no build for Minecraft 1.12.2. Use None, or a version Quilt supports.' })
  await assert.rejects(Q.assertQuiltAvailable('27.1-snapshot-1', { kind: 'snapshot', cacheDir, fetchImpl: async () => list }), /Quilt has no loader for Minecraft 27\.1-snapshot-1 yet/)
})

test('a Quilt profile is written with each library\'s sha1 from the .sha1 its maven publishes, once', async () => {
  const { calls, fetchImpl, fetchSha1Impl } = fakeMeta('26.3', '0.30.2')
  const id = await Q.ensureQuiltProfile('26.3', '0.30.2', { fetchImpl, fetchSha1Impl })
  assert.equal(id, 'quilt-loader-0.30.2-26.3')
  const written = JSON.parse(fs.readFileSync(versionJson(id), 'utf8'))
  const sums = read('sidecars-26.3-0.30.2.json')
  for (const lib of written.libraries) assert.equal(lib.sha1, sums[lib.name].sha1, lib.name)
  assert.equal(calls.filter((u) => u.endsWith('.sha1')).length, written.libraries.length)
  // on disk and whole: nothing is asked again
  calls.length = 0
  assert.equal(await Q.ensureQuiltProfile('26.3', '0.30.2', { fetchImpl, fetchSha1Impl }), id)
  assert.equal(calls.length, 0)
  // and the downloader sees every row with its checksum
  const rows = libraries(mergeInherited(written, F.loadVersion('26.3')), { os: linux })
  assert.ok(rows.every((r) => r.native !== false || /^[0-9a-f]{40}$/.test(r.sha1)))
})

test('a Quilt profile that names another id, parent or host is refused, and nothing is written', async () => {
  const profile = read('profile-26.3-0.30.2.json')
  const fetchSha1Impl = async () => '0'.repeat(40)
  const cases = [
    [{ ...profile, id: 'quilt-loader-0.30.2-26.2' }, /answered for a different profile/],
    [{ ...profile, inheritsFrom: '26.2' }, /inherits from 26\.2, not 26\.3/],
    [{ ...profile, libraries: [{ name: 'evil:jar:1', url: 'https://example.net/' }] }, (err) => err.code === 'loader-host-refused'],
    [{ ...profile, libraries: [{ name: 'evil:jar:1', url: 'http://maven.quiltmc.org/repository/release/' }] }, (err) => err.code === 'loader-host-refused'],
    [{ ...profile, libraries: [{ name: 'a:b:1', downloads: { artifact: {} } }] }, /shape SpawnLoft does not know/],
  ]
  for (const [answer, expected] of cases) {
    fs.rmSync(path.dirname(versionJson('quilt-loader-0.30.2-26.3')), { recursive: true, force: true })
    await assert.rejects(Q.ensureQuiltProfile('26.3', '0.30.2', { fetchImpl: async () => structuredClone(answer), fetchSha1Impl }), expected)
    assert.ok(!fs.existsSync(versionJson('quilt-loader-0.30.2-26.3')))
  }
  await assert.rejects(Q.ensureQuiltProfile('26.3', '../0.30.2', { fetchImpl: async () => profile, fetchSha1Impl }), /not a valid version/)
})

test('a Quilt library base without its trailing slash is written with one, so the downloader fetches the URL that was checked', async () => {
  const profile = read('profile-26.3-0.30.2.json')
  const answer = structuredClone(profile)
  answer.libraries = [{ name: 'org.quiltmc:quilt-loader:0.30.2', url: 'https://maven.quiltmc.org/repository/release' }]
  const seen = []
  fs.rmSync(path.dirname(versionJson('quilt-loader-0.30.2-26.3')), { recursive: true, force: true })
  await Q.ensureQuiltProfile('26.3', '0.30.2', { fetchImpl: async () => answer, fetchSha1Impl: async (url) => { seen.push(url); return '1'.repeat(40) } })
  const written = JSON.parse(fs.readFileSync(versionJson('quilt-loader-0.30.2-26.3'), 'utf8'))
  assert.equal(written.libraries[0].url, 'https://maven.quiltmc.org/repository/release/')
  assert.deepEqual(seen, ['https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.30.2/quilt-loader-0.30.2.jar'])
  fs.rmSync(path.dirname(versionJson('quilt-loader-0.30.2-26.3')), { recursive: true, force: true })
})

test('the loader hosts: https on the loaders\' and Mojang\'s own hosts only', () => {
  for (const ok of ['https://maven.quiltmc.org/x.jar', 'https://maven.fabricmc.net/x.jar', 'https://libraries.minecraft.net/x.jar', 'https://maven.neoforged.net/x', 'https://maven.minecraftforge.net/x']) assert.equal(loaderHostAllowed(ok), true, ok)
  for (const bad of ['http://maven.quiltmc.org/x.jar', 'https://maven.quiltmc.org.evil.net/x', 'https://user@maven.quiltmc.org/x', 'https://maven.quiltmc.org:8443/x', 'file:///etc/passwd', 'not a url']) assert.equal(loaderHostAllowed(bad), false, bad)
})

test('a Quilt setup on 26.3 resolves with nothing SpawnLoft does not know, and launches with Knot and one asm', () => {
  const merged = mergeInherited(read('profile-26.3-0.30.2.json'), F.loadVersion('26.3'))
  for (const os of F.OS_PAIRS) {
    const resolved = resolveVersion(merged, { os, hostCaps: { x64: true } })
    const refusal = resolvedRefusal(resolved)
    assert.ok(!refusal || refusal.code === 'no-natives-for-this-machine', `${F.pairName(os)}: ${refusal?.message}`)
  }
  const cmd = buildCommand({ version: merged, profile: { mc: '26.3', loader: 'quilt', memory: '4G', server: null }, profileName: 'q', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  assert.ok(cmd.args.includes('org.quiltmc.loader.impl.launch.knot.KnotClient'))
  const cp = classpathRows(libraries(merged, { os: linux })).map((r) => r.name)
  assert.equal(cp.filter((n) => n.startsWith('org.ow2.asm:asm:')).length, 1)
  assert.ok(cp.includes('org.quiltmc:quilt-loader:0.30.2'))
})

test('Quilt behind the loader list: its id, its stage and Fabric API in its mods folder', () => {
  const quilt = loaderFor('quilt')
  assert.equal(quilt.name, 'Quilt')
  assert.equal(quilt.versionId('1.20.1', '0.30.2'), 'quilt-loader-0.30.2-1.20.1')
  assert.equal(quilt.isInstalled('1.20.1', '0.30.2'), false)
  assert.match(String(quilt.afterInstall), /ensureFabricApi/)
})
