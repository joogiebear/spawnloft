import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-server-list-'))
process.env.MCCTL_DATA_ROOT = scratch

const { readNbt, writeNbt, mutf8, fromMutf8, addressKey, reconcile, syncServerList, versionKeepsServerList } = await import('../src/client-server-list.mjs')
const { launch, stop, createProfile, updateProfile, duplicateProfile, getProfile, serversFor, fillServerList } = await import('../src/client.mjs')
const { putInstance, updateInstance, removeInstance } = await import('../src/registry.mjs')
const { INSTANCES_DIR } = await import('../src/paths.mjs')
const { versionDir, versionJson, profileDir, clientServerList } = await import('../src/client-paths.mjs')

const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')
const mc = '1.21.11'
fs.mkdirSync(versionDir(mc), { recursive: true })
fs.copyFileSync(path.join(here, 'fixtures', 'client', `${mc}.json`), versionJson(mc))

after(async () => {
  for (const name of ['list']) { try { await stop(name) } catch { /* not running */ } }
  fs.rmSync(scratch, { recursive: true, force: true })
})

// ---- a servers.dat as the game writes it, built by hand so the reader is checked against the
// format and not against the writer ------------------------------------------------------------
const b = (...bytes) => Buffer.from(bytes)
const u16 = (n) => { const x = Buffer.alloc(2); x.writeUInt16BE(n); return x }
const i32 = (n) => { const x = Buffer.alloc(4); x.writeInt32BE(n); return x }
const str = (s) => { const raw = Buffer.from(s, 'utf8'); return Buffer.concat([u16(raw.length), raw]) }
const named = (type, name) => Buffer.concat([b(type), str(name)])
function entry(fields) {
  const parts = []
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') parts.push(named(8, key), str(value))
    else parts.push(named(1, key), b(value ? 1 : 0))
  }
  parts.push(b(0))
  return Buffer.concat(parts)
}
function serversDat(entries) {
  return Buffer.concat([named(10, ''), named(9, 'servers'), b(entries.length ? 10 : 0), i32(entries.length), ...entries.map(entry), b(0)])
}
function listOf(file) {
  const doc = readNbt(fs.readFileSync(file))
  const list = doc.root.entries.find((e) => fromMutf8(e.key) === 'servers').tag
  return list.items.map((item) => Object.fromEntries(item.entries.map((e) => [fromMutf8(e.key), e.tag.type === 8 ? fromMutf8(e.tag.raw) : e.tag.raw[0]])))
}

test('a servers.dat is read and written back byte for byte', () => {
  const file = serversDat([
    { name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'iVBORw0KGgo=', acceptTextures: true },
    { name: 'Café ☕', ip: '192.168.1.20:25566', hidden: false },
  ])
  assert.deepEqual(writeNbt(readNbt(file)), file)
  // every other kind of tag a mod might leave in the file survives too
  const odd = Buffer.concat([
    named(10, ''),
    named(2, 's'), b(0x12, 0x34), named(3, 'i'), i32(-5), named(4, 'l'), Buffer.alloc(8, 7), named(5, 'f'), Buffer.alloc(4, 1), named(6, 'd'), Buffer.alloc(8, 2),
    named(7, 'ba'), i32(3), b(1, 2, 3), named(11, 'ia'), i32(2), Buffer.alloc(8, 9), named(12, 'la'), i32(1), Buffer.alloc(8, 4),
    named(9, 'empty'), b(0), i32(0), named(9, 'nested'), b(9), i32(1), b(3), i32(2), i32(1), i32(2),
    named(10, 'inner'), named(8, 'k'), str('v'), b(0),
    b(0),
  ])
  assert.deepEqual(writeNbt(readNbt(odd)), odd)
})

test('a file that is not whole NBT is refused, not guessed at', () => {
  const good = serversDat([{ name: 'A', ip: 'a.example' }])
  assert.throws(() => readNbt(good.subarray(0, good.length - 3)), /ends in the middle/)
  assert.throws(() => readNbt(Buffer.concat([good, b(0)])), /left over/)
  assert.throws(() => readNbt(Buffer.from([0x1f, 0x8b, 8, 0])), /not an NBT file/)
  assert.throws(() => readNbt(Buffer.concat([named(10, ''), named(13, 'x'), b(0)])), /unknown tag type 13/)
  assert.throws(() => readNbt(Buffer.alloc(0)), /ends in the middle/)
  // a list that claims a billion items in a ten-byte file
  assert.throws(() => readNbt(Buffer.concat([named(10, ''), named(9, 'servers'), b(10), i32(0x3fffffff)])), /ends in the middle/)
})

