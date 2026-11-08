import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { loaderOf } from '../src/registry.mjs'
import { contentKindFor, loadersFor, mcVersionOf, listPlugins } from '../src/plugins.mjs'
import { launcherName } from '../src/fabric.mjs'

test('an instance with no loader field is a Paper instance - the whole migration', () => {
  assert.equal(loaderOf({ name: 'old' }), 'paper')
  assert.equal(loaderOf({ name: 'new', loader: 'fabric' }), 'fabric')
})

test('content follows the loader: folder, vocabulary, facet and Hangar', () => {
  const paper = contentKindFor({ loader: 'paper' })
  assert.deepEqual([paper.dir, paper.projectType, paper.hangar], ['plugins', 'plugin', true])
  const fabricKind = contentKindFor({ loader: 'fabric' })
  assert.deepEqual([fabricKind.dir, fabricKind.projectType, fabricKind.hangar], ['mods', 'mod', false])
  assert.deepEqual(loadersFor({ loader: 'fabric' }), ['fabric'])
  assert.ok(loadersFor({}).includes('paper'))
})

test('the game version reads out of a Fabric launcher name too', () => {
  const name = launcherName('26.2', '0.19.3', '1.1.2')
  assert.equal(name, 'fabric-server-mc.26.2-loader.0.19.3-launcher.1.1.2.jar')
  assert.equal(mcVersionOf({ jar: name }), '26.2')
})

test('a fabric.mod.json manifest is read from a jar in mods/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-loader-'))
  fs.mkdirSync(path.join(dir, 'mods'))
  const inst = { name: 'modded', dir, jar: 'fabric-server-mc.26.2-loader.0.19.3-launcher.1.1.2.jar', loader: 'fabric' }
  // A stored (uncompressed) zip holding only the manifest, built by hand like the zip tests.
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: 'lithium',
    name: 'Lithium',
    version: '0.14.3',
    description: 'No-compromises optimization mod',
    authors: ['jellysquid3', { name: '2No2Name' }],
    contact: { homepage: 'https://example.com' },
  })
  const raw = Buffer.from(manifest)
  const nameBuf = Buffer.from('fabric.mod.json')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(zlib.crc32(raw), 14)
  local.writeUInt32LE(raw.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt32LE(raw.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const cd = Buffer.concat([central, nameBuf])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(30 + nameBuf.length + raw.length, 16)
  fs.writeFileSync(path.join(dir, 'mods', 'lithium.jar'), Buffer.concat([local, nameBuf, raw, cd, eocd]))

  const rows = listPlugins(inst)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Lithium')
  assert.equal(rows[0].version, '0.14.3')
  assert.deepEqual(rows[0].authors, ['jellysquid3', '2No2Name'])
})
