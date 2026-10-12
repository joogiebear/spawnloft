// Updates the server jar. A newer build of the same Minecraft version is routine; a newer
// Minecraft version migrates the worlds on first start and they can't migrate back, so that one
// needs a warning and a snapshot first.
import path from 'node:path'
import * as paper from './paper.mjs'
import * as purpur from './purpur.mjs'
import * as asp from './asp.mjs'
import { placeJar, strayJars } from './create.mjs'
import { getInstance, updateInstance } from './registry.mjs'
import { createSnapshot } from './backup.mjs'
import { fail } from './util.mjs'
import * as activity from './activity.mjs'

const MC = String.raw`(\d+\.\d+(?:\.\d+)?)`

// Updatable software, keyed by the jar name prefix. Each knows how to parse a build from the jar
// name, find the newest build and fetch one. `channel` is Paper/Folia's stable/experimental;
// the others have none and report null.
const SOURCES = {
  paper: {
    label: 'Paper',
    jar: new RegExp(String.raw`^paper-${MC}-(\d+)\.jar$`, 'i'),
    build: Number,
    versions: () => paper.versions(),
    async latest(version, current) {
      const b = await paper.resolveBuild(version)
      return { build: Number(b.build), channel: b.channel, time: b.time ?? null, newer: Number(b.build) > Number(current) }
    },
    fetch: (version, build, o) => paper.fetchBuild(version, build, o),
  },
  folia: {
    label: 'Folia',
    jar: new RegExp(String.raw`^folia-${MC}-(\d+)\.jar$`, 'i'),
    build: Number,
    versions: () => paper.versions({ project: 'folia' }),
    async latest(version, current) {
      const b = await paper.resolveBuild(version, null, { project: 'folia' })
      return { build: Number(b.build), channel: b.channel, time: b.time ?? null, newer: Number(b.build) > Number(current) }
    },
    fetch: (version, build, o) => paper.fetchBuild(version, build, { ...o, project: 'folia' }),
  },
  purpur: {
    label: 'Purpur',
    jar: new RegExp(String.raw`^purpur-${MC}-(\d+)\.jar$`, 'i'),
    build: Number,
    versions: () => purpur.versions(),
    async latest(version, current) {
      const { latest } = await purpur.builds(version)
      return { build: Number(latest), channel: null, time: null, newer: Number(latest) > Number(current) }
    },
    fetch: (version, build, o) => purpur.fetchBuild(version, build, o),
  },
  asp: {
    label: 'Advanced Slime Paper',
    // builds have no number; the jar carries the first eight characters of the build id
    jar: new RegExp(String.raw`^asp-${MC}-([0-9a-f]{8})\.jar$`, 'i'),
    build: String,
    versions: () => asp.versions(),
    async latest(version, current) {
      const b = await asp.latestBuild(version, current)
      if (!b) fail(`Advanced Slime Paper has no build for Minecraft ${version}.`)
      return { build: b.build, channel: null, time: b.time, newer: b.newer }
    },
    fetch(version, build, o) {
      // the API only offers the newest build per version
      if (build != null) fail('Advanced Slime Paper builds cannot be chosen by id; SpawnLoft fetches the newest one.')
      return asp.fetchBuild(version, o)
    },
  },
}

export const UPDATABLE = Object.keys(SOURCES)

// paper-26.2-121.jar is Paper 26.2 build 121; asp-26.3-b77d5e97.jar is ASP 26.3 build b77d5e97.
// Null for a jar SpawnLoft didn't name.
export function parseServerJar(jar) {
  for (const [software, source] of Object.entries(SOURCES)) {
    const m = source.jar.exec(String(jar ?? ''))
    if (m) return { software, label: source.label, version: m[1], build: source.build(m[2]) }
  }
  return null
}

export function parsePaperJar(jar) {
  const parsed = parseServerJar(jar)
  return parsed?.software === 'paper' ? { version: parsed.version, build: parsed.build } : null
}

// numeric comparison: 26.3 is after 26.2.1, 1.21.10 after 1.21.9
export function compareMcVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

// Newest first. Compared by number, not list position: ASP orders by last build, so an older
// version still receiving fixes would otherwise look like an upgrade.
export function newerVersionsOf(all, current) {
  if (!all.includes(current)) return []
  return all.filter((v) => compareMcVersions(v, current) > 0).sort((a, b) => compareMcVersions(b, a))
}

// A jar SpawnLoft didn't name (adopted custom build) gets a null current version and only
// Paper's newest version, since "newer than" can't be judged for an unparseable jar.
export async function checkUpgrade(inst) {
  const current = parseServerJar(inst.jar)
  const source = SOURCES[current?.software ?? 'paper']
  const all = await source.versions()
  const newerVersions = current ? newerVersionsOf(all, current.version) : []
  const out = {
    software: current?.software ?? null,
    label: current?.label ?? null,
    current: current ? { version: current.version, build: current.build } : null,
    latestBuild: null,
    buildUpdate: false,
    newerVersions,
    latestVersion: newerVersions[0] ?? (current ? current.version : [...all].sort((a, b) => compareMcVersions(b, a))[0] ?? null),
  }
  if (!current) return out
  const { newer, ...latest } = await source.latest(current.version, current.build)
  out.latestBuild = latest
  out.buildUpdate = newer
  return out
}

// The old jar is deliberately left in the instance folder as the way back, and named in the result.
export async function applyUpgrade(name, { version = null, build = null, running = false, onProgress = null } = {}) {
  const inst = getInstance(name)
  const current = parseServerJar(inst.jar)
  const target = version ?? current?.version
  if (!target) {
    fail(`"${inst.jar}" is not a jar SpawnLoft can reason about - name a version: upgrade ${name} --version <v>`)
  }
  // an unnamed jar is treated as Paper
  const source = SOURCES[current?.software ?? 'paper']
  const crossVersion = Boolean(current && target !== current.version)

  const fetched = await source.fetch(target, build, { onProgress })
  if (fetched.name === inst.jar) return { alreadyCurrent: true, jar: inst.jar }

  // Crossing versions migrates the worlds on next start and they can't migrate back, so snapshot
  // before the registry changes. After the fetch so a failed download costs no snapshot. A build
  // update needs none: worlds are untouched and the old jar stays.
  let snapshot = null
  if (crossVersion) {
    const snap = await createSnapshot(inst, { scope: 'standard', label: 'pre-upgrade', running, quiet: true })
    snapshot = snap.file
  }

  placeJar(inst.dir, fetched.name)
  // mcVersion moves with the jar: it selects the Java version and offered plugin builds. An
  // instance that never recorded one reads it from the jar name instead.
  updateInstance(name, { jar: fetched.name, ...(inst.mcVersion ? { mcVersion: target } : {}) })
  activity.record(name, 'upgrade', { detail: `${inst.jar} to ${fetched.name}`, snapshot: snapshot ? path.basename(snapshot) : null })
  return {
    from: inst.jar,
    to: fetched.name,
    label: source.label,
    version: target,
    build: fetched.build,
    channel: fetched.channel ?? null,
    crossVersion,
    snapshot,
    oldJars: strayJars(inst.dir, fetched.name).map((j) => j.name),
  }
}
