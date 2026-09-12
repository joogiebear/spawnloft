/** Managed MySQL: official pinned native archives; no system service. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './tar.mjs'
import { fail, UserError } from './util.mjs'
import * as maria from './mariadb.mjs'
import { MARIADB_READY_RE } from './ready.mjs'

export const ENGINE = 'mysql'
export const LABEL = 'MySQL'
export const KIND = 'mariadb'
export const DEFAULT_PORT = 3306
export const canDump = true
export const VERSION = '8.4.11'
// Downloaded from Oracle's HTTPS CDN; architecture-specific SHA-256 pins prevent
// an upstream replacement from silently changing executable code in an existing preview.
export const ARCHIVES = Object.freeze({
  arm64: { file: 'mysql-8.4.11-macos15-arm64.tar.gz', sha256: 'b96e00493bc3499b9ffd7f08d65c5d64933af0383a8287d9873b64f94c2d6009' },
  x64: { file: 'mysql-8.4.11-macos15-x86_64.tar.gz', sha256: '90e8aea10698d01b978f0179e72e8d5e2cbe9f9bd5771e88b0b75d7c82244d3f' },
})
export const WINDOWS_ARCHIVE = Object.freeze({ file: 'mysql-8.4.11-winx64.zip', sha256: 'a492371d687d2bab088b0062581144a0044b8964baefdf4faa579292b423d25c' })

export function assertSupported({ platform = process.platform, arch = process.arch, release = os.release() } = {}) {
  if (platform === 'win32' && arch === 'x64') return
  if (platform !== 'darwin' || !Object.hasOwn(ARCHIVES, arch)) fail('Managed MySQL requires Windows x64 or an Apple Silicon or Intel Mac.')
  if (Number(release.split('.')[0]) < 24) fail('Managed MySQL requires macOS 15 or later. You can still connect to an existing MySQL database.')
}
export async function versions() {
  assertSupported()
  return [{ version: VERSION, series: '8.4', status: 'Stable', support: 'Long Term Support' }]
}
export function archiveFor(version, arch = process.arch, platform = process.platform) {
  const entry = platform === 'win32' && arch === 'x64' ? WINDOWS_ARCHIVE
    : platform === 'darwin' && Object.hasOwn(ARCHIVES, arch) ? ARCHIVES[arch] : null
  if (version !== VERSION || !entry) fail(`No verified MySQL ${version} archive for ${platform}/${arch}. See: spawnloft db versions`)
  return { ...entry, url: `https://cdn.mysql.com/Downloads/MySQL-8.4/${entry.file}` }
}
export function engineDir(version, platform = process.platform, arch = process.arch) {
  archiveFor(version, arch, platform)
  return path.join(ENGINES_DIR, `mysql-${version}-${platform}-${arch}`)
}
export const binary = maria.binary
const roles = ['server', 'admin', 'client', 'dump']
export function hasEngine(version) {
  const dir = engineDir(version)
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'spawnloft-engine.json'), 'utf8'))
    return marker.sha256 === archiveFor(version).sha256 && roles.every(role => binary(dir, role))
  } catch { return false }
}

/** Cross-process lock and private staging: a failed download never looks installed. */
export async function fetchEngine(version, { onProgress = null } = {}) {
  assertSupported()
  const archive = archiveFor(version)
  const dir = engineDir(version)
  if (hasEngine(version)) {
    onProgress?.({ cached: true, message: `MySQL ${version} is already here` })
    return { version, dir, cached: true }
  }
  fs.mkdirSync(ENGINES_DIR, { recursive: true })
  const lock = `${dir}.install-lock`
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) }
  catch (err) {
    if (err.code === 'EEXIST') fail(`MySQL installation is already in progress. If a previous installation was interrupted, close SpawnLoft and remove ${lock}, then retry.`)
    throw err
  }
  let staging
  try {
    if (hasEngine(version)) return { version, dir, cached: true }
    if (fs.existsSync(dir)) fail(`An incomplete MySQL engine exists at ${dir}. Move it aside before retrying; no existing files were replaced.`)
    staging = fs.mkdtempSync(path.join(ENGINES_DIR, '.mysql-download-'))
    const file = path.join(staging, archive.file)
    const unpacked = path.join(staging, 'engine')
    fs.mkdirSync(unpacked)
    const response = await fetch(archive.url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok || !response.body) fail(`MySQL download failed (${response.status}). Please retry.`)
    const total = Number(response.headers.get('content-length')) || 0
    let received = 0
    const hash = crypto.createHash('sha256')
    const input = Readable.fromWeb(response.body)
    input.on('data', chunk => {
      hash.update(chunk); received += chunk.length
      onProgress?.({ message: `Downloading MySQL ${version}`, received, total })
    })
    await pipeline(input, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))
    if (hash.digest('hex') !== archive.sha256) fail('MySQL download checksum mismatch. Nothing was installed; please retry.')
    onProgress?.({ message: `Unpacking MySQL ${version}` })
    const extracted = await runTar(['-xf', file, '--strip-components=1', '-C', unpacked], staging)
    if (extracted.code !== 0 || !roles.every(role => binary(unpacked, role))) fail('The MySQL archive did not unpack completely. Please retry.')
    fs.writeFileSync(path.join(unpacked, 'spawnloft-engine.json'), JSON.stringify({ version, arch: process.arch, sha256: archive.sha256 }))
    fs.renameSync(unpacked, dir)
    return { version, dir, cached: false }
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}

