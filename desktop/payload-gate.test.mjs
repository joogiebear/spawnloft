// payload-gate.mjs: the bundled Node and the test-build wording checks of the release gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkRuntime, checkNoInternalStrings } from './payload-gate.mjs'
import { NODE_VERSION, nodeArchive } from './node-pin.mjs'

function staged({ platform = 'win32', arch = 'x64', tweak = (r) => r, bytes = 'node bytes' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-gate-'))
  const pin = nodeArchive(platform, arch)
  const exe = path.join(dir, `node-${NODE_VERSION}`, pin.exe)
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, bytes)
  const record = tweak({
    node: NODE_VERSION,
    exe: `node-${NODE_VERSION}/${pin.exe}`,
    platform,
    arch,
    archive: pin.file,
    archiveSha256: pin.sha256,
    exeSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  })
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(record))
  return { dir, exe }
}

test('a runtime staged from the pins passes', () => {
  assert.deepEqual(checkRuntime(staged().dir, { run: false }), [])
})

test('another version, another archive hash or a changed exe is refused', () => {
  assert.match(checkRuntime(staged({ tweak: (r) => ({ ...r, node: '20.0.0' }) }).dir, { run: false }).join('\n'), /the pin .* is/)
  assert.match(checkRuntime(staged({ tweak: (r) => ({ ...r, archiveSha256: '0'.repeat(64) }) }).dir, { run: false }).join('\n'), /archive sha256/)
  const s = staged()
  fs.writeFileSync(s.exe, 'swapped')
  assert.match(checkRuntime(s.dir, { run: false }).join('\n'), /not the executable staged/)
})

test('macOS re-signs the exe, so its hash is not compared; an extra folder is refused', () => {
  const s = staged({ platform: 'darwin', arch: 'arm64' })
  fs.writeFileSync(s.exe, 're-signed')
  assert.deepEqual(checkRuntime(s.dir, { run: false }), [])
  fs.mkdirSync(path.join(s.dir, 'node-20.0.0'))
  assert.match(checkRuntime(s.dir, { run: false }).join('\n'), /unexpected node-20\.0\.0/)
})

test('test-build wording is found in text and in binaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-strings-'))
  fs.writeFileSync(path.join(dir, 'ok.mjs'), '// SPAWNLOFT_SPIKE_LOG is an env name, fine\n')
  assert.deepEqual(checkNoInternalStrings([dir]), [])
  fs.writeFileSync(path.join(dir, 'core.exe'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('<h1>SpawnLoft (internal spike)</h1>'), Buffer.from([0])]))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'help.txt'), 'Internal build: not for release.')
  const found = checkNoInternalStrings([dir]).join('\n')
  assert.match(found, /core\.exe contains test-build wording/)
  assert.match(found, /help\.txt contains test-build wording/)
})
