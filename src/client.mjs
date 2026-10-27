import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PROFILES_FILE, profileDir, versionJson, clientLog, clientRunDir, clientCacheDir, clientLaunchLock } from './client-paths.mjs'
import { readJson, writeJson, fail, validateName, acquireLock, lockHolder } from './util.mjs'
import { parseMemoryGb } from './registry.mjs'
import { pickJava, requiredMajor } from './java.mjs'
import { ensureVersion } from './client-install.mjs'
import { mergeInherited, fetchManifest, fetchVersionJson, currentOs, platformRefusal } from './client-meta.mjs'
import { buildCommand, spawnClient, readClientState, stopClient } from './client-launch.mjs'
import { offlineAccount, defaultPlayerName, accountFor } from './client-auth.mjs'
import { loaderVersions, pickLoader, fabricVersionId, ensureFabricProfile, ensureFabricApi } from './client-fabric.mjs'
import { harnessFor, HARNESS_RELEASES, ensureHarnessJar, readHarnessFile, removeHarnessFile, connectHarness, waitForHarness } from './client-harness.mjs'
import { checkInstance, REFUSED_CONSOLE, commandVerb } from './bots.mjs'

export const LOADERS = ['vanilla', 'fabric']
export const DEFAULT_MEMORY = '2G'

const PROFILE_KEYS = ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness', 'server', 'account', 'assistantAccount']

function validateMc(mc) {
  if (!/^\d+(\.\d+){1,2}$/.test(mc) && !/^\d{2}w\d{2}[a-z]$/.test(mc)) {
    fail(`invalid Minecraft version "${mc}" - use e.g. 1.21.4 or 25w14a`)
  }
}

function validateFields({ mc, loader, loaderVersion, java, memory, harness, server, account, assistantAccount }) {
  validateMc(mc)
  parseMemoryGb(memory)
  // -Xmx takes whole units only: 1.5G is refused by Java where a server's launcher would round it
  if (!/^\d+[MG]$/i.test(String(memory))) fail(`memory must be a whole number of M or G, like 2G or 1536M, not "${memory}"`)
  if (!LOADERS.includes(loader)) {
    fail(`unknown loader "${loader}" - use ${LOADERS.join(' or ')}`)
  }
  if (typeof harness !== 'boolean') fail('harness must be true or false')
  if (typeof assistantAccount !== 'boolean') fail('assistantAccount must be true or false')
  if (harness && loader === 'vanilla') {
    fail('the harness mod needs the fabric loader')
  }
  for (const [key, value] of Object.entries({ loaderVersion, java, server, account })) {
    if (value !== null && (typeof value !== 'string' || !value.trim())) fail(`${key} must be text or null`)
  }
  // the loader version becomes part of a folder name under versions/
  if (loaderVersion !== null && !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(loaderVersion)) {
    fail(`loaderVersion "${loaderVersion}" must be a version like 0.16.9 (letters, digits, dots, +, _ and -)`)
  }
}

// The same rule as a server name, worded for a profile.
function validateProfileName(name) {
  try {
    validateName(name)
  } catch {
    fail(`invalid profile name "${name}" - use letters, digits, dash, underscore (max 32 chars)`)
  }
}

export function loadProfiles() {
  const data = readJson(PROFILES_FILE, null) ?? { version: 1, profiles: {} }
  if (!data.profiles) data.profiles = {}
  return data
}

export function saveProfiles(data) {
  writeJson(PROFILES_FILE, data)
}

// Profiles written before the key existed read as false: an assistant may not play as a
// Microsoft account unless someone said so for that profile.
function withDefaults(cfg) {
  return { assistantAccount: false, ...cfg }
}

