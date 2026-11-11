/**
 * entry.mjs: what the files the Node core writes to disk run (PLAN-2.0-REMAINING.md A5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cliCommand, entryBinary, windowsRun } from '../src/entry.mjs'
import { ROOT } from '../src/paths.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-entry-'))
const core = path.join(scratch, 'spawnloft-core.exe')
fs.writeFileSync(core, '')

test('SPAWNLOFT_ENTRY names the binary to run, with no script and no Electron switch', () => {
  const cli = cliCommand({ env: { SPAWNLOFT_ENTRY: core }, electron: true })
  assert.deepEqual(cli, { exe: core, args: [], env: {}, viaEntry: true })
  assert.deepEqual(windowsRun(cli, 'task run abc'), [`"${core}" task run abc`])
})

test('an entry that is relative, missing or a folder is ignored', () => {
  for (const value of ['spawnloft-core.exe', path.join(scratch, 'nope.exe'), scratch, '']) {
    assert.equal(entryBinary({ SPAWNLOFT_ENTRY: value }), null, value)
  }
})

test('without an entry: the running executable and mcctl.mjs, as before', () => {
  const node = cliCommand({ env: {}, execPath: '/usr/local/bin/node', electron: false })
  assert.deepEqual(node, { exe: '/usr/local/bin/node', args: [path.join(ROOT, 'mcctl.mjs')], env: {}, viaEntry: false })
  // a plain Node checkout keeps the bare `node` on Windows
  assert.deepEqual(windowsRun({ ...node, exe: 'C:\\Program Files\\nodejs\\node.exe' }, 'start s'), [`node "${path.join(ROOT, 'mcctl.mjs')}" start s`])

  const electron = cliCommand({ env: {}, execPath: 'C:\\SpawnLoft\\SpawnLoft.exe', electron: true })
  assert.deepEqual(windowsRun(electron, 'start s'), ['set ELECTRON_RUN_AS_NODE=1', `"C:\\SpawnLoft\\SpawnLoft.exe" "${path.join(ROOT, 'mcctl.mjs')}" start s`])
})

test('a bundled Node under an entry point is never shortened to a PATH lookup', () => {
  const cli = { exe: 'C:\\SpawnLoft\\resources\\runtime\\node-24.21.0\\node.exe', args: [], env: {}, viaEntry: true }
  assert.deepEqual(windowsRun(cli, 'mcp'), [`"${cli.exe}" mcp`])
})

test('a % in a path is doubled for the batch file', () => {
  const cli = { exe: 'C:\\Users\\a%b%\\spawnloft-core.exe', args: [], env: {}, viaEntry: true }
  assert.deepEqual(windowsRun(cli, 'task run x'), ['"C:\\Users\\a%%b%%\\spawnloft-core.exe" task run x'])
})
