// The 2.x update feed of one release (rust/INSTALLER-UPDATER-DESIGN.md 5.2 and 5.3): the signed
// envelope `spawnloft-updates.json` and the plugin's `latest.json`, both written from the verified
// artifact bytes in a dist folder, and the envelope signed with the release key through
// `tauri signer sign --app-version <version>` (the same key and tool that sign the artifacts; the
// CLI has no custom-comment flag, so the client binds the signature by its `file:` and `version:`
// fields). After signing, the signature is verified here with Node's crypto (minisign is Ed25519
// over a BLAKE2b-512 prehash) against the public key, so a release never ships an envelope its
// clients would refuse.
//
//   node update-envelope.mjs --dist <dir> --version <v> --channel stable|beta --pubkey <file.pub>
//        [--min-version <v>] [--data-format <n>] [--expires-days <n>] [--notes <url>]
//        [--generated-at <iso>] [--no-sign] [--tauri <path to tauri cli>]
//
// Reads from <dist>: SpawnLoft-Setup-<v>.exe (+ .sig), SpawnLoft-<v>-mac-arm64.app.tar.gz (+ .sig),
// SpawnLoft-<v>-linux-*.deb/.rpm, whichever exist; writes spawnloft-updates.json, its .sig and
// latest.json into <dist>. The release gate (verify-build) checks them again before publishing.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ENVELOPE_FILE = 'spawnloft-updates.json'
export const DOWNLOAD_BASE = 'https://github.com/joogiebear/spawnloft/releases/download/'
export const FORMAT = 1
export const PRODUCT = 'spawnloft'
export const DEFAULT_DATA_FORMAT = 1
export const DEFAULT_EXPIRES_DAYS = 90

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

// The artifacts a release may carry, by the plugin's target names. Linux packages have no
// updater signature (the package manager installs them).
export function artifactTargets(version) {
  return [
    { target: 'windows-x86_64', file: `SpawnLoft-Setup-${version}.exe`, signed: true },
    { target: 'darwin-aarch64', file: `SpawnLoft-${version}-mac-arm64.app.tar.gz`, signed: true },
    { target: 'linux-x86_64-deb', file: `SpawnLoft-${version}-linux-amd64.deb`, signed: false },
    { target: 'linux-x86_64-rpm', file: `SpawnLoft-${version}-linux-x86_64.rpm`, signed: false },
    { target: 'linux-aarch64-deb', file: `SpawnLoft-${version}-linux-arm64.deb`, signed: false },
    { target: 'linux-aarch64-rpm', file: `SpawnLoft-${version}-linux-aarch64.rpm`, signed: false },
  ]
}

// The channel a version belongs to: no prerelease is stable; `beta.N` is beta; anything else
// (`next`, `internal`, `spike`) is never published to a feed.
export function channelOf(version) {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`${version} is not a semver version`)
  if (!m[4]) return 'stable'
  if (m[4].split('.')[0] === 'beta') return 'beta'
  throw new Error(`${version} is a ${m[4].split('.')[0]} build; it has no update channel`)
}

// A minisign public key file (or Tauri's base64 of it): { keyId, keyLine, raw }.
export function parsePublicKey(text) {
  let s = String(text).trim()
  if (!s.includes('\n') && !s.startsWith('RW')) s = Buffer.from(s, 'base64').toString('utf8').trim()
  const line = s.split('\n').map(l => l.trim()).find(l => l.startsWith('RW'))
  if (!line) throw new Error('not a minisign public key')
  const raw = Buffer.from(line, 'base64')
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not an Ed25519 minisign public key')
  const keyId = Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase()
  return { keyId, keyLine: line, publicKey: raw.subarray(10, 42) }
}

