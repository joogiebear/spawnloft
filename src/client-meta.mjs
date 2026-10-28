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

// The natives classifier Mojang ships for this machine: natives-<os> is the x64 build, the
// other arches carry a suffix. null when Mojang names none for this arch.
export function nativesClassifier(os = currentOs()) {
  const base = `natives-${os.name === 'osx' ? 'macos' : os.name}`
  if (os.arch === 'x64') return base
  if (os.arch === 'arm64') return `${base}-arm64`
  if (os.arch === 'x86' && os.name === 'windows') return `${base}-x86`
  return null
}

function classifierOf(name) {
  const parts = name.split(':')
  return parts.length >= 4 ? parts[3].split('@')[0] : ''
}

// The suffixes that name an arch build of a natives jar, and the arch each one is. Anything
// else after natives-<os>- (or another OS altogether) is not an arch variant and is left to the
// rules, as before.
const ARCH_SUFFIXES = { '': 'x64', '-arm64': 'arm64', '-x86': 'x86' }
// natives-macos-patch (lwjgl-freetype since 1.21) holds only macos/x64 files: it is the Intel
// Mac's freetype, which has no plain natives-macos row, while Apple Silicon takes its freetype
// from natives-macos-arm64. So on macOS it counts as an x64 build.
const MACOS_ARCH_SUFFIXES = { ...ARCH_SUFFIXES, '-patch': 'x64' }

// For a natives-<os>[-arch] classifier of this machine's OS, whether it is this machine's arch;
// null when the classifier is not an arch build of this OS's natives.
function archMatch(classifier, os) {
  const base = `natives-${os.name === 'osx' ? 'macos' : os.name}`
  if (!classifier.startsWith(base)) return null
  const suffixes = os.name === 'osx' ? MACOS_ARCH_SUFFIXES : ARCH_SUFFIXES
  const suffix = classifier.slice(base.length)
  if (!Object.hasOwn(suffixes, suffix)) return null
  return suffixes[suffix] === os.arch && nativesClassifier(os) !== null
}

const OS_LABEL = { windows: 'Windows', osx: 'macOS', linux: 'Linux' }

// Why this machine cannot run the client, or null. Without a version only the machine is
// judged (Linux arm64 and other arches Mojang has never built for, refused before anything
// downloads); with one, a version whose natives rows have arch builds for this OS but not for
// this arch is refused too (Windows arm64 before 1.21), rather than starting without natives.
export function platformRefusal(version = null, os = currentOs()) {
  if (nativesClassifier(os) === null || (os.name === 'linux' && os.arch === 'arm64')) {
    return `the Minecraft client has no ${OS_LABEL[os.name] ?? os.name} ${os.arch} build; use bots on this machine`
  }
  if (!version) return null
  const matches = (version.libraries ?? [])
    .filter(lib => ruleAllows(lib.rules, { os }))
    .map(lib => archMatch(classifierOf(lib.name), os))
    .filter(m => m !== null)
  if (matches.length === 0 || matches.includes(true)) return null
  return `${version.id ?? 'this version'} ships no ${OS_LABEL[os.name] ?? os.name} ${os.arch} natives; use a newer Minecraft version on this machine`
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

    // Mojang's rules pick the OS but not the arch, so a Mac is offered both natives-macos and
    // natives-macos-arm64: only the one for this arch is taken, and the others are left out
    // altogether (neither extracted nor on the classpath).
    const classifier = classifierOf(lib.name)
    const arch = archMatch(classifier, os)
    if (arch === false) continue
    // Mojang names the macOS natives "natives-macos", not "natives-osx" as the rules do
    const nativeOs = os.name === 'osx' ? 'macos' : os.name
    if (arch === true || classifier.startsWith(`natives-${nativeOs}`)) {
      rows.push({ name: lib.name, path: p, url: u, sha1: s1, size: sz, native: { extract: { exclude: [] } } })
      continue
    }

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
  return rows
}

// Mojang's Log4Shell (CVE-2021-44228) mitigation. 1.7 through 1.18.0 ship a log4j that resolves
// ${jndi:...} in logged text, so a chat line or a server's MOTD can run code on this machine;
// the launcher is expected to pass `logging.client`: a log4j config without lookups, named by
// -Dlog4j.configurationFile. The file id becomes a file name under assets/log_configs, so it is
// held to one path segment.
export function loggingConfig(version) {
  const client = version.logging?.client
  if (!client) return null
  const id = version.id ?? 'this version'
  const bad = (what) => fail(`the logging config of ${id} ${what}; SpawnLoft cannot launch it safely`)
  if (client.type !== 'log4j2-xml') bad(`has the unknown type "${client.type}"`)
  if (typeof client.argument !== 'string' || !client.argument.includes('${path}')) bad('has no ${path} in its argument')
  const file = client.file
  if (!file || typeof file.id !== 'string' || !/^[\w.-]+$/.test(file.id) || /^\.+$/.test(file.id)) bad('names a file outside log_configs')
  if (typeof file.sha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(file.sha1)) bad('has no sha1 to check the file against')
  if (typeof file.url !== 'string' || !/^https:\/\//.test(file.url)) bad('has no https URL')
  return { id: file.id, url: file.url, sha1: file.sha1.toLowerCase(), size: Number.isInteger(file.size) ? file.size : null, argument: client.argument }
}

// Whether to pass -Dlog4j2.formatMsgNoLookups=true as well: log4j-core 2.0 to 2.15 resolve
// lookups in messages, and 2.10 and newer honour the property (older ones ignore it, and 2.16+
// have no lookups to turn off). A second guard beside the config file, as Mojang's launcher.
export function log4jNoLookupsNeeded(version) {
  for (const lib of version.libraries ?? []) {
    const parts = String(lib.name ?? '').split(':')
    if (parts[0] !== 'org.apache.logging.log4j' || parts[1] !== 'log4j-core') continue
    const m = /^(\d+)\.(\d+)/.exec(parts[2] ?? '')
    if (m && Number(m[1]) === 2 && Number(m[2]) < 16) return true
  }
  return false
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

// Where in the natives directory the game looks for its libraries: 26.x points java.library.path
// at ${natives_directory}/java (with jna, lwjgl and netty beside it), older versions at the
// directory itself. '' for the directory itself, or when the argument is missing or odd.
export function nativesLibrarySubdir(version, { os = currentOs() } = {}) {
  const prefix = '-Djava.library.path=${natives_directory}'
  const arg = jvmArguments(version, { os }).find(a => typeof a === 'string' && a.startsWith(prefix))
  if (!arg) return ''
  const rest = arg.slice(prefix.length)
  if (rest === '') return ''
  if (!/^[\\/][\w.-]+(?:[\\/][\w.-]+)*[\\/]?$/.test(rest)) return ''
  const parts = rest.split(/[\\/]/).filter(Boolean)
  if (parts.some(p => p === '.' || p === '..')) return ''
  return parts.join('/')
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
