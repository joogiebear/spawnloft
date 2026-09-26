/**
 * Updating the server software itself.
 *
 * <p>Two different sizes of decision share this module, and the code keeps them apart the way
 * the panel does. A newer BUILD of the same Minecraft version is routine - bug fixes for the
 * server you already run, and the old jar stays in the instance folder as the way back. A
 * newer Minecraft VERSION is not routine: the first start migrates the worlds, and worlds do
 * not migrate back. Both end the same way mechanically - fetch, verify, place, point the
 * registry at it - but only one should ever happen without a person having read a warning.
 */
import * as paper from './paper.mjs'
import * as purpur from './purpur.mjs'
import * as asp from './asp.mjs'
import { placeJar, strayJars } from './create.mjs'
import { getInstance, updateInstance } from './registry.mjs'
import { createSnapshot } from './backup.mjs'
import { fail } from './util.mjs'

const MC = String.raw`(\d+\.\d+(?:\.\d+)?)`

/**
 * The server software SpawnLoft can update, keyed by the prefix of the jar name it gave the jar.
 * Each says how to read a build out of that name, what the newest build for a Minecraft version
 * is and whether it is newer than the one running, and how to fetch one.
 *
 * <p>`channel` is Paper's and Folia's STABLE/EXPERIMENTAL; the others publish no such thing, and
 * say null rather than claim a stability nobody vouched for.
 */
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
    // Builds have no number; the jar carries the first eight characters of the build's id.
    jar: new RegExp(String.raw`^asp-${MC}-([0-9a-f]{8})\.jar$`, 'i'),
    build: String,
    versions: () => asp.versions(),
    async latest(version, current) {
      const b = await asp.latestBuild(version, current)
      if (!b) fail(`Advanced Slime Paper has no build for Minecraft ${version}.`)
      return { build: b.build, channel: null, time: b.time, newer: b.newer }
    },
    fetch(version, build, o) {
      // The API is picked over for the newest build per version; there is no asking for another.
      if (build != null) fail('Advanced Slime Paper builds cannot be chosen by id; SpawnLoft fetches the newest one.')
      return asp.fetchBuild(version, o)
    },
  },
}

export const UPDATABLE = Object.keys(SOURCES)

/**
 * What a jar's name says it is - paper-26.2-121.jar is Paper 26.2 build 121, asp-26.3-b77d5e97.jar
 * is Advanced Slime Paper 26.3 build b77d5e97 - or null for a jar SpawnLoft did not name and so
 * cannot reason about.
 */
export function parseServerJar(jar) {
  for (const [software, source] of Object.entries(SOURCES)) {
    const m = source.jar.exec(String(jar ?? ''))
    if (m) return { software, label: source.label, version: m[1], build: source.build(m[2]) }
  }
  return null
}

/** What a Paper jar's filename says it is: paper-26.2-121.jar -> { version, build }. */
export function parsePaperJar(jar) {
  const parsed = parseServerJar(jar)
  return parsed?.software === 'paper' ? { version: parsed.version, build: parsed.build } : null
}

/** Negative, zero or positive by Minecraft version number: 26.3 after 26.2.1, 1.21.10 after 1.21.9. */
export function compareMcVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/**
 * The versions newer than the current one, newest first. By number rather than by position: ASP
 * orders its list by when each version last had a build, and an older Minecraft version still
 * receiving fixes is not an upgrade. A version the list does not contain gets no "newer than"
 * claim at all.
 */
export function newerVersionsOf(all, current) {
  if (!all.includes(current)) return []
  return all.filter((v) => compareMcVersions(v, current) > 0).sort((a, b) => compareMcVersions(b, a))
}

/**
 * What is available for this server, asked of its own software's API on demand.
 *
 * <p>A server whose jar SpawnLoft did not name (an adopted custom build) gets an honest null for
 * its current version rather than a guess, and only Paper's newest version - there is no way to
 * say "newer than" something unparseable.
 */
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

/**
 * Fetch a build, place it in the instance, and point the registry at it.
 *
 * <p>The old jar is deliberately left in the instance folder - it is the way back if the new
 * build turns out to be wrong, and fifty megabytes is not a good enough reason to take that
 * away. It is named in the result so the caller can say so.
 */
export async function applyUpgrade(name, { version = null, build = null, running = false, onProgress = null } = {}) {
  const inst = getInstance(name)
  const current = parseServerJar(inst.jar)
  const target = version ?? current?.version
  if (!target) {
    fail(`"${inst.jar}" is not a jar SpawnLoft can reason about - name a version: upgrade ${name} --version <v>`)
  }
  // A jar SpawnLoft did not name is taken to be Paper, as it always was.
  const source = SOURCES[current?.software ?? 'paper']
  const crossVersion = Boolean(current && target !== current.version)

  const fetched = await source.fetch(target, build, { onProgress })
  if (fetched.name === inst.jar) return { alreadyCurrent: true, jar: inst.jar }

  // Crossing versions migrates the worlds on the next start, and worlds do not migrate back -
  // so the way back is made before the registry points anywhere new. After the fetch, so a
  // failed download never costs a snapshot; a build update needs none of this, because the
  // worlds are untouched and the old jar stays beside the new one.
  let snapshot = null
  if (crossVersion) {
    const snap = await createSnapshot(inst, { scope: 'standard', label: 'pre-upgrade', running })
    snapshot = snap.file
  }

  placeJar(inst.dir, fetched.name)
  updateInstance(name, { jar: fetched.name })
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
