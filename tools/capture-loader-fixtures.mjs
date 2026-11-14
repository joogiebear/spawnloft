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
// The per-version loader lists (Quilt's and Fabric's /versions/loader/<mc>) are cut to their
// newest LIST_KEEP rows, since each row carries a whole launcher profile; everything else is as
// published. manifest.json says what came from where. Nothing here is run: the jars are read as
// zip files and removed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readZipEntry, zipEntryList } from '../src/plugins.mjs'

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
const LIST_KEEP = 25

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

// A per-version loader list, cut to its newest rows (see the top)
async function saveList(rel, url) {
  const list = JSON.parse((await get(url)).toString('utf8'))
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${url}: not a list, or an empty one`)
  save(rel, Buffer.from(JSON.stringify(list.slice(0, LIST_KEEP), null, 2) + '\n'), url)
}

// legacy: the installer format with no version.json (Forge 1.12.2 builds before 2851 and older)
async function captureInstaller(dir, url, { legacy = false } = {}) {
  const jar = await get(url)
  const published = await sidecar(url)
  const actual = sha1(jar)
  if (published && published !== actual) throw new Error(`${url}: sha1 ${actual}, the maven publishes ${published}`)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-installer-')), 'installer.jar')
  fs.writeFileSync(tmp, jar)
  try {
    const entries = zipEntryList(tmp)
    if (entries.length === 0) throw new Error(`${url}: no entries could be read out of the jar`)
    for (const name of ['install_profile.json', 'version.json']) {
      const data = readZipEntry(tmp, name)
      if (data) save(`${dir}/${name}`, data, `${url}!/${name}`)
      else if (name === 'install_profile.json' || !legacy) throw new Error(`${url}: ${name} could not be read out of the jar`)
    }
    const info = { url, sha1: actual, publishedSha1: published, bytes: jar.length, entries }
    save(`${dir}/installer.json`, Buffer.from(JSON.stringify(info, null, 2) + '\n'), url)
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
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
