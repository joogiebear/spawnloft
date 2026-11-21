/**
 * zip.mjs and the jar readers of plugins.mjs against the Rust port (spawnloft-lib zip.rs), across
 * processes: archives made by either side are read by both the same way (names, sizes, contents),
 * non-ASCII names and the UTF-8 flag decode the same, damaged and hostile archives (path
 * traversal, encryption, links, bad checksums, truncation) are refused in the same words, and
 * what each side extracts is the same tree.
 *
 * The Rust side is the test-only `zip-probe` binary of spawnloft-fakes, named by
 * SPAWNLOFT_ZIP_PROBE:
 *   (cd rust && cargo build -p spawnloft-fakes)
 *   SPAWNLOFT_ZIP_PROBE=$PWD/rust/target/debug/zip-probe node --test test/zip-cross-process.test.mjs
 * The Node side is test/fixtures/zip-node-probe.mjs.
 *
 * One declared difference (rust/PLAN-CORE-PORT.md 6.1) is not compared byte for byte: the
 * compressed bytes each side writes (zlib's against miniz_oxide's), so `packed` and `offset` of
 * an archive are compared only between the two readings of that same archive. The other, zlib's
 * words for a jar entry whose compressed data is damaged in the middle, has no case here.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE_PROBE = path.join(HERE, 'fixtures', 'zip-node-probe.mjs')
const RUST_PROBE = process.env.SPAWNLOFT_ZIP_PROBE
// a probe that is named but missing is a broken setup (CI names it), not a reason to skip
if (RUST_PROBE && !fs.existsSync(RUST_PROBE)) {
  throw new Error(`SPAWNLOFT_ZIP_PROBE names ${RUST_PROBE}, which does not exist; build it with: cd rust && cargo build -p spawnloft-fakes`)
}
const skip = RUST_PROBE
  ? false
  : 'set SPAWNLOFT_ZIP_PROBE to the built zip-probe binary (cd rust && cargo build -p spawnloft-fakes; then SPAWNLOFT_ZIP_PROBE=$PWD/rust/target/debug/zip-probe)'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-zip-x-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (label) => {
  const dir = path.join(scratch, `${label}-${n++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function run(side, ...args) {
  const [bin, argv] = side === 'rust' ? [RUST_PROBE, args] : [process.execPath, [NODE_PROBE, ...args]]
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out: out.trim(), err })))
}

/** Every file and folder under `dir`: relative path (with /) to 'dir' or the content as hex. */
function tree(dir) {
  const out = {}
  if (!fs.existsSync(dir)) return out
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const st = fs.lstatSync(path.join(dir, r))
      if (st.isDirectory()) { out[`${r}/`] = 'dir'; walk(r) }
      else if (st.isSymbolicLink()) out[r] = 'link'
      else out[r] = fs.readFileSync(path.join(dir, r)).toString('hex')
    }
  }
  walk('')
  return out
}

/** Both sides do the same thing to `zip`; their answers and the trees they leave must agree. */
async function same(command, zip, ...more) {
  const node = fresh('node')
  const rust = fresh('rust')
  const answer = {}
  for (const [side, dest] of [['node', node], ['rust', rust]]) {
    answer[side] = await run(side, command, zip, ...(command.endsWith('extract') ? [dest, ...more] : more))
    // an error that names the destination names each side's own, and a quoted one (the NUL
    // TypeError's inspect quote) has its backslashes doubled on Windows
    for (const named of [dest.replaceAll('\\', '\\\\'), dest]) answer[side].out = answer[side].out.split(named).join('<dest>')
  }
  const label = `${command} ${path.basename(zip)} ${more.join(' ')}`
  assert.equal(answer.rust.out, answer.node.out, `${label}: the answers differ`)
  assert.equal(answer.rust.code, answer.node.code, `${label}: exit ${answer.rust.code} vs ${answer.node.code}`)
  assert.deepEqual(tree(rust), tree(node), `${label}: the trees differ`)
  return { ...answer.node, tree: tree(node) }
}

const crc32 = (b) => zlib.crc32(b)

/** A zip written field by field, for archives no writer makes: each entry
 *  { name (string or Buffer), flags, method, data (as stored), crc, size, madeBy, attributes,
 *    extra (central, Buffer) }; `comment` after the end record, `prefix` before the archive. */
