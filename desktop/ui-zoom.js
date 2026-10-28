'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Steps instead of free scaling: each one is a size a person can name, and 100% is always one
// press of Ctrl+0 away.
const STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

// The default: a step picked from the screen the window is on, re-picked when that changes.
const AUTO = 'auto'

function clamp(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 1)
}

// 'auto', or a step. Anything else is 100%.
function normalize(value) {
  return value === AUTO ? AUTO : clamp(value)
}

// Which step suits a display. `size` is in device-independent pixels, so the OS's own scaling is
// already taken out: a 4K monitor the OS scales to 150% reports 2560 wide and is treated like any
// QHD screen. The table, widest first, is the first row whose width the display reaches; a short
// laptop screen (1366x768) goes to 90%, which puts a fourth vital and a wider console back in reach.
// A QHD screen at OS 100% gets 125%: at 100% the panel read small on one, with text the size of a
// 1080p screen's on a panel a third wider. A 4K panel at OS 100% reads 3840 and gets 175%, at
// OS 125% it reads 3072 and gets 150%.
const AUTO_TABLE = [
  { minWidth: 3400, zoom: 1.75 },
  { minWidth: 2800, zoom: 1.5 },
  { minWidth: 2400, zoom: 1.25 },
]
const SHORT_HEIGHT = 800

function autoStep(display) {
  const width = Number(display?.size?.width) || 0
  const height = Number(display?.size?.height) || 0
  const row = AUTO_TABLE.find((r) => width >= r.minWidth)
  if (row) return row.zoom
  if (height > 0 && height < SHORT_HEIGHT) return 0.9
  return 1
}

// The factor to apply for a setting on a display.
function resolve(setting, display) {
  return setting === AUTO ? autoStep(display) : clamp(setting)
}

function step(current, direction) {
  const at = STEPS.indexOf(clamp(current))
  return STEPS[Math.min(STEPS.length - 1, Math.max(0, at + direction))]
}

// No file means the size was never chosen, and Auto is what a fresh install gets. A file from
// before Auto existed holds a number and keeps it: a size someone picked stays picked.
function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')).zoom)
  } catch {
    return AUTO
  }
}

function save(file, zoom) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ zoom: normalize(zoom) }) + '\n')
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

module.exports = { STEPS, AUTO, AUTO_TABLE, clamp, normalize, autoStep, resolve, step, load, save, zoomForKey }
