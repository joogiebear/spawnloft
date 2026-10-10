import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { parseIndex, planRemovals, allowedPackUrl, ALLOWED_PACK_HOSTS } from '../src/mrpack.mjs'
import { extractZip } from '../src/plugins.mjs'
import { UserError } from '../src/util.mjs'

// The same hand-built zip the plugin tests use, so extraction is tested against the format.
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(zlib.crc32(raw), 14)
    local.writeUInt32LE(raw.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, raw)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(zlib.crc32(raw), 16)
    central.writeUInt32LE(raw.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + raw.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-mrpack-'))

// ---- the index reader -------------------------------------------------------

const SHA1 = 'a'.repeat(40)
const SHA512 = 'b'.repeat(128)
const CDN = 'https://cdn.modrinth.com/data/AANobbMI/versions/abc'

const INDEX = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.2.0',
  name: 'Example Pack',
  dependencies: { minecraft: '26.2', 'fabric-loader': '0.19.3' },
  files: [
    { path: 'mods/lithium.jar', hashes: { sha1: SHA1, sha512: SHA512 }, downloads: [`${CDN}/lith.jar`], fileSize: 10 },
    // Client-only, so never fetched: its host and hashes are not held to the policy.
    { path: 'mods/clientshader.jar', env: { server: 'unsupported' }, hashes: {}, downloads: ['http://example.invalid/x.jar'] },
    { path: 'config/lithium.properties', hashes: { sha1: SHA1 }, downloads: [`${CDN}/c.prop`] },
  ],
}

/** INDEX with its one server file replaced by `file`, so a test changes exactly one thing. */
const withFile = (file) => ({ ...INDEX, files: [{ path: 'mods/x.jar', hashes: { sha1: SHA1 }, downloads: [`${CDN}/x.jar`], ...file }] })

test('a fabric pack index reduces to what the install needs', () => {
  const out = parseIndex(INDEX)
  assert.equal(out.name, 'Example Pack')
  assert.equal(out.mc, '26.2')
  assert.deepEqual(out.loader, { kind: 'fabric', version: '0.19.3' })
  assert.deepEqual(out.files.map((f) => f.path), ['mods/lithium.jar', 'config/lithium.properties'])
  assert.equal(out.skipped, 1, 'the client-only file is skipped and counted')
})

test('a neoforge pack is a first-class citizen now', () => {
  const neo = { ...INDEX, dependencies: { minecraft: '26.2', neoforge: '26.2.0.75' } }
  assert.deepEqual(parseIndex(neo).loader, { kind: 'neoforge', version: '26.2.0.75' })
})

test('a pack for a loader mcctl cannot run is refused by name', () => {
  const forge = { ...INDEX, dependencies: { minecraft: '26.2', forge: '52.0.1' } }
  assert.throws(() => parseIndex(forge), /forge.*Fabric and NeoForge packs only/s)
  const quilt = { ...INDEX, dependencies: { minecraft: '26.2', 'quilt-loader': '0.26.0' } }
  assert.throws(() => parseIndex(quilt), /quilt/)
})

test('a pack with no loader, no minecraft version, or the wrong shape is refused', () => {
  assert.throws(() => parseIndex({ game: 'minecraft', files: [], dependencies: {} }), UserError)
  assert.throws(() => parseIndex({ game: 'terraria', files: [] }), UserError)
  assert.throws(() => parseIndex({ ...INDEX, dependencies: { minecraft: '26.2' } }), UserError)
})

test('a pack file path that escapes the instance folder poisons the whole pack', () => {
  for (const bad of ['../outside.jar', '/absolute.jar', 'C:/windows/system32/evil.jar', 'mods/../../up.jar']) {
    assert.throws(() => parseIndex(withFile({ path: bad })), /outside its own folder/, `accepted "${bad}"`)
  }
})

test('a parsed file carries its checksums, its size and the one download it may use', () => {
  const [lithium, config] = parseIndex(INDEX).files
  assert.deepEqual(lithium, { path: 'mods/lithium.jar', sha1: SHA1, sha512: SHA512, url: `${CDN}/lith.jar`, size: 10 })
  assert.deepEqual(config, { path: 'config/lithium.properties', sha1: SHA1, sha512: null, url: `${CDN}/c.prop`, size: 0 })
})

