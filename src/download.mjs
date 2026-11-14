// Fetch a file into the jar store, hashed as it arrives. It gets its final name only once the hash
// matches; a truncated download would look like a jar and fail later with an opaque class-loading error.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { fail, humanBytes, UserError } from './util.mjs'
import { Cancelled, cancelSignal, checkCancelled } from './cancel.mjs'

const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

// timeouts, busy or restarting servers, rate limits: worth asking again
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// fetch, retried when a second request usually changes the answer (GitHub's download servers return
// stray 504s). Refusals like 403/404, and the last answer if every attempt was transient, are returned
// at once so the caller's message names the status. Only opening the response is retried; a download
// that breaks half way is the caller's to report. timeoutMs for the per-attempt limit, because a
// fired AbortSignal stays fired and each attempt needs its own; a signal in `init` is the caller's
// way to give up on the whole thing, and ends the retrying too.
export async function fetchRetry(url, init = {}, { attempts = 4, delayMs = 1500, timeoutMs = 0, fetcher = fetch, onRetry = null } = {}) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts
    let res
    try {
      res = await fetcher(url, timeoutMs ? { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) } : init)
    } catch (err) {
      // a cancelled job is not a server having a bad moment
      if (last || init.signal?.aborted) throw err
      onRetry?.({ attempt, reason: err.cause?.message || err.message })
      await wait(delayMs * attempt)
      init.signal?.throwIfAborted()
      continue
    }
    if (last || !TRANSIENT.has(res.status)) return res
    // An unread body holds its connection open.
    await res.body?.cancel().catch(() => {})
    onRetry?.({ attempt, reason: `HTTP ${res.status}` })
    await wait(delayMs * attempt)
    init.signal?.throwIfAborted()
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
// Where a download is written until it is whole. One name per attempt: two downloads of the same
// file (two setups on one Minecraft version, started together) each write their own, and one of
// them stopping or failing takes nothing from the other.
export function partPath(dest) {
  return `${dest}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.part`
}

/** Removes what a stopped download had written. Never the reason the caller hears about: a file
 *  Windows still holds for a moment is tried again, and then left. */
export function dropPart(tmp) {
  try { fs.rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* left behind; nothing reads a .part */ }
}

// How long a download may go without a byte, from asking to the last one, before it is given up
// and asked for again; and how many times one file is asked for. A connection that dies quietly
// (a sleeping laptop, a router dropping state) otherwise holds its caller for ever: there are
// thousands of files in a game install and one stuck one stops them all.
export const STALL_MS = 30000
const DOWNLOAD_ATTEMPTS = 3

export async function downloadFile(url, dest, { hash = null, expected = null, onProgress = null, minBytes = 0, label = null, stallMs = STALL_MS, attempts = DOWNLOAD_ATTEMPTS, retryDelayMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(url, dest, { hash, expected, onProgress, minBytes, label, stallMs })
    } catch (err) {
      // a stall or a connection cut part way is worth asking again; a refusal, a wrong checksum
      // and a cancelled job are not
      if (!err?.retryable || attempt >= attempts) throw err
      await wait(retryDelayMs * attempt)
      checkCancelled()
    }
  }
}

function retryable(message, code) {
  const err = new UserError(message)
  err.code = code
  err.retryable = true
  return err
}

async function downloadOnce(url, dest, { hash, expected, onProgress, minBytes, label, stallMs }) {
  const what = label ?? dest
  // the job this download is part of, if it is part of one that can be cancelled
  const cancel = cancelSignal()
  checkCancelled()
  // the watchdog: armed before the request, wound back by every chunk
  const stall = new AbortController()
  let timer = null
  const wind = () => {
    clearTimeout(timer)
    if (stallMs > 0) timer = setTimeout(() => stall.abort(new Error('stalled')), stallMs)
  }
  const signal = cancel ? AbortSignal.any([cancel, stall.signal]) : stall.signal
  const stalled = () => retryable(`download of ${what} failed: nothing arrived for ${Math.round(stallMs / 1000)} seconds`, 'download-failed')
  wind()
  let tmp = null
  try {
    let res
    try {
      res = await fetchRetry(url, { headers: { 'User-Agent': UA }, signal })
    } catch (err) {
      if (cancel?.aborted) throw new Cancelled()
      if (stall.signal.aborted) throw stalled()
      fail(`download of ${what} failed: ${err.cause?.message || err.message}`, 'download-failed')
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {})
      fail(`download of ${what} failed (${res.status}) from ${url}`, 'download-failed')
    }

    tmp = partPath(dest)
    const digest = hash ? crypto.createHash(hash) : null
    const source = Readable.fromWeb(res.body)
    let received = 0
    const total = Number(res.headers.get('content-length')) || 0
    source.on('data', (chunk) => {
      wind()
      digest?.update(chunk)
      received += chunk.length
      onProgress?.({ received, total })
    })
    try {
      await pipeline(source, fs.createWriteStream(tmp), { signal })
    } catch (err) {
      // stopped half way: the half is not left for a later download to trip on
      dropPart(tmp)
      if (cancel?.aborted) throw new Cancelled()
      if (stall.signal.aborted) throw stalled()
      // the disk's own errors (full, read-only) are not the network's to retry
      if (typeof err?.code === 'string' && /^E(NOSPC|ROFS|ACCES|PERM|DQUOT|IO)$/.test(err.code)) throw err
      throw retryable(`download of ${what} failed part way: ${err.cause?.message || err.message}`, 'download-failed')
    }
    clearTimeout(timer)

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
  } finally {
    clearTimeout(timer)
  }
}
