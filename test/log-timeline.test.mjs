import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SOURCES, parseLine, parseLog, mergeTimelines, formatTimeline } from '../src/log-timeline.mjs'

test('SOURCES lists the four log origins', () => {
  assert.deepEqual(SOURCES, ['server', 'daemon', 'client', 'client-process'])
})

test('parseLine handles a Paper line', () => {
  const r = parseLine('[12:00:01 INFO]: Done (3.2s)! For help, type "help"')
  assert.equal(r.time, '12:00:01')
  assert.equal(r.iso, null)
  assert.equal(r.level, 'INFO')
  assert.equal(r.thread, null)
  assert.equal(r.text, 'Done (3.2s)! For help, type "help"')
})

test('parseLine handles a Fabric server line with a mod tag', () => {
  const r = parseLine('[12:00:01] [Render thread/DEBUG] (FabricLoader) Loading mod "lithium"')
  assert.equal(r.time, '12:00:01')
  assert.equal(r.iso, null)
  assert.equal(r.level, 'DEBUG')
  assert.equal(r.thread, 'Render thread')
  assert.equal(r.text, 'Loading mod "lithium"')
})

test('parseLine handles a daemon ISO line', () => {
  const r = parseLine('[2026-10-20T22:00:00.000Z] Server process started')
  assert.equal(r.time, null)
  assert.equal(r.iso, '2026-10-20T22:00:00.000Z')
  assert.equal(r.level, null)
  assert.equal(r.thread, null)
  assert.equal(r.text, 'Server process started')
})

test('parseLine handles a client line', () => {
  const r = parseLine('[12:00:01] [main/INFO]: Starting Minecraft client')
  assert.equal(r.time, '12:00:01')
  assert.equal(r.iso, null)
  assert.equal(r.level, 'INFO')
  assert.equal(r.thread, 'main')
  assert.equal(r.text, 'Starting Minecraft client')
})

test('parseLine handles a JVM line without a timestamp', () => {
  const r = parseLine('Error occurred during initialization of VM')
  assert.equal(r.time, null)
  assert.equal(r.iso, null)
  assert.equal(r.level, null)
  assert.equal(r.thread, null)
  assert.equal(r.text, 'Error occurred during initialization of VM')
})