// ---- loader and game versions come from the pack author -------------------------

test('a loader or game version that is not version-shaped refuses the whole pack', () => {
  for (const bad of ['1/../x', '../../etc', '0.19.3/../x', 'a b', '0.19.3?x=1', '..', '', 'x'.repeat(65)]) {
    const fabric = { ...INDEX, dependencies: { minecraft: '26.2', 'fabric-loader': bad } }
    const neo = { ...INDEX, dependencies: { minecraft: '26.2', neoforge: bad } }
    const game = { ...INDEX, dependencies: { minecraft: bad, 'fabric-loader': '0.19.3' } }
    for (const [what, index] of [['fabric loader', fabric], ['neoforge', neo], ['minecraft', game]]) {
      assert.throws(() => parseIndex(index), UserError, `accepted ${what} version ${JSON.stringify(bad)}`)
    }
  }
})

test('the version shapes real loaders use are accepted', () => {
  for (const v of ['0.19.3', '0.16.10', '21.1.172', '26.2.0.75', '21.1.0-beta', '1.21.1+build.3']) {
    assert.equal(parseIndex({ ...INDEX, dependencies: { minecraft: '26.2', 'fabric-loader': v } }).loader.version, v)
  }
  for (const mc of ['1.21.1', '26.2', '24w14a', '1.21-pre1']) {
    assert.equal(parseIndex({ ...INDEX, dependencies: { minecraft: mc, 'fabric-loader': '0.19.3' } }).mc, mc)
  }
})

// ---- where a pack may fetch from, and what it must prove ----------------------------

test('a download must be https from a host the pack format allows', () => {
  for (const host of ALLOWED_PACK_HOSTS) {
    assert.ok(allowedPackUrl(`https://${host}/some/file.jar`), host)
  }
  for (const bad of [
    'http://cdn.modrinth.com/x.jar',
    'https://example.com/x.jar',
    'https://cdn.modrinth.com.evil.test/x.jar',
    'https://evil.test/cdn.modrinth.com/x.jar',
    'https://cdn.modrinth.com@evil.test/x.jar',
    'https://user:pass@cdn.modrinth.com/x.jar',
    'https://cdn.modrinth.com:8443/x.jar',
    'https://localhost/x.jar',
    'https://127.0.0.1/x.jar',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'ftp://cdn.modrinth.com/x.jar',
    'not a url',
    '',
  ]) {
    assert.equal(allowedPackUrl(bad), null, `allowed ${JSON.stringify(bad)}`)
  }
})

test('a file offered only from a host a pack may not use refuses the whole pack', () => {
  for (const url of ['http://cdn.modrinth.com/x.jar', 'https://example.com/x.jar', 'https://127.0.0.1:25565/x.jar', 'http://localhost/x']) {
    assert.throws(() => parseIndex(withFile({ downloads: [url] })), /host a pack may not use/, url)
  }
})

test('the first allowed download is the one used, whichever position it is in', () => {
  const out = parseIndex(withFile({ downloads: ['https://example.com/x.jar', 'http://cdn.modrinth.com/x.jar', `${CDN}/ok.jar`] }))
  assert.equal(out.files[0].url, `${CDN}/ok.jar`)
})

test('a file with no checksum, or a malformed one, refuses the whole pack', () => {
  assert.throws(() => parseIndex(withFile({ hashes: {} })), /no checksum/)
  assert.throws(() => parseIndex(withFile({ hashes: undefined })), /no checksum/)
  assert.throws(() => parseIndex(withFile({ hashes: { sha1: '' } })), /not a checksum/)
  assert.throws(() => parseIndex(withFile({ hashes: { sha1: 'zz'.repeat(20) } })), /not a checksum/)
  assert.throws(() => parseIndex(withFile({ hashes: { sha1: SHA1, sha512: 'short' } })), /not a checksum/)
  assert.throws(() => parseIndex(withFile({ hashes: { sha512: 123 } })), /not a checksum/)
})

test('either checksum on its own is enough, and uppercase hex is normalised', () => {
  assert.equal(parseIndex(withFile({ hashes: { sha512: SHA512 } })).files[0].sha1, null)
  assert.equal(parseIndex(withFile({ hashes: { sha1: SHA1.toUpperCase() } })).files[0].sha1, SHA1)
})

