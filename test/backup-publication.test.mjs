import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-backup-publication-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const backup = await import('../src/backup.mjs')
const { BACKUPS_DIR } = await import('../src/paths.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function instance(name) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'example.jar'), 'fixture plugin contents')
  return { name, dir }
}

function controlledTar(t) {
  const children = []
  t.mock.method(childProcess, 'spawn', (binary, args) => {
    assert.equal(args[0], '-czf')
    const child = new EventEmitter()
    child.stderr = new PassThrough()
    child.stdout = new PassThrough()
    children.push({ child, file: args[1] })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return children
}

test('history and restore ignore an in-flight archive until its manifest is complete', async t => {
  const children = controlledTar(t)
  const inst = instance('pending')
  const creating = backup.createSnapshot(inst, { scope: 'plugins', label: 'manual' })
  const { child, file } = children[0]
  assert.ok(file.endsWith('.pending'))
  fs.writeFileSync(file, 'partial archive')
  assert.deepEqual(backup.listSnapshots(inst.name), [])
  assert.throws(() => backup.resolveSnapshot(inst.name, 'latest'), /no snapshots exist/)
  fs.appendFileSync(file, ' now complete')
  child.emit('exit', 0)
  const created = await creating
  const history = backup.listSnapshots(inst.name)
  assert.equal(history.length, 1)
  assert.equal(history[0].path, created.file)
  assert.equal(history[0].scope, 'plugins')
  assert.equal(history[0].label, 'manual')
  assert.deepEqual(history[0].members, ['plugins'])
  assert.equal(history[0].size, created.size)
  assert.deepEqual(JSON.parse(fs.readFileSync(created.file.replace(/\.tar\.gz$/, '.json'), 'utf8')), created.manifest)
  assert.equal(fs.existsSync(file), false)
})

test('failed and empty tar output is removed without publishing a snapshot', async t => {
  const children = controlledTar(t)
  for (const [name, code, contents, expected] of [
    ['failure', 2, 'truncated archive', /tar exited 2/],
    ['empty', 1, '', /came out empty/],
  ]) {
    const inst = instance(name)
    const creating = backup.createSnapshot(inst, { scope: 'plugins' })
    const { child, file } = children.at(-1)
    fs.writeFileSync(file, contents)
    child.stderr.write('fixture tar failure')
    child.emit('exit', code)
    await assert.rejects(creating, expected)
    assert.deepEqual(backup.listSnapshots(inst.name), [])
    assert.deepEqual(fs.readdirSync(path.join(BACKUPS_DIR, inst.name)), [])
  }
})

test('a failed final rename cleans only its own pending archive and manifest', async t => {
  const children = controlledTar(t)
  const inst = instance('rename-failure')
  const dir = path.join(BACKUPS_DIR, inst.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'existing.tar.gz'), 'existing snapshot')
  fs.writeFileSync(path.join(dir, 'existing.json'), '{"scope":"full"}')
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('.pending')) throw new Error('fixture publication failure')
    return rename(from, to)
  })
  const creating = backup.createSnapshot(inst, { scope: 'plugins' })
  fs.writeFileSync(children[0].file, 'completed archive')
  children[0].child.emit('exit', 0)
  await assert.rejects(creating, /fixture publication failure/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['existing.json', 'existing.tar.gz'])
  assert.equal(fs.readFileSync(path.join(dir, 'existing.tar.gz'), 'utf8'), 'existing snapshot')
})

test('same-second concurrent and subsequent snapshots never overwrite each other', async t => {
  const children = controlledTar(t)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-11T12:00:00Z') })
  const inst = instance('concurrent')
  const first = backup.createSnapshot(inst, { scope: 'plugins' })
  const second = backup.createSnapshot(inst, { scope: 'plugins' })
  assert.notEqual(children[0].file, children[1].file)
  assert.deepEqual(backup.listSnapshots(inst.name), [])
  fs.writeFileSync(children[0].file, 'first contents')
  fs.writeFileSync(children[1].file, 'second contents')
  children[1].child.emit('exit', 0)
  children[0].child.emit('exit', 0)
  const [a, b] = await Promise.all([first, second])
  const third = backup.createSnapshot(inst, { scope: 'plugins' })
  fs.writeFileSync(children[2].file, 'third contents')
  children[2].child.emit('exit', 0)
  const c = await third
  assert.equal(new Set([a.file, b.file, c.file]).size, 3)
  assert.equal(fs.readFileSync(a.file, 'utf8'), 'first contents')
  assert.equal(fs.readFileSync(b.file, 'utf8'), 'second contents')
  assert.equal(fs.readFileSync(c.file, 'utf8'), 'third contents')
  assert.equal(backup.listSnapshots(inst.name).length, 3)
  assert.equal(fs.readdirSync(path.join(BACKUPS_DIR, inst.name)).filter(file => file.endsWith('.pending')).length, 0)
})

test('completed real snapshots still verify and restore with their manifests', async () => {
  const inst = instance('real-archive')
  const created = await backup.createSnapshot(inst, { scope: 'plugins', label: 'manual' })
  const checked = await backup.verifySnapshot(inst.name, path.basename(created.file))
  assert.equal(checked.ok, true, checked.problems.join('; '))
  assert.equal(checked.hasManifest, true)
  assert.deepEqual(checked.snapshot.members, ['plugins'])
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'example.jar'), 'changed contents')
  await backup.restoreSnapshot(inst, checked.snapshot)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins', 'example.jar'), 'utf8'), 'fixture plugin contents')
})
