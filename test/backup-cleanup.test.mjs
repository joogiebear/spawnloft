/**
 * Backups in bulk: which snapshots are small copies, deleting several at once, and the clean-up a
 * server can turn on. Own file: it starts a panel for the two routes.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-backup-cleanup-'))
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const backup = await import('../src/backup.mjs')
const registry = await import('../src/registry.mjs')
const activity = await import('../src/activity.mjs')
const { INSTANCES_DIR } = await import('../src/paths.mjs')
const { serve } = await import('../src/ui.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')

let seq = 0
function server() {
  const name = `tidy${++seq}`
  const dir = path.join(INSTANCES_DIR, name)
  const tree = {
    'server.jar': '',
    'server.properties': 'level-name=world\n',
    'world/level.dat': 'level',
    'plugins/A.jar': 'a',
    'notes.txt': 'n',
  }
  for (const [rel, body] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  registry.putInstance(name, { dir, jar: 'server.jar', memory: '1G', port: 41700 + seq })
  return registry.getInstance(name)
}

const DAY = 24 * 3600 * 1000
/** Take one and make it look `days` old. Returns its file name. */
async function taken(inst, opts, days = 0) {
  const out = await backup.createSnapshot(inst, { flush: false, quiet: true, ...opts })
  if (days) {
    const at = new Date(Date.now() - days * DAY)
    fs.utimesSync(out.file, at, at)
  }
  return path.basename(out.file)
}
/** A copy as SpawnLoft takes one before a change. */
const copied = (inst, opts, days = 0) => taken(inst, { changeCopy: true, ...opts }, days)
/** Rewrites a manifest as an older SpawnLoft wrote it: no record of who asked for it. */
function asBefore(inst, file) {
  const m = path.join(path.dirname(backup.listSnapshots(inst.name)[0].path), file.replace(/\.tar\.gz$/, '.json'))
  const json = JSON.parse(fs.readFileSync(m, 'utf8'))
  delete json.changeCopy
  fs.writeFileSync(m, JSON.stringify(json))
}
const names = (inst) => backup.listSnapshots(inst.name).map((s) => s.name).sort()
const said = (inst, action) => activity.readActivity({ server: inst.name }).entries.filter((e) => e.action === action).map((e) => e.detail)

