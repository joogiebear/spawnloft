import fs from 'node:fs'
import path from 'node:path'

import { fetchJson, downloadFile } from './download.mjs'
import { versionJson, versionDir, profileDir } from './client-paths.mjs'
import { fail, assertSafeVersion, readJson, writeJson } from './util.mjs'
import { modrinthRequest, pickVersion, primaryFile } from './plugins.mjs'

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

export async function ensureFabricApi(profileName, mc, { onProgress = () => {} } = {}) {
  const versions = await modrinthRequest(
    '/project/fabric-api/version?' + new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([mc]) }),
  )
  const version = pickVersion(versions, { gameVersion: mc, loaders: ['fabric'] })
  const file = version && primaryFile(version)
  if (!file) fail('no Fabric API build is published for Minecraft ' + mc)

  const modsDir = path.join(profileDir(profileName), 'mods')
  const recordFile = path.join(modsDir, '.spawnloft-mods.json')
  const record = readJson(recordFile, null) ?? { version: 1, managed: {} }

  for (const [filename, meta] of Object.entries(record.managed)) {
    if (meta.project === 'fabric-api' && meta.mc === mc) {
      const filePath = path.join(modsDir, filename)
      if (fs.existsSync(filePath)) return { installed: false, file: filename }
    }
  }

  if (!/^[^\\/]+\.jar$/.test(file.filename)) {
    fail('Modrinth offered a file named "' + file.filename + '", which is not a mod jar')
  }

  const dest = path.join(modsDir, file.filename)
  fs.mkdirSync(modsDir, { recursive: true })
  await downloadFile(file.url, dest, { hash: 'sha1', expected: file.hashes.sha1, label: 'Fabric API ' + version.version_number })

  for (const [filename, meta] of Object.entries(record.managed)) {
    if (meta.project === 'fabric-api') {
      fs.rmSync(path.join(modsDir, filename), { force: true })
      delete record.managed[filename]
    }
  }

  record.managed[file.filename] = {
    source: 'modrinth',
    project: 'fabric-api',
    version: version.version_number,
    mc,
    installedAt: new Date().toISOString(),
  }
  writeJson(recordFile, record)
  return { installed: true, file: file.filename, version: version.version_number }
}
