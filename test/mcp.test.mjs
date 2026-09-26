import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { hideIps } from '../src/mcp-tools.mjs'
import { validate } from '../src/mcp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mcp-'))
const data = path.join(scratch, 'data')
const instance = path.join(data, 'instances', 'royalplugins')
const run = path.join(data, 'run', 'royalplugins')
for (const dir of [instance, run, path.join(instance, 'plugins')]) fs.mkdirSync(dir, { recursive: true })
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
const secret = 'fixture-secret-never-leaves'
const hook = 'https://discord.com/api/webhooks/1/fixture-hook-token'
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {
  royalplugins: { dir: instance, jar: 'paper-1.21.4-100.jar', memory: '1G', port: 45611,
    rcon: { port: 45612, password: secret }, webhook: hook },
  externaldb: { kind: 'database', engine: 'mariadb', external: true, port: 45613,
    root: { password: secret }, attachments: { royalplugins: { password: secret } } },
} }))
fs.writeFileSync(path.join(instance, 'paper-1.21.4-100.jar'), 'fixture')
fs.writeFileSync(path.join(instance, 'eula.txt'), 'eula=true\n')
fs.writeFileSync(path.join(run, 'console.log'), [
  '[12:00:00 INFO]: Starting minecraft server version 1.21.4',
  '[12:00:01 INFO]: Steve[/203.0.113.7:51234] logged in with entity id 1 at ([world]0, 64, 0)',
  '[12:00:02 WARN]: Plugin Example uses a deprecated API',
  `[12:00:03 ERROR]: Could not connect: jdbc:mariadb://127.0.0.1/db?password=${secret}`,
  '[12:00:04 INFO]: Alex[/[2001:db8::5]:40000] logged in with entity id 2',
  '[12:00:05 INFO]: **** FAILED TO BIND TO PORT!',
  '',
].join('\n'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const LEGACY = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
const meta = (extra = {}) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {}, ...extra })

/** Send every message, close stdin, and collect what came back: replies by id, and the rest. */
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

test('legacy clients get the initialize handshake and the non-destructive tool set', async () => {
  const s = await session([
    { id: 1, method: 'initialize', params: LEGACY },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'ping' },
  ])
  assert.equal(s.code, 0, s.stderr)
  const init = s.byId.get(1).result
  assert.equal(init.protocolVersion, '2025-06-18')
  assert.equal(init.serverInfo.name, 'spawnloft')
  assert.match(init.serverInfo.version, /^\d+\.\d+\.\d+/)
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } })
  const names = s.byId.get(2).result.tools.map((t) => t.name)
  for (const expected of ['list_servers', 'get_logs', 'start', 'stop', 'run_command', 'backup', 'install_plugin', 'upgrade_build']) {
    assert.ok(names.includes(expected), expected)
  }
  for (const hidden of ['restore', 'kill', 'upgrade_minecraft', 'rm']) assert.ok(!names.includes(hidden), hidden)
  assert.equal(s.byId.get(2).result.resultType, undefined)
  assert.deepEqual(s.byId.get(3).result, {})
})

test('an unknown legacy version is answered with the newest legacy one', async () => {
  const s = await session([{ id: 1, method: 'initialize', params: { ...LEGACY, protocolVersion: '2023-01-01' } }])
  assert.equal(s.byId.get(1).result.protocolVersion, '2025-11-25')
})

test('--allow-destructive adds restore, kill and upgrade_minecraft, marked destructive', async () => {
  const s = await session([{ id: 1, method: 'tools/list', params: { _meta: meta() } }], ['--allow-destructive'])
  const tools = s.byId.get(1).result.tools
  for (const n of ['restore', 'kill', 'upgrade_minecraft']) {
    const tool = tools.find((t) => t.name === n)
    assert.ok(tool, n)
    assert.equal(tool.annotations.destructiveHint, true)
    assert.ok(tool.inputSchema.properties.confirm)
  }
  assert.ok(!tools.some((t) => t.name === 'rm'))
})

test('modern requests are served statelessly, with resultType and serverInfo', async () => {
  const s = await session([
    { id: 'd', method: 'server/discover', params: { _meta: meta() } },
    call('l', 'list_servers', {}, meta()),
    { id: 'v', method: 'tools/list', params: { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }) } },
    { id: 'c', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { id: 'm', method: 'resources/list', params: { _meta: meta() } },
  ])
  const discover = s.byId.get('d').result
  assert.equal(discover.resultType, 'complete')
  assert.deepEqual(discover.supportedVersions, ['2026-07-28'])
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'spawnloft')
  const list = s.byId.get('l').result
  assert.equal(list.resultType, 'complete')
  assert.equal(list.structuredContent.instances[0].name, 'royalplugins')
  assert.equal(s.byId.get('v').error.code, -32022)
  assert.ok(s.byId.get('v').error.data.supported.includes('2026-07-28'))
  assert.equal(s.byId.get('c').error.code, -32602)
  assert.equal(s.byId.get('m').error.code, -32601)
})

