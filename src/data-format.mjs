import fs from 'node:fs'
import path from 'node:path'

import { DATA_ROOT } from './paths.mjs'

// SpawnLoft 2.0 keeps <data root>/data-format.json, { "writtenBy": "2.0.0", "format": 1 }, naming
// the newest release that wrote the data folder. 1.x never writes it; it reads it so that someone
// who went to 2.0 and came back is told the folder was last used by a newer SpawnLoft and what to
// check. A warning, never a refusal: the formats are the same, and refusing would lock people out
// of their own servers.

// the data format this release reads and writes; 2.0 starts at 1 too
export const DATA_FORMAT = 1

export function dataFormatFile(root = DATA_ROOT) {
  return path.join(root, 'data-format.json')
}

// null when there is no marker; unknown fields are kept and ignored
export function readDataFormat(file = dataFormatFile()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// this release's version, from the package.json beside src/
export function releaseVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function major(version) {
  const m = /^v?(\d+)\./.exec(String(version ?? ''))
  return m ? Number(m[1]) : null
}

// One sentence, or null when there is nothing to say: no marker, or one from this major or older.
export function dataFormatWarning({ file = dataFormatFile(), marker = readDataFormat(file), version = releaseVersion() } = {}) {
  if (!marker) return null
  const theirs = major(marker.writtenBy)
  const ours = major(version)
  const newerRelease = theirs !== null && ours !== null && theirs > ours
  const newerFormat = Number.isInteger(marker.format) && marker.format > DATA_FORMAT
  if (!newerRelease && !newerFormat) return null
  const who = typeof marker.writtenBy === 'string' ? `SpawnLoft ${marker.writtenBy}` : 'a newer SpawnLoft'
  return `this data folder was last used by ${who} (${file}). This version can still run it, but ` +
    'servers, tasks or settings made there may not show up or may behave differently here. ' +
    'SpawnLoft points scheduled tasks and launchers back at this version when it starts; if a task ' +
    'still does not run, run "spawnloft repair".'
}