test('a stack trace of three lines folds into its entry', () => {
  const lines = [
    '[12:00:01 ERROR]: Something broke',
    '  at com.example.Foo.bar(Foo.java:42)',
    '  at com.example.Main.run(Main.java:10)',
    'Caused by: java.lang.NullPointerException',
  ]
  const entries = parseLog(lines, { source: 'server', anchor: '2026-10-20T00:00:00Z' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, 'ERROR')
  assert.ok(entries[0].text.includes('Something broke'))
  assert.ok(entries[0].text.includes('at com.example.Foo.bar(Foo.java:42)'))
  assert.ok(entries[0].text.includes('at com.example.Main.run(Main.java:10)'))
  assert.ok(entries[0].text.includes('Caused by: java.lang.NullPointerException'))
})

test('midnight rollover moves the second line to the next day', () => {
  const lines = ['[23:59:59 INFO]: Last of the day', '[00:00:01 INFO]: First of the next']
  const entries = parseLog(lines, { source: 'server', anchor: '2026-10-20T00:00:00Z' })
  assert.equal(entries.length, 2)
  const d0 = new Date(entries[0].at)
  const d1 = new Date(entries[1].at)
  assert.equal(d0.getHours(), 23)
  assert.equal(d0.getMinutes(), 59)
  assert.equal(d0.getSeconds(), 59)
  assert.equal(d1.getHours(), 0)
  assert.equal(d1.getMinutes(), 0)
  assert.equal(d1.getSeconds(), 1)
  const nextDay = new Date(d0)
  nextDay.setDate(nextDay.getDate() + 1)
  assert.equal(d1.getFullYear(), nextDay.getFullYear())
  assert.equal(d1.getMonth(), nextDay.getMonth())
  assert.equal(d1.getDate(), nextDay.getDate())
})

test('lines are dated on the anchor day when they come after the start', () => {
  const anchor = new Date(2026, 9, 20, 10, 0, 0)
  const lines = ['[12:00:00 INFO]: Started', '[12:00:01 INFO]: Ticking']
  const entries = parseLog(lines, { source: 'server', anchor: anchor.getTime() })
  const d0 = new Date(entries[0].at)
  assert.equal(d0.getDate(), anchor.getDate())
  assert.equal(d0.getHours(), 12)
  assert.equal(new Date(entries[1].at).getSeconds(), 1)
})

test('a first line earlier than the start time belongs to the next day', () => {
  const anchor = new Date(2026, 9, 20, 23, 0, 0)
  const entries = parseLog(['[01:00:00 INFO]: Late start'], { source: 'server', anchor: anchor.getTime() })
  const d0 = new Date(entries[0].at)
  assert.equal(d0.getDate(), 21)
  assert.equal(d0.getHours(), 1)
})

test('with an mtime the tail is dated backwards from the last line, across days', () => {
  const mtime = new Date(2026, 9, 23, 8, 30, 0)
  const lines = ['[23:00:00 INFO]: Day one', '[00:30:00 INFO]: Day two', '[08:29:59 INFO]: Written at mtime']
  const entries = parseLog(lines, { source: 'server', anchor: new Date(2026, 9, 1).getTime(), mtime: mtime.getTime() })
  const dates = entries.map((e) => new Date(e.at).getDate())
  assert.deepEqual(dates, [22, 23, 23])
  const late = parseLog(['[09:00:00 INFO]: Later than the mtime clock'], { source: 'server', mtime: mtime.getTime() })
  assert.equal(new Date(late[0].at).getDate(), 22)
})

test('CRLF lines parse like LF lines and keep no carriage return', () => {
  const lines = ['[12:00:00 INFO]: Hello\r', '[2026-10-20T12:00:01.000Z] daemon\r', '  at Foo.bar\r']
  const entries = parseLog(lines, { source: 'daemon', anchor: '2026-10-20T00:00:00Z' })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].text, 'Hello')
  assert.equal(entries[1].text, 'daemon\n  at Foo.bar')
  assert.ok(!JSON.stringify(entries).includes('\\r'))
})

test('a daemon time with an offset is normalised to UTC ISO', () => {
  const [e] = parseLog(['[2026-10-20 14:00:00+02:00] hi'], { source: 'daemon' })
  assert.equal(e.at, '2026-10-20T12:00:00.000Z')
})

test('mergeTimelines orders server before client when times are equal', () => {
  const serverEntries = [{ at: '2026-10-20T12:00:00.000Z', source: 'server', level: 'INFO', thread: null, text: 'A', raw: 'A' }]
  const clientEntries = [{ at: '2026-10-20T12:00:00.000Z', source: 'client', level: 'INFO', thread: null, text: 'B', raw: 'B' }]
  const merged = mergeTimelines(serverEntries, clientEntries)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].source, 'server')
  assert.equal(merged[1].source, 'client')
})

test('formatTimeline produces the expected exact output', () => {
  const entries = [
    { at: '2026-10-20T22:00:00.000Z', source: 'server', level: 'INFO', thread: null, text: 'Starting server', raw: '[22:00:00 INFO]: Starting server' },
    { at: '2026-10-20T22:00:01.000Z', source: 'client', level: 'WARN', thread: 'main', text: 'Something wrong', raw: '[22:00:01] [main/WARN]: Something wrong' },
  ]
  // The timeline prints local time, like the logs it came from; the expected text follows this machine's zone.
  const hms = (iso) => { const d = new Date(iso); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':') }
  const out = formatTimeline(entries)
  assert.equal(out, `${hms(entries[0].at)}.000 server  INFO  Starting server\n${hms(entries[1].at)}.000 client  WARN  Something wrong`)
})