test('no credential or webhook leaves, even from a console line that printed one', async () => {
  const s = await session([
    call(1, 'list_servers'), call(2, 'server_status', { name: 'royalplugins' }),
    call(3, 'get_logs', { name: 'royalplugins' }), call(4, 'diagnostics', { name: 'royalplugins' }),
    call(5, 'doctor'),
  ])
  assert.ok(!s.stdout.includes(secret))
  assert.ok(!s.stdout.includes('fixture-hook-token'))
  assert.match(s.byId.get(3).result.content[0].text, /password=\[redacted\]/)
})

test('player IP addresses are hidden unless --show-ips is passed', async () => {
  const hidden = await session([call(1, 'get_logs', { name: 'royalplugins' })])
  const text = hidden.byId.get(1).result.content[0].text
  assert.ok(!text.includes('203.0.113.7'))
  assert.ok(!text.includes('2001:db8'))
  assert.match(text, /Steve\[\/\[ip hidden\]:51234\]/)
  const shown = await session([call(1, 'get_logs', { name: 'royalplugins' })], ['--show-ips'])
  assert.match(shown.byId.get(1).result.content[0].text, /203\.0\.113\.7/)
  assert.ok(!shown.stdout.includes(secret), 'showing IPs never shows secrets')
})

test('get_logs filters by level the way Paper writes it, and caps its size', async () => {
  const s = await session([
    call(1, 'get_logs', { name: 'royalplugins', level: 'error' }),
    call(2, 'get_logs', { name: 'royalplugins', level: 'warn' }),
    call(3, 'get_logs', { name: 'royalplugins', lines: 1 }),
    call(4, 'get_logs', { name: 'royalplugins', lines: 5000 }),
    call(5, 'get_logs', { name: 'royalplugins', grep: '(' }),
  ])
  assert.equal(s.byId.get(1).result.structuredContent.lines.length, 1)
  assert.equal(s.byId.get(2).result.structuredContent.lines.length, 2)
  assert.equal(s.byId.get(3).result.structuredContent.lines.length, 1)
  assert.equal(s.byId.get(4).result.isError, true)
  assert.equal(s.byId.get(5).result.isError, true)
})

test('run_command refuses the commands that bypass the supervisor, before touching RCON', async () => {
  const s = await session(['stop', '/minecraft:stop', 'restart now', 'bukkit:reload confirm', 'rl']
    .map((command, i) => call(i + 1, 'run_command', { name: 'royalplugins', command })))
  for (let id = 1; id <= 5; id++) {
    const r = s.byId.get(id).result
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /not run over RCON/)
  }
  const idle = await session([call(1, 'run_command', { name: 'royalplugins', command: 'list' })])
  assert.match(idle.byId.get(1).result.content[0].text, /not running/)
})

test('mistakes come back as tool errors; unknown tools as protocol errors', async () => {
  const s = await session([
    call(1, 'server_status', { name: 'nope' }),
    call(2, 'server_status', {}),
    call(3, 'server_status', { name: 'royalplugins', extra: 1 }),
    call(4, 'no_such_tool'),
    call(5, 'players', { name: 'externaldb' }),
    call(6, 'kill', { name: 'royalplugins' }),
    'not json',
  ])
  assert.equal(s.byId.get(1).result.isError, true)
  assert.match(s.byId.get(2).result.content[0].text, /"name" is required/)
  assert.match(s.byId.get(3).result.content[0].text, /unknown argument "extra"/)
  assert.equal(s.byId.get(4).error.code, -32602)
  assert.match(s.byId.get(5).result.content[0].text, /is a database/)
  assert.equal(s.byId.get(6).error.code, -32602, 'destructive tools do not exist without the flag')
  assert.equal(s.byId.get(null).error.code, -32700)
})

