import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  readZipEntry, parsePluginYml, mcVersionOf, listPlugins, setPluginEnabled, removePlugin,
  pickVersion, primaryFile, LOADERS, readManaged, recordManaged, pickHangarVersion, searchHangar,
  planInstall, installPlugin,
} from '../src/plugins.mjs'
import { UserError } from '../src/util.mjs'

// zip built by hand so the reader is tested against the format itself

function buildZip(entries, { deflate = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflate ? zlib.deflateRawSync(raw) : raw
    const method = deflate ? 8 : 0
    const crc = zlib.crc32(raw)
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))

    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-plugins-'))

function writeJar(dir, name, yml, opts) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, buildZip([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'], ['plugin.yml', yml]], opts))
  return file
}

test('a stored and a deflated entry both read back exactly', () => {
  const dir = scratch()
  for (const deflate of [false, true]) {
    const file = path.join(dir, deflate ? 'd.jar' : 's.jar')
    fs.writeFileSync(file, buildZip([['plugin.yml', 'name: Example\n']], { deflate }))
    assert.equal(readZipEntry(file, 'plugin.yml').toString(), 'name: Example\n')
  }
})

test('an entry that is not there is null, not an error', () => {
  const dir = scratch()
  const file = writeJar(dir, 'x.jar', 'name: X\n')
  assert.equal(readZipEntry(file, 'paper-plugin.yml'), null)
})

test('a file that is not a zip at all is null', () => {
  const dir = scratch()
  const file = path.join(dir, 'junk.jar')
  fs.writeFileSync(file, 'not a zip, just bytes pretending')
  assert.equal(readZipEntry(file, 'plugin.yml'), null)
})

test('the common manifest fields come through, quotes stripped', () => {
  const meta = parsePluginYml([
    'name: EcoExample',
    "version: '2026.33'",
    'main: com.example.Main',
    'api-version: "1.21"',
    'author: Auxilor',
    'description: Does example things',
    'website: https://example.com',
  ].join('\n'))
  assert.equal(meta.name, 'EcoExample')
  assert.equal(meta.version, '2026.33')
  assert.equal(meta['api-version'], '1.21')
  assert.equal(meta.author, 'Auxilor')
})

test('authors as a flow list and as a block list both become arrays', () => {
  assert.deepEqual(parsePluginYml('authors: [A, "B"]\n').authors, ['A', 'B'])
  assert.deepEqual(parsePluginYml('authors:\n  - A\n  - B\n').authors, ['A', 'B'])
})

test('nested blocks like commands are skipped without eating later keys', () => {
  const meta = parsePluginYml('name: X\ncommands:\n  fly:\n    usage: /fly\nversion: 1.2\n')
  assert.equal(meta.name, 'X')
  assert.equal(meta.version, '1.2')
  assert.equal(meta.commands, undefined)
})

function fakeInstance() {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, 'plugins'))
  return { name: 'test', dir, jar: 'paper-26.2-121.jar' }
}

test('the game version is read from the server jar name', () => {
  assert.equal(mcVersionOf({ jar: 'paper-26.2-121.jar' }), '26.2')
  assert.equal(mcVersionOf({ jar: 'purpur-1.21.4-2140.jar' }), '1.21.4')
  assert.equal(mcVersionOf({ jar: 'custom-build.jar' }), null)
})

test('enabled and disabled jars are listed; other files are not', () => {
  const inst = fakeInstance()
  writeJar(path.join(inst.dir, 'plugins'), 'Alpha.jar', 'name: Alpha\nversion: 1.0\n')
  writeJar(path.join(inst.dir, 'plugins'), 'Beta.jar.disabled', 'name: Beta\nversion: 2.0\n')
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'notes.txt'), 'not a plugin')
  const rows = listPlugins(inst)
  assert.deepEqual(rows.map((r) => [r.name, r.enabled, r.version]),
    [['Alpha', true, '1.0'], ['Beta', false, '2.0']])
})

test('a jar with no readable manifest is still listed, by filename', () => {
  const inst = fakeInstance()
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'Mystery.jar'), 'not a zip')
  const rows = listPlugins(inst)
  assert.equal(rows[0].name, 'Mystery')
  assert.equal(rows[0].version, null)
})

