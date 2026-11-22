// payload-gate.mjs: the no-Node and the test-build wording checks of the release gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkNoNode, checkNoInternalStrings } from './payload-gate.mjs'

// a payload laid out as a 2.x package: the core, its forwarders, the licence
function payload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-gate-'))
  fs.mkdirSync(path.join(dir, 'resources', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'resources', 'bin', 'spawnloft-core.exe'), 'core bytes')
  fs.writeFileSync(path.join(dir, 'resources', 'bin', 'spawnloft.cmd'), '@echo off\r\n')
  fs.writeFileSync(path.join(dir, 'resources', 'LICENSE'), 'MIT')
  return dir
}

test('a package with the core alone passes', () => {
  assert.deepEqual(checkNoNode([payload()]), [])
})

test('a bundled Node, under either name, is refused', () => {
  for (const exe of [['runtime', 'node-24.0.0', 'node.exe'], ['runtime', 'node-24.0.0', 'bin', 'node'], ['bin', 'NODE.EXE']]) {
    const dir = payload()
    fs.mkdirSync(path.join(dir, 'resources', ...exe.slice(0, -1)), { recursive: true })
    fs.writeFileSync(path.join(dir, 'resources', ...exe), 'node bytes')
    assert.match(checkNoNode([dir]).join('\n'), /is a Node\.js binary/, exe.join('/'))
  }
})

test('any .mjs file of the Node core is refused', () => {
  const dir = payload()
  fs.mkdirSync(path.join(dir, 'resources', 'core', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'resources', 'core', 'mcctl.mjs'), '')
  fs.writeFileSync(path.join(dir, 'resources', 'core', 'src', 'ui.mjs'), '')
  const found = checkNoNode([dir])
  assert.equal(found.length, 2)
  for (const p of found) assert.match(p, /is a Node core \.mjs file/)
  // a single file given as a payload path counts too
  assert.match(checkNoNode([path.join(dir, 'resources', 'core', 'mcctl.mjs')]).join('\n'), /mcctl\.mjs is a Node core/)
})

test('the command-line package\'s bin/node link to the core passes; any other link is refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-cli-'))
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'spawnloft-core'), 'core bytes')
  fs.symlinkSync('spawnloft-core', path.join(dir, 'bin', 'node'))
  assert.deepEqual(checkNoNode([dir]), [])
  fs.rmSync(path.join(dir, 'bin', 'node'))
  fs.mkdirSync(path.join(dir, 'runtime', 'node-24.0.0', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'runtime', 'node-24.0.0', 'bin', 'node'), 'node bytes')
  fs.symlinkSync('../runtime/node-24.0.0/bin/node', path.join(dir, 'bin', 'node'))
  const found = checkNoNode([dir]).join('\n')
  assert.match(found, /bin\/node is a Node\.js binary/)
  assert.match(found, /runtime\/node-24\.0\.0\/bin\/node is a Node\.js binary/)
})

test('a missing payload path is a problem, not a pass', () => {
  assert.match(checkNoNode([path.join(os.tmpdir(), 'no-such-payload-gate-dir')]).join('\n'), /is missing/)
})

test('test-build wording is found in text and in binaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-strings-'))
  fs.writeFileSync(path.join(dir, 'ok.txt'), '// SPAWNLOFT_SPIKE_LOG is an env name, fine\n')
  assert.deepEqual(checkNoInternalStrings([dir]), [])
  fs.writeFileSync(path.join(dir, 'core.exe'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('<h1>SpawnLoft (internal spike)</h1>'), Buffer.from([0])]))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'help.txt'), 'Internal build: not for release.')
  const found = checkNoInternalStrings([dir]).join('\n')
  assert.match(found, /core\.exe contains test-build wording/)
  assert.match(found, /help\.txt contains test-build wording/)
})
