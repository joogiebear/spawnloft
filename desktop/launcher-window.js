'use strict'

const fs = require('node:fs')

// The game launcher's window rules, kept out of main.js so they can be tested without Electron.
// Run: node --test launcher-window.test.js (or npm test, from desktop/)

const LAUNCHER_TITLE = 'SpawnLoft Launcher'
const LAUNCHER_BOUNDS = { width: 1180, height: 760 }

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

module.exports = { windowKind, openProfileFolder, LAUNCHER_TITLE, LAUNCHER_BOUNDS }
