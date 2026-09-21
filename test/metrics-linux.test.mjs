import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseProcSample, startLinuxSampler } from '../src/metrics-linux.mjs'

// pid, (comm), state, ppid ... utime is field 14, stime 15, starttime 22.
const stat = (comm, utime, stime, start) =>
  `42 (${comm}) S 1 42 42 0 -1 4194560 900 0 0 0 ${utime} ${stime} 0 0 20 0 31 0 ${start} 9000000 5000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`
const status = kib => `Name:\tjava\nVmPeak:\t 9000000 kB\nVmRSS:\t  ${kib} kB\nThreads:\t31\n`

async function waitFor(check, timeout = 2000) {
  const end = Date.now() + timeout
  while (!check() && Date.now() < end) await sleep(10)
}

test('proc readings become cumulative CPU seconds, resident bytes and a process identity', () => {
  assert.deepEqual(parseProcSample(stat('java', 1500, 250, 987654), status(2048), 100),
    { seconds: 17.5, bytes: 2048 * 1024, identity: '987654' })
  // Paper names its threads, and a name may hold spaces and brackets of its own.
  assert.deepEqual(parseProcSample(stat('Server (main) x', 200, 0, 5), status(1), 100), { seconds: 2, bytes: 1024, identity: '5' })
  assert.equal(parseProcSample(stat('java', 300, 0, 5), status(1), 250).seconds, 1.2)
  // A zombie has no VmRSS line; it holds no memory, which is a reading rather than an error.
  assert.equal(parseProcSample(stat('java', 1, 1, 5), 'Name:\tjava\nState:\tZ (zombie)\n', 100).bytes, 0)
  assert.throws(() => parseProcSample('', status(1), 100), /unreadable/)
  assert.throws(() => parseProcSample('42 (java) S 1 2 3', status(1), 100), /unreadable/)
})

test('the sampler reads on an interval, and a vanished process ends the graph without an error', async () => {
  let reads = 0
  const samples = [], errors = []
  const read = async (file) => {
    if (file.endsWith('/stat') && ++reads > 3) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return file.endsWith('/stat') ? stat('java', reads * 100, 0, 77) : status(4096)
  }
  const stop = startLinuxSampler(42, { read, ticksPerSecond: 100, intervalMs: 5, now: () => 100,
    onSample: sample => samples.push(sample), onError: error => errors.push(error) })
  try {
    await waitFor(() => reads > 3)
    await sleep(30)
    assert.deepEqual(samples.map(sample => sample.seconds), [1, 2, 3])
    assert.deepEqual(samples[0], { at: 100, seconds: 1, bytes: 4096 * 1024 })
    assert.deepEqual(errors, [])
  } finally { stop() }
})

test('a reused PID does not continue the old graph, and an unreadable reading is reported once', async () => {
  let reads = 0
  const samples = [], errors = []
  const stop = startLinuxSampler(42, { ticksPerSecond: 100, intervalMs: 5,
    read: async file => file.endsWith('/stat') ? stat('java', 100, 0, ++reads > 2 ? 999 : 77) : status(1),
    onSample: sample => samples.push(sample), onError: error => errors.push(error) })
  try {
    await waitFor(() => reads > 2)
    await sleep(30)
    assert.equal(samples.length, 2)
    assert.deepEqual(errors, [])
  } finally { stop() }

  const broken = []
  const halt = startLinuxSampler(42, { ticksPerSecond: 100, intervalMs: 5, read: async () => 'nonsense',
    onSample: () => assert.fail('no sample expected'), onError: error => broken.push(error) })
  try {
    await waitFor(() => broken.length > 0)
    await sleep(30)
    assert.equal(broken.length, 1)
    assert.match(broken[0].message, /unreadable/)
  } finally { halt() }

  const invalid = []
  assert.equal(typeof startLinuxSampler(0, { onError: error => invalid.push(error) }), 'function')
  assert.match(invalid[0].message, /valid PID/)
})

test('native Linux measures a live process, observes CPU and memory, and stops after exit',
  { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
    const child = spawn(process.execPath, ['-e', `
      global.memory = Buffer.alloc(32 * 1024 * 1024, 1);
      setInterval(() => { const end = performance.now() + 60; while (performance.now() < end) {} }, 100);
      console.log('ready');
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let stop = () => {}
    try {
      await once(child.stdout, 'data')
      const samples = [], errors = []
      stop = startLinuxSampler(child.pid, { intervalMs: 200,
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
