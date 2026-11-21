// Test only: points the core's downloads at local fakes, so a test can run the real CLI as a
// separate process (the parity rig, tools/parity/) without touching the network
// (rust/PLAN-CORE-PORT.md section 6.2, the one named exception to the Node freeze).
//
// SPAWNLOFT_TEST_ORIGINS is a JSON object from an origin to its replacement, e.g.
// {"https://fill.papermc.io":"http://127.0.0.1:41234"}. It counts only with NODE_ENV=test, so a
// stray variable in a user's environment changes nothing. While it is set, a request to any other
// origin that is not on this machine is refused rather than sent, so a test that forgot a host
// fails instead of quietly downloading. Redirects are followed here, one hop at a time, so a
// redirect cannot lead past the check either. The Rust core reads the same variable with the same rules
// in a `test-hooks` build only (spawnloft-lib test_origins.rs); test/fixtures/contracts/test-origins.json
// holds both to them.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

export const ORIGINS_ENV = 'SPAWNLOFT_TEST_ORIGINS'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function isLoopback(url) {
  return LOOPBACK.has(url.hostname)
}

// The map, or an Error saying why the variable cannot be used.
export function parseOrigins(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return new Error(`${ORIGINS_ENV} is not JSON: ${err.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error(`${ORIGINS_ENV} must be a JSON object`)
  const map = new Map()
  for (const [from, to] of Object.entries(raw)) {
    let f, t
    try {
      f = new URL(from)
      t = new URL(String(to))
    } catch {
      return new Error(`${ORIGINS_ENV}: ${from} -> ${to} is not a pair of origins`)
    }
    if (f.origin !== from || !/^https?:$/.test(f.protocol)) return new Error(`${ORIGINS_ENV}: ${from} is not an origin (scheme://host[:port], nothing after it)`)
    if (t.origin !== String(to) || !/^https?:$/.test(t.protocol)) return new Error(`${ORIGINS_ENV}: ${to} is not an origin (scheme://host[:port], nothing after it)`)
    if (!isLoopback(t)) return new Error(`${ORIGINS_ENV}: ${to} is not on this machine`)
    map.set(f.origin, t.origin)
  }
  return map
}

// The URL to fetch instead of `url`; throws for a request the variable refuses. Only the origin
// is replaced: what follows it is kept as written, so both cores give the same answer without
// either normalising the path.
export function rewriteUrl(url, map) {
  if (map instanceof Error) throw map
  const u = new URL(url)
  if (u.username || u.password) throw new Error(`${ORIGINS_ENV}: refusing a URL with credentials in it`)
  const to = map.get(u.origin)
  if (to) {
    const start = url.indexOf('//') + 2
    const cut = url.slice(start).search(/[/?#]/)
    const rest = cut === -1 ? '' : url.slice(start + cut)
    return to + (rest.startsWith('/') ? rest : '/' + rest)
  }
  if (isLoopback(u)) return url
  throw new Error(`${ORIGINS_ENV} has no fake for ${u.origin}; the request was not sent`)
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export function install(env = process.env) {
  if (env.NODE_ENV !== 'test' || !env[ORIGINS_ENV]) return false
  const map = parseOrigins(env[ORIGINS_ENV])
  const real = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null
    let url = rewriteUrl(req ? req.url : String(input instanceof URL ? input.href : input), map)
    if ((init.redirect ?? req?.redirect ?? 'follow') !== 'follow') return real(req ? new Request(url, req) : url, init)
    // fetch would follow a redirect itself, past this check: so each hop comes back here
    const fromReq = req ? { method: req.method, headers: req.headers, signal: req.signal, ...(req.body ? { body: req.body, duplex: 'half' } : {}) } : {}
    let opts = { ...fromReq, ...init, redirect: 'manual' }
    for (let hop = 0; hop <= 20; hop++) {
      const res = await real(url, opts)
      const location = res.headers.get('location')
      if (!REDIRECTS.has(res.status) || !location) return res
      await res.body?.cancel().catch(() => {})
      url = rewriteUrl(new URL(location, url).href, map)
      const method = (opts.method ?? 'GET').toUpperCase()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) opts = { ...opts, method: 'GET', body: undefined, duplex: undefined }
    }
    throw new Error('too many redirects')
  }
  return true
}

// SPAWNLOFT_TEST_SCHEDULER names a stand-in program for the system scheduler's tools (C6 of
// rust/PLAN-CORE-PORT.md): with NODE_ENV=test, every run of `schtasks`, `powershell`,
// `/bin/launchctl`, `systemctl` or `loginctl` runs `<stand-in> <tool> <args...>` instead, so the
// parity rig can create, list and remove scheduled tasks without touching the machine's own
// scheduler. The Rust core does the same in a `test-hooks` build only
// (spawnloft-lib test_origins.rs, `scheduler_command`).
export const SCHEDULER_ENV = 'SPAWNLOFT_TEST_SCHEDULER'
export const SCHEDULER_TOOLS = ['schtasks', 'powershell', '/bin/launchctl', 'systemctl', 'loginctl']

export function installScheduler(env = process.env) {
  if (env.NODE_ENV !== 'test' || !env[SCHEDULER_ENV]) return false
  const fake = env[SCHEDULER_ENV]
  const cp = createRequire(import.meta.url)('node:child_process')
  for (const name of ['spawnSync', 'spawn', 'execFile', 'execFileSync']) {
    const real = cp[name]
    cp[name] = function (file, args, ...rest) {
      if (!SCHEDULER_TOOLS.includes(file)) return real.call(this, file, args, ...rest)
      const list = Array.isArray(args) ? args : []
      const tail = Array.isArray(args) ? rest : [args, ...rest]
      return real.call(this, fake, [path.posix.basename(file), ...list], ...tail)
    }
  }
  // the ES module bindings (`import { spawnSync } from 'node:child_process'`) follow the change
  syncBuiltinESMExports()
  return true
}

install()
installScheduler()
