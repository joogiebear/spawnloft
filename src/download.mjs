/**
 * Fetch a file into the jar store, hashed as it arrives, and only named once the hash matches.
 *
 * <p>The checksum is not ceremony: a truncated download produces a jar that unzips far enough
 * to look plausible and then fails at runtime with a class-loading error that says nothing about
 * the real cause. A .part file is what an interrupted or corrupt download leaves, never a jar
 * that looks stored and is not.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { fail, humanBytes } from './util.mjs'

const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

/** A gateway that timed out, a server that is busy or restarting, a rate limit: worth asking again. */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `fetch`, asked again when the answer is one that a second request usually changes.
 *
 * <p>GitHub's download servers answered 504 to three separate engine downloads on one release
 * day. Each was a single bad response, and each failed an install that the next request would
 * have completed. A refusal that means something - 403, 404 - is returned at once, as is the last
 * answer when every attempt was transient, so the caller's own message still names the status.
 *
 * <p>Only opening the response is retried. A download that breaks half way is the caller's to
 * report: its bytes are already being hashed and written.
 *
 * <p>`timeoutMs` rather than a signal, because an AbortSignal that has fired stays fired and each
 * attempt needs its own.
 */
export async function fetchRetry(url, init = {}, { attempts = 4, delayMs = 1500, timeoutMs = 0, fetcher = fetch, onRetry = null } = {}) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts
    let res
    try {
      res = await fetcher(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init)
    } catch (err) {
      if (last) throw err
      onRetry?.({ attempt, reason: err.cause?.message || err.message })
      await wait(delayMs * attempt)
      continue
    }
    if (last || !TRANSIENT.has(res.status)) return res
    // An unread body holds its connection open.
    await res.body?.cancel().catch(() => {})
    onRetry?.({ attempt, reason: `HTTP ${res.status}` })
    await wait(delayMs * attempt)
  }
}

export async function fetchJson(url, { label = url } = {}) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    fail(`could not reach ${label}: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) fail(`${label} answered ${res.status}`)
  return res.json()
}

/**
 * Download `url` to `dest`. `hash` names the algorithm and `expected` the digest the publisher
 * gave, both optional - a source that publishes none is downloaded over TLS with a size floor,
 * which is all that can be had. Progress reports the bytes that actually arrived.
 */
export async function downloadFile(url, dest, { hash = null, expected = null, onProgress = null, minBytes = 0, label = null } = {}) {
  const what = label ?? dest
  let res
  try {
    res = await fetchRetry(url, { headers: { 'User-Agent': UA } })
  } catch (err) {
    fail(`download of ${what} failed: ${err.cause?.message || err.message}`)
  }
  if (!res.ok || !res.body) fail(`download of ${what} failed (${res.status}) from ${url}`)

  const tmp = `${dest}.part`
  const digest = hash ? crypto.createHash(hash) : null
  const source = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || 0
  source.on('data', (chunk) => {
    digest?.update(chunk)
    received += chunk.length
    onProgress?.({ received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))

  const size = fs.statSync(tmp).size
  if (size < minBytes) {
    fs.rmSync(tmp, { force: true })
    fail(`${what} came back ${humanBytes(size)}, which is not a server jar`)
  }
  if (digest && expected) {
    const got = digest.digest('hex')
    if (got.toLowerCase() !== String(expected).toLowerCase()) {
      fs.rmSync(tmp, { force: true })
      fail(`checksum mismatch for ${what}\n  expected ${expected}\n  got      ${got}`)
    }
  }
  fs.renameSync(tmp, dest)
  return { size, sizeHuman: humanBytes(size) }
}
