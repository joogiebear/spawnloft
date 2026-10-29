import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-harness-index-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const {
  parseHarnessIndex, loadCachedHarnessIndex, refreshHarnessIndex, harnessIndexStatus, forgetHarnessIndex, indexRows,
  harnessJarUrl, HARNESS_INDEX_URL, HARNESS_INDEX_SIG_URL, HARNESS_INDEX_KEYS, SIGNATURE_DOMAIN,
} = await import('../src/client-harness-index.mjs')
const { fetchCapped } = await import('../src/download.mjs')
const { harnessFor, publishedHarnessIds } = await import('../src/client-harness.mjs')
const { harnessListLine } = await import('../src/doctor-client.mjs')

// Keys made here; no private key is ever checked in. The code's real keys are only checked for shape.
function pair(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { name, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey }
}
const primary = pair('primary')
const spare = pair('spare')
const stranger = pair('stranger')
const keys = [primary, spare].map(({ name, spki }) => ({ name, spki }))

const row = (id, extra = {}) => ({
  minecraft: [id], version: '0.2.0', tag: `v0.2.0-mc${id}`, file: `spawnloft-harness-0.2.0+${id}.jar`, sha256: 'ab'.repeat(32), ...extra,
})
const indexBytes = (doc) => Buffer.from(`${JSON.stringify({ format: 1, serial: 1, generated: '2026-10-29T00:00:00Z', rows: [row('26.3')], ...doc }, null, 2)}\n`)
const sign = (bytes, key = primary) => `${crypto.sign(null, Buffer.concat([Buffer.from(SIGNATURE_DOMAIN), bytes]), key.privateKey).toString('base64')}\n`
const parse = (bytes, sig, opts = {}) => parseHarnessIndex(bytes, sig, { keys, minSerial: 1, ...opts })
const code = (fn) => { try { fn() } catch (err) { return err.code } return null }

