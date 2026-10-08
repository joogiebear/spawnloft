import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyTree, compareTrees, treeStats, removeTree } from '../src/tree.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-tree-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const onWindows = process.platform === 'win32'
// A directory link: a junction on Windows (no elevation needed), a symlink elsewhere.
const dirLink = (target, at) => fs.symlinkSync(target, at, onWindows ? 'junction' : 'dir')
const T0 = new Date('2026-03-14T09:26:53.500Z')

let n = 0
/** A tree that holds one of everything a server folder holds. Returns its root. */
function sample() {
  const root = path.join(scratch, `src-${++n}`)
  const put = (rel, content, when) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    fs.utimesSync(file, when, when)
  }
  put('instances.json', '{"version":1,"instances":{}}\n', new Date(T0.getTime() + 1000))
  put('instances/Srv/server.properties', 'motd=hello\n', new Date(T0.getTime() + 2000))
  put('instances/Srv/world/region/r.0.0.mca', 'x'.repeat(5000), new Date(T0.getTime() + 3000))
  put('instances/Srv/plugins/.mcctl-plugins.json', '{}', new Date(T0.getTime() + 4000))
  put('instances/Srv/zero.bin', '', new Date(T0.getTime() + 5000))
  put('backups/Srv/old_2026-01-01.tar.gz', 'a'.repeat(300), new Date('2026-01-01T00:00:00Z'))
  put('backups/Srv/new_2026-02-01.tar.gz', 'b'.repeat(300), new Date('2026-02-01T00:00:00Z'))
  put('run/Srv/ünïcode name.log', 'log\n', new Date(T0.getTime() + 6000))
  fs.mkdirSync(path.join(root, 'templates', 'empty'), { recursive: true })
  return root
}

test('a copy has the same files, sizes and contents', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-1')
  const done = await copyTree(src, dest)
  assert.equal(done.files, 8)
  assert.equal(done.bytes, 29 + 11 + 5000 + 2 + 0 + 300 + 300 + 4)
  assert.equal(fs.readFileSync(path.join(dest, 'instances/Srv/server.properties'), 'utf8'), 'motd=hello\n')
  assert.equal(fs.readFileSync(path.join(dest, 'run/Srv/ünïcode name.log'), 'utf8'), 'log\n')
  assert.ok(fs.statSync(path.join(dest, 'templates/empty')).isDirectory(), 'an empty folder is still there')
  assert.equal(fs.statSync(path.join(dest, 'instances/Srv/zero.bin')).size, 0)
  assert.deepEqual(await compareTrees(src, dest), { ok: true, problems: [], files: 8 })
})

test('modification times are kept, because backup history is ordered by them', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-2')
  await copyTree(src, dest)
  for (const rel of ['instances.json', 'backups/Srv/old_2026-01-01.tar.gz', 'backups/Srv/new_2026-02-01.tar.gz', 'instances/Srv/world/region/r.0.0.mca']) {
    const a = fs.statSync(path.join(src, rel)).mtimeMs
    const b = fs.statSync(path.join(dest, rel)).mtimeMs
    assert.ok(Math.abs(a - b) < 2, `${rel}: ${a} vs ${b}`)
  }
  const order = (root) => fs.readdirSync(path.join(root, 'backups/Srv')).filter((f) => f.endsWith('.tar.gz'))
    .sort((x, y) => fs.statSync(path.join(root, 'backups/Srv', y)).mtimeMs - fs.statSync(path.join(root, 'backups/Srv', x)).mtimeMs)
  assert.deepEqual(order(dest), order(src), '"latest" is the same snapshot after the copy')
})

test('the times are set by the copy itself, not left to whatever the platform\'s file copy does', async (t) => {
  // Windows' own copy keeps a file's time and Linux's does not, so on one of them a copier that
  // forgot would pass. This one gives the copy the time it was made, as Linux does.
  t.mock.method(fs.promises, 'copyFile', async (from, to) => {
    fs.writeFileSync(to, fs.readFileSync(from), { flag: 'wx' })
  })
  const src = sample()
  const dest = path.join(scratch, 'dest-times')
  await copyTree(src, dest)
  for (const rel of ['instances.json', 'backups/Srv/old_2026-01-01.tar.gz', 'instances/Srv/world/region/r.0.0.mca']) {
    assert.ok(Math.abs(fs.statSync(path.join(src, rel)).mtimeMs - fs.statSync(path.join(dest, rel)).mtimeMs) < 2, rel)
  }
  assert.deepEqual(await compareTrees(src, dest), { ok: true, problems: [], files: 8 })
})

