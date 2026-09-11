import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { metricCursor, metricsCsv } from '../src/cli-metrics.mjs'
import { createRequire } from 'node:module'
const { writeCliLaunchers } = createRequire(import.meta.url)('../desktop/cli-launchers.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cli-'))
const data = path.join(scratch, 'data')
const instance = path.join(data, 'instances', 'royalplugins')
const run = path.join(data, 'run', 'royalplugins')
for (const dir of [instance, run, path.join(instance, 'plugins')]) fs.mkdirSync(dir, { recursive: true })
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
const secret = 'fixture-secret-never-in-status'
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {
  royalplugins: { dir: instance, jar: 'server.jar', memory: '1G', port: 45601,
    rcon: { port: 45602, password: secret }, webhook: secret, jvmFlags: [secret] },
  externaldb: { kind: 'database', engine: 'mariadb', external: true, port: 45603,
    root: { password: secret }, attachments: { royalplugins: { password: secret } } },
} }))
fs.writeFileSync(path.join(instance, 'server.jar'), 'fixture')
fs.writeFileSync(path.join(instance, 'eula.txt'), 'eula=true\n')
fs.writeFileSync(path.join(instance, 'plugins', 'manual.jar'), 'unreadable fixture still inventoried')
fs.writeFileSync(path.join(run, 'console.log'), '[ERROR]: FAILED TO BIND TO PORT\n')
const metrics = path.join(run, 'metrics.log')
const at = Math.floor(Date.now() / 1000)
fs.writeFileSync(metrics, `${at - 20} 12.5 128\n${at - 10} 6.25 256\n`)
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function cli(args, name = 'mcctl') {
  try { return { code: 0, stdout: execFileSync(process.execPath, [path.join(root, `${name}.mjs`), ...args],
    { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' } }
  catch (error) { if (!Number.isInteger(error.status)) throw error
    return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) } }
}
function json(args, code = 0, name) {
  const result = cli(args, name)
  assert.equal(result.code, code, JSON.stringify(result))
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.ok, code === 0)
  return parsed
}

test('both CLI names return the same versioned status without registry credentials', () => {
  const old = json(['status', 'royalplugins', '--json'])
  const next = json(['status', '--json', 'royalplugins'], 0, 'spawnloft')
  assert.deepEqual(next, old)
  assert.equal(next.command, 'status')
  assert.equal(next.data.status, 'stopped')
  assert.equal(next.data.rconPort, 45602)
  for (const command of ['list', 'ls', 'status']) {
    const inventory = json([command, '--json'])
    assert.equal(inventory.data.instances.length, 1)
    assert.equal(inventory.data.databases[0].status, 'external')
    assert.ok(!JSON.stringify(inventory).includes(secret))
  }
  assert.ok(!JSON.stringify(next).includes(secret))
})

test('both CLI names reject removed database config commands without changing plugin files or credentials', () => {
  const folder = path.join(instance, 'plugins', 'LuckPerms')
  fs.mkdirSync(folder, { recursive: true })
  const config = path.join(folder, 'config.yml')
  const original = 'storage-method: h2\n# My manual settings\ndata:\n  password: keep-me\n'
  fs.writeFileSync(config, original)
  const registry = path.join(data, 'instances.json')
  const before = fs.readFileSync(registry, 'utf8')
  for (const name of ['mcctl', 'spawnloft']) {
    for (const args of [['db', 'apply', 'externaldb', 'royalplugins', 'luckperms'], ['db', 'plugins', 'royalplugins']]) {
      const result = cli(args, name)
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /usage:/)
      assert.ok(!result.stdout.includes(secret))
      assert.equal(fs.readFileSync(config, 'utf8'), original)
      assert.equal(fs.readFileSync(registry, 'utf8'), before)
    }
    const credentials = cli(['db', 'creds', 'externaldb', 'royalplugins'], name)
    assert.equal(credentials.code, 0, JSON.stringify(credentials))
    assert.ok(credentials.stdout.includes(secret), 'explicit credential display remains available')
    assert.match(credentials.stdout, /Configure your plugins manually/)
    assert.equal(fs.readFileSync(config, 'utf8'), original)
  }
})

test('JSON inventories and diagnostics retain useful fields and aliases agree', () => {
  const plugins = json(['plugins', 'royalplugins', '--json'])
  assert.equal(plugins.data.plugins[0].file, 'manual.jar')
  assert.equal(plugins.data.plugins[0].managed, false)
  const backups = json(['backups', 'royalplugins', '--json'])
  assert.deepEqual(backups.data.backups, [])
  assert.deepEqual(json(['snapshots', 'royalplugins', '--json']), backups)
  const diagnostics = json(['diagnostics', 'royalplugins', '--json'])
  assert.equal(diagnostics.data.findings[0].id, 'port-in-use')
  assert.equal(diagnostics.data.scope, 'recent-console-and-crash-reports')
  assert.deepEqual(json(['why', 'royalplugins', '--json']), diagnostics)
})

test('usage errors are JSON and occur before unsupported mutations; operation failures use exit 1', () => {
  for (const args of [['plugins', 'royalplugins', 'disable', 'manual', '--json'],
    ['remove', 'royalplugins', '--json'], ['status', 'royalplugins', '--json', '--typo'],
    ['metrics', 'royalplugins', '--json', '--csv'], ['metrics', 'royalplugins', '--json', '--seconds=zero'],
    ['backup', 'royalplugins', '--json', '--keep=0'], ['bogus', '--json'], ['__proto__', '--json'], ['--help', '--json']]) {
    assert.equal(json(args, 2).error.code, 'INVALID_USAGE')
  }
  assert.ok(fs.existsSync(path.join(instance, 'plugins', 'manual.jar')))
  assert.equal(json(['status', 'missing', '--json'], 1).error.code, 'COMMAND_FAILED')
})

