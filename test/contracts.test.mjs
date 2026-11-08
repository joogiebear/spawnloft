/**
 * The R1 contract fixtures in test/fixtures/contracts/, checked against the Node code that writes
 * and reads each file: the state file and readState's statuses, metrics.log's writer and readers,
 * activity entries and the action catalog, the webhook payload, instances.json and schedules.json.
 * The daemon's live side (control ops, the state it writes, its webhook post and crash entry) is
 * test/contracts-daemon.test.mjs. A failure here means either the code changed a contract a second
 * implementation depends on, or the fixture is out of date: see test/fixtures/contracts/README.md.
 *
 * Isolated by MCCTL_DATA_ROOT like the lifecycle suites.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-contracts-'))
process.env.MCCTL_DATA_ROOT = scratch

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'contracts')
const SRC = path.join(HERE, '..', 'src')
const load = (file) => JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'))
// line endings normalised: a Windows checkout may give CRLF, and the scans below anchor on \n
const source = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n')

const { check, fieldsOf } = await import('./fixtures/contracts/shape.mjs')
const { readState } = await import('../src/control.mjs')
const { stateFile, runDir, REGISTRY_FILE, DATA_ROOT } = await import('../src/paths.mjs')
const { sampleLine, readSamples, latestSample, metricsFile, SAMPLE_SECONDS } = await import('../src/metrics.mjs')
const activity = await import('../src/activity.mjs')
const { formatDiscord, notifyInstance } = await import('../src/notify.mjs')
const registry = await import('../src/registry.mjs')
const { adoptInstance } = await import('../src/create.mjs')
const schedule = await import('../src/schedule.mjs')
const { STEP_KINDS } = await import('../src/task-steps.mjs')
const { CRASH_LIMIT, CRASH_WINDOW_MS } = await import('../src/crashguard.mjs')

const control = load('control-protocol.json')
const states = load('state.json')
const metrics = load('metrics.json')
const activityFx = load('activity.json')
const webhook = load('webhook.json')
const instances = load('instances.json')
const schedules = load('schedules.json')

const fits = (value, spec, defs, what) => {
  const problems = check(value, spec, '$', defs)
  assert.deepEqual(problems, [], `${what}:\n  ${problems.join('\n  ')}`)
}

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// --- the checker itself, since every assertion below leans on it ---

test('the shape checker refuses what it should', () => {
  assert.deepEqual(check(1, 'integer'), [])
  assert.deepEqual(check(1.5, 'number'), [])
  assert.equal(check(1.5, 'integer').length, 1)
  assert.deepEqual(check(null, 'integer|null'), [])
  assert.equal(check({ a: 1, b: 2 }, { object: { a: 'integer' } }).length, 1, 'an unlisted field')
  assert.deepEqual(check({ a: 1, b: 2 }, { object: { a: 'integer' }, extra: true }), [])
  assert.equal(check({}, { object: { a: 'integer' } }).length, 1, 'a missing field')
  assert.deepEqual(check({}, { object: { 'a?': 'integer' } }), [])
  assert.equal(check('x', { match: '^y' }).length, 1)
  assert.equal(check(2, { enum: [1] }).length, 1)
  assert.equal(check([1, 'a'], { array: 'integer' }).length, 1)
  assert.deepEqual(check({ k: 1 }, { map: { ref: 'n' } }, '$', { n: 'integer' }), [])
  assert.equal(check(true, { oneOf: ['integer', 'string'] }).length, 1)
  assert.equal(check(1, 'int').length, 1, 'a typo in a fixture fails instead of passing everything')
  assert.equal(check({}, { object: {}, extar: true }).length, 1, 'a misspelt keyword is refused')
  assert.equal(check(1, { const: 1, enum: [2] }).length, 1, 'two keywords in one spec are refused')
  assert.deepEqual(check('anything', { match: '' }), [])
})

// --- control protocol: what the live suite cannot reach is held against the source ---

test('the daemon serves exactly the ops the fixture lists, and the clients send only those', () => {
  const daemon = source('daemon.mjs')
  const handle = daemon.slice(daemon.indexOf('async function handle(req)'))
  const body = handle.slice(0, handle.indexOf('\n}\n'))
  const served = [...body.matchAll(/case '([a-z]+)':/g)].map((m) => m[1])
  assert.deepEqual(served.sort(), [...control.ops].sort())
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'))) {
    for (const m of source(file).matchAll(/controlRequest\([^,]+,\s*\{\s*op:\s*'([a-z]+)'/g)) {
      assert.ok(control.ops.includes(m[1]), `${file} sends op "${m[1]}", which the fixture does not list`)
    }
  }
  const ids = new Set()
  for (const c of control.cases) {
    assert.ok(!ids.has(c.id), `case ${c.id} listed twice`)
    ids.add(c.id)
    assert.ok(['live', 'source'].includes(c.asserted), c.id)
    // a refused request is malformed on purpose; the rest are what a client may send
    if (c.request && control.ops.includes(c.request.op) && !c.id.startsWith('send-no-line')) fits(c.request, control.requests[c.request.op], {}, `${c.id} request`)
  }
})

test('every reply the live suite cannot reach is still written by the daemon as the fixture says', () => {
  const daemon = source('daemon.mjs')
  for (const c of control.cases.filter((x) => x.asserted === 'source')) {
    assert.ok(c.source, `${c.id}: a source case names the line it is held to`)
    assert.ok(daemon.includes(c.source), `${c.id}: "${c.source}" is not in src/daemon.mjs`)
    const literal = c.source.slice(c.source.indexOf('{'))
    assert.deepEqual(replyKeys(literal), Object.keys(c.reply.object).map((k) => k.replace(/\?$/, '')).sort(), `${c.id}: fields`)
  }
})

// the field names of a one-line `{ ok: ..., key: value }` literal
function replyKeys(literal) {
  const inner = literal.replace(/^\{\s*/, '').replace(/\s*\}$/, '')
  return [...inner.matchAll(/(?:^|, )(\w+):/g)].map((m) => m[1]).sort()
}

