import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

test('a snapshot from before launch cannot misidentify a reused PID as an orphan', async t => {
  const image = path.basename(process.execPath)
  const row = name => process.platform === 'win32' ? `"${name}","${process.pid}"` : `${process.pid} ${name}`
  let queries = 0
  const mock = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: row(++queries === 1 ? 'previous-owner' : image) }))
  syncBuiltinESMExports()
  try {
    const util = await import('../src/util.mjs?identity-cache-test')
    assert.equal(util.processImage(process.pid), 'previous-owner')
    await new Promise(resolve => setTimeout(resolve, 5))
    const startedAt = Date.now()
    assert.equal(util.sameProcess(process.pid, image, startedAt), true)
    assert.equal(queries, 2)
    assert.equal(util.sameProcess(process.pid, 'wrong-executable', 0), false)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})

test('a process name Linux has cut to fifteen bytes is still the process it was started as', async () => {
  const { sameImage } = await import('../src/util.mjs')
  // What ps says about the installed app, against what was recorded when the daemon started.
  assert.equal(sameImage('spawnloft-deskt', 'spawnloft-desktop', 'linux'), true)
  assert.equal(sameImage('java', 'java', 'linux'), true)
  assert.equal(sameImage('SpawnLoft.exe', 'spawnloft', 'win32'), true)
  // Fifteen bytes of something else is still something else.
  assert.equal(sameImage('chrome_crashpad', 'spawnloft-desktop', 'linux'), false)
  // A short name is a whole name: "spawn" is not spawnloft-desktop cut short.
  assert.equal(sameImage('spawn', 'spawnloft-desktop', 'linux'), false)
  // Only Linux truncates; elsewhere a prefix is a different program.
  assert.equal(sameImage('spawnloft-deskt', 'spawnloft-desktop', 'darwin'), false)
  assert.equal(sameImage('spawnloft-deskt', 'spawnloft-desktop', 'win32'), false)
})
