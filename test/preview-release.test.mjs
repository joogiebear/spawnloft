import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { TARGETS, manifestName, artifactNames, createManifest, verifyRelease, verifyPublishedRelease, verifyWindowsFeed, verifyLinuxFeed, linuxPackages, linuxFeedNames } from '../desktop/preview-artifacts.mjs'

const identity = { sourceVersion: '0.15.0-beta.1', version: '0.15.0-beta.3', commit: 'a'.repeat(40), dirty: false }
const installer = Buffer.from('fixture NSIS installer bytes')
const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
const installerName = `SpawnLoft-Setup-${identity.version}.exe`
const feed = `version: ${identity.version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${installerName}\nsha512: ${sha512}\nreleaseDate: '2026-09-11T12:00:00.000Z'\n`

// A Linux feed lists both packages for its architecture, and is named for that architecture.
const linuxBytes = name => Buffer.from(`fixture Linux package bytes: ${name}`)
function linuxFeed(arch, version = identity.version) {
  const packages = linuxPackages({ arch, version })
  const entry = name => `  - url: ${name}\n    sha512: ${crypto.createHash('sha512').update(linuxBytes(name)).digest('base64')}\n    size: ${linuxBytes(name).length}\n`
  return `version: ${version}\nfiles:\n${packages.map(entry).join('')}path: ${packages[0]}\nsha512: ${crypto.createHash('sha512').update(linuxBytes(packages[0])).digest('base64')}\nreleaseDate: '2026-09-11T12:00:00.000Z'\n`
}

function fixtureBytes(name, version = identity.version) {
  // Each feed names its installer, and the installer's name carries the version.
  if (name.includes('-linux')) return name.endsWith('.yml') ? linuxFeed(name.includes('arm64') ? 'arm64' : 'x64', version) : linuxBytes(name)
  if (name.endsWith('.yml')) return feed.replaceAll(identity.version, version)
  if (name.endsWith('.exe')) return installer
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

test('paired release verifies Windows, both native Mac builds and both Linux architectures, including every updater feed', t => {
  const verified = verifyRelease(fixture(t), identity)
  // 4 Windows + 2 x 2 Mac + 2 x (deb, rpm, two feeds) Linux, and one manifest per target.
  assert.equal(verified.assets.length, 4 + 4 + 8 + TARGETS.length)
  assert.equal(verified.version, identity.version)
  assert.deepEqual(verified.assets.filter(asset => asset.name.endsWith('.yml')).map(asset => asset.name),
    ['latest.yml', 'beta.yml', 'latest-linux.yml', 'beta-linux.yml', 'latest-linux-arm64.yml', 'beta-linux-arm64.yml'])
  for (const name of [`SpawnLoft-${identity.version}-linux-amd64.deb`, `SpawnLoft-${identity.version}-linux-x86_64.rpm`,
    `SpawnLoft-${identity.version}-linux-arm64.deb`, `SpawnLoft-${identity.version}-linux-aarch64.rpm`]) {
    assert.ok(verified.assets.some(asset => asset.name === name), name)
  }
})

test('a Linux feed must describe every package it ships with, not just the first', t => {
  const x64 = linuxPackages({ arch: 'x64', version: identity.version }).map(name => ({ name, bytes: linuxBytes(name) }))
  assert.doesNotThrow(() => verifyLinuxFeed(linuxFeed('x64'), identity.version, x64))
  // Right about the .deb and wrong about the .rpm: every Fedora install would be stranded.
  const wrongRpm = x64.map(p => p.name.endsWith('.rpm') ? { ...p, bytes: Buffer.from('different bytes') } : p)
  assert.throws(() => verifyLinuxFeed(linuxFeed('x64'), identity.version, wrongRpm), /does not match the verified package: .*rpm/)
  assert.throws(() => verifyLinuxFeed(linuxFeed('x64'), identity.version, x64.slice(0, 1)), /does not match the verified packages/)
  assert.throws(() => verifyLinuxFeed(linuxFeed('x64').replace(`path: ${x64[0].name}`, 'path: other.deb'), identity.version, x64), /names a package it does not list/)
  assert.throws(() => verifyLinuxFeed(linuxFeed('x64'), '9.9.9', x64), /does not match the verified packages/)
  assert.throws(() => verifyLinuxFeed(linuxFeed('x64') + 'blockMapSize: 1\n', identity.version, x64), /Unexpected Linux updater feed field/)

  // Through a whole release: a feed changed after its manifest was made stops it, on either architecture.
  for (const target of TARGETS.filter(target => target.platform === 'linux')) {
    const dir = fixture(t)
    const [latest, beta] = linuxFeedNames(target.arch)
    const rpm = linuxPackages({ ...identity, ...target })[1]
    fs.writeFileSync(path.join(dir, latest), linuxFeed(target.arch).replace(`- url: ${rpm}`, '- url: other.rpm'))
    fs.copyFileSync(path.join(dir, latest), path.join(dir, beta))
    modifyManifest(dir, target, info => {
      for (const asset of info.assets.filter(a => a.name.endsWith('.yml'))) {
        const bytes = fs.readFileSync(path.join(dir, asset.name))
        asset.size = bytes.length
        asset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
      }
    })
    assert.throws(() => verifyRelease(dir, identity), /does not match the verified package/, target.arch)
    // The two names are one feed; a beta installation must not be told something different.
    const other = fixture(t)
    fs.appendFileSync(path.join(other, beta), '\n')
    assert.throws(() => createManifest(other, { ...identity, ...target }, target), /must be identical/, target.arch)
  }
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


test('stable release requires matching clean versions and signed builds on every platform', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-stable-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stable = { ...identity, sourceVersion: '1.0.0', version: '1.0.0' }
  for (const target of TARGETS) {
    for (const name of artifactNames({ ...stable, ...target })) {
      fs.writeFileSync(path.join(dir, name), fixtureBytes(name, stable.version))
    }
    const info = { ...stable, ...target, windowsSigningMode: 'azure', macSigningMode: 'signed' }
    writeManifest(dir, target, createManifest(dir, info, target, { stable: true }))
  }
  assert.equal(verifyRelease(dir, { ...stable, stable: true }).assets.length, 4 + 4 + 8 + TARGETS.length)
  assert.throws(() => verifyRelease(dir, stable), /development/)
  modifyManifest(dir, TARGETS[0], info => { info.windowsSigningMode = 'unsigned' })
  assert.throws(() => verifyRelease(dir, { ...stable, stable: true }), /Azure signing/)
  modifyManifest(dir, TARGETS[0], info => { info.windowsSigningMode = 'azure'; info.sourceVersion = '1.0.0-beta.1' })
  assert.throws(() => verifyRelease(dir, { ...stable, stable: true }), /clean stable/)
  modifyManifest(dir, TARGETS[0], info => { info.sourceVersion = '1.0.0' })
  for (const target of TARGETS.filter(target => target.platform === 'darwin')) modifyManifest(dir, target, info => { info.macSigningMode = 'ad-hoc' })
  assert.throws(() => verifyRelease(dir, { ...stable, stable: true }), /Mac signing mode/)
})