test('every reply object in the daemon has a case with the same fields, and every error text is listed', () => {
  const daemon = source('daemon.mjs')
  // replies live in handleStop, the socket's line loop and handle(), all below handleStop
  const replies = daemon.slice(daemon.indexOf('async function handleStop('))
  assert.ok(replies.length < daemon.length, 'handleStop not found')
  const literals = [...replies.matchAll(/\{ ok: (?:true|false)(?:, [^{}\n]*)? \}/g)].map((m) => m[0])
  assert.ok(literals.length >= 12, `found only ${literals.length} reply objects; has the daemon's reply style changed?`)
  const caseKeys = control.cases.map((c) => Object.keys(c.reply.object).map((k) => k.replace(/\?$/, '')).sort().join(','))
  for (const literal of literals) {
    assert.ok(caseKeys.includes(replyKeys(literal).join(',')), `src/daemon.mjs replies ${literal}, whose fields no case has`)
  }
  // a new reply text is a protocol change
  const replied = [...daemon.matchAll(/\{ ok: false, error: '([^']+)' \}/g)].map((m) => m[1])
  const listed = control.cases.map((c) => c.reply.object.error?.const).filter(Boolean)
  for (const text of replied) assert.ok(listed.includes(text), `src/daemon.mjs replies "${text}", which no case lists`)
})

// --- state.json ---

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => child.on('exit', r))
  return child.pid
}

