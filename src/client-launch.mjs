import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { currentOs, jvmArguments, gameArguments, libraries, assetIndex } from './client-meta.mjs'
import { LIBRARIES_DIR, ASSETS_DIR, profileDir, versionJar, nativesDir, clientRunDir, clientStateFile, clientLog } from './client-paths.mjs'
import { getInstance } from './registry.mjs'
import { boundAddress } from './exposure.mjs'
import { writeJson, readJson, UserError, pidAlive, killProcessGroup, sleep } from './util.mjs'

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

export async function spawnClient(command, { name, state }) {
  fs.mkdirSync(command.cwd, { recursive: true })
  fs.mkdirSync(clientRunDir(name), { recursive: true })

  let cmd
  let args
  let env
  if (/\.m?js$/i.test(command.bin)) {
    cmd = process.execPath
    args = [command.bin, ...command.args]
    env = { ...command.env, ELECTRON_RUN_AS_NODE: '1' }
  } else {
    cmd = command.bin
    args = command.args
    env = command.env
  }

  // The launcher may be a short-lived CLI command, so the game runs in its own session with its
  // output on a file descriptor rather than a pipe to us; windowsHide keeps java.exe's console
  // window from appearing (the game's own window is unaffected).
  const fd = fs.openSync(clientLog(name), 'a')
  let child
  try {
    child = spawn(cmd, args, {
      cwd: command.cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: true,
      env,
    })
  } finally {
    // spawn() has already duplicated the descriptor into the child.
    fs.closeSync(fd)
  }

  // A stopped client's exit event can arrive after the next launch wrote its own state; leave that one alone.
  child.on('exit', () => {
    if (readJson(clientStateFile(name), null)?.pid === child.pid) fs.rmSync(clientStateFile(name), { force: true })
  })

  return new Promise((resolve, reject) => {
    child.on('spawn', () => {
      writeJson(clientStateFile(name), {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        mode: state.mode ?? 'offline',
        account: { type: state.account.type, name: state.account.name },
        javaPid: child.pid,
        harness: state.harness ?? null,
      })
      child.unref()
      resolve({ pid: child.pid, child })
    })
    child.on('error', (err) => reject(new UserError('could not start ' + command.bin + ': ' + err.message)))
  })
}

export function readClientState(name) {
  const state = readJson(clientStateFile(name), null)
  if (state === null) return null
  if (!pidAlive(state.pid)) {
    fs.rmSync(clientStateFile(name), { force: true })
    return null
  }
  return state
}

export async function stopClient(name, { timeout = 10000, quit = null } = {}) {
  const state = readClientState(name)
  if (state === null) return { stopped: false, wasRunning: false }

  if (typeof quit === 'function') {
    try { await quit() } catch { /* a failed quit falls through to the kill */ }
    const deadline = Date.now() + timeout
    while (Date.now() < deadline && pidAlive(state.pid)) {
      await sleep(100)
    }
  }

  if (pidAlive(state.pid)) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true })
    } else {
      killProcessGroup(state.pid)
    }
    const killDeadline = Date.now() + 5000
    while (Date.now() < killDeadline && pidAlive(state.pid)) {
      await sleep(100)
    }
  }

  fs.rmSync(clientStateFile(name), { force: true })
  return { stopped: true, wasRunning: true }
}
