import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patternsFor, scanConsole, READY_RE } from '../src/ready.mjs'

const server = patternsFor(null)

test('a ready line is found in one read', () => {
  assert.equal(scanConsole('', '[12:00:01] [Server thread/INFO]: Done (4.321s)! For help, type "help"\n', server).ready, 'Done (4.321s)!')
})

test('a ready line split across two reads is still found', () => {
  const first = scanConsole('', '[12:00:01] [Server thread/INFO]: Done (4.3', server)
  assert.equal(first.ready, undefined)
  assert.equal(first.failed, undefined)
  assert.equal(scanConsole(first.carry, '21s)! For help, type "help"\n', server).ready, 'Done (4.321s)!')
})

test('a failure line split across reads is found too', () => {
  const first = scanConsole('', 'Error: A fatal error has occ', server)
  const second = scanConsole(first.carry, 'urred\n', server)
  assert.match(second.failed, /A fatal error has occurred/)
})

test('the carry stays short however much has been read', () => {
  let carry = ''
  for (let i = 0; i < 200; i++) carry = scanConsole(carry, 'x'.repeat(1000) + '\n', server).carry
  assert.ok(carry.length <= 512, String(carry.length))
})

test('ready wins when one read holds both, and a plain line finds nothing', () => {
  assert.ok(scanConsole('', 'Done (1.0s)!\nFailed to start the minecraft server', server).ready)
  assert.deepEqual(scanConsole('', 'Loading libraries, please wait...\n', server), { carry: 'Loading libraries, please wait...\n' })
})

test('database patterns scan the same way', () => {
  const maria = patternsFor({ kind: 'database', engine: 'mariadb' })
  const first = scanConsole('', 'mariadbd: ready for conn', maria)
  assert.ok(scanConsole(first.carry, 'ections. Version: 11\n', maria).ready)
  assert.ok(READY_RE.test('Done (0.5s)!'))
})
