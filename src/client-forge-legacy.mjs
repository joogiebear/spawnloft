// Forge's older installer, for Minecraft 1.6.4 to 1.12.2 (builds before 1.12.2's 2851): an
// install_profile.json with two parts and no build steps. `install` says where the Forge jar in
// the installer goes; `versionInfo` is the version file itself. SpawnLoft reads it into the shape
// of the newer installer (no profile libraries, no steps, the Forge jar taken out of the
// installer), so the installer engine sets it up the same way.
//
// The rough edges are in the data: a library row gives a maven base URL, or none (Mojang's), and
// some carry checksums and some do not. Each URL is made https and pointed at today's Forge maven,
// each library gets the checksum its maven publishes beside it (and must match the installer's
// own list, when there is one), rows the client does not need are left out, and a version file
// that does not inherit from vanilla is made to. `optionals` (Mercurius, a statistics mod) is
// not installed.
import crypto from 'node:crypto'

import { readZipEntry } from './plugins.mjs'
import { assertLoaderHost } from './client-loader-hosts.mjs'
import { fetchCapped } from './download.mjs'
import { fail, safeRelativePath } from './util.mjs'
import { isSafeVersionId } from './client-version.mjs'
import { libraryPath } from './client-meta.mjs'

const isSha1 = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)
const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

export const isLegacyProfile = (profile) => Boolean(profile && typeof profile === 'object' && (profile.install || profile.versionInfo))

// An old maven base made today's: https, and Forge's maven where it now lives.
export function legacyBaseUrl(url) {
  let u = String(url ?? '').trim()
  if (!u) return 'https://libraries.minecraft.net/'
  u = u.replace(/^http:\/\//i, 'https://')
  u = u.replace(/^https:\/\/files\.minecraftforge\.net\/maven\/?/i, 'https://maven.minecraftforge.net/')
  return u.endsWith('/') ? u : `${u}/`
}

function placed(name) {
  if (typeof name !== 'string' || name.split(':').length < 3 || name.length > 300) return null
  const rel = safeRelativePath(libraryPath(name))
  return rel && rel === libraryPath(name) ? rel : null
}

// The newer installer's shape out of the old one: { profile, version, pending }. pending lists
// the library rows still without a checksum ({ index, url, sums }), which fillLegacyChecksums
// asks the mavens for before the version file is written.
export function convertLegacy(profile, { mc, id, installerPath, who = 'Forge' }) {
  const unknown = (why) => fail(`This ${who} build needs a newer SpawnLoft (${why}). Update SpawnLoft, or pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  const inst = profile.install
  const info = profile.versionInfo
  if (!inst || typeof inst !== 'object' || !info || typeof info !== 'object' || !Array.isArray(info.libraries)) unknown('an old installer profile SpawnLoft does not know')
  if (inst.minecraft !== mc) fail(`The ${who} installer is for Minecraft ${String(inst.minecraft).slice(0, 40)}, not ${mc}; pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  if (info.inheritsFrom != null && info.inheritsFrom !== mc) fail(`The ${who} installer's version inherits from ${String(info.inheritsFrom).slice(0, 40)}, not Minecraft ${mc}; pick another ${who} build in Advanced.`, 'loader-installer-unknown')
  if (typeof info.mainClass !== 'string' || typeof info.minecraftArguments !== 'string') unknown('a version file with no main class or arguments')
  if (!isSafeVersionId(id)) fail(`${who} makes a version id SpawnLoft cannot use`)
  const forgeRel = placed(inst.path)
  const entry = typeof inst.filePath === 'string' ? safeRelativePath(inst.filePath.replace(/^\//, '')) : null
  if (!forgeRel || !entry) unknown('a Forge jar SpawnLoft cannot place')
  const jar = readZipEntry(installerPath, entry)
  if (!jar) unknown(`no ${entry} in the installer`)

  const libraries = []
  const pending = []
  let hasForge = false
  for (const lib of info.libraries) {
    if (!lib || typeof lib.name !== 'string') continue
    // a row only the server needs
    if (lib.clientreq === false) continue
    const rel = placed(lib.name)
    if (!rel) fail(`The ${who} installer names a library "${lib.name.slice(0, 80)}" SpawnLoft cannot place in its libraries folder`, 'loader-installer-unknown')
    if (lib.name === inst.path) {
      hasForge = true
      libraries.push({ name: lib.name, downloads: { artifact: { path: rel, url: '', sha1: sha1Of(jar), size: jar.length } } })
      continue
    }
    if (lib.natives || lib.rules) unknown(`a library row for ${lib.name.slice(0, 60)} SpawnLoft does not know`)
    const url = legacyBaseUrl(lib.url) + rel
    assertLoaderHost(url, `The ${who} installer`)
    const sums = Array.isArray(lib.checksums) ? lib.checksums.filter(isSha1).map((s) => s.toLowerCase()) : []
    pending.push({ index: libraries.length, url, sums })
    libraries.push({ name: lib.name, downloads: { artifact: { path: rel, url } } })
  }
  if (!hasForge) {
    libraries.unshift({ name: inst.path, downloads: { artifact: { path: forgeRel, url: '', sha1: sha1Of(jar), size: jar.length } } })
    for (const p of pending) p.index++
  }
  const { libraries: _old, jar: _jar, inheritsFrom: _from, ...rest } = info
  const version = { ...rest, id, inheritsFrom: mc, libraries }
  return {
    profile: { spec: 0, minecraft: mc, libraries: [], processors: [], data: {}, installerFiles: { [forgeRel]: entry } },
    version,
    pending,
  }
}

async function publishedSha1(url) {
  const body = await fetchCapped(`${url}.sha1`, { maxBytes: 1024, label: `the checksum of ${url.split('/').pop()}` })
  const m = /^[0-9a-f]{40}\b/i.exec(body.toString('utf8').trim())
  if (!m) fail(`the checksum published for ${url.split('/').pop()} is not a sha1`)
  return m[0].toLowerCase()
}

// Each pending row's checksum, from its maven: it must be one the installer lists when it lists
// any. A maven with no checksum file is taken at the installer's word only when that names one.
export async function fillLegacyChecksums(version, pending, { sha1Impl = publishedSha1, who = 'Forge' } = {}) {
  for (const p of pending) {
    const row = version.libraries[p.index]
    let sum = null
    try {
      sum = await sha1Impl(p.url)
    } catch (err) {
      if (p.sums.length !== 1) fail(`Could not read the checksum of ${row.name} from ${p.url}: ${err.message}`, err.code ?? 'loader-unreachable')
      sum = p.sums[0]
    }
    if (p.sums.length && !p.sums.includes(sum)) fail(`${row.name} on ${new URL(p.url).host} is not the file the ${who} installer lists. Pick another ${who} build in Advanced.`, 'loader-installer-unknown')
    row.downloads.artifact.sha1 = sum
  }
  return version
}
