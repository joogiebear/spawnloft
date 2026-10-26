import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './tar.mjs'
import { fail, humanBytes, UserError, randomPassword } from './util.mjs'
import { fetchRetry } from './download.mjs'
import { MARIADB_READY_RE, MARIADB_FAILED_RE } from './ready.mjs'
import { libraryEnv } from './linux-libs.mjs'

// MariaDB engine: fetch the portable Windows zip, lay out a database, start/stop/talk to one.
// Engines live in <data>/engines/mariadb-<version>/. Tests drop scripts named like the real
// binaries into such a folder and they run under this Node instead.

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

// numeric-aware comparator for "11.4.5" style versions, newest first
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

// The API has three levels with different shapes. The root lists major_releases (an array, and the
// only place status lives), a major answers `releases` keyed by point release, and a point release
// answers `release_data`. Point releases inherit their major's status and support type. Release
// candidates are left out unless includeUnstable.
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

export function stableMajorsFrom(root, { includeUnstable = false } = {}) {
  return (root?.major_releases ?? [])
    .filter((m) => includeUnstable || /stable/i.test(String(m?.release_status ?? '')))
    .map((m) => String(m.release_id))
}

export async function versions(opts = {}) {
  const root = await api(API)
  const ids = stableMajorsFrom(root, opts)
  const answers = await Promise.all(ids.map((id) => api(`${API}${encodeURIComponent(id)}/`)))
  const majors = {}
  ids.forEach((id, i) => { majors[id] = answers[i] })
  return releasesFrom(root, majors, opts)
}

// Accepts a bare `files` array, a major's `releases` or a point release's `release_data` (both
// keyed by version). The debug-symbols zip is also Windows x64 and sometimes listed first, so it is
// skipped by name. Download URLs come back as http:// and are upgraded to https.
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

// MariaDB renamed its binaries in 10.4+ and ships the old names alongside for a while; older zips
// have only the mysql names. A .mjs is a test stand-in.
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
      // the store keeps bin/ under the version; a user-selected tools folder (XAMPP's mysql\bin) holds the binaries directly
      for (const p of [path.join(dir, 'bin', name + ext), path.join(dir, name + ext)]) {
        if (fs.existsSync(p)) return { path: p, script: ext === '.mjs' }
      }
    }
  }
  return null
}

// An external database with no tools recorded borrows them from the engine store or the usual install locations.
export function toolsDir(inst) {
  if (!inst.external) return engineDir(inst.version)
  if (inst.tools?.dir) return inst.tools.dir
  return findTools()
}

export function findTools() {
  const candidates = []
  try {
    for (const e of fs.readdirSync(ENGINES_DIR)) if (/^(mariadb-|mysql-)/.test(e)) candidates.push(path.join(ENGINES_DIR, e))
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
  if (process.platform === 'darwin') {
    for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
      for (const formula of ['mysql', 'mysql@8.4', 'mariadb', 'mariadb@11.4']) candidates.push(path.join(base, formula, 'bin'))
    }
    candidates.push('/usr/local/mysql/bin')
    for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(entry)
  }
  return candidates.find((c) => binary(c, 'client')) ?? null
}

export function hostOf(inst) {
  return inst.host ?? '127.0.0.1'
}

function rootArgs(inst) {
  return ['--no-defaults', '--protocol=TCP', `--host=${hostOf(inst)}`, `--port=${inst.port}`, `--user=${inst.root?.user ?? 'root'}`]
}

export function hasEngine(version) {
  return Boolean(binary(engineDir(version), 'server'))
}

