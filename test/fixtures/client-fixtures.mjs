// The client's fixtures from every era of Mojang's version JSONs, for the tests that run one
// piece of the launcher across all of them. client/README.md says where each file came from.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeInherited } from '../../src/client-meta.mjs'

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client')

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, ...parts), 'utf8'))

// One real JSON per era, oldest first, with what makes it the one to test.
export const ERAS = [
  { id: 'rd-132211', note: 'own mainClass, ${auth_session}, no --gameDir, pre-1.6 assets' },
  { id: 'a1.2.6', note: 'launchwrapper, pre-1.6 assets' },
  { id: 'b1.7.3', note: 'launchwrapper, pre-1.6 assets' },
  { id: '1.5.2', note: 'last pre-1.6 index, ${game_assets}' },
  { id: '1.6.4', note: 'no javaVersion, legacy (virtual) index, ${auth_session}' },
  { id: '1.7.2', note: '${game_assets} with the legacy index, first logging block' },
  { id: '1.7.10', note: 'own objects index, ${user_properties}, logging on launchermeta' },
  { id: '1.12.2', note: 'last minecraftArguments, LWJGL 2, natives-only rows' },
  { id: '1.14.4', note: 'first Fabric era, arguments, jre-legacy, map-form natives' },
  { id: '1.16.5', note: 'arguments, jre-legacy, map-form natives' },
  { id: '1.17.1', note: 'java-runtime-alpha (16), map-form natives' },
  { id: '1.18.2', note: 'java-runtime-beta (17), last map-form natives' },
  { id: '1.20.4', note: 'java-runtime-gamma (17), classifier natives, quick play' },
  { id: '1.21.11', note: 'java-runtime-delta (21), the version the V1a gate pins' },
  { id: '26.1', note: 'java-runtime-epsilon (25), os.versionRange in default-user-jvm' },
  { id: '26.3', note: 'natives under ${natives_directory}/java, no natives-windows-x86' },
  { id: '26.4-snapshot-6', note: 'a snapshot id, changed default-user-jvm' },
]

export const ERA_IDS = ERAS.map((e) => e.id)

// Fabric profiles: the real one for 1.21.11 and two derived from it (README).
export const FABRIC_PROFILES = {
  '1.21.11': 'fabric-profile.json',
  '26.3': 'fabric-profile-26.3.json',
  '1.14.4': 'fabric-profile-1.14.4.json',
}

// Every OS and arch the resolver is asked about; os.version is what os.release() answers there
// (the Darwin kernel on macOS, not the marketed version).
export const OS_PAIRS = [
  { name: 'windows', arch: 'x64', version: '10.0.22631' },
  { name: 'windows', arch: 'arm64', version: '10.0.22631' },
  { name: 'windows', arch: 'x86', version: '10.0.19045' },
  { name: 'osx', arch: 'arm64', version: '24.1.0' },
  { name: 'osx', arch: 'x64', version: '24.1.0' },
  { name: 'linux', arch: 'x64', version: '6.8.0-45-generic' },
  { name: 'linux', arch: 'arm64', version: '6.8.0-45-generic' },
]

export const pairName = (os) => `${os.name}-${os.arch}`

export function loadVersion(id) {
  if (!ERA_IDS.includes(id)) throw new Error(`no era fixture for "${id}"`)
  return read('versions', `${id}.json`)
}

export function loadFabricProfile(mc) {
  if (!Object.hasOwn(FABRIC_PROFILES, mc)) throw new Error(`no Fabric profile fixture for "${mc}"`)
  return read(FABRIC_PROFILES[mc])
}

// The Fabric profile merged onto its vanilla parent, as launch sees it.
export function loadFabricMerged(mc) {
  return mergeInherited(loadFabricProfile(mc), loadVersion(mc))
}

// Synthetic: a version that uses one of everything SpawnLoft cannot know yet (README).
export function loadFuture() {
  return read('future.json')
}

// objects, legacy, pre-1.6, bad (a ../ path), future-pack (an unknown layout flag)
export function loadAssetIndex(name) {
  return read('assets', `${name}.json`)
}

// Mojang's manifest cut down to the era ids and the odd id shapes.
export function loadErasManifest() {
  return read('version_manifest_eras.json')
}