test('disable renames in place and enable renames it back', () => {
  const inst = fakeInstance()
  writeJar(path.join(inst.dir, 'plugins'), 'Alpha.jar', 'name: Alpha\n')
  const off = setPluginEnabled(inst, 'Alpha.jar', false)
  assert.equal(off.file, 'Alpha.jar.disabled')
  assert.ok(fs.existsSync(path.join(inst.dir, 'plugins', 'Alpha.jar.disabled')))
  const on = setPluginEnabled(inst, 'Alpha.jar.disabled', true)
  assert.equal(on.file, 'Alpha.jar')
  assert.ok(fs.existsSync(path.join(inst.dir, 'plugins', 'Alpha.jar')))
})

test('a hand-dropped jar is not managed; one spawnloft recorded is', () => {
  const inst = fakeInstance()
  writeJar(path.join(inst.dir, 'plugins'), 'Premium.jar', 'name: Premium\n')
  writeJar(path.join(inst.dir, 'plugins'), 'FromModrinth.jar', 'name: FromModrinth\n')
  recordManaged(inst, 'FromModrinth.jar', { source: 'modrinth', project: 'abc', version: '1.0' })
  const rows = listPlugins(inst)
  assert.deepEqual(rows.map((r) => [r.name, r.managed]),
    [['FromModrinth', true], ['Premium', false]])
  assert.equal(rows[0].source, 'modrinth')
})

test('the provenance record follows a rename and dies with a delete', () => {
  const inst = fakeInstance()
  writeJar(path.join(inst.dir, 'plugins'), 'Tracked.jar', 'name: Tracked\n')
  recordManaged(inst, 'Tracked.jar', { source: 'modrinth', project: 'abc' })

  setPluginEnabled(inst, 'Tracked.jar', false)
  assert.deepEqual(Object.keys(readManaged(inst).managed), ['Tracked.jar.disabled'])
  setPluginEnabled(inst, 'Tracked.jar.disabled', true)
  assert.deepEqual(Object.keys(readManaged(inst).managed), ['Tracked.jar'])

  removePlugin(inst, 'Tracked.jar')
  assert.deepEqual(readManaged(inst).managed, {})
})

test('the provenance file itself never shows up as a plugin', () => {
  const inst = fakeInstance()
  writeJar(path.join(inst.dir, 'plugins'), 'Alpha.jar', 'name: Alpha\n')
  recordManaged(inst, 'Alpha.jar', { source: 'modrinth' })
  assert.deepEqual(listPlugins(inst).map((r) => r.name), ['Alpha'])
})

test('a path that walks out of the plugins folder is refused', () => {
  const inst = fakeInstance()
  for (const bad of ['../server.jar', 'a/b.jar', 'x.jar.disabled.disabled', 'plain.txt']) {
    assert.throws(() => removePlugin(inst, bad), UserError, `accepted "${bad}"`)
  }
})

const v = (over) => ({
  version_type: 'release',
  loaders: ['paper'],
  game_versions: ['26.2'],
  files: [{ primary: true, filename: 'x.jar', url: 'u', hashes: { sha1: 'abc' } }],
  ...over,
})

test('the newest compatible release wins; pre-releases only when nothing else fits', () => {
  const versions = [
    v({ version_type: 'beta', version_number: '2.0-beta' }),
    v({ version_number: '1.9' }),
  ]
  assert.equal(pickVersion(versions, { gameVersion: '26.2' }).version_number, '1.9')
  assert.equal(pickVersion([v({ version_type: 'beta', version_number: 'b' })], {}).version_number, 'b')
})

test('a version for the wrong loader or game version does not fit', () => {
  assert.equal(pickVersion([v({ loaders: ['fabric'] })], {}), null)
  assert.equal(pickVersion([v({ game_versions: ['25.1'] })], { gameVersion: '26.2' }), null)
  assert.ok(LOADERS.includes('spigot'), 'paper servers load spigot builds')
})

const hv = (over) => ({
  name: '2.0',
  channel: { name: 'Release' },
  platformDependencies: { PAPER: ['26.2'] },
  downloads: { PAPER: { downloadUrl: 'https://x/file.jar', fileInfo: { name: 'x.jar', sha256Hash: 'h' }, externalUrl: null } },
  ...over,
})

test('a Hangar Release with a real file and an exact version match wins', () => {
  const versions = [
    hv({ name: '3.0-beta', channel: { name: 'Beta' } }),
    hv({ name: '2.0' }),
  ]
  const picked = pickHangarVersion(versions, { gameVersion: '26.2' })
  assert.equal(picked.version.name, '2.0')
  assert.equal(picked.exactMatch, true)
})

