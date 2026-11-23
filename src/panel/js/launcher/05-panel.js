'use strict';
  // ---- the panel -----------------------------------------------------------------------------

  class PanelDown extends Error {}

  async function api(route, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetch('/api/' + route, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new PanelDown('the SpawnLoft panel is not answering')
    }
    let data = null
    try { data = await res.json() } catch { /* an empty or non-JSON answer */ }
    if (!res.ok) {
      const err = new Error(data?.error ? plain(data.error) : plainStatus(res.status))
      err.status = res.status
      throw err
    }
    return data
  }

  const enc = encodeURIComponent

  function newId() {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    return 'launch-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  function stored(kind, key, value) {
    const box = kind === 'session' ? 'sessionStorage' : 'localStorage'
    try {
      if (value === undefined) return window[box].getItem(key)
      if (value === null) window[box].removeItem(key)
      else window[box].setItem(key, value)
    } catch { /* storage off: the page works, it just forgets */ }
    return null
  }

