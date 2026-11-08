// Which daemon supervises a server, and how it is started (v2 branch, internal phase).
//
// SPAWNLOFT_DAEMON=rust (or "daemon": "rust" in settings.json) starts the Rust daemon,
// `spawnloft-core daemon <name>`; anything else, or nothing, starts daemon.mjs as before. The Rust
// one is told the data root this process resolved and the runtime to run `.mjs` stand-in programs
// with (the lifecycle tests' fake java, the fake engines), since the packaged app has no `node`.
// A database's launch spec is worked out here, by the same engine modules daemon.mjs uses, and
// handed over on the daemon's stdin, so no password is written to disk or shown in a process list.
//
// Falling back to daemon.mjs happens only when the binary provably never ran (missing, not
// executable, not a program for this machine) and is never silent: a line goes to panel.log and
// to the server's daemon.log.
import fs from 'node:fs'
import path from 'node:path'
import { CODE_ROOT, load as loadSettings } from './settings.mjs'
import { DATA_ROOT, RUN_DIR, daemonLog } from './paths.mjs'

export const CORE_EXE = process.platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core'

// spawn errors that prove nothing was launched
export const FALLBACK_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'UNKNOWN'])

export function daemonChoice(env = process.env, settings = null) {
  const said = env.SPAWNLOFT_DAEMON || (settings ?? safeSettings()).daemon
  return said === 'rust' ? 'rust' : 'node'
}

function safeSettings() {
  try {
    return loadSettings()
  } catch {
    return {}
  }
}

// Where the binary is: SPAWNLOFT_CORE_BIN; beside the packaged core (resources/bin on Windows and
// Linux, the CLI package's bin/); Contents/MacOS in the Mac app; a cargo build in a checkout (the
// newer of release and debug). The first candidate is returned when none exists, so the spawn
// fails with ENOENT and the fallback says which path was missing.
export function coreBinary(env = process.env, root = CODE_ROOT) {
  if (env.SPAWNLOFT_CORE_BIN) return path.resolve(env.SPAWNLOFT_CORE_BIN)
  const packaged = [
    path.join(root, '..', 'bin', CORE_EXE),
    ...(process.platform === 'darwin' ? [path.join(root, '..', '..', 'MacOS', CORE_EXE)] : []),
  ]
  for (const p of packaged) if (fs.existsSync(p)) return p
  const built = ['release', 'debug']
    .map((profile) => path.join(root, 'rust', 'target', profile, CORE_EXE))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return built[0] ?? packaged[0]
}

// The env entries of `full` that differ from this process's own; the daemon inherits the rest.
function envDelta(full) {
  const out = {}
  for (const [k, v] of Object.entries(full ?? {})) {
    if (v !== undefined && process.env[k] !== v) out[k] = String(v)
  }
  return out
}

// A database's program as the Rust daemon reads it (src/daemon/program.rs in rust/).
export async function databaseSpec(inst) {
  const engines = {
    mariadb: () => import('./mariadb.mjs'),
    garnet: () => import('./garnet.mjs'),
    mysql: () => import('./mysql.mjs'),
  }
  const load = engines[inst.engine]
  if (!load) throw new Error(`Unknown database engine: ${inst.engine}`)
  const spec = (await load()).launchSpec(inst)
  let stop = null
  if (spec.stop?.stdin) stop = { stdin: spec.stop.stdin }
  else if (spec.stop?.cmd) stop = { cmd: spec.stop.cmd, args: spec.stop.args ?? [], env: envDelta(spec.stop.env) }
  else if (spec.stop?.resp) stop = { resp: spec.stop.resp }
  return { cmd: spec.cmd, args: spec.args ?? [], env: envDelta(spec.env), cwd: spec.cwd, stop }
}

export function rustDaemonArgs(name, { database = false } = {}) {
  return ['daemon', name, '--data-root', DATA_ROOT, '--node', process.execPath, ...(database ? ['--spec', '-'] : [])]
}

// Never silent: panel.log for doctor and the panel, daemon.log for whoever reads this server's.
export function noteFallback(name, message) {
  const line = `[${new Date().toISOString()}] daemon: ${message}\n`
  for (const file of [path.join(RUN_DIR, 'panel.log'), daemonLog(name)]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line)
    } catch {
      /* best-effort, like every log here */
    }
  }
}
