'use strict'

const crypto = require('node:crypto')

// The launcher's Microsoft sign-in window (CLIENT.md, "Signing in from the launcher"). Microsoft's
// own page in a window with no preload, no Node and a throwaway in-memory session, so its cookies
// never outlive the window and nothing it loads can reach SpawnLoft. The pure checks are exported
// for the tests; open() is the only part that needs Electron.
// Run: node --test login-window.test.js (or npm test, from desktop/)

const CALLBACK_PATH = '/api/client/accounts/login/callback'

// Where the sign-in may take the top frame: Microsoft's sign-in, password, MFA, consent and
// account-picker pages hop between these. Subframes, scripts and images are not filtered: they
// come from msauth.net and other CDNs, and a request filter would blank the page.
const LOGIN_HOSTS = new Set(['login.microsoftonline.com', 'login.live.com', 'account.live.com', 'login.microsoft.com'])
const LOGIN_SUFFIXES = ['.microsoftonline.com', '.live.com', '.microsoft.com']

function parse(url) {
  if (typeof url !== 'string' || url.length > 8192) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// The panel's callback: exact scheme, host, port and path, any query.
function isCallback(url, port) {
  const u = typeof url === 'string' ? parse(url) : url
  return Boolean(u) && u.protocol === 'http:' && u.hostname === 'localhost' && u.port === String(port) &&
    u.pathname === CALLBACK_PATH && !u.username && !u.password
}

function isAllowedNavigation(url, port) {
  const u = parse(url)
  if (!u || u.username || u.password) return false
  if (isCallback(u, port)) return true
  if (u.protocol !== 'https:' || u.port !== '') return false
  return LOGIN_HOSTS.has(u.hostname) || LOGIN_SUFFIXES.some((s) => u.hostname.endsWith(s))
}

// The only URL the page may ask the main process to open: the panel's own authorize URL for this
// app, sending the code back to this panel. Everything else is refused before a window exists.
function isAuthorizeUrl(url, { authorizeUrl, clientId, port }) {
  const u = parse(url)
  if (!u || u.username || u.password || u.hash) return false
  if (u.origin + u.pathname !== authorizeUrl) return false
  const one = (key) => {
    const all = u.searchParams.getAll(key)
    return all.length === 1 ? all[0] : null
  }
  return one('client_id') === clientId &&
    one('response_type') === 'code' &&
    one('redirect_uri') === `http://localhost:${port}${CALLBACK_PATH}`
}

// The login window's position: centred on the window that asked (Electron keeps it on screen).
function centredOn(parent, width, height) {
  if (!parent) return {}
  return {
    x: Math.round(parent.x + (parent.width - width) / 2),
    y: Math.round(parent.y + Math.max(0, (parent.height - height) / 2)),
  }
}

// One login window at a time. A second call for the same URL focuses the open one; a call for a
// different URL is a new sign-in (the panel replaced the old record), so the old window closes.
let current = null

// Resolves when the window has closed, whether the sign-in reached the callback or the person
// closed it. The outcome itself reaches the launcher through the panel's login stream.
function open(url, { port, near = null, icon } = {}) {
  if (current && !current.win.isDestroyed()) {
    if (current.url === url) {
      if (current.win.isMinimized()) current.win.restore()
      current.win.focus()
      return current.closed
    }
    // destroy, not close: a beforeunload on Microsoft's page could refuse a close and leave two
    // windows, with the first call's promise never settling ('closed' still fires)
    current.win.destroy()
  }

  const { BrowserWindow, session, shell } = require('electron')
  // no "persist:" prefix: the session lives in memory, and its storage is cleared on close. A fresh
  // name each time (Electron keeps a small Session object per name until quit) so a replaced
  // window's clearStorageData cannot wipe the cookies of the sign-in that replaced it
  const partition = 'login-' + crypto.randomBytes(8).toString('hex')
  const ses = session.fromPartition(partition, { cache: false })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    width: 480,
    height: 720,
    ...centredOn(near && !near.isDestroyed() ? near.getBounds() : null, 480, 720),
    minWidth: 360,
    minHeight: 480,
    resizable: true,
    title: 'Sign in to Microsoft',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false,
    },
  })
  // Windows and Linux: no menu (and so no reload or devtools shortcuts); macOS keeps the app menu
  win.setMenu(null)
  // Microsoft's page titles would replace the window's name
  win.on('page-title-updated', (e) => e.preventDefault())

  const wc = win.webContents
  wc.setWindowOpenHandler(({ url: target }) => {
    if (typeof target === 'string' && target.startsWith('https://')) shell.openExternal(target)
    return { action: 'deny' }
  })
  // top frame only: will-navigate is the main frame's, will-redirect also fires for subframes
  wc.on('will-navigate', (e, target) => {
    if (!isAllowedNavigation(e.url ?? target, port)) e.preventDefault()
  })
  wc.on('will-redirect', (e, target, _inPlace, mainFrame) => {
    if ((e.isMainFrame ?? mainFrame) === false) return
    if (!isAllowedNavigation(e.url ?? target, port)) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
  // the panel has answered the callback (it holds the code now), so the window's job is over
  wc.on('did-navigate', (_e, target) => {
    if (isCallback(target, port)) win.close()
  })

  const record = { win, url, closed: null }
  record.closed = new Promise((resolve) => {
    win.on('closed', () => {
      if (current === record) current = null
      ses.clearStorageData().catch(() => {})
      resolve()
    })
  })
  current = record
  win.loadURL(url)
  return record.closed
}

module.exports = { open, isAllowedNavigation, isCallback, isAuthorizeUrl, centredOn, CALLBACK_PATH }
