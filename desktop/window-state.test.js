// window-state.js takes the display list as an argument, so these tests pass fictional monitors.
// Run: node window-state.test.js (or npm test, from desktop/)
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ws = require('./window-state')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-ws-'))
const file = path.join(tmp, 'window-state.json')
const write = (o) => fs.writeFileSync(file, JSON.stringify(o))

// two 2560x1392 displays side by side
const TWO = [{ x: 0, y: 0, width: 2560, height: 1392 }, { x: 2560, y: 0, width: 2560, height: 1392 }]
const ONE = [{ x: 0, y: 0, width: 2560, height: 1392 }]

let pass = 0
const check = (label, fn) => {
  try { fn(); console.log('  ok   ' + label); pass++ }
  catch (e) { console.log('  FAIL ' + label + ' -> ' + e.message); process.exitCode = 1 }
}

check('no saved state gives the defaults', () => {
  fs.rmSync(file, { force: true })
  const s = ws.load(file, TWO)
  assert.deepStrictEqual(s, { width: 1280, height: 820, maximized: false })
})

check('corrupt state falls back rather than throwing', () => {
  fs.writeFileSync(file, 'not json at all')
  assert.strictEqual(ws.load(file, TWO).width, 1280)
})

check('a saved size and position round-trips', () => {
  write({ x: 300, y: 200, width: 1500, height: 900, maximized: false })
  assert.deepStrictEqual(ws.load(file, TWO), { width: 1500, height: 900, maximized: false, x: 300, y: 200 })
})

check('a position on the second monitor is kept', () => {
  write({ x: 3000, y: 150, width: 1280, height: 820, maximized: false })
  assert.strictEqual(ws.load(file, TWO).x, 3000)
})

check('that same position is DROPPED once that monitor is gone', () => {
  write({ x: 3000, y: 150, width: 1280, height: 820, maximized: false })
  const s = ws.load(file, ONE)
  assert.strictEqual(s.x, undefined, 'x should be dropped')
  assert.strictEqual(s.y, undefined, 'y should be dropped')
  assert.strictEqual(s.width, 1280, 'size is still honoured')
})

check('a window dragged mostly off-screen is not restored there', () => {
  write({ x: -1250, y: 100, width: 1280, height: 820, maximized: false })
  assert.strictEqual(ws.load(file, ONE).x, undefined)
})

check('a size below the minimum is raised to it', () => {
  write({ x: 10, y: 10, width: 300, height: 200, maximized: false })
  const s = ws.load(file, ONE)
  assert.strictEqual(s.width, 900)
  assert.strictEqual(s.height, 600)
})

check('maximised is remembered', () => {
  write({ x: 10, y: 10, width: 1400, height: 900, maximized: true })
  assert.strictEqual(ws.load(file, ONE).maximized, true)
})

check('garbage numbers do not produce NaN bounds', () => {
  write({ x: 'left', y: null, width: 'wide', height: {}, maximized: 'yes' })
  const s = ws.load(file, ONE)
  assert.strictEqual(s.width, 1280)
  assert.strictEqual(s.height, 820)
  assert.strictEqual(s.x, undefined)
  assert.strictEqual(s.maximized, false)
})

check('track() writes what a window reports, and only after it settles', () => {
  const fake = {
    handlers: {},
    isDestroyed: () => false,
    isMaximized: () => false,
    getNormalBounds: () => ({ x: 42, y: 43, width: 1111, height: 777 }),
    on(ev, fn) { this.handlers[ev] = fn },
  }
  fs.rmSync(file, { force: true })
  ws.track(fake, file)
  fake.handlers.resize()
  assert.ok(!fs.existsSync(file), 'nothing written yet - the drag is still in progress')
  fake.handlers.close()
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(saved, { x: 42, y: 43, width: 1111, height: 777, maximized: false })
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n  ' + pass + '/10 passed')
