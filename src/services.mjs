import fs from 'node:fs'
import path from 'node:path'

import { SERVICES_DIR, BACKUPS_DIR } from './paths.mjs'
import {
  getInstance, putInstance, updateInstance, removeInstance, hasInstance, listServices, isDatabase, freeName,
  usedPorts, assertPortUsable,
} from './registry.mjs'
import * as mariadb from './mariadb.mjs'
import * as garnet from './garnet.mjs'
import * as mysql from './mysql.mjs'
import { readState, clearState, activeBlock } from './control.mjs'
import { fail, findFreePort, isPortFree, randomPassword, validateName, cleanLabel, stamp, humanBytes, safeRelativePath, isInside } from './util.mjs'
import * as supervisor from './supervisor.mjs'
import * as activity from './activity.mjs'

// Databases are registered like servers, run by the same daemon, and attached to servers with their
// own credentials. An external database is registered by address and root credentials and is never
// started or stopped from here.
//
// Each engine module fills one interface: versions/fetchEngine/initData/launchSpec to run one here;
// probe/newRecord/provision/deprovision/credentialsFor to attach servers; dump/importSql where the
// engine has dumps.

export const ENGINES = {
  [mariadb.ENGINE]: { label: mariadb.LABEL, kind: mariadb.KIND, defaultPort: mariadb.DEFAULT_PORT, module: mariadb },
  [garnet.ENGINE]: { label: garnet.LABEL, kind: garnet.KIND, defaultPort: garnet.DEFAULT_PORT, module: garnet },
  [mysql.ENGINE]: { label: mysql.LABEL, kind: mysql.KIND, defaultPort: mysql.DEFAULT_PORT, module: mysql },
}

// MariaDB stays as an internal driver; new databases offer MySQL and Redis (Garnet).
export const NEW_ENGINES = ['mysql', 'garnet']
export function assertNewEngine(engine = defaultEngine()) {
  if (!NEW_ENGINES.includes(engine)) fail('Choose MySQL or Redis (Garnet). MariaDB is not offered for new databases.')
  return engine
}
export function defaultEngine() { return 'mysql' }
export function canManage(engine, platform = process.platform, arch = process.arch) {
  if (!NEW_ENGINES.includes(engine)) return false
  if (['win32', 'darwin'].includes(platform)) return true
  // elsewhere, only where the engine has a verified build
  return ENGINES[engine].module.supports?.(platform, arch) ?? false
}

// external databases are assumed up; the call itself reports otherwise
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
    })
  }
  return out
}

export async function versionsFor(engine = defaultEngine()) {
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  return ENGINES[engine].module.versions()
}

// Registered last, so a failed download or init leaves nothing behind but the engine.
export async function createDatabase(name, { engine = defaultEngine(), version, port = null, label = null, onProgress = null } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`"${name}" already exists - servers and databases share one set of names`)
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  if (!version) fail('a version is required - see: mcctl db versions')
  const mod = ENGINES[engine].module

  const chosenPort = port != null
    ? assertPortUsable(name, Number(port))
    : await findFreePort(ENGINES[engine].defaultPort, usedPorts())

  await mod.fetchEngine(String(version), { onProgress })
  if (hasInstance(name)) fail(`"${name}" was created while the database engine downloaded. Pick another name.`)
  assertPortUsable(name, chosenPort)

  const dir = path.join(SERVICES_DIR, name)
  // claim the directory before init can yield; never initialize or delete an existing database or
  // another request's in-progress setup
  fs.mkdirSync(SERVICES_DIR, { recursive: true })
  try { fs.mkdirSync(dir, { mode: 0o700 }) }
  catch (err) {
    if (err.code === 'EEXIST') fail(`A database folder already exists at ${dir}. Move it aside or finish the existing setup before retrying.`)
    throw err
  }
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
    await mod.initData({ name, ...inst })
    if (hasInstance(name)) fail(`"${name}" was created while the database initialized. Pick another name.`)
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  putInstance(name, inst)
  return { name, ...inst }
}

// server name plus -db, trimmed so the whole name fits the 32-character limit
export function nameForServer(serverName) {
  const suffix = '-db'
  const base = serverName.slice(0, 32 - suffix.length).replace(/[-_]+$/g, '') + suffix
  return freeName(base)
}

// game port plus one (25565 -> 25566), easy to remember; if taken, the search walks up from there
export async function portForServer(server) {
  const want = Number(server.port) + 1
  if (!Number.isInteger(want) || want < 1 || want > 65535) return findFreePort(mariadb.DEFAULT_PORT, usedPorts())
  return findFreePort(want, usedPorts())
}

