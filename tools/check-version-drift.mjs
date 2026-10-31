// The weekly check that Mojang's formats still fit this SpawnLoft (all-versions plan, step V4).
// Fetches the version list, the newest release and snapshot, Fabric's profile for that release,
// their asset indexes and Mojang's Java runtime list, runs the launcher's own resolver on them for
// every OS and arch it knows, and fails on anything a launch would refuse or a SpawnLoft release
// would be needed for. The facts that change only with Mojang (log config ids, natives
// classifiers, runtime platforms) are compared with tools/version-drift-baseline.json. It also
// checks the signed harness list as the mod repo publishes it: the list verifies with the keys this
// SpawnLoft trusts, and every jar it and HARNESS_RELEASES name still downloads with its sha256, so a
// deleted or replaced release shows up here before a user's launch finds it.
//
//   node tools/check-version-drift.mjs [--report <file.md>] [--update-baseline]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchJson, fetchCapped } from '../src/download.mjs'
import { MANIFEST_URL, mergeInherited, assetLayout } from '../src/client-meta.mjs'
import { resolveVersion, launchFeatures, versionKind } from '../src/client-version.mjs'
import { META_URL, pickLoader } from '../src/client-fabric.mjs'
import { RUNTIME_INDEX_URL, platformKey } from '../src/client-java.mjs'
import { HARNESS_INDEX_KEYS, HARNESS_INDEX_MIN_SERIAL, HARNESS_INDEX_URL, HARNESS_INDEX_SIG_URL, MAX_INDEX_BYTES, MAX_SIG_BYTES, harnessJarUrl, parseHarnessIndex } from '../src/client-harness-index.mjs'
import { HARNESS_RELEASES } from '../src/client-harness.mjs'

export const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'version-drift-baseline.json')

// Every machine the resolver is asked about, os.version as os.release() answers there.
export const OS_PAIRS = [
  { name: 'windows', arch: 'x64', version: '10.0.22631' },
  { name: 'windows', arch: 'arm64', version: '10.0.22631' },
  { name: 'windows', arch: 'x86', version: '10.0.19045' },
  { name: 'osx', arch: 'arm64', version: '24.1.0' },
  { name: 'osx', arch: 'x64', version: '24.1.0' },
  { name: 'linux', arch: 'x64', version: '6.8.0-45-generic' },
  { name: 'linux', arch: 'arm64', version: '6.8.0-45-generic' },
]

// Where a newest version that cannot launch is drift. Mojang ships nothing for Linux arm64, has
// dropped Windows x86, and Intel Macs are not a target, so a refusal there is only noted.
const MUST_LAUNCH = new Set(['windows-x64', 'windows-arm64', 'osx-arm64', 'linux-x64'])

// The picker's kinds come from these manifest types (versionKind)
const KNOWN_TYPES = ['release', 'snapshot', 'old_beta', 'old_alpha']

// The extra feature flags, so a variable gated behind one still shows
const ALL_FEATURES = { ...launchFeatures(), has_custom_resolution: true, is_quick_play_singleplayer: true, is_quick_play_multiplayer: true, is_quick_play_realms: true }

// natives-<os>[suffix] the launcher can place (client-meta's archMatch)
const OS_PARTS = ['windows', 'macos', 'osx', 'linux']
const SUFFIXES = ['', '-arm64', '-x86', '-patch']

function nativesClassifiers(version) {
  const found = new Set()
  for (const lib of version.libraries ?? []) {
    const parts = String(lib.name ?? '').split(':')
    if (parts[3]?.startsWith('natives-')) found.add(parts[3].split('@')[0])
    for (const key of Object.keys(lib.downloads?.classifiers ?? {})) if (key.startsWith('natives-')) found.add(key)
    for (const value of Object.values(lib.natives ?? {})) found.add(String(value).replace('${arch}', '64'))
  }
  return [...found].sort()
}

