// The signed list of harness builds (all-versions plan, step V3; design in V3-PLAN.md, with the
// review's decisions in its section 12). The harness mod is built per Minecraft version; this list
// lets a new build reach SpawnLoft without a SpawnLoft release. It is two release assets of the mod
// repo's fixed `index` tag: harness-index.json and its one-line Ed25519 signature. The signature is
// checked on the raw bytes before anything is parsed, against the two public keys below; a list
// older than the one this build shipped with, or than the one already cached, is refused; and a
// row can only name a jar among the mod repo's own releases, pinned by sha256. Nothing about the
// list ever fails a launch: bad, stale, replayed, oversized or unreachable all mean "the cached
// verified copy, else the built-in rows", and the reason goes to a status file the doctor reads.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { UserError, renameOver } from './util.mjs'
import { CLIENT_CACHE_DIR } from './client-paths.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { fetchCapped } from './download.mjs'

// SPKI DER, base64. Both made by Victor on the signing machine on 2026-10-29; the private halves
// never leave it (the spare's is kept offline). Signing uses the primary; the spare is there so a
// key can be switched without stranding builds that only know one.
export const HARNESS_INDEX_KEYS = [
  { name: 'primary', spki: 'MCowBQYDK2VwAyEA4gftri3viZzfRIT7o+lr5ndac+Kd9/KKSIoTFba/DGc=' },
  { name: 'spare', spki: 'MCowBQYDK2VwAyEA7eDiBj6m+d/4AgWLqJEo0QfG4Q6QJHxRgvN7mrR851c=' },
]

// The serial of the signed list whose rows were last copied into HARNESS_RELEASES (the fold rule in
// desktop/STABLE.md): a list below it is older than what this build ships with.
export const HARNESS_INDEX_MIN_SERIAL = 1

export const HARNESS_RELEASE_PREFIX = 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/'
export const HARNESS_INDEX_URL = `${HARNESS_RELEASE_PREFIX}index/harness-index.json`
export const HARNESS_INDEX_SIG_URL = `${HARNESS_INDEX_URL}.sig`

// Signed and verified ahead of the file's bytes, so a signature this key made over anything else
// can never pass for a list.
export const SIGNATURE_DOMAIN = 'spawnloft-harness-index/1\n'

const MAX_INDEX_BYTES = 64 * 1024
const MAX_SIG_BYTES = 1024
const MAX_ROWS = 100
const MAX_REVOKE = 8
const FETCH_TIMEOUT_MS = 10000
const FRESH_MS = 24 * 3600000
const RETRY_AFTER_FAILURE_MS = 3600000
const FORCE_GUARD_MS = 60000

const INDEX_FILE = 'harness-index.json'
const SIG_FILE = 'harness-index.json.sig'
const STATUS_FILE = 'harness-index.status.json'
const REVOKED_FILE = 'harness-revoked-keys.json'

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/
const TAG_RE = /^v[0-9A-Za-z][0-9A-Za-z.-]{0,39}-mc[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILE_RE = /^spawnloft-harness-[0-9A-Za-z][0-9A-Za-z.-]{0,39}\+[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jar$/
const SHA256_RE = /^[0-9a-fA-F]{64}$/
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/
const SPKI_RE = /^[A-Za-z0-9+/]{40,120}={0,2}$/

export function harnessJarUrl(row) {
  return HARNESS_RELEASE_PREFIX + row.tag + '/' + encodeURIComponent(row.file)
}

const indexError = (code, message) => Object.assign(new UserError(message), { code })

const publicKeys = new Map()
function publicKey(spki) {
  if (!publicKeys.has(spki)) publicKeys.set(spki, crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }))
  return publicKeys.get(spki)
}

