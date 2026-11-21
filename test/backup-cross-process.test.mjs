/**
 * Backups made by the Rust core (spawnloft-lib backup.rs) restore with the Node core and the
 * reverse (rust/PLAN-CORE-PORT.md, C3's done-when): each side backs up a server folder, the other
 * verifies and restores it, and what comes back is the folder that was backed up. The format is
 * the Node core's own (a system-tar .tar.gz with its .json manifest beside it), which is what a
 * 1.5.0 build reads and writes, since `dataFormat` never changes in the port.
 *
 * On macOS it is also the check the installer design owed C3: a restore adds no quarantine
 * attribute to what it extracts, not even from an archive that carries one itself (an archive
 * downloaded through a browser, then restored).
 *
 * The Rust side is the spawnloft-core binary named by SPAWNLOFT_CORE_BIN (the parity job's), and
 * the Node side the same binary with SPAWNLOFT_CORE_IMPL=node, which forwards to mcctl.mjs:
 *   (cd rust && cargo build -p spawnloft-core --features test-hooks)
 *   SPAWNLOFT_CORE_BIN=$PWD/rust/target/debug/spawnloft-core node --test test/backup-cross-process.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = process.env.SPAWNLOFT_CORE_BIN
if (CORE && !fs.existsSync(CORE)) {
  throw new Error(`SPAWNLOFT_CORE_BIN names ${CORE}, which does not exist; build it with: cd rust && cargo build -p spawnloft-core --features test-hooks`)
}
const skip = CORE ? false : 'set SPAWNLOFT_CORE_BIN to a built spawnloft-core (cd rust && cargo build -p spawnloft-core --features test-hooks)'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-backup-x-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function setup(label) {
  const root = path.join(scratch, label)
  const data = path.join(root, 'data')
  const dir = path.join(data, 'instances', 'srv')
  const files = {
    'server.properties': 'level-name=world\nmotd=Hi\n',
    'eula.txt': 'eula=true\n',
    'ops.json': '[]\n',
    'plugins/Essentials.jar': 'jar bytes',
    'plugins/Essentials/config.yml': 'a: 1\n',
    'world/level.dat': 'level',
    'world/region/r.0.0.mca': Buffer.from([0, 1, 2, 255, 254]).toString('latin1'),
    'world_nether/level.dat': 'nether',
    'config/paper-world-defaults.yml': 'x: 1\n',
    'plugins/naïve ünïcödé.yml': 'b: 2\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text, 'latin1')
  }
  fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
    version: 1,
    instances: { srv: { dir, jar: 'server.jar', memory: '1G', port: 47990 } },
  }))
  return { root, data, dir, files }
}

function core(side, ctx, ...args) {
  const home = path.join(ctx.root, 'home')
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(SPAWNLOFT_|MCCTL_)/.test(k)) delete env[k]
  Object.assign(env, {
    SPAWNLOFT_DATA_ROOT: ctx.data,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    SPAWNLOFT_NODE: process.execPath,
    SPAWNLOFT_CORE_DIR: REPO,
  })
  if (side === 'node') env.SPAWNLOFT_CORE_IMPL = 'node'
  const r = spawnSync(CORE, args, { env, encoding: 'utf8', timeout: 120000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** Every file under `dir`, by relative path with forward slashes, to its bytes as hex. */
function tree(dir) {
  const out = {}
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else out[r] = fs.readFileSync(path.join(dir, r)).toString('hex')
    }
  }
  walk('')
  return out
}

function quarantined(dir) {
  const r = spawnSync('xattr', ['-r', '-l', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter((l) => l.includes('com.apple.quarantine'))
}

for (const [maker, restorer] of [['rust', 'node'], ['node', 'rust']]) {
  test(`a backup the ${maker} core makes, the ${restorer} core verifies and restores`, { skip }, () => {
    const ctx = setup(`${maker}-to-${restorer}`)
    const before = tree(ctx.dir)

    const made = core(maker, ctx, 'backup', 'srv', '--json')
    assert.equal(made.code, 0, made.err + made.out)
    const res = JSON.parse(made.out).data
    assert.deepEqual(res.members, ['plugins', 'world', 'world_nether', 'server.properties', 'ops.json', 'eula.txt', 'config'])
    assert.ok(fs.existsSync(res.path.replace(/\.tar\.gz$/, '.json')))

    const listed = core(restorer, ctx, 'snapshots', 'srv', '--json')
    assert.equal(listed.code, 0, listed.err)
    const [row] = JSON.parse(listed.out).data.backups
    assert.equal(row.path, res.path)
    assert.deepEqual(row.members, res.members)

    const verified = core(restorer, ctx, 'verify', 'srv')
    assert.equal(verified.code, 0, verified.err + verified.out)
    assert.match(verified.out, /^ok {4}standard_/)

    // what the backup holds comes back: changed, removed and added files
    fs.writeFileSync(path.join(ctx.dir, 'world', 'level.dat'), 'changed')
    fs.rmSync(path.join(ctx.dir, 'plugins', 'Essentials'), { recursive: true })
    fs.writeFileSync(path.join(ctx.dir, 'world', 'new.txt'), 'made after')
    if (process.platform === 'darwin') {
      // as a browser marks a download
      const q = spawnSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', res.path], { encoding: 'utf8' })
      assert.equal(q.status, 0, q.stderr)
    }
    const restored = core(restorer, ctx, 'restore', 'srv', path.basename(res.path), '--yes')
    assert.equal(restored.code, 0, restored.err + restored.out)
    assert.match(restored.out, /^Restored standard_/)
    const after = tree(ctx.dir)
    // an ordinary restore adds and overwrites, it does not delete
    assert.equal(after['world/new.txt'], Buffer.from('made after').toString('hex'))
    delete after['world/new.txt']
    assert.deepEqual(after, before)
    if (process.platform === 'darwin') assert.deepEqual(quarantined(ctx.dir), [])

    // the copy the restore kept of what it replaced is one the maker reads back too
    const again = core(maker, ctx, 'verify', 'srv', 'pre-restore')
    assert.equal(again.code, 0, again.err + again.out)
  })
}
