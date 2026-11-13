// Signs a test's requests in to a panel it started. Import it after the test has pointed the
// config and data folders at its scratch space (a dynamic import, like the core's own), because
// the key it signs with is the one in that config folder:
//
//   const { panelFetch: fetch, authorization } = await import('./helpers/panel.mjs')
//
// Every request to a loopback address then carries a fresh `Authorization: SpawnLoft <token>`
// for that address's port, unless the test set the header itself (to test a bad one) or passed
// `anonymous: true` (to test none).
import { apiAuthorization } from '../../src/panel-auth.mjs'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

// the header value for the panel on `port`
export function authorization(port) {
  return apiAuthorization(Number(port))
}

export function panelFetch(input, init = {}) {
  const { anonymous = false, ...rest } = init
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const headers = new Headers(rest.headers ?? {})
  if (!anonymous && !headers.has('authorization') && LOOPBACK.has(url.hostname) && url.port) {
    headers.set('authorization', authorization(url.port))
  }
  return fetch(input, { ...rest, headers })
}