test('destructive tools describe what they would do until confirmed', async () => {
  const s = await session([
    call(1, 'kill', { name: 'royalplugins' }),
    call(2, 'restore', { name: 'royalplugins' }),
    call(3, 'upgrade_minecraft', { name: 'royalplugins', version: '1.21.4' }),
    call(4, 'upgrade_minecraft', { name: 'royalplugins', version: '1.99' }),
  ], ['--allow-destructive'])
  const kill = s.byId.get(1).result
  assert.equal(kill.structuredContent.confirmed, false)
  assert.match(kill.content[0].text, /confirm: true/)
  assert.match(s.byId.get(2).result.content[0].text, /no snapshots/)
  assert.match(s.byId.get(3).result.content[0].text, /use upgrade_build/)
  const up = s.byId.get(4).result.structuredContent
  assert.deepEqual([up.confirmed, up.from, up.to], [false, '1.21.4', '1.99'])
  assert.equal(fs.readFileSync(path.join(data, 'instances.json'), 'utf8').includes('paper-1.21.4-100.jar'), true)
})

test('backup works through MCP and reports progress to a client that asked for it', async () => {
  const s = await session([call(1, 'backup', { name: 'royalplugins', scope: 'config' }, { progressToken: 'p1' })])
  const r = s.byId.get(1).result
  assert.equal(r.isError, undefined, r.content[0].text)
  assert.match(r.structuredContent.snapshot, /config_.*\.tar\.gz$/)
  assert.ok(s.notes.some((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p1'))
  const listed = await session([call(1, 'list_snapshots', { name: 'royalplugins' })])
  assert.equal(listed.byId.get(1).result.structuredContent.snapshots.length, 1)
})

test('the restore preview reads the archive, and a broken one is refused before and after confirming', async () => {
  const snapshot = (await session([call(1, 'list_snapshots', { name: 'royalplugins' })]))
    .byId.get(1).result.structuredContent.snapshots[0].name
  const sound = (await session([call(1, 'restore', { name: 'royalplugins' })], ['--allow-destructive'])).byId.get(1).result
  assert.equal(sound.structuredContent.restorable, true)
  assert.match(sound.content[0].text, /reads back cleanly/)

  const file = path.join(data, 'backups', 'royalplugins', snapshot)
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
  const s = await session([
    call(1, 'restore', { name: 'royalplugins' }),
    call(2, 'restore', { name: 'royalplugins', confirm: true }),
  ], ['--allow-destructive'])
  const preview = s.byId.get(1).result
  assert.equal(preview.structuredContent.restorable, false)
  assert.match(preview.content[0].text, /does NOT read back cleanly/)
  const confirmed = s.byId.get(2).result
  assert.equal(confirmed.isError, true)
  assert.match(confirmed.content[0].text, /would not restore cleanly, so nothing was changed/)
  fs.rmSync(file)
  fs.rmSync(file.replace(/\.tar\.gz$/, '.json'))
})

test('results read as sentences, with the structured data beside them', async () => {
  const s = await session([
    call(1, 'server_status', { name: 'royalplugins' }),
    call(2, 'diagnostics', { name: 'royalplugins' }),
    call(3, 'check_plugin_updates', { name: 'royalplugins' }),
    call(4, 'list_snapshots', { name: 'royalplugins' }),
  ])
  for (let id = 1; id <= 4; id++) {
    const r = s.byId.get(id).result
    assert.ok(!r.content[0].text.trimStart().startsWith('{'), `tool ${id} answered with raw JSON: ${r.content[0].text}`)
    assert.ok(r.structuredContent, `tool ${id} lost its structured data`)
  }
  assert.match(s.byId.get(1).result.content[0].text, /^royalplugins: stopped; port 45611, RCON 45612; 1G memory/)
  assert.match(s.byId.get(2).result.content[0].text, /The port is already taken\. .*\n  From: .*FAILED TO BIND/)
  assert.match(s.byId.get(3).result.content[0].text, /has not installed any plugins/)
})

test('hideIps masks socket addresses and leaves versions and times alone', () => {
  assert.equal(hideIps('Steve[/10.0.0.2:5000] logged in'), 'Steve[/[ip hidden]:5000] logged in')
  assert.equal(hideIps('/0:0:0:0:0:0:0:1:25565 lost connection'), '/[ip hidden]:25565 lost connection')
  for (const kept of ['Paper 1.21.4-100', '[12:00:01 INFO]', 'Java 21.0.4.7', 'https://example.com:443/x']) {
    assert.equal(hideIps(kept), kept)
  }
})

test('validate enforces what the tool schemas declare', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'string', minLength: 1 }, n: { type: 'integer', minimum: 1, maximum: 5 }, e: { type: 'string', enum: ['x'] } } }
  assert.equal(validate(schema, { a: 'ok', n: 3, e: 'x' }), null)
  assert.match(validate(schema, {}), /required/)
  assert.match(validate(schema, { a: '' }), /empty/)
  assert.match(validate(schema, { a: 'ok', n: 1.5 }), /whole number/)
  assert.match(validate(schema, { a: 'ok', n: 9 }), /at most/)
  assert.match(validate(schema, { a: 'ok', e: 'y' }), /one of/)
  assert.match(validate(schema, []), /object/)
})

