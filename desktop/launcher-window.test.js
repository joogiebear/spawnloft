// The launcher window's rules, without Electron: which window.open URLs become windows, and the
// openProfileFolder refusals. Run: node --test launcher-window.test.js (or npm test, from desktop/)
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { windowKind, openProfileFolder, launcherBounds } = require('./launcher-window')
const windowState = require('./window-state')

const LOAD = 'http://127.0.0.1:51234/'

test('exactly /launcher opens the launcher window', () => {
  assert.equal(windowKind(LOAD + 'launcher', LOAD), 'launcher')
})

test('anything near /launcher is refused', () => {
  for (const url of [
    LOAD + 'launcher?x=1',
    LOAD + 'launcher#play',
    LOAD + 'launcherx',
    LOAD + 'launcher/',
    LOAD + 'Launcher',
    LOAD + '/launcher',
    LOAD + 'launcher.html',
    'http://127.0.0.1:51235/launcher',
    'http://localhost:51234/launcher',
    'https://example.com/launcher',
  ]) assert.equal(windowKind(url, LOAD), null, url)
})

test('console windows keep their rule', () => {
  assert.equal(windowKind(LOAD + '?console=survival', LOAD), 'console')
  assert.equal(windowKind(LOAD + '?console=a&x=1', LOAD), null)
  assert.equal(windowKind(LOAD + '?console=a#x', LOAD), null)
  assert.equal(windowKind(LOAD + '?console=', LOAD), null)
})

test('the setup wizard opens no launcher', () => {
  const setup = 'file:///app/setup.html?theme=classic'
  assert.equal(windowKind(setup + 'launcher', setup), null)
})

test('non-strings are refused', () => {
  assert.equal(windowKind(undefined, LOAD), null)
  assert.equal(windowKind({ toString: () => LOAD + 'launcher' }, LOAD), null)
  assert.equal(windowKind(LOAD + 'launcher', undefined), null)
})

test('the launcher opens at 1040x640 CSS pixels times the zoom, never under 640x520 of them', () => {
  const big = { x: 0, y: 0, width: 3840, height: 2100 }
  // [zoom, width, height, minWidth, minHeight]
  for (const [zoom, w, h, mw, mh] of [
    [1, 1040, 640, 640, 520],
    [0.9, 936, 576, 576, 468],
    [1.25, 1300, 800, 800, 650],
    [1.5, 1560, 960, 960, 780],
    [1.75, 1820, 1120, 1120, 910],
    [2, 2080, 1280, 1280, 1040],
  ]) assert.deepEqual(launcherBounds(zoom, big), { width: w, height: h, minWidth: mw, minHeight: mh }, String(zoom))
})

test('the launcher\'s size and minimum are clamped to the work area', () => {
  // 1366x768 less a taskbar, at a zoom someone chose by hand
  const area = { x: 0, y: 0, width: 1366, height: 728 }
  assert.deepEqual(launcherBounds(2, area), { width: 1366, height: 728, minWidth: 1280, minHeight: 728 })
  assert.deepEqual(launcherBounds(1.75, { width: 1000.6, height: 700.4 }), { width: 1000, height: 700, minWidth: 1000, minHeight: 700 })
})

test('a bad zoom or a missing work area falls back to 100% and no clamp', () => {
  const at100 = { width: 1040, height: 640, minWidth: 640, minHeight: 520 }
  for (const zoom of [undefined, NaN, 0, -1, 'big']) assert.deepEqual(launcherBounds(zoom, undefined), at100, String(zoom))
  assert.deepEqual(launcherBounds(1.5, { width: 0, height: 0 }), { width: 1560, height: 960, minWidth: 960, minHeight: 780 })
})

test('the launcher window remembers its size afterwards, held to its own minimum', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-launcher-ws-'))
  const file = path.join(tmp, 'launcher-window-state.json')
  const display = [{ x: 0, y: 0, width: 2560, height: 1392 }]
  const size = launcherBounds(1.25, display[0])
  const min = { width: size.minWidth, height: size.minHeight }
  assert.deepEqual(windowState.load(file, display, size, min), { width: 1300, height: 800, maximized: false })
  // a size the person dragged it to wins over the zoomed default
  fs.writeFileSync(file, JSON.stringify({ width: 1700, height: 900, x: 10, y: 10 }))
  assert.deepEqual(windowState.load(file, display, size, min), { width: 1700, height: 900, maximized: false, x: 10, y: 10 })
  // and a saved size under the minimum is raised to it: 640x520 CSS pixels at 125%
  fs.writeFileSync(file, JSON.stringify({ width: 400, height: 300, x: 10, y: 10 }))
  const s = windowState.load(file, display, size, min)
  assert.equal(s.width, 800)
  assert.equal(s.height, 650)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the panel window keeps its 900x600 minimum when no minimum is passed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-panel-ws-'))
  const file = path.join(tmp, 'window-state.json')
  fs.writeFileSync(file, JSON.stringify({ width: 400, height: 300 }))
  const s = windowState.load(file, [{ x: 0, y: 0, width: 2560, height: 1392 }])
  assert.equal(s.width, 900)
  assert.equal(s.height, 600)
  fs.rmSync(tmp, { recursive: true, force: true })
})

function folderDeps(overrides = {}) {
  const opened = []
  const deps = {
    getProfile: (name) => {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('invalid profile name')
      if (name !== 'survival') throw new Error('no profile')
      return { name }
    },
    profileDir: (name) => path.join('/data/client/profiles', name),
    isDirectory: () => true,
    openPath: async (dir) => { opened.push(dir); return '' },
    ...overrides,
  }
  return { deps, opened }
}

test('openProfileFolder opens a known profile\'s folder', async () => {
  const { deps, opened } = folderDeps()
  assert.deepEqual(await openProfileFolder('survival', deps), { ok: true })
  assert.deepEqual(opened, [path.join('/data/client/profiles', 'survival')])
})

test('openProfileFolder refuses a bad name, an unknown profile and a missing folder', async () => {
  for (const name of ['../..', '..', 'a/b', '', 'x'.repeat(40), 'nobody', null, undefined, 42, ['survival'], { name: 'survival' }]) {
    const { deps, opened } = folderDeps()
    assert.deepEqual(await openProfileFolder(name, deps), { ok: false }, String(name))
    assert.equal(opened.length, 0)
  }
  const { deps, opened } = folderDeps({ isDirectory: () => false })
  assert.deepEqual(await openProfileFolder('survival', deps), { ok: false })
  assert.equal(opened.length, 0)
})

test('openProfileFolder reports a failed open as ok:false, never the message or the path', async () => {
  const { deps } = folderDeps({ openPath: async () => 'Failed to open C:\\secret\\path' })
  assert.deepEqual(await openProfileFolder('survival', deps), { ok: false })
  const { deps: throwing } = folderDeps({ openPath: async () => { throw new Error('boom /data') } })
  assert.deepEqual(await openProfileFolder('survival', throwing), { ok: false })
})

test('openProfileFolder checks the real folder by default', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-launcher-pf-'))
  const { deps } = folderDeps({ profileDir: (name) => path.join(tmp, name) })
  delete deps.isDirectory
  assert.deepEqual(await openProfileFolder('survival', deps), { ok: false })
  fs.mkdirSync(path.join(tmp, 'survival'))
  assert.deepEqual(await openProfileFolder('survival', deps), { ok: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})