// One release's envelope from its verified artifacts. `assets` is a list of
// { target, file, bytes, signature? } (signature: the .sig file's text, Tauri's base64 form).
// `key` ({ keyId, publicKey }, from parsePublicKey) makes each artifact signature verify
// cryptographically against the release key before it is written into the envelope; a stale
// .sig from an earlier build of the same version, or one by another key, would otherwise ship
// and every client would download the installer only to refuse it.
export function buildEnvelope({ version, channel, keyId, generatedAt, expiresAt, minVersion, dataFormat, notes, assets, key }, downloadBase = DOWNLOAD_BASE) {
  if (!SEMVER.test(version)) throw new Error(`${version} is not a semver version`)
  if (channel !== channelOf(version)) throw new Error(`${version} is not a ${channel} release`)
  if (!/^[0-9A-F]{16}$/.test(keyId)) throw new Error('keyId must be the 16-digit minisign key id')
  if (!SEMVER.test(minVersion)) throw new Error(`minVersion ${minVersion} is not a semver version`)
  if (!Number.isInteger(dataFormat) || dataFormat < 1) throw new Error('dataFormat must be a positive whole number')
  if (!assets.length) throw new Error('an envelope needs at least one artifact')
  const tag = `v${version}`
  const platforms = {}
  for (const a of assets) {
    if (!/^[a-z0-9_-]{1,32}$/.test(a.target)) throw new Error(`bad target ${a.target}`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.file)) throw new Error(`bad file name ${a.file}`)
    const entry = {
      url: `${downloadBase}${tag}/${a.file}`,
      size: a.bytes.length,
      sha512: crypto.createHash('sha512').update(a.bytes).digest('hex'),
    }
    if (a.signature !== undefined) {
      const sig = String(a.signature).trim()
      if (!/^[A-Za-z0-9+/]+=*$/.test(sig)) throw new Error(`${a.file}: the signature is not base64`)
      verifyArtifactComment(sig, a.file, version)
      if (decodeSignature(sig).keyId !== keyId) throw new Error(`${a.file}: its signature is by key ${decodeSignature(sig).keyId}, the envelope names ${keyId}`)
      if (key && !verifyMinisign(a.bytes, sig, key)) throw new Error(`${a.file}: its signature does not verify with the release key (stale .sig?)`)
      entry.signature = sig
    }
    platforms[a.target] = entry
  }
  return {
    format: FORMAT,
    product: PRODUCT,
    keyId,
    channel,
    version,
    tag,
    generatedAt,
    expiresAt,
    notes: notes ?? `https://github.com/joogiebear/spawnloft/releases/tag/${tag}`,
    minVersion,
    dataFormat,
    platforms,
  }
}

// The trusted comment of an artifact's Tauri signature must name that file and version, or the
// client's requireSignedVersion check would refuse the install after the download.
function verifyArtifactComment(sigBase64, file, version) {
  const { trustedComment } = decodeSignature(sigBase64)
  const fields = Object.fromEntries(trustedComment.split('\t').map(f => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)]))
  if (fields.file !== file) throw new Error(`${file}: its signature was made for ${fields.file ?? 'no file'}`)
  if ((fields.version ?? '').replace(/^v/, '') !== version) throw new Error(`${file}: its signature carries version ${fields.version ?? 'none'}, not ${version} (sign with --app-version)`)
}

// The plugin's own manifest, derived from the envelope: one entry per target, plus the
// `-nsis` / `-app` aliases the plugin tries first. The client never reads this file (it builds
// the same from the envelope), but it is published for anything else that speaks the format.
export function buildLatestJson(envelope) {
  const platforms = {}
  for (const [target, e] of Object.entries(envelope.platforms)) {
    if (!e.signature) continue
    const entry = { url: e.url, signature: e.signature }
    platforms[target] = entry
    if (target.startsWith('windows-')) platforms[`${target}-nsis`] = entry
    if (target.startsWith('darwin-')) platforms[`${target}-app`] = entry
  }
  return { version: envelope.version, notes: envelope.notes, pub_date: envelope.generatedAt, platforms }
}

// ---- minisign verification in Node (for the self-check after signing) --------------------------

// Tauri's base64 wraps the signature file: untrusted comment, signature, trusted comment, global sig.
export function decodeSignature(sigBase64) {
  const text = Buffer.from(String(sigBase64).trim(), 'base64').toString('utf8')
  const lines = text.split('\n').map(l => l.trimEnd())
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) throw new Error('not a minisign signature file')
  const sig = Buffer.from(lines[1], 'base64')
  if (sig.length !== 74) throw new Error('bad minisign signature length')
  const alg = sig.subarray(0, 2).toString('latin1')
  if (alg !== 'ED') throw new Error(`unsupported minisign algorithm ${alg} (only prehashed signatures are accepted)`)
  return {
    keyId: Buffer.from(sig.subarray(2, 10)).reverse().toString('hex').toUpperCase(),
    signature: sig.subarray(10, 74),
    trustedComment: lines[2].slice('trusted comment:'.length).trim(),
    globalSignature: Buffer.from(lines[3], 'base64'),
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// True when `sigBase64` is a valid minisign signature over `bytes` by `publicKey` ({ keyId, publicKey }).
export function verifyMinisign(bytes, sigBase64, key) {
  const s = decodeSignature(sigBase64)
  if (s.keyId !== key.keyId) return false
  const pub = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.publicKey]), format: 'der', type: 'spki' })
  const prehash = crypto.createHash('blake2b512').update(bytes).digest()
  if (!crypto.verify(null, prehash, pub, s.signature)) return false
  return crypto.verify(null, Buffer.concat([s.signature, Buffer.from(s.trustedComment, 'utf8')]), pub, s.globalSignature)
}

