import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { fetchJson, downloadFile } from './download.mjs'
import { versionJson, versionDir } from './client-paths.mjs'
import { fail, safeRelativePath } from './util.mjs'

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const RESOURCES_URL = 'https://resources.download.minecraft.net'

export function currentOs() {
  const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch = process.arch === 'ia32' ? 'x86' : process.arch
  return { name, arch, version: os.release() }
}

// The rule grammar Mojang's JSONs use. A rule with anything else in it is not understood: it never
// matches (so it cannot switch on a row meant for another machine), and ruleProblems reports it.
const RULE_KEYS = ['action', 'os', 'features']
const OS_RULE_KEYS = ['name', 'arch', 'version', 'versionRange']

// Dotted numbers compared numerically, as far as both have them: Windows' 10.0.22631, or the
// 6.8.0 of Linux's 6.8.0-45-generic.
function compareDotted(a, b) {
  const nums = (v) => (/^\d+(?:\.\d+)*/.exec(String(v))?.[0] ?? '').split('.').filter(Boolean).map(Number)
  const x = nums(a)
  const y = nums(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

const DOTTED = /^\d+(?:\.\d+)*$/

// Why SpawnLoft cannot judge this rule, or null when it can.
function ruleProblem(rule) {
  if (!rule || typeof rule !== 'object') return 'a rule that is not an object'
  const extra = Object.keys(rule).find((k) => !RULE_KEYS.includes(k))
  if (extra) return `"${extra}"`
  if (rule.action !== 'allow' && rule.action !== 'disallow') return '"action"'
  if (rule.os !== undefined) {
    if (!rule.os || typeof rule.os !== 'object') return '"os"'
    const extraOs = Object.keys(rule.os).find((k) => !OS_RULE_KEYS.includes(k))
    if (extraOs) return `"os.${extraOs}"`
    const range = rule.os.versionRange
    if (range !== undefined) {
      // os.release() on macOS is the Darwin kernel version, not the macOS one a range would name
      if (rule.os.name === 'osx') return '"os.versionRange" on macOS'
      if (!range || typeof range !== 'object' || Object.keys(range).some((k) => k !== 'min' && k !== 'max')
        || [range.min, range.max].some((v) => v !== undefined && !DOTTED.test(String(v)))) return '"os.versionRange"'
    }
  }
  if (rule.features !== undefined && (!rule.features || typeof rule.features !== 'object' || Array.isArray(rule.features))) return '"features"'
  return null
}

// A range for every OS is judged against the Darwin version on a Mac, as an osx one would be, so
// on a Mac it is read as one (review N-1).
function asOnHost(rule, os) {
  return rule?.os && rule.os.name === undefined && rule.os.versionRange !== undefined && os.name === 'osx'
    ? { ...rule, os: { ...rule.os, name: 'osx' } }
    : rule
}

export function ruleAllows(rules, { os = currentOs(), features = {} } = {}) {
  if (!rules || rules.length === 0) return true
  let result = false
  for (const rule of rules) {
    if (ruleProblem(asOnHost(rule, os)) !== null) continue
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
      const range = rule.os.versionRange
      if (range) {
        if (range.min !== undefined && compareDotted(os.version, range.min) < 0) matches = false
        // max is exclusive: only then do Mojang's own pair (ZGC from 10.0.17134 on, the G1 flags
        // below it) split the Windows builds between them instead of both matching 10.0.17134
        if (range.max !== undefined && compareDotted(os.version, range.max) >= 0) matches = false
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

// What in these rules SpawnLoft does not understand, for the rules that concern this OS (a rule
// for another OS name cannot change what this machine runs).
export function ruleProblems(rules, { os = currentOs() } = {}) {
  const found = []
  for (const rule of rules ?? []) {
    const name = rule?.os?.name
    if (name !== undefined && name !== os.name) continue
    const problem = ruleProblem(asOnHost(rule, os))
    if (problem !== null && !found.includes(problem)) found.push(problem)
  }
  return found
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
  // A loader profile with an empty logging block (Forge's and NeoForge's carry one) must not
  // drop the parent's Log4Shell config (see loggingConfig)
  if (!result.logging?.client && parent.logging?.client) result.logging = parent.logging
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

function machineRefusal(os) {
  if (nativesClassifier(os) === null || (os.name === 'linux' && os.arch === 'arm64')) {
    return `the Minecraft client has no ${OS_LABEL[os.name] ?? os.name} ${os.arch} build; use bots on this machine`
  }
  return null
}

// The arches a version ships natives for on this OS. The classifier form (1.19 on) names each
// arch; the older map form (natives.<os>, LWJGL 2 to 3.2) only ever had x64 and x86 builds. Empty
// when no natives row names an arch at all.
export function nativeArches(version, os = currentOs()) {
  const arches = new Set()
  for (const arch of ['x64', 'arm64', 'x86']) {
    const asArch = { ...os, arch }
    for (const lib of version.libraries ?? []) {
      if (!ruleAllows(lib.rules, { os: asArch })) continue
      if (archMatch(classifierOf(lib.name), asArch) === true) arches.add(arch)
      if (lib.natives?.[os.name] && arch !== 'arm64') arches.add(arch)
    }
  }
  return arches
}

// The arch this version runs as on this machine: its own, or x64 under emulation when the
// version has no arm64 natives (everything before 1.19) and the machine can run x64 code
// (Rosetta on Apple Silicon, Windows 11 on arm64). hostCaps.x64 says whether it can; null when
// that is not known, which judges as before emulation existed.
export function archDecision(version = null, os = currentOs(), hostCaps = null) {
  const refused = machineRefusal(os)
  if (refused) return { refusal: refused, arch: os.arch, emulated: false }
  const native = { refusal: null, arch: os.arch, emulated: false }
  if (!version) return native
  const arches = nativeArches(version, os)
  if (arches.size === 0 || arches.has(os.arch)) return native
  const id = version.id ?? 'this version'
  if (os.arch === 'arm64' && arches.has('x64') && hostCaps !== null) {
    if (hostCaps.x64) return { refusal: null, arch: 'x64', emulated: true }
    if (os.name === 'osx') {
      return { ...native, refusal: `Minecraft ${id} has no Apple Silicon build; install Rosetta to run it: softwareupdate --install-rosetta --agree-to-license` }
    }
    if (os.name === 'windows') {
      const build = String(os.version).split('.')[2] ?? '?'
      return { ...native, refusal: `Minecraft ${id} has no Windows arm64 build, and Windows 10 arm64 (build ${build}) cannot run the x64 one; Windows 11 can` }
    }
  }
  return { ...native, refusal: `${id} ships no ${OS_LABEL[os.name] ?? os.name} ${os.arch} natives; use a newer Minecraft version on this machine` }
}

// Why this machine cannot run the client, or null. Without a version only the machine is
// judged (Linux arm64 and other arches Mojang has never built for, refused before anything
// downloads); with one, a version with no natives for this arch is refused too, unless hostCaps
// says the machine runs it as x64 (archDecision).
export function platformRefusal(version = null, os = currentOs(), hostCaps = null) {
  return archDecision(version, os, hostCaps).refusal
}

// A library's path is joined under libraries/, and the Fabric profile it may come from is not
// hash-pinned: a path that would leave that folder is refused (review N-7).
function libraryRelPath(name, p) {
  const safe = safeRelativePath(p)
  if (safe === null) fail(`library ${String(name).slice(0, 80)} names the path "${String(p).slice(0, 80)}", which leaves the libraries folder`)
  return safe
}

export function libraries(version, { os = currentOs() } = {}) {
  const rows = []
  for (const lib of version.libraries ?? []) {
    if (!ruleAllows(lib.rules, { os })) continue

    const dl = lib.downloads
    const p = libraryRelPath(lib.name, dl?.artifact?.path ?? libraryPath(lib.name))
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

    // Before 1.13 the natives rows (lwjgl-platform, jinput-platform, twitch-platform) carry
    // classifiers only: there is no plain jar of them to put on the classpath, and the URL
    // libraryPath would make up for one is a 404.
    if (!dl || dl.artifact) rows.push({ name: lib.name, path: p, url: u, sha1: s1, size: sz, native: false })

    const nativesKey = lib.natives?.[os.name]
    if (nativesKey) {
      const archNum = os.arch === 'x86' ? '32' : '64'
      const resolved = nativesKey.replace('${arch}', archNum)
      const clsDl = dl?.classifiers?.[resolved]
      if (clsDl) {
        const clsPath = libraryRelPath(lib.name, clsDl.path ?? libraryPath(`${lib.name}:${resolved}`))
        rows.push({
          name: `${lib.name}:${resolved}`,
          path: clsPath,
          url: clsDl.url ?? (lib.url ?? 'https://libraries.minecraft.net/') + clsPath,
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
  // Mojang has only ever shipped this one argument; anything else would name a property log4j
  // never reads, and the game would start reported as mitigated.
  if (client.argument !== '-Dlog4j.configurationFile=${path}') bad(`has the unknown argument "${client.argument}"`)
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

// How an asset index wants its files laid out: 'objects' (1.7.3 on: the game reads the hashed
// store itself), 'virtual' (1.6.1 to 1.7.2: a tree under real names in assets/virtual/<index>),
// 'resources' (before 1.6: a tree in the profile's resources/), or null for an index with a key
// SpawnLoft does not know, whose files it cannot know where to put.
const ASSET_INDEX_KEYS = ['objects', 'virtual', 'map_to_resources']
export function assetLayout(index) {
  if (!index || typeof index !== 'object' || !index.objects || typeof index.objects !== 'object') return null
  if (Object.keys(index).some((k) => !ASSET_INDEX_KEYS.includes(k))) return null
  if (index.map_to_resources === true) return 'resources'
  if (index.virtual === true) return 'virtual'
  return 'objects'
}

export function assetObjects(index) {
  const rows = []
  for (const [name, entry] of Object.entries(index.objects ?? {})) {
    // the hash becomes a path under assets/objects
    if (!/^[0-9a-f]{40}$/.test(String(entry?.hash))) fail(`the asset index names "${String(name).slice(0, 60)}" with a malformed hash`)
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

// The other folders the JVM arguments name under the natives directory (26.2 on: jna, lwjgl and
// netty beside java). They are made, empty, with the natives, so nothing starts without them.
export function nativesExtraDirs(version, { os = currentOs() } = {}) {
  const lib = nativesLibrarySubdir(version, { os })
  const dirs = []
  for (const arg of jvmArguments(version, { os })) {
    const m = typeof arg === 'string' && /^-D[\w.]+=\$\{natives_directory\}((?:[\\/][\w.-]+)+)[\\/]?$/.exec(arg)
    if (!m) continue
    const parts = m[1].split(/[\\/]/).filter(Boolean)
    if (parts.some((p) => p === '.' || p === '..')) continue
    const dir = parts.join('/')
    if (dir !== lib && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
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

// A small JSON list kept in the cache folder with the time it was fetched: used while younger
// than maxAgeMs, fetched again after; a failed fetch falls back to the stale copy, since a stale
// list is better than none. force fetches now, unless the copy is younger than minAgeMs (so a
// stream of mistyped ids asks the server once a minute at most).
export async function cachedJson(file, url, { cacheDir, label, maxAgeMs = 3600000, minAgeMs = 60000, force = false, fetchImpl = fetchJson }) {
  const dest = path.join(cacheDir, file)
  const fetchedAtPath = `${dest}.fetched-at`

  try {
    const cached = JSON.parse(fs.readFileSync(dest, 'utf8'))
    const fetchedAt = Number(fs.readFileSync(fetchedAtPath, 'utf8'))
    const age = Date.now() - fetchedAt
    if (!Number.isNaN(fetchedAt) && age < (force ? minAgeMs : maxAgeMs)) return cached
  } catch (err) {
    // A missing or corrupt cache file both mean "no usable cache yet".
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
  }

  try {
    const body = await fetchImpl(url, { label })
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(dest, JSON.stringify(body))
    fs.writeFileSync(fetchedAtPath, String(Date.now()))
    return body
  } catch (err) {
    try {
      return JSON.parse(fs.readFileSync(dest, 'utf8'))
    } catch (innerErr) {
      if (innerErr.code !== 'ENOENT' && !(innerErr instanceof SyntaxError)) throw innerErr
      throw err
    }
  }
}

export async function fetchManifest({ cacheDir, maxAgeMs = 3600000, force = false, fetchImpl = fetchJson }) {
  return cachedJson('version_manifest_v2.json', MANIFEST_URL, { cacheDir, label: 'the Minecraft version list', maxAgeMs, force, fetchImpl })
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
