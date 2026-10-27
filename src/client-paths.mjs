import path from 'node:path'
import fs from 'node:fs'
import { DATA_ROOT } from './paths.mjs'

export const CLIENT_ROOT = path.join(DATA_ROOT, 'client')
export const PROFILES_FILE = path.join(CLIENT_ROOT, 'profiles.json')
export const LIBRARIES_DIR = path.join(CLIENT_ROOT, 'libraries')
export const ASSETS_DIR = path.join(CLIENT_ROOT, 'assets')
export const NATIVES_DIR = path.join(CLIENT_ROOT, 'natives')
export const ACCOUNTS_FILE = path.join(CLIENT_ROOT, 'accounts.json')

export function profileDir(name) {
  return path.join(CLIENT_ROOT, 'profiles', name)
}

export function versionDir(id) {
  return path.join(CLIENT_ROOT, 'versions', id)
}

export function versionJson(id) {
  return path.join(versionDir(id), `${id}.json`)
}

export function versionJar(id) {
  return path.join(versionDir(id), `${id}.jar`)
}

export function nativesDir(id) {
  return path.join(NATIVES_DIR, id)
}

export function clientRunDir(name) {
  return path.join(CLIENT_ROOT, 'run', name)
}

export function clientStateFile(name) {
  return path.join(clientRunDir(name), 'state.json')
}

export function clientLog(name) {
  return path.join(clientRunDir(name), 'client.log')
}

// Held from the start of launch() until state.json is written, so two launches (two Play
// clicks, panel plus CLI) cannot both pass the "already running" check and start two games.
export function clientLaunchLock(name) {
  return path.join(clientRunDir(name), 'launch.lock')
}

export function clientCacheDir(name) {
  return path.join(clientRunDir(name), 'cache')
}

export function ensureClientDirs() {
  for (const d of [
    CLIENT_ROOT,
    path.join(CLIENT_ROOT, 'profiles'),
    path.join(CLIENT_ROOT, 'versions'),
    LIBRARIES_DIR,
    ASSETS_DIR,
    NATIVES_DIR,
    path.join(CLIENT_ROOT, 'run'),
  ]) {
    fs.mkdirSync(d, { recursive: true })
  }
}
