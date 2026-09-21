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
    // Linux answers from /proc/<pid>/exe before the table is consulted, so the stale snapshot is
    // never in a position to contradict anything and is not read again.
    assert.equal(queries, process.platform === 'linux' ? 1 : 2)
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

test('on Linux the executable is read from /proc, which a program cannot rename', async () => {
  const { executableName } = await import('../src/util.mjs')
  const asked = []
  const link = target => (file) => { asked.push(file); return target }
  assert.equal(executableName(4321, link('/opt/spawnloft-cli/bin/node')), 'node')
  assert.deepEqual(asked, ['/proc/4321/exe'])
  // After an upgrade replaces the file, a daemon that is still running is still the same program.
  assert.equal(executableName(1, link('/opt/SpawnLoft/spawnloft-desktop (deleted)')), 'spawnloft-desktop')
  // Not truncated to fifteen bytes, unlike the name in the process table.
  assert.equal(executableName(1, link('/opt/SpawnLoft/spawnloft-desktop')), 'spawnloft-desktop')
  // Another user's process, or one that has gone: no answer, and the table is asked instead.
  assert.equal(executableName(1, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }), null)
})

test('this process is recognised whatever its runtime has named its main thread', { skip: process.platform !== 'linux' }, async () => {
  const { sameProcess, executableName } = await import('../src/util.mjs')
  const path = await import('node:path')
  // Node 23 and later call the main thread "MainThread", and that is what `ps` reports as the name.
  assert.equal(executableName(process.pid), path.basename(process.execPath))
  assert.equal(sameProcess(process.pid, path.basename(process.execPath)), true)
  assert.equal(sameProcess(process.pid, 'java'), false, 'and a different program is still a contradiction')
})