test('names are written the way Java reads them', () => {
  assert.deepEqual(mutf8('abc'), Buffer.from('abc'))
  assert.deepEqual(mutf8('é'), Buffer.from([0xc3, 0xa9]))
  assert.deepEqual(mutf8('\u0000'), Buffer.from([0xc0, 0x80]))
  // outside the basic plane: two three-byte halves, not one four-byte character
  assert.equal(mutf8('\u{1F600}').length, 6)
  for (const s of ['Survival', 'Café ☕', '\u{1F600} smile', 'a\u0000b']) assert.equal(fromMutf8(mutf8(s)), s)
})

test('one place, however it is spelled', () => {
  assert.equal(addressKey('localhost'), addressKey('127.0.0.1:25565'))
  assert.equal(addressKey('LOCALHOST:25566'), addressKey('127.0.0.1:25566'))
  assert.notEqual(addressKey('127.0.0.1:25566'), addressKey('127.0.0.1'))
  assert.equal(addressKey('[::1]:25570'), addressKey('localhost:25570'))
  assert.equal(addressKey('Play.Example.net.'), addressKey('play.example.net:25565'))
  assert.equal(addressKey('LOCALHOST.'), addressKey('127.0.0.1'))
})

const compound = (fields) => readNbt(Buffer.concat([named(10, ''), entry(fields).subarray(0, -1), b(0)])).root
const plain = (items) => items.map((item) => Object.fromEntries(item.entries.map((e) => [fromMutf8(e.key), e.tag.type === 8 ? fromMutf8(e.tag.raw) : e.tag.raw[0]])))

test('reconcile adds, follows and removes only what SpawnLoft wrote', () => {
  const items = [compound({ name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'abc' })]
  const survival = { key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }
  const creative = { key: 'creative', name: 'Creative', ip: '127.0.0.1:25566' }
  let out = reconcile(items, {}, [survival, creative])
  assert.deepEqual([out.added, out.updated, out.removed, out.changed], [2, 0, 0, true])
  assert.deepEqual(plain(items), [{ name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'abc' }, { name: 'Survival', ip: '127.0.0.1:25565' }, { name: 'Creative', ip: '127.0.0.1:25566' }])
  // nothing to do the second time
  let state = out.next
  out = reconcile(items, state, [survival, creative])
  assert.equal(out.changed, false)
  // the game adds what it knows to an entry (an icon, a choice about resource packs): still ours
  items[1].entries.push(...compound({ icon: 'png', acceptTextures: true }).entries)
  // a rename and a new port follow; the icon the game saved stays
  out = reconcile(items, out.next, [{ ...survival, name: 'Survival SMP', ip: '127.0.0.1:25570' }, creative])
  assert.deepEqual([out.added, out.updated, out.removed], [0, 1, 0])
  assert.deepEqual(plain(items)[1], { name: 'Survival SMP', ip: '127.0.0.1:25570', icon: 'png', acceptTextures: 1 })
  // a server that is gone (deleted, or moved to another version) takes its entry with it
  out = reconcile(items, out.next, [creative])
  assert.deepEqual([out.added, out.updated, out.removed], [0, 0, 1])
  assert.deepEqual(plain(items).map((e) => e.name), ['Hypixel', 'Creative'])
  assert.deepEqual(Object.keys(out.next), ['creative'])
  // the player's own entry was never touched
  assert.deepEqual(plain(items)[0], { name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'abc' })
})

test('an entry the player edited or deleted is theirs from then on', () => {
  const survival = { key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }
  const creative = { key: 'creative', name: 'Creative', ip: '127.0.0.1:25566' }
  const items = []
  let out = reconcile(items, {}, [survival, creative])
  // renamed in the game, and the other one deleted there
  items[0].entries[0].tag = { type: 8, raw: mutf8('my world') }
  items.splice(1, 1)
  out = reconcile(items, out.next, [survival, creative])
  assert.equal(out.changed, false)
  assert.equal(out.next.survival.state, 'theirs')
  assert.equal(out.next.creative.state, 'dismissed')
  assert.deepEqual(plain(items), [{ name: 'my world', ip: '127.0.0.1:25565' }])
  // and stays so, launch after launch, even when SpawnLoft's name for the server changes
  out = reconcile(items, out.next, [{ ...survival, name: 'Renamed' }, creative])
  assert.equal(out.changed, false)
  assert.deepEqual(plain(items), [{ name: 'my world', ip: '127.0.0.1:25565' }])
  // a deleted one comes back only when the server moves to another address
  out = reconcile(items, out.next, [survival, { ...creative, ip: '127.0.0.1:25599' }])
  assert.equal(out.added, 1)
  assert.deepEqual(plain(items)[1], { name: 'Creative', ip: '127.0.0.1:25599' })
})

