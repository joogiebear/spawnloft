// One reading of a version JSON (merged with its loader profile first) into everything install
// and launch need, with no per-version branches: what a version needs is read from its own keys.
// Anything in the JSON SpawnLoft does not understand becomes a problem, and a version with a
// problem is refused before Java is looked for or anything but the JSON is downloaded.
import crypto from 'node:crypto'

import {
  currentOs, libraries, jvmArguments, gameArguments, loggingConfig, assetIndex, archDecision,
  nativesLibrarySubdir, nativesExtraDirs, ruleProblems,
} from './client-meta.mjs'

// Mojang's launcher format; it has been 21 since 1.13, through every real format change since.
export const LAUNCHER_FORMAT = 21

// Every ${name} SpawnLoft fills in. A version using another one was made for a launcher that
// knows something this one does not: every format change Mojang made showed up as a new
// variable first.
export const LAUNCH_VARIABLES = [
  // filled by buildCommand
  'classpath', 'classpath_separator', 'library_directory', 'natives_directory',
  'game_directory', 'assets_root', 'assets_index_name', 'version_name', 'version_type',
  'launcher_name', 'launcher_version',
  'auth_player_name', 'auth_uuid', 'auth_access_token', 'clientid', 'auth_xuid', 'user_type',
  'quickPlayMultiplayer', 'quickPlayPath',
  // behind features a launch never sets; listed so a run with them on sees no problem
  'resolution_width', 'resolution_height', 'quickPlaySingleplayer', 'quickPlayRealms',
  // the logging argument's own
  'path',
]

// What the game is run with on a normal launch; a server to join turns on quick play.
export function launchFeatures({ hasServer = false } = {}) {
  return {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: hasServer,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: hasServer,
    is_quick_play_realms: false,
  }
}

// The Java a version runs on, from its javaVersion (absent before 1.6.x was backfilled: Java 8).
// Bounds by what the JSON shows of its era, never by its number: LWJGL 2 and launchwrapper
// (minecraftArguments) start on 8 only, jre-legacy versions with arguments (1.13 to 1.16.5) on 8
// to 17, and later components on their own major or newer. prefer is the major Mojang pairs it
// with, taken first when installed: a newer Java runs it today, but JDK 26 and later deny the
// sun.misc.Unsafe access every LWJGL 3.2 and 3.3 version makes (review R3).
export function javaRequirement(version) {
  const jv = version.javaVersion
  const major = Number.isInteger(jv?.majorVersion) ? jv.majorVersion : 8
  const component = typeof jv?.component === 'string' ? jv.component : 'jre-legacy'
  if (component === 'jre-legacy') {
    return { major, component, min: 8, max: version.arguments ? 17 : 8, prefer: 8 }
  }
  // Temurin publishes no 16, and Mojang's runtime is the only place one comes from
  return { major, component, min: major, max: null, prefer: major === 16 ? 17 : major }
}

// The ${name}s in these arguments, in order of first use.
export function collectVariables(args) {
  const names = []
  for (const arg of args) {
    for (const [, name] of String(arg).matchAll(/\$\{(\w+)\}/g)) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

function problem(code, message) {
  return { code, message }
}

function argumentRules(version) {
  const rows = [...(version.arguments?.jvm ?? []), ...(version.arguments?.game ?? [])]
  return rows.filter((a) => a && typeof a === 'object').flatMap((a) => a.rules ?? [])
}

// os is the machine; hostCaps.x64 whether it runs x64 code (null when unknown); features the
// launch's (launchFeatures).
export function resolveVersion(version, { os = currentOs(), features = launchFeatures(), hostCaps = null, launcherFormat = LAUNCHER_FORMAT } = {}) {
  const id = version.id ?? 'this version'
  const what = `Minecraft ${id}`
  const problems = []

  const decision = archDecision(version, os, hostCaps)
  if (decision.refusal) problems.push(problem('no-natives-for-this-machine', decision.refusal))
  // the arch the game runs as: rules, natives and the Java all follow it
  const runOs = { ...os, arch: decision.arch }

  const unknownRules = ruleProblems([...(version.libraries ?? []).flatMap((l) => l.rules ?? []), ...argumentRules(version)], { os: runOs })
  if (unknownRules.length) {
    problems.push(problem('unknown-rule-key', `${what} uses a platform rule SpawnLoft does not know (${unknownRules.join(', ')}). Update SpawnLoft.`))
  }

  const jvm = jvmArguments(version, { os: runOs, features })
  const game = gameArguments(version, { os: runOs, features })
  const variables = collectVariables([...jvm, ...game])
  const unknownVars = variables.filter((v) => !LAUNCH_VARIABLES.includes(v))
  if (unknownVars.length) {
    problems.push(problem('unknown-variable', `${what} uses a launcher setting SpawnLoft does not know (${unknownVars.map((v) => '${' + v + '}').join(', ')}). Update SpawnLoft.`))
  }

  const minimumLauncherVersion = Number.isInteger(version.minimumLauncherVersion) ? version.minimumLauncherVersion : null
  const formatOk = minimumLauncherVersion === null || minimumLauncherVersion <= launcherFormat
  if (!formatOk) {
    problems.push(problem('newer-launcher-format', `${what} needs launcher format ${minimumLauncherVersion}; this SpawnLoft knows ${launcherFormat}. Update SpawnLoft.`))
  }

  const libRows = libraries(version, { os: runOs })
  const natives = libRows.filter((r) => r.native !== false)
  const nativesDir = nativesLibrarySubdir(version, { os: runOs })
  const extraDirs = nativesExtraDirs(version, { os: runOs })

  return {
    id: version.id,
    type: version.type ?? 'release',
    releaseTime: version.releaseTime ?? null,
    java: javaRequirement(version),
    os: runOs,
    arch: decision.arch,
    emulated: decision.emulated,
    mainClass: version.mainClass,
    jvm,
    game,
    libraries: libRows,
    natives: { rows: natives, dir: nativesDir, extraDirs, stamp: nativesStamp(version, runOs) },
    logging: loggingConfig(version),
    assets: { index: assetIndex(version), layout: 'unknown-until-index' },
    clientJar: version.downloads?.client ?? null,
    format: { minimumLauncherVersion, ok: formatOk },
    variables,
    problems,
  }
}

// Says whose natives a folder holds and from what: a different OS, arch, or any change to the
// natives rows or the JVM arguments that place them redoes the extraction, with no hand-kept
// version number to bump.
export function nativesStamp(version, os) {
  const jvm = jvmArguments(version, { os })
  const natives = libraries(version, { os }).filter((r) => r.native !== false)
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify({ jvm, natives: natives.map((r) => [r.name, r.path, r.sha1, r.native.extract.exclude]) }))
    .digest('hex')
  return `${version.id} ${os.name} ${os.arch} ${hash}`
}

// The one-line refusal for a resolved version, or null. code is the first problem's.
export function resolvedRefusal(resolved) {
  if (resolved.problems.length === 0) return null
  return { code: resolved.problems[0].code, message: resolved.problems.map((p) => p.message).join(' ') }
}
