// Quilt: a Fabric-like loader. Its meta hands out a finished profile (one version file that
// inherits from vanilla, about nine libraries); its rows carry no checksum, so each library's is
// read from the .sha1 file the maven publishes beside it and written into the profile, and the
// downloader then checks every jar as it does Mojang's.
import crypto from 'node:crypto'
import fs from 'node:fs'

import { fetchJson, fetchCapped } from './download.mjs'
import { versionJson, versionDir, CLIENT_CACHE_DIR } from './client-paths.mjs'
import { fail, assertSafeVersion } from './util.mjs'
import { cachedJson, libraryPath } from './client-meta.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { assertLoaderHost } from './client-loader-hosts.mjs'

export const QUILT_META = 'https://meta.quiltmc.org/v3'

function gameId(mc) {
  if (!isSafeVersionId(mc)) fail(`Minecraft version ${JSON.stringify(String(mc).slice(0, 64))} is not a valid version`)
  return mc
}

// Quilt's list has no stable flag: a build with a pre-release part in its name is a beta.
export function quiltBuildStable(version) {
  return !/-(beta|alpha|pre|rc)\b/i.test(String(version))
}

// The Minecraft versions Quilt builds for ({ version, stable }, newest first), cached for an hour.
export async function quiltGameVersions({ cacheDir = CLIENT_CACHE_DIR, force = false, fetchImpl } = {}) {
  const list = await cachedJson('quilt-game-versions.json', `${QUILT_META}/versions/game`, { cacheDir, label: 'Quilt\'s version list', force, ...(fetchImpl ? { fetchImpl } : {}) })
  if (!Array.isArray(list)) fail('Quilt\'s version list is not a list')
  return list
}

export function quiltAvailable(mc, list) {
  return list.some((e) => e?.version === mc)
}

// As Fabric's: a list that cannot be read decides nothing, and an id the cached list lacks asks
// once more.
export async function assertQuiltAvailable(mc, { kind = 'release', ...opts } = {}) {
  let list
  try {
    list = await quiltGameVersions(opts)
    if (!quiltAvailable(mc, list)) list = await quiltGameVersions({ ...opts, force: true })
  } catch {
    return
  }
  if (quiltAvailable(mc, list)) return
  if (['release', 'beta', 'alpha'].includes(kind)) {
    fail(`Quilt has no build for Minecraft ${mc}. Use None, or a version Quilt supports.`, 'loader-not-available')
  }
  fail(`Quilt has no loader for Minecraft ${mc} yet. Use None for it, or wait for Quilt to catch up.`, 'loader-not-available')
}

// Orders two loader versions as semantic versions: 0.30.2 after 0.30.2-beta.1, 0.31.0-beta.6 after
// both; build metadata (+...) does not count. Negative when a is older.
export function compareLoaderVersions(a, b) {
  const parse = (v) => {
    const [core, pre = null] = String(v).split('+')[0].split(/-(.*)/s)
    const split = (t) => t.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    return { core: split(core), pre: pre === null ? null : split(pre) }
  }
  const parts = (x, y) => {
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === undefined) return -1
      if (y[i] === undefined) return 1
      if (x[i] === y[i]) continue
      if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i]
      if (typeof x[i] === 'number') return -1
      if (typeof y[i] === 'number') return 1
      return x[i] < y[i] ? -1 : 1
    }
    return 0
  }
  const A = parse(a)
  const B = parse(b)
  const core = parts(A.core, B.core)
  if (core !== 0) return core
  if (A.pre === null || B.pre === null) return A.pre === null ? (B.pre === null ? 0 : 1) : -1
  return parts(A.pre, B.pre)
}