test('a folder\'s own modification time is restored after its contents are put in it', async () => {
  const src = sample()
  const dir = path.join(src, 'instances/Srv/world')
  fs.utimesSync(dir, T0, T0)
  const dest = path.join(scratch, 'dest-3')
  await copyTree(src, dest)
  assert.ok(Math.abs(fs.statSync(path.join(dest, 'instances/Srv/world')).mtimeMs - T0.getTime()) < 2)
})

test('a link inside the tree is recreated as a link, with the target it had, not followed', async () => {
  const src = sample()
  const real = path.join(src, 'instances/Srv/real-dir')
  fs.mkdirSync(real)
  fs.writeFileSync(path.join(real, 'inside.txt'), 'only once')
  dirLink(real, path.join(src, 'instances/Srv/via-link'))
  const dest = path.join(scratch, 'dest-4')
  const done = await copyTree(src, dest)
  assert.equal(done.links, 1)
  const copied = path.join(dest, 'instances/Srv/via-link')
  assert.ok(fs.lstatSync(copied).isSymbolicLink(), 'still a link')
  assert.equal(path.normalize(fs.readlinkSync(copied)).replace(/[\\/]+$/, ''), path.normalize(real).replace(/[\\/]+$/, ''), 'the target it had')
  assert.equal(done.files, 9, 'the file behind the link is counted once, not twice')
  assert.equal(fs.readdirSync(path.join(dest, 'instances/Srv/real-dir')).length, 1)
})

test('a link to a file is kept too', { skip: onWindows && 'links to files need elevation on Windows' }, async () => {
  const src = sample()
  fs.symlinkSync('server.properties', path.join(src, 'instances/Srv/props-link'))
  const dest = path.join(scratch, 'dest-5')
  await copyTree(src, dest)
  assert.equal(fs.readlinkSync(path.join(dest, 'instances/Srv/props-link')), 'server.properties', 'a relative target stays relative')
})

test('something that is neither a file, a folder nor a link is reported, not silently left out', { skip: onWindows && 'no named pipes to make here' }, async () => {
  const src = sample()
  const made = spawnSync('mkfifo', [path.join(src, 'run/Srv/pipe')])
  if (made.status !== 0) return
  const dest = path.join(scratch, 'dest-6')
  const done = await copyTree(src, dest)
  assert.deepEqual(done.skipped, [{ path: path.join('run', 'Srv', 'pipe'), reason: 'not a file, folder or link' }])
})

test('a file that cannot be read is retried, and then named with every other one that failed', async (t) => {
  const src = sample()
  const dest = path.join(scratch, 'dest-7')
  const real = fs.promises.copyFile
  let tries = 0
  t.mock.method(fs.promises, 'copyFile', async (from, to, mode) => {
    if (from.endsWith('server.properties')) {
      tries++
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    if (from.endsWith('r.0.0.mca')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return real(from, to, mode)
  })
  await assert.rejects(copyTree(src, dest, { retryDelays: [0, 0] }), (err) => {
    assert.equal(tries, 3, 'tried, then twice more')
    assert.equal(err.problems.length, 2)
    assert.ok(err.problems.some((p) => p.includes('server.properties') && p.includes('EBUSY')))
    assert.ok(err.problems.some((p) => p.includes('r.0.0.mca') && p.includes('EACCES')))
    assert.match(err.message, /2 files could not be copied/)
    return true
  })
})

test('a lock that lets go in time is not a failure', async (t) => {
  const src = sample()
  const dest = path.join(scratch, 'dest-8')
  const real = fs.promises.copyFile
  let refused = 0
  t.mock.method(fs.promises, 'copyFile', async (from, to, mode) => {
    if (from.endsWith('zero.bin') && refused++ < 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(from, to, mode)
  })
  const done = await copyTree(src, dest, { retryDelays: [0, 0] })
  assert.equal(done.files, 8)
  assert.equal(refused, 3)
})

test('copying never overwrites: a destination that already holds a file is an error', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-9')
  fs.mkdirSync(path.join(dest, 'instances/Srv'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'instances/Srv/server.properties'), 'precious')
  await assert.rejects(copyTree(src, dest, { retryDelays: [] }), /already exists/)
  assert.equal(fs.readFileSync(path.join(dest, 'instances/Srv/server.properties'), 'utf8'), 'precious')
})

test('progress is reported with the totals', async () => {
  const src = sample()
  const seen = []
  await copyTree(src, path.join(scratch, 'dest-10'), { onProgress: (p) => seen.push({ ...p }) })
  assert.ok(seen.length > 0)
  const last = seen.at(-1)
  assert.equal(last.files, 8)
  assert.equal(last.totalFiles, 8)
  assert.equal(last.bytes, last.totalBytes)
})

// ---- comparing ------------------------------------------------------------------------------

test('a comparison finds a file that is missing, one that is extra, and one that changed size', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-c1')
  await copyTree(src, dest)
  fs.rmSync(path.join(dest, 'run/Srv/ünïcode name.log'))
  fs.writeFileSync(path.join(dest, 'extra.txt'), 'x')
  fs.appendFileSync(path.join(dest, 'instances/Srv/world/region/r.0.0.mca'), 'more')
  const result = await compareTrees(src, dest)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => /missing/.test(p) && p.includes('ünïcode name.log')))
  assert.ok(result.problems.some((p) => /not in the original/.test(p) && p.includes('extra.txt')))
  assert.ok(result.problems.some((p) => /size/.test(p) && p.includes('r.0.0.mca')))
})

