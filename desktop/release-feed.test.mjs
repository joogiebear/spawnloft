import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'

import { assemble, singleFileFeed, linuxFeed, linuxFeedNames, writeElectronFeeds, resolveTauriCommand } from './release-feed.mjs'
import { gate, releaseFlags, semverKey, semverLess, peVersionInfo, infoPlistShortVersion } from './release-gate.mjs'
import { main as publishMain, isPrebetaNumber } from './release-publish.mjs'
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
  inputs.cli = [put(`spawnloft-cli-${version}-linux-amd64.deb`, 1500), put(`spawnloft-cli-${version}-linux-x86_64.rpm`, 1500)]
  if (full) {
    inputs['mac-updater'] = macUpdaterBytes ? putBytes('SpawnLoft.app.tar.gz', macUpdaterBytes) : put('SpawnLoft.app.tar.gz', 3000)
    inputs['mac-dmg'] = put('SpawnLoft.dmg', 4000)
    inputs['mac-zip'] = put('SpawnLoft.zip', 3500)
    inputs['deb-arm64'] = put('bundle-arm64.deb')
    inputs['rpm-arm64'] = put('bundle-arm64.rpm')
    inputs.cli.push(put(`spawnloft-cli-${version}-linux-arm64.deb`, 1500), put(`spawnloft-cli-${version}-linux-aarch64.rpm`, 1500))
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

  const result = gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
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
  assert.deepEqual(result.platforms, ['windows', 'mac', 'linux-x64', 'linux-arm64'])
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
  const result = gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
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
  assert.deepEqual(gate({ partial: true, dir: out, version: '2.1.0', pubkey: pubFile(key) }).flags, { prerelease: false, makeLatest: true })
  assert.deepEqual(gate({ partial: true, dir: out, version: '2.1.0', pubkey: pubFile(key), makeLatest: false }).flags, { prerelease: false, makeLatest: false })
})

// The dry-run waivers and a record standing in for the checks this host has no tools for, so the
// release-mode gate inside release-publish can pass on placeholder bytes.
const NO_TOOLS = { tools: { windows: false, dpkg: false, rpm: false } }
function dryPublishArgs(out, version, key, extra = []) {
  const ev = evidenceFor(out, version, n => /\.(deb|rpm)$/.test(n) ? ['linux-package', 'trust'] : /\.exe$/.test(n) ? ['trust'] : [])
  return ['--dir', out, '--version', version, '--commit', 'a'.repeat(40), '--pubkey', pubFile(key), '--partial', '--unsigned', '--throwaway-key', '--evidence', ev, ...extra]
}
function evidenceFor(out, version, checksOf) {
  const checks = []
  for (const name of fs.readdirSync(out).sort()) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex')
    for (const check of checksOf(name)) checks.push({ check, file: name, sha256 })
  }
  const f = path.join(tmp(), 'record.json')
  fs.writeFileSync(f, JSON.stringify({ format: 1, version, host: 'test', checks }))
  return f
}

test('release-publish in dry mode gates the dir and reports the ordering flags, publishing nothing', () => {
  const { key, out } = buildRelease('2.0.0-beta.3', { winBytes: fakePeVersion(2, 0, 0, 3) })
  const result = publishMain(dryPublishArgs(out, '2.0.0-beta.3', key), NO_TOOLS)
  assert.equal(result.tag, 'v2.0.0-beta.3')
  assert.equal(result.prerelease, true)
  assert.equal(result.makeLatest, false)
  assert.ok(result.assets.includes('spawnloft-updates.json'))
  // a failed gate stops it before any gh call
  fs.writeFileSync(path.join(out, 'stray.txt'), 'x')
  assert.throws(() => publishMain(dryPublishArgs(out, '2.0.0-beta.3', key), NO_TOOLS), /gate did not pass/)
})

