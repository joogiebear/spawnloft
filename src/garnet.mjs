import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './tar.mjs'
import { respPing } from './resp.mjs'
import { GARNET_READY_RE, GARNET_FAILED_RE } from './ready.mjs'
import { fail, humanBytes } from './util.mjs'

/**
 * Garnet, for the Redis role.
 *
 * <p>Redis itself ships no Windows binary. Microsoft's Garnet speaks the Redis protocol, is MIT
 * licensed, and publishes native Windows and macOS builds on its GitHub releases page - which is
 * the same feed shape this program already reads for its own updates. Plugins using supported Redis commands can use it for messaging or caching;
 * command compatibility should be checked for each plugin.
 *
 * <p>Unlike MariaDB there is no per-server database or user: Redis has one password and one key
 * space, and plugins are expected to prefix their keys. So an attachment here is the same
 * credentials for every server, recorded so the panel can say who uses it.
 */

const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

export const VERSION = '2.1.7'
export const ENGINE = 'garnet'
export const LABEL = 'Redis (Garnet)'
export const KIND = 'redis'
export const DEFAULT_PORT = 6379
export const READY_RE = GARNET_READY_RE
export const FAILED_RE = GARNET_FAILED_RE

// Native release assets verified against Microsoft's published SHA-256 digests.
export const ARCHIVES = Object.freeze({
  'win32-x64': { name: 'win-x64-based-readytorun.zip', sha256: '3409c9aba39565caa4c6166f2d7c66ac112c2a773d70679b1bb34458dea16473' },
  'darwin-arm64': { name: 'osx-arm64-based.tar.xz', sha256: 'e4b41812a5c554735046022e6f4ab8a8651511444f284935339296bd83e431b9' },
  'darwin-x64': { name: 'osx-x64-based.tar.xz', sha256: '19bf42260c35d5521794f4a422e3df5d8cb0a921ab3a10a896413d4b7d45abdd' },
})
export function archiveFor(version, platform = process.platform, arch = process.arch) {
  const archive = ARCHIVES[`${platform}-${arch}`]
  if (version !== VERSION || !archive) fail(`No verified Redis (Garnet) ${version} archive for ${platform}/${arch}.`)
  return { ...archive, url: `https://github.com/microsoft/garnet/releases/download/v${VERSION}/${archive.name}` }
}

/** The Windows x64 ReadyToRun zip on a release, or null. */
export function windowsZipFrom(release) {
  const assets = release?.assets ?? []
  const win = assets.filter((a) => /win-?x64/i.test(a.name) && /\.zip$/i.test(a.name))
  // Select the native ReadyToRun package. Installation supplies its private .NET runtime.
  const hit = win.find((a) => /readytorun|self-?contained/i.test(a.name))
  if (!hit) return null
  const digest = typeof hit.digest === 'string' && hit.digest.startsWith('sha256:') ? hit.digest.slice(7) : null
  return { name: hit.name, url: hit.browser_download_url, sha256: digest, size: Number(hit.size) || 0 }
}

/** Select only a native release for this machine. */
export function archiveFrom(release, platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return windowsZipFrom(release)
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return null
  const hit = (release?.assets ?? []).find(a => a.name === `osx-${arch}-based.tar.xz`)
  if (!hit) return null
  return { name: hit.name, url: hit.browser_download_url,
    sha256: typeof hit.digest === 'string' && hit.digest.startsWith('sha256:') ? hit.digest.slice(7) : null,
    size: Number(hit.size) || 0 }
}

export function releasesFrom(list, { includeUnstable = false, platform = 'win32', arch = 'x64' } = {}) {
  const out = []
  for (const r of list ?? []) {
    if (r.draft) continue
    if (!includeUnstable && r.prerelease) continue
    if (!archiveFrom(r, platform, arch)) continue
    out.push({
      version: String(r.tag_name ?? r.name ?? '').replace(/^v/, ''),
      status: r.prerelease ? 'Pre-release' : 'Stable',
      support: null,
      date: r.published_at ? String(r.published_at).slice(0, 10) : null,
      tag: r.tag_name,
    })
  }
  return out
}

export async function versions() {
  archiveFor(VERSION)
  return [{ version: VERSION, status: 'Stable', support: 'Verified native build' }]
}

export function engineDir(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9.-]+)?$/.test(String(version))) fail('Invalid Garnet version')
  return path.join(ENGINES_DIR, `garnet-${version}`)
}

/**
 * The server binary, wherever the zip put it: the root, bin/, or one folder down. A .mjs is a
 * test standing in for it.
 */
