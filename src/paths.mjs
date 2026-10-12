import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

import { CODE_ROOT, resolveRoots } from './settings.mjs'

// Resolved once at import: a data root that changed under a running process would create an instance
// in one directory and look for it in another. Changes take effect on restart.
const roots = resolveRoots()

// Where the code lives, not data. For invoking mcctl itself (the generated .bat launchers); user
// data goes under the roots below.
export const ROOT = CODE_ROOT

export const DATA_ROOT = roots.dataRoot
export const REGISTRY_FILE = roots.registryFile
export const INSTANCES_DIR = roots.instancesDir
export const TEMPLATES_DIR = roots.templatesDir
export const JARS_DIR = roots.jarsDir
export const BACKUPS_DIR = roots.backupsDir
export const RUN_DIR = roots.runDir
export const ENGINES_DIR = roots.enginesDir
export const SERVICES_DIR = roots.servicesDir

// the resolved layout, for `mcctl config` and the panel's settings screen
export const LAYOUT = roots

// per-instance runtime scratch: pid/state file, captured console
export function runDir(name) {
  return path.join(RUN_DIR, name)
}

export function stateFile(name) {
  return path.join(runDir(name), 'state.json')
}

export function consoleLog(name) {
  return path.join(runDir(name), 'console.log')
}

export function daemonLog(name) {
  return path.join(runDir(name), 'daemon.log')
}

// unix socket paths are limited by sun_path: 108 bytes on Linux, 104 on macOS, both including the NUL
export const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107

// A deep data root plus run/<name>/control.sock can pass the socket path limit, and the kernel's
// EINVAL then looks like a SpawnLoft bug. The stand-in is named by a hash of the original path so the
// daemon and its clients agree without coordinating. The folder must be this user's alone: /tmp is
// shared, and a folder someone else made there first could hand over another user's control channel.
export function shortSocketPath(natural, { base = '/tmp', uid = process.getuid() } = {}) {
  const dir = path.join(base, `spawnloft-${uid}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error(`Cannot use the socket directory ${dir}: it is not a private folder of this user`)
  }
  fs.chmodSync(dir, 0o700)
  return path.join(dir, crypto.createHash('sha256').update(natural).digest('hex').slice(0, 20) + '.sock')
}

// named pipe on Windows, unix socket elsewhere
export function controlPath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\mcctl-${name}`
  const natural = path.join(runDir(name), 'control.sock')
  return Buffer.byteLength(natural) <= SOCKET_PATH_MAX ? natural : shortSocketPath(natural)
}

export function ensureDirs() {
  for (const d of [INSTANCES_DIR, TEMPLATES_DIR, JARS_DIR, BACKUPS_DIR, RUN_DIR, ENGINES_DIR, SERVICES_DIR]) {
    fs.mkdirSync(d, { recursive: true })
  }
}
