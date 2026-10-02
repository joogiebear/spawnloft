import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeRcon } from './fixtures/fake-rcon.mjs'

// An ordinary RCON command gets half a second and a flush two, so "slower than an ordinary command
// but within what a flush is allowed" is a second here and eight to a hundred and twenty seconds
// in life. Half a second, not less: it also covers connecting and logging in, and a runner that
// stalls for longer than that makes a command retry, which these tests count.
process.env.MCCTL_RCON_TIMEOUT_MS = '500'
process.env.MCCTL_FLUSH_TIMEOUT_MS = '2000'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-backup-flush-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const backup = await import('../src/backup.mjs')
const { rconExec } = await import('../src/rcon.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let n = 0
async function server(t, options) {
  const rcon = await startFakeRcon(options)
  t.after(() => rcon.close())
  const name = `flush-${++n}`
  const dir = path.join(scratch, name)
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'example.jar'), 'fixture plugin contents')
  return { rcon, inst: { name, dir, rcon: { port: rcon.port, password: 'pw' } } }
}

const snapshot = (inst, extra = {}) => backup.createSnapshot(inst, { scope: 'plugins', running: true, ...extra })

test('a flush slower than an ordinary command is waited for, and saving is switched back on', async (t) => {
  const { rcon, inst } = await server(t, { delays: { 'save-all flush': 1000 } })
  const res = await snapshot(inst)
  assert.deepEqual(rcon.sent(), ['save-off', 'save-all flush', 'save-on'])
  assert.equal(res.flushed, true)
  assert.equal(res.flushWarning, null)
  assert.deepEqual(res.manifest.warnings, [])
})

test('a flush that never answers is given up on once, and saving is still switched back on', async (t) => {
  const { rcon, inst } = await server(t, { delays: { 'save-all flush': 10000 } })
  const res = await snapshot(inst)
  // One save-off and one flush: a flush that timed out is not run again, and not behind a second
  // save-off. save-on is what matters: the server must not be left with saving off.
  assert.deepEqual(rcon.sent(), ['save-off', 'save-all flush', 'save-on'])
  assert.equal(res.flushed, false)
  assert.match(res.flushWarning, /could not flush the world.*the copy may be torn/)
  assert.ok(res.manifest.warnings.includes(res.flushWarning))
  assert.equal(res.saveOnWarning, null)
})

test('a flush whose connection is dropped is tried again, without a second save-off', async (t) => {
  const { rcon, inst } = await server(t, { drop: { 'save-all flush': 1 } })
  const res = await snapshot(inst)
  assert.deepEqual(rcon.sent(), ['save-off', 'save-all flush', 'save-all flush', 'save-on'])
  assert.equal(res.flushed, true)
  assert.equal(res.flushWarning, null)
})

test('a save-off that is never answered may still have run, so saving is switched back on', async (t) => {
  const { rcon, inst } = await server(t, { delays: { 'save-off': 10000 } })
  const res = await snapshot(inst)
  const sent = rcon.sent()
  assert.equal(sent.at(-1), 'save-on')
  assert.ok(!sent.includes('save-all flush'), 'no flush is asked of a server that did not take save-off')
  assert.equal(res.flushed, false)
  assert.match(res.flushWarning, /could not flush/)
})

test('a save-on that is not confirmed is reported, in the result and in the manifest', async (t) => {
  const { inst } = await server(t, { drop: { 'save-on': Infinity } })
  const res = await snapshot(inst)
  assert.equal(res.flushed, true)
  assert.match(res.saveOnWarning, /autosave may still be off.*save-on/)
  assert.ok(res.manifest.warnings.includes(res.saveOnWarning))
})

test('a server that stopped during the backup is not reported as having autosave off', async (t) => {
  const { rcon, inst } = await server(t, { stopAfter: 'save-all flush' })
  const res = await snapshot(inst)
  assert.deepEqual(rcon.sent(), ['save-off', 'save-all flush'])
  assert.equal(res.flushed, true)
  assert.equal(res.saveOnWarning, null)
  assert.deepEqual(res.manifest.warnings, [])
})

test('a backup that fails after save-off still switches saving on, and says so if it cannot', async (t) => {
  const { rcon, inst } = await server(t, { drop: { 'save-on': Infinity } })
  // A member that is not there makes tar fail, after the flush and before the manifest.
  await assert.rejects(snapshot(inst, { members: ['missing.txt'] }), /autosave may still be off/)
  assert.equal(rcon.sent().at(-1), 'save-on')
})

// An error that is not one of SpawnLoft's own is printed from its stack, and whether the stack's
// first line already holds the message depends on whether anything has read the stack yet.
for (const [when, readStackFirst] of [['read before the warning is added', true], ['not yet read when the warning is added', false]]) {
  test(`a file system error after save-off carries the warning once, in its message and its stack (stack ${when})`, async (t) => {
    const { inst } = await server(t, { drop: { 'save-on': Infinity } })
    const open = fs.openSync
    t.mock.method(fs, 'openSync', (file, ...rest) => {
      if (!String(file).endsWith('.pending')) return open(file, ...rest)
      const error = Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' })
      if (readStackFirst) void error.stack
      throw error
    })
    const err = await snapshot(inst).then(() => null, (e) => e)
    assert.equal(err?.code, 'EACCES', 'not one of SpawnLoft\'s own errors, so it is printed from its stack')
    const times = (text) => text.split('autosave may still be off').length - 1
    assert.equal(times(err.message), 1)
    assert.equal(times(err.stack), 1)
  })
}

test('a refused connection is marked as refused and keeps the error code it always had', async (t) => {
  const { rcon, inst } = await server(t)
  await rcon.close()
  const err = await rconExec(inst, ['list']).then(() => null, (e) => e)
  assert.equal(err.refused, true)
  assert.equal(err.code, undefined, 'the CLI and the panel pass `code` on to whoever is calling')
})

test('a save-off that could not be sent is not followed by a claim that saving is off', async (t) => {
  // Nothing reached the server, so nothing was switched off: the failed flush is the whole story.
  const { rcon, inst } = await server(t)
  const res = await snapshot({ ...inst, rcon: { ...inst.rcon, password: 'wrong' } })
  assert.deepEqual(rcon.sent(), [])
  assert.match(res.flushWarning, /could not flush.*authentication failed/)
  assert.equal(res.saveOnWarning, null)

  const unconfigured = await snapshot({ ...inst, rcon: undefined })
  assert.match(unconfigured.flushWarning, /could not flush.*no RCON port/)
  assert.equal(unconfigured.saveOnWarning, null)
})

test('a server that is not running is not sent anything', async (t) => {
  const { rcon, inst } = await server(t)
  const res = await snapshot(inst, { running: false })
  assert.deepEqual(rcon.sent(), [])
  assert.equal(res.flushed, false)
  assert.equal(res.saveOnWarning, null)
})
