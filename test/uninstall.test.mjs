/**
 * What the uninstaller deletes when asked to take the data too. The planner is pure so this can
 * say exactly which paths go and which stay without touching a disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { purgeTargets } from '../src/uninstall.mjs'

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
  })
  assert.ok(remove.includes('D:\\Games\\instances\\smp'))
  assert.ok(!remove.includes('D:\\Servers\\Old'), 'an adopted server was marked for deletion')
  assert.ok(!remove.includes('D:\\Games\\instances\\odd'), 'an adopted server inside the instances folder was marked for deletion')
})

test('the store folders, the registry, the task shims and the settings go; the data root itself does not', () => {
  const { remove, removeIfEmpty } = purgeTargets({ instances: [], layout, settings })
  for (const p of [layout.jarsDir, layout.backupsDir, layout.templatesDir, layout.runDir, layout.registryFile, settings, path.join(layout.dataRoot, 'tasks')]) {
    assert.ok(remove.includes(p), `${p} was not marked for deletion`)
  }
  assert.ok(!remove.includes(layout.dataRoot), 'the data root was marked for recursive deletion')
  assert.ok(!remove.includes(layout.instancesDir), 'the instances folder was marked for recursive deletion')
  assert.deepEqual(removeIfEmpty, [layout.instancesDir, layout.dataRoot, path.dirname(settings)])
})

test("the desktop app's own folders go only when named, and nothing is listed twice", () => {
  const dirs = ['C:\\Users\\me\\AppData\\Roaming\\SpawnLoft']
  const { remove } = purgeTargets({ instances: [{ name: 'a', dir: layout.jarsDir }], layout, settings, desktopDirs: dirs })
  assert.ok(remove.includes(dirs[0]))
  assert.equal(remove.filter((p) => p === layout.jarsDir).length, 1)
})