function rawZip(entries, { comment = Buffer.alloc(0), prefix = Buffer.alloc(0) } = {}) {
  const parts = [prefix]
  let at = prefix.length
  const central = []
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8')
    const data = e.data ?? Buffer.alloc(0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.flags ?? 0x0800, 6)
    local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(e.crc ?? crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(e.size ?? data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const offset = at - prefix.length
    parts.push(local, name, data)
    at += 30 + name.length + data.length
    const extra = e.extra ?? Buffer.alloc(0)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(((e.madeBy ?? 3) << 8) | 20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(e.flags ?? 0x0800, 8)
    c.writeUInt16LE(e.method ?? 0, 10)
    c.writeUInt32LE(e.crc ?? crc32(data), 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(e.size ?? data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(extra.length, 30)
    c.writeUInt32LE((e.attributes ?? (0o100644 << 16)) >>> 0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, name, extra)
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(at - prefix.length, 16)
  end.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...parts, cd, end, comment])
}

const file = (name, data) => ({ name, data: Buffer.from(data) })

function save(bytes, name = 'a.zip') {
  const f = path.join(fresh('zip'), name)
  fs.writeFileSync(f, bytes)
  return f
}

test('archives made by either side read and extract the same on both', { skip, timeout: 180000 }, async () => {
  const src = fresh('src')
  const world = path.join(src, 'world')
  fs.mkdirSync(path.join(world, 'région', '日本'), { recursive: true })
  fs.mkdirSync(path.join(world, 'empty dir'))
  fs.writeFileSync(path.join(world, 'level.dat'), Buffer.alloc(200000, 'abcdefgh'))
  fs.writeFileSync(path.join(world, 'random.bin'), Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 7919) % 251)))
  fs.writeFileSync(path.join(world, 'zero'), '')
  fs.writeFileSync(path.join(world, 'région', '日本', 'r.0.0.mca'), 'chunk')
  fs.writeFileSync(path.join(world, '\uff5e'), 'wide')
  fs.writeFileSync(path.join(world, '😀 café'), 'astral')
  fs.writeFileSync(path.join(world, 'session.lock'), 'held')
  fs.writeFileSync(path.join(src, '-dash'), 'dash')
  const listings = {}
  for (const maker of ['node', 'rust']) {
    for (const zip64 of [false, true]) {
      const zip = path.join(fresh('made'), `${maker}-${zip64}.zip`)
      const made = await run(maker, 'create', zip, src, ...(zip64 ? ['--zip64'] : []), '--exclude', 'session.lock', '--', 'world', '-dash')
      assert.equal(made.code, 0, made.out)
      assert.equal(made.out, '{"entries":11}')
      const listing = await same('list', zip)
      const extracted = await same('extract', zip)
      assert.equal(extracted.out, '{"files":7}')
      assert.equal(extracted.tree['world/région/日本/r.0.0.mca'], Buffer.from('chunk').toString('hex'))
      assert.equal(extracted.tree['world/level.dat'], Buffer.alloc(200000, 'abcdefgh').toString('hex'))
      assert.ok(!('world/session.lock' in extracted.tree))
      await same('is-zip', zip)
      await same('jar-list', zip)
      await same('jar-read', zip, 'world/random.bin')
      await same('jar-read', zip, 'world/😀 café')
      await same('jar-extract', zip, 'world/')
      // what does not depend on the compressor is the same whichever side wrote it
      listings[`${maker}-${zip64}`] = JSON.parse(listing.out).map(({ packed, offset, ...rest }) => rest)
    }
  }
  assert.deepEqual(listings['rust-false'], listings['node-false'])
  assert.deepEqual(listings['rust-true'], listings['node-true'])
  // directories first, then names in UTF-16 order (the astral one before U+FF5E)
  assert.deepEqual(listings['node-false'].map((e) => e.name), [
    'world/', 'world/empty dir/', 'world/level.dat', 'world/random.bin', 'world/région/', 'world/région/日本/',
    'world/région/日本/r.0.0.mca', 'world/zero', 'world/😀 café', 'world/\uff5e', '-dash',
  ])
})

test('names decode the same with and without the UTF-8 flag', { skip, timeout: 60000 }, async () => {
  const zip = save(rawZip([
    { name: Buffer.from([0x63, 0x61, 0x66, 0x82]), flags: 0, data: Buffer.from('cp437') },
    { name: Buffer.from('mac ü', 'utf8'), flags: 0, data: Buffer.from('unflagged utf8') },
    { name: Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x6d]), flags: 0, data: Buffer.from('bom') },
    { name: Buffer.from([0x61, 0xff, 0x62]), flags: 0x0800, data: Buffer.from('flagged, not utf8') },
    { name: Buffer.from([0xe2, 0x82]), flags: 0x0800, data: Buffer.from('cut sequence') },
    { name: Buffer.from([0xb0, 0xb1, 0xdb, 0xff]), flags: 0, data: Buffer.from('box drawing') },
  ]))
  const listing = await same('list', zip)
  assert.deepEqual(JSON.parse(listing.out).map((e) => e.name), ['café', 'mac ü', 'bom', 'a\ufffdb', '\ufffd', '░▒█\u00a0'])
  await same('extract', zip)
  await same('jar-list', zip)
})

