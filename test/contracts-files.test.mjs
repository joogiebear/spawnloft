/**
 * The C0 contract fixtures of rust/PLAN-CORE-PORT.md 3.4: every file the Node core and the Rust
 * core will both write, held against the Node code that writes it. Each test makes the real Node
 * call with the fixture's inputs in a scratch data root (contracts-files-observe.mjs) and compares
 * the exact text; what only runs on another platform, or needs a network or a running database, is
 * held against the source instead ("asserted": "source" in the fixture). Also: the ordering fixture
 * (localeCompare), the regular expressions the Rust regex crate cannot run, and the activity
 * actions. A failure means the code changed a contract the Rust side must follow, or the fixture is
 * out of date: see test/fixtures/contracts/README.md.
 */
// first: it points the data root and the settings folders at a scratch folder before src/ loads
import * as o from './contracts-files-observe.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check } from './fixtures/contracts/shape.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'contracts')
const load = (file) => JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'))
const { m } = o
const win = process.platform === 'win32'
const posix = !win

// On Windows a path joined below a placeholder keeps its backslashes (doubled inside JSON text);
// the fixtures are written with /.
const slashes = (text) => (win ? String(text).replace(/\\\\/g, '/').replace(/\\/g, '/') : String(text))
const sameMode = (got, want, what) => { if (posix) assert.equal(got, want, `${what}: mode`) }

after(() => fs.rmSync(o.scratch, { recursive: true, force: true }))

// --- instances.json writes ---

test('instances.json: every registry write leaves exactly the fixture\'s text', () => {
  const fx = load('instances-writes.json')
  const got = o.registryWrites()
  assert.equal(got.steps.length, fx.steps.length)
  for (const [i, step] of fx.steps.entries()) {
    assert.equal(got.steps[i].call, step.call)
    assert.equal(slashes(got.steps[i].text), step.text, step.call)
    sameMode(got.steps[i].mode, step.mode, step.call)
  }
  assert.equal(got.lockLeft, false, 'the lock is released')
  assert.equal(got.tmpLeft, false, 'no temp file is left')
  // and the text is what the reader fixture describes
  const reads = load('instances.json')
  assert.deepEqual(check(JSON.parse(fx.steps.at(-1).text), reads.file, '$', reads.shapes), [])
})


// --- settings.json and data-format.json ---

test('settings.json: a save writes the merged text, keeps keys it does not know, and refuses a damaged file', () => {
  const fx = load('settings.json').saves
  const got = o.settingsWrites()
  assert.equal(slashes(got.fresh.file), fx.fresh.file)
  assert.equal(got.fresh.text, fx.fresh.text)
  sameMode(got.fresh.mode, fx.fresh.mode, 'settings.json')
  assert.deepEqual(got.merge, fx.merge)
  assert.equal(got.merge.returned['bot.node'], '/usr/bin/node', 'a key this build does not know survives')
  assert.deepEqual(got.legacy.text, fx.legacy.text)
  assert.equal(slashes(got.legacy.file), fx.legacy.file)
  assert.equal(got.legacy.currentMade, false, 'an older install keeps its mcctl/ folder')
  assert.deepEqual(got.damaged, fx.damaged)
})