// Creates, starts and attaches a server's own database in one step. With no version, uses the
// newest stable release. A database that fails to start or attach is removed again; the engine
// download is kept.
export async function createForServer(serverName, { engine = defaultEngine(), version = null, onProgress = null } = {}) {
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
    try { await supervisor.kill(name) } catch { /* already down */ }
    fs.rmSync(db.dir, { recursive: true, force: true })
    removeInstance(name)
    fail(out.failed
      ? `the database started but stopped again: ${out.reason}`
      : `the database did not report ready in time; nothing was kept`)
  }
  onProgress?.({ message: `Attaching ${serverName}` })
  let credentials
  try {
    credentials = await attach(name, serverName)
  } catch (err) {
    // the server may have been renamed or deleted during the download, or provisioning failed;
    // clean up as for a failed start
    try { await supervisor.kill(name) } catch { /* already down */ }
    fs.rmSync(db.dir, { recursive: true, force: true })
    removeInstance(name)
    throw err
  }
  onProgress?.({ message: `Created ${name}`, done: true })
  return { database: { name, ...getDatabase(name) }, credentials }
}

export function removeDatabase(name, { purge = false } = {}) {
  const inst = getDatabase(name)
  const why = activeBlock(name, 'deleting it')
  if (why) fail(why)
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

// Idempotent: attaching again re-asserts the same credentials, so manually configured plugins keep working.
export async function attach(dbName, serverName) {
  const db = getDatabase(dbName)
  assertServer(serverName)
  if (!isUp(db)) fail(`"${dbName}" is not running - start it first, then attach`)
  const mod = engineOf(db)
  const record = db.attachments?.[serverName] ?? mod.newRecord(serverName, db)
  await mod.provision(db, record)
  updateInstance(dbName, { attachments: { ...(db.attachments ?? {}), [serverName]: record } })
  return credentials(dbName, serverName)
}

export async function detach(dbName, serverName, { drop = false } = {}) {
  const db = getDatabase(dbName)
  const record = db.attachments?.[serverName]
  if (!record) fail(`"${serverName}" is not attached to "${dbName}"`)
  if (isUp(db)) {
    await engineOf(db).deprovision(db, record, { drop })
  } else if (drop) {
    fail(`"${dbName}" is not running, so its data cannot be dropped - start it first, or detach without --drop`)
  }
  const rest = { ...(db.attachments ?? {}) }
  delete rest[serverName]
  updateInstance(dbName, { attachments: rest })
  return { service: dbName, server: serverName, dropped: drop, database: record.database }
}

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

// Registers a database that runs elsewhere (XAMPP, a LAN Redis). It must answer a probe before it
// is recorded, so a wrong address fails now rather than at the first attach.
export async function registerExternal(name, { engine = defaultEngine(), host = '127.0.0.1', port = null, user = 'root', password = '', tools = null, label = null } = {}) {
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

export async function externalStatus(db) {
  try {
    await engineOf(db).probe(db)
    return 'reachable'
  } catch {
    return 'unreachable'
  }
}

export function dumpFileFor(service, database) {
  return path.join('databases', `${service}__${database}.sql`)
}

// Dumps into <dir>/databases/. A database that can't be dumped (e.g. not running) is reported as
// skipped rather than thrown, so the rest of the snapshot is still taken.
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

// A database's own backups live beside server snapshots, under the database's name (unique across
// servers and databases): one plain .sql file per backup plus a small .json manifest.

export function databaseBackupsDir(name) {
  return path.join(BACKUPS_DIR, name)
}

// only names this module wrote; nothing that could reach outside the folder
const DUMP_NAME = /^[\w.-]+\.sql$/

function dumpPath(name, file) {
  const base = path.basename(String(file ?? ''))
  if (base !== file || !DUMP_NAME.test(base)) fail(`"${file}" is not a backup of "${name}"`)
  const full = path.join(databaseBackupsDir(name), base)
  if (!fs.existsSync(full)) fail(`there is no backup called "${base}" for "${name}"`)
  return full
}

function attachedDatabases(db) {
  return [...new Set(Object.values(db.attachments ?? {}).map((a) => a.database))]
}

// newest first; async because the panel polls this
export async function listDatabaseBackups(name) {
  getDatabase(name)
  const dir = databaseBackupsDir(name)
  let files
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => DUMP_NAME.test(f))
  } catch {
    return []
  }
  const rows = await Promise.all(files.map(async (f) => {
    const full = path.join(dir, f)
    const st = await fs.promises.stat(full)
    const manifest = await fs.promises.readFile(`${full.slice(0, -4)}.json`, 'utf8').then(JSON.parse, () => ({}))
    return {
      name: f,
      size: st.size,
      sizeHuman: humanBytes(st.size),
      mtime: st.mtime,
      label: manifest.label ?? '',
      databases: manifest.databases ?? [],
    }
  }))
  return rows.sort((a, b) => b.mtime - a.mtime)
}

