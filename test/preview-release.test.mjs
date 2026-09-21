import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { TARGETS, manifestName, artifactNames, createManifest, verifyRelease, verifyPublishedRelease, verifyWindowsFeed } from '../desktop/preview-artifacts.mjs'

const identity = { sourceVersion: '0.15.0-beta.1', version: '0.15.0-beta.3', commit: 'a'.repeat(40), dirty: false }
const installer = Buffer.from('fixture NSIS installer bytes')
const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
const installerName = `SpawnLoft-Setup-${identity.version}.exe`
const feed = `version: ${identity.version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${installerName}\nsha512: ${sha512}\nreleaseDate: '2026-09-11T12:00:00.000Z'\n`

// The Linux feed is the same shape about a different file: the .deb, under the platform's feed names.
const debPackage = Buffer.from('fixture Debian package bytes')
const debSha512 = crypto.createHash('sha512').update(debPackage).digest('base64')
const debName = `SpawnLoft-${identity.version}-linux-amd64.deb`
const linuxFeed = `version: ${identity.version}\nfiles:\n  - url: ${debName}\n    sha512: ${debSha512}\n    size: ${debPackage.length}\npath: ${debName}\nsha512: ${debSha512}\nreleaseDate: '2026-09-11T12:00:00.000Z'\n`

function fixtureBytes(name) {
  if (name.endsWith('-linux.yml')) return linuxFeed
  if (name.endsWith('.yml')) return feed
  if (name.endsWith('.exe')) return installer
  if (name.endsWith('.deb')) return debPackage
  return Buffer.from(name)
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-preview-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const target of TARGETS) {
    for (const name of artifactNames({ ...identity, ...target })) {
      fs.writeFileSync(path.join(dir, name), fixtureBytes(name))
    }
    writeManifest(dir, target, createManifest(dir, { ...identity, ...target, macSigningMode: 'ad-hoc' }, target))
  }
  return dir
}

function writeManifest(dir, target, data) {
  fs.writeFileSync(path.join(dir, manifestName(target)), JSON.stringify(data, null, 2) + '\n')
}

function modifyManifest(dir, target, change) {
  const info = JSON.parse(fs.readFileSync(path.join(dir, manifestName(target)), 'utf8'))
  change(info)
  writeManifest(dir, target, info)
}

test('paired release verifies Windows, both native Mac builds and Linux, including every updater feed', t => {
  const verified = verifyRelease(fixture(t), identity)
  assert.equal(verified.assets.length, 15)
  assert.equal(verified.version, identity.version)
  assert.deepEqual(verified.assets.filter(asset => asset.name.endsWith('.yml')).map(asset => asset.name),
    ['latest.yml', 'beta.yml', 'latest-linux.yml', 'beta-linux.yml'])
  assert.ok(verified.assets.some(asset => asset.name === debName))
})

test('a Linux feed that does not describe the package it ships with stops the release', t => {
  const dir = fixture(t)
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), linuxFeed.replace(`path: ${debName}`, 'path: other.deb'))
  fs.copyFileSync(path.join(dir, 'latest-linux.yml'), path.join(dir, 'beta-linux.yml'))
  const linux = TARGETS.find(target => target.platform === 'linux')
  modifyManifest(dir, linux, info => {
    for (const asset of info.assets.filter(a => a.name.endsWith('-linux.yml'))) {
      const bytes = fs.readFileSync(path.join(dir, asset.name))
      asset.size = bytes.length
      asset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    }
  })
  assert.throws(() => verifyRelease(dir, identity), /does not match the verified installer/)
  // The two names are one feed; a beta installation must not be told something different.
  const other = fixture(t)
  fs.appendFileSync(path.join(other, 'beta-linux.yml'), '\n')
  assert.throws(() => createManifest(other, { ...identity, ...linux }, linux), /must be identical/)
})

test('paired release refuses missing platform manifests and missing installer bytes', async t => {
  for (const target of TARGETS) await t.test(`${target.platform}/${target.arch}`, t => {
    const dir = fixture(t)
    fs.unlinkSync(path.join(dir, manifestName(target)))
    assert.throws(() => verifyRelease(dir, identity), /ENOENT/)
  })
  await t.test('missing installer', t => {
    const dir = fixture(t)
    fs.unlinkSync(path.join(dir, installerName))
    assert.throws(() => verifyRelease(dir, identity), /ENOENT/)
  })
})

test('paired release refuses mixed or unclean build identities', async t => {
  const cases = [
    ['version', '0.15.0-beta.4'], ['commit', 'b'.repeat(40)], ['sourceVersion', '0.15.0-beta.2'],
    ['arch', 'x64'], ['platform', 'win32'], ['dirty', true], ['dirty', undefined],
    ['sourceVersion', '0.15.0'], ['version', '0.15.0'], ['version', '0.15.0-preview.3'],
    ['version', '0.15.0-beta.1'], ['version', '0.15.0-beta.03'], ['commit', 'short'],
  ]
  for (const [key, value] of cases) await t.test(`${key}=${value}`, t => {
    const dir = fixture(t)
    modifyManifest(dir, TARGETS[1], info => { info[key] = value })
    assert.throws(() => verifyRelease(dir, identity), /Unexpected build|clean development|numbered beta|newer than/)
  })
})

