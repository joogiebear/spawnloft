import fs from 'node:fs'
import path from 'node:path'
import { PROFILES_FILE, profileDir, versionJson, clientLog, clientRunDir } from './client-paths.mjs'
import { readJson, writeJson, fail, validateName } from './util.mjs'
import { parseMemoryGb } from './registry.mjs'
import { pickJava, requiredMajor } from './java.mjs'
import { ensureVersion } from './client-install.mjs'
import { mergeInherited } from './client-meta.mjs'
import { buildCommand, spawnClient, readClientState, stopClient } from './client-launch.mjs'
import { offlineAccount, defaultPlayerName } from './client-auth.mjs'

export const LOADERS = ['vanilla', 'fabric']
export const DEFAULT_MEMORY = '2G'

const PROFILE_KEYS = ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness', 'server']

function validateMc(mc) {
  if (!/^\d+(\.\d+){1,2}$/.test(mc) && !/^\d{2}w\d{2}[a-z]$/.test(mc)) {
    fail(`invalid Minecraft version "${mc}" - use e.g. 1.21.4 or 25w14a`)
  }
}

function validateFields({ mc, loader, loaderVersion, java, memory, harness, server }) {
  validateMc(mc)
  parseMemoryGb(memory)
  // -Xmx takes whole units only: 1.5G is refused by Java where a server's launcher would round it
  if (!/^\d+[MG]$/i.test(String(memory))) fail(`memory must be a whole number of M or G, like 2G or 1536M, not "${memory}"`)
  if (!LOADERS.includes(loader)) {
    fail(`unknown loader "${loader}" - use ${LOADERS.join(' or ')}`)
  }
  if (typeof harness !== 'boolean') fail('harness must be true or false')
  if (harness && loader === 'vanilla') {
    fail('the harness mod needs the fabric loader')
  }
  for (const [key, value] of Object.entries({ loaderVersion, java, server })) {
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

export function listProfiles() {
  const reg = loadProfiles()
  return Object.entries(reg.profiles)
    .map(([name, cfg]) => ({ name, ...cfg }))
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
  return { name, ...cfg }
}

export function createProfile(name, { mc, loader = 'vanilla', loaderVersion = null, java = null, memory = DEFAULT_MEMORY, harness = false, server = null }) {
  validateProfileName(name)
  const reg = loadProfiles()
  const lower = name.toLowerCase()
  for (const existing of Object.keys(reg.profiles)) {
    if (existing.toLowerCase() === lower) {
      fail(`a profile named "${existing}" already exists (names must differ in more than case)`)
    }
  }
  validateFields({ mc, loader, loaderVersion, java, memory, harness, server })
  fs.mkdirSync(profileDir(name), { recursive: true })
  const optionsFile = path.join(profileDir(name), 'options.txt')
  if (!fs.existsSync(optionsFile)) {
    fs.writeFileSync(optionsFile, 'lang:en_us\n')
  }
  const profile = { mc, loader, loaderVersion, java, memory, harness, server, createdAt: new Date().toISOString() }
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
  return { name, ...reg.profiles[name] }
}

export function removeProfile(name, { purge = false } = {}) {
  if (status(name).running) fail(`profile "${name}" is running; stop it first: spawnloft client stop ${name}`)
  getProfile(name)
  const reg = loadProfiles()
  delete reg.profiles[name]
  saveProfiles(reg)
  if (purge) {
    fs.rmSync(profileDir(name), { recursive: true, force: true })
    fs.rmSync(clientRunDir(name), { recursive: true, force: true })
  }
}

export async function launch(name, { playerName = null, server = null, onProgress = () => {}, fakeJava = null } = {}) {
  const profile = getProfile(name)
  const st = status(name)
  if (st.running) {
    fail(`profile "${name}" is already running (pid ${st.pid}); stop it first`)
  }

  const java = fakeJava ?? await pickJava({ explicit: profile.java, needs: requiredMajor(profile.mc), what: 'Minecraft ' + profile.mc })

  let versionId
  if (profile.loader === 'fabric') {
    if (profile.loaderVersion === null) {
      fail(`profile "${name}" uses the fabric loader but has no loaderVersion; set one with spawnloft client set`)
    }
    versionId = `fabric-loader-${profile.loaderVersion}-${profile.mc}`
  } else {
    versionId = profile.mc
  }

  if (!(fakeJava && fs.existsSync(versionJson(versionId)))) {
    await ensureVersion(versionId, { onProgress })
  }
  let version = JSON.parse(fs.readFileSync(versionJson(versionId), 'utf8'))
  if (version.inheritsFrom) {
    const parentJson = JSON.parse(fs.readFileSync(versionJson(version.inheritsFrom), 'utf8'))
    version = mergeInherited(version, parentJson)
  }

  const account = offlineAccount(playerName ?? defaultPlayerName(name))
  const command = buildCommand({ version, profile: { ...profile, server: server ?? profile.server }, profileName: name, account, java })
  const { pid } = await spawnClient(command, { name, state: { mode: 'offline', account, harness: null } })

  return { pid, profile, version: versionId, account: { type: account.type, name: account.name } }
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
    harness: st?.harness ? { port: st.harness.port } : null,
  }
}

export async function stop(name) {
  getProfile(name)
  return stopClient(name)
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
