import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs } from '../src/args.mjs'

test('declared boolean flags never swallow an instance name or another positional argument', () => {
  assert.deepEqual(parseArgs(['--follow', 'royalplugins', '--json'], { booleanFlags: ['follow', 'json'] }),
    { flags: { follow: true, json: true }, positional: ['royalplugins'] })
})

test('bare words are positional, in order', () => {
  assert.deepEqual(parseArgs(['stock', 'extra']), { flags: {}, positional: ['stock', 'extra'] })
})

test('a --flag with nothing after it is true', () => {
  assert.deepEqual(parseArgs(['--force']).flags, { force: true })
})

test('a --flag consumes the next arg as its value', () => {
  assert.deepEqual(parseArgs(['--port', '8771']).flags, { port: '8771' })
})

test('a --flag does not consume something that looks like another flag', () => {
  assert.deepEqual(parseArgs(['--label', '--force']).flags, { label: true, force: true })
})

test('--key=value keeps everything after the first equals, verbatim', () => {
  assert.deepEqual(parseArgs(['--motd=a=b']).flags, { motd: 'a=b' })
  assert.deepEqual(parseArgs(['--label=']).flags, { label: '' })
})

test('kebab-case becomes camelCase', () => {
  assert.deepEqual(parseArgs(['--keep-jars']).flags, { keepJars: true })
  assert.deepEqual(parseArgs(['--paper-version', '26.2']).flags, { paperVersion: '26.2' })
})

// The "no-" prefix negates the BASE name: --no-open sets `open`, not `noOpen`. Any command
// reading flags.noOpen is reading a key this parser never writes - which is exactly the
// mcctl ui bug - so this is the contract, pinned.
test('a no- prefix negates the base flag name', () => {
  assert.deepEqual(parseArgs(['--no-open']).flags, { open: false })
  assert.deepEqual(parseArgs(['--no-keep-jars']).flags, { keepJars: false })
})

test('short flags take a value when one follows, else true', () => {
  assert.deepEqual(parseArgs(['-n', '40']).flags, { n: '40' })
  assert.deepEqual(parseArgs(['-v']).flags, { v: true })
})

test('everything after -- is positional, even things shaped like flags', () => {
  assert.deepEqual(parseArgs(['send', '--', '--not-a-flag']), {
    flags: {},
    positional: ['send', '--not-a-flag'],
  })
})
