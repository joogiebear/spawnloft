// What a built SpawnLoft binary trusts for updates (rust/beta-review/REVIEW.md B6), read from the
// bytes so it works on any host and for any platform's build:
//
//   - every minisign public key line compiled into the binary (`RW` + 54 base64 characters that
//     decode to an Ed25519 minisign key). spawnloft-lib's update/keys.rs always carries the two
//     release keys; a build made with SPAWNLOFT_UPDATE_PUBKEYS (the CI test builds) carries the
//     override list as well, and trusts only that list. So a release build is one whose key lines
//     are exactly the release keys,
//   - for the core, which feed code it was built with: update/fetch.rs compiles in exactly one of
//     `spawnloft-feed:release` and `spawnloft-feed:internal` (the `internal-feed` feature, which
//     reads SPAWNLOFT_UPDATE_SOURCE and allows loopback HTTP).
//
// The release keys are read from keys.rs itself, so this file never holds a second copy of them.
// `statusProblems` checks the same facts from a runnable core's `update status --json`.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const KEYS_RS = path.join(HERE, '..', 'rust', 'crates', 'spawnloft-lib', 'src', 'update', 'keys.rs')
export const FEED_RELEASE = 'spawnloft-feed:release'
export const FEED_INTERNAL = 'spawnloft-feed:internal'

// The key id minisign prints for a key line (bytes 2..10, little endian), or null if the line is
// not an Ed25519 minisign public key.
export function keyIdOf(line) {
  const raw = Buffer.from(line, 'base64')
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') return null
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase()
}

// The release key list compiled into every build: RELEASE_KEYS in update/keys.rs.
export function releaseKeys(file = KEYS_RS) {
  const text = fs.readFileSync(file, 'utf8')
  const block = /const RELEASE_KEYS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text)
  if (!block) throw new Error(`${file}: no RELEASE_KEYS list`)
  const keys = [...block[1].matchAll(/"([0-9A-F]{16})",\s*"(RW[A-Za-z0-9+/=]{54})"/g)].map(m => ({ id: m[1], line: m[2] }))
  if (!keys.length) throw new Error(`${file}: RELEASE_KEYS lists no key`)
  for (const k of keys) if (keyIdOf(k.line) !== k.id) throw new Error(`${file}: key ${k.id} does not match its key line`)
  return keys
}

// Every minisign key line in `bytes`, by key id. A string literal is stored contiguously, so the
// whole line is there; overlapping windows are tried so a neighbouring literal cannot hide one.
export function embeddedKeys(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes)
  const found = new Map()
  for (const m of text.matchAll(/(?=(RW[A-Za-z0-9+/]{54}))/g)) {
    const id = keyIdOf(m[1])
    if (id) found.set(id, m[1])
  }
  return found
}

// The problems with one binary. `kind` is 'core' (also checks the feed code) or 'shell'.
export function binaryProblems(bytes, kind, release = releaseKeys()) {
  const problems = []
  const keys = embeddedKeys(bytes)
  const ids = new Set(release.map(k => k.id))
  // the core always reaches the key list (it verifies every feed); a shell whose platform never
  // verifies an update itself may carry none, but never a partial or foreign list
  if (kind === 'core' || keys.size) for (const k of release) if (keys.get(k.id) !== k.line) problems.push(`does not carry release key ${k.id}`)
  for (const id of keys.keys()) if (!ids.has(id)) problems.push(`trusts key ${id}, which is not a release key (built with SPAWNLOFT_UPDATE_PUBKEYS, a test key list)`)
  if (kind === 'core') {
    const text = bytes.toString('latin1')
    if (text.includes(FEED_INTERNAL)) problems.push('was built with the internal-feed feature (loopback test feeds)')
    else if (!text.includes(FEED_RELEASE)) problems.push(`carries no ${FEED_RELEASE} marker, so its feed code cannot be told (a build from before the marker?)`)
  }
  return problems
}

// The same facts from a runnable core: `spawnloft-core update status --json`.
export function statusProblems(status, release = releaseKeys()) {
  const problems = []
  if (status.keysOverridden !== false) problems.push(`update status says keysOverridden=${status.keysOverridden}`)
  const ids = (status.keys ?? []).map(k => k.id).sort()
  const want = release.map(k => k.id).sort()
  if (ids.join(',') !== want.join(',')) problems.push(`update status trusts ${ids.join(', ') || 'no key'}, expected ${want.join(', ')}`)
  if (status.feed !== FEED_RELEASE) problems.push(`update status reports feed ${status.feed ?? 'none'}, expected ${FEED_RELEASE}`)
  if (JSON.stringify(status.sources) !== JSON.stringify(['github'])) problems.push(`update status reads from ${JSON.stringify(status.sources)}, expected ["github"]`)
  return problems
}

