// Version stamping of Tauri builds (plan D4): a build is versioned only as a release, beta or
// internal build, and the release gate refuses an installed copy whose core reports another
// version, or that still carries Node (rust/PLAN-CORE-PORT.md 5.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { BUILD_VERSION_RE, checkBuildVersion } = await import(pathToFileURL(path.join(HERE, '..', 'rust', 'crates', 'spawnloft-shell', 'installer', 'build-version.mjs')).href)
const { installedVersions } = await import(pathToFileURL(path.join(HERE, 'release-gate.mjs')).href)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))

test('build versions: release, beta and internal only', () => {
  for (const v of ['2.0.0', '2.0.0-beta.1', '2.0.0-beta.9000', '2.0.0-internal.901', '2.0.0-internal.0']) assert.ok(BUILD_VERSION_RE.test(v), v)
  for (const v of ['', '2.0', 'v2.0.0', '2.0.0-rc.1', '2.0.0-beta', '2.0.0 ']) assert.ok(!BUILD_VERSION_RE.test(v), v)
  assert.equal(checkBuildVersion('2.0.0-beta.3'), '2.0.0-beta.3')
  assert.throws(() => checkBuildVersion('2.0'), /not a build version/)
  assert.throws(() => checkBuildVersion(undefined), /not a build version/)
})

// a fake installed copy; the fake core is a shell script, so this part is POSIX only
function fakeInstall({ mac = false, core = '2.0.0-beta.5', testHooks = false } = {}) {
  const root = tmp()
  const base = mac ? path.join(root, 'Contents', 'Resources', 'resources') : path.join(root, 'resources')
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true })
  const bin = path.join(base, 'bin', 'spawnloft-core')
  const hooks = testHooks ? ',"testHooks":"spawnloft-test-hooks:on"' : ''
  fs.writeFileSync(bin, `#!/bin/sh\necho '{"name":"spawnloft-core","version":"${core}","commit":null,"target":"x"${hooks}}'\n`)
  fs.chmodSync(bin, 0o755)
  fs.writeFileSync(path.join(base, 'LICENSE'), 'MIT')
  return { root, base }
}

const posix = { skip: process.platform === 'win32' && 'the fake core is a shell script' }

test('an installed copy reports its core\'s version', posix, () => {
  for (const mac of [false, true]) {
    const found = installedVersions(fakeInstall({ mac }).root)
    assert.deepEqual(found.problems, [])
    assert.equal(found.core, '2.0.0-beta.5')
    assert.equal('node' in found, false, 'there is no Node core to ask')
  }
})

test('an unstamped core binary is reported as it is', posix, () => {
  const found = installedVersions(fakeInstall({ core: '2.0.0-internal.0' }).root)
  assert.equal(found.core, '2.0.0-internal.0')
  assert.deepEqual(found.problems, [])
})

test('a test-hooks core is refused', posix, () => {
  assert.match(installedVersions(fakeInstall({ testHooks: true }).root).problems.join('\n'), /test-hooks build/)
})

test('an installed copy that still carries Node or its core is refused', posix, () => {
  const { root, base } = fakeInstall()
  fs.mkdirSync(path.join(base, 'runtime', 'node-24.0.0'), { recursive: true })
  fs.writeFileSync(path.join(base, 'runtime', 'node-24.0.0', 'node.exe'), 'node bytes')
  fs.mkdirSync(path.join(base, 'core'))
  fs.writeFileSync(path.join(base, 'core', 'mcctl.mjs'), '')
  const problems = installedVersions(root).problems.join('\n')
  assert.match(problems, /node\.exe is a Node\.js binary/)
  assert.match(problems, /mcctl\.mjs is a Node core \.mjs file/)
})

test('a folder that is not an install is a problem, not a crash', () => {
  const found = installedVersions(tmp())
  assert.equal(found.core, undefined)
  assert.match(found.problems[0], /no resources folder/)
  const root = tmp()
  fs.mkdirSync(path.join(root, 'resources'))
  const half = installedVersions(root)
  assert.equal(half.problems.length, 1)
  assert.match(half.problems[0], /no bin\/spawnloft-core/)
})
