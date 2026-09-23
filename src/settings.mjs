import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the code lives. Distinct from where data lives — see below. */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where mcctl keeps its own settings.
 *
 * <p>Deliberately NOT next to the code. Once this ships as an installed application the program
 * directory is read-only for the person running it, and the one thing that must be findable before
 * anything else is the file that says where everything else lives.
 */
export function settingsFile() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'mcctl', 'settings.json')
}

export function load() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

export function save(patch) {
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const merged = { ...load(), ...patch }
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n')
  return merged
}

/** The default data location for a fresh install: per-user, writable, and not inside the program. */
export function defaultDataRoot() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'mcctl')
}

/**
 * Resolve every location mcctl uses.
 *
 * <p>Three sources, in order:
 *
 * <ol>
 *   <li><b>Settings</b>, if the person has chosen locations.</li>
 *   <li><b>The code directory</b>, when it already holds an {@code instances.json}. This is what
 *       keeps an existing checkout working after this change: its registry, worlds and backups stay
 *       exactly where they are rather than the tool waking up one day pointed at an empty folder and
 *       reporting no servers.</li>
 *   <li><b>A per-user data directory</b>, for a fresh install.</li>
 * </ol>
 *
 * <p>Servers can live on a different drive from everything else. That is the one split worth
 * supporting directly: worlds and backups are the large, growing things, and the reason to move
 * them is usually that they no longer fit where the program was installed.
 */
export function resolveRoots(overrides = {}) {
  const s = { ...load(), ...overrides }

  const legacy = fs.existsSync(path.join(CODE_ROOT, 'instances.json'))
  // MCCTL_DATA_ROOT wins over everything: it is how the lifecycle tests keep a real daemon, registry
  // and run directory inside a scratch folder instead of the person's own servers. It is inherited
  // by the daemons this process spawns, so they land in the same place.
  const forced = process.env.MCCTL_DATA_ROOT
  const dataRoot = forced ? path.resolve(forced) : s.dataRoot ? path.resolve(s.dataRoot) : legacy ? CODE_ROOT : defaultDataRoot()

  // separateInstances is the toggle: off (default) means servers live with everything else.
  const instancesDir = s.separateInstances && s.instancesDir
    ? path.resolve(s.instancesDir)
    : path.join(dataRoot, 'instances')

  return {
    dataRoot,
    instancesDir,
    separateInstances: Boolean(s.separateInstances && s.instancesDir),
    registryFile: path.join(dataRoot, 'instances.json'),
    templatesDir: path.join(dataRoot, 'templates'),
    jarsDir: path.join(dataRoot, 'jars'),
    // Snapshots are the thing most likely to outgrow the drive everything else is on, so they get
    // the same escape hatch the instances directory has. Changing it does not move what already
    // exists - the panel says so rather than letting history appear to vanish.
    backupsDir: s.backupsDir ? path.resolve(s.backupsDir) : path.join(dataRoot, 'backups'),
    runDir: path.join(dataRoot, 'run'),
    // Database engines (one folder per engine version, shared) and the databases that run on them.
    enginesDir: path.join(dataRoot, 'engines'),
    servicesDir: path.join(dataRoot, 'services'),
    usingLegacyLayout: legacy && !s.dataRoot,
    settingsFile: settingsFile(),
  }
}

/**
 * Other places on this machine that hold a registry with servers in it, when the data root in use
 * holds none.
 *
 * <p>The desktop app resolves its data root once, at launch; the CLI and the MCP server resolve it
 * on every run. So if settings.json changes under a running app - a second copy of SpawnLoft on the
 * same account, a development checkout, a hand edit - the app keeps showing the servers it started
 * with while every fresh process looks somewhere else and reports that nothing exists. That reads
 * as "my servers are gone" when they are one folder away. Checked only where SpawnLoft itself would
 * have put them: the per-user default and the legacy checkout layout.
 */
export function serversElsewhere(dataRoot) {
  const here = path.resolve(dataRoot)
  const found = []
  for (const root of new Set([defaultDataRoot(), CODE_ROOT].map((r) => path.resolve(r)))) {
    if (root === here) continue
    let names = []
    try {
      names = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf8')).instances ?? {})
    } catch {
      continue
    }
    if (names.length) found.push({ root, names })
  }
  return found
}

/** One line per other location, for the places that report an empty data root. */
export function describeServersElsewhere(dataRoot) {
  return serversElsewhere(dataRoot).map(({ root, names }) =>
    `${names.length} server(s) (${names.join(', ')}) are registered in ${root}, which is not the data root in use. ` +
    `If they are yours: spawnloft config set-root "${root}"`)
}

/**
 * Whether a directory can be written to, checked by actually writing.
 *
 * <p>Permission bits and free-space numbers both lie — a network share, a read-only mount, or a
 * drive that has been unplugged all look fine until the first write. The picker needs a real answer
 * before someone points their servers at a location that cannot hold them.
 */
export function checkWritable(dir) {
  const probe = path.join(dir, '.mcctl-write-test')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