export function binary(dir, role = 'server') {
  if (role !== 'server') return null
  const names = ['GarnetServer.exe', 'GarnetServer', 'GarnetServer.mjs']
  const places = [dir, path.join(dir, 'bin')]
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) places.push(path.join(dir, e.name))
  } catch {
    return null
  }
  for (const p of places) {
    for (const n of names) {
      const f = path.join(p, n)
      if (fs.existsSync(f)) return { path: f, script: n.endsWith('.mjs') }
    }
  }
  return null
}

export function hasEngine(version) {
  const dir = engineDir(version)
  const server = binary(dir)
  if (!server) return false
  if (server.script) return true
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'spawnloft-engine.json'), 'utf8'))
    return marker.platform === process.platform && marker.arch === process.arch && marker.sha256 === archiveFor(version).sha256 &&
      fs.existsSync(path.join(dir, '.runtime', 'shared', 'Microsoft.NETCore.App', RUNTIME_VERSION))
  } catch { return false }
}

function runnable(bin, args, env = process.env) {
  if (bin.script) return { cmd: process.execPath, args: [bin.path, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { cmd: bin.path, args, env }
}

export async function fetchEngine(version, { onProgress = null } = {}) {
  const dir = engineDir(version)
  if (hasEngine(version)) {
    onProgress?.({ cached: true, message: `Garnet ${version} is already here` })
    return { version, dir, cached: true }
  }
  if (!((process.platform === 'win32' && process.arch === 'x64') ||
        (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)))) {
    fail('Managed Redis (Garnet) requires Windows x64 or an Apple Silicon or Intel Mac.')
  }
  if (version !== VERSION) fail(`No verified Garnet ${version} bundle. See: mcctl db versions --engine garnet`)
  const archive = archiveFor(version)
  fs.mkdirSync(ENGINES_DIR, { recursive: true })
  const lock = `${dir}.install-lock`
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) }
  catch (err) {
    if (err.code === 'EEXIST') fail(`Redis installation is already in progress. If it was interrupted, close SpawnLoft and remove ${lock}, then retry.`)
    throw err
  }
  let staging
  try {
    if (hasEngine(version)) return { version, dir, cached: true }
    if (fs.existsSync(dir)) fail(`An incomplete Garnet engine exists at ${dir}. Move it aside before retrying.`)
    staging = fs.mkdtempSync(path.join(ENGINES_DIR, '.garnet-download-'))
    const file = path.join(staging, 'download')
    const unpacked = path.join(staging, 'engine')
    fs.mkdirSync(unpacked)
    const res = await fetch(archive.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(600000) })
    if (!res.ok || !res.body) fail(`Garnet download failed (${res.status}). Please retry.`)
    const hash = crypto.createHash('sha256')
    const source = Readable.fromWeb(res.body)
    let received = 0
    const total = Number(res.headers.get('content-length')) || archive.size || 0
    source.on('data', chunk => {
      hash.update(chunk); received += chunk.length
      onProgress?.({ message: `Downloading Redis (Garnet) ${version}`, received, total })
    })
    await pipeline(source, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))
    if (hash.digest('hex') !== archive.sha256) fail('Garnet download checksum mismatch. Nothing was installed; please retry.')
    onProgress?.({ message: `Unpacking Redis (Garnet) ${version}` })
    const result = await runTar(['-xf', file, '-C', unpacked], staging)
    const server = binary(unpacked)
    if (result.code !== 0 || !server) fail('The Garnet archive did not unpack completely.')
    if (process.platform === 'darwin') fs.chmodSync(server.path, 0o755)
    await installRuntime(unpacked, staging, onProgress)
    fs.writeFileSync(path.join(unpacked, 'spawnloft-engine.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, sha256: archive.sha256 }))
    fs.renameSync(unpacked, dir)
    return { version, dir, cached: false, sizeHuman: humanBytes(total) }
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}

export function dataDir(inst) {
  return path.join(inst.dir, 'data')
}

/** Nothing to initialise but the folder: Garnet makes its checkpoint files on first save. */
export function initData(inst) {
  fs.mkdirSync(dataDir(inst), { recursive: true })
  return { initialised: true }
}

/**
 * Loopback, password auth, checkpoints and an append-only log in the data folder, recovered
 * on start. The password is on the command line, which is readable by other processes on this
 * machine; Garnet takes it no other way, and this is one person's PC. Stop waits for SAVE to acknowledge a durable checkpoint, then terminates the process;
 * Garnet does not implement the Redis SHUTDOWN command.
 */
export function launchSpec(inst) {
  const dir = engineDir(inst.version)
  const server = binary(dir)
  if (!server) fail(`Garnet ${inst.version} is not in the engine store (${dir}). Add the database again to fetch it.`)
  const runtime = path.join(dir, '.runtime')
  const env = server.script ? process.env : { ...process.env, DOTNET_ROOT: runtime,
    [`DOTNET_ROOT_${process.arch.toUpperCase()}`]: runtime, DOTNET_MULTILEVEL_LOOKUP: '0' }
  const run = runnable(server, [
    '--port', String(inst.port),
    '--bind', '127.0.0.1',
    '--auth', 'Password',
    '--password', inst.root?.password ?? '',
    '--checkpointdir', dataDir(inst),
    '--recover',
    '--aof',
  ], env)
  return {
    cmd: run.cmd,
    args: run.args,
    env: run.env,
    cwd: inst.dir,
    ready: READY_RE,
    failed: FAILED_RE,
    stop: { resp: { host: '127.0.0.1', port: inst.port, password: inst.root?.password ?? '', commands: [['SAVE']], terminateAfterSave: true } },
  }
}

// ---- the engine interface ----------------------------------------------------------------------

export function hostOf(inst) {
  return inst.host ?? '127.0.0.1'
}

/** Is it answering? PING with the password. */
export async function probe(inst) {
  return respPing(hostOf(inst), inst.port, { password: inst.root?.password || null })
}

/** One key space, one password: an attachment is a record of who uses it, not a new user. */
export function newRecord(serverName, inst) {
  return { database: null, user: null, password: inst.root?.password ?? '', keyPrefix: `${serverName}:`, createdAt: new Date().toISOString() }
}

export function provision() {
  return { provisioned: false }
}

export function deprovision() {
  return { deprovisioned: false }
}

export function credentialsFor(inst, record) {
  const host = hostOf(inst)
  const pw = record.password ?? inst.root?.password ?? ''
  return {
    url: `redis://${pw ? ':' + encodeURIComponent(pw) + '@' : ''}${host}:${inst.port}`,
    keyPrefix: record.keyPrefix ?? null,
    note: 'Redis has no per-server databases or users: every server attached here shares this password and key space. Plugins prefix their keys; LuckPerms and most others do it for you.',
  }
}

export const canDump = false

// Official Microsoft runtime archives; private to this engine, without a system install.
export const RUNTIME_VERSION = '10.0.12'
export const RUNTIME_HASHES = Object.freeze({
  'win-x64': '844fa99e16fd6f44e0a7c29def7a82d7846902334d6a955248a9519a4dddb3f5acceb9c9223bef69f8c83b8ae2417537e5b76dddf79fb7117dc85b5039bc1297',
  'osx-arm64': 'd1b422c2afecb5e741430584c3e1887d5e0f2df321a80d492fdd13d8c7f99579f0dbbf34e348bc512cb276f0f86b4645423a032ded52808b74ab8eb0d7bf2a6d',
  'osx-x64': 'c5019357c9d8fbe30b49ec8f81ae85be56a784d8b4b75f470e931583c39e082773c089b39785b322770a298ab08636c6b30e695a2397fc311060f73c98743b48',
})
async function installRuntime(dir, staging, onProgress) {
  const rid = `${process.platform === 'win32' ? 'win' : 'osx'}-${process.arch}`
  const suffix = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const url = `https://builds.dotnet.microsoft.com/dotnet/Runtime/${RUNTIME_VERSION}/dotnet-runtime-${RUNTIME_VERSION}-${rid}.${suffix}`
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) })
  if (!res.ok || !res.body) fail(`Redis runtime download failed (${res.status}). Please retry.`)
  const file = path.join(staging, 'runtime-archive')
  const hash = crypto.createHash('sha512')
  const input = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || 0
  input.on('data', chunk => {
    hash.update(chunk); received += chunk.length
    onProgress?.({ message: 'Downloading the private Redis runtime', received, total })
  })
  await pipeline(input, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))
  if (hash.digest('hex') !== RUNTIME_HASHES[rid]) fail('Redis runtime checksum mismatch. Nothing was installed.')
  const runtime = path.join(dir, '.runtime')
  fs.mkdirSync(runtime)
  const result = await runTar(['-xf', file, '-C', runtime], staging)
  if (result.code !== 0 || !fs.existsSync(path.join(runtime, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')))
    fail('The Redis runtime archive did not unpack completely.')
}
