import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './tar.mjs'
import { fail, humanBytes, UserError, randomPassword } from './util.mjs'
import { MARIADB_READY_RE, MARIADB_FAILED_RE } from './ready.mjs'

/**
 * MariaDB as an engine SpawnLoft runs: where to get it, how to lay a database out on it, how to
 * start, stop and talk to one.
 *
 * <p>Nothing is installed. MariaDB publishes a portable zip for Windows - `mariadbd`, the init
 * tool, the admin tool, the client and the dump tool, all under bin/ - and a REST API that lists
 * releases with checksums. That is the Paper download pattern exactly: resolve a version, fetch
 * the file, verify it, keep it in a store shared by every database on that version. Windows's own
 * tar unpacks zips, so there is nothing to add for that either.
 *
 * <p>The engine store is `<data>/engines/mariadb-<version>/`. A test drops scripts named like the
 * real binaries into such a folder, and everything here runs them with this Node instead - the
 * same trick the lifecycle tests play with a fake JVM.
 */

const API = 'https://downloads.mariadb.org/rest-api/mariadb/'
const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

export const ENGINE = 'mariadb'
export const LABEL = 'MariaDB'
export const KIND = 'mariadb'
export const DEFAULT_PORT = 3306
export const canDump = true

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    fail(`could not reach the MariaDB download API: ${err.message}`)
  }
  if (!res.ok) fail(`the MariaDB download API returned ${res.status} for ${url}`)
  return res.json()
}

/** Numeric-aware sort key for "11.4.5" style versions, newest first. */
function byVersionDesc(a, b) {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return y - x
    return String(y).localeCompare(String(x))
  }
  return 0
}

/**
 * Releases, newest first, from what the API actually answers.
 *
 * <p>The API is three levels deep and each level has its own shape. The root lists `major_releases`
 * (11.4, 11.8, ...) as an array, and the status - Stable, RC, Preview - lives only there. A major
 * (`/11.4/`) answers `releases`, an object keyed by point release, each with its date and its files,
 * and no status of its own. A point release (`/11.4.5/`) answers `release_data`, keyed the same way.
 * The first cut read `releases` off the root, found nothing, and the panel's version list said "No
 * stable release listed" for every install.
 *
 * <p>So: the stable majors are picked from the root, each is asked for its point releases, and a
 * point release inherits its major's status and support type. Release candidates are left out
 * unless asked for: an RC is not what anyone means by "a database" unless they say so.
 */
export function releasesFrom(root, majors = {}, { includeUnstable = false } = {}) {
  const out = []
  for (const m of root?.major_releases ?? []) {
    const status = String(m?.release_status ?? '')
    if (!includeUnstable && !/stable/i.test(status)) continue
    const id = String(m?.release_id ?? '')
    const releases = majors[id]?.releases ?? {}
    for (const [pid, r] of Object.entries(releases)) {
      out.push({
        version: String(r?.release_id ?? pid),
        series: id,
        status,
        support: m?.release_support_type ?? null,
        date: r?.date_of_release ?? null,
      })
    }
  }
  return out.sort((a, b) => byVersionDesc(a.version, b.version))
}

/** The stable majors the root lists, as the ids the per-major endpoint takes. */
export function stableMajorsFrom(root, { includeUnstable = false } = {}) {
  return (root?.major_releases ?? [])
    .filter((m) => includeUnstable || /stable/i.test(String(m?.release_status ?? '')))
    .map((m) => String(m.release_id))
}

export async function versions(opts = {}) {
  const root = await api(API)
  const ids = stableMajorsFrom(root, opts)
  // One request per stable series, in parallel: five or six of them, each a few kilobytes.
  const answers = await Promise.all(ids.map((id) => api(`${API}${encodeURIComponent(id)}/`)))
  const majors = {}
  ids.forEach((id, i) => { majors[id] = answers[i] })
  return releasesFrom(root, majors, opts)
}

