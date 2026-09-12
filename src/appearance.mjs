import * as settings from './settings.mjs'
import { fail } from './util.mjs'

export const THEMES = Object.freeze(['classic', 'spawnloft'])

// An older settings file has no theme. An unknown value must not select an
// arbitrary HTML attribute or leave the app without a usable palette.
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
