import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { JARS_DIR } from './paths.mjs'
import { fail, humanBytes } from './util.mjs'

// PaperMC downloads via the v3 "fill" API. The old api.papermc.io/v2 endpoints are sunset and answer
// {"ok":false,"error":"sunset"} instead of a 404, which reads like a network problem.
// One API, several projects: Paper and Folia are served identically, so `project` picks which.
const projectApi = (project) => `https://fill.papermc.io/v3/projects/${project}`

// the API asks for a descriptive agent so operators can contact misbehaving clients
const HEADERS = { 'User-Agent': 'SpawnLoft (github.com/joogiebear/spawnloft)', Accept: 'application/json' }

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: HEADERS })
  } catch (err) {
    fail(`could not reach the PaperMC API: ${err.message}`)
  }
  if (!res.ok) fail(`PaperMC API returned ${res.status} for ${url}`)
  return res.json()
}

// Newest first. The API groups versions by minor and lists newest first within a group; flattening keeps that order.
export async function versions({ includeUnstable = false, project = 'paper' } = {}) {
  const data = await api(projectApi(project))
  const out = []
  for (const group of Object.values(data.versions ?? {})) {
    for (const v of group) {
      // rc and pre-releases are published beside releases and are not what "latest" means
      if (!includeUnstable && /-(rc|pre)/i.test(v)) continue
      out.push(v)
    }
  }
  return out
}

export async function builds(version, { project = 'paper' } = {}) {
  const data = await api(`${projectApi(project)}/versions/${encodeURIComponent(version)}/builds`)
  return data.map((b) => {
    const dl = b.downloads?.['server:default']
    return {
      build: b.id,
      channel: b.channel,
      time: b.time,
      name: dl?.name ?? null,
      url: dl?.url ?? null,
      sha256: dl?.checksums?.sha256 ?? null,
      size: dl?.size ?? 0,
    }
  })
}

// Default is the newest STABLE build, since handing out an EXPERIMENTAL one just because it is newest
// is a bad surprise. Falls back to the newest of any channel if the version has no stable build yet.
export async function resolveBuild(version, wanted = null, { project = 'paper' } = {}) {
  const all = await builds(version, { project })
  const label = project === 'paper' ? 'Paper' : project[0].toUpperCase() + project.slice(1)
  if (!all.length) fail(`${label} has no builds for version ${version}.`)
  if (wanted != null) {
    const hit = all.find((b) => String(b.build) === String(wanted))
    if (!hit) fail(`${label} ${version} has no build ${wanted}. Newest is ${all[0].build}.`)
    return hit
  }
  return all.find((b) => b.channel === 'STABLE') ?? all[0]
}

// Verified before it is put in place: a truncated download unzips far enough to look fine, then
// fails at runtime with an unhelpful class-loading error.
export async function fetchBuild(version, wanted = null, { force = false, onProgress = null, project = 'paper' } = {}) {
  const build = await resolveBuild(version, wanted, { project })
  if (!build.url) fail(`${project} ${version} build ${build.build} publishes no server jar.`)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const dest = path.join(JARS_DIR, build.name)
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: build.size, total: build.size, cached: true })
    return { ...build, path: dest, cached: true }
  }

  const tmp = `${dest}.part`
  const res = await fetch(build.url, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${build.url}`)

  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(res.body)
  // progress is measured from the bytes that arrive; a ~50MB jar takes long enough that silence reads as a hang
  let received = 0
  const total = Number(res.headers.get('content-length')) || build.size || 0
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    onProgress?.({ received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))

  const got = hash.digest('hex')
  if (build.sha256 && got !== build.sha256) {
    fs.rmSync(tmp, { force: true })
    fail(`checksum mismatch for ${build.name}\n  expected ${build.sha256}\n  got      ${got}`)
  }
  // rename only after the hash matches, so a bad download leaves a .part file rather than a jar that looks stored
  fs.renameSync(tmp, dest)
  return { ...build, path: dest, cached: false, sizeHuman: humanBytes(build.size) }
}
