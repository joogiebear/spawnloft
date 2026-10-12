// Where each kind of server comes from: the version list, and the fetch that turns a chosen version
// into a jar in the store. Metadata lives in software.mjs. Every fetch answers { name, cached, ... }
// and takes { onProgress, java, build, force }; progress is either byte counts (received, total) or a
// message line from a build or installer.
import * as paper from './paper.mjs'
import * as purpur from './purpur.mjs'
import * as asp from './asp.mjs'
import * as vanilla from './vanilla.mjs'
import * as buildtools from './buildtools.mjs'
import * as fabric from './fabric.mjs'
import * as neoforge from './neoforge.mjs'
import { JAR_IDS, softwareOf } from './software.mjs'

const JAR_SOURCES = {
  paper: {
    versions: () => paper.versions(),
    fetch: (v, o) => paper.fetchBuild(v, o.build ?? null, o),
  },
  folia: {
    versions: () => paper.versions({ project: 'folia' }),
    fetch: (v, o) => paper.fetchBuild(v, o.build ?? null, { ...o, project: 'folia' }),
  },
  purpur: {
    versions: () => purpur.versions(),
    fetch: (v, o) => purpur.fetchBuild(v, o.build ?? null, o),
  },
  asp: {
    versions: () => asp.versions(),
    fetch: (v, o) => asp.fetchBuild(v, o),
  },
  vanilla: {
    versions: () => vanilla.versions(),
    fetch: (v, o) => vanilla.fetchServer(v, o),
  },
  spigot: {
    versions: () => buildtools.versions(),
    fetch: (v, o) => buildtools.build(v, { ...o, flavour: 'spigot' }),
  },
  craftbukkit: {
    versions: () => buildtools.versions(),
    fetch: (v, o) => buildtools.build(v, { ...o, flavour: 'craftbukkit' }),
  },
  fabric: {
    versions: () => fabric.versions(),
    fetch: (v, o) => fabric.fetchLauncher(v, o),
  },
}

for (const id of JAR_IDS) {
  if (!JAR_SOURCES[id]) throw new Error(`software.mjs lists "${id}" but sources.mjs has no client for it`)
}

export function isJarSource(id) {
  return Object.hasOwn(JAR_SOURCES, id)
}

export async function versionsFor(id) {
  if (id === 'neoforge') return neoforge.versions()
  if (!isJarSource(id)) throw new Error(`no version list for "${id}"`)
  return JAR_SOURCES[id].versions()
}

export async function fetchJar(id, version, options = {}) {
  if (!isJarSource(id)) throw new Error(`"${id}" is not fetched as a jar`)
  return JAR_SOURCES[id].fetch(String(version), options)
}

export function labelFor(id) {
  return softwareOf(id).label
}