// Quilt Loader's builds for one Minecraft version, newest first. Quilt's meta does not serve them
// in order, so they are sorted here.
export async function quiltBuilds(mc, { fetchImpl = fetchJson } = {}) {
  const safe = gameId(mc)
  const list = await fetchImpl(`${QUILT_META}/versions/loader/${encodeURIComponent(safe)}`, { label: `Quilt loaders for ${safe}` })
  if (!Array.isArray(list) || list.length === 0) fail(`Quilt publishes no loader for Minecraft ${mc}`, 'loader-not-available')
  return list
    .map((e) => String(e?.loader?.version ?? ''))
    .filter((v) => v !== '')
    .map((version) => ({ version, stable: quiltBuildStable(version) }))
    .sort((a, b) => compareLoaderVersions(b.version, a.version))
}

// The newest build that is not a beta; the newest beta when there is nothing else (design Q10).
export function pickQuilt(list, wanted = null) {
  if (list.length === 0) fail('no Quilt loader to pick from', 'loader-not-available')
  if (wanted) {
    const entry = list.find((e) => e.version === wanted)
    if (!entry) fail(`Quilt loader ${wanted} is not published for this Minecraft version; known: ${list.slice(0, 10).map((e) => e.version).join(', ')}`)
    return entry
  }
  return list.find((e) => e.stable) ?? list[0]
}

export function quiltVersionId(mc, loader) {
  return `quilt-loader-${loader}-${mc}`
}

function libraryUrl(lib) {
  if (typeof lib?.name !== 'string' || lib.name.split(':').length < 3) fail('Quilt\'s profile lists a library without a proper name')
  const base = typeof lib.url === 'string' && lib.url !== '' ? lib.url : 'https://libraries.minecraft.net/'
  return assertLoaderHost(`${base.endsWith('/') ? base : `${base}/`}${libraryPath(lib.name)}`, 'Quilt\'s profile')
}

async function fetchSha1(url) {
  const body = await fetchCapped(`${url}.sha1`, { maxBytes: 1024, label: `the checksum of ${url.split('/').pop()}` })
  const m = /^[0-9a-f]{40}\b/i.exec(body.toString('utf8').trim())
  if (!m) fail(`the checksum Quilt's maven publishes for ${url.split('/').pop()} is not a sha1`)
  return m[0].toLowerCase()
}

// Writes versions/<id>/<id>.json: Quilt's profile with each library's sha1 filled in. fetchSha1Impl
// is the tests' stand-in for the maven.
export async function ensureQuiltProfile(mc, loader, { fetchImpl = fetchJson, fetchSha1Impl = fetchSha1 } = {}) {
  const safeMc = gameId(mc)
  const safeLoader = assertSafeVersion(loader, 'Quilt loader version')
  const id = quiltVersionId(safeMc, safeLoader)
  if (!isSafeVersionId(id)) fail(`Quilt loader ${safeLoader} for ${safeMc} makes a version id SpawnLoft cannot use`)
  const dest = versionJson(id)
  try {
    if (JSON.parse(fs.readFileSync(dest, 'utf8'))?.id === id) return id
  } catch { /* missing or damaged: fetched again */ }
  const json = await fetchImpl(`${QUILT_META}/versions/loader/${encodeURIComponent(safeMc)}/${encodeURIComponent(safeLoader)}/profile/json`, { label: `Quilt profile for ${safeMc} with loader ${safeLoader}` })
  if (json?.id !== id) fail(`Quilt's meta answered for a different profile (expected ${id}, got ${json?.id})`)
  if (json.inheritsFrom !== safeMc) fail(`Quilt's meta profile inherits from ${json.inheritsFrom}, not ${safeMc}`)
  if (!Array.isArray(json.libraries)) fail('Quilt\'s profile lists no libraries')
  await Promise.all(json.libraries.map(async (lib) => {
    if (lib.downloads) fail(`Quilt's profile lists ${String(lib.name).slice(0, 80)} in a shape SpawnLoft does not know; update SpawnLoft`)
    const url = libraryUrl(lib)
    if (!/^[0-9a-f]{40}$/i.test(String(lib.sha1 ?? ''))) lib.sha1 = await fetchSha1Impl(url)
  }))
  fs.mkdirSync(versionDir(id), { recursive: true })
  const tmp = `${dest}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2))
  fs.renameSync(tmp, dest)
  return id
}