test('every state example fits its shape, and readState gives it the status the fixture says', { timeout: 30000 }, async (t) => {
  const exe = path.basename(process.execPath)
  // a live stand-in for java: this runtime, so its image name is known
  const java = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  t.after(() => java.kill())
  const dead = await deadPid()
  const name = 'contract-state'
  fs.mkdirSync(runDir(name), { recursive: true })
  const seen = new Set()
  for (const ex of states.examples) {
    fits(ex.state, states.shapes[ex.shape], states.shapes, `state example ${ex.id}`)
    assert.ok(states.statuses.includes(ex.status), ex.id)
    seen.add(ex.status)
    const live = { ...ex.state, name }
    live.daemonPid = ex.pids.daemon === 'alive' ? process.pid : dead
    if ('daemonExe' in live) live.daemonExe = exe
    if ('javaPid' in live) {
      live.javaPid = ex.pids.java === 'alive' ? java.pid : dead
      live.javaExe = exe
    }
    fs.writeFileSync(stateFile(name), JSON.stringify(live))
    assert.equal(readState(name).status, ex.status, `${ex.id} read as ${readState(name).status}`)
  }
  assert.deepEqual([...seen].sort(), [...states.statuses].sort(), 'every status has an example')
  fs.rmSync(stateFile(name))
  assert.equal(readState(name).status, 'stopped', 'no file reads as stopped')
})

test('every field the daemon writes into state.json is in the fixture', () => {
  const daemon = source('daemon.mjs')
  const listed = new Set([...fieldsOf(states.shapes.launched), ...fieldsOf(states.shapes.failedToStart)])
  const written = new Set()
  for (const m of daemon.matchAll(/\bstate\.(\w+)\s*=(?!=)/g)) written.add(m[1])
  for (const m of daemon.matchAll(/delete state\.(\w+)/g)) written.add(m[1])
  const literal = daemon.slice(daemon.indexOf('  state = {'), daemon.indexOf('  writeJson(stateFile(name), state)\n  log(`child pid'))
  for (const m of literal.matchAll(/^ {4}(\w+)[:,]/gm)) written.add(m[1])
  const die = daemon.slice(daemon.indexOf('writeJson(stateFile(name), {'), daemon.indexOf('process.exit(1)\n}'))
  for (const m of die.matchAll(/^ {6}(\w+)[:,]/gm)) written.add(m[1])
  for (const m of die.matchAll(/\{ (\w+), (\w+): true \}/g)) { written.add(m[1]); written.add(m[2]) }
  assert.ok(written.size >= 20, `found only ${[...written].join(', ')}`)
  for (const key of ['failedAt', 'killedOnDaemonFailure', 'restarting', 'stoppedAt']) assert.ok(written.has(key), `the scan missed ${key}`)
  for (const key of written) {
    assert.ok(listed.has(key), `the daemon writes state.${key}, which state.json does not list`)
  }
})

// --- metrics.log ---

test('metrics.log lines are written and read exactly as the fixture says', async () => {
  assert.equal(SAMPLE_SECONDS, metrics.format.intervalSeconds)
  const metricsSrc = source('metrics.mjs')
  assert.match(metricsSrc, new RegExp(`const KEEP = ${metrics.format.keep}\\b`))
  assert.match(metricsSrc, /const TRIM_AT = KEEP \+ 600\b/)
  assert.equal(metrics.format.trimAt, metrics.format.keep + 600)
  const lineRe = new RegExp(metrics.format.lineRegex)
  for (const w of metrics.writer) {
    const line = sampleLine(w.sample, w.server)
    assert.equal(line, `${w.line}\n`)
    assert.match(w.line, lineRe)
  }
  const name = 'contract-metrics'
  fs.mkdirSync(runDir(name), { recursive: true })
  fs.writeFileSync(metricsFile(name), metrics.reader.file.join('\n') + '\n')
  assert.deepEqual(readSamples(name), metrics.reader.rows)
  assert.deepEqual(await latestSample(name, { now: metrics.reader.latestNow }), metrics.reader.latest)
  assert.equal(await latestSample(name, { now: metrics.reader.latestStaleNow }), null)
})

// --- activity ---

test('activity entries are written in the fixture\'s shape', () => {
  for (const c of activityFx.record) {
    const run = () => activity.record(c.call.server, c.call.action, c.call.options)
    const entry = c.call.actor ? activity.asActor(c.call.actor, run) : run()
    fits(entry, activityFx.entry, {}, `${c.call.action} entry`)
    const { at, ...rest } = entry
    assert.deepEqual(rest, c.entry)
    assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60000)
    if (entry.action === 'crash') fits(entry, activityFx.daemon.entry, {}, 'the daemon\'s crash entry')
  }
  const lines = fs.readFileSync(path.join(DATA_ROOT, activityFx.files.current), 'utf8').trim().split('\n')
  assert.equal(lines.length, activityFx.record.length, 'one line per entry')
  assert.equal(activity.MAX_BYTES, activityFx.files.maxBytes)
  const read = activity.readActivity({ server: 'survival' }).entries
  assert.deepEqual(read.map((e) => e.action), activityFx.record.map((c) => c.entry.action).reverse(), 'newest first')
})

