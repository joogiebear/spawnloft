import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Version ids by Mojang's list rather than by shape (plan 4.4), and Fabric for ids with spaces.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-ids-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const client = await import('../src/client.mjs')
const { CLIENT_CACHE_DIR, versionDir, versionJson, profileDir } = await import('../src/client-paths.mjs')
const { META_URL, loaderVersions, ensureFabricProfile, fabricVersionId, fabricAvailable, assertFabricAvailable } = await import('../src/client-fabric.mjs')

const F_DIR = path.dirname(fileURLToPath(import.meta.url))
const eras = F.loadErasManifest()
const fabricList = JSON.parse(fs.readFileSync(path.join(F_DIR, 'fixtures', 'client', 'fabric-game-versions.json'), 'utf8'))

// the cached lists, as fetched a moment ago
function seed(file, body, age = 0) {
  fs.mkdirSync(CLIENT_CACHE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CLIENT_CACHE_DIR, file), JSON.stringify(body))
  fs.writeFileSync(path.join(CLIENT_CACHE_DIR, `${file}.fetched-at`), String(Date.now() - age))
}
const noNetwork = async () => { throw new Error('network used') }

test('ids: any id Mojang lists is taken as it is, trimmed, spaces and old shapes included', async () => {
  seed('version_manifest_v2.json', eras)
  for (const id of ['26.4-snapshot-6', '1.21.11-rc3', '1.14.2 Pre-Release 4', 'b1.7.3', 'rd-132211', '3D Shareware v1.34']) {
    assert.equal((await client.assertVersionId(id, { fetchImpl: noNetwork })).mc, id)
  }
  assert.equal((await client.assertVersionId(' 1.21.11 ', { fetchImpl: noNetwork })).mc, '1.21.11')
  await assert.rejects(client.assertVersionId('1.21.11.', { fetchImpl: noNetwork }), /invalid Minecraft version "1\.21\.11\."/)
})

test('ids: an id the list lacks asks Mojang once more, then is refused with the nearest ids', async () => {
  seed('version_manifest_v2.json', eras, 2 * 60000)
  let fetched = 0
  const fresh = { ...eras, versions: [{ id: '26.5', type: 'release', url: 'https://x/26.5.json', sha1: 'a'.repeat(40), releaseTime: '2026-11-01T00:00:00+00:00' }, ...eras.versions] }
  assert.equal((await client.assertVersionId('26.5', { fetchImpl: async () => { fetched++; return fresh } })).mc, '26.5', 'a release out since the list was cached')
  assert.equal(fetched, 1)
  // the list is now under a minute old, so a typo does not ask again
  await assert.rejects(client.assertVersionId('26.9', { fetchImpl: noNetwork }), (err) => {
    assert.equal(err.code, 'unknown-version')
    assert.equal(err.message, 'Mojang\'s version list has no "26.9"; check the id (releases look like 26.3, snapshots like 26.4-snapshot-6, old versions like b1.7.3). Did you mean 26.5, 26.4-snapshot-6, 26.3, 26.1?')
    return true
  })
  await assert.rejects(client.assertVersionId('1.14.2 pre-release 4', { fetchImpl: noNetwork }), /Did you mean 1\.14\.2 Pre-Release 4\?/)
  await assert.rejects(client.assertVersionId('zzz', { fetchImpl: noNetwork }), /check the id \(releases look like 26\.3, snapshots like 26\.4-snapshot-6, old versions like b1\.7\.3\)$/)
})

test('ids: offline with no list, only a downloaded version is accepted', async () => {
  fs.rmSync(path.join(CLIENT_CACHE_DIR, 'version_manifest_v2.json'), { force: true })
  await assert.rejects(client.assertVersionId('1.20.4', { fetchImpl: noNetwork }), { message: 'the Minecraft version list is not available offline and "1.20.4" is not downloaded' })
  fs.mkdirSync(versionDir('1.20.4'), { recursive: true })
  fs.writeFileSync(versionJson('1.20.4'), JSON.stringify(F.loadVersion('1.20.4')))
  assert.equal((await client.assertVersionId('1.20.4', { fetchImpl: noNetwork })).mc, '1.20.4')
  // a loader profile's id on disk is not a Minecraft version
  const fabricId = fabricVersionId('1.20.4', '0.16.9')
  fs.mkdirSync(versionDir(fabricId), { recursive: true })
  fs.writeFileSync(versionJson(fabricId), JSON.stringify({ id: fabricId, inheritsFrom: '1.20.4' }))
  await assert.rejects(client.assertVersionId(fabricId, { fetchImpl: noNetwork }), /not available offline/)
})

