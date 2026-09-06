import fs from 'node:fs'
import path from 'node:path'

import { SERVICES_DIR } from './paths.mjs'
import {
  getInstance, putInstance, updateInstance, removeInstance, hasInstance, listServices, isDatabase, freeName,
  usedPorts, assertPortUsable,
} from './registry.mjs'
import * as mariadb from './mariadb.mjs'
import * as garnet from './garnet.mjs'
import { detectHelpers, applyHelper } from './dbconfig.mjs'
import { readState, clearState } from './control.mjs'
import { fail, findFreePort, isPortFree, randomPassword, validateName, cleanLabel } from './util.mjs'
import * as supervisor from './supervisor.mjs'

/**
 * Databases: registered like servers, run by the same daemon, attached to servers with their
 * own credentials - or, for one the person already runs, registered with its address and root
 * credentials and attached to just the same, only never started or stopped from here.
 *
 * <p>Two engines. Each module fills one interface: versions/fetchEngine/initData/launchSpec to
 * run one here; probe/newRecord/provision/deprovision/credentialsFor to attach servers to one
 * wherever it runs; dump/importSql where a dump is a thing the engine has.
 */

export const ENGINES = {
  [mariadb.ENGINE]: { label: mariadb.LABEL, kind: mariadb.KIND, defaultPort: mariadb.DEFAULT_PORT, module: mariadb },
  [garnet.ENGINE]: { label: garnet.LABEL, kind: garnet.KIND, defaultPort: garnet.DEFAULT_PORT, module: garnet },
}

/** Whether the database is there to be talked to: running here, or external (assumed; the call says otherwise). */
function isUp(db) {
  return db.external ? true : readState(db.name).status === 'running'
}

function engineOf(inst) {
  const engine = ENGINES[inst.engine]
  if (!engine) fail(`"${inst.name}" runs an engine this build does not know: ${inst.engine}`)
  return engine.module
}

export function getDatabase(name) {
  const inst = getInstance(name)
  if (!isDatabase(inst)) fail(`"${name}" is a server, not a database`)
  return inst
}

export function assertServer(name) {
  const inst = getInstance(name)
  if (isDatabase(inst)) fail(`"${name}" is a database, not a server`)
  return inst
}

/** Every database a server is attached to, without the passwords. */
export function serverAttachments(serverName) {
  const out = []
  for (const db of listServices()) {
    const a = db.attachments?.[serverName]
    if (!a) continue
    out.push({
      service: db.name,
      label: db.label ?? null,
      engine: db.engine,
      kind: ENGINES[db.engine]?.kind ?? db.engine,
      external: Boolean(db.external),
      version: db.version ?? null,
      host: db.host ?? '127.0.0.1',
      port: db.port,
      database: a.database,
      user: a.user,
      createdAt: a.createdAt ?? null,
      applied: a.applied ?? {},
    })
  }
  return out
}

/** The engine's version list, for a picker. */
export async function versionsFor(engine = mariadb.ENGINE) {
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  return ENGINES[engine].module.versions()
}

/**
 * Make a database: fetch its engine if the store lacks it, lay out its folder, register it.
 *
 * <p>Registered last, so a download that fails or an init that refuses leaves nothing behind but
 * the engine, which is worth keeping.
 */
export async function createDatabase(name, { engine = mariadb.ENGINE, version, port = null, label = null, onProgress = null } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`"${name}" already exists - servers and databases share one set of names`)
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  if (!version) fail('a version is required - see: mcctl db versions')
  const mod = ENGINES[engine].module

  const chosenPort = port != null
    ? assertPortUsable(name, Number(port))
    : await findFreePort(ENGINES[engine].defaultPort, usedPorts())

  await mod.fetchEngine(String(version), { onProgress })

  const dir = path.join(SERVICES_DIR, name)
  const inst = {
    kind: 'database',
    engine,
    version: String(version),
    dir,
    port: chosenPort,
    root: { password: randomPassword(24) },
    autoRestart: true,
    attachments: {},
    createdAt: new Date().toISOString(),
  }
  const clean = cleanLabel(label)
  if (clean && clean !== name) inst.label = clean

  onProgress?.({ message: `Setting up ${ENGINES[engine].label} ${version} on port ${chosenPort}` })
  try {
    mod.initData({ name, ...inst })
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  putInstance(name, inst)
  return { name, ...inst }
}

