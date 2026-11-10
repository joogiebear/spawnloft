import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import {
  ENVELOPE_FILE, buildEnvelope, buildLatestJson, channelOf, decodeSignature, parsePublicKey, verifyEnvelope, verifyMinisign,
} from './update-envelope.mjs'

// A minisign key pair and signer in Node, the format `tauri signer` writes (prehashed Ed25519),
// so the verifier is tested against real bytes without the Tauri CLI.
function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const keyIdLe = crypto.randomBytes(8)
  const keyLine = Buffer.concat([Buffer.from('Ed'), keyIdLe, raw]).toString('base64')
  const pub = `untrusted comment: minisign public key: ${Buffer.from(keyIdLe).reverse().toString('hex').toUpperCase()}\n${keyLine}\n`
  const sign = (bytes, trustedComment) => {
    const prehash = crypto.createHash('blake2b512').update(bytes).digest()
    const sig = crypto.sign(null, prehash, privateKey)
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trustedComment, 'utf8')]), privateKey)
    const file = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64')}\ntrusted comment: ${trustedComment}\n${global.toString('base64')}\n`
    return Buffer.from(file).toString('base64')
  }
  return { pub, parsed: parsePublicKey(pub), sign }
}

const tauriComment = (file, version) => `timestamp:1700000000\tfile:${file}\tversion:${version}`

test('channel of a version', () => {
  assert.equal(channelOf('2.0.0'), 'stable')
  assert.equal(channelOf('2.0.0-beta.3'), 'beta')
  assert.throws(() => channelOf('2.0.0-next.1'), /no update channel/)
  assert.throws(() => channelOf('2.0'), /not a semver/)
})

test("Victor's public key parses to the key id minisign printed", () => {
  const key = parsePublicKey('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDFENkZBNzcyNEYxNTkzMTUKUldRVmt4VlBjcWR2SGJ2QmZqWlZKRUZIK05aSUREbm5PRXpJRnBqTERjZ25iUDBleDVwNytWSmQK')
  assert.equal(key.keyId, '1D6FA7724F159315')
  assert.equal(key.keyLine, 'RWQVkxVPcqdvHbvBfjZVJEFH+NZIDDnnOEzIFpjLDcgnbP0ex5p7+VJd')
  // the file form and the bare line parse the same
  assert.equal(parsePublicKey(`untrusted comment: x\n${key.keyLine}\n`).keyId, key.keyId)
})