test('the action catalog is every action the source records, and nothing else', () => {
  const found = new Set()
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs') && f !== 'activity.mjs')) {
    for (const line of source(file).split('\n')) {
      const at = line.indexOf('activity.record(')
      if (at === -1) continue
      // the action is the second argument: everything between the first comma and the options
      const args = line.slice(at + 'activity.record('.length)
      const second = args.slice(args.indexOf(',') + 1).split(/,\s*\{|\)\s*$|\)\s*;?$/)[0]
      for (const m of second.matchAll(/'([a-z][a-z-]*)'/g)) found.add(m[1])
    }
  }
  assert.deepEqual([...found].sort(), [...activityFx.actions].sort())
})

// --- webhook ---

test('the webhook payload and every daemon message are as the fixture says', async () => {
  for (const ex of webhook.examples) {
    assert.deepEqual(formatDiscord(ex.server, ex.message), ex.body)
    fits(ex.body, webhook.request.body, {}, 'webhook body')
    const matching = webhook.daemonMessages.filter((m) => new RegExp(m.regex).test(ex.message))
    assert.equal(matching.length, 1, `"${ex.message}" matches ${matching.length} message shapes`)
  }
  for (const m of webhook.daemonMessages) {
    assert.ok(webhook.examples.some((ex) => new RegExp(m.regex).test(ex.message)), `${m.id} has no example`)
  }
  // one message shape per place the daemon tells someone
  const daemon = source('daemon.mjs')
  const calls = [...daemon.matchAll(/\btell\(`/g)].length
  assert.equal(calls, webhook.daemonMessages.length)
  assert.equal(CRASH_LIMIT, 3)
  assert.equal(CRASH_WINDOW_MS, 10 * 60 * 1000)

  const got = []
  const hook = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { got.push({ method: req.method, url: req.url, type: req.headers['content-type'], body }); res.writeHead(204).end() })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  try {
    const ex = webhook.examples[0]
    assert.equal(await notifyInstance({ name: ex.server, webhook: `http://127.0.0.1:${hook.address().port}/hook?wait=true` }, ex.message), true)
    assert.equal(got.length, 1)
    assert.equal(got[0].method, webhook.request.method)
    assert.equal(got[0].url, '/hook?wait=true')
    assert.equal(got[0].type, webhook.request.headers['content-type'])
    assert.deepEqual(JSON.parse(got[0].body), ex.body)
  } finally {
    await new Promise((r) => hook.close(r))
  }
  assert.match(source('notify.mjs'), new RegExp(`AbortSignal\\.timeout\\(${webhook.request.timeoutMs}\\)`))
})

// --- instances.json ---

test('the registry example fits the shapes and reads back through the registry', () => {
  fits(instances.example, instances.file, instances.shapes, 'instances.json example')
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true })
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(instances.example, null, 2) + '\n')
  const all = Object.entries(instances.example.instances)
  const servers = all.filter(([, c]) => c.kind !== 'database').map(([n]) => n).sort()
  const dbs = all.filter(([, c]) => c.kind === 'database').map(([n]) => n).sort()
  assert.deepEqual(registry.listInstances().map((i) => i.name), servers)
  assert.deepEqual(registry.listServices().map((i) => i.name), dbs)
  assert.equal(registry.loaderOf(registry.getInstance('legacy')), 'paper', 'no loader reads as paper')
  assert.equal(registry.kindOf(registry.getInstance('old-mariadb')), 'database')
  assert.deepEqual(registry.getInstance('survival').rcon, instances.example.instances.survival.rcon)
  // every shape field has an example somewhere, so a reader is tested on each one
  for (const [shape, kind] of [['server', (c) => c.kind !== 'database'], ['database', (c) => c.kind === 'database']]) {
    const present = new Set(all.filter(([, c]) => kind(c)).flatMap(([, c]) => Object.keys(c)))
    for (const field of fieldsOf(instances.shapes[shape])) {
      if (shape === 'server' && field === 'kind') continue
      if (shape === 'database' && ['java', 'jar', 'jvmFlags', 'webhook', 'label'].includes(field)) continue
      assert.ok(present.has(field), `no ${shape} example has ${field}`)
    }
  }
})

