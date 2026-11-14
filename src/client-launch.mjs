import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

import { currentOs, jvmArguments, gameArguments, libraries, assetIndex, loggingConfig, log4jNoLookupsNeeded } from './client-meta.mjs'
import { launchFeatures } from './client-version.mjs'
import { LIBRARIES_DIR, ASSETS_DIR, profileDir, versionJar, nativesDir, clientRunDir, clientStateFile, clientLastExit, clientPlayed, clientLog, logConfigPath } from './client-paths.mjs'
import { getInstance } from './registry.mjs'
import { boundAddress } from './exposure.mjs'
import { writeJson, readJson, fail, UserError, pidAlive, sameProcess, killProcessGroup, sleep, PRIVATE_FILE_MODE } from './util.mjs'

export function substitute(template, vars) {
  const unknown = []
  const text = template.replace(/\$\{(\w+)\}/g, (match, name) => {
    if (Object.hasOwn(vars, name)) return String(vars[name])
    if (!unknown.includes(name)) unknown.push(name)
    return match
  })
  return { text, unknown }
}

export const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
export const IPV6 = /^[0-9A-Fa-f:.]+$/

// A host the game's command line can carry: a name, an IPv4 address or an IPv6 one (unbracketed).
export function validHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253) return false
  return host.includes(':') ? IPV6.test(host) : HOSTNAME.test(host)
}

// Where the game finds a SpawnLoft server on this machine: the server-ip in its server.properties,
// or 127.0.0.1 when it listens on every interface. Checked here because the game's quick play
// shows any address it cannot parse (a port that is not a number turns the whole address into
// one) or look up as "Unknown host", long after the launch has gone through.
export function localJoinAddress(inst) {
  const port = Number(inst.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`server "${inst.name}" has no usable port (${JSON.stringify(inst.port ?? null)}), so the game would have no address to join; give it a port in the server's settings`)
  }
  const ip = boundAddress(inst.dir).replace(/^\[(.*)\]$/, '$1')
  const host = (ip === '' || ip === '0.0.0.0' || ip === '::') ? '127.0.0.1' : ip
  if (!validHost(host)) {
    fail(`server "${inst.name}" has server-ip=${ip} in its server.properties, which is not an address the game can join; clear it (server-ip=) so the server listens on every interface`)
  }
  return { host, port }
}

