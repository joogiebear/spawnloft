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
  assert.deepEqual(removeIfEmpty, [layout.instancesDir, layout.dataRoot, win.dirname(settings)])
})

test("the desktop app's own folders go only when named, and nothing is listed twice", () => {
  const dirs = ['C:\\Users\\me\\AppData\\Roaming\\SpawnLoft']
  const { remove } = purgeTargets({ instances: [{ name: 'a', dir: layout.jarsDir }], layout, settings, desktopDirs: dirs, pathApi: win })
  assert.ok(remove.includes(dirs[0]))
  assert.equal(remove.filter((p) => p === layout.jarsDir).length, 1)
})

test('a backups folder the person chose is never deleted whole, only what SpawnLoft wrote there', () => {
  const chosen = { ...layout, backupsDir: 'D:\\Backups' }
  const { remove, removeIfEmpty } = purgeTargets({
    instances: [
      { name: 'smp', dir: 'D:\\Games\\instances\\smp' },
      { name: 'old', dir: 'D:\\Servers\\Old', origin: { adopted: 'D:\\Servers\\Old' } },
      { name: 'smp-db', dir: 'D:\\Games\\services\\smp-db', kind: 'database' },
    ],
    layout: chosen,
    settings,
    pathApi: win,
  })
  assert.ok(!remove.includes('D:\\Backups'), 'the chosen backups folder was marked for recursive deletion')
  for (const p of ['D:\\Backups\\smp', 'D:\\Backups\\old', 'D:\\Backups\\smp-db', 'D:\\Backups\\client\\exports']) {
    assert.ok(remove.includes(p), `${p} was not marked for deletion`)
  }
  assert.ok(removeIfEmpty.includes('D:\\Backups'))
  assert.ok(removeIfEmpty.indexOf('D:\\Backups\\client') < removeIfEmpty.indexOf('D:\\Backups'))
  assert.ok(removeIfEmpty.indexOf('D:\\Backups') < removeIfEmpty.indexOf(layout.dataRoot))
})

test('a chosen backups folder at a drive root or the data root itself is handled the same way', () => {
  for (const backupsDir of ['D:\\', layout.dataRoot]) {
    const { remove } = purgeTargets({ instances: [{ name: 'smp' }], layout: { ...layout, backupsDir }, settings, pathApi: win })
    assert.ok(!remove.includes(backupsDir), `${backupsDir} was marked for recursive deletion`)
    assert.ok(remove.includes(win.join(backupsDir, 'smp')))
  }
})

test('the default backups folder is recognised however it is spelled', () => {
  const { remove } = purgeTargets({ instances: [], layout: { ...layout, backupsDir: 'd:\\games\\Backups\\' }, settings, pathApi: win })
  assert.ok(remove.includes('d:\\games\\Backups\\'))
})

test('a server name that could reach outside the backups folder is ignored', () => {
  const { remove } = purgeTargets({
    instances: [{ name: '..' }, { name: 'a\\..\\..' }, { name: 'x/../..' }, { name: '' }, {}],
    layout: { ...layout, backupsDir: 'D:\\Backups' },
    settings,
    pathApi: win,
  })
  const inBackups = remove.filter((p) => p.toLowerCase().startsWith('d:\\backups'))
  assert.deepEqual(inBackups, ['D:\\Backups\\client\\exports'])
})

test('on disk: uninstalling with data keeps the other files in a chosen backups folder', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-uninstall-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const dataRoot = path.join(tmp, 'data')
  const backupsDir = path.join(tmp, 'MyBackups')
  const write = (p, body = 'x') => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
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
  write(path.join(backupsDir, 'smp', '2026-11-13_120000.tar.gz'))
  write(path.join(backupsDir, 'smp', '2026-11-13_120000.json'), '{}')
  write(path.join(backupsDir, 'smp', 'exports', 'console.log'))
  write(path.join(backupsDir, 'client', 'exports', 'bundle.zip'))
  write(path.join(backupsDir, 'family photos', 'beach.jpg'))
  write(path.join(backupsDir, 'tax-2025.pdf'))
  write(path.join(backupsDir, 'client', 'notes.txt'))

  const targets = purgeTargets({ instances: [{ name: 'smp', dir: path.join(disk.instancesDir, 'smp') }], layout: disk, settings: settingsFile })
  const result = applyTargets(targets)
  assert.deepEqual(result.failed, [])

  assert.ok(!fs.existsSync(path.join(backupsDir, 'smp')), "the server's backups were left behind")
  assert.ok(!fs.existsSync(path.join(backupsDir, 'client', 'exports')))
  assert.ok(fs.existsSync(path.join(backupsDir, 'family photos', 'beach.jpg')), 'an unrelated folder in the backups folder was deleted')
  assert.ok(fs.existsSync(path.join(backupsDir, 'tax-2025.pdf')), 'an unrelated file in the backups folder was deleted')
  assert.ok(fs.existsSync(path.join(backupsDir, 'client', 'notes.txt')))
  assert.ok(!fs.existsSync(disk.instancesDir), 'the emptied instances folder was left behind')
  assert.ok(!fs.existsSync(dataRoot), 'the emptied data root was left behind')
})

test('on disk: a chosen backups folder that held only SpawnLoft backups is removed once empty', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-uninstall-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const backupsDir = path.join(tmp, 'Backups')
  fs.mkdirSync(path.join(backupsDir, 'smp'), { recursive: true })
  fs.writeFileSync(path.join(backupsDir, 'smp', 'a.tar.gz'), 'x')
  fs.mkdirSync(path.join(backupsDir, 'client', 'exports'), { recursive: true })
  const disk = { dataRoot: path.join(tmp, 'data'), backupsDir }
  applyTargets(purgeTargets({ instances: [{ name: 'smp' }], layout: disk, settings: path.join(tmp, 'cfg', 'settings.json') }))
  assert.ok(!fs.existsSync(backupsDir))
})
