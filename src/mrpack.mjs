/**
 * Modrinth modpacks (.mrpack), as servers.
 *
 * <p>An .mrpack is a zip holding one honest manifest and two override folders:
 * `modrinth.index.json` lists every file the pack needs - path, hashes, download URLs, and
 * whether the server side wants it at all - and names the Minecraft version and loader the
 * pack was built against. `overrides/` and `server-overrides/` are config laid on top, the
 * second winning where they collide.
 *
 * <p>The flow here downloads and validates EVERYTHING it can before an instance exists, so
 * "this pack needs NeoForge" or a dead download URL costs nothing but time. Only once the
 * pack is proven installable is the instance created - and if laying the files in fails
 * partway, the half-built instance is torn down rather than left looking created.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { modrinthRequest, pickVersion, primaryFile, extractZip, recordManaged, readManaged, forgetManaged, readZipEntry } from './plugins.mjs'
import * as fabric from './fabric.mjs'
import * as neoforge from './neoforge.mjs'
import * as create from './create.mjs'
import { getInstance, removeInstance, updateInstance } from './registry.mjs'
import { createSnapshot } from './backup.mjs'
import { readState } from './control.mjs'
import { readProps, worldDirs } from './props.mjs'
import { fail, UserError, writeJson, assertSafeVersion, safeRelativePath, humanBytes } from './util.mjs'

/** The provenance record for a whole pack, written into the instance root. */
export const PACK_FILE = '.mcctl-pack.json'

/**
 * Where a pack may fetch its files from: the hosts the Modrinth pack format allows. A pack is
 * written by a stranger, and without this its index could point a download at any address the
 * machine can reach - a service on localhost, say - not just at a mod host.
 */
export const ALLOWED_PACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']

const HEX_SHA1 = /^[0-9a-f]{40}$/i
const HEX_SHA512 = /^[0-9a-f]{128}$/i

/** The URL as a normalised string when a pack may use it, or null: https, an allowed host, no login. */
export function allowedPackUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (url.port && url.port !== '443') return null
  if (!ALLOWED_PACK_HOSTS.includes(url.hostname.toLowerCase())) return null
  return url.href
}

/**
 * What the index says, reduced to what the install needs - and refused early when it names
 * a loader mcctl cannot run yet. Exported pure, so the refusals are testable without a pack.
 */
