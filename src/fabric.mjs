/**
 * Fabric downloads, against meta.fabricmc.net.
 *
 * <p>Fabric's server story is friendlier than its reputation: the meta API serves a single
 * bundled launcher jar per (game, loader, installer) triple, and that jar runs with a plain
 * `-jar` exactly like Paper - it fetches the vanilla server and its libraries itself on first
 * start. So a Fabric server is created the same shape as a Paper one: pick a version,
 * download one jar into the store, place it. The daemon needs no new launch machinery.
 *
 * <p>One honest difference from paper.mjs: the meta API publishes no checksum for the
 * launcher jar, so the download cannot be hash-verified - it is TLS to fabricmc.net and a
 * sanity floor on the size, and that is all that can be had.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { JARS_DIR } from './paths.mjs'
import { fail, humanBytes, assertSafeVersion, isInside } from './util.mjs'

const API = 'https://meta.fabricmc.net/v2'
const HEADERS = { 'User-Agent': 'SpawnLoft (github.com/joogiebear/spawnloft)', Accept: 'application/json' }

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
  } catch (err) {
    fail(`could not reach the Fabric meta API: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) fail(`Fabric meta API returned ${res.status} for ${url}`)
  return res.json()
}

/** Every stable Minecraft version Fabric supports, newest first (the API's own order). */
export async function versions() {
  const all = await api(`${API}/versions/game`)
  return all.filter((v) => v.stable).map((v) => v.version)
}

/** The newest stable loader and installer - the pair the launcher jar is built from. */
async function latestStable(pathname, label) {
  const all = await api(`${API}${pathname}`)
  const hit = all.find((v) => v.stable) ?? all[0]
  if (!hit) fail(`Fabric publishes no ${label} versions`)
  return hit.version
}

/** What the launcher jar for a triple is called. Exported so a name can be recognised. */
export function launcherName(game, loader, installer) {
  return `fabric-server-mc.${game}-loader.${loader}-launcher.${installer}.jar`
}

/**
 * Download the Fabric server launcher for a game version into the jars store.
 *
 * <p>The loader defaults to the newest stable, but a modpack pins the one its mods were
 * built against - its index names it, and `loader` passes it through. The installer is
 * always the newest stable; it only bootstraps.
 */
export async function fetchLauncher(game, { loader: pinned = null, force = false, onProgress = null } = {}) {
  // A modpack's index names the loader, and a command line names the game: neither is trusted to be
  // a version. Both go into a file name under the jars store and into the URL below.
  assertSafeVersion(game, 'the Minecraft version')
  if (pinned != null) assertSafeVersion(pinned, 'the Fabric loader version')
  const [loader, installer] = await Promise.all([
    pinned ?? latestStable('/versions/loader', 'loader'),
    latestStable('/versions/installer', 'installer'),
  ])
  assertSafeVersion(loader, 'the Fabric loader version')
  assertSafeVersion(installer, 'the Fabric installer version')
  const name = launcherName(game, loader, installer)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const dest = path.join(JARS_DIR, name)
  if (!isInside(JARS_DIR, dest) || path.dirname(dest) !== path.resolve(JARS_DIR)) {
    fail(`the Fabric launcher name "${name}" would land outside the jars folder`)
  }
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: fs.statSync(dest).size, total: fs.statSync(dest).size, cached: true })
    return { name, path: dest, game, loader, installer, cached: true }
  }

  const url = `${API}/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
  } catch (err) {
    fail(`could not reach the Fabric meta API: ${err.cause?.message || err.message}`)
  }
  if (!res.ok || !res.body) {
    fail(res.status === 400 || res.status === 404
      ? `Fabric has no server launcher for ${game} - it may not support that version.`
      : `download failed (${res.status}) for ${url}`)
  }

  const tmp = `${dest}.part`
  const source = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || 0
  source.on('data', (chunk) => {
    received += chunk.length
    onProgress?.({ received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))

  // No published checksum to verify against, so the floor is structural: a launcher jar is
  // never a handful of bytes, and an HTML error page saved as a jar would be exactly that.
  const size = fs.statSync(tmp).size
  if (size < 100 * 1024) {
    fs.rmSync(tmp, { force: true })
    fail(`the Fabric launcher download came back ${humanBytes(size)}, which is not a server jar`)
  }
  fs.renameSync(tmp, dest)
  return { name, path: dest, game, loader, installer, cached: false, size, sizeHuman: humanBytes(size) }
}
