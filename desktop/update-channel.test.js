'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const channel = require('./update-channel')

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-channel-'))
process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }))
let n = 0
const fresh = () => path.join(folder, `nested-${n++}`, 'update-channel.json')

test('with no choice made, a copy follows what it already followed', () => {
  // installed copies must keep following what they already followed
  assert.deepEqual(channel.describe(fresh(), '1.1.0'), { beta: false, chosen: false, onBetaBuild: false, waitingFor: null })
  assert.deepEqual(channel.describe(fresh(), '1.2.0-beta.63'), { beta: true, chosen: false, onBetaBuild: true, waitingFor: null })
})

test('a stable copy that opts in follows betas, and one that opts out again simply stops', () => {
  const file = fresh()
  channel.save(file, true)
  assert.deepEqual(channel.describe(file, '1.1.0'), { beta: true, chosen: true, onBetaBuild: false, waitingFor: null })
  channel.save(file, false)
  assert.deepEqual(channel.describe(file, '1.1.0'), { beta: false, chosen: true, onBetaBuild: false, waitingFor: null })
})

test('a beta copy that opts out is told which release it is waiting for', () => {
  const file = fresh()
  channel.save(file, false)
  assert.deepEqual(channel.describe(file, '1.2.0-beta.63'), { beta: false, chosen: true, onBetaBuild: true, waitingFor: '1.2.0' })
  // the choice outlives the update that ends the wait
  assert.deepEqual(channel.describe(file, '1.2.0'), { beta: false, chosen: true, onBetaBuild: false, waitingFor: null })
})

test('a file that is not ours counts as no choice', () => {
  for (const text of ['', 'not json', '{"beta":"yes"}', '[]', 'null']) {
    const file = fresh()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    assert.equal(channel.load(file), null, JSON.stringify(text))
  }
})

test('the updater is never given a channel, and never allowed to downgrade', () => {
  // electron-updater switches allowDowngrade on when `channel` is assigned, which would reinstall
  // the last stable over a newer data folder when opting out of betas
  const updater = { allowDowngrade: true }
  let channelAssigned = false
  Object.defineProperty(updater, 'channel', { set() { channelAssigned = true }, get() { return null } })
  channel.apply(updater, true)
  assert.equal(updater.allowPrerelease, true)
  assert.equal(updater.allowDowngrade, false)
  channel.apply(updater, false)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(channelAssigned, false)
})
