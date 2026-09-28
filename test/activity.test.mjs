import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-activity-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const activity = await import('../src/activity.mjs')
const files = await import('../src/files.mjs')
const backup = await import('../src/backup.mjs')
const { DATA_ROOT } = await import('../src/paths.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const log = () => path.join(DATA_ROOT, 'activity.jsonl')
function reset() {
  fs.rmSync(log(), { force: true })
  fs.rmSync(path.join(DATA_ROOT, 'activity.1.jsonl'), { force: true })
}

let seq = 0
function server(tree = {}) {
  const name = `act${++seq}`
  const dir = path.join(scratch, name)
  for (const [rel, body] of Object.entries({ 'server.properties': 'level-name=world\n', 'plugins/A/config.yml': 'a: 1\n', ...tree })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return { name, dir, jar: 'paper.jar' }
}

test('entries come back newest first, and narrow by server, actor, time and count', async () => {
  reset()
  activity.record('alpha', 'start')
  await new Promise((r) => setTimeout(r, 5))
  const mid = new Date().toISOString()
  await activity.asActor({ kind: 'assistant', name: 'Claude Desktop' }, async () => {
    activity.record('beta', 'config-edit', { detail: 'plugins/X/config.yml', snapshot: 'snap.tar.gz' })
  })
  activity.record('alpha', 'stop')

  const all = activity.readActivity()
  assert.deepEqual(all.entries.map((e) => `${e.server} ${e.action}`), ['alpha stop', 'beta config-edit', 'alpha start'])
  assert.deepEqual(activity.readActivity({ server: 'alpha' }).entries.map((e) => e.action), ['stop', 'start'])
  assert.deepEqual(activity.readActivity({ by: 'assistant' }).entries.map((e) => e.by), [{ kind: 'assistant', name: 'Claude Desktop' }])
  assert.deepEqual(activity.readActivity({ since: mid }).entries.map((e) => e.action), ['stop', 'config-edit'])
  const one = activity.readActivity({ limit: 1 })
  assert.equal(one.entries.length, 1)
  assert.equal(one.more, true)
  assert.equal(all.entries[1].snapshot, 'snap.tar.gz')
})

test('who did it follows the work through awaits, and falls back to the process default', async () => {
  reset()
  activity.record('x', 'crash')
  await activity.asActor({ kind: 'schedule', name: 'Nightly backup' }, async () => {
    await new Promise((r) => setTimeout(r, 1))
    activity.record('x', 'backup')
  })
  activity.setDefaultActor({ kind: 'cli' })
  activity.record('x', 'start')
  activity.setDefaultActor({ kind: 'spawnloft' })
  assert.deepEqual(activity.readActivity().entries.map((e) => e.by), [
    { kind: 'cli' }, { kind: 'schedule', name: 'Nightly backup' }, { kind: 'spawnloft' },
  ])
  // An actor kind nobody defined is not trusted as one.
  await activity.asActor({ kind: 'root', name: 'x' }, async () => activity.record('x', 'stop'))
  assert.equal(activity.readActivity().entries[0].by.kind, 'spawnloft')
})

test('a full log rolls over, and both halves are read', () => {
  reset()
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const old = JSON.stringify({ at: '2020-01-01T00:00:00.000Z', server: 'old', action: 'start', by: { kind: 'cli' } })
  fs.writeFileSync(log(), (old + '\n').repeat(Math.ceil(activity.MAX_BYTES / old.length) + 1))
  activity.record('new', 'stop')
  assert.ok(fs.existsSync(path.join(DATA_ROOT, 'activity.1.jsonl')))
  assert.ok(fs.statSync(log()).size < 1000)
  const read = activity.readActivity({ limit: 2 })
  assert.deepEqual(read.entries.map((e) => e.server), ['new', 'old'])
})

test('a line cut short by a crash is skipped, not fatal', () => {
  reset()
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  fs.writeFileSync(log(), '{"at":"2026-01-01T00:00:00.000Z","server":"a","action":"start","by":{"kind":"cli"}}\n{"at":"2026-01-01T00:0')
  activity.record('a', 'stop')
  assert.deepEqual(activity.readActivity().entries.map((e) => e.action), ['stop', 'start'])
})

test('a renamed server keeps its history', () => {
  reset()
  activity.record('before', 'start')
  activity.record('other', 'start')
  activity.renameServer('before', 'after')
  assert.equal(activity.readActivity({ server: 'after' }).entries.length, 1)
  assert.equal(activity.readActivity({ server: 'before' }).entries.length, 0)
  assert.equal(activity.readActivity({ server: 'other' }).entries.length, 1)
})

test('file changes are recorded with the copy that undoes them, and Undo puts it back', async () => {
  reset()
  const inst = server()
  const { version } = await files.readFile(inst, 'plugins/A/config.yml')
  await activity.asActor({ kind: 'panel' }, () => files.writeFile(inst, 'plugins/A/config.yml', { text: 'a: 2\n', version }))
  const [edit] = activity.readActivity({ server: inst.name }).entries
  assert.equal(edit.action, 'file-edit')
  assert.equal(edit.detail, 'plugins/A/config.yml')
  assert.deepEqual(edit.by, { kind: 'panel' })
  assert.ok(files.UNDOABLE.has(edit.action))

  await files.undoSnapshot(inst, edit.snapshot)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/A/config.yml'), 'utf8'), 'a: 1\n')
  const [undo] = activity.readActivity({ server: inst.name }).entries
  assert.equal(undo.action, 'undo')
  assert.equal(undo.snapshot, edit.snapshot)
})

test('Undo brings back a delete, and refuses a whole-server backup or something in use', async () => {
  reset()
  const inst = server({ 'world/level.dat': 'lvl' })
  const del = await files.deletePaths(inst, ['plugins/A'])
  assert.equal(activity.readActivity({ server: inst.name }).entries[0].action, 'file-delete')
  await files.undoSnapshot(inst, del.snapshot, { running: true })
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/A/config.yml'), 'utf8'), 'a: 1\n')

  const whole = await backup.createSnapshot(inst, { scope: 'config', label: 'manual' })
  assert.equal(activity.readActivity({ server: inst.name }).entries[0].action, 'backup')
  await assert.rejects(files.undoSnapshot(inst, path.basename(whole.file)), /backup of the server, not a copy of one change/)

  const worldCopy = await backup.createSnapshot(inst, { scope: 'files', label: 'file-edit', members: ['world'], flush: false })
  await assert.rejects(files.undoSnapshot(inst, path.basename(worldCopy.file), { running: true }), /in use by the running server/)
})

test('a narrowed or quiet snapshot is not recorded as a backup of its own', async () => {
  reset()
  const inst = server()
  await backup.createSnapshot(inst, { scope: 'plugins', label: 'pre-install', quiet: true })
  await backup.createSnapshot(inst, { scope: 'files', members: ['plugins/A/config.yml'], flush: false })
  assert.equal(activity.readActivity({ server: inst.name }).entries.length, 0)
})
