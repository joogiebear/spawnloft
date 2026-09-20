/** The pure parts of the Garnet engine: reading GitHub's release list. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { storageArgs, VERSION, archiveFor, releasesFrom, archiveFrom, windowsZipFrom, credentialsFor, newRecord, supports, runtimeId, RUNTIME_HASHES } from '../src/garnet.mjs'

const rel = (tag, assets, extra = {}) => ({ tag_name: tag, published_at: '2026-08-01T00:00:00Z', assets, ...extra })

test('the self-contained Windows zip is preferred, and a release without one is skipped', () => {
  const a = [
    { name: 'garnet-linux-x64-based-readytorun.zip', browser_download_url: 'l', size: 1 },
    { name: 'garnet-win-x64-framework-dependent.zip', browser_download_url: 'fd', size: 2 },
    { name: 'garnet-win-x64-based-readytorun.zip', browser_download_url: 'w', size: 3, digest: 'sha256:abc' },
  ]
  assert.deepEqual(windowsZipFrom(rel('v1.0.70', a)), { name: 'garnet-win-x64-based-readytorun.zip', url: 'w', sha256: 'abc', size: 3 })
  assert.equal(windowsZipFrom(rel('v1', [a[0]])), null)
  const list = releasesFrom([rel('v1.0.70', a), rel('v1.0.71-rc', a, { prerelease: true }), rel('v1.0.60', [a[0]]), rel('draft', a, { draft: true })])
  assert.deepEqual(list.map((r) => r.version), ['1.0.70'])
  assert.equal(releasesFrom([rel('v1.0.71-rc', a, { prerelease: true })], { includeUnstable: true })[0].status, 'Pre-release')
})

test('an attachment shares the password and suggests a key prefix; the URL carries the password', () => {
  const inst = { port: 6380, root: { password: 'p@ss' } }
  const rec = newRecord('smp', inst)
  assert.equal(rec.database, null)
  assert.equal(rec.password, 'p@ss')
  assert.equal(rec.keyPrefix, 'smp:')
  const c = credentialsFor(inst, rec)
  assert.equal(c.url, 'redis://:p%40ss@127.0.0.1:6380')
  assert.match(c.note, /shares this password/)
})


test('Mac archives match the native architecture and never fall back to Windows or Linux', () => {
  const release = rel('v2.1.7', ['arm64', 'x64'].map(arch => ({
    name: `osx-${arch}-based.tar.xz`, browser_download_url: `https://example.test/${arch}`, digest: 'sha256:' + 'a'.repeat(64), size: 42,
  })))
  for (const arch of ['arm64', 'x64']) {
    assert.equal(archiveFrom(release, 'darwin', arch).url, `https://example.test/${arch}`)
    assert.equal(releasesFrom([release], { platform: 'darwin', arch }).length, 1)
  }
  assert.equal(archiveFrom(release, 'win32', 'x64'), null)
  assert.equal(archiveFrom(release, 'darwin', 'ia32'), null)
  // The fixture release carries no Linux tarball; a release that does is matched by its exact name.
  assert.equal(archiveFrom(release, 'linux', 'x64'), null)
  const linux = rel('v2.1.7', [{ name: 'linux-arm64-based.tar.xz', browser_download_url: 'https://example.test/linux-arm64', digest: 'sha256:' + 'b'.repeat(64), size: 7 }])
  assert.equal(archiveFrom(linux, 'linux', 'arm64').url, 'https://example.test/linux-arm64')
  assert.equal(archiveFrom(linux, 'linux', 'x64'), null)
  assert.equal(windowsZipFrom(rel('v1', [{ name: 'win-x64-framework-dependent.zip' }])), null)
})


test('Linux runs Garnet on managed file I/O, because its native device needs libraries nobody has', () => {
  assert.deepEqual(storageArgs('linux'), ['--device-type', 'RandomAccess'])
  assert.deepEqual(storageArgs('win32'), [])
  assert.deepEqual(storageArgs('darwin'), [])
})

test('the shipped Garnet version has pinned native downloads without a release-list API call', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    assert.equal(supports(platform, arch), true)
    // A build with no runtime to run it on is not a build that can be offered.
    assert.match(RUNTIME_HASHES[runtimeId(platform, arch)], /^[a-f0-9]{128}$/)
    const archive = archiveFor(VERSION, platform, arch)
    assert.match(archive.url, /^https:\/\/github\.com\/microsoft\/garnet\/releases\/download\//)
    assert.match(archive.sha256, /^[a-f0-9]{64}$/)
  }
  assert.throws(() => archiveFor('9.9.9', 'win32', 'x64'), /No verified/)
  assert.throws(() => archiveFor(VERSION, 'linux', 'riscv64'), /No verified/)
  assert.equal(supports('linux', 'riscv64'), false)
  assert.equal(supports('freebsd', 'x64'), false)
})