export function parseIndex(index) {
  if (!index || index.game !== 'minecraft' || !Array.isArray(index.files)) {
    fail('that file does not look like a Modrinth modpack index')
  }
  const deps = index.dependencies ?? {}
  const mc = deps.minecraft
  if (!mc) fail('the pack names no Minecraft version')
  for (const other of ['forge', 'quilt-loader']) {
    if (deps[other]) {
      fail(`this pack is built for ${other.replace('-loader', '')}, which SpawnLoft cannot run - Fabric and NeoForge packs only`)
    }
  }
  const loader = deps['fabric-loader']
    ? { kind: 'fabric', version: deps['fabric-loader'] }
    : deps.neoforge
      ? { kind: 'neoforge', version: deps.neoforge }
      : null
  if (!loader) fail('the pack names no loader SpawnLoft can run (Fabric or NeoForge)')
  // The pack author wrote these, and they become a file name in the jars store and part of a
  // download URL, so only version-shaped values are accepted - before anything is fetched.
  assertSafeVersion(mc, "the pack's Minecraft version")
  assertSafeVersion(loader.version, `the pack's ${loader.kind === 'fabric' ? 'Fabric loader' : 'NeoForge'} version`)

  const files = index.files
    .filter((f) => f.env?.server !== 'unsupported')
    .map((f) => ({
      path: String(f.path).replace(/\\/g, '/'),
      hashes: f.hashes && typeof f.hashes === 'object' ? f.hashes : {},
      downloads: Array.isArray(f.downloads) ? f.downloads : [],
      size: f.fileSize,
    }))
    .map((f) => ({ ...f, url: f.downloads.map(allowedPackUrl).find(Boolean) ?? null }))
  for (const f of files) {
    // Paths come from the pack author. Confined here once, so nothing later has to re-decide.
    const safe = safeRelativePath(f.path)
    if (safe === null) {
      fail(`the pack lists a file outside its own folder ("${f.path}"); refusing the whole pack`)
    }
    f.path = safe
    if (!f.downloads.length) fail(`the pack gives no download for "${f.path}"`)
    if (!f.url) {
      fail(`"${f.path}" is only offered from a host a pack may not use (https from ${ALLOWED_PACK_HOSTS.join(', ')} only); refusing the whole pack`)
    }
    // A hash the author did not publish is a hash nothing was checked against, so a file with none
    // is refused rather than trusted. Whatever hashes ARE published are all checked at download.
    for (const [kind, shape] of [['sha1', HEX_SHA1], ['sha512', HEX_SHA512]]) {
      if (f.hashes[kind] != null && !shape.test(String(f.hashes[kind]))) {
        fail(`the pack's ${kind} checksum for "${f.path}" is not a checksum; refusing the whole pack`)
      }
    }
    if (!f.hashes.sha1 && !f.hashes.sha512) {
      fail(`the pack publishes no checksum for "${f.path}", so it could not be verified; refusing the whole pack`)
    }
    if (f.size != null && !(Number.isSafeInteger(f.size) && f.size >= 0)) {
      fail(`the pack lists an impossible size for "${f.path}"; refusing the whole pack`)
    }
  }
  return {
    name: index.name || 'modpack',
    versionId: index.versionId || null,
    mc,
    loader,
    files: files.map((f) => ({
      path: f.path,
      sha1: f.hashes.sha1 ? String(f.hashes.sha1).toLowerCase() : null,
      sha512: f.hashes.sha512 ? String(f.hashes.sha512).toLowerCase() : null,
      url: f.url,
      size: f.size ?? 0,
    })),
    skipped: index.files.length - files.length,
  }
}

/**
 * Put the pack's loader in place. Fabric is a launcher jar fetched before the instance
 * exists; NeoForge is an installer run INTO the instance, so it can only happen after -
 * which is why this takes the instance dir and answers with the jar name to record.
 */
async function installLoader(inst, index, onProgress) {
  if (index.loader.kind === 'fabric') {
    onProgress({ message: `Fetching Fabric ${index.loader.version} for ${index.mc}`, percent: null })
    const launcher = await fabric.fetchLauncher(index.mc, { loader: index.loader.version })
    create.placeJar(inst.dir, launcher.name)
    return launcher.name
  }
  const installer = await neoforge.fetchInstaller(index.loader.version, { onProgress })
  await neoforge.installServer(inst.dir, installer.path, { java: inst.java, onProgress })
  return 'server.jar'
}