test('the shipped keys are two Ed25519 SPKI keys and the URLs are the mod repo\'s index release', () => {
  assert.deepEqual(HARNESS_INDEX_KEYS.map((k) => k.name), ['primary', 'spare'])
  for (const k of HARNESS_INDEX_KEYS) assert.equal(crypto.createPublicKey({ key: Buffer.from(k.spki, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519')
  assert.equal(HARNESS_INDEX_URL, 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/index/harness-index.json')
  assert.equal(HARNESS_INDEX_SIG_URL, `${HARNESS_INDEX_URL}.sig`)
  // the built-in row builds the URL the 0.1.0 release has always had
  assert.equal(harnessFor('1.21.11').url, 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/v0.1.0-mc1.21.11/spawnloft-harness-0.1.0%2B1.21.11.jar')
  assert.equal(harnessJarUrl(row('26.3')), 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/v0.2.0-mc26.3/spawnloft-harness-0.2.0%2B26.3.jar')
})

test('a list signed by either key is read; any other key, a changed byte or a bad .sig is not', () => {
  const bytes = indexBytes()
  assert.equal(parse(bytes, sign(bytes)).key, 'primary')
  assert.equal(parse(bytes, sign(bytes, spare)).key, 'spare')
  assert.deepEqual(parse(bytes, sign(bytes)).rows, [row('26.3')])
  assert.equal(code(() => parse(bytes, sign(bytes, stranger))), 'harness-index-signature')
  const flipped = Buffer.from(bytes); flipped[10] ^= 1
  assert.equal(code(() => parse(flipped, sign(bytes))), 'harness-index-signature')
  // without the domain prefix the same key's signature is not one
  const bare = crypto.sign(null, bytes, primary.privateKey).toString('base64')
  assert.equal(code(() => parse(bytes, bare)), 'harness-index-signature')
  // a revoked key is skipped
  assert.equal(code(() => parse(bytes, sign(bytes), { revoked: [primary.spki] })), 'harness-index-signature')

  const sig = sign(bytes).trim()
  for (const ok of [sig, `${sig}\r\n`, `${sig}  \t\n`]) assert.equal(parse(bytes, ok).serial, 1)
  for (const bad of ['', `${sig}\n${sig}`, Buffer.from(sig, 'base64').toString('hex'), sig.slice(0, -4) + '====', `-----BEGIN-----\n${sig}`, ` ${sig}`]) {
    assert.equal(code(() => parse(bytes, bad)), 'harness-index-signature', JSON.stringify(bad))
  }
})

test('every malformed field refuses the whole list, naming it', () => {
  const cases = [
    [{ format: 2 }, /format 2/],
    [{ serial: undefined }, /serial/],
    [{ serial: 0 }, /serial/],
    [{ serial: 1.5 }, /serial/],
    [{ serial: '3' }, /serial/],
    [{ serial: Number.MAX_SAFE_INTEGER + 2 }, /serial/],
    [{ rows: 'x' }, /rows/],
    [{ rows: Array.from({ length: 101 }, (_, i) => row(`1.${i}`)) }, /rows/],
    [{ rows: [row('26.3', { minecraft: [] })] }, /row 1: minecraft/],
    [{ rows: [row('26.3', { minecraft: ['../x'] })] }, /row 1: minecraft/],
    [{ rows: [row('26.3', { minecraft: ['26.3.'] })] }, /row 1: minecraft/],
    [{ rows: [row('26.3', { version: '0.2/0' })] }, /row 1: version/],
    [{ rows: [row('26.3', { sha256: 'a'.repeat(63) })] }, /row 1: sha256/],
    [{ rows: [row('26.3', { sha256: 'g'.repeat(64) })] }, /row 1: sha256/],
    [{ rows: [row('26.3', { tag: '../evil' })] }, /row 1: tag/],
    [{ rows: [row('26.3', { tag: 'v0.2.0-mc26.3?x' })] }, /row 1: tag/],
    [{ rows: [row('26.3', { tag: 'v0.2.0-mc26.3/../../other' })] }, /row 1: tag/],
    [{ rows: [row('26.3', { file: 'spawnloft-harness-0.2.0+26.3.jar/../x.jar' })] }, /row 1: file/],
    [{ rows: [row('26.3', { file: 'evil.jar' })] }, /row 1: file/],
    [{ rows: [row('26.3', { file: 'spawnloft-harness-0.2.0%2e%2e+26.3.jar' })] }, /row 1: file/],
    [{ rows: [row('26.3'), row('26.3', { version: '0.2.1' })] }, /26\.3 is listed twice/],
    [{ rows: [null] }, /row 1/],
    [{ revoke: 'x' }, /revoke/],
    [{ revoke: Array(9).fill(primary.spki) }, /revoke/],
  ]
  for (const [doc, why] of cases) {
    const bytes = indexBytes(doc)
    assert.throws(() => parse(bytes, sign(bytes)), (err) => err.code === 'harness-index-format' && why.test(err.message), JSON.stringify(doc).slice(0, 80))
  }
  const bytes = Buffer.from('not json')
  assert.equal(code(() => parse(bytes, sign(bytes))), 'harness-index-format')
})

test('unknown keys are accepted and dropped; parsed rows are fresh objects', () => {
  const bytes = Buffer.from(`{"format":1,"serial":2,"later":true,"rows":[{"minecraft":["26.3"],"version":"0.2.0","tag":"v0.2.0-mc26.3","file":"spawnloft-harness-0.2.0+26.3.jar","sha256":"${'AB'.repeat(32)}","notes":"x","__proto__":{"polluted":true}}]}`)
  const got = parse(bytes, sign(bytes))
  assert.deepEqual(Object.keys(got.rows[0]), ['minecraft', 'version', 'tag', 'file', 'sha256'])
  assert.equal(got.rows[0].sha256, 'ab'.repeat(32))
  assert.equal(got.rows[0].polluted, undefined)
  assert.equal({}.polluted, undefined)
  assert.equal(got.generated, null)
})

test('a list older than the floor is refused', () => {
  const bytes = indexBytes({ serial: 4 })
  assert.equal(code(() => parse(bytes, sign(bytes), { minSerial: 5 })), 'harness-index-serial')
  assert.equal(parse(bytes, sign(bytes), { minSerial: 4 }).serial, 4)
})

// ---- fetching --------------------------------------------------------------------------------

// A fetch stub: answers per URL with { status, chunks } or a function; records what was pulled.
function server(answers) {
  const log = { calls: [], pulled: 0, aborted: 0 }
  const fetchImpl = async (url, init) => {
    log.calls.push(url)
    init?.signal?.addEventListener('abort', () => { log.aborted++ })
    let a = answers[url]
    if (typeof a === 'function') a = a()
    if (!a) throw new Error(`no answer for ${url}`)
    if (a.error) throw a.error
    const chunks = a.chunks ?? [a.body]
    async function* body() {
      for (const c of chunks) {
        if (c === 'stall') await new Promise(() => {})
        log.pulled += c.length
        yield Buffer.from(c)
      }
    }
    return { ok: a.status === undefined || a.status < 300, status: a.status ?? 200, headers: new Headers(a.headers ?? {}), body: body() }
  }
  return { fetchImpl, log }
}
const published = (bytes, sig, extra = {}) => ({ [HARNESS_INDEX_URL]: { body: bytes, ...extra }, [HARNESS_INDEX_SIG_URL]: { body: Buffer.from(sig) } })

test('fetchCapped stops reading and aborts the request past the cap, whatever Content-Length said', async () => {
  const { fetchImpl, log } = server({ u: { chunks: Array(20).fill(Buffer.alloc(8192)), headers: { 'content-length': '2000' } } })
  await assert.rejects(fetchCapped('u', { maxBytes: 64 * 1024, fetcher: fetchImpl }), (err) => err.code === 'too-large')
  assert.ok(log.pulled <= 64 * 1024 + 8192, `pulled ${log.pulled}`)
  assert.ok(log.aborted >= 1)
  const ok = server({ u: { chunks: ['ab', 'cd'] } })
  assert.equal((await fetchCapped('u', { maxBytes: 4, fetcher: ok.fetchImpl })).toString(), 'abcd')
})

test('fetchCapped gives up on a body that stalls, and retries a 504 once', async () => {
  const stall = server({ u: { chunks: ['ab', 'stall'] } })
  const started = Date.now()
  await assert.rejects(fetchCapped('u', { maxBytes: 100, timeoutMs: 200, fetcher: stall.fetchImpl }), (err) => err.code === 'download-failed' && /timed out/.test(err.message))
  assert.ok(Date.now() - started < 5000)

  let n = 0
  const flaky = server({ u: () => (++n === 1 ? { status: 504, body: 'busy' } : { body: 'ok' }) })
  assert.equal((await fetchCapped('u', { maxBytes: 100, delayMs: 1, fetcher: flaky.fetchImpl })).toString(), 'ok')
  const gone = server({ u: { status: 404, body: 'no' } })
  await assert.rejects(fetchCapped('u', { maxBytes: 100, delayMs: 1, fetcher: gone.fetchImpl }), (err) => err.code === 'download-failed' && /404/.test(err.message))
  assert.equal(gone.log.calls.length, 1)
})

// ---- refresh and the cache -------------------------------------------------------------------

let clock = Date.parse('2026-10-29T12:00:00Z')
const now = () => clock
let dirs = 0
function fresh() {
  forgetHarnessIndex()
  return path.join(scratch, `cache-${++dirs}`)
}
const refresh = (cacheDir, fetchImpl, opts = {}) => refreshHarnessIndex({ cacheDir, fetchImpl, keys, minSerial: 1, now, ...opts })

test('an accepted list is cached and its rows are found; the next day it is asked again', async () => {
  const cacheDir = fresh()
  const bytes = indexBytes({ serial: 3 })
  const { fetchImpl, log } = server(published(bytes, sign(bytes)))
  assert.equal(await refresh(cacheDir, fetchImpl), 'accepted')
  assert.deepEqual(indexRows({ cacheDir, keys, minSerial: 1 }), [row('26.3')])
  assert.deepEqual(fs.readFileSync(path.join(cacheDir, 'harness-index.json')), bytes)
  const st = harnessIndexStatus({ cacheDir, keys, minSerial: 1 })
  assert.equal(st.source, 'index')
  assert.equal(st.serial, 3)
  assert.equal(st.key, 'primary')
  assert.equal(st.outcome, 'accepted')
  assert.deepEqual(st.ids, ['26.3'])

  // within the day: no network
  assert.equal(await refresh(cacheDir, fetchImpl), 'fresh')
  clock += 60 * 60000
  assert.equal(await refresh(cacheDir, fetchImpl), 'fresh')
  assert.equal(log.calls.length, 2)
  // a forced check within the minute of the last one does not ask either
  clock += 30000
  forgetHarnessIndex()
  indexRows({ cacheDir, keys, minSerial: 1 })
  assert.equal(await refresh(cacheDir, fetchImpl, { force: true }), 'unchanged')
  assert.equal(await refresh(cacheDir, fetchImpl, { force: true }), 'recently-tried')
  clock += 25 * 3600000
  assert.equal(await refresh(cacheDir, fetchImpl), 'unchanged')
  assert.equal(log.calls.length, 6)
})

test('a replayed or reused serial keeps the cached list', async () => {
  const cacheDir = fresh()
  const three = indexBytes({ serial: 3 })
  await refresh(cacheDir, server(published(three, sign(three))).fetchImpl)
  clock += 25 * 3600000

  const two = indexBytes({ serial: 2, rows: [row('26.4')] })
  assert.equal(await refresh(cacheDir, server(published(two, sign(two))).fetchImpl), 'harness-index-serial')
  assert.deepEqual(indexRows({ cacheDir, keys, minSerial: 1 }), [row('26.3')])
  assert.deepEqual(fs.readFileSync(path.join(cacheDir, 'harness-index.json')), three)

  clock += 2 * 3600000
  const again = indexBytes({ serial: 3, generated: '2026-10-30T00:00:00Z' })
  assert.equal(await refresh(cacheDir, server(published(again, sign(again))).fetchImpl), 'harness-index-serial')
  assert.match(harnessIndexStatus({ cacheDir, keys, minSerial: 1 }).reason, /published again with different content/)
  assert.deepEqual(indexRows({ cacheDir, keys, minSerial: 1 }), [row('26.3')])

  clock += 2 * 3600000
  const four = indexBytes({ serial: 4, rows: [row('26.3'), row('26.4')] })
  assert.equal(await refresh(cacheDir, server(published(four, sign(four, spare))).fetchImpl), 'accepted')
  assert.equal(harnessIndexStatus({ cacheDir, keys, minSerial: 1 }).key, 'spare')
  assert.equal(indexRows({ cacheDir, keys, minSerial: 1 }).length, 2)
})

test('oversized, unreachable and badly signed lists leave the cache alone and wait an hour', async () => {
  const cacheDir = fresh()
  const good = indexBytes({ serial: 2 })
  await refresh(cacheDir, server(published(good, sign(good))).fetchImpl)
  clock += 25 * 3600000

  const big = server({ [HARNESS_INDEX_URL]: { chunks: Array(10).fill(Buffer.alloc(8192)), headers: { 'content-length': '100' } }, [HARNESS_INDEX_SIG_URL]: { body: 'x' } })
  assert.equal(await refresh(cacheDir, big.fetchImpl), 'harness-index-oversized')
  assert.ok(big.log.pulled <= 64 * 1024 + 8192)
  assert.deepEqual(fs.readFileSync(path.join(cacheDir, 'harness-index.json')), good)
  assert.deepEqual(indexRows({ cacheDir, keys, minSerial: 1 }), [row('26.3')])
  // a failure is not asked again within the hour
  assert.equal(await refresh(cacheDir, big.fetchImpl), 'recently-failed')
  clock += 3600000 + 1

  const bigSig = server({ ...published(good, sign(good)), [HARNESS_INDEX_SIG_URL]: { body: Buffer.alloc(2048, 65) } })
  assert.equal(await refresh(cacheDir, bigSig.fetchImpl), 'harness-index-oversized')
  clock += 3600000 + 1

  assert.equal(await refresh(cacheDir, server({ [HARNESS_INDEX_URL]: { status: 404, body: 'Not Found' } }).fetchImpl), 'harness-index-unreachable')
  clock += 3600000 + 1
  assert.equal(await refresh(cacheDir, server({ [HARNESS_INDEX_URL]: { error: new Error('getaddrinfo ENOTFOUND github.com') } }).fetchImpl), 'harness-index-unreachable')
  assert.match(harnessIndexStatus({ cacheDir, keys, minSerial: 1 }).reason, /ENOTFOUND/)
  clock += 3600000 + 1

  const tampered = indexBytes({ serial: 9, rows: [row('26.3', { sha256: 'cd'.repeat(32) })] })
  assert.equal(await refresh(cacheDir, server(published(tampered, sign(good))).fetchImpl), 'harness-index-signature')
  assert.equal(indexRows({ cacheDir, keys, minSerial: 1 })[0].sha256, 'ab'.repeat(32))
  const st = harnessIndexStatus({ cacheDir, keys, minSerial: 1 })
  assert.equal(st.source, 'index')
  assert.equal(st.serial, 2)
})

test('a cached copy that no longer verifies is dropped on load, and the status says why', async () => {
  const cacheDir = fresh()
  const bytes = indexBytes({ serial: 2 })
  await refresh(cacheDir, server(published(bytes, sign(bytes))).fetchImpl)
  const file = path.join(cacheDir, 'harness-index.json')
  const edited = Buffer.from(bytes); edited[20] ^= 1
  fs.writeFileSync(file, edited)
  forgetHarnessIndex()
  assert.deepEqual(indexRows({ cacheDir, keys, minSerial: 1 }), [])
  assert.equal(fs.existsSync(file), false)
  const st = harnessIndexStatus({ cacheDir, keys, minSerial: 1 })
  assert.equal(st.source, 'built-in')
  assert.equal(st.outcome, 'harness-index-signature')
  assert.match(st.reason, /cached list was dropped/)

  // a floor raised above the cached serial (a newer build) drops it too
  const cacheDir2 = fresh()
  await refresh(cacheDir2, server(published(bytes, sign(bytes))).fetchImpl)
  forgetHarnessIndex()
  assert.equal(loadCachedHarnessIndex({ cacheDir: cacheDir2, keys, minSerial: 3 }), null)
  assert.equal(fs.existsSync(path.join(cacheDir2, 'harness-index.json')), false)
})

test('a list that revokes a key drops a cached copy that key signed, huge serial or not', async () => {
  const cacheDir = fresh()
  // what an attacker with the primary would publish
  const poisoned = indexBytes({ serial: Number.MAX_SAFE_INTEGER, rows: [row('26.3', { sha256: 'ee'.repeat(32) })] })
  await refresh(cacheDir, server(published(poisoned, sign(poisoned))).fetchImpl)
  assert.equal(indexRows({ cacheDir, keys, minSerial: 1 })[0].sha256, 'ee'.repeat(32))
  clock += 25 * 3600000

  // the recovery: signed with the spare at a lower serial, revoking the primary
  const recovery = indexBytes({ serial: 5, revoke: [primary.spki] })
  assert.equal(await refresh(cacheDir, server(published(recovery, sign(recovery, spare))).fetchImpl), 'accepted')
  assert.equal(indexRows({ cacheDir, keys, minSerial: 1 })[0].sha256, 'ab'.repeat(32))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'harness-revoked-keys.json'), 'utf8')), [primary.spki])

  // from now on the primary's lists are refused, on fetch and on load
  clock += 25 * 3600000
  const later = indexBytes({ serial: 6 })
  assert.equal(await refresh(cacheDir, server(published(later, sign(later))).fetchImpl), 'harness-index-signature')
  forgetHarnessIndex()
  assert.equal(indexRows({ cacheDir, keys, minSerial: 1 })[0].sha256, 'ab'.repeat(32))

  // a list cannot revoke the key that signed it, and a refused list revokes nothing
  const cacheDir2 = fresh()
  const selfRevoke = indexBytes({ serial: 2, revoke: [primary.spki] })
  assert.equal(await refresh(cacheDir2, server(published(selfRevoke, sign(selfRevoke))).fetchImpl), 'accepted')
  assert.equal(fs.existsSync(path.join(cacheDir2, 'harness-revoked-keys.json')), false)
  clock += 25 * 3600000
  const replay = indexBytes({ serial: 1, revoke: [spare.spki] })
  assert.equal(await refresh(cacheDir2, server(published(replay, sign(replay))).fetchImpl), 'harness-index-serial')
  assert.equal(fs.existsSync(path.join(cacheDir2, 'harness-revoked-keys.json')), false)
})

test('a cache folder that cannot be written is recorded, not thrown', async () => {
  const cacheDir = fresh()
  fs.writeFileSync(cacheDir, 'a file where the folder should be')
  const bytes = indexBytes({ serial: 2 })
  assert.equal(await refresh(cacheDir, server(published(bytes, sign(bytes))).fetchImpl), 'harness-index-store')
})

test('built-in rows win over the list, and the merged ids are listed once', () => {
  const cacheDir = path.join(scratch, 'data-cache')
  void cacheDir
  // the module's own cache folder (CLIENT_CACHE_DIR) is the scratch data root's
  const ids = publishedHarnessIds()
  assert.ok(ids.includes('1.21.11'))
  assert.equal(new Set(ids).size, ids.length)
})

test('the doctor line names the source, and a rejected list is a problem', () => {
  const t = Date.now() - 2 * 3600000
  assert.deepEqual(harnessListLine({ source: 'built-in', outcome: null }), { problem: false, text: `harness list: built-in only (${publishedHarnessIds().join(', ')}); the published list has not been checked yet` })
  const ok = harnessListLine({ source: 'index', serial: 3, generated: '2026-10-30T18:00:00Z', key: 'spare', fetchedAt: t, lastCheck: t, outcome: 'accepted' })
  assert.equal(ok.problem, false)
  assert.match(ok.text, /^harness list: serial 3 from 2026-10-30, signed with the spare key, fetched 2 h ago/)
  const bad = harnessListLine({ source: 'built-in', lastCheck: t, outcome: 'harness-index-signature', reason: 'the signature does not verify with any key this SpawnLoft trusts' })
  assert.equal(bad.problem, true)
  assert.match(bad.text, /rejected 2 h ago: the signature does not verify/)
  const offline = harnessListLine({ source: 'index', serial: 3, fetchedAt: t - 9 * 86400000, lastCheck: t, outcome: 'harness-index-unreachable', reason: 'could not reach the harness list: ENOTFOUND' })
  assert.equal(offline.problem, false)
  assert.match(offline.text, /fetched 9 days ago .*could not be read \(could not reach the harness list: ENOTFOUND\)/)
})

test('a list written and signed by the mod repo\'s sign-index script reads here', () => {
  const dir = new URL('./fixtures/client/harness-index/', import.meta.url)
  const bytes = fs.readFileSync(new URL('harness-index.json', dir))
  const sig = fs.readFileSync(new URL('harness-index.json.sig', dir), 'utf8')
  const spki = fs.readFileSync(new URL('test-public-key.txt', dir), 'utf8').trim()
  const got = parseHarnessIndex(bytes, sig, { keys: [{ name: 'primary', spki }], minSerial: 1 })
  assert.equal(got.serial, 1)
  assert.deepEqual(got.rows.map((r) => r.minecraft[0]), ['1.21.11', '26.3'])
  assert.equal(harnessJarUrl(got.rows[0]), harnessFor('1.21.11').url)
  assert.equal(got.rows[0].sha256, harnessFor('1.21.11').sha256)
})
