import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'

import { humanBytes, humanDuration, table, validateName, stamp, randomPassword, readJson, writeJson, UserError, dirSize, dirSizeAsync, sameProcess, refreshProcessTable, acquireLock, acquireLockAsync, withLock, lockHolder } from '../src/util.mjs'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-lock-'))

test('bytes read at the right unit, whole below 1 KB', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(1023), '1023 B')
  assert.equal(humanBytes(1536), '1.5 KB')
  assert.equal(humanBytes(111518632), '106.4 MB')
  assert.equal(humanBytes(null), '-')
})

test('durations carry the two units that matter at their scale', () => {
  assert.equal(humanDuration(5000), '5s')
  assert.equal(humanDuration(65000), '1m 5s')
  assert.equal(humanDuration(3 * 3600000 + 7 * 60000), '3h 7m')
  assert.equal(humanDuration(26 * 3600000), '1d 2h')
  assert.equal(humanDuration(null), '-')
})

test('table pads every column to its widest cell and trims row ends', () => {
  const text = table([['NAME', 'STATE'], ['stock', 'running'], ['g', 'up']])
  assert.deepEqual(text.split('\n'), ['NAME   STATE', 'stock  running', 'g      up'])
})

test('names allow letters, digits, dash, underscore, up to 32', () => {
  assert.equal(validateName('Stock_2-b'), 'Stock_2-b')
  assert.equal(validateName('a'.repeat(32)), 'a'.repeat(32))
  for (const bad of ['', '-lead', 'has space', 'a'.repeat(33), '..\\up', 'semi;colon']) {
    assert.throws(() => validateName(bad), UserError, `accepted "${bad}"`)
  }
})

test('stamp is filename-safe and zero-padded', () => {
  assert.equal(stamp(new Date(2026, 7, 30, 5, 4, 3)), '2026-08-30_050403')
})

test('passwords draw only from the unambiguous alphabet, at the asked length', () => {
  const pw = randomPassword(32)
  assert.equal(pw.length, 32)
  assert.match(pw, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/)
})

test('readJson answers the fallback for a missing file, not an error', () => {
  assert.deepEqual(readJson(path.join(os.tmpdir(), 'mcctl-does-not-exist.json'), { a: 1 }), { a: 1 })
})

test('writeJson round-trips and leaves no .tmp behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-util-'))
  const file = path.join(dir, 'deep', 'reg.json')
  writeJson(file, { version: 1, instances: {} })
  assert.deepEqual(readJson(file), { version: 1, instances: {} })
  assert.ok(!fs.existsSync(`${file}.tmp`), 'the temp file should have been renamed away')
})

// ---- locking -----------------------------------------------------------------

test('withLock serializes two read-modify-writes that would otherwise clobber each other', () => {
  const file = path.join(scratch(), 'counter.json')
  writeJson(file, { n: 0 })
  for (let i = 0; i < 20; i++) {
    withLock(`${file}.lock`, () => {
      const data = readJson(file)
      writeJson(file, { n: data.n + 1 })
    })
  }
  assert.equal(readJson(file).n, 20)
  assert.ok(!fs.existsSync(`${file}.lock`), 'the lock file is removed once released')
})

test('acquireLock with mode "fail" reports the conflict instead of waiting for it', () => {
  const lock = path.join(scratch(), 'start.lock')
  const release = acquireLock(lock, { mode: 'fail' })
  assert.ok(release, 'nothing else holds it yet')
  assert.equal(acquireLock(lock, { mode: 'fail' }), null, 'already held by this same (live) process')
  release()
  assert.ok(acquireLock(lock, { mode: 'fail' }), 'free again once released')
})

test('a lock left behind by a pid that is no longer alive is taken over, not waited for', () => {
  const lock = path.join(scratch(), 'stale.lock')
  // A pid essentially nothing will ever legitimately be, standing in for "that process is gone".
  fs.writeFileSync(lock, '999999', { flag: 'wx' })
  const release = acquireLock(lock, { mode: 'fail' })
  assert.ok(release, 'a dead holder does not block a new one')
  release()
})

