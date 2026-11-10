/**
 * Files a newer SpawnLoft (2.0, the Rust core) may have written are read by this one without
 * complaint: unknown fields are ignored and kept when the file is written back, a higher top-level
 * `version` is not refused, and a daemon reply with fields this release does not know still reads.
 * Only additions are allowed between releases, so this is what keeps 1.x and 2.0 able to share a
 * data folder in both directions.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-lenient-'))
process.env.MCCTL_DATA_ROOT = scratch

const { REGISTRY_FILE, DATA_ROOT, ROOT, stateFile } = await import('../src/paths.mjs')
const { getInstance, updateInstance, listAll } = await import('../src/registry.mjs')
const { readState, protocolOf, CONTROL_PROTOCOL } = await import('../src/control.mjs')
const schedule = await import('../src/schedule.mjs')
const { repairAfterMove, RUNTIME_FORMAT } = await import('../src/relocate.mjs')
const { dataFormatWarning, DATA_FORMAT } = await import('../src/data-format.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('instances.json from a newer release loads, and its unknown fields survive a change', () => {
  const dir = path.join(scratch, 'instances', 'smp')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
    version: 2,
    writtenBy: '2.0.0',
    instances: { smp: { dir, jar: 'paper.jar', memory: '4G', port: 25565, future: { shape: [1, 2] } } },
  }))
  assert.equal(getInstance('smp').future.shape[1], 2)
  assert.deepEqual(listAll().map((i) => i.name), ['smp'])
  updateInstance('smp', { memory: '6G' })
  const saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.writtenBy, '2.0.0')
  assert.deepEqual(saved.instances.smp.future, { shape: [1, 2] })
  assert.equal(saved.instances.smp.memory, '6G')
})

test('a state.json with fields this release does not know reads by the fields it does', () => {
  const file = stateFile('smp')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ running: false, exitCode: 0, protocol: 7, daemon: 'rust', somethingNew: { a: 1 } }))
  const { status, state } = readState('smp')
  assert.equal(status, 'stopped')
  assert.equal(state.somethingNew.a, 1)
})

test('schedules.json from a newer release loads with its unknown fields', () => {
  fs.writeFileSync(path.join(DATA_ROOT, 'schedules.json'), JSON.stringify({
    version: 3,
    tasks: { nightly: { instance: 'smp', action: { type: 'backup' }, schedule: { kind: 'daily', at: '03:00' }, retries: { max: 2 } } },
  }))
  const data = schedule.load()
  assert.equal(data.version, 3)
  assert.equal(data.tasks.nightly.retries.max, 2)
})

test('a ping reply is read for its protocol, and one from before the field speaks 1', () => {
  assert.equal(CONTROL_PROTOCOL, 1)
  assert.equal(protocolOf({ ok: true, javaPid: 1, alive: true }), 1)
  assert.equal(protocolOf({ ok: true, protocol: 2, daemon: 'rust', extra: true }), 2)
  assert.equal(protocolOf({ ok: true, protocol: 'two' }), 1)
  assert.equal(protocolOf(null), 1)
})

test('runtime.json carries format; one without it, or another format, triggers the rewrite and keeps unknown fields', () => {
  const marker = path.join(scratch, 'runtime.json')
  fs.writeFileSync(marker, JSON.stringify({ exe: process.execPath, root: ROOT, shell: 'tauri' }))
  assert.equal(repairAfterMove({ marker }).moved, true, 'a record from before format did not trigger a rewrite')
  const written = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.equal(written.format, RUNTIME_FORMAT)
  assert.equal(written.shell, 'tauri')
  assert.equal(repairAfterMove({ marker }).moved, false)

  fs.writeFileSync(marker, JSON.stringify({ ...written, format: RUNTIME_FORMAT + 1 }))
  assert.equal(repairAfterMove({ marker }).moved, true, 'a record of another format did not trigger a rewrite')
  assert.equal(repairAfterMove({ marker, force: true }).moved, true, 'force did not rewrite')
})

test('data-format.json from a newer major warns; this major, an older one or none says nothing', () => {
  const file = path.join(scratch, 'data-format.json')
  assert.equal(dataFormatWarning({ file, version: '1.7.0' }), null)
  fs.writeFileSync(file, JSON.stringify({ writtenBy: '2.0.0', format: DATA_FORMAT, extra: 1 }))
  assert.match(dataFormatWarning({ file, version: '1.7.0' }), /last used by SpawnLoft 2\.0\.0/)
  assert.equal(dataFormatWarning({ file, version: '2.1.0' }), null)
  fs.writeFileSync(file, JSON.stringify({ writtenBy: '1.6.0', format: DATA_FORMAT }))
  assert.equal(dataFormatWarning({ file, version: '1.7.0' }), null)
  fs.writeFileSync(file, JSON.stringify({ writtenBy: '1.9.0', format: DATA_FORMAT + 1 }))
  assert.match(dataFormatWarning({ file, version: '1.7.0' }), /SpawnLoft 1\.9\.0/)
  fs.writeFileSync(file, 'not json')
  assert.equal(dataFormatWarning({ file, version: '1.7.0' }), null)
})
