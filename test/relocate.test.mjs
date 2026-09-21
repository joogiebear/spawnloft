/**
 * The repair that runs when the installation has moved: task shims and launchers are rewritten
 * for the runtime running now, once, and left alone while nothing has changed.
 *
 * <p>Isolated the way manage.test.mjs is: MCCTL_DATA_ROOT points every path at a scratch folder
 * before the first module that resolves paths is imported.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-relocate-'))
process.env.MCCTL_DATA_ROOT = scratch

const { putInstance } = await import('../src/registry.mjs')
const { DATA_ROOT, INSTANCES_DIR, ROOT } = await import('../src/paths.mjs')
const { repairAfterMove, runtimeSignature } = await import('../src/relocate.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const marker = path.join(scratch, 'runtime.json')
const tasksFile = path.join(DATA_ROOT, 'schedules.json')
const posix = process.platform !== 'win32'
const shim = path.join(DATA_ROOT, 'tasks', posix ? 'nightly.sh' : 'nightly.cmd')
// Linux gets shell launchers; macOS still gets the batch files it always has.
const launcher = (name) => name + (process.platform === 'linux' ? '.sh' : '.bat')

function stale(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

test('with no record, shims and launchers are rewritten for this runtime and a record is kept', () => {
  const dir = path.join(INSTANCES_DIR, 'smp')
  fs.mkdirSync(dir, { recursive: true })
  putInstance('smp', { dir, jar: 'paper.jar', memory: '4G', port: 25565 })
  fs.writeFileSync(tasksFile, JSON.stringify({ version: 1, tasks: { nightly: { instance: 'smp', action: { type: 'backup' }, schedule: { kind: 'daily', at: '03:00' } } } }))

  const oldExe = 'C:\\Users\\me\\AppData\\Local\\Programs\\mcctl\\mcctl.exe'
  stale(shim, `@echo off\r\n"${oldExe}" "C:\\old\\mcctl.mjs" task run nightly\r\n`)
  stale(path.join(dir, launcher('start')), `@echo off\r\n"${oldExe}" "C:\\old\\mcctl.mjs" start smp\r\n`)

  const result = repairAfterMove({ marker })
  assert.deepEqual(result, { moved: true, shims: 1, launchers: 1 })

  const shimBody = fs.readFileSync(shim, 'utf8')
  assert.ok(!shimBody.includes(oldExe), 'the shim still names the old executable')
  assert.ok(shimBody.includes(path.join(ROOT, 'mcctl.mjs')), 'the shim does not name this code folder')
  assert.ok(shimBody.includes(posix ? "task run 'nightly'" : 'task run nightly'))

  const startBody = fs.readFileSync(path.join(dir, launcher('start')), 'utf8')
  assert.ok(!startBody.includes(oldExe), 'the launcher still names the old executable')
  assert.ok(startBody.includes(path.join(ROOT, 'mcctl.mjs')))
  for (const f of [launcher('console'), launcher('stop')]) assert.ok(fs.existsSync(path.join(dir, f)), `${f} was not written`)
  // A shell launcher that is not executable is a text file.
  if (process.platform === 'linux') assert.equal(fs.statSync(path.join(dir, launcher('start'))).mode & 0o111, 0o111)

  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), runtimeSignature())
})

test('while the record matches, nothing is touched', () => {
  const before = fs.statSync(shim).mtimeMs
  fs.writeFileSync(shim, 'left alone\r\n')
  assert.deepEqual(repairAfterMove({ marker }), { moved: false, shims: 0, launchers: 0 })
  assert.equal(fs.readFileSync(shim, 'utf8'), 'left alone\r\n')
  void before
})

test('a record from another executable or code folder triggers the rewrite again', () => {
  fs.writeFileSync(marker, JSON.stringify({ exe: 'C:\\somewhere\\else\\SpawnLoft.exe', root: ROOT }))
  assert.equal(repairAfterMove({ marker }).moved, true)
  assert.ok(fs.readFileSync(shim, 'utf8').includes(posix ? "task run 'nightly'" : 'task run nightly'))

  fs.writeFileSync(marker, JSON.stringify({ exe: process.execPath, root: 'C:\\somewhere\\else\\core' }))
  assert.equal(repairAfterMove({ marker }).moved, true)
})

test('a server whose folder is gone is skipped rather than failing the repair', () => {
  putInstance('ghost', { dir: path.join(INSTANCES_DIR, 'ghost'), jar: 'paper.jar', memory: '4G', port: 25566 })
  fs.rmSync(marker, { force: true })
  assert.deepEqual(repairAfterMove({ marker }), { moved: true, shims: 1, launchers: 1 })
})