test('config files: listed, read with secrets hidden, changed with a one-file snapshot that restores', async () => {
  fs.writeFileSync(path.join(instance, 'server.properties'), `motd=Fixture\nserver-port=45611\nrcon.port=45612\nrcon.password=${secret}\n`)
  const cfg = path.join(instance, 'plugins', 'Example', 'config.yml')
  fs.mkdirSync(path.dirname(cfg), { recursive: true })
  fs.writeFileSync(cfg, 'storage:\n  host: localhost\n  password: plugin-db-pass\nradius: 5\n')
  fs.writeFileSync(path.join(instance, 'plugins', 'Example', 'other.yml'), 'untouched: true\n')

  const s = await session([
    { id: 1, method: 'tools/list', params: { _meta: meta() } },
    call(2, 'list_config_files', { name: 'royalplugins' }),
    call(3, 'read_config_file', { name: 'royalplugins', path: 'server.properties' }),
    call(4, 'read_config_file', { name: 'royalplugins', path: 'plugins/Example/config.yml' }),
    call(5, 'read_config_file', { name: 'royalplugins', path: 'eula.txt' }),
    call(6, 'read_config_file', { name: 'royalplugins', path: '../../instances.json' }),
  ])
  const tools = s.byId.get(1).result.tools
  const write = tools.find((t) => t.name === 'write_config_file')
  assert.ok(tools.some((t) => t.name === 'list_config_files' && t.annotations.readOnlyHint))
  assert.ok(tools.some((t) => t.name === 'read_config_file' && t.annotations.readOnlyHint))
  assert.deepEqual([write.annotations.readOnlyHint, write.annotations.destructiveHint], [false, false])
  const listed = s.byId.get(2).result.structuredContent.files.map((f) => f.path)
  assert.ok(listed.includes('plugins/Example/config.yml') && listed.includes('server.properties'))
  assert.ok(!listed.includes('eula.txt'))
  assert.ok(!s.stdout.includes(secret) && !s.stdout.includes('plugin-db-pass'), 'no secret in any reply')
  assert.match(s.byId.get(3).result.content[0].text, /rcon\.password=\[redacted\]/)
  assert.match(s.byId.get(4).result.content[0].text, /password: \[redacted\]/)
  assert.equal(s.byId.get(5).result.isError, true)
  assert.match(s.byId.get(6).result.content[0].text, /inside the server folder/)

  const w = await session([
    call(1, 'write_config_file', { name: 'royalplugins', path: 'plugins/Example/config.yml', old_text: 'radius: 5', new_text: 'radius: 12' }),
    call(2, 'write_config_file', { name: 'royalplugins', path: 'plugins/Example/config.yml', content: 'radius: 1\n' }),
    call(3, 'write_config_file', { name: 'royalplugins', path: 'server.properties', old_text: 'server-port=45611', new_text: 'server-port=1' }),
  ])
  const done = w.byId.get(1).result
  assert.equal(done.isError, undefined, done.content[0].text)
  assert.match(done.content[0].text, /- radius: 5\n\+ radius: 12/)
  assert.match(done.structuredContent.snapshot, /^before-edit_config_.*\.tar\.gz$/)
  assert.match(w.byId.get(2).result.content[0].text, /hides/)
  assert.match(w.byId.get(3).result.content[0].text, /set by SpawnLoft/)
  assert.ok(!w.stdout.includes('plugin-db-pass'))
  assert.match(fs.readFileSync(cfg, 'utf8'), /password: plugin-db-pass\nradius: 12\n/)

  // The snapshot holds that one file, so restoring it puts the file back and nothing else.
  fs.writeFileSync(path.join(instance, 'plugins', 'Example', 'other.yml'), 'untouched: changed later\n')
  const r = await session([call(1, 'restore', { name: 'royalplugins', snapshot: done.structuredContent.snapshot, confirm: true })], ['--allow-destructive'])
  assert.equal(r.byId.get(1).result.isError, undefined, r.byId.get(1).result.content[0].text)
  assert.match(fs.readFileSync(cfg, 'utf8'), /radius: 5\n$/)
  assert.equal(fs.readFileSync(path.join(instance, 'plugins', 'Example', 'other.yml'), 'utf8'), 'untouched: changed later\n')
})