test('an address the player already lists is not added twice', () => {
  const items = [compound({ name: 'home', ip: 'localhost' }), compound({ name: 'typed once', ip: '127.0.0.1:25566', hidden: true })]
  const out = reconcile(items, {}, [{ key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }, { key: 'creative', name: 'Creative', ip: '127.0.0.1:25566' }])
  // "localhost" is the survival server already; a Direct Connection address is not on the list
  assert.equal(out.added, 1)
  assert.equal(out.next.survival.state, 'theirs')
  assert.deepEqual(plain(items).map((e) => e.name), ['home', 'typed once', 'Creative'])
})

test('a server that moves after its entry was edited in the game is listed again at the new address', () => {
  const survival = { key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }
  const items = []
  let out = reconcile(items, {}, [survival])
  items[0].entries[0].tag = { type: 8, raw: mutf8('my name') }
  // the edit and the move are seen in the same launch
  out = reconcile(items, out.next, [{ ...survival, ip: '127.0.0.1:25570' }])
  assert.equal(out.next.survival.state, 'theirs')
  assert.equal(out.next.survival.ip, '127.0.0.1:25565')
  out = reconcile(items, out.next, [{ ...survival, ip: '127.0.0.1:25570' }])
  assert.deepEqual(plain(items), [{ name: 'my name', ip: '127.0.0.1:25565' }, { name: 'Survival', ip: '127.0.0.1:25570' }])
})

test('two SpawnLoft servers on one address are both listed, and each goes by itself', () => {
  const a = { key: 'a', name: 'A', ip: '127.0.0.1:25565' }
  const b = { key: 'b', name: 'B', ip: '127.0.0.1:25565' }
  const items = []
  let out = reconcile(items, {}, [a, b])
  assert.deepEqual(plain(items).map((e) => e.name), ['A', 'B'])
  assert.deepEqual([out.next.a.state, out.next.b.state], ['ours', 'ours'])
  out = reconcile(items, out.next, [b])
  assert.deepEqual(plain(items).map((e) => e.name), ['B'])
  // the same name too: two entries, two owners, and one goes when its server does
  const twin = [{ key: 'x', name: 'Same', ip: '127.0.0.1:25566' }, { key: 'y', name: 'Same', ip: '127.0.0.1:25566' }]
  const list = []
  out = reconcile(list, {}, twin)
  assert.equal(list.length, 2)
  out = reconcile(list, out.next, twin)
  assert.equal(out.changed, false)
  out = reconcile(list, out.next, [twin[0]])
  assert.equal(list.length, 1)
  assert.equal(out.removed, 1)
})

test('a server named like something every object has is listed like any other', () => {
  const items = []
  const wanted = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'].map((key, i) => ({ key, name: key, ip: `127.0.0.1:${25600 + i}` }))
  let out = reconcile(items, {}, wanted)
  assert.equal(out.added, 4)
  out = reconcile(items, out.next, wanted)
  assert.equal(out.changed, false)
  out = reconcile(items, out.next, [])
  assert.equal(out.removed, 4)
  assert.deepEqual(items, [])
})

test('a stop between the two writes never leaves an entry SpawnLoft has forgotten is its own', () => {
  const survival = { key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }
  const creative = { key: 'creative', name: 'Creative', ip: '127.0.0.1:25566' }
  // an add: the memory was written, the file was not
  let items = []
  let out = reconcile(items, {}, [survival])
  assert.equal(out.before.survival.pending, true)
  let again = reconcile([], out.before, [survival])
  assert.equal(again.added, 1, 'an add that never reached the file is added, not taken for a delete')
  // an add: both were written, the second memory write was not
  again = reconcile(items, out.before, [survival])
  assert.equal(again.changed, false)
  assert.deepEqual(again.next.survival, { ip: '127.0.0.1:25565', name: 'Survival', state: 'ours' })
  // a rename: memory written, file not; the entry is found by what it said before
  const moved = { ...survival, name: 'Survival SMP', ip: '127.0.0.1:25570' }
  const stale = [compound({ name: 'Survival', ip: '127.0.0.1:25565', icon: 'png' })]
  out = reconcile([compound({ name: 'Survival', ip: '127.0.0.1:25565', icon: 'png' })], out.next, [moved])
  assert.deepEqual(out.before.survival.prev, { ip: '127.0.0.1:25565', name: 'Survival' })
  again = reconcile(stale, out.before, [moved])
  assert.equal(again.updated, 1)
  assert.deepEqual(plain(stale), [{ name: 'Survival SMP', ip: '127.0.0.1:25570', icon: 'png' }])
  // a removal: memory written, file not; it is still SpawnLoft's to remove
  items = []
  out = reconcile(items, {}, [survival, creative])
  const kept = plain(items).map((e) => compound(e))
  out = reconcile(items, out.next, [creative])
  assert.equal(out.before.survival.state, 'ours')
  again = reconcile(kept, out.before, [creative])
  assert.equal(again.removed, 1)
  assert.deepEqual(plain(kept).map((e) => e.name), ['Creative'])
  // and what is remembered in the end carries none of the marks
  assert.deepEqual(Object.keys(again.next.creative).sort(), ['ip', 'name', 'state'])
})

