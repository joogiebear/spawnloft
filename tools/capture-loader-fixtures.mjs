#!/usr/bin/env node
// Captures the mod loaders' real files into test/fixtures/client/loaders/, for the Forge, NeoForge
// and Quilt launcher work. Run by .github/workflows/loader-fixtures.yml, since the loaders' hosts
// cannot be reached from where the code is written; it runs anywhere with network access:
//
//   node tools/capture-loader-fixtures.mjs [--out <dir>]
//
// For each pinned installer it keeps install_profile.json and version.json as published (byte for
// byte), the jar's entry list (names and sizes, not the files), and the jar's sha1 beside the one
// the maven publishes. For each loader it keeps the version lists as published. Quilt profiles
// keep, per library, the .sha1 file the maven publishes beside it (Quilt's rows carry none).
// The per-version loader lists (Quilt's and Fabric's /versions/loader/<mc>) keep every row in
// the order served, with only each row's loader part (the rest of a row is a whole launcher
// profile); everything else is as published. manifest.json says what came from where. Nothing here is run: the jars are read as
// zip files and removed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const OUT = outArg !== -1 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'test', 'fixtures', 'client', 'loaders')

const FORGE_FILES = 'https://files.minecraftforge.net/net/minecraftforge/forge'
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
const NEOFORGE_LIST = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
const QUILT_META = 'https://meta.quiltmc.org/v3'
const FABRIC_META = 'https://meta.fabricmc.net/v2'

// The builds the design's Tests section names (chosen 2026-11-14 from the loaders' lists: Forge's
// recommended build per version, the newest NeoForge, the newest Quilt Loader that is not a
// beta). 1.12.2 has two: 14.23.0.2486 is the legacy installer format, 14.23.5.2864 the modern one.
const FORGE = [
  ['1.7.10', '10.13.4.1614', { legacy: true }],
  ['1.12.2', '14.23.0.2486', { legacy: true }],
  ['1.12.2', '14.23.5.2864'],
  ['1.16.5', '36.2.34'],
  ['1.18.2', '40.3.0'],
  ['1.20.1', '47.4.28'],
  ['1.21.1', '52.1.20'],
  ['26.3', '66.1.8'],
]
const NEOFORGE = ['20.4.253', '21.1.266', '26.3.0.103']
const QUILT = [['1.20.1', '0.30.2'], ['26.3', '0.30.2']]
const FABRIC_LOADER_LISTS = ['1.21.11', '26.3']

const manifest = { capturedAt: new Date().toISOString(), files: [] }
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

async function get(url, { optional = false } = {}) {
  if (!url.startsWith('https://')) throw new Error(`not https: ${url}`)
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: { 'user-agent': 'spawnloft-fixture-capture' }, redirect: 'follow', signal: AbortSignal.timeout(120000) })
    } catch (err) {
      if (attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue }
      throw new Error(`${url}: ${err.message}`)
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    if (optional && res.status === 404) return null
    if (attempt < 4 && res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue }
    throw new Error(`${url}: HTTP ${res.status}`)
  }
}

function save(rel, buf, url) {
  const file = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  manifest.files.push({ file: rel, url, sha1: sha1(buf), bytes: buf.length })
  console.log(`${rel} (${buf.length} bytes)`)
}

async function saveUrl(rel, url) {
  const buf = await get(url)
  save(rel, buf, url)
  return buf
}

// The published .sha1 beside a file: its first 40 hex characters, or null when there is none.
async function sidecar(url) {
  const buf = await get(`${url}.sha1`, { optional: true })
  if (!buf) return null
  const m = /^[0-9a-f]{40}/i.exec(buf.toString('utf8').trim())
  return m ? m[0].toLowerCase() : null
}

