import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

import { CODE_ROOT, resolveRoots } from './settings.mjs'

/**
 * Every location mcctl uses, resolved once at startup from settings.
 *
 * <p>Resolved at import rather than per call: these are read on nearly every operation, and a data
 * root that could change underneath a running process would mean an instance created in one
 * directory and looked for in another. Changing locations takes effect on restart, which is also
 * the only point at which moving servers between drives could be safe.
 */
const roots = resolveRoots()

/**
 * Where the code lives — NOT where data lives.
 *
 * <p>The two were the same thing until data locations became configurable, and they are still the
 * same on an existing checkout. Anything that needs to invoke mcctl itself (the generated .bat
 * launchers) wants this; anything that reads or writes user data wants the roots below.
 */
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

/** The resolved layout, for `mcctl config` and the panel's settings screen. */
export const LAYOUT = roots

/** Per-instance runtime scratch: pid/state file, captured console. */
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

/**
 * The longest path a unix socket may have, in bytes. The kernel's sun_path is 108 bytes on Linux
 * and 104 on macOS, and both counts include the terminating NUL.
 */
export const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107

/**
 * Where a socket goes when the place it belongs is too long a path to bind.
 *
 * <p>A data root deep inside a home folder, plus run/<name>/control.sock, passes the limit sooner
 * than it looks - and what the kernel says then is EINVAL, which reads as a bug in SpawnLoft rather
 * than as a long folder name. The stand-in is named by a hash of the path it replaces, so the
 * daemon and everything that talks to it arrive at the same place without having to agree on
 * anything first. The folder is this user's alone and is checked to be: /tmp is shared, and a
 * folder somebody else made there first is a way to be handed another user's control channel.
 */
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

/**
 * Control channel the daemon listens on for stdin injection and shutdown.
 * Named pipe on Windows, unix socket elsewhere.
 */
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
