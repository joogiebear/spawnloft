import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-launch-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { offlineUuid, assertPlayerName, offlineAccount, defaultPlayerName } = await import('../src/client-auth.mjs')
const { buildCommand, substitute } = await import('../src/client-launch.mjs')
const { mergeInherited, libraries } = await import('../src/client-meta.mjs')
const { versionJar, nativesDir, LIBRARIES_DIR, ASSETS_DIR, logConfigPath } = await import('../src/client-paths.mjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'client')

const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release
const vanilla = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${mc}.json`), 'utf8'))
const fabric = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-profile.json'), 'utf8'))

const testOs = { name: 'linux', arch: 'x64', version: '6' }
const account = offlineAccount('alice')
const java = '/usr/bin/java'

test('offlineUuid matches the value the server derives', () => {
  assert.equal(offlineUuid('alice'), '40f5db53-a47a-33ee-b1f6-db0e20deded4')
})

test('assertPlayerName refuses names outside 3 to 16 of letters, digits, underscores', () => {
  assert.throws(() => assertPlayerName('ab'), /player name "ab" must be 3 to 16 letters, digits or underscores/)
  assert.throws(() => assertPlayerName('way_too_long_name_x'), /player name "way_too_long_name_x" must be 3 to 16 letters, digits or underscores/)
})

test('assertPlayerName takes strings only', () => {
  assert.throws(() => assertPlayerName(true), /player name/)
})

test('defaultPlayerName turns any profile name into a valid player name', () => {
  assert.equal(defaultPlayerName('my-client'), 'my_client')
  assert.equal(defaultPlayerName('p'), 'p__')
  assert.equal(defaultPlayerName('a-very-long-profile-name-here').length, 16)
  for (const n of ['my-client', 'p', 'a-very-long-profile-name-here']) assertPlayerName(defaultPlayerName(n))
})

test('substitute replaces known variables and reports unknown ones', () => {
  assert.deepEqual(substitute('${a} ${b}', { a: 1 }), { text: '1 ${b}', unknown: ['b'] })
})

test('vanilla: main class, -Xmx2G, natives directory, classpath ends with jar and has no natives', () => {
  const profile = { mc, loader: 'vanilla', memory: '2G', server: null }
  const cmd = buildCommand({ version: vanilla, profile, profileName: 'test', account, java, os: testOs })

  assert.equal(cmd.bin, java)
  assert.ok(cmd.args.includes(vanilla.mainClass), 'main class in args')
  assert.ok(cmd.args.includes('-Xmx2G'), '-Xmx2G in args')

  const natDir = nativesDir(vanilla.id)
  assert.ok(cmd.args.some((a) => a.includes(natDir)), 'natives directory in JVM args')

  const cpIdx = cmd.args.findIndex((a) => a === '-cp' || a === '-classpath')
  assert.ok(cpIdx !== -1, 'has -cp or -classpath argument')
  const entries = cmd.args[cpIdx + 1].split(path.delimiter)
  const jar = versionJar(vanilla.id)
  assert.equal(entries[entries.length - 1], jar, 'classpath ends with the client jar')

  const nativePaths = libraries(vanilla, { os: testOs })
    .filter((r) => r.native !== false)
    .map((r) => path.join(LIBRARIES_DIR, r.path))
  for (const np of nativePaths) {
    assert.ok(!entries.includes(np), `classpath must not contain natives jar ${np}`)
  }
})

test('windows: the natives classifier jar stays off the classpath', () => {
  const winOs = { name: 'windows', arch: 'x64', version: '10' }
  const profile = { mc, loader: 'vanilla', memory: '2G', server: null }
  const cmd = buildCommand({ version: vanilla, profile, profileName: 'test', account, java, os: winOs })
  const entries = cmd.args[cmd.args.indexOf('-cp') + 1].split(path.delimiter)
  const nativePaths = libraries(vanilla, { os: winOs })
    .filter((r) => r.native !== false)
    .map((r) => path.join(LIBRARIES_DIR, r.path))
  assert.ok(nativePaths.length > 0, 'the fixture has a natives row for windows')
  for (const np of nativePaths) assert.ok(!entries.includes(np), `classpath must not contain natives jar ${np}`)
})

test('fabric: merged version gives Knot as the main class', () => {
  const merged = mergeInherited(fabric, vanilla)
  const profile = { mc, loader: 'fabric', memory: '2G', server: null }
  const cmd = buildCommand({ version: merged, profile, profileName: 'test', account, java, os: testOs })

  assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
  assert.ok(cmd.args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'), 'Knot in args')
})

test('a server on the profile adds --quickPlayMultiplayer 127.0.0.1:<port>', () => {
  const instDir = path.join(scratch, 'instances', 'testserver')
  fs.mkdirSync(instDir, { recursive: true })
  fs.writeFileSync(path.join(instDir, 'server.properties'), 'server-ip=0.0.0.0\n')
  fs.writeFileSync(path.join(scratch, 'instances.json'), JSON.stringify({
    version: 1,
    instances: {
      testserver: { dir: instDir, port: 25599, jar: 'paper.jar', memory: '1G' },
    },
  }))

  const profile = { mc, loader: 'vanilla', memory: '2G', server: 'testserver' }
  const cmd = buildCommand({ version: vanilla, profile, profileName: 'test', account, java, os: testOs })

  const idx = cmd.args.indexOf('--quickPlayMultiplayer')
  assert.ok(idx !== -1, 'has --quickPlayMultiplayer')
  assert.equal(cmd.args[idx + 1], '127.0.0.1:25599')
  assert.ok(!cmd.args.includes('--server'), 'no --server fallback when the placeholder exists')
})

test('a version without the quick play placeholder gets --server and --port instead', () => {
  const old = { ...vanilla, arguments: undefined, minecraftArguments: '--username ${auth_player_name} --version ${version_name}' }
  delete old.arguments
  const profile = { mc, loader: 'vanilla', memory: '2G', server: 'testserver' }
  const cmd = buildCommand({ version: old, profile, profileName: 'test', account, java, os: testOs })
  assert.ok(!cmd.args.includes('--quickPlayMultiplayer'))
  const idx = cmd.args.indexOf('--server')
  assert.ok(idx !== -1, 'has --server')
  assert.equal(cmd.args[idx + 1], '127.0.0.1')
  assert.equal(cmd.args[idx + 2], '--port')
  assert.equal(cmd.args[idx + 3], '25599')
  assert.ok(cmd.args.includes('alice'), 'the old-style arguments were substituted')
  // the launcher supplied these itself before 1.13
  const cp = cmd.args.indexOf('-cp')
  assert.ok(cp !== -1 && cmd.args[cp + 1].endsWith(versionJar(vanilla.id)), 'legacy JSON still gets a classpath')
  assert.ok(cmd.args.some((a) => a.startsWith('-Djava.library.path=') && a.endsWith(nativesDir(vanilla.id))))
})

test('quick play supplies the log path as well as the server', () => {
  const profile = { mc, loader: 'vanilla', memory: '2G', server: 'testserver' }
  const cmd = buildCommand({ version: vanilla, profile, profileName: 'test', account, java, os: testOs })
  for (const a of cmd.args) assert.ok(!a.includes('${'), `unsubstituted placeholder in ${a}`)
  const idx = cmd.args.indexOf('--quickPlayPath')
  if (idx !== -1) assert.ok(cmd.args[idx + 1].endsWith('quickPlay.json'))
})

test('Log4Shell: the log config argument and the lookup switch are JVM arguments for 1.12.2 and 1.17.1', () => {
  for (const id of ['1.12.2', '1.17.1']) {
    const version = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', `${id}.json`), 'utf8'))
    const profile = { mc: id, loader: 'vanilla', memory: '2G', server: null }
    const cmd = buildCommand({ version, profile, profileName: 'old', account, java, os: testOs })
    const mainIdx = cmd.args.indexOf(version.mainClass)
    assert.ok(mainIdx > 0, `${id}: main class in args`)
    const jvm = cmd.args.slice(0, mainIdx)
    assert.ok(jvm.includes(`-Dlog4j.configurationFile=${logConfigPath('client-1.12.xml')}`), `${id}: log config argument, got ${jvm.join(' ')}`)
    assert.ok(jvm.includes('-Dlog4j2.formatMsgNoLookups=true'), `${id}: lookup switch`)
    assert.ok(!cmd.args.some((a) => a.includes('${path}')), `${id}: \${path} substituted`)
    assert.ok(!cmd.args.some((a) => a.includes('${')), `${id}: no variable left unsubstituted: ${cmd.args.filter((a) => a.includes('${')).join(' ')}`)
  }
})

test('Log4Shell: 1.21.11 gets its log config as Mojang\'s launcher passes it, and no lookup switch', () => {
  const profile = { mc, loader: 'vanilla', memory: '2G', server: null }
  const cmd = buildCommand({ version: vanilla, profile, profileName: 'test', account, java, os: testOs })
  const mainIdx = cmd.args.indexOf(vanilla.mainClass)
  const jvm = cmd.args.slice(0, mainIdx)
  assert.ok(jvm.includes(`-Dlog4j.configurationFile=${logConfigPath('client-1.21.2.xml')}`), 'log config argument')
  assert.ok(!cmd.args.includes('-Dlog4j2.formatMsgNoLookups=true'), 'no switch for log4j 2.16+')
  assert.deepEqual(cmd.args.filter((a) => a.startsWith('-Dlog4j')).length, 1)
})

test('the minecraftArguments era: every era fills every variable, with the session as Mojang wrote it', () => {
  const ids = ['rd-132211', 'a1.2.6', 'b1.7.3', '1.5.2', '1.6.4', '1.7.2', '1.7.10', '1.12.2', '1.14.4', '1.16.5', '1.17.1', '1.18.2', '1.20.4', '1.21.11', '26.1', '26.3', '26.4-snapshot-6']
  for (const id of ids) {
    const version = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', `${id}.json`), 'utf8'))
    const cmd = buildCommand({ version, profile: { mc: id, loader: 'vanilla', memory: '2G', server: null }, profileName: 'old', account, java, os: testOs })
    assert.deepEqual(cmd.args.filter((a) => a.includes('${')), [], `${id}: nothing left unsubstituted`)
  }
  const at = (args, flag) => args[args.indexOf(flag) + 1]
  // 1.6.4: --session token:<access>:<uuid>, the offline player's access token being "0"
  const v164 = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', '1.6.4.json'), 'utf8'))
  const old = buildCommand({ version: v164, profile: { mc: '1.6.4', loader: 'vanilla', memory: '2G', server: null }, profileName: 'old', account, java, os: testOs })
  assert.equal(at(old.args, '--session'), `token:0:${account.uuid}`)
  assert.equal(at(old.args, '--assetsDir'), ASSETS_DIR)
  // a signed-in player's own token
  const signedIn = { ...account, type: 'microsoft', accessToken: 'abc.def', userType: 'msa' }
  const msa = buildCommand({ version: v164, profile: { mc: '1.6.4', loader: 'vanilla', memory: '2G', server: null }, profileName: 'old', account: signedIn, java, os: testOs })
  assert.equal(at(msa.args, '--session'), `token:abc.def:${account.uuid}`)
  // 1.7.10: no Twitch properties
  const v1710 = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'versions', '1.7.10.json'), 'utf8'))
  const mid = buildCommand({ version: v1710, profile: { mc: '1.7.10', loader: 'vanilla', memory: '2G', server: null }, profileName: 'old', account, java, os: testOs })
  assert.equal(at(mid.args, '--userProperties'), '{}')
})

test('the old versions\' session text is redacted in the log lines the panel shows', async () => {
  const { redactClientLine } = await import('../src/client.mjs')
  assert.equal(redactClientLine('(Session ID is token:eyJhbGciOi.abc:40f5db53a47a33eeb1f6db0e20deded4)'), '(Session ID is token:[redacted]:40f5db53a47a33eeb1f6db0e20deded4)')
  assert.equal(redactClientLine('--accessToken secret --version 1.21.11'), '--accessToken [redacted] --version 1.21.11')
})