// One row, copied field by field into a fresh object (nothing of the parsed JSON is kept by
// reference, unknown keys included). Throws with the row and the field.
function validRow(raw, n) {
  const bad = (field, why) => { throw indexError('harness-index-format', `row ${n}: ${field} ${why}`) }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad('', 'is not an object')
  const ids = raw.minecraft
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20) bad('minecraft', 'must be a list of 1 to 20 version ids')
  const minecraft = ids.map((id) => {
    if (typeof id !== 'string' || !isSafeVersionId(id)) bad('minecraft', `has an id SpawnLoft would not use (${JSON.stringify(id)})`)
    return id
  })
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) bad('version', 'is not a mod version')
  if (typeof raw.tag !== 'string' || !TAG_RE.test(raw.tag)) bad('tag', 'is not a harness release tag')
  if (typeof raw.file !== 'string' || !FILE_RE.test(raw.file)) bad('file', 'is not a harness jar name')
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) bad('sha256', 'is not 64 hex digits')
  return { minecraft, version: raw.version, tag: raw.tag, file: raw.file, sha256: raw.sha256.toLowerCase() }
}

// The list in `bytes`, if `sigText` is a signature over it by one of `keys` (skipping `revoked`)
// and its content is well formed and not older than `minSerial`: { serial, generated, rows,
// revoke, key }. Otherwise throws with code harness-index-signature, -format or -serial.
export function parseHarnessIndex(bytes, sigText, { keys = HARNESS_INDEX_KEYS, minSerial = HARNESS_INDEX_MIN_SERIAL, revoked = [] } = {}) {
  const sigLine = String(sigText).replace(/[\r\n\t ]+$/, '')
  if (!SIG_RE.test(sigLine)) throw indexError('harness-index-signature', 'the signature file is not one base64 Ed25519 signature')
  const signature = Buffer.from(sigLine, 'base64')
  const signed = Buffer.concat([Buffer.from(SIGNATURE_DOMAIN), bytes])
  const key = keys.find((k) => !revoked.includes(k.spki) && crypto.verify(null, signed, publicKey(k.spki), signature))
  if (!key) throw indexError('harness-index-signature', 'the signature does not verify with any key this SpawnLoft trusts')

  let doc
  try {
    doc = JSON.parse(bytes.toString('utf8'))
  } catch (err) {
    throw indexError('harness-index-format', `not JSON: ${err.message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw indexError('harness-index-format', 'not a JSON object')
  if (doc.format !== 1) throw indexError('harness-index-format', `format ${JSON.stringify(doc.format)} is not one this SpawnLoft reads`)
  if (!Number.isSafeInteger(doc.serial) || doc.serial < 1) throw indexError('harness-index-format', 'serial is not a positive whole number')
  if (!Array.isArray(doc.rows) || doc.rows.length > MAX_ROWS) throw indexError('harness-index-format', `rows must be a list of at most ${MAX_ROWS}`)
  const rows = doc.rows.map((row, i) => validRow(row, i + 1))
  const seen = new Set()
  for (const id of rows.flatMap((r) => r.minecraft)) {
    if (seen.has(id)) throw indexError('harness-index-format', `Minecraft ${id} is listed twice`)
    seen.add(id)
  }
  let revoke = []
  if (doc.revoke !== undefined) {
    if (!Array.isArray(doc.revoke) || doc.revoke.length > MAX_REVOKE || !doc.revoke.every((k) => typeof k === 'string' && SPKI_RE.test(k))) {
      throw indexError('harness-index-format', `revoke must be a list of at most ${MAX_REVOKE} public keys`)
    }
    revoke = [...doc.revoke]
  }
  if (doc.serial < minSerial) throw indexError('harness-index-serial', `serial ${doc.serial} is older than the list this SpawnLoft shipped with (${minSerial})`)
  return { serial: doc.serial, generated: typeof doc.generated === 'string' ? doc.generated.slice(0, 40) : null, rows, revoke, key: key.name }
}

// ---- the cache -------------------------------------------------------------------------------

const file = (cacheDir, name) => path.join(cacheDir, name)

function writeAtomic(dest, data) {
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    renameOver(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

function readJsonFile(dest, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dest, 'utf8'))
  } catch {
    return fallback
  }
}

function readRevoked(cacheDir) {
  const list = readJsonFile(file(cacheDir, REVOKED_FILE), [])
  return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []
}

function writeStatus(cacheDir, status) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    writeAtomic(file(cacheDir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`)
  } catch {
    // the status is for the doctor; a disk that cannot take it has bigger news
  }
}

