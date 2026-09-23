import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  readZipEntry, parsePluginYml, mcVersionOf, listPlugins, setPluginEnabled, removePlugin,
  pickVersion, primaryFile, LOADERS, readManaged, recordManaged, pickHangarVersion, searchHangar,
} from '../src/plugins.mjs'
import { UserError } from '../src/util.mjs'

// ---- a zip built by hand, so the reader is tested against the format itself ----

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

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-plugins-'))

function writeJar(dir, name, yml, opts) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, buildZip([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'], ['plugin.yml', yml]], opts))
  return file
}

// ---- the zip reader ---------------------------------------------------------

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

// ---- the manifest reader ----------------------------------------------------

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

// ---- the installed list -----------------------------------------------------

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

test('a hand-dropped jar is not managed; one mcctl recorded is', () => {
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

// ---- choosing a Modrinth version --------------------------------------------

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

// ---- choosing a Hangar version ----------------------------------------------

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
  // The shape Hangar's /projects endpoint returns: the count lives at stats.downloads. Reading a
  // field it does not have showed every Hangar result as never downloaded.
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: [{
    name: 'Chunky', namespace: { owner: 'pop4959', slug: 'Chunky' }, description: 'Pre-generates chunks',
    stats: { views: 252983, downloads: 76528, recentViews: 7015, recentDownloads: 2392, stars: 303, watchers: 157 },
  }] }), { headers: { 'content-type': 'application/json' } }))
  const [hit] = await searchHangar('chunky')
  assert.equal(hit.downloads, 76528)
  assert.equal(hit.id, 'Chunky')
  assert.equal(hit.source, 'hangar')
})
