import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-backup-controls-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const backup = await import('../src/backup.mjs')
const { tarBinary } = await import('../src/tar.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let seq = 0
function server(extra = {}) {
  const name = `bc${++seq}`
  const dir = path.join(scratch, name)
  const tree = {
    'server.properties': 'level-name=world\n',
    'world/level.dat': 'level',
    'world/region/r.0.0.mca': 'region',
    'plugins/A.jar': 'a',
    'plugins/dynmap/web/tiles/t1.png': 'tile',
    'plugins/dynmap/config.txt': 'cfg',
    'plugins/B/debug.log': 'log',
  }
  for (const [rel, body] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return { name, dir, jar: 'paper.jar', ...extra }
}

const listing = (file) => execFileSync(tarBinary(), ['-tzf', file], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\/$/, ''))

test('a locked snapshot survives Delete and retention, and unlocking hands it back', async () => {
  const inst = server()
  const a = await backup.createSnapshot(inst, { scope: 'config', label: 'scheduled', taskId: 't' })
  await new Promise((r) => setTimeout(r, 1100))
  await backup.createSnapshot(inst, { scope: 'config', label: 'scheduled', taskId: 't' })
  const oldest = path.basename(a.file)
  backup.setSnapshotLocked(inst.name, oldest, true)
  assert.throws(() => backup.removeSnapshot(inst.name, oldest), /is locked/)
  assert.deepEqual(backup.pruneSnapshots(inst.name, 1, { only: 'scheduled', taskId: 't' }), [])
  assert.equal(backup.listSnapshots(inst.name).find((s) => s.name === oldest).locked, true)
  backup.setSnapshotLocked(inst.name, oldest, false)
  backup.removeSnapshot(inst.name, oldest)
  assert.equal(backup.listSnapshots(inst.name).length, 1)
})

test('a note is kept with the snapshot, cleaned up and removable', async () => {
  const inst = server()
  const s = await backup.createSnapshot(inst, { scope: 'config' })
  backup.setSnapshotNote(inst.name, path.basename(s.file), '  before the\n1.21 upgrade  ')
  assert.equal(backup.listSnapshots(inst.name)[0].note, 'before the 1.21 upgrade')
  backup.setSnapshotNote(inst.name, path.basename(s.file), '')
  assert.equal(backup.listSnapshots(inst.name)[0].note, null)
})

test('the leave-out list keeps paths out of backups, but not out of a copy of named files', async () => {
  const inst = server({ backupExclude: backup.cleanExcludePatterns('plugins/dynmap/web\n*.log\n# a comment\n') })
  assert.deepEqual(inst.backupExclude, ['plugins/dynmap/web', '*.log'])
  const full = await backup.createSnapshot(inst, { scope: 'standard' })
  const inside = listing(full.file)
  assert.ok(inside.includes('plugins/dynmap/config.txt'))
  assert.ok(!inside.some((p) => p.startsWith('plugins/dynmap/web')), inside.join(','))
  assert.ok(!inside.includes('plugins/B/debug.log'))
  assert.deepEqual(backup.listSnapshots(inst.name)[0].excluded, ['plugins/dynmap/web', '*.log'])
  const named = await backup.createSnapshot(inst, { scope: 'files', members: ['plugins/B'], flush: false })
  assert.ok(listing(named.file).includes('plugins/B/debug.log'))
})

test('a leave-out list cannot climb out or leave out everything', () => {
  for (const bad of ['../x', '/etc', 'C:/x', '*', 'plugins/../../x']) assert.throws(() => backup.cleanExcludePatterns(bad), /inside the server folder|everything/, bad)
  assert.throws(() => backup.cleanExcludePatterns(Array.from({ length: 41 }, (_, i) => `p${i}`)), /40 lines/)
  assert.deepEqual(backup.cleanExcludePatterns('a\\b/\n./c\na\\b'), ['a/b', 'c'])
})

test('a clean restore ends exactly as the snapshot was, and keeps what it cleared', async () => {
  const inst = server()
  const snap = await backup.createSnapshot(inst, { scope: 'standard' })
  // Since the snapshot: a plugin added, a region grown, a file changed.
  fs.writeFileSync(path.join(inst.dir, 'plugins/New.jar'), 'new')
  fs.writeFileSync(path.join(inst.dir, 'world/region/r.1.0.mca'), 'grown')
  fs.writeFileSync(path.join(inst.dir, 'plugins/A.jar'), 'changed')

  const over = backup.resolveSnapshot(inst.name, path.basename(snap.file))
  await backup.restoreSnapshot(inst, over)
  assert.ok(fs.existsSync(path.join(inst.dir, 'plugins/New.jar')), 'an ordinary restore only adds and overwrites')
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/A.jar'), 'utf8'), 'a')

  const out = await backup.restoreSnapshot(inst, over, { clean: true })
  assert.ok(!fs.existsSync(path.join(inst.dir, 'plugins/New.jar')))
  assert.ok(!fs.existsSync(path.join(inst.dir, 'world/region/r.1.0.mca')))
  assert.equal(fs.readFileSync(path.join(inst.dir, 'world/level.dat'), 'utf8'), 'level')
  const safety = backup.listSnapshots(inst.name).find((s) => s.name === out.safety)
  assert.equal(safety.label, 'pre-restore')
  assert.ok(listing(safety.path).includes('plugins/New.jar'), 'what was cleared is kept')
})
