import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { versionJson, versionJar, LIBRARIES_DIR, ASSETS_DIR, CLIENT_ROOT, CLIENT_CACHE_DIR, nativesDir, logConfigPath } from './client-paths.mjs'
import { currentOs, mergeInherited, libraries, assetIndex, assetObjects, assetLayout, platformRefusal, nativesLibrarySubdir, nativesExtraDirs, loggingConfig } from './client-meta.mjs'
import { nativesStamp } from './client-version.mjs'
import { downloadFile } from './download.mjs'
import { extractZip } from './plugins.mjs'
import { fail, safeRelativePath, isInside, acquireLockAsync } from './util.mjs'
import { isCancelled } from './cancel.mjs'

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

// ---- the checked-files list ----------------------------------------------------------------
// Hashing every library and every asset on each Play read about half a gigabyte for a current
// version, and the panel answered nothing while it did. A file is hashed once: when it passes, its
// size and modification time are written down beside the hash it passed, and a later launch that
// finds the same size and time takes it as checked. A file that was replaced, truncated or
// touched no longer matches its line and is hashed again; `verify` hashes everything regardless
// (a repair). The list is a cache: losing it costs one slow launch, never a wrong one.
const VERIFIED_FILE = path.join(CLIENT_CACHE_DIR, 'verified.json')
const VERIFIED_FORMAT = 1

const ledgerKey = (file) => path.relative(CLIENT_ROOT, file).split(path.sep).join('/')

function readLedgerFile() {
  try {
    const data = JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8'))
    if (data?.format === VERIFIED_FORMAT && data.files && typeof data.files === 'object' && !Array.isArray(data.files)) return data.files
  } catch { /* none yet, or unreadable: every file is hashed once more */ }
  return {}
}

export function openLedger({ verify = false } = {}) {
  return { files: verify ? {} : readLedgerFile(), added: {}, dropped: new Set() }
}

