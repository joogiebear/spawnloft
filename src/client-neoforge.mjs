// NeoForge for the game launcher. Its builds come from the NeoForged maven's version list (the one
// the server side reads), and a build is set up by the installer engine
// (client-forge-install.mjs): the installer's version file first, its build steps once the game's
// Java is picked.
//
// A NeoForge build names its Minecraft version: 20.4.253 and 21.1.266 are 1.20.4 and 1.21.1 (the
// first two parts after "1.", a zero dropped: 21.0.x is 1.21); from 26.1 on the build has four
// parts and the first three are the version (26.3.0.103 is 26.3, 26.1.2.14 is 26.1.2).
import fs from 'node:fs'

import { CLIENT_CACHE_DIR, versionJson } from './client-paths.mjs'
import { cachedJson } from './client-meta.mjs'
import { fail, assertSafeVersion } from './util.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { compareLoaderVersions } from './client-quilt.mjs'
import { fetchInstaller, readInstaller, writeVersionFile, isStamped, runInstaller } from './client-forge-install.mjs'

export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
export const NEOFORGE_LIST = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'

// The Minecraft version a NeoForge build is for, or null (an April Fools build, a name it does
// not know).
export function neoforgeMc(build) {
  const s = String(build)
  let m = /^(\d+)\.(\d+)\.(\d+)\.\d+(?:-[\w.]+)?$/.exec(s)
  if (m) return m[3] === '0' ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`
  m = /^(\d+)\.(\d+)\.\d+(?:-[\w.]+)?$/.exec(s)
  if (m && Number(m[1]) >= 20 && Number(m[1]) < 26) return m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`
  return null
}

export const neoforgeStable = (build) => !String(build).includes('-')

// The maven's list ({ versions: [...] }, oldest first), cached for an hour.
async function neoforgeList({ cacheDir = CLIENT_CACHE_DIR, force = false, fetchImpl } = {}) {
  const list = await cachedJson('neoforge-versions.json', NEOFORGE_LIST, { cacheDir, label: 'NeoForge\'s version list', force, ...(fetchImpl ? { fetchImpl } : {}) })
  if (!Array.isArray(list?.versions)) fail('NeoForge\'s version list is not a list')
  return list.versions.map(String)
}

// The Minecraft versions NeoForge builds for ({ version, stable }: stable when it has a build
// that is not a beta), newest first.
export async function neoforgeGameVersions(opts = {}) {
  const byMc = new Map()
  for (const b of await neoforgeList(opts)) {
    const mc = neoforgeMc(b)
    if (!mc) continue
    byMc.set(mc, (byMc.get(mc) ?? false) || neoforgeStable(b))
  }
  return [...byMc.entries()].map(([version, stable]) => ({ version, stable })).reverse()
}

export function neoforgeAvailable(mc, list) {
  return list.some((e) => e?.version === mc)
}

export async function assertNeoforgeAvailable(mc, { kind = 'release', ...opts } = {}) {
  let list
  try {
    list = await neoforgeGameVersions(opts)
    if (!neoforgeAvailable(mc, list)) list = await neoforgeGameVersions({ ...opts, force: true })
  } catch {
    return
  }
  if (neoforgeAvailable(mc, list)) return
  if (['release', 'beta', 'alpha'].includes(kind)) {
    fail(`NeoForge has no build for Minecraft ${mc}. Use None, or a version NeoForge supports.`, 'loader-not-available')
  }
  fail(`NeoForge has no build for Minecraft ${mc} yet. Use None for it, or wait for NeoForge to catch up.`, 'loader-not-available')
}

// NeoForge's builds for one Minecraft version, newest first.
export async function neoforgeBuilds(mc, opts = {}) {
  let all
  try {
    all = await neoforgeList(opts)
  } catch (err) {
    fail(`Could not reach NeoForge to set it up. This computer needs to be online for the first Play of a NeoForge setup. (${err.message})`, err.code ?? 'loader-unreachable')
  }
  const builds = all.filter((b) => neoforgeMc(b) === mc)
  if (!builds.length) fail(`NeoForge has no build for Minecraft ${mc}. Use None, or a version NeoForge supports.`, 'loader-not-available')
  return builds.map((version) => ({ version, stable: neoforgeStable(version) })).sort((a, b) => compareLoaderVersions(b.version, a.version))
}

// The newest stable build; the newest beta only when the version has no stable one (design Q10).
export function pickNeoforge(list, wanted = null) {
  if (!list.length) fail('no NeoForge build to pick from', 'loader-not-available')
  if (wanted) {
    const entry = list.find((e) => e.version === wanted)
    if (!entry) fail(`NeoForge ${wanted} is not published for this Minecraft version; known: ${list.slice(0, 10).map((e) => e.version).join(', ')}`)
    return entry
  }
  return list.find((e) => e.stable) ?? list[0]
}

export function neoforgeVersionId(mc, build) {
  return `neoforge-${build}`
}

function checked(mc, build) {
  const safe = assertSafeVersion(build, 'NeoForge build')
  if (neoforgeMc(safe) !== mc) fail(`NeoForge ${safe} is not a build for Minecraft ${mc}; pick another in Advanced`, 'loader-not-available')
  const id = neoforgeVersionId(mc, safe)
  if (!isSafeVersionId(id)) fail(`NeoForge ${safe} makes a version id SpawnLoft cannot use`)
  return { build: safe, id }
}

const installerUrl = (build) => `${NEOFORGE_MAVEN}/${encodeURIComponent(build)}/neoforge-${encodeURIComponent(build)}-installer.jar`

async function installer(build, opts) {
  return fetchInstaller(installerUrl(build), { name: `neoforge-${build}-installer.jar`, label: `NeoForge ${build} installer`, stage: 'neoforge', ...opts })
}

export function neoforgeInstalled(mc, build) {
  const id = neoforgeVersionId(mc, build)
  return fs.existsSync(versionJson(id)) && isStamped(id)
}

// Step 1: the installer, checked, and its version file under versions/<id>/.
export async function ensureNeoforgeVersion(mc, build, { onStage = () => {}, fetchImpl, sha1Impl } = {}) {
  const c = checked(mc, build)
  const inst = await installer(c.build, { onStage, ...(fetchImpl ? { fetchImpl } : {}), ...(sha1Impl ? { sha1Impl } : {}) })
  const { version } = readInstaller(inst.path, { mc, id: c.id, who: 'NeoForge' })
  writeVersionFile(c.id, version)
  return c.id
}

// Steps 2 to 5, on the game's Java.
export async function finishNeoforge(mc, build, { name, java, javaArgs, onStage = () => {}, onProgress = () => {}, onNote = () => {}, fetchImpl, sha1Impl, spawnImpl } = {}) {
  const c = checked(mc, build)
  const inst = await installer(c.build, { onStage, ...(fetchImpl ? { fetchImpl } : {}), ...(sha1Impl ? { sha1Impl } : {}) })
  return runInstaller({ id: c.id, mc, who: 'NeoForge', build: c.build, stage: 'neoforge', name, installer: inst, java, ...(javaArgs ? { javaArgs } : {}), ...(fetchImpl ? { fetchImpl } : {}), ...(spawnImpl ? { spawnImpl } : {}), onStage, onProgress, onNote })
}