test('acquireLock mode "wait" blocks until a holder in another process releases it', async () => {
  // acquireLock's "wait" blocks this thread (Atomics.wait), which only a separate process can
  // unblock - a timer in this same process could never fire while this thread is stuck waiting on
  // it, which is exactly why acquireLockAsync exists for anything that shares a process with its
  // holder. A real child process is the only honest way to exercise this mode's wait at all.
  const lock = path.join(scratch(), 'wait.lock')
  const holder = childProcess.spawn(process.execPath, ['-e',
    `require('fs').writeFileSync(${JSON.stringify(lock)}, String(process.pid), { flag: 'wx' });
     setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), 150)`,
  ])
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('holder never created the lock')), 2000)
    const check = setInterval(() => {
      if (fs.existsSync(lock)) { clearInterval(check); clearTimeout(deadline); resolve() }
    }, 5)
  })
  const t0 = Date.now()
  const release = acquireLock(lock, { timeoutMs: 5000 })
  assert.ok(Date.now() - t0 >= 100, 'it actually waited for the other process to release it')
  release()
  await new Promise((resolve) => holder.on('exit', resolve))
})

test('acquireLockAsync waits by yielding, not by blocking the holder\'s own progress', async () => {
  const lock = path.join(scratch(), 'async.lock')
  const release = acquireLock(lock, { mode: 'fail' })
  let holderProgressed = false
  // The holder's own "work" is just another timer - if the waiter blocked the thread instead of
  // yielding, this would never get to run, and acquireLockAsync below would time out instead of
  // succeeding once release() runs.
  setTimeout(() => { holderProgressed = true; release() }, 30)
  const second = await acquireLockAsync(lock, { timeoutMs: 2000 })
  assert.ok(holderProgressed, 'the holder\'s own timer fired while the second request was waiting')
  second()
})

test('acquireLockAsync times out with the holder named, rather than waiting forever', async () => {
  const lock = path.join(scratch(), 'timeout.lock')
  const release = acquireLock(lock, { mode: 'fail' })
  await assert.rejects(
    acquireLockAsync(lock, { timeoutMs: 50 }),
    new RegExp(`timed out waiting for lock .*held by pid ${process.pid}`),
  )
  release()
})

// ---- the things that must not hold the event loop --------------------------

test('dirSizeAsync agrees with dirSize', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-size-'))
  fs.mkdirSync(path.join(dir, 'region', 'deeper'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'level.dat'), 'x'.repeat(10))
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), 'y'.repeat(300))
  fs.writeFileSync(path.join(dir, 'region', 'deeper', 'z'), 'z'.repeat(7))
  assert.equal(await dirSizeAsync(dir), 317)
  assert.equal(await dirSizeAsync(dir), dirSize(dir))
  assert.equal(await dirSizeAsync(path.join(dir, 'missing')), 0)
})

// The first read is synchronous so a one-shot CLI call is right first time; after that the
// table refreshes in the background and a read never waits on a child process.
test('the process table refreshes without blocking and keeps knowing this process', async () => {
  const me = path.basename(process.execPath)
  assert.equal(sameProcess(process.pid, me), true)
  const started = Date.now()
  const table = await refreshProcessTable()
  assert.ok(table instanceof Map)
  assert.ok(table.has(process.pid), 'this process is in the table it just read')
  assert.equal(sameProcess(process.pid, 'java'), false, `after a refresh (${Date.now() - started}ms) the image is still checked`)
  // Two refreshes in flight are one child process, not two.
  const a = refreshProcessTable()
  const b = refreshProcessTable()
  assert.equal(a, b)
  await a
})