export const dataDir = maria.dataDir
export const iniFile = maria.iniFile
/** Short sockets support data folders with spaces and paths beyond the Unix socket limit. */
export function socketFor(inst) {
  const base = path.join('/tmp', `spawnloft-mysql-${process.getuid()}`)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(base)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail(`Cannot use MySQL socket directory ${base}`)
  fs.chmodSync(base, 0o700)
  return path.join(base, crypto.createHash('sha256').update(path.resolve(inst.dir)).digest('hex').slice(0, 20) + '.sock')
}
export function iniFor(inst, socket, platform = process.platform) {
  const value = text => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
  return ['# Managed by SpawnLoft; plugin configs remain manual.', '[mysqld]',
    `basedir=${value(engineDir(inst.version, platform))}`, `datadir=${value(dataDir(inst))}`,
    ...(platform === 'darwin' ? [`socket=${value(socket)}`] : []), `pid-file=${value(path.join(inst.dir, 'mysql.pid'))}`,
    `port=${inst.port}`, 'bind-address=127.0.0.1', 'mysqlx=0', 'skip-name-resolve',
    'character-set-server=utf8mb4', 'collation-server=utf8mb4_unicode_ci',
    'max_connections=100', 'log-error-verbosity=2', '',
  ].join('\n')
}

function execute(cmd, args, { env = process.env, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-32768) })
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-32768) })
    child.once('error', err => { clearTimeout(timer); reject(new UserError(`MySQL tool could not start: ${err.message}`)) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) resolve(stdout)
      else reject(new UserError(timedOut ? 'MySQL setup timed out.'
        : process.platform === 'win32' && [3221225781, -1073741515].includes(code)
          ? 'MySQL needs the Microsoft Visual C++ x64 runtime. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then retry.'
          : `MySQL tool exited ${code}: ${stderr.trim()}`))
    })
  })
}

