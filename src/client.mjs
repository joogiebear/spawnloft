import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { PROFILES_FILE, profileDir, versionJson, versionJar, versionsDir, clientLog, clientRunDir, CLIENT_CACHE_DIR, clientLaunchLock } from './client-paths.mjs'
import { readJson, writeJson, fail, validateName, acquireLock, lockHolder, sleep } from './util.mjs'
import { parseMemoryGb, getInstance, isDatabase } from './registry.mjs'
import { pickClientJava, requiredMajor } from './java.mjs'
import { ensureVersion } from './client-install.mjs'
import { mergeInherited, fetchManifest, fetchVersionJson, currentOs, platformRefusal, nativeArches } from './client-meta.mjs'
import { resolveVersion, resolvedRefusal, launchFeatures, isSafeVersionId, versionKind, javaRequirement } from './client-version.mjs'
import { buildCommand, spawnClient, readClientState, stopClient } from './client-launch.mjs'
import { offlineAccount, defaultPlayerName, accountFor, assertPlayerName, peekAccount, loadAccounts, findAccount, sameUuid } from './client-auth.mjs'
import { loaderVersions, pickLoader, fabricVersionId, ensureFabricProfile, ensureFabricApi, assertFabricAvailable, fabricGameVersions, fabricAvailable } from './client-fabric.mjs'
import { harnessFor, HARNESS_RELEASES, ensureHarnessJar, readHarnessFile, removeHarnessFile, connectHarness, waitForHarness } from './client-harness.mjs'
import { checkInstance, REFUSED_CONSOLE, commandVerb } from './bots.mjs'

export const LOADERS = ['vanilla', 'fabric']
export const DEFAULT_MEMORY = '2G'

const PROFILE_KEYS = ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness', 'server', 'account', 'assistantAccount']
// The keys that make up the running game's command line; the rest only matter at the next launch.
const RUNNING_KEYS = ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness']

// The shape of a version id; whether Mojang lists it is assertVersionId's question.
function validateMc(mc) {
  if (typeof mc !== 'string') fail('the Minecraft version must be text, like 26.3')
  if (!isSafeVersionId(mc)) {
    fail(`invalid Minecraft version "${mc.slice(0, 64)}" - versions look like 26.3, 26.4-snapshot-6 or b1.7.3`)
  }
}

// Typed ids are trimmed: "1.21.11 " is 1.21.11.
const trimMc = (mc) => (typeof mc === 'string' ? mc.trim() : mc)

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
  // a default account that was signed out is dropped on the next save, not an error
  if (data.defaultAccount != null && !accountExists(data.defaultAccount)) delete data.defaultAccount
  writeJson(PROFILES_FILE, data)
}

// A damaged accounts.json must not take the profiles with it: the launch that needs it fails
// on its own, everything else treats the list as unknown (null).
function accountsOrNull() {
  try { return loadAccounts() } catch { return null }
}

function accountExists(uuid) {
  const list = accountsOrNull()
  return list === null ? true : list.some((a) => sameUuid(a.uuid, uuid))
}

// The launcher's default account (a uuid from accounts.json, top-level in profiles.json): what a
// launch from the CLI, the panel or the launcher plays as when neither the command line nor the
// profile names an account. Assistant launches never use it (see launchLocked). Null when none
// is set or the account is gone.
export function getDefaultAccount() {
  const uuid = loadProfiles().defaultAccount
  const list = accountsOrNull()
  return typeof uuid === 'string' && list !== null && list.some((a) => sameUuid(a.uuid, uuid)) ? uuid : null
}

export function setDefaultAccount(uuid) {
  const reg = loadProfiles()
  if (uuid === null) {
    delete reg.defaultAccount
  } else {
    const idx = findAccount(loadAccounts(), String(uuid))
    if (idx === -1) fail(`no account with uuid "${uuid}" is in the list; sign in or add an offline account first`)
    reg.defaultAccount = loadAccounts()[idx].uuid
  }
  saveProfiles(reg)
  return reg.defaultAccount ?? null
}

// A profile's account key written as a name keeps working (resolved by name at launch); from now
// on the uuid is stored when the account is in the list, so a Mojang name change cannot detach
// the profile. "offline:<name>" and an unknown name are stored as typed.
function accountKeyFor(value) {
  if (typeof value !== 'string' || value.startsWith('offline:')) return value
  const list = accountsOrNull()
  if (list === null) return value
  const idx = findAccount(list, value)
  return idx === -1 ? value : list[idx].uuid
}

// The name to show for a profile's account key (a uuid, a name, or offline:<name>), and its
// type: 'microsoft', 'offline', or null for a name no longer in the list.
export function accountLabel(value) {
  return accountInfo(value).name
}

