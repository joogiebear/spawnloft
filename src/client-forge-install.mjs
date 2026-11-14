// The installer engine for NeoForge and modern Forge: what their installer jar does for a client,
// done by SpawnLoft itself so it can show progress, stop cleanly and check every file.
//
// The jar holds version.json (the loader's version file, inheriting from vanilla) and
// install_profile.json (extra libraries, a data table and the build steps, "processors"). A
// first Play:
//   1. downloads the installer to client/cache/installers/ and checks it against the maven's .sha1
//      (fetchInstaller), reads both files out of it and refuses one this SpawnLoft does not know
//      (readInstaller), and writes version.json under versions/<id>/ (writeVersionFile);
//   2. then, with the game's Java picked and the vanilla game downloaded (runInstaller):
//      downloads the profile's libraries, checked by SHA-1, and takes the ones that ship inside
//      the installer (maven/...) out of it;
//   3. resolves the data table: [group:name:version] is a path in the libraries folder, 'text' a
//      literal, /data/... a file taken out of the installer;
//   4. runs each client-side build step as a child of that Java, with an argument list and no
//      shell, skipping a step whose outputs are already there;
//   5. writes a stamp last. A loader counts as set up only with its stamp, and only while the
//      files the stamp lists still match it.
//
// A step that fails or is cancelled leaves the finished steps in place: the next Play carries on.
// One lock per version id keeps two setups from building the same files at once.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { CLIENT_ROOT, CLIENT_CACHE_DIR, LIBRARIES_DIR, versionDir, versionJson, versionJar, clientRunDir } from './client-paths.mjs'
import { libraryPath } from './client-meta.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { assertLoaderHost } from './client-loader-hosts.mjs'
import { needsFetch, noteChecked, openLedger, saveLedger } from './client-install.mjs'
import { downloadFile, fetchCapped } from './download.mjs'
import { readZipEntry } from './plugins.mjs'
import { isLegacyProfile, convertLegacy } from './client-forge-legacy.mjs'
import { fail, safeRelativePath, isInside, acquireLockAsync, sha1OfFile, writeAtomic } from './util.mjs'
import { Cancelled, cancelSignal, checkCancelled, isCancelled, stopOnCancel, OWN_GROUP, inOwnGroup } from './cancel.mjs'

export const INSTALLERS_DIR = path.join(CLIENT_CACHE_DIR, 'installers')
// The install_profile.json formats this engine knows: 0 (Forge 1.13 to 1.17) and 1 (since)
export const KNOWN_SPECS = [0, 1]
const STAMP_FORMAT = 1
const STAMP = '.loader-installed.json'
// A second setup waits for the first one's build steps. The lock and the record of finished steps
// are per Minecraft version, not per build: two builds for one version share the steps' middle
// files (client-…-slim.jar, the mappings), so one build's steps must not run under another's, and
// a step one build already ran with the same arguments is not run again for the next.
const LOCK_WAIT_MS = 30 * 60 * 1000
const STEPS_DIR = path.join(CLIENT_CACHE_DIR, 'loader-steps')
const ARTIFACTS = Symbol('artifact paths')
const TAIL_LINES = 8

const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
const isSha1 = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)
const ledgerKey = (file) => path.relative(CLIENT_ROOT, file).split(path.sep).join('/')

export const stampFile = (id) => path.join(versionDir(id), STAMP)
const stepsFile = (mc) => path.join(STEPS_DIR, `${mc}.json`)

// through a temp file, waiting out a virus scanner that holds the old one for a moment
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, JSON.stringify(data, null, 2))
}

const fileRow = (v) => Array.isArray(v) && v.length === 2 && (v[0] === null || Number.isInteger(v[0])) && isSha1(v[1])

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// A library's place in the libraries folder, from its maven name; null for a name that would
// leave the folder or is no maven name at all.
export function artifactPath(name) {
  if (typeof name !== 'string' || name.split(':').length < 3 || name.length > 300) return null
  const rel = safeRelativePath(libraryPath(name))
  return rel && rel === libraryPath(name) ? rel : null
}