test('release-publish refuses a pre-beta build number before any gh call', () => {
  assert.equal(isPrebetaNumber('2.0.0-beta.1'), false)
  assert.equal(isPrebetaNumber('2.0.0-beta.999'), false)
  assert.equal(isPrebetaNumber('2.0.0-beta.1000'), true)
  assert.equal(isPrebetaNumber('2.0.0-beta.1002'), true)
  assert.equal(isPrebetaNumber('2.0.0'), false)
  const { key, out } = buildRelease('2.0.0-beta.1002', { winBytes: fakePeVersion(2, 0, 0, 1002) })
  const args = dryPublishArgs(out, '2.0.0-beta.1002', key).filter(a => a !== '--unsigned' && a !== '--throwaway-key')
  // the dry run still works for such a number (release.yml's dry run uses one)
  assert.equal(publishMain([...args, '--unsigned', '--throwaway-key'], NO_TOOLS).tag, 'v2.0.0-beta.1002')
  assert.throws(() => publishMain([...args, '--confirm'], NO_TOOLS), /pre-beta build number/)
})

test('the gate fails on a tampered envelope', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const f = path.join(out, 'spawnloft-updates.json')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"dataFormat": 1', '"dataFormat": 2'))
  const result = gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!result.ok)
  assert.ok(result.problems.some(p => p.includes('spawnloft-updates.json')), result.problems.join('; '))
})

test('the gate fails when an installer byte changes after signing', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  const exe = path.join(out, 'SpawnLoft-Setup-2.0.0-beta.3.exe')
  const bytes = fs.readFileSync(exe); bytes[0] ^= 0xff; fs.writeFileSync(exe, bytes)
  const result = gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!result.ok)
  assert.ok(result.problems.some(p => p.includes('SpawnLoft-Setup-2.0.0-beta.3.exe')), result.problems.join('; '))
})

test('the gate fails on a stray file and on a wrong public key', () => {
  const { key, out } = buildRelease('2.0.0-beta.3')
  fs.writeFileSync(path.join(out, 'stray.txt'), 'x')
  assert.ok(gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) }).problems.some(p => p.includes('stray.txt')))

  const other = makeKey()
  const result = gate({ partial: true, dir: out, version: '2.0.0-beta.3', pubkey: pubFile(other) })
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
  assert.ok(gate({ partial: true, dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key) }).ok) // off by default
  const r = gate({ partial: true, dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(r.ok, r.problems.join('; '))
  assert.ok(r.notes.some(n => /VIProductVersion 2\.0\.0/.test(n)), r.notes.join('; '))
})