test('backup creation emits one JSON result and inventory reports the finished archive', () => {
  const made = json(['backup', 'royalplugins', '--scope=plugins', '--json'])
  assert.ok(fs.existsSync(made.data.path))
  assert.ok(made.data.sizeBytes > 0)
  assert.deepEqual(made.data.warnings, [])
  const history = json(['backups', 'royalplugins', '--json'])
  assert.equal(history.data.backups.length, 1)
  assert.equal(history.data.backups[0].path, made.data.path)
})

test('metrics JSON and CSV export the same numbers; explicit output never overwrites a run', () => {
  const snapshot = json(['metrics', 'royalplugins', '--json'])
  assert.deepEqual(snapshot.data.samples.map(row => [row.cpuPercent, row.rssMiB]), [[12.5, 128], [6.25, 256]])
  assert.equal(snapshot.data.cpuScale, 'whole-machine')
  assert.equal(json(['metrics', 'royalplugins', '--json', '--seconds=1']).data.samples.length, 0)
  const csv = cli(['metrics', 'royalplugins', '--csv'])
  assert.equal(csv.code, 0)
  assert.equal(csv.stdout, metricsCsv(snapshot.data))
  const output = path.join(scratch, 'run comparison.csv')
  assert.equal(cli(['metrics', 'royalplugins', '--csv', '--output', output]).code, 0)
  assert.equal(fs.readFileSync(output, 'utf8'), csv.stdout)
  assert.equal(cli(['metrics', 'royalplugins', '--csv', '--output', output]).code, 1)
  assert.equal(fs.readFileSync(output, 'utf8'), csv.stdout)
})

test('doctor JSON reports checks without clearing stale runtime state', () => {
  const file = path.join(run, 'state.json')
  const stale = JSON.stringify({ daemonPid: 2147483647, javaPid: 2147483646, startedAt: 1, running: true })
  fs.writeFileSync(file, stale)
  try {
    const result = json(['doctor', '--json'], 1)
    assert.equal(result.error.code, 'CHECK_FAILED')
    assert.ok(result.data.problems.some(problem => problem.includes('stale state file')))
    assert.equal(fs.readFileSync(file, 'utf8'), stale)
  } finally { fs.unlinkSync(file) }
})

test('follow cursor avoids duplicates across trimming and marks a new server run', () => {
  const cursor = metricCursor()
  const frame = (runId, times) => ({ runId, samples: times.map(at => ({ at })) })
  assert.equal(cursor(frame('a', [1, 2])).rows.length, 2)
  assert.deepEqual(cursor(frame('a', [1, 2])).rows, [])
  assert.deepEqual(cursor(frame('a', [])).rows, [])
  assert.deepEqual(cursor(frame('a', [1, 2])).rows, [])
  assert.deepEqual(cursor(frame('a', [2, 3])).rows, [{ at: 3 }])
  assert.equal(cursor(frame('b', [])).reset, true)
  assert.deepEqual(cursor(frame('b', [4])).rows, [{ at: 4 }])
})

test('follow emits parseable JSON Lines, only new samples, and reset events', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [path.join(root, 'spawnloft.mjs'), 'metrics', '--follow', 'royalplugins', '--json'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const frames = []
  let buffer = ''
  let errors = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) frames.push(JSON.parse(line))
  })
  child.stderr.on('data', chunk => { errors += chunk })
  async function wait(check) {
    const deadline = Date.now() + 4500
    while (!check() && Date.now() < deadline) await sleep(25)
    assert.ok(check(), JSON.stringify(frames))
  }
  try {
    await wait(() => frames.length === 1)
    assert.equal(frames[0].type, 'snapshot')
    fs.appendFileSync(metrics, `${at} 25 300\n`)
    await wait(() => frames.some(frame => frame.type === 'sample' && frame.data.at === at))
    await sleep(1100)
    assert.equal(frames.filter(frame => frame.type === 'sample').length, 1)
    fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify({ startedAt: Date.now(), daemonPid: process.pid, javaPid: process.pid }))
    fs.writeFileSync(metrics, `${at + 1} 30 320\n`)
    await wait(() => frames.some(frame => frame.type === 'reset'))
    // Reset and sample are separate writes and may arrive in separate pipe chunks.
    // Seeing the reset acknowledges the generation change, not delivery of its first sample.
    await wait(() => frames.some(frame => frame.type === 'sample' && frame.data.at === at + 1))
    const resetIndex = frames.findIndex(frame => frame.type === 'reset')
    const sampleIndex = frames.findIndex(frame => frame.type === 'sample' && frame.data.at === at + 1)
    assert.ok(sampleIndex > resetIndex)
    assert.equal(frames[sampleIndex].data.cpuPercent, 30)
    assert.equal(errors, '')
  } finally {
    child.kill('SIGTERM')
    const [code] = await closed
    if (process.platform !== 'win32') assert.equal(code, 143)
    fs.rmSync(path.join(run, 'state.json'), { force: true })
  }
})

test('packaged launchers quote paths and forward arguments using the bundled runtime', () => {
  for (const platform of ['darwin', 'win32']) {
    const resources = path.join(scratch, platform, 'App With Spaces', 'Resources')
    writeCliLaunchers(resources, platform)
    for (const name of ['spawnloft', 'mcctl']) {
      const file = path.join(resources, 'bin', name + (platform === 'win32' ? '.cmd' : ''))
      const script = fs.readFileSync(file, 'utf8')
      assert.ok(script.includes('ELECTRON_RUN_AS_NODE=1'))
      assert.ok(script.includes(`${name}.mjs"`))
      assert.ok(script.includes(platform === 'darwin' ? '"$@"' : '%*'))
      if (platform === 'darwin' && process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o111)
    }
  }
})
