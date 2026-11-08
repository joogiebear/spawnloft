'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const majorUpdate = require('./major-update')

// pure, so it runs without node_modules; major-update-feed.test.cjs drives the real updater

test('only a higher major counts; versions this code cannot read count too', () => {
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0', '1.7.1'), false)
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0', '1.8.0-beta.3'), false)
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0-beta.4', '2.0.0-beta.1'), true)
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0', 'v2.0.0'), true)
  assert.equal(majorUpdate.isMajorUpgrade('2.0.0', '1.9.0'), false)
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0', 'nonsense'), true)
  assert.equal(majorUpdate.isMajorUpgrade('1.7.0', undefined), true)
})
