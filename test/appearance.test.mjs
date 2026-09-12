import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The actual settings and HTTP boundary are exercised, with every path redirected
// before importing the core. This must never change the developer's appearance.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-appearance-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const settings = await import('../src/settings.mjs')
const { normalizeTheme } = await import('../src/appearance.mjs')
const { serve } = await import('../src/ui.mjs')
const servers = []
after(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('appearance defaults safely and survives a new desktop panel origin', async () => {
  for (const value of [undefined, null, '', 'unknown', {}, '" onload="alert(1)']) {
    assert.equal(normalizeTheme(value), 'classic')
  }
  const first = await serve({ port: 0, open: false })
  servers.push(first.server)
  assert.match(await (await fetch(first.url)).text(), /<html lang="en" data-theme="classic">/)
  settings.save({ dataRoot: process.env.MCCTL_DATA_ROOT, backupsMirrorDir: 'preserve-this-path' })
  const post = value => fetch(first.url + 'api/appearance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  })
  const saved = await post({ theme: 'spawnloft', dataRoot: 'must-not-move-data' })
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { theme: 'spawnloft' })
  assert.equal(settings.load().dataRoot, process.env.MCCTL_DATA_ROOT)
  assert.equal(settings.load().backupsMirrorDir, 'preserve-this-path')

  for (const theme of ['unknown', null, false, {}, '" onload="alert(1)']) {
    const invalid = await post({ theme })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /Classic or SpawnLoft/)
    assert.equal(settings.load().theme, 'spawnloft')
  }
  const otherOrigin = await fetch(first.url + 'api/appearance', {
    method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'classic' }),
  })
  assert.equal(otherOrigin.status, 403)

  const second = await serve({ port: 0, open: false })
  servers.push(second.server)
  assert.notEqual(first.port, second.port)
  assert.match(await (await fetch(second.url)).text(), /<html lang="en" data-theme="spawnloft">/)
  assert.equal((await (await fetch(second.url + 'api/settings')).json()).theme, 'spawnloft')
  assert.deepEqual(await (await fetch(second.url + 'api/appearance')).json(), { theme: 'spawnloft' })

  assert.equal((await post({ theme: 'classic' })).status, 200)
  assert.match(await (await fetch(second.url)).text(), /<html lang="en" data-theme="classic">/)
  settings.save({ theme: 'unsupported-future-theme' })
  assert.match(await (await fetch(second.url)).text(), /<html lang="en" data-theme="classic">/)
})
