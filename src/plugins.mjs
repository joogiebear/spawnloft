/**
 * Plugins: what a server has, and what Modrinth can give it.
 *
 * <p>Everything a jar says about itself lives in its plugin.yml (or paper-plugin.yml), which
 * sits inside a zip. mcctl ships no dependencies, so the zip is read here by hand - the format
 * is stable, the entry wanted is tiny, and zlib's inflateRaw is built into node. Only the
 * bytes needed are read: the end-of-central-directory record, the central directory, and the
 * one entry - never the whole of a fifty-megabyte jar.
 *
 * <p>Disabling a plugin renames it to `<file>.disabled` in place. The server only loads
 * `*.jar`, so the file stays exactly where it was, keeps its config folder, and comes back
 * with a rename - no second folder to keep in sync.
 *
 * <p>Modrinth is the install source: open API, no key, and version metadata that says which
 * game versions and loaders a build supports - so "this does not run on your server" is
 * caught before the download. Everything network-facing degrades to a readable error;
 * the installed list works with no network at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fail, UserError, readJson, writeJson } from './util.mjs'
import { loaderOf } from './registry.mjs'
import { softwareOf, versionFromJar } from './software.mjs'

// ---- reading one entry out of a zip -----------------------------------------

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * Find the end-of-central-directory record. It sits at the very end of the file, behind an
 * optional comment of up to 64 KiB, so the search reads only that tail.
 */
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

/** Walk the central directory, yielding one record per entry. Shared by every reader below. */
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