/**
 * The name a server's own database gets: the server's name with -db, made unique. Kept within the
 * 32 characters a name may have, the suffix included, so a long server name still gets one.
 */
export function nameForServer(serverName) {
  const suffix = '-db'
  const base = serverName.slice(0, 32 - suffix.length).replace(/[-_]+$/g, '') + suffix
  return freeName(base)
}

/**
 * The port a server's own database gets: the game port plus one, unless something already has it.
 *
 * <p>One rule a person can remember - survival on 25565, its database on 25566 - beats the
 * engine's usual port, which is 3306 for the first database and then whatever was free. When
 * the port after the game port is taken, in the registry or on the machine, the search walks
 * up from there, so the database still sits next to its server rather than somewhere else.
 */
export async function portForServer(server) {
  const want = Number(server.port) + 1
  if (!Number.isInteger(want) || want < 1 || want > 65535) return findFreePort(mariadb.DEFAULT_PORT, usedPorts())
  return findFreePort(want, usedPorts())
}

/**
 * A database of the server's own, in one step: made on the port after the server's, started,
 * and attached, so the credentials come back from the same click that asked for it.
 *
 * <p>The version, when none is named, is the newest stable release the engine publishes; the
 * server-side flow has no version list to pick from and should not need one. Attach needs the
 * database up, so it is started here and waited for; a database that does not come up is
 * removed again, engine and folder included, since a half-made database nobody asked for by
 * name would only confuse the list. The engine download is kept, as ever.
 */
export async function createForServer(serverName, { engine = mariadb.ENGINE, version = null, onProgress = null } = {}) {
  const server = assertServer(serverName)
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  if (!version) {
    onProgress?.({ message: `Asking ${ENGINES[engine].label} for its newest stable release` })
    const newest = (await versionsFor(engine))[0]
    if (!newest) fail(`${ENGINES[engine].label} publishes no stable release to pick from - name one with --version`)
    version = newest.version
  }
  const name = nameForServer(serverName)
  const port = await portForServer(server)
  const label = server.label ? `${server.label} database` : null
  const db = await createDatabase(name, { engine, version, port, label, onProgress })

  onProgress?.({ message: `Starting ${name} on port ${port}` })
  let out
  try {
    out = await supervisor.start(name)
  } catch (err) {
    fs.rmSync(db.dir, { recursive: true, force: true })
    removeInstance(name)
    throw err
  }
  if (out.failed || out.timedOut) {
    // Nothing to keep: the person asked for a working database, not a folder to debug.
    try { await supervisor.kill(name) } catch { /* already down */ }
    fs.rmSync(db.dir, { recursive: true, force: true })
    removeInstance(name)
    fail(out.failed
      ? `the database started but stopped again: ${out.reason}`
      : `the database did not report ready in time; nothing was kept`)
  }
  onProgress?.({ message: `Attaching ${serverName}` })
  const credentials = attach(name, serverName)
  onProgress?.({ message: `Created ${name}`, done: true })
  return { database: { name, ...getDatabase(name) }, credentials }
}