// A per-version loader list: every row in the order served, with only its loader part (see the top)
async function saveList(rel, url) {
  const list = JSON.parse((await get(url)).toString('utf8'))
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${url}: not a list, or an empty one`)
  if (!list.every((row) => typeof row?.loader?.version === 'string')) throw new Error(`${url}: a row without a loader version`)
  save(rel, Buffer.from(JSON.stringify(list.map((row) => ({ loader: row.loader })), null, 2) + '\n'), url)
}

// A jar's entries, read from its central directory (what the Node core's plugins.mjs did): name,
// method, sizes and where its local header is. Zip64 archives (0xffffffff sizes) are declined
// rather than misread: none of the pinned installers is one.
function zipEntries(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    const count = buf.readUInt16LE(i + 10)
    let at = buf.readUInt32LE(i + 16)
    if (at === 0xffffffff) return []
    const out = []
    for (let n = 0; n < count && at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50; n++) {
      const nameLen = buf.readUInt16LE(at + 28)
      out.push({
        name: buf.toString('utf8', at + 46, at + 46 + nameLen),
        method: buf.readUInt16LE(at + 10),
        compressed: buf.readUInt32LE(at + 20),
        size: buf.readUInt32LE(at + 24),
        localOffset: buf.readUInt32LE(at + 42),
      })
      at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
    }
    return out
  }
  return []
}

// Every entry's name and unpacked size, in the archive's order.
const zipEntryList = (buf) => zipEntries(buf).map((e) => ({ name: e.name, size: e.size }))

// One entry's bytes, or null when it is missing or cannot be read.
function readZipEntry(buf, wanted) {
  const entry = zipEntries(buf).find((e) => e.name === wanted)
  if (!entry || entry.compressed === 0xffffffff || entry.localOffset === 0xffffffff) return null
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) return null
  // the local header's extra field can differ in length from the central one
  const dataAt = entry.localOffset + 30 + buf.readUInt16LE(entry.localOffset + 26) + buf.readUInt16LE(entry.localOffset + 28)
  const data = buf.subarray(dataAt, Math.min(buf.length, dataAt + entry.compressed))
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) })
  return null
}

// legacy: the installer format with no version.json (Forge 1.12.2 builds before 2851 and older)
async function captureInstaller(dir, url, { legacy = false } = {}) {
  const jar = await get(url)
  const published = await sidecar(url)
  const actual = sha1(jar)
  if (published && published !== actual) throw new Error(`${url}: sha1 ${actual}, the maven publishes ${published}`)
  const entries = zipEntryList(jar)
  if (entries.length === 0) throw new Error(`${url}: no entries could be read out of the jar`)
  for (const name of ['install_profile.json', 'version.json']) {
    const data = readZipEntry(jar, name)
    if (data) save(`${dir}/${name}`, data, `${url}!/${name}`)
    else if (name === 'install_profile.json' || !legacy) throw new Error(`${url}: ${name} could not be read out of the jar`)
  }
  const info = { url, sha1: actual, publishedSha1: published, bytes: jar.length, entries }
  save(`${dir}/installer.json`, Buffer.from(JSON.stringify(info, null, 2) + '\n'), url)
}

// group:artifact:version[:classifier][@ext] to its path in a maven
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@')
  const [group, artifact, version, classifier] = coords.split(':')
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  // Forge
  const metaBuf = await saveUrl('forge/maven-metadata.json', `${FORGE_FILES}/maven-metadata.json`)
  await saveUrl('forge/promotions_slim.json', `${FORGE_FILES}/promotions_slim.json`)
  const forgeMeta = JSON.parse(metaBuf.toString('utf8'))
  for (const [mc, build, opts = {}] of FORGE) {
    // Forge's own version string: 1.7.10 builds carry the game version a second time
    const full = (forgeMeta[mc] ?? []).find((v) => v === `${mc}-${build}` || v.startsWith(`${mc}-${build}-`))
    if (!full) throw new Error(`Forge ${build} for ${mc} is not in maven-metadata.json`)
    await captureInstaller(`forge/${full}`, `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`, opts)
  }

  // NeoForge
  const neoList = JSON.parse((await saveUrl('neoforge/versions.json', NEOFORGE_LIST)).toString('utf8'))
  for (const v of NEOFORGE) {
    if (!neoList.versions?.includes(v)) throw new Error(`NeoForge ${v} is not in the versions list`)
    await captureInstaller(`neoforge/${v}`, `${NEOFORGE_MAVEN}/${v}/neoforge-${v}-installer.jar`)
  }

  // Quilt
  await saveUrl('quilt/game-versions.json', `${QUILT_META}/versions/game`)
  await saveUrl('quilt/loader-versions.json', `${QUILT_META}/versions/loader`)
  for (const [mc, loader] of QUILT) {
    await saveList(`quilt/loader-${mc}.json`, `${QUILT_META}/versions/loader/${encodeURIComponent(mc)}`)
    const profileUrl = `${QUILT_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`
    const profile = JSON.parse((await saveUrl(`quilt/profile-${mc}-${loader}.json`, profileUrl)).toString('utf8'))
    const sums = {}
    for (const lib of profile.libraries ?? []) {
      const base = lib.url ?? 'https://libraries.minecraft.net/'
      const url = `${base.endsWith('/') ? base : `${base}/`}${mavenPath(lib.name)}`
      sums[lib.name] = { url, sha1: await sidecar(url) }
    }
    save(`quilt/sidecars-${mc}-${loader}.json`, Buffer.from(JSON.stringify(sums, null, 2) + '\n'), profileUrl)
  }

  // Fabric, for comparison with the synthetic lists the existing tests use
  await saveUrl('fabric/game-versions.json', `${FABRIC_META}/versions/game`)
  for (const mc of FABRIC_LOADER_LISTS) {
    await saveList(`fabric/loader-${mc}.json`, `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`)
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${manifest.files.length} files in ${OUT}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
