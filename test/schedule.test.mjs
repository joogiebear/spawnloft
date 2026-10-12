import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseSchedule, normaliseAction, describeResult, DAYS } from '../src/schedule.mjs'
import { UserError } from '../src/util.mjs'

test('an unknown kind is refused', () => {
  assert.throws(() => normaliseSchedule({ kind: 'fortnightly' }), UserError)
  assert.throws(() => normaliseSchedule(undefined), UserError)
})

test('onlogon keeps nothing but its kind', () => {
  assert.deepEqual(normaliseSchedule({ kind: 'onlogon', at: '03:00', extra: true }), { kind: 'onlogon' })
})

test('intervals coerce numeric strings and must be whole and at least 1', () => {
  assert.deepEqual(normaliseSchedule({ kind: 'minutes', every: '30' }), { kind: 'minutes', every: 30 })
  assert.throws(() => normaliseSchedule({ kind: 'minutes', every: 0 }), UserError)
  assert.throws(() => normaliseSchedule({ kind: 'minutes', every: 1.5 }), UserError)
  assert.throws(() => normaliseSchedule({ kind: 'hourly', every: 'six' }), UserError)
})

// schtasks tops out at /MO 1439 (minutes) and 23 (hours). Past that it creates a task that
// never fires, so these are refusals here rather than surprises at 3am.
test('intervals stop at what Windows will actually run', () => {
  assert.deepEqual(normaliseSchedule({ kind: 'minutes', every: 1439 }), { kind: 'minutes', every: 1439 })
  assert.throws(() => normaliseSchedule({ kind: 'minutes', every: 1440 }), UserError)
  assert.deepEqual(normaliseSchedule({ kind: 'hourly', every: 23 }), { kind: 'hourly', every: 23 })
  assert.throws(() => normaliseSchedule({ kind: 'hourly', every: 24 }), UserError)
})

test('daily needs a zero-padded 24h time', () => {
  assert.deepEqual(normaliseSchedule({ kind: 'daily', at: '03:00' }), { kind: 'daily', at: '03:00' })
  assert.deepEqual(normaliseSchedule({ kind: 'daily', at: '23:59' }), { kind: 'daily', at: '23:59' })
  for (const bad of ['3:00', '24:00', '12:60', 'noon', '']) {
    assert.throws(() => normaliseSchedule({ kind: 'daily', at: bad }), UserError, `accepted "${bad}"`)
  }
})

test('weekly upcases its day and refuses one schtasks does not know', () => {
  assert.deepEqual(normaliseSchedule({ kind: 'weekly', day: 'sun', at: '03:00' }),
    { kind: 'weekly', day: 'SUN', at: '03:00' })
  assert.throws(() => normaliseSchedule({ kind: 'weekly', day: 'SOMEDAY', at: '03:00' }), UserError)
  for (const day of DAYS) {
    assert.equal(normaliseSchedule({ kind: 'weekly', day, at: '03:00' }).day, day)
  }
})

test('an unknown action is refused', () => {
  assert.throws(() => normaliseAction({ type: 'format-c' }), UserError)
  assert.throws(() => normaliseAction(null), UserError)
})

test('a command must have a line, trimmed, no longer than a console line', () => {
  assert.deepEqual(normaliseAction({ type: 'command', line: '  say hi  ' }), { type: 'command', line: 'say hi' })
  assert.throws(() => normaliseAction({ type: 'command', line: '   ' }), UserError)
  assert.equal(normaliseAction({ type: 'command', line: 'x'.repeat(400) }).line.length, 400)
  assert.throws(() => normaliseAction({ type: 'command', line: 'x'.repeat(401) }), UserError)
})

test('backup keep is a positive whole number capped at 365, else null', () => {
  assert.deepEqual(normaliseAction({ type: 'backup', keep: '7' }), { type: 'backup', keep: 7 })
  assert.equal(normaliseAction({ type: 'backup', keep: 9999 }).keep, 365)
  assert.equal(normaliseAction({ type: 'backup', keep: 0 }).keep, null)
  assert.equal(normaliseAction({ type: 'backup' }).keep, null)
})

test('fields the action does not use are dropped rather than stored', () => {
  assert.deepEqual(normaliseAction({ type: 'restart', line: 'say hi', keep: 7 }),
    { type: 'restart', warnMinutes: 0 })
  assert.deepEqual(normaliseAction({ type: 'stop', warnMinutes: 5 }), { type: 'stop' })
})

test('a restart keeps its warning, whole and capped at an hour', () => {
  assert.equal(normaliseAction({ type: 'restart', warnMinutes: '5' }).warnMinutes, 5)
  assert.equal(normaliseAction({ type: 'restart', warnMinutes: 500 }).warnMinutes, 60)
  assert.equal(normaliseAction({ type: 'restart', warnMinutes: -3 }).warnMinutes, 0)
  assert.equal(normaliseAction({ type: 'restart', warnMinutes: 2.5 }).warnMinutes, 0)
  assert.equal(normaliseAction({ type: 'restart' }).warnMinutes, 0)
})

test('Task Scheduler result codes read as words, not HRESULTs', () => {
  assert.equal(describeResult(0), 'ok')
  assert.equal(describeResult(267011), 'not run yet')
  assert.equal(describeResult(null), 'unknown')
  assert.equal(describeResult(5), 'failed (exit 5)')
})
