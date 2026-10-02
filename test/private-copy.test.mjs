import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-private-copy-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { findPrivateCopies, describePrivateCopies, mcpNotice } = await import('../src/private-copy.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// What Windows does for a program installed as a package: what it writes under AppData\Local goes to
// Packages\<family>\LocalCache\Local\<the same path>, and it reads that copy from then on. These
// tests build that layout in a scratch folder and pass its places in, so they run on every platform.

const PACKAGE = 'Acme.Client_8wekyb3d8bbwe'
const registry = (servers) => JSON.stringify({ version: 1, instances: servers }, null, 2)
const server = (memory) => ({ dir: '/srv/x', jar: 'paper.jar', memory, port: 25565 })

let n = 0
/**
 * A machine: the data root, and for each package the private copy of it, as files by relative path.
 * `real` and `copies` are under Local\mcctl; `realRoaming` and `copiesRoaming` under Roaming\mcctl.
 */
function machine({ real = {}, copies = {}, realRoaming = {}, copiesRoaming = {}, dataRootOutside = false } = {}) {
  const base = path.join(scratch, `m${++n}`)
  const local = path.join(base, 'local')
  const roaming = path.join(base, 'roaming')
  const data = dataRootOutside ? path.join(base, 'elsewhere', 'data') : path.join(local, 'mcctl')
  const write = (dir, files) => {
    fs.mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
    }
  }
  write(data, real)
  write(path.join(roaming, 'mcctl'), realRoaming)
  for (const [pkg, files] of Object.entries(copies)) write(path.join(local, 'Packages', pkg, 'LocalCache', 'Local', 'mcctl'), files)
  for (const [pkg, files] of Object.entries(copiesRoaming)) write(path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', 'mcctl'), files)
  fs.mkdirSync(path.join(local, 'Packages'), { recursive: true })
  const options = { platform: 'win32', localAppData: local, roamingAppData: roaming, dataRoot: data,
    backupsDir: path.join(data, 'backups'), settingsFile: path.join(roaming, 'mcctl', 'settings.json') }
  return { local, roaming, data, options }
}

const privateData = (m, pkg = PACKAGE) => path.join(m.local, 'Packages', pkg, 'LocalCache', 'Local', 'mcctl')
const describe = (copies, m) => describePrivateCopies(copies, { backupsDir: m.options.backupsDir })

// ---- finding the copy --------------------------------------------------------------------------

test('nothing is reported where Windows does not redirect, or where nothing the data lives in is under AppData', async () => {
  const m = machine({ real: { 'instances.json': registry({ a: server('4G') }) }, copies: { [PACKAGE]: { 'instances.json': registry({}) } } })
  assert.equal((await findPrivateCopies(m.options)).length, 1, 'the fixture does hold a copy')
  assert.deepEqual(await findPrivateCopies({ ...m.options, platform: 'linux' }), [])
  assert.deepEqual(await findPrivateCopies({ ...m.options, platform: 'darwin' }), [])
  const away = path.join(scratch, 'away')
  assert.deepEqual(await findPrivateCopies({ ...m.options, dataRoot: path.join(away, 'data'), backupsDir: path.join(away, 'backups'), settingsFile: path.join(away, 'settings.json') }), [],
    'data, backups and settings all outside AppData are never redirected')
  fs.rmSync(path.join(m.local, 'Packages'), { recursive: true })
  assert.deepEqual(await findPrivateCopies(m.options), [], 'no Packages folder: nothing is installed as a package')
})

test('a trailing separator on the AppData folder makes no difference', async () => {
  const m = machine({ copies: { [PACKAGE]: { 'activity.jsonl': '{}\n' } } })
  const [copy] = await findPrivateCopies({ ...m.options, localAppData: m.local + path.sep })
  assert.equal(copy.package, PACKAGE)
})

test('a package that has written nothing under the data root has no copy to report', async () => {
  const m = machine({ real: { 'instances.json': registry({ a: server('4G') }) } })
  fs.mkdirSync(path.join(m.local, 'Packages', PACKAGE, 'LocalCache', 'Local', 'something-else'), { recursive: true })
  assert.deepEqual(await findPrivateCopies(m.options), [])
})

test('a registry that differs says which servers are on one side only and which are set up differently', async () => {
  const m = machine({
    real: { 'instances.json': registry({ kept: server('4G'), moved: server('4G'), same: server('2G') }) },
    copies: { [PACKAGE]: { 'instances.json': registry({ kept: server('8G'), same: server('2G'), old: server('1G') }) } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.package, PACKAGE)
  assert.equal(copy.dir, privateData(m))
  assert.equal(copy.registry.state, 'differs')
  assert.deepEqual(copy.registry.onlyInRegistry, ['moved'])
  assert.deepEqual(copy.registry.onlyInCopy, ['old'])
  assert.deepEqual(copy.registry.changed, ['kept'])
})

test('the same values written another way are the same: key order and spacing are not a difference', async () => {
  // Two programs that write the same settings do not write the keys in the same order, and a
  // comparison of bytes calls that a disagreement. On one real machine it was the only difference.
  const m = machine({
    real: { 'instances.json': registry({ a: { dir: '/srv/a', jar: 'p.jar', memory: '4G', port: 1 } }) },
    realRoaming: { 'settings.json': '{\n  "dataRoot": "C:\\\\A",\n  "theme": "classic"\n}\n' },
    copies: { [PACKAGE]: { 'instances.json': '{"instances":{"a":{"port":1,"memory":"4G","jar":"p.jar","dir":"/srv/a"}},"version":1}' } },
    copiesRoaming: { [PACKAGE]: { 'settings.json': '{"theme":"classic","dataRoot":"C:\\\\A"}' } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.registry.state, 'same')
  assert.equal(copy.settings, 'same')
  assert.deepEqual(describe([copy], m).problems, [])
})

test('server names that are also names on Object.prototype are compared as the servers they are', async () => {
  const m = machine({
    real: { 'instances.json': registry({ constructor: server('4G'), toString: server('4G'), plain: server('4G') }) },
    copies: { [PACKAGE]: { 'instances.json': registry({ plain: server('4G') }) } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.deepEqual(copy.registry.onlyInRegistry, ['constructor', 'toString'])
  assert.deepEqual(copy.registry.changed, [])
})

test('a registry document that is not the shape expected does not make the check fail', async () => {
  const m = machine({
    real: { 'instances.json': '{"instances":5}' },
    copies: { [PACKAGE]: { 'instances.json': '{"instances":"nope","version":2}' } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.registry.state, 'differs')
  assert.deepEqual([copy.registry.onlyInCopy, copy.registry.onlyInRegistry, copy.registry.changed], [[], [], []])
  assert.match(describe([copy], m).problems[0], /differ outside the list of servers/, 'a disagreement is never reported with nothing in the brackets')
})

test('a registry that cannot be read is blamed on the file that cannot be read', async () => {
  const bad = machine({ real: { 'instances.json': registry({ a: server('4G') }) }, copies: { [PACKAGE]: { 'instances.json': '{ not json' } } })
  const [copyBad] = await findPrivateCopies(bad.options)
  assert.equal(copyBad.registry.state, 'unreadable')
  assert.match(describe([copyBad], bad).problems[0], /Rename it/)

  const brokenHere = machine({ real: { 'instances.json': '{ not json' }, copies: { [PACKAGE]: { 'instances.json': registry({ a: server('4G') }) } } })
  const [copyGood] = await findPrivateCopies(brokenHere.options)
  assert.equal(copyGood.registry.state, 'registry-unreadable')
  const [said] = describe([copyGood], brokenHere).problems
  assert.doesNotMatch(said, /rename/i, 'the good copy is not to be moved aside because the other file is broken')
  assert.match(said, /Mend that one first/)
})

test('a copy of servers the real registry lacks says that renaming it would drop them', async () => {
  const lacks = machine({
    real: { 'instances.json': registry({ kept: server('4G') }) },
    copies: { [PACKAGE]: { 'instances.json': registry({ kept: server('4G'), fresh: server('4G') }) } },
  })
  const [copy] = await findPrivateCopies(lacks.options)
  const [said] = describe([copy], lacks).problems
  assert.match(said, /would drop "fresh"/)
  assert.match(said, /copy their entries across first/)

  const noRegistry = machine({ copies: { [PACKAGE]: { 'instances.json': registry({ only: server('4G') }) } } })
  const [orphan] = await findPrivateCopies(noRegistry.options)
  assert.equal(orphan.registry.realMissing, true)
  assert.match(describe([orphan], noRegistry).problems[0], /drop every server in it/)
})

test('backups only in the copy are counted by archive, and ones the real folder also has are not', async () => {
  const m = machine({
    real: { 'backups/Srv/old.tar.gz': 'x'.repeat(10), 'backups/Srv/old.json': '{}' },
    copies: { [PACKAGE]: {
      'backups/Srv/old.tar.gz': 'x'.repeat(10), 'backups/Srv/old.json': '{}',
      'backups/Srv/a.tar.gz': 'x'.repeat(100), 'backups/Srv/a.json': '{}',
      'backups/Other/b.tar.gz': 'x'.repeat(200), 'backups/Other/b.json': '{}',
    } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.backups.archives, 2)
  assert.equal(copy.backups.bytes, 300)
})

test('the copy\'s own activity log is counted by entry', async () => {
  const m = machine({ copies: { [PACKAGE]: { 'activity.jsonl': '{"a":1}\n{"a":2}\n\n{"a":3}\n' } } })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.activity.entries, 3)
})

test('files of servers\' folders in the copy are counted, up to a limit that says "some"', async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`instances/Srv/plugins/p${i}.yml`, 'x']))
  const m = machine({ copies: { [PACKAGE]: files } })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.instances.files, 50)
  assert.match(describe([copy], m).problems[0], /50 or more files from servers' folders/)
  assert.match(describe([copy], m).problems[0], /Renaming the registry does not undo that/)
})

test('settings that differ are reported with a way out, since they decide where the data root is', async () => {
  const m = machine({
    realRoaming: { 'settings.json': '{"dataRoot":"C:\\\\A"}' },
    copies: { [PACKAGE]: { 'activity.jsonl': '{"a":1}\n' } },
    copiesRoaming: { [PACKAGE]: { 'settings.json': '{"dataRoot":"C:\\\\B"}' } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.settings, 'differs')
  const [said] = describe([copy], m).problems
  assert.ok(said.includes(copy.settingsFile))
  assert.match(said, /Rename .*settings\.json/)
})

test('a package that holds only a copy of the settings is still found, and so is one when the data root is elsewhere', async () => {
  const m = machine({
    dataRootOutside: true,
    realRoaming: { 'settings.json': '{"dataRoot":"D:\\\\data"}' },
    copiesRoaming: { [PACKAGE]: { 'settings.json': '{"dataRoot":"C:\\\\old"}' } },
  })
  const [copy] = await findPrivateCopies(m.options)
  assert.equal(copy.package, PACKAGE)
  assert.equal(copy.dir, null, 'no copy of the data root: it is not under AppData')
  assert.equal(copy.settings, 'differs')
  assert.equal(describe([copy], m).problems.length, 1)
})

test('backups under AppData are found when the data root is not', async () => {
  const m = machine({ dataRootOutside: true, copies: {} })
  const backups = path.join(m.local, 'my-backups')
  const copyBackups = path.join(m.local, 'Packages', PACKAGE, 'LocalCache', 'Local', 'my-backups', 'Srv')
  fs.mkdirSync(copyBackups, { recursive: true })
  fs.writeFileSync(path.join(copyBackups, 'a.tar.gz'), 'x'.repeat(42))
  const [copy] = await findPrivateCopies({ ...m.options, backupsDir: backups })
  assert.equal(copy.backups.archives, 1)
  assert.equal(copy.backups.bytes, 42)
})

test('every package that holds a copy is reported, in name order', async () => {
  const m = machine({ copies: { 'Zed.App_1': { 'activity.jsonl': '{}\n' }, 'Acme.Client_8wekyb3d8bbwe': { 'activity.jsonl': '{}\n' } } })
  assert.deepEqual((await findPrivateCopies(m.options)).map((c) => c.package), ['Acme.Client_8wekyb3d8bbwe', 'Zed.App_1'])
})

test('a Packages folder with a file in it, or an unusable path, is not a reason to fail', async () => {
  const m = machine({ copies: { [PACKAGE]: { 'activity.jsonl': '{}\n' } } })
  fs.writeFileSync(path.join(m.local, 'Packages', 'not-a-folder.txt'), 'x')
  assert.equal((await findPrivateCopies(m.options)).length, 1)
  assert.deepEqual(await findPrivateCopies({ ...m.options, dataRoot: 42 }), [])
})

// ---- what is said about it ---------------------------------------------------------------------

test('a registry that differs is a problem that names the copy, the two sides, and what to rename', async () => {
  const m = machine({
    real: { 'instances.json': registry({ moved: server('4G'), kept: server('4G') }) },
    copies: { [PACKAGE]: { 'instances.json': registry({ kept: server('8G') }) } },
  })
  const { problems, notes } = describe(await findPrivateCopies(m.options), m)
  assert.equal(problems.length, 1)
  assert.equal(notes.length, 0)
  const [text] = problems
  assert.ok(text.includes(PACKAGE) && text.includes('moved') && text.includes('kept'))
  assert.match(text, /private copy of what it writes under AppData/)
  assert.ok(text.includes(path.join(privateData(m), 'instances.json')), 'the file to rename, in full')
  assert.match(text, /rename .*instances\.json/i)
  assert.match(text, /can come back/)
  assert.doesNotMatch(text, /drop/, 'nothing is lost by renaming this one, so nothing is said about losing it')
})

test('a copy that matches and holds nothing else is a note, not a problem', async () => {
  const text = registry({ a: server('4G') })
  const m = machine({ real: { 'instances.json': text }, copies: { [PACKAGE]: { 'instances.json': text } } })
  const { problems, notes } = describe(await findPrivateCopies(m.options), m)
  assert.deepEqual(problems, [])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /matches/)
})

test('a copy that holds no registry is a note that says so, and does not claim the registry matches', async () => {
  const m = machine({ real: { 'instances.json': registry({ a: server('4G') }) }, copies: { [PACKAGE]: { 'activity.jsonl': '{"a":1}\n{"a":2}\n' } } })
  const { problems, notes } = describe(await findPrivateCopies(m.options), m)
  assert.deepEqual(problems, [])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /holds no copy of the registry/)
  assert.doesNotMatch(notes[0], /matches/)
  assert.match(notes[0], /which the panel does not read, holds 2 entries/)
})

test('backups held only in the copy are a problem that says where to copy them, folder by folder', async () => {
  const m = machine({ copies: { [PACKAGE]: { 'backups/Srv/a.tar.gz': 'x'.repeat(2048), 'backups/Srv/a.json': '{}' } } })
  const { problems } = describe(await findPrivateCopies(m.options), m)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /1 backup \(2\.0 KB\)/)
  assert.match(problems[0], /Backups tab/)
  assert.match(problems[0], /\.tar\.gz and \.json files of each server's folder/)
  assert.ok(problems[0].includes(m.options.backupsDir), 'the folder to copy them into')
  assert.match(problems[0], /may go if/)
})

test('nothing found says nothing', () => {
  assert.deepEqual(describePrivateCopies([], { backupsDir: '/x' }), { problems: [], notes: [] })
  assert.equal(mcpNotice([]), '')
})

// ---- telling an AI client ---------------------------------------------------------------------

test('the notice sends a client that may itself be redirected to a program that is not', async () => {
  const text = registry({ a: server('4G') })
  const m = machine({ real: { 'instances.json': text }, copies: { [PACKAGE]: { 'instances.json': text } } })
  const notice = mcpNotice(await findPrivateCopies(m.options))
  assert.ok(notice.includes(privateData(m)))
  assert.match(notice, /this process may be reading it/)
  assert.match(notice, /doctor.* from a terminal outside this assistant/)
  assert.match(notice, /out of date/)
})

test('the notice is for a copy that matters: not one with only an activity log, nor one whose registry has been renamed away', async () => {
  const quiet = machine({ copies: { [PACKAGE]: { 'activity.jsonl': '{}\n', 'instances.json.stale-2026-10-01': registry({}) } } })
  assert.equal(mcpNotice(await findPrivateCopies(quiet.options)), '', 'what is left once the way out has been followed')
  const stranded = machine({ copies: { [PACKAGE]: { 'backups/Srv/a.tar.gz': 'x' } } })
  assert.match(mcpNotice(await findPrivateCopies(stranded.options)), /NOTE/)
  const files = machine({ copies: { [PACKAGE]: { 'instances/Srv/server.properties': 'x' } } })
  assert.match(mcpNotice(await findPrivateCopies(files.options)), /NOTE/)
})

// ---- the real programs, on the platform where it applies ---------------------------------------

const onWindows = { skip: process.platform !== 'win32' && 'Windows only: the redirection is a Windows feature' }

function windowsEnv({ copyRegistry }) {
  const base = path.join(scratch, `real-${++n}`)
  const local = path.join(base, 'local')
  const data = path.join(local, 'mcctl')
  const priv = path.join(local, 'Packages', PACKAGE, 'LocalCache', 'Local', 'mcctl')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(priv, { recursive: true })
  fs.writeFileSync(path.join(data, 'instances.json'), registry({ here: server('4G') }))
  fs.writeFileSync(path.join(priv, 'instances.json'), copyRegistry)
  return { priv, env: { ...process.env, MCCTL_DATA_ROOT: data, LOCALAPPDATA: local, APPDATA: path.join(base, 'roaming'),
    XDG_CONFIG_HOME: path.join(base, 'config'), HOME: base, USERPROFILE: base } }
}

/** Run the MCP server, send it these messages, and return its replies by id. */
function mcp(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'spawnloft.mjs'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')) }, 60000)
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(new Map(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id !== undefined).map((m) => [m.id, m])))
    })
    for (const m of messages) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    child.stdin.end()
  })
}
const initialize = { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }

test('spawnloft doctor reports a private copy that disagrees', onWindows, () => {
  const { env, priv } = windowsEnv({ copyRegistry: registry({ there: server('8G') }) })
  const run = spawnSync(process.execPath, [path.join(root, 'spawnloft.mjs'), 'doctor', '--json'], { env, encoding: 'utf8', timeout: 60000 })
  const reply = JSON.parse(run.stdout.trim().split('\n').at(-1))
  const found = reply.data.problems.filter((p) => p.includes(PACKAGE))
  assert.equal(found.length, 1, run.stdout)
  assert.ok(found[0].includes(path.join(priv, 'instances.json')))
  assert.equal(reply.data.privateCopies, undefined, 'the CLI\'s documented JSON keeps the fields it always had')
})

test('the MCP server tells the client about a copy when it starts', onWindows, async () => {
  const { env } = windowsEnv({ copyRegistry: registry({ there: server('8G') }) })
  const replies = await mcp(env, [initialize])
  const instructions = replies.get(1).result.instructions
  assert.match(instructions, /Start with list_servers/, 'the usual instructions are still there')
  assert.match(instructions, /second copy of SpawnLoft's data/)
})

test('the MCP doctor tool does not say "no problems" and stop there when the client may be the redirected one', onWindows, async () => {
  // The copy matches what this process reads - which is what a redirected process sees - so doctor's own
  // comparison finds nothing wrong; the notice is all that tells the client otherwise.
  const { env } = windowsEnv({ copyRegistry: registry({ here: server('4G') }) })
  const replies = await mcp(env, [initialize, { method: 'notifications/initialized' },
    { id: 2, method: 'tools/call', params: { name: 'doctor', arguments: {} } }])
  const text = replies.get(2).result.content.map((c) => c.text).join('\n')
  assert.match(text, /from a terminal outside this assistant/)
})
