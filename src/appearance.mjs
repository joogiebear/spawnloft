import * as settings from './settings.mjs'
import { fail } from './util.mjs'

export const THEMES = Object.freeze(['classic', 'spawnloft'])

// older settings files have no theme, and an unknown value must not become an arbitrary HTML attribute
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'classic'
}

export function readTheme() {
  return normalizeTheme(settings.load().theme)
}

export function saveTheme(value) {
  if (!THEMES.includes(value)) fail('Choose Classic or SpawnLoft for the application theme.')
  settings.save({ theme: value })
  return value
}