function placeable(classifier) {
  const m = /^natives-([a-z]+)(.*)$/.exec(classifier)
  return !!m && OS_PARTS.includes(m[1]) && SUFFIXES.includes(m[2])
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// Everything the check found: { rows, failures, notes, facts }. `get(url, label)` fetches JSON;
// a baseline of null skips the comparisons (it is being written).
export async function checkDrift({ get = (url, label) => fetchJson(url, { label }), baseline = null } = {}) {
  const failures = []
  const notes = []
  const rows = []
  const fact = (label, fn) => fn().catch((err) => { failures.push(`${label}: ${err.message}`); return null })

  const manifest = await fact('the version list', () => get(MANIFEST_URL, 'the version list'))
  if (!manifest) return { rows, failures, notes, facts: null }
  const unknownTypes = [...new Set(manifest.versions.map((v) => v.type))].filter((t) => !KNOWN_TYPES.includes(t))
  if (unknownTypes.length) failures.push(`the version list has types the picker does not know: ${unknownTypes.join(', ')}`)

  const newest = [manifest.latest.release, manifest.latest.snapshot].filter((id, i, all) => id && all.indexOf(id) === i)
  const versions = []
  for (const id of newest) {
    const entry = manifest.versions.find((v) => v.id === id)
    if (!entry) { failures.push(`the version list names ${id} as latest but does not list it`); continue }
    const json = await fact(id, () => get(entry.url, `the ${id} JSON`))
    if (json) versions.push({ label: `${id} (${versionKind(entry)})`, json })
  }

  // Fabric for the newest release: a release Fabric has not caught up with yet is only a note
  const release = versions.find((v) => v.json.id === manifest.latest.release)
  if (release) {
    try {
      const loaders = await get(`${META_URL}/versions/loader/${encodeURIComponent(release.json.id)}`, 'Fabric loaders')
      if (!Array.isArray(loaders) || loaders.length === 0) {
        notes.push(`Fabric has no loader for ${release.json.id} yet`)
      } else {
        const loader = pickLoader(loaders.map((e) => ({ version: e.loader.version, stable: e.loader.stable === true }))).version
        const profile = await get(`${META_URL}/versions/loader/${encodeURIComponent(release.json.id)}/${encodeURIComponent(loader)}/profile/json`, 'the Fabric profile')
        versions.push({ label: `${release.json.id} + Fabric ${loader}`, json: mergeInherited(profile, release.json) })
      }
    } catch (err) {
      notes.push(`Fabric for ${release.json.id} could not be read: ${err.message}`)
    }
  }

  for (const { label, json } of versions) {
    // one line per problem, naming the machines it shows on
    const seen = new Map()
    for (const os of OS_PAIRS) {
      const pair = `${os.name}-${os.arch}`
      for (const [features, flags] of [['default', launchFeatures()], ['all flags', ALL_FEATURES]]) {
        const resolved = resolveVersion(json, { os, features: flags, hostCaps: { x64: true } })
        const codes = resolved.problems.map((p) => p.code)
        rows.push({ version: label, pair, features, result: codes.length ? codes.join(', ') : 'ok' })
        for (const p of resolved.problems) {
          if (p.code === 'no-natives-for-this-machine' && !MUST_LAUNCH.has(pair)) continue
          if (!seen.has(p.message)) seen.set(p.message, new Set())
          seen.get(p.message).add(features === 'default' ? pair : `${pair} (all flags)`)
        }
      }
    }
    for (const [message, where] of seen) failures.push(`${label}: ${message} (on ${[...where].join(', ')})`)
    const unplaced = nativesClassifiers(json).filter((c) => !placeable(c))
    if (unplaced.length) failures.push(`${label} has natives classifiers SpawnLoft cannot place: ${unplaced.join(', ')}`)
  }

  // asset indexes: a new layout needs a release
  for (const { label, json } of versions.filter((v) => !v.label.includes('Fabric'))) {
    if (!json.assetIndex?.url) { failures.push(`${label} names no asset index`); continue }
    const index = await fact(`${label}'s asset index`, () => get(json.assetIndex.url, `asset index ${json.assetIndex.id}`))
    if (index && assetLayout(index) === null) failures.push(`${label}'s asset index ${json.assetIndex.id} is laid out in a way SpawnLoft does not know (keys: ${Object.keys(index).join(', ')})`)
  }

  // Mojang's Java runtimes: the URL still answers, and every newest component is there for the
  // machines SpawnLoft supports
  const all = await fact("Mojang's Java runtime list", () => get(RUNTIME_INDEX_URL, "Mojang's Java runtime list"))
  if (all) {
    for (const { label, json } of versions.filter((v) => !v.label.includes('Fabric'))) {
      const component = json.javaVersion?.component
      if (!component) continue
      for (const pair of MUST_LAUNCH) {
        const [name, arch] = pair.split('-')
        const platform = platformKey(name, arch)
        if (!all[platform]?.[component]?.length) failures.push(`Mojang's Java runtime list has no ${component} (for ${label}) on ${platform}`)
      }
    }
  }

  const facts = {
    loggingIds: [...new Set(versions.map((v) => v.json.logging?.client?.file?.id).filter(Boolean))].sort(),
    nativesClassifiers: [...new Set(versions.flatMap((v) => nativesClassifiers(v.json)))].sort(),
    runtimePlatforms: all ? Object.keys(all).sort() : null,
  }
  if (baseline) {
    for (const [key, what] of [['loggingIds', 'log4j config ids'], ['nativesClassifiers', 'natives classifiers'], ['runtimePlatforms', 'Java runtime platforms']]) {
      if (facts[key] && !sameSet(facts[key], baseline[key] ?? [])) {
        failures.push(`the ${what} changed: was ${(baseline[key] ?? []).join(', ') || 'none'}, now ${facts[key].join(', ') || 'none'} (check the launcher handles them, then run with --update-baseline)`)
      }
    }
  }
  return { rows, failures, notes, facts }
}

// The published harness list and every jar it or the built-in rows name: { failures, notes }.
// `getBytes(url, label, maxBytes)` fetches a Buffer.
export async function checkHarnessList({
  getBytes = (url, label, maxBytes) => fetchCapped(url, { maxBytes, timeoutMs: 60000, label }),
  keys = HARNESS_INDEX_KEYS,
  minSerial = HARNESS_INDEX_MIN_SERIAL,
  builtIn = HARNESS_RELEASES,
} = {}) {
  const failures = []
  const notes = []
  let listed = []
  try {
    const bytes = await getBytes(HARNESS_INDEX_URL, 'the harness list', MAX_INDEX_BYTES)
    const sig = await getBytes(HARNESS_INDEX_SIG_URL, "the harness list's signature", MAX_SIG_BYTES)
    const index = parseHarnessIndex(bytes, sig.toString('utf8'), { keys, minSerial })
    listed = index.rows
    notes.push(`harness list: serial ${index.serial}, signed with the ${index.key} key, ${index.rows.length} row(s)`)
    if (index.revoke.length) notes.push(`the harness list revokes ${index.revoke.length} key(s)`)
  } catch (err) {
    failures.push(`the signed harness list: ${err.message}`)
  }

  // harnessFor takes a built-in row over a listed one, so a listed row that disagrees is never used
  for (const row of listed) {
    for (const id of row.minecraft) {
      const own = builtIn.find((r) => r.minecraft.includes(id))
      if (own && (own.version !== row.version || own.tag !== row.tag || own.file !== row.file || own.sha256 !== row.sha256)) {
        failures.push(`the harness list's row for Minecraft ${id} (${row.tag}) differs from the one built into SpawnLoft (${own.tag}); the built-in one wins`)
      }
    }
  }

  const rows = [...builtIn, ...listed]
  const jars = rows.filter((r, i) => rows.findIndex((o) => harnessJarUrl(o) === harnessJarUrl(r) && o.sha256 === r.sha256) === i)
  for (const row of jars) {
    const label = `harness ${row.file} (for ${row.minecraft.join(', ')})`
    try {
      const jar = await getBytes(harnessJarUrl(row), label, 32 * 1024 * 1024)
      const hash = crypto.createHash('sha256').update(jar).digest('hex')
      if (hash !== row.sha256) failures.push(`${label} has sha256 ${hash}, not the ${row.sha256} it is listed with`)
    } catch (err) {
      failures.push(err.message)
    }
  }
  return { failures, notes }
}

export function report({ rows, failures, notes }) {
  const lines = [failures.length ? `**${failures.length} problem(s)**` : '**No drift.**', '']
  for (const f of failures) lines.push(`- ${f}`)
  for (const n of notes) lines.push(`- note: ${n}`)
  lines.push('', '| version | machine | features | result |', '|---|---|---|---|')
  for (const r of rows) lines.push(`| ${r.version} | ${r.pair} | ${r.features} | ${r.result} |`)
  return lines.join('\n') + '\n'
}

async function main(argv) {
  const at = argv.indexOf('--report')
  const reportFile = at === -1 ? null : argv[at + 1]
  const updating = argv.includes('--update-baseline')
  const baseline = updating ? null : JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  const result = await checkDrift({ baseline })
  const harness = await checkHarnessList()
  result.failures.push(...harness.failures)
  result.notes.push(...harness.notes)
  const text = report(result)
  process.stdout.write(text)
  if (reportFile) fs.writeFileSync(reportFile, text)
  if (updating && result.facts) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(result.facts, null, 2) + '\n')
    process.stdout.write(`wrote ${BASELINE_FILE}\n`)
  }
  return result.failures.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
