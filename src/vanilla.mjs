// Mojang's server jar, via the launcher's version manifest. Each version's metadata names the download
// with its sha1 and the Java major version it needs; that is passed up so a Java mismatch can be
// explained before the download.
import fs from 'node:fs'
import path from 'node:path'

import { JARS_DIR } from './paths.mjs'
import { fail } from './util.mjs'
import { fetchJson, downloadFile } from './download.mjs'

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const LABEL = 'Mojang’s version manifest'

async function manifest() {
  return fetchJson(MANIFEST, { label: LABEL })
}

export async function versions({ includeSnapshots = false } = {}) {
  const data = await manifest()
  return (data.versions ?? [])
    .filter((v) => includeSnapshots || v.type === 'release')
    .map((v) => v.id)
}

export function jarName(id) {
  return `vanilla-${id}.jar`
}

export async function fetchServer(id, { force = false, onProgress = null } = {}) {
  const entry = (await manifest()).versions?.find((v) => v.id === id)
  if (!entry) fail(`Mojang lists no Minecraft version ${id}.`)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = jarName(id)
  const dest = path.join(JARS_DIR, name)
  const meta = await fetchJson(entry.url, { label: `the metadata for ${id}` })
  const javaMajor = meta.javaVersion?.majorVersion ?? null
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: 1, total: 1, cached: true })
    return { name, path: dest, version: id, javaMajor, cached: true }
  }
  const dl = meta.downloads?.server
  if (!dl?.url) fail(`Minecraft ${id} publishes no server jar.`)
  const { size, sizeHuman } = await downloadFile(dl.url, dest, {
    hash: 'sha1',
    expected: dl.sha1 ?? null,
    onProgress,
    minBytes: 1024 * 1024,
    label: name,
  })
  return { name, path: dest, version: id, javaMajor, cached: false, size, sizeHuman }
}