async function download(url, { timeoutMs = 180000 } = {}) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new UserError(`download failed: ${err.cause?.message || err.message} (${url})`)
  }
  if (!res.ok) throw new UserError(`download failed: ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * The most one pack file may be. A mod is megabytes, a big one tens; this is far past any real file
 * and exists so a pack cannot fill the disk by lying about, or never ending, a download.
 */
export const MAX_PACK_FILE_BYTES = 1024 * 1024 * 1024
// What a file may be when the pack states no size - the format requires one, but a pack is a stranger's file.
export const DEFAULT_PACK_FILE_BYTES = 256 * 1024 * 1024
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** An address that is this machine or its own network, which a mod host never is. */
function isLocalHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true
  if (h.startsWith('::ffff:') || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Download one pack file to `dest`, checked against everything the pack says about it.
 *
 * <p>Streamed to a `.part` file beside `dest` rather than held in memory, and only renamed into
 * place once it is the declared size and matches every checksum the pack published - so a bad file
 * never has the right name. The size the pack declares is also the most that will be read, which is
 * what stops a download that never ends. Redirects are followed by hand, because a CDN does
 * redirect (GitHub release assets do) but never to anything that is not https on the internet.
 */
export async function downloadVerified(url, dest, {
  size = 0, sha1 = null, sha512 = null, label = url, timeoutMs = 180000, maxRedirects = 5, fetchImpl = fetch,
} = {}) {
  if (size > MAX_PACK_FILE_BYTES) {
    throw new UserError(`"${label}" says it is ${humanBytes(size)}, more than the ${humanBytes(MAX_PACK_FILE_BYTES)} a pack file may be; nothing was installed`)
  }
  const cap = size > 0 ? size : DEFAULT_PACK_FILE_BYTES
  const signal = AbortSignal.timeout(timeoutMs)

  let current = url
  let res
  for (let hop = 0; ; hop++) {
    let target
    try {
      target = new URL(current)
    } catch {
      throw new UserError(`download failed: "${current}" is not a URL`)
    }
    if (target.protocol !== 'https:' || target.username || target.password || isLocalHost(target.hostname)) {
      throw new UserError(`download refused: ${target.origin} is not an https address on the internet`)
    }
    try {
      res = await fetchImpl(target.href, { redirect: 'manual', signal })
    } catch (err) {
      throw new UserError(`download failed: ${err.cause?.message || err.message} (${url})`)
    }
    if (!REDIRECT_STATUS.has(res.status)) break
    const next = res.headers.get('location')
    await res.body?.cancel?.().catch(() => {})
    if (!next || hop >= maxRedirects) throw new UserError(`download failed: too many redirects (${url})`)
    current = new URL(next, target).href
  }
  if (!res.ok || !res.body) throw new UserError(`download failed: ${res.status} for ${url}`)
  const announced = Number(res.headers.get('content-length')) || 0
  if (announced > cap) {
    await res.body.cancel().catch(() => {})
    throw new UserError(`"${label}" is larger than the ${humanBytes(cap)} the pack allows for it; nothing was installed`)
  }

  const part = `${dest}.part`
  const sums = [['sha1', sha1], ['sha512', sha512]].filter(([, want]) => want).map(([kind, want]) => ({ kind, want, hash: crypto.createHash(kind) }))
  let received = 0
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length
          if (received > cap) throw new UserError(`"${label}" is larger than the ${humanBytes(cap)} the pack allows for it; nothing was installed`)
          for (const s of sums) s.hash.update(chunk)
          yield chunk
        }
      },
      fs.createWriteStream(part),
    )
  } catch (err) {
    fs.rmSync(part, { force: true })
    throw err instanceof UserError ? err : new UserError(`download failed: ${err.cause?.message || err.message} (${url})`)
  }
  if (size > 0 && received !== size) {
    fs.rmSync(part, { force: true })
    throw new UserError(`"${label}" is not the size the pack published; nothing was installed`)
  }
  for (const s of sums) {
    if (s.hash.digest('hex') !== s.want) {
      fs.rmSync(part, { force: true })
      throw new UserError(`"${label}" did not match the checksum the pack published; nothing was installed`)
    }
  }
  fs.renameSync(part, dest)
  return { bytes: received }
}

/** The newest installable release of a pack, or a readable refusal. */
async function resolvePackVersion(projectId) {
  const RUNNABLE = ['fabric', 'neoforge']
  const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${new URLSearchParams({ loaders: JSON.stringify(RUNNABLE) })}`)
  const version = pickVersion(versions, { loaders: RUNNABLE })
  if (!version) fail('that pack has no Fabric or NeoForge release SpawnLoft can install')
  const packFile = primaryFile(version)
  if (!packFile) fail('that pack version has no downloadable file')
  return { version, packFile }
}