test('envelope from artifacts, and the plugin manifest derived from it', () => {
  const k = makeKey()
  const exe = Buffer.from('installer')
  const env = buildEnvelope({
    version: '2.0.0-beta.3', channel: 'beta', keyId: k.parsed.keyId,
    generatedAt: '2026-12-01T18:02:11Z', expiresAt: '2027-03-01T18:02:11Z', minVersion: '2.0.0-beta.1', dataFormat: 1,
    assets: [
      { target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0-beta.3.exe', bytes: exe, signature: k.sign(exe, tauriComment('SpawnLoft-Setup-2.0.0-beta.3.exe', '2.0.0-beta.3')) },
      { target: 'linux-x86_64-deb', file: 'SpawnLoft-2.0.0-beta.3-linux-amd64.deb', bytes: Buffer.from('deb') },
    ],
  })
  assert.equal(env.tag, 'v2.0.0-beta.3')
  assert.equal(env.platforms['windows-x86_64'].url, 'https://github.com/joogiebear/spawnloft/releases/download/v2.0.0-beta.3/SpawnLoft-Setup-2.0.0-beta.3.exe')
  assert.equal(env.platforms['windows-x86_64'].size, exe.length)
  assert.equal(env.platforms['windows-x86_64'].sha512, crypto.createHash('sha512').update(exe).digest('hex'))
  assert.equal(env.platforms['linux-x86_64-deb'].signature, undefined)
  assert.equal(env.notes, 'https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0-beta.3')
  const latest = buildLatestJson(env)
  assert.equal(latest.version, '2.0.0-beta.3')
  assert.deepEqual(Object.keys(latest.platforms).sort(), ['windows-x86_64', 'windows-x86_64-nsis'])
  assert.equal(latest.platforms['windows-x86_64-nsis'].signature, env.platforms['windows-x86_64'].signature)
})

test('an artifact signature for another file or version is refused before the envelope is written', () => {
  const k = makeKey()
  const exe = Buffer.from('installer')
  const base = { version: '2.0.0', channel: 'stable', keyId: k.parsed.keyId, generatedAt: '2026-12-01T18:02:11Z', expiresAt: null, minVersion: '2.0.0-beta.1', dataFormat: 1 }
  assert.throws(() => buildEnvelope({ ...base, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: exe, signature: k.sign(exe, tauriComment('other.exe', '2.0.0')) }] }), /made for other.exe/)
  assert.throws(() => buildEnvelope({ ...base, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: exe, signature: k.sign(exe, tauriComment('SpawnLoft-Setup-2.0.0.exe', '1.9.0')) }] }), /carries version 1.9.0/)
  assert.throws(() => buildEnvelope({ ...base, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: exe, signature: k.sign(exe, 'timestamp:1\tfile:SpawnLoft-Setup-2.0.0.exe') }] }), /sign with --app-version/)
  assert.throws(() => buildEnvelope({ ...base, channel: 'beta', assets: [] }), /not a beta release/)
  // with the key given, the signature itself is verified: another key's, or a stale one, is refused
  const other = makeKey()
  const good = k.sign(exe, tauriComment('SpawnLoft-Setup-2.0.0.exe', '2.0.0'))
  assert.throws(() => buildEnvelope({ ...base, key: k.parsed, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: exe, signature: other.sign(exe, tauriComment('SpawnLoft-Setup-2.0.0.exe', '2.0.0')) }] }), /is by key/)
  assert.throws(() => buildEnvelope({ ...base, key: k.parsed, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: Buffer.from('rebuilt'), signature: good }] }), /does not verify/)
  assert.ok(buildEnvelope({ ...base, key: k.parsed, assets: [{ target: 'windows-x86_64', file: 'SpawnLoft-Setup-2.0.0.exe', bytes: exe, signature: good }] }).platforms['windows-x86_64'].signature)
  assert.throws(() => buildEnvelope({ ...base, assets: [] }), /at least one artifact/)
})

test('minisign verification: good, wrong key, moved comment', () => {
  const k = makeKey()
  const other = makeKey()
  const bytes = Buffer.from(JSON.stringify({ format: 1, keyId: k.parsed.keyId, version: '2.0.0' }))
  const sig = k.sign(bytes, tauriComment(ENVELOPE_FILE, '2.0.0'))
  assert.equal(verifyMinisign(bytes, sig, k.parsed), true)
  assert.equal(verifyMinisign(Buffer.from(bytes.toString() + ' '), sig, k.parsed), false)
  assert.equal(verifyMinisign(bytes, sig, other.parsed), false)
  assert.deepEqual(verifyEnvelope(bytes, sig, k.parsed), { format: 1, keyId: k.parsed.keyId, version: '2.0.0' })
  assert.throws(() => verifyEnvelope(bytes, k.sign(bytes, tauriComment('SpawnLoft-Setup-2.0.0.exe', '2.0.0')), k.parsed), /made for SpawnLoft-Setup-2.0.0.exe/)
  assert.throws(() => verifyEnvelope(bytes, k.sign(bytes, tauriComment(ENVELOPE_FILE, '2.0.1')), k.parsed), /carries version 2.0.1/)
  const wrongId = Buffer.from(JSON.stringify({ format: 1, keyId: other.parsed.keyId, version: '2.0.0' }))
  assert.throws(() => verifyEnvelope(wrongId, k.sign(wrongId, tauriComment(ENVELOPE_FILE, '2.0.0')), k.parsed), /names key/)
  // a tampered trusted comment fails the global signature
  const decoded = decodeSignature(sig)
  const forged = Buffer.from(`untrusted comment: x\n${Buffer.concat([Buffer.from('ED'), Buffer.alloc(8), decoded.signature]).toString('base64')}\ntrusted comment: ${tauriComment(ENVELOPE_FILE, '9.9.9')}\n${decoded.globalSignature.toString('base64')}\n`).toString('base64')
  assert.equal(verifyMinisign(bytes, forged, k.parsed), false)
})