/**
 * The Windows x64 zip in a release's file list, or null when the release has none.
 *
 * <p>Takes any of the shapes a file list arrives in: a bare `files` array, a major's `releases`,
 * or a point release's `release_data`, the last two keyed by version. The debug-symbols zip is
 * also a Windows x64 zip and is skipped by name; the API lists it alongside, sometimes first.
 * Download URLs come back as http:// and are asked for over https.
 */
export function windowsZipFrom(payload, version = null) {
  let files = payload?.files
  if (!files) {
    const keyed = payload?.release_data ?? payload?.releases ?? {}
    const entry = version != null && keyed[version] ? keyed[version] : Object.values(keyed)[0]
    files = entry?.files
  }
  const hit = (files ?? []).find((f) =>
    /windows/i.test(String(f?.os ?? '')) &&
    /zip/i.test(String(f?.package_type ?? '')) &&
    /x86_64|amd64|x64/i.test(String(f?.cpu ?? '')) &&
    !/debug/i.test(String(f?.file_name ?? '')))
  if (!hit) return null
  return {
    name: hit.file_name,
    url: String(hit.file_download_url ?? '').replace(/^http:\/\//i, 'https://'),
    sha256: hit.checksum?.sha256sum ?? null,
    size: Number(hit.size) || 0,
  }
}

export async function fileFor(version) {
  const zip = windowsZipFrom(await api(`${API}${encodeURIComponent(version)}/`), version)
  if (!zip) fail(`MariaDB ${version} publishes no Windows zip, so it cannot be run from here.`)
  return zip
}

export function engineDir(version) {
  return path.join(ENGINES_DIR, `mariadb-${version}`)
}

// The names a binary has had. MariaDB renamed them in 10.4+ and ships the old names alongside
// for a while; older zips have only the mysql names. A .mjs is a test standing in for the binary.
const NAMES = {
  server: ['mariadbd', 'mysqld'],
  init: ['mariadb-install-db', 'mysql_install_db'],
  admin: ['mariadb-admin', 'mysqladmin'],
  client: ['mariadb', 'mysql'],
  dump: ['mariadb-dump', 'mysqldump'],
}

export function binary(dir, role) {
  if (!dir) return null
  for (const name of NAMES[role]) {
    for (const ext of ['.exe', '', '.mjs']) {
      // The store keeps bin/ under the version; a tools folder someone points at (XAMPP's
      // mysql\bin, a MariaDB install's bin) holds the binaries directly.
      for (const p of [path.join(dir, 'bin', name + ext), path.join(dir, name + ext)]) {
        if (fs.existsSync(p)) return { path: p, script: ext === '.mjs' }
      }
    }
  }
  return null
}

/**
 * Where the client tools for an instance are: the engine store for one run here, the folder
 * recorded for an external one. An external database with no tools recorded borrows them from
 * any MariaDB in the store, or from the usual install locations on this machine.
 */
export function toolsDir(inst) {
  if (!inst.external) return engineDir(inst.version)
  if (inst.tools?.dir) return inst.tools.dir
  return findTools()
}

/** Common places MariaDB/MySQL client tools live on a Windows PC, plus the engine store. */
export function findTools() {
  const candidates = []
  try {
    for (const e of fs.readdirSync(ENGINES_DIR)) if (e.startsWith('mariadb-')) candidates.push(path.join(ENGINES_DIR, e))
  } catch {
    /* no store yet */
  }
  if (process.platform === 'win32') {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    candidates.push('C:\\xampp\\mysql\\bin')
    for (const base of pf) {
      try {
        for (const e of fs.readdirSync(base)) {
          if (/^MariaDB/i.test(e)) candidates.push(path.join(base, e, 'bin'))
          if (/^MySQL$/i.test(e)) {
            for (const v of fs.readdirSync(path.join(base, e))) if (/^MySQL Server/i.test(v)) candidates.push(path.join(base, e, v, 'bin'))
          }
        }
      } catch {
        /* folder missing */
      }
    }
  }
  return candidates.find((c) => binary(c, 'client')) ?? null
}

export function hostOf(inst) {
  return inst.host ?? '127.0.0.1'
}

function rootArgs(inst) {
  return ['--protocol=TCP', `--host=${hostOf(inst)}`, `--port=${inst.port}`, `--user=${inst.root?.user ?? 'root'}`]
}

export function hasEngine(version) {
  return Boolean(binary(engineDir(version), 'server'))
}

/** How to run a binary: itself, or - a script standing in for it - this Node told to be Node. */
function runnable(bin, args, env = process.env) {
  if (bin.script) return { cmd: process.execPath, args: [bin.path, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { cmd: bin.path, args, env }
}

/**
 * Download and unpack one engine version into the store.
 *
 * <p>The zip is hashed as it arrives and renamed into place only if the hash matches, so a
 * truncated download is a .part file and never a half-engine. Unpacked with --strip-components,
 * so the store holds bin/ directly rather than the zip's own top folder.
 */
export async function fetchEngine(version, { onProgress = null, force = false } = {}) {
  const dir = engineDir(version)
  if (hasEngine(version) && !force) {
    onProgress?.({ cached: true, message: `MariaDB ${version} is already here` })
    return { version, dir, cached: true }
  }
  if (process.platform !== 'win32') {
    fail(`MariaDB ${version} is not in the engine store, and only the Windows build is fetched from here.\n` +
      `  Put a MariaDB with bin/mariadbd in ${dir} to run one on this platform.`)
  }
  const zip = await fileFor(version)
  fs.mkdirSync(ENGINES_DIR, { recursive: true })
  const archive = path.join(ENGINES_DIR, zip.name)
  const tmp = `${archive}.part`

  onProgress?.({ message: `Downloading MariaDB ${version}`, received: 0, total: zip.size })
  let res
  try {
    res = await fetch(zip.url, { headers: { 'User-Agent': UA } })
  } catch (err) {
    fail(`download failed for MariaDB ${version}: ${err.message}`)
  }
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${zip.url}`)
  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || zip.size || 0
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    onProgress?.({ message: `Downloading MariaDB ${version}`, received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))
  const got = hash.digest('hex')
  if (zip.sha256 && got !== zip.sha256) {
    fs.rmSync(tmp, { force: true })
    fail(`checksum mismatch for ${zip.name}\n  expected ${zip.sha256}\n  got      ${got}`)
  }
  fs.renameSync(tmp, archive)

  onProgress?.({ message: `Unpacking MariaDB ${version}`, received: total, total })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    await runTar(['-xf', archive, '--strip-components=1', '-C', dir], ENGINES_DIR)
  } finally {
    fs.rmSync(archive, { force: true })
  }
  if (!binary(dir, 'server')) {
    fs.rmSync(dir, { recursive: true, force: true })
    fail(`${zip.name} unpacked, but holds no MariaDB server binary under bin/.`)
  }
  return { version, dir, cached: false, sizeHuman: humanBytes(total) }
}

// ---- one database on the engine ---------------------------------------------------------------

export function dataDir(inst) {
  return path.join(inst.dir, 'data')
}

export function iniFile(inst) {
  return path.join(inst.dir, 'my.ini')
}

/**
 * The server's configuration, written by us rather than left to the init tool.
 *
 * <p>Loopback only, by the same reasoning as the panel: nothing this program runs listens on an
 * interface the router can see. skip-name-resolve keeps every grant keyed by address, which is
 * what the attach step writes. utf8mb4 because plugins store player names and chat.
 */
export function iniFor(inst) {
  const dd = dataDir(inst).replace(/\\/g, '/')
  return [
    '# Written by SpawnLoft. Edit if you like; the port and bind-address are what the panel shows.',
    '[mysqld]',
    `datadir=${dd}`,
    `port=${inst.port}`,
    'bind-address=127.0.0.1',
    'skip-name-resolve',
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    'max_connections=100',
    '',
    '[client]',
    `port=${inst.port}`,
    'default-character-set=utf8mb4',
    '',
  ].join('\n')
}

/**
 * Lay the database out: system tables with the root password, and our my.ini beside them.
 *
 * <p>Done once. A data folder that already holds system tables is left alone, so re-running is
 * safe and a failed later step never re-initialises a database that has data in it.
 */
export function initData(inst) {
  const dir = engineDir(inst.version)
  const init = binary(dir, 'init')
  if (!init) fail(`MariaDB ${inst.version} has no init tool under ${dir}`)
  const dd = dataDir(inst)
  fs.mkdirSync(inst.dir, { recursive: true })
  fs.writeFileSync(iniFile(inst), iniFor(inst))
  if (fs.existsSync(path.join(dd, 'mysql'))) return { initialised: false }

  const { cmd, args, env } = runnable(init, [`--datadir=${dd}`, `--password=${inst.root.password}`, `--port=${inst.port}`])
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, env })
  if (res.error) fail(`could not run the MariaDB init tool: ${res.error.message}`)
  if (res.status !== 0) {
    fail(`MariaDB could not set up its data folder (exit ${res.status}):\n${(res.stderr || res.stdout || '').trim()}`)
  }
  return { initialised: true }
}

/**
 * What the daemon spawns, what it watches for, and how it asks the process to stop.
 *
 * <p>--console puts the log on stderr, which the daemon captures like stdout. Stop is the admin
 * tool over TCP rather than stdin, because a database takes no console input; the password rides
 * in the environment the way the client tools expect, and never on a command line.
 */
export function launchSpec(inst) {
  const dir = engineDir(inst.version)
  const server = binary(dir, 'server')
  if (!server) fail(`MariaDB ${inst.version} is not in the engine store (${dir}). Add the database again to fetch it.`)
  const admin = binary(dir, 'admin')
  const run = runnable(server, [`--defaults-file=${iniFile(inst)}`, '--console'])
  const stop = admin
    ? runnable(admin, [...rootArgs(inst), 'shutdown'], { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
    : null
  return {
    cmd: run.cmd,
    args: run.args,
    env: run.env,
    cwd: inst.dir,
    ready: MARIADB_READY_RE,
    failed: MARIADB_FAILED_RE,
    stop,
  }
}

// ---- talking to a running database -----------------------------------------------------------

export function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function quoteStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/** Run statements as root over TCP. Returns stdout; a refusal names the reason. */
export function sql(inst, statements) {
  const dir = toolsDir(inst)
  const client = binary(dir, 'client')
  if (!client) {
    fail(inst.external
      ? `no MariaDB client tools found for "${inst.name}". Point at a folder holding mariadb.exe or mysql.exe (XAMPP's mysql\\bin, a MariaDB install's bin), or add a MariaDB here once so its tools are in the store.`
      : `MariaDB ${inst.version} has no client tool under ${dir}`)
  }
  const { cmd, args, env } = runnable(client,
    [...rootArgs(inst), '--batch', '--skip-column-names', '--execute', statements],
    { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env })
  if (res.error) fail(`could not run the MariaDB client: ${res.error.message}`)
  if (res.status !== 0) fail(`MariaDB refused: ${(res.stderr || res.stdout || `exit ${res.status}`).trim()}`)
  return res.stdout ?? ''
}

/**
 * The statements that give a server its own database and user, and take them away again.
 *
 * <p>Two hosts because skip-name-resolve keys TCP connections by address: 'localhost' matches a
 * socket or a named pipe, '127.0.0.1' matches what a plugin actually opens. Granted on that one
 * database and nothing else. IF NOT EXISTS plus ALTER, so attaching twice repairs rather than
 * refuses.
 */
export function attachSql({ database, user, password }) {
  const db = quoteIdent(database)
  const hosts = ['localhost', '127.0.0.1'].map((h) => `${quoteStr(user)}@${quoteStr(h)}`)
  return [
    `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ...hosts.map((u) => `CREATE USER IF NOT EXISTS ${u} IDENTIFIED BY ${quoteStr(password)};`),
    ...hosts.map((u) => `ALTER USER ${u} IDENTIFIED BY ${quoteStr(password)};`),
    `GRANT ALL PRIVILEGES ON ${db}.* TO ${hosts.join(', ')};`,
    'FLUSH PRIVILEGES;',
  ].join('\n')
}

export function detachSql({ database, user, drop = false }) {
  const hosts = ['localhost', '127.0.0.1'].map((h) => `${quoteStr(user)}@${quoteStr(h)}`)
  const lines = [`DROP USER IF EXISTS ${hosts.join(', ')};`]
  if (drop) lines.push(`DROP DATABASE IF EXISTS ${quoteIdent(database)};`)
  lines.push('FLUSH PRIVILEGES;')
  return lines.join('\n')
}

// ---- dumps ------------------------------------------------------------------------------------

function runToFile(cmd, args, env, { stdout = null, stdin = null, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    if (stdout) child.stdout.pipe(stdout, { end: false })
    if (stdin) stdin.pipe(child.stdin)
    child.on('error', (err) => reject(new UserError(`could not run the MariaDB ${label}: ${err.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new UserError(`MariaDB ${label} exited ${code}: ${stderr.trim().split(/\r?\n/)[0] || 'no reason given'}`))
    })
  })
}

/**
 * Dump one database to a file, consistently.
 *
 * <p>--single-transaction reads the tables as of one moment without locking them, which is what
 * makes a hot backup of a live server honest. --databases puts the CREATE DATABASE and USE at the
 * top, so the file imports as root without anyone having to pick a database first.
 */
export async function dump(inst, database, file) {
  const dir = toolsDir(inst)
  const tool = binary(dir, 'dump')
  if (!tool) fail(`no MariaDB dump tool found for "${inst.name}" under ${dir ?? '(no tools folder)'}`)
  const { cmd, args, env } = runnable(tool,
    [...rootArgs(inst), '--single-transaction', '--routines', '--triggers', '--events', '--databases', database],
    { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const out = fs.createWriteStream(file)
  try {
    await runToFile(cmd, args, env, { stdout: out, label: 'dump tool' })
  } catch (err) {
    out.destroy()
    fs.rmSync(file, { force: true })
    throw err
  }
  await new Promise((resolve) => out.end(resolve))
  return { file, bytes: fs.statSync(file).size }
}

/** Feed a dump back through the client as root. */
export async function importSql(inst, file) {
  const dir = toolsDir(inst)
  const client = binary(dir, 'client')
  if (!client) fail(`no MariaDB client tool found for "${inst.name}" under ${dir ?? '(no tools folder)'}`)
  const { cmd, args, env } = runnable(client,
    rootArgs(inst),
    { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
  await runToFile(cmd, args, env, { stdin: fs.createReadStream(file), label: 'client' })
  return { file }
}

// ---- the engine interface ----------------------------------------------------------------------

/** Is it answering? One statement as root; a refusal is the reason. */
export async function probe(inst) {
  sql(inst, 'SELECT 1;')
  return true
}

export function newRecord(serverName) {
  return { database: serverName, user: serverName, password: randomPassword(24), createdAt: new Date().toISOString() }
}

export function provision(inst, record) {
  sql(inst, attachSql(record))
  return { provisioned: true }
}

export function deprovision(inst, record, { drop = false } = {}) {
  sql(inst, detachSql({ database: record.database, user: record.user, drop }))
  return { deprovisioned: true, dropped: drop }
}

export function credentialsFor(inst, record) {
  return { jdbc: `jdbc:mysql://${hostOf(inst)}:${inst.port}/${record.database}` }
}