export function accountInfo(value) {
  if (typeof value !== 'string') return { name: value, type: null }
  if (value.startsWith('offline:')) return { name: value.slice('offline:'.length), type: 'offline' }
  const list = accountsOrNull()
  if (list === null) return { name: value, type: null }
  const idx = findAccount(list, value)
  return idx === -1 ? { name: value, type: null } : { name: list[idx].name, type: list[idx].type ?? 'microsoft' }
}

// The uuid a profile's account key resolves to (a key written as a name by an older CLI
// included), or null for an offline selector or a name no longer in the list.
export function accountUuid(value) {
  if (typeof value !== 'string' || value.startsWith('offline:')) return null
  const list = accountsOrNull()
  if (list === null) return null
  const idx = findAccount(list, value)
  return idx === -1 ? null : list[idx].uuid
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
export function createProfile(name, { mc: typedMc, loader = 'vanilla', loaderVersion = null, java = null, memory = DEFAULT_MEMORY, harness = false, server = null, account = null }) {
  validateProfileName(name)
  const reg = loadProfiles()
  const lower = name.toLowerCase()
  for (const existing of Object.keys(reg.profiles)) {
    if (existing.toLowerCase() === lower) {
      fail(`a profile named "${existing}" already exists (names must differ in more than case)`)
    }
  }
  const assistantAccount = false
  const mc = trimMc(typedMc)
  validateFields({ mc, loader, loaderVersion, java, memory, harness, server, account, assistantAccount })
  fs.mkdirSync(profileDir(name), { recursive: true })
  const optionsFile = path.join(profileDir(name), 'options.txt')
  if (!fs.existsSync(optionsFile)) {
    fs.writeFileSync(optionsFile, 'lang:en_us\n')
  }
  const profile = { mc, loader, loaderVersion, java, memory, harness, server, account: accountKeyFor(account), assistantAccount, createdAt: new Date().toISOString() }
  reg.profiles[name] = profile
  saveProfiles(reg)
  return { name, ...profile }
}

// `launching: true` is launch's own write of the loader it picked, made while it holds the lock.
export function updateProfile(name, patch, { launching = false } = {}) {
  validateProfileName(name)
  for (const key of Object.keys(patch)) {
    if (!PROFILE_KEYS.includes(key)) {
      fail(`unknown profile key "${key}" - use ${PROFILE_KEYS.join(', ')}`)
    }
  }
  if (typeof patch.mc === 'string') patch = { ...patch, mc: trimMc(patch.mc) }
  const existing = getProfile(name)
  const changing = RUNNING_KEYS.filter((k) => Object.hasOwn(patch, k) && patch[k] !== existing[k])
  if (changing.length && status(name).running) {
    fail(`profile "${name}" is running; stop it before changing ${changing.join(', ')}: spawnloft client stop ${name}`)
  }
  // a launch under way read the profile at its start and reads it again while it downloads
  if (changing.length && !launching && lockHolder(clientLaunchLock(name)) !== null) {
    fail(`profile "${name}" is being launched (pid ${holderText(name)}); wait for it before changing ${changing.join(', ')}`)
  }
  // a loader build is made for one Minecraft version; the next launch picks one for the new version
  if (Object.hasOwn(patch, 'mc') && patch.mc !== existing.mc && (!Object.hasOwn(patch, 'loaderVersion') || patch.loaderVersion === existing.loaderVersion)) {
    patch = { ...patch, loaderVersion: null }
  }
  const merged = { ...existing, ...patch }
  validateFields(merged)
  const reg = loadProfiles()
  reg.profiles[name] = { ...reg.profiles[name], ...patch, ...(Object.hasOwn(patch, 'account') ? { account: accountKeyFor(patch.account) } : {}) }
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

// A version id this machine can get: downloaded already, or in Mojang's list. An id the cached
// list lacks asks Mojang again once (a release out within the hour), then is refused with the
// nearest ids. Returns the trimmed id, and the list when it was read.
export async function assertVersionId(typed, { fetchImpl } = {}) {
  const mc = trimMc(typed)
  validateMc(mc)
  // a vanilla version on disk, not a loader profile's id
  const onDisk = readJson(versionJson(mc), null)
  if (onDisk && !onDisk.inheritsFrom) return { mc, manifest: null }
  const opts = { cacheDir: CLIENT_CACHE_DIR, ...(fetchImpl ? { fetchImpl } : {}) }
  let manifest
  try {
    manifest = await fetchManifest(opts)
  } catch {
    fail(`the Minecraft version list is not available offline and "${mc}" is not downloaded`)
  }
  const listed = (m) => (m.versions ?? []).some((v) => v.id === mc)
  if (!listed(manifest)) manifest = await fetchManifest({ ...opts, force: true })
  if (!listed(manifest)) fail(`Mojang's version list has no "${mc}"; check the id (releases look like 26.3, snapshots like 26.4-snapshot-6, old versions like b1.7.3)${nearIds(mc, manifest)}`, 'unknown-version')
  return { mc, manifest }
}

// Up to five listed ids that start like the typed one, ignoring case, newest first.
function nearIds(mc, manifest) {
  const ids = (manifest.versions ?? []).map((v) => v.id)
  let stem = mc.toLowerCase()
  let near = []
  while (stem && !near.length) {
    near = ids.filter((id) => id.toLowerCase().startsWith(stem))
    stem = stem.replace(/[^.\- ]*[.\- ]?$/, '')
  }
  return near.length ? `. Did you mean ${near.slice(0, 5).join(', ')}?` : ''
}

// What a profile's save checks beyond the shape: the version exists, and Fabric builds for it.
export async function checkProfileVersion({ mc, loader = 'vanilla' }, { fetchImpl } = {}) {
  const known = await assertVersionId(mc, { fetchImpl })
  if (loader === 'fabric') await assertFabricAvailable(known.mc)
  return known.mc
}

export async function prepareVersion(name, { onStage = () => {} } = {}) {
  const profile = getProfile(name)
  if (!fs.existsSync(versionJson(profile.mc))) {
    onStage({ stage: 'manifest', message: 'Reading the Minecraft version list' })
    const { manifest } = await assertVersionId(profile.mc)
    onStage({ stage: 'version', message: `Downloading the version file for Minecraft ${profile.mc}` })
    await fetchVersionJson(profile.mc, { manifest, cacheDir: CLIENT_CACHE_DIR })
  }
  if (profile.loader === 'fabric') {
    let loaderVersion = profile.loaderVersion
    // a loader profile already on disk was made for this version, so Fabric has it
    if (loaderVersion === null || !fs.existsSync(versionJson(fabricVersionId(profile.mc, loaderVersion)))) {
      await assertFabricAvailable(profile.mc)
    }
    if (loaderVersion === null) {
      onStage({ stage: 'fabric', message: `Finding a Fabric loader for Minecraft ${profile.mc}` })
      const list = await loaderVersions(profile.mc)
      loaderVersion = pickLoader(list).version
      updateProfile(name, { loaderVersion }, { launching: true })
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

export const LAUNCHED_BY = ['launcher', 'panel', 'cli', 'assistant']

// `assistant: true` marks a launch asked for by an AI assistant (the MCP tool): playing as a
// Microsoft account is then allowed only on a profile whose assistantAccount key says so.
// `onWarning` is told about a stopped target server before the game starts, so the warning comes
// out before (not under) the launch line. The warnings are also in the result.
// `server: false` launches to the title screen even when the profile names a server.
// `onStage` hears { stage, message } as each step starts; `onProgress` keeps the downloads'
// { phase, done, total, bytes }. `ensureServer(target)` starts a stopped target server and waits
// for it, just before the game is spawned; without it a stopped server is only a warning.
async function launchLocked(name, { playerName = null, account: accountSelector = null, server = null, address: addressText = null, onProgress = () => {}, onStage = () => {}, onWarning = () => {}, ensureServer = null, fakeJava = null, assistant = false, launchedBy = null, os = launchOs(fakeJava), hostCaps = null }) {
  const by = assistant ? 'assistant' : (launchedBy ?? 'cli')
  if (!LAUNCHED_BY.includes(by)) throw new Error(`unknown launchedBy "${launchedBy}"`)
  const profile = getProfile(name)
  const st = status(name)
  if (st.running) {
    fail(`profile "${name}" is already running (pid ${st.pid}); stop it first`)
  }
  // a machine Mojang never built for is refused before Java is looked for or anything downloads
  const machineRefusal = platformRefusal(null, os)
  if (machineRefusal) fail(machineRefusal)
  // before any download: a database is a registered instance but nothing a game can join
  if (addressText !== null && typeof server === 'string') fail('join either a SpawnLoft server or an address, not both')
  const address = addressText === null ? null : parseServerAddress(addressText)
  const target = address || server === false ? null : (server ?? profile.server)
  if (target && isDatabase(getInstance(target))) fail(`"${target}" is a database, not a Minecraft server; point the profile at a server`)
  if (profile.harness && !harnessFor(profile.mc)) {
    fail('the harness mod is published for Minecraft ' + HARNESS_RELEASES.map(r => r.minecraft).join(', ') + ', not ' + profile.mc + '; set harness=false on the profile or use one of those versions')
  }

  // --as names an offline player; a signed-in account brings its own name. Both at once is a
  // contradiction, not a preference. The launcher's default account is only a preference: it
  // applies when neither the caller nor the profile names an account, never to an assistant
  // launch (which would otherwise play as a Microsoft account the assistantAccount rule never
  // allowed), and --as beats it.
  const named = accountSelector ?? profile.account ?? null
  if (playerName && named) fail('use either --as <player name> or --account <account>, not both')
  const selector = named ?? (assistant || playerName ? null : getDefaultAccount())
  // An offline player against an online-mode server is refused here, before Java is looked for
  // or anything downloads, with the words join() uses: the server would refuse the join for
  // sure, so a launch would only show a kick screen. A stopped server is a warning, told to the
  // caller now (before the launch line, not under it) and carried in the result, since it can be
  // started while the game loads. The account itself is resolved later (a refresh needs the
  // network); its type and name are read from the list now, which also refuses an unknown
  // account before anything downloads.
  const stored = selector ? peekAccount(selector) : null
  const provisional = stored
    ? { type: stored.type, name: stored.name }
    : { type: 'offline', name: playerName ? assertPlayerName(playerName) : defaultPlayerName(name) }
  if (assistant && provisional.type !== 'offline' && !profile.assistantAccount) {
    fail(assistantAccountRefusal(name))
  }
  const { refusal, warnings: found, stopped } = target ? serverCheck(target, provisional) : { refusal: null, warnings: [], stopped: false }
  // the launcher has no --account flag to point at; it has an account picker
  if (refusal) fail(by === 'launcher' ? `${target} requires a Microsoft account (online-mode=true); sign in or pick another server` : refusal)
  // a server this launch will start is not worth a warning
  const warnings = stopped && ensureServer ? found.filter((w) => !/is not running/.test(w)) : found
  // SpawnLoft cannot read another machine's server.properties, so this is a warning, not a refusal
  if (address && provisional.type === 'offline') {
    warnings.push(`${provisional.name} is an offline player, so ${addressText} will refuse the join unless it runs with online-mode=false; sign in to play on public servers`)
  }
  for (const w of warnings) onWarning(w)

  // The version file comes first: what the game needs (its Java, the arch it runs as, anything
  // this SpawnLoft cannot launch) is read from it before Java is looked for or anything else
  // downloads (review B3).
  let versionId
  // the fake game runs a version already on disk as it is, without installing it
  let fakeInstalled = false
  if (fakeJava) {
    if (profile.loader === 'fabric') {
      if (profile.loaderVersion === null) {
        fail(`profile "${name}" uses the fabric loader but has no loaderVersion; set one with spawnloft client set`)
      }
      versionId = fabricVersionId(profile.mc, profile.loaderVersion)
    } else {
      versionId = profile.mc
    }
    fakeInstalled = fs.existsSync(versionJson(versionId))
    if (!fakeInstalled) versionId = await prepareVersion(name, { onStage })
  } else {
    versionId = await prepareVersion(name, { onStage })
  }

  let version = JSON.parse(fs.readFileSync(versionJson(versionId), 'utf8'))
  if (version.inheritsFrom) {
    version = mergeInherited(version, JSON.parse(fs.readFileSync(versionJson(version.inheritsFrom), 'utf8')))
  }
  const features = launchFeatures({ hasServer: Boolean(address || target) })
  // the Rosetta check runs only for a version that has no natives for this arch; hostCaps given
  // is the tests' stand-in for a machine they are not
  const needsCaps = !nativeArches(version, os).has(os.arch)
  const caps = hostCaps ?? (needsCaps && !fakeJava ? await hostCapabilities(os) : null)
  const resolved = resolveVersion(version, { os, features, hostCaps: caps })
  const refused = resolvedRefusal(resolved)
  if (refused) fail(refused.message, refused.code)
  // the game runs as this arch: x64 under Rosetta or Windows emulation for a version with no
  // arm64 natives, so its natives, its rules and its Java all follow it
  const runOs = resolved.os

  onStage({ stage: 'java', message: 'Finding Java' })
  const picked = fakeJava ? { path: fakeJava, warning: null } : await pickClientJava({ explicit: profile.java, requirement: resolved.java, arch: resolved.arch, what: 'Minecraft ' + profile.mc })
  const java = picked.path
  if (picked.warning) {
    warnings.push(picked.warning)
    onWarning(picked.warning)
  }

  const installed = fakeInstalled ? null : await ensureVersion(versionId, { os: runOs, onProgress, keepNatives: versionsInUse(name) })
  if (!fakeJava) {
    if (profile.loader === 'fabric') {
      onStage({ stage: 'fabric', message: 'Checking Fabric API' })
      await ensureFabricApi(name, profile.mc, { onProgress })
    }
    if (profile.harness) {
      onStage({ stage: 'harness', message: 'Checking the harness mod' })
      await ensureHarnessJar(name, profile.mc, { onProgress })
    }
  }

  const account = selector ? await accountFor(selector) : offlineAccount(playerName ?? defaultPlayerName(name))
  // last before the game, so a failed download or sign-in does not leave a server started for nothing
  if (stopped && ensureServer) {
    onStage({ stage: 'server', message: `Starting ${target}` })
    await ensureServer(target)
  }
  const harnessToken = profile.harness ? crypto.randomBytes(16).toString('hex') : null
  // a file from a crashed run would otherwise be read as this run's, before the mod replaces it
  if (harnessToken) removeHarnessFile(name)
  const command = buildCommand({ version, profile: { ...profile, server: target }, profileName: name, account, java, os: runOs, harnessToken, address })
  onStage({ stage: 'spawn', message: 'Starting the game' })
  // server: the one the game joins by itself (quickPlay), so a join to it can wait instead of racing
  const { pid } = await spawnClient(command, { name, state: { mode: account.type, account, harness: harnessToken ? { token: harnessToken, port: null } : null, server: target ?? null, address: address ? formatAddress(address) : null, launchedBy: by, launch: launchFacts(resolved, picked, profile, installed) } })

  return { pid, profile, version: versionId, account: { type: account.type, name: account.name }, warnings }
}

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV6 = /^[0-9A-Fa-f:.]+$/

// A server outside SpawnLoft to join at launch: host[:port], a name, an IPv4 address or a
// bracketed IPv6 one. Strict because the host lands on the game's command line: it can never
// start with a dash or carry a space, a scheme or a path.
export function parseServerAddress(text) {
  const bad = () => fail(`"${text}" is not a server address; use host or host:port, like play.example.net or 192.168.1.20:25566`)
  if (typeof text !== 'string') bad()
  const raw = text.trim()
  if (!raw || raw.length > 260) bad()
  let host
  let portText = null
  const v6 = /^\[([^\]]+)\](?::([^:]*))?$/.exec(raw)
  if (v6) {
    host = v6[1]
    portText = v6[2] ?? null
    if (!IPV6.test(host) || !host.includes(':')) bad()
  } else {
    const parts = raw.split(':')
    if (parts.length > 2) bad()
    host = parts[0]
    portText = parts[1] ?? null
    if (host.length > 253 || !HOSTNAME.test(host)) bad()
  }
  let port = 25565
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) bad()
    port = Number(portText)
    if (port < 1 || port > 65535) bad()
  }
  return { host, port }
}

function formatAddress({ host, port }) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

// The version ids whose natives a running game (of another profile) has loaded: each game's
// own and every parent it inherits from, since a Fabric game loads its vanilla parent's natives.
// A re-extraction (a new stamp, an arch switch) would pull them from under it, or fail on
// Windows, so those folders wait for a later launch.
function versionsInUse(except) {
  const ids = new Set()
  for (const p of listProfiles()) {
    if (p.name === except) continue
    const state = readClientState(p.name)
    if (!state) continue
    let id = state.launch?.id ?? p.mc
    while (typeof id === 'string' && !ids.has(id)) {
      ids.add(id)
      id = readJson(versionJson(id), null)?.inheritsFrom ?? null
    }
  }
  return ids
}

// What this launch was decided from, kept in the run's state for diagnose and the diag bundle.
function launchFacts(resolved, picked, profile, installed) {
  return {
    id: resolved.id,
    java: { major: resolved.java.major, component: resolved.java.component, min: resolved.java.min, max: resolved.java.max, chosenPath: picked.path, source: profile.java ? 'explicit' : picked.warning ? 'fallback' : 'installed', warning: picked.warning },
    arch: resolved.arch,
    emulated: resolved.emulated,
    nativesDir: resolved.natives.dir,
    assetsLayout: installed?.assetsLayout ?? null,
    loggingConfig: resolved.logging?.id ?? null,
    minimumLauncherVersion: resolved.format.minimumLauncherVersion,
  }
}

// Whether this machine runs x64 code, for the versions with no arm64 natives (everything before
// 1.19): Apple Silicon with Rosetta installed, Windows 11 on arm64 (build 22000 on). Linux arm64
// cannot. A Mac's answer is kept only once it is yes, so a Rosetta installed after a refusal is
// seen on the next launch without a restart (review R6).
let rosettaSeen = false
export async function hostCapabilities(os = currentOs()) {
  if (os.arch !== 'arm64') return { x64: os.arch === 'x64' }
  if (os.name === 'windows') return { x64: Number(String(os.version).split('.')[2]) >= 22000 }
  if (os.name !== 'osx') return { x64: false }
  if (!rosettaSeen) {
    rosettaSeen = await new Promise((resolve) => {
      execFile('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 10000 }, (err) => resolve(!err))
    })
  }
  return { x64: rosettaSeen }
}

// The fake game is a Node script, so it runs where Mojang's client cannot (the Linux arm64 CI
// runner); there it is launched as if on Linux x64 instead of being refused.
function launchOs(fakeJava) {
  const os = currentOs()
  return fakeJava && platformRefusal(null, os) ? { ...os, name: 'linux', arch: 'x64' } : os
}

// What the target server means for this launch: a refusal (the join cannot happen: an offline
// player against an online-mode server) and warnings (the game will show "Connection refused"
// until the server is started), so nobody waits on a join that cannot happen.
function serverCheck(server, account) {
  let check
  // advisory only: an unreadable server.properties must not stop a launch that got this far
  try { check = checkInstance(server) } catch { return { refusal: null, warnings: [], stopped: false } }
  const warnings = []
  let refusal = null
  const stopped = check.problems.some((p) => /is not running/.test(p))
  if (stopped) {
    warnings.push(`server "${server}" is not running, so the game will show "Connection refused"; start it first: spawnloft start ${server}`)
  }
  if (account.type !== 'microsoft' && check.problems.some((p) => /runs in online mode/.test(p))) {
    refusal = onlineModeRefusal(server, account.name)
  }
  return { refusal, warnings, stopped }
}

function onlineModeRefusal(server, playerName) {
  return `server "${server}" runs in online mode and ${playerName} is an offline player, so the server would refuse the join; sign in (spawnloft client login) and play as that account (--account <name>, or account=<name> on the profile), or set online-mode=false on a test server`
}

// MCCTL_FAKE_CLIENT points launch at a script run by this Node instead of Java (the test suite's
// fake game). It is honoured only with NODE_ENV=test, so a stray variable in a user's environment
// cannot make SpawnLoft run an arbitrary script in place of the game.
export function fakeClientJava(env = process.env) {
  return env.NODE_ENV === 'test' && env.MCCTL_FAKE_CLIENT ? env.MCCTL_FAKE_CLIENT : null
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
    launchedBy: st?.launchedBy ?? null,
    server: st?.server ?? null,
    address: st?.address ?? null,
    harness: st?.harness ? { port: readHarnessFile(name, { pid: st.pid })?.port ?? null } : null,
  }
}

const sessions = new Map()

export async function session(name) {
  // the name becomes part of the state and harness file paths
  getProfile(name)
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

// a kick can land on the disconnect screen or straight back on the title or server list
const leftServer = (screen) => screen === 'disconnected' || screen === 'title' || screen === 'multiplayer'

async function waitInWorld(name, server, waitMs) {
  // The mod answers once the player entity exists, while the screen still says "Loading
  // terrain"; anything done then lands before the world is there. Wait for "ingame".
  const deadline = Date.now() + waitMs
  let st = await viaSession(name, (ch) => ch.call('status'))
  while (st.screen !== 'ingame' && !leftServer(st.screen) && Date.now() < deadline) {
    await sleep(500)
    st = await viaSession(name, (ch) => ch.call('status'))
  }
  if (leftServer(st.screen)) {
    fail(`"${name}" was disconnected from ${server} while the world loaded; read the reason with client_status or spawnloft client logs ${name}`)
  }
  return st
}

export async function join(name, server, { loadWaitMs = 60000 } = {}) {
  // the account decides the online-mode rule below, and a stopped client has none to go by
  const { running, account } = status(name)
  if (!running) fail('profile "' + name + '" is not running; launch it first: spawnloft client launch ' + name)
  const check = checkInstance(server)
  // The offline-mode rule is for players without an account; a signed-in one may join an online
  // server. checkInstance words it for bots, so an offline client gets the launch warning's wording.
  const problems = check.problems.flatMap((p) => {
    if (!/runs in online mode/.test(p)) return [p]
    if (account?.type === 'microsoft') return []
    return [onlineModeRefusal(server, account?.name) + '.']
  })
  if (problems.length) fail(problems.join(' '))
  const host = check.host
  const port = check.inst.port
  // A profile with a server joins it by itself on launch. Asked to join while that is under way
  // (the connect screen comes before there is a connection the mod can see), a second connect
  // would race the first, so wait for the first one instead; another server has to wait its turn.
  const before = await viaSession(name, (ch) => ch.call('status'))
  const isHere = (st) => Boolean(st.connected && st.connected.host === host && st.connected.port === port)
  const launchTarget = readClientState(name)?.server ?? null
  let result
  if (isHere(before)) {
    result = { joined: true, already: true }
  } else if (!before.connected && launchTarget === server && (before.screen === 'connecting' || before.screen === 'other')) {
    // still loading, or on the connect screen: the launch's own join is coming or under way
    result = { joined: true, already: true }
  } else if (before.screen === 'connecting' && !before.connected) {
    fail(`"${name}" is still connecting to a server; wait until client_status shows it in the world, then disconnect before joining ${server}`)
  } else {
    result = await viaSession(name, (ch) => ch.call('join', { host, port }, { timeout: 65000 }))
  }
  const st = await waitInWorld(name, server, loadWaitMs)
  // a connect we waited on may have been to another server (one picked in the game's server list)
  if (st.connected && !isHere(st)) {
    fail(`"${name}" is on ${st.connected.host}:${st.connected.port}, not ${server}; disconnect first`)
  }
  return { ...result, server, host, port, loaded: st.screen === 'ingame', screen: st.screen }
}

// The harness answers before the game has loaded its resources (no screen yet), and a launch
// with a server then shows the connect and terrain screens; a screenshot taken before the end
// shows Mojang's loading overlay. Wait for the title screen, or the world (or a disconnect)
// when the launch joins a server, then for the overlay's one-second fade-out. While resources
// load there is no screen at all ("other" with no title); a titled "other" is a real screen,
// such as the accessibility one a fresh profile opens with.
export const LAUNCH_WAIT_MS = 90000

export async function waitUntilLoaded(name, { server = null, timeoutMs = LAUNCH_WAIT_MS, fadeMs = 1500 } = {}) {
  const booting = (st) => (st.screen === 'other' && !st.screenTitle) || /loading/i.test(st.screenTitle || '')
  let connecting = false
  const loaded = (st) => {
    if (st.screen === 'connecting') connecting = true
    if (!server) return !booting(st) && st.screen !== 'connecting'
    // a refused or kicked join can land back on the title screen, but so can the moment before
    // the launch's join starts, so the title counts only once the join was seen
    return st.screen === 'ingame' || st.screen === 'disconnected' || st.screen === 'multiplayer' || (connecting && st.screen === 'title')
  }
  const deadline = Date.now() + timeoutMs
  let st = await viaSession(name, (ch) => ch.call('status'))
  while (!loaded(st) && Date.now() < deadline) {
    await sleep(500)
    st = await viaSession(name, (ch) => ch.call('status'))
  }
  if (!loaded(st)) return { ...st, loaded: false }
  await sleep(fadeMs)
  return { ...(await viaSession(name, (ch) => ch.call('status'))), loaded: true }
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

// A crash report prints the game's whole command line, the harness token and the Minecraft
// access token among it; the diag bundle redacts the first the same way.
export function redactClientLine(line) {
  return line
    .replace(/spawnloft\.harness\.token=\S+/g, 'spawnloft.harness.token=[redacted]')
    .replace(/(--accessToken[\s=]+)\S+/g, '$1[redacted]')
    // the old versions' ${auth_session}, which some of them print ("Session ID is token:...")
    .replace(/\btoken:[^:\s]+:/g, 'token:[redacted]:')
}

// Whether a row came out before a release: by the manifest's times, or by the numbers when the
// list could not be read (offline, downloaded versions only).
function olderThan(row, refTimes, release) {
  const ref = refTimes.get(release)
  if (ref && row.releaseTime) return Date.parse(row.releaseTime) < ref
  const m = /^(\d+)\.(\d+)/.exec(row.id)
  const r = /^(\d+)\.(\d+)/.exec(release)
  if (!m) return false
  return Number(m[1]) < Number(r[1]) || (Number(m[1]) === Number(r[1]) && Number(m[2]) < Number(r[2]))
}

// What is on disk for each installed vanilla version: its JSON when the client jar beside it has
// the size the JSON names (a size check only; the launch checks sha1).
async function installedVersions() {
  let ids
  try { ids = await fs.promises.readdir(versionsDir()) } catch { return new Map() }
  const out = new Map()
  await Promise.all(ids.filter(isSafeVersionId).map(async (id) => {
    let json
    try { json = JSON.parse(await fs.promises.readFile(versionJson(id), 'utf8')) } catch { return }
    if (json.inheritsFrom) return
    let jarSize = null
    try { jarSize = (await fs.promises.stat(versionJar(id))).size } catch { /* no jar yet */ }
    const want = json.downloads?.client?.size
    out.set(id, { json, downloaded: jarSize !== null && (want === undefined || jarSize === want) })
  }))
  return out
}

// The Java a version not on disk probably needs, from its id and type alone; the JSON says for sure.
function javaHint(row) {
  if (row.type === 'old_alpha' || row.type === 'old_beta') return 8
  return requiredMajor(row.id)
}

// The version picker's rows, newest first: every id Mojang lists. The per-version facts that
// need the JSON (its exact Java, a platform refusal) are given for versions on disk; the rest
// say so (javaNeedsExact false), and describeVersion answers for one. fabric is whether Fabric
// builds for it: read when asked for (the list is a fetch of its own), else null.
export async function listVersions({ os = currentOs(), fetchImpl, fabric = false, refresh = false } = {}) {
  const installed = await installedVersions()
  const machineRefusal = platformRefusal(null, os)
  // asked only when a downloaded version lacks natives for this arch
  const needsCaps = [...installed.values()].some(({ json }) => !nativeArches(json, os).has(os.arch))
  const hostCaps = needsCaps ? await hostCapabilities(os) : null
  let manifest = null
  let offline = null
  try {
    manifest = await fetchManifest({ cacheDir: CLIENT_CACHE_DIR, force: refresh, ...(fetchImpl ? { fetchImpl } : {}) })
  } catch (err) {
    offline = `the Minecraft version list could not be read (${err?.message ?? err}), so only downloaded versions are listed`
  }
  let fabricList = null
  if (fabric || refresh) {
    try { fabricList = await fabricGameVersions({ force: refresh }) } catch { /* unknown: null per row */ }
  }
  const source = manifest
    ? manifest.versions.filter((v) => isSafeVersionId(v.id))
    : [...installed.entries()].map(([id, { json }]) => ({ id, type: json.type ?? 'release', releaseTime: json.releaseTime ?? null }))
  const winArm = os.name === 'windows' && os.arch === 'arm64'
  const refTimes = new Map()
  for (const id of ['1.13', '1.21']) {
    const t = Date.parse(manifest?.versions?.find((v) => v.id === id)?.releaseTime ?? '')
    if (!Number.isNaN(t)) refTimes.set(id, t)
  }
  const versions = source.map((v) => {
    const disk = installed.get(v.id)
    const notes = []
    if (olderThan(v, refTimes, '1.13')) notes.push('old launcher arguments; untested')
    if (winArm && olderThan(v, refTimes, '1.21')) notes.push('may not run on this machine; checked at launch')
    return {
      id: v.id,
      type: v.type,
      kind: versionKind(v),
      releaseTime: v.releaseTime ?? null,
      downloaded: Boolean(disk?.downloaded),
      javaNeeds: disk ? javaRequirement(disk.json).major : javaHint(v),
      javaNeedsExact: Boolean(disk),
      harness: Boolean(harnessFor(v.id)),
      fabric: fabricList ? fabricAvailable(v.id, fabricList) : null,
      refusal: disk ? platformRefusal(disk.json, os, hostCaps) : null,
      note: notes.length ? notes.join('; ') : null,
    }
  })
  // newest first, by release time; a row without one keeps its place at the end
  versions.sort((a, b) => (Date.parse(b.releaseTime ?? '') || 0) - (Date.parse(a.releaseTime ?? '') || 0))
  return { machineRefusal, offline, versions }
}

// One version in full, for the form: fetches its JSON (a few KB, kept in versions/) and answers
// what the launch would decide from it: the exact Java, the arch it runs as, a refusal with its
// code, and whether Fabric and the harness have it.
export async function describeVersion(id, { os = currentOs(), fetchImpl } = {}) {
  const { mc, manifest } = await assertVersionId(id, { fetchImpl })
  let json = readJson(versionJson(mc), null)
  if (!json) json = await fetchVersionJson(mc, { manifest, cacheDir: CLIENT_CACHE_DIR })
  const needsCaps = !nativeArches(json, os).has(os.arch)
  const resolved = resolveVersion(json, { os, hostCaps: needsCaps ? await hostCapabilities(os) : null })
  const refused = resolvedRefusal(resolved)
  let fabric = null
  try { fabric = fabricAvailable(mc, await fabricGameVersions()) } catch { /* unknown */ }
  return {
    id: mc,
    type: json.type ?? 'release',
    kind: versionKind({ id: mc, type: json.type ?? 'release' }),
    releaseTime: json.releaseTime ?? null,
    javaNeeds: resolved.java.major,
    javaNeedsExact: true,
    java: resolved.java,
    arch: resolved.arch,
    emulated: resolved.emulated,
    fabric,
    harness: Boolean(harnessFor(mc)),
    refusal: refused?.message ?? null,
    code: refused?.code ?? null,
    problems: resolved.problems,
  }
}

export function profileFolder(name) {
  getProfile(name)
  return profileDir(name)
}
