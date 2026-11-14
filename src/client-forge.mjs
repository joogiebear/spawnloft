// Forge for the game launcher, from Minecraft 1.13 on (the installer with build steps; the older
// one comes in a later SpawnLoft). Its builds come from files.minecraftforge.net's two lists: every
// build per Minecraft version (maven-metadata.json) and the one Forge marks recommended
// (promotions_slim.json). A build is set up by the installer engine (client-forge-install.mjs),
// as NeoForge's is.
//
// A build's full name carries the Minecraft version: 1.20.1-47.4.28 is build 47.4.28 for 1.20.1,
// and its version file is 1.20.1-forge-47.4.28.
import fs from 'node:fs'

import { CLIENT_CACHE_DIR, versionJson } from './client-paths.mjs'
import { cachedJson } from './client-meta.mjs'
import { fail, assertSafeVersion } from './util.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { compareLoaderVersions } from './client-quilt.mjs'
import { fetchInstaller, readInstaller, writeVersionFile, isStamped, runInstaller } from './client-forge-install.mjs'

export const FORGE_FILES = 'https://files.minecraftforge.net/net/minecraftforge/forge'
export const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'

// Minecraft 1.13 and newer: the versions whose Forge installers have build steps.
export function forgeModernMc(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(mc))
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 1 || minor >= 13
}

async function forgeLists({ cacheDir = CLIENT_CACHE_DIR, force = false, fetchImpl } = {}) {
  const opts = { cacheDir, force, ...(fetchImpl ? { fetchImpl } : {}) }
  const [meta, promos] = await Promise.all([
    cachedJson('forge-maven-metadata.json', `${FORGE_FILES}/maven-metadata.json`, { label: 'Forge\'s version list', ...opts }),
    cachedJson('forge-promotions.json', `${FORGE_FILES}/promotions_slim.json`, { label: 'Forge\'s recommended builds', ...opts }),
  ])
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('Forge\'s version list is not a list')
  return { meta, promos: promos?.promos && typeof promos.promos === 'object' ? promos.promos : {} }
}

// The Minecraft versions Forge builds for here ({ version, stable: true }), newest first.
export async function forgeGameVersions(opts = {}) {
  const { meta } = await forgeLists(opts)
  return Object.keys(meta)
    .filter((mc) => forgeModernMc(mc) && Array.isArray(meta[mc]) && meta[mc].length)
    .map((version) => ({ version, stable: true }))
    .sort((a, b) => compareLoaderVersions(b.version, a.version))
}

export function forgeAvailable(mc, list) {
  return list.some((e) => e?.version === mc)
}

export async function assertForgeAvailable(mc, { kind = 'release', ...opts } = {}) {
  if (/^\d+\.\d+(\.\d+)?$/.test(String(mc)) && !forgeModernMc(mc)) {
    fail(`Forge for Minecraft ${mc} is coming in a later SpawnLoft. Use None for now.`, 'loader-not-available')
  }
  let list
  try {
    list = await forgeGameVersions(opts)
    if (!forgeAvailable(mc, list)) list = await forgeGameVersions({ ...opts, force: true })
  } catch {
    return
  }
  if (forgeAvailable(mc, list)) return
  if (['release', 'beta', 'alpha'].includes(kind)) {
    fail(`Forge has no build for Minecraft ${mc}. Use None, or a version Forge supports.`, 'loader-not-available')
  }
  fail(`Forge has no build for Minecraft ${mc} yet. Use None for it, or wait for Forge to catch up.`, 'loader-not-available')
}

