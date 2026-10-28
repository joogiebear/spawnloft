'use strict'

const fs = require('node:fs')

// The game launcher's window rules, kept out of main.js so they can be tested without Electron.
// Run: node --test launcher-window.test.js (or npm test, from desktop/)

const LAUNCHER_TITLE = 'SpawnLoft Launcher'
// In CSS pixels. The window is sized for the page at the zoom it will show at, so a 150% screen
// opens it at 1560x960 rather than a 1040x640 window holding a page drawn half again as large.
const LAUNCHER_CSS = { width: 1040, height: 640 }
const LAUNCHER_MIN_CSS = { width: 640, height: 520 }

// What a window.open from a panel page is allowed to become. Exact matches only: `/launcher?x=1`,
// `/launcher#play` and `/launcherx` are refused like any other URL, so a page cannot smuggle a
// query into the one window it may open. The setup wizard (a file: URL) opens nothing.
function windowKind(url, loadUrl) {
  if (typeof url !== 'string' || typeof loadUrl !== 'string' || !url.startsWith(loadUrl)) return null
  const rest = url.slice(loadUrl.length)
  if (rest === 'launcher' && loadUrl.startsWith('http://')) return 'launcher'
  if (/^\?console=[^&#]+$/.test(rest)) return 'console'
  return null
}

// The launcher's first size and its minimum, in window pixels, for a page at `zoom` on a display
// whose work area is `area`. Neither is ever bigger than the work area: a short screen at a large
// zoom gets a window that fits rather than one that runs under the taskbar.
function launcherBounds(zoom, area) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const maxW = Number(area?.width) > 0 ? Math.floor(area.width) : Infinity
  const maxH = Number(area?.height) > 0 ? Math.floor(area.height) : Infinity
  const minWidth = Math.min(Math.round(LAUNCHER_MIN_CSS.width * z), maxW)
  const minHeight = Math.min(Math.round(LAUNCHER_MIN_CSS.height * z), maxH)
  return {
    width: Math.min(Math.round(LAUNCHER_CSS.width * z), maxW),
    height: Math.min(Math.round(LAUNCHER_CSS.height * z), maxH),
    minWidth,
    minHeight,
  }
}

// The panel already validates profile names, but this is a call from a page into the main process,
// so it checks again: the name through the core's own rule (getProfile throws on a bad name or an
// unknown profile), the folder through the core's path helper, and it must exist as a folder. The
// page learns only ok or not; never a path, never an error message.
function openProfileFolder(name, { getProfile, profileDir, openPath, isDirectory = isDir }) {
  if (typeof name !== 'string' || !name) return Promise.resolve({ ok: false })
  let dir
  try {
    getProfile(name)
    dir = profileDir(name)
  } catch {
    return Promise.resolve({ ok: false })
  }
  if (!isDirectory(dir)) return Promise.resolve({ ok: false })
  // openPath resolves to '' on success and to an error message otherwise
  return Promise.resolve(openPath(dir)).then((err) => ({ ok: err === '' }), () => ({ ok: false }))
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

module.exports = { windowKind, openProfileFolder, launcherBounds, LAUNCHER_TITLE, LAUNCHER_CSS, LAUNCHER_MIN_CSS }