test('§11: a VIProductVersion that differs from the tag fails the gate', () => {
  const { key, out } = buildRelease('2.0.0-beta.9000', { winBytes: fakePeVersion(1, 9, 9, 0) })
  const r = gate({ partial: true, dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(!r.ok)
  assert.ok(r.problems.some(p => /VIProductVersion is 1\.9\.9/.test(p)), r.problems.join('; '))
})

test('§11: an installer with no VERSIONINFO fails the check when it is asked for', () => {
  const { key, out } = buildRelease('2.0.0-beta.9000') // placeholder random bytes, no resource
  const r = gate({ partial: true, dir: out, version: '2.0.0-beta.9000', pubkey: pubFile(key), checkBinaryVersions: true })
  assert.ok(!r.ok)
  assert.ok(r.problems.some(p => /no VERSIONINFO resource/.test(p)), r.problems.join('; '))
})

test('§11: the mac app Info.plist version is checked and a mismatch fails', () => {
  const ok = buildRelease('2.0.0-beta.9000', { full: true, winBytes: fakePeVersion(2, 0, 0, 9000), macUpdaterBytes: fakeMacTarball('2.0.0') })
  const rok = gate({ partial: true, dir: ok.out, version: '2.0.0-beta.9000', pubkey: pubFile(ok.key), checkBinaryVersions: true })
  assert.ok(rok.ok, rok.problems.join('; '))
  assert.ok(rok.notes.some(n => /Info\.plist version 2\.0\.0/.test(n)), rok.notes.join('; '))

  const bad = buildRelease('2.0.0-beta.9000', { full: true, winBytes: fakePeVersion(2, 0, 0, 9000), macUpdaterBytes: fakeMacTarball('1.9.0') })
  const rbad = gate({ partial: true, dir: bad.out, version: '2.0.0-beta.9000', pubkey: pubFile(bad.key), checkBinaryVersions: true })
  assert.ok(!rbad.ok)
  assert.ok(rbad.problems.some(p => /CFBundleShortVersionString is 1\.9\.0/.test(p)), rbad.problems.join('; '))
})

test('writeElectronFeeds writes identical channel pairs', () => {
  const out = tmp()
  fs.writeFileSync(path.join(out, 'SpawnLoft-Setup-2.0.0.exe'), crypto.randomBytes(512))
  writeElectronFeeds(out, '2.0.0', '2026-12-01T00:00:00Z')
  assert.ok(fs.readFileSync(path.join(out, 'latest.yml')).equals(fs.readFileSync(path.join(out, 'beta.yml'))))
})

// ---- B4 completeness, B5 release mode and evidence, B6 what a build trusts ---------------------

import { binaryProblems, embeddedKeys, releaseKeys, statusProblems, tarFiles, cpioFiles, keyIdOf, FEED_RELEASE, FEED_INTERNAL } from './build-trust.mjs'
import { gateRecord, platformAssets } from './release-gate.mjs'

const RELEASE = releaseKeys()

// A tar of the given { name: Buffer } entries; names over 100 bytes get a GNU long-name record.
function makeTar(entries) {
  const blocks = []
  const header = (name, size, type) => {
    const h = Buffer.alloc(512)
    h.write(name.slice(0, 99), 0, 'utf8')
    h.write('0000644\0', 100, 'ascii'); h.write('0000000\0', 108, 'ascii'); h.write('0000000\0', 116, 'ascii')
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    h.write('00000000000\0', 136, 'ascii'); h.write('        ', 148, 'ascii'); h.write(type, 156, 'ascii')
    h.write('ustar  \0', 257, 'ascii')
    let sum = 0; for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    return h
  }
  const pad = b => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
  for (const [name, data] of Object.entries(entries)) {
    if (Buffer.byteLength(name) > 99) { const n = Buffer.from(name + '\0'); blocks.push(header('././@LongLink', n.length, 'L'), pad(n)) }
    blocks.push(header(name, data.length, '0'), pad(data))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

// A cpio newc stream of the given entries, as rpm2cpio writes it.
function makeCpio(entries) {
  const parts = []
  const rec = (name, data, mode) => {
    const nameBuf = Buffer.from(name + '\0')
    const f = [1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nameBuf.length, 0].map(n => n.toString(16).padStart(8, '0')).join('')
    const head = Buffer.from('070701' + f, 'ascii')
    const p1 = Buffer.alloc((4 - ((head.length + nameBuf.length) % 4)) % 4)
    const p2 = Buffer.alloc((4 - (data.length % 4)) % 4)
    parts.push(head, nameBuf, p1, data, p2)
  }
  for (const [name, data] of Object.entries(entries)) rec(name, data, 0o100755)
  rec('TRAILER!!!', Buffer.alloc(0), 0)
  return Buffer.concat(parts)
}

// Bytes standing in for a built binary: noise around the key lines (and the feed marker) a build
// of that kind would compile in.
function fakeBinary({ kind = 'core', extraKeys = [], feed = kind === 'core' ? FEED_RELEASE : null, keys = RELEASE } = {}) {
  const parts = [crypto.randomBytes(300)]
  for (const k of [...keys.map(k => k.line), ...extraKeys]) parts.push(Buffer.from(k, 'latin1'), crypto.randomBytes(40))
  if (feed) parts.push(Buffer.from(feed), crypto.randomBytes(40))
  return Buffer.concat(parts)
}

function fakeMacApp(shortVersion, { core = fakeBinary(), shell = fakeBinary({ kind: 'shell' }) } = {}) {
  const plist = Buffer.from(`<plist><dict><key>CFBundleShortVersionString</key><string>${shortVersion}</string></dict></plist>`)
  return zlib.gzipSync(makeTar({
    'SpawnLoft.app/Contents/Info.plist': plist,
    'SpawnLoft.app/Contents/MacOS/SpawnLoft': shell,
    'SpawnLoft.app/Contents/Resources/resources/bin/spawnloft-core': core,
  }))
}

test('B6: the release keys come from keys.rs and agree with UPDATER-KEYS.md', () => {
  assert.deepEqual(RELEASE.map(k => k.id), ['1D6FA7724F159315', 'FABC42A3EFD78DF4'])
  const doc = fs.readFileSync(new URL('./UPDATER-KEYS.md', import.meta.url), 'utf8')
  for (const k of RELEASE) assert.ok(doc.includes(k.line), `${k.id} is in UPDATER-KEYS.md`)
  for (const k of RELEASE) assert.equal(keyIdOf(k.line), k.id)
})

test('B6: a binary must carry exactly the release keys, and a core the release feed code', () => {
  assert.deepEqual(binaryProblems(fakeBinary(), 'core'), [])
  assert.deepEqual(binaryProblems(fakeBinary({ kind: 'shell' }), 'shell'), [])
  const test = makeKey().parsed.keyLine
  assert.ok(binaryProblems(fakeBinary({ extraKeys: [test] }), 'core').some(p => /not a release key/.test(p)))
  assert.ok(binaryProblems(fakeBinary({ feed: FEED_INTERNAL }), 'core').some(p => /internal-feed/.test(p)))
  assert.ok(binaryProblems(fakeBinary({ feed: null }), 'core').some(p => /no spawnloft-feed:release marker/.test(p)))
  assert.ok(binaryProblems(fakeBinary({ keys: RELEASE.slice(0, 1) }), 'shell').some(p => /does not carry release key FABC/.test(p)))
  assert.deepEqual(binaryProblems(fakeBinary({ kind: 'shell', keys: [] }), 'shell'), [])
  assert.ok(binaryProblems(fakeBinary({ keys: [] }), 'core').some(p => /does not carry release key 1D6F/.test(p)))
  // a key line glued to a neighbouring literal is still found
  assert.ok(embeddedKeys(Buffer.from(`xRW${RELEASE[0].line}`)).has(RELEASE[0].id))
})

test('B6: an installed core\'s update status is held to the same rule', () => {
  const good = { keysOverridden: false, keys: RELEASE.map(k => ({ id: k.id })), feed: FEED_RELEASE, sources: ['github'] }
  assert.deepEqual(statusProblems(good), [])
  assert.ok(statusProblems({ ...good, keysOverridden: true }).length)
  assert.ok(statusProblems({ ...good, feed: FEED_INTERNAL }).length)
  assert.ok(statusProblems({ ...good, sources: ['override'] }).length)
  assert.ok(statusProblems({ ...good, keys: [{ id: 'ABCDEF0123456789' }] }).length)
})

test('B6: tar (GNU long names) and cpio newc readers find the binaries', () => {
  const long = `./opt/SpawnLoft/${'x'.repeat(120)}/spawnloft-core`
  const files = tarFiles(makeTar({ './opt/SpawnLoft/spawnloft-desktop': Buffer.from('shell'), [long]: Buffer.from('core'), './usr/bin/other': Buffer.from('no') }), n => /spawnloft-(core|desktop)$/.test(n))
  assert.deepEqual(files.map(f => [f.name, f.data.toString()]), [['opt/SpawnLoft/spawnloft-desktop', 'shell'], [long.slice(2), 'core']])
  const c = cpioFiles(makeCpio({ './opt/SpawnLoft/resources/bin/spawnloft-core': Buffer.from('abc'), './opt/x': Buffer.from('y') }), n => n.endsWith('spawnloft-core'))
  assert.deepEqual(c.map(f => [f.name, f.data.toString()]), [['opt/SpawnLoft/resources/bin/spawnloft-core', 'abc']])
})

test('B4: a one-platform folder fails unless --partial, and a half platform fails even then', () => {
  const { key, out } = buildRelease('2.0.0-beta.3') // Windows and Linux x64 only
  const full = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key) })
  assert.ok(!full.ok)
  assert.ok(full.problems.some(p => /a complete release needs mac/.test(p)), full.problems.join('; '))
  assert.ok(full.problems.some(p => /a complete release needs linux-arm64/.test(p)))
  assert.ok(gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key), partial: true }).ok)
  fs.rmSync(path.join(out, 'spawnloft-cli-2.0.0-beta.3-linux-x86_64.rpm'))
  const half = gate({ dir: out, version: '2.0.0-beta.3', pubkey: pubFile(key), partial: true })
  assert.ok(half.problems.some(p => /linux-x64 part of the release is incomplete: spawnloft-cli-2\.0\.0-beta\.3-linux-x86_64\.rpm/.test(p)), half.problems.join('; '))
  assert.equal(Object.keys(platformAssets('2.0.0')).length, 4)
})