const panel = await serve({ port: 0 })
const send = (inst, verb, body) => panelFetch(`${panel.url}api/instances/${inst.name}/backups/${verb}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
after(async () => {
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('a small copy is what SpawnLoft took by itself before a change, and nothing else', async () => {
  const inst = server()
  const install = await copied(inst, { scope: 'plugins', label: 'pre-install' })
  const edit = await copied(inst, { scope: 'files', label: 'file-edit', members: ['notes.txt'] })
  const asked = await taken(inst, { scope: 'config', label: 'manual' })
  // someone's own backup, labelled with a word SpawnLoft also uses: still theirs
  const askedLikeOurs = await taken(inst, { scope: 'plugins', label: 'pre-update' })
  const scheduled = await copied(inst, { scope: 'plugins', label: 'pre-update', taskId: 't1' })
  const world = await taken(inst, { scope: 'files', label: 'world-delete', members: ['world'] })
  const whole = await taken(inst, { scope: 'standard', label: 'pre-upgrade' })
  // from before the manifest recorded it: told by the label SpawnLoft wrote then
  const oldInstall = await taken(inst, { scope: 'plugins', label: 'pre-install' })
  asBefore(inst, oldInstall)
  const oldAsked = await taken(inst, { scope: 'plugins', label: 'plugins-only' })
  asBefore(inst, oldAsked)
  const copy = Object.fromEntries(backup.listSnapshots(inst.name).map((s) => [s.name, s.copy]))
  assert.equal(copy[install], true)
  assert.equal(copy[edit], true)
  assert.equal(copy[oldInstall], true)
  assert.equal(copy[asked], false)
  assert.equal(copy[askedLikeOurs], false)
  assert.equal(copy[scheduled], false)
  assert.equal(copy[world], false)
  assert.equal(copy[whole], false)
  assert.equal(copy[oldAsked], false)
  assert.equal(backup.isChangeCopy(null), false)
  assert.equal(backup.isChangeCopy({}), false)
  // a whole backup is never one, whatever its manifest claims
  assert.equal(backup.isChangeCopy({ scope: 'standard', changeCopy: true }), false)
})

test('the copies SpawnLoft takes before a change say that they are', async () => {
  const files = await import('../src/files.mjs')
  const inst = server()
  await files.writeFile(inst, 'notes.txt', { text: 'changed', version: (await files.readFile(inst, 'notes.txt')).version })
  await files.deletePaths(inst, ['notes.txt'])
  const rows = backup.listSnapshots(inst.name)
  assert.deepEqual(rows.map((s) => [s.label, s.copy]).sort(), [['file-delete', true], ['file-edit', true]])
})

test('several are deleted at once by exact name, and a locked or missing one is left and said', async () => {
  const inst = server()
  const a = await taken(inst, { scope: 'plugins', label: 'pre-install' })
  const b = await taken(inst, { scope: 'config', label: 'manual' })
  const kept = await taken(inst, { scope: 'standard', label: 'manual' })
  const locked = await taken(inst, { scope: 'plugins', label: 'pre-update' })
  backup.setSnapshotLocked(inst.name, locked, true)
  const out = backup.removeSnapshots(inst.name, [a, b, a, locked, 'nothing.tar.gz'])
  assert.deepEqual(out.removed.sort(), [a, b].sort())
  assert.ok(out.size > 0)
  assert.deepEqual(out.skipped, [{ name: locked, reason: 'locked' }, { name: 'nothing.tar.gz', reason: 'missing' }])
  assert.deepEqual(names(inst), [kept, locked].sort())
  // the manifests went with the archives
  assert.equal(fs.readdirSync(path.dirname(backup.listSnapshots(inst.name)[0].path)).filter((f) => f.endsWith('.json')).length, 2)
  // one line for the lot
  assert.equal(said(inst, 'backup-delete').length, 1)
  assert.match(said(inst, 'backup-delete')[0], /^2 backups, /)
  // a part of a name, or "latest", names nothing here
  assert.deepEqual(backup.removeSnapshots(inst.name, ['latest', 'standard']).removed, [])
  assert.deepEqual(names(inst), [kept, locked].sort())
  // one that will not go (open somewhere, on Windows) is left whole and said; the other still goes
  const stuck = await taken(inst, { scope: 'config', label: 'manual' })
  const free = await taken(inst, { scope: 'plugins', label: 'manual' })
  const dir = path.dirname(backup.listSnapshots(inst.name)[0].path)
  fs.rmSync(path.join(dir, stuck))
  fs.mkdirSync(path.join(dir, stuck))
  fs.writeFileSync(path.join(dir, stuck, 'held'), '')
  const partly = backup.removeSnapshots(inst.name, [stuck, free])
  assert.deepEqual(partly.removed, [free])
  assert.deepEqual(partly.skipped, [{ name: stuck, reason: 'busy' }])
  assert.ok(fs.existsSync(path.join(dir, stuck.replace(/\.tar\.gz$/, '.json'))), 'its manifest stays with it')
  assert.equal(said(inst, 'backup-delete').at(0), free)
  fs.rmSync(path.join(dir, stuck), { recursive: true })
  assert.throws(() => backup.removeSnapshots(inst.name, []), /which backups/)
  assert.throws(() => backup.removeSnapshots(inst.name, new Array(backup.REMOVE_MANY_LIMIT + 1).fill('x')), /at most/)
})

test('the clean-up removes old small copies and nothing else', async () => {
  const inst = server()
  const oldCopy = await copied(inst, { scope: 'plugins', label: 'pre-install' }, 31)
  const oldEdit = await copied(inst, { scope: 'files', label: 'file-edit', members: ['notes.txt'] }, 45)
  const newCopy = await copied(inst, { scope: 'plugins', label: 'pre-update' }, 29)
  const oldLocked = await copied(inst, { scope: 'config', label: 'before-edit', members: ['server.properties'] }, 90)
  backup.setSnapshotLocked(inst.name, oldLocked, true)
  const oldNoted = await copied(inst, { scope: 'plugins', label: 'pre-install' }, 60)
  // a note rewrites the manifest, not the archive: still 60 days old
  backup.setSnapshotNote(inst.name, oldNoted, 'the build that worked')
  // what was deleted in Files is nowhere else
  const oldDeleted = await copied(inst, { scope: 'files', label: 'file-delete', members: ['notes.txt'] }, 400)
  const oldWhole = await taken(inst, { scope: 'standard', label: 'pre-upgrade' }, 400)
  const oldAsked = await taken(inst, { scope: 'config', label: 'manual' }, 400)
  const oldAskedLikeOurs = await taken(inst, { scope: 'plugins', label: 'pre-install' }, 400)
  const oldWorld = await taken(inst, { scope: 'files', label: 'world-delete', members: ['world'] }, 400)
  const stays = [newCopy, oldLocked, oldNoted, oldDeleted, oldWhole, oldAsked, oldAskedLikeOurs, oldWorld].sort()

  assert.deepEqual(backup.oldCopies(inst.name).map((s) => s.name).sort(), [oldCopy, oldEdit].sort())
  // narrowed to named ones: a name that is not due, or not there, removes nothing
  assert.deepEqual(backup.cleanCopies(inst.name, { only: [oldCopy, newCopy, oldWhole, 'nothing.tar.gz'] }).removed, [oldCopy])
  assert.deepEqual(names(inst), [...stays, oldEdit].sort())
  const out = backup.cleanCopies(inst.name)
  assert.deepEqual(out.removed, [oldEdit])
  assert.deepEqual(names(inst), stays)
  assert.match(said(inst, 'backup-prune')[0], /^1 small copy older than 30 days, /)
  // nothing left to do: nothing removed, nothing said
  assert.deepEqual(backup.cleanCopies(inst.name).removed, [])
  assert.equal(said(inst, 'backup-prune').length, 2)
})

test('nothing is deleted or cleaned up while a backup is being restored', async () => {
  const { beginRestore } = await import('../src/control.mjs')
  const inst = server()
  const old = await copied(inst, { scope: 'plugins', label: 'pre-install' }, 40)
  registry.updateInstance(inst.name, { backupCleanCopies: true })
  const end = beginRestore(inst.name, 'x.tar.gz')
  try {
    assert.throws(() => backup.removeSnapshots(inst.name, [old]), /being put back/)
    assert.deepEqual(backup.cleanCopies(inst.name).removed, [])
    assert.equal((await send(inst, 'delete-many', { snapshots: [old] })).status >= 400, true)
    assert.equal((await send(inst, 'clean-copies', { on: true, remove: [old] })).status, 409)
    // the copy a restore keeps of what it replaces is taken all the same, and clears nothing
    await taken(registry.getInstance(inst.name), { scope: 'files', label: 'pre-restore', members: ['notes.txt'], duringRestore: true })
    assert.ok(names(inst).includes(old))
  } finally {
    if (typeof end === 'function') end()
    else if (end && typeof end.end === 'function') end.end()
  }
})

test('the clean-up runs after a snapshot only for a server that turned it on', async () => {
  const inst = server()
  const old = await copied(inst, { scope: 'plugins', label: 'pre-install' }, 40)
  assert.deepEqual(backup.oldCopies(inst.name).map((s) => s.name), [old])
  await copied(inst, { scope: 'plugins', label: 'pre-update' })
  assert.ok(names(inst).includes(old), 'off: an old copy stays')
  registry.updateInstance(inst.name, { backupCleanCopies: true })
  await taken(registry.getInstance(inst.name), { scope: 'standard', label: 'manual' })
  assert.ok(!names(inst).includes(old), 'on: the next snapshot clears it')
})

test('the panel deletes several, and refuses a request that names nothing', async () => {
  const inst = server()
  const a = await copied(inst, { scope: 'plugins', label: 'pre-install' })
  const b = await taken(inst, { scope: 'standard', label: 'manual' })
  for (const bad of [{}, { snapshots: [] }, { snapshots: 'all' }, { snapshots: [a, 7] }]) {
    assert.equal((await send(inst, 'delete-many', bad)).status, 400, JSON.stringify(bad))
  }
  assert.deepEqual(names(inst), [a, b].sort())
  const res = await send(inst, 'delete-many', { snapshots: [a, '../' + b] })
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.deepEqual(out.removed, [a])
  assert.deepEqual(out.skipped, [{ name: '../' + b, reason: 'missing' }])
  assert.deepEqual(names(inst), [b])
})

test('the panel turns the clean-up on and off, says so, and clears only what it was shown', async () => {
  const inst = server()
  const old = await copied(inst, { scope: 'plugins', label: 'pre-install' }, 31)
  const alsoOld = await copied(inst, { scope: 'plugins', label: 'pre-update' }, 50)
  const fresh = await copied(inst, { scope: 'plugins', label: 'pre-update' })
  const whole = await taken(inst, { scope: 'standard', label: 'manual' }, 200)
  const all = [old, alsoOld, fresh, whole].sort()
  const history = async () => (await panelFetch(`${panel.url}api/instances/${inst.name}/backups/history`)).json()
  let h = await history()
  assert.equal(h.cleanCopies, false)
  assert.equal(h.copyDays, 30)
  assert.equal(h.snapshots.find((s) => s.name === old).copy, true)
  for (const bad of [{}, { on: 'yes' }, { on: 1 }, { enabled: true }]) {
    assert.equal((await send(inst, 'clean-copies', bad)).status, 400, JSON.stringify(bad))
  }
  assert.equal(registry.getInstance(inst.name).backupCleanCopies, undefined)

  // only the named ones that really are old small copies go now
  const on = await (await send(inst, 'clean-copies', { on: true, remove: [old, fresh, whole, 7, '../x'] })).json()
  assert.equal(on.cleanCopies, true)
  assert.deepEqual(on.removed, [old])
  assert.deepEqual(names(inst), [alsoOld, fresh, whole].sort())
  assert.equal(registry.getInstance(inst.name).backupCleanCopies, true)
  // reading the history removes nothing, with the clean-up on and an old copy waiting
  h = await history()
  assert.equal(h.cleanCopies, true)
  await (await panelFetch(`${panel.url}api/instances/${inst.name}/backups`)).json()
  assert.deepEqual(names(inst), [alsoOld, fresh, whole].sort())

  const off = await (await send(inst, 'clean-copies', { on: false, remove: [alsoOld] })).json()
  assert.equal(off.cleanCopies, false)
  assert.deepEqual(off.removed, [])
  assert.notEqual(registry.getInstance(inst.name).backupCleanCopies, true)
  assert.deepEqual(names(inst), [alsoOld, fresh, whole].sort())
  assert.deepEqual(said(inst, 'settings').sort(), ['small copies are kept until deleted', 'small copies are removed after 30 days'])
  assert.equal(all.length, 4)
})

test('a change whose copy is gone is listed as that, so Undo is not offered for it', async () => {
  const files = await import('../src/files.mjs')
  const inst = server()
  await files.writeFile(inst, 'notes.txt', { text: 'one', version: (await files.readFile(inst, 'notes.txt')).version })
  const log = async () => (await (await panelFetch(`${panel.url}api/instances/${inst.name}/activity`)).json()).entries.find((e) => e.action === 'file-edit')
  let entry = await log()
  assert.ok(entry.snapshot)
  assert.equal(entry.snapshotGone, undefined)
  backup.removeSnapshots(inst.name, [entry.snapshot])
  entry = await log()
  assert.equal(entry.snapshotGone, true)
})