export function databaseBackupStatus(name) {
  const db = getDatabase(name)
  return {
    canDump: Boolean(engineOf(db).canDump),
    running: isUp(db),
    databases: attachedDatabases(db),
    dir: databaseBackupsDir(name),
  }
}

// One .sql file: each database is dumped separately and joined in order (each part names its own
// database, so the file imports in one go). Written as .pending and renamed into place, so a
// listing never offers half a dump.
export async function backupDatabase(name, { label = 'manual', quiet = false } = {}) {
  const db = getDatabase(name)
  const engine = engineOf(db)
  if (!engine.canDump) fail(`${ENGINES[db.engine].label} keeps its own checkpoints on disk; there is nothing here to dump`)
  if (!isUp(db)) fail(`"${name}" is not running. A dump is read from the running database - start it first.`)
  const databases = attachedDatabases(db)
  if (!databases.length) fail(`nothing to back up yet: no server is attached to "${name}"`)

  const dir = databaseBackupsDir(name)
  await fs.promises.mkdir(dir, { recursive: true })
  const tag = (cleanLabel(label) ?? 'manual').replace(/[^\w-]+/g, '-').slice(0, 40) || 'manual'
  let base = `${tag}_${stamp()}`
  for (let n = 2; fs.existsSync(path.join(dir, `${base}.sql`)); n++) base = `${tag}_${stamp()}_${n}`
  const file = path.join(dir, `${base}.sql`)
  const pending = `${file}.pending`
  const parts = databases.map((_, i) => `${pending}.${i}`)
  try {
    for (const [i, database] of databases.entries()) await engine.dump(db, database, parts[i])
    const out = fs.createWriteStream(pending, { flags: 'wx' })
    for (const part of parts) {
      for await (const chunk of fs.createReadStream(part)) {
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    await fs.promises.writeFile(`${file.slice(0, -4)}.json`, JSON.stringify({
      database: name, engine: db.engine, version: db.version ?? null, label: tag, databases, createdAt: new Date().toISOString(),
    }, null, 2))
    await fs.promises.rename(pending, file)
  } finally {
    await Promise.all([pending, ...parts].map((p) => fs.promises.rm(p, { force: true })))
  }
  const { size } = await fs.promises.stat(file)
  if (!quiet) activity.record(name, 'backup', { detail: `${databases.join(', ')} as SQL, ${humanBytes(size)}`, snapshot: `${base}.sql` })
  return { name: `${base}.sql`, file, databases, size, sizeHuman: humanBytes(size) }
}

// Takes a "pre-restore" backup first, so restoring the wrong backup can itself be undone.
export async function restoreDatabaseBackup(name, file) {
  const db = getDatabase(name)
  const full = dumpPath(name, file)
  if (!isUp(db)) fail(`"${name}" is not running. A backup is put back into the running database - start it first.`)
  const safety = attachedDatabases(db).length ? await backupDatabase(name, { label: 'pre-restore', quiet: true }) : null
  await engineOf(db).importSql(db, full)
  activity.record(name, 'restore', { detail: path.basename(full) + (safety ? `; how it was is kept as ${safety.name}` : '') })
  return { restored: path.basename(full), safety: safety?.name ?? null }
}

export async function deleteDatabaseBackup(name, file) {
  getDatabase(name)
  const full = dumpPath(name, file)
  await fs.promises.rm(full, { force: true })
  await fs.promises.rm(`${full.slice(0, -4)}.json`, { force: true })
  activity.record(name, 'backup-delete', { detail: path.basename(full) })
  return { deleted: path.basename(full) }
}

export function databaseBackupFile(name, file) {
  getDatabase(name)
  return dumpPath(name, file)
}

// A dump whose database is gone from the registry or not running stays on disk and is reported as
// skipped, so a restore never loses a file it couldn't use.
export async function importDumps(serverName, dumps, baseDir) {
  const imported = []
  const skipped = []
  for (const d of dumps) {
    // the manifest picks the file and the import runs as the database's root, so only accept a file
    // in databases/ inside the server folder: no climbing out, no links leading out
    const rel = safeRelativePath(d.file)
    if (rel === null || !rel.startsWith('databases/')) {
      skipped.push({ ...d, reason: 'the manifest names a dump outside the server folder\'s databases folder; it was not imported' })
      continue
    }
    const file = path.join(baseDir, ...rel.split('/'))
    if (!fs.existsSync(file)) {
      skipped.push({ ...d, reason: 'the dump is missing from the archive' })
      continue
    }
    if (!isInside(fs.realpathSync(baseDir), fs.realpathSync(file))) {
      skipped.push({ ...d, reason: 'the dump leads outside the server folder; it was not imported' })
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
