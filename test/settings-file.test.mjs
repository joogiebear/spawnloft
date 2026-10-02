import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-settings-'))
// Where settings.json lives is read from the environment at call time, so each test points it at a
// folder of its own.
const config = (name) => {
  const dir = path.join(scratch, name)
  process.env.APPDATA = dir
  process.env.XDG_CONFIG_HOME = dir
  return path.join(dir, 'mcctl', 'settings.json')
}
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
config('init')
const settings = await import('../src/settings.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** Run `fn` and return what was written to stderr while it ran. */
function stderrOf(fn) {
  const real = process.stderr.write
  let said = ''
  process.stderr.write = (chunk) => { said += chunk; return true }
  try {
    fn()
  } finally {
    process.stderr.write = real
  }
  return said
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('no settings file is the ordinary state of a fresh install, and says nothing', () => {
  config('fresh')
  let loaded
  const said = stderrOf(() => { loaded = settings.load() })
  assert.deepEqual(loaded, {})
  assert.equal(said, '')
  assert.deepEqual(settings.inspect(), { ok: true, exists: false })
})

test('a file that cannot be parsed loads as the defaults, and says so once, naming the file and the way out', () => {
  const file = config('corrupt')
  write(file, '{ "dataRoot": "D:\\\\servers", ')
  let first
  const said = stderrOf(() => {
    first = settings.load()
    settings.load()
    settings.load()
  })
  assert.deepEqual(first, {})
  assert.equal(said.split('\n').filter(Boolean).length, 1, 'once per process, not once per read')
  assert.ok(said.includes(file))
  assert.match(said, /using the defaults/)
  assert.match(said, /fix it or delete it/)
})

test('JSON that is not an object is treated the same way', () => {
  for (const [i, text] of ['[]', '"x"', 'null', '42'].entries()) {
    const file = config(`not-object-${i}`)
    write(file, text)
    let loaded
    const said = stderrOf(() => { loaded = settings.load() })
    assert.deepEqual(loaded, {}, text)
    assert.match(said, /not a JSON object/, text)
  }
})

test('inspect reports an unreadable file as a problem, for doctor', () => {
  const file = config('inspect')
  write(file, 'nope')
  const found = settings.inspect()
  assert.equal(found.ok, false)
  assert.equal(found.file, file)
  assert.match(found.error, /JSON/i)
  write(file, '{"theme":"classic"}')
  assert.deepEqual(settings.inspect(), { ok: true, exists: true })
})

test('save merges into what is there and leaves no temporary file behind', () => {
  const file = config('merge')
  write(file, '{"dataRoot":"D:\\\\servers","theme":"classic"}')
  const merged = settings.save({ theme: 'dark' })
  assert.deepEqual(merged, { dataRoot: 'D:\\servers', theme: 'dark' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), merged)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('save creates the folder when there is none', () => {
  const file = config('fresh-save')
  settings.save({ dataRoot: 'E:\\x' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataRoot: 'E:\\x' })
})

test('save will not overwrite a file it cannot read: that would erase the data folder it names', () => {
  const file = config('refuse')
  const damaged = '{"dataRoot":"D:\\\\servers","theme":'
  write(file, damaged)
  assert.throws(() => settings.save({ theme: 'dark' }), (err) => {
    assert.ok(err.message.includes(file))
    assert.match(err.message, /fix it or delete it/)
    return true
  })
  assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'untouched')
})

test('choosing a data folder on purpose may replace an unreadable file, after setting it aside', () => {
  const file = config('replace')
  const damaged = '{"dataRoot":"D:\\\\servers","theme":'
  write(file, damaged)
  const merged = settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true })
  assert.deepEqual(merged, { dataRoot: 'E:\\new' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataRoot: 'E:\\new' })
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('settings.json.unreadable-'))
  assert.equal(aside.length, 1, 'the old file is kept, not deleted')
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), damaged)
})

test('an empty file, which is what an interrupted write used to leave, is the same case', () => {
  const file = config('empty')
  write(file, '')
  assert.throws(() => settings.save({ theme: 'dark' }), /could not be read/)
  settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataRoot: 'E:\\new' })
})

test('replacing is for a readable file too: nothing is set aside when there is nothing wrong', () => {
  const file = config('replace-fine')
  write(file, '{"theme":"classic"}')
  settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'classic', dataRoot: 'E:\\new' })
})

test('nothing is moved until the replacement is safely written: a failure leaves the damaged file where it was, and no copy', (t) => {
  const file = config('replace-fails')
  const damaged = '{"dataRoot":"D:\\\\servers","theme":'
  write(file, damaged)
  const dir = path.dirname(file)

  // The disk fills while the new file is being flushed.
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) })
  assert.throws(() => settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true }), /ENOSPC.*left as it was/)
  t.mock.restoreAll()
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
  assert.equal(fs.readFileSync(file, 'utf8'), damaged)

  // The final rename, of the new file into place, is refused and keeps being refused. Only that one:
  // anything else that renames - setting the damaged file aside, say - is let through, so that a
  // version which moves the damaged file before the new one is in place is caught having done it.
  const real = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.tmp')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return real(from, to)
  })
  assert.throws(() => settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true }), /EPERM/)
  t.mock.restoreAll()
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no copy of the damaged file is left behind, and no temporary file')
  assert.equal(fs.readFileSync(file, 'utf8'), damaged)
  assert.equal(settings.inspect().ok, false, 'so the warning is still on: this is not mistaken for a fresh install')
})

