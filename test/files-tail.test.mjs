/** The end of a text file too big to edit: what the read-only view in Files is given. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-files-tail-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const files = await import('../src/files.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const dir = path.join(scratch, 'srv')
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
const inst = { name: 'srv', dir, jar: 'paper.jar' }
const put = (rel, body) => fs.writeFileSync(path.join(dir, rel), body)
const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => `[12:00:00] [Server thread/INFO]: line ${from + i} ✓`).join('\n') + '\n'

test('the tail of a big log starts at a whole line and ends at the end', async () => {
  const text = lines(3 * 1024 * 1024 / 40)
  put('logs/latest.log', text)
  assert.equal((await files.readFile(inst, 'logs/latest.log')).reason, 'large')
  const out = await files.readTail(inst, 'logs/latest.log')
  assert.equal(out.whole, false)
  assert.equal(out.packed, false)
  assert.equal(out.of, Buffer.byteLength(text))
  assert.ok(out.shown <= files.TAIL_BYTES && out.shown > files.TAIL_BYTES - 200)
  assert.ok(text.endsWith(out.text))
  // no half line, and no half character where the cut fell
  assert.match(out.text, /^\[12:00:00\] \[Server thread\/INFO\]: line \d+ ✓\n/)
  assert.ok(!out.text.includes('�'))
  assert.equal(out.version, undefined)
})

test('a file smaller than the tail comes whole, first line included', async () => {
  put('logs/short.log', 'one\ntwo\n')
  const out = await files.readTail(inst, 'logs/short.log')
  assert.equal(out.whole, true)
  assert.equal(out.text, 'one\ntwo\n')
  const cut = await files.readTail(inst, 'logs/short.log', { bytes: 5 })
  assert.equal(cut.whole, false)
  assert.equal(cut.text, 'two\n')
})

test('a packed log is read through to its end', async () => {
  const text = lines(20000)
  put('logs/2026-11-13-1.log.gz', zlib.gzipSync(text))
  const out = await files.readTail(inst, 'logs/2026-11-13-1.log.gz')
  assert.equal(out.packed, true)
  assert.equal(out.whole, false)
  assert.equal(out.of, Buffer.byteLength(text))
  assert.ok(text.endsWith(out.text))
  assert.match(out.text, /^\[12:00:00\]/)
  const small = 'a\nb\n'
  put('logs/small.log.gz', zlib.gzipSync(small))
  assert.deepEqual((({ text: t, whole }) => ({ t, whole }))(await files.readTail(inst, 'logs/small.log.gz')), { t: small, whole: true })
})

test('what is not text is said to be that, not shown', async () => {
  put('region.mca', Buffer.concat([Buffer.alloc(4096), Buffer.from('tail')]))
  assert.equal((await files.readTail(inst, 'region.mca')).reason, 'binary')
  put('broken.gz', 'this is not gzip')
  assert.equal((await files.readTail(inst, 'broken.gz')).reason, 'binary')
  put('half.gz', zlib.gzipSync(lines(5000)).subarray(0, 900))
  assert.equal((await files.readTail(inst, 'half.gz')).reason, 'binary')
  // a backup archive is not a packed log
  put('world.tar.gz', zlib.gzipSync(Buffer.concat([Buffer.from('world/level.dat'), Buffer.alloc(600)])))
  assert.equal((await files.readTail(inst, 'world.tar.gz')).reason, 'binary')
})

test('the tail stays inside the server folder and reads only files', async () => {
  await assert.rejects(() => files.readTail(inst, '../srv/logs/latest.log'), /inside the server folder/)
  await assert.rejects(() => files.readTail(inst, 'logs'), /is not a file/)
  await assert.rejects(() => files.readTail(inst, 'logs/nothing.log'), /does not exist/)
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(scratch, 'outside.log'), 'secret\n')
    fs.symlinkSync(path.join(scratch, 'outside.log'), path.join(dir, 'logs', 'link.log'))
    await assert.rejects(() => files.readTail(inst, 'logs/link.log'), /leads outside/)
  }
})

test('a picture is told from its first bytes, not its name', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
  put('server-icon.png', png)
  assert.deepEqual((({ size, type }) => ({ size, type }))(await files.imageFile(inst, 'server-icon.png')), { size: png.length, type: 'image/png' })
  put('photo.dat', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]))
  assert.equal((await files.imageFile(inst, 'photo.dat')).type, 'image/jpeg')
  assert.equal(files.imageKind(Buffer.from('GIF89a' + '\0'.repeat(10), 'latin1')), 'image/gif')
  assert.equal(files.imageKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp')
  // a page or a drawing with a script in it, named like a picture, is not shown
  put('evil.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await assert.rejects(() => files.imageFile(inst, 'evil.png'), /not a picture/)
  put('page.png', '<!doctype html><script>1</script>')
  await assert.rejects(() => files.imageFile(inst, 'page.png'), /not a picture/)
  put('tiny.png', 'x')
  await assert.rejects(() => files.imageFile(inst, 'tiny.png'), /not a picture/)
  await assert.rejects(() => files.imageFile(inst, '../x.png'), /inside the server folder/)
  await assert.rejects(() => files.imageFile(inst, 'logs'), /is not a file/)
  assert.equal(files.imageKind(null), null)
})

test('the panel serves the end of a file and a picture, each as what it is', async () => {
  const registry = await import('../src/registry.mjs')
  const { serve } = await import('../src/ui.mjs')
  const { panelFetch } = await import('./helpers/panel.mjs')
  fs.writeFileSync(path.join(dir, 'paper.jar'), '')
  registry.putInstance('srv', { dir, jar: 'paper.jar', memory: '1G', port: 41790 })
  const panel = await serve({ port: 0 })
  try {
    const at = (verb, p) => `${panel.url}api/instances/srv/files/${verb}?path=${encodeURIComponent(p)}`
    const tail = await (await panelFetch(at('tail', 'logs/latest.log'))).json()
    assert.equal(tail.whole, false)
    assert.match(tail.text, /line \d+ ✓\n$/)
    const pic = await panelFetch(at('image', 'server-icon.png'))
    assert.equal(pic.status, 200)
    assert.equal(pic.headers.get('content-type'), 'image/png')
    assert.equal(pic.headers.get('x-content-type-options'), 'nosniff')
    assert.match(pic.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal((await pic.arrayBuffer()).byteLength, 72)
    // markup named like a picture is refused, not served for the browser to make something of
    const bad = await panelFetch(at('image', 'evil.png'))
    assert.ok(bad.status >= 400)
    assert.match((await bad.json()).error, /not a picture/)
    assert.ok((await panelFetch(at('image', '../x.png'))).status >= 400)
    // neither is a way to change anything
    assert.equal((await panelFetch(at('tail', 'logs/latest.log'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404)
  } finally {
    panel.server.closeAllConnections()
    await new Promise((resolve) => panel.server.close(resolve))
  }
})