test('an external-only project yields null - it cannot be installed, only linked to', () => {
  const versions = [hv({ downloads: { PAPER: { downloadUrl: null, fileInfo: null, externalUrl: 'https://elsewhere' } } })]
  assert.equal(pickHangarVersion(versions, {}), null)
})

test('with no exact match the newest downloadable is offered, flagged as a mismatch', () => {
  const versions = [hv({ platformDependencies: { PAPER: ['26.1.2'] } })]
  const picked = pickHangarVersion(versions, { gameVersion: '26.2' })
  assert.equal(picked.version.name, '2.0')
  assert.equal(picked.exactMatch, false)
})

test('the primary file wins; the first stands in when nothing is marked', () => {
  const files = [{ filename: 'a.jar' }, { filename: 'b.jar', primary: true }]
  assert.equal(primaryFile({ files }).filename, 'b.jar')
  assert.equal(primaryFile({ files: [{ filename: 'a.jar' }] }).filename, 'a.jar')
  assert.equal(primaryFile({ files: [] }), null)
})

test('Hangar search reports how often each project was downloaded', async (t) => {
  // in Hangar's /projects response the count lives at stats.downloads
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: [{
    name: 'Chunky', namespace: { owner: 'pop4959', slug: 'Chunky' }, description: 'Pre-generates chunks',
    stats: { views: 252983, downloads: 76528, recentViews: 7015, recentDownloads: 2392, stars: 303, watchers: 157 },
  }] }), { headers: { 'content-type': 'application/json' } }))
  const [hit] = await searchHangar('chunky')
  assert.equal(hit.downloads, 76528)
  assert.equal(hit.id, 'Chunky')
  assert.equal(hit.source, 'hangar')
})

// --- what an install would do, asked before it is done ---

const answers = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([part]) => String(url).includes(part))
  if (!hit) return new Response('not found', { status: 404 })
  const body = hit[1]
  return body instanceof Uint8Array ? new Response(body) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}
const mrVersion = (extra = {}) => ({
  project_id: 'main1', version_number: '2.0', version_type: 'release', loaders: ['paper'], game_versions: ['1.21.4'],
  files: [{ primary: true, filename: 'Main.jar', url: 'https://cdn.modrinth.com/Main.jar', hashes: {} }], dependencies: [], ...extra,
})
const needs = (...ids) => ids.map((id) => ({ project_id: id, dependency_type: 'required' }))
const paper = () => ({ ...fakeInstance(), jar: 'paper-1.21.4-100.jar' })
const brief = (plan) => plan.requires.map((d) => [d.title, d.installed, d.off])

test('a plan lists what a build needs, and which of it is already here', async (t) => {
  const inst = paper()
  // Vault dropped in by hand is still Vault; ProtocolLib was installed by SpawnLoft under another file name
  writeJar(path.join(inst.dir, 'plugins'), 'Vault-1.7.jar', 'name: Vault\n')
  writeJar(path.join(inst.dir, 'plugins'), 'plib.jar', 'name: Something Else\n')
  recordManaged(inst, 'plib.jar', { source: 'modrinth', project: 'plib1', version: '5.0' })
  const asked = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(decodeURIComponent(String(url)))
    return answers({
      '/project/main1/version': [mrVersion({ dependencies: [...needs('vault1', 'plib1', 'lp1'), { project_id: 'opt1', dependency_type: 'optional' }, { project_id: 'bad1', dependency_type: 'incompatible' }] })],
      '/project/lp1/version': [mrVersion({ project_id: 'lp1' })],
      '/projects?ids=': [{ id: 'vault1', slug: 'vault', title: 'Vault' }, { id: 'plib1', slug: 'protocollib', title: 'ProtocolLib' }, { id: 'lp1', slug: 'luckperms', title: 'LuckPerms' }],
    })(url)
  })
  const plan = await planInstall(inst, 'main1', { gameVersion: '1.21.4' })
  assert.deepEqual([plan.version, plan.exactMatch, plan.builtFor], ['2.0', true, null])
  assert.deepEqual(brief(plan), [['Vault', true, false], ['ProtocolLib', true, false], ['LuckPerms', false, false]])
  // nothing was downloaded to find this out, and what is already here was not asked about again
  assert.ok(asked.every((u) => u.startsWith('https://api.modrinth.com/')), asked.join(' '))
  assert.ok(!asked.some((u) => u.includes('/project/vault1/') || u.includes('/project/plib1/')))
  assert.deepEqual(fs.readdirSync(path.join(inst.dir, 'plugins')).filter((f) => f.endsWith('.jar')).sort(), ['Vault-1.7.jar', 'plib.jar'])
})

