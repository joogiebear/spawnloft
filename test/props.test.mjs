import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseProps, writeProps, readProps, worldDirs } from '../src/props.mjs'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-props-'))

test('comments, blanks and lines with no equals are skipped', () => {
  const map = parseProps('#Minecraft server properties\n!legacy comment\n\nnot a pair\nserver-port=25565\n')
  assert.deepEqual([...map], [['server-port', '25565']])
})

test('the key is trimmed; the value is kept verbatim after the first equals', () => {
  const map = parseProps('motd =A server with = in it \n')
  assert.equal(map.get('motd'), 'A server with = in it ')
})

test('both line endings parse the same', () => {
  assert.deepEqual(parseProps('a=1\r\nb=2\r\n'), parseProps('a=1\nb=2\n'))
})

const ORIGINAL = [
  '#Minecraft server properties',
  '#Sat Aug 30 12:00:00 CDT 2026',
  'server-port=25565',
  'motd=A Minecraft Server',
  'level-name=world',
  '',
].join('\n')

test('an update edits its line in place, keeping comments and order', () => {
  const file = path.join(scratch(), 'server.properties')
  fs.writeFileSync(file, ORIGINAL)
  writeProps(file, { motd: 'hello=world' })
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  assert.equal(lines[0], '#Minecraft server properties')
  assert.equal(lines[2], 'server-port=25565')
  assert.equal(lines[3], 'motd=hello=world')
  assert.equal(lines[4], 'level-name=world')
})

test('a key the file does not have is appended, and the file ends in one newline', () => {
  const file = path.join(scratch(), 'server.properties')
  fs.writeFileSync(file, ORIGINAL)
  writeProps(file, { 'max-players': '10' })
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /\nmax-players=10\n$/)
  assert.ok(!text.endsWith('\n\n'), 'blank lines should not pile up at the end')
})

test('touching one key twice does not scramble the rest', () => {
  const file = path.join(scratch(), 'server.properties')
  fs.writeFileSync(file, ORIGINAL)
  writeProps(file, { motd: 'first' })
  writeProps(file, { motd: 'second' })
  const map = readProps(file)
  assert.equal(map.get('motd'), 'second')
  assert.equal(map.get('server-port'), '25565')
})

test('writing to a file that does not exist yet creates it', () => {
  const file = path.join(scratch(), 'server.properties')
  writeProps(file, { 'server-port': '25570' })
  assert.deepEqual([...readProps(file)], [['server-port', '25570']])
})

test('reading a missing file is an empty map, not an error', () => {
  assert.deepEqual([...readProps(path.join(scratch(), 'nope.properties'))], [])
})

test('world directories follow level-name, with a fallback', () => {
  assert.deepEqual(worldDirs(new Map([['level-name', 'rpg']])), ['rpg', 'rpg_nether', 'rpg_the_end'])
  assert.deepEqual(worldDirs(new Map()), ['world', 'world_nether', 'world_the_end'])
})
