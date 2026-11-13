import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'

import { assemble, singleFileFeed, linuxFeed, linuxFeedNames, writeElectronFeeds, resolveTauriCommand } from './release-feed.mjs'
import { gate, releaseFlags, semverKey, semverLess, peVersionInfo, infoPlistShortVersion } from './release-gate.mjs'
import { main as publishMain } from './release-publish.mjs'
import { parsePublicKey } from './update-envelope.mjs'
import { verifyWindowsFeed, verifyLinuxFeed } from './preview-artifacts.mjs'

// A minisign key pair and signer in Node, in the prehashed-Ed25519 form `tauri signer` writes, so
// the pipeline is tested end to end without the Tauri CLI. `sign(file, version)` writes <file>.sig
// and returns it, the contract release-feed.mjs expects of its signer.
function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const keyIdLe = crypto.randomBytes(8)
  const keyLine = Buffer.concat([Buffer.from('Ed'), keyIdLe, raw]).toString('base64')
  const pub = `untrusted comment: minisign public key: ${Buffer.from(keyIdLe).reverse().toString('hex').toUpperCase()}\n${keyLine}\n`
  const signBytes = (bytes, trustedComment) => {
    const prehash = crypto.createHash('blake2b512').update(bytes).digest()
    const sig = crypto.sign(null, prehash, privateKey)
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trustedComment, 'utf8')]), privateKey)
    const file = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64')}\ntrusted comment: ${trustedComment}\n${global.toString('base64')}\n`
    return Buffer.from(file).toString('base64')
  }
  const sign = (file, version) => {
    const comment = `timestamp:1700000000\tfile:${path.basename(file)}\tversion:${version}`
    const s = signBytes(fs.readFileSync(file), comment)
    fs.writeFileSync(`${file}.sig`, s + '\n')
    return s
  }
  return { pub, parsed: parsePublicKey(pub), sign }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-feed-'))
}

function sha512b64(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('base64')
}

test('releaseFlags: betas are never latest, stable is latest unless held', () => {
  assert.deepEqual(releaseFlags('beta'), { prerelease: true, makeLatest: false })
  assert.deepEqual(releaseFlags('beta', false), { prerelease: true, makeLatest: false })
  assert.throws(() => releaseFlags('beta', true), /never be marked the latest/)
  assert.deepEqual(releaseFlags('stable'), { prerelease: false, makeLatest: true })
  assert.deepEqual(releaseFlags('stable', false), { prerelease: false, makeLatest: false })
  assert.throws(() => releaseFlags('internal', true), /no update channel/)
})

test('singleFileFeed is accepted by the 1.x verifier for the shipped bytes', () => {
  const name = 'SpawnLoft-Setup-2.0.0-beta.3.exe'
  const bytes = Buffer.from('an installer')
  const text = singleFileFeed(name, bytes, '2.0.0-beta.3', '2026-12-01T00:00:00Z')
  verifyWindowsFeed(text, '2.0.0-beta.3', name, bytes) // throws if it does not describe the bytes
  assert.throws(() => verifyWindowsFeed(text, '2.0.0-beta.3', name, Buffer.from('other')))
})

test('linuxFeed lists every package, deb primary, accepted by the verifier', () => {
  const deb = Buffer.from('a deb'); const rpm = Buffer.from('an rpm')
  const text = linuxFeed([{ name: 'a.deb', bytes: deb }, { name: 'a.rpm', bytes: rpm }], '2.0.0', null)
  verifyLinuxFeed(text, '2.0.0', [{ name: 'a.deb', bytes: deb }, { name: 'a.rpm', bytes: rpm }])
  assert.deepEqual(linuxFeedNames('x64'), ['latest-linux.yml', 'beta-linux.yml'])
  assert.deepEqual(linuxFeedNames('arm64'), ['latest-linux-arm64.yml', 'beta-linux-arm64.yml'])
})

