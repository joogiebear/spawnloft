import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createZip, extractZip, isZip, zipEntries, decodeName } from '../src/zip.mjs'
import { tarBinary, tarHandlesZip } from '../src/tar.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-zip-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A small world: nested folders, an empty file, an empty folder, bytes that do and do not compress. */
function makeWorld(root) {
  const world = path.join(root, 'world')
  fs.mkdirSync(path.join(world, 'region'), { recursive: true })
  fs.mkdirSync(path.join(world, 'datapacks'), { recursive: true })
  fs.mkdirSync(path.join(root, 'world_nether', 'DIM-1'), { recursive: true })
  fs.writeFileSync(path.join(world, 'level.dat'), 'level '.repeat(5000))
  fs.writeFileSync(path.join(world, 'session.lock'), 'held')
  fs.writeFileSync(path.join(world, 'empty.txt'), '')
  fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), crypto.randomBytes(300 * 1024))
  fs.writeFileSync(path.join(world, 'region', 'r.-1.0 ünï.mca'), crypto.randomBytes(70 * 1024))
  fs.writeFileSync(path.join(root, 'world_nether', 'DIM-1', 'r.0.0.mca'), Buffer.alloc(200 * 1024, 7))
  return ['world', 'world_nether']
}

function listing(root) {
  const out = {}
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      // Compared in one normal form. macOS hands file names back decomposed - "u" and a combining
      // diaeresis where "ü" was written - so the same file would otherwise read as a different name.
      const rel = path.relative(root, full).split(path.sep).join('/').normalize('NFC')
      if (fs.statSync(full).isDirectory()) { out[rel + '/'] = 'dir'; visit(full) }
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')
    }
  }
  visit(root)
  return out
}

function names(file) {
  const fd = fs.openSync(file, 'r')
  try { return [...zipEntries(fd, fs.fstatSync(fd).size)].map(entry => entry.name) }
  finally { fs.closeSync(fd) }
}

test('a world survives the trip through a zip, with its empty folders and without its lock', async () => {
  const src = fs.mkdtempSync(path.join(scratch, 'src-'))
  const members = makeWorld(src)
  const file = path.join(scratch, 'plain.zip')
  const made = await createZip(file, src, members, { exclude: ['session.lock'] })
  assert.ok(isZip(file))
  assert.equal(made.bytes, fs.statSync(file).size)
  assert.ok(!names(file).some(name => name.endsWith('session.lock')))
  assert.ok(names(file).includes('world/datapacks/'))
  // Small archives stay plain: no 64-bit structures that an old unzip might trip on.
  assert.ok(!fs.readFileSync(file).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])))

  const out = fs.mkdtempSync(path.join(scratch, 'out-'))
  await extractZip(file, out)
  const expected = listing(src)
  delete expected['world/session.lock']
  assert.deepEqual(listing(out), expected)
})

test('zip64 structures are written and read back, for the worlds that are past four gigabytes', async () => {
  const src = fs.mkdtempSync(path.join(scratch, 'src64-'))
  const members = makeWorld(src)
  const file = path.join(scratch, 'wide.zip')
  await createZip(file, src, members, { forceZip64: true })
  assert.ok(fs.readFileSync(file).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])))
  const out = fs.mkdtempSync(path.join(scratch, 'out64-'))
  await extractZip(file, out)
  assert.deepEqual(listing(out), listing(src))
})

test('names are read in the encoding they were written in', () => {
  // bsdtar on Windows: code page 437, no flag. 0x81 is ü and 0x8b is ï there.
  assert.equal(decodeName(Buffer.from('772f7220816e8b2e6d6361', 'hex'), 0x0008), 'w/r ünï.mca')
  // macOS: UTF-8, and no flag either.
  assert.equal(decodeName(Buffer.from('w/r ünï.mca', 'utf8'), 0), 'w/r ünï.mca')
  assert.equal(decodeName(Buffer.from('w/r ünï.mca', 'utf8'), 0x0800), 'w/r ünï.mca')
  assert.equal(decodeName(Buffer.from([0x80, 0xff, 0xe1]), 0), 'Ç ß')
})

