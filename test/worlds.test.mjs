import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listWorlds, findWorldRoot, activateWorld, deleteWorld, importWorld } from '../src/worlds.mjs'
import { UserError } from '../src/util.mjs'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-worlds-'))

function world(dir, name) {
  fs.mkdirSync(path.join(dir, name, 'region'), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'level.dat'), 'nbt')
  fs.writeFileSync(path.join(dir, name, 'region', 'r.0.0.mca'), 'chunks')
}

function fakeInstance({ active = 'world' } = {}) {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, 'server.properties'), `level-name=${active}\n`)
  return { name: 'worlds-test-not-registered', dir }
}

test('worlds are folders with a level.dat; companions fold into their base row', async () => {
  const inst = fakeInstance({ active: 'rpg' })
  world(inst.dir, 'rpg')
  world(inst.dir, 'rpg_nether')
  world(inst.dir, 'old')
  fs.mkdirSync(path.join(inst.dir, 'plugins'))
  const data = await listWorlds(inst)
  assert.equal(data.active, 'rpg')
  assert.deepEqual(data.worlds.map((w) => [w.name, w.active, w.dimensions]),
    [['rpg', true, ['nether']], ['old', false, []]])
  assert.ok(data.worlds[0].size > 0)
})

test('a companion with no base world of its own is listed as a world', async () => {
  const inst = fakeInstance()
  world(inst.dir, 'orphan_nether')
  assert.deepEqual((await listWorlds(inst)).worlds.map((w) => w.name), ['orphan_nether'])
})

test('the shallowest level.dat wins, however the download is wrapped', () => {
  const dir = scratch()
  world(dir, 'TheMap')
  assert.equal(findWorldRoot(dir), path.join(dir, 'TheMap'))

  const wrapped = scratch()
  world(path.join(wrapped, 'Amazing Map v2', 'files'), 'world')
  assert.equal(findWorldRoot(wrapped), path.join(wrapped, 'Amazing Map v2', 'files', 'world'))

  const bare = scratch()
  fs.writeFileSync(path.join(bare, 'level.dat'), 'nbt')
  assert.equal(findWorldRoot(bare), bare)

  assert.equal(findWorldRoot(scratch()), null)
})

test('a nested backup can never win over the map itself', () => {
  const dir = scratch()
  world(dir, 'map')
  world(path.join(dir, 'map', 'backups'), 'old-copy')
  assert.equal(findWorldRoot(dir), path.join(dir, 'map'))
})

test('importing a folder copies the world in under the new name, lock stripped', async () => {
  const inst = fakeInstance()
  const download = scratch()
  world(path.join(download, 'Cool Map'), 'world')
  fs.writeFileSync(path.join(download, 'Cool Map', 'world', 'session.lock'), 'stale')
  world(path.join(download, 'Cool Map'), 'world_nether')

  const res = await importWorld(inst, download, { name: 'coolmap' })
  assert.equal(res.name, 'coolmap')
  assert.deepEqual(res.dimensions, ['nether'])
  assert.ok(fs.existsSync(path.join(inst.dir, 'coolmap', 'level.dat')))
  assert.ok(fs.existsSync(path.join(inst.dir, 'coolmap_nether', 'level.dat')))
  assert.ok(!fs.existsSync(path.join(inst.dir, 'coolmap', 'session.lock')), 'the stale lock came along')
  assert.ok(fs.existsSync(path.join(download, 'Cool Map', 'world', 'level.dat')), 'the source is untouched')
})

test('a taken name is refused before anything is copied', async () => {
  const inst = fakeInstance()
  world(inst.dir, 'world')
  const download = scratch()
  world(download, 'world')
  await assert.rejects(() => importWorld(inst, download, { name: 'world' }), UserError)
})

test('a source with no world in it is a readable refusal', async () => {
  const inst = fakeInstance()
  await assert.rejects(() => importWorld(inst, scratch(), { name: 'nothing' }), /does not hold a world/)
})

test('activate writes level-name; a non-world target is refused', async () => {
  const inst = fakeInstance({ active: 'world' })
  world(inst.dir, 'world')
  world(inst.dir, 'better')
  activateWorld(inst, 'better')
  assert.equal((await listWorlds(inst)).active, 'better')
  assert.throws(() => activateWorld(inst, 'plugins'), UserError)
  assert.throws(() => activateWorld(inst, '..'), UserError)
})

test('the active world cannot be deleted; an inactive one goes with its companions', () => {
  const inst = fakeInstance({ active: 'keep' })
  world(inst.dir, 'keep')
  world(inst.dir, 'old')
  world(inst.dir, 'old_nether')
  assert.throws(() => deleteWorld(inst, 'keep'), /active world/)
  const res = deleteWorld(inst, 'old')
  assert.deepEqual(res.removed, ['old', 'old_nether'])
  assert.ok(!fs.existsSync(path.join(inst.dir, 'old')))
  assert.ok(fs.existsSync(path.join(inst.dir, 'keep')))
})
