import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseArgs, BOOLEAN_FLAGS } from '../src/args.mjs'
import { keepCount, UsageError } from '../src/cli-output.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cli-flags-'))
const data = path.join(scratch, 'data')
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }
Object.assign(process.env, { MCCTL_DATA_ROOT: env.MCCTL_DATA_ROOT, APPDATA: env.APPDATA, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME })
const backup = await import('../src/backup.mjs')
const { BACKUPS_DIR } = await import('../src/paths.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const dir = path.join(data, 'instances', 'srv')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'server.jar'), 'fixture')
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {
  srv: { dir, jar: 'server.jar', memory: '1G', port: 45701, rcon: { port: 45702, password: 'x' } },
} }))

function cli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(root, 'mcctl.mjs'), ...args],
      { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error
    return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}

function seedSnapshots(count, extra = {}) {
  const snapDir = path.join(BACKUPS_DIR, 'srv')
  fs.rmSync(snapDir, { recursive: true, force: true })
  fs.mkdirSync(snapDir, { recursive: true })
  const now = Date.now() / 1000
  for (let i = 0; i < count; i++) {
    const file = path.join(snapDir, `snap-${i}.tar.gz`)
    fs.writeFileSync(file, 'fixture')
    fs.writeFileSync(file.replace(/\.tar\.gz$/, '.json'), JSON.stringify({ label: 'manual', ...extra }))
    fs.utimesSync(file, now - (count - i) * 60, now - (count - i) * 60)
  }
}
const snapshots = () => backup.listSnapshots('srv').map((s) => s.name)

test('declared boolean flags leave the next positional alone', () => {
  assert.deepEqual(parseArgs(['restore', 'srv', '--yes', 'snap-1'], { booleanFlags: BOOLEAN_FLAGS }),
    { flags: { yes: true }, positional: ['restore', 'srv', 'snap-1'] })
  assert.deepEqual(parseArgs(['new', '--accept-eula', 'srv'], { booleanFlags: BOOLEAN_FLAGS }),
    { flags: { acceptEula: true }, positional: ['new', 'srv'] })
  assert.deepEqual(parseArgs(['rm', '--purge', '--yes', 'srv'], { booleanFlags: BOOLEAN_FLAGS }),
    { flags: { purge: true, yes: true }, positional: ['rm', 'srv'] })
})

test('a declared short flag does not take the instance name as its value', () => {
  assert.deepEqual(parseArgs(['logs', '-f', 'srv'], { booleanFlags: BOOLEAN_FLAGS }),
    { flags: { f: true }, positional: ['logs', 'srv'] })
  assert.deepEqual(parseArgs(['logs', '-n', '40', 'srv'], { booleanFlags: BOOLEAN_FLAGS }),
    { flags: { n: '40' }, positional: ['logs', 'srv'] })
})

test('flags that carry a value are not declared boolean', () => {
  for (const name of ['port', 'keep', 'memory', 'version', 'timeout', 'label', 'scope', 'at']) {
    assert.ok(!BOOLEAN_FLAGS.includes(name), `--${name} takes a value`)
  }
})

test('keepCount accepts positive whole numbers and nothing else', () => {
  assert.equal(keepCount('1'), 1)
  assert.equal(keepCount('10'), 10)
  for (const bad of [true, '', '0', 'abc', '1.5', '-2', ' 3', '3x', undefined]) {
    assert.throws(() => keepCount(bad), UsageError, `keepCount(${JSON.stringify(bad)})`)
  }
})

test('pruneSnapshots refuses a limit that would delete everything', () => {
  seedSnapshots(3)
  for (const bad of [NaN, 0, -1, 1.5, undefined, '2']) {
    assert.throws(() => backup.pruneSnapshots('srv', bad), /whole number of at least 1/, String(bad))
  }
  assert.equal(snapshots().length, 3)
})

test('prune and backup reject a bad --keep without touching any snapshot', () => {
  seedSnapshots(3)
  for (const args of [['prune', 'srv', '--keep', 'abc'], ['prune', 'srv', '--keep'], ['prune', 'srv', '--keep=0'],
    ['prune', 'srv', '--keep=1.5'], ['prune', 'srv', '--keep='], ['backup', 'srv', '--keep', 'abc'], ['backup', 'srv', '--keep']]) {
    const res = cli(args)
    assert.notEqual(res.code, 0, args.join(' '))
    assert.match(res.stderr, /--keep must be a positive whole number/, args.join(' '))
    assert.equal(snapshots().length, 3, `${args.join(' ')} must not delete or add snapshots`)
  }
})

test('prune --keep N keeps the newest N unlocked snapshots', () => {
  seedSnapshots(4)
  const res = cli(['prune', 'srv', '--keep', '2'])
  assert.equal(res.code, 0, res.stderr)
  assert.deepEqual(snapshots(), ['snap-3.tar.gz', 'snap-2.tar.gz'])
})

test('prune without --keep keeps ten', () => {
  seedSnapshots(12)
  assert.equal(cli(['prune', 'srv']).code, 0)
  assert.equal(snapshots().length, 10)
})

test('locked snapshots survive prune and do not count toward the limit', () => {
  seedSnapshots(3, { locked: true })
  assert.equal(cli(['prune', 'srv', '--keep', '1']).code, 0)
  assert.equal(snapshots().length, 3)
})
