import fs from 'node:fs'
import path from 'node:path'

import { fetchJson, downloadFile } from './download.mjs'
import { versionJson, versionDir, profileDir } from './client-paths.mjs'
import { fail, assertSafeVersion, readJson, writeJson } from './util.mjs'
import { modrinthRequest, pickVersion, primaryFile, readZipEntry } from './plugins.mjs'

export const META_URL = 'https://meta.fabricmc.net/v2'

export async function loaderVersions(mc, { fetchImpl = fetchJson } = {}) {
  const safe = assertSafeVersion(mc, 'Minecraft version')
  const list = await fetchImpl(`${META_URL}/versions/loader/${safe}`, { label: `Fabric loaders for ${safe}` })
  if (!Array.isArray(list) || list.length === 0) {
    fail('Fabric publishes no loader for Minecraft ' + mc)
  }
  return list.map((e) => ({ version: e.loader.version, stable: e.loader.stable === true }))
}

export function pickLoader(list, { wanted = null } = {}) {
  if (list.length === 0) fail('no Fabric loader to pick from')
  if (wanted) {
    const entry = list.find((e) => e.version === wanted)
    if (!entry) {
      fail('Fabric loader ' + wanted + ' is not published for this Minecraft version; known: ' + list.map((e) => e.version).join(', '))
    }
    return entry
  }
  return list.find((e) => e.stable) ?? list[0]
}

export function fabricVersionId(mc, loader) {
  return 'fabric-loader-' + loader + '-' + mc
}

export async function ensureFabricProfile(mc, loader, { fetchImpl = fetchJson } = {}) {
  const safeMc = assertSafeVersion(mc, 'Minecraft version')
  const safeLoader = assertSafeVersion(loader, 'Fabric loader version')
  const id = fabricVersionId(safeMc, safeLoader)
  const dest = versionJson(id)
  if (fs.existsSync(dest)) return id
  const json = await fetchImpl(`${META_URL}/versions/loader/${safeMc}/${safeLoader}/profile/json`, { label: `Fabric profile for ${safeMc} with loader ${safeLoader}` })
  if (json.id !== id) {
    fail('the Fabric meta answered for a different profile (expected ' + id + ', got ' + json.id + ')')
  }
  if (json.inheritsFrom !== safeMc) {
    fail('the Fabric meta profile inherits from ' + json.inheritsFrom + ', not ' + safeMc)
  }
  fs.mkdirSync(versionDir(id), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(json, null, 2))
  return id
}

// Jars in mods/ whose fabric.mod.json says id "fabric-api", whatever the file is called.
function fabricApiJars(modsDir) {
  let names = []
  try { names = fs.readdirSync(modsDir) } catch (err) { if (err.code !== 'ENOENT') throw err }
  return names.filter((n) => /\.jar$/i.test(n)).filter((n) => {
    try {
      const raw = readZipEntry(path.join(modsDir, n), 'fabric.mod.json')
      return raw !== null && raw !== undefined && JSON.parse(raw.toString('utf8')).id === 'fabric-api'
    } catch {
      return false
    }
  })
}

export async function ensureFabricApi(profileName, mc, { onProgress = () => {} } = {}) {
  const modsDir = path.join(profileDir(profileName), 'mods')
  const recordFile = path.join(modsDir, '.spawnloft-mods.json')
  const record = readJson(recordFile, null) ?? { version: 1, managed: {} }

  // Fabric refuses to start with two copies of one mod. A Fabric API someone put in mods/ by hand
  // is used as it is; a second copy beside it is a mistake to fix, not to download a third for.
  const present = fabricApiJars(modsDir)
  const handDropped = present.filter((n) => !Object.hasOwn(record.managed, n))
  // Two managed copies are SpawnLoft's own leftover (a crash mid-update); the download below
  // replaces them, so only a copy someone dropped in makes this a person's problem.
  if (handDropped.length && present.length > 1) {
    fail(`mods/ in profile "${profileName}" holds ${present.length} copies of Fabric API (${present.join(', ')}), and the game will not start with more than one; remove all but one from ${modsDir}`)
  }
  if (handDropped.length === 1) return { installed: false, file: handDropped[0], handDropped: true }

  for (const [filename, meta] of Object.entries(record.managed)) {
    if (meta.project === 'fabric-api' && meta.mc === mc && present.length <= 1) {
      const filePath = path.join(modsDir, filename)
      if (fs.existsSync(filePath)) return { installed: false, file: filename }
    }
  }

  const versions = await modrinthRequest(
    '/project/fabric-api/version?' + new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([mc]) }),
  )
  const version = pickVersion(versions, { gameVersion: mc, loaders: ['fabric'] })
  const file = version && primaryFile(version)
  if (!file) fail('no Fabric API build is published for Minecraft ' + mc)

  if (!/^[^\\/]+\.jar$/.test(file.filename)) {
    fail('Modrinth offered a file named "' + file.filename + '", which is not a mod jar')
  }

  const dest = path.join(modsDir, file.filename)
  fs.mkdirSync(modsDir, { recursive: true })
  await downloadFile(file.url, dest, { hash: 'sha1', expected: file.hashes.sha1, label: 'Fabric API ' + version.version_number })

  // Recorded before the old copy goes, so a crash in between leaves two managed jars (replaced on
  // the next launch) rather than one the duplicate check would take for hand-dropped.
  const old = Object.entries(record.managed).filter(([filename, meta]) => meta.project === 'fabric-api' && filename !== file.filename)
  record.managed[file.filename] = {
    source: 'modrinth',
    project: 'fabric-api',
    version: version.version_number,
    mc,
    installedAt: new Date().toISOString(),
  }
  writeJson(recordFile, record)
  for (const [filename] of old) {
    fs.rmSync(path.join(modsDir, filename), { force: true })
    delete record.managed[filename]
  }
  if (old.length) writeJson(recordFile, record)
  return { installed: true, file: file.filename, version: version.version_number }
}
