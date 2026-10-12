import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { verifyArchive } from '../src/backup.mjs'

// The same resolution backup.mjs uses: System32's bsdtar by name, because a GNU tar found
// through PATH reads "C:\..." as a hostname.
const TAR = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

function makeArchive(members) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-verify-'))
  fs.mkdirSync(path.join(dir, 'plugins'))
  fs.writeFileSync(path.join(dir, 'plugins', 'Example.jar'), 'not really a jar')
  fs.mkdirSync(path.join(dir, 'world'))
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'nbt goes here')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\n')
  const file = path.join(dir, 'snap.tar.gz')
  execFileSync(TAR, ['-czf', file, ...members], { cwd: dir })
  return file
}

test('a whole archive verifies, with its entries counted', async () => {
  const file = makeArchive(['plugins', 'world', 'server.properties'])
  const res = await verifyArchive(file, ['plugins', 'world', 'server.properties'])
  assert.equal(res.ok, true, res.problems.join('; '))
  assert.ok(res.entries >= 5, `expected at least 5 entries, saw ${res.entries}`)
  assert.deepEqual(res.missing, [])
})

test('a member the manifest promises but the archive lacks is named', async () => {
  const file = makeArchive(['plugins'])
  const res = await verifyArchive(file, ['plugins', 'world_nether'])
  assert.equal(res.ok, false)
  assert.deepEqual(res.missing, ['world_nether'])
  assert.match(res.problems.join('\n'), /world_nether/)
})

test('a truncated archive fails as corrupt, not as missing members', async () => {
  const file = makeArchive(['plugins', 'world'])
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
  const res = await verifyArchive(file, ['plugins', 'world'])
  assert.equal(res.ok, false)
  assert.match(res.problems.join('\n'), /does not read back/)
  // The walk failed, so member absence is a consequence, not a finding.
  assert.deepEqual(res.missing, [])
})

test('a zero-byte archive is the finding, said plainly', async () => {
  const file = makeArchive(['plugins'])
  fs.writeFileSync(file, '')
  const res = await verifyArchive(file, ['plugins'])
  assert.equal(res.ok, false)
  assert.deepEqual(res.problems, ['the archive is zero bytes'])
})

test('a missing archive file is reported, not thrown', async () => {
  const res = await verifyArchive(path.join(os.tmpdir(), 'mcctl-never-existed.tar.gz'))
  assert.equal(res.ok, false)
  assert.deepEqual(res.problems, ['the archive file is missing'])
})

test('with no expected members, a readable archive passes on structure alone', async () => {
  const file = makeArchive(['server.properties'])
  const res = await verifyArchive(file)
  assert.equal(res.ok, true)
  assert.equal(res.entries, 1)
})
