import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  redactConfig, resolveConfigPath, listConfigFiles, readConfigFile, planConfigWrite, applyConfigWrite,
  unchangedSince, summarizeChange,
} from '../src/config-files.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-config-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function server(files) {
  const dir = fs.mkdtempSync(path.join(scratch, 'srv-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return { name: 'fixture', dir }
}

const PROPS = 'motd=Hello\nserver-port=25566\nenable-rcon=true\nrcon.port=25576\nrcon.password=hunter22\nlevel-name=world\n'

test('secret values are hidden, and ordinary keys that only look alike are not', () => {
  const text = [
    'storage:',
    '  password: s3cret-value',
    '  username: root',
    "  api-key: 'abc123'",
    'discord:',
    '  webhook-url: https://discord.com/api/webhooks/1/xyz',
    '  bot-token: MTAx.yz',
    'currencies:',
    '  tokens: 5',
    '  token-cost: 10',
    '  require-password: false',
    '  password: ""',
    '  jdbc: jdbc:mysql://user:pa55@localhost/db',
    '{"password": "json-secret", "count": 3}',
    '  "clientSecret": "x-y-z",',
    'rcon.password=hunter22',
  ].join('\r\n')
  const out = redactConfig(text).split('\r\n')
  assert.equal(out[1], '  password: [redacted]')
  assert.equal(out[2], '  username: root')
  assert.equal(out[3], "  api-key: '[redacted]'")
  assert.equal(out[5], '  webhook-url: [redacted]')
  assert.equal(out[6], '  bot-token: [redacted]')
  assert.equal(out[8], '  tokens: 5')
  assert.equal(out[9], '  token-cost: 10')
  assert.equal(out[10], '  require-password: false')
  assert.equal(out[11], '  password: ""')
  assert.equal(out[12], '  jdbc: jdbc:mysql://user:[redacted]@localhost/db')
  assert.equal(out[14], '  "clientSecret": "[redacted]",')
  assert.equal(out[15], 'rcon.password=[redacted]')
  for (const s of ['s3cret', 'abc123', 'xyz', 'MTAx', 'pa55', 'x-y-z', 'hunter22']) assert.ok(!redactConfig(text).includes(s), s)
})

test('a URL password with no user in front of it is hidden too, and URLs without one are left alone', () => {
  // How TAB and most Redis clients write it; the first real config read through the tool had one.
  assert.equal(redactConfig("    url: 'redis://:r3dis-pass@localhost:6379/0'"), "    url: 'redis://:[redacted]@localhost:6379/0'")
  for (const kept of ["url: 'redis://localhost:6379/0'", 'site: https://example.com:8443/path', 'dl: https://user@host/x']) {
    assert.equal(redactConfig(kept), kept)
  }
})

test('paths stay inside the server folder and away from worlds, logs and player data', () => {
  const inst = server({ 'server.properties': PROPS, 'plugins/EcoItems/config.yml': 'a: 1\n', 'world/level.dat': 'x',
    'world/datapacks/x.json': '{}', 'logs/latest.txt': 'x', 'eula.txt': 'eula=true\n', 'banned-ips.json': '[]',
    'plugins/EcoItems.jar': 'jar' })
  assert.equal(resolveConfigPath(inst, 'plugins\\EcoItems\\config.yml').shown, 'plugins/EcoItems/config.yml')
  assert.equal(resolveConfigPath(inst, './server.properties').shown, 'server.properties')
  const refused = {
    '../other/server.properties': /inside the server folder/,
    'plugins/../../x.yml': /inside the server folder/,
    [path.join(scratch, 'x.yml')]: /inside the server folder/,
    'C:/Windows/win.ini': /inside the server folder/,
    'world/datapacks/x.json': /worlds, logs/,
    'logs/latest.txt': /worlds, logs/,
    'eula.txt': /EULA/,
    'banned-ips.json': /IP addresses/,
    'plugins/EcoItems.jar': /not a text configuration file/,
    'plugins/EcoItems/missing.yml': /does not exist/,
    'plugins/EcoItems': /not a text configuration file/,
  }
  for (const [p, why] of Object.entries(refused)) assert.throws(() => resolveConfigPath(inst, p), why, p)
})

test('a link that leads out of the server folder is refused', (t) => {
  const inst = server({ 'plugins/.keep': '' })
  const outside = fs.mkdtempSync(path.join(scratch, 'outside-'))
  fs.writeFileSync(path.join(outside, 'secret.yml'), 'a: 1\n')
  try {
    fs.symlinkSync(outside, path.join(inst.dir, 'plugins', 'Linked'), 'junction')
  } catch (err) {
    t.skip(`cannot make a link here: ${err.code}`)
    return
  }
  assert.throws(() => resolveConfigPath(inst, 'plugins/Linked/secret.yml'), /leads outside/)
  assert.throws(() => resolveConfigPath(inst, 'plugins/Linked/new.yml', { mustExist: false }), /leads outside/)
})

test('listing finds config files and skips worlds, logs, jars and player data', () => {
  const inst = server({ 'server.properties': PROPS, 'paper-global.yml': 'x: 1\n', 'plugins/EcoItems/config.yml': 'a: 1\n',
    'plugins/EcoItems/items/sword.yml': 'b: 2\n', 'plugins/EcoItems.jar': 'jar', 'world/datapacks/x.json': '{}',
    'logs/latest.txt': 'x', 'eula.txt': 'eula=true\n', 'usercache.json': '[]' })
  assert.deepEqual(listConfigFiles(inst).files.map((f) => f.path).sort(),
    ['paper-global.yml', 'plugins/EcoItems/config.yml', 'plugins/EcoItems/items/sword.yml', 'server.properties'])
  assert.deepEqual(listConfigFiles(inst, 'plugins/EcoItems/items').files.map((f) => f.path), ['plugins/EcoItems/items/sword.yml'])
  assert.throws(() => listConfigFiles(inst, 'world'), /worlds, logs/)
  assert.throws(() => listConfigFiles(inst, '../'), /inside the server folder/)
  assert.throws(() => listConfigFiles(inst, 'plugins/Nope'), /not a folder/)
})

test('reading redacts, and refuses binary and oversized files', () => {
  const inst = server({ 'server.properties': PROPS, 'plugins/X/data.yml': 'a\0b', 'plugins/X/big.yml': 'a'.repeat(600 * 1024) })
  const r = readConfigFile(inst, 'server.properties')
  assert.equal(r.redacted, true)
  assert.match(r.text, /rcon\.password=\[redacted\]/)
  assert.throws(() => readConfigFile(inst, 'plugins/X/data.yml'), /not a text file/)
  assert.throws(() => readConfigFile(inst, 'plugins/X/big.yml'), /KB/)
})

test('an exact replacement changes that text only, keeping CRLF and the BOM', () => {
  const inst = server({ 'plugins/X/config.yml': '\ufeffsettings:\r\n  enabled: false\r\n  radius: 5\r\n' })
  const plan = planConfigWrite(inst, 'plugins/X/config.yml', { oldText: '  enabled: false\n  radius: 5', newText: '  enabled: true\n  radius: 8' })
  applyConfigWrite(plan)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/X/config.yml'), 'utf8'), '\ufeffsettings:\r\n  enabled: true\r\n  radius: 8\r\n')
  assert.deepEqual(fs.readdirSync(path.join(inst.dir, 'plugins/X')), ['config.yml'], 'no temporary file left behind')
  assert.match(summarizeChange(plan.before, plan.after), /^@@ line 2 @@\n {2}settings:\n- {3}enabled: false\n- {3}radius: 5\n\+ {3}enabled: true\n\+ {3}radius: 8/)
})

test('replacements must match once, and must not be a no-op', () => {
  const inst = server({ 'plugins/X/config.yml': 'a: 1\nb: 1\n' })
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { oldText: 'c: 1', newText: 'c: 2' }), /not found/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { oldText: ': 1', newText: ': 2' }), /appears 2 times/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { oldText: 'a: 1', newText: 'a: 1' }), /unchanged/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { oldText: 'a: 1' }), /both needed/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { content: 'x: 1\n', oldText: 'a: 1', newText: 'a: 2' }), /not both/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', {}), /either content/)
})

