// Test only: points the core's downloads at local fakes, so a test can run the real CLI as a
// separate process (the parity rig, tools/parity/) without touching the network
// (rust/PLAN-CORE-PORT.md section 6.2, the one named exception to the Node freeze).
//
// SPAWNLOFT_TEST_ORIGINS is a JSON object from an origin to its replacement, e.g.
// {"https://fill.papermc.io":"http://127.0.0.1:41234"}. It counts only with NODE_ENV=test, so a
// stray variable in a user's environment changes nothing. While it is set, a request to any other
// origin that is not on this machine is refused rather than sent, so a test that forgot a host
// fails instead of quietly downloading. The Rust core reads the same variable with the same rules
// in a `test-hooks` build only (spawnloft-lib test_origins.rs); test/fixtures/contracts/test-origins.json
// holds both to them.

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

export function install(env = process.env) {
  if (env.NODE_ENV !== 'test' || !env[ORIGINS_ENV]) return false
  const map = parseOrigins(env[ORIGINS_ENV])
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (input instanceof Request) return real(new Request(rewriteUrl(input.url, map), input), init)
    return real(rewriteUrl(String(input instanceof URL ? input.href : input), map), init)
  }
  return true
}

install()