test('data-format.json: every marker reads and warns as the fixture says', () => {
  const fx = load('data-format.json')
  assert.equal(m.dataFormat.DATA_FORMAT, fx.dataFormat)
  const got = o.dataFormatReads(fx.cases)
  for (const [i, c] of fx.cases.entries()) {
    assert.deepEqual(got[i], { marker: c.marker, warns: c.warns }, `${JSON.stringify(c.text)} read by ${c.version}`)
    // a marker of the wrong type still reads (and does not warn); the shape is what a writer writes
    if (c.marker && c.warns) assert.deepEqual(check(c.marker, fx.shape), [], 'fits the shape')
  }
  // nothing in the Node source writes it
  for (const file of fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs'))) {
    const text = o.source(`src/${file}`)
    assert.ok(!/write\w*\([^)]*dataFormatFile|data-format\.json'[^\n]*write/.test(text), `${file} writes data-format.json`)
  }
})

// --- run/runtime.json ---

test('runtime.json: repairAfterMove writes and compares the record as the fixture says', () => {
  const fx = load('runtime.json')
  const got = o.runtimeWrites(fx.cases)
  assert.deepEqual(got.signature, fx.signature)
  assert.equal(m.relocate.RUNTIME_FORMAT, fx.signature.format)
  for (const [i, c] of fx.cases.entries()) {
    assert.equal(got.cases[i].moved, c.moved, c.what)
    assert.equal(got.cases[i].after, c.after, c.what)
  }
  assert.equal(path.resolve(m.paths.ROOT), m.paths.ROOT, 'root is resolved, no trailing separator')
  assert.ok(fs.existsSync(path.join(m.paths.ROOT, 'src', 'relocate.mjs')), 'root is the folder that holds src/')
})

// --- task shims, launchers, units ---

const tasks = load('task-files.json')

test('task shims: the POSIX shim is written exactly as the fixture says', () => {
  const got = o.posixShims()
  for (const form of ['entry', 'checkout']) {
    const want = tasks.shims.posix[form]
    assert.equal(slashes(got[form].file), want.file, form)
    assert.equal(got[form].text, want.text, form)
    sameMode(got[form].mode, want.mode, form)
  }
})

test('task shims: the Windows .cmd shim is the fixture\'s text (written for real on Windows)', () => {
  const schedule = o.source('src/schedule.mjs')
  for (const line of tasks.shims.windows.source) assert.ok(schedule.includes(line), `src/schedule.mjs no longer has: ${line}`)
  const got = o.windowsShims()
  assert.equal(got.entry, tasks.shims.windows.entry)
  assert.equal(got.checkout, tasks.shims.windows.checkout)
  // the % rule, which no scratch path exercises
  assert.deepEqual(m.entry.windowsRun({ exe: 'C:\\100%\\spawnloft-core.exe', args: [], env: {}, viaEntry: true }, 'task run a'), ['"C:\\100%%\\spawnloft-core.exe" task run a'])
  assert.deepEqual(m.entry.windowsRun({ exe: 'C:\\SpawnLoft\\SpawnLoft.exe', args: ['C:\\core\\mcctl.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, viaEntry: false }, 'start x'),
    ['set ELECTRON_RUN_AS_NODE=1', '"C:\\SpawnLoft\\SpawnLoft.exe" "C:\\core\\mcctl.mjs" start x'])
})

test('server launchers: .sh and .bat are written exactly as the fixture says', () => {
  const got = o.launchers()
  // the .bat bodies are a template literal, so their lines end as src/create.mjs was checked out
  const crlfCheckout = fs.readFileSync(path.join(o.CODE, 'src', 'create.mjs'), 'utf8').includes('\r\n')
  for (const [key, files] of Object.entries(tasks.launchers.files)) {
    assert.deepEqual(Object.keys(got[key]), Object.keys(files), key)
    for (const [name, want] of Object.entries(files)) {
      const text = key.startsWith('win32') && crlfCheckout ? want.text.replace(/\r?\n/g, '\r\n') : want.text
      assert.equal(got[key][name].text, text, `${key} ${name}`)
      if (want.mode) sameMode(got[key][name].mode, want.mode, `${key} ${name}`)
    }
  }
})

test('launchd plists are the fixture\'s text for every schedule kind', { skip: win && 'launchd paths are POSIX' }, () => {
  assert.deepEqual(o.plists(), tasks.launchd.plists)
  assert.deepEqual(o.unitNames(), tasks.launchd.names)
})

test('systemd units are the fixture\'s text for every schedule kind', { skip: win && 'systemd paths are POSIX' }, () => {
  assert.deepEqual(o.systemdUnits(), tasks.systemd.units)
})

test('schtasks: the trigger arguments and every command line are as the fixture says', () => {
  const triggerArgs = o.triggerArgsFromSource()
  for (const [kind, schedule] of Object.entries(o.KINDS)) assert.deepEqual(triggerArgs(schedule), tasks.schtasks.triggers[kind], kind)
  const schedule = o.source('src/schedule.mjs')
  for (const [what, call] of Object.entries(tasks.schtasks.calls)) assert.ok(schedule.includes(call.source), `${what}: src/schedule.mjs no longer has ${call.source}`)
  assert.equal(m.schedule.TASK_FOLDER, 'mcctl')
  // Node writes no Task Scheduler XML anywhere
  for (const file of fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs'))) {
    assert.ok(!/['"`]\/XML['"`]|<Task[\s>]/.test(o.source(`src/${file}`)), `${file} writes Task Scheduler XML`)
  }
})

// --- tasks.log and schedules.json writes ---

const runs = load('task-runs.json')

test('tasks.log: a run appends one line in the fixture\'s format, and the reader reads lines as the fixture says', () => {
  fs.writeFileSync(path.join(o.DATA, 'schedules.json'), JSON.stringify({ version: 1, tasks: {
    'survival-command': { instance: 'survival', name: 'Say hi', action: { type: 'command', line: 'say hi' }, schedule: { kind: 'minutes', every: 15 }, enabled: true, owner: null, createdAt: '2026-11-21T03:00:00.000Z' },
  } }, null, 2) + '\n')
  if (!m.registry.hasInstance('survival')) m.registry.putInstance('survival', o.SERVER('survival', 25565))
  const log = path.join(o.DATA, 'run', 'survival', 'tasks.log')
  fs.rmSync(log, { force: true })
  const ran = o.runTask('survival-command')
  assert.equal(ran.status, runs.tasksLog.run.status, ran.stderr)
  assert.equal(o.maskTimes(fs.readFileSync(log, 'utf8')), runs.tasksLog.run.line)
  assert.equal(o.maskTimes(ran.stdout), runs.tasksLog.run.stdout)
  assert.match(fs.readFileSync(log, 'utf8').replace(/\n$/, ''), new RegExp(runs.tasksLog.lineRegex))
  assert.ok(o.source('mcctl.mjs').includes("const line = `${new Date().toISOString()}\\t${id}\\t${status}\\t${action.type}\\t${flat}`"), 'the line is built as the fixture says')
  fs.writeFileSync(log, runs.tasksLog.reader.file)
  assert.deepEqual(m.schedule.recentRuns('survival'), runs.tasksLog.reader.rows)
})

test('schedules.json: create and update write the fixture\'s text and make the fixture\'s systemctl calls', { skip: process.platform !== 'linux' && 'needs systemd units (a stand-in systemctl on PATH)' }, () => {
  if (!m.registry.hasInstance('survival')) m.registry.putInstance('survival', o.SERVER('survival', 25565))
  const got = o.scheduleWrites()
  const want = runs.schedulesWrites
  assert.deepEqual(got.ids, want.ids)
  assert.equal(got.afterCreate, want.afterCreate)
  assert.equal(got.afterEnable, want.afterEnable)
  assert.deepEqual(got.units, want.units)
  assert.deepEqual(got.createEnabled, tasks.systemd.calls.createEnabled)
  assert.deepEqual(got.createDisabled, tasks.systemd.calls.createDisabled)
  const saved = JSON.parse(fs.readFileSync(path.join(o.DATA, 'schedules.json'), 'utf8'))
  const shapes = load('schedules.json')
  assert.deepEqual(check(saved, shapes.file, '$', shapes.shapes), [])
})

// --- backups, tar and zip ---

const backups = load('backups.json')

test('backups: names, manifest text and archive members are as the fixture says', { timeout: 60000 }, async () => {
  const inst = o.makeServer('survival')
  const got = await o.backupLayout(inst)
  const stamp = /\d{4}-\d{2}-\d{2}_\d{6}/g
  const mask = (t) => o.maskTimes(t).replace(/"size": \d+/, '"size": "<size>"')
  assert.equal(got.folder, backups.layout.observedFolder)
  assert.deepEqual(got.names.map((n) => n.replace(stamp, '<stamp>')), backups.layout.names)
  assert.deepEqual(got.files.map((n) => n.replace(stamp, '<stamp>')), backups.layout.files)
  assert.equal(slashes(mask(got.manifestText)), backups.manifest.standard)
  assert.equal(slashes(mask(got.lockedText)), backups.manifest.afterLockAndNote)
  assert.equal(got.fullLabel, backups.manifest.fullScope.label)
  // full is readdir order: byte order wherever libuv sorts (POSIX), the directory's own on Windows
  assert.deepEqual(win ? [...got.fullMembers].sort() : got.fullMembers, win ? [...backups.manifest.fullScope.members].sort() : backups.manifest.fullScope.members)
  assert.deepEqual(got.standardListing, backups.members.standardListing)
  assert.deepEqual(got.fullListing, backups.members.fullListing)
  // the manifest names its members in the order the archive was asked for
  assert.deepEqual(JSON.parse(got.manifestText).members, JSON.parse(backups.manifest.standard).members)
})

test('tar: the argument lists, EXCLUDE_ARGS and tarMember are as the fixture says, and every tar call is listed', () => {
  assert.deepEqual(m.backup.EXCLUDE_ARGS, backups.tar.EXCLUDE_ARGS)
  for (const c of backups.tar.tarMember) assert.equal(m.tar.tarMember(c.name), c.member, c.name)
  const listed = new Map()
  for (const c of backups.tar.calls) {
    assert.ok(o.source(c.file).includes(c.code), `${c.file} no longer has ${c.code}`)
    listed.set(c.file, (listed.get(c.file) ?? 0) + 1)
  }
  const found = new Map()
  for (const file of fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs') && f !== 'tar.mjs')) {
    const n = [...o.source(`src/${file}`).matchAll(/\brunTar\(\[|spawn\(tarBinary\(\)/g)].length
    if (n) found.set(`src/${file}`, n)
  }
  assert.deepEqual(Object.fromEntries([...found].sort()), Object.fromEntries([...listed].sort()), 'a tar call the fixture does not list')
  assert.ok(o.source('src/services.mjs').includes(backups.databaseDumps.source), 'the database dump manifest is written as the fixture says')
})

test('zip: entry order, names, flags and methods are as the fixture says', async () => {
  const fx = load('zip.json')
  const dir = path.join(o.scratch, 'zip-tree')
  o.makeTree(dir)
  const got = await o.zipLayout(dir, fx.members)
  const common = [...new Set(got.entries.map((e) => JSON.stringify({ madeBy: e.madeBy, needed: e.needed, flags: e.flags, local: `${e.local.needed}/${e.local.flags}` })))].map((s) => JSON.parse(s))
  assert.deepEqual(common, fx.common)
  assert.deepEqual(got.entries.map((e) => [e.name, e.method, e.dirBit, e.unixType === 0o40000 ? 'dir' : e.unixType === 0o100000 ? 'file' : e.unixType]), fx.entries)
  assert.equal(got.endTotal, fx.total)
  assert.equal(got.endComment, 0)
  for (const e of got.entries) assert.equal(e.local.method, e.method, `${e.name}: local and central agree`)
  assert.ok(o.source('src/worlds.mjs').includes("createZip(file, inst.dir, members, { exclude: EXCLUDE_ARGS.filter((arg) => arg !== '--exclude') })"))
})

// --- engines, provenance, client ---

test('engine store: folder names, and a marker counts only with Node\'s platform names', () => {
  const fx = load('engines.json')
  const got = o.engineMarkers()
  assert.equal(got.garnetDir, fx.folders.garnet)
  assert.equal(got.mariadbDir, fx.folders.mariadb)
  assert.equal(got.mysqlDir, fx.folders.mysqlOnLinuxX64)
  if (got.garnet) assert.deepEqual(got.garnet, fx.hasEngine.garnet)
  assert.ok(o.source('src/garnet.mjs').includes(fx.markers.garnet.source))
  assert.ok(o.source('src/mysql.mjs').includes(fx.markers.mysql.source))
  const writers = fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs') && o.source(`src/${f}`).includes("'spawnloft-engine.json'), JSON.stringify"))
  assert.deepEqual(writers.sort(), ['garnet.mjs', 'mysql.mjs'], 'every marker writer is in the fixture')
})

test('provenance: the plugin store is written as the fixture says, and the pack records as the source says', () => {
  const fx = load('provenance.json')
  assert.deepEqual(o.pluginStore(), fx.pluginStore.observed)
  const mrpack = o.source('src/mrpack.mjs')
  assert.equal(m.mrpack.PACK_FILE, '.mcctl-pack.json')
  // both writes of the pack record, with their keys in the fixture's order
  const writes = [...mrpack.matchAll(/writeJson\(path\.join\(inst\.dir, PACK_FILE\), \{\n([\s\S]*?)\n\s*\}\)/g)].map((w) => [...w[1].matchAll(/^\s*(\w+)[:,]/gm)].map((k) => k[1]))
  assert.equal(writes.length, 2, 'install and update')
  for (const keys of writes) assert.deepEqual(keys, fx.modpack.keyOrder)
  const fabric = o.source('src/client-fabric.mjs')
  assert.ok(fabric.includes("const recordFile = path.join(modsDir, '.spawnloft-mods.json')"))
  assert.ok(/record\.managed\[file\.filename\] = \{\n\s+source: 'modrinth',\n\s+project: 'fabric-api',\n\s+version: version\.version_number,\n\s+mc,\n\s+installedAt: new Date\(\)\.toISOString\(\),\n\s+\}/.test(fabric), 'the client mods record')
  for (const [source, keys] of Object.entries({ modrinth: fx.pluginStore.record.modrinth, hangar: fx.pluginStore.record.hangar, modpack: fx.pluginStore.record.modpack })) {
    const order = Object.keys(keys)
    const where = source === 'modpack' ? mrpack : o.source('src/plugins.mjs')
    assert.ok(new RegExp(`recordManaged\\([^{]*\\{\\s*source: '${source}',\\s*${order.slice(1).map((k) => `${k}:?[^\\n]*,?\\s*`).join('')}\\}\\)`).test(where), `${source} record keys`)
  }
})

test('client files: profiles, accounts, the store layout and servers.dat are as the fixture says', () => {
  const fx = load('client-files.json')
  const got = o.clientFiles()
  assert.deepEqual(got.layout, fx.layout.paths)
  assert.deepEqual(got.profiles, fx.profiles.observed)
  assert.equal(got.accounts.text, fx.accounts.observed.text)
  sameMode(got.accounts.mode, fx.accounts.observed.mode, 'accounts.json')
  assert.deepEqual(got.serversDat, fx.serversDat.first)
  assert.deepEqual(got.serversDatAfterRemove, fx.serversDat.afterRemovingLobby)
  // what servers.dat holds reads back as two { name, ip } entries
  const doc = m.serverList.readNbt(Buffer.from(fx.serversDat.first.hex, 'hex'))
  assert.equal(doc.root.entries.length, 1)
})

// --- activity actions ---

// every activity.record call, read across lines: file:line -> the second argument's source text
function activitySites() {
  const files = [...fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs') && f !== 'activity.mjs').map((f) => `src/${f}`), 'mcctl.mjs']
  const sites = {}
  for (const file of files) {
    const text = o.source(file)
    for (const call of text.matchAll(/activity\.record\(/g)) {
      const args = []
      let depth = 0
      let quote = null
      let current = ''
      for (let i = call.index + call[0].length; i < text.length; i++) {
        const c = text[i]
        if (quote) {
          current += c
          if (c === '\\') current += text[++i]
          else if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"' || c === '`') quote = c
        if (depth === 0 && c === ')') break
        if ('([{'.includes(c)) depth++
        if (')]}'.includes(c)) depth--
        if (depth === 0 && c === ',') {
          args.push(current.trim())
          current = ''
        } else current += c
      }
      args.push(current.trim())
      sites[`${file}:${text.slice(0, call.index).split('\n').length}`] = args[1]
    }
  }
  return sites
}

test('activity: every record call is listed with its actions, and every action is in the catalog', () => {
  const fx = load('activity.json')
  const found = activitySites()
  assert.deepEqual(Object.keys(found).sort(), Object.keys(fx.sites).sort(), 'a record call was added, moved or removed')
  for (const [site, arg] of Object.entries(found)) {
    const literal = [...arg.matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1])
    if (literal.length === 0) {
      const dynamic = fx.dynamicSites[site]
      assert.ok(dynamic, `${site} records an action held in ${arg}; list it under dynamicSites`)
      assert.equal(arg, dynamic.argument)
      const file = site.slice(0, site.lastIndexOf(':'))
      assert.ok(o.source(file).includes(dynamic.source), `${site}: ${dynamic.source}`)
      const values = [...dynamic.source.matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1]).filter((v) => v.includes('-'))
      assert.deepEqual(values.sort(), [...fx.sites[site]].sort(), site)
    } else {
      assert.deepEqual(literal, fx.sites[site], site)
    }
    for (const action of fx.sites[site]) assert.ok(fx.actions.includes(action), `${site} records "${action}", which the catalog does not list`)
  }
  const used = new Set(Object.values(fx.sites).flat())
  assert.deepEqual([...used].sort(), [...fx.actions].sort(), 'every catalogued action has a site')
})

// --- ordering ---

test('ordering: this Node sorts the fixture as it was made, in every variant the source uses', () => {
  const fx = load('ordering.json')
  const variants = { default: undefined, base: { sensitivity: 'base' }, numericBase: { numeric: true, sensitivity: 'base' } }
  assert.deepEqual(fx.variants, Object.fromEntries(Object.entries(variants).filter(([, v]) => v)))
  const cmp = (v) => (a, b) => (variants[v] ? a.localeCompare(b, undefined, variants[v]) : a.localeCompare(b))
  // a shuffle, the same on every run
  let seed = 7
  const shuffled = [...fx.orders.default].map((s) => [((seed = (seed * 16807) % 2147483647)), s]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
  assert.deepEqual([...shuffled].sort(cmp('default')), fx.orders.default, 'ICU or the machine locale moved a character')
  for (const v of ['base', 'numericBase']) assert.deepEqual([...fx.orders.default].sort(cmp(v)), fx.orders[v], v)
  const pairs = load('ordering-pairs.json').pairs
  for (const [v, rows] of Object.entries(pairs)) {
    for (const [a, b, sign] of rows) assert.equal(Math.sign(cmp(v)(a, b)), sign, `${v}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
})

test('ordering: every localeCompare in the source is a listed site with a listed variant', () => {
  const fx = load('ordering.json')
  const calls = []
  for (const file of [...fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`), 'mcctl.mjs']) {
    for (const line of o.source(file).split('\n')) {
      for (const call of line.matchAll(/localeCompare\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
        const options = call[1].includes('{') ? call[1].slice(call[1].indexOf('{')) : null
        const variant = options === null ? 'default' : options === "{ numeric: true, sensitivity: 'base' }" ? 'numericBase' : options === "{ sensitivity: 'base' }" ? 'base' : `unknown: ${options}`
        calls.push({ file, variant })
      }
    }
  }
  assert.equal(calls.length, 11, `found ${calls.length} localeCompare calls; list a new one in ordering.json sites`)
  for (const c of calls) {
    assert.ok(fx.sites.some((s) => s.site.startsWith(c.file) && s.variant === c.variant), `${c.file} sorts with ${c.variant}, which ordering.json does not list`)
  }
  for (const s of fx.sites) assert.ok(calls.some((c) => s.site.startsWith(c.file)), `${s.site} no longer sorts`)
})

// --- regular expressions ---

test('regex: the lookaround and backreference lines, and every new RegExp, are exactly the fixture\'s', () => {
  const fx = load('regex.json')
  const files = [...fs.readdirSync(path.join(o.CODE, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`), 'mcctl.mjs']
  const lines = Object.fromEntries(files.map((f) => [f, o.source(f).split('\n')]))
  const at = (file, line) => lines[file][line - 1] ?? ''
  const found = []
  const made = []
  for (const file of files) {
    lines[file].forEach((text, i) => {
      if (/\(\?(?:=|!|<=|<!)|\\[1-9]|\\k</.test(text)) found.push(`${file}:${i + 1}`)
      if (/new RegExp\(/.test(text)) made.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(found, fx.unsupported.map((u) => `${u.file}:${u.line}`), 'a line using lookaround or a backreference was added or moved')
  assert.equal(found.length, 7)
  for (const u of fx.unsupported) {
    assert.ok(at(u.file, u.line).includes(u.pattern), `${u.file}:${u.line} no longer reads ${u.pattern}`)
    const kinds = []
    if (/\(\?[=!]/.test(u.pattern)) kinds.push('lookahead')
    if (/\(\?<[=!]/.test(u.pattern)) kinds.push('lookbehind')
    if (/\\[1-9]|\\k</.test(u.pattern)) kinds.push('backreference')
    assert.deepEqual([...kinds].sort(), [...u.uses].sort(), `${u.file}:${u.line} uses`)
  }
  const listedMade = [
    ...fx.runtime.sites.map((s) => [s, s.code]),
    ...fx.constructed.sites.map((s) => [s, s.code]),
    ...fx.unsupported.filter((u) => u.pattern.startsWith('new RegExp(')).map((u) => [u, u.pattern]),
  ]
  for (const [s, code] of listedMade) assert.ok(at(s.file, s.line).includes(code), `${s.file}:${s.line} no longer reads ${code}`)
  assert.deepEqual(made.sort(), listedMade.map(([s]) => `${s.file}:${s.line}`).sort(), 'a new RegExp site the fixture does not list')
})

// the bot host matches scenario patterns itself; it stays JavaScript (PLAN-CORE-PORT.md 5.4)
test('regex: the bot host is where scenario patterns are matched', () => {
  assert.ok(fs.readFileSync(path.join(o.CODE, 'src', 'bot-host.cjs'), 'utf8').includes('new RegExp(m[1], m[2])'))
})

// tar itself is only checked to exist: the backup test above needs it
test('tar is on this machine', () => {
  const res = spawnSync(m.tar.tarBinary(), ['--version'], { encoding: 'utf8', windowsHide: true })
  assert.equal(res.status, 0)
})
