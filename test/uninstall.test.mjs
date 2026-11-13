/**
 * What the uninstaller deletes when asked to take the data too. The planner is pure so this can
 * say exactly which paths go and which stay without touching a disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { purgeTargets, applyTargets } from '../src/uninstall.mjs'

const win = path.win32

const layout = {
  dataRoot: 'D:\\Games',
  instancesDir: 'D:\\Games\\instances',
  jarsDir: 'D:\\Games\\jars',
  backupsDir: 'D:\\Games\\backups',
  templatesDir: 'D:\\Games\\templates',
  runDir: 'D:\\Games\\run',
  registryFile: 'D:\\Games\\instances.json',
}
const settings = 'C:\\Users\\me\\AppData\\Roaming\\spawnloft\\settings.json'

test('servers this program created go; adopted ones stay, whatever folder they are in', () => {
  const { remove } = purgeTargets({
    instances: [
      { name: 'smp', dir: 'D:\\Games\\instances\\smp' },
      { name: 'old', dir: 'D:\\Servers\\Old', origin: { adopted: 'D:\\Servers\\Old' } },
      { name: 'odd', dir: 'D:\\Games\\instances\\odd', origin: { adopted: 'D:\\Games\\instances\\odd' } },
    ],
    layout,
    settings,
    pathApi: win,
  })
  assert.ok(remove.includes('D:\\Games\\instances\\smp'))
  assert.ok(!remove.includes('D:\\Servers\\Old'), 'an adopted server was marked for deletion')
  assert.ok(!remove.includes('D:\\Games\\instances\\odd'), 'an adopted server inside the instances folder was marked for deletion')
})

test('the store folders, the registry, the task shims and the settings go; the data root itself does not', () => {
  const { remove, removeIfEmpty } = purgeTargets({ instances: [], layout, settings, pathApi: win })
  for (const p of [layout.jarsDir, layout.backupsDir, layout.templatesDir, layout.runDir, layout.registryFile, settings, win.join(layout.dataRoot, 'tasks')]) {
    assert.ok(remove.includes(p), `${p} was not marked for deletion`)
  }
  assert.ok(!remove.includes(layout.dataRoot), 'the data root was marked for recursive deletion')
  assert.ok(!remove.includes(layout.instancesDir), 'the instances folder was marked for recursive deletion')
  assert.deepEqual(removeIfEmpty, [win.dirname(settings), layout.instancesDir, layout.dataRoot])
})

test("the desktop app's own folders go only when named, and nothing is listed twice", () => {
  const dirs = ['C:\\Users\\me\\AppData\\Roaming\\SpawnLoft']
  const { remove } = purgeTargets({ instances: [{ name: 'a', dir: layout.jarsDir }], layout, settings, desktopDirs: dirs, pathApi: win })
  assert.ok(remove.includes(dirs[0]))
  assert.equal(remove.filter((p) => p === layout.jarsDir).length, 1)
})

test('a backups folder the person chose is never deleted by folder, only swept file by file', () => {
  for (const backupsDir of ['D:\\Backups', 'D:\\', layout.dataRoot, 'C:\\Users\\me']) {
    const { remove, sweep } = purgeTargets({
      instances: [{ name: 'smp', dir: 'D:\\Games\\instances\\smp' }, { name: 'Documents' }],
      layout: { ...layout, backupsDir },
      settings,
      pathApi: win,
    })
    assert.ok(!remove.includes(backupsDir))
    for (const n of ['smp', 'Documents', 'client']) assert.ok(!remove.includes(win.join(backupsDir, n)), `${win.join(backupsDir, n)} was marked for recursive deletion`)
    assert.deepEqual(sweep, { root: backupsDir, names: ['smp', 'Documents'] })
  }
})

test('the default backups folder is recognised however it is spelled, and goes whole', () => {
  const { remove, sweep } = purgeTargets({ instances: [], layout: { ...layout, backupsDir: 'd:\\games\\Backups\\' }, settings, pathApi: win })
  assert.ok(remove.includes('d:\\games\\Backups\\'))
  assert.equal(sweep, null)
})

test('empty folders are tried deepest first, so a data root used as the backups folder still goes', () => {
  const { removeIfEmpty } = purgeTargets({ instances: [], layout: { ...layout, servicesDir: 'D:\\Games\\services', backupsDir: layout.dataRoot }, settings, pathApi: win })
  assert.ok(removeIfEmpty.indexOf(layout.dataRoot) > removeIfEmpty.indexOf(layout.instancesDir))
  assert.ok(removeIfEmpty.indexOf(layout.dataRoot) > removeIfEmpty.indexOf('D:\\Games\\services'))
})

function tempDir(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-uninstall-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  return tmp
}

function write(p, body = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

test('on disk: uninstalling with data takes only SpawnLoft files out of a chosen backups folder', (t) => {
  const tmp = tempDir(t)
  const dataRoot = path.join(tmp, 'data')
  const backupsDir = path.join(tmp, 'MyBackups')
  const disk = {
    dataRoot,
    instancesDir: path.join(dataRoot, 'instances'),
    jarsDir: path.join(dataRoot, 'jars'),
    backupsDir,
    templatesDir: path.join(dataRoot, 'templates'),
    runDir: path.join(dataRoot, 'run'),
    registryFile: path.join(dataRoot, 'instances.json'),
  }
  const settingsFile = path.join(tmp, 'config', 'settings.json')
  write(path.join(disk.instancesDir, 'smp', 'server.properties'))
  write(disk.registryFile, '{}')
  write(settingsFile, '{}')
  const b = (...parts) => path.join(backupsDir, ...parts)
  // SpawnLoft's
  write(b('smp', '2026-11-13_120000_manual.tar.gz'))
  write(b('smp', '2026-11-13_120000_manual.json'), JSON.stringify({ instance: 'smp' }))
  write(b('smp', '2026-11-13_130000_daily.tar.gz.pending'))
  write(b('smp', '.snapshot.lock'))
  write(b('smp', 'exports', 'smp_console_2026-11-13_120000.log'))
  write(b('smp', 'exports', 'world_2026-11-13_120000.zip'))
  write(b('smp-db', 'manual_2026-11-13_120000.sql'))
  write(b('smp-db', 'manual_2026-11-13_120000.json'), JSON.stringify({ database: 'smp-db' }))
  write(b('gone', '2026-01-01_120000_manual.tar.gz'))
  write(b('gone', '2026-01-01_120000_manual.json'), JSON.stringify({ instance: 'gone' }))
  write(b('client', 'exports', 'client_diag_2026-11-13_120000.zip'))
  // the person's
  write(b('tax-2025.pdf'))
  write(b('family photos', 'beach.jpg'))
  write(b('Documents', 'letter.docx'))
  write(b('Documents', 'old-project.tar.gz'))
  write(b('smp', 'my notes.txt'))
  write(b('smp', 'exports', 'keep-this.zip'))
  write(b('client', 'notes.txt'))
  write(b('archive', 'site.tar.gz'))
  write(b('archive', 'site.json'), JSON.stringify({ instance: 'someone-else' }))

  const targets = purgeTargets({
    instances: [{ name: 'smp', dir: path.join(disk.instancesDir, 'smp') }, { name: 'smp-db' }, { name: 'Documents', origin: { adopted: 'x' } }],
    layout: disk,
    settings: settingsFile,
  })
  const result = applyTargets(targets)
  assert.deepEqual(result.failed, [])

  for (const gone of [
    b('smp', '2026-11-13_120000_manual.tar.gz'), b('smp', '2026-11-13_120000_manual.json'), b('smp', '2026-11-13_130000_daily.tar.gz.pending'),
    b('smp', '.snapshot.lock'), b('smp', 'exports', 'smp_console_2026-11-13_120000.log'), b('smp', 'exports', 'world_2026-11-13_120000.zip'),
    b('smp-db'), b('gone'), b('client', 'exports'),
  ]) assert.ok(!fs.existsSync(gone), `${gone} was left behind`)
  for (const kept of [
    b('tax-2025.pdf'), b('family photos', 'beach.jpg'), b('Documents', 'letter.docx'), b('Documents', 'old-project.tar.gz'),
    b('smp', 'my notes.txt'), b('smp', 'exports', 'keep-this.zip'), b('client', 'notes.txt'), b('archive', 'site.tar.gz'), b('archive', 'site.json'),
  ]) assert.ok(fs.existsSync(kept), `${kept} was deleted`)
  assert.ok(!fs.existsSync(dataRoot), 'the emptied data root was left behind')
})

test('on disk: a chosen backups folder that held only SpawnLoft backups is removed once empty', (t) => {
  const tmp = tempDir(t)
  const backupsDir = path.join(tmp, 'Backups')
  write(path.join(backupsDir, 'smp', '2026-11-13_120000_manual.tar.gz'))
  write(path.join(backupsDir, 'smp', '2026-11-13_120000_manual.json'), JSON.stringify({ instance: 'smp' }))
  fs.mkdirSync(path.join(backupsDir, 'client', 'exports'), { recursive: true })
  const disk = { dataRoot: path.join(tmp, 'data'), backupsDir }
  applyTargets(purgeTargets({ instances: [{ name: 'smp' }], layout: disk, settings: path.join(tmp, 'cfg', 'settings.json') }))
  assert.ok(!fs.existsSync(backupsDir))
})

test('on disk: a symlinked folder inside a chosen backups folder is not followed', (t) => {
  const tmp = tempDir(t)
  const backupsDir = path.join(tmp, 'Backups')
  const elsewhere = path.join(tmp, 'elsewhere')
  write(path.join(elsewhere, '2026-11-13_120000_manual.tar.gz'))
  fs.mkdirSync(backupsDir, { recursive: true })
  try {
    fs.symlinkSync(elsewhere, path.join(backupsDir, 'smp'), 'junction')
  } catch {
    t.skip('no symlinks here')
    return
  }
  applyTargets(purgeTargets({ instances: [{ name: 'smp' }], layout: { dataRoot: path.join(tmp, 'data'), backupsDir }, settings: path.join(tmp, 'cfg', 'settings.json') }))
  assert.ok(fs.existsSync(path.join(elsewhere, '2026-11-13_120000_manual.tar.gz')))
})
