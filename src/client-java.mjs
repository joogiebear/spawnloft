import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { fetchJson, downloadFile } from './download.mjs'
import { cachedJson } from './client-meta.mjs'
import { CLIENT_CACHE_DIR, RUNTIME_DIR } from './client-paths.mjs'
import { fail, safeRelativePath, isInside, renameOver, acquireLock, acquireLockAsync, readJson } from './util.mjs'

// Mojang's index of its Java runtimes. The URL carries the file's hash and is what the official
// launcher reads; it can rotate, which the drift job (V4) notices.
export const RUNTIME_INDEX_URL = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
const RUNTIME_INDEX_FILE = path.join(RUNTIME_DIR, 'index.json')
const PARALLEL = 8

// The index's name for a machine, or null for one Mojang builds nothing for (Linux arm64).
// `arch` is what the game runs as: x64 on an arm64 machine that emulates it.
export function platformKey(osName, arch) {
  const keys = {
    windows: { x64: 'windows-x64', arm64: 'windows-arm64', x86: 'windows-x86' },
    osx: { x64: 'mac-os', arm64: 'mac-os-arm64' },
    linux: { x64: 'linux', x86: 'linux-i386' },
  }
  return keys[osName]?.[arch] ?? null
}

const platformText = {
  'windows-x64': 'Windows x64', 'windows-arm64': 'Windows arm64', 'windows-x86': 'Windows x86',
  'mac-os': 'macOS x64', 'mac-os-arm64': 'macOS arm64', linux: 'Linux x64', 'linux-i386': 'Linux x86',
}

export function runtimeDir(component, platform) {
  return path.join(RUNTIME_DIR, component, platform)
}

function manifestFile(component, platform) {
  return path.join(RUNTIME_DIR, component, `${platform}.manifest.json`)
}

// Names Mojang uses for components and platforms; anything else could not be a folder name here.
const PLAIN = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function fetchRuntimeIndex({ cacheDir = CLIENT_CACHE_DIR, force = false, fetchImpl = fetchJson } = {}) {
  return cachedJson('java-runtime-all.json', RUNTIME_INDEX_URL, { cacheDir, label: "Mojang's Java runtime list", maxAgeMs: 24 * 3600000, force, fetchImpl })
}

// The index row for one component on one platform: { manifest: { sha1, size, url }, version },
// or null when Mojang publishes none there (an empty list, as for jre-legacy on mac-os-arm64).
export function runtimeEntry(all, component, platform) {
  const row = all?.[platform]?.[component]?.[0]
  if (!row) return null
  const m = row.manifest
  if (!m || !/^[0-9a-f]{40}$/.test(String(m.sha1)) || !/^https:\/\//.test(String(m.url))) {
    fail(`Mojang's Java runtime list has a malformed entry for ${component} on ${platform}`)
  }
  return { manifest: { sha1: m.sha1, size: m.size ?? null, url: m.url }, version: String(row.version?.name ?? '') }
}

// What one component manifest asks for, checked before anything is written: every path inside
// the runtime folder, files with a raw download and a sha1, links whose targets stay inside and
// never on Windows (where making one needs rights SpawnLoft does not ask for). Throws on the
// first entry it cannot honour, so a runtime is never half made from a manifest it misread.
export function runtimePlan(manifest, { platform }) {
  const files = manifest?.files
  if (!files || typeof files !== 'object') fail(`the Java runtime manifest for ${platform} lists no files`)
  const dirs = []
  const downloads = []
  const links = []
  for (const [name, entry] of Object.entries(files)) {
    const rel = safeRelativePath(name)
    if (rel === null) fail(`the Java runtime manifest names "${String(name).slice(0, 80)}", which would land outside its folder`)
    if (entry?.type === 'directory') {
      dirs.push(rel)
    } else if (entry?.type === 'file') {
      const raw = entry.downloads?.raw
      // Node has no xz decoder, so a file offered only compressed cannot be fetched
      if (!raw) fail(`the Java runtime manifest offers "${rel}" only compressed, which SpawnLoft cannot unpack. Update SpawnLoft.`, 'runtime-format')
      if (!/^[0-9a-f]{40}$/.test(String(raw.sha1)) || !/^https:\/\//.test(String(raw.url))) fail(`the Java runtime manifest has no usable download for "${rel}"`)
      downloads.push({ rel, url: raw.url, sha1: raw.sha1, size: Number.isInteger(raw.size) ? raw.size : null, executable: entry.executable === true })
    } else if (entry?.type === 'link') {
      if (platform.startsWith('windows')) fail(`the Java runtime manifest for ${platform} has a link ("${rel}"), which SpawnLoft does not make on Windows. Update SpawnLoft.`, 'runtime-format')
      const target = String(entry.target ?? '')
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target))
      if (!target || target.startsWith('/') || target.includes('\0') || resolved === '..' || resolved.startsWith('../')) {
        fail(`the Java runtime manifest links "${rel}" to "${target.slice(0, 80)}", outside its folder`)
      }
      links.push({ rel, target })
    } else {
      fail(`the Java runtime manifest has an entry of a kind SpawnLoft does not know ("${rel}"). Update SpawnLoft.`, 'runtime-format')
    }
  }
  // nothing is written through a link: a path under one would land wherever the link points
  const linked = new Set(links.map((l) => l.rel))
  for (const rel of [...dirs, ...downloads.map((d) => d.rel), ...links.map((l) => l.rel)]) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (linked.has(parts.slice(0, i).join('/'))) fail(`the Java runtime manifest puts "${rel}" under the link "${parts.slice(0, i).join('/')}"`)
    }
  }
  // the java the game runs: bin/java, which macOS keeps under jre.bundle/Contents/Home
  const exe = platform.startsWith('windows') ? 'bin/java.exe' : 'bin/java'
  const java = downloads.map((d) => d.rel).filter((r) => r === exe || r.endsWith(`/${exe}`)).sort((a, b) => a.length - b.length)[0]
  if (!java) fail(`the Java runtime manifest for ${platform} has no ${exe}`)
  if (!platform.startsWith('windows') && !downloads.find((d) => d.rel === java).executable) fail(`the Java runtime manifest for ${platform} does not mark ${java} executable`, 'runtime-format')
  return { dirs, downloads, links, java, count: Object.keys(files).length }
}