test('a plan goes down through what the requirements need, once each, and says which have no build for this version', async (t) => {
  const inst = paper()
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ dependencies: needs('a1', 'b1') })],
    // a needs b (already listed) and c; c needs main (a loop); b has only an old build
    '/project/a1/version': [mrVersion({ project_id: 'a1', dependencies: needs('b1', 'c1') })],
    '/project/b1/version': [mrVersion({ project_id: 'b1', game_versions: ['1.20.4'] })],
    '/project/c1/version': [mrVersion({ project_id: 'c1', dependencies: needs('main1') })],
    '/projects?ids=': [{ id: 'a1', slug: 'a', title: 'A' }, { id: 'b1', slug: 'b', title: 'B' }, { id: 'c1', slug: 'c', title: 'C' }],
  }))
  const plan = await planInstall(inst, 'main1', { gameVersion: '1.21.4' })
  assert.deepEqual(plan.requires.map((d) => [d.title, d.mismatch, d.builtFor]), [['A', false, null], ['C', false, null], ['B', true, '1.20.4']])
})

test('a turned-off jar is not "installed", and a jar with a name in another alphabet does not stand in for everything', async (t) => {
  const inst = paper()
  writeJar(path.join(inst.dir, 'plugins'), 'Vault.jar.disabled', 'name: Vault\n')
  writeJar(path.join(inst.dir, 'plugins'), 'jingji.jar', 'name: 经济\n')
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ dependencies: needs('vault1', 'lp1') })],
    '/project/lp1/version': [mrVersion({ project_id: 'lp1' })],
    // the name lookup fails: both are listed by id, and neither counts as here
    '/projects?ids=': null,
  }))
  const lost = await planInstall(inst, 'main1', { gameVersion: '1.21.4' })
  assert.deepEqual(brief(lost), [['vault1', false, false], ['lp1', false, false]])
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ dependencies: needs('vault1') })],
    '/projects?ids=': [{ id: 'vault1', slug: 'vault', title: 'Vault' }],
  }))
  assert.deepEqual(brief(await planInstall(inst, 'main1', { gameVersion: '1.21.4' })), [['Vault', false, true]])
})

test('a requirement named only by build is looked up, and listed even when it cannot be', async (t) => {
  const inst = paper()
  const byBuild = [{ project_id: null, version_id: 'v9', dependency_type: 'required' }]
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ dependencies: byBuild })],
    '/versions?ids=': [{ id: 'v9', project_id: 'lp1' }],
    '/project/lp1/version': [mrVersion({ project_id: 'lp1' })],
    '/projects?ids=': [{ id: 'lp1', slug: 'luckperms', title: 'LuckPerms' }],
  }))
  assert.deepEqual(brief(await planInstall(inst, 'main1', { gameVersion: '1.21.4' })), [['LuckPerms', false, false]])
  t.mock.method(globalThis, 'fetch', answers({ '/project/main1/version': [mrVersion({ dependencies: byBuild })] }))
  const blind = await planInstall(inst, 'main1', { gameVersion: '1.21.4' })
  assert.equal(blind.requires.length, 1)
  assert.deepEqual([blind.requires[0].unnamed, blind.requires[0].id, blind.requires[0].installed], [true, null, false])
})

test('a mod is known by its id as well as its name, and a modpack\'s record is not a project match', async (t) => {
  const inst = { ...fakeInstance(), jar: 'fabric-server-mc.1.21.4-loader.0.16.0-launcher.1.0.0.jar', loader: 'fabric' }
  fs.mkdirSync(path.join(inst.dir, 'mods'), { recursive: true })
  fs.writeFileSync(path.join(inst.dir, 'mods', 'cloth.jar'), buildZip([['fabric.mod.json', JSON.stringify({ id: 'cloth-config', name: 'Cloth Config v15', version: '15.0' })]]))
  fs.writeFileSync(path.join(inst.dir, 'mods', 'other.jar'), buildZip([['fabric.mod.json', JSON.stringify({ id: 'other', name: 'Other', version: '1' })]]))
  // the pack's own id is on every jar it brought; it says nothing about which project a jar is
  recordManaged(inst, 'other.jar', { source: 'modpack', project: 'arch1', version: '1' })
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ loaders: ['fabric'], dependencies: needs('cloth1', 'arch1') })],
    '/project/arch1/version': [mrVersion({ project_id: 'arch1', loaders: ['fabric'] })],
    '/projects?ids=': [{ id: 'cloth1', slug: 'cloth-config', title: 'Cloth Config API' }, { id: 'arch1', slug: 'architectury-api', title: 'Architectury API' }],
  }))
  assert.equal(listPlugins(inst).find((p) => p.file === 'cloth.jar').modId, 'cloth-config')
  assert.deepEqual(brief(await planInstall(inst, 'main1', { gameVersion: '1.21.4' })), [['Cloth Config API', true, false], ['Architectury API', false, false]])
})