test('Fabric: refused before anything downloads where Fabric has no build, allowed for spaced ids', async () => {
  seed('version_manifest_v2.json', eras)
  seed('fabric-game-versions.json', fabricList)
  assert.equal(fabricAvailable('1.14.2 Pre-Release 4', fabricList), true)
  assert.equal(fabricAvailable('1.12.2', fabricList), false)
  await assert.rejects(client.checkProfileVersion({ mc: '1.12.2', loader: 'fabric' }, { fetchImpl: noNetwork }), {
    code: 'fabric-not-available',
    message: 'Fabric has no build for Minecraft 1.12.2; use Vanilla for it, or a version Fabric supports',
  })
  assert.equal(await client.checkProfileVersion({ mc: '1.12.2', loader: 'vanilla' }, { fetchImpl: noNetwork }), '1.12.2')
  assert.equal(await client.checkProfileVersion({ mc: '1.14.2 Pre-Release 4', loader: 'fabric' }, { fetchImpl: noNetwork }), '1.14.2 Pre-Release 4')
  // a list that cannot be read decides nothing
  fs.rmSync(path.join(CLIENT_CACHE_DIR, 'fabric-game-versions.json'))
  await assertFabricAvailable('1.12.2', { fetchImpl: noNetwork })
})

test('Fabric: a spaced id is percent-encoded in Fabric\'s URLs and kept as it is in the profile id and its folder', async () => {
  const mc = '1.14.2 Pre-Release 4'
  const urls = []
  await loaderVersions(mc, { fetchImpl: async (url) => { urls.push(url); return [{ loader: { version: '0.16.9', stable: true } }] } })
  const id = fabricVersionId(mc, '0.16.9')
  assert.equal(id, 'fabric-loader-0.16.9-1.14.2 Pre-Release 4')
  const profile = { ...F.loadFabricProfile('1.14.4'), id, inheritsFrom: mc }
  assert.equal(await ensureFabricProfile(mc, '0.16.9', { fetchImpl: async (url) => { urls.push(url); return profile } }), id)
  assert.deepEqual(urls, [
    `${META_URL}/versions/loader/1.14.2%20Pre-Release%204`,
    `${META_URL}/versions/loader/1.14.2%20Pre-Release%204/0.16.9/profile/json`,
  ])
  assert.ok(fs.existsSync(versionJson(id)))
  await assert.rejects(loaderVersions('../1.14', { fetchImpl: noNetwork }), /not a valid version/)
})

test('a profile on a spaced id saves, and its folders are ordinary ones', () => {
  const made = client.createProfile('spaced', { mc: ' 1.14.2 Pre-Release 4 ', loader: 'fabric' })
  assert.equal(made.mc, '1.14.2 Pre-Release 4')
  assert.ok(fs.existsSync(profileDir('spaced')))
  assert.equal(client.updateProfile('spaced', { mc: '1.14.4 ' }).mc, '1.14.4')
  client.removeProfile('spaced', { purge: true })
})

test('the picker lists every id Mojang does, with its kind, newest first, and Fabric when asked', async () => {
  seed('version_manifest_v2.json', eras)
  seed('fabric-game-versions.json', fabricList)
  const { versions } = await client.listVersions({ os: { name: 'linux', arch: 'x64', version: '6' }, fabric: true })
  assert.equal(versions.length, eras.versions.length)
  const times = versions.map((v) => Date.parse(v.releaseTime))
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
  const row = (id) => versions.find((v) => v.id === id)
  assert.equal(row('1.14.2 Pre-Release 4').kind, 'pre-release')
  assert.equal(row('1.14.2 Pre-Release 4').fabric, true)
  assert.equal(row('1.12.2').fabric, false)
  assert.equal(row('b1.7.3').kind, 'beta')
  assert.equal(row('b1.7.3').javaNeeds, 8)
  assert.equal(row('b1.7.3').javaNeedsExact, false)
  // 1.20.4 is on disk (the offline test put it there): its Java is read, not guessed
  assert.equal(row('1.20.4').javaNeeds, 17)
  assert.equal(row('1.20.4').javaNeedsExact, true)
  const plain = await client.listVersions({ os: { name: 'linux', arch: 'x64', version: '6' } })
  assert.equal(plain.versions[0].fabric, null, 'not asked for, not read')
})

test('describeVersion answers what a launch would decide, from the version\'s own file', async () => {
  seed('version_manifest_v2.json', eras)
  seed('fabric-game-versions.json', fabricList)
  const d = await client.describeVersion('1.20.4', { os: { name: 'linux', arch: 'x64', version: '6' }, fetchImpl: noNetwork })
  assert.deepEqual({ ...d, java: undefined, problems: undefined }, {
    id: '1.20.4', type: 'release', kind: 'release', releaseTime: d.releaseTime, javaNeeds: 17, javaNeedsExact: true, java: undefined,
    arch: 'x64', emulated: false, fabric: true, harness: false, refusal: null, code: null, problems: undefined,
  })
  const arm = await client.describeVersion('1.20.4', { os: { name: 'linux', arch: 'arm64', version: '6' }, fetchImpl: noNetwork })
  assert.equal(arm.code, 'no-natives-for-this-machine')
})