// `address` ({ host, port }, from parseServerAddress) joins a server SpawnLoft does not run, in
// place of the profile's server.
// `assetsDir` is the tree an older asset layout was laid out in (materialiseAssets), which
// ${game_assets} names; null for the objects layout, which the game reads from assets/ itself.
export function buildCommand({ version, profile, profileName, account, java, os = currentOs(), harnessToken = null, address = null, assetsDir = null }) {
  const hasServer = Boolean(address || profile.server)

  let host = null
  let port = null
  if (address) {
    host = address.host
    port = address.port
  } else if (hasServer) {
    ;({ host, port } = localJoinAddress(getInstance(profile.server)))
  }

  const features = launchFeatures({ hasServer })

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
    // the minecraftArguments era's: the session as Mojang's launcher wrote it (an offline
    // player's access token is "0"), the assets folder the game reads, and no Twitch properties
    auth_session: `token:${account.accessToken}:${account.uuid}`,
    game_assets: assetsDir ?? ASSETS_DIR,
    user_properties: '{}',
  }

  if (hasServer) {
    vars.quickPlayMultiplayer = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
    // has_quick_plays_support also enables --quickPlayPath, the game's quick-play log
    vars.quickPlayPath = path.join(clientRunDir(profileName), 'quickPlay.json')
  }

  const jvmArgs = jvmArguments(version, { os, features }).map((a) => substitute(a, vars).text)
  // Log4Shell: the config file ensureVersion fetched, and the lookup switch for the log4j
  // versions that honour it (see loggingConfig). ${path} is this argument's own variable.
  const logCfg = loggingConfig(version)
  if (logCfg) jvmArgs.push(substitute(logCfg.argument, { path: logConfigPath(logCfg.id) }).text)
  if (log4jNoLookupsNeeded(version)) jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true')
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
  // window from appearing (the game's own window is unaffected). The log holds one run: a
  // diagnosis of this launch must not find the last one's errors.
  const fd = fs.openSync(clientLog(name), 'w')
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
  // How it ended is written down first: the exit code is the one fact that says "crashed" for
  // sure, and it is gone the moment this handler returns. Only the process that started the game
  // hears it (a panel that was restarted, or a CLI launch, does not), so a missing or older
  // record means "not known", and the log is still the fallback for those.
  // set when the state is written; Stop removes the state file before this handler runs
  let startedAt = null
  // a Stop mark left by a game this process never heard exit must not be read as this one's
  if (child.pid) {
    stopAsked.delete(child.pid)
    try { fs.rmSync(stopMark(name), { force: true }) } catch { /* only a mark */ }
  }
  child.on('exit', (code, signal) => {
    const mine = readJson(clientStateFile(name), null)?.pid === child.pid
    if (startedAt) notePlayed(name, (rec) => ({ ...rec, totalMs: rec.totalMs + Math.max(0, Date.now() - Date.parse(startedAt)) }))
    try {
      writeJson(clientLastExit(name), {
        pid: child.pid,
        code: code ?? null,
        signal: signal ?? null,
        startedAt,
        endedAt: new Date().toISOString(),
        // Stop was pressed (stopClient left its mark): however the process ended, it was asked to
        stopped: stopAsked.delete(child.pid) || readJson(stopMark(name), null)?.pid === child.pid,
      })
    } catch { /* a record, not a requirement */ }
    fs.rmSync(stopMark(name), { force: true })
    if (mine) fs.rmSync(clientStateFile(name), { force: true })
  })

  return new Promise((resolve, reject) => {
    child.on('spawn', () => {
      // The state carries the harness token: owner-only, like the accounts file.
      startedAt = new Date().toISOString()
      writeJson(clientStateFile(name), {
        pid: child.pid,
        // javaExe lets readClientState tell this process from a later owner of the same pid
        javaExe: path.basename(cmd),
        startedAt,
        mode: state.mode ?? 'offline',
        account: { type: state.account.type, name: state.account.name },
        javaPid: child.pid,
        // Linux: the process's own start time, which a later owner of the same pid cannot share
        procStart: procStartTicks(child.pid),
        harness: state.harness ?? null,
        server: state.server ?? null,
        address: state.address ?? null,
        // who asked for this run: launcher, panel, cli or assistant
        launchedBy: state.launchedBy ?? null,
        // the version's Java, arch and folders as launch decided them (client-version)
        launch: state.launch ?? null,
      }, { mode: PRIVATE_FILE_MODE })
      notePlayed(name, (rec) => ({ ...rec, lastPlayedAt: startedAt, launches: rec.launches + 1 }))
      child.unref()
      resolve({ pid: child.pid, child })
    })
    child.on('error', (err) => reject(new UserError('could not start ' + command.bin + ': ' + err.message)))
  })
}

// pids this process asked to stop, and the same as a file for a stop asked by another process
// (the CLI stopping a game the panel started)
const stopAsked = new Set()
const stopMark = (name) => path.join(clientRunDir(name), 'stop-asked.json')

// When a profile was last played, how many times, and for how long in all. The time is added
// when the game exits, by the process that started it: a game started by a CLI command that has
// since ended counts as a launch and adds no time.
export function readPlayed(name) {
  let rec = null
  try { rec = readJson(clientPlayed(name), null) } catch { /* unreadable: starts again */ }
  // no record yet (a profile older than the record): the last game known to have ended says when
  const known = typeof rec?.lastPlayedAt === 'string' ? rec.lastPlayedAt : readLastExit(name)?.startedAt
  return {
    lastPlayedAt: typeof known === 'string' ? known : null,
    totalMs: Number.isFinite(rec?.totalMs) && rec.totalMs > 0 ? rec.totalMs : 0,
    launches: Number.isInteger(rec?.launches) && rec.launches > 0 ? rec.launches : 0,
  }
}

