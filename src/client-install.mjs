import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { versionJson, versionJar, LIBRARIES_DIR, ASSETS_DIR, nativesDir, logConfigPath } from './client-paths.mjs'
import { currentOs, mergeInherited, libraries, assetIndex, assetObjects, assetLayout, platformRefusal, nativesLibrarySubdir, nativesExtraDirs, loggingConfig } from './client-meta.mjs'
import { nativesStamp } from './client-version.mjs'
import { downloadFile } from './download.mjs'
import { extractZip } from './plugins.mjs'
import { fail, safeRelativePath, isInside } from './util.mjs'

export const PARALLEL = 8

export function needsDownload(file, { sha1 = null, size = null } = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return true
  }
  if (size != null && stat.size !== size) return true
  if (sha1 != null) {
    const actual = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
    if (actual !== sha1.toLowerCase()) return true
  }
  return false
}

function linkOrCopy(from, to) {
  fs.rmSync(to, { force: true })
  try {
    fs.linkSync(from, to)
  } catch {
    fs.copyFileSync(from, to)
  }
}

async function inBatches(items, limit, worker) {
  let index = 0
  let failed = false
  async function next() {
    while (!failed && index < items.length) {
      const i = index++
      try {
        await worker(items[i], i)
      } catch (err) {
        // the first failure rejects the call; the other workers finish their item and stop
        failed = true
        throw err
      }
    }
  }
  const n = Math.min(limit, items.length)
  const workers = Array.from({ length: n }, () => next())
  await Promise.all(workers)
}

// One data root can serve two operating systems (a dual boot, a portable drive): the stamp says
// whose natives are extracted and from which rows (nativesStamp), so a switch re-extracts them.
// subdir: the folder under natives/<id> the version's java.library.path names ('' for natives/<id>);
// extraDirs: the other folders its arguments name there, made empty
export async function extractNatives(id, nativeRows, { stamp, subdir = '', extraDirs = [] }) {
  const root = nativesDir(id)
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, subdir)
  fs.mkdirSync(dir, { recursive: true })
  for (const extra of extraDirs) fs.mkdirSync(path.join(root, extra), { recursive: true })

  // a jar listed under two rows is extracted once
  const seen = new Set()
  let files = 0
  for (const row of nativeRows) {
    if (seen.has(row.path)) continue
    seen.add(row.path)
    const exclude = row.native.extract.exclude
    const written = extractZip(path.join(LIBRARIES_DIR, row.path), dir, {
      mapPath: (name) => {
        if (name.startsWith('META-INF/')) return null
        for (const prefix of exclude) {
          if (name.startsWith(prefix)) return null
        }
        return name
      },
    })
    files += written.length
  }

  fs.writeFileSync(path.join(root, '.complete'), stamp)
  return { files }
}

// What ensureVersion fetches and unpacks for a version on this machine, decided without touching
// the disk or the network: the tests run it for every era and OS.
export function planInstall(version, { os = currentOs() } = {}) {
  // Mojang JSONs can list one jar under two rows; two workers on one file would race
  const libRows = libraries(version, { os })
  const byPath = new Map()
  for (const row of libRows) {
    if (!byPath.has(row.path)) byPath.set(row.path, row)
  }
  return {
    id: version.id,
    client: version.downloads?.client ?? null,
    logConfig: loggingConfig(version),
    libraries: [...byPath.values()],
    natives: libRows.filter(r => r.native !== false),
    nativesSubdir: nativesLibrarySubdir(version, { os }),
    nativesExtraDirs: nativesExtraDirs(version, { os }),
    nativesStamp: nativesStamp(version, os),
    assetIndex: assetIndex(version),
    // every library row ensureVersion counts, duplicates included
    libraryRows: libRows.length,
  }
}

// An index's files under their real names: [relative path, the object it is]. A path that would
// leave its tree refuses the whole index.
function assetTreeRows(index) {
  const rows = []
  for (const [name, entry] of Object.entries(index.objects ?? {})) {
    const rel = safeRelativePath(name)
    if (rel === null || rel === '.complete') fail(`the asset index names the file "${String(name).slice(0, 80)}", which would land outside its folder`)
    if (!/^[0-9a-f]{40}$/.test(String(entry?.hash))) fail(`the asset index names "${rel}" with a malformed hash`)
    rows.push([rel, `objects/${entry.hash.slice(0, 2)}/${entry.hash}`])
  }
  return rows
}

