import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mcp-client-'))
const data = path.join(scratch, 'data')
process.env.MCCTL_DATA_ROOT = data
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share'),
  MCCTL_FAKE_CLIENT: path.join(root, 'test', 'fixtures', 'fake-client.mjs') }
const secret = 'fixture-secret-never-leaves'

const { createProfile, stop } = await import('../src/client.mjs')
const { putInstance } = await import('../src/registry.mjs')
const { stateFile, INSTANCES_DIR } = await import('../src/paths.mjs')
const { writeJson } = await import('../src/util.mjs')
const { versionDir, versionJson } = await import('../src/client-paths.mjs')

fs.mkdirSync(versionDir('1.21.11'), { recursive: true })
fs.copyFileSync(path.join(root, 'test', 'fixtures', 'client', '1.21.11.json'), versionJson('1.21.11'))
const fabricId = 'fabric-loader-0.19.5-1.21.11'
fs.mkdirSync(versionDir(fabricId), { recursive: true })
fs.copyFileSync(path.join(root, 'test', 'fixtures', 'client', 'fabric-profile.json'), versionJson(fabricId))

createProfile('harn', { mc: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', harness: true })

{
  const dir = path.join(INSTANCES_DIR, 'offline')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\nserver-ip=127.0.0.1\n')
  putInstance('offline', { dir, jar: 'server.jar', memory: '1G', port: 45641, rcon: { port: 45642, password: secret } })
  writeJson(stateFile('offline'), { name: 'offline', running: true, daemonPid: process.pid, javaPid: process.pid })
}

after(async () => {
  try { await stop('harn') } catch {}
  fs.rmSync(scratch, { recursive: true, force: true })
})

const meta = (extra = {}) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {}, ...extra })

function session(messages, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'spawnloft.mjs'), 'mcp', ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out; stderr: ${stderr}`)) }, 20000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      // Every line on stdout must be a protocol message; anything else corrupts the stream.
      const parsed = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const byId = new Map(parsed.filter((m) => m.id !== undefined).map((m) => [m.id, m]))
      resolve({ code, stdout, stderr, byId, notes: parsed.filter((m) => m.id === undefined) })
    })
    for (const m of messages) child.stdin.write(typeof m === 'string' ? m + '\n' : JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    child.stdin.end()
  })
}

const call = (id, name, args = {}, extraMeta) => ({ id, method: 'tools/call',
  params: { name, arguments: args, ...(extraMeta ? { _meta: extraMeta } : {}) } })

async function one(name, args) {
  const s = await session([call(1, name, args, meta())])
  assert.equal(s.code, 0, s.stderr)
  assert.ok(!s.stdout.includes(secret), 'secret leaked')
  return s.byId.get(1).result
}

test('tools/list includes all nine client tools with the right annotations', async () => {
  const s = await session([{ id: 1, method: 'tools/list', params: { _meta: meta() } }])
  assert.equal(s.code, 0, s.stderr)
  const tools = s.byId.get(1).result.tools
  for (const n of ['client_profiles', 'client_status', 'client_messages', 'client_logs', 'client_launch', 'client_join', 'client_chat', 'client_screenshot', 'client_quit']) {
    assert.ok(tools.some((t) => t.name === n), n)
  }
  for (const n of ['client_profiles', 'client_status', 'client_messages', 'client_logs']) {
    const t = tools.find((t) => t.name === n)
    assert.equal(t.annotations.readOnlyHint, true)
  }
  for (const n of ['client_launch', 'client_join', 'client_chat', 'client_screenshot', 'client_quit']) {
    const t = tools.find((t) => t.name === n)
    assert.equal(t.annotations.readOnlyHint, false)
    assert.equal(t.annotations.destructiveHint, false)
  }
  assert.equal(tools.find((t) => t.name === 'client_launch').annotations.openWorldHint, true)
  for (const n of ['client_profiles', 'client_status', 'client_messages', 'client_logs', 'client_join', 'client_chat', 'client_screenshot', 'client_quit']) {
    assert.equal(tools.find((t) => t.name === n).annotations.openWorldHint, false, n)
  }
  const statusTool = tools.find((t) => t.name === 'client_status')
  assert.deepEqual(statusTool.inputSchema.required, ['profile'])
})

test('client_profiles lists the fixture profile', async () => {
  const r = await one('client_profiles', {})
  assert.match(r.content[0].text, /^harn: Minecraft 1\.21\.11, fabric 0\.19\.5, harness, stopped$/m)
  assert.equal(r.structuredContent.profiles[0].name, 'harn')
})

test('client_status on a stopped profile says stopped', async () => {
  const r = await one('client_status', { profile: 'harn' })
  assert.match(r.content[0].text, /is stopped/)
})

test('client_launch with wait returns the title screen', async () => {
  const r = await one('client_launch', { profile: 'harn', player_name: 'tester', wait: true })
  assert.equal(r.isError, undefined, r.content[0].text)
  assert.match(r.content[0].text, /Launched "harn" as tester/)
  assert.match(r.content[0].text, /Screen: Title Screen/)
  assert.equal(r.structuredContent.harness.screen, 'title')
})

test('client_status now shows running and the screen', async () => {
  const r = await one('client_status', { profile: 'harn' })
  assert.match(r.content[0].text, /is running/)
  assert.match(r.content[0].text, /Screen: Title Screen/)
})

test('client_chat refuses /stop', async () => {
  const r = await one('client_chat', { profile: 'harn', text: '/stop' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /would take the server down/)
})

test('client_join connects to the offline server', async () => {
  const r = await one('client_join', { profile: 'harn', server: 'offline' })
  assert.match(r.content[0].text, /"harn" joined offline at 127\.0\.0\.1:45641/)
  assert.equal(r.structuredContent.joined, true)
})

test('client_chat sends a message', async () => {
  const r = await one('client_chat', { profile: 'harn', text: 'hello' })
  assert.equal(r.content[0].text, 'Sent.')
})

test('client_messages reflects the sent chat', async () => {
  const r = await one('client_messages', { profile: 'harn' })
  assert.equal(r.structuredContent.messages.length, 1)
  assert.ok(r.structuredContent.messages[0].text.endsWith(' hello'))
  assert.match(r.content[0].text, /game content/)
})

test('client_screenshot writes a file', async () => {
  const r = await one('client_screenshot', { profile: 'harn' })
  assert.ok(r.structuredContent.file.endsWith('.png'))
  assert.ok(fs.existsSync(r.structuredContent.file))
})

test('client_logs shows the process output', async () => {
  let r
  for (let i = 0; i < 10; i++) {
    r = await one('client_logs', { profile: 'harn' })
    if (r.content[0].text.includes('Setting user: tester')) break
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  assert.match(r.content[0].text, /Setting user: tester/)
})

test('client_quit stops the client', async () => {
  const r = await one('client_quit', { profile: 'harn' })
  assert.equal(r.structuredContent.stopped, true)
  const st = await one('client_status', { profile: 'harn' })
  assert.match(st.content[0].text, /is stopped/)
})

test('client_join on a stopped profile is a tool error', async () => {
  const r = await one('client_join', { profile: 'harn', server: 'offline' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not running/)
})

test('client_launch with an unknown profile is a tool error', async () => {
  const r = await one('client_launch', { profile: 'nosuch' })
  assert.equal(r.isError, true)
})
