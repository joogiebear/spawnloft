/**
 * registry.mjs's writes against the Rust port (spawnloft-lib registry.rs), across processes:
 * the same changes made by either side leave the same bytes in instances.json, each side reads
 * what the other wrote, both refuse the same things with the same words, the file stays
 * owner-only, and the two writing at once under the shared lock lose no record.
 *
 * The Rust side is the test-only `registry-probe` binary of spawnloft-fakes, named by
 * SPAWNLOFT_REGISTRY_PROBE:
 *   (cd rust && cargo build -p spawnloft-fakes)
 *   SPAWNLOFT_REGISTRY_PROBE=$PWD/rust/target/debug/registry-probe node --test test/registry-cross-process.test.mjs
 * The Node side is test/fixtures/registry-node-probe.mjs.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE_PROBE = path.join(HERE, 'fixtures', 'registry-node-probe.mjs')
const RUST_PROBE = process.env.SPAWNLOFT_REGISTRY_PROBE
// a probe that is named but missing is a broken setup (CI names it), not a reason to skip
if (RUST_PROBE && !fs.existsSync(RUST_PROBE)) {
  throw new Error(`SPAWNLOFT_REGISTRY_PROBE names ${RUST_PROBE}, which does not exist; build it with: cd rust && cargo build -p spawnloft-fakes`)
}
const skip = RUST_PROBE
  ? false
  : 'set SPAWNLOFT_REGISTRY_PROBE to the built registry-probe binary (cd rust && cargo build -p spawnloft-fakes; then SPAWNLOFT_REGISTRY_PROBE=$PWD/rust/target/debug/registry-probe)'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-reg-x-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const registry = () => {
  const dir = path.join(scratch, `r${n++}`)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'instances.json')
}

function run(side, ...args) {
  const [bin, argv] = side === 'rust' ? [RUST_PROBE, args] : [process.execPath, [NODE_PROBE, ...args]]
  // the probes find nothing of this machine's own SpawnLoft
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(SPAWNLOFT|MCCTL)_/.test(k)) delete env[k]
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out: out.trim(), err })))
}

async function ok(side, ...args) {
  const r = await run(side, ...args)
  assert.equal(r.code, 0, `${side} ${args.join(' ')} exited ${r.code}: ${r.out} ${r.err}`)
  return r.out
}

// Records with what JSON.stringify has opinions about: an index-like name (keys like it go
// first), numbers that print in exponent form, nested objects, unicode and an empty list.
const STEPS = [
  ['put', 'beta', JSON.stringify({ dir: '/srv/beta', port: 25566, rcon: { port: 25576, password: 'päss' }, flags: [] })],
  ['put', 'alpha', JSON.stringify({ dir: '/srv/alpha', port: 25565, memory: '4G', big: 1e21, small: 1e-7, motd: 'café \u{1F600}' })],
  ['put', '10', JSON.stringify({ dir: '/srv/10', port: 25567 })],
  ['update', 'beta', JSON.stringify({ port: 25570, autoRestart: true })],
  ['put', '2', JSON.stringify({ dir: '/srv/2' })],
  ['remove', 'alpha'],
  ['update', '10', JSON.stringify({ dir: '/srv/ten', name: 'own' })],
  ['put', 'alpha', JSON.stringify({ kind: 'database', engine: 'mariadb' })],
]

test('the same changes leave the same bytes, whichever side makes each one', { skip, timeout: 120000 }, async () => {
  const plans = { node: STEPS.map(() => 'node'), rust: STEPS.map(() => 'rust'), mixed: STEPS.map((_, i) => (i % 2 ? 'rust' : 'node')) }
  const files = {}
  const outputs = {}
  for (const [plan, sides] of Object.entries(plans)) {
    const file = registry()
    outputs[plan] = []
    for (const [i, [cmd, ...args]] of STEPS.entries()) outputs[plan].push(await ok(sides[i], cmd, file, ...args))
    files[plan] = fs.readFileSync(file, 'utf8')
    assert.ok(!fs.existsSync(`${file}.tmp`), `${plan}: no temp file left`)
    assert.ok(!fs.existsSync(`${file}.lock`), `${plan}: no lock left`)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${plan}: owner-only`)
  }
  assert.equal(files.rust, files.node)
  assert.equal(files.mixed, files.node)
  assert.deepEqual(outputs.rust, outputs.node)
  assert.deepEqual(outputs.mixed, outputs.node)
  assert.deepEqual(Object.keys(JSON.parse(files.node).instances), ['2', '10', 'beta', 'alpha'])
})

test('both refuse the same things in the same words', { skip, timeout: 60000 }, async () => {
  for (const args of [['update', 'ghost', '{"port":1}'], ['put', '-bad', '{}'], ['put', 'a'.repeat(33), '{}']]) {
    const file = registry()
    const [node, rust] = [await run('node', args[0], file, ...args.slice(1)), await run('rust', args[0], file, ...args.slice(1))]
    assert.equal(node.code, 1, `node ${args[0]}: ${node.out}`)
    assert.equal(rust.code, 1, `rust ${args[0]}: ${rust.out}`)
    assert.equal(rust.out, node.out)
  }
  // a registry that is not an object document: Node's TypeError, word for word
  const file = registry()
  fs.writeFileSync(file, '{"instances":"abc"}')
  const [node, rust] = [await run('node', 'put', file, 'x', '{}'), await run('rust', 'put', file, 'x', '{}')]
  assert.equal(rust.out, node.out)
  assert.match(node.out, /^error: Cannot create property 'x' on string 'abc'$/)
})

test('free names agree', { skip, timeout: 60000 }, async () => {
  const file = registry()
  const long = 'a'.repeat(30) + '--'
  for (const name of ['smp', 'smp-2', long.slice(0, 32)]) await ok('node', 'put', file, name, '{}')
  for (const base of ['smp', 'other', long.slice(0, 32)]) {
    assert.equal(await ok('rust', 'free', file, base), await ok('node', 'free', file, base), base)
  }
})

test('writing at once under the shared lock loses no record', { skip, timeout: 180000 }, async () => {
  const file = registry()
  const count = 25
  const results = await Promise.all([
    run('node', 'many', file, 'n', String(count)),
    run('rust', 'many', file, 'r', String(count)),
    run('node', 'many', file, 'm', String(count)),
    run('rust', 'many', file, 's', String(count)),
  ])
  for (const r of results) assert.equal(r.code, 0, `${r.out} ${r.err}`)
  const names = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).instances)
  assert.equal(names.length, 4 * count, `lost a write: ${names.length} records`)
  for (const p of ['n', 'r', 'm', 's']) for (let i = 0; i < count; i++) assert.ok(names.includes(`${p}-${i}`), `${p}-${i}`)
})