test('a file with no download, or an impossible size, refuses the whole pack', () => {
  assert.throws(() => parseIndex(withFile({ downloads: [] })), /no download/)
  assert.throws(() => parseIndex(withFile({ downloads: undefined })), /no download/)
  for (const fileSize of [-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 2, NaN]) {
    assert.throws(() => parseIndex(withFile({ fileSize })), /impossible size/, String(fileSize))
  }
})

test('a pack path is normalised, and an empty or NUL one is refused', () => {
  assert.equal(parseIndex(withFile({ path: 'mods//a.jar' })).files[0].path, 'mods/a.jar')
  assert.equal(parseIndex(withFile({ path: './mods/a.jar' })).files[0].path, 'mods/a.jar')
  for (const bad of ['', '.', './', 'mods/\0a.jar']) {
    assert.throws(() => parseIndex(withFile({ path: bad })), /outside its own folder/, JSON.stringify(bad))
  }
})

// ---- what a pack update may delete ------------------------------------------

test('an update deletes only what the old pack owned and the new one dropped', () => {
  const old = ['mods/a-1.0.jar', 'mods/b-1.0.jar', 'config/a.toml']
  const now = ['mods/a-2.0.jar', 'mods/b-1.0.jar', 'config/a.toml']
  assert.deepEqual(planRemovals(old, now), ['mods/a-1.0.jar'])
})

test('what the person added is never a removal candidate, because it was never owned', () => {
  const old = ['mods/pack-mod.jar']
  // hand-added.jar is on disk but not in either record - it simply never appears here.
  assert.deepEqual(planRemovals(old, []), ['mods/pack-mod.jar'])
})

test('protected paths survive even a confused record', () => {
  const old = ['world/level.dat', 'world_nether/level.dat', 'server.properties', 'mods/old.jar', 'eula.txt']
  const removals = planRemovals(old, [], { protect: ['world', 'world_nether', 'server.properties', 'eula.txt'] })
  assert.deepEqual(removals, ['mods/old.jar'])
})

test('a protected prefix guards the directory, not every name that starts with it', () => {
  const removals = planRemovals(['worldedit/config.yml', 'world/level.dat'], [], { protect: ['world'] })
  assert.deepEqual(removals, ['worldedit/config.yml'])
})

test('path tricks in a record never become deletions', () => {
  const old = ['../outside.jar', '/absolute.jar', 'mods/../../up.jar', 'mods\\windows-style.jar']
  const removals = planRemovals(old, [])
  assert.deepEqual(removals, ['mods/windows-style.jar'], 'backslashes normalise; escapes are dropped')
})

// ---- extraction -------------------------------------------------------------

test('overrides extract with their prefix stripped and everything else left behind', () => {
  const dir = scratch()
  const file = path.join(dir, 'pack.mrpack')
  fs.writeFileSync(file, buildZip([
    ['modrinth.index.json', '{}'],
    ['overrides/config/mod.toml', 'setting = true'],
    ['overrides/mods/', ''],
    ['server-overrides/server-only.txt', 'server'],
  ]))
  const dest = path.join(dir, 'out')
  const strip = (p) => (n) => (n.startsWith(p) ? n.slice(p.length) : null)
  const laid = extractZip(file, dest, { mapPath: strip('overrides/') })
  assert.deepEqual(laid, ['config/mod.toml'])
  assert.equal(fs.readFileSync(path.join(dest, 'config', 'mod.toml'), 'utf8'), 'setting = true')
  assert.ok(!fs.existsSync(path.join(dest, 'modrinth.index.json')), 'the index is not an override')
  const laidServer = extractZip(file, dest, { mapPath: strip('server-overrides/') })
  assert.deepEqual(laidServer, ['server-only.txt'])
})

test('a zip entry that tries to climb out of the destination stops the extraction', () => {
  const dir = scratch()
  const file = path.join(dir, 'evil.zip')
  fs.writeFileSync(file, buildZip([['../escape.txt', 'gotcha']]))
  const dest = path.join(dir, 'out')
  fs.mkdirSync(dest)
  assert.throws(() => extractZip(file, dest), /outside its folder/)
  assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')), 'nothing was written outside dest')
})
