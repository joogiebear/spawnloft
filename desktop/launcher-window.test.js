// The launcher window's rules, without Electron: which window.open URLs become windows, and the
// openProfileFolder refusals. Run: node --test launcher-window.test.js (or npm test, from desktop/)
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { windowKind, openProfileFolder } = require('./launcher-window')
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

test('the launcher window opens at its own size the first time and is never smaller than 900x600', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-launcher-ws-'))
  const file = path.join(tmp, 'launcher-window-state.json')
  const display = [{ x: 0, y: 0, width: 2560, height: 1392 }]
  assert.deepEqual(windowState.load(file, display, { width: 1180, height: 760 }), { width: 1180, height: 760, maximized: false })
  fs.writeFileSync(file, JSON.stringify({ width: 400, height: 300, x: 10, y: 10 }))
  const s = windowState.load(file, display, { width: 1180, height: 760 })
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
