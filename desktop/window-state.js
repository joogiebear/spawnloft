'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_BOUNDS = { width: 1280, height: 820 }
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

// A saved position may point at a monitor that is no longer attached. It only counts if enough of
// the window (a grabbable title bar, not a pixel) overlaps some display's work area; otherwise
// the position is dropped and the window is centred. `displays` is passed in so tests can supply
// arrangements.
function isVisibleSomewhere(bounds, displays) {
  return displays.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return overlapX > 120 && overlapY > 40
  })
}

// `defaults` is the size a window opens at the first time (the launcher's differs from the panel's).
function load(file, displays, defaults = DEFAULT_BOUNDS) {
  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // missing or unreadable: use defaults
    return { width: defaults.width, height: defaults.height, maximized: false }
  }

  const width = Math.max(MIN_WIDTH, Math.round(Number(saved.width) || defaults.width))
  const height = Math.max(MIN_HEIGHT, Math.round(Number(saved.height) || defaults.height))
  const state = { width, height, maximized: saved.maximized === true }

  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const at = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
    if (isVisibleSomewhere(at, displays)) {
      state.x = at.x
      state.y = at.y
    }
  }
  return state
}

// Debounced: dragging emits a move per frame. getNormalBounds is saved (maximised is stored
// separately) so un-maximising restores the earlier size, not the screen size.
function track(win, file) {
  let timer = null

  const save = () => {
    if (!win || win.isDestroyed()) return
    const normal = win.getNormalBounds()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const state = {
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: win.isMaximized(),
      }
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
    } catch {
      // losing the position is a smaller problem than failing to close
    }
  }

  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 400)
  }

  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, later)
  // 'close', not 'closed': the window still has bounds to read
  win.on('close', () => {
    clearTimeout(timer)
    save()
  })
}

module.exports = { load, track, isVisibleSomewhere, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT }
