import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Every location redirected before the core is imported: the per-user default is where the
// "elsewhere" servers are planted, and the data root in use is an empty scratch folder.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-data-root-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.LOCALAPPDATA = path.join(scratch, 'local')
process.env.XDG_DATA_HOME = path.join(scratch, 'local')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
fs.mkdirSync(process.env.MCCTL_DATA_ROOT, { recursive: true })
const settings = await import('../src/settings.mjs')
const { runDoctor } = await import('../src/doctor.mjs')
const { toolsFor } = await import('../src/mcp-tools.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const defaultRoot = settings.defaultDataRoot()

function plant(names) {
  fs.mkdirSync(defaultRoot, { recursive: true })
  fs.writeFileSync(path.join(defaultRoot, 'instances.json'),
    JSON.stringify({ instances: Object.fromEntries(names.map((n) => [n, { name: n, dir: path.join(defaultRoot, 'instances', n) }])) }))
}

test('servers in the default location are found when the data root in use is empty', () => {
  plant(['Survival', 'Skyblock'])
  const found = settings.serversElsewhere(process.env.MCCTL_DATA_ROOT).find((f) => f.root === path.resolve(defaultRoot))
  assert.deepEqual(found?.names, ['Survival', 'Skyblock'])
  const lines = settings.describeServersElsewhere(process.env.MCCTL_DATA_ROOT)
  assert.ok(lines.some((l) => l.includes('Survival, Skyblock') && l.includes(`config set-root "${path.resolve(defaultRoot)}"`)))
})

test('the data root in use is never reported as somewhere else', () => {
  plant(['Survival'])
  assert.equal(settings.serversElsewhere(defaultRoot).some((f) => f.root === path.resolve(defaultRoot)), false)
})

test('an empty or unreadable registry elsewhere is not reported', () => {
  fs.writeFileSync(path.join(defaultRoot, 'instances.json'), JSON.stringify({ instances: {} }))
  assert.equal(settings.serversElsewhere(process.env.MCCTL_DATA_ROOT).some((f) => f.root === path.resolve(defaultRoot)), false)
  fs.writeFileSync(path.join(defaultRoot, 'instances.json'), '{ not json')
  assert.equal(settings.serversElsewhere(process.env.MCCTL_DATA_ROOT).some((f) => f.root === path.resolve(defaultRoot)), false)
})

test('doctor reports it as a problem and names the data root it read', async () => {
  plant(['Survival'])
  const res = await runDoctor()
  assert.ok(res.problems.some((p) => p.includes('Survival') && p.includes('set-root')), res.problems.join('\n'))
  assert.ok(res.notes.includes(`data root: ${path.resolve(process.env.MCCTL_DATA_ROOT)}`), res.notes.join('\n'))
})

test('list_servers says which folder it read instead of only "no servers"', async () => {
  plant(['Survival'])
  const listServers = toolsFor().find((t) => t.name === 'list_servers')
  const res = await listServers.run({}, { progress() {} })
  assert.match(res.text, /^No servers in /)
  assert.ok(res.text.includes(path.resolve(process.env.MCCTL_DATA_ROOT)), res.text)
  assert.ok(res.text.includes('Survival') && res.text.includes('set-root'), res.text)
  assert.ok(res.data.serversElsewhere.some((f) => f.names.includes('Survival')))
})

test('a server in a folder picked at setup is found by a fresh MCP server with nothing else configured', async () => {
  // What a person's machine looks like after the setup wizard: settings.json names the folder they
  // chose, and the MCP client launches `spawnloft mcp` with no location of its own. No
  // MCCTL_DATA_ROOT - that override exists for tests, and no real client sets it.
  const home = path.join(scratch, 'person')
  const chosen = path.join(home, 'Games', 'Minecraft Servers')
  const serverDir = path.join(chosen, 'instances', 'Survival')
  fs.mkdirSync(serverDir, { recursive: true })
  fs.writeFileSync(path.join(chosen, 'instances.json'), JSON.stringify({ version: 1, instances: {
    Survival: { dir: serverDir, jar: 'paper.jar', memory: '2G', port: 45711, rcon: { port: 45712, password: 'x' } },
  } }))
  const config = path.join(home, 'config')
  fs.mkdirSync(path.join(config, 'mcctl'), { recursive: true })
  // The exact shape desktop/main.js saveSetup writes.
  fs.writeFileSync(path.join(config, 'mcctl', 'settings.json'),
    JSON.stringify({ dataRoot: chosen, separateInstances: false, instancesDir: null }))

  const env = { ...process.env, APPDATA: config, XDG_CONFIG_HOME: config, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'local'), XDG_DATA_HOME: path.join(home, 'share') }
  delete env.MCCTL_DATA_ROOT
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const replies = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'spawnloft.mjs'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')) }, 20000)
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    })
    for (const m of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } },
    ]) child.stdin.write(JSON.stringify(m) + '\n')
    child.stdin.end()
  })
  const text = replies.find((r) => r.id === 2).result.content.map((c) => c.text).join('\n')
  assert.match(text, /^Survival: stopped, port 45711/, text)
})