/** Initialize without TCP, set root credentials, stop, then register the finished database. */
export async function initData(inst) {
  assertSupported()
  const dir = engineDir(inst.version)
  if (!hasEngine(inst.version)) fail('The MySQL engine installation is incomplete. Download it again.')
  if (fs.existsSync(dataDir(inst))) fail('Refusing to initialize an existing MySQL data directory.')
  fs.mkdirSync(inst.dir, { recursive: true, mode: 0o700 })
  const win = process.platform === 'win32'
  const socket = win ? null : socketFor(inst)
  fs.writeFileSync(iniFile(inst), iniFor(inst, socket), { mode: 0o600 })
  const server = binary(dir, 'server').path
  await execute(server, ['--no-defaults', '--version'])
  // --initialize creates a temporary random root password; it is captured, never logged.
  await execute(server, ['--no-defaults', '--initialize', `--basedir=${dir}`, `--datadir=${dataDir(inst)}`])
  const initFile = path.join(inst.dir, 'bootstrap.sql')
  const password = maria.quoteStr(inst.root.password)
  fs.writeFileSync(initFile, [
    `ALTER USER 'root'@'localhost' IDENTIFIED BY ${password};`,
    `CREATE USER 'root'@'127.0.0.1' IDENTIFIED BY ${password};`,
    "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;",
  ].join('\n'), { flag: 'wx', mode: 0o600 })
  let child, exited, timer
  const sharedMemory = `SpawnLoft-${crypto.randomUUID()}`
  try {
    child = spawn(server, [`--defaults-file=${iniFile(inst)}`, '--skip-networking', `--init-file=${initFile}`,
      ...(win ? ['--console', '--shared-memory', `--shared-memory-base-name=${sharedMemory}`] : [])],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    exited = new Promise(resolve => { child.once('error', () => resolve()); child.once('close', resolve) })
    await new Promise((resolve, reject) => {
      let log = ''
      timer = setTimeout(() => reject(new UserError('MySQL setup did not become ready within 60 seconds.')), 60000)
      child.once('error', reject)
      child.once('close', code => reject(new UserError(`MySQL setup stopped (${code}): ${log.replaceAll(inst.root.password, '[redacted]')}`)))
      child.stderr.on('data', chunk => {
        log = (log + chunk).slice(-8192)
        if (MARIADB_READY_RE.test(log)) resolve()
      })
    })
    clearTimeout(timer)
    await execute(binary(dir, 'admin').path, ['--no-defaults',
      ...(win ? ['--protocol=MEMORY', `--shared-memory-base-name=${sharedMemory}`] : ['--protocol=SOCKET', `--socket=${socket}`]), '--user=root', 'shutdown'],
      { env: { ...process.env, MYSQL_PWD: inst.root.password }, timeout: 30000 })
    await exited
    if (child.exitCode !== 0) fail('MySQL did not finish setup cleanly.')
    return { initialised: true }
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (exited) await exited
    fs.rmSync(initFile, { force: true })
  }
}

export function launchSpec(inst) {
  const dir = engineDir(inst.version)
  if (!hasEngine(inst.version)) fail('The managed MySQL engine is missing or incomplete.')
  if (process.platform === 'darwin') socketFor(inst)
  return {
    cmd: binary(dir, 'server').path, args: [`--defaults-file=${iniFile(inst)}`, ...(process.platform === 'win32' ? ['--console'] : [])], env: process.env, cwd: inst.dir,
    ready: MARIADB_READY_RE, failed: /\[ERROR\].*(?:Aborting|Can't start|Unable to lock|Fatal)/i,
    stop: { cmd: binary(dir, 'admin').path,
      args: ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', `--port=${inst.port}`, '--user=root', 'shutdown'],
      env: { ...process.env, MYSQL_PWD: inst.root.password } },
  }
}

// MySQL and MariaDB share SQL and client conventions. Select the managed tools explicitly;
// external instances retain normal discovery and any user-selected tools directory.
function withTools(inst) {
  return inst.external ? inst : { ...inst, external: true, tools: { dir: engineDir(inst.version) } }
}
export const newRecord = maria.newRecord
export const credentialsFor = maria.credentialsFor
export const sql = (inst, statements) => maria.sql(withTools(inst), statements)
export const probe = inst => maria.probe(withTools(inst))
export const provision = (inst, record) => maria.provision(withTools(inst), record)
export const deprovision = (inst, record, options) => maria.deprovision(withTools(inst), record, options)
export const dump = (inst, database, file) => maria.dump(withTools(inst), database, file)
export const importSql = (inst, file) => maria.importSql(withTools(inst), file)
