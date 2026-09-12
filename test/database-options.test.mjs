import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-db-options-'))
process.env.MCCTL_DATA_ROOT = scratch
const ui = await import('../src/ui.mjs')
const registry = await import('../src/registry.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('new UI and API flows expose MySQL and Redis and refuse MariaDB before doing work', async () => {
  const { server, url } = await ui.serve({ port: 0, open: false })
  try {
    const engines = await (await fetch(`${url}api/databases/engines`)).json()
    assert.deepEqual(engines.map(e => e.id).sort(), ['garnet', 'mysql'])
    assert.deepEqual(engines.filter(e => e.default).map(e => e.id), ['mysql'])
    const versions = await fetch(`${url}api/databases/versions?engine=mariadb`)
    assert.equal(versions.status, 400)
    for (const route of ['databases', 'databases/external']) {
      const res = await fetch(`${url}api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'refused', engine: 'mariadb', version: '11.4.5' }) })
      assert.equal(res.status, 400)
    }
    assert.deepEqual(registry.listServices(), [])
  } finally { server.close() }
})

test('CLI rejects removed engines for new databases and version discovery', () => {
  const cli = fileURLToPath(new URL('../mcctl.mjs', import.meta.url))
  for (const args of [['versions'], ['add', 'refused'], ['connect', 'refused'], ['create', 'refused']]) {
    const result = spawnSync(process.execPath, [cli, 'db', ...args, '--engine', 'mariadb'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr + result.stdout, /Choose MySQL or Redis/)
  }
  assert.deepEqual(registry.listServices(), [])
})