test('paired release verifies bytes and exact artifact lists', async t => {
  await t.test('changed bytes', t => {
    const dir = fixture(t)
    fs.appendFileSync(path.join(dir, installerName), 'tampering')
    assert.throws(() => verifyRelease(dir, identity), /Artifact verification failed/)
  })
  for (const [label, change] of [
    ['checksum', info => { info.assets[0].sha256 = '0'.repeat(64) }],
    ['size', info => { info.assets[0].size++ }],
    ['duplicate', info => { info.assets[1] = info.assets[0] }],
    ['unexpected path', info => { info.assets[0].name = '../outside.dmg' }],
    ['extra artifact', info => { info.assets.push({ name: 'extra.zip' }) }],
  ]) await t.test(label, t => {
    const dir = fixture(t)
    modifyManifest(dir, TARGETS[1], change)
    assert.throws(() => verifyRelease(dir, identity), /Artifact verification failed|Unexpected artifact list/)
  })
})

test('Windows updater feed must point to the exact verified installer', () => {
  assert.doesNotThrow(() => verifyWindowsFeed(feed, identity.version, installerName, installer))
  for (const corrupted of [
    feed.replace(identity.version, '0.15.0-beta.2'),
    feed.replace(`url: ${installerName}`, 'url: https://example.com/other.exe'),
    feed.replace(`path: ${installerName}`, 'path: other.exe'),
    feed.replace(sha512, 'wrong-checksum'),
    feed.replace(`size: ${installer.length}`, 'size: 1'),
    feed + '\nversion: 0.15.0-beta.3\n',
    feed.replace('    size:', '    unknown:'),
  ]) assert.throws(() => verifyWindowsFeed(corrupted, identity.version, installerName, installer), /Windows updater feed/)
})

test('recomputed manifests cannot hide a corrupt or divergent Windows updater feed', async t => {
  for (const divergence of [false, true]) await t.test(divergence ? 'feeds differ' : 'feeds agree on wrong installer', t => {
    const dir = fixture(t)
    fs.writeFileSync(path.join(dir, 'latest.yml'), feed.replace(`path: ${installerName}`, 'path: wrong.exe'))
    if (!divergence) fs.copyFileSync(path.join(dir, 'latest.yml'), path.join(dir, 'beta.yml'))
    modifyManifest(dir, TARGETS[0], info => {
      for (const asset of info.assets.filter(asset => asset.name.endsWith('.yml'))) {
        const bytes = fs.readFileSync(path.join(dir, asset.name))
        asset.size = bytes.length
        asset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
      }
    })
    assert.throws(() => verifyRelease(dir, identity), /Windows updater feed|must be identical/)
  })
})

test('artifact manifests reject relabelled native provenance', t => {
  const dir = fixture(t)
  assert.throws(() => createManifest(dir, { ...identity, platform: 'darwin', arch: 'arm64' }, TARGETS[0]), /provenance platform/)
  assert.throws(() => createManifest(dir, { ...identity, platform: 'darwin', arch: 'x64' }, TARGETS[1]), /provenance architecture/)
  assert.throws(() => createManifest(dir, identity, TARGETS[0]), /provenance platform/)
})

test('already published prereleases are a no-op only for the same commit and every digest', t => {
  const verified = verifyRelease(fixture(t), identity)
  const release = {
    tag_name: `v${identity.version}`, draft: false, prerelease: true,
    assets: verified.assets.map(asset => ({ name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}` })),
  }
  assert.doesNotThrow(() => verifyPublishedRelease(release, identity.commit, verified))
  assert.throws(() => verifyPublishedRelease(release, 'b'.repeat(40), verified), /different target/)
  assert.throws(() => verifyPublishedRelease({ ...release, prerelease: false }, identity.commit, verified), /different target/)
  assert.throws(() => verifyPublishedRelease({ ...release, assets: release.assets.slice(1) }, identity.commit, verified), /different artifact set/)
  for (const digest of ['sha256:' + '0'.repeat(64), null]) {
    const changed = structuredClone(release)
    changed.assets[0].digest = digest
    assert.throws(() => verifyPublishedRelease(changed, identity.commit, verified), /differs or cannot be verified/)
  }
})

test('signed publication refuses ad-hoc, missing, or mixed Mac provenance', t => {
  const dir = fixture(t)
  assert.throws(() => verifyRelease(dir, { ...identity, macSigningMode: 'signed' }), /Mac signing mode/)
  modifyManifest(dir, TARGETS[1], info => { info.macSigningMode = 'signed' })
  assert.throws(() => verifyRelease(dir, identity), /Mac signing mode/)
  modifyManifest(dir, TARGETS[2], info => { delete info.macSigningMode })
  assert.throws(() => verifyRelease(dir, identity), /Mac signing mode/)
  modifyManifest(dir, TARGETS[2], info => { info.macSigningMode = 'signed' })
  assert.equal(verifyRelease(dir, { ...identity, macSigningMode: 'signed' }).macSigningMode, 'signed')
})
