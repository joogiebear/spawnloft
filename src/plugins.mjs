// Installed plugins/mods of a server, and installing them from Modrinth and Hangar.
// Manifests are read straight out of the jar with node's zlib (no zip dependency), reading only
// the central directory and the one entry wanted. Disabling renames <file>.jar to <file>.jar.disabled.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fail, UserError, readJson, writeJson } from './util.mjs'
import { loaderOf } from './registry.mjs'
import { softwareOf, versionFromJar } from './software.mjs'
import * as activity from './activity.mjs'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

// the end-of-central-directory record is at the end of the file, behind an optional comment of up to 64 KiB
function readEocd(fd, size) {
  const tailSize = Math.min(size, 22 + 65535)
  const tail = Buffer.alloc(tailSize)
  fs.readSync(fd, tail, 0, tailSize, size - tailSize)
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return {
        entries: tail.readUInt16LE(i + 10),
        cdSize: tail.readUInt32LE(i + 12),
        cdOffset: tail.readUInt32LE(i + 16),
      }
    }
  }
  return null
}

function* zipEntries(fd, size) {
  const eocd = readEocd(fd, size)
  if (!eocd || eocd.cdOffset === 0xffffffff) return

  const cd = Buffer.alloc(eocd.cdSize)
  fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset)

  let at = 0
  for (let n = 0; n < eocd.entries && at + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(at) !== CENTRAL_SIG) break
    const nameLen = cd.readUInt16LE(at + 28)
    const extraLen = cd.readUInt16LE(at + 30)
    const commentLen = cd.readUInt16LE(at + 32)
    yield {
      name: cd.toString('utf8', at + 46, at + 46 + nameLen),
      method: cd.readUInt16LE(at + 10),
      compressed: cd.readUInt32LE(at + 20),
      localOffset: cd.readUInt32LE(at + 42),
    }
    at += 46 + nameLen + extraLen + commentLen
  }
}

function readEntryData(fd, entry) {
  if (entry.compressed === 0xffffffff || entry.localOffset === 0xffffffff) return null
  // the local header's extra field can differ in length from the central one, so read it
  const local = Buffer.alloc(30)
  fs.readSync(fd, local, 0, 30, entry.localOffset)
  if (local.readUInt32LE(0) !== LOCAL_SIG) return null
  const dataAt = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  const data = Buffer.alloc(entry.compressed)
  fs.readSync(fd, data, 0, entry.compressed, dataAt)
  if (entry.method === 0) return data
  if (entry.method === 8) return zlib.inflateRawSync(data)
  return null
}

