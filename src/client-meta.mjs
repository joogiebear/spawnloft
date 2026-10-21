import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { fetchJson, downloadFile } from './download.mjs'
import { versionJson, versionDir } from './client-paths.mjs'
import { fail } from './util.mjs'

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const RESOURCES_URL = 'https://resources.download.minecraft.net'

export function currentOs() {
  const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch = process.arch === 'ia32' ? 'x86' : process.arch
  return { name, arch, version: os.release() }
}

export function ruleAllows(rules, { os = currentOs(), features = {} } = {}) {
  if (!rules || rules.length === 0) return true
  let result = false
  for (const rule of rules) {
    let matches = true
    if (rule.os) {
      if (rule.os.name && rule.os.name !== os.name) matches = false
      if (rule.os.arch && rule.os.arch !== os.arch) matches = false
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.version)) matches = false
        } catch {
          matches = false
        }
      }
    }
    if (matches && rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if ((features[key] ?? false) !== expected) {
          matches = false
          break
        }
      }
    }
    if (matches) result = rule.action === 'allow'
  }
  return result
}

export function mergeInherited(child, parent) {
  const result = {}
  for (const key of Object.keys(parent)) {
    if (key !== 'libraries' && key !== 'arguments' && key !== 'minecraftArguments' && key !== 'mainClass') {
      result[key] = parent[key]
    }
  }
  for (const key of Object.keys(child)) {
    if (key !== 'libraries' && key !== 'arguments' && key !== 'mainClass' && key !== 'inheritsFrom') {
      result[key] = child[key]
    }
  }
  delete result.inheritsFrom
  result.mainClass = child.mainClass
  result.libraries = [...(child.libraries ?? []), ...(parent.libraries ?? [])]

  if (parent.arguments || child.arguments) {
    const parentGame = parent.arguments?.game ?? (parent.minecraftArguments ? parent.minecraftArguments.split(' ') : [])
    const parentJvm = parent.arguments?.jvm ?? []
    const childGame = child.arguments?.game ?? []
    const childJvm = child.arguments?.jvm ?? []
    result.arguments = { game: [...parentGame, ...childGame], jvm: [...parentJvm, ...childJvm] }
  }
  if (parent.minecraftArguments !== undefined) {
    result.minecraftArguments = parent.minecraftArguments
  }
  return result
}

export function libraryPath(name) {
  const parts = name.split(':')
  const group = parts[0].replace(/\./g, '/')
  const artifact = parts[1]
  let version = parts[2]
  let classifier = parts[3] ?? ''
  let ext = 'jar'

  const atIdx = version.indexOf('@')
  if (atIdx !== -1) {
    ext = version.slice(atIdx + 1)
    version = version.slice(0, atIdx)
  }
  if (classifier) {
    const cAt = classifier.indexOf('@')
    if (cAt !== -1) {
      ext = classifier.slice(cAt + 1)
      classifier = classifier.slice(0, cAt)
    }
  }
  const cls = classifier ? `-${classifier}` : ''
  return `${group}/${artifact}/${version}/${artifact}-${version}${cls}.${ext}`
}

export function libraries(version, { os = currentOs() } = {}) {
  const rows = []
  for (const lib of version.libraries ?? []) {
    if (!ruleAllows(lib.rules, { os })) continue

    const dl = lib.downloads
    const p = dl?.artifact?.path ?? libraryPath(lib.name)
    const u = dl?.artifact?.url ?? (lib.url ?? 'https://libraries.minecraft.net/') + p
    const s1 = dl?.artifact?.sha1 ?? lib.sha1 ?? null
    const sz = dl?.artifact?.size ?? lib.size ?? null

    // Mojang names the macOS natives "natives-macos", not "natives-osx" as the rules do
    const lastSeg = lib.name.split(':').pop()
    const nativeOs = os.name === 'osx' ? 'macos' : os.name
    const isModernNative = lastSeg.startsWith('natives-') && lastSeg.slice(8).startsWith(nativeOs)

    if (isModernNative) {
      rows.push({ name: lib.name, path: p, url: u, sha1: s1, size: sz, native: { extract: { exclude: [] } } })
    } else {
      rows.push({ name: lib.name, path: p, url: u, sha1: s1, size: sz, native: false })

      const nativesKey = lib.natives?.[os.name]
      if (nativesKey) {
        const archNum = os.arch === 'x86' ? '32' : '64'
        const resolved = nativesKey.replace('${arch}', archNum)
        const clsDl = dl?.classifiers?.[resolved]
        if (clsDl) {
          rows.push({
            name: `${lib.name}:${resolved}`,
            path: clsDl.path ?? libraryPath(`${lib.name}:${resolved}`),
            url: clsDl.url ?? (lib.url ?? 'https://libraries.minecraft.net/') + (clsDl.path ?? libraryPath(`${lib.name}:${resolved}`)),
            sha1: clsDl.sha1 ?? null,
            size: clsDl.size ?? null,
            native: { extract: { exclude: lib.extract?.exclude ?? [] } },
          })
        }
      }
    }
  }
  return rows
}

