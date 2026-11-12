import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The first-run wizard's routes for the Tauri window (src/first-run.mjs, /setup and /api/setup in
// ui.mjs). Every location is redirected before the core is imported.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-first-run-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.LOCALAPPDATA = path.join(scratch, 'local')
process.env.XDG_DATA_HOME = path.join(scratch, 'local')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
// what the Tauri window sets for the core and so for this panel
process.env.SPAWNLOFT_SHELL = 'tauri'
fs.mkdirSync(process.env.MCCTL_DATA_ROOT, { recursive: true })
const settings = await import('../src/settings.mjs')
const firstRun = await import('../src/first-run.mjs')
const ui = await import('../src/ui.mjs')
const { server, url } = await ui.serve({ port: 0, open: false })
after(() => {
  server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

const origin = new URL(url).origin

test('the wizard is served with the saved theme and no frame may hold it', async () => {
  const res = await fetch(new URL('/setup', url))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const html = await res.text()
  assert.ok(html.includes('dataset.theme = "classic"'), 'the theme is filled in, not read from the query')
  assert.ok(html.includes('window.spawnloftDesktop'), 'it is the wizard')
})

test('GET /api/setup says what the wizard needs', async () => {
  const body = await (await fetch(new URL('/api/setup', url))).json()
  assert.equal(body.needed, firstRun.needsSetup())
  assert.equal(body.defaultDataRoot, settings.defaultDataRoot())
  assert.ok(body.current && body.current.dataRoot)
})

test('POST /api/setup checks, saves and reads back', async () => {
  const post = (payload) => fetch(new URL('/api/setup', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(payload),
  }).then((r) => r.json())
  assert.equal((await post({ dataRoot: 'relative/path' })).ok, false)
  assert.equal((await post({})).ok, false)
  assert.equal((await post({ dataRoot: path.join(scratch, 'root'), separate: true })).ok, false, 'separate needs a second folder')
  const root = path.join(scratch, 'chosen root')
  assert.deepEqual(await post({ dataRoot: root, separate: false }), { ok: true })
  assert.equal(settings.load().dataRoot, root)
  assert.equal(firstRun.needsSetup(), false)
})

test('another site cannot save locations', async () => {
  const res = await fetch(new URL('/api/setup', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ dataRoot: path.join(scratch, 'evil') }),
  })
  assert.equal(res.status, 403)
})

test('the Java check answers with where to get Java', async () => {
  const body = await (await fetch(new URL('/api/setup/java', url))).json()
  assert.ok(typeof body.downloadUrl === 'string' && body.downloadUrl.startsWith('https://'))
})

test('outside the window the wizard is not served and locations cannot be changed over HTTP', async () => {
  delete process.env.SPAWNLOFT_SHELL
  try {
    assert.equal((await fetch(new URL('/setup', url))).status, 404)
    const res = await fetch(new URL('/api/setup', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ dataRoot: path.join(scratch, 'browser') }),
    })
    assert.equal(res.status, 403)
    assert.notEqual(settings.load().dataRoot, path.join(scratch, 'browser'))
  } finally {
    process.env.SPAWNLOFT_SHELL = 'tauri'
  }
})
