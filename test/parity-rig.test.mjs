// The parity rig itself (tools/parity/, rust/PLAN-CORE-PORT.md section 6): its evening-out, its
// comparison, its fake hosts and its rules, with no core binary needed. The end-to-end part runs
// the rig's own self-tests (scenarios seeded with a difference it must find) and the basics
// scenario, and needs SPAWNLOFT_CORE_BIN; rust-internal.yml's parity job runs the whole rig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText, machineNeutral } from '../tools/parity/lib/normalize.mjs'
import { textDiff, compareSides, runScenario, sideEnv, findCore, awaitedReply } from '../tools/parity/lib/rig.mjs'
import { snapshot, zipListing, tarListing, globToRegExp } from '../tools/parity/lib/tree.mjs'
import { startHosts } from '../tools/parity/lib/fake-host.mjs'
import { DECLARED, applyDeclared, declaredTable } from '../tools/parity/declared-differences.mjs'
import { loadScenarios } from '../tools/parity/run.mjs'
import { buildZip } from './fixtures/zip-writer.mjs'
import zlib from 'node:zlib'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parity = path.join(repo, 'tools', 'parity')

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sl-rig-${label}-`))
}

test('volatile values are evened out, and nothing else', () => {
  const t = normalizeText('at 2026-11-21T03:17:44.123Z and 2026-11-21 03:17:44, made 2026-11-21, '
    + 'file standard_2026-11-21_033246.tar.gz, {"pid":123,"javaPid": 456,"token":"abc","uptimeMs":12,"at":1763695064000,"startedAt":1763695064001} pid 77')
  assert.equal(t, 'at <time> and <time>, made <date>, file standard_<stamp>.tar.gz, '
    + '{"pid":<pid>,"javaPid": <pid>,"token":"<token>","uptimeMs":<ms>,"at":<epoch-ms>,"startedAt":<epoch-ms>} pid <pid>')
  // ports, sizes, versions, names, configured durations, counts and protocol versions are left
  // alone: they must match exactly
  const kept = 'port 25565 size 2048 version 1.21.4 alpha Beta_2 took 15 ms {"timeoutMs":5000,"delayMs":250,'
    + '"count":1763695064000,"sizeBytes":1763695064000,"protocolVersion":"2025-06-18"}'
  assert.equal(normalizeText(kept), kept)
  assert.equal(normalizeText('x=1 y', [{ pattern: 'x=\\d', replace: 'x=?' }]), 'x=? y')
})

test('golden files name this machine\'s paths, with / after them on every platform', () => {
  const run = 'C:\\T\\run'
  assert.equal(machineNeutral('C:\\T\\run\\data\\x.json {"d":"C:\\\\T\\\\run\\\\data"}', { run }), '<run>/data/x.json {"d":"<run>/data"}')
  assert.equal(machineNeutral('/tmp/r/run/data and /repo/src', { run: '/tmp/r/run', repo: '/repo' }), '<run>/data and <repo>/src')
})

test('a text diff shows where the sides part', () => {
  const d = textDiff('a\nb\nc\nd', 'a\nb\nX\nd')
  assert.match(d, /- node: c/)
  assert.match(d, /\+ rust: X/)
  assert.match(d, /^ {2}a$/m)
  assert.equal(textDiff('same', 'same').includes('-'), false)
})

test('globs for ignored paths', () => {
  assert.ok(globToRegExp('data/run/**').test('data/run/alpha/console.log'))
  assert.ok(globToRegExp('**/*.part').test('data/jars/x.jar.part'))
  assert.equal(globToRegExp('data/*.log').test('data/run/x.log'), false)
})

test('a zip is compared by its entries, in order, with their flags', () => {
  const listing = zipListing(buildZip([['b.txt', 'two'], ['a/ä.txt', 'one']]))
  const lines = listing.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^b\.txt method=0 flags=0x0 size=3/)
  assert.equal(zipListing(Buffer.from('not a zip')), null)
})

test('the data tree records kinds, modes, text and archives, and skips what a scenario ignores', () => {
  const root = tmp('tree')
  fs.mkdirSync(path.join(root, 'data', 'run'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'a.json'), '{"pid":5}\n')
  fs.writeFileSync(path.join(root, 'data', 'b.zip'), buildZip([['x', 'y']]))
  fs.writeFileSync(path.join(root, 'data', 'c.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(root, 'data', 'run', 'skip.log'), 'x')
  const tree = snapshot(root, { ignore: ['data/run/**'], normalize: (t) => normalizeText(t) })
  assert.deepEqual([...tree.keys()], ['data', 'data/a.json', 'data/b.zip', 'data/c.bin', 'data/run'])
  assert.equal(tree.get('data/a.json').text, '{"pid":<pid>}\n')
  assert.match(tree.get('data/b.zip').zip, /^x method=0/)
  assert.equal(tree.get('data/c.bin').size, 3)
  if (process.platform !== 'win32') assert.match(tree.get('data/a.json').mode, /^[0-7]{3}$/)
  fs.rmSync(root, { recursive: true, force: true })
})

// a minimal ustar archive: [name, body, type?, mode?]
function buildTar(entries) {
  const blocks = []
  for (const [name, body = '', type = '0', mode = 0o644] of entries) {
    const data = Buffer.from(body)
    const h = Buffer.alloc(512)
    h.write(name, 0, 100, 'utf8')
    h.write(mode.toString(8).padStart(7, '0') + '\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write(type, 156)
    h.write('ustar\u000000', 257)
    h.fill(' ', 148, 156)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

test('a tar is compared by its members\' names, types, modes and bytes, gzipped or not', () => {
  const long = 'd/' + 'n'.repeat(120) + '.txt'
  const tar = buildTar([['a/', '', '5', 0o755], ['a/x.txt', 'one'], ['././@LongLink', long + '\0', 'L'], ['ignored', 'two']])
  const lines = tarListing(tar).split('\n')
  assert.equal(lines[0], 'a/ type=5 mode=755 size=0')
  assert.match(lines[1], /^a\/x\.txt type=0 mode=644 size=3 sha256=[0-9a-f]{64}$/)
  assert.ok(lines[2].startsWith(`${long} type=0 `), 'a GNU long name replaces the short one')
  assert.equal(tarListing(zlib.gzipSync(tar)), tarListing(tar))
  // the same names with other bytes are a different archive
  assert.notEqual(tarListing(buildTar([['a/', '', '5', 0o755], ['a/x.txt', 'One']])), tarListing(buildTar([['a/', '', '5', 0o755], ['a/x.txt', 'one']])))
  assert.equal(tarListing(Buffer.from([0x1f, 0x8b, 1, 2])), null)
})

test('two files whose stamped names even out to one are both kept', () => {
  const root = tmp('collide')
  fs.mkdirSync(path.join(root, 'b'))
  fs.writeFileSync(path.join(root, 'b', 'standard_2026-11-21_033246.txt'), 'one')
  fs.writeFileSync(path.join(root, 'b', 'standard_2026-11-21_033247.txt'), 'two')
  const tree = snapshot(root, { normalizePath: (p) => normalizeText(p) })
  assert.deepEqual([...tree.keys()], ['b', 'b/standard_<stamp>.txt', 'b/standard_<stamp>.txt#2'])
  assert.deepEqual([tree.get('b/standard_<stamp>.txt').text, tree.get('b/standard_<stamp>.txt#2').text], ['one', 'two'])
  fs.rmSync(root, { recursive: true, force: true })
})

const side = (over = {}) => ({ steps: [{ label: 'step 1 (list)', code: 0, signal: null, stdout: 'a\n', stderr: '' }], requests: [], tree: new Map([['data', { kind: 'dir' }]]), ...over })

test('the comparison reports output, exit code, requests and tree differences', () => {
  assert.deepEqual(compareSides(side(), side()), [])
  const b = side({
    steps: [{ label: 'step 1 (list)', code: 1, signal: null, stdout: 'b\n', stderr: '' }],
    requests: [{ url: '/x' }],
    tree: new Map([['data', { kind: 'dir' }], ['data/new', { kind: 'file', text: 'x' }]]),
  })
  const whats = compareSides(side(), b).map(d => d.what)
  assert.deepEqual(whats, ['step 1 (list): exit code', 'step 1 (list): stdout', 'requests to the fake hosts', 'data tree: data/new'])
  assert.deepEqual(compareSides(side(), side({ steps: [] })).map(d => d.detail), ['ran on one side only'])
})

test('each side runs in the scratch folder, with the switch on the Node side only', () => {
  const ctx = { run: '/s/run', data: '/s/run/data', home: '/s/run/home', repo: '/repo' }
  process.env.SPAWNLOFT_DATA_ROOT_LEAK_CHECK = 'x'
  const node = sideEnv(ctx, 'node', { origins: null })
  const rust = sideEnv(ctx, 'rust', { origins: '{"https://a.b":"http://127.0.0.1:1"}', extra: { FOO: 'bar', HOME: null } })
  delete process.env.SPAWNLOFT_DATA_ROOT_LEAK_CHECK
  assert.equal(node.SPAWNLOFT_CORE_IMPL, 'node')
  assert.equal('SPAWNLOFT_CORE_IMPL' in rust, false)
  assert.equal(node.SPAWNLOFT_DATA_ROOT_LEAK_CHECK, undefined, 'the machine\'s own SPAWNLOFT_ variables never reach a side')
  assert.equal(node.SPAWNLOFT_DATA_ROOT, '/s/run/data')
  assert.equal(node.MCCTL_DATA_ROOT, '/s/run/data')
  assert.equal(node.NODE_ENV, 'test')
  // with no host faked, every outside host is still refused
  assert.equal(node.SPAWNLOFT_TEST_ORIGINS, '{}')
  assert.equal(rust.FOO, 'bar')
  assert.equal('HOME' in rust, false)
})

test('the fake host answers routes, fills in checksums, and points redirects at its fakes', async () => {
  const hosts = await startHosts({
    'https://meta.example': { routes: {
      'GET /v': { json: { url: 'https://files.example/f.jar', sha1: '${sha1:https://files.example/f.jar}', size: '${size:https://files.example/f.jar}' } },
      'GET /v?x=1': { text: 'with query' },
      'GET /moved': { redirect: 'https://files.example/f.jar' },
      'GET /fail': { status: 500, text: 'no' },
    } },
    'https://files.example': { routes: { 'GET /f.jar': { bytes: { size: 100, seed: 's' } } } },
  })
  try {
    const map = JSON.parse(hosts.env)
    const meta = await (await fetch(`${map['https://meta.example']}/v`, { headers: { 'user-agent': 'rig-test' } })).json()
    assert.equal(meta.size, '100')
    const jar = Buffer.from(await (await fetch(`${map['https://files.example']}/f.jar`)).arrayBuffer())
    assert.equal(jar.length, 100)
    const { createHash } = await import('node:crypto')
    assert.equal(meta.sha1, createHash('sha1').update(jar).digest('hex'))
    assert.equal(await (await fetch(`${map['https://meta.example']}/v?x=1`)).text(), 'with query')
    const moved = await fetch(`${map['https://meta.example']}/moved`, { redirect: 'manual' })
    assert.equal(moved.headers.get('location'), `${map['https://files.example']}/f.jar`)
    assert.equal((await fetch(`${map['https://meta.example']}/fail`)).status, 500)
    assert.equal((await fetch(`${map['https://meta.example']}/nope`)).status, 404)
    const log = hosts.take()
    assert.equal(log.length, 6)
    assert.equal(log[0].userAgent, 'rig-test')
    assert.equal(log.at(-1).unmatched, true)
    assert.deepEqual(hosts.take(), [])
    // a redirect off the faked origins would reach the network, so the host answers 500 instead
    const off = await startHosts({ 'https://a.example': { routes: { 'GET /r': { redirect: 'https://elsewhere.example/x' } } } })
    try {
      const r = await fetch(`${JSON.parse(off.env)['https://a.example']}/r`, { redirect: 'manual' })
      assert.equal(r.status, 500)
      assert.match(await r.text(), /not a faked origin/)
      assert.ok(off.take().some(e => /not a faked origin/.test(e.error ?? '')))
    } finally {
      await off.close()
    }
    assert.deepEqual(hosts.take(), [])
  } finally {
    await hosts.close()
  }
})

test('a step for one side only is refused outside a self-test', async () => {
  await assert.rejects(runScenario({ name: 'x', steps: [{ side: 'rust', mkdir: 'data/x' }, { run: ['list'] }] }, { core: 'none', repo, scratch: tmp('refuse') }),
    /allowed only in a self-test/)
  await assert.rejects(runScenario({ name: 'x', steps: [{ mkdir: 'data/x' }] }, { core: 'none', repo, scratch: tmp('refuse') }), /no step runs a command/)
  // the switch and the origin map are the rig's to set, never a scenario's
  for (const env of [{ env: { SPAWNLOFT_CORE_IMPL: 'rust' } }, { steps: [{ run: ['list'], env: { SPAWNLOFT_TEST_ORIGINS: '{}' } }] }]) {
    await assert.rejects(runScenario({ name: 'x', steps: [{ run: ['list'] }], ...env }, { core: 'none', repo, scratch: tmp('refuse') }), /a scenario may not set/)
  }
})

test('the declared differences are the plan\'s six rows, the locale row, C1\'s eight, C2\'s two, C5\'s three and C9\'s two, each with a way it is held', () => {
  assert.equal(DECLARED.length, 22)
  for (const row of DECLARED) assert.ok(row.apply || row.held, row.id)
  // doctor's node line and root go; everything else stays
  const doctor = '{"notes":["java: 21","node: v22.1.0","root: /x","data root: /d"]}'
  assert.equal(applyDeclared(doctor, 'doctor'), '{"notes":["java: 21","data root: /d"]}')
  assert.equal(applyDeclared(doctor, 'list'), doctor, 'a row applies only to its commands')
  // the Rust core's line in their place, and the bundle's facts
  assert.equal(applyDeclared('{"notes":["java: 21","core: spawnloft-core 2.0.0 (x86_64-unknown-linux-gnu)","data root: /d"]}', 'doctor'), '{"notes":["java: 21","data root: /d"]}')
  assert.equal(applyDeclared('{"facts":{"spawnloft":"1.6.0","os":"linux","arch":"x64","node":"v22.1.0","server":null}}', 'diag'), '{"facts":{"spawnloft":"<version>","os":"linux","arch":"x64","server":null}}')
  assert.equal(applyDeclared('spawnloft: 2.0.0\nos: linux\nnode: v22.1.0\narch: x64', 'diag'), 'spawnloft: <version>\nos: linux\narch: x64')
  // the panel's diagnostics, in each of the three forms it is served in
  for (const [node, rust] of [
    ['SpawnLoft: 1.6.0\nnode: v22.1.0\nos: linux', 'SpawnLoft: 2.0.0-beta.1\ncore: spawnloft-core 2.0.0-beta.1 (x86_64-unknown-linux-gnu)\nos: linux'],
    ['{"full": "== d ==\\nSpawnLoft: 1.6.0\\nnode: v22.1.0\\nos: linux\\n"}', '{"full": "== d ==\\nSpawnLoft: 2.0.0\\ncore: spawnloft-core 2.0.0 (aarch64-apple-darwin)\\nos: linux\\n"}'],
    ['body=%3D%3D%0ASpawnLoft%3A+1.6.0%0Anode%3A+v22.1.0%0Aos%3A+linux', 'body=%3D%3D%0ASpawnLoft%3A+2.0.0%0Acore%3A+spawnloft-core+2.0.0+%28x86_64-pc-windows-msvc%29%0Aos%3A+linux'],
  ]) {
    assert.equal(applyDeclared(node, 'ui'), applyDeclared(rust, 'ui'), node)
    assert.match(applyDeclared(node, 'ui'), /<version>/)
    assert.match(applyDeclared(node, 'ui'), /os(: |%3A\+)linux/)
  }
  assert.equal(applyDeclared('{"runtime":"/usr/bin/node"}', 'repair'), '{"runtime":"<runtime>"}')
  // a Windows secrets file the core sees inheriting its folder's entries and Node's icacls does not
  assert.equal(applyDeclared('{"problems":["a: x","registry (y): other users on this computer can read C:\\\\d\\\\r.json (it inherits its folder\'s permissions (BUILTIN\\\\Users)); run doctor"]}', 'doctor'), '{"problems":["a: x"]}')
  assert.equal(applyDeclared('  - a: x\n  registry: made owner-only (it inherits its folder\'s permissions (U))\n', 'doctor'), '  - a: x\n')
  assert.match(declaredTable(), /^\| Where \| Node \| Rust \|/)
  // a stack goes, the error line stays
  assert.equal(applyDeclared('SyntaxError: x\n    at JSON.parse (<anonymous>)\n    at f (file:///a.mjs:1:2)\n', 'list'), 'SyntaxError: x\n')
  for (const text of [
    'Expected \',\' or \'}\' after property value in JSON at position 41 (line 1 column 42)',
    'Unexpected token \'\ufeff\', "\ufeff{"version"... is not valid JSON',
    'Unexpected end of JSON input',
    'JSON parse error: EOF while parsing an object at line 1 column 41',
  ]) assert.equal(applyDeclared(`SyntaxError: ${text}`, 'list'), 'SyntaxError: <invalid json>', text)
  // half of an emoji: Node's escape and the Rust core's U+FFFD read the same
  assert.equal(applyDeclared('{"label":"a\\ud83d"}', 'list'), '{"label":"a\ufffd"}')
  // a crash at import keeps only its error line
  const crash = 'node:path:1272\n      validateString(path, `paths[${i}]`);\n      ^\n\nTypeError [ERR_INVALID_ARG_TYPE]: The "paths[0]" argument must be of type string. Received type number (5)\n' +
    '    at Object.resolve (node:path:1272:7)\n    at f (file:///a.mjs:1:2) {\n  code: \'ERR_INVALID_ARG_TYPE\'\n}\n\nNode.js v22.23.5\n'
  assert.equal(applyDeclared(crash, 'list'), 'TypeError [ERR_INVALID_ARG_TYPE]: The "paths[0]" argument must be of type string. Received type number (5)\n')
})

test('every scenario file loads and keeps to the rules', () => {
  const all = loadScenarios([path.join(parity, 'scenarios'), path.join(parity, 'selftest')])
  assert.ok(all.length >= 10)
  for (const s of all) {
    assert.ok(Array.isArray(s.steps) && s.steps.some(x => x.run || x.panel), `${s.name} runs something`)
    assert.ok(s.about, `${s.name} says what it is for`)
    if (s.expect === 'differ') assert.ok(s.expectDifferences?.length, `${s.name} names the differences it seeds`)
    else assert.equal(s.steps.some(x => x.side), false, `${s.name} runs the same steps on both sides`)
  }
  assert.ok(all.filter(s => s.expect === 'differ').length >= 4, 'self-tests for output, exit code, tree and requests')
})

test('the --json scenario runs every command name mcctl.mjs answers', () => {
  const src = fs.readFileSync(path.join(repo, 'mcctl.mjs'), 'utf8')
  const table = src.slice(src.indexOf('const COMMANDS = {'))
  const names = [...table.slice(0, table.indexOf('}')).matchAll(/^\s+([a-z]+):/gm)].map(m => m[1])
  assert.ok(names.length >= 59, `found ${names.length} names`)
  const scenario = JSON.parse(fs.readFileSync(path.join(parity, 'scenarios', 'cli-json.json'), 'utf8'))
  const ran = new Set(scenario.steps.filter(s => s.run && s.run.length === 2 && s.run[1] === '--json').map(s => s.run[0]))
  for (const n of [...names, '--help', '-h']) assert.ok(ran.has(n), `cli-json.json does not run "${n} --json"`)
})

const core = findCore(repo)
test('end to end: the self-tests find their seeded differences and the basics agree', { skip: !process.env.SPAWNLOFT_CORE_BIN && 'set SPAWNLOFT_CORE_BIN to a spawnloft-core built with --features test-hooks' }, async () => {
  const scenarios = loadScenarios([path.join(parity, 'selftest'), path.join(parity, 'scenarios', 'basics.json')])
  for (const s of scenarios) {
    if (s.platforms && !s.platforms.includes(process.platform)) continue
    const r = await runScenario(s, { core, repo, scratch: tmp(s.name), baseDir: path.dirname(s.file) })
    assert.ok(r.ok, `${s.name}: ${JSON.stringify({ problems: r.problems, diffs: r.diffs.map(d => d.what) })}`)
  }
})

test('an rpc step waits for the reply each line asks for', () => {
  assert.deepEqual(awaitedReply('{"jsonrpc":"2.0","id":3,"method":"ping"}'), { id: 3 })
  assert.deepEqual(awaitedReply('{"jsonrpc":"2.0","id":"a","method":"ping"}'), { id: 'a' })
  assert.equal(awaitedReply('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null)
  assert.equal(awaitedReply('   '), null)
  assert.deepEqual(awaitedReply('this is not json'), { anyLine: true })
  assert.deepEqual(awaitedReply('[1,2]'), { anyLine: true })
  assert.equal(awaitedReply('{"jsonrpc":"2.0","id":5}'), null)
  assert.equal(awaitedReply('{"jsonrpc":"2.0","id":5,"method":5}'), null)
  assert.deepEqual(awaitedReply('{"jsonrpc":"1.0","id":5,"method":"ping"}'), { anyLine: true })
  assert.deepEqual(awaitedReply('{"jsonrpc":"2.0","id":null,"method":"ping"}'), { anyLine: true })
  assert.deepEqual(awaitedReply('{"jsonrpc":"2.0","id":{},"method":"ping"}'), { anyLine: true })
  assert.deepEqual(awaitedReply('null'), { anyLine: true })
})
