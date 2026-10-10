import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'

// The child is scripted, so the order of events is exactly the one under test rather than a race
// the machine happens to win: a process that has exited while its output is still in the pipe.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-runtofile-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { runToFile } = await import('../src/mariadb.mjs')
const { UserError } = await import('../src/util.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function fakeChild(t, { withStdin = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  if (withStdin) child.stdin = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true }
  t.mock.method(childProcess, 'spawn', () => child)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return child
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const file = (name) => path.join(scratch, name)

test('a dump is not finished until the process has closed, even if it exited first', async (t) => {
  const child = fakeChild(t)
  const dest = file('dump.sql')
  const out = fs.createWriteStream(dest)
  let settled = false
  const running = runToFile('tool', [], {}, { stdout: out, label: 'dump tool' }).then(() => { settled = true })

  child.stdout.write('-- first half of the dump\n')
  await tick()
  child.emit('exit', 0, null) // the process is gone; the rest of what it wrote is still in the pipe
  await tick()
  assert.equal(settled, false, 'declared finished on exit, with output still to come')

  child.stdout.write('-- second half of the dump\n')
  child.stdout.end()
  child.emit('close', 0, null)
  await running
  await new Promise((resolve) => out.end(resolve))

  assert.equal(fs.readFileSync(dest, 'utf8'), '-- first half of the dump\n-- second half of the dump\n')
})

test('the reason a tool failed is read from its error output in full, not as far as it had got at exit', async (t) => {
  const child = fakeChild(t)
  const running = runToFile('tool', [], {}, { stdout: fs.createWriteStream(file('refused.sql')), label: 'dump tool' })
  child.emit('exit', 2, null)
  await tick()
  child.stderr.write("mariadb-dump: Got error: 1045: Access denied for user 'root'\n")
  child.stdout.end()
  child.emit('close', 2, null)
  await assert.rejects(running, /MariaDB dump tool exited 2: mariadb-dump: Got error: 1045: Access denied/)
})

test('a client that exits while its input is still being fed does not take the process down', async (t) => {
  const child = fakeChild(t, { withStdin: true })
  const input = new PassThrough()
  const running = runToFile('client', [], {}, { stdin: input, label: 'client' })

  input.write('INSERT INTO t VALUES (1);\n')
  await tick()
  // What writing to a client that has already refused the login looks like.
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  child.stderr.write('ERROR 1045 (28000): Access denied for user root\n')
  child.emit('close', 1, null)

  await assert.rejects(running, /MariaDB client exited 1: ERROR 1045/)
})

test('an input file that cannot be read stops the tool and says why', async (t) => {
  const child = fakeChild(t, { withStdin: true })
  const input = new PassThrough()
  const running = runToFile('client', [], {}, { stdin: input, label: 'client' })
  input.emit('error', Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
  await assert.rejects(running, (err) => err instanceof UserError && /could not read the input for the MariaDB client: EIO/.test(err.message))
  assert.equal(child.killed, true, 'the tool was stopped, not left waiting for input')
})

test('an output file that cannot be written stops the tool and says why', async (t) => {
  const child = fakeChild(t)
  const out = new PassThrough()
  const running = runToFile('tool', [], {}, { stdout: out, label: 'dump tool' })
  out.emit('error', Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))
  await assert.rejects(running, /could not write the output of the MariaDB dump tool: ENOSPC/)
  assert.equal(child.killed, true)
})

test('only the first outcome counts: a failure is not turned into success by a later close', async (t) => {
  const child = fakeChild(t)
  const out = new PassThrough()
  const running = runToFile('tool', [], {}, { stdout: out, label: 'dump tool' })
  out.emit('error', new Error('disk full'))
  child.emit('close', 0, null)
  await assert.rejects(running, /could not write the output/)
})

test('a tool that cannot be started is a readable refusal', async (t) => {
  const child = fakeChild(t)
  const running = runToFile('tool', [], {}, { stdout: fs.createWriteStream(file('x.sql')), label: 'dump tool' })
  child.emit('error', Object.assign(new Error('spawn tool ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(running, /could not run the MariaDB dump tool: spawn tool ENOENT/)
})

test('a clean run resolves once the process has closed with 0', async (t) => {
  const child = fakeChild(t)
  const running = runToFile('tool', [], {}, { stdout: fs.createWriteStream(file('ok.sql')), label: 'dump tool' })
  child.stdout.end()
  child.emit('close', 0, null)
  await running
})