// Zip64 archives (0xffffffff sizes) are declined rather than misread.
export function readZipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    for (const entry of zipEntries(fd, size)) {
      if (entry.name === wanted) return readEntryData(fd, entry)
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// mapPath(name) returns the destination relative to dest, or null to skip the entry.
// Entry names come from the archive, so every path is confined to dest before writing.
export function extractZip(file, dest, { mapPath = (n) => n } = {}) {
  const fd = fs.openSync(file, 'r')
  const written = []
  try {
    const size = fs.fstatSync(fd).size
    const root = path.resolve(dest)
    for (const entry of zipEntries(fd, size)) {
      if (entry.name.endsWith('/')) continue
      const mapped = mapPath(entry.name)
      if (mapped == null) continue
      const target = path.resolve(root, mapped)
      if (target !== root && !target.startsWith(root + path.sep)) {
        fail(`the archive tried to write outside its folder ("${entry.name}"); nothing more was extracted`)
      }
      const data = readEntryData(fd, entry)
      if (data == null) fail(`could not read "${entry.name}" out of ${path.basename(file)}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
      written.push(mapped.replace(/\\/g, '/'))
    }
    return written
  } finally {
    fs.closeSync(fd)
  }
}

// Reads the top-level scalars and simple lists of a plugin.yml. Not a YAML parser: nested
// blocks are skipped and anything unreadable is left out.
export function parsePluginYml(text) {
  const out = {}
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s/.test(line) || line.startsWith('#')) continue
    const m = /^([\w.-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    let value = m[2].trim()

    if (value === '' || value === '|' || value === '>' || value === '|-' || value === '>-') {
      // block: a list, a folded scalar, or a nested map (skipped)
      const block = []
      let j = i + 1
      while (j < lines.length && (/^\s/.test(lines[j]) || lines[j] === '')) {
        if (lines[j].trim()) block.push(lines[j].trim())
        j++
      }
      if (block.every((b) => b.startsWith('- '))) {
        out[key] = block.map((b) => unquote(b.slice(2)))
      } else if (value !== '' && block.length) {
        out[key] = block.join(' ')
      }
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map((v) => unquote(v)).filter(Boolean)
      continue
    }
    out[key] = unquote(value)
  }
  return out
}

function unquote(v) {
  const t = String(v).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

const DISABLED = '.disabled'

// Bukkit-family servers load plugins/, mod loaders load mods/, vanilla loads nothing.
// software.mjs decides which; a plugin won't load as a mod, hence the different Modrinth facet.
export function contentKindFor(inst) {
  const sw = softwareOf(loaderOf(inst))
  if (sw.content === 'mods') return { dir: 'mods', kind: 'mods', word: 'mod', projectType: 'mod', hangar: false, label: sw.label }
  if (sw.content === 'none') return { dir: 'plugins', kind: 'none', word: 'plugin', projectType: 'plugin', hangar: false, label: sw.label }
  return { dir: 'plugins', kind: 'plugins', word: 'plugin', projectType: 'plugin', hangar: sw.hangar, label: sw.label }
}

export function loadersFor(inst) {
  const sw = softwareOf(loaderOf(inst))
  return sw.modrinth.length ? sw.modrinth : LOADERS
}

function pluginsDir(inst) {
  return path.join(inst.dir, contentKindFor(inst).dir)
}

// Record of the jars mcctl installed. Hand-dropped jars are not managed: no updates, and their
// hashes are never sent to Modrinth. Kept in the plugins folder (the server ignores non-jars)
// so snapshots carry it.
const STORE = '.mcctl-plugins.json'

export function readManaged(inst) {
  const store = readJson(path.join(pluginsDir(inst), STORE), null)
  return store && typeof store.managed === 'object' && store.managed ? store : { version: 1, managed: {} }
}

function writeManaged(inst, store) {
  writeJson(path.join(pluginsDir(inst), STORE), store)
}

export function recordManaged(inst, file, meta) {
  const store = readManaged(inst)
  store.managed[file] = meta
  writeManaged(inst, store)
}

export function forgetManaged(inst, file) {
  const store = readManaged(inst)
  if (Object.hasOwn(store.managed, file)) {
    delete store.managed[file]
    writeManaged(inst, store)
  }
}

function moveManaged(inst, from, to) {
  const store = readManaged(inst)
  if (Object.hasOwn(store.managed, from)) {
    store.managed[to] = store.managed[from]
    delete store.managed[from]
    writeManaged(inst, store)
  }
}

export function mcVersionOf(inst) {
  if (inst?.mcVersion) return String(inst.mcVersion)
  return versionFromJar(inst?.jar)
}

// Minimal TOML for a NeoForge manifest: scalar fields of the first [[mods]] block. A version of
// ${file.jarVersion} means it lives in the jar's MANIFEST.MF.
export function parseModsToml(text, { jarVersion = null } = {}) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === '[[mods]]')
  if (start === -1) return null
  const out = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('[')) break
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (value.startsWith("'''") || value.startsWith('"""')) {
      const quote = value.slice(0, 3)
      let body = value.slice(3)
      while (i + 1 < lines.length && !body.includes(quote)) body += `\n${lines[++i]}`
      value = body.slice(0, body.indexOf(quote)).trim()
    } else {
      value = value.replace(/\s#.*$/, '').trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
    }
    out[m[1]] = value
  }
  let version = out.version ?? null
  if (version && version.includes('${')) version = jarVersion
  return {
    name: out.displayName || out.modId,
    version,
    description: out.description,
    authors: out.authors ? [out.authors] : [],
  }
}

function readNeoforgeManifest(full) {
  const raw = readZipEntry(full, 'META-INF/neoforge.mods.toml') ?? readZipEntry(full, 'META-INF/mods.toml')
  if (!raw) return null
  let jarVersion = null
  const mf = readZipEntry(full, 'META-INF/MANIFEST.MF')
  if (mf) jarVersion = /^Implementation-Version:\s*(.+)$/m.exec(mf.toString('utf8'))?.[1]?.trim() ?? null
  return parseModsToml(raw.toString('utf8'), { jarVersion })
}

function readFabricManifest(full) {
  const raw = readZipEntry(full, 'fabric.mod.json')
  if (!raw) return null
  let data
  try {
    data = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  // authors are strings or { name } objects, sometimes both
  const authors = (Array.isArray(data.authors) ? data.authors : [])
    .map((a) => (typeof a === 'string' ? a : a?.name))
    .filter(Boolean)
  return {
    name: data.name || data.id,
    version: data.version,
    description: data.description,
    authors,
    website: data.contact?.homepage,
  }
}

// A jar with no readable manifest is still listed, by filename.
export function listPlugins(inst) {
  const dir = pluginsDir(inst)
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const store = readManaged(inst)
  const rows = []
  for (const file of entries) {
    const enabled = file.endsWith('.jar')
    if (!enabled && !file.endsWith(`.jar${DISABLED}`)) continue
    const full = path.join(dir, file)
    let meta = {}
    try {
      const yml = readZipEntry(full, 'plugin.yml') ?? readZipEntry(full, 'paper-plugin.yml')
      if (yml) meta = parsePluginYml(yml.toString('utf8'))
      else meta = readFabricManifest(full) ?? readNeoforgeManifest(full) ?? {}
    } catch {
      /* unreadable jar: still listed by filename */
    }
    const st = fs.statSync(full)
    const record = store.managed[file] ?? null
    rows.push({
      file,
      enabled,
      // managed = mcctl installed it; hand-dropped jars are listed but never managed
      managed: Boolean(record),
      source: record?.source ?? null,
      project: record?.project ?? null,
      installedVersion: record?.version ?? null,
      name: meta.name || file.replace(/\.jar(\.disabled)?$/, ''),
      version: meta.version || null,
      description: meta.description || null,
      authors: meta.authors || (meta.author ? [meta.author] : []),
      apiVersion: meta['api-version'] || null,
      website: meta.website || null,
      size: st.size,
      mtime: st.mtime,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function setPluginEnabled(inst, file, enabled) {
  const dir = pluginsDir(inst)
  const current = safePluginPath(dir, file)
  const isOn = file.endsWith('.jar')
  if (isOn === Boolean(enabled)) return { file, enabled: isOn }
  const next = enabled ? file.slice(0, -DISABLED.length) : `${file}${DISABLED}`
  fs.renameSync(current, path.join(dir, next))
  moveManaged(inst, file, next)
  activity.record(inst.name, enabled ? 'plugin-enable' : 'plugin-disable', { detail: file.replace(/\.disabled$/, '') })
  return { file: next, enabled: Boolean(enabled) }
}

export function removePlugin(inst, file) {
  const dir = pluginsDir(inst)
  fs.rmSync(safePluginPath(dir, file), { force: true })
  forgetManaged(inst, file)
  activity.record(inst.name, 'plugin-remove', { detail: file })
  return { removed: file }
}

// the name arrives over HTTP; only a plain jar name inside the plugins folder is allowed
function safePluginPath(dir, file) {
  const name = String(file)
  if (!/^[^\\/]+\.jar(\.disabled)?$/.test(name) || name.includes('..')) {
    fail(`"${file}" is not a plugin file name`)
  }
  const full = path.join(dir, name)
  if (!fs.existsSync(full)) fail(`no plugin file "${name}" in ${dir}`)
  return full
}

const MODRINTH = 'https://api.modrinth.com/v2'
// Paper also runs Spigot and Bukkit plugins
export const LOADERS = ['paper', 'spigot', 'bukkit', 'folia']

export async function modrinthRequest(pathname, init) {
  return modrinth(pathname, init)
}

async function modrinth(pathname, init) {
  let res
  try {
    res = await fetch(`${MODRINTH}${pathname}`, {
      ...init,
      headers: {
        // Modrinth requires a user-agent
        'user-agent': 'joogiebear/spawnloft (github.com/joogiebear/spawnloft)',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new UserError(`could not reach Modrinth: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`Modrinth answered ${res.status} for ${pathname}`)
  return res.json()
}

// Not filtered by game version: sparse metadata would hide much of the ecosystem. The version
// is applied when a build is picked, where a mismatch can be reported.
export async function searchPlugins(query, { limit = 20, loaders = LOADERS, projectType = 'plugin' } = {}) {
  const facets = [
    [`project_type:${projectType}`],
    loaders.map((l) => `categories:${l}`),
  ]
  const params = new URLSearchParams({
    query: String(query ?? ''),
    facets: JSON.stringify(facets),
    limit: String(limit),
    index: 'relevance',
  })
  const data = await modrinth(`/search?${params}`)
  return data.hits.map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url || null,
  }))
}

