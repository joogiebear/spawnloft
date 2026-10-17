import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-overview-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { newestSnapshotAt, snapshotSummary } = await import('../src/backup.mjs')
const { BACKUPS_DIR } = await import('../src/paths.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// The overview asks this of every server at once, so it reads the archives' times and nothing else.
test('the newest backup is the newest archive, and a server with none has none', async () => {
  const dir = path.join(BACKUPS_DIR, 'survival')
  fs.mkdirSync(dir, { recursive: true })
  const at = (file, seconds) => {
    fs.writeFileSync(path.join(dir, file), 'x')
    fs.utimesSync(path.join(dir, file), seconds, seconds)
  }
  at('old_standard_2026-09-01.tar.gz', 1_780_000_000)
  at('new_plugins_2026-09-20.tar.gz', 1_790_000_000)
  // Neither a manifest nor an archive still being written is a backup.
  at('newer_standard_2026-09-21.json', 1_795_000_000)
  at('newest_standard_2026-09-22.tar.gz.pending', 1_799_000_000)

  assert.equal(await newestSnapshotAt('survival'), 1_790_000_000 * 1000)
  assert.deepEqual(await snapshotSummary('survival'), { newestAt: 1_790_000_000 * 1000, count: 2 })
  assert.deepEqual(await snapshotSummary('never-backed-up'), { newestAt: null, count: 0 })
  assert.equal(await newestSnapshotAt('never-backed-up'), null)
  assert.equal(fs.existsSync(path.join(BACKUPS_DIR, 'never-backed-up')), false, 'Asking makes no folder')
})
