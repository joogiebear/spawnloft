/**
 * NeoForge servers, via the official installer and NeoForged's server starter jar.
 *
 * <p>NeoForge has no single downloadable server jar - its installer lays down a libraries
 * tree and argument files, and the stock way to launch is `java @argfiles`. mcctl sidesteps
 * that whole shape with the installer's own `--server-jar` flag, which also downloads
 * NeoForged's serverstarterjar as `server.jar`: a launcher built precisely so that a plain
 * `java -jar server.jar` works, JVM flags and all. So a NeoForge instance ends up the same
 * shape as every other - one jar name in the registry, the daemon unchanged.
 *
 * <p>Version scheme: a NeoForge version is the Minecraft version with a build appended -
 * 26.2.0.75 is Minecraft 26.2 (a zero patch is spelled out), 26.1.2.x would be 26.1.2.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

import { JARS_DIR } from './paths.mjs'
import * as create from './create.mjs'
import { removeInstance, updateInstance } from './registry.mjs'
import { fail, UserError, humanBytes, assertSafeVersion, isInside } from './util.mjs'

const MAVEN = 'https://maven.neoforged.net'
const API = `${MAVEN}/api/maven/versions/releases/net/neoforged/neoforge`
const HEADERS = { 'User-Agent': 'SpawnLoft (github.com/joogiebear/spawnloft)' }

/** The Minecraft version a NeoForge version is built for. Exported pure for its tests. */
export function mcOf(neoVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+(?:-\w+)?$/.exec(String(neoVersion))
  if (!m) return null
  return m[3] === '0' ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`
}

/**
 * Newest NeoForge build for a Minecraft version, out of the full maven list. Stable wins;
 * a beta stands in only when the version has nothing else - which is every version's first
 * weeks, and a refusal there would just mean "come back later" with no reason given.
 */
export function pickBuild(all, mc) {
  const matches = all.filter((v) => mcOf(v) === mc)
  const stable = matches.filter((v) => !v.includes('-'))
  const pool = stable.length ? stable : matches
  // The maven list is oldest-first; the last match is the newest build.
  return pool.length ? pool[pool.length - 1] : null
}

async function mavenVersions() {
  let res
  try {
    res = await fetch(API, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
  } catch (err) {
    fail(`could not reach the NeoForge maven: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) fail(`the NeoForge maven answered ${res.status}`)
  return (await res.json()).versions ?? []
}

/** Every Minecraft version NeoForge has a stable build for, newest first. */
export async function versions() {
  const all = await mavenVersions()
  const out = []
  const seen = new Set()
  for (const v of all) {
    if (v.includes('-')) continue
    const mc = mcOf(v)
    if (mc && !seen.has(mc)) {
      seen.add(mc)
      out.push(mc)
    }
  }
  return out.reverse()
}

/** Resolve a Minecraft version to the newest NeoForge build for it. */
export async function resolveBuild(mc, wanted = null) {
  const all = await mavenVersions()
  if (wanted != null) {
    if (!all.includes(String(wanted))) fail(`NeoForge has no build ${wanted}`)
    return String(wanted)
  }
  const build = pickBuild(all, String(mc))
  if (!build) fail(`NeoForge has no build for Minecraft ${mc}`)
  return build
}

/**
 * Download one installer into the jars store, verified against the checksum the maven
 * publishes beside every artifact.
 */
export async function fetchInstaller(neoVersion, { onProgress = () => {} } = {}) {
  // From a modpack's index, so not trusted to be a version: it becomes a file name under the jars
  // store and a path on the maven.
  assertSafeVersion(neoVersion, 'the NeoForge version')
  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = `neoforge-${neoVersion}-installer.jar`
  const dest = path.join(JARS_DIR, name)
  if (!isInside(JARS_DIR, dest) || path.dirname(dest) !== path.resolve(JARS_DIR)) {
    fail(`the NeoForge installer name "${name}" would land outside the jars folder`)
  }
  if (fs.existsSync(dest)) return { name, path: dest, version: neoVersion, cached: true }

  const url = `${MAVEN}/releases/net/neoforged/neoforge/${encodeURIComponent(neoVersion)}/${encodeURIComponent(name)}`
  onProgress({ message: `Downloading the NeoForge ${neoVersion} installer`, percent: null })
  let res
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) })
  } catch (err) {
    fail(`could not reach the NeoForge maven: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) fail(`installer download failed (${res.status}) for ${url}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const shaRes = await fetch(`${url}.sha256`, { headers: HEADERS, signal: AbortSignal.timeout(30000) }).catch(() => null)
  if (shaRes?.ok) {
    const want = (await shaRes.text()).trim().split(/\s/)[0]
    const got = crypto.createHash('sha256').update(bytes).digest('hex')
    if (want && got !== want) fail('the installer did not match the checksum the maven publishes; nothing was installed')
  }
  fs.writeFileSync(dest, bytes)
  return { name, path: dest, version: neoVersion, cached: false, size: bytes.length, sizeHuman: humanBytes(bytes.length) }
}

/**
 * Run the installer into an instance directory and come back with a launchable server.
 *
 * <p>`--install-server` lays down the libraries tree; `--server-jar` adds the starter jar
 * as server.jar. The installer downloads a couple of hundred megabytes of libraries, so
 * this is the long step and it narrates. Its log file is cleaned up on success and LEFT on
 * failure - it is the only record of what went wrong.
 */
export function installServer(dir, installerPath, { java = 'java', onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    onProgress({ message: 'Installing NeoForge (this downloads its libraries and takes a few minutes)', percent: null })
    const child = spawn(java, ['-jar', installerPath, '--install-server', dir, '--server-jar'], {
      cwd: dir,
      windowsHide: true,
    })
    let tail = ''
    const keepTail = (c) => {
      tail = (tail + c.toString()).slice(-2000)
    }
    child.stdout.on('data', keepTail)
    child.stderr.on('data', keepTail)
    child.on('error', (err) => reject(new UserError(
      err.code === 'ENOENT' ? `could not run ${java} to install NeoForge` : `NeoForge install failed: ${err.message}`)))
    child.on('exit', (code) => {
      const starter = path.join(dir, 'server.jar')
      if (code === 0 && fs.existsSync(starter)) {
        fs.rmSync(path.join(dir, `${path.basename(installerPath)}.log`), { force: true })
        resolve({ starter: 'server.jar' })
      } else {
        reject(new UserError(`the NeoForge installer exited ${code}. Its last words:\n${tail.trim().split(/\r?\n/).slice(-4).join('\n')}`))
      }
    })
  })
}

/**
 * A plain NeoForge server, end to end: resolve the build, fetch the installer, create the
 * instance, install into it. A failed install tears the instance down rather than leaving
 * a half-built folder that looks created.
 */
export async function createServer(name, mc, {
  build = null, memory = '4G', port = null, onlineMode = true, java = null, onProgress = () => {},
} = {}) {
  const neoVersion = await resolveBuild(mc, build)
  const installer = await fetchInstaller(neoVersion, { onProgress })
  const inst = await create.newInstance(name, {
    java,
    loader: 'neoforge',
    jar: null,
    mcVersion: mcOf(neoVersion),
    memory,
    port,
    onlineMode,
    acceptEula: true,
  })
  try {
    await installServer(inst.dir, installer.path, { java: inst.java, onProgress })
    updateInstance(name, { jar: 'server.jar' })
  } catch (err) {
    try {
      removeInstance(name)
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err
  }
  return { name, neoVersion, mc: mcOf(neoVersion), port: inst.port }
}
