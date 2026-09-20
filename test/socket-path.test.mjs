/**
 * A data root too deep for a unix socket.
 *
 * <p>Its own file because paths are resolved once, at import: the long data root has to be in the
 * environment before anything from src/ is loaded, and each test file is its own process.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const posix = process.platform !== 'win32'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-socket-'))
// Deep enough that run/<name>/control.sock under it is past 108 bytes on any machine.
const deep = path.join(scratch, 'a-data-folder-with-a-long-name'.repeat(3), 'and-another-level-below-that-one')
process.env.MCCTL_DATA_ROOT = deep

const { putInstance, removeInstance } = await import('../src/registry.mjs')
const sup = await import('../src/supervisor.mjs')
const { readState } = await import('../src/control.mjs')
const { findFreePort, sleep } = await import('../src/util.mjs')
const { controlPath, runDir, shortSocketPath, SOCKET_PATH_MAX } = await import('../src/paths.mjs')

const FAKE_JAVA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-java.mjs')
const name = `sock-${process.pid}`
const other = `${name}-b`

after(async () => {
  for (const instance of [name, other]) {
    try { await sup.kill(instance) } catch { /* already down */ }
    try { removeInstance(instance) } catch { /* never made */ }
  }
  await sleep(300)
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('a control socket that would not fit is given a short, private, repeatable path', { skip: !posix }, () => {
  const natural = path.join(runDir(name), 'control.sock')
  assert.ok(Buffer.byteLength(natural) > SOCKET_PATH_MAX, 'the fixture path is not long enough to prove anything')
  const chosen = controlPath(name)
  assert.notEqual(chosen, natural)
  assert.ok(Buffer.byteLength(chosen) <= SOCKET_PATH_MAX)
  // The daemon and the CLI are different processes and must arrive at the same place.
  assert.equal(controlPath(name), chosen)
  assert.notEqual(controlPath(`${name}-other`), chosen)
  const dir = path.dirname(chosen)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)

  // /tmp is shared. A folder that is not this user's own is refused rather than trusted.
  const foreign = fs.mkdtempSync(path.join(scratch, 'tmp-'))
  assert.throws(() => shortSocketPath(natural, { base: foreign, uid: process.getuid() + 1 }), /not a private folder/)
})

async function makeServer(instance) {
  const dir = path.join(deep, 'instances', instance)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  const port = await findFreePort(35000 + Math.floor(Math.random() * 20000))
  putInstance(instance, { dir, jar: 'server.jar', java: FAKE_JAVA, memory: '1G', port,
    rcon: { port: await findFreePort(port + 1), password: 'test' } })
}

// Node does not refuse a socket path that is too long: it cuts it to fit and says nothing. Every
// server under one deep data root is cut to the SAME path, so the second cannot listen - and
// whatever is sent to it is answered by the first. "Stop B" stopped A.
test('two servers under a data root that deep each answer to their own name', { skip: !posix, timeout: 60000 }, async () => {
  await makeServer(name)
  await makeServer(other)
  for (const instance of [name, other]) {
    const started = await sup.start(instance, { timeout: 15000 })
    assert.equal(started.ready, true, `${instance}: ${JSON.stringify(started)}`)
  }
  assert.equal((await sup.sendConsole(other, 'hello')).ok, true)
  await sup.stop(other)
  assert.equal(readState(other).status, 'stopped')
  assert.equal(readState(name).status, 'running', 'stopping one server took the other down')
  await sup.stop(name)
  assert.equal(readState(name).status, 'stopped')
})