// Forge's builds for one Minecraft version, newest first; the one Forge recommends is marked.
// Forge marks no betas: every build counts as stable.
export async function forgeBuilds(mc, opts = {}) {
  let lists
  try {
    lists = await forgeLists(opts)
  } catch (err) {
    fail(`Could not reach Forge to set it up. This computer needs to be online for the first Play of a Forge setup. (${err.message})`, err.code ?? 'loader-unreachable')
  }
  const full = Array.isArray(lists.meta[mc]) ? lists.meta[mc] : []
  const recommended = typeof lists.promos[`${mc}-recommended`] === 'string' ? lists.promos[`${mc}-recommended`] : null
  const builds = full
    .map(String)
    .filter((f) => f.startsWith(`${mc}-`))
    .map((f) => f.slice(mc.length + 1))
    .filter((b) => /^\d+(\.\d+)*$/.test(b))
  if (!builds.length || !forgeModernMc(mc)) fail(`Forge has no build for Minecraft ${mc}. Use None, or a version Forge supports.`, 'loader-not-available')
  return builds
    .map((version) => ({ version, stable: true, recommended: version === recommended }))
    .sort((a, b) => compareLoaderVersions(b.version, a.version))
}

// The build Forge recommends for the version; its newest when none is (design: default builds).
export function pickForge(list, wanted = null) {
  if (!list.length) fail('no Forge build to pick from', 'loader-not-available')
  if (wanted) {
    const entry = list.find((e) => e.version === wanted)
    if (!entry) fail(`Forge ${wanted} is not published for this Minecraft version; known: ${list.slice(0, 10).map((e) => e.version).join(', ')}`)
    return entry
  }
  return list.find((e) => e.recommended) ?? list[0]
}

export function forgeVersionId(mc, build) {
  return `${mc}-forge-${build}`
}

function checked(mc, build) {
  const safe = assertSafeVersion(build, 'Forge build')
  if (!/^\d+(\.\d+)*$/.test(safe)) fail(`Forge ${safe} is not a Forge build; pick another in Advanced`, 'loader-not-available')
  if (!forgeModernMc(mc)) fail(`Forge for Minecraft ${mc} is coming in a later SpawnLoft. Use None for now.`, 'loader-not-available')
  const id = forgeVersionId(mc, safe)
  if (!isSafeVersionId(id)) fail(`Forge ${safe} makes a version id SpawnLoft cannot use`)
  return { build: safe, id, full: `${mc}-${safe}` }
}

const installerUrl = (full) => `${FORGE_MAVEN}/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`

function installer(c, opts) {
  return fetchInstaller(installerUrl(c.full), { name: `forge-${c.full}-installer.jar`, label: `Forge ${c.build} installer`, stage: 'forge', ...opts })
}

export function forgeInstalled(mc, build) {
  const id = forgeVersionId(mc, build)
  return fs.existsSync(versionJson(id)) && isStamped(id)
}

// Step 1: the installer, checked, and its version file. A build already set up needs neither.
export async function ensureForgeVersion(mc, build, { onStage = () => {}, fetchImpl, sha1Impl } = {}) {
  const c = checked(mc, build)
  if (fs.existsSync(versionJson(c.id)) && isStamped(c.id)) return c.id
  const inst = await installer(c, { onStage, ...(fetchImpl ? { fetchImpl } : {}), ...(sha1Impl ? { sha1Impl } : {}) })
  const { version } = readInstaller(inst.path, { mc, id: c.id, who: 'Forge' })
  writeVersionFile(c.id, version)
  return c.id
}

// Steps 2 to 5, on the game's Java.
export async function finishForge(mc, build, { name, java, javaArgs, verify = false, onStage = () => {}, onProgress = () => {}, onNote = () => {}, fetchImpl, sha1Impl, spawnImpl } = {}) {
  const c = checked(mc, build)
  const getInstaller = () => installer(c, { onStage, ...(fetchImpl ? { fetchImpl } : {}), ...(sha1Impl ? { sha1Impl } : {}) })
  return runInstaller({ id: c.id, mc, who: 'Forge', build: c.build, stage: 'forge', name, installer: getInstaller, java, verify, ...(javaArgs ? { javaArgs } : {}), ...(fetchImpl ? { fetchImpl } : {}), ...(spawnImpl ? { spawnImpl } : {}), onStage, onProgress, onNote })
}

// Forge on a version Mojang ships with Java 8 runs on Java 8 only: today's rule lets those
// versions use up to 17, and Forge of that era fails on anything newer than 8.
export function forgeJava(requirement) {
  return requirement?.component === 'jre-legacy' ? { ...requirement, max: 8, prefer: 8 } : requirement
}