test('a damaged memory of what was written is no memory, and nothing is removed for it', () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'state-'))
  const file = path.join(dir, 'servers.dat')
  const stateFile = path.join(dir, 'server-list.json')
  const wanted = [{ key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }]
  syncServerList({ file, stateFile, wanted })
  for (const junk of ['{ not json', '[]', '"text"', '{"entries": [1, 2]}', '{"entries": {"survival": 7, "x": null}}']) {
    fs.writeFileSync(stateFile, junk)
    const out = syncServerList({ file, stateFile, wanted })
    assert.equal(out.skipped, null, junk)
    assert.equal(out.changed, false, junk)
    assert.deepEqual(listOf(file), [{ name: 'Survival', ip: '127.0.0.1:25565' }], junk)
  }
})

test('a file of a great many tags is refused before it can use the memory up', () => {
  const many = 150000
  const big = Buffer.concat([named(10, ''), named(9, 'junk'), b(1), i32(many), Buffer.alloc(many), b(0)])
  assert.throws(() => readNbt(big), /more tags than a server list holds/)
})

test('the file: made when missing, left alone when unreadable, not written when nothing changed', () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'file-'))
  const file = path.join(dir, 'servers.dat')
  const stateFile = path.join(dir, 'run', 'server-list.json')
  const wanted = [{ key: 'survival', name: 'Survival', ip: '127.0.0.1:25565' }]
  // nothing wanted and nothing written before: no file is made
  assert.deepEqual(syncServerList({ file, stateFile, wanted: [] }), { changed: false, added: 0, updated: 0, removed: 0, skipped: null })
  assert.equal(fs.existsSync(file), false)
  let out = syncServerList({ file, stateFile, wanted })
  assert.equal(out.added, 1)
  assert.deepEqual(listOf(file), [{ name: 'Survival', ip: '127.0.0.1:25565' }])
  const first = fs.statSync(file).mtimeMs
  out = syncServerList({ file, stateFile, wanted })
  assert.equal(out.changed, false)
  assert.equal(fs.statSync(file).mtimeMs, first)
  // turned off: ours goes, and so does the memory of it
  out = syncServerList({ file, stateFile, wanted: [] })
  assert.equal(out.removed, 1)
  assert.deepEqual(listOf(file), [])
  assert.equal(fs.existsSync(stateFile), false)
  // an empty list the game wrote (a list of nothing) takes entries
  fs.writeFileSync(file, serversDat([]))
  assert.equal(syncServerList({ file, stateFile, wanted }).added, 1)
  assert.deepEqual(listOf(file), [{ name: 'Survival', ip: '127.0.0.1:25565' }])
  // a file cut short is reported and left exactly as it is
  fs.rmSync(stateFile)
  const broken = serversDat([{ name: 'A', ip: 'a.example' }]).subarray(0, 20)
  fs.writeFileSync(file, broken)
  out = syncServerList({ file, stateFile, wanted })
  assert.match(out.skipped, /could not be read/)
  assert.deepEqual(fs.readFileSync(file), broken)
  assert.equal(fs.existsSync(stateFile), false)
  // so is one where "servers" is something else
  const odd = Buffer.concat([named(10, ''), named(8, 'servers'), str('no'), b(0)])
  fs.writeFileSync(file, odd)
  assert.match(syncServerList({ file, stateFile, wanted }).skipped, /does not hold a list/)
  assert.deepEqual(fs.readFileSync(file), odd)
})

