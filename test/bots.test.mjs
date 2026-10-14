import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// The checks below need a registry, so they go through the CLI with a data root of their own, the
// way cli.test.mjs does. The pure parts (scenario validation) are imported after that root is set,
// because paths.mjs resolves it at import.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-bots-'))
const data = path.join(scratch, 'data')
const online = path.join(data, 'instances', 'online')
const offline = path.join(data, 'instances', 'offline')
for (const dir of [online, offline, path.join(data, 'run')]) fs.mkdirSync(dir, { recursive: true })
process.env.MCCTL_DATA_ROOT = data
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {
  online: { dir: online, jar: 'paper-1.21.4-100.jar', memory: '1G', port: 45621, rcon: { port: 45622, password: 'x' } },
  offline: { dir: offline, jar: 'paper-1.21.4-100.jar', memory: '1G', port: 45623, rcon: { port: 45624, password: 'x' } },
  db: { kind: 'database', engine: 'mariadb', external: true, port: 45625, root: { password: 'x' } },
} }))
fs.writeFileSync(path.join(online, 'server.properties'), 'online-mode=true\nserver-ip=\n')
fs.writeFileSync(path.join(offline, 'server.properties'), 'online-mode=false\nserver-ip=127.0.0.1\n')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { validateScenario, checkInstance, hostInstall, formatReport, MAX_BOTS } = await import('../src/bots.mjs')

function cli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(root, 'mcctl.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

const good = { instance: 'offline', bots: ['alice', 'bob'], setup: ['op alice'], steps: [
  { bot: 'alice', command: '/tp bob' },
  { bot: 'bob', expectMessage: 'teleported', timeout: 2000 },
  { expectLog: { absent: 'Exception' } },
] }

test('a well-formed scenario passes validation and keeps its parts', () => {
  const s = validateScenario(good, { name: 'from-file' })
  assert.equal(s.name, 'from-file')
  assert.equal(s.instance, 'offline')
  assert.deepEqual(s.bots, ['alice', 'bob'])
  assert.equal(s.steps.length, 3)
})

test('validation names the step and what is wrong with it', () => {
  const bad = (patch, re) => assert.throws(() => validateScenario({ ...good, ...patch }), re)
  bad({ bots: [] }, /at least one bot/)
  bad({ bots: Array.from({ length: MAX_BOTS + 1 }, (_, i) => `bot${i}`) }, /limit is/)
  bad({ bots: ['al'] }, /not a Minecraft name/)
  bad({ bots: ['Alice', 'alice'] }, /must differ/)
  bad({ setup: ['stop'] }, /setup command "stop"/)
  bad({ setup: ['/minecraft:reload confirm'] }, /setup command "reload"/)
  bad({ steps: [] }, /at least one step/)
  bad({ steps: [{ bot: 'alice' }] }, /step 1 must have exactly one of/)
  bad({ steps: [{ bot: 'alice', chat: 'hi', command: '/x' }] }, /step 1 must have exactly one of .* it has chat, command/)
  bad({ steps: [{ bot: 'carol', chat: 'hi' }] }, /step 1 \(chat\) names bot "carol"/)
  bad({ steps: [{ bot: 'alice', chat: 'hi', timeout: 0 }] }, /"timeout" is milliseconds/)
  bad({ steps: [{ expectLog: { present: 'a', absent: 'b' } }] }, /expectLog takes/)
  bad({ steps: [{ expectLog: {} }] }, /expectLog takes/)
  bad({ steps: [{ bot: 'alice', click: 'eleven' }] }, /"click" is a slot number/)
  assert.throws(() => validateScenario([]), /JSON object/)
})

test('an online-mode server is refused, with the way out', () => {
  const res = checkInstance('online')
  assert.equal(res.ok, false)
  assert.match(res.problems[0], /online mode/)
  assert.match(res.problems[0], /online-mode=false/)
  assert.match(res.problems[1], /not running/)
  assert.match(res.warnings[0], /every interface/)
  assert.equal(res.version, '1.21.4')
})

test('an offline server bound to loopback only needs to be running', () => {
  const res = checkInstance('offline')
  assert.equal(res.ok, false)
  assert.deepEqual(res.problems.map((p) => p.split('.')[0]), ['"offline" is not running'])
  assert.deepEqual(res.warnings, [])
})

test('a database is not a server bots can join', () => {
  assert.throws(() => checkInstance('db'), /database/)
})

test('no install means no host, and the CLI says how to get one', () => {
  assert.equal(hostInstall(), null)
  const res = cli(['bot', 'check', 'offline'])
  assert.equal(res.code, 1)
  assert.match(res.stdout, /not running/)
})

test('the report reads one line per step and exits non-zero on a failure', () => {
  const text = formatReport({ ok: false, durationMs: 42, setup: [{ command: 'op alice', reply: 'Made alice a server operator', ok: true },
    { command: 'gamemode survival nobody', reply: 'No player was found', ok: false }], steps: [
    { index: 0, step: { bot: 'alice', command: '/tp bob' }, status: 'passed', durationMs: 1 },
    { index: 1, step: { bot: 'bob', expectMessage: 'teleported', timeout: 2000 }, status: 'failed', durationMs: 2000, error: 'timed out' },
    { index: 2, step: { expectLog: { absent: 'Exception' } }, status: 'skipped' },
  ] })
  assert.match(text, /setup {2}op alice {2}-> Made alice/)
  assert.match(text, /FAIL {3}gamemode survival nobody {2}-> No player was found/)
  assert.match(text, /ok {5}1\. alice \{"command":"\/tp bob"\}/)
  assert.match(text, /FAIL {3}2\. bob \{"expectMessage":"teleported"\}/)
  assert.match(text, /skip {3}3\. \{"expectLog"/)
  assert.match(text, /FAILED: 1 of 3 steps passed in 42 ms/)
})

test('bot run refuses a scenario it cannot read before touching a server', () => {
  const file = path.join(scratch, 'broken.json')
  fs.writeFileSync(file, '{ not json')
  const res = cli(['bot', 'run', file])
  assert.equal(res.code, 1)
  assert.match(res.stderr, /not valid JSON/)
  const usage = cli(['bot', 'dance'])
  assert.equal(usage.code, 2)
})

test('the MCP tools are offered and bot_check reads like the CLI', async () => {
  const { toolsFor } = await import('../src/mcp-tools.mjs')
  const names = toolsFor().map((t) => t.name)
  assert.ok(names.includes('bot_check'))
  assert.ok(names.includes('bot_run_scenario'))
  const check = toolsFor().find((t) => t.name === 'bot_check')
  const res = await check.run({ name: 'online' })
  assert.equal(res.data.ok, false)
  assert.match(res.text, /online mode/)
  assert.match(res.text, /mineflayer is not installed/)
})