/** Remove a stopped database from the registry and, if asked, from disk. */
export function removeDatabase(name, { purge = false } = {}) {
  const inst = getDatabase(name)
  const { status } = readState(name)
  if (status === 'running' || status === 'stopping') fail(`"${name}" is running - stop it before deleting it`)
  const attached = Object.keys(inst.attachments ?? {})
  if (purge && inst.dir && !inst.external) {
    try {
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch (err) {
      fail(`could not delete ${inst.dir}: ${err.message}\n  "${name}" is still registered.`)
    }
  }
  removeInstance(name)
  clearState(name)
  return { name, purged: purge, detached: attached }
}

/**
 * Give a server its own database and user on a running database, and remember it.
 *
 * <p>Idempotent: attaching again re-asserts the same credentials rather than minting new ones,
 * so a plugin config written from the first attach keeps working.
 */
export function attach(dbName, serverName) {
  const db = getDatabase(dbName)
  assertServer(serverName)
  if (!isUp(db)) fail(`"${dbName}" is not running - start it first, then attach`)
  const mod = engineOf(db)
  const record = db.attachments?.[serverName] ?? mod.newRecord(serverName, db)
  mod.provision(db, record)
  updateInstance(dbName, { attachments: { ...(db.attachments ?? {}), [serverName]: record } })
  return credentials(dbName, serverName)
}

/** Take the user away; the data stays unless `drop` says otherwise. */
export function detach(dbName, serverName, { drop = false } = {}) {
  const db = getDatabase(dbName)
  const record = db.attachments?.[serverName]
  if (!record) fail(`"${serverName}" is not attached to "${dbName}"`)
  if (isUp(db)) {
    engineOf(db).deprovision(db, record, { drop })
  } else if (drop) {
    fail(`"${dbName}" is not running, so its data cannot be dropped - start it first, or detach without --drop`)
  }
  const rest = { ...(db.attachments ?? {}) }
  delete rest[serverName]
  updateInstance(dbName, { attachments: rest })
  return { service: dbName, server: serverName, dropped: drop, database: record.database }
}

/** Everything a plugin config needs, for one server on one database. */
export function credentials(dbName, serverName) {
  const db = getDatabase(dbName)
  const a = db.attachments?.[serverName]
  if (!a) fail(`"${serverName}" is not attached to "${dbName}" - attach it first`)
  return {
    service: dbName,
    server: serverName,
    engine: db.engine,
    kind: ENGINES[db.engine]?.kind ?? db.engine,
    host: db.host ?? '127.0.0.1',
    port: db.port,
    database: a.database,
    user: a.user,
    password: a.password,
    ...engineOf(db).credentialsFor(db, a),
  }
}

// ---- one the person already runs --------------------------------------------------------------

/**
 * Register a database that runs elsewhere - XAMPP, a MariaDB install, a Redis on the LAN - so
 * servers can be attached to it with credentials of their own. It is asked to answer before it
 * is recorded: an address that is wrong is refused now, with the engine's own reason, rather
 * than at the first attach.
 */
export async function registerExternal(name, { engine = mariadb.ENGINE, host = '127.0.0.1', port = null, user = 'root', password = '', tools = null, label = null } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`"${name}" already exists - servers and databases share one set of names`)
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  const chosenPort = Number(port ?? ENGINES[engine].defaultPort)
  if (!Number.isInteger(chosenPort) || chosenPort < 1 || chosenPort > 65535) fail(`${port} is not a port number`)
  const inst = {
    kind: 'database',
    engine,
    external: true,
    host: String(host || '127.0.0.1'),
    port: chosenPort,
    root: { user: String(user || 'root'), password: String(password ?? '') },
    attachments: {},
    createdAt: new Date().toISOString(),
  }
  if (tools) {
    if (!ENGINES[engine].module.binary?.(String(tools), 'client')) fail(`${tools} holds no client tool this engine knows`)
    inst.tools = { dir: String(tools) }
  }
  const clean = cleanLabel(label)
  if (clean && clean !== name) inst.label = clean
  await ENGINES[engine].module.probe({ name, ...inst })
  putInstance(name, inst)
  return { name, ...inst }
}

/** Reachability for an external database, for a list that has no daemon to ask. */
export async function externalStatus(db) {
  try {
    await engineOf(db).probe(db)
    return 'reachable'
  } catch {
    return 'unreachable'
  }
}

