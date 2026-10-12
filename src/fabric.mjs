// Fabric downloads from meta.fabricmc.net. The meta API serves one bundled launcher jar per (game,
// loader, installer) triple; it runs with plain -jar and fetches vanilla and its libraries on first
// start, so a Fabric server is created like a Paper one. No checksum is published, so there is no
// hash verification, only TLS and a size floor.
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

// newest first, the API's own order
export async function versions() {
  const all = await api(`${API}/versions/game`)
  return all.filter((v) => v.stable).map((v) => v.version)
}

async function latestStable(pathname, label) {
  const all = await api(`${API}${pathname}`)
  const hit = all.find((v) => v.stable) ?? all[0]
  if (!hit) fail(`Fabric publishes no ${label} versions`)
  return hit.version
}

export function launcherName(game, loader, installer) {
  return `fabric-server-mc.${game}-loader.${loader}-launcher.${installer}.jar`
}

// The loader defaults to the newest stable, but a modpack pins the one its mods were built against.
// The installer is always the newest stable; it only bootstraps.
export async function fetchLauncher(game, { loader: pinned = null, force = false, onProgress = null } = {}) {
  // a modpack index or command line is not trusted to be a version; both end up in a file name and the URL
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

  // no published checksum, so a structural floor: an HTML error page saved as a jar would be tiny
  const size = fs.statSync(tmp).size
  if (size < 100 * 1024) {
    fs.rmSync(tmp, { force: true })
    fail(`the Fabric launcher download came back ${humanBytes(size)}, which is not a server jar`)
  }
  fs.renameSync(tmp, dest)
  return { name, path: dest, game, loader, installer, cached: false, size, sizeHuman: humanBytes(size) }
}
