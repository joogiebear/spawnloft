import { execFile } from 'node:child_process'
import fsSync from 'node:fs'
import path from 'node:path'
import { fail, UserError } from './util.mjs'

// Checks for a Java the server can run on. It is the one prerequisite mcctl can't supply, so the
// wizard, panel and doctor share this to answer the same way.

// Minecraft 26.x needs 25 (Mojang's version metadata), 1.21.x needs 21 and older versions 17, which
// is why 17 is the floor rather than the recommendation.
export const RECOMMENDED_MAJOR = 25
export const MINIMUM_MAJOR = 17

// a build, not a vendor download page behind a login
export const DOWNLOAD_URL = 'https://adoptium.net/temurin/releases/?version=25'

// handles `openjdk version "21.0.5"` and the pre-9 `java version "1.8.0_401"`, where the major is the second number
export function parseMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(text)
  if (!m) return null
  const first = Number(m[1])
  if (first === 1) return m[2] ? Number(m[2]) : null
  return first
}

// The os.arch line of -XshowSettings:properties, in the arch names the client uses; null when
// the Java printed none.
export function parseArch(text) {
  const m = /^\s*os\.arch\s*=\s*(\S+)/m.exec(text)
  if (!m) return null
  const raw = m[1].toLowerCase()
  if (raw === 'amd64' || raw === 'x86_64') return 'x64'
  if (raw === 'aarch64' || raw === 'arm64') return 'arm64'
  if (raw === 'x86' || /^i[3-6]86$/.test(raw)) return 'x86'
  return raw
}

const PROBE_TIMEOUT_MS = 8000

// execFile's timeout kills the child and reports it as a signal, never an exit code
function timedOut(error) {
  return Boolean(error && error.killed && error.code == null)
}

// Returns a plain object rather than throwing, since callers want to report it. Async because the
// panel asks as it opens, alongside the first poll and console stream, and a JVM takes a few hundred ms.
export async function probe(bin = 'java') {
  // the properties name the arch this Java runs as (Java 7 on), which the game client needs: an
  // x64 Java under Rosetta or Windows emulation says x86_64/amd64, as it should
  const run = (args = ['-XshowSettings:properties', '-version']) => new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  let res = await run()
  // a slow JVM is not a missing one: discovery starts every Java at once and one can exceed the window
  // on a loaded machine, which flipped the default Java between calls. Retry a timeout once before
  // counting it against the binary.
  if (timedOut(res.error)) res = await run()
  // a JVM that refuses the option (Java 6, or a vendor build without it) is still a Java: ask
  // the plain question, and its arch stays unknown
  if (res.error && res.error.code !== 'ENOENT' && !timedOut(res.error)) res = await run(['-version'])
  if (res.error) {
    // ENOENT is the common case; execFile also puts a numeric exit status in code
    const missing = res.error.code === 'ENOENT'
    return {
      ok: false,
      found: false,
      major: null,
      version: null,
      reason: missing ? 'not-installed' : 'unusable',
      message: missing
        ? 'Java is not installed, or not on PATH.'
        : timedOut(res.error)
          ? `Java did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds, twice.`
          : `Java could not be run: ${typeof res.error.code === 'number' ? `exit ${res.error.code}` : res.error.message}`,
    }
  }

  // java -version writes to stderr
  const text = `${res.stderr ?? ''}${res.stdout ?? ''}`
  // the version line, not the first line: JAVA_TOOL_OPTIONS makes the JVM print a "Picked up" notice first
  const version = (text.split('\n').find((l) => /version "/.test(l)) ?? text.split('\n')[0]).trim()
  const major = parseMajor(text)
  const arch = parseArch(text)

  if (major == null) {
    return { ok: true, found: true, major: null, version, arch, reason: 'unknown-version', message: `Found ${version}.` }
  }
  if (major < MINIMUM_MAJOR) {
    return {
      ok: false,
      found: true,
      major,
      version,
      arch,
      reason: 'too-old',
      message: `Java ${major} is too old to run a modern Minecraft server. Version ${RECOMMENDED_MAJOR} is what current Paper needs.`,
    }
  }
  if (major < RECOMMENDED_MAJOR) {
    return {
      ok: true,
      found: true,
      major,
      version,
      arch,
      reason: 'old',
      message: `Java ${major} will run older Minecraft versions, but current Paper needs ${RECOMMENDED_MAJOR}.`,
    }
  }
  return { ok: true, found: true, major, version, arch, reason: 'ok', message: `Java ${major} is installed.` }
}

// Every Java on the machine, not just PATH: Temurin's add-to-PATH box is optional, a running desktop
// app doesn't see a PATH change, and Oracle's javapath shim can point at an older runtime. Looks in
// the usual install folders, JAVA_HOME and PATH, probing each once, in parallel.
const WINDOWS_VENDOR_DIRS = [
  'Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Temurin', 'Microsoft',
  'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'OpenJDK', 'Azul', 'Oracle',
]

function candidatePaths() {
  const fs = fsSync
  const found = new Map()
  const add = (p, source) => {
    if (!p) return
    let real = p
    try {
      real = fs.realpathSync(p)
    } catch {
      return
    }
    if (!found.has(real)) found.set(real, { path: p, source })
  }
  const bin = process.platform === 'win32' ? 'java.exe' : 'java'
  const home = process.env.JAVA_HOME
  if (home) add(path.join(home, 'bin', bin), 'JAVA_HOME')

  const scan = (root, source) => {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const base = path.join(root, e.name)
      // <vendor>/<jdk-25.0.1>/bin/java.exe, or .../Contents/Home/bin in macOS bundles
      for (const rel of [['bin', bin], ['Contents', 'Home', 'bin', bin]]) add(path.join(base, ...rel), source)
    }
  }
  if (process.platform === 'win32') {
    const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean))
    for (const root of roots) {
      for (const vendor of WINDOWS_VENDOR_DIRS) scan(path.join(root, vendor), vendor)
    }
  } else if (process.platform === 'darwin') {
    scan('/Library/Java/JavaVirtualMachines', 'JavaVirtualMachines')
    scan(path.join(process.env.HOME ?? '', 'Library', 'Java', 'JavaVirtualMachines'), 'JavaVirtualMachines')
  } else {
    scan('/usr/lib/jvm', '/usr/lib/jvm')
  }
  return [...found.values()]
}

