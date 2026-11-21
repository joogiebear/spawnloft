// SPAWNLOFT_TEST_ORIGINS (src/test-origins.mjs, rust/PLAN-CORE-PORT.md 6.2): the shared fixture's
// cases, that the variable counts only with NODE_ENV=test, and a real CLI process downloading
// from a fake host through it. The Rust side runs the same fixture under cargo test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseOrigins, rewriteUrl, install, ORIGINS_ENV, installScheduler, SCHEDULER_ENV } from '../src/test-origins.mjs'
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

test('a redirect is followed one hop at a time, and one to a host with no fake is refused', async () => {
  // in a child, since install() replaces this process's fetch
  const script = `
    await import(${JSON.stringify(new URL('../src/test-origins.mjs', import.meta.url).href)})
    const http = await import('node:http')
    const seen = []
    const server = http.createServer((req, res) => {
      seen.push(req.url)
      if (req.url === '/hop') { res.writeHead(302, { location: '/ok' }); return res.end() }
      if (req.url === '/away') { res.writeHead(302, { location: 'https://example.invalid/x' }); return res.end() }
      res.end('ok')
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const base = 'http://127.0.0.1:' + server.address().port
    const hop = await (await fetch(base + '/hop')).text()
    let away
    try { await fetch(base + '/away'); away = 'sent' } catch (err) { away = err.message }
    server.close()
    console.log(JSON.stringify({ hop, away, seen }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, NODE_ENV: 'test', [ORIGINS_ENV]: '{}' }, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  const code = await new Promise(r => child.on('close', r))
  assert.equal(code, 0, stderr)
  const out = JSON.parse(stdout)
  assert.equal(out.hop, 'ok')
  assert.match(out.away, /has no fake for https:\/\/example\.invalid; the request was not sent/)
  assert.deepEqual(out.seen, ['/hop', '/ok', '/away'])
})

test('SPAWNLOFT_TEST_SCHEDULER runs the stand-in for the scheduler tools, with NODE_ENV=test only', async () => {
  assert.equal(installScheduler({ [SCHEDULER_ENV]: 'x' }), false)
  assert.equal(installScheduler({ NODE_ENV: 'test' }), false)
  // the stand-in is Node itself, and the tool's name a script beside it that prints its arguments
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sched-'))
  try {
    for (const tool of ['launchctl', 'systemctl']) fs.writeFileSync(path.join(dir, tool), `console.log(JSON.stringify([${JSON.stringify(tool)}, ...process.argv.slice(2)]))`)
    const script = `
      await import(${JSON.stringify(new URL('../src/test-origins.mjs', import.meta.url).href)})
      const { spawnSync, execFile } = await import('node:child_process')
      const a = spawnSync('/bin/launchctl', ['print', 'gui/1/x'], { encoding: 'utf8' }).stdout.trim()
      const b = await new Promise(r => execFile('systemctl', ['--user', 'show'], { encoding: 'utf8' }, (e, out) => r(out.trim())))
      const c = spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8' }).stdout.trim()
      console.log(JSON.stringify([a, b, c]))
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', [SCHEDULER_ENV]: process.execPath }, windowsHide: true })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout.trim().split('\n').pop()), [
      '["launchctl","print","gui/1/x"]',
      '["systemctl","--user","show"]',
      '1',
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