// streamed: lib/modules is over 100 MB on the newer runtimes
async function fileSha1(file) {
  const hash = crypto.createHash('sha1')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function readRuntimeIndex() {
  const index = readJson(RUNTIME_INDEX_FILE, null)
  return index && typeof index === 'object' && index.runtimes && typeof index.runtimes === 'object' ? index : { runtimes: {} }
}

// index.json is shared by every runtime, whose own locks do not cover it: each change is a
// read-modify-write under a lock of its own, so two runtimes finishing together keep both records
function updateRuntimeIndex(change) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const release = acquireLock(path.join(RUNTIME_DIR, 'index.lock'))
  try {
    const index = readRuntimeIndex()
    if (change(index) !== false) writeRuntimeIndex(index)
  } finally {
    release()
  }
}

function writeRuntimeIndex(index) {
  const tmp = `${RUNTIME_INDEX_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2))
  renameOver(tmp, RUNTIME_INDEX_FILE)
}

// The runtimes laid out here: [{ component, platform, version, javaPath, manifestSha1 }].
export function installedRuntimes() {
  return Object.values(readRuntimeIndex().runtimes)
}

// Whether a recorded runtime still has every file at its manifest size: [] when whole, else the
// paths that are missing or the wrong size. Reads only the local manifest (doctor, launch).
export function runtimeDamage(component, platform) {
  const manifest = readJson(manifestFile(component, platform), null)
  if (!manifest) return ['the manifest']
  const plan = runtimePlan(manifest, { platform })
  const dir = runtimeDir(component, platform)
  const bad = []
  for (const d of plan.downloads) {
    let st = null
    try { st = fs.statSync(path.join(dir, d.rel)) } catch { /* missing */ }
    if (!st || (d.size != null && st.size !== d.size)) bad.push(d.rel)
  }
  for (const l of plan.links) {
    try { fs.lstatSync(path.join(dir, l.rel)) } catch { bad.push(l.rel) }
  }
  return bad
}

// Mojang's runtime for a component on a platform, downloaded or brought back to whole as needed:
// { javaPath, version, downloaded }. `entry` is the index row (runtimeEntry); with none (offline)
// a runtime laid out earlier is used as recorded, after its size check. Files are fetched raw,
// sha1-checked, made executable only where the manifest says so; the index.json record is
// written last, so a runtime cut off half-way is finished on the next launch.
export async function ensureRuntime(component, platform, { entry = null, fetchImpl = downloadFile, onProgress = () => {} } = {}) {
  if (!PLAIN.test(component) || !PLAIN.test(platform)) fail(`"${component}" on "${platform}" is not a Java runtime SpawnLoft can lay out`)
  const key = `${component}/${platform}`
  const dir = runtimeDir(component, platform)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // two profiles launched together share one runtime; a download takes minutes
  const release = await acquireLockAsync(path.join(RUNTIME_DIR, component, `${platform}.lock`), { timeoutMs: 15 * 60000 })
  try {
    const recorded = readRuntimeIndex().runtimes[key] ?? null
    const mFile = manifestFile(component, platform)
    if (!entry && !recorded) fail(`Mojang's Java runtime list could not be read, and ${component} for ${platformText[platform] ?? platform} is not downloaded yet`, 'runtime-offline')
    const want = entry?.manifest.sha1 ?? recorded.manifestSha1
    let manifestText = null
    try {
      const text = fs.readFileSync(mFile)
      if (crypto.createHash('sha1').update(text).digest('hex') === want) manifestText = text
    } catch { /* not fetched yet */ }
    if (!manifestText) {
      if (!entry) fail(`the Java runtime ${component} for ${platformText[platform] ?? platform} is damaged, and Mojang's runtime list could not be read to repair it`, 'runtime-offline')
      await fetchImpl(entry.manifest.url, mFile, { hash: 'sha1', expected: entry.manifest.sha1, label: `the ${component} manifest` })
      manifestText = fs.readFileSync(mFile)
    }
    const plan = runtimePlan(JSON.parse(manifestText), { platform })

    // a new manifest replaces the record before any file changes, so the old one is not trusted
    if (recorded && recorded.manifestSha1 !== want) {
      updateRuntimeIndex((index) => { delete index.runtimes[key] })
    }
    fs.mkdirSync(dir, { recursive: true })
    for (const rel of plan.dirs) fs.mkdirSync(path.join(dir, rel), { recursive: true })

    // a launch checks sizes; a new manifest (or a first one) checks every file's sha1, since a
    // file Mojang changed can keep its size
    const thorough = recorded?.manifestSha1 !== want
    const todo = []
    for (const d of plan.downloads) {
      const dest = path.join(dir, d.rel)
      if (!isInside(dir, dest)) fail(`the Java runtime manifest names "${d.rel}", which would land outside its folder`)
      let st = null
      try { st = fs.lstatSync(dest) } catch { /* missing */ }
      if (!st || !st.isFile() || (d.size != null && st.size !== d.size) || (thorough && (await fileSha1(dest)) !== d.sha1)) todo.push(d)
    }
    let done = 0
    let bytes = 0
    const total = todo.length
    if (total) onProgress({ phase: 'java', done, total, bytes })
    let index = 0
    let failed = false
    const worker = async () => {
      while (!failed && index < todo.length) {
        const d = todo[index++]
        const dest = path.join(dir, d.rel)
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.rmSync(dest, { force: true })
          await fetchImpl(d.url, dest, { hash: 'sha1', expected: d.sha1, label: `${component} ${d.rel}` })
          if (d.size != null && fs.statSync(dest).size !== d.size) {
            fs.rmSync(dest, { force: true })
            fail(`${component} ${d.rel} came back the wrong size`)
          }
        } catch (err) {
          failed = true
          throw err
        }
        bytes += d.size ?? 0
        onProgress({ phase: 'java', done: ++done, total, bytes })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))

    if (process.platform !== 'win32') {
      for (const d of plan.downloads) fs.chmodSync(path.join(dir, d.rel), d.executable ? 0o755 : 0o644)
      for (const l of plan.links) {
        const at = path.join(dir, l.rel)
        let current = null
        try { current = fs.readlinkSync(at) } catch { /* missing or not a link */ }
        if (current === l.target) continue
        fs.mkdirSync(path.dirname(at), { recursive: true })
        fs.rmSync(at, { force: true, recursive: true })
        fs.symlinkSync(l.target, at)
      }
    }

    // every entry the manifest lists is now in place
    const missing = runtimeDamage(component, platform)
    if (missing.length) fail(`the Java runtime ${component} is incomplete after download (${missing.slice(0, 3).join(', ')})`)
    const lexists = (rel) => { try { fs.lstatSync(path.join(dir, rel)); return true } catch { return false } }
    const present = [...plan.dirs, ...plan.downloads.map((d) => d.rel), ...plan.links.map((l) => l.rel)].filter(lexists).length
    if (present !== plan.count) fail(`the Java runtime ${component} has ${present} of the ${plan.count} entries its manifest lists`)

    const javaPath = path.join(dir, plan.java)
    const record = { component, platform, version: entry?.version ?? recorded?.version ?? '', javaPath: plan.java, manifestSha1: want }
    updateRuntimeIndex((index) => {
      if (JSON.stringify(index.runtimes[key]) === JSON.stringify(record)) return false
      index.runtimes[key] = record
    })
    return { javaPath, version: record.version, downloaded: total }
  } finally {
    release()
  }
}

// The java of Mojang's runtime for a version's component on the machine the game runs as, laid
// out as needed: { path, version }. Refused with no-runtime-for-this-machine where Mojang
// publishes none (Linux arm64; Windows x86 past Java 17; the old components on macOS arm64,
// which run as x64 under Rosetta instead).
export async function mojangJava({ component, major, osName, arch, fetchImpl = downloadFile, listFetchImpl = fetchJson, onProgress = () => {} }) {
  const platform = platformKey(osName, arch)
  const where = platform ? platformText[platform] : `${osName} ${arch}`
  if (!platform) fail(`Mojang publishes no Java for ${where}`, 'no-runtime-for-this-machine')
  let all = null
  try {
    all = await fetchRuntimeIndex({ fetchImpl: listFetchImpl })
  } catch { /* offline with no copy: a runtime laid out earlier still serves */ }
  let entry = null
  if (all) {
    entry = runtimeEntry(all, component, platform)
    if (!entry) fail(`Mojang publishes no Java ${major} (${component}) for ${where}`, 'no-runtime-for-this-machine')
  }
  const r = await ensureRuntime(component, platform, { entry, fetchImpl, onProgress })
  return { path: r.javaPath, version: r.version }
}