test('a comparison finds a changed byte in a small file even when size and time are the same', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-c2')
  await copyTree(src, dest)
  const file = path.join(dest, 'instances.json')
  const when = fs.statSync(file).mtime
  fs.writeFileSync(file, '{"version":2,"instances":{}}\n')
  fs.utimesSync(file, when, when)
  assert.equal(fs.statSync(file).size, fs.statSync(path.join(src, 'instances.json')).size)
  const result = await compareTrees(src, dest)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => /contents differ/.test(p) && p.includes('instances.json')))
})

test('a larger file is compared by size and time, and by contents only when asked', async () => {
  const src = sample()
  const big = path.join(src, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 7))
  fs.utimesSync(big, T0, T0)
  const dest = path.join(scratch, 'dest-c3')
  await copyTree(src, dest)
  const copy = path.join(dest, 'big.bin')
  const flipped = Buffer.alloc(2 * 1024 * 1024, 7)
  flipped[1000] = 8
  fs.writeFileSync(copy, flipped)
  fs.utimesSync(copy, T0, T0)
  assert.equal((await compareTrees(src, dest)).ok, true, 'same size, same time: the quick comparison cannot see it')
  const thorough = await compareTrees(src, dest, { thorough: true })
  assert.equal(thorough.ok, false)
  assert.ok(thorough.problems.some((p) => /contents differ/.test(p) && p.includes('big.bin')))
})

test('a comparison finds a time that was not kept', async () => {
  const src = sample()
  const dest = path.join(scratch, 'dest-c4')
  await copyTree(src, dest)
  const file = path.join(dest, 'backups/Srv/old_2026-01-01.tar.gz')
  const now = new Date()
  fs.utimesSync(file, now, now)
  const result = await compareTrees(src, dest)
  assert.ok(result.problems.some((p) => /modified time/.test(p) && p.includes('old_2026-01-01')))
})

test('a comparison finds a link that points somewhere else', async () => {
  const src = sample()
  fs.mkdirSync(path.join(src, 'a'))
  fs.mkdirSync(path.join(src, 'b'))
  dirLink(path.join(src, 'a'), path.join(src, 'go'))
  const dest = path.join(scratch, 'dest-c5')
  await copyTree(src, dest)
  fs.rmSync(path.join(dest, 'go'), { force: true })
  dirLink(path.join(dest, 'b'), path.join(dest, 'go'))
  const result = await compareTrees(src, dest)
  assert.ok(result.problems.some((p) => /link/.test(p) && p.includes('go')))
})

test('a comparison reports a bounded number of problems, and says how many there were', async () => {
  const src = sample()
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(src, `f${i}.txt`), 'x')
  const dest = path.join(scratch, 'dest-c6')
  fs.mkdirSync(dest)
  const result = await compareTrees(src, dest)
  assert.equal(result.ok, false)
  assert.equal(result.problems.length, 51)
  assert.match(result.problems.at(-1), /and \d+ more/)
})

// ---- the rest ----------------------------------------------------------------------------------

test('treeStats counts files, folders, links and bytes without following links', async () => {
  const src = sample()
  const real = path.join(src, 'instances/Srv/real-dir')
  fs.mkdirSync(real)
  fs.writeFileSync(path.join(real, 'inside.txt'), '12345')
  dirLink(real, path.join(src, 'instances/Srv/via-link'))
  const stats = await treeStats(src)
  assert.equal(stats.files, 9)
  assert.equal(stats.links, 1)
  assert.equal(stats.bytes, 29 + 11 + 5000 + 2 + 0 + 300 + 300 + 4 + 5)
  assert.ok(stats.dirs >= 9)
})

test('removing a tree that holds a link leaves what the link points at', async () => {
  const outside = path.join(scratch, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'must survive')
  const tree = path.join(scratch, 'doomed')
  fs.mkdirSync(path.join(tree, 'inner'), { recursive: true })
  dirLink(outside, path.join(tree, 'inner', 'link'))
  await removeTree(tree)
  assert.equal(fs.existsSync(tree), false)
  assert.equal(fs.readFileSync(path.join(outside, 'canary.txt'), 'utf8'), 'must survive')
})