// A complete release on placeholder bytes that is release-grade where the gate can read it here:
// the installer carries a version resource, the mac tarball a release core and shell.
function releaseGrade(version, opts = {}) {
  const [a, b, c] = version.split(/[.-]/).map(Number)
  return buildRelease(version, { full: true, winBytes: fakePeVersion(a, b, c, 0), macUpdaterBytes: fakeMacApp(`${a}.${b}.${c}`, opts), ...opts })
}

test('B5: release mode fails what this host cannot check, and evidence for the same bytes covers it', () => {
  const v = '2.0.0-beta.3'
  const { key, out } = releaseGrade(v)
  const base = { dir: out, version: v, pubkey: pubFile(key), release: true, throwawayKey: true, tools: { windows: false, dpkg: false, rpm: false } }
  const bare = gate(base)
  assert.ok(!bare.ok)
  assert.ok(bare.problems.some(p => /SpawnLoft-Setup-2\.0\.0-beta\.3\.exe: authenticode not checked/.test(p)), bare.problems.join('; '))
  assert.ok(bare.problems.some(p => /linux-amd64\.deb: linux-package not checked/.test(p)))
  assert.ok(bare.problems.some(p => /linux-arm64\.deb: trust not checked/.test(p)))
  // the same gate outside release mode only notes them (the old behaviour of a plain gate)
  assert.ok(gate({ ...base, release: false, checkTrust: true }).ok)

  const ev = evidenceFor(out, v, n => /\.(deb|rpm)$/.test(n) ? ['linux-package', 'trust'] : /\.exe$/.test(n) ? ['authenticode', 'trust'] : [])
  const covered = gate({ ...base, evidence: [ev] })
  assert.ok(covered.ok, covered.problems.join('; '))
  assert.ok(covered.notes.some(n => /authenticode checked on record\.json \(test\), same sha256/.test(n)), covered.notes.join('; '))
  assert.ok(covered.notes.some(n => /mac-arm64\.app\.tar\.gz: core and shell trust exactly the release keys/.test(n)))

  // evidence for other bytes, or another version, covers nothing
  const exe = path.join(out, `SpawnLoft-Setup-${v}.exe`)
  const rec = JSON.parse(fs.readFileSync(ev, 'utf8'))
  rec.checks.find(c => c.file.endsWith('.exe') && c.check === 'authenticode').sha256 = '0'.repeat(64)
  fs.writeFileSync(ev, JSON.stringify(rec))
  assert.ok(gate({ ...base, evidence: [ev] }).problems.some(p => p.startsWith(`${path.basename(exe)}: authenticode not checked`)))
  fs.writeFileSync(ev, JSON.stringify({ ...rec, version: '2.0.0-beta.2' }))
  assert.ok(gate({ ...base, evidence: [ev] }).problems.some(p => /is for 2\.0\.0-beta\.2, not 2\.0\.0-beta\.3/.test(p)))
})

