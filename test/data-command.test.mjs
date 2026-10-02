import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-datacmd-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let n = 0
/** A data folder, and the environment that makes the CLI look nowhere else. */
function setup({ files = true } = {}) {
  const base = path.join(scratch, `c${++n}`)
  const data = path.join(base, 'mcctl')
  if (files) {
    fs.mkdirSync(path.join(data, 'instances', 'Srv'), { recursive: true })
    fs.mkdirSync(path.join(data, 'run'), { recursive: true })
    fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {} }, null, 2) + '\n')
    fs.writeFileSync(path.join(data, 'instances', 'Srv', 'server.properties'), 'motd=hello\n')
  }
  const env = {
    ...process.env,
    MCCTL_DATA_ROOT: data,
    APPDATA: path.join(base, 'config'), XDG_CONFIG_HOME: path.join(base, 'config'),
    LOCALAPPDATA: path.join(base, 'local'), XDG_DATA_HOME: path.join(base, 'share'),
    HOME: base, USERPROFILE: base,
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'spawnloft.mjs'), 'data', ...args], { env, encoding: 'utf8', timeout: 120000 })
  return { base, data, dest: path.join(base, 'moved', 'data'), run, env }
}
const isLink = (p) => fs.lstatSync(p).isSymbolicLink()

test('without --yes it only shows the plan, and changes nothing', () => {
  const s = setup()
  const run = s.run('move', s.dest)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Move the data folder/)
  assert.match(run.stdout, /how: +rename it: same drive, instant, nothing is copied/)
  assert.match(run.stdout, /A link is left at the old path/)
  assert.match(run.stdout, /Nothing was changed\. Run it again with --yes/)
  assert.equal(isLink(s.data), false)
  assert.equal(fs.existsSync(s.dest), false)
})

test('with --yes it moves the data and leaves a link that reads the same', () => {
  const s = setup()
  const run = s.run('move', s.dest, '--yes')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Moved in .*s\. The data is now at .*, and .* is a link to it\./)
  assert.equal(isLink(s.data), true)
  assert.equal(fs.readFileSync(path.join(s.data, 'instances', 'Srv', 'server.properties'), 'utf8'), 'motd=hello\n')
  assert.equal(fs.readFileSync(path.join(s.dest, 'instances', 'Srv', 'server.properties'), 'utf8'), 'motd=hello\n')
})

test('--yes before the folder is the same: the folder is not taken for the flag\'s value', () => {
  const s = setup()
  const run = s.run('move', '--yes', s.dest)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(isLink(s.data), true)
})

test('status says where the data is, before and after', () => {
  const s = setup()
  assert.match(s.run('status').stdout, /is: +an ordinary folder/)
  s.run('move', s.dest, '--yes')
  const after = s.run('status')
  assert.match(after.stdout, /is: +a link to /)
  assert.match(after.stdout, /Last move: .*finished/)
  const json = JSON.parse(s.run('status', '--json').stdout.trim().split('\n').at(-1))
  assert.equal(json.data.isLink, true)
  assert.equal(json.data.dangling, false)
})

test('a move that cannot happen says why and exits 1; nothing is changed', () => {
  const s = setup()
  fs.mkdirSync(s.dest, { recursive: true })
  fs.writeFileSync(path.join(s.dest, 'already-here.txt'), 'x')
  const run = s.run('move', s.dest, '--yes')
  assert.equal(run.status, 1)
  assert.match(run.stdout, /Cannot move yet:/)
  assert.match(run.stdout, /is not empty/)
  assert.equal(isLink(s.data), false)
  assert.deepEqual(fs.readdirSync(s.dest), ['already-here.txt'])
})

test('--json gives the plan, and the problems with the usual error', () => {
  const s = setup()
  const ok = JSON.parse(s.run('move', s.dest, '--json').stdout.trim().split('\n').at(-1))
  assert.equal(ok.ok, true)
  assert.equal(ok.data.action, 'move')
  assert.equal(ok.data.executed, false)
  assert.equal(ok.data.mode, 'rename')
  assert.equal(ok.data.files, 2)

  const run = s.run('move', s.data, '--json')
  assert.equal(run.status, 1)
  const bad = JSON.parse(run.stdout.trim().split('\n').at(-1))
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'CHECK_FAILED')
  assert.ok(bad.data.problems.length > 0)
})

test('status of a data folder that is not there says so and does not make it', () => {
  const s = setup({ files: false })
  const run = s.run('status')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /is: +missing/)
  assert.equal(fs.existsSync(s.data), false, 'ensureDirs would have made it, empty, where a link has to go')
})

test('finish without a recorded move, and rollback without one, say so', () => {
  const s = setup()
  const finish = s.run('finish', '--yes')
  assert.equal(finish.status, 1)
  assert.match(finish.stderr, /no move is recorded/)
  const rollback = s.run('rollback')
  assert.equal(rollback.status, 1)
  assert.match(rollback.stderr, /nothing to put back/)
})

test('finish after a rename only clears the record, and a finished move cannot be rolled back', () => {
  const s = setup()
  s.run('move', s.dest, '--yes')
  const dry = s.run('finish')
  assert.match(dry.stdout, /no parked original to delete/)
  const rollback = s.run('rollback')
  assert.equal(rollback.status, 1)
  assert.match(rollback.stderr, /finished, and the data has been used since/)
  const done = s.run('finish', '--yes')
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /Cleared the record of the move/)
  assert.equal(isLink(s.data), true, 'the link and the data are untouched')
})

test('an unknown subcommand, or none, is a usage error', () => {
  const s = setup()
  assert.equal(s.run().status, 2)
  assert.equal(s.run('teleport').status, 2)
  assert.equal(s.run('move').status, 2)
  assert.match(s.run('move').stderr, /Usage: spawnloft data move <folder>/)
})
