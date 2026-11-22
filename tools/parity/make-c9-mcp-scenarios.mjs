// Writes scenarios/c9-mcp-protocol.json and scenarios/c9-mcp-tools.json: the MCP server's
// protocol edges and its tools called over stdio, on a stopped and then a running server.
//   node tools/parity/make-c9-mcp-scenarios.mjs
// Each MCP session is one `rpc` step (a line is written once the one before it is answered), so
// the two cores are compared in the order of the requests. Change this script, never the
// scenarios by hand.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODERN = '2026-07-28'
const META = 'io.modelcontextprotocol/'

let nextId = 1
const line = (m) => JSON.stringify(m)
const init = (client = 'parity-rig') => [
  line({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '0' } } }),
  line({ jsonrpc: '2.0', method: 'notifications/initialized' }),
]
const call = (name, args = {}, extra = {}) =>
  line({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args, ...extra } })
const raw = (m) => line({ jsonrpc: '2.0', id: nextId++, ...m })
const session = (lines, { flags = [], expect = { code: 0 }, golden } = {}) => ({
  run: ['mcp', ...flags],
  stdin: `${lines.join('\n')}\n`,
  rpc: true,
  expect,
  ...(golden === undefined ? {} : { golden }),
})

// the version is the package's on one side and the build's on the other
const VERSION = { pattern: '("name":"spawnloft","title":"SpawnLoft","version":)"[^"]*"', replace: '$1"<version>"' }
const write = (name, scenario) => {
  scenario.normalize = [VERSION, ...(scenario.normalize ?? [])]
  fs.writeFileSync(path.join(here, 'scenarios', name), `${JSON.stringify(scenario, null, 2)}\n`)
}

// ------------------------------------------------------------------------------ protocol
nextId = 1
write('c9-mcp-protocol.json', {
  about: 'C9: the MCP protocol edges, on both eras. Handshake versions (a known one, an unknown one, none), a modern request with its version in _meta and one without client capabilities, an unsupported version, ping, unknown methods, requests that are not requests (no method, a bad jsonrpc, an array, a number), notifications that need no answer (cancelled, an unknown one), tools/call with no name, an unknown tool, arguments that are not an object, a missing required argument, wrong types, enum and integer checks, the Object.prototype names that pass unchecked, and the usage errors of the mcp command itself.',
  steps: [
    { run: ['mcp', 'extra'], expect: { code: 2 } },
    { run: ['mcp', '--bogus'], expect: { code: 2 } },
    { run: ['mcp', '--json'], expect: { code: 2 } },
    session([
      raw({ method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } }),
      raw({ method: 'initialize', params: {} }),
      raw({ method: 'initialize' }),
      raw({ method: 'ping' }),
      raw({ method: 'ping', params: { _meta: { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {} } } }),
      raw({ method: 'ping', params: { _meta: { [`${META}protocolVersion`]: MODERN } } }),
      raw({ method: 'ping', params: { _meta: { [`${META}protocolVersion`]: '2030-01-01', [`${META}clientCapabilities`]: {} } } }),
      raw({ method: 'tools/list', params: { _meta: { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {}, [`${META}clientInfo`]: { name: 'modern-rig' } } } }),
      raw({ method: 'server/discover', params: { _meta: { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {} } } }),
      raw({ method: 'resources/list' }),
      raw({ method: 'prompts/list' }),
      raw({ method: 'no/such' }),
      raw({}),
      line({ jsonrpc: '1.0', id: 900, method: 'ping' }),
      line({ id: 901, method: 'ping' }),
      '[1,2,3]',
      '42',
      '"text"',
      'null',
      '{"jsonrpc":"2.0","id":902,"method":5}',
      line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 12345 } }),
      line({ jsonrpc: '2.0', method: 'notifications/whatever' }),
      raw({ method: 'tools/call', params: {} }),
      raw({ method: 'tools/call' }),
      call('no_such_tool'),
      raw({ method: 'tools/call', params: { name: 'server_status', arguments: 'nope' } }),
      raw({ method: 'tools/call', params: { name: 'server_status', arguments: [] } }),
      raw({ method: 'tools/call', params: { name: 'server_status' } }),
      call('server_status', {}),
      call('server_status', { name: 5 }),
      call('get_logs', { name: 'nope', lines: 2.5 }),
      call('get_logs', { name: 'nope', lines: '10' }),
      call('get_logs', { name: 'nope', level: 'info' }),
      call('diagnostics', { name: 'nope', bundle: 'yes' }),
      call('bot_run_scenario', { scenario: [] }),
      call('bot_run_scenario', { scenario: 'x' }),
      call('server_status', { name: 'nope', constructor: 5 }),
      call('server_status', { name: 'nope', toString: 1, extra: true }),
      call('list_servers', { anything: 1 }),
      raw({ method: 'tools/call', params: { name: 'list_servers', arguments: {}, _meta: { progressToken: 'p1' } } }),
      raw({ method: 'tools/call', params: { name: 'server_status', arguments: { name: 'nope' }, _meta: { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {} } } }),
      '',
      '   ',
      '{"jsonrpc":"2.0",',
      raw({ method: 'ping' }),
    ]),
    session([...init('second'), call('server_status', { name: 'nope' })], { flags: ['--allow-destructive'] }),
    session([], {}),
  ],
})

