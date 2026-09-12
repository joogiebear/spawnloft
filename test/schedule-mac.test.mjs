import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trigger, plist, label, nextCalendarRun } from '../src/schedule-mac.mjs'

test('launchd translates all supported schedules without polling or a resident app', () => {
  assert.deepEqual(trigger({ kind: 'minutes', every: 17 }), { StartInterval: 1020 })
  assert.deepEqual(trigger({ kind: 'hourly', every: 2 }), { StartInterval: 7200 })
  assert.deepEqual(trigger({ kind: 'onlogon' }), { RunAtLoad: true })
  assert.deepEqual(trigger({ kind: 'daily', at: '03:05' }), { StartCalendarInterval: { Hour: 3, Minute: 5 } })
  assert.deepEqual(trigger({ kind: 'weekly', day: 'SUN', at: '23:59' }), { StartCalendarInterval: { Hour: 23, Minute: 59, Weekday: 0 } })
  const disabled = plist('a'.repeat(32) + '-backup', { enabled: false, schedule: { kind: 'minutes', every: 1 } })
  assert.match(disabled, /<key>Disabled<\/key><true\/>/)
  assert.match(disabled, /<key>AbandonProcessGroup<\/key><true\/>/)
  assert.doesNotMatch(disabled, /KeepAlive/)
  assert.throws(() => label('../other'))
})
test('calendar estimates roll forward in local time; intervals do not invent a next-run time', () => {
  const now = new Date(2026, 8, 12, 10, 0)
  assert.equal(new Date(nextCalendarRun({ kind: 'daily', at: '09:00' }, now)).getDate(), 13)
  const sun = new Date(nextCalendarRun({ kind: 'weekly', day: 'SUN', at: '09:00' }, now))
  assert.equal(sun.getDay(), 0)
  assert.equal(sun.getHours(), 9)
  assert.equal(nextCalendarRun({ kind: 'minutes', every: 10 }, now), null)
})
