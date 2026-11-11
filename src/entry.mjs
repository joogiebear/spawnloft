import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './paths.mjs'

// How anything written to disk runs this command line again: task shims, server launchers, the
// launchd and systemd units, runtime.json and the MCP config the panel shows.
//
// In a 2.0 install the Node core only ever runs under `spawnloft-core`, the install's one entry
// point, which sets SPAWNLOFT_ENTRY to its own absolute path. Those files then name that binary
// and never a Node path, so they keep working when 2.1 takes the bundled Node out of the package
// (PLAN-2.0-REMAINING.md A5). Without it (a checkout run with `node spawnloft.mjs`, a 1.x
// desktop build) they name the running executable and mcctl.mjs, as before.
export const ENTRY_ENV = 'SPAWNLOFT_ENTRY'

export function entryBinary(env = process.env) {
  const entry = env[ENTRY_ENV]
  if (!entry || !path.isAbsolute(entry)) return null
  try {
    return fs.statSync(entry).isFile() ? entry : null
  } catch {
    return null
  }
}

// { exe, args, env, viaEntry }: run `exe ...args <command...>` with `env` added.
export function cliCommand({ env = process.env, execPath = process.execPath, electron = Boolean(process.versions.electron) } = {}) {
  const entry = entryBinary(env)
  if (entry) return { exe: entry, args: [], env: {}, viaEntry: true }
  return {
    exe: execPath,
    args: [path.join(ROOT, 'mcctl.mjs')],
    // Electron runs scripts as Node only with this variable; plain node ignores it
    env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    viaEntry: false,
  }
}

// The lines of a .cmd that run `<cli> <rest>`: any environment the runner needs, then the command.
// A plain Node checkout keeps the bare `node` (a PATH lookup), as it always did; a bundled or
// entry-point runner is named by its full path.
// Paths are written with `%` doubled: in a batch file a single `%` starts a variable, so a folder
// named `100%` would otherwise break the line.
export function windowsRun(cli, rest) {
  const batch = (text) => String(text).replaceAll('%', '%%')
  const runner = !cli.viaEntry && /[\\/]node(?:\.exe)?$/i.test(cli.exe) ? 'node' : `"${batch(cli.exe)}"`
  return [
    ...Object.entries(cli.env).map(([key, value]) => `set ${key}=${batch(value)}`),
    [runner, ...cli.args.map((a) => `"${batch(a)}"`), rest].join(' '),
  ]
}
