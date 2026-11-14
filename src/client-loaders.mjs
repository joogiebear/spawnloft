// The mod loaders a setup can use, each behind one shape, so the launch path names none of them.
// A setup keeps loader (an id from LOADERS) and loaderVersion (the loader's own build, pinned by
// the first Play). Vanilla has no module: it is the game as Mojang ships it.
//
// Each module answers:
//   id, name                      'fabric', 'Fabric'
//   gameVersions(opts)            the Minecraft versions it builds for, cached for an hour
//   available(mc, list)           whether that list has mc
//   assertAvailable(mc, { kind }) refuses a version it does not build for, before any download
//   builds(mc)                    its builds for one version, newest first ({ version, stable })
//   pick(builds, wanted)          the build a first Play takes when none is pinned
//   versionId(mc, build)          the id of its version file (versions/<id>/<id>.json)
//   isInstalled(mc, build)        whether that version file is on disk
//   ensureInstalled(mc, build)    leaves a complete versions/<id>/ and returns the id
//   finishInstall(mc, build, o)   optional: what is left once the game's Java is picked and the
//                                 vanilla game is downloaded (an installer's build steps)
//   narrowJava(requirement)       optional: the Java the loader needs, narrower than the version's
//   afterInstall(name, profile)   anything for the setup's mods folder
import fs from 'node:fs'

import { versionJson } from './client-paths.mjs'
import {
  loaderVersions, pickLoader, fabricVersionId, ensureFabricProfile, ensureFabricApi,
  assertFabricAvailable, fabricGameVersions, fabricAvailable,
} from './client-fabric.mjs'
import {
  quiltGameVersions, quiltAvailable, assertQuiltAvailable, quiltBuilds, pickQuilt, quiltVersionId,
  ensureQuiltProfile,
} from './client-quilt.mjs'
import {
  neoforgeGameVersions, neoforgeAvailable, assertNeoforgeAvailable, neoforgeBuilds, pickNeoforge,
  neoforgeVersionId, neoforgeInstalled, ensureNeoforgeVersion, finishNeoforge,
} from './client-neoforge.mjs'
import {
  forgeGameVersions, forgeAvailable, assertForgeAvailable, forgeBuilds, pickForge, forgeVersionId,
  forgeInstalled, ensureForgeVersion, finishForge, forgeJava,
} from './client-forge.mjs'

const fabric = {
  id: 'fabric',
  name: 'Fabric',
  gameVersions: (opts) => fabricGameVersions(opts),
  available: (mc, list) => fabricAvailable(mc, list),
  assertAvailable: (mc, opts) => assertFabricAvailable(mc, opts),
  builds: (mc, opts) => loaderVersions(mc, opts),
  pick: (builds, wanted = null) => pickLoader(builds, { wanted }),
  versionId: (mc, build) => fabricVersionId(mc, build),
  isInstalled: (mc, build) => fs.existsSync(versionJson(fabricVersionId(mc, build))),
  ensureInstalled: async (mc, build, opts = {}) => ensureFabricProfile(mc, build, opts),
  afterInstall: async (name, profile, { onStage = () => {}, onProgress = () => {} } = {}) => {
    onStage({ stage: 'fabric', message: 'Checking Fabric API' })
    await ensureFabricApi(name, profile.mc, { onProgress })
  },
}

// Quilt loads Fabric API too, and retired its own libraries (QSL) from Minecraft 26.1 on: one
// rule for every version (design Q4)
const quilt = {
  id: 'quilt',
  name: 'Quilt',
  gameVersions: (opts) => quiltGameVersions(opts),
  available: (mc, list) => quiltAvailable(mc, list),
  assertAvailable: (mc, opts) => assertQuiltAvailable(mc, opts),
  builds: (mc, opts) => quiltBuilds(mc, opts),
  pick: (builds, wanted = null) => pickQuilt(builds, wanted),
  versionId: (mc, build) => quiltVersionId(mc, build),
  isInstalled: (mc, build) => fs.existsSync(versionJson(quiltVersionId(mc, build))),
  ensureInstalled: async (mc, build, opts = {}) => ensureQuiltProfile(mc, build, opts),
  afterInstall: async (name, profile, { onStage = () => {}, onProgress = () => {} } = {}) => {
    onStage({ stage: 'quilt', message: 'Checking Fabric API' })
    await ensureFabricApi(name, profile.mc, { onProgress })
  },
}

// NeoForge is set up by the installer engine: its version file first, its build steps on the
// game's own Java. It needs nothing in the mods folder.
const neoforge = {
  id: 'neoforge',
  name: 'NeoForge',
  gameVersions: (opts) => neoforgeGameVersions(opts),
  available: (mc, list) => neoforgeAvailable(mc, list),
  assertAvailable: (mc, opts) => assertNeoforgeAvailable(mc, opts),
  builds: (mc, opts) => neoforgeBuilds(mc, opts),
  pick: (builds, wanted = null) => pickNeoforge(builds, wanted),
  versionId: (mc, build) => neoforgeVersionId(mc, build),
  isInstalled: (mc, build) => neoforgeInstalled(mc, build),
  ensureInstalled: async (mc, build, opts = {}) => ensureNeoforgeVersion(mc, build, opts),
  finishInstall: async (mc, build, opts = {}) => finishNeoforge(mc, build, opts),
  afterInstall: null,
}

// Forge from Minecraft 1.13 on, by the same engine; on a Java 8 version it runs on Java 8 only.
const forge = {
  id: 'forge',
  name: 'Forge',
  gameVersions: (opts) => forgeGameVersions(opts),
  available: (mc, list) => forgeAvailable(mc, list),
  assertAvailable: (mc, opts) => assertForgeAvailable(mc, opts),
  builds: (mc, opts) => forgeBuilds(mc, opts),
  pick: (builds, wanted = null) => pickForge(builds, wanted),
  versionId: (mc, build) => forgeVersionId(mc, build),
  isInstalled: (mc, build) => forgeInstalled(mc, build),
  ensureInstalled: async (mc, build, opts = {}) => ensureForgeVersion(mc, build, opts),
  finishInstall: async (mc, build, opts = {}) => finishForge(mc, build, opts),
  narrowJava: (requirement) => forgeJava(requirement),
  afterInstall: null,
}

const MODULES = { fabric, quilt, forge, neoforge }

// Every loader id a setup may name, vanilla first.
export const LOADERS = ['vanilla', ...Object.keys(MODULES)]

// The module for a loader id; null for vanilla. An id not in LOADERS is a mistake in the caller
// (a setup's loader is checked when it is saved).
export function loaderFor(id) {
  if (id === 'vanilla' || id === undefined || id === null) return null
  const mod = MODULES[id]
  if (!mod) throw new Error(`unknown loader "${id}"`)
  return mod
}

// Which loaders build for each version, from their game lists read side by side: { fabric: true,
// quilt: false } per id, a loader whose list could not be read null. refresh asks them again now.
export async function loaderLists({ force = false } = {}) {
  const ids = Object.keys(MODULES)
  const lists = await Promise.all(ids.map((id) => MODULES[id].gameVersions({ force }).catch(() => null)))
  return Object.fromEntries(ids.map((id, i) => [id, lists[i]]))
}

export function loadersFor(mc, lists) {
  const out = {}
  for (const [id, list] of Object.entries(lists)) {
    let has = null
    try { if (list) has = MODULES[id].available(mc, list) } catch { /* unknown */ }
    out[id] = has
  }
  return out
}
