import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainClientLog, plainClientLines, clockTime } from '../src/client-log.mjs'

const clock = (ms) => `T${ms}`
const event = (ts, level, thread, logger, msg) =>
  `  <log4j:Event logger="${logger}" timestamp="${ts}" level="${level}" thread="${thread}">\n    <log4j:Message><![CDATA[${msg}]]></log4j:Message>\n  </log4j:Event>`

test('log4j XML events read as latest.log lines; other lines pass through', () => {
  const text = [
    'Picked up JAVA_TOOL_OPTIONS: -Dx=1',
    event(1793416981451, 'INFO', 'Render thread', 'net.minecraft.client.renderer.texture.TextureAtlas', 'Created: 2048x2048x4 minecraft:textures/atlas/blocks.png-atlas'),
    event(1793416984246, 'INFO', 'Render thread', 'net.minecraft.client.Minecraft', 'Stopping!'),
    'Game exited with code 0',
  ].join('\n')
  assert.deepEqual(plainClientLog(text, { clock }).split('\n'), [
    'Picked up JAVA_TOOL_OPTIONS: -Dx=1',
    '[T1793416981451] [Render thread/INFO]: Created: 2048x2048x4 minecraft:textures/atlas/blocks.png-atlas',
    '[T1793416984246] [Render thread/INFO]: Stopping!',
    'Game exited with code 0',
  ])
})

test('a throwable follows its line, a multi-line message keeps its lines, entities and "]]>" decode', () => {
  const text = `<log4j:Event logger="a.b" timestamp="5" level="ERROR" thread="main &amp; co">
    <log4j:Message><![CDATA[line one
line two ]]>]]&gt;<![CDATA[ three &amp; four]]></log4j:Message>
    <log4j:Throwable><![CDATA[java.lang.RuntimeException: boom
\tat a.b.C.d(C.java:1)
]]></log4j:Throwable>
  </log4j:Event>`
  assert.equal(plainClientLog(text, { clock }),
    '[T5] [main & co/ERROR]: line one\nline two ]]> three &amp; four\njava.lang.RuntimeException: boom\n\tat a.b.C.d(C.java:1)')
})

test('a tail that starts inside an event drops the torn event and keeps the whole ones', () => {
  const torn = `    <log4j:Message><![CDATA[Created: 1024x512x0 items]]></log4j:Message>\n  </log4j:Event>\n${event(7, 'WARN', 'Worker-1', 'x', 'slow')}`
  assert.deepEqual(plainClientLines(torn.split('\n'), { clock }), ['[T7] [Worker-1/WARN]: slow'])
})

test('plain text is returned untouched, and the clock prints HH:MM:SS or a placeholder', () => {
  const plain = '[12:00:00] [main/INFO]: already plain\nError: could not create the Java Virtual Machine'
  assert.equal(plainClientLog(plain), plain)
  assert.match(clockTime(Date.now()), /^\d\d:\d\d:\d\d$/)
  const d = new Date(2026, 9, 31, 21, 3, 1)
  assert.equal(clockTime(d.getTime()), '21:03:01')
  assert.equal(clockTime(NaN), '??:??:??')
})
