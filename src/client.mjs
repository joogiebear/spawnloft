import fs from 'node:fs'
import path from 'node:path'
import { PROFILES_FILE, profileDir } from './client-paths.mjs'
import { readJson, writeJson, fail, validateName } from './util.mjs'
import { parseMemoryGb } from './registry.mjs'

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
  getProfile(name)
  const reg = loadProfiles()
  delete reg.profiles[name]
  saveProfiles(reg)
  if (purge) {
    fs.rmSync(profileDir(name), { recursive: true, force: true })
  }
}