/** One stored entry under any name at all - which is how a hostile archive is made. */
function craft(name, body = Buffer.from('owned')) {
  const label = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
  local.writeUInt32LE(zlib.crc32 ? zlib.crc32(body) : 0, 14)
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(label.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  local.copy(central, 16, 14, 26)
  central.writeUInt16LE(label.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + label.length, 12); end.writeUInt32LE(30 + label.length + body.length, 16)
  return Buffer.concat([local, label, body, central, label, end])
}

test('an archive cannot write outside the folder it is extracted into', async () => {
  for (const name of ['../escaped.txt', 'world/../../escaped.txt', '/tmp/escaped.txt', 'C:/escaped.txt', '..\\escaped.txt']) {
    const file = path.join(scratch, 'hostile.zip')
    fs.writeFileSync(file, craft(name))
    const out = fs.mkdtempSync(path.join(scratch, 'jail-'))
    await assert.rejects(extractZip(file, out), /outside its folder/, name)
    assert.deepEqual(fs.readdirSync(out), [], name)
    assert.ok(!fs.existsSync(path.join(scratch, 'escaped.txt')), name)
  }
})

test('damage is found on the file that is damaged, and what is not a zip is said not to be one', async () => {
  const src = fs.mkdtempSync(path.join(scratch, 'srcbad-'))
  fs.mkdirSync(path.join(src, 'world'))
  fs.writeFileSync(path.join(src, 'world', 'level.dat'), crypto.randomBytes(64 * 1024))
  const file = path.join(scratch, 'damaged.zip')
  await createZip(file, src, ['world'])
  const bytes = fs.readFileSync(file)
  bytes[2000] ^= 0xff
  fs.writeFileSync(file, bytes)
  const out = fs.mkdtempSync(path.join(scratch, 'outbad-'))
  await assert.rejects(extractZip(file, out))
  // A file that failed its checksum is not left behind looking like a world.
  assert.ok(!fs.existsSync(path.join(out, 'world', 'level.dat')))

  const cut = path.join(scratch, 'cut.zip')
  fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, 5000))
  await assert.rejects(extractZip(cut, out), /not a zip|cut short|damaged/)

  const tarball = path.join(scratch, 'really.tar.gz')
  fs.writeFileSync(tarball, zlib.gzipSync(Buffer.alloc(2048)))
  assert.equal(isZip(tarball), false)
  assert.equal(isZip(file), true)
})

// The point of a zip is that something else opens it. Whichever independent implementation this
// machine has is asked to: bsdtar where tar is bsdtar, Python's zipfile where it is not.
const python = spawnSync('python3', ['-c', 'import zipfile'], { encoding: 'utf8' }).status === 0
const other = tarHandlesZip() ? 'bsdtar' : python ? 'python' : null

test('other tools open what is written here, and what they write is read here',
  { skip: other ? false : 'no bsdtar and no python3 on this machine to check against' }, async () => {
    const src = fs.mkdtempSync(path.join(scratch, 'srcx-'))
    const members = makeWorld(src)

    for (const forceZip64 of [false, true]) {
      const ours = path.join(scratch, `ours-${forceZip64}.zip`)
      await createZip(ours, src, members, { forceZip64 })
      const out = fs.mkdtempSync(path.join(scratch, 'theirs-out-'))
      const res = other === 'bsdtar'
        ? spawnSync(tarBinary(), ['-xf', ours, '-C', out], { encoding: 'utf8' })
        : spawnSync('python3', ['-m', 'zipfile', '-e', ours, out], { encoding: 'utf8' })
      assert.equal(res.status, 0, res.stderr)
      const got = listing(out)
      const expected = listing(src)
      // Python's extractor creates folders only for files; an empty one is not part of the comparison.
      for (const map of [got, expected]) for (const key of Object.keys(map)) if (map[key] === 'dir') delete map[key]
      assert.deepEqual(got, expected, `zip64=${forceZip64}`)
    }

    const theirs = path.join(scratch, 'theirs.zip')
    const res = other === 'bsdtar'
      ? spawnSync(tarBinary(), ['-a', '-cf', theirs, ...members], { cwd: src, encoding: 'utf8' })
      : spawnSync('python3', ['-m', 'zipfile', '-c', theirs, ...members], { cwd: src, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const out = fs.mkdtempSync(path.join(scratch, 'ours-out-'))
    await extractZip(theirs, out)
    const got = listing(out)
    const expected = listing(src)
    for (const map of [got, expected]) for (const key of Object.keys(map)) if (map[key] === 'dir') delete map[key]
    assert.deepEqual(got, expected)
  })