// ---- backups ------------------------------------------------------------------------------------

/** The file a dump takes inside a snapshot: databases/<service>__<database>.sql */
export function dumpFileFor(service, database) {
  return path.join('databases', `${service}__${database}.sql`)
}

/**
 * Dump every database a server is attached to, into `<dir>/databases/`.
 *
 * <p>Returns what was dumped, ready to go in a manifest, and what could not be: a database that
 * is not running has nothing to answer a dump with. That is reported, not thrown - the rest of
 * the snapshot is still worth taking, and the manifest says what it lacks.
 */
export async function dumpAttachments(serverName, dir) {
  const dumped = []
  const skipped = []
  for (const a of serverAttachments(serverName)) {
    const db = getDatabase(a.service)
    if (!engineOf(db).canDump) {
      skipped.push({ service: db.name, database: a.database, reason: `${ENGINES[db.engine].label} keeps its own checkpoints; it is not dumped` })
      continue
    }
    if (!isUp(db)) {
      skipped.push({ service: db.name, database: a.database, reason: 'the database is not running' })
      continue
    }
    const rel = dumpFileFor(db.name, a.database)
    try {
      const { bytes } = await engineOf(db).dump(db, a.database, path.join(dir, rel))
      dumped.push({ service: db.name, engine: db.engine, version: db.version, database: a.database, user: a.user, file: rel.replace(/\\/g, '/'), bytes })
    } catch (err) {
      skipped.push({ service: db.name, database: a.database, reason: err.message })
    }
  }
  return { dumped, skipped }
}

/**
 * Import the dumps a snapshot carried, each into the database it came from.
 *
 * <p>The dump names its own database, so the file goes in as root and lands where it was taken
 * from. A database that is gone from the registry, or not running, keeps its dump on disk and is
 * named as skipped: a restore must not lose a file it could not use.
 */
export async function importDumps(serverName, dumps, baseDir) {
  const imported = []
  const skipped = []
  for (const d of dumps) {
    const file = path.join(baseDir, d.file)
    if (!fs.existsSync(file)) {
      skipped.push({ ...d, reason: 'the dump is missing from the archive' })
      continue
    }
    if (!hasInstance(d.service) || !isDatabase(getInstance(d.service))) {
      skipped.push({ ...d, reason: `"${d.service}" is no longer here; the dump is left at ${file}` })
      continue
    }
    const db = getDatabase(d.service)
    if (!isUp(db)) {
      skipped.push({ ...d, reason: `"${d.service}" is not running; the dump is left at ${file}` })
      continue
    }
    try {
      await engineOf(db).importSql(db, file)
      imported.push(d)
    } catch (err) {
      skipped.push({ ...d, reason: `${err.message}; the dump is left at ${file}` })
    }
  }
  return { imported, skipped }
}

// ---- plugins that want the credentials ------------------------------------------------------

/** The plugin config helpers this server can use, with whether each plugin and its config are there. */
export function helpersFor(serverName, { engine = null } = {}) {
  const kind = engine ? (ENGINES[engine]?.kind ?? engine) : null
  return detectHelpers(assertServer(serverName)).filter((h) => !kind || h.engine === kind)
}

/**
 * Write a server's credentials on one database into one plugin's config, and remember that it
 * was done, so the panel can show which plugins point at which database.
 */
export function applyToPlugin(dbName, serverName, helperId) {
  const server = assertServer(serverName)
  const creds = credentials(dbName, serverName)
  const result = applyHelper(server, helperId, creds, { kind: creds.kind })
  const db = getDatabase(dbName)
  const record = db.attachments[serverName]
  const applied = { ...(record.applied ?? {}), [result.plugin]: { file: result.file, at: new Date().toISOString() } }
  updateInstance(dbName, { attachments: { ...db.attachments, [serverName]: { ...record, applied } } })
  return { ...result, service: dbName, server: serverName, restartNeeded: true }
}