test('B5: release mode wants a release key on the feed, unless a dry run says it is a throwaway', () => {
  const v = '2.0.0-beta.3'
  const { key, out } = releaseGrade(v)
  const ev = evidenceFor(out, v, n => /\.(deb|rpm)$/.test(n) ? ['linux-package', 'trust'] : /\.exe$/.test(n) ? ['authenticode', 'trust'] : [])
  const r = gate({ dir: out, version: v, pubkey: pubFile(key), release: true, evidence: [ev], tools: { windows: false, dpkg: false, rpm: false } })
  assert.ok(r.problems.some(p => /is not a release key/.test(p)), r.problems.join('; '))
  assert.equal(r.problems.length, 1)
})

test('B6: a mac build that trusts a test key, or a test feed, fails the gate', () => {
  const v = '2.0.0-beta.3'
  const testKey = makeKey().parsed.keyLine
  for (const opts of [{ shell: fakeBinary({ kind: 'shell', extraKeys: [testKey] }) }, { core: fakeBinary({ feed: FEED_INTERNAL }) }]) {
    const { key, out } = releaseGrade(v, opts)
    const r = gate({ dir: out, version: v, pubkey: pubFile(key), checkTrust: true, tools: { windows: false, dpkg: false, rpm: false } })
    assert.ok(r.problems.some(p => /mac-arm64\.app\.tar\.gz: SpawnLoft\.app\/Contents\/.*(not a release key|internal-feed)/.test(p)), r.problems.join('; '))
  }
})

