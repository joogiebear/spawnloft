import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { parsePsSample, startDarwinSampler } from '../src/metrics-darwin.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-metrics-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { sampleRecorder, readSamples, metricsFile } = await import('../src/metrics.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('Mac ps CPU time preserves fractions and long-running counters; RSS is KiB', () => {
  assert.deepEqual(parsePsSample('  42  12345:56.78  262144 Fri Sep 11 12:30:00 2026\n', 42), {
    seconds: 740756.78, bytes: 268435456, identity: 'Fri Sep 11 12:30:00 2026',
  })
  for (const value of ['', '42 1:99.0 42 start', '43 0:00.10 100 start',
    '42 NaN 100 start', '42 0:00.10 -1 start', '42 0:00.10 12',
    '42 0:00.10 12 start\n43 0:01.00 12 other']) {
    assert.throws(() => parsePsSample(value, 42))
  }
})

test('Mac and Windows samples use cumulative CPU deltas and whole-machine normalization', () => {
  const samples = []
  const record = sampleRecorder(sample => samples.push(sample), 8)
  record({ at: 100, seconds: 5, bytes: 100 * 1048576 })
  assert.equal(samples.length, 0, 'The first measurement is a baseline')
  record({ at: 110, seconds: 15, bytes: 128 * 1048576 })
  assert.deepEqual(samples, [{ at: 110, cpu: 12.5, rss: 128 }])
  record({ at: 120, seconds: 15, bytes: 129 * 1048576 })
  assert.equal(samples[1].cpu, 0, 'A quiet process is a valid measurement')
  record({ at: 130, seconds: 2000, bytes: 130 * 1048576 })
  assert.equal(samples[2].cpu, 100)
})

test('clock jumps, sleep gaps, reset counters, and malformed input cannot manufacture spikes', () => {
  const samples = []
  const record = sampleRecorder(sample => samples.push(sample), 2)
  const input = (at, seconds) => record({ at, seconds, bytes: 1048576 })
  input(100, 10)
  input(100, 11)
  input(90, 12)
  input(140, 20)
  input(150, 1)
  input(NaN, 2)
  record({ at: 151, seconds: 2, bytes: -1 })
  assert.deepEqual(samples, [])
  input(160, 2)
  assert.deepEqual(samples, [{ at: 160, cpu: 5, rss: 1 }])
})

test('corrupt history rows are skipped without losing good readings', () => {
  const file = metricsFile('history')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '100 12.5 128\n101 NaN 120\n102 20\n103 101 20\n104 2 -1\n105 0 140\n')
  assert.deepEqual(readSamples('history'), [{ at: 100, cpu: 12.5, rss: 128 }, { at: 105, cpu: 0, rss: 140 }])
})

function fakeQuery() {
  const calls = []
  const execute = (file, args, options, callback) => {
    const call = { file, args, options, callback, killed: false }
    calls.push(call)
    return { kill() { call.killed = true } }
  }
  return { calls, execute }
}
async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await sleep(5)
  assert.ok(check(), 'Expected condition did not arrive')
}
const psRow = (start = 'Fri Sep 11 12:30:00 2026') => `42 0:01.23 65536 ${start}\n`

test('Mac queries are asynchronous, bounded, locale-independent, and never overlap', async () => {
  const fake = fakeQuery()
  const samples = []
  const errors = []
  const stop = startDarwinSampler(42, { ...fake, intervalMs: 10, now: () => 100,
    onSample: sample => samples.push(sample), onError: error => errors.push(error) })
  try {
    await waitFor(() => fake.calls.length === 1)
    await sleep(40)
    assert.equal(fake.calls.length, 1, 'Do not launch another query while this one is running')
    const first = fake.calls[0]
    assert.equal(first.file, '/bin/ps')
    assert.deepEqual(first.args, ['-p', '42', '-o', 'pid=,time=,rss=,lstart='])
    assert.equal(first.options.env.LC_ALL, 'C')
    assert.equal(first.options.timeout, 3000)
    first.callback(null, psRow(), '')
    assert.deepEqual(samples, [{ at: 100, seconds: 1.23, bytes: 67108864 }])
    await waitFor(() => fake.calls.length === 2)
    stop()
    assert.equal(fake.calls[1].killed, true)
    fake.calls[1].callback(null, psRow(), '')
    await sleep(30)
    assert.equal(samples.length, 1, 'Stopping suppresses late measurements')
    assert.equal(fake.calls.length, 2)
    assert.deepEqual(errors, [])
  } finally { stop() }
})

test('missing processes and reused PIDs end sampling without a false error', async () => {
  for (const reused of [false, true]) {
    const fake = fakeQuery()
    const samples = []
    const errors = []
    const stop = startDarwinSampler(42, { ...fake, intervalMs: 5,
      onSample: sample => samples.push(sample), onError: error => errors.push(error) })
    try {
      await waitFor(() => fake.calls.length === 1)
      fake.calls[0].callback(null, psRow(), '')
      await waitFor(() => fake.calls.length === 2)
      if (reused) fake.calls[1].callback(null, psRow('Sat Sep 12 12:30:00 2026'), '')
      else fake.calls[1].callback({ code: 1 }, '', '')
      await sleep(30)
      assert.equal(fake.calls.length, 2)
      assert.equal(samples.length, 1)
      assert.deepEqual(errors, [])
    } finally { stop() }
  }
})

test('query failures and unwritable history stop with a useful error', async () => {
  for (const failure of ['timeout', 'malformed', 'write']) {
    const fake = fakeQuery()
    const errors = []
    const stop = startDarwinSampler(42, { ...fake, intervalMs: 5,
      onSample: () => { if (failure === 'write') throw new Error('read-only history') },
      onError: error => errors.push(error) })
    try {
      await waitFor(() => fake.calls.length === 1)
      fake.calls[0].callback(failure === 'timeout' ? new Error('timed out') : null,
        failure === 'malformed' ? 'invalid' : psRow(), '')
      await sleep(30)
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /timed out|unreadable|read-only/)
      assert.equal(fake.calls.length, 1)
    } finally { stop() }
  }
})

test('native macOS measures a live process, observes CPU and memory, and stops after exit',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
    const child = spawn(process.execPath, ['-e', `
      global.memory = Buffer.alloc(32 * 1024 * 1024, 1);
      setInterval(() => { const end = performance.now() + 60; while (performance.now() < end) {} }, 100);
      console.log('ready');
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let stop = () => {}
    try {
      await once(child.stdout, 'data')
      const samples = []
      const errors = []
      stop = startDarwinSampler(child.pid, { intervalMs: 200,
        onSample: sample => samples.push(sample), onError: error => errors.push(error) })
      await waitFor(() => samples.length >= 4 || errors.length > 0, 10000)
      assert.deepEqual(errors, [])
      assert.ok(samples.at(-1).seconds > samples[0].seconds, JSON.stringify(samples))
      assert.ok(samples.every(sample => sample.bytes >= 32 * 1024 * 1024))
      child.kill()
      await exited
      await sleep(500)
      const count = samples.length
      await sleep(400)
      assert.equal(samples.length, count)
      assert.deepEqual(errors, [])
    } finally {
      stop()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
    }
  })
