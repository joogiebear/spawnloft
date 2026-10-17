// Run: node ui-zoom.test.js (or npm test, from desktop/)
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const z = require('./ui-zoom')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-zoom-'))
const file = path.join(tmp, 'ui-zoom.json')
let pass = 0
const check = (label, fn) => {
  try { fn(); console.log('  ok   ' + label); pass++ }
  catch (e) { console.log('  FAIL ' + label + ' -> ' + e.message); process.exitCode = 1 }
}

check('garbage and missing values mean 100%', () => {
  assert.strictEqual(z.clamp('big'), 1)
  assert.strictEqual(z.clamp(NaN), 1)
  assert.strictEqual(z.load(file), 1)
})

check('an off-step value snaps to the nearest step and the ends hold', () => {
  assert.strictEqual(z.clamp(1.2), 1.25)
  assert.strictEqual(z.clamp(9), 2)
  assert.strictEqual(z.clamp(0.1), 0.8)
  assert.strictEqual(z.step(2, 1), 2)
  assert.strictEqual(z.step(0.8, -1), 0.8)
  assert.strictEqual(z.step(1, 1), 1.1)
  assert.strictEqual(z.step(1, -1), 0.9)
})

check('the size round-trips through the file', () => {
  z.save(file, 1.5)
  assert.strictEqual(z.load(file), 1.5)
  fs.writeFileSync(file, 'not json')
  assert.strictEqual(z.load(file), 1)
})

check('only Ctrl/Cmd zoom keys on key-down are claimed', () => {
  const key = (o) => z.zoomForKey({ type: 'keyDown', control: true, ...o }, 1)
  assert.strictEqual(key({ key: '=' }), 1.1)
  assert.strictEqual(key({ key: '+' }), 1.1)
  assert.strictEqual(key({ key: '-' }), 0.9)
  assert.strictEqual(z.zoomForKey({ type: 'keyDown', control: true, key: '0' }, 1.5), 1)
  assert.strictEqual(z.zoomForKey({ type: 'keyDown', control: true, key: 'à', code: 'Digit0' }, 1.5), 1)
  assert.strictEqual(z.zoomForKey({ type: 'keyDown', meta: true, key: '_' }, 1), 0.9)
  assert.strictEqual(key({ key: 'c' }), null)
  assert.strictEqual(z.zoomForKey({ type: 'keyUp', control: true, key: '=' }, 1), null)
  assert.strictEqual(z.zoomForKey({ type: 'keyDown', key: '=' }, 1), null)
  assert.strictEqual(z.zoomForKey({ type: 'keyDown', control: true, alt: true, key: '=' }, 1), null)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n  ' + pass + '/4 passed')