// Written through a temp file of its own name, over whatever another launch wrote meanwhile: the
// lines this launch added go on top of the file as it is now, so two launches lose nothing.
export function saveLedger(ledger) {
  if (!Object.keys(ledger.added).length && !ledger.dropped.size) return
  try {
    const files = readLedgerFile()
    for (const key of ledger.dropped) delete files[key]
    Object.assign(files, ledger.added)
    fs.mkdirSync(path.dirname(VERIFIED_FILE), { recursive: true })
    const tmp = `${VERIFIED_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ format: VERIFIED_FORMAT, files }))
    fs.renameSync(tmp, VERIFIED_FILE)
    ledger.added = {}
    ledger.dropped = new Set()
  } catch { /* a cache: the next launch hashes again */ }
}

function sha1OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

// Notes a file as checked: it was just hashed here, or just downloaded against that hash.
// A checksum is 40 hex characters; anything else in a version file (an empty string) is no
// checksum, and a file fetched without one is never written down as checked.
const isSha1 = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)

async function noteChecked(ledger, file, sha1) {
  if (!ledger || !isSha1(sha1)) return
  try {
    const stat = await fs.promises.stat(file)
    const key = ledgerKey(file)
    const line = [stat.size, stat.mtimeMs, String(sha1).toLowerCase()]
    ledger.files[key] = line
    ledger.added[key] = line
    ledger.dropped.delete(key)
  } catch { /* gone again already: the next launch sees that */ }
}

// needsDownload for a launch: the same answer, without reading a file whose line still fits it,
// and without holding the thread while it reads one that does not.
export async function needsFetch(file, { sha1 = null, size = null } = {}, ledger = null) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return true
  }
  if (size != null && stat.size !== size) return true
  if (!isSha1(sha1)) return false
  const want = String(sha1).toLowerCase()
  const key = ledgerKey(file)
  const line = ledger?.files[key]
  if (line && line[0] === stat.size && line[1] === stat.mtimeMs && line[2] === want) return false
  let actual
  try {
    actual = await sha1OfFile(file)
  } catch {
    return true
  }
  if (actual !== want) {
    if (ledger && line) { delete ledger.files[key]; delete ledger.added[key]; ledger.dropped.add(key) }
    return true
  }
  if (ledger) {
    const entry = [stat.size, stat.mtimeMs, want]
    ledger.files[key] = entry
    ledger.added[key] = entry
    ledger.dropped.delete(key)
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

function sameFile(a, b) {
  try {
    // bigint: an NTFS file id is 64 bits, and as a Number two files can share one
    const [x, y] = [fs.statSync(a, { bigint: true }), fs.statSync(b, { bigint: true })]
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
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
    if (rel === null) fail(`the asset index names the file "${String(name).slice(0, 80)}", which would land outside its folder`)
    // the stamp's own name, in any case (Windows and macOS fold it) and as a folder too
    if (rel.split('/')[0].toLowerCase() === '.complete') fail(`the asset index names the file "${rel.slice(0, 80)}", which SpawnLoft keeps for itself`)
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
// another index is laid out again, so a half-done one is finished on the next launch. `copy`
// copies every file instead: a tree in the profile's folder is the game's and the user's to
// write, and a write through a hard link would change the shared object store.
export async function materialiseAssets({ file, sha1 }, dest, { copy = false } = {}) {
  const stampFile = path.join(dest, '.complete')
  let stamp = null
  try { stamp = fs.readFileSync(stampFile, 'utf8') } catch { /* not laid out yet */ }
  if (!/^[0-9a-f]{40}$/i.test(String(sha1))) fail('the asset index has no sha1 to check it by')
  if (stamp === sha1) return { files: 0 }
  const rows = assetTreeRows(JSON.parse(fs.readFileSync(file, 'utf8')))
  fs.mkdirSync(dest, { recursive: true })
  fs.rmSync(stampFile, { force: true })
  for (const [rel, object] of rows) {
    const to = path.join(dest, rel)
    if (!isInside(dest, to)) fail(`the asset index names the file "${rel}", which would land outside its folder`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (copy) {
      fs.rmSync(to, { force: true })
      fs.copyFileSync(path.join(ASSETS_DIR, object), to)
    } else if (!sameFile(path.join(ASSETS_DIR, object), to)) {
      // a link already in place stays, so a game running from a shared tree never sees it missing
      linkOrCopy(path.join(ASSETS_DIR, object), to)
    }
  }
  fs.writeFileSync(stampFile, sha1)
  return { files: rows.length }
}

// `verify` hashes every file again, whatever the checked-files list says (a repair).
export async function ensureVersion(id, opts = {}) {
  // one list for a version and the parent it inherits from, saved once, however the install ends
  if (opts.ledger) return ensureVersionWith(id, opts)
  const ledger = openLedger({ verify: opts.verify })
  try {
    return await ensureVersionWith(id, { ...opts, ledger })
  } finally {
    saveLedger(ledger)
  }
}

async function ensureVersionWith(id, { os = currentOs(), onProgress = () => {}, fetchImpl = downloadFile, keepNatives = new Set(), ledger }) {
  const began = Date.now()
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
    await ensureVersionWith(rawJson.inheritsFrom, { os, onProgress, fetchImpl, keepNatives, ledger })
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
  if (await needsFetch(indexDest, { sha1: ai.sha1, size: ai.size }, ledger)) {
    fs.mkdirSync(path.dirname(indexDest), { recursive: true })
    try {
      await fetchImpl(ai.url, indexDest, { hash: 'sha1', expected: ai.sha1, label: `asset index ${ai.id}` })
    } catch (err) {
      if (isCancelled(err)) throw err
      fail(`could not download asset index ${ai.id} from ${ai.url}: ${err.message}`, err.code ?? 'download-failed')
    }
    await noteChecked(ledger, indexDest, ai.sha1)
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
    const needs = await needsFetch(jarPath, { sha1: dl.sha1, size: dl.size }, ledger)
    if (needs) {
      fs.mkdirSync(path.dirname(jarPath), { recursive: true })
      if (rawJson.downloads?.client) {
        try {
          await fetchImpl(dl.url, jarPath, { hash: 'sha1', expected: dl.sha1, label: `the client jar for ${id}` })
        } catch (err) {
          if (isCancelled(err)) throw err
          fail(`could not download the client jar for ${id} from ${dl.url}: ${err.message}`, err.code ?? 'download-failed')
        }
        await noteChecked(ledger, jarPath, dl.sha1)
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
    const needs = await needsFetch(dest, { sha1: logCfg.sha1, size: logCfg.size }, ledger)
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        await fetchImpl(logCfg.url, dest, { hash: 'sha1', expected: logCfg.sha1, label: `the log config ${logCfg.id}` })
      } catch (err) {
        if (isCancelled(err)) throw err
        fail(`could not download the log config ${logCfg.id} from ${logCfg.url}: ${err.message}; without it ${id} would run open to Log4Shell, so it is not launched`, err.code ?? 'download-failed')
      }
      await noteChecked(ledger, dest, logCfg.sha1)
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
    const needs = await needsFetch(dest, { sha1: row.sha1, size: row.size }, ledger)
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const opts = { hash: 'sha1', label: `library ${row.name}` }
      if (row.sha1 != null) opts.expected = row.sha1
      try {
        await fetchImpl(row.url, dest, opts)
      } catch (err) {
        if (isCancelled(err)) throw err
        fail(`could not download library ${row.name} from ${row.url}: ${err.message}`, err.code ?? 'download-failed')
      }
      await noteChecked(ledger, dest, row.sha1)
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
    const needs = await needsFetch(dest, { sha1: row.hash, size: row.size }, ledger)
    if (needs) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        await fetchImpl(row.url, dest, { hash: 'sha1', expected: row.hash, label: `asset ${row.hash}` })
      } catch (err) {
        if (isCancelled(err)) throw err
        fail(`could not download asset ${row.hash} from ${row.url}: ${err.message}`, err.code ?? 'download-failed')
      }
      await noteChecked(ledger, dest, row.hash)
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
    // Two setups on one version started together would each clear the folder under the other,
    // perhaps under the other's game by then. The second waits, and a stamp written since this
    // call began is the first one's work from the same checked jars: the folder is left as it is.
    fs.mkdirSync(path.dirname(nativesDir(id)), { recursive: true })
    const release = await acquireLockAsync(`${nativesDir(id)}.lock`, { timeoutMs: 60000 })
    try {
      let done = false
      try {
        done = fs.readFileSync(completeFile, 'utf8') === plan.nativesStamp && (!nativeWasDownloaded || fs.statSync(completeFile).mtimeMs >= began)
      } catch { /* no stamp: extract */ }
      if (!done) await extractNatives(id, nativeRows, { stamp: plan.nativesStamp, subdir: plan.nativesSubdir, extraDirs: plan.nativesExtraDirs })
    } finally {
      release()
    }
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