// Where an index in an older layout is laid out for the game: the virtual one once for every
// version that shares it (1.6.1 to 1.7.2), the resources one in the profile's own folder (before
// 1.6, where the game reads <gameDir>/resources). null for the objects layout, read in place.
export function assetTreeDir(layout, indexId, profileFolder) {
  if (layout === 'virtual') return path.join(ASSETS_DIR, 'virtual', indexId)
  if (layout === 'resources') return path.join(profileFolder, 'resources')
  return null
}

// Lays out an index in an older layout as hard links into the object store (copies where links
// fail), with a .complete stamp holding the index's sha1: a tree whose stamp is missing or names
// another index is laid out again, so a half-done one is finished on the next launch.
export async function materialiseAssets({ file, sha1 }, dest) {
  const stampFile = path.join(dest, '.complete')
  let stamp = null
  try { stamp = fs.readFileSync(stampFile, 'utf8') } catch { /* not laid out yet */ }
  if (stamp === sha1) return { files: 0 }
  const rows = assetTreeRows(JSON.parse(fs.readFileSync(file, 'utf8')))
  fs.mkdirSync(dest, { recursive: true })
  fs.rmSync(stampFile, { force: true })
  for (const [rel, object] of rows) {
    const to = path.join(dest, rel)
    if (!isInside(dest, to)) fail(`the asset index names the file "${rel}", which would land outside its folder`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    linkOrCopy(path.join(ASSETS_DIR, object), to)
  }
  fs.writeFileSync(stampFile, sha1)
  return { files: rows.length }
}

export async function ensureVersion(id, { os = currentOs(), onProgress = () => {}, fetchImpl = downloadFile, keepNatives = new Set() } = {}) {
  let rawJson
  try {
    rawJson = JSON.parse(fs.readFileSync(versionJson(id), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`version "${id}" is not installed; run spawnloft client install first`)
    }
    throw err
  }

  let version = rawJson
  if (rawJson.inheritsFrom) {
    await ensureVersion(rawJson.inheritsFrom, { os, onProgress, fetchImpl, keepNatives })
    const parentJson = JSON.parse(fs.readFileSync(versionJson(rawJson.inheritsFrom), 'utf8'))
    version = mergeInherited(rawJson, parentJson)
  }
  // before the first download: natives this machine cannot load are not worth fetching
  const refusal = platformRefusal(version, os)
  if (refusal) fail(refusal)

  // The asset index first, small as it is: an index laid out in a way this SpawnLoft does not set
  // up is refused before the jar and the libraries download (review R4, S-5).
  const plan = planInstall(version, { os })
  const ai = plan.assetIndex
  const indexDest = path.join(ASSETS_DIR, 'indexes', `${ai.id}.json`)
  let indexBytes = 0
  if (needsDownload(indexDest, { sha1: ai.sha1, size: ai.size })) {
    fs.mkdirSync(path.dirname(indexDest), { recursive: true })
    try {
      await fetchImpl(ai.url, indexDest, { hash: 'sha1', expected: ai.sha1, label: `asset index ${ai.id}` })
    } catch (err) {
      fail(`could not download asset index ${ai.id} from ${ai.url}: ${err.message}`)
    }
    indexBytes = ai.size ?? 0
  }
  const indexJson = JSON.parse(fs.readFileSync(indexDest, 'utf8'))
  const layout = assetLayout(indexJson)
  if (layout === null) {
    fail(`Minecraft ${id}'s asset index (${ai.id}) is laid out in a way SpawnLoft does not know. Update SpawnLoft.`, 'unknown-asset-layout')
  }
  // the older layouts name files by their real paths: every one must stay inside its tree, checked
  // before anything else downloads
  if (layout !== 'objects') assetTreeRows(indexJson)

  const jarPath = versionJar(id)

  let downloaded = 0
  let totalBytes = 0

  const lastEmit = {}
  function emit(phase, done, total, bytes) {
    const now = Date.now()
    if (!lastEmit[phase] || now - lastEmit[phase] >= 250) {
      lastEmit[phase] = now
      onProgress({ phase, done, total, bytes })
    }
  }
  function emitEnd(phase, done, total, bytes) {
    lastEmit[phase] = Date.now()
    onProgress({ phase, done, total, bytes })
  }

  const dl = version.downloads?.client
  if (dl) {
    const needs = needsDownload(jarPath, { sha1: dl.sha1, size: dl.size })
    if (needs) {
      fs.mkdirSync(path.dirname(jarPath), { recursive: true })
      if (rawJson.downloads?.client) {
        try {
          await fetchImpl(dl.url, jarPath, { hash: 'sha1', expected: dl.sha1, label: `the client jar for ${id}` })
        } catch (err) {
          fail(`could not download the client jar for ${id} from ${dl.url}: ${err.message}`)
        }
        downloaded++
        totalBytes += dl.size ?? 0
      } else {
        // A loader profile inherits the parent's jar: the launch command expects it under the
        // profile's own id, so it is linked there rather than fetched and stored a second time.
        linkOrCopy(versionJar(rawJson.inheritsFrom), jarPath)
      }
    }
    emitEnd('client', 1, 1, needs ? (dl.size ?? 0) : 0)
  } else {
    emitEnd('client', 0, 0, 0)
  }

  // Before the libraries, so a version that cannot be made safe is refused early: without
  // this file 1.7 to 1.18.0 would run open to Log4Shell (see loggingConfig).
  const logCfg = loggingConfig(version)
  if (logCfg) {
    const dest = logConfigPath(logCfg.id)
    const needs = needsDownload(dest, { sha1: logCfg.sha1, size: logCfg.size })
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        await fetchImpl(logCfg.url, dest, { hash: 'sha1', expected: logCfg.sha1, label: `the log config ${logCfg.id}` })
      } catch (err) {
        fail(`could not download the log config ${logCfg.id} from ${logCfg.url}: ${err.message}; without it ${id} would run open to Log4Shell, so it is not launched`)
      }
      downloaded++
      totalBytes += logCfg.size ?? 0
    }
    emitEnd('log config', 1, 1, needs ? (logCfg.size ?? 0) : 0)
  }

  if (indexBytes) {
    downloaded++
    totalBytes += indexBytes
  }

  const nativeRows = plan.natives
  let libBytes = 0
  let libDone = 0
  let nativeWasDownloaded = false

  const libDownloads = plan.libraries
  const nativePaths = new Set(nativeRows.map(r => r.path))

  await inBatches(libDownloads, PARALLEL, async (row) => {
    const dest = path.join(LIBRARIES_DIR, row.path)
    const needs = needsDownload(dest, { sha1: row.sha1, size: row.size })
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const opts = { hash: 'sha1', label: `library ${row.name}` }
      if (row.sha1 != null) opts.expected = row.sha1
      try {
        await fetchImpl(row.url, dest, opts)
      } catch (err) {
        fail(`could not download library ${row.name} from ${row.url}: ${err.message}`)
      }
      libBytes += row.size ?? 0
      downloaded++
      totalBytes += row.size ?? 0
      if (nativePaths.has(row.path)) nativeWasDownloaded = true
    }
    libDone++
    emit('libraries', libDone, libDownloads.length, libBytes)
  })
  emitEnd('libraries', libDone, libDownloads.length, libBytes)

  // two index entries can share a hash, so key the queue by destination path
  let assetDone = 1
  let assetBytes = indexBytes
  const objRows = assetObjects(indexJson)

  const assetByPath = new Map()
  for (const row of objRows) {
    if (!assetByPath.has(row.path)) assetByPath.set(row.path, row)
  }
  const assetDownloads = [...assetByPath.values()]
  const assetTotal = 1 + assetDownloads.length

  await inBatches(assetDownloads, PARALLEL, async (row) => {
    const dest = path.join(ASSETS_DIR, row.path)
    const needs = needsDownload(dest, { sha1: row.hash, size: row.size })
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        await fetchImpl(row.url, dest, { hash: 'sha1', expected: row.hash, label: `asset ${row.hash}` })
      } catch (err) {
        fail(`could not download asset ${row.hash} from ${row.url}: ${err.message}`)
      }
      assetBytes += row.size ?? 0
      downloaded++
      totalBytes += row.size ?? 0
    }
    assetDone++
    emit('assets', assetDone, assetTotal, assetBytes)
  })
  emitEnd('assets', assetDone, assetTotal, assetBytes)

  const completeFile = path.join(nativesDir(id), '.complete')
  const stamped = fs.existsSync(completeFile) && fs.readFileSync(completeFile, 'utf8') === plan.nativesStamp
  // keepNatives: the ids whose natives a running game has loaded; an extracted folder is left as it is
  const keep = keepNatives.has(id) && fs.existsSync(completeFile)
  if (nativeRows.length > 0 && !keep && (nativeWasDownloaded || !stamped)) {
    await extractNatives(id, nativeRows, { stamp: plan.nativesStamp, subdir: plan.nativesSubdir, extraDirs: plan.nativesExtraDirs })
  }
  emitEnd('natives', nativeRows.length, nativeRows.length, 0)

  return {
    id,
    jar: jarPath,
    logConfig: logCfg?.id ?? null,
    assetsLayout: layout,
    assetIndex: { id: ai.id, sha1: ai.sha1, file: indexDest },
    libraries: plan.libraryRows,
    natives: nativeRows.length,
    assets: objRows.length,
    downloaded,
    bytes: totalBytes,
  }
}
