// The first-run wizard (src/setup.html) when the window is the Tauri shell: the same three calls
// Electron answers in desktop/main.js (getSetup, saveSetup, checkJava), served by the panel at
// /api/setup so the window needs no Node of its own. The shell asks `needed` once the panel is up
// and shows /setup instead of / when it is true; after a save it restarts the core, because the
// data root is resolved once at import (paths.mjs).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as settings from './settings.mjs'
import * as java from './java.mjs'

const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The same rule as Electron's needsSetup: settings.json survives an uninstall and the data folder
// may be on an unplugged drive, so a saved root only counts if it still exists; a checkout that
// already has instances.json is configured.
export function needsSetup() {
  const saved = settings.load()
  if (saved.dataRoot && fs.existsSync(saved.dataRoot)) return false
  return !fs.existsSync(path.join(CORE_DIR, 'instances.json'))
}

export function getSetup() {
  return {
    needed: needsSetup(),
    defaultDataRoot: settings.defaultDataRoot(),
    current: settings.resolveRoots(),
    coreDir: CORE_DIR,
    coreMode: 'bundled',
    // nobody sees stderr in the desktop app, so an unreadable settings file is reported to the wizard
    settingsProblem: settings.inspect(),
  }
}

export async function checkJava() {
  return { ...(await java.health()), downloadUrl: java.DOWNLOAD_URL }
}

// { ok } or { ok: false, error }; the caller (the shell) restarts the core on ok
export function saveSetup(body) {
  const dataRoot = typeof body?.dataRoot === 'string' ? body.dataRoot : ''
  const separate = body?.separate === true
  const instancesDir = separate && typeof body?.instancesDir === 'string' ? body.instancesDir : null
  if (!dataRoot || !path.isAbsolute(dataRoot)) return { ok: false, error: 'Choose a folder for SpawnLoft\'s files.' }
  if (separate && (!instancesDir || !path.isAbsolute(instancesDir))) return { ok: false, error: 'Choose a folder for the servers.' }

  // write-test the folders: unplugged drives, read-only mounts and network shares look fine
  // until the first write
  for (const dir of [dataRoot, instancesDir].filter(Boolean)) {
    const check = settings.checkWritable(dir)
    if (!check.ok) return { ok: false, error: `Cannot write to ${dir}\n${check.error}` }
  }
  try {
    settings.save({ dataRoot, separateInstances: separate, instancesDir }, { replaceUnreadable: true })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  // read back: a write that did not land (read-only roaming profile, a sync client holding the
  // file) would silently restart on the default location
  const written = settings.load()
  if (path.resolve(written.dataRoot ?? '') !== path.resolve(dataRoot)) {
    return {
      ok: false,
      error: `SpawnLoft could not remember that location.\n\nIt saved to ${settings.settingsFile()} but read back ` +
        `${written.dataRoot ? `"${written.dataRoot}"` : 'nothing'}. Check that file is writable, then try again.`,
    }
  }
  return { ok: true }
}