function artifactFile(name, what) {
  const rel = artifactPath(name)
  if (!rel) fail(`${what} names a library "${String(name).slice(0, 80)}" SpawnLoft cannot place in its libraries folder; update SpawnLoft, or pick another build`, 'loader-installer-unknown')
  return path.join(LIBRARIES_DIR, rel)
}

// ---- 1. the installer --------------------------------------------------------------------

async function publishedSha1(url) {
  const body = await fetchCapped(`${url}.sha1`, { maxBytes: 1024, label: `the checksum of ${url.split('/').pop()}` })
  const m = /^[0-9a-f]{40}\b/i.exec(body.toString('utf8').trim())
  if (!m) fail(`the checksum published for ${url.split('/').pop()} is not a sha1`)
  return m[0].toLowerCase()
}

// The installer jar in the cache, downloaded once and checked against the checksum its maven
// publishes. A cached jar is checked again against the sum it passed then (a few MB).
export async function fetchInstaller(url, { name, label, fetchImpl = downloadFile, sha1Impl = publishedSha1, onStage = () => {}, stage = 'loader' } = {}) {
  assertLoaderHost(url, label)
  if (!/^[A-Za-z0-9._+-]+\.jar$/.test(String(name)) || name.includes('..')) fail(`the installer name "${String(name).slice(0, 80)}" is not one SpawnLoft can use`)
  const dest = path.join(INSTALLERS_DIR, name)
  const sumFile = `${dest}.sha1`
  try {
    const want = fs.readFileSync(sumFile, 'utf8').trim()
    if (isSha1(want) && (await sha1OfFile(dest)) === want) return { path: dest, sha1: want, cached: true }
  } catch { /* not cached, or not whole: fetched again */ }
  checkCancelled()
  onStage({ stage, message: `Downloading the ${label}` })
  const want = await sha1Impl(url)
  fs.mkdirSync(INSTALLERS_DIR, { recursive: true })
  fs.rmSync(sumFile, { force: true })
  try {
    await fetchImpl(url, dest, { hash: 'sha1', expected: want, label: `the ${label}` })
  } catch (err) {
    if (isCancelled(err)) throw err
    fail(`could not download the ${label} from ${url}: ${err.message}`, err.code ?? 'download-failed')
  }
  fs.writeFileSync(sumFile, want)
  return { path: dest, sha1: want, cached: false }
}