test('B6: the Windows setup is proven by its built binaries, and the record carries that elsewhere', () => {
  const v = '2.0.0-beta.3'
  const { key, out } = buildRelease(v, { winBytes: fakePeVersion(2, 0, 0, 3) })
  const bin = tmp()
  fs.writeFileSync(path.join(bin, 'SpawnLoft.exe'), fakeBinary({ kind: 'shell' }))
  fs.writeFileSync(path.join(bin, 'spawnloft-core.exe'), fakeBinary())
  const opts = { dir: out, version: v, pubkey: pubFile(key), partial: true, checkTrust: true, tools: { windows: false, dpkg: false, rpm: false } }
  const onlyCore = gate({ ...opts, release: true, unsigned: true, throwawayKey: true, binaries: [path.join(bin, 'spawnloft-core.exe')] })
  assert.ok(onlyCore.problems.some(p => /Setup-2\.0\.0-beta\.3\.exe: trust not checked/.test(p)), onlyCore.problems.join('; '))
  const both = gate({ ...opts, binaries: [path.join(bin, 'SpawnLoft.exe'), path.join(bin, 'spawnloft-core.exe')] })
  assert.ok(both.ok, both.problems.join('; '))
  const record = gateRecord(both)
  assert.deepEqual(record.checks.map(c => c.check + ':' + c.file), [`trust:SpawnLoft-Setup-${v}.exe`])
  const rf = path.join(tmp(), 'win.json'); fs.writeFileSync(rf, JSON.stringify(record))
  const later = gate({ ...opts, release: true, unsigned: true, throwawayKey: true, evidence: [rf, evidenceFor(out, v, n => /\.(deb|rpm)$/.test(n) ? ['linux-package', 'trust'] : [])] })
  assert.ok(later.ok, later.problems.join('; '))
  // a test build's core among the binaries fails, whatever else is given
  fs.writeFileSync(path.join(bin, 'spawnloft-core.exe'), fakeBinary({ feed: FEED_INTERNAL }))
  assert.ok(!gate({ ...opts, binaries: [path.join(bin, 'SpawnLoft.exe'), path.join(bin, 'spawnloft-core.exe')] }).ok)
})

test('B5: release-publish --confirm refuses the dry-run waivers before any gh call', () => {
  const v = '2.0.0-beta.3'
  const { key, out } = buildRelease(v, { winBytes: fakePeVersion(2, 0, 0, 3) })
  const args = dryPublishArgs(out, v, key)
  assert.throws(() => publishMain([...args.filter(a => a !== '--unsigned'), '--confirm'], NO_TOOLS), /--throwaway-key is for dry runs/)
  assert.throws(() => publishMain([...args.filter(a => a !== '--throwaway-key'), '--confirm'], NO_TOOLS), /--unsigned is for dry runs/)
  // without the waivers the release-mode gate stops it: an unsigned setup on a host that cannot read
  // Authenticode, and a feed key that is not a release key
  assert.throws(() => publishMain([...args.filter(a => a !== '--unsigned' && a !== '--throwaway-key'), '--confirm'], NO_TOOLS), /gate did not pass/)
})

import { parseArgs as assembleArgs, collectInputs, assembleRelease, LINUX_RECORD } from './release-assemble.mjs'

