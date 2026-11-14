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
  const install = await taken(inst, { scope: 'plugins', label: 'pre-install' })
  const edit = await taken(inst, { scope: 'files', label: 'file-edit', members: ['notes.txt'] })
  const asked = await taken(inst, { scope: 'config', label: 'manual' })
  const scheduled = await taken(inst, { scope: 'plugins', label: 'pre-update', taskId: 't1' })
  const world = await taken(inst, { scope: 'files', label: 'world-delete', members: ['world'] })
  const whole = await taken(inst, { scope: 'standard', label: 'pre-upgrade' })
  const copy = Object.fromEntries(backup.listSnapshots(inst.name).map((s) => [s.name, s.copy]))
  assert.equal(copy[install], true)
  assert.equal(copy[edit], true)
  // someone asked for this one, a schedule made that one, and a deleted world may have no other copy
  assert.equal(copy[asked], false)
  assert.equal(copy[scheduled], false)
  assert.equal(copy[world], false)
  assert.equal(copy[whole], false)
  assert.equal(backup.isChangeCopy(null), false)
  assert.equal(backup.isChangeCopy({}), false)
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
  assert.throws(() => backup.removeSnapshots(inst.name, []), /which backups/)
  assert.throws(() => backup.removeSnapshots(inst.name, new Array(backup.REMOVE_MANY_LIMIT + 1).fill('x')), /at most/)
})

test('the clean-up removes old small copies and nothing else', async () => {
  const inst = server()
  const oldCopy = await taken(inst, { scope: 'plugins', label: 'pre-install' }, 31)
  const oldEdit = await taken(inst, { scope: 'files', label: 'file-delete', members: ['notes.txt'] }, 45)
  const newCopy = await taken(inst, { scope: 'plugins', label: 'pre-update' }, 29)
  const oldLocked = await taken(inst, { scope: 'config', label: 'before-edit', members: ['server.properties'] }, 90)
  backup.setSnapshotLocked(inst.name, oldLocked, true)
  const oldNoted = await taken(inst, { scope: 'plugins', label: 'pre-install' }, 60)
  backup.setSnapshotNote(inst.name, oldNoted, 'the build that worked')
  // a note rewrites the manifest, not the archive: still 60 days old
  const oldWhole = await taken(inst, { scope: 'standard', label: 'pre-upgrade' }, 400)
  const oldAsked = await taken(inst, { scope: 'config', label: 'manual' }, 400)
  const oldWorld = await taken(inst, { scope: 'files', label: 'world-delete', members: ['world'] }, 400)

  assert.deepEqual(backup.oldCopies(inst.name).map((s) => s.name).sort(), [oldCopy, oldEdit].sort())
  const out = backup.cleanCopies(inst.name)
  assert.deepEqual(out.removed.sort(), [oldCopy, oldEdit].sort())
  assert.deepEqual(names(inst), [newCopy, oldLocked, oldNoted, oldWhole, oldAsked, oldWorld].sort())
  assert.match(said(inst, 'backup-prune')[0], /^2 small copies older than 30 days, /)
  // nothing left to do: nothing removed, nothing said
  assert.deepEqual(backup.cleanCopies(inst.name).removed, [])
  assert.equal(said(inst, 'backup-prune').length, 1)
})

test('the clean-up runs after a snapshot only for a server that turned it on', async () => {
  const inst = server()
  const old = await taken(inst, { scope: 'plugins', label: 'pre-install' }, 40)
  await taken(inst, { scope: 'plugins', label: 'pre-update' })
  assert.ok(names(inst).includes(old), 'off: an old copy stays')
  registry.updateInstance(inst.name, { backupCleanCopies: true })
  await taken(registry.getInstance(inst.name), { scope: 'standard', label: 'manual' })
  assert.ok(!names(inst).includes(old), 'on: the next snapshot clears it')
})

test('the panel deletes several, and refuses a request that names nothing', async () => {
  const inst = server()
  const a = await taken(inst, { scope: 'plugins', label: 'pre-install' })
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

test('the panel turns the clean-up on and off, says so, and clears what is already old', async () => {
  const inst = server()
  const old = await taken(inst, { scope: 'plugins', label: 'pre-install' }, 31)
  const fresh = await taken(inst, { scope: 'plugins', label: 'pre-update' })
  const history = async () => (await panelFetch(`${panel.url}api/instances/${inst.name}/backups/history`)).json()
  let h = await history()
  assert.equal(h.cleanCopies, false)
  assert.equal(h.copyDays, 30)
  assert.equal(h.snapshots.find((s) => s.name === old).copy, true)
  // reading the history removed nothing, whatever the setting
  assert.deepEqual(names(inst), [old, fresh].sort())
  for (const bad of [{}, { on: 'yes' }, { on: 1 }, { enabled: true }]) {
    assert.equal((await send(inst, 'clean-copies', bad)).status, 400, JSON.stringify(bad))
  }
  assert.equal(registry.getInstance(inst.name).backupCleanCopies, undefined)

  const on = await (await send(inst, 'clean-copies', { on: true })).json()
  assert.equal(on.cleanCopies, true)
  assert.deepEqual(on.removed, [old])
  assert.deepEqual(names(inst), [fresh])
  assert.equal(registry.getInstance(inst.name).backupCleanCopies, true)
  h = await history()
  assert.equal(h.cleanCopies, true)

  const off = await (await send(inst, 'clean-copies', { on: false })).json()
  assert.equal(off.cleanCopies, false)
  assert.deepEqual(off.removed, [])
  assert.notEqual(registry.getInstance(inst.name).backupCleanCopies, true)
  assert.deepEqual(said(inst, 'settings').sort(), ['small copies are kept until deleted', 'small copies are removed after 30 days'])
  assert.equal(said(inst, 'settings').length, 2)
})