// install_profile.json and version.json out of the jar, refused unless this engine knows them and
// they are for this game version and this id. who: "NeoForge"; build: its own version, for the
// refusal. legacy: Forge's older installer (1.6.4 to 1.12.2) is read into the newer shape, its
// version file given the id asked for; pending then lists the rows still to get a checksum.
export function readInstaller(jarPath, { mc, id, who, legacy = false }) {
  const unknown = (why) => fail(`This ${who} build needs a newer SpawnLoft (${why}). Update SpawnLoft, or pick an older ${who} build in Advanced.`, 'loader-installer-unknown')
  let profile
  let version
  try {
    profile = JSON.parse(readZipEntry(jarPath, 'install_profile.json')?.toString('utf8') ?? 'null')
    const name = typeof profile?.json === 'string' ? profile.json.replace(/^\//, '') : 'version.json'
    version = JSON.parse(readZipEntry(jarPath, name)?.toString('utf8') ?? 'null')
  } catch {
    unknown('its installer could not be read')
  }
  if (!profile || typeof profile !== 'object') unknown('no install_profile.json')
  if (isLegacyProfile(profile)) {
    if (!legacy) unknown('the old installer format')
    return convertLegacy(profile, { mc, id, installerPath: jarPath, who })
  }
  if (!KNOWN_SPECS.includes(profile.spec ?? 0)) unknown(`installer format ${String(profile.spec).slice(0, 10)}`)
  if (!Array.isArray(profile.processors) || !Array.isArray(profile.libraries) || (profile.data != null && typeof profile.data !== 'object')) unknown('an installer profile SpawnLoft does not know')
  if (!version || typeof version !== 'object') unknown('no version file')
  if (profile.minecraft !== mc) fail(`The ${who} installer is for Minecraft ${String(profile.minecraft).slice(0, 40)}, not ${mc}; pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  if (version.id !== id || !isSafeVersionId(version.id)) fail(`The ${who} installer names its version "${String(version.id).slice(0, 60)}", not ${id}; pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  if (version.inheritsFrom !== mc) fail(`The ${who} installer's version inherits from ${String(version.inheritsFrom).slice(0, 40)}, not Minecraft ${mc}; pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  return { profile, version }
}

// versions/<id>/<id>.json, as the installer has it, unless the same file is there already.
export function writeVersionFile(id, version) {
  const dest = versionJson(id)
  const text = JSON.stringify(version, null, 2)
  try { if (fs.readFileSync(dest, 'utf8') === text) return false } catch { /* not there yet */ }
  fs.mkdirSync(versionDir(id), { recursive: true })
  writeAtomic(dest, text)
  return true
}

// ---- the stamp ---------------------------------------------------------------------------

export function isStamped(id) {
  return readJson(stampFile(id))?.format === STAMP_FORMAT
}

// Whether every file the stamp lists still matches it; the checked-files list keeps this from
// reading the patched jars on each Play.
export async function stampHolds(id, ledger = null) {
  const stamp = readJson(stampFile(id))
  if (stamp?.format !== STAMP_FORMAT) return false
  return filesStillMatch(stamp.files, ledger)
}

// ---- 3. the data table and the arguments -------------------------------------------------

// The client side of the data table, resolved: [maven name] to its path, 'text' to the text,
// /data/... to a file taken out of the installer into dataDir. Plus the names every installer
// knows.
export function resolveData(profile, { installerPath, mc, dataDir, who }) {
  const out = {}
  const artifacts = new Set()
  for (const [key, sides] of Object.entries(profile.data ?? {})) {
    if (!/^[A-Z0-9_]+$/i.test(key)) fail(`The ${who} installer names a value "${key.slice(0, 40)}" SpawnLoft does not know`, 'loader-installer-unknown')
    const value = sides?.client
    if (typeof value !== 'string') continue
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = artifactFile(value.slice(1, -1), `The ${who} installer`)
      artifacts.add(out[key])
    } else if (value.startsWith("'") && value.endsWith("'")) out[key] = value.slice(1, -1)
    else {
      const entry = safeRelativePath(value.replace(/^\//, ''))
      if (!entry) fail(`The ${who} installer names a file "${value.slice(0, 80)}" SpawnLoft cannot take out of it`, 'loader-installer-unknown')
      const data = readZipEntry(installerPath, entry)
      if (!data) fail(`The ${who} installer has no ${entry}, which it says it needs`, 'loader-installer-unknown')
      const dest = path.join(dataDir, entry)
      if (!isInside(dataDir, dest)) fail(`The ${who} installer names a file outside its folder`, 'loader-installer-unknown')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, data)
      out[key] = dest
    }
  }
  // the names every installer knows, set last as the installers do, so a table cannot move them
  Object.assign(out, {
    SIDE: 'client',
    MINECRAFT_JAR: versionJar(mc),
    MINECRAFT_VERSION: mc,
    ROOT: CLIENT_ROOT,
    INSTALLER: installerPath,
    LIBRARY_DIR: LIBRARIES_DIR,
  })
  Object.defineProperty(out, ARTIFACTS, { value: artifacts })
  return out
}

// One argument filled in, as the installers do: a whole [maven name] is its path; otherwise each
// {NAME} is replaced, with \ escaping the next character. A name the table lacks stops the
// install: running a step with a hole in its arguments could write anywhere.
export function fillArgument(arg, data, who) {
  const text = String(arg)
  if (text.startsWith('[') && text.endsWith(']')) return artifactFile(text.slice(1, -1), `The ${who} installer`)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) { out += text[++i]; continue }
    if (c === '{') {
      const end = text.indexOf('}', i)
      if (end === -1) { out += text.slice(i); break }
      const key = text.slice(i + 1, end)
      if (!Object.hasOwn(data, key)) fail(`The ${who} installer's build steps use a value {${key.slice(0, 40)}} it does not give. Update SpawnLoft, or pick an older ${who} build in Advanced.`, 'loader-installer-unknown')
      out += data[key]
      i = end
      continue
    }
    out += c
  }
  return out
}

// The build steps a client runs: those with no sides, and those that name the client.
export function clientProcessors(profile) {
  return profile.processors.filter((p) => !Array.isArray(p.sides) || p.sides.includes('client'))
}

// A step's command and checks, with every path filled in.
export function planStep(proc, data, who) {
  if (typeof proc?.jar !== 'string' || !Array.isArray(proc.args ?? [])) fail(`The ${who} installer lists a build step SpawnLoft does not know`, 'loader-installer-unknown')
  const jar = artifactFile(proc.jar, `The ${who} installer`)
  const classpath = [jar, ...(proc.classpath ?? []).map((n) => artifactFile(n, `The ${who} installer`))]
  const args = (proc.args ?? []).map((a) => fillArgument(a, data, who))
  // the libraries-folder files the step names by maven name: each must be there once it ran (an
  // input already was; an output it was to make)
  const artifacts = data[ARTIFACTS] ?? new Set()
  const named = (proc.args ?? []).map(String).map((a, i) => ((a.startsWith('[') && a.endsWith(']')) || artifacts.has(args[i]) ? args[i] : null)).filter(Boolean)
  const outputs = Object.entries(proc.outputs ?? {}).map(([file, sha1]) => {
    const f = fillArgument(file, data, who)
    const s = fillArgument(sha1, data, who).toLowerCase()
    if (!isInside(LIBRARIES_DIR, f) || !isSha1(s)) fail(`The ${who} installer names a build output SpawnLoft cannot check`, 'loader-installer-unknown')
    return { file: f, sha1: s }
  })
  const key = sha1Of(JSON.stringify([proc.jar, proc.classpath ?? [], args]))
  return { jar, classpath, args, outputs, key, named }
}

// The Main-Class of a step's jar, from its manifest (a line may run on after a space).
export function mainClassOf(jarFile) {
  const mf = readZipEntry(jarFile, 'META-INF/MANIFEST.MF')
  if (!mf) return null
  const text = mf.toString('utf8').replace(/\r?\n /g, '')
  const m = /^Main-Class:\s*(\S+)\s*$/m.exec(text)
  return m && /^[A-Za-z_$][\w$.]*$/.test(m[1]) ? m[1] : null
}

// ---- 2. libraries --------------------------------------------------------------------------

function libraryRows(list, who) {
  const rows = []
  for (const lib of list ?? []) {
    const a = lib?.downloads?.artifact
    if (!lib?.name) continue
    const rel = a?.path ? safeRelativePath(a.path) : artifactPath(lib.name)
    if (!rel) fail(`The ${who} installer names a library at "${String(a?.path ?? lib.name).slice(0, 80)}", outside the libraries folder`, 'loader-installer-unknown')
    rows.push({ name: lib.name, file: path.join(LIBRARIES_DIR, rel), rel, url: a ? (a.url ?? '') : null, sha1: isSha1(a?.sha1) ? a.sha1.toLowerCase() : null, size: Number.isInteger(a?.size) ? a.size : null })
  }
  return rows
}

// The profile's libraries, and the version file's that ship inside the installer (an empty url
// with the jar under maven/ in it). A version-file row with no url that is not in the installer
// is a build output: the steps make it.
async function ensureLibraries({ profile, version, installerPath, who, fetchImpl, ledger, onProgress }) {
  const seen = new Set()
  const rows = [...libraryRows(profile.libraries, who), ...libraryRows(version.libraries, who).filter((r) => r.url === '')]
    .filter((r) => !seen.has(r.rel) && seen.add(r.rel))
  let done = 0
  let bytes = 0
  for (const row of rows) {
    checkCancelled()
    // a jar the build steps may run: never one that cannot be checked, downloaded or already there
    if (row.url && !row.sha1) fail(`The ${who} installer lists ${row.name} without a checksum; SpawnLoft does not run or load an unchecked file. Pick another ${who} build in Advanced.`, 'loader-installer-unknown')
    if (await needsFetch(row.file, { sha1: row.sha1, size: row.size }, ledger)) {
      if (row.url === '') {
        const data = readZipEntry(installerPath, profile.installerFiles?.[row.rel] ?? `maven/${row.rel}`)
        if (data) {
          if (row.sha1 && sha1Of(data) !== row.sha1) fail(`The ${who} installer's copy of ${row.name} does not match its checksum`, 'loader-installer-unknown')
          fs.mkdirSync(path.dirname(row.file), { recursive: true })
          fs.writeFileSync(row.file, data)
          await noteChecked(ledger, row.file, row.sha1)
        }
        // else made by a build step
      } else if (row.url !== null) {
        assertLoaderHost(row.url, `The ${who} installer`)
        fs.mkdirSync(path.dirname(row.file), { recursive: true })
        try {
          await fetchImpl(row.url, row.file, { hash: 'sha1', ...(row.sha1 ? { expected: row.sha1 } : {}), label: `library ${row.name}` })
        } catch (err) {
          if (isCancelled(err)) throw err
          fail(`could not download library ${row.name} from ${row.url}: ${err.message}`, err.code ?? 'download-failed')
        }
        await noteChecked(ledger, row.file, row.sha1)
        bytes += row.size ?? 0
      } else {
        fail(`The ${who} installer lists ${row.name} with no download SpawnLoft knows. Update SpawnLoft, or pick another ${who} build in Advanced.`, 'loader-installer-unknown')
      }
    }
    done++
    onProgress({ phase: 'libraries', done, total: rows.length, bytes })
  }
}

// ---- 4. a build step -------------------------------------------------------------------------

function defaultSpawn(java, argv, opts) {
  return inOwnGroup(spawn(java, argv, { ...opts, ...OWN_GROUP }))
}

function runStep({ java, javaArgs, main, step, cwd, log, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const argv = [...javaArgs, '-cp', step.classpath.join(path.delimiter), main, ...step.args]
    log.write(`\n$ java ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`)
    let child
    try {
      child = spawnImpl(java, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    const cancelled = stopOnCancel(child)
    const tail = []
    let partial = ''
    const take = (chunk) => {
      const text = chunk.toString('utf8')
      log.write(text)
      const lines = (partial + text).split(/\r?\n/)
      partial = lines.pop()
      for (const l of lines) if (l.trim()) { tail.push(l); if (tail.length > TAIL_LINES) tail.shift() }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (err) => reject(err))
    child.on('close', (code, signal) => {
      if (partial.trim()) { tail.push(partial); if (tail.length > TAIL_LINES) tail.shift() }
      if (cancelled() || cancelSignal()?.aborted) return reject(new Cancelled())
      resolve({ code: code ?? (signal ? 1 : 0), tail })
    })
  })
}

// The files a step that names no outputs leaves in the libraries folder: every argument that is
// one (its inputs too, which must not change under it either).
async function filesNamedBy(step) {
  const out = {}
  for (const a of step.args) {
    if (!isInside(LIBRARIES_DIR, a) || a === LIBRARIES_DIR) continue
    let stat
    try { stat = fs.statSync(a) } catch { continue }
    if (!stat.isFile()) continue
    out[ledgerKey(a)] = [stat.size, await sha1OfFile(a)]
  }
  return out
}

async function filesStillMatch(files, ledger) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false
  for (const [key, row] of Object.entries(files)) {
    const rel = safeRelativePath(key)
    if (!rel || !fileRow(row) || await needsFetch(path.join(CLIENT_ROOT, rel), { sha1: row[1], size: row[0] }, ledger)) return false
  }
  return true
}

// ---- 2 to 5 ----------------------------------------------------------------------------------

// The lock for one Minecraft version's loader builds, waited for in short turns so a cancel ends
// the wait.
async function lockFor(mc) {
  fs.mkdirSync(STEPS_DIR, { recursive: true })
  const file = path.join(STEPS_DIR, `${mc}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    checkCancelled()
    try {
      return await acquireLockAsync(file, { timeoutMs: 500 })
    } catch (err) {
      if (!/timed out waiting for lock/.test(err.message) || Date.now() > deadline) throw err
    }
  }
}

function removeFolder(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a temp folder: left to the system */ }
}

// Everything after the version file, for one build: what a launch runs once the game's Java is
// picked and the vanilla game is downloaded. Returns { built: false } when the stamp already
// holds. who: "NeoForge"; build: "21.1.266"; stage: the launch stage id; name: the setup, for the
// log; installer: a function giving { path, sha1 }, only called when there is something to build;
// java: the Java to run the steps on (javaArgs before -cp: the tests' fake one); verify: hash the
// stamped files again whatever earlier launches noted.
export async function runInstaller({ id, mc, who, build, stage, name, installer, java, javaArgs = [], legacy = false, verify = false, fetchImpl = downloadFile, spawnImpl = defaultSpawn, onStage = () => {}, onProgress = () => {}, onNote = () => {} }) {
  const ledger = openLedger({ verify })
  try {
    if (isStamped(id) && await stampHolds(id, ledger)) return { built: false }
    const release = await lockFor(mc)
    try {
      // another setup may have finished it while this one waited
      if (isStamped(id) && await stampHolds(id, ledger)) return { built: false }
      if (isStamped(id)) {
        onNote(`${who} ${build}'s files were changed or removed since it was set up, so it is set up again`)
        fs.rmSync(stampFile(id), { force: true })
      }
      const inst = typeof installer === 'function' ? await installer() : installer
      return await buildAll({ id, mc, who, build, stage, name, installer: inst, java, javaArgs, legacy, fetchImpl, spawnImpl, onStage, onProgress, ledger })
    } finally {
      release()
    }
  } finally {
    saveLedger(ledger)
  }
}

