import fs from 'node:fs'
import path from 'node:path'
import { REGISTRY_FILE, INSTANCES_DIR } from './paths.mjs'
import { readJson, writeJson, fail, validateName, withLock, PRIVATE_FILE_MODE } from './util.mjs'

// One lock for the whole registry file: putInstance/updateInstance/removeInstance each read it,
// change one entry, and write it back, and the daemon recording a pid at the same moment the
// panel changes a setting is exactly the kind of overlap a plain read-modify-write loses silently.
const REGISTRY_LOCK = `${REGISTRY_FILE}.lock`

const EMPTY = { version: 1, instances: {} }

export function loadRegistry() {
  const data = readJson(REGISTRY_FILE, EMPTY)
  if (!data.instances) data.instances = {}
  return data
}

// The registry holds every instance's RCON password, the database root and attachment passwords and
// the Discord webhook URL, so it is owner-only.
export function saveRegistry(data) {
  writeJson(REGISTRY_FILE, data, { mode: PRIVATE_FILE_MODE })
}

/**
 * What an entry in the registry is: a Minecraft server, or a database that serves them.
 *
 * <p>Absent means server: every entry made before databases existed is one, and defaulting here
 * migrates them all without a write. Servers and databases share one namespace on purpose - a
 * name is a folder under run/, a control pipe and a command-line argument, and two things called
 * "survival" would fight over all three.
 */
export function kindOf(inst) {
  return inst?.kind === 'database' ? 'database' : 'server'
}

export function isDatabase(inst) {
  return kindOf(inst) === 'database'
}

