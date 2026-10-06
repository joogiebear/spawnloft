import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-files-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const files = await import('../src/files.mjs')
const backup = await import('../src/backup.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let seq = 0
function server(tree = {}) {
  const name = `srv${++seq}`
  const dir = path.join(scratch, name)
  const all = {
    'server.properties': 'motd=Hello\nserver-port=25566\nrcon.port=25576\nlevel-name=world\n',
    'paper.jar': 'jar bytes',
    'world/level.dat': Buffer.from([0, 1, 2, 3]),
    'plugins/Example.jar': 'plugin bytes',
    'plugins/Example/config.yml': 'enabled: true\nlimit: 5\n',
    ...tree,
  }
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return { name, dir, jar: 'paper.jar' }
}

const code = (c) => (err) => { assert.equal(err.code, c, err.message); return true }
const snaps = (inst) => backup.listSnapshots(inst.name)

test('paths stay inside the server folder', () => {
  const inst = server()
  for (const bad of ['../x', 'plugins/../../x', '/etc/passwd', 'C:/Windows', '..']) {
    assert.throws(() => files.resolvePath(inst, bad, { mustExist: false }), /inside the server folder|stay inside/, bad)
  }
  assert.equal(files.resolvePath(inst, '', { allowRoot: true }).rel, '')
  assert.equal(files.resolvePath(inst, 'plugins\\Example\\config.yml').rel, 'plugins/Example/config.yml')
})

test('a link that leads out of the server folder cannot be walked into', (t) => {
  const inst = server()
  const outside = fs.mkdtempSync(path.join(scratch, 'outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  try {
    fs.symlinkSync(outside, path.join(inst.dir, 'escape'), 'junction')
  } catch {
    t.skip('this machine cannot make links')
    return
  }
  assert.throws(() => files.resolvePath(inst, 'escape/secret.txt'), /leads outside/)
  const entry = files.listDir(inst, '').entries.find((e) => e.name === 'escape')
  assert.equal(entry.type, 'link')
})

test('a folder lists folders first, and while running marks what the server holds', () => {
  const inst = server()
  const stopped = files.listDir(inst, '')
  assert.deepEqual(stopped.entries.map((e) => e.name), ['plugins', 'world', 'paper.jar', 'server.properties'])
  assert.ok(stopped.entries.every((e) => !e.inUse))
  const running = files.listDir(inst, '', { running: true })
  const used = running.entries.filter((e) => e.inUse).map((e) => e.name)
  assert.deepEqual(used.sort(), ['paper.jar', 'world'])
  assert.ok(files.listDir(inst, 'plugins', { running: true }).entries.find((e) => e.name === 'Example.jar').inUse)
})

test('text reads with a version; binary and oversized files do not', async () => {
  const inst = server({ 'big.log': 'x'.repeat(files.MAX_EDIT_BYTES + 1) })
  const cfg = await files.readFile(inst, 'plugins/Example/config.yml')
  assert.equal(cfg.text, 'enabled: true\nlimit: 5\n')
  assert.match(cfg.version, /^[0-9a-f]{40}$/)
  assert.equal((await files.readFile(inst, 'world/level.dat')).reason, 'binary')
  assert.equal((await files.readFile(inst, 'big.log')).reason, 'large')
})

test('a save copies the file first, and only that file', async () => {
  const inst = server()
  const { version } = await files.readFile(inst, 'plugins/Example/config.yml')
  const out = await files.writeFile(inst, 'plugins/Example/config.yml', { text: 'enabled: false\nlimit: 5\n', version })
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/Example/config.yml'), 'utf8'), 'enabled: false\nlimit: 5\n')
  const [snap] = snaps(inst)
  assert.equal(snap.name, out.snapshot)
  assert.deepEqual(snap.members, ['plugins/Example/config.yml'])
  assert.equal(snap.label, 'file-edit')
})

test('a save over a file that changed since it was opened is refused', async () => {
  const inst = server()
  const { version } = await files.readFile(inst, 'plugins/Example/config.yml')
  fs.writeFileSync(path.join(inst.dir, 'plugins/Example/config.yml'), 'enabled: true\nlimit: 9\n')
  await assert.rejects(files.writeFile(inst, 'plugins/Example/config.yml', { text: 'x: 1\n', version }), code('changed'))
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/Example/config.yml'), 'utf8'), 'enabled: true\nlimit: 9\n')
})

test('line endings and a byte-order mark survive the editor', async () => {
  const inst = server({ 'crlf.yml': '\ufeffa: 1\r\nb: 2\r\n' })
  const { version } = await files.readFile(inst, 'crlf.yml')
  await files.writeFile(inst, 'crlf.yml', { text: 'a: 1\nb: 3\n', version })
  assert.equal(fs.readFileSync(path.join(inst.dir, 'crlf.yml'), 'utf8'), '\ufeffa: 1\r\nb: 3\r\n')
})

test('broken YAML and JSON need "save anyway"; SpawnLoft\'s own properties are refused', async () => {
  const inst = server({ 'data.json': '{"a": 1}' })
  let { version } = await files.readFile(inst, 'plugins/Example/config.yml')
  await assert.rejects(files.writeFile(inst, 'plugins/Example/config.yml', { text: 'a:\n\tb: 1\n', version }), code('format'))
  await files.writeFile(inst, 'plugins/Example/config.yml', { text: 'a:\n\tb: 1\n', version, force: true })
  ;({ version } = await files.readFile(inst, 'data.json'))
  await assert.rejects(files.writeFile(inst, 'data.json', { text: '{"a": ', version }), code('format'))
  ;({ version } = await files.readFile(inst, 'server.properties'))
  await assert.rejects(files.writeFile(inst, 'server.properties', { text: 'motd=Hello\nserver-port=1\nrcon.port=25576\nlevel-name=world\n', version }), /server-port is set by SpawnLoft/)
  await files.writeFile(inst, 'server.properties', { text: 'motd=Hi\nserver-port=25566\nrcon.port=25576\nlevel-name=world\n', version })
})

test('a new file is created empty-handed, and never over an existing one', async () => {
  const inst = server()
  const out = await files.writeFile(inst, 'plugins/Example/notes.txt', { text: 'hello', create: true })
  assert.equal(out.snapshot, null)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/Example/notes.txt'), 'utf8'), 'hello')
  await assert.rejects(files.writeFile(inst, 'plugins/Example/notes.txt', { text: 'again', create: true }), /already exists/)
  assert.equal(files.makeFolder(inst, 'plugins', 'NewOne').path, 'plugins/NewOne')
  assert.throws(() => files.makeFolder(inst, 'plugins', 'NewOne'), /already exists/)
  assert.throws(() => files.makeFolder(inst, 'plugins', 'a/b'), /no slashes/)
  assert.throws(() => files.makeFolder(inst, 'plugins', 'what?'), /not a name/)
})

test('an upload lands whole, asks before replacing, and copies what it replaces', async () => {
  const inst = server()
  const out = await files.uploadFile(inst, 'plugins', 'New.jar', Readable.from([Buffer.from('new '), Buffer.from('plugin')]))
  assert.equal(out.size, 10)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/New.jar'), 'utf8'), 'new plugin')
  await assert.rejects(files.uploadFile(inst, 'plugins', 'Example.jar', Readable.from(['v2'])), code('exists'))
  const replaced = await files.uploadFile(inst, 'plugins', 'Example.jar', Readable.from(['v2']), { overwrite: true })
  assert.deepEqual(snaps(inst).find((s) => s.name === replaced.snapshot).members, ['plugins/Example.jar'])
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/Example.jar'), 'utf8'), 'v2')
  assert.ok(!fs.readdirSync(path.join(inst.dir, 'plugins')).some((f) => f.endsWith('.part')))
})

test('a dropped folder arrives with its structure, and cannot climb out', async () => {
  const inst = server()
  const out = await files.uploadFile(inst, 'plugins', 'Pack/lang/en.yml', Readable.from(['hi']))
  assert.equal(out.path, 'plugins/Pack/lang/en.yml')
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/Pack/lang/en.yml'), 'utf8'), 'hi')
  await assert.rejects(files.uploadFile(inst, 'plugins', 'Pack/lang/en.yml', Readable.from(['v2'])), code('exists'))
  await assert.rejects(files.uploadFile(inst, 'plugins', '../evil.yml', Readable.from(['x'])), /no slashes|stay inside|not a name/)
  await assert.rejects(files.uploadFile(inst, 'plugins', 'Pack/../../evil.yml', Readable.from(['x'])), /no slashes|stay inside|not a name/)
  await assert.rejects(files.uploadFile(inst, 'plugins', 'Pack/lang/en.yml/x.yml', Readable.from(['x'])), /in the way|not a folder/)
})

test('while running, a loaded plugin is not replaced but a new one can be added', async () => {
  const inst = server()
  await assert.rejects(files.uploadFile(inst, 'plugins', 'Example.jar', Readable.from(['v2']), { overwrite: true, running: true }), /in use by the running server/)
  await files.uploadFile(inst, 'plugins', 'Another.jar', Readable.from(['x']), { running: true })
})

test('rename and move, but not into itself and not what the running server holds', () => {
  const inst = server()
  assert.equal(files.movePath(inst, 'plugins/Example/config.yml', 'plugins/Example/config.old.yml').path, 'plugins/Example/config.old.yml')
  files.makeFolder(inst, '', 'archive')
  files.movePath(inst, 'plugins/Example', 'archive/Example')
  assert.ok(fs.existsSync(path.join(inst.dir, 'archive/Example/config.old.yml')))
  assert.throws(() => files.movePath(inst, 'archive', 'archive/inner'), /inside itself/)
  assert.throws(() => files.movePath(inst, 'world', 'world2', { running: true }), /in use/)
  assert.throws(() => files.movePath(inst, 'plugins/Example.jar', 'plugins/Other.jar', { running: true }), /in use/)
  assert.throws(() => files.movePath(inst, 'paper.jar', 'server.properties'), /already exists/)
})

test('a delete keeps a copy of everything it removes', async () => {
  const inst = server({ 'plugins/Example/lang/en.yml': 'hi: there\n' })
  const out = await files.deletePaths(inst, ['plugins/Example', 'plugins/Example/lang/en.yml', 'plugins/Example.jar'])
  assert.deepEqual(out.deleted.sort(), ['plugins/Example', 'plugins/Example.jar'])
  assert.ok(!fs.existsSync(path.join(inst.dir, 'plugins/Example')))
  const snap = snaps(inst).find((s) => s.name === out.snapshot)
  assert.equal(snap.label, 'file-delete')
  assert.deepEqual(snap.members.sort(), ['plugins/Example', 'plugins/Example.jar'])
  await assert.rejects(files.deletePaths(inst, ['world'], { running: true }), /in use/)
  const bare = await files.deletePaths(inst, ['paper.jar'], { withoutCopy: true })
  assert.equal(bare.snapshot, null)
})

test('zip up, then unpack beside it without overwriting anything', async () => {
  const inst = server({ 'plugins/Example/lang/en.yml': 'hi: there\n' })
  const zipped = await files.archivePaths(inst, ['plugins/Example'], 'pack')
  assert.equal(zipped.path, 'plugins/pack.zip')
  assert.equal((await files.extractArchive(inst, 'plugins/pack.zip')).path, 'plugins/pack')
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/pack/Example/lang/en.yml'), 'utf8'), 'hi: there\n')
  assert.equal((await files.extractArchive(inst, 'plugins/pack.zip')).path, 'plugins/pack (2)')
  await assert.rejects(files.archivePaths(inst, ['plugins/Example', 'server.properties']), /one folder at a time/)
  await assert.rejects(files.extractArchive(inst, 'server.properties'), /not a .zip/)
  assert.ok(!fs.readdirSync(path.join(inst.dir, 'plugins')).some((f) => f.startsWith('.spawnloft-extract-')))
})

test('search finds names at any depth', async () => {
  const inst = server({ 'plugins/Deep/a/b/c/Target-config.yml': 'x: 1\n' })
  const out = await files.searchNames(inst, '', 'target')
  assert.deepEqual(out.results.map((r) => r.path), ['plugins/Deep/a/b/c/Target-config.yml'])
  await assert.rejects(files.searchNames(inst, '', 'x'), /at least two/)
})

test('a folder downloads as a zip that is cleaned up afterwards', async () => {
  const inst = server()
  const file = await files.downloadable(inst, 'plugins/Example/config.yml')
  assert.equal(file.name, 'config.yml')
  const folder = await files.downloadable(inst, 'plugins/Example')
  assert.equal(folder.name, 'Example.zip')
  assert.ok(fs.statSync(folder.file).size > 0)
  folder.done()
  assert.ok(!fs.existsSync(folder.file))
})