test('a plan says when the only build is for another Minecraft version, and the record keeps what the build lists', async (t) => {
  const inst = paper()
  t.mock.method(globalThis, 'fetch', answers({
    '/project/main1/version': [mrVersion({ game_versions: ['1.20.1', '1.20.4'] })],
    'cdn.modrinth.com/Main.jar': new TextEncoder().encode('jar'),
  }))
  const plan = await planInstall(inst, 'main1', { gameVersion: '1.21.4' })
  assert.deepEqual([plan.exactMatch, plan.builtFor], [false, '1.20.4'])
  // a server whose version is not known is not told its plugins are for the wrong one
  assert.equal((await planInstall(inst, 'main1', {})).exactMatch, true)
  const out = await installPlugin(inst, 'main1', { gameVersion: '1.21.4' })
  assert.match(out.versionNote, /lists 1\.20\.4, not 1\.21\.4/)
  assert.deepEqual(readManaged(inst).managed['Main.jar'].gameVersions, ['1.20.1', '1.20.4'])
  assert.deepEqual(listPlugins(inst).find((p) => p.file === 'Main.jar').gameVersions, ['1.20.1', '1.20.4'])
  // a jar added by hand says nothing about versions
  writeJar(path.join(inst.dir, 'plugins'), 'Hand.jar', 'name: Hand\n')
  assert.equal(listPlugins(inst).find((p) => p.file === 'Hand.jar').gameVersions, null)
})

test('a project id that is not one never reaches a request', async (t) => {
  const inst = paper()
  const fetched = t.mock.method(globalThis, 'fetch', answers({}))
  for (const bad of ['..', '.', '', 'a/b', 'a?b', 'x'.repeat(65), 'a b']) {
    await assert.rejects(planInstall(inst, bad, {}), /not a project id/, bad)
    await assert.rejects(installPlugin(inst, bad, {}), /not a project id/, bad)
  }
  assert.equal(fetched.mock.callCount(), 0)
})

test('a Hangar plan lists required plugins, and where one that is hosted elsewhere lives', async (t) => {
  const inst = paper()
  writeJar(path.join(inst.dir, 'plugins'), 'Vault.jar', 'name: Vault\n')
  const build = (extra) => ({ name: '3.1', channel: { name: 'Release' }, platformDependencies: { PAPER: ['1.21.4'] }, downloads: { PAPER: { downloadUrl: 'https://hangar/x.jar', fileInfo: { name: 'x.jar' } } }, ...extra })
  t.mock.method(globalThis, 'fetch', answers({
    '/projects/Shop/versions': { result: [build({
      platformDependencies: { PAPER: ['1.20.4'] },
      pluginDependencies: { PAPER: [
        { name: 'Vault', required: true, externalUrl: null },
        { name: 'Citizens', required: true, externalUrl: 'https://ci.citizensnpcs.co' },
        { name: 'PlaceholderAPI', required: false, externalUrl: null },
        { name: 'ProtocolLib', required: true, externalUrl: null },
      ] },
    })] },
    '/projects/ProtocolLib/versions': { result: [build({})] },
  }))
  const plan = await planInstall(inst, 'Shop', { source: 'hangar', gameVersion: '1.21.4' })
  assert.deepEqual([plan.version, plan.exactMatch, plan.builtFor], ['3.1', false, '1.20.4'])
  assert.deepEqual(plan.requires.map((d) => [d.title, d.installed, d.external, d.mismatch]),
    [['Vault', true, null, false], ['Citizens', false, 'https://ci.citizensnpcs.co', false], ['ProtocolLib', false, null, false]])
})