async function buildAll({ id, mc, who, build, stage, name, installer, java, javaArgs, legacy, fetchImpl, spawnImpl, onStage, onProgress, ledger }) {
  const { profile, version } = readInstaller(installer.path, { mc, id, who, legacy })
  onStage({ stage, message: `Downloading ${who} ${build}'s libraries` })
  await ensureLibraries({ profile, version, installerPath: installer.path, who, fetchImpl, ledger, onProgress })

  const dataDir = path.join(INSTALLERS_DIR, `${id}-data`)
  removeFolder(dataDir)
  const data = resolveData(profile, { installerPath: installer.path, mc, dataDir, who })
  const steps = clientProcessors(profile).map((p) => planStep(p, data, who))
  const total = steps.length

  // the steps already run for this Minecraft version, by their command (see STEPS_DIR)
  let record = readJson(stepsFile(mc))
  if (record?.format !== 1 || !record.steps || typeof record.steps !== 'object' || Array.isArray(record.steps)) record = { format: 1, steps: {} }
  const stampFiles = {}

  const logFile = path.join(clientRunDir(name), 'loader-install.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.createWriteStream(logFile, { flags: 'a' })
  // the log is a help, not a step: a disk too full to write it fails the step itself, if anything
  log.on('error', () => {})
  log.write(`\n==== ${new Date().toISOString()} setting up ${who} ${build} (${id}), ${total} steps ====\n`)
  try {
    for (let i = 0; i < total; i++) {
      checkCancelled()
      const step = steps[i]
      const n = i + 1
      onStage({ stage, message: `Setting up ${who} ${build} (step ${n} of ${total})` })
      // a step with outputs is done when they match; one without is done when it ran with this
      // same command and the files it named are still as it left them
      let done
      if (step.outputs.length) {
        done = true
        for (const o of step.outputs) if (await needsFetch(o.file, { sha1: o.sha1 }, ledger)) { done = false; break }
      } else {
        done = await filesStillMatch(record.steps[step.key], ledger)
      }
      if (done) {
        log.write(`-- step ${n} of ${total}: already done\n`)
        Object.assign(stampFiles, step.outputs.length ? outputsAsFiles(step) : record.steps[step.key])
        continue
      }
      if (record.steps[step.key]) {
        delete record.steps[step.key]
        writeJsonAtomic(stepsFile(mc), record)
      }
      const main = mainClassOf(step.jar)
      if (!main) fail(`Setting up ${who} stopped at step ${n} of ${total}: its tool ${path.basename(step.jar)} names no main class. Pick another ${who} build in Advanced.`, 'loader-install-failed')
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-loader-step-'))
      let result
      try {
        result = await runStep({ java, javaArgs, main, step, cwd, log, spawnImpl })
      } catch (err) {
        for (const o of step.outputs) fs.rmSync(o.file, { force: true })
        if (isCancelled(err)) throw err
        fail(`Setting up ${who} stopped at step ${n} of ${total}: Java could not be started (${err.message}).`, 'loader-install-failed')
      } finally {
        removeFolder(cwd)
      }
      const stopped = (why) => {
        for (const o of step.outputs) fs.rmSync(o.file, { force: true })
        const tail = result.tail.length ? `\n${result.tail.join('\n')}` : ''
        fail(`Setting up ${who} stopped at step ${n} of ${total}${why}.${tail}\nThe whole output is in ${logFile}`, 'loader-install-failed')
      }
      if (result.code !== 0) stopped(` (its tool ended with code ${result.code})`)
      for (const o of step.outputs) {
        let actual = null
        try { actual = await sha1OfFile(o.file) } catch { /* not made */ }
        if (actual !== o.sha1) stopped(`: ${path.basename(o.file)} ${actual ? 'did not come out as the installer says it should' : 'was not made'}`)
        await noteChecked(ledger, o.file, o.sha1)
      }
      for (const f of step.named) {
        if (!fs.existsSync(f)) stopped(`: ${path.basename(f)} was not made`)
      }
      const files = step.outputs.length ? outputsAsFiles(step) : await filesNamedBy(step)
      if (!step.outputs.length) {
        record.steps[step.key] = files
        writeJsonAtomic(stepsFile(mc), record)
      }
      Object.assign(stampFiles, files)
      log.write(`-- step ${n} of ${total}: done\n`)
    }
    // the version file's rows the steps were to make
    for (const row of libraryRows(version.libraries, who).filter((r) => r.url === '')) {
      if (await needsFetch(row.file, { sha1: row.sha1, size: row.size }, ledger)) {
        fail(`Setting up ${who} ${build} finished without making ${row.name}. Pick another ${who} build in Advanced.\nThe whole output is in ${logFile}`, 'loader-install-failed')
      }
      if (row.sha1) stampFiles[ledgerKey(row.file)] = [fs.statSync(row.file).size, row.sha1]
    }
    checkCancelled()
    writeJsonAtomic(stampFile(id), { format: STAMP_FORMAT, id, installer: installer.sha1, at: new Date().toISOString(), files: stampFiles })
    removeFolder(dataDir)
    log.write(`==== ${who} ${build} is set up ====\n`)
    return { built: true, steps: total }
  } finally {
    await new Promise((r) => log.end(r))
  }
}

function outputsAsFiles(step) {
  const out = {}
  for (const o of step.outputs) {
    let size = null
    try { size = fs.statSync(o.file).size } catch { /* checked just before */ }
    out[ledgerKey(o.file)] = [size, o.sha1]
  }
  return out
}