// ------------------------------------------------------------------------------ tools
nextId = 1
const run1 = {
  dir: '{data}/instances/run1', jar: 'server.jar', java: '{repo}/test/fixtures/fake-java.mjs', memory: '1G',
  port: 47861, rcon: { port: 47871, password: 'hunter22secret' }, type: 'paper', mcVersion: '1.21.4',
}
const props = '#Minecraft server properties\nmotd=A Minecraft Server\nonline-mode=false\nserver-ip=127.0.0.1\nmax-players=20\n'
write('c9-mcp-tools.json', {
  about: 'C9: the MCP tools over stdio on a stopped and then a running server (the JVM stand-in answering RCON): the read tools (list_servers, server_status, get_logs with level and grep, diagnostics, players, performance, list_snapshots, get_activity, verify_snapshot, list_plugins, list_config_files, read_config_file, bot_check, doctor, the client read tools with no client), the actions (start with progress, run_command and its refusals, backup, write_config_file by old_text and by content, stop, restart), the destructive previews (kill, restore, upgrade_minecraft without confirm) and their absence without --allow-destructive, the tools that need a download host with every host refused, the client and bot tools with no client or bots to drive, refusals on an unknown server and a path outside the server folder, the RCON password scrubbed from what a tool sends back, and the activity each call leaves under the client\'s name.',
  env: { FAKE_JAVA_RCON: '1', SPAWNLOFT_RCON_TIMEOUT_MS: '3000' },
  normalize: [
    { pattern: '\\(build [^)]*\\)', replace: '(build)' },
    // a diagnostics bundle is compared by its entries; its summary.json differs by the version
    // and its deflate by the encoder (declared, as in c6b-diag)
    { pattern: 'size=\\d+ csize=\\d+ crc=[0-9a-f]+', replace: 'size=<n> csize=<n> crc=<crc>' },
    // an activity listing's later lines follow a "\n" inside a JSON string
    { pattern: '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z', replace: '<time>' },
    { pattern: '\\b\\d+(?:\\.\\d+)? (?:B|KB|KiB|MiB)\\b', replace: '<size>' },
    { pattern: '"(size|sizeBytes|bytes)"(\\s*):(\\s*)\\d+', replace: '"$1"$2:$3<n>' },
    { pattern: '"(?:uptimeMs)":\\d+', replace: '"uptimeMs":<ms>' },
    { pattern: '"(javaPid|pid|daemonPid)":\\d+', replace: '"$1":<pid>' },
    { pattern: '"runId":"run1:\\d+"', replace: '"runId":"run1:<epoch-ms>"' },
    { pattern: '"samples":\\[[^\\]]*\\]', replace: '"samples":<samples>' },
    { pattern: '\\b\\d+s\\b *', replace: '<secs> ' },
  ],
  ignore: ['data/run/**', 'data/instances/run1/logs/**'],
  steps: [
    { write: 'data/instances/run1/server.jar', text: '' },
    { write: 'data/instances/run1/eula.txt', text: 'eula=true\n' },
    { write: 'data/instances/run1/server.properties', text: props },
    { write: 'data/instances/run1/plugins/Greeter/config.yml', text: 'greeting: hello\nlimit: 3\n' },
    { write: 'data/instances/run1/plugins/Greeter/messages.properties', text: 'welcome=Welcome!\n' },
    { write: 'data/instances.json', json: { version: 1, instances: { run1 }, databases: {} } },
    session([
      ...init(),
      call('list_servers'),
      call('server_status', { name: 'run1' }),
      call('server_status', { name: 'nope' }),
      call('get_logs', { name: 'run1' }),
      call('diagnostics', { name: 'run1' }),
      call('players', { name: 'run1' }),
      call('performance', { name: 'run1' }),
      call('list_snapshots', { name: 'run1' }),
      call('get_activity', {}),
      call('verify_snapshot', { name: 'run1' }),
      call('verify_snapshot', { name: 'run1', snapshot: 'missing.tar.gz' }),
      call('list_plugins', { name: 'run1' }),
      call('list_config_files', { name: 'run1' }),
      call('list_config_files', { name: 'run1', folder: 'plugins/Greeter' }),
      call('list_config_files', { name: 'run1', folder: '../..' }),
      call('read_config_file', { name: 'run1', path: 'plugins/Greeter/config.yml' }),
      call('read_config_file', { name: 'run1', path: 'server.properties' }),
      call('read_config_file', { name: 'run1', path: '../instances.json' }),
      call('read_config_file', { name: 'run1', path: 'plugins/Greeter/none.yml' }),
      call('bot_check', { name: 'run1' }),
      call('bot_check', { name: 'nope' }),
      call('run_command', { name: 'run1', command: 'list' }),
      call('stop', { name: 'run1' }),
      call('client_profiles'),
      call('client_status', { profile: 'nobody' }),
      call('client_messages', { profile: 'nobody' }),
      call('client_logs', { profile: 'nobody' }),
      call('client_quit', { profile: 'nobody' }),
      call('write_config_file', { name: 'run1', path: 'plugins/Greeter/config.yml', old_text: 'limit: 3', new_text: 'limit: 5' }),
      call('write_config_file', { name: 'run1', path: 'plugins/Greeter/config.yml', old_text: 'absent text', new_text: 'x' }),
      call('write_config_file', { name: 'run1', path: 'plugins/Greeter/config.yml' }),
      call('write_config_file', { name: 'run1', path: 'plugins/Greeter/messages.properties', content: 'welcome=Hi!\n' }),
      call('read_config_file', { name: 'run1', path: 'plugins/Greeter/config.yml' }),
      call('get_activity', { name: 'run1', limit: 5 }),
    ]),
    session([
      ...init(),
      call('start', { name: 'run1' }, { _meta: { progressToken: 'start-1' } }),
      call('start', { name: 'run1' }),
      call('server_status', { name: 'run1' }),
      call('players', { name: 'run1' }),
      call('run_command', { name: 'run1', command: 'list' }),
      call('run_command', { name: 'run1', command: '/say hunter22secret' }),
      call('run_command', { name: 'run1', command: 'stop' }),
      call('run_command', { name: 'run1', command: 'restart now' }),
      call('run_command', { name: 'run1', command: '   ' }),
      call('get_logs', { name: 'run1', lines: 5 }),
      call('get_logs', { name: 'run1', level: 'warn' }),
      call('get_logs', { name: 'run1', grep: 'done|Done' }),
      call('get_logs', { name: 'run1', grep: '(' }),
      call('bot_check', { name: 'run1' }),
      call('backup', { name: 'run1', scope: 'config', label: 'mcp test' }, { _meta: { progressToken: 7 } }),
      call('list_snapshots', { name: 'run1' }),
    ]),
    session([
      ...init(),
      call('kill', { name: 'run1' }),
      call('restore', { name: 'run1' }),
      call('upgrade_minecraft', { name: 'run1', version: '1.21.5' }),
      call('kill', { name: 'nope' }),
      call('stop', { name: 'run1' }),
      call('server_status', { name: 'run1' }),
      call('get_activity', { name: 'run1' }),
    ], { flags: ['--allow-destructive'] }),
    // every download host is refused (SPAWNLOFT_TEST_ORIGINS is {}), so these show how each
    // tool reports a host it cannot reach
    session([
      ...init(),
      call('check_server_update', { name: 'run1' }),
      call('upgrade_build', { name: 'run1' }),
      call('search_plugins', { name: 'run1', query: 'greeter' }),
      call('check_plugin_updates', { name: 'run1' }),
      call('install_plugin', { name: 'run1', project_id: 'greeter' }),
      call('install_plugin', { name: 'run1', project_id: 'greeter', source: 'hangar' }),
      call('update_plugin', { name: 'run1', file: 'Greeter.jar' }),
      call('restart', { name: 'run1' }),
      call('stop', { name: 'run1' }),
      call('client_launch', { profile: 'nobody' }),
      call('client_join', { profile: 'nobody', server: 'run1' }),
      call('client_chat', { profile: 'nobody', text: 'hi' }),
      call('client_screenshot', { profile: 'nobody' }),
      call('diagnostics', { name: 'run1', client: 'nobody' }),
      call('diagnostics', { name: 'run1', bundle: true }),
      call('bot_run_scenario', { scenario: { bots: [] } }),
      call('bot_run_scenario', { scenario: { bots: ['alice'], steps: [{ bot: 'alice', chat: 'hi' }] }, name: 'nope' }),
      call('bot_run_scenario', { scenario: { instance: 'run1', bots: ['alice'], steps: [{ bot: 'alice', chat: 'hi' }] } }),
    ]),
    session([
      ...init(),
      call('kill', { name: 'run1', confirm: true }),
    ]),
  ],
})