// Checks what the client checks before it trusts an envelope: signature by this key, key id in
// the payload, trusted comment naming the file and version.
export function verifyEnvelope(bytes, sigBase64, key) {
  if (!verifyMinisign(bytes, sigBase64, key)) throw new Error('the envelope signature does not verify with the release key')
  const doc = JSON.parse(bytes.toString('utf8'))
  if (doc.keyId !== key.keyId) throw new Error(`the envelope names key ${doc.keyId}; it was signed by ${key.keyId}`)
  const { trustedComment } = decodeSignature(sigBase64)
  const fields = Object.fromEntries(trustedComment.split('\t').map(f => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)]))
  if (fields.file !== ENVELOPE_FILE) throw new Error(`the signature was made for ${fields.file ?? 'no file'}, not ${ENVELOPE_FILE}`)
  if ((fields.version ?? '').replace(/^v/, '') !== doc.version) throw new Error(`the signature carries version ${fields.version ?? 'none'}, the envelope says ${doc.version}`)
  return doc
}

// ---- the command --------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { sign: true, expiresDays: DEFAULT_EXPIRES_DAYS, dataFormat: DEFAULT_DATA_FORMAT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--dist': out.dist = value(); break
      case '--version': out.version = value(); break
      case '--channel': out.channel = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--min-version': out.minVersion = value(); break
      case '--data-format': out.dataFormat = Number(value()); break
      case '--expires-days': out.expiresDays = Number(value()); break
      case '--notes': out.notes = value(); break
      case '--generated-at': out.generatedAt = value(); break
      case '--download-base': out.downloadBase = value(); break
      case '--tauri': out.tauri = value(); break
      case '--no-sign': out.sign = false; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  for (const k of ['dist', 'version', 'pubkey']) if (!out[k]) throw new Error(`--${k} is required`)
  out.channel ??= channelOf(out.version)
  out.minVersion ??= out.version.startsWith('2.') ? '2.0.0-beta.1' : out.version
  return out
}

export function collectAssets(dist, version) {
  const assets = []
  for (const t of artifactTargets(version)) {
    const file = path.join(dist, t.file)
    if (!fs.existsSync(file)) continue
    const asset = { target: t.target, file: t.file, bytes: fs.readFileSync(file) }
    if (t.signed) {
      const sigFile = `${file}.sig`
      if (!fs.existsSync(sigFile)) throw new Error(`${t.file} has no .sig beside it`)
      asset.signature = fs.readFileSync(sigFile, 'utf8').trim()
    }
    assets.push(asset)
  }
  return assets
}

// Signs `file` with the release key through the Tauri CLI; TAURI_SIGNING_PRIVATE_KEY and
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD come from the environment, as for `tauri build`.
export function signWithTauri(file, version, tauri = process.env.TAURI_CLI || 'tauri') {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('TAURI_SIGNING_PRIVATE_KEY (or _PATH) is not set')
  execFileSync(tauri, ['signer', 'sign', '--app-version', version, file], { stdio: ['ignore', 'pipe', 'inherit'] })
  const sigFile = `${file}.sig`
  if (!fs.existsSync(sigFile)) throw new Error(`tauri signer sign wrote no ${sigFile}`)
  return fs.readFileSync(sigFile, 'utf8').trim()
}

export function main(argv) {
  const opts = parseArgs(argv)
  const key = parsePublicKey(fs.readFileSync(opts.pubkey, 'utf8'))
  const now = opts.generatedAt ? new Date(opts.generatedAt) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error('--generated-at is not a date')
  // the client refuses a feed dated more than a day ahead, and accepting one would raise every
  // client's replay floor past the feeds to come: a typo here must not ship
  if (now.getTime() > Date.now() + 3600000) throw new Error(`--generated-at ${opts.generatedAt} is in the future`)
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expiresAt = new Date(now.getTime() + opts.expiresDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const assets = collectAssets(opts.dist, opts.version)
  const envelope = buildEnvelope({
    version: opts.version, channel: opts.channel, keyId: key.keyId, generatedAt, expiresAt,
    minVersion: opts.minVersion, dataFormat: opts.dataFormat, notes: opts.notes, assets, key,
  }, opts.downloadBase)
  const envelopeFile = path.join(opts.dist, ENVELOPE_FILE)
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
  fs.writeFileSync(envelopeFile, bytes)
  fs.writeFileSync(path.join(opts.dist, 'latest.json'), JSON.stringify(buildLatestJson(envelope), null, 2) + '\n')
  if (opts.sign) {
    const sig = signWithTauri(envelopeFile, opts.version, opts.tauri)
    verifyEnvelope(bytes, sig, key)
    console.log(`Signed ${ENVELOPE_FILE} for ${opts.version} (${opts.channel}) with key ${key.keyId}; ${assets.length} artifact(s)`)
  } else {
    console.log(`Wrote ${ENVELOPE_FILE} for ${opts.version} (${opts.channel}), unsigned; ${assets.length} artifact(s)`)
  }
  return envelope
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`update-envelope: ${err.message}`)
    process.exit(1)
  }
}