function dropCache(cacheDir) {
  for (const name of [INDEX_FILE, SIG_FILE, `${INDEX_FILE}.fetched-at`]) fs.rmSync(file(cacheDir, name), { force: true })
}

// The copy in the cache, verified again (with every revocation applied), or null. A copy that no
// longer verifies is deleted, so "the cache holds verified copies only" stays true after a crash,
// a hand edit, or a newer build with a higher floor or fewer keys. { ...parsed, bytes } on success.
export function loadCachedHarnessIndex({ cacheDir = CLIENT_CACHE_DIR, keys = HARNESS_INDEX_KEYS, minSerial = HARNESS_INDEX_MIN_SERIAL, revoked = null } = {}) {
  let bytes, sig
  try {
    bytes = fs.readFileSync(file(cacheDir, INDEX_FILE))
    sig = fs.readFileSync(file(cacheDir, SIG_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    return { ...parseHarnessIndex(bytes, sig, { keys, minSerial, revoked: revoked ?? readRevoked(cacheDir) }), bytes }
  } catch (err) {
    dropCache(cacheDir)
    const old = readJsonFile(file(cacheDir, STATUS_FILE), {})
    writeStatus(cacheDir, { ...statusFields(old), source: 'built-in', serial: null, key: null, generated: null, outcome: err.code ?? 'harness-index-format', reason: `the cached list was dropped: ${err.message}` })
    return null
  }
}

function statusFields(s) {
  return { lastCheck: Number(s?.lastCheck) || null, outcome: s?.outcome ?? null, reason: s?.reason ?? null }
}

// ---- in memory -------------------------------------------------------------------------------

// The rows of the verified copy in use, per cache folder (tests use several). Loaded lazily by the
// first lookup, replaced by an accepted refresh.
const loaded = new Map()
const lastTried = new Map()

export function indexRows({ cacheDir = CLIENT_CACHE_DIR, keys = HARNESS_INDEX_KEYS, minSerial = HARNESS_INDEX_MIN_SERIAL } = {}) {
  if (!loaded.has(cacheDir)) loaded.set(cacheDir, loadCachedHarnessIndex({ cacheDir, keys, minSerial }))
  return loaded.get(cacheDir)?.rows ?? []
}

// Tests: forget what this process loaded and when it last asked the network.
export function forgetHarnessIndex() {
  loaded.clear()
  lastTried.clear()
}

// ---- refresh ---------------------------------------------------------------------------------

// Asks GitHub for the list when the copy in use is older than a day (an hour after a failed try),
// or now with `force` (at most once a minute). Never throws: the outcome goes to the status file.
// Returns that outcome.
export async function refreshHarnessIndex({ cacheDir = CLIENT_CACHE_DIR, force = false, fetchImpl = null, keys = HARNESS_INDEX_KEYS, minSerial = HARNESS_INDEX_MIN_SERIAL, now = Date.now } = {}) {
  // npm test sets this so the suite never reads the real published list (tests pass fetchImpl)
  if (!fetchImpl && process.env.SPAWNLOFT_HARNESS_INDEX_FETCH === 'off') return 'off'
  const old = readJsonFile(file(cacheDir, STATUS_FILE), {})
  const fetchedAt = Number(readJsonFile(file(cacheDir, `${INDEX_FILE}.fetched-at`), NaN))
  if (!force) {
    indexRows({ cacheDir, keys, minSerial })
    if (Number.isFinite(fetchedAt) && now() - fetchedAt < FRESH_MS && loaded.get(cacheDir)) return 'fresh'
    const failed = old.outcome && !['accepted', 'unchanged'].includes(old.outcome)
    if (failed && now() - (Number(old.lastCheck) || 0) < RETRY_AFTER_FAILURE_MS) return 'recently-failed'
  }
  if (now() - (lastTried.get(cacheDir) ?? -Infinity) < FORCE_GUARD_MS) return 'recently-tried'
  lastTried.set(cacheDir, now())

  const record = (outcome, reason, copy) => {
    writeStatus(cacheDir, {
      lastCheck: now(),
      outcome,
      reason,
      source: copy ? 'index' : 'built-in',
      serial: copy?.serial ?? null,
      generated: copy?.generated ?? null,
      key: copy?.key ?? null,
    })
    return outcome
  }

  let bytes, sig
  try {
    const fetcher = fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
    bytes = await fetchCapped(HARNESS_INDEX_URL, { maxBytes: MAX_INDEX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, fetcher, label: 'the harness list' })
    sig = (await fetchCapped(HARNESS_INDEX_SIG_URL, { maxBytes: MAX_SIG_BYTES, timeoutMs: FETCH_TIMEOUT_MS, fetcher, label: 'the harness list signature' })).toString('utf8')
  } catch (err) {
    const current = loaded.get(cacheDir) ?? loadCachedHarnessIndex({ cacheDir, keys, minSerial })
    return record(err.code === 'too-large' ? 'harness-index-oversized' : 'harness-index-unreachable', err.message, current)
  }

  const storedRevoked = readRevoked(cacheDir)
  let fresh
  try {
    fresh = parseHarnessIndex(bytes, sig, { keys, minSerial, revoked: storedRevoked })
  } catch (err) {
    const current = loaded.get(cacheDir) ?? loadCachedHarnessIndex({ cacheDir, keys, minSerial })
    return record(err.code, err.message, current)
  }

  // A key the new list revokes is out before the cached copy is compared with it: a copy signed
  // by a revoked key (say one that published a huge serial) is dropped, not trusted for its serial.
  const signedBy = keys.find((k) => k.name === fresh.key)?.spki
  const revoked = [...new Set([...storedRevoked, ...fresh.revoke.filter((k) => k !== signedBy && keys.some((known) => known.spki === k))])]
  const cached = loadCachedHarnessIndex({ cacheDir, keys, minSerial, revoked })
  if (cached) {
    if (fresh.serial < cached.serial) {
      loaded.set(cacheDir, cached)
      return record('harness-index-serial', `serial ${fresh.serial} is older than the cached list (${cached.serial}); a replay of an old list`, cached)
    }
    if (fresh.serial === cached.serial) {
      loaded.set(cacheDir, cached)
      if (Buffer.compare(bytes, cached.bytes) !== 0) {
        return record('harness-index-serial', `serial ${fresh.serial} was published again with different content`, cached)
      }
      try {
        writeAtomic(file(cacheDir, `${INDEX_FILE}.fetched-at`), String(now()))
      } catch (err) {
        return record('harness-index-store', `could not write to ${cacheDir}: ${err.message}`, cached)
      }
      return record('unchanged', null, cached)
    }
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    if (revoked.length !== storedRevoked.length) writeAtomic(file(cacheDir, REVOKED_FILE), `${JSON.stringify(revoked, null, 2)}\n`)
    writeAtomic(file(cacheDir, INDEX_FILE), bytes)
    writeAtomic(file(cacheDir, SIG_FILE), sig)
    writeAtomic(file(cacheDir, `${INDEX_FILE}.fetched-at`), String(now()))
  } catch (err) {
    loaded.set(cacheDir, cached)
    return record('harness-index-store', `could not write to ${cacheDir}: ${err.message}`, cached)
  }
  const accepted = { ...fresh, bytes }
  loaded.set(cacheDir, accepted)
  return record('accepted', null, accepted)
}

// For the doctor and the diagnostics bundle: where the rows come from and how the last check went.
export function harnessIndexStatus({ cacheDir = CLIENT_CACHE_DIR, keys = HARNESS_INDEX_KEYS, minSerial = HARNESS_INDEX_MIN_SERIAL } = {}) {
  const s = readJsonFile(file(cacheDir, STATUS_FILE), {})
  const fetchedAt = Number(readJsonFile(file(cacheDir, `${INDEX_FILE}.fetched-at`), NaN))
  indexRows({ cacheDir, keys, minSerial })
  const copy = loaded.get(cacheDir)
  return {
    source: copy ? 'index' : 'built-in',
    serial: copy?.serial ?? null,
    generated: copy?.generated ?? null,
    key: copy?.key ?? null,
    ids: copy ? copy.rows.flatMap((r) => r.minecraft) : [],
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    ...statusFields(s),
  }
}