// ---- reading binaries out of archives -------------------------------------------------------------

// The regular files of an uncompressed tar whose path `want(name)` accepts: [{ name, data }].
// Handles ustar prefixes, GNU long names ('L') and pax path records ('x').
export function tarFiles(tar, want) {
  const out = []
  let longName = null
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512)
    if (header.every(b => b === 0)) break
    const field = (a, b) => header.toString('utf8', a, b).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 136).replace(/[^0-7]/g, ''), 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const data = tar.subarray(off + 512, off + 512 + size)
    let name = field(0, 100)
    const prefix = field(257, 263).startsWith('ustar') ? field(345, 500) : ''
    if (prefix) name = `${prefix}/${name}`
    if (longName !== null) { name = longName; longName = null }
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '')
    else if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (m) longName = m[1]
    } else if ((type === '0' || type === '\0' || type === '7') && want(name.replace(/^\.\//, ''))) {
      out.push({ name: name.replace(/^\.\//, ''), data: Buffer.from(data) })
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

// The regular files of a cpio "newc" stream (what rpm2cpio writes) whose path `want` accepts.
export function cpioFiles(cpio, want) {
  const out = []
  for (let off = 0; off + 110 <= cpio.length;) {
    const magic = cpio.toString('ascii', off, off + 6)
    if (magic !== '070701' && magic !== '070702') throw new Error(`not a newc cpio stream at ${off}`)
    const hex = i => parseInt(cpio.toString('ascii', off + 6 + i * 8, off + 14 + i * 8), 16)
    const mode = hex(1); const size = hex(6); const nameSize = hex(11)
    const nameStart = off + 110
    const name = cpio.toString('utf8', nameStart, nameStart + nameSize - 1)
    const dataStart = nameStart + nameSize + ((4 - ((110 + nameSize) % 4)) % 4)
    if (name === 'TRAILER!!!') break
    const clean = name.replace(/^\.?\//, '')
    if ((mode & 0o170000) === 0o100000 && want(clean)) out.push({ name: clean, data: Buffer.from(cpio.subarray(dataStart, dataStart + size)) })
    off = dataStart + size + ((4 - (size % 4)) % 4)
  }
  return out
}

// Which binaries in an archive are the core and the shell, by path.
export function binaryKind(name) {
  const base = name.split('/').pop()
  if (base === 'spawnloft-core' || base === 'spawnloft-core.exe') return 'core'
  if (/Contents\/MacOS\/SpawnLoft$/.test(name) || base === 'spawnloft-desktop' || base === 'SpawnLoft.exe') return 'shell'
  return null
}

// The trust problems of a macOS updater tarball (gzipped tar of SpawnLoft.app), and what was read.
export function macTarballTrust(tgz, release = releaseKeys()) {
  const files = tarFiles(zlib.gunzipSync(tgz), n => binaryKind(n) !== null)
  return archiveTrust(files, ['core', 'shell'], release)
}

// `files` from tarFiles/cpioFiles; `need` the kinds that must be present.
export function archiveTrust(files, need, release = releaseKeys()) {
  const problems = []
  const checked = []
  for (const kind of need) if (!files.some(f => binaryKind(f.name) === kind)) problems.push(`holds no ${kind} binary`)
  for (const f of files) {
    const kind = binaryKind(f.name)
    const found = binaryProblems(f.data, kind, release)
    problems.push(...found.map(p => `${f.name} ${p}`))
    checked.push(f.name)
  }
  return { problems, checked }
}

// node desktop/build-trust.mjs <binary>[=core|shell]...   exits 1 unless every binary is release-grade
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = releaseKeys()
  let bad = 0
  for (const arg of process.argv.slice(2)) {
    const m = /^(.*?)(?:=(core|shell))?$/.exec(arg)
    const kind = m[2] ?? binaryKind(m[1].replaceAll('\\', '/')) ?? 'shell'
    const problems = binaryProblems(fs.readFileSync(m[1]), kind, release)
    if (problems.length) { bad++; for (const p of problems) console.error(`  FAIL ${m[1]} ${p}`) }
    else console.log(`  ok   ${m[1]} (${kind}): trusts exactly the release keys ${release.map(k => k.id).join(', ')}${kind === 'core' ? `, ${FEED_RELEASE}` : ''}`)
  }
  if (!process.argv[2]) { console.error('usage: node desktop/build-trust.mjs <binary>[=core|shell]...'); process.exit(64) }
  process.exit(bad ? 1 : 0)
}
