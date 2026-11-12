// Version stamping of Tauri builds (plan D4): the Node core's package.json a build ships carries
// the build's version, and the release gate refuses an installed copy whose cores disagree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { writeCorePackage, BUILD_VERSION_RE } = await import(pathToFileURL(path.join(HERE, '..', 'rust', 'crates', 'spawnloft-shell', 'installer', 'core-package.mjs')).href)
const { installedVersions } = await import(pathToFileURL(path.join(HERE, 'release-gate.mjs')).href)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))

test('the shipped core package.json carries the build version and nothing else changes', () => {
  const out = tmp()
  const repo = fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')
  const file = writeCorePackage('2.0.0-beta.9000', out)
  assert.equal(file, path.join(out, 'core-package.json'))
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(JSON.parse(text).version, '2.0.0-beta.9000')
  assert.deepEqual({ ...JSON.parse(text), version: null }, { ...JSON.parse(repo), version: null })
  assert.equal(text.split('\n').length, repo.split('\n').length, 'layout kept')
  // the repository copy is never touched
  assert.equal(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'), repo)
})

test('build versions: release, beta and internal only', () => {
  for (const v of ['2.0.0', '2.0.0-beta.1', '2.0.0-beta.9000', '2.0.0-internal.901', '2.0.0-internal.0']) assert.ok(BUILD_VERSION_RE.test(v), v)
  for (const v of ['', '2.0', 'v2.0.0', '2.0.0-rc.1', '2.0.0-beta', '2.0.0 ']) assert.ok(!BUILD_VERSION_RE.test(v), v)
  assert.throws(() => writeCorePackage('2.0', tmp()), /not a build version/)
})

// a fake installed copy; the fake core is a shell script, so this part is POSIX only
function fakeInstall({ mac = false, core = '2.0.0-beta.5', node = '2.0.0-beta.5' } = {}) {
  const root = tmp()
  const base = mac ? path.join(root, 'Contents', 'Resources', 'resources') : path.join(root, 'resources')
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(base, 'core'), { recursive: true })
  const bin = path.join(base, 'bin', 'spawnloft-core')
  fs.writeFileSync(bin, `#!/bin/sh\necho '{"name":"spawnloft-core","version":"${core}","commit":null,"target":"x"}'\n`)
  fs.chmodSync(bin, 0o755)
  fs.writeFileSync(path.join(base, 'core', 'package.json'), JSON.stringify({ name: 'spawnloft', version: node }))
  return root
}

const posix = { skip: process.platform === 'win32' && 'the fake core is a shell script' }

test('an installed copy reports both cores', posix, () => {
  for (const mac of [false, true]) {
    const found = installedVersions(fakeInstall({ mac }))
    assert.deepEqual(found.problems, [])
    assert.equal(found.core, '2.0.0-beta.5')
    assert.equal(found.node, '2.0.0-beta.5')
  }
})

test('an unstamped Node core or core binary is caught', posix, () => {
  const found = installedVersions(fakeInstall({ core: '2.0.0-internal.0', node: '1.6.0-beta.2' }))
  assert.equal(found.core, '2.0.0-internal.0')
  assert.equal(found.node, '1.6.0-beta.2')
})

test('a folder that is not an install is a problem, not a crash', () => {
  const found = installedVersions(tmp())
  assert.equal(found.core, undefined)
  assert.match(found.problems[0], /no resources folder/)
  const root = tmp()
  fs.mkdirSync(path.join(root, 'resources'))
  const half = installedVersions(root)
  assert.equal(half.problems.length, 2)
})

// CI tests on the Node that ships (plan D7): .node-version is what setup-node installs
test('.node-version is the pinned runtime', async () => {
  const { NODE_VERSION } = await import(pathToFileURL(path.join(HERE, 'build-cli-package.mjs')).href)
  assert.equal(fs.readFileSync(path.join(HERE, '..', '.node-version'), 'utf8').trim(), NODE_VERSION)
})

test('the Node pin check finds newer LTS releases and security releases in the line', async () => {
  const { compare } = await import(pathToFileURL(path.join(HERE, '..', 'tools', 'check-node-pin.mjs')).href)
  const rows = [
    { version: 'v27.0.0', lts: false, security: false, date: 'd' },
    { version: 'v26.1.0', lts: 'Lithium', security: false, date: 'd' },
    { version: 'v24.22.2', lts: 'Krypton', security: false, date: 'd' },
    { version: 'v24.22.1', lts: 'Krypton', security: true, date: 'd' },
    { version: 'v24.21.0', lts: 'Krypton', security: false, date: 'd' },
    { version: 'v24.9.0', lts: 'Krypton', security: true, date: 'd' },
  ]
  const r = compare('24.21.0', rows)
  assert.equal(r.pinnedIsLts, true)
  assert.equal(r.newest.version, '26.1.0')
  assert.equal(r.newestInLine.version, '24.22.2')
  assert.deepEqual(r.security, ['24.22.1'])
  const current = compare('26.1.0', rows)
  assert.equal(current.newest, null)
  assert.equal(current.newestInLine, null)
  assert.equal(compare('25.0.0', rows).pinnedIsLts, false)
})

test('the Node pin check prints the sha256 line of every pinned archive', async () => {
  const { pinnedSums } = await import(pathToFileURL(path.join(HERE, '..', 'tools', 'check-node-pin.mjs')).href)
  const { NODE_ARCHIVES } = await import(pathToFileURL(path.join(HERE, 'node-pin.mjs')).href)
  const archives = Object.keys(NODE_ARCHIVES)
  const text = [...archives, 'darwin-arm64.tar.gz', 'linux-x64.tar.gz'].map((a, i) => `${String(i).repeat(64)}  node-v1.2.3-${a}`).reverse().join('\n') + '\n'
  assert.equal(pinnedSums(text, '1.2.3', archives), archives.map((a, i) => `${String(i).repeat(64)}  node-v1.2.3-${a}`).join('\n'))
  assert.match(pinnedSums('', '1.2.3', ['win-x64.zip']), /no line for node-v1\.2\.3-win-x64\.zip/)
})
