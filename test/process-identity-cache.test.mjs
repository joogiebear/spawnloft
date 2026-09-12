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
