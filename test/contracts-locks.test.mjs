/**
 * The lock contract in test/fixtures/contracts/locks.json, held against src/util.mjs: the record
 * acquireLock writes, how lockHolder and a second taker read each kind of lock file, the breaker,
 * the constants. Then a scan of src/*.mjs and mcctl.mjs for every lock call and exclusive create,
 * which fails on one the fixture does not list, so a new site is never missed by the Rust port
 * (rust/crates/spawnloft-lib/src/lock.rs, whose tests read the same fixture). Prose: EXCLUSION.md.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireLock, acquireLockAsync, lockHolder, withLock } from '../src/util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'contracts', 'locks.json'), 'utf8'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-contracts-locks-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let n = 0
const lockPath = () => path.join(scratch, `l${n++}`, 'x.lock')
// line endings normalised: a Windows checkout may give CRLF
const source = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
const age = (file, ms) => {
  const t = (Date.now() - ms) / 1000
  fs.utimesSync(file, t, t)
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid
}

function livePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  t.after(() => child.kill())
  return child.pid
}

// --- the constants, as util.mjs spells them ---

test('util.mjs uses the constants the fixture lists', () => {
  const util = source('src/util.mjs')
  const r = fx.rules
  const has = (text, what) => assert.ok(util.includes(text), `${what}: "${text}" is not in src/util.mjs`)
  has(`const LOCK_WRITE_GRACE_MS = ${r.writeGraceMs}`, 'writeGraceMs')
  has(`const LOCK_BREAK_STALE_MS = ${r.breaker.staleMs}`, 'breaker.staleMs')
  has(`{ mode = '${r.defaultMode}', timeoutMs = ${r.defaultTimeoutMs} } = {}`, 'defaults')
  has(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${r.pollMs})`, 'pollMs')
  has(`pauseSync(${r.busyPauseMs}); continue`, 'busyPauseMs')
  has(`pauseSync(${r.unreadablePauseMs}); continue`, 'unreadablePauseMs')
  has(`if (attempt > ${r.maxAttempts}) return { ok: false, holder: null }`, 'maxAttempts')
  has(`if (attempt >= ${r.breakAttempts} || !breakStaleLock(lockFile, seen))`, 'breakAttempts')
  has(`const LOCK_BUSY = new Set([${r.busyCodes.map((c) => `'${c}'`).join(', ')}])`, 'busyCodes')
  has(`const RM_RETRY = { force: true, maxRetries: ${r.rmRetry.maxRetries}, retryDelay: ${r.rmRetry.retryDelay} }`, 'rmRetry')
  has(`const breaker = \`\${lockFile}${r.breaker.suffix}\``, 'breaker.suffix')
  has(`fs.writeFileSync(breaker, String(process.pid), { flag: '${r.breaker.flag}' })`, 'breaker content')
  has(`fs.writeFileSync(lockFile, body, { flag: '${fx.record.flag}' })`, 'record flag')
  has('const body = JSON.stringify({ pid: process.pid, token })', 'record')
  has('const token = crypto.randomUUID()', 'token')
  has('if (rec.pid === process.pid) return true', 'samePidIsAlive')
  has('fs.mkdirSync(path.dirname(lockFile), { recursive: true })', 'createsParentDir')
  has(`throw new Error(\`${r.messages.timedOut.replace('${file}', '${lockFile}').replace('${holder}', '${result.holder}')}\`)`, 'messages.timedOut')
  has(`fail(\`${r.messages.notGot.replace('${file}', '${lockFile}')}\`)`, 'messages.notGot')
})

// --- the record ---

test('acquireLock writes exactly the record the fixture describes', () => {
  const file = lockPath()
  const release = acquireLock(file)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, new RegExp(fx.record.match))
  assert.match(fx.record.example, new RegExp(fx.record.match))
  const rec = JSON.parse(text)
  assert.deepEqual(Object.keys(rec), ['pid', 'token'])
  assert.equal(rec.pid, process.pid)
  assert.equal(text, JSON.stringify({ pid: process.pid, token: rec.token }), 'no whitespace, no newline')
  release()
  assert.ok(!fs.existsSync(file))
  // a new token every time
  const again = acquireLock(file)
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, rec.token)
  again()
})

test('lockHolder answers per the fixture for every kind of lock file', async (t) => {
  const h = fx.lockHolder
  const dead = await deadPid()
  const live = livePid(t)
  const file = lockPath()
  assert.equal(lockHolder(file), h.absent)
  write(file, '')
  assert.equal(lockHolder(file), h.unwrittenYoungerThanGrace)
  age(file, fx.rules.writeGraceMs + 1000)
  assert.equal(lockHolder(file), h.unwrittenOlderThanGrace)
  write(file, 'not json')
  assert.equal(lockHolder(file), h.unwrittenYoungerThanGrace, 'damaged reads as unwritten')
  write(file, JSON.stringify({ pid: 0, token: 't' }))
  assert.equal(lockHolder(file), -1, 'a pid of 0 is not a record')
  for (const text of [String(dead), JSON.stringify({ pid: dead, token: 't' })]) {
    write(file, text)
    assert.equal(lockHolder(file), h.deadHolder, text)
  }
  for (const text of [String(live), JSON.stringify({ pid: live, token: 't' }), ` ${live}\n`, `﻿${live}`, JSON.stringify({ pid: live })]) {
    write(file, text)
    assert.equal(lockHolder(file), live, JSON.stringify(text))
  }
  write(file, String(process.pid))
  assert.equal(lockHolder(file), process.pid, 'ownPid')
})

test('a legacy bare-pid lock is held while its pid lives and taken over once it is dead', async (t) => {
  const live = livePid(t)
  const file = lockPath()
  write(file, String(live))
  assert.equal(acquireLock(file, { mode: 'fail' }), null)
  assert.equal(fs.readFileSync(file, 'utf8'), String(live), 'a live holder is left alone')
  write(file, String(await deadPid()))
  const release = acquireLock(file, { mode: 'fail' })
  assert.ok(release, 'a dead legacy holder is taken over')
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(fx.record.match), 'and replaced by the current format')
  assert.ok(!fs.existsSync(`${file}${fx.rules.breaker.suffix}`), 'the breaker is gone')
  release()
})

test('this process\'s own pid holds a lock against itself, in both formats', () => {
  const file = lockPath()
  for (const text of [String(process.pid), JSON.stringify({ pid: process.pid, token: 'other' })]) {
    write(file, text)
    assert.equal(acquireLock(file, { mode: 'fail' }), null, text)
  }
})

test('release is token-checked: a lock rewritten since is not removed', () => {
  const file = lockPath()
  const release = acquireLock(file)
  const other = JSON.stringify({ pid: process.pid, token: 'someone-else' })
  fs.writeFileSync(file, other)
  release()
  assert.equal(fs.readFileSync(file, 'utf8'), other)
  fs.writeFileSync(file, String(process.pid))
  fs.rmSync(file)
  const second = acquireLock(file)
  fs.writeFileSync(file, String(process.pid))
  second()
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid), 'a legacy record never matches a token')
})

test('an empty lock is respected for the write grace and taken over after it', () => {
  const file = lockPath()
  write(file, '')
  assert.equal(acquireLock(file, { mode: 'fail' }), null)
  age(file, fx.rules.writeGraceMs + 1000)
  const release = acquireLock(file, { mode: 'fail' })
  assert.ok(release)
  release()
})

test('a fresh breaker blocks a takeover; one older than its staleness is cleared', async () => {
  const file = lockPath()
  const breaker = `${file}${fx.rules.breaker.suffix}`
  write(file, String(await deadPid()))
  write(breaker, '1')
  assert.equal(acquireLock(file, { mode: 'fail' }), null)
  assert.ok(fs.existsSync(breaker), 'a fresh breaker belongs to someone clearing the lock')
  age(breaker, fx.rules.breaker.staleMs + 1000)
  assert.equal(acquireLock(file, { mode: 'fail' }), null, 'the try that clears a stale breaker reports held')
  assert.ok(!fs.existsSync(breaker))
  const release = acquireLock(file, { mode: 'fail' })
  assert.ok(release, 'the next try takes over')
  release()
})

test('the wait and withLock refusals carry the fixture\'s messages', async () => {
  const file = lockPath()
  const release = acquireLock(file)
  const timedOut = fx.rules.messages.timedOut.replace('${file}', file).replace('${holder}', process.pid)
  assert.throws(() => acquireLock(file, { timeoutMs: 50 }), { message: timedOut })
  await assert.rejects(acquireLockAsync(file, { timeoutMs: 50 }), { message: timedOut })
  assert.throws(() => withLock(file, () => {}, { mode: 'fail' }), { message: fx.rules.messages.notGot.replace('${file}', file) })
  release()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  assert.throws(() => acquireLock(file, { timeoutMs: 30 }), { message: fx.rules.messages.timedOut.replace('${file}', file).replace('${holder}', 'null') })
})

// --- every site is listed ---

const CALL = /\b(acquireLockAsync|acquireLock|withLock|lockHolder)\(/
const EXCLUSIVE = /['"]wx\+?['"]|COPYFILE_EXCL|O_EXCL|'EEXIST'/
const PID_MARKER = /\bpid: process\.pid\b/
const scanned = () => [...fs.readdirSync(path.join(REPO, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`), 'mcctl.mjs']

// [file, trimmed line] for every line that takes a lock, creates exclusively or writes a pid marker
function found() {
  const hits = []
  for (const file of scanned()) {
    for (const raw of source(file).split('\n')) {
      const line = raw.trim()
      // comments, imports and util.mjs's own definitions are not call sites
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('import ')) continue
      if (/^export (async )?function (acquireLockAsync|acquireLock|withLock|lockHolder)\(/.test(line)) continue
      if (CALL.test(line) || EXCLUSIVE.test(line) || PID_MARKER.test(line)) hits.push(`${file}\t${line}`)
    }
  }
  return hits
}

const listed = () => [...fx.sites, ...fx.exclusive, ...fx.markers].flatMap((s) => s.lines.map((l) => `${s.file}\t${l}`))

test('every lock call, exclusive create and pid marker in the source is listed in locks.json', () => {
  const want = listed()
  const left = [...want]
  const missing = []
  for (const hit of found()) {
    const i = left.indexOf(hit)
    if (i === -1) missing.push(hit.replace('\t', ': '))
    else left.splice(i, 1)
  }
  assert.deepEqual(missing, [], 'not in test/fixtures/contracts/locks.json: add each (and its row in EXCLUSION.md), and port it')
  // a line listed but gone from the source is a stale entry (markers are checked below)
  const markerLines = new Set(fx.markers.flatMap((m) => m.lines.map((l) => `${m.file}\t${l}`)))
  assert.deepEqual(left.filter((l) => !markerLines.has(l)).map((l) => l.replace('\t', ': ')), [], 'listed in locks.json but not in the source')
})

test('every listed marker line is still in its file, and the lock functions are not imported under another name', () => {
  for (const m of fx.markers) {
    for (const line of m.lines) assert.ok(source(m.file).includes(line), `${m.id}: "${line}" is not in ${m.file}`)
  }
  for (const file of scanned()) {
    assert.doesNotMatch(source(file), /\b(acquireLockAsync|acquireLock|withLock|lockHolder) as \w+/, `${file} renames a lock function, which the scan would miss`)
  }
  const ids = [...fx.sites, ...fx.exclusive, ...fx.markers].map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const s of fx.sites) {
    assert.ok(['acquireLock', 'acquireLockAsync', 'withLock', 'lockHolder', 'wx'].includes(s.call), s.id)
    if (s.call !== 'lockHolder' && s.call !== 'wx' && s.lock !== 'any') {
      assert.ok(['wait', 'fail'].includes(s.mode), `${s.id}: mode`)
      if (s.mode === 'wait') assert.ok(Number.isInteger(s.timeoutMs), `${s.id}: timeoutMs`)
    }
  }
})

test('a listed mode and timeout agree with the call line', () => {
  for (const s of fx.sites.filter((x) => ['acquireLock', 'acquireLockAsync', 'withLock'].includes(x.call) && x.lock !== 'any')) {
    const line = s.lines[0]
    if (s.mode === 'fail') assert.match(line, /mode: 'fail'/, s.id)
    else assert.doesNotMatch(line, /mode: 'fail'/, s.id)
    const t = line.match(/timeoutMs: ([\d* ]+)/)
    // a literal like 30 * 60 * 1000
    const timeout = t ? t[1].split('*').reduce((a, b) => a * Number(b), 1) : fx.rules.defaultTimeoutMs
    if (s.mode === 'wait') assert.equal(s.timeoutMs, timeout, s.id)
  }
})