test('a hidden value can never be written back, or dropped by a whole-file write', () => {
  const inst = server({ 'plugins/DB/config.yml': 'storage:\n  host: localhost\n  password: realpass\n' })
  const f = 'plugins/DB/config.yml'
  const shown = readConfigFile(inst, f).text
  assert.throws(() => planConfigWrite(inst, f, { content: shown.replace('localhost', 'db') }), /\[redacted\]/)
  assert.throws(() => planConfigWrite(inst, f, { content: 'storage:\n  host: db\n' }), /hides/)
  assert.throws(() => planConfigWrite(inst, f, { oldText: '  password: [redacted]', newText: '  password: x' }), /\[redacted\]|hidden value/)
  assert.throws(() => planConfigWrite(inst, f, { oldText: 'host: localhost\n  password: [redacted]', newText: 'host: db\n  password: [redacted]' }), /\[redacted\]/)
  assert.throws(() => planConfigWrite(inst, f, { oldText: 'x', newText: 'Steve /[ip hidden]:1' }), /\[ip hidden\]/)
  applyConfigWrite(planConfigWrite(inst, f, { oldText: 'host: localhost', newText: 'host: db' }))
  assert.match(fs.readFileSync(path.join(inst.dir, f), 'utf8'), /host: db\n {2}password: realpass/)
})

