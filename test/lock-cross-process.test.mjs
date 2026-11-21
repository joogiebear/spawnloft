/**
 * util.mjs's lock against the Rust port (spawnloft-lib lock.rs), across processes and in both
 * directions: each side refuses a lock the other holds and names its pid, takes over one left by
 * a dead pid in either format, waits out an empty lock's write grace, leaves a lock alone that
 * someone rewrote, and the two together lose no update to a counter they both increment. The
 * contract is test/fixtures/contracts/locks.json.
 *
 * The Rust side is the test-only `lock-probe` binary of spawnloft-fakes, named by
 * SPAWNLOFT_LOCK_PROBE:
 *   (cd rust && cargo build -p spawnloft-fakes)
 *   SPAWNLOFT_LOCK_PROBE=$PWD/rust/target/debug/lock-probe node --test test/lock-cross-process.test.mjs
 * The Node side runs in child processes (test/fixtures/lock-node-probe.mjs) where its pid matters.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireLock, lockHolder } from '../src/util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'contracts', 'locks.json'), 'utf8'))
const NODE_PROBE = path.join(HERE, 'fixtures', 'lock-node-probe.mjs')
const RUST_PROBE = process.env.SPAWNLOFT_LOCK_PROBE
const skip = RUST_PROBE
  ? (fs.existsSync(RUST_PROBE) ? false : `SPAWNLOFT_LOCK_PROBE names ${RUST_PROBE}, which does not exist; build it with: cd rust && cargo build -p spawnloft-fakes`)
  : 'set SPAWNLOFT_LOCK_PROBE to the built lock-probe binary (cd rust && cargo build -p spawnloft-fakes; then SPAWNLOFT_LOCK_PROBE=$PWD/rust/target/debug/lock-probe)'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-lock-x-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const lockPath = () => path.join(scratch, `l${n++}`, 'x.lock')

const sides = {
  rust: (...args) => [RUST_PROBE, args],
  node: (...args) => [process.execPath, [NODE_PROBE, ...args]],
}

// A probe running in the background, with a way to wait for a line it prints.
function start(side, ...args) {
  const [bin, argv] = sides[side](...args)
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const waiters = []
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  child.stdout.on('data', (d) => {
    out += d
    for (const w of [...waiters]) w()
  })
  child.stderr.on('data', (d) => { err += d })
  const line = (re, ms = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${side} ${args.join(' ')}: no line matching ${re} within ${ms} ms; printed ${JSON.stringify(out)}, stderr ${JSON.stringify(err)}`)), ms)
    const check = () => {
      const m = out.match(re)
      if (!m) return
      clearTimeout(timer)
      waiters.splice(waiters.indexOf(check), 1)
      resolve(m)
    }
    waiters.push(check)
    check()
  })
  const done = async () => {
    const code = await exited
    assert.equal(code, 0, `${side} ${args.join(' ')} exited ${code}: ${err}`)
    return out.trim()
  }
  return { child, line, done }
}

const run = (side, ...args) => start(side, ...args).done()

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid
}

const age = (file, ms) => {
  const t = (Date.now() - ms) / 1000
  fs.utimesSync(file, t, t)
}

for (const [holder, other] of [['rust', 'node'], ['node', 'rust']]) {
  test(`${holder} holds: ${other} is refused and names ${holder}'s pid; free again once released`, { skip, timeout: 60000 }, async () => {
    const file = lockPath()
    const h = start(holder, 'hold', file, '1500')
    const pid = Number((await h.line(/held (\d+)/))[1])
    assert.notEqual(pid, process.pid)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, new RegExp(fx.record.match), `${holder} writes the contract record`)
    assert.equal(JSON.parse(text).pid, pid)
    assert.equal(await run(other, 'try', file), `busy ${pid}`)
    assert.equal(await run(other, 'holder', file), String(pid))
    // and this test process, as a third Node holder-to-be
    assert.equal(acquireLock(file, { mode: 'fail' }), null)
    assert.equal(lockHolder(file), pid)
    await h.line(/released/)
    await h.done()
    assert.ok(!fs.existsSync(file), 'released by removing the file')
    assert.equal(await run(other, 'try', file), 'got')
  })
}

for (const side of ['rust', 'node']) {
  test(`${side} takes over a lock left by a dead pid, in the legacy and the current format`, { skip, timeout: 60000 }, async () => {
    const dead = await deadPid()
    for (const text of [String(dead), JSON.stringify({ pid: dead, token: '00000000-0000-4000-8000-000000000000' })]) {
      const file = lockPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      assert.equal(await run(side, 'holder', file), 'free', text)
      assert.equal(await run(side, 'try', file), 'got', text)
      assert.ok(!fs.existsSync(file), 'taken and released')
      assert.ok(!fs.existsSync(`${file}${fx.rules.breaker.suffix}`), 'no breaker left')
    }
  })

  test(`${side} respects an empty lock for the write grace and takes it after`, { skip, timeout: 60000 }, async () => {
    const file = lockPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    assert.equal(await run(side, 'holder', file), '-1')
    assert.equal(await run(side, 'try', file), 'busy -1')
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'left alone')
    age(file, fx.rules.writeGraceMs + 1000)
    assert.equal(await run(side, 'holder', file), 'free')
    assert.equal(await run(side, 'try', file), 'got')
  })

  test(`${side} respects a fresh breaker on a dead lock`, { skip, timeout: 60000 }, async () => {
    const file = lockPath()
    const dead = await deadPid()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(dead))
    fs.writeFileSync(`${file}${fx.rules.breaker.suffix}`, String(dead))
    // the holder named is lockHolder's, and a dead holder is none
    assert.equal(await run(side, 'try', file), 'busy null')
    assert.equal(fs.readFileSync(file, 'utf8'), String(dead))
    age(`${file}${fx.rules.breaker.suffix}`, fx.rules.breaker.staleMs + 1000)
    assert.equal(await run(side, 'try', file), 'busy null', 'clearing the stale breaker spends the try')
    assert.equal(await run(side, 'try', file), 'got')
  })

  test(`${side}'s release leaves a lock that someone rewrote while it was held`, { skip, timeout: 60000 }, async () => {
    const file = lockPath()
    const h = start(side, 'hold', file, '800')
    await h.line(/held \d+/)
    const theirs = JSON.stringify({ pid: process.pid, token: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
    fs.writeFileSync(file, theirs)
    await h.line(/released/)
    await h.done()
    assert.equal(fs.readFileSync(file, 'utf8'), theirs)
  })
}

test('Node and Rust incrementing one counter under the same lock lose no update', { skip, timeout: 180000 }, async () => {
  const file = lockPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const counter = path.join(path.dirname(file), 'counter')
  fs.writeFileSync(counter, '0')
  const each = 40
  const workers = ['node', 'rust', 'node', 'rust', 'node', 'rust'].map((side) => start(side, 'count', file, counter, String(each)))
  const outs = await Promise.all(workers.map((w) => w.done()))
  assert.deepEqual(outs, outs.map(() => 'done'))
  assert.equal(fs.readFileSync(counter, 'utf8'), String(each * workers.length))
  assert.ok(!fs.existsSync(file), 'the lock is free at the end')
})
