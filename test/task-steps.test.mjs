import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseSteps, runSteps, describeStep, MAX_STEPS } from '../src/task-steps.mjs'
import { normaliseAction } from '../src/schedule.mjs'

/** A server that is only a flag and a transcript, and a clock that does not wait. */
function fakeServer({ running = true, startFails = false, backupFails = false } = {}) {
  const log = []
  let up = running
  return {
    log,
    deps: {
      isRunning: async () => up,
      send: async (line) => { log.push(`send ${line}`) },
      sleep: async (ms) => { log.push(`sleep ${ms / 1000}`) },
      backup: async ({ keep }) => {
        if (backupFails) throw new Error('disk full')
        log.push(`backup ${keep}`)
        return 'backed up x.tar.gz'
      },
      verify: async () => { log.push('verify'); return 'verified 2 backups' },
      stop: async () => { up = false; log.push('stop') },
      start: async () => {
        log.push('start')
        if (startFails) return { failed: true, reason: 'port taken' }
        up = true
        return { ready: true }
      },
    },
  }
}

const chain = (steps, extra = {}) => normaliseSteps({ steps, ...extra })

test('steps are checked and cleaned before they are stored', () => {
  const a = normaliseAction({
    type: 'steps',
    steps: [
      { do: 'say', text: '  Restarting soon  ' },
      { do: 'command', line: '/save-all' },
      { do: 'wait', seconds: 2 },
      { do: 'countdown', minutes: 500 },
      { do: 'backup', keep: '7' },
      { do: 'restart', extra: 'ignored' },
    ],
    onlyWhenRunning: true,
  })
  assert.deepEqual(a, {
    type: 'steps',
    steps: [
      { do: 'say', text: 'Restarting soon' },
      { do: 'command', line: 'save-all' },
      { do: 'wait', seconds: 5 },
      { do: 'countdown', minutes: 60, message: 'Server restarting' },
      { do: 'backup', keep: 7 },
      { do: 'restart' },
    ],
    onlyWhenRunning: true,
    keepGoing: false,
  })
  assert.throws(() => chain([]), /at least one step/)
  assert.throws(() => chain([{ do: 'dance' }]), /step 1: "dance" is not a step/)
  assert.throws(() => chain([{ do: 'say', text: ' ' }]), /step 1: what should the players be told/)
  assert.throws(() => chain(Array.from({ length: MAX_STEPS + 1 }, () => ({ do: 'stop' }))), /at most 12 steps/)
  assert.throws(() => chain([{ do: 'countdown', minutes: 60 }, { do: 'wait', seconds: 3600 }, { do: 'wait', seconds: 60 }]), /waits add up to 121 minutes/)
})

test('a restart with a warning and a backup runs in order, and the countdown speaks', async () => {
  const s = fakeServer()
  const res = await runSteps(chain([{ do: 'countdown', minutes: 5 }, { do: 'backup', keep: 7 }, { do: 'restart' }]), s.deps)
  assert.equal(res.status, 'ok')
  assert.deepEqual(s.log, [
    'send say Server restarting in 5 minutes', 'sleep 240', 'send say Server restarting in 1 minute',
    'sleep 50', 'send say Server restarting in 10 seconds', 'sleep 10',
    'backup 7', 'stop', 'start',
  ])
  assert.equal(res.detail, 'counted down 5 minutes; backed up x.tar.gz; restarted')
})

test('a step with nothing to act on is skipped, not failed', async () => {
  const s = fakeServer({ running: false })
  const res = await runSteps(chain([{ do: 'say', text: 'hi' }, { do: 'command', line: 'save-all' }, { do: 'countdown', minutes: 1 }, { do: 'stop' }, { do: 'backup' }]), s.deps)
  assert.equal(res.status, 'ok')
  assert.deepEqual(s.log, ['backup null'])
  assert.match(res.detail, /nobody to tell \(not running\); "save-all" not sent \(not running\); no countdown \(not running\); already stopped; backed up/)
})

test('"only while running" skips the whole chain on a stopped server', async () => {
  const s = fakeServer({ running: false })
  const res = await runSteps(chain([{ do: 'backup' }], { onlyWhenRunning: true }), s.deps)
  assert.equal(res.status, 'skipped')
  assert.deepEqual(s.log, [])
})

test('a failed step stops the chain, so nothing restarts without its backup', async () => {
  const s = fakeServer({ backupFails: true })
  const res = await runSteps(chain([{ do: 'say', text: 'backing up' }, { do: 'backup' }, { do: 'restart' }]), s.deps)
  assert.equal(res.status, 'FAILED')
  assert.deepEqual(s.log, ['send say backing up'])
  assert.match(res.detail, /back up FAILED; stopped there, 1 step not run$/)
  assert.deepEqual(res.failures, ['step 2 (back up) failed: disk full'])
})

test('"keep going" runs the rest, and the run still reads as failed', async () => {
  const s = fakeServer({ backupFails: true })
  const res = await runSteps(chain([{ do: 'backup' }, { do: 'restart' }], { keepGoing: true }), s.deps)
  assert.equal(res.status, 'FAILED')
  assert.deepEqual(s.log, ['stop', 'start'])
})

test('a start that does not come up is a failure', async () => {
  const s = fakeServer({ running: false, startFails: true })
  const res = await runSteps(chain([{ do: 'start' }]), s.deps)
  assert.equal(res.status, 'FAILED')
  assert.match(res.failures[0], /it stopped again: port taken/)
})

test('each step reads as a phrase', () => {
  assert.equal(describeStep({ do: 'wait', seconds: 90 }), 'wait 1m 30s')
  assert.equal(describeStep({ do: 'wait', seconds: 120 }), 'wait 2 minutes')
  assert.equal(describeStep({ do: 'countdown', minutes: 1 }), 'a 1 minute countdown')
  assert.equal(describeStep({ do: 'backup', keep: 3 }), 'back up, keeping 3')
})
