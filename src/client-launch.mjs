import fs from 'node:fs'
import path from 'node:path'

import { currentOs, jvmArguments, gameArguments, libraries, assetIndex } from './client-meta.mjs'
import { LIBRARIES_DIR, ASSETS_DIR, profileDir, versionJar, nativesDir } from './client-paths.mjs'
import { getInstance } from './registry.mjs'
import { boundAddress } from './exposure.mjs'

export function substitute(template, vars) {
  const unknown = []
  const text = template.replace(/\$\{(\w+)\}/g, (match, name) => {
    if (Object.hasOwn(vars, name)) return String(vars[name])
    if (!unknown.includes(name)) unknown.push(name)
    return match
  })
  return { text, unknown }
}

export function buildCommand({ version, profile, profileName, account, java, os = currentOs(), harnessToken = null }) {
  const hasServer = Boolean(profile.server)

  let host = null
  let port = null
  if (hasServer) {
    const inst = getInstance(profile.server)
    const ip = boundAddress(inst.dir)
    host = (ip === '' || ip === '0.0.0.0' || ip === '::') ? '127.0.0.1' : ip
    port = inst.port
  }

  const features = {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: hasServer,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: hasServer,
    is_quick_play_realms: false,
  }

  // ensureVersion puts every version's jar under its own id, a loader profile's included
  const clientJar = versionJar(version.id)
  const natDir = nativesDir(version.id)

  const nonNative = []
  const seen = new Set()
  for (const row of libraries(version, { os })) {
    if (row.native !== false) continue
    const p = path.join(LIBRARIES_DIR, row.path)
    if (!seen.has(p)) {
      seen.add(p)
      nonNative.push(p)
    }
  }
  const classpath = [...nonNative, clientJar].join(path.delimiter)

  const launcherVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

  const vars = {
    classpath,
    library_directory: LIBRARIES_DIR,
    classpath_separator: path.delimiter,
    natives_directory: natDir,
    game_directory: profileDir(profileName),
    assets_root: ASSETS_DIR,
    assets_index_name: assetIndex(version).id,
    version_name: version.id,
    version_type: version.type ?? 'release',
    launcher_name: 'SpawnLoft',
    launcher_version: launcherVersion,
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken,
    clientid: account.clientId,
    auth_xuid: account.xuid,
    user_type: account.userType,
  }

  if (hasServer) {
    vars.quickPlayMultiplayer = `${host}:${port}`
  }

  const jvmArgs = jvmArguments(version, { os, features }).map((a) => substitute(a, vars).text)
  const gameArgs = gameArguments(version, { os, features }).map((a) => substitute(a, vars).text)

  // Pre-1.20 versions have no ${quickPlayMultiplayer} rule, so the join target goes the old way.
  const rawGame = JSON.stringify(version.arguments?.game ?? version.minecraftArguments ?? '')
  if (hasServer && !rawGame.includes('${quickPlayMultiplayer}')) {
    gameArgs.push('--server', host, '--port', String(port))
  }

  const args = [...jvmArgs, `-Xmx${profile.memory}`]
  if (typeof harnessToken === 'string' && harnessToken !== '') {
    args.push(`-Dspawnloft.harness.token=${harnessToken}`)
  }
  args.push(version.mainClass)
  args.push(...gameArgs)

  return { bin: java, args, cwd: profileDir(profileName), env: { ...process.env } }
}
