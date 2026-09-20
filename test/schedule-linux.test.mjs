import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trigger, serviceUnit, timerUnit, label, parseShow, describe } from '../src/schedule-linux.mjs'

test('systemd translates all supported schedules without polling or a resident app', () => {
  assert.deepEqual(trigger({ kind: 'minutes', every: 17 }), ['OnActiveSec=1020s', 'OnUnitActiveSec=1020s', 'AccuracySec=1s'])
  assert.deepEqual(trigger({ kind: 'hourly', every: 2 }), ['OnActiveSec=7200s', 'OnUnitActiveSec=7200s', 'AccuracySec=1s'])
  assert.deepEqual(trigger({ kind: 'daily', at: '03:05' }), ['OnCalendar=*-*-* 03:05:00', 'Persistent=true', 'AccuracySec=1s'])
  assert.deepEqual(trigger({ kind: 'weekly', day: 'SUN', at: '23:59' }), ['OnCalendar=Sun *-*-* 23:59:00', 'Persistent=true', 'AccuracySec=1s'])
  assert.equal(trigger({ kind: 'onlogon' }), null)
  assert.throws(() => trigger({ kind: 'weekly', day: 'FUNDAY', at: '09:00' }))
  assert.throws(() => label('../other'))
})

test('a task outlives nothing it should not, and the servers it starts outlive it', () => {
  const id = 'a'.repeat(32) + '-backup'
  const unit = serviceUnit(id, { enabled: true, schedule: { kind: 'daily', at: '03:00' } })
  assert.match(unit, /^Type=oneshot$/m)
  // Without this systemd kills the server a scheduled start has just launched.
  assert.match(unit, /^KillMode=process$/m)
  assert.match(unit, /^ExecStart=\/bin\/sh ".*-backup\.sh"$/m)
  assert.doesNotMatch(unit, /Restart=|\[Install\]/)
  const timer = timerUnit(id, { enabled: true, schedule: { kind: 'daily', at: '03:00' } })
  assert.match(timer, /^WantedBy=timers\.target$/m)
})

test('"at logon" is the service wanted by the default target, with no timer', () => {
  const task = { enabled: true, schedule: { kind: 'onlogon' } }
  assert.equal(timerUnit('smp-start', task), null)
  assert.match(serviceUnit('smp-start', task), /\[Install\]\nWantedBy=default\.target\n$/)
})

test('systemd answers are read per unit, and absent units are not reported as working', () => {
  const id = 'smp-backup'
  const svc = `${label(id)}.service`, clock = `${label(id)}.timer`
  const daily = { enabled: true, schedule: { kind: 'daily', at: '03:00' } }
  const units = parseShow([
    `Id=${svc}\nLoadState=loaded\nActiveState=inactive\nExecMainStatus=3\nExecMainExitTimestamp=Sun 2026-09-13 08:00:00 UTC`,
    // Asked for in UTC; a local zone name is not something to guess an offset from.
    `Id=${clock}\nLoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Mon 2026-09-14 08:00:00 UTC\nLastTriggerUSec=Sun 2026-09-13 08:00:00 UTC`,
  ].join('\n\n'))
  assert.deepEqual(describe(id, daily, units, null), { state: 'Ready', lastResult: 3,
    lastRun: '2026-09-13T08:00:00.000Z', nextRun: '2026-09-14T08:00:00.000Z' })
  const local = parseShow(`Id=${svc}\nLoadState=loaded\nActiveState=inactive\nExecMainStatus=0\nExecMainExitTimestamp=Sun 2026-09-13 03:00:00 CDT\n\nId=${clock}\nLoadState=loaded`)
  assert.equal(describe(id, { ...daily, enabled: false }, local, null).lastRun, null)
  // The run log's own time wins over systemd's: it is when mcctl did the work.
  assert.equal(describe(id, daily, units, '2026-09-12T08:00:00.000Z').lastRun, '2026-09-12T08:00:00.000Z')
  assert.equal(describe(id, { ...daily, enabled: false }, units, null).state, 'Disabled')

  // Intervals elapse on the monotonic clock; the next run is the last firing plus the interval.
  const every = { enabled: true, schedule: { kind: 'minutes', every: 10 } }
  assert.equal(describe(id, every, units, null).nextRun, '2026-09-13T08:10:00.000Z')

  const never = parseShow(`Id=${svc}\nLoadState=loaded\nActiveState=activating\nExecMainStatus=0\nExecMainExitTimestamp=n/a\n\n` +
    `Id=${clock}\nLoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Mon 2026-09-14 08:00:00 UTC`)
  assert.deepEqual(describe(id, daily, never, null), { state: 'Running', lastRun: null, lastResult: null, nextRun: null })

  const deleted = parseShow(`Id=${svc}\nLoadState=not-found\nActiveState=inactive\n\nId=${clock}\nLoadState=not-found`)
  assert.equal(describe(id, daily, deleted, null), null)
  assert.equal(describe('other-backup', daily, units, null), null)
})
