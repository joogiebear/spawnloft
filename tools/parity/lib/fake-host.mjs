// The fake download hosts of a parity scenario: one loopback HTTP server per faked origin, each
// answering the routes the scenario lists and recording every request, so the rig can compare
// what each core asked for (method, path, query, user agent) as well as what it did with the
// answers. The cores reach these servers through SPAWNLOFT_TEST_ORIGINS (src/test-origins.mjs,
// spawnloft-lib test_origins.rs).
//
// A scenario's `hosts`:
//   { "https://fill.papermc.io": { "routes": { "GET /v3/projects/paper": { "json": {...} } } } }
// A route answers with one of `json`, `text`, `base64`, `bytes: {size, seed}` (deterministic
// filler, for a jar or an archive whose content does not matter) or `file` (relative to the
// scenario), plus optional `status`, `headers`, `redirect` (a path, or a URL on a faked origin)
// and `delayMs`. A route key may carry a query (`GET /x?y=1`); it is tried before the bare path.
// Strings in `json`, `text` and `headers` may name another route's body as `${sha1:<url>}`,
// `${sha256:<url>}`, `${sha512:<url>}`, `${md5:<url>}` or `${size:<url>}`, so a metadata answer can
// carry the checksum of the file it points at. A request no route answers gets a 404 and is
// recorded with `unmatched: true`.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function filler(size, seed) {
  const out = Buffer.alloc(size)
  let block = crypto.createHash('sha256').update(String(seed)).digest()
  for (let i = 0; i < size; i += block.length) {
    block.copy(out, i, 0, Math.min(block.length, size - i))
    block = crypto.createHash('sha256').update(block).digest()
  }
  return out
}

function rawBody(route, baseDir) {
  if (route.bytes) return filler(route.bytes.size, route.bytes.seed ?? '')
  if (route.base64 !== undefined) return Buffer.from(route.base64, 'base64')
  if (route.file !== undefined) return fs.readFileSync(path.resolve(baseDir, route.file))
  return null
}

const TOKEN = /\$\{(sha1|sha256|sha512|md5|size):([^}]+)\}/g

export async function startHosts(hosts = {}, { baseDir = '.' } = {}) {
  const origins = Object.keys(hosts)
  const servers = []
  const map = {}
  const log = []
  // listen first, so every replacement origin is known before redirects and tokens are worked out
  for (const origin of origins) {
    const server = http.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    servers.push(server)
    map[origin] = `http://127.0.0.1:${server.address().port}`
  }
  // bodies that are bytes as given, keyed by their public URL, for the checksum tokens
  const fixed = new Map()
  for (const origin of origins) {
    for (const [key, route] of Object.entries(hosts[origin].routes ?? {})) {
      const body = rawBody(route, baseDir)
      if (body) fixed.set(origin + key.split(' ')[1], body)
    }
  }
  const expand = (text) => text.replace(TOKEN, (_, kind, url) => {
    const body = fixed.get(url)
    if (!body) throw new Error(`fake host: \${${kind}:${url}} names no route with fixed bytes`)
    return kind === 'size' ? String(body.length) : crypto.createHash(kind).update(body).digest('hex')
  })
  const expandDeep = (v) => typeof v === 'string' ? expand(v)
    : Array.isArray(v) ? v.map(expandDeep)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)]))
        : v
  // a redirect to a faked origin must point at its fake: fetch follows it without asking us
  const toFake = (location, origin) => {
    for (const [from, to] of Object.entries(map)) if (location.startsWith(from)) return to + location.slice(from.length)
    return location.startsWith('/') ? map[origin] + location : location
  }
  origins.forEach((origin, i) => {
    const routes = hosts[origin].routes ?? {}
    servers[i].on('request', (req, res) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const pathname = req.url.split('?')[0]
        const route = routes[`${req.method} ${req.url}`] ?? routes[`${req.method} ${pathname}`]
        log.push({ origin, method: req.method, url: req.url, userAgent: req.headers['user-agent'] ?? null,
          accept: req.headers.accept ?? null, bodyBytes: Buffer.concat(chunks).length, ...(route ? {} : { unmatched: true }) })
        const send = () => {
          if (!route) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'not faked', origin, url: req.url }))
            return
          }
          const headers = expandDeep(route.headers ?? {})
          let body
          if (route.json !== undefined) {
            body = Buffer.from(JSON.stringify(expandDeep(route.json)))
            headers['content-type'] ??= 'application/json'
          } else if (route.text !== undefined) {
            body = Buffer.from(expand(route.text))
          } else {
            body = rawBody(route, baseDir) ?? Buffer.alloc(0)
          }
          if (route.redirect) headers.location = toFake(route.redirect, origin)
          headers['content-length'] = String(body.length)
          res.writeHead(route.status ?? (route.redirect ? 302 : 200), headers)
          res.end(req.method === 'HEAD' ? undefined : body)
        }
        if (route?.delayMs) setTimeout(send, route.delayMs)
        else send()
      })
    })
  })
  return {
    map,
    env: origins.length ? JSON.stringify(map) : null,
    // what was asked since the last take, and a fresh log for the next side
    take() { return log.splice(0) },
    async close() {
      await Promise.all(servers.map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r) })))
    },
  }
}
