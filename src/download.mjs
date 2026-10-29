// Fetch a file into the jar store, hashed as it arrives. It gets its final name only once the hash
// matches; a truncated download would look like a jar and fail later with an opaque class-loading error.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { fail, humanBytes } from './util.mjs'

const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

// timeouts, busy or restarting servers, rate limits: worth asking again
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// fetch, retried when a second request usually changes the answer (GitHub's download servers return
// stray 504s). Refusals like 403/404, and the last answer if every attempt was transient, are returned
// at once so the caller's message names the status. Only opening the response is retried; a download
// that breaks half way is the caller's to report. timeoutMs instead of a signal because a fired
// AbortSignal stays fired and each attempt needs its own.
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

// A small file read into memory, for bytes that are checked before anything trusts them (the
// signed harness list). The body is counted as it arrives and the request is aborted the moment it
// passes maxBytes, whatever Content-Length said; one deadline covers each attempt, body included,
// so a server that sends a byte a second cannot hold the caller. Two attempts, for GitHub's stray
// 504s. Fails with code 'too-large' or 'download-failed'.
export async function fetchCapped(url, { maxBytes, timeoutMs = 10000, attempts = 2, delayMs = 1500, fetcher = fetch, label = url } = {}) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs)
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    aborted.catch(() => {})
    try {
      let res
      try {
        res = await Promise.race([fetcher(url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream, */*' }, signal: controller.signal }), aborted])
      } catch (err) {
        if (last) fail(`could not reach ${label}: ${err.cause?.message || err.message}`, 'download-failed')
        await wait(delayMs * attempt)
        continue
      }
      if (!res.ok || !res.body) {
        controller.abort(new Error('unwanted body'))
        if (last || !TRANSIENT.has(res.status)) fail(`${label} answered ${res.status}`, 'download-failed')
        await wait(delayMs * attempt)
        continue
      }
      const chunks = []
      let size = 0
      const reader = res.body[Symbol.asyncIterator]()
      try {
        for (;;) {
          const { value, done } = await Promise.race([reader.next(), aborted])
          if (done) break
          size += value.length
          if (size > maxBytes) {
            controller.abort(new Error('too large'))
            fail(`${label} is larger than ${humanBytes(maxBytes)}`, 'too-large')
          }
          chunks.push(Buffer.from(value))
        }
      } catch (err) {
        if (err.code === 'too-large') throw err
        fail(`could not read ${label}: ${err.cause?.message || err.message}`, 'download-failed')
      } finally {
        reader.return?.().catch?.(() => {})
      }
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timer)
    }
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

// hash names the algorithm and expected the publisher's digest, both optional. A source that
// publishes none gets TLS plus a size floor.
export async function downloadFile(url, dest, { hash = null, expected = null, onProgress = null, minBytes = 0, label = null } = {}) {
  const what = label ?? dest
  let res
  try {
    res = await fetchRetry(url, { headers: { 'User-Agent': UA } })
  } catch (err) {
    fail(`download of ${what} failed: ${err.cause?.message || err.message}`, 'download-failed')
  }
  if (!res.ok || !res.body) fail(`download of ${what} failed (${res.status}) from ${url}`, 'download-failed')

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
      fail(`checksum mismatch for ${what}\n  expected ${expected}\n  got      ${got}`, 'checksum-mismatch')
    }
  }
  fs.renameSync(tmp, dest)
  return { size, sizeHuman: humanBytes(size) }
}