test('a rename that is refused for a moment, as a scanner holds the new file, is tried again', (t) => {
  const file = config('retry')
  write(file, '{"theme":"classic"}')
  const real = fs.renameSync
  let refused = 0
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (refused++ < 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(from, to)
  })
  settings.save({ theme: 'dark' })
  t.mock.restoreAll()
  assert.equal(refused, 3)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('a file set aside is reported to whoever asked, with where it was kept', () => {
  const file = config('reported')
  const damaged = '{"dataRoot":'
  write(file, damaged)
  const told = []
  settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true, onSetAside: (kept) => told.push(kept) })
  assert.equal(told.length, 1)
  assert.equal(fs.readFileSync(told[0], 'utf8'), damaged)
  assert.equal(path.dirname(told[0]), path.dirname(file))
})

test('only damage to the content is set aside: a file that cannot be read at all is not moved on a guess', () => {
  const file = config('directory')
  fs.mkdirSync(file, { recursive: true }) // a folder where the file should be
  assert.equal(settings.inspect().ok, false)
  assert.throws(() => settings.save({ dataRoot: 'E:\\new' }, { replaceUnreadable: true }), /could not be read/)
  assert.ok(fs.statSync(file).isDirectory(), 'still there, still a folder')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('a byte-order mark, which some Windows editors add, is not damage', () => {
  const file = config('bom')
  write(file, '\uFEFF{"theme":"classic","dataRoot":"D:\\\\servers"}')
  let loaded
  const said = stderrOf(() => { loaded = settings.load() })
  assert.deepEqual(loaded, { theme: 'classic', dataRoot: 'D:\\servers' })
  assert.equal(said, '')
  assert.equal(settings.inspect().ok, true)
  assert.deepEqual(settings.save({ theme: 'dark' }), { theme: 'dark', dataRoot: 'D:\\servers' })
})

test('the warning comes back when a mended file breaks again, even the same way', () => {
  const file = config('again')
  write(file, '{ cut')
  assert.match(stderrOf(() => settings.load()), /could not be read/)
  assert.equal(stderrOf(() => settings.load()), '', 'not repeated while it stays the same')
  write(file, '{"theme":"classic"}')
  assert.equal(stderrOf(() => settings.load()), '')
  write(file, '{ cut')
  assert.match(stderrOf(() => settings.load()), /could not be read/, 'a long-lived process says it again')
})

test('a settings file that is a link is changed where the link points, and stays a link', { skip: process.platform === 'win32' && 'links to files need elevation on Windows' }, () => {
  const file = config('link')
  const real = path.join(scratch, 'dotfiles', 'settings.json')
  write(real, '{"theme":"classic"}')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.symlinkSync(real, file)
  settings.save({ theme: 'dark' })
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'still a link')
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { theme: 'dark' })
})

// ---- the command line ---------------------------------------------------------------------------

/** Run the CLI with every place it looks redirected into the scratch folder, so the real machine is never read. */
function cli(args, name) {
  const home = path.join(scratch, `home-${name}`)
  const configDir = path.join(scratch, name)
  return spawnSync(process.execPath, [path.join(root, 'spawnloft.mjs'), ...args], {
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir, LOCALAPPDATA: path.join(home, 'local'),
      XDG_DATA_HOME: path.join(home, 'share'), HOME: home, USERPROFILE: home, MCCTL_DATA_ROOT: path.join(scratch, 'data') },
    encoding: 'utf8', timeout: 60000,
  })
}

test('config set-root replaces a damaged settings file and says where it kept it', () => {
  const file = config('cli-root')
  write(file, '{"dataRoot":"D:\\\\servers",')
  const target = path.join(scratch, 'new-root')
  const run = cli(['config', 'set-root', target], 'cli-root')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /could not be read, so it was kept as .*settings\.json\.unreadable-/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataRoot: target })
})

test('config set-instances refuses a damaged settings file: it does not name the data folder, and would drop it', () => {
  const file = config('cli-instances')
  const damaged = '{"dataRoot":"D:\\\\servers",'
  write(file, damaged)
  const run = cli(['config', 'set-instances', path.join(scratch, 'servers-here')], 'cli-instances')
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /could not be read \(.*\), so it was not changed; fix it or delete it/)
  assert.equal(fs.readFileSync(file, 'utf8'), damaged)
})

test('a write that fails halfway leaves the old file whole and no temporary file', (t) => {
  const file = config('halfway')
  write(file, '{"dataRoot":"D:\\\\servers"}')
  const before = fs.readFileSync(file, 'utf8')
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) })
  assert.throws(() => settings.save({ theme: 'dark' }), /EBUSY/)
  t.mock.restoreAll()
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('doctor names a settings file that cannot be read, and what that means', () => {
  const file = config('doctor')
  write(file, '{ cut off')
  const run = cli(['doctor', '--json'], 'doctor')
  const reply = JSON.parse(run.stdout.trim().split('\n').at(-1))
  const mine = reply.data.problems.filter((p) => p.includes(file))
  assert.equal(mine.length, 1, run.stdout)
  assert.match(mine[0], /using the defaults/)
  assert.match(mine[0], /not be the data folder you chose/)
})