test('hostile and damaged archives are refused in the same words', { skip, timeout: 180000 }, async () => {
  const cases = {
    'parent': [file('ok', '1'), file('../evil', 'x')],
    'nested parent': [file('a/../../evil', 'x')],
    'absolute': [file('/etc/evil', 'x')],
    'drive': [file('C:/evil', 'x')],
    'drive relative': [file('c:evil', 'x')],
    'backslashes': [file('a\\..\\..\\evil', 'x')],
    'empty name': [file('', 'x')],
    'dot': [file('./ok', 'x'), file('.', 'y')],
    'encrypted': [{ ...file('secret', 'x'), flags: 0x0801 }],
    'method': [{ ...file('lzma', 'x'), method: 14 }],
    'bad crc': [{ ...file('bad', 'hello'), crc: 1 }],
    'wrong size': [{ ...file('size', 'hello'), size: 4 }],
    'deflated': [{ name: 'd.txt', method: 8, data: zlib.deflateRawSync('deflated text'), crc: crc32(Buffer.from('deflated text')), size: 13 }],
    'link': [{ ...file('link', '/etc/passwd'), attributes: (0o120777 << 16) >>> 0 }, file('after', 'a')],
    'dos link bits': [{ ...file('notlink', 'x'), madeBy: 0, attributes: (0o120777 << 16) >>> 0 }],
    'folder over file': [file('x', '1'), file('x/y', '2')],
    'deep': [file('a/b/c/d/e/f.txt', 'deep'), file('a/', '')],
    // names Win32 would change are taken literally on Windows, as Node's namespaced paths are
    'trailing dot and space': [file('a.', '1'), file('b ', '2'), file('a', '3')],
    'device names': [file('w/nul', 'x'), file('com1.txt', 'y')],
    'nul byte': [file('ok', '1'), file('a\u0000b', 'x')],
    'nul byte in a folder': [file('d\u0000/x', 'x')],
  }
  for (const [label, entries] of Object.entries(cases)) {
    const zip = save(rawZip(entries), `${label.replace(/ /g, '-')}.zip`)
    await same('extract', zip)
    await same('list', zip)
    await same('jar-list', zip)
    await same('jar-extract', zip, '')
    // (a NUL cannot be passed as an argument)
    for (const e of entries) if (!String(e.name).includes('\u0000')) await same('jar-read', zip, String(e.name))
  }
  const good = rawZip([file('a.txt', 'A'), file('b/c.txt', 'C')])
  const cd = good.readUInt32LE(good.length - 6)
  const damaged = {
    'too small': Buffer.from('PK'),
    'not a zip': Buffer.alloc(300, 7),
    'cut short': good.subarray(0, good.length - 30),
    'index past the end': (() => { const b = Buffer.from(good); b.writeUInt32LE(b.length, b.length - 10); return b })(),
    'entry past the end': (() => { const b = Buffer.from(good); b.writeUInt32LE(9999, cd + 20); return b })(),
    'local header moved': (() => { const b = Buffer.from(good); b.writeUInt32LE(1, cd + 42); return b })(),
    'more entries than the index holds': (() => { const b = Buffer.from(good); b.writeUInt16LE(3, b.length - 12); return b })(),
    'extra field past the index': (() => { const b = Buffer.from(good); b.writeUInt16LE(12, cd + 30); return b })(),
    'fake end record in the comment': rawZip([file('a', '1')], { comment: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]) }),
    'data prepended': rawZip([file('a', '1'), file('b', '2')], { prefix: Buffer.from('#!/bin/sh\nexit 0\n') }),
    'zip64 marker without a locator': (() => { const b = Buffer.from(good); b.writeUInt16LE(0xffff, b.length - 12); return b })(),
    // an entry claiming 4 MiB past the end of the file: only what the file holds is read
    'claims past its end': (() => { const b = rawZip([{ name: 'a.txt', method: 8, data: zlib.deflateRawSync('A'), size: 1 }]); const c = b.readUInt32LE(b.length - 6); b.writeUInt32LE(4 << 20, c + 20); return b })(),
    // more out than the entry declares
    'inflates past its size': rawZip([{ name: 'a.txt', method: 8, data: zlib.deflateRawSync(Buffer.alloc(100000)), crc: 0, size: 10 }]),
    'deflate cut short': rawZip([{ name: 'cut', method: 8, data: zlib.deflateRawSync(Buffer.alloc(5000, 'q')).subarray(0, 10), crc: 0, size: 5000 }]),
  }
  for (const [label, bytes] of Object.entries(damaged)) {
    const zip = save(bytes, `${label.replace(/ /g, '-')}.zip`)
    await same('list', zip)
    await same('is-zip', zip)
    await same('jar-list', zip)
    await same('jar-read', zip, 'a.txt')
    await same('extract', zip)
  }
  // compressed data that does not inflate is damage, said as such, and the half is not kept
  const cut = await same('extract', save(damaged['deflate cut short'], 'cut.zip'))
  assert.equal(cut.out, 'error: "cut" did not match its checksum; the archive is damaged and nothing more was extracted')
  assert.deepEqual(cut.tree, {})
})
