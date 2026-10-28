import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { versionJson, versionJar, LIBRARIES_DIR, ASSETS_DIR, nativesDir, logConfigPath } from './client-paths.mjs'
import { currentOs, mergeInherited, libraries, assetIndex, assetObjects, platformRefusal, nativesLibrarySubdir, loggingConfig } from './client-meta.mjs'
import { downloadFile } from './download.mjs'
import { extractZip } from './plugins.mjs'
import { fail } from './util.mjs'

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

// One data root can serve two operating systems (a dual boot, a portable drive): the stamp
// says whose natives are extracted, so a switch re-extracts them.
// v2: natives are now chosen per arch, so a folder extracted with every arch's jars is redone
// v3: Apple Silicon no longer takes natives-macos-patch (x64 freetype), so its macos/x64 goes
// v4: natives go where java.library.path points (26.x: the java/ subfolder), so 26.x installs
// extracted to the top of the folder are redone
function nativesStamp(id, os) {
  return `${id} ${os.name} ${os.arch} natives-v4`
}

// subdir: the folder under natives/<id> the version's java.library.path names ('' for natives/<id>)
export async function extractNatives(id, nativeRows, { os, subdir = '' }) {
  const root = nativesDir(id)
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, subdir)
  fs.mkdirSync(dir, { recursive: true })

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

  fs.writeFileSync(path.join(root, '.complete'), nativesStamp(id, os))
  return { files }
}

export async function ensureVersion(id, { os = currentOs(), onProgress = () => {}, fetchImpl = downloadFile } = {}) {
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
    await ensureVersion(rawJson.inheritsFrom, { os, onProgress, fetchImpl })
    const parentJson = JSON.parse(fs.readFileSync(versionJson(rawJson.inheritsFrom), 'utf8'))
    version = mergeInherited(rawJson, parentJson)
  }
  // before the first download: natives this machine cannot load are not worth fetching
  const refusal = platformRefusal(version, os)
  if (refusal) fail(refusal)

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

  // Mojang JSONs can list one jar under two rows; two workers on one file would race
  const libRows = libraries(version, { os })
  const nativeRows = libRows.filter(r => r.native !== false)
  let libBytes = 0
  let libDone = 0
  let nativeWasDownloaded = false

  const libByPath = new Map()
  for (const row of libRows) {
    if (!libByPath.has(row.path)) libByPath.set(row.path, row)
  }
  const libDownloads = [...libByPath.values()]
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
  const ai = assetIndex(version)
  const indexDest = path.join(ASSETS_DIR, 'indexes', `${ai.id}.json`)
  let assetDone = 0
  let assetBytes = 0

  const indexNeeds = needsDownload(indexDest, { sha1: ai.sha1, size: ai.size })
  if (indexNeeds) {
    fs.mkdirSync(path.dirname(indexDest), { recursive: true })
    try {
      await fetchImpl(ai.url, indexDest, { hash: 'sha1', expected: ai.sha1, label: `asset index ${ai.id}` })
    } catch (err) {
      fail(`could not download asset index ${ai.id} from ${ai.url}: ${err.message}`)
    }
    assetBytes += ai.size ?? 0
    downloaded++
    totalBytes += ai.size ?? 0
  }
  assetDone++

  const indexJson = JSON.parse(fs.readFileSync(indexDest, 'utf8'))
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
  const stamped = fs.existsSync(completeFile) && fs.readFileSync(completeFile, 'utf8') === nativesStamp(id, os)
  if (nativeRows.length > 0 && (nativeWasDownloaded || !stamped)) {
    await extractNatives(id, nativeRows, { os, subdir: nativesLibrarySubdir(version, { os }) })
  }
  emitEnd('natives', nativeRows.length, nativeRows.length, 0)

  return {
    id,
    jar: jarPath,
    logConfig: logCfg?.id ?? null,
    libraries: libRows.length,
    natives: nativeRows.length,
    assets: objRows.length,
    downloaded,
    bytes: totalBytes,
  }
}