// Builds a full release folder from fake raw bundles and gates it. `full` adds the mac bundles and
// a command-line package, so the whole §5.2 set is exercised.
function buildRelease(version, { key, extra = [], signEnvelope, full = false, winBytes, macUpdaterBytes } = {}) {
  key ??= makeKey()
  const raw = tmp()
  const out = tmp()
  const inputs = { out, version, pubkey: pubFile(key), cli: [], sign: true, date: '2026-12-01T00:00:00Z', extraEnvelope: extra }
  const put = (name, bytes = 1024) => { const p = path.join(raw, name); fs.writeFileSync(p, crypto.randomBytes(bytes)); return p }
  const putBytes = (name, bytes) => { const p = path.join(raw, name); fs.writeFileSync(p, bytes); return p }
  inputs.win = winBytes ? putBytes('SpawnLoft_setup.exe', winBytes) : put('SpawnLoft_setup.exe', 2048)
  inputs.deb = put('bundle.deb')
  inputs.rpm = put('bundle.rpm')
  if (full) {
    inputs['mac-updater'] = macUpdaterBytes ? putBytes('SpawnLoft.app.tar.gz', macUpdaterBytes) : put('SpawnLoft.app.tar.gz', 3000)
    inputs['mac-dmg'] = put('SpawnLoft.dmg', 4000)
    inputs['mac-zip'] = put('SpawnLoft.zip', 3500)
    inputs.cli = [put(`spawnloft-cli-${version}-linux-amd64.deb`, 1500)]
  }
  const envelope = assemble(inputs, signEnvelope ?? key.sign)
  return { key, out, envelope }
}

// A buffer carrying a VS_FIXEDFILEINFO block (signature 0xFEEF04BD) with the given four-part
// version in both the file and product fields, as an NSIS installer's VERSIONINFO resource would.
function fakePeVersion(a, b, c, d) {
  const info = Buffer.alloc(24)
  info.writeUInt32LE(0xfeef04bd, 0)
  info.writeUInt32LE(0x00010000, 4) // dwStrucVersion
  const ms = a * 0x10000 + b; const ls = c * 0x10000 + d
  info.writeUInt32LE(ms, 8); info.writeUInt32LE(ls, 12) // file
  info.writeUInt32LE(ms, 16); info.writeUInt32LE(ls, 20) // product
  return Buffer.concat([crypto.randomBytes(96), info, crypto.randomBytes(96)])
}