export function assetIndex(version) {
  const ai = version.assetIndex
  return { id: ai.id, url: ai.url, sha1: ai.sha1, size: ai.size, totalSize: ai.totalSize }
}

export function assetObjects(index) {
  const rows = []
  for (const [_path, entry] of Object.entries(index.objects ?? {})) {
    rows.push({
      hash: entry.hash,
      size: entry.size,
      path: `objects/${entry.hash.slice(0, 2)}/${entry.hash}`,
      url: `${RESOURCES_URL}/${entry.hash.slice(0, 2)}/${entry.hash}`,
    })
  }
  return rows
}

export function gameArguments(version, { os = currentOs(), features = {} } = {}) {
  if (version.arguments) return flattenArgs(version.arguments.game, { os, features })
  if (version.minecraftArguments) return version.minecraftArguments.split(' ')
  return []
}

export function jvmArguments(version, { os = currentOs(), features = {} } = {}) {
  if (version.arguments) return flattenArgs(version.arguments.jvm, { os, features })
  // Before 1.13 the JSON carried no JVM arguments; the launcher supplied these two itself.
  return ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}']
}

function flattenArgs(args, ctx) {
  const out = []
  for (const arg of args ?? []) {
    if (typeof arg === 'string') {
      out.push(arg)
    } else if (arg && typeof arg === 'object') {
      if (ruleAllows(arg.rules, ctx)) {
        if (typeof arg.value === 'string') out.push(arg.value)
        else if (Array.isArray(arg.value)) out.push(...arg.value)
      }
    }
  }
  return out
}

export async function fetchManifest({ cacheDir, maxAgeMs = 3600000, fetchImpl = fetchJson }) {
  const manifestPath = path.join(cacheDir, 'version_manifest_v2.json')
  const fetchedAtPath = `${manifestPath}.fetched-at`

  try {
    const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const fetchedAt = Number(fs.readFileSync(fetchedAtPath, 'utf8'))
    if (!Number.isNaN(fetchedAt) && Date.now() - fetchedAt < maxAgeMs) return cached
  } catch (err) {
    // A missing or corrupt cache file both mean "no usable cache yet".
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
  }

  try {
    const manifest = await fetchImpl(MANIFEST_URL, { label: 'the Minecraft version list' })
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    fs.writeFileSync(fetchedAtPath, String(Date.now()))
    return manifest
  } catch (err) {
    // A stale cache is better than no manifest at all.
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (innerErr) {
      if (innerErr.code !== 'ENOENT' && !(innerErr instanceof SyntaxError)) throw innerErr
      throw err
    }
  }
}

export async function fetchVersionJson(id, { manifest, cacheDir, fetchImpl = downloadFile }) {
  const entry = manifest.versions.find(v => v.id === id)
  if (!entry) fail(`unknown Minecraft version "${id}"`)

  const dest = versionJson(id)
  try {
    const existing = fs.readFileSync(dest)
    const hash = crypto.createHash('sha1').update(existing).digest('hex')
    if (hash === entry.sha1) return JSON.parse(existing.toString())
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  fs.mkdirSync(versionDir(id), { recursive: true })
  await fetchImpl(entry.url, dest, { hash: 'sha1', expected: entry.sha1, label: `the version JSON for ${id}` })
  return JSON.parse(fs.readFileSync(dest, 'utf8'))
}
