'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Steps instead of free scaling: each one is a size a person can name, and 100% is always one
// press of Ctrl+0 away.
const STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function clamp(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 1)
}

function step(current, direction) {
  const at = STEPS.indexOf(clamp(current))
  return STEPS[Math.min(STEPS.length - 1, Math.max(0, at + direction))]
}

function load(file) {
  try {
    return clamp(JSON.parse(fs.readFileSync(file, 'utf8')).zoom)
  } catch {
    return 1
  }
}

function save(file, zoom) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ zoom: clamp(zoom) }) + '\n')
  } catch {
    // an unsaved size is a smaller problem than an error on every keypress
  }
}

// Ctrl/Cmd with + = - _ 0 and the numpad. Returns the new zoom, or null when the key is not a zoom key.
function zoomForKey(input, current) {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null
  if (input.key === '+' || input.key === '=') return step(current, 1)
  if (input.key === '-' || input.key === '_') return step(current, -1)
  // code as well as key: on AZERTY the unshifted 0 key reports 'à', and with NumLock off the numpad 0 reports 'Insert'
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 1
  return null
}

module.exports = { STEPS, clamp, step, load, save, zoomForKey }