test('games older than 1.7 are left alone', () => {
  assert.equal(versionKeepsServerList({ releaseTime: '2025-12-09T12:23:30+00:00' }), true)
  assert.equal(versionKeepsServerList({ releaseTime: '2013-10-25T13:00:00+00:00' }), true)
  assert.equal(versionKeepsServerList({ releaseTime: '2013-09-19T15:52:37+00:00' }), false)
  assert.equal(versionKeepsServerList({ releaseTime: '2011-09-14T22:00:00+00:00' }), false)
  assert.equal(versionKeepsServerList({}), false)
  assert.equal(versionKeepsServerList(null), false)
})

// ---- through a launch --------------------------------------------------------------------------

function makeServer(name, port, { mcVersion = mc, label = undefined, props = 'online-mode=false\nserver-ip=\n' } = {}) {
  const dir = path.join(INSTANCES_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), props)
  putInstance(name, { dir, jar: 'server.jar', memory: '1G', port, mcVersion, ...(label ? { label } : {}) })
}

test('a launch puts the servers on the setup\'s version into its Multiplayer list', async () => {
  makeServer('survival', 45701, { label: 'Survival SMP' })
  makeServer('lan', 45702, { props: 'server-ip=192.168.1.50\n' })
  makeServer('old', 45703, { mcVersion: '1.20.4' })
  makeServer('noport', undefined)
  putInstance('db', { dir: path.join(INSTANCES_DIR, 'db'), kind: 'database', engine: 'mysql', port: 45704 })
  createProfile('list', { mc })
  assert.equal(getProfile('list').serverList, true)
  // not the one on another version, the one with no port, or the database
  assert.deepEqual(serversFor(getProfile('list')).sort((x, y) => x.key.localeCompare(y.key)), [
    { key: 'lan', name: 'lan', ip: '192.168.1.50:45702' },
    { key: 'survival', name: 'Survival SMP', ip: '127.0.0.1:45701' },
  ])
  const file = path.join(profileDir('list'), 'servers.dat')
  fs.writeFileSync(file, serversDat([{ name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'abc' }]))
  const warnings = []
  await launch('list', { fakeJava, onWarning: (w) => warnings.push(w) })
  await stop('list')
  assert.deepEqual(warnings, [])
  const names = () => listOf(file).map((e) => e.name).sort()
  assert.deepEqual(names(), ['Hypixel', 'Survival SMP', 'lan'])
  assert.deepEqual(listOf(file)[0], { name: 'Hypixel', ip: 'mc.hypixel.net', icon: 'abc' })

  // a server that moves to another version leaves the list; a new port follows
  updateInstance('lan', { mcVersion: '1.20.4' })
  updateInstance('survival', { port: 45711 })
  await launch('list', { fakeJava })
  await stop('list')
  assert.deepEqual(listOf(file).slice(1), [{ name: 'Survival SMP', ip: '127.0.0.1:45711' }])

  // a copy of the setup knows which entries were SpawnLoft's
  const copy = duplicateProfile('list')
  removeInstance('survival')
  assert.equal(fillServerList(copy.name).removed, 1)
  assert.deepEqual(listOf(path.join(profileDir(copy.name), 'servers.dat')).map((e) => e.name), ['Hypixel'])

  // switched off: what SpawnLoft wrote goes, the player's entry stays, and the file is then left alone
  makeServer('survival', 45711, { label: 'Survival SMP' })
  await launch('list', { fakeJava })
  await stop('list')
  assert.deepEqual(names(), ['Hypixel', 'Survival SMP'])
  updateProfile('list', { serverList: false })
  await launch('list', { fakeJava })
  await stop('list')
  assert.deepEqual(names(), ['Hypixel'])
  assert.equal(fs.existsSync(clientServerList('list')), false)
  assert.throws(() => updateProfile('list', { serverList: 'no' }), /serverList must be true or false/)
})

test('a list that cannot be read is a warning, and the game still starts', async () => {
  updateProfile('list', { serverList: true })
  const file = path.join(profileDir('list'), 'servers.dat')
  const broken = Buffer.from('not nbt at all')
  fs.writeFileSync(file, broken)
  const warnings = []
  const res = await launch('list', { fakeJava, onWarning: (w) => warnings.push(w) })
  await stop('list')
  assert.ok(res.pid)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Multiplayer list was not brought up to date: servers\.dat could not be read/)
  assert.deepEqual(fs.readFileSync(file), broken)
})

test('a server on another version is a warning at launch', async () => {
  fs.rmSync(path.join(profileDir('list'), 'servers.dat'))
  const warnings = []
  await launch('list', { fakeJava, server: 'old', playerName: 'tester', onWarning: (w) => warnings.push(w) })
  await stop('list')
  assert.ok(warnings.some((w) => /server "old" runs Minecraft 1\.20\.4 and this profile is 1\.21\.11/.test(w)), warnings.join('\n'))
})
