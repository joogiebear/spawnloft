/**
 * Installing something together with what it needs: one backup of the folder for the lot, and a
 * requirement that fails does not undo the thing that was asked for. Own file: it writes a
 * registry and takes a real snapshot.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-install-many-'))
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')

const { putInstance, getInstance } = await import('../src/registry.mjs')
const { INSTANCES_DIR } = await import('../src/paths.mjs')
const activity = await import('../src/activity.mjs')
const pluginActions = await import('../src/plugin-actions.mjs')

const name = 'with-friends'
const dir = path.join(INSTANCES_DIR, name)
fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
fs.writeFileSync(path.join(dir, 'paper-1.21.4-100.jar'), '')
fs.writeFileSync(path.join(dir, 'plugins', 'Old.jar'), 'not a zip, still a jar')
putInstance(name, { dir, jar: 'paper-1.21.4-100.jar', memory: '1G', port: 41640, rcon: { port: 41641, password: 'p' } })
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const version = (id) => [{
  project_id: id, version_number: '1.0', version_type: 'release', loaders: ['paper'], game_versions: ['1.21.4'],
  files: [{ primary: true, filename: `${id}.jar`, url: `https://cdn.modrinth.com/${id}.jar`, hashes: {} }], dependencies: [],
}]

test('what it needs comes with it under one backup, and one that fails is reported, not fatal', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    const m = /\/project\/([^/]+)\/version/.exec(u)
    if (m && m[1] === 'gone1') return new Response('{}', { status: 404 })
    if (m) return new Response(JSON.stringify(version(m[1])), { headers: { 'content-type': 'application/json' } })
    if (u.startsWith('https://cdn.modrinth.com/')) return new Response(new TextEncoder().encode('jar'))
    return new Response('not found', { status: 404 })
  })
  const out = await pluginActions.installWithSnapshot(getInstance(name), 'main1', {
    also: [{ projectId: 'vault1', source: 'modrinth' }, { projectId: 'gone1', source: 'modrinth' }],
  })
  assert.equal(out.installed, 'main1.jar')
  assert.deepEqual(out.extras, [{ projectId: 'vault1', installed: 'vault1.jar', version: '1.0' }])
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].projectId, 'gone1')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')).filter((f) => f.endsWith('.jar')).sort(), ['Old.jar', 'main1.jar', 'vault1.jar'])

  // one backup, named on both entries
  assert.ok(out.snapshot && fs.existsSync(out.snapshot))
  const entries = activity.readActivity({ server: name }).entries.filter((e) => e.action === 'plugin-install')
  assert.deepEqual(entries.map((e) => e.detail).sort(), ['main1.jar 1.0', 'vault1.jar 1.0'])
  assert.deepEqual([...new Set(entries.map((e) => e.snapshot))], [path.basename(out.snapshot)])
  assert.equal(fs.readdirSync(path.dirname(out.snapshot)).filter((f) => f.endsWith('.tar.gz')).length, 1)
})