function runnable(bin, args, env = process.env) {
  if (bin.script) return { cmd: process.execPath, args: [bin.path, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  // a managed Linux engine may carry its own libraries beside bin/ (linux-libs.mjs)
  return { cmd: bin.path, args, env: libraryEnv(bin.path, env) }
}

// The zip is hashed as it arrives and renamed from .part only on a match, so a truncated download
// is never a half-engine. --strip-components drops the zip's own top folder so the store holds bin/.
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
    res = await fetchRetry(zip.url, { headers: { 'User-Agent': UA } })
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

export function dataDir(inst) {
  return path.join(inst.dir, 'data')
}

export function iniFile(inst) {
  return path.join(inst.dir, 'my.ini')
}

// Loopback only. skip-name-resolve keeps grants keyed by address, as the attach step writes them.
// utf8mb4 because plugins store player names and chat.
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

// A data folder that already holds system tables is left alone, so re-running never re-initialises a database with data.
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

// --console puts the log on stderr. Stop is the admin tool over TCP, since a database takes no
// console input; the password goes in the environment, never on a command line.
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

export function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function quoteStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

// Async because it runs inside the panel's process: with spawnSync, the client's first launch
// (scanned by Defender on a fresh machine) blocked the event loop for 5+ seconds and the panel's
// own requests timed out.
export async function sql(inst, statements) {
  const dir = toolsDir(inst)
  const client = binary(dir, 'client')
  if (!client) {
    fail(inst.external
      ? `no MariaDB/MySQL client tools found for "${inst.name}". Select a folder containing mariadb or mysql, or create a managed database here once to download its tools.`
      : `MariaDB ${inst.version} has no client tool under ${dir}`)
  }
  const { cmd, args, env } = runnable(client,
    [...rootArgs(inst), '--batch', '--skip-column-names', '--execute', statements],
    { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
  const { error, stdout, stderr } = await new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env, maxBuffer: 16 * 1024 * 1024 },
      (err, out, errOut) => resolve({ error: err, stdout: out, stderr: errOut }))
  })
  // a numeric code is the client's exit status (it ran and refused); anything else means it couldn't run or timed out
  if (error && typeof error.code !== 'number') {
    fail(`could not run the MariaDB client: ${error.killed ? 'it did not answer within a minute' : error.message}`)
  }
  if (error) fail(`MariaDB refused: ${(stderr || stdout || `exit ${error.code}`).trim()}`)
  return stdout ?? ''
}

// Two hosts because skip-name-resolve keys TCP connections by address: 'localhost' matches a socket
// or named pipe, '127.0.0.1' matches what a plugin opens. IF NOT EXISTS plus ALTER, so attaching
// twice repairs rather than refuses.
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

// Settles on 'close', not 'exit': exit can fire with output still in the pipe, which would cut a
// dump short and record it as a good backup (the only check is that the file exists). Same for
// stderr, which carries the failure reason.
//
// Every stream gets an error handler, since an unhandled stream error would crash the panel's
// process. A client that rejects the login exits while its input is still being fed (EPIPE); its
// exit code reports that, so the write error must not be a second failure.
export function runToFile(cmd, args, env, { stdout = null, stdin = null, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const abort = (message) => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      settle(reject, new UserError(message))
    }
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    if (stdout) {
      stdout.on('error', (err) => abort(`could not write the output of the MariaDB ${label}: ${err.message}`))
      child.stdout.pipe(stdout, { end: false })
    }
    if (stdin) {
      child.stdin.on('error', () => {})
      stdin.on('error', (err) => abort(`could not read the input for the MariaDB ${label}: ${err.message}`))
      stdin.pipe(child.stdin)
    }
    child.on('error', (err) => settle(reject, new UserError(`could not run the MariaDB ${label}: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) settle(resolve)
      else settle(reject, new UserError(`MariaDB ${label} exited ${code}: ${stderr.trim().split(/\r?\n/)[0] || 'no reason given'}`))
    })
  })
}

// --single-transaction gives a consistent snapshot without locking tables. --databases puts CREATE
// DATABASE and USE at the top, so the file imports without picking a database first.
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
  // end only now so every byte is handed to the file first; a flush failure (full disk) fails the dump
  try {
    await new Promise((resolve, reject) => {
      out.once('error', reject)
      out.end(resolve)
    })
  } catch (err) {
    fs.rmSync(file, { force: true })
    throw new UserError(`could not finish writing the dump of "${database}": ${err.message}`)
  }
  return { file, bytes: fs.statSync(file).size }
}

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

export async function probe(inst) {
  await sql(inst, 'SELECT 1;')
  return true
}

export function newRecord(serverName) {
  return { database: serverName, user: serverName, password: randomPassword(24), createdAt: new Date().toISOString() }
}

export async function provision(inst, record) {
  await sql(inst, attachSql(record))
  return { provisioned: true }
}

export async function deprovision(inst, record, { drop = false } = {}) {
  await sql(inst, detachSql({ database: record.database, user: record.user, drop }))
  return { deprovisioned: true, dropped: drop }
}

export function credentialsFor(inst, record) {
  return { jdbc: `jdbc:mysql://${hostOf(inst)}:${inst.port}/${record.database}` }
}