test('the ports and RCON SpawnLoft sets in server.properties are refused; other keys are not', () => {
  const inst = server({ 'server.properties': PROPS })
  assert.throws(() => planConfigWrite(inst, 'server.properties', { oldText: 'server-port=25566', newText: 'server-port=25570' }), /server-port.*set by SpawnLoft/)
  assert.throws(() => planConfigWrite(inst, 'server.properties', { oldText: 'rcon.port=25576\n', newText: '' }), /rcon\.port/)
  const plan = planConfigWrite(inst, 'server.properties', { oldText: 'motd=Hello', newText: 'motd=Skyblock' })
  assert.match(plan.after, /motd=Skyblock/)
  assert.doesNotMatch(summarizeChange(plan.before, plan.after), /hunter22/)
})

test('broken YAML indentation and invalid JSON are caught before writing', () => {
  const inst = server({ 'plugins/X/config.yml': 'a:\n  b: 1\n', 'plugins/X/data.json': '{"a": 1}' })
  assert.throws(() => planConfigWrite(inst, 'plugins/X/config.yml', { oldText: '  b: 1', newText: '\tb: 2' }), /line 2 .*tab/)
  assert.throws(() => planConfigWrite(inst, 'plugins/X/data.json', { content: '{"a": 1,}' }), /not valid JSON/)
})

test('content creates a new file, and a file changed since planning is noticed', () => {
  const inst = server({ 'plugins/EcoCrates/config.yml': 'x: 1\n' })
  const plan = planConfigWrite(inst, 'plugins/EcoCrates/rewards/new_reward.yml', { content: 'id: new_reward\n' })
  assert.equal(plan.existed, false)
  assert.equal(unchangedSince(plan), true)
  applyConfigWrite(plan)
  assert.equal(fs.readFileSync(path.join(inst.dir, 'plugins/EcoCrates/rewards/new_reward.yml'), 'utf8'), 'id: new_reward\n')

  const edit = planConfigWrite(inst, 'plugins/EcoCrates/config.yml', { oldText: 'x: 1', newText: 'x: 2' })
  fs.writeFileSync(path.join(inst.dir, 'plugins/EcoCrates/config.yml'), 'x: 1\ny: 1\n')
  assert.equal(unchangedSince(edit), false)
})

test('a listing cut short keeps the top-level files and loses the deepest ones', () => {
  const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`plugins/Big/lang/l${String(i).padStart(3, '0')}.yml`, 'x: 1\n']))
  const inst = server({ ...many, 'server.properties': PROPS, 'plugins/Zed/config.yml': 'a: 1\n' })
  const { files, truncated } = listConfigFiles(inst)
  assert.equal(truncated, true)
  assert.equal(files.length, 400)
  const paths = files.map((f) => f.path)
  assert.ok(paths.includes('server.properties') && paths.includes('plugins/Zed/config.yml'))
})