function notePlayed(name, change) {
  try { writeJson(clientPlayed(name), change(readPlayed(name))) } catch { /* a record, not a requirement */ }
}

// The last recorded exit of a profile's game, or null: { pid, code, signal, startedAt, endedAt, stopped }.
export function readLastExit(name) {
  try {
    const rec = readJson(clientLastExit(name), null)
    return rec && typeof rec === 'object' && typeof rec.endedAt === 'string' ? rec : null
  } catch {
    return null
  }
}

// Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. The command
// name (field 2) may hold spaces and brackets, so the fields are counted from the last ")".
export function procStartTicks(pid, read = fs.readFileSync) {
  if (process.platform !== 'linux') return null
  try {
    const stat = String(read(`/proc/${pid}/stat`, 'utf8'))
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return /^\d+$/.test(ticks ?? '') ? ticks : null
  } catch {
    return null
  }
}

// Whether a state file written before this machine last started: no process outlives a reboot,
// but its pid is handed out again, quite possibly to a SpawnLoft server's Java, which has the
// same image name as the game's. A minute's slack covers a clock set at boot.
export function fromBeforeBoot(startedAt, { now = Date.now(), uptime = os.uptime() } = {}) {
  const at = Date.parse(startedAt)
  return Number.isFinite(at) && at < now - uptime * 1000 - 60000
}

function stateAlive(state) {
  if (!pidAlive(state.pid)) return false
  // Where the process's own start time can be read it decides, both ways: the same pid with
  // another start time is another process, and the same start time is this game whatever the
  // wall clock has done since (a VM resumed, a clock corrected by hours).
  const ticks = state.procStart ? procStartTicks(state.pid) : null
  if (ticks) {
    if (ticks !== state.procStart) return false
  } else if (fromBeforeBoot(state.startedAt)) {
    return false
  }
  return sameProcess(state.pid, state.javaExe, Date.parse(state.startedAt) || 0)
}

export function readClientState(name) {
  const file = clientStateFile(name)
  const state = readJson(file, null)
  if (state === null) return null
  if (stateAlive(state)) return state
  // Another launch may have written its own state between the read and this delete; only a
  // file that still names the dead pid is ours to clear.
  if (readJson(file, null)?.pid === state.pid) fs.rmSync(file, { force: true })
  return null
}

function askToClose(pid) {
  if (process.platform === 'win32') {
    // Without /F taskkill sends WM_CLOSE, which the game treats as its window closing.
    return new Promise((resolve) => {
      const ask = spawn('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' })
      ask.on('error', () => resolve(false))
      ask.on('exit', (code) => resolve(code === 0))
    })
  }
  try {
    process.kill(-pid, 'SIGTERM')
    return Promise.resolve(true)
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
      return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
  }
}

function forceKill(pid) {
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    kill.on('error', () => {})
  } else {
    killProcessGroup(pid)
  }
}

async function waitGone(state, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && stateAlive(state)) await sleep(100)
  return !stateAlive(state)
}

export async function stopClient(name, { timeout = 10000, quit = null } = {}) {
  const state = readClientState(name)
  if (state === null) return { stopped: false, wasRunning: false }

  // Politely first (the harness quit, else a close request so the JVM's shutdown hooks run),
  // then by force once the timeout passes.
  // for the exit record: this exit, however it comes, was asked for
  stopAsked.add(state.pid)
  try { writeJson(stopMark(name), { pid: state.pid, at: new Date().toISOString() }) } catch { /* the in-process mark still holds */ }
  let asked = false
  if (typeof quit === 'function') {
    try {
      await quit()
      asked = true
    } catch { /* a failed quit falls through to the close request */ }
  }
  if (!asked) asked = await askToClose(state.pid)
  let gone = asked ? await waitGone(state, timeout) : false
  if (!gone) {
    forceKill(state.pid)
    gone = await waitGone(state, 5000)
  }
  if (!gone) {
    stopAsked.delete(state.pid)
    fs.rmSync(stopMark(name), { force: true })
    return { stopped: false, wasRunning: true }
  }

  fs.rmSync(clientStateFile(name), { force: true })
  return { stopped: true, wasRunning: true }
}
