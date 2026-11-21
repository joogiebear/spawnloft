// SPAWNLOFT_TEST_ORIGINS (src/test-origins.mjs, rust/PLAN-CORE-PORT.md 6.2): the shared fixture's
// cases, that the variable counts only with NODE_ENV=test, and a real CLI process downloading
// from a fake host through it. The Rust side runs the same fixture under cargo test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseOrigins, rewriteUrl, install, ORIGINS_ENV } from '../src/test-origins.mjs'
import { startHosts } from '../tools/parity/lib/fake-host.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'contracts', 'test-origins.json'), 'utf8'))

test('every case of the shared fixture', () => {
  assert.equal(fixture.env, ORIGINS_ENV)
  for (const c of fixture.cases) {
    const map = parseOrigins(JSON.stringify(fixture.maps[c.map]))
    assert.ok(map instanceof Map, c.map)
    if (typeof c.expect === 'string') assert.equal(rewriteUrl(c.url, map), c.expect, c.url)
    else assert.throws(() => rewriteUrl(c.url, map), undefined, c.url)
  }
})

test('a bad map is refused whole, and nothing goes through it', () => {
  for (const text of fixture.badMaps) {
    const map = parseOrigins(text)
    assert.ok(map instanceof Error, text)
    assert.throws(() => rewriteUrl('http://127.0.0.1:1/x', map))
  }
})

test('the variable is ignored without NODE_ENV=test', () => {
  assert.equal(install({ [ORIGINS_ENV]: '{}' }), false)
  assert.equal(install({ NODE_ENV: 'production', [ORIGINS_ENV]: '{}' }), false)
  assert.equal(install({ NODE_ENV: 'test' }), false)
})

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'spawnloft.mjs'), ...args], { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('a spawned CLI downloads from the fake host, and is refused a host with no fake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-origins-'))
  const hosts = await startHosts({ 'https://fill.papermc.io': { routes: { 'GET /v3/projects/paper': { json: { versions: { '9.9': ['9.9.9'] } } } } } })
  const base = { ...process.env, MCCTL_DATA_ROOT: root, NODE_ENV: 'test' }
  delete base.SPAWNLOFT_DATA_ROOT
  try {
    const ok = await cli(['paper', 'versions'], { ...base, [ORIGINS_ENV]: hosts.env })
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /9\.9\.9/)
    assert.equal(hosts.take().length, 1)
    const refused = await cli(['paper', 'versions'], { ...base, [ORIGINS_ENV]: '{}' })
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /has no fake for https:\/\/fill\.papermc\.io; the request was not sent/)
    assert.deepEqual(hosts.take(), [])
  } finally {
    await hosts.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