export function listProfiles() {
  const reg = loadProfiles()
  return Object.entries(reg.profiles)
    .map(([name, cfg]) => ({ name, ...withDefaults(cfg) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getProfile(name) {
  validateProfileName(name)
  const reg = loadProfiles()
  const cfg = Object.hasOwn(reg.profiles, name) ? reg.profiles[name] : null
  if (!cfg) {
    const known = Object.keys(reg.profiles)
    fail(
      `no profile named "${name}"` +
        (known.length ? `. Known profiles: ${known.join(', ')}` : '. Create one with: spawnloft client new <name> --mc <version>'),
    )
  }
  return { name, ...withDefaults(cfg) }
}

// assistantAccount starts false for every profile, whoever made it; only `set` turns it on.
export function createProfile(name, { mc, loader = 'vanilla', loaderVersion = null, java = null, memory = DEFAULT_MEMORY, harness = false, server = null, account = null }) {
  validateProfileName(name)
  const reg = loadProfiles()
  const lower = name.toLowerCase()
  for (const existing of Object.keys(reg.profiles)) {
    if (existing.toLowerCase() === lower) {
      fail(`a profile named "${existing}" already exists (names must differ in more than case)`)
    }
  }
  const assistantAccount = false
  validateFields({ mc, loader, loaderVersion, java, memory, harness, server, account, assistantAccount })
  fs.mkdirSync(profileDir(name), { recursive: true })
  const optionsFile = path.join(profileDir(name), 'options.txt')
  if (!fs.existsSync(optionsFile)) {
    fs.writeFileSync(optionsFile, 'lang:en_us\n')
  }
  const profile = { mc, loader, loaderVersion, java, memory, harness, server, account, assistantAccount, createdAt: new Date().toISOString() }
  reg.profiles[name] = profile
  saveProfiles(reg)
  return { name, ...profile }
}

export function updateProfile(name, patch) {
  validateProfileName(name)
  for (const key of Object.keys(patch)) {
    if (!PROFILE_KEYS.includes(key)) {
      fail(`unknown profile key "${key}" - use ${PROFILE_KEYS.join(', ')}`)
    }
  }
  const existing = getProfile(name)
  const merged = { ...existing, ...patch }
  validateFields(merged)
  const reg = loadProfiles()
  reg.profiles[name] = { ...reg.profiles[name], ...patch }
  saveProfiles(reg)
  return { name, ...withDefaults(reg.profiles[name]) }
}

export function removeProfile(name, { purge = false } = {}) {
  if (status(name).running) fail(`profile "${name}" is running; stop it first: spawnloft client stop ${name}`)
  getProfile(name)
  // Under the launch lock, so a launch that passed getProfile cannot recreate the run folder
  // after the purge.
  const release = acquireLock(clientLaunchLock(name), { mode: 'fail' })
  if (!release) fail(`profile "${name}" is being launched (pid ${holderText(name)}); wait for it`)
  try {
    const reg = loadProfiles()
    delete reg.profiles[name]
    saveProfiles(reg)
    if (purge) fs.rmSync(profileDir(name), { recursive: true, force: true })
  } finally {
    release()
  }
  if (purge) fs.rmSync(clientRunDir(name), { recursive: true, force: true })
}

function holderText(name) {
  const holder = lockHolder(clientLaunchLock(name))
  return holder === null || holder === -1 ? '?' : String(holder)
}

export async function prepareVersion(name, { onProgress = () => {} } = {}) {
  const profile = getProfile(name)
  if (!fs.existsSync(versionJson(profile.mc))) {
    const cacheDir = clientCacheDir(name)
    const manifest = await fetchManifest({ cacheDir })
    await fetchVersionJson(profile.mc, { manifest, cacheDir })
  }
  if (profile.loader === 'fabric') {
    let loaderVersion = profile.loaderVersion
    if (loaderVersion === null) {
      const list = await loaderVersions(profile.mc)
      loaderVersion = pickLoader(list).version
      updateProfile(name, { loaderVersion })
    }
    await ensureFabricProfile(profile.mc, loaderVersion)
    return fabricVersionId(profile.mc, loaderVersion)
  }
  return profile.mc
}

export async function launch(name, opts = {}) {
  getProfile(name)
  // Taken before anything else, released once state.json names the new process (or on any
  // failure), so a second launch of the same profile during the downloads is refused instead of
  // overwriting the first one's state and truncating its log. A lock whose holder has died is
  // taken over (see acquireLock); one held by this very process counts as held, which is the
  // panel's two Play clicks.
  const release = acquireLock(clientLaunchLock(name), { mode: 'fail' })
  if (!release) fail(`profile "${name}" is being launched (pid ${holderText(name)}); wait for it`)
  try {
    return await launchLocked(name, opts)
  } finally {
    release()
  }
}

// `assistant: true` marks a launch asked for by an AI assistant (the MCP tool): playing as a
// Microsoft account is then allowed only on a profile whose assistantAccount key says so.
async function launchLocked(name, { playerName = null, account: accountSelector = null, server = null, onProgress = () => {}, fakeJava = null, assistant = false, os = currentOs() }) {
  const profile = getProfile(name)
  const st = status(name)
  if (st.running) {
    fail(`profile "${name}" is already running (pid ${st.pid}); stop it first`)
  }
  // a machine Mojang never built for is refused before Java is looked for or anything downloads
  const machineRefusal = platformRefusal(null, os)
  if (machineRefusal) fail(machineRefusal)
  if (profile.harness && !harnessFor(profile.mc)) {
    fail('the harness mod is published for Minecraft ' + HARNESS_RELEASES.map(r => r.minecraft).join(', ') + ', not ' + profile.mc + '; set harness=false on the profile or use one of those versions')
  }

  const java = fakeJava ?? await pickJava({ explicit: profile.java, needs: requiredMajor(profile.mc), what: 'Minecraft ' + profile.mc })

  let versionId
  if (fakeJava) {
    if (profile.loader === 'fabric') {
      if (profile.loaderVersion === null) {
        fail(`profile "${name}" uses the fabric loader but has no loaderVersion; set one with spawnloft client set`)
      }
      versionId = fabricVersionId(profile.mc, profile.loaderVersion)
    } else {
      versionId = profile.mc
    }
    if (!fs.existsSync(versionJson(versionId))) {
      versionId = await prepareVersion(name, { onProgress })
      await ensureVersion(versionId, { os, onProgress })
    }
  } else {
    versionId = await prepareVersion(name, { onProgress })
    await ensureVersion(versionId, { os, onProgress })
    if (profile.loader === 'fabric') await ensureFabricApi(name, profile.mc, { onProgress })
    if (profile.harness) await ensureHarnessJar(name, profile.mc, { onProgress })
  }

  let version = JSON.parse(fs.readFileSync(versionJson(versionId), 'utf8'))
  if (version.inheritsFrom) {
    const parentJson = JSON.parse(fs.readFileSync(versionJson(version.inheritsFrom), 'utf8'))
    version = mergeInherited(version, parentJson)
  }
  // ensureVersion refuses too, but an installed version can skip it (the fakeJava path)
  const versionRefusal = platformRefusal(version, os)
  if (versionRefusal) fail(versionRefusal)

  // --as names an offline player; a signed-in account brings its own name. Both at once is a
  // contradiction, not a preference.
  const selector = accountSelector ?? profile.account ?? null
  if (playerName && selector) fail('use either --as <player name> or --account <account>, not both')
  if (assistant && selector && !selector.startsWith('offline:') && !profile.assistantAccount) {
    fail(assistantAccountRefusal(name))
  }
  const account = selector ? await accountFor(selector) : offlineAccount(playerName ?? defaultPlayerName(name))
  const harnessToken = profile.harness ? crypto.randomBytes(16).toString('hex') : null
  // a file from a crashed run would otherwise be read as this run's, before the mod replaces it
  if (harnessToken) removeHarnessFile(name)
  const command = buildCommand({ version, profile: { ...profile, server: server ?? profile.server }, profileName: name, account, java, os, harnessToken })
  const { pid } = await spawnClient(command, { name, state: { mode: account.type, account, harness: harnessToken ? { token: harnessToken, port: null } : null } })

  return { pid, profile, version: versionId, account: { type: account.type, name: account.name } }
}

export function assistantAccountRefusal(name) {
  return `profile "${name}" plays as a Microsoft account; allow an assistant to launch it with: spawnloft client set ${name} assistantAccount=true`
}

export function status(name) {
  getProfile(name)
  const st = readClientState(name)
  return {
    name,
    running: Boolean(st),
    pid: st?.pid ?? null,
    startedAt: st?.startedAt ?? null,
    uptimeMs: st ? Date.now() - Date.parse(st.startedAt) : null,
    account: st?.account ?? null,
    harness: st?.harness ? { port: readHarnessFile(name, { pid: st.pid })?.port ?? null } : null,
  }
}

const sessions = new Map()

export async function session(name) {
  const st = readClientState(name)
  if (!st) {
    fail('profile "' + name + '" is not running; launch it first: spawnloft client launch ' + name)
  }
  if (!st.harness) {
    fail('profile "' + name + '" was launched without the harness; set harness=true on a fabric profile (spawnloft client set ' + name + ' harness=true) and launch it again')
  }
  const cached = sessions.get(name)
  if (cached && cached.pid === st.pid) {
    return cached.channel
  }
  const channel = await waitForHarness(name, st.harness.token, { timeout: 90000, alive: () => status(name).running, pid: st.pid })
  sessions.set(name, { pid: st.pid, channel })
  return channel
}

async function viaSession(name, fn) {
  const channel = await session(name)
  try {
    return await fn(channel)
  } catch (err) {
    if (/went away/.test(err.message)) sessions.delete(name)
    throw err
  }
}

export async function join(name, server) {
  const check = checkInstance(server)
  // The offline-mode rule is for players without an account; a signed-in one may join an online server.
  const signedIn = status(name).account?.type === 'microsoft'
  const problems = check.problems.filter((p) => !(signedIn && /runs in online mode/.test(p)))
  if (problems.length) fail(problems.join(' '))
  const host = check.host
  const port = check.inst.port
  const result = await viaSession(name, (ch) => ch.call('join', { host, port }, { timeout: 65000 }))
  return { ...result, server, host, port }
}

export async function chat(name, text) {
  if (typeof text !== 'string' || text.trim() === '') fail('chat needs text')
  if (text.startsWith('/') && REFUSED_CONSOLE.has(commandVerb(text))) {
    fail('"' + commandVerb(text) + '" would take the server down or half-reload it; a client cannot run it, send it from the console if you mean it')
  }
  return viaSession(name, (ch) => ch.call('chat', { text }))
}

export async function messages(name, since = 0) {
  return viaSession(name, (ch) => ch.call('messages', { since }))
}

export async function screenshot(name) {
  return viaSession(name, (ch) => ch.call('screenshot'))
}

export async function player(name) {
  return viaSession(name, (ch) => ch.call('player'))
}

export async function screen(name) {
  return viaSession(name, (ch) => ch.call('screen'))
}

export async function disconnect(name) {
  return viaSession(name, (ch) => ch.call('disconnect'))
}

async function quitViaHarness(name, st) {
  const cached = sessions.get(name)
  let channel
  if (cached && cached.pid === st.pid) {
    channel = cached.channel
  } else {
    const info = readHarnessFile(name, { pid: st.pid })
    if (!info) fail('the harness file is missing; the game may still be loading')
    channel = await connectHarness(name, st.harness.token, { timeout: 3000, pid: st.pid })
  }
  await channel.call('quit', {}, { timeout: 5000 })
  channel.close()
  sessions.delete(name)
}

export async function stop(name) {
  getProfile(name)
  const st = readClientState(name)
  const quit = st?.harness ? () => quitViaHarness(name, st) : null
  const res = await stopClient(name, { quit })
  sessions.delete(name)
  return res
}

export function tailClientLog(name, count = 100) {
  const file = clientLog(name)
  if (!fs.existsSync(file)) return []
  const size = fs.statSync(file).size
  const readBytes = Math.min(size, Math.max(64 * 1024, count * 512))
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(readBytes)
  fs.readSync(fd, buf, 0, readBytes, size - readBytes)
  fs.closeSync(fd)
  const lines = buf.toString('utf8').split(/\r?\n/)
  if (size > readBytes && lines.length) lines.shift()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-count)
}

export function latestLogPath(name) {
  return path.join(profileDir(name), 'logs', 'latest.log')
}