/** Every registry entry, whatever it is, sorted by name. */
export function listAll() {
  const reg = loadRegistry()
  return Object.entries(reg.instances)
    .map(([name, cfg]) => ({ name, ...cfg }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The servers. Databases are left out deliberately: everything that iterates "the servers" -
 * launchers, backups, the panel's list, a scheduled task's instance picker - was written before
 * databases existed and would treat one as a server with no jar.
 */
export function listInstances() {
  return listAll().filter((i) => !isDatabase(i))
}

/** The databases. */
export function listServices() {
  return listAll().filter(isDatabase)
}

export function getInstance(name) {
  validateName(name)
  const reg = loadRegistry()
  const cfg = Object.hasOwn(reg.instances, name) ? reg.instances[name] : null
  if (!cfg) {
    const known = Object.keys(reg.instances)
    fail(
      `no instance named "${name}"` +
        (known.length ? `. Known instances: ${known.join(', ')}` : '. Create one with: mcctl new <name>'),
    )
  }
  return { name, ...cfg }
}

export function hasInstance(name) {
  // Own properties only. `instances` comes straight out of JSON.parse, so it inherits
  // Object.prototype - and a plain lookup answers true for "constructor" or "toString", which is
  // enough to get a request past the panel's existence check and into a confusing failure.
  return Object.hasOwn(loadRegistry().instances, name)
}

export function putInstance(name, cfg) {
  validateName(name)
  withLock(REGISTRY_LOCK, () => {
    const reg = loadRegistry()
    reg.instances[name] = cfg
    saveRegistry(reg)
  })
}

export function updateInstance(name, patch) {
  return withLock(REGISTRY_LOCK, () => {
    const reg = loadRegistry()
    if (!Object.hasOwn(reg.instances, name)) fail(`no instance named "${name}"`)
    reg.instances[name] = { ...reg.instances[name], ...patch }
    saveRegistry(reg)
    return { name, ...reg.instances[name] }
  })
}

/**
 * The first free name from a base: the base itself, then base-2, base-3, kept within the name
 * limit. For a name derived from a label, where "survival" may already be taken by the last
 * survival server.
 */
export function freeName(base) {
  let name = base
  for (let i = 2; hasInstance(name); i++) {
    const suffix = '-' + i
    name = base.slice(0, 32 - suffix.length).replace(/[-_]+$/g, '') + suffix
  }
  return name
}

export function removeInstance(name) {
  withLock(REGISTRY_LOCK, () => {
    const reg = loadRegistry()
    delete reg.instances[name]
    saveRegistry(reg)
  })
}

/** Ports already claimed in the registry, so allocation never double-books. */
export function usedPorts() {
  const taken = new Set()
  for (const inst of listAll()) {
    if (inst.port) taken.add(inst.port)
    if (inst.rcon?.port) taken.add(inst.rcon.port)
  }
  return taken
}

/**
 * Refuse a port that is not a port, or that another instance already holds.
 *
 * <p>One check for the CLI's `set` and the panel's settings route. The panel had this and the CLI
 * did not, so `mcctl set x port=abc` recorded NaN and the collision showed up minutes later as a
 * server that would not bind.
 */
export function assertPortUsable(name, port, label = 'port') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${port} is not a ${label} number - use 1 to 65535`)
  }
  const clash = listAll().find(
    (i) => i.name !== name && (i.port === port || i.rcon?.port === port),
  )
  if (clash) fail(`port ${port} is already used by "${clash.name}"`)
  return port
}

export function defaultDir(name) {
  return path.join(INSTANCES_DIR, name)
}

export function serverJarPath(inst) {
  return path.join(inst.dir, inst.jar)
}

export function assertInstanceDir(inst) {
  if (!fs.existsSync(inst.dir)) fail(`instance "${inst.name}" directory is missing: ${inst.dir}`)
  // A database has no jar; what it needs to run is checked by its engine at launch.
  if (isDatabase(inst)) return
  const jar = serverJarPath(inst)
  if (!fs.existsSync(jar)) fail(`server jar not found for "${inst.name}": ${jar}`)
}

/**
 * Aikar's G1 flags. The large-heap variant kicks in above 12G because the
 * young-gen sizing that works for 4G starves a big heap.
 */
export function jvmFlagsFor(memory) {
  const gb = parseMemoryGb(memory)
  const large = gb >= 12
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? 16 : 8}M`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ]
}

/**
 * A server's own Java arguments, in place of the flags above, checked. Space- or line-separated
 * text, or a list; empty means "SpawnLoft's recommended flags" and comes back null.
 *
 * <p>Memory is not one of them: -Xms and -Xmx come from the server's Memory setting, which the
 * panel, the overview's reserved-memory sum and crash diagnosis all read. Nor is -jar, or what
 * follows it - which jar runs is the server's jar. Everything else is the owner's to choose.
 */
export function cleanJvmFlags(input) {
  if (input == null) return null
  const tokens = (Array.isArray(input) ? input.map(String) : String(input).split(/\s+/))
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return null
  if (tokens.length > 60) fail('that is more than 60 Java arguments')
  for (const t of tokens) {
    if (t.length > 300) fail(`"${t.slice(0, 40)}..." is too long for one argument`)
    if (!t.startsWith('-')) fail(`"${t}" is not a Java option - each starts with a dash, like -XX:+UseG1GC`)
    if (/^-Xm[sx]/i.test(t)) fail(`${t}: memory is set by the Memory setting, so both stay in step`)
    if (/^-(jar|cp|classpath)$/i.test(t) || /^--class-path$/i.test(t)) fail(`${t}: which jar runs is the server's own jar`)
  }
  return tokens
}

/**
 * Which server software family an instance runs. Absent means paper: every instance made
 * before the field existed is one, and defaulting here migrates them all without a write.
 */
export function loaderOf(inst) {
  return inst?.loader ?? 'paper'
}

export function parseMemoryGb(memory) {
  const m = /^(\d+(?:\.\d+)?)\s*([GgMm])$/.exec(String(memory).trim())
  if (!m) fail(`invalid memory value "${memory}" - use e.g. 4G or 6144M`)
  const n = Number(m[1])
  return m[2].toUpperCase() === 'G' ? n : n / 1024
}
