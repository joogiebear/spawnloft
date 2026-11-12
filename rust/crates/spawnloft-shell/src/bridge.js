// window.spawnloftDesktop for the panel's pages in the Tauri window (bridge.rs). The same names
// and shapes as Electron's preload.js, minus Electron's own updater calls (the panel's update
// section talks to the core instead). Top-level frames only; the Play page in a frame of the
// panel uses its parent's bridge.
;(() => {
  'use strict'
  if (window.top !== window || !/^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin)) return
  const call = (cmd, args) => {
    const ipc = window.__TAURI_INTERNALS__
    if (!ipc || typeof ipc.invoke !== 'function') return Promise.reject(new Error('the window bridge is not ready'))
    return ipc.invoke(cmd, args || {})
  }
  const text = (v) => (v === undefined || v === null ? null : String(v))
  const getJson = async (path, init) => {
    const res = await fetch(path, { cache: 'no-store', ...init })
    let body = null
    try { body = await res.json() } catch { /* not JSON */ }
    return { res, body }
  }
  const bridge = {
    isDesktop: true,
    shell: 'tauri',
    // resolves to an absolute path, or null if cancelled
    pickFolder: (title) => call('pick_folder', { title: text(title) }),
    // files only (world archives); null if cancelled
    pickFile: (title) => call('pick_file', { title: text(title) }),
    // { setting, zoom }: setting is 'auto' or the chosen factor, zoom the factor on screen now
    getZoom: () => call('get_zoom'),
    setZoom: (value) => call('set_zoom', { value: value === 'auto' ? 'auto' : Number(value) }),
    // https only
    openExternal: (url) => call('open_external', { url: String(url ?? '') }),
    openProfileFolder: (name) => call('open_profile_folder', { name: String(name ?? '') }),
    // the system browser; resolves at once with { ok, external: true }, the login stream says the rest
    openMicrosoftLogin: (url) => call('open_microsoft_login', { url: String(url ?? '') }),
    // the first-run wizard (src/setup.html at /setup), answered by the panel itself
    getSetup: async () => (await getJson('/api/setup')).body,
    checkJava: async () => (await getJson('/api/setup/java')).body,
    saveSetup: async (choice) => {
      const { res, body } = await getJson('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choice ?? {}),
      })
      if (!res.ok || !body) return { ok: false, error: (body && body.error) || 'SpawnLoft could not save these locations.' }
      // the core reads its locations once, at start: the window restarts it and opens the panel again
      if (body.ok) await call('restart_core')
      return body
    },
  }
  Object.defineProperty(window, 'spawnloftDesktop', { value: Object.freeze(bridge), writable: false, configurable: false })

  // Ctrl/Cmd with + = - _ 0 and the numpad: the interface size, remembered, for every window.
  // code as well as key: on AZERTY the unshifted 0 reports 'à', with NumLock off the numpad 0 reports 'Insert'
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    let step = null
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') step = 1
    else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') step = -1
    else if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') step = 0
    if (step === null) return
    e.preventDefault()
    call('zoom_key', { step }).catch(() => {})
  }, true)
})()