// The three platform folders as release-windows.mjs and the two release workflows leave them.
function platformFolders(version) {
  const root = tmp()
  const win = path.join(root, 'v2-signed', version); const mac = path.join(root, 'mac'); const linux = path.join(root, 'linux')
  for (const d of [win, mac, linux]) fs.mkdirSync(d, { recursive: true })
  const [a, b, c] = version.split(/[.-]/).map(Number)
  const write = (dir, name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); return path.join(dir, name) }
  write(win, `SpawnLoft-Setup-${version}.exe`, fakePeVersion(a, b, c, 0))
  write(mac, `SpawnLoft-${version}-mac-arm64.app.tar.gz`, fakeMacApp(`${a}.${b}.${c}`))
  write(mac, `SpawnLoft-${version}-mac-arm64.dmg`, crypto.randomBytes(2000))
  write(mac, `SpawnLoft-${version}-mac-arm64.zip`, crypto.randomBytes(2000))
  const linuxNames = ['amd64.deb', 'x86_64.rpm', 'arm64.deb', 'aarch64.rpm'].flatMap(s => [`SpawnLoft-${version}-linux-${s}`, `spawnloft-cli-${version}-linux-${s}`])
  for (const n of linuxNames) write(linux, n, crypto.randomBytes(1500))
  const record = (dir, file, checksOf) => {
    const checks = fs.readdirSync(dir).flatMap(n => checksOf(n).map(check => ({ check, file: n, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex') })))
    fs.writeFileSync(file, JSON.stringify({ format: 1, version, host: 'ci', checks }))
  }
  record(win, `${win}.gate-record.json`, n => n.endsWith('.exe') ? ['authenticode', 'trust'] : [])
  record(linux, path.join(linux, LINUX_RECORD), n => /\.(deb|rpm)$/.test(n) ? ['linux-package', 'trust'] : [])
  return { root, win, mac, linux }
}

test('B4: release-assemble takes the three platforms into one complete, gated release', () => {
  const v = '2.0.0-beta.4'
  const key = makeKey()
  const f = platformFolders(v)
  const opts = assembleArgs(['--version', v, '--key', 'k', '--windows', f.win, '--mac', f.mac, '--linux', f.linux, '--out', path.join(f.root, 'out'), '--pubkey', pubFile(key)])
  const collected = collectInputs(opts)
  assert.equal(collected.evidence.length, 2)
  const r = assembleRelease({ ...opts, date: '2026-12-01T00:00:00Z' }, collected, { sign: key.sign, tools: { windows: false, dpkg: false, rpm: false } })
  // everything holds except the one thing a test key cannot be: a release key
  assert.deepEqual(r.problems.filter(p => !/is not a release key/.test(p)), [])
  assert.equal(r.problems.length, 1)
  assert.deepEqual(r.platforms, ['windows', 'mac', 'linux-x64', 'linux-arm64'])
  assert.equal(r.targets.length, 6)
  // the folder is refused a second time rather than mixed
  assert.throws(() => assembleRelease(opts, collected, { sign: key.sign }), /already holds files/)
})

test('B4: release-assemble names every missing input before signing anything', () => {
  const v = '2.0.0-beta.4'
  const f = platformFolders(v)
  fs.rmSync(path.join(f.mac, `SpawnLoft-${v}-mac-arm64.dmg`))
  fs.rmSync(path.join(f.linux, LINUX_RECORD))
  const opts = assembleArgs(['--version', v, '--key', 'k', '--windows', f.win, '--mac', f.mac, '--linux', f.linux])
  assert.throws(() => collectInputs(opts), e => /mac-arm64\.dmg/.test(e.message) && /release-gate-record\.json/.test(e.message))
  assert.throws(() => assembleArgs(['--version', v, '--key', 'k', '--windows', 'w', '--linux', 'l']), /--mac/)
  assert.throws(() => assembleArgs(['--version', '2.0.0-internal.1', '--key', 'k', '--windows', 'w', '--mac', 'm', '--linux', 'l']), /not a 2\.x release version/)
  assert.throws(() => assembleArgs(['--version', v, '--windows', 'w', '--mac', 'm', '--linux', 'l']), /--key is required/)
})
