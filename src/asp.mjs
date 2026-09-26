/**
 * Advanced Slime Paper, from InfernalSuite's build API.
 *
 * <p>ASP is Paper with the Slime World Manager built into the server jar. The API is one list
 * of every build ever made - each naming the Minecraft versions it targets and carrying its
 * files with sha256 hashes - rather than versions-then-builds, so the list is fetched once
 * per process and picked over in memory. The server jar is always called `asp-server.jar`
 * in the build, and is renamed on the way into the store so its Minecraft version and build
 * are in the filename like every other jar mcctl keeps.
 *
 * <p>Builds have no number, only an id; the first eight characters of it stand in.
 */
import fs from 'node:fs'
import path from 'node:path'

import { JARS_DIR } from './paths.mjs'
import { fail } from './util.mjs'
import { fetchJson, downloadFile } from './download.mjs'

const API = 'https://api.infernalsuite.com/v1/projects/asp'
const LABEL = 'the InfernalSuite API'
const SERVER_JAR = 'asp-server.jar'

let cached = null
async function allBuilds() {
  if (!cached) cached = await fetchJson(API, { label: LABEL })
  return cached
}

const hasServerJar = (b) => Array.isArray(b.files) && b.files.some((f) => f.fileName === SERVER_JAR)
const isPrerelease = (v) => /-(pre|rc|snapshot)/i.test(v)

/**
 * The Minecraft versions ASP has a server jar for, newest release first, judged by the date of
 * the newest build for each. Exported pure over the list so it can be tested without the API.
 */
export function versionsOf(builds) {
  const newest = new Map()
  for (const b of builds) {
    if (!hasServerJar(b)) continue
    for (const mc of b.mcVersion ?? []) {
      if (isPrerelease(mc)) continue
      if ((newest.get(mc) ?? 0) < b.date) newest.set(mc, b.date)
    }
  }
  return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([mc]) => mc)
}

/** The newest build with a server jar for a Minecraft version, or null. */
export function pickBuild(builds, mc) {
  return builds
    .filter((b) => hasServerJar(b) && (b.mcVersion ?? []).includes(mc))
    .sort((a, b) => b.date - a.date)[0] ?? null
}

export function jarName(mc, build) {
  return `asp-${mc}-${String(build.id).slice(0, 8)}.jar`
}

export async function versions() {
  return versionsOf(await allBuilds())
}

/**
 * The newest build for a Minecraft version against the one a server runs, by the id prefix its
 * jar name carries. Builds have no number to compare, so "newer" is by date; a prefix the API no
 * longer lists is taken to be older than whatever it does.
 */
export function compareBuilds(builds, mc, currentPrefix) {
  const latest = pickBuild(builds, mc)
  if (!latest) return null
  const prefix = String(latest.id).slice(0, 8)
  const current = builds.find((b) => String(b.id).startsWith(String(currentPrefix)))
  return {
    build: prefix,
    time: new Date(latest.date).toISOString(),
    newer: prefix !== currentPrefix && (!current || latest.date > current.date),
  }
}

export async function latestBuild(mc, currentPrefix) {
  return compareBuilds(await allBuilds(), mc, currentPrefix)
}

export async function fetchBuild(mc, { force = false, onProgress = null } = {}) {
  const build = pickBuild(await allBuilds(), mc)
  if (!build) fail(`Advanced Slime Paper has no build for Minecraft ${mc}.`)
  const file = build.files.find((f) => f.fileName === SERVER_JAR)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = jarName(mc, build)
  const dest = path.join(JARS_DIR, name)
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: 1, total: 1, cached: true })
    return { name, path: dest, version: mc, build: build.id, cached: true }
  }
  const { size, sizeHuman } = await downloadFile(`${API}/${build.id}/download/${file.id}`, dest, {
    hash: 'sha256',
    expected: file.sha256Hash ?? null,
    onProgress,
    minBytes: 1024 * 1024,
    label: name,
  })
  return { name, path: dest, version: mc, build: build.id, cached: false, size, sizeHuman }
}