/** Download one pack archive into a scratch dir, checksummed, and read its index. */
async function fetchPackArchive(packFile, onProgress) {
  onProgress({ message: `Downloading ${packFile.filename}`, percent: null })
  const packBytes = await download(packFile.url)
  if (packFile.hashes?.sha1) {
    const got = crypto.createHash('sha1').update(packBytes).digest('hex')
    if (got !== packFile.hashes.sha1) fail('the pack download did not match its checksum; nothing was installed')
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-mrpack-'))
  const mrpack = path.join(tmp, 'pack.mrpack')
  fs.writeFileSync(mrpack, packBytes)

  const rawIndex = readZipEntry(mrpack, 'modrinth.index.json')
  if (!rawIndex) fail('the pack has no modrinth.index.json - it is not an mrpack')
  const index = parseIndex(JSON.parse(rawIndex.toString('utf8')))
  return { tmp, mrpack, index }
}

/**
 * Every server-side file the index lists, downloaded and checksummed into `tmp`.
 *
 * <p>On disk rather than in memory: a pack is hundreds of files, and holding all of them at once
 * is a lot of RAM for what is only a waiting room. `tmp` is the scratch folder the caller removes.
 */
export async function stagePackFiles(index, tmp, onProgress, { fetchImpl = fetch } = {}) {
  const dir = path.join(tmp, 'staged')
  fs.mkdirSync(dir, { recursive: true })
  const staged = []
  for (let i = 0; i < index.files.length; i++) {
    const f = index.files[i]
    onProgress({
      message: `Downloading ${path.posix.basename(f.path)} (${i + 1} of ${index.files.length})`,
      percent: Math.round((i / Math.max(1, index.files.length)) * 100),
    })
    const file = path.join(dir, String(i))
    await downloadVerified(f.url, file, { size: f.size, sha1: f.sha1, sha512: f.sha512, label: f.path, fetchImpl })
    staged.push({ ...f, file })
  }
  return staged
}

/**
 * Build a new server from a Modrinth modpack, end to end.
 *
 * <p>Progress lands on `onProgress({ message, percent })` - a pack is dozens of downloads,
 * and dozens of downloads with no narration reads as a hang.
 */
export async function createFromModpack(name, projectId, {
  memory = '4G', port = null, onlineMode = true, onProgress = () => {},
} = {}) {
  // ---- resolve and fetch the pack itself, before anything exists ------------
  onProgress({ message: 'Finding the pack on Modrinth', percent: null })
  const { version, packFile } = await resolvePackVersion(projectId)
  const { tmp, mrpack, index } = await fetchPackArchive(packFile, onProgress)

  // ---- everything the pack needs, downloaded and verified up front ----------
  // Fabric's launcher and NeoForge's installer both cache into the jars store here, so the
  // loader step after the instance exists is a cache hit, not a fresh gamble.
  let staged
  let inst
  try {
    if (index.loader.kind === 'fabric') {
      onProgress({ message: `Fetching Fabric ${index.loader.version} for ${index.mc}`, percent: null })
      await fabric.fetchLauncher(index.mc, { loader: index.loader.version })
    } else {
      await neoforge.fetchInstaller(index.loader.version, { onProgress })
    }

    staged = await stagePackFiles(index, tmp, onProgress)

    // ---- only now does the instance exist -------------------------------------
    onProgress({ message: 'Creating the server', percent: null })
    inst = await create.newInstance(name, {
      jar: null,
      loader: index.loader.kind,
      mcVersion: index.mc,
      memory,
      port,
      onlineMode,
      acceptEula: true,
      motd: index.name,
    })
  } catch (err) {
    // Nothing exists yet but the scratch folder, which now holds the staged files: not left behind.
    fs.rmSync(tmp, { recursive: true, force: true })
    throw err
  }

  try {
    const jarName = await installLoader(inst, index, onProgress)
    updateInstance(name, { jar: jarName })
    for (const f of staged) {
      const target = path.join(inst.dir, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(f.file, target)
      // Pack-owned mods are managed BY THE PACK: shown in the Mods tab, but never offered an
      // individual update - updating one mod out of a pack is how packs break.
      if (f.path.startsWith('mods/') && f.path.endsWith('.jar') && !f.path.slice(5).includes('/')) {
        recordManaged(inst, path.posix.basename(f.path), {
          source: 'modpack',
          project: String(projectId),
          version: version.version_number,
          installedAt: new Date().toISOString(),
        })
      }
    }
    onProgress({ message: 'Applying the pack’s configuration', percent: null })
    const strip = (prefix) => (entryName) =>
      entryName.startsWith(prefix) ? entryName.slice(prefix.length) : null
    const laid = extractZip(mrpack, inst.dir, { mapPath: strip('overrides/') })
    const laidServer = extractZip(mrpack, inst.dir, { mapPath: strip('server-overrides/') })

    writeJson(path.join(inst.dir, PACK_FILE), {
      project: String(projectId),
      versionId: index.versionId,
      versionNumber: version.version_number,
      name: index.name,
      mc: index.mc,
      loader: index.loader,
      installedAt: new Date().toISOString(),
      files: [...index.files.map((f) => f.path), ...laid, ...laidServer],
      skippedClientOnly: index.skipped,
    })
  } catch (err) {
    // A half-laid pack must not sit there looking like a server. The instance was created by
    // this call, so this call cleans it up before failing.
    try {
      removeInstance(name)
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  return {
    name,
    pack: index.name,
    packVersion: version.version_number,
    mc: index.mc,
    loader: index.loader,
    files: index.files.length,
    skippedClientOnly: index.skipped,
    port: inst.port,
  }
}

/** An older record wrote fabricLoader; a newer one writes loader. Read either. */
function loaderOfRecord(pack) {
  return pack.loader ?? (pack.fabricLoader ? { kind: 'fabric', version: pack.fabricLoader } : null)
}

/** The pack record for an instance, or null for a server no pack built. */
export function packOf(inst) {
  try {
    return JSON.parse(fs.readFileSync(path.join(inst.dir, PACK_FILE), 'utf8'))
  } catch {
    return null
  }
}

// ---- updating an installed pack --------------------------------------------

/**
 * What an update may DELETE: files the old pack owned that the new one does not - and
 * nothing else, ever. Exported pure, because this list is the entire safety argument of a
 * pack update and it deserves tests that need no pack.
 *
 * <p>`protect` guards what must survive even a confused record: the worlds (a pack that
 * shipped one has long since had it overwritten by real play), the server's own root files,
 * and mcctl's provenance. A path is matched exactly or as a directory prefix.
 */
export function planRemovals(oldFiles = [], newFiles = [], { protect = [] } = {}) {
  const keep = new Set(newFiles.map((p) => String(p).replace(/\\/g, '/')))
  const guarded = (p) => protect.some((g) => p === g || p.startsWith(`${g}/`))
  return [...new Set(oldFiles.map((p) => String(p).replace(/\\/g, '/')))]
    .filter((p) => !keep.has(p) && !guarded(p) && !p.split('/').includes('..') && !p.startsWith('/'))
}

function protectedPaths(inst) {
  const props = readProps(path.join(inst.dir, 'server.properties'))
  return [
    ...worldDirs(props),
    'server.properties', 'eula.txt', 'ops.json', 'whitelist.json',
    'banned-players.json', 'banned-ips.json', 'usercache.json',
    PACK_FILE, 'mods/.mcctl-plugins.json', 'plugins/.mcctl-plugins.json',
  ]
}

/** Whether a newer installable release of this server's pack exists. */
export async function checkPackUpdate(inst) {
  const pack = packOf(inst)
  if (!pack) fail(`"${inst.name}" was not built from a modpack`)
  const { version } = await resolvePackVersion(pack.project)
  return {
    pack: { name: pack.name, version: pack.versionNumber, project: pack.project, mc: pack.mc },
    latest: { version: version.version_number, id: version.id },
    updateAvailable: version.version_number !== pack.versionNumber,
  }
}

/**
 * Move an installed pack server to the pack's newest release.
 *
 * <p>The order is the whole design. Everything new is downloaded and checksummed FIRST, so
 * a dead URL costs nothing; a standard snapshot is taken next, so the way back exists before
 * anything changes; only then are new files laid in, and only files the OLD record owned and
 * the new pack dropped are deleted - the worlds and everything the person added are not the
 * pack's to touch. The provenance record and managed-mod store are rewritten to match.
 */
export async function updatePack(name, { onProgress = () => {} } = {}) {
  const inst = getInstance(name)
  const { status } = readState(name)
  if (status === 'running' || status === 'stopping') {
    fail(`"${name}" is running - stop it before updating its pack, or its own files change under it`)
  }
  const pack = packOf(inst)
  if (!pack) fail(`"${name}" was not built from a modpack`)

  onProgress({ message: 'Finding the pack on Modrinth', percent: null })
  const { version, packFile } = await resolvePackVersion(pack.project)
  if (version.version_number === pack.versionNumber) {
    return { alreadyLatest: true, version: pack.versionNumber }
  }

  const { tmp, mrpack, index } = await fetchPackArchive(packFile, onProgress)
  try {
    // Warm the loader artifact into the store now, so the install step after the snapshot is
    // a cache hit rather than a fresh download that could fail mid-change.
    if (index.loader.kind === 'fabric') {
      onProgress({ message: `Fetching Fabric ${index.loader.version} for ${index.mc}`, percent: null })
      await fabric.fetchLauncher(index.mc, { loader: index.loader.version })
    } else {
      await neoforge.fetchInstaller(index.loader.version, { onProgress })
    }
    const staged = await stagePackFiles(index, tmp, onProgress)

    onProgress({ message: 'Snapshotting before anything changes', percent: null })
    const snap = await createSnapshot(inst, { scope: 'standard', label: 'pre-pack-update', running: false })

    // ---- lay the new pack in ------------------------------------------------
    onProgress({ message: 'Applying the new pack', percent: null })
    for (const f of staged) {
      const target = path.join(inst.dir, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(f.file, target)
    }
    const strip = (prefix) => (entryName) =>
      entryName.startsWith(prefix) ? entryName.slice(prefix.length) : null
    const laid = extractZip(mrpack, inst.dir, { mapPath: strip('overrides/') })
    const laidServer = extractZip(mrpack, inst.dir, { mapPath: strip('server-overrides/') })
    const newOwned = [...index.files.map((f) => f.path), ...laid, ...laidServer]

    // ---- retire what the old pack owned and the new one dropped -------------
    const removals = planRemovals(pack.files, newOwned, { protect: protectedPaths(inst) })
    for (const p of removals) {
      fs.rmSync(path.join(inst.dir, ...p.split('/')), { force: true })
    }

    // ---- the loader, the registry, and the records --------------------------
    const oldLoader = loaderOfRecord(pack)
    if (!oldLoader || index.loader.kind !== oldLoader.kind || index.loader.version !== oldLoader.version) {
      const jarName = await installLoader(inst, index, onProgress)
      if (jarName !== inst.jar) updateInstance(name, { jar: jarName })
    }
    updateInstance(name, { mcVersion: index.mc, loader: index.loader.kind })
    for (const [file, entry] of Object.entries(readManaged(inst).managed)) {
      if (entry.source === 'modpack' && !fs.existsSync(path.join(inst.dir, contentPathFor(inst, file)))) {
        forgetManaged(inst, file)
      }
    }
    for (const f of index.files) {
      if (f.path.startsWith('mods/') && f.path.endsWith('.jar') && !f.path.slice(5).includes('/')) {
        recordManaged(inst, path.posix.basename(f.path), {
          source: 'modpack',
          project: pack.project,
          version: version.version_number,
          installedAt: new Date().toISOString(),
        })
      }
    }
    writeJson(path.join(inst.dir, PACK_FILE), {
      project: pack.project,
      versionId: index.versionId,
      versionNumber: version.version_number,
      name: index.name,
      mc: index.mc,
      loader: index.loader,
      installedAt: new Date().toISOString(),
      files: newOwned,
      skippedClientOnly: index.skipped,
    })

    return {
      from: pack.versionNumber,
      to: version.version_number,
      mc: index.mc,
      mcChanged: index.mc !== pack.mc,
      loader: index.loader,
      files: index.files.length,
      removed: removals.length,
      snapshot: snap.file,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Where a managed-store filename actually lives for this instance's content kind. */
function contentPathFor(inst, file) {
  return path.join(inst.loader === 'fabric' || inst.loader === 'neoforge' ? 'mods' : 'plugins', file)
}