// Modpacks a server can be built from: server side not unsupported, on fabric or neoforge.
// Client-only packs would install as an empty world.
export async function searchModpacks(query, { limit = 20 } = {}) {
  const facets = [
    ['project_type:modpack'],
    ['server_side:required', 'server_side:optional'],
    ['categories:fabric', 'categories:neoforge'],
  ]
  const params = new URLSearchParams({
    query: String(query ?? ''),
    facets: JSON.stringify(facets),
    limit: String(limit),
    index: 'relevance',
  })
  const data = await modrinth(`/search?${params}`)
  return data.hits.map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
  }))
}

// Hangar is PaperMC's plugin platform. Some projects host downloads externally; those can't be
// installed and are reported with the link. Version support is a sparse exact list ("26.1.2" but
// not "26.2"), so an exact match is preferred, else the newest build is offered with the mismatch stated.
const HANGAR = 'https://hangar.papermc.io/api/v1'

async function hangar(pathname) {
  let res
  try {
    res = await fetch(`${HANGAR}${pathname}`, {
      headers: { 'user-agent': 'joogiebear/spawnloft (github.com/joogiebear/spawnloft)' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new UserError(`could not reach Hangar: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`Hangar answered ${res.status} for ${pathname}`)
  return res.json()
}

export async function searchHangar(query, { limit = 10 } = {}) {
  const params = new URLSearchParams({ q: String(query ?? ''), limit: String(limit), platform: 'PAPER' })
  const data = await hangar(`/projects?${params}`)
  return (data.result ?? []).map((p) => ({
    source: 'hangar',
    id: p.namespace?.slug ?? p.name,
    slug: p.namespace?.slug ?? p.name,
    title: p.name,
    description: p.description || '',
    downloads: p.stats?.downloads ?? 0,
    author: p.namespace?.owner ?? null,
  }))
}

// Prefer a Release with a Paper file and an exact game-version match, then any channel, then
// the newest downloadable (exactMatch false, for the caller to report). Null if none is downloadable.
export function pickHangarVersion(versions, { gameVersion = null } = {}) {
  const downloadable = (v) => Boolean(v.downloads?.PAPER?.downloadUrl && v.downloads?.PAPER?.fileInfo)
  const exact = (v) => !gameVersion || (v.platformDependencies?.PAPER ?? []).includes(gameVersion)
  const pick =
    versions.find((v) => v.channel?.name === 'Release' && downloadable(v) && exact(v)) ??
    versions.find((v) => downloadable(v) && exact(v)) ??
    versions.find(downloadable) ??
    null
  if (!pick) return null
  return { version: pick, exactMatch: exact(pick) }
}

async function hangarVersions(slug) {
  const data = await hangar(`/projects/${encodeURIComponent(slug)}/versions?limit=25&platform=PAPER`)
  return data.result ?? []
}

export async function installFromHangar(inst, slug, { gameVersion = null } = {}) {
  const versions = await hangarVersions(slug)
  const picked = pickHangarVersion(versions, { gameVersion })
  if (!picked) {
    const external = versions.map((v) => v.downloads?.PAPER?.externalUrl).find(Boolean)
    fail(external
      ? `that project hosts its downloads elsewhere: ${external}\n  Download it by hand and drop it into the plugins folder - SpawnLoft will leave it alone.`
      : 'that project has no downloadable Paper build on Hangar')
  }
  const { version, exactMatch } = picked
  const dl = version.downloads.PAPER

  let res
  try {
    res = await fetch(dl.downloadUrl, { signal: AbortSignal.timeout(120000) })
  } catch (err) {
    throw new UserError(`download failed: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`download failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const wantSha = dl.fileInfo.sha256Hash
  if (wantSha) {
    const got = crypto.createHash('sha256').update(bytes).digest('hex')
    if (got !== wantSha) fail('the download did not match the checksum Hangar published; nothing was installed')
  }

  const dir = pluginsDir(inst)
  fs.mkdirSync(dir, { recursive: true })
  const name = path.basename(String(dl.fileInfo.name || `${slug}.jar`))
  if (!/^[^\\/]+\.jar$/.test(name)) fail(`Hangar offered a file named "${name}", which is not a plugin jar`)
  fs.writeFileSync(path.join(dir, name), bytes)
  recordManaged(inst, name, {
    source: 'hangar',
    project: slug,
    version: version.name,
    installedAt: new Date().toISOString(),
  })
  return {
    installed: name,
    version: version.name,
    size: bytes.length,
    versionNote: exactMatch || !gameVersion
      ? null
      : `Hangar lists support for ${(version.platformDependencies?.PAPER ?? []).slice(-1)[0] ?? 'other versions'}, not ${gameVersion} - it will probably run, but that is its author's claim, not SpawnLoft's.`,
  }
}

// Modrinth lists newest first. Take the first release matching our loaders and game version,
// else the newest compatible pre-release.
export function pickVersion(versions, { gameVersion = null, loaders = LOADERS } = {}) {
  const fits = (v) =>
    v.loaders.some((l) => loaders.includes(l)) &&
    (!gameVersion || v.game_versions.includes(gameVersion))
  return versions.find((v) => v.version_type === 'release' && fits(v)) ?? versions.find(fits) ?? null
}

export function primaryFile(version) {
  return version.files.find((f) => f.primary) ?? version.files[0] ?? null
}

// Verifies the sha1 Modrinth published before the file is written under its final name.
export async function installPlugin(inst, projectId, { gameVersion = null } = {}) {
  const loaders = loadersFor(inst)
  const { word } = contentKindFor(inst)
  const params = new URLSearchParams({ loaders: JSON.stringify(loaders) })
  const versions = await modrinth(`/project/${encodeURIComponent(projectId)}/version?${params}`)
  // the game version is a preference: fall back to the newest build for the loader and report the mismatch
  let version = pickVersion(versions, { gameVersion, loaders })
  let versionNote = null
  if (!version && gameVersion) {
    version = pickVersion(versions, { loaders })
    if (version) {
      const claims = version.game_versions[version.game_versions.length - 1] ?? 'other versions'
      versionNote = `Its newest build lists ${claims}, not ${gameVersion} - it may run anyway, but that is its author's claim, not SpawnLoft's.`
    }
  }
  if (!version) fail(`no build of that ${word} supports a ${loaders[0]} server`)
  const file = primaryFile(version)
  if (!file) fail('that version has no downloadable file')

  let res
  try {
    res = await fetch(file.url, { signal: AbortSignal.timeout(120000) })
  } catch (err) {
    throw new UserError(`download failed: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`download failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const wantSha = file.hashes?.sha1
  if (wantSha) {
    const got = crypto.createHash('sha1').update(bytes).digest('hex')
    if (got !== wantSha) fail('the download did not match the checksum Modrinth published; nothing was installed')
  }

  const dir = pluginsDir(inst)
  fs.mkdirSync(dir, { recursive: true })
  const name = path.basename(String(file.filename || `${projectId}.jar`))
  if (!/^[^\\/]+\.jar$/.test(name)) fail(`Modrinth offered a file named "${name}", which is not a plugin jar`)
  fs.writeFileSync(path.join(dir, name), bytes)
  // only jars with a record here are listed as managed, offered updates, or hashed to Modrinth
  recordManaged(inst, name, {
    source: 'modrinth',
    project: String(version.project_id ?? projectId),
    version: version.version_number,
    installedAt: new Date().toISOString(),
  })
  return { installed: name, version: version.version_number, size: bytes.length, versionNote }
}

// Asks Modrinth by sha1 (version_files/update) for newer builds of the jars mcctl installed.
// Hand-dropped jars are never asked about; their hashes are not ours to send.
export async function checkUpdates(inst, { gameVersion = null } = {}) {
  const rows = listPlugins(inst).filter((p) => p.enabled && p.managed)
  if (!rows.length) return []
  const dir = pluginsDir(inst)
  const updates = []

  // Pack-owned jars are skipped: offering one mod an update out from under its pack breaks packs.
  const modrinthRows = rows.filter((p) => p.source !== 'hangar' && p.source !== 'modpack')
  if (modrinthRows.length) {
    const byHash = new Map()
    for (const p of modrinthRows) {
      const sha = sha1File(path.join(dir, p.file))
      byHash.set(sha, p)
    }
    const body = {
      hashes: [...byHash.keys()],
      algorithm: 'sha1',
      loaders: loadersFor(inst),
      ...(gameVersion ? { game_versions: [gameVersion] } : {}),
    }
    const latest = await modrinth('/version_files/update', { method: 'POST', body: JSON.stringify(body) })
    for (const [sha, p] of byHash) {
      const v = latest[sha]
      if (!v) continue
      const file = primaryFile(v)
      if (!file || file.hashes?.sha1 === sha) continue
      updates.push({
        file: p.file,
        name: p.name,
        installedVersion: p.version,
        latestVersion: v.version_number,
        projectId: v.project_id,
        source: 'modrinth',
      })
    }
  }

  // Hangar has no hash lookup, so compare the recorded version name against the newest pick.
  // One project failing to answer must not sink the whole check.
  for (const p of rows.filter((r) => r.source === 'hangar')) {
    try {
      const picked = pickHangarVersion(await hangarVersions(p.project), { gameVersion })
      if (!picked || picked.version.name === p.installedVersion) continue
      updates.push({
        file: p.file,
        name: p.name,
        installedVersion: p.installedVersion,
        latestVersion: picked.version.name,
        projectId: p.project,
        source: 'hangar',
      })
    } catch {
      /* unreachable project: report nothing */
    }
  }
  return updates
}

function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

// The old jar is deleted only after the new one is on disk and checksummed, so a failure
// leaves two jars rather than none.
export async function updatePlugin(inst, file, { gameVersion = null } = {}) {
  const dir = pluginsDir(inst)
  const current = safePluginPath(dir, file)
  const entry = readManaged(inst).managed[file]
  if (!entry) {
    fail('SpawnLoft did not install this jar, so it will not touch it - custom and premium plugins are yours to update')
  }
  if (entry.source === 'modpack') {
    fail('this mod belongs to the modpack, which governs its version - update the pack, not the mod')
  }

  if (entry.source === 'hangar') {
    const picked = pickHangarVersion(await hangarVersions(entry.project), { gameVersion })
    if (!picked) fail('that project no longer offers a downloadable Paper build on Hangar')
    if (picked.version.name === entry.version) return { alreadyLatest: true, version: entry.version }
    const res = await installFromHangar(inst, entry.project, { gameVersion })
    if (res.installed !== file) {
      fs.rmSync(current, { force: true })
      forgetManaged(inst, file)
    }
    return { updated: res.installed, from: file, version: res.version, versionNote: res.versionNote }
  }

  const sha = sha1File(current)
  const body = {
    hashes: [sha],
    algorithm: 'sha1',
    loaders: loadersFor(inst),
    ...(gameVersion ? { game_versions: [gameVersion] } : {}),
  }
  const latest = await modrinth('/version_files/update', { method: 'POST', body: JSON.stringify(body) })
  const version = latest[sha]
  if (!version) fail('Modrinth does not recognise this jar, so it cannot update it')
  const newFile = primaryFile(version)
  if (!newFile) fail('the latest version has no downloadable file')
  if (newFile.hashes?.sha1 === sha) return { alreadyLatest: true, version: version.version_number }

  const res = await installPlugin(inst, version.project_id, { gameVersion })
  if (res.installed !== file) {
    fs.rmSync(current, { force: true })
    forgetManaged(inst, file)
  }
  return { updated: res.installed, from: file, version: res.version }
}
