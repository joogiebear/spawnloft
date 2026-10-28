import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// The CLI tests go through a scratch data root, the way cli.test.mjs and bots.test.mjs do.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-cli-'))
const data = path.join(scratch, 'data')
const inst = path.join(data, 'instances', 't')
fs.mkdirSync(inst, { recursive: true })
fs.mkdirSync(path.join(data, 'run'), { recursive: true })
process.env.MCCTL_DATA_ROOT = data
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {
  t: { dir: inst, jar: 'paper-1.21.4-100.jar', memory: '1G', port: 45701 },
} }))
fs.writeFileSync(path.join(inst, 'server.properties'), 'online-mode=false\nserver-ip=127.0.0.1\n')

// Seed the installed version so launch needs no network
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'client', 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release
const { versionDir, versionJson, profileDir } = await import('../src/client-paths.mjs')
fs.mkdirSync(versionDir(mc), { recursive: true })
fs.copyFileSync(path.join(root, 'test', 'fixtures', 'client', `${mc}.json`), versionJson(mc))

function cli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(root, 'mcctl.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

after(() => {
  try { execFileSync(process.execPath, [path.join(root, 'mcctl.mjs'), 'client', 'stop', 'p'], { env, encoding: 'utf8' }) } catch { /* already dead or removed */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('new then list shows the profile', () => {
  const newRes = cli(['client', 'new', 'p', '--mc', mc])
  assert.equal(newRes.code, 0)

  const listRes = cli(['client', 'list', '--json'])
  assert.equal(listRes.code, 0)
  const parsed = JSON.parse(listRes.stdout.trim())
  assert.equal(parsed.data.profiles[0].name, 'p')
  assert.equal(parsed.data.profiles[0].mc, mc)
  assert.equal(parsed.data.profiles[0].running, false)
})

test('set memory=3G is reflected', () => {
  const setRes = cli(['client', 'set', 'p', 'memory=3G'])
  assert.equal(setRes.code, 0)
  const listRes = cli(['client', 'list', '--json'])
  const parsed = JSON.parse(listRes.stdout.trim())
  assert.equal(parsed.data.profiles[0].memory, '3G')
})

test('set memory=lots fails naming the field', () => {
  const res = cli(['client', 'set', 'p', 'memory=lots'])
  assert.notEqual(res.code, 0)
  assert.match(res.stderr, /memory/)
})

test('launch with fake client, status, logs, stop', async () => {
  env.NODE_ENV = 'test'
  env.MCCTL_FAKE_CLIENT = path.join(root, 'test', 'fixtures', 'fake-client.mjs')
  const launchRes = cli(['client', 'launch', 'p', '--as', 'tester', '--json'])
  assert.equal(launchRes.code, 0)
  const launchData = JSON.parse(launchRes.stdout.trim())
  assert.equal(typeof launchData.data.pid, 'number')

  const statusRes = cli(['client', 'status', 'p', '--json'])
  assert.equal(statusRes.code, 0)
  assert.equal(JSON.parse(statusRes.stdout.trim()).data.running, true)

  const deadline = Date.now() + 3000
  let found = false
  while (Date.now() < deadline && !found) {
    const logsRes = cli(['client', 'logs', 'p', '--json'])
    const logData = JSON.parse(logsRes.stdout.trim())
    found = logData.data.lines.some(l => l.includes('Setting user: tester'))
    if (!found) await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(found, 'Setting user: tester should appear in the log')

  const stopRes = cli(['client', 'stop', 'p', '--json'])
  assert.equal(stopRes.code, 0)
  assert.equal(JSON.parse(stopRes.stdout.trim()).data.stopped, true)

  const status2 = cli(['client', 'status', 'p', '--json'])
  assert.equal(JSON.parse(status2.stdout.trim()).data.running, false)
})

test('launch --account offline:<name> plays offline under that name, and --as with --account is refused', async () => {
  env.NODE_ENV = 'test'
  env.MCCTL_FAKE_CLIENT = path.join(root, 'test', 'fixtures', 'fake-client.mjs')
  const both = cli(['client', 'launch', 'p', '--as', 'x', '--account', 'offline:Steve', '--json'])
  assert.equal(both.code, 1)
  assert.match(both.stderr + both.stdout, /not both/)
  const res = cli(['client', 'launch', 'p', '--account', 'offline:Steve', '--json'])
  assert.equal(res.code, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()).data.account, { type: 'offline', name: 'Steve' })
  cli(['client', 'stop', 'p'])
  const nobody = cli(['client', 'launch', 'p', '--account', 'nobody', '--json'])
  assert.equal(nobody.code, 1)
  assert.match(nobody.stderr + nobody.stdout, /no Microsoft account named \\?"nobody\\?" is signed in/)
})

test('accounts lists nothing before a login, and logout of an unknown name says so', () => {
  const list = cli(['client', 'accounts', '--json'])
  assert.equal(list.code, 0)
  assert.deepEqual(JSON.parse(list.stdout.trim()).data, { accounts: [], defaultAccount: null })
  const out = cli(['client', 'logout', 'nobody'])
  assert.equal(out.code, 1)
  assert.match(out.stderr + out.stdout, /no signed-in account named "nobody"/)
})

test('the MCP scrubber hides the tokens of a signed-in account', async () => {
  const { saveAccounts } = await import('../src/client-auth.mjs')
  const { scrubber } = await import('../src/mcp-tools.mjs')
  saveAccounts([{ type: 'microsoft', name: 'Joogiebear', uuid: 'u', accessToken: 'mc-access-secret', refreshToken: 'msa-refresh-secret', expiresAt: new Date().toISOString() }])
  const scrub = scrubber()
  assert.equal(scrub('token mc-access-secret and msa-refresh-secret here'), 'token [redacted] and [redacted] here')
  const listed = cli(['client', 'accounts'])
  assert.equal(listed.code, 0)
  assert.ok(!listed.stdout.includes('secret'), listed.stdout)
  saveAccounts([])
})

test('remove --purge deletes the folder', () => {
  const res = cli(['client', 'remove', 'p', '--purge'])
  assert.equal(res.code, 0)
  assert.equal(fs.existsSync(profileDir('p')), false)
})

test('set assistantAccount=true is reflected and anything else is refused', () => {
  assert.equal(cli(['client', 'new', 'aa', '--mc', mc]).code, 0)
  const setRes = cli(['client', 'set', 'aa', 'assistantAccount=true'])
  assert.equal(setRes.code, 0, setRes.stderr)
  const listRes = cli(['client', 'list', '--json'])
  const parsed = JSON.parse(listRes.stdout.trim())
  assert.equal(parsed.data.profiles.find((x) => x.name === 'aa').assistantAccount, true)
  const bad = cli(['client', 'set', 'aa', 'assistantAccount=maybe'])
  assert.notEqual(bad.code, 0)
  assert.equal(cli(['client', 'set', 'aa', 'assistantAccount=false']).code, 0)
  assert.equal(JSON.parse(cli(['client', 'list', '--json']).stdout.trim()).data.profiles.find((x) => x.name === 'aa').assistantAccount, false)
  assert.equal(cli(['client', 'remove', 'aa', '--purge']).code, 0)
})
