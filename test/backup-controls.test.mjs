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
  fs.writeFileSync(path.join(inst.dir, 'plugins/New.jar'), 'new')
  fs.writeFileSync(path.join(inst.dir, 'world/region/r.1.0.mca'), 'grown')
  fs.writeFileSync(path.join(inst.dir, 'plugins/A.jar'), 'changed')

  const over = backup.resolveSnapshot(inst.name, path.basename(snap.file))
  const plain = await backup.restoreSnapshot(inst, over)
  assert.ok(fs.existsSync(path.join(inst.dir, 'plugins/New.jar')), 'an ordinary restore only adds and overwrites')
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/A.jar'), 'utf8'), 'a')
  // an ordinary restore overwrites too, so it keeps a copy of how things were as well
  const kept = backup.listSnapshots(inst.name).find((s) => s.name === plain.safety)
  assert.equal(kept.label, 'pre-restore')
  const undo = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-undo-'))
  execFileSync(tarBinary(), ['-xzf', kept.path, '-C', undo])
  assert.equal(fs.readFileSync(path.join(undo, 'plugins/A.jar'), 'utf8'), 'changed', 'the overwritten file is in the copy')
  fs.rmSync(undo, { recursive: true, force: true })
  // a caller that is itself an undo asks for no copy
  assert.equal((await backup.restoreSnapshot(inst, over, { safety: false })).safety, null)

  const out = await backup.restoreSnapshot(inst, over, { clean: true })
  assert.ok(!fs.existsSync(path.join(inst.dir, 'plugins/New.jar')))
  assert.ok(!fs.existsSync(path.join(inst.dir, 'world/region/r.1.0.mca')))
  assert.equal(fs.readFileSync(path.join(inst.dir, 'world/level.dat'), 'utf8'), 'level')
  const safety = backup.listSnapshots(inst.name).find((s) => s.name === out.safety)
  assert.equal(safety.label, 'pre-restore')
  assert.ok(listing(safety.path).includes('plugins/New.jar'), 'what was cleared is kept')
})

test('while a restore runs, a second restore, a delete, a new backup and a change to its files are refused', async () => {
  const control = await import('../src/control.mjs')
  const files = await import('../src/files.mjs')
  const inst = server()
  const snap = await backup.createSnapshot(inst, { scope: 'standard' })
  const ref = backup.resolveSnapshot(inst.name, path.basename(snap.file))
  const first = backup.restoreSnapshot(inst, ref)
  assert.equal(backup.isRestoring(inst.name), true)
  await assert.rejects(backup.restoreSnapshot(inst, ref), /being put back.*restoring another/)
  assert.throws(() => backup.removeSnapshot(inst.name, ref.name), /being put back.*deleting a backup/)
  await assert.rejects(backup.createSnapshot(inst, { scope: 'config' }), /being put back.*taking a new one/)
  // everything that asks "may I touch this server's files" hears about it: delete, rename, worlds
  assert.match(control.activeBlock(inst.name, 'deleting it'), /being put back.*deleting it/)
  await assert.rejects(files.deletePaths(inst, ['plugins/A.jar'], { running: false }), /being put back/)
  await first
  assert.equal(backup.isRestoring(inst.name), false)
  assert.equal(control.activeBlock(inst.name, 'deleting it'), null)
  // a restore that fails releases the server too
  await assert.rejects(backup.restoreSnapshot({ ...inst, dir: path.join(scratch, 'gone') }, ref), /missing/)
  assert.equal(backup.isRestoring(inst.name), false)

  // The mark is a file, so another process sees it, and one left by a process that died is not
  // believed: a crash halfway through a restore must not lock the server for good.
  const done = control.beginRestore(inst.name)
  const { stateFile } = await import('../src/paths.mjs')
  const marker = path.join(path.dirname(stateFile(inst.name)), 'restoring.json')
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, process.pid)
  fs.writeFileSync(marker, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }))
  assert.equal(control.isRestoring(inst.name), false)
  done()
  await backup.restoreSnapshot(inst, ref)
})

test('"latest" is the newest real backup, not the copy a restore kept', async () => {
  const inst = server()
  const snap = await backup.createSnapshot(inst, { scope: 'standard' })
  const out = await backup.restoreSnapshot(inst, backup.resolveSnapshot(inst.name, 'latest'))
  assert.match(out.safety, /^pre-restore_/)
  assert.equal(backup.listSnapshots(inst.name)[0].label, 'pre-restore')
  assert.equal(backup.resolveSnapshot(inst.name, 'latest').name, path.basename(snap.file))
  // by name it can still be restored, which is how the first restore is undone
  assert.equal(backup.resolveSnapshot(inst.name, out.safety).name, out.safety)
})

test('a restore whose copy cannot be kept changes nothing, and goes ahead only when asked to', async () => {
  const inst = server()
  const snap = await backup.createSnapshot(inst, { scope: 'config' })
  const ref = backup.resolveSnapshot(inst.name, path.basename(snap.file))
  fs.writeFileSync(path.join(inst.dir, 'server.properties'), 'level-name=changed\n')
  // the backups folder cannot be written: the copy fails the way a full disk makes it fail
  const dir = path.dirname(ref.path)
  const lock = path.join(dir, '.snapshot.lock')
  fs.rmSync(lock, { recursive: true, force: true })
  fs.chmodSync(dir, 0o500)
  try {
    if (process.platform !== 'win32' && process.getuid() !== 0) {
      await assert.rejects(backup.restoreSnapshot(inst, ref), (err) => err.code === 'no-copy' && /nothing was changed/.test(err.message))
      assert.equal(fs.readFileSync(path.join(inst.dir, 'server.properties'), 'utf8'), 'level-name=changed\n')
      await assert.rejects(backup.restoreSnapshot(inst, ref, { clean: true }), (err) => err.code === undefined && /nothing was changed/.test(err.message))
    }
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  const out = await backup.restoreSnapshot(inst, ref, { safety: false })
  assert.equal(out.safety, null)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'server.properties'), 'utf8'), 'level-name=world\n')
})

test('a snapshot that may be torn or is missing a database says so in the listing, in plain words', async () => {
  assert.deepEqual(backup.snapshotProblems([
    'could not flush the world before the snapshot (RCON timed out); the copy may be torn',
    'database survival on main-db not included: the database is not running',
    'database cache on fast not included: Redis (Garnet) keeps its own checkpoints; it is not dumped',
    'world/session.lock not included: another program has it locked, usually the running server',
    'tar: something harmless',
  ]), [
    'Taken while the server was running and it could not be asked to save first, so the world in it may be incomplete.',
    'Does not include the database survival (main-db): the database is not running.',
  ])
  assert.deepEqual(backup.snapshotProblems(undefined), [])

  const inst = server()
  const snap = await backup.createSnapshot(inst, { scope: 'config' })
  const manifest = snap.file.replace(/\.tar\.gz$/, '.json')
  const body = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  assert.deepEqual(backup.listSnapshots(inst.name)[0].problems, [])
  body.warnings = ['database survival on main-db not included: the database is not running']
  fs.writeFileSync(manifest, JSON.stringify(body))
  assert.deepEqual(backup.listSnapshots(inst.name)[0].problems, ['Does not include the database survival (main-db): the database is not running.'])
})
