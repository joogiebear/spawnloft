// The rig's HTTP replay (rust/PLAN-CORE-PORT.md section 6, layer 2, for C8). A `panel` step starts
// the side's panel (`spawnloft-core ui`), sends it a list of requests one after the other, and
// writes down what came back: the status, the headers a page or a script can see, and the body.
// That text is compared between the sides exactly as a command's output is.
//
// Requests are signed as a program with the install's key would sign them (panel-auth.mjs), unless
// a request says `"anonymous": true` or brings an `authorization` header of its own.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

const READY = 'SpawnLoft panel: '
const START_TIMEOUT_MS = 90000
const REQUEST_TIMEOUT_MS = 120000

// Headers that say how the bytes travelled, not what the panel answered: Node keeps connections
// and chunks what has no length, the Rust panel closes each one and always sends a length.
const HOP = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'])

// The install's key, where both cores keep it (settings.mjs configDir, paths::config_dir).
function keyFile(env) {
  const base = process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME
  return path.join(base, 'spawnloft', 'panel.key')
}

function apiToken(env, port) {
  const key = Buffer.from(fs.readFileSync(keyFile(env), 'utf8').trim(), 'base64url')
  const body = `v1.api.${port}.${Date.now()}.`
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`
}

// Starts `core <args>` and waits for the line every panel prints once it listens.
export function startPanel(core, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(core, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => fail(new Error(`the panel printed no address in ${START_TIMEOUT_MS} ms\n${out}${err}`)), START_TIMEOUT_MS)
    const fail = (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(e)
    }
    child.on('error', (e) => fail(new Error(`could not start the panel: ${e.message}`)))
    child.on('exit', (code) => fail(new Error(`the panel exited (${code}) before it listened\n${out}${err}`)))
    child.stderr.on('data', (c) => { err += c })
    child.stdin.on('error', () => {})
    child.stdout.on('data', (c) => {
      out += c
      const line = out.split(/\r?\n/).find((l) => l.startsWith(READY))
      if (!line || settled) return
      settled = true
      clearTimeout(timer)
      const port = Number(new URL(line.slice(READY.length).trim()).port)
      const stop = () => new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done()
        child.once('exit', () => done())
        // the window's form ends when its stdin does; the terminal's form is killed, as Ctrl+C would
        child.stdin.end()
        setTimeout(() => child.kill('SIGKILL'), args.includes('--exit-with-stdin') ? 3000 : 0).unref()
      })
      resolve({ port, stop, stderr: () => err })
    })
  })
}

function bodyOf(req, ctx) {
  if (req.json !== undefined) return { bytes: Buffer.from(JSON.stringify(req.json)), type: 'application/json' }
  if (req.text !== undefined) return { bytes: Buffer.from(req.text), type: req.type ?? 'text/plain' }
  if (req.base64 !== undefined) return { bytes: Buffer.from(req.base64, 'base64'), type: req.type ?? 'application/octet-stream' }
  if (req.file !== undefined) return { bytes: fs.readFileSync(path.resolve(ctx.run, req.file)), type: req.type ?? 'application/octet-stream' }
  return { bytes: null, type: null }
}

// One request; resolves to { status, headers, body } with the body as a Buffer. A request with
// `stream` reads an event stream until it has that many `data:` events (or `ms` passed), then
// hangs up, as a page that navigates away does.
function send(port, req, env, ctx) {
  const method = (req.method ?? (req.get ? 'GET' : req.post ? 'POST' : req.delete ? 'DELETE' : req.patch ? 'PATCH' : 'GET')).toUpperCase()
  const target = req.get ?? req.post ?? req.delete ?? req.patch ?? req.path
  const { bytes, type } = bodyOf(req, ctx)
  const headers = { host: `${req.host ?? '127.0.0.1'}:${port}` }
  if (type) headers['content-type'] = type
  if (bytes) headers['content-length'] = bytes.length
  if (!req.anonymous) headers.authorization = `SpawnLoft ${apiToken(env, port)}`
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (v === null) delete headers[k.toLowerCase()]
    else headers[k.toLowerCase()] = String(v).replaceAll('{port}', String(port))
  }
  return new Promise((resolve) => {
    const chunks = []
    let done = false
    const finish = (out) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(out)
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const answer = () => ({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      const want = req.stream
      let streamTimer = null
      if (want) streamTimer = setTimeout(() => { finish(answer()); r.destroy() }, want.ms ?? 5000)
      res.on('data', (c) => {
        chunks.push(c)
        if (!want) return
        const events = Buffer.concat(chunks).toString('utf8').split('\n\n').filter((e) => e.startsWith('data:')).length
        if (events >= (want.events ?? 1)) {
          clearTimeout(streamTimer)
          finish(answer())
          r.destroy()
        }
      })
      res.on('end', () => { clearTimeout(streamTimer); finish(answer()) })
      res.on('error', () => { clearTimeout(streamTimer); finish(answer()) })
    })
    const timer = setTimeout(() => { finish({ error: `no answer in ${REQUEST_TIMEOUT_MS} ms` }); r.destroy() }, req.timeoutMs ?? REQUEST_TIMEOUT_MS)
    r.on('error', (e) => finish({ error: e.message }))
    r.end(bytes ?? undefined)
  })
}

// What a request is called in the report, and in a difference.
export function requestLabel(req) {
  const method = (req.method ?? (req.get ? 'GET' : req.post ? 'POST' : req.delete ? 'DELETE' : req.patch ? 'PATCH' : 'GET')).toUpperCase()
  return `${method} ${req.get ?? req.post ?? req.delete ?? req.patch ?? req.path}`
}

// The answer as text. JSON is laid out one value per line in the order it came, so a key that
// moved shows as a difference; an event stream keeps its `data:` lines; anything that is not text
// is its size and digest. `body: "skip"` leaves a body out (a page, compared by its headers),
// `body: "sha256"` forces the digest.
function describe(req, res, port) {
  if (res.error) return `${requestLabel(req)}\n  failed: ${res.error}\n`
  const lines = [`${requestLabel(req)}`, `  ${res.status}`]
  for (const name of Object.keys(res.headers).sort()) {
    if (HOP.has(name)) continue
    for (const value of [].concat(res.headers[name])) lines.push(`  ${name}: ${value}`)
  }
  const type = String(res.headers['content-type'] ?? '')
  const text = res.body.toString('utf8')
  let body
  if (req.body === 'skip') body = `(${type || 'no type'}, not compared)`
  else if (req.body === 'sha256' || !/^(text\/|application\/(json|sql))/.test(type)) {
    body = res.body.length ? `${res.body.length} bytes, sha256 ${crypto.createHash('sha256').update(res.body).digest('hex')}` : '(empty)'
  } else if (type.startsWith('application/json')) {
    try { body = JSON.stringify(JSON.parse(text), null, 1) } catch { body = text }
  } else if (type.startsWith('text/event-stream')) {
    // the beat (": ping") is timing, not content
    body = text.split('\n\n').filter((e) => e.startsWith('data:')).map((e) => {
      const data = e.slice(5).trim()
      try { return `data: ${JSON.stringify(JSON.parse(data), null, 1)}` } catch { return `data: ${data}` }
    }).join('\n')
  } else body = text
  lines.push(body)
  // this run's port, wherever it shows (a cookie's name, a redirect address)
  // (not any run of the same digits: a size or a pid may hold them)
  const p = String(port)
  return lines.join('\n').replaceAll(`spawnloft_${p}`, 'spawnloft_<panel-port>').replaceAll(`:${p}`, ':<panel-port>') + '\n'
}

// Replays `requests` against a panel started with `args`. Returns the text to compare and any
// problem that is the rig's to report (the panel never listened).
export async function replay(core, args, requests, { cwd, env, ctx }) {
  let panel
  try {
    panel = await startPanel(core, args, { cwd, env })
    // A token made before the panel began is refused, and on Windows each Node process keeps its
    // own clock, a few milliseconds from the next one's: a first request sent at once could carry
    // a time from before the start it has just read about.
    if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 100))
  } catch (e) {
    return { text: '', problem: e.message }
  }
  const out = []
  // `keep: { name: regex }` keeps the first group a regex finds in an answer's body; a later
  // request's address reads it as `{name}` (a sign-in's state, which only the answer knows)
  const kept = {}
  const fill = (t) => (typeof t === 'string' ? t.replace(/\{(\w+)\}/g, (m, k) => kept[k] ?? m) : t)
  try {
    for (const raw of requests) {
      const req = { ...raw, ...Object.fromEntries(['get', 'post', 'delete', 'patch', 'path'].filter((k) => raw[k]).map((k) => [k, fill(raw[k])])) }
      if (req.waitMs) await new Promise((r) => setTimeout(r, req.waitMs))
      if (!(req.get || req.post || req.delete || req.patch || req.path)) continue
      const res = await send(panel.port, req, env, ctx)
      for (const [k, re] of Object.entries(req.keep ?? {})) {
        const m = new RegExp(re).exec(res.body?.toString('utf8') ?? '')
        if (m) kept[k] = m[1]
      }
      out.push(describe(raw, res, panel.port))
    }
  } finally {
    await panel.stop()
  }
  return { text: out.join('\n'), problem: null }
}
