import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-launch-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { offlineUuid, assertPlayerName, offlineAccount } = await import('../src/client-auth.mjs')
const { buildCommand, substitute } = await import('../src/client-launch.mjs')
const { mergeInherited, libraries } = await import('../src/client-meta.mjs')
const { versionJar, nativesDir, LIBRARIES_DIR } = await import('../src/client-paths.mjs')

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
})