// A gzipped tar holding one SpawnLoft.app/Contents/Info.plist with the given short version string.
function fakeMacTarball(shortVersion) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key><string>${shortVersion}</string>\n<key>CFBundleVersion</key><string>${shortVersion}</string>\n</dict></plist>\n`
  const data = Buffer.from(plist, 'utf8')
  const header = Buffer.alloc(512)
  header.write('SpawnLoft.app/Contents/Info.plist', 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii') // checksum field is spaces while summing
  header.write('0', 156, 'ascii') // typeflag: regular file
  let sum = 0; for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  data.copy(body)
  return zlib.gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]))
}

function pubFile(key) {
  const f = path.join(tmp(), 'release.pub')
  fs.writeFileSync(f, key.pub)
  return f
}

test('a beta release assembles every asset and passes the gate', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const files = fs.readdirSync(out).sort()
  for (const name of [
    'SpawnLoft-Setup-2.0.0-beta.3.exe', 'SpawnLoft-Setup-2.0.0-beta.3.exe.sig',
    'SpawnLoft-2.0.0-beta.3-linux-amd64.deb', 'SpawnLoft-2.0.0-beta.3-linux-x86_64.rpm',
    'spawnloft-updates.json', 'spawnloft-updates.json.sig', 'latest.json',
    'latest.yml', 'beta.yml', 'latest-linux.yml', 'beta-linux.yml',
  ]) assert.ok(files.includes(name), `${name} should be in the folder, saw ${files.join(', ')}`)

  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(result.ok, result.problems.join('; '))
  assert.deepEqual(result.flags, { prerelease: true, makeLatest: false })
  assert.ok(result.targets.includes('windows-x86_64'))
})

test('the full asset set (mac updater tarball, dmg, zip, cli package) passes the gate', () => {
  const { key, out } = buildRelease('2.0.0-beta.3', { full: true })
  const files = fs.readdirSync(out).sort()
  for (const name of [
    'SpawnLoft-2.0.0-beta.3-mac-arm64.app.tar.gz', 'SpawnLoft-2.0.0-beta.3-mac-arm64.app.tar.gz.sig',
    'SpawnLoft-2.0.0-beta.3-mac-arm64.dmg', 'SpawnLoft-2.0.0-beta.3-mac-arm64.zip',
    'latest-mac.yml', 'beta-mac.yml', 'spawnloft-cli-2.0.0-beta.3-linux-amd64.deb',
  ]) assert.ok(files.includes(name), `${name} should be present, saw ${files.join(', ')}`)
  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(result.ok, result.problems.join('; '))
  assert.ok(result.targets.includes('darwin-aarch64'))
})

test('the gate rejects a signature whose trusted comment names another file', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  // sign the SAME installer bytes under a different name, so the sig verifies but its comment lies
  const installer = path.join(out, 'SpawnLoft-Setup-2.0.0-beta.3.exe')
  const decoy = path.join(tmp(), 'decoy.exe')
  fs.copyFileSync(installer, decoy)
  const badSig = key.sign(decoy, '2.0.0-beta.3') // comment file:decoy.exe over the installer bytes
  fs.writeFileSync(`${installer}.sig`, badSig + '\n')
  const env = path.join(out, 'spawnloft-updates.json')
  const doc = JSON.parse(fs.readFileSync(env, 'utf8'))
  doc.platforms['windows-x86_64'].signature = badSig
  fs.writeFileSync(env, JSON.stringify(doc, null, 2) + '\n')
  key.sign(env, '2.0.0-beta.3') // re-sign the edited envelope so only the comment check fails
  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!result.ok)
  assert.ok(result.problems.some(p => /made for decoy\.exe/.test(p)), result.problems.join('; '))
})

test('resolveTauriCommand turns npm\'s .bin shim into a node invocation', () => {
  const r = resolveTauriCommand('/tmp/tauri-cli/node_modules/.bin/tauri')
  assert.equal(r.length, 2)
  assert.ok(r[1].endsWith(path.join('@tauri-apps', 'cli', 'tauri.js')))
  assert.deepEqual(resolveTauriCommand('/usr/local/bin/tauri'), ['/usr/local/bin/tauri'])
  // the CLI's JS entry (release-windows.mjs passes it) runs through this node: Windows cannot exec a .js
  const js = 'S:\\x\\tauri-cli\\node_modules\\@tauri-apps\\cli\\tauri.js'
  assert.deepEqual(resolveTauriCommand(js), [process.execPath, js])
})

test('semver helpers order betas below their stable and 1.x below 2.x', () => {
  assert.ok(semverLess('2.0.0-beta.1', '2.0.0-beta.2'))
  assert.ok(semverLess('2.0.0-beta.9000', '2.0.0'))
  assert.ok(semverLess('1.6.0-beta.413', '2.0.0-beta.1'))
  assert.ok(!semverLess('2.0.0', '2.0.0'))
  assert.equal(semverKey('not-semver'), null)
})

test('a stable release is latest by default and can be held back', () => {
  const { key, out } = buildRelease('2.1.0', { extra: ['--min-version', '2.0.0'] })
  assert.deepEqual(gate({ dir: out, version: '2.1.0', pubkey: pubFile(key) }).flags, { prerelease: false, makeLatest: true })
  assert.deepEqual(gate({ dir: out, version: '2.1.0', pubkey: pubFile(key), makeLatest: false }).flags, { prerelease: false, makeLatest: false })
})

test('release-publish in dry mode gates the dir and reports the ordering flags, publishing nothing', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const result = publishMain(['--dir', out, '--version', '2.0.0-beta.3', '--commit', 'a'.repeat(40), '--pubkey', pubFile(key)])
  assert.equal(result.tag, 'v2.0.0-beta.3')
  assert.equal(result.prerelease, true)
  assert.equal(result.makeLatest, false)
  assert.ok(result.assets.includes('spawnloft-updates.json'))
  // a failed gate stops it before any gh call
  fs.writeFileSync(path.join(out, 'stray.txt'), 'x')
  assert.throws(() => publishMain(['--dir', out, '--version', '2.0.0-beta.3', '--commit', 'a'.repeat(40), '--pubkey', pubFile(key)]), /gate did not pass/)
})

test('the gate fails on a tampered envelope', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const f = path.join(out, 'spawnloft-updates.json')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"dataFormat": 1', '"dataFormat": 2'))
  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!result.ok)
  assert.ok(result.problems.some(p => p.includes('spawnloft-updates.json')), result.problems.join('; '))
})

test('the gate fails when an installer byte changes after signing', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const exe = path.join(out, 'SpawnLoft-Setup-2.0.0-beta.3.exe')
  const bytes = fs.readFileSync(exe); bytes[0] ^= 0xff; fs.writeFileSync(exe, bytes)
  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!result.ok)
  assert.ok(result.problems.some(p => p.includes('SpawnLoft-Setup-2.0.0-beta.3.exe')), result.problems.join('; '))
})

test('the gate fails on a stray file and on a wrong public key', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  fs.writeFileSync(path.join(out, 'stray.txt'), 'x')
  assert.ok(gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) }).problems.some(p => p.includes('stray.txt')))

  const other = makeKey()
  const result = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(other) })
  assert.ok(!result.ok)
})

test('no feed is ever produced for an internal build (updates off by construction)', () => {
  const key = makeKey()
  const raw = tmp(); const out = tmp()
  const win = path.join(raw, 'SpawnLoft_2.0.0-internal.9_x64-setup.exe')
  fs.writeFileSync(win, crypto.randomBytes(256))
  assert.throws(
    () => assemble({ out, version: '2.0.0-internal.9', pubkey: pubFile(key), win, cli: [], sign: true, extraEnvelope: [] }, key.sign),
    /no update channel/,
  )
})

test('peVersionInfo reads the version out of a VERSIONINFO resource, or null when absent', () => {
  assert.deepEqual(peVersionInfo(fakePeVersion(2, 0, 0, 0)).product, [2, 0, 0, 0])
  assert.deepEqual(peVersionInfo(fakePeVersion(2, 0, 0, 9000)).file, [2, 0, 0, 9000])
  assert.equal(peVersionInfo(crypto.randomBytes(512)), null)
})

test('infoPlistShortVersion reads CFBundleShortVersionString from the mac tarball', () => {
  assert.equal(infoPlistShortVersion(fakeMacTarball('2.0.0')), '2.0.0')
  assert.equal(infoPlistShortVersion(zlib.gzipSync(Buffer.alloc(1024))), null) // empty archive, no plist
})

test('§11: the gate checks the installer VIProductVersion when --check-binary-versions is set', () => {
  // VIProductVersion 2.0.0.x matches the 2.0.0-beta.9000 release (the resource drops the tag)
  const { key, out } = buildRelease('2.0.0-beta.9000', { winBytes: fakePeVersion(2, 0, 0, 9000) })
  assert.ok(gate({ dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key) }).ok) // off by default
  const r = gate({ dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(r.ok, r.problems.join('; '))
  assert.ok(r.notes.some(n => /VIProductVersion 2\.0\.0/.test(n)), r.notes.join('; '))
})

test('§11: a VIProductVersion that differs from the tag fails the gate', () => {
  const { key, out } = buildRelease('2.0.0-beta.9000', { winBytes: fakePeVersion(1, 9, 9, 0) })
  const r = gate({ dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(!r.ok)
  assert.ok(r.problems.some(p => /VIProductVersion is 1\.9\.9/.test(p)), r.problems.join('; '))
})

test('§11: an installer with no VERSIONINFO fails the check when it is asked for', () => {
  const { key, out } = buildRelease('2.0.0-beta.9000') // placeholder random bytes, no resource
  const r = gate({ dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(!r.ok)
  assert.ok(r.problems.some(p => /no VERSIONINFO resource/.test(p)), r.problems.join('; '))
})

test('§11: the mac app Info.plist version is checked and a mismatch fails', () => {
  const ok = buildRelease('2.0.0-beta.9000', { full: true, winBytes: fakePeVersion(2, 0, 0, 9000), macUpdaterBytes: fakeMacTarball('2.0.0') })
  const rok = gate({ dir: ok.out, version: '2.0.0-beta.9000', pubkey: pubFile(ok.key), checkBinaryVersions: true })
  assert.ok(rok.ok, rok.problems.join('; '))
  assert.ok(rok.notes.some(n => /Info\.plist version 2\.0\.0/.test(n)), rok.notes.join('; '))

  const bad = buildRelease('2.0.0-beta.9000', { full: true, winBytes: fakePeVersion(2, 0, 0, 9000), macUpdaterBytes: fakeMacTarball('1.9.0') })
  const rbad = gate({ dir: bad.out, version: '2.0.0-beta.9000', pubkey: pubFile(bad.key), checkBinaryVersions: true })
  assert.ok(!rbad.ok)
  assert.ok(rbad.problems.some(p => /CFBundleShortVersionString is 1\.9\.0/.test(p)), rbad.problems.join('; '))
})

test('writeElectronFeeds writes identical channel pairs', () => {
  const out = tmp()
  fs.writeFileSync(path.join(out, 'SpawnLoft-Setup-2.0.0.exe'), crypto.randomBytes(512))
  writeElectronFeeds(out, '2.0.0', '2026-12-01T00:00:00Z')
  assert.ok(fs.readFileSync(path.join(out, 'latest.yml')).equals(fs.readFileSync(path.join(out, 'beta.yml'))))
})