/** The bytes of one entry, following its local header. Null for anything unreadable. */
function readEntryData(fd, entry) {
  if (entry.compressed === 0xffffffff || entry.localOffset === 0xffffffff) return null
  // The local header repeats the name and extra field, and the extra field there can differ
  // in length from the central one - so it is read, not assumed.
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

/**
 * Read one named entry from a zip, or null when it is not there.
 *
 * <p>Zip64 archives report 0xffffffff sizes and are declined rather than misread - a
 * plugin.yml has never needed four gigabytes.
 */
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

/**
 * Extract a zip's files into a directory, with the caller deciding where each lands.
 *
 * <p>`mapPath(name)` returns the destination RELATIVE to dest, or null to skip the entry -
 * which is how a modpack's `overrides/` prefix is stripped and everything outside it left
 * behind. Every path is confined to dest before a byte is written: entry names arrive from
 * the archive, and "../" in one would otherwise turn "extract a pack" into "write anywhere".
 */
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

// ---- just enough YAML -------------------------------------------------------

/**
 * The top-level scalars and simple lists of a plugin.yml.
 *
 * <p>Not a YAML parser - a reader for the handful of fields a plugin manifest actually uses.
 * Nested blocks (commands, permissions) are skipped whole; folded scalars keep their first
 * following lines; flow and block lists become arrays. Anything it cannot read it leaves
 * out, and a missing field is normal.
 */
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
      // A block: either a list, a folded scalar, or a nested map (which is skipped).
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

// ---- the installed list -----------------------------------------------------

const DISABLED = '.disabled'

/**
 * What "content" means for this instance. A Bukkit-family server loads plugins from plugins/;
 * a mod loader loads mods from mods/; vanilla loads nothing. Same management, different folder
 * and vocabulary - and a different Modrinth facet, because a plugin will not load as a mod or
 * vice versa. The table in software.mjs is the authority; this shapes its answer.
 */
export function contentKindFor(inst) {
  const sw = softwareOf(loaderOf(inst))
  if (sw.content === 'mods') return { dir: 'mods', kind: 'mods', word: 'mod', projectType: 'mod', hangar: false, label: sw.label }
  if (sw.content === 'none') return { dir: 'plugins', kind: 'none', word: 'plugin', projectType: 'plugin', hangar: false, label: sw.label }
  return { dir: 'plugins', kind: 'plugins', word: 'plugin', projectType: 'plugin', hangar: sw.hangar, label: sw.label }
}

/** The Modrinth loader facet for this instance's content. */
export function loadersFor(inst) {
  const sw = softwareOf(loaderOf(inst))
  return sw.modrinth.length ? sw.modrinth : LOADERS
}

function pluginsDir(inst) {
  return path.join(inst.dir, contentKindFor(inst).dir)
}

// ---- what mcctl itself installed --------------------------------------------

/**
 * Provenance: which jars in this folder mcctl put there, and from where.
 *
 * <p>The distinction carries the whole feature. A jar somebody dropped in by hand - a custom
 * build, a premium plugin bought elsewhere - is theirs: it would never show an update, its
 * hash must not be sent to Modrinth to ask, and a manager that lists it anyway is claiming
 * jurisdiction it does not have. So mcctl manages exactly what it installed, records that
 * here, and leaves everything else alone.
 *
 * <p>The record lives IN the plugins folder (the server ignores non-jar files), so a
 * plugins-scope snapshot carries it and a restore keeps the managed set consistent with the
 * jars beside it.
 */
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

/** A rename (enable/disable, or an update that changed the filename) moves the record along. */
function moveManaged(inst, from, to) {
  const store = readManaged(inst)
  if (Object.hasOwn(store.managed, from)) {
    store.managed[to] = store.managed[from]
    delete store.managed[from]
    writeManaged(inst, store)
  }
}

/** The Minecraft version this server runs: recorded when the registry knows it, else read
 * from the jar's filename; null when unclear. */
export function mcVersionOf(inst) {
  if (inst?.mcVersion) return String(inst.mcVersion)
  return versionFromJar(inst?.jar)
}

/**
 * Just enough TOML for a NeoForge mod manifest - the first [[mods]] block's scalar fields,
 * the same way plugin.yml got a YAML-lite. `${file.jarVersion}` is the one indirection worth
 * chasing: it means "my version is in the jar manifest", and that is where it is read from.
 */
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

/** What a Fabric mod's own manifest says, mapped to the same shape plugin.yml yields. */
function readFabricManifest(full) {
  const raw = readZipEntry(full, 'fabric.mod.json')
  if (!raw) return null
  let data
  try {
    data = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  // authors entries are strings or { name } objects, in the wild both at once.
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

/**
 * Every plugin jar this server has, enabled or not, with what its manifest says about it.
 *
 * <p>A jar with no readable manifest still appears - it is on disk and will be loaded (or
 * refused) by the server, and hiding it from the one screen that manages plugins would make
 * that screen lie. It simply carries no name beyond its filename.
 */
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
      /* an unreadable jar is still listed by filename */
    }
    const st = fs.statSync(full)
    const record = store.managed[file] ?? null
    rows.push({
      file,
      enabled,
      // Managed means mcctl installed it and may update it. A jar dropped in by hand is the
      // person's own - listed here for the CLI's inventory, but never offered management.
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

/** Flip one plugin on or off by renaming it in place. Takes effect at the next start. */
export function setPluginEnabled(inst, file, enabled) {
  const dir = pluginsDir(inst)
  const current = safePluginPath(dir, file)
  const isOn = file.endsWith('.jar')
  if (isOn === Boolean(enabled)) return { file, enabled: isOn }
  const next = enabled ? file.slice(0, -DISABLED.length) : `${file}${DISABLED}`
  fs.renameSync(current, path.join(dir, next))
  moveManaged(inst, file, next)
  return { file: next, enabled: Boolean(enabled) }
}

export function removePlugin(inst, file) {
  const dir = pluginsDir(inst)
  fs.rmSync(safePluginPath(dir, file), { force: true })
  forgetManaged(inst, file)
  return { removed: file }
}

/**
 * The file must be a plain name inside the plugins folder. The name arrives over HTTP, and a
 * path that walks out of the folder would turn "delete a plugin" into "delete anything".
 */
function safePluginPath(dir, file) {
  const name = String(file)
  if (!/^[^\\/]+\.jar(\.disabled)?$/.test(name) || name.includes('..')) {
    fail(`"${file}" is not a plugin file name`)
  }
  const full = path.join(dir, name)
  if (!fs.existsSync(full)) fail(`no plugin file "${name}" in ${dir}`)
  return full
}

// ---- Modrinth ---------------------------------------------------------------

const MODRINTH = 'https://api.modrinth.com/v2'
// The loaders a Paper server can actually load. Paper runs Spigot and Bukkit plugins, so a
// build published for those is as installable as one published for Paper itself.
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
        // Modrinth asks every client to say who it is.
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

/**
 * Search Modrinth for content this kind of server can load - plugins or mods by loader.
 *
 * <p>Deliberately NOT filtered by game version. Hiding everything that does not list the
 * server's exact version hid half the ecosystem behind sparse metadata; the version is a
 * preference applied when a build is PICKED, where a mismatch can be said instead of
 * silently pre-empted. People choose what to run; mcctl states the claim.
 */
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

/**
 * Search Modrinth for modpacks a SERVER can be built from: packs whose server side is not
 * unsupported, on a loader mcctl can run (Fabric, until the NeoForge phase lands). A pack
 * that is client-only would install fine and then be an empty world with none of its point.
 */
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

// ---- Hangar -----------------------------------------------------------------

/**
 * Hangar is PaperMC's own plugin platform, and the second source - plenty of Paper-ecosystem
 * plugins publish there and nowhere else. Two things make it different from Modrinth:
 *
 * <ul>
 *   <li>Some projects host their downloads elsewhere (an external release page instead of a
 *       file). Those cannot be installed by mcctl and are said to be so, with the link -
 *       installing by hand is exactly what the manual-plugins boundary is for.</li>
 *   <li>Version support is a sparse, exact list ("26.1.2" but not "26.2"), maintained by
 *       hand. An exact match is preferred; failing that, the newest downloadable build is
 *       offered WITH the mismatch stated, because "claims up to 26.1.2" is information the
 *       person should weigh - not a reason to silently offer nothing.</li>
 * </ul>
 */
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

/**
 * Choose a Hangar version: newest Release with a real Paper file and an exact game-version
 * match; then any channel with both; then the newest downloadable at all, flagged as a
 * version mismatch for the caller to say out loud. Null only when nothing is downloadable.
 */
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
    // Carried up so the person is told, not protected from, a claims mismatch.
    versionNote: exactMatch || !gameVersion
      ? null
      : `Hangar lists support for ${(version.platformDependencies?.PAPER ?? []).slice(-1)[0] ?? 'other versions'}, not ${gameVersion} - it will probably run, but that is its author's claim, not SpawnLoft's.`,
  }
}

/**
 * Choose the version to install from what a project offers.
 *
 * <p>Newest first is Modrinth's order. The first release that supports one of our loaders
 * (and the server's game version, when known) wins; with nothing but pre-releases, the
 * newest compatible one of those is better than nothing and is labelled by its own type.
 */
export function pickVersion(versions, { gameVersion = null, loaders = LOADERS } = {}) {
  const fits = (v) =>
    v.loaders.some((l) => loaders.includes(l)) &&
    (!gameVersion || v.game_versions.includes(gameVersion))
  return versions.find((v) => v.version_type === 'release' && fits(v)) ?? versions.find(fits) ?? null
}

/** The downloadable file of a version: the one marked primary, else the first. */
export function primaryFile(version) {
  return version.files.find((f) => f.primary) ?? version.files[0] ?? null
}

/**
 * Download one project's best version into the plugins folder.
 *
 * <p>The bytes are checked against the sha1 Modrinth published before the file is allowed to
 * keep its name - a truncated or tampered download must not sit there looking installed.
 */
export async function installPlugin(inst, projectId, { gameVersion = null } = {}) {
  const loaders = loadersFor(inst)
  const { word } = contentKindFor(inst)
  const params = new URLSearchParams({ loaders: JSON.stringify(loaders) })
  const versions = await modrinth(`/project/${encodeURIComponent(projectId)}/version?${params}`)
  // The server's version is a preference, not a wall: an exact match wins, and failing one
  // the newest build for the right loader installs WITH the mismatch stated - the same deal
  // Hangar's sparse version lists already get.
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
  // Recorded as mcctl's to manage. Only jars with a record here are ever listed by the panel,
  // offered updates, or have their hashes sent anywhere.
  recordManaged(inst, name, {
    source: 'modrinth',
    project: String(version.project_id ?? projectId),
    version: version.version_number,
    installedAt: new Date().toISOString(),
  })
  return { installed: name, version: version.version_number, size: bytes.length, versionNote }
}

/**
 * Which of the jars MCCTL INSTALLED have a newer build, asked by hash.
 *
 * <p>Hashes rather than names, because a jar knows nothing reliable about where it came
 * from - Modrinth's version_files/update endpoint maps a file's sha1 straight to the latest
 * version of whatever project it belongs to.
 *
 * <p>Only managed jars are asked about, and that is a boundary, not an optimisation: a
 * custom or premium plugin somebody dropped in by hand is not mcctl's to update, and its
 * hash is not mcctl's to send to anyone.
 */
export async function checkUpdates(inst, { gameVersion = null } = {}) {
  const rows = listPlugins(inst).filter((p) => p.enabled && p.managed)
  if (!rows.length) return []
  const dir = pluginsDir(inst)
  const updates = []

  // Modrinth-installed jars go by hash, in one batch. Pack-owned jars are deliberately not
  // asked about at all: the pack governs their versions, and offering one mod an individual
  // update out from under its pack is how packs break.
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
      // Same hash means same file: already the newest.
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

  // Hangar has no hash lookup, but the provenance record knows exactly which version was
  // installed, so the comparison is the recorded name against the newest pick. One project
  // failing to answer must not sink the whole check.
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
      /* an unreachable project simply reports nothing this round */
    }
  }
  return updates
}

function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Replace one installed jar with its latest build. The old jar is deleted only after the new
 * one is fully on disk and checksummed - the failure mode must be "two jars, remove one",
 * never "no plugin at all".
 */
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