test('a write through the registry keeps the file in the fixture\'s shape', async () => {
  const dir = path.join(scratch, 'adopt-me')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'paper-1.21.4-1.jar'), '')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25601\nrcon.port=25602\nrcon.password=hunter2\n')
  const made = await adoptInstance('adopted', dir, { java: 'java', memory: '3G' })
  const { name, ...stored } = made
  assert.equal(name, 'adopted')
  fits(stored, instances.shapes.server, instances.shapes, 'an adopted server')
  registry.updateInstance('adopted', { label: 'Adopted', autoRestart: true, jvmFlags: null, webhook: null, backupExclude: ['logs'] })
  const file = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  fits(file, instances.file, instances.shapes, 'instances.json after adopt and settings')
  assert.equal(fs.readFileSync(REGISTRY_FILE, 'utf8'), JSON.stringify(file, null, 2) + '\n', 'two-space JSON with a newline')
})

// --- schedules.json ---

test('every scheduled task example is stored exactly as the normalisers would store it', () => {
  fits(schedules.example, schedules.file, schedules.shapes, 'schedules.json example')
  const types = new Set()
  const kinds = new Set()
  const steps = new Set()
  for (const [id, task] of Object.entries(schedules.example.tasks)) {
    assert.ok(id.startsWith(`${task.instance}-${task.action.type}`), `${id} does not follow the id format`)
    assert.deepEqual(schedule.normaliseAction(task.action), task.action, `${id} action`)
    assert.deepEqual(schedule.normaliseSchedule(task.schedule), task.schedule, `${id} schedule`)
    types.add(task.action.type)
    kinds.add(task.schedule.kind)
    for (const s of task.action.steps ?? []) steps.add(s.do)
  }
  assert.deepEqual([...types].sort(), Object.keys(schedule.ACTIONS).sort(), 'every action type has an example')
  assert.deepEqual([...kinds].sort(), [...schedule.SCHEDULE_KINDS].sort(), 'every schedule kind has an example')
  assert.deepEqual([...steps].sort(), Object.keys(STEP_KINDS).sort(), 'every step kind has an example')
  fs.writeFileSync(path.join(DATA_ROOT, 'schedules.json'), JSON.stringify(schedules.example, null, 2))
  assert.deepEqual(schedule.load(), schedules.example)
  assert.equal(schedule.TASK_FOLDER, 'mcctl')
})

test('the normalisers drop what a caller invents, so nothing outside the shapes is stored', () => {
  const raw = [
    { type: 'backup', keep: '7', extra: 1 },
    { type: 'backup', keep: 0 },
    { type: 'restart', warnMinutes: 500, cmd: 'rm -rf /' },
    { type: 'command', line: '  say hi  ', shell: true },
    { type: 'verify', keep: 3 },
    { type: 'steps', steps: [{ do: 'command', line: '/save-all', x: 1 }, { do: 'wait', seconds: 1 }, { do: 'countdown' }], onlyWhenRunning: 'yes' },
  ]
  for (const r of raw) fits(schedule.normaliseAction(r), schedules.shapes.action, schedules.shapes, JSON.stringify(r))
  for (const s of [{ kind: 'daily', at: '03:00', every: 5 }, { kind: 'onlogon', at: '03:00' }, { kind: 'weekly', day: 'sun', at: '23:59' }]) {
    fits(schedule.normaliseSchedule(s), schedules.shapes.schedule, schedules.shapes, JSON.stringify(s))
  }
})
