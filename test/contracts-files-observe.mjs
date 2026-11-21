/**
 * What the Node writers of the shared files (rust/PLAN-CORE-PORT.md 3.4) produce from fixed inputs,
 * gathered in one place so test/contracts-files.test.mjs can hold each fixture against it. Every
 * value is made by calling the real Node function in a scratch data root, with the scratch paths
 * put back as placeholders (<data>, <entry>, ...) so the result is the same on every machine.
 *
 * Importing this sets MCCTL_DATA_ROOT and the settings folders before any src/ module loads, so it
 * must be the first import of the test that uses it (paths.mjs resolves the data root once).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-files-')))
export const DATA = path.join(scratch, 'data')
export const CONFIG = path.join(scratch, 'config')
export const HOME = path.join(scratch, 'home')
// a space in the folder: every quoting rule sees one
export const ENTRY = path.join(scratch, 'core bin', process.platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core')
for (const dir of [DATA, CONFIG, HOME, path.dirname(ENTRY)]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(ENTRY, '')

process.env.MCCTL_DATA_ROOT = DATA
delete process.env.SPAWNLOFT_DATA_ROOT
delete process.env.SPAWNLOFT_ENTRY
process.env.XDG_CONFIG_HOME = CONFIG
process.env.APPDATA = CONFIG
delete process.env.XDG_DATA_HOME

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CODE = path.resolve(HERE, '..')
export const MCCTL = path.join(CODE, 'mcctl.mjs')

export const m = {
  paths: await import('../src/paths.mjs'),
  util: await import('../src/util.mjs'),
  registry: await import('../src/registry.mjs'),
  settings: await import('../src/settings.mjs'),
  dataFormat: await import('../src/data-format.mjs'),
  relocate: await import('../src/relocate.mjs'),
  entry: await import('../src/entry.mjs'),
  create: await import('../src/create.mjs'),
  schedule: await import('../src/schedule.mjs'),
  mac: await import('../src/schedule-mac.mjs'),
  linux: await import('../src/schedule-linux.mjs'),
  backup: await import('../src/backup.mjs'),
  tar: await import('../src/tar.mjs'),
  zip: await import('../src/zip.mjs'),
  garnet: await import('../src/garnet.mjs'),
  mysql: await import('../src/mysql.mjs'),
  mariadb: await import('../src/mariadb.mjs'),
  plugins: await import('../src/plugins.mjs'),
  mrpack: await import('../src/mrpack.mjs'),
  client: await import('../src/client.mjs'),
  clientPaths: await import('../src/client-paths.mjs'),
  clientAuth: await import('../src/client-auth.mjs'),
  serverList: await import('../src/client-server-list.mjs'),
}

if (m.paths.DATA_ROOT !== DATA) throw new Error(`the data root resolved to ${m.paths.DATA_ROOT}, not the scratch folder; import this module first`)

export const NS = crypto.createHash('sha256').update(DATA).digest('hex').slice(0, 16)

// Real paths back to placeholders, longest first so <data> does not eat part of a longer one.
export function placeholders(text) {
  const map = [
    [ENTRY, '<entry>'],
    [MCCTL, '<mcctl>'],
    [process.execPath, '<node>'],
    [DATA, '<data>'],
    [CONFIG, '<config>'],
    [HOME, '<home>'],
    [CODE, '<code>'],
    [NS, '<ns>'],
  ].sort((a, b) => b[0].length - a[0].length)
  let out = String(text)
  // a path inside JSON text is escaped (Windows backslashes doubled), so both spellings go
  for (const [real, name] of map) out = out.split(JSON.stringify(real).slice(1, -1)).join(name).split(real).join(name)
  return out
}

// the other way, for JSON text written as input to a reader
export function fillJson(text) {
  const map = { '<entry>': ENTRY, '<code>': CODE, '<data>': DATA, '<node>': process.execPath, '<mcctl>': MCCTL }
  return String(text).replace(/<(entry|code|data|node|mcctl)>/g, (p) => JSON.stringify(map[p]).slice(1, -1))
}

// Runs fn with SPAWNLOFT_ENTRY set to the scratch core (a 2.0 install) or unset (a checkout).
export function withEntry(on, fn) {
  const before = process.env.SPAWNLOFT_ENTRY
  if (on) process.env.SPAWNLOFT_ENTRY = ENTRY
  else delete process.env.SPAWNLOFT_ENTRY
  try { return fn() } finally {
    if (before === undefined) delete process.env.SPAWNLOFT_ENTRY
    else process.env.SPAWNLOFT_ENTRY = before
  }
}

// Runs fn as if on another platform, for writers that only look at process.platform when called.
export function asPlatform(platform, fn) {
  const own = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...own, value: platform })
  try { return fn() } finally { Object.defineProperty(process, 'platform', own) }
}

// the settings locations a POSIX shim copies from the caller, fixed for the call
export function withShimEnv(fn) {
  const keys = ['HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env.HOME = HOME
  process.env.XDG_CONFIG_HOME = CONFIG
  delete process.env.APPDATA
  delete process.env.XDG_DATA_HOME
  try { return fn() } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

export const read = (file) => fs.readFileSync(file, 'utf8')
// line endings normalised: a Windows checkout may give CRLF
export const source = (rel) => read(path.join(CODE, rel)).replace(/\r\n/g, '\n')

// schedule.mjs triggerArgs, which is not exported, taken from the source and run: schtasks only
// exists on Windows, so this is how the argument lists are held on every platform
export function triggerArgsFromSource() {
  const text = source('src/schedule.mjs')
  const start = text.indexOf('function triggerArgs(schedule) {')
  if (start === -1) throw new Error('triggerArgs is not in src/schedule.mjs any more')
  const body = text.slice(start, text.indexOf('\n}\n', start) + 2)
  return new Function('fail', `${body}; return triggerArgs`)((message) => { throw new Error(message) })
}
export const modeOf = (file) => process.platform === 'win32' ? null : (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0')

// ---- the writers, one function per fixture --------------------------------------------------

export const SERVER = (name, port) => ({
  dir: path.join(DATA, 'instances', name),
  jar: 'paper-1.21.4-232.jar',
  java: 'java',
  memory: '4G',
  loader: 'paper',
  port,
  rcon: { port: port + 10, password: 'hunter2' },
  createdAt: '2026-11-21T03:00:00.000Z',
})

// instances.json: what each registry call leaves in the file
export function registryWrites() {
  const steps = []
  const step = (call, fn) => {
    fn()
    steps.push({ call, text: placeholders(read(m.paths.REGISTRY_FILE)), mode: modeOf(m.paths.REGISTRY_FILE) })
  }
  fs.rmSync(m.paths.REGISTRY_FILE, { force: true })
  step("putInstance('survival', server)", () => m.registry.putInstance('survival', SERVER('survival', 25565)))
  step("putInstance('lobby', server)", () => m.registry.putInstance('lobby', SERVER('lobby', 25566)))
  step("updateInstance('survival', { label: 'Survival', port: 25570, webhook: null })", () => m.registry.updateInstance('survival', { label: 'Survival', port: 25570, webhook: null }))
  step("updateInstance('lobby', { autoRestart: true })", () => m.registry.updateInstance('lobby', { autoRestart: true }))
  step("removeInstance('survival')", () => m.registry.removeInstance('survival'))
  step("putInstance('survival', server)", () => m.registry.putInstance('survival', SERVER('survival', 25565)))
  return { steps, lockLeft: fs.existsSync(`${m.paths.REGISTRY_FILE}.lock`), tmpLeft: fs.existsSync(`${m.paths.REGISTRY_FILE}.tmp`) }
}

// settings.json: two saves, the second into a file holding keys this build does not know
export function settingsWrites() {
  const current = path.join(CONFIG, 'spawnloft', 'settings.json')
  const legacy = path.join(CONFIG, 'mcctl', 'settings.json')
  fs.rmSync(path.join(CONFIG, 'spawnloft'), { recursive: true, force: true })
  fs.rmSync(path.join(CONFIG, 'mcctl'), { recursive: true, force: true })
  const out = {}
  m.settings.save({ dataRoot: '/srv/minecraft' })
  out.fresh = { file: placeholders(m.settings.settingsFile()), text: read(current), mode: modeOf(current) }
  fs.writeFileSync(current, JSON.stringify({ theme: 'dark', 'bot.node': '/usr/bin/node', future: { nested: [1, 2] }, dataRoot: '/old' }, null, 2) + '\n')
  const merged = m.settings.save({ dataRoot: '/srv/minecraft', backupsDir: null })
  out.merge = { returned: merged, text: read(current) }
  // a machine that only has the older folder keeps writing there
  fs.rmSync(path.join(CONFIG, 'spawnloft'), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, '{"dataRoot":"/old"}')
  m.settings.save({ theme: 'spawnloft' })
  out.legacy = { file: placeholders(m.settings.settingsFile()), text: read(legacy), currentMade: fs.existsSync(current) }
  fs.rmSync(path.join(CONFIG, 'mcctl'), { recursive: true, force: true })
  // a damaged file is refused, and kept as it was
  fs.mkdirSync(path.dirname(current), { recursive: true })
  fs.writeFileSync(current, '{ not json')
  try {
    m.settings.save({ theme: 'x' })
    out.damaged = 'written'
  } catch (err) {
    out.damaged = { refused: err instanceof m.util.UserError, kept: read(current) }
  }
  fs.rmSync(path.join(CONFIG, 'spawnloft'), { recursive: true, force: true })
  return out
}

// data-format.json: Node only reads it
export function dataFormatReads(cases) {
  return cases.map((c) => {
    const file = path.join(scratch, 'data-format.json')
    fs.writeFileSync(file, c.text)
    const marker = m.dataFormat.readDataFormat(file)
    const warning = m.dataFormat.dataFormatWarning({ file, marker, version: c.version })
    return { marker, warns: warning !== null }
  })
}

// run/runtime.json: what repairAfterMove leaves, from each earlier record
export function runtimeWrites(cases) {
  const marker = path.join(scratch, 'runtime-cases', 'runtime.json')
  return withEntry(true, () => {
    const signature = m.relocate.runtimeSignature()
    return {
      signature: JSON.parse(placeholders(JSON.stringify(signature))),
      cases: cases.map((c) => {
        fs.rmSync(path.dirname(marker), { recursive: true, force: true })
        fs.mkdirSync(path.dirname(marker), { recursive: true })
        if (c.before !== null) fs.writeFileSync(marker, fillJson(c.before))
        const res = m.relocate.repairAfterMove({ marker, signature })
        return { moved: res.moved, after: placeholders(read(marker)) }
      }),
    }
  })
}

const TASK_ID = 'survival-backup'
export const KINDS = {
  minutes: { kind: 'minutes', every: 30 },
  hourly: { kind: 'hourly', every: 2 },
  daily: { kind: 'daily', at: '03:00' },
  weekly: { kind: 'weekly', day: 'SUN', at: '23:30' },
  onlogon: { kind: 'onlogon' },
}

// the POSIX task shim (macOS and Linux share it)
export function posixShims() {
  return withShimEnv(() => Object.fromEntries([true, false].map((entry) => {
    const file = withEntry(entry, () => m.mac.writeShim(TASK_ID))
    return [entry ? 'entry' : 'checkout', { file: placeholders(file), text: placeholders(read(file)), mode: modeOf(file) }]
  })))
}

// the Windows task shim: written for real on Windows (rewriteShims), elsewhere the source's own
// two lines are checked by the test and their formula is run here
export function windowsShims() {
  return Object.fromEntries([true, false].map((entry) => {
    const text = withEntry(entry, () => {
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(DATA, 'schedules.json'), JSON.stringify({ version: 1, tasks: { [TASK_ID]: { instance: 'survival' } } }))
        m.schedule.rewriteShims()
        return read(path.join(DATA, 'tasks', `${TASK_ID}.cmd`))
      }
      const lines = ['@echo off', ...m.entry.windowsRun(m.entry.cliCommand(), `task run ${TASK_ID}`), 'exit /b %errorlevel%']
      return lines.join('\r\n') + '\r\n'
    })
    return [entry ? 'entry' : 'checkout', placeholders(text)]
  }))
}

// the three launchers in a server folder, as each platform writes them
export function launchers() {
  const dir = path.join(scratch, 'launchers')
  const out = {}
  for (const platform of ['linux', 'win32']) {
    for (const entry of [true, false]) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      const files = withEntry(entry, () => asPlatform(platform, () => m.create.writeLaunchers({ name: 'survival', dir })))
      out[`${platform}-${entry ? 'entry' : 'checkout'}`] = Object.fromEntries(files.map((f) => [f, { text: placeholders(read(path.join(dir, f))), mode: modeOf(path.join(dir, f)) }]))
    }
  }
  return out
}

export function plists() {
  return Object.fromEntries(Object.entries(KINDS).map(([kind, schedule]) =>
    [kind, placeholders(m.mac.plist(TASK_ID, { enabled: kind !== 'hourly', schedule }))]))
}

export function systemdUnits() {
  return Object.fromEntries(Object.entries(KINDS).map(([kind, schedule]) => {
    const task = { enabled: true, schedule }
    return [kind, { service: placeholders(m.linux.serviceUnit(TASK_ID, task)), timer: m.linux.timerUnit(TASK_ID, task) }]
  }))
}

export function unitNames() {
  return {
    launchdLabel: placeholders(m.mac.label(TASK_ID)),
    launchdFile: placeholders(m.mac.agentFile(TASK_ID).split(os.homedir()).join('~').split(path.sep).join('/')),
    systemdLabel: placeholders(m.linux.label(TASK_ID)),
  }
}

// a backup of a stopped server, its manifest and what the archive holds
export async function backupLayout(inst) {
  const made = await m.backup.createSnapshot(inst, { scope: 'standard' })
  const full = await m.backup.createSnapshot(inst, { scope: 'full', label: 'before 1.21!' })
  const listing = (file) => {
    const res = spawnSync(m.tar.tarBinary(), ['-tzf', file], { encoding: 'utf8', windowsHide: true })
    return res.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\\/g, '/').replace(/\/$/, '')).sort()
  }
  const manifestText = placeholders(read(made.file.replace(/\.tar\.gz$/, '.json')))
  const fullManifest = JSON.parse(read(full.file.replace(/\.tar\.gz$/, '.json')))
  m.backup.setSnapshotLocked(inst.name, path.basename(made.file), true)
  m.backup.setSnapshotNote(inst.name, path.basename(made.file), 'before\tthe\nupgrade')
  const lockedText = placeholders(read(made.file.replace(/\.tar\.gz$/, '.json')))
  const folder = path.dirname(made.file)
  return {
    folder: placeholders(folder).split(path.sep).join('/'),
    files: fs.readdirSync(folder).sort(),
    names: [path.basename(made.file), path.basename(full.file)],
    manifestText,
    lockedText,
    fullMembers: fullManifest.members,
    fullLabel: fullManifest.label,
    standardListing: listing(made.file),
    fullListing: listing(full.file),
  }
}

// a zip as zip.mjs writes it, read back from its central directory
export async function zipLayout(cwd, members) {
  const file = path.join(scratch, 'out.zip')
  await m.zip.createZip(file, cwd, members)
  const buf = fs.readFileSync(file)
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const offset = buf.readUInt32LE(at + 42)
    const external = buf.readUInt32LE(at + 38)
    entries.push({
      name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      madeBy: buf.readUInt16LE(at + 4),
      needed: buf.readUInt16LE(at + 6),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      dirBit: (external & 0x10) !== 0,
      unixType: (external >>> 16) & 0o170000,
      extraLength,
      local: { needed: buf.readUInt16LE(offset + 4), flags: buf.readUInt16LE(offset + 6), method: buf.readUInt16LE(offset + 8), extraLength: buf.readUInt16LE(offset + 28) },
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return { entries, endComment: buf.readUInt16LE(end + 20), endTotal: count }
}

// spawnloft-engine.json as hasEngine reads it: a marker with Node's platform names is an
// installed engine, the same marker with Rust's names is not (garnet.mjs compares both)
export function engineMarkers() {
  const g = m.garnet
  const dir = g.engineDir(g.VERSION)
  const slash = (p) => placeholders(p).split(path.sep).join('/')
  const out = { garnetDir: slash(dir), mariadbDir: slash(m.mariadb.engineDir('11.4.5')) }
  try { out.mysqlDir = slash(m.mysql.engineDir(m.mysql.VERSION, 'linux', 'x64')) } catch { out.mysqlDir = null }
  let sha256
  try { sha256 = g.archiveFor(g.VERSION).sha256 } catch { return { ...out, garnet: null } }
  fs.mkdirSync(path.join(dir, '.runtime', 'shared', 'Microsoft.NETCore.App', g.RUNTIME_VERSION), { recursive: true })
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'GarnetServer.exe' : 'GarnetServer'), '')
  const rust = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  const rustArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  const as = (marker) => {
    fs.writeFileSync(path.join(dir, 'spawnloft-engine.json'), JSON.stringify(marker))
    return g.hasEngine(g.VERSION)
  }
  out.garnet = {
    node: as({ version: g.VERSION, platform: process.platform, arch: process.arch, sha256 }),
    rustNames: as({ version: g.VERSION, platform: rust, arch: rustArch, sha256 }),
    rustArchOnly: as({ version: g.VERSION, platform: process.platform, arch: rustArch, sha256 }),
    extraField: as({ version: g.VERSION, platform: process.platform, arch: process.arch, sha256, writtenBy: '2.0.0' }),
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

// .mcctl-plugins.json, where it lives for each kind of server and what each change leaves
export function pluginStore() {
  const out = {}
  for (const loader of ['paper', 'fabric']) {
    const inst = { name: `store-${loader}`, dir: path.join(scratch, `store-${loader}`), loader }
    fs.mkdirSync(inst.dir, { recursive: true })
    m.plugins.recordManaged(inst, 'LuckPerms-Bukkit-5.4.141.jar', { source: 'modrinth', project: 'Vebnzrzj', version: 'v5.4.141-bukkit', installedAt: '2026-11-21T03:00:00.000Z', gameVersions: ['1.21.4'] })
    m.plugins.recordManaged(inst, 'worldedit.jar', { source: 'hangar', project: 'WorldEdit', version: '7.3.9', installedAt: '2026-11-21T03:00:00.000Z', gameVersions: ['1.21.4'] })
    m.plugins.forgetManaged(inst, 'LuckPerms-Bukkit-5.4.141.jar')
    const folder = fs.readdirSync(inst.dir)[0]
    out[loader] = { file: `${folder}/${fs.readdirSync(path.join(inst.dir, folder)).join(',')}`, text: read(path.join(inst.dir, folder, '.mcctl-plugins.json')) }
  }
  return out
}

// the launcher's own files, from the calls that make them without a network
export function clientFiles() {
  const c = m.client
  const P = m.clientPaths
  const out = {}
  c.createProfile('vanilla-1', { mc: '1.21.4' })
  c.createProfile('fabric-1', { mc: '1.21.4', loader: 'fabric', memory: '4G', serverList: false })
  out.profiles = { text: read(P.PROFILES_FILE).replace(/"createdAt": "[^"]+"/g, '"createdAt": "<at>"'), options: read(path.join(P.profileDir('vanilla-1'), 'options.txt')) }
  m.clientAuth.addOfflineAccount('Steve')
  out.accounts = { text: read(P.ACCOUNTS_FILE), mode: modeOf(P.ACCOUNTS_FILE) }
  const rel = (p) => path.relative(DATA, p).split(path.sep).join('/')
  out.layout = {
    profilesFile: rel(P.PROFILES_FILE), accountsFile: rel(P.ACCOUNTS_FILE), profileDir: rel(P.profileDir('vanilla-1')),
    versionJson: rel(P.versionJson('1.21.4')), versionJar: rel(P.versionJar('1.21.4')), libraries: rel(P.LIBRARIES_DIR),
    assets: rel(P.ASSETS_DIR), logConfig: rel(P.logConfigPath('client-1.12.xml')), natives: rel(P.nativesDir('1.21.4')),
    runtime: rel(P.RUNTIME_DIR), cache: rel(P.CLIENT_CACHE_DIR), runState: rel(P.clientStateFile('vanilla-1')),
    lastExit: rel(P.clientLastExit('vanilla-1')), played: rel(P.clientPlayed('vanilla-1')), serverListState: rel(P.clientServerList('vanilla-1')),
    clientLog: rel(P.clientLog('vanilla-1')), launchLock: rel(P.clientLaunchLock('vanilla-1')),
  }
  // servers.dat: a new list with two of SpawnLoft's servers, then one of them taken away
  const dat = path.join(scratch, 'servers.dat')
  const state = path.join(scratch, 'server-list.json')
  const wanted = [{ key: 'survival', name: 'Survival (SpawnLoft)', ip: '127.0.0.1:25565' }, { key: 'lobby', name: 'lobby', ip: 'localhost:25566' }]
  const first = m.serverList.syncServerList({ file: dat, stateFile: state, wanted })
  out.serversDat = { result: first, hex: fs.readFileSync(dat).toString('hex'), state: read(state) }
  const second = m.serverList.syncServerList({ file: dat, stateFile: state, wanted: wanted.slice(0, 1) })
  out.serversDatAfterRemove = { result: second, hex: fs.readFileSync(dat).toString('hex'), state: read(state) }
  return out
}

// the tree the zip and backup checks pack: names that sort differently by code unit and by
// localeCompare, an empty file, an empty folder, and a member that starts with a dash
export function makeTree(dir) {
  const files = { 'world/level.dat': 'x'.repeat(100), 'world/region/r.0.0.mca': 'x'.repeat(100), 'world/B.txt': 'b', 'world/_x.txt': '_', 'world/a.txt': '', 'world/Zed/z.txt': 'z', 'icon.png': 'png' }
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  fs.mkdirSync(path.join(dir, 'world', 'DIM-1'), { recursive: true })
}

// a stopped server's folder for the backup checks: plugins, the world server.properties names, a
// second world (any folder with a level.dat), root config files, a member that starts with a dash,
// and what the full scope leaves out (logs) or every scope leaves out (session.lock)
export function makeServer(name) {
  const dir = path.join(DATA, 'instances', name)
  makeTree(dir)
  const files = {
    'plugins/x.jar': 'jar', 'server.properties': 'level-name=world\n', 'eula.txt': 'eula=true\n', '-dash': 'dash',
    'logs/latest.log': 'log', 'other_world/level.dat': 'x', 'world/session.lock': 'x',
  }
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  m.registry.putInstance(name, SERVER(name, 25565))
  return m.registry.getInstance(name)
}

// ISO times a writer stamps with "now", for comparing the rest of the text
export const maskTimes = (text) => String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<at>')

// schedules.json through schedule.create and update on Linux, with a stand-in systemctl first on
// PATH that records its arguments and succeeds (Linux only: macOS runs /bin/launchctl by its full
// path, Windows runs the real schtasks)
export function scheduleWrites() {
  const bin = path.join(scratch, 'fake-systemctl')
  fs.mkdirSync(bin, { recursive: true })
  const calls = path.join(bin, 'calls')
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\nshift\necho "$*" >> '${calls}'\nexit 0\n`, { mode: 0o755 })
  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before}`
  const file = path.join(DATA, 'schedules.json')
  const label = m.linux.label('x').slice(0, -2)
  const takeCalls = () => {
    const text = fs.existsSync(calls) ? read(calls) : ''
    fs.rmSync(calls, { force: true })
    return text.split('\n').filter(Boolean).map((l) => l.split(label).join('<label>').replace(/<label>-[a-z0-9-]+?(\.service|\.timer)/g, '<label>$1'))
  }
  try {
    fs.rmSync(file, { force: true })
    const a = m.schedule.create({ instance: 'survival', name: 'Nightly backup', action: { type: 'backup', keep: 7 }, schedule: { kind: 'daily', at: '03:00' } })
    const createEnabled = takeCalls()
    const b = m.schedule.create({ instance: 'survival', name: '', action: { type: 'command', line: 'say hi' }, schedule: { kind: 'minutes', every: 15 }, enabled: false })
    const createDisabled = takeCalls()
    const afterCreate = maskTimes(read(file))
    m.schedule.update(b.id, { enabled: true })
    takeCalls()
    const afterEnable = maskTimes(read(file))
    const units = fs.readdirSync(path.join(CONFIG, 'systemd', 'user')).map((f) => placeholders(f)).sort()
    return { ids: [a.id, b.id], createEnabled, createDisabled, afterCreate, afterEnable, units }
  } finally {
    process.env.PATH = before
  }
}

// `spawnloft task run <id>` as Task Scheduler, launchd or systemd starts it: a command task for a
// stopped server, which is logged as skipped
export function runTask(id) {
  const env = { ...process.env, MCCTL_DATA_ROOT: DATA, XDG_CONFIG_HOME: CONFIG, APPDATA: CONFIG, SPAWNLOFT_HARNESS_INDEX_FETCH: 'off' }
  delete env.SPAWNLOFT_DATA_ROOT
  delete env.SPAWNLOFT_ENTRY
  const res = spawnSync(process.execPath, [MCCTL, 'task', 'run', id], { encoding: 'utf8', env, windowsHide: true, timeout: 60000 })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}