test('a lock taken over after this holder was judged dead is not deleted by this holder\'s release', () => {
  const lock = path.join(scratch(), 'owned.lock')
  const release = acquireLock(lock, { mode: 'fail' })
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, image: 'node', token: 'someone-else' }))
  release()
  assert.ok(fs.existsSync(lock), 'a release only removes the lock it took')
  fs.rmSync(lock)
})

test('a lock held by a live process is never taken from it, however old the lock is', () => {
  const lock = path.join(scratch(), 'live.lock')
  // The parent process is alive: a holder that is slow, not gone.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, token: 'slow' }))
  const old = new Date(Date.now() - 600000)
  fs.utimesSync(lock, old, old)
  assert.equal(acquireLock(lock, { mode: 'fail' }), null, 'age alone does not make a live holder dead')
  assert.ok(fs.existsSync(lock))
  fs.rmSync(lock)
})

test('a lock still being written is not mistaken for an abandoned one', () => {
  const lock = path.join(scratch(), 'young.lock')
  fs.writeFileSync(lock, '') // created, owner has not written its pid yet
  assert.equal(acquireLock(lock, { mode: 'fail' }), null, 'a brand-new empty lock is held')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(lock, old, old)
  const release = acquireLock(lock, { mode: 'fail' })
  assert.ok(release, 'an empty lock nobody finished writing is cleared once it is old')
  release()
})

test('while one waiter is clearing a dead holder\'s lock, another does not clear it too', () => {
  const lock = path.join(scratch(), 'breaking.lock')
  fs.writeFileSync(lock, '999999')
  fs.writeFileSync(`${lock}.break`, String(process.pid)) // another waiter is mid-clear
  assert.equal(acquireLock(lock, { mode: 'fail' }), null, 'waits for the clear in progress')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(`${lock}.break`, old, old)
  assert.equal(acquireLock(lock, { mode: 'fail' }), null, 'a dead clearer\'s marker is removed, and the next try proceeds')
  const release = acquireLock(lock, { mode: 'fail' })
  assert.ok(release)
  release()
})

test('many processes taking over one dead holder\'s lock never hold it together', async () => {
  const dir = scratch()
  const lock = path.join(dir, 'race.lock')
  const counter = path.join(dir, 'count')
  fs.writeFileSync(lock, '999999') // abandoned before anyone starts
  fs.writeFileSync(counter, '0')
  const util = new URL('../src/util.mjs', import.meta.url).href
  const code = `import('${util}').then(({ withLock }) => { for (let i = 0; i < 40; i++) withLock(${JSON.stringify(lock)}, () => {
    const fs = require('fs'); const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1)) }, { timeoutMs: 20000 }) })`
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', code], { stdio: 'inherit' })
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`worker exited ${c}`))))
  }))
  await Promise.all(runs)
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 240, 'every increment survived: no two held the lock at once')
})

test('lockHolder reads a lock as acquireLock writes it, without taking or clearing anything', () => {
  const lock = path.join(scratch(), 'held.lock')
  assert.equal(lockHolder(lock), null, 'no file: free')
  const release = acquireLock(lock, { mode: 'fail' })
  assert.equal(lockHolder(lock), process.pid, 'a lock taken the real way names its holder')
  release()
  assert.equal(lockHolder(lock), null, 'released: free')

  fs.writeFileSync(lock, String(process.ppid))
  assert.equal(lockHolder(lock), process.ppid, 'a pid-only lock from before the record existed is still read')
  fs.writeFileSync(lock, '999999999')
  assert.equal(lockHolder(lock), null, 'a dead holder reads as free')
  assert.ok(fs.existsSync(lock), 'and reading never clears it')

  fs.writeFileSync(lock, '')
  assert.equal(lockHolder(lock), -1, 'created a moment ago and not yet written: held by someone not yet named')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(lock, old, old)
  assert.equal(lockHolder(lock), null, 'an empty lock nobody finished writing is not a holder')
  fs.rmSync(lock)
})