// Probes PATH and every candidate at once: { best, onPath, all }. all is newest first, best the newest usable Java or null.
export async function discover() {
  const onPath = await probe('java')
  const rest = await Promise.all(candidatePaths().map(async (c) => ({ ...c, ...(await probe(c.path)) })))
  const all = rest.filter((r) => r.found && r.major != null).sort((a, b) => b.major - a.major)
  if (onPath.found && onPath.major != null) all.unshift({ path: 'java', source: 'PATH', ...onPath })
  // dedupe a PATH java that is also in a scanned folder (same version string)
  const seen = new Set()
  const unique = all.filter((r) => {
    // an x64 and an arm64 build of one release print the same version line
    const key = `${r.version} ${r.arch ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => b.major - a.major)
  const best = unique.find((r) => r.major >= MINIMUM_MAJOR) ?? null
  return { best, onPath, all: unique }
}

// `java` by name when PATH has the best one (the registry stays readable and follows upgrades),
// else an absolute path. Null when there is no usable Java.
export async function defaultJava() {
  const { best, onPath } = await discover()
  if (!best) return null
  if (onPath.found && onPath.major === best.major) return 'java'
  return best.path
}

// What the panel banner, wizard and doctor report. Shaped like probe()'s answer, plus facts for when PATH and reality disagree.
export async function health() {
  const { best, onPath, all } = await discover()
  if (!best) {
    return {
      ...onPath,
      ok: false,
      found: all.length > 0,
      path: null,
      onPath: false,
      others: all,
      message: all.length
        ? `Java ${all[0].major} was found at ${all[0].path}, but a Minecraft server needs ${MINIMUM_MAJOR} or newer.`
        : 'Java is not installed, or is somewhere SpawnLoft did not look.',
    }
  }
  const viaPath = best.path === 'java'
  const state = await probe(best.path)
  const where = viaPath ? '' : ` at ${best.path}`
  const note = viaPath ? '' : (onPath.found
    ? ` PATH points at Java ${onPath.major}; SpawnLoft will use this one instead.`
    : ' It is not on PATH; SpawnLoft will use it anyway.')
  return {
    ...state,
    path: best.path,
    onPath: viaPath,
    others: all,
    message: state.reason === 'ok'
      ? `Java ${state.major} is installed${where}.${note}`
      : `${state.message}${where ? ` Found${where}.` : ''}${note}`,
  }
}

// Mojang's floor, inherited by every server built on a version (they load the same class files).
// A table rather than fetched, so offline and online agree. Unknown shapes (snapshots, fork numbering)
// return null, meaning no check. Too-new is not checked: a modern Java usually runs an old server,
// while too-old certainly fails.
export function requiredMajor(mc) {
  // Digits and dots only: a snapshot like 25w14a is not a release and answers null.
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(mc ?? '').trim())
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] == null ? 0 : Number(m[2])
  const c = m[3] == null ? 0 : Number(m[3])
  // Year-based versions, 26.1 onward, need 25.
  if (a >= 25) return 25
  if (a !== 1) return null
  if (b >= 21) return 21
  if (b === 20) return c >= 5 ? 21 : 17
  if (b >= 18) return 17
  if (b === 17) return 16
  return 8
}

export async function javaFor(needs) {
  const { all } = await discover()
  return all.find((j) => j.major >= needs) ?? null
}

// Decides which Java a server gets before anything is downloaded. An explicit Java is probed and
// refused only if certainly too old (unless force). Otherwise the newest installed Java that satisfies
// the version wins. If none is new enough, refuse naming what is needed, or with force use the best.
// No Java at all is not refused here; the panel banner and start already say so.
export async function pickJava({ explicit = null, needs = null, force = false, what = 'this version' } = {}) {
  if (explicit) {
    const state = await probe(explicit)
    if (!state.found) fail(`${explicit} could not be run: ${state.message}`)
    if (needs && state.major != null && state.major < needs && !force) {
      throw tooOld(`${what} needs Java ${needs}, and ${explicit} is Java ${state.major}. `
        + 'Pick a newer Java, or pass --force to use it anyway.', { needs, have: state.major })
    }
    return explicit
  }
  if (!needs) return (await defaultJava()) ?? 'java'
  const fit = await javaFor(needs)
  if (fit) return fit.path === 'java' ? 'java' : fit.path
  const { best } = await discover()
  if (!best) return 'java'
  if (force) return best.path
  throw tooOld(`${what} needs Java ${needs}. The newest Java on this machine is ${best.major}`
    + `${best.path === 'java' ? '' : ` (${best.path})`}. Install Java ${needs} from ${DOWNLOAD_URL}, `
    + 'or create it anyway and point it at a Java of your own afterwards.', { needs, have: best.major })
}

// the panel recognises code 'java-too-old' and offers to override
function tooOld(message, { needs, have }) {
  const err = new UserError(message)
  err.code = 'java-too-old'
  err.needs = needs
  err.have = have
  return err
}

const temurinUrl = (major) => `https://adoptium.net/temurin/releases/?version=${major}`

// Which installed Java a game client runs on (requirement: client-version's javaRequirement):
// one of the arch the game runs as, inside the bounds, the preferred major first and otherwise
// the newest. null when none fits. A Java whose arch could not be read is taken as fitting.
export function chooseClientJava(candidates, { min, max = null, prefer = null }, arch = null) {
  const fits = candidates.filter((j) => j.major != null && j.major >= min && (max == null || j.major <= max) && (arch == null || j.arch == null || j.arch === arch))
  return fits.find((j) => j.major === prefer) ?? [...fits].sort((a, b) => b.major - a.major)[0] ?? null
}

function boundsText({ min, max }) {
  if (max == null) return `Java ${min} or newer`
  return min === max ? `Java ${min}` : `Java ${min} to ${max}`
}

// The Java a game client gets, decided from its version JSON before anything but that JSON is
// downloaded: { path, warning, source }. An explicit Java is probed and refused when it certainly
// cannot run the version (too old, or the wrong arch); one newer than the version's bounds is used
// with a warning, as the person chose it. "mojang" always takes Mojang's runtime. Otherwise
// chooseClientJava over every Java on the machine, then Mojang's runtime for the version's
// component (`runtime`, which downloads it when needed), and when that cannot be had (offline,
// or none for this machine) the closest newer installed Java with a warning, since a refusal
// would stop versions that mostly run on it. `found` replaces discovery (tests).
export async function pickClientJava({ explicit = null, requirement, arch = null, what = 'this version', found = null, runtime = null } = {}) {
  const need = boundsText(requirement)
  const install = requirement.prefer ?? requirement.min
  const get = `Install Java ${install} from ${temurinUrl(install)}, or point the profile at one.`
  if (explicit === 'mojang') {
    if (!runtime) fail(`${what} is set to Mojang's Java, which this launch cannot download`)
    const r = await runtime()
    return { path: r.path, warning: null, source: 'mojang-runtime' }
  }
  if (explicit) {
    const state = await probe(explicit)
    if (!state.found) fail(`${explicit} could not be run: ${state.message}`)
    if (arch && state.arch && state.arch !== arch) {
      throw clientJavaError('java-wrong-arch', `${what} runs as ${arch} on this machine, and ${explicit} is an ${state.arch} Java. Pick an ${arch} Java for the profile, or clear it to let SpawnLoft choose.`, { needs: install, have: state.major })
    }
    if (state.major != null && state.major < requirement.min) {
      throw clientJavaError('java-too-old', `${what} needs ${need}, and ${explicit} is Java ${state.major}. Pick another Java for the profile, or clear it to let SpawnLoft choose.`, { needs: install, have: state.major })
    }
    const over = state.major != null && requirement.max != null && state.major > requirement.max
    const warning = over ? `${what} wants ${need}; using Java ${state.major} at ${explicit}, which is newer, so the game may not start.` : null
    return { path: explicit, warning, source: 'explicit' }
  }
  const all = found ?? (await discover()).all
  const choice = chooseClientJava(all, requirement, arch)
  if (choice) return { path: choice.path, warning: null, source: 'installed' }

  let why = null
  if (runtime) {
    try {
      const r = await runtime()
      return { path: r.path, warning: null, source: 'mojang-runtime' }
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      // no runtime for this machine is the whole answer when nothing installed can stand in
      why = err
    }
  }
  const right = all.filter((j) => j.major != null && (arch == null || j.arch == null || j.arch === arch))
  const newer = right.filter((j) => j.major > (requirement.max ?? Infinity)).sort((a, b) => a.major - b.major)
  if (newer.length) {
    const j = newer[0]
    const missed = why ? ` Mojang's Java could not be had: ${why.message.replace(/\.$/, '')}.` : ''
    return { path: j.path, warning: `${what} wants ${need}; using Java ${j.major}${j.path === 'java' ? '' : ` at ${j.path}`}, which is newer, so the game may not start.${missed} ${get}`, source: 'fallback' }
  }
  if (why?.code === 'no-runtime-for-this-machine') {
    throw clientJavaError('no-runtime-for-this-machine', `${why.message}. ${what} needs ${need}. ${get}`, { needs: install, have: null })
  }
  const after = why ? ` Mojang's Java could not be had either: ${why.message}` : ''
  if (all.length === 0) {
    throw clientJavaError('java-missing', `${what} needs ${need}, and no Java was found on this machine.${after} ${get}`, { needs: install, have: null })
  }
  if (right.length === 0) {
    throw clientJavaError('java-wrong-arch', `${what} runs as ${arch} on this machine and needs an ${arch} ${need}; the Javas found are ${[...new Set(all.map((j) => j.arch ?? '?'))].join(', ')}.${after} ${get}`, { needs: install, have: null })
  }
  const newest = [...right].sort((a, b) => b.major - a.major)[0]
  throw clientJavaError('java-too-old', `${what} needs ${need}. The newest Java on this machine is ${newest.major}${newest.path === 'java' ? '' : ` (${newest.path})`}.${after} ${get}`, { needs: install, have: newest.major })
}

function clientJavaError(code, message, { needs, have }) {
  const err = new UserError(message)
  err.code = code
  err.needs = needs
  err.have = have
  return err
}
