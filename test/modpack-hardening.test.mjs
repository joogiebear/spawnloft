import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// What a modpack, or a snapshot's manifest, is allowed to make this program do. Each test hands
// the code something hostile and checks what it refuses - and, where it matters, that nothing was
// written or fetched on the way to refusing.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-hardening-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { downloadVerified, stagePackFiles, parseIndex, MAX_PACK_FILE_BYTES, DEFAULT_PACK_FILE_BYTES } = await import('../src/mrpack.mjs')
const fabric = await import('../src/fabric.mjs')
const neoforge = await import('../src/neoforge.mjs')
const backup = await import('../src/backup.mjs')
const { tarMember, tarBinary } = await import('../src/tar.mjs')
const services = await import('../src/services.mjs')
const { JARS_DIR } = await import('../src/paths.mjs')
const { UserError } = await import('../src/util.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const folder = (name) => {
  const dir = path.join(scratch, `${name}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const sha = (kind, data) => crypto.createHash(kind).update(data).digest('hex')
const URL_OK = 'https://cdn.modrinth.com/data/x/versions/y/file.jar'

// ---- downloadVerified -----------------------------------------------------------------------

/** A fetch that answers from a script: each call takes the next entry, and records what it was asked. */
function scripted(...answers) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected request for ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  }
  impl.calls = calls
  return impl
}
const reply = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers })
const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to } })

/** A body that never ends, and records whether anyone stopped reading it. */
function endless() {
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream({
    pull(controller) {
      state.pulled++
      controller.enqueue(new Uint8Array(64 * 1024))
    },
    cancel() { state.cancelled = true },
  })
  return { body, state }
}

test('a download that matches its size and checksums lands under its name, with no .part left', async () => {
  const data = Buffer.from('a mod, more or less')
  const dest = path.join(folder('ok'), 'file')
  const fetchImpl = scripted(reply(data))
  const out = await downloadVerified(URL_OK, dest, { size: data.length, sha1: sha('sha1', data), sha512: sha('sha512', data), fetchImpl })
  assert.equal(out.bytes, data.length)
  assert.deepEqual(fs.readFileSync(dest), data)
  assert.equal(fs.existsSync(`${dest}.part`), false)
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual', 'redirects are followed by hand, not by fetch')
})

test('a checksum that does not match leaves nothing under the name or beside it', async () => {
  const data = Buffer.from('tampered')
  const dir = folder('badsum')
  const dest = path.join(dir, 'file')
  for (const sums of [{ sha1: sha('sha1', 'other') }, { sha512: sha('sha512', 'other') }, { sha1: sha('sha1', data), sha512: sha('sha512', 'other') }]) {
    await assert.rejects(
      downloadVerified(URL_OK, dest, { size: data.length, label: 'mods/x.jar', ...sums, fetchImpl: scripted(reply(data)) }),
      /mods\/x\.jar" did not match the checksum/,
    )
  }
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('every checksum the pack published is checked, not just the first', async () => {
  const data = Buffer.from('x')
  await assert.rejects(
    downloadVerified(URL_OK, path.join(folder('both'), 'f'), { sha1: sha('sha1', data), sha512: '0'.repeat(128), fetchImpl: scripted(reply(data)) }),
    /did not match/,
  )
})

test('a file that is not the size the pack declared is refused, short or long', async () => {
  const dir = folder('size')
  for (const [declared, body] of [[10, 'short'], [3, 'longer than that']]) {
    await assert.rejects(
      downloadVerified(URL_OK, path.join(dir, 'f'), { size: declared, sha1: sha('sha1', body), fetchImpl: scripted(reply(body)) }),
      /larger than|not the size/,
    )
  }
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('a download that never ends is cut off at the declared size, and its body is let go', async () => {
  const dir = folder('endless')
  const { body, state } = endless()
  await assert.rejects(
    downloadVerified(URL_OK, path.join(dir, 'f'), { size: 100 * 1024, sha1: 'a'.repeat(40), label: 'mods/loop.jar', fetchImpl: scripted(reply(body)) }),
    /mods\/loop\.jar" is larger than the 100\.0 KB/,
  )
  assert.ok(state.pulled < 20, `kept reading: ${state.pulled} chunks`)
  assert.deepEqual(fs.readdirSync(dir), [], 'no partial file kept')
})

test('with no declared size the default cap still applies', async () => {
  const { body, state } = endless()
  const fetchImpl = scripted(reply(body))
  await assert.rejects(
    downloadVerified(URL_OK, path.join(folder('nosize'), 'f'), { sha1: 'a'.repeat(40), fetchImpl }),
    /is larger than/,
  )
  assert.ok(state.cancelled || state.pulled >= DEFAULT_PACK_FILE_BYTES / (64 * 1024))
})

test('a length announced up front over the cap is refused, and the body is let go unread', async () => {
  const dir = folder('announced')
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(
    downloadVerified(URL_OK, path.join(dir, 'f'), { size: 1000, sha1: 'a'.repeat(40), fetchImpl: scripted(reply(body, { headers: { 'content-length': '999999' } })) }),
    /is larger than/,
  )
  assert.equal(cancelled, true)
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written')
})

test('a declared size past the hard limit is refused before any request', async () => {
  const fetchImpl = scripted()
  await assert.rejects(
    downloadVerified(URL_OK, path.join(folder('huge'), 'f'), { size: MAX_PACK_FILE_BYTES + 1, sha1: 'a'.repeat(40), fetchImpl }),
    /more than the 1\.0 GB/,
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('redirects are followed to another https host, as a CDN needs', async () => {
  const data = Buffer.from('from the asset host')
  const fetchImpl = scripted(
    redirect('https://release-assets.githubusercontent.com/abc'),
    redirect('/relative/path'),
    reply(data),
  )
  const dest = path.join(folder('hop'), 'f')
  await downloadVerified('https://github.com/o/r/releases/download/v/f.jar', dest, { sha1: sha('sha1', data), fetchImpl })
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [
    'https://github.com/o/r/releases/download/v/f.jar',
    'https://release-assets.githubusercontent.com/abc',
    'https://release-assets.githubusercontent.com/relative/path',
  ])
  assert.deepEqual(fs.readFileSync(dest), data)
})

test('a redirect to anything but https on the internet is refused, and never requested', async () => {
  for (const to of [
    'http://cdn.modrinth.com/x.jar',
    'https://localhost/x',
    'https://127.0.0.1:8080/admin',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://172.16.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://user:pass@cdn.modrinth.com/x',
    'file:///etc/passwd',
  ]) {
    const fetchImpl = scripted(redirect(to), reply('never asked for'))
    await assert.rejects(
      downloadVerified(URL_OK, path.join(folder('redir'), 'f'), { sha1: 'a'.repeat(40), fetchImpl }),
      /refused|is not a URL/,
      to,
    )
    assert.equal(fetchImpl.calls.length, 1, `${to} was requested`)
  }
})

test('a redirect loop is given up on', async () => {
  const fetchImpl = scripted(...Array.from({ length: 10 }, () => redirect(URL_OK)))
  await assert.rejects(
    downloadVerified(URL_OK, path.join(folder('loop'), 'f'), { sha1: 'a'.repeat(40), fetchImpl, maxRedirects: 3 }),
    /too many redirects/,
  )
  assert.equal(fetchImpl.calls.length, 4)
})

test('the first address is held to https on the internet too', async () => {
  const fetchImpl = scripted()
  for (const bad of ['http://cdn.modrinth.com/x.jar', 'https://localhost/x', 'ftp://x/y']) {
    await assert.rejects(downloadVerified(bad, path.join(folder('first'), 'f'), { sha1: 'a'.repeat(40), fetchImpl }), UserError)
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test('an error status, and a transport failure, are readable refusals that leave nothing behind', async () => {
  const dir = folder('errs')
  await assert.rejects(downloadVerified(URL_OK, path.join(dir, 'f'), { fetchImpl: scripted(reply('no', { status: 404 })) }), /download failed: 404/)
  await assert.rejects(downloadVerified(URL_OK, path.join(dir, 'f'), { fetchImpl: scripted(() => { throw new Error('socket hang up') }) }), /download failed: socket hang up/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

// ---- staging a whole pack ------------------------------------------------------------------------

const packOf = (files) => parseIndex({
  game: 'minecraft',
  name: 'Staged',
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
  files: files.map(([p, data, extra = {}]) => ({
    path: p,
    hashes: { sha1: sha('sha1', data), sha512: sha('sha512', data) },
    downloads: [`https://cdn.modrinth.com/data/${encodeURIComponent(p)}`],
    fileSize: Buffer.byteLength(data),
    ...extra,
  })),
})

test('a pack is staged to files on disk, each verified, ready to be copied into place', async () => {
  const tmp = folder('stage')
  const index = packOf([['mods/a.jar', 'alpha'], ['config/b.toml', 'bravo = 1']])
  const bodies = new Map([['alpha', 'alpha'], ['bravo = 1', 'bravo = 1']])
  const fetchImpl = scripted(reply(bodies.get('alpha')), reply(bodies.get('bravo = 1')))
  const progress = []
  const staged = await stagePackFiles(index, tmp, (p) => progress.push(p.message), { fetchImpl })

  assert.deepEqual(staged.map((f) => f.path), ['mods/a.jar', 'config/b.toml'])
  assert.deepEqual(staged.map((f) => fs.readFileSync(f.file, 'utf8')), ['alpha', 'bravo = 1'])
  for (const f of staged) assert.ok(f.file.startsWith(tmp), 'inside the scratch folder the caller removes')
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'staged')).sort(), ['0', '1'], 'no .part files left')
  assert.equal(progress.length, 2)
})

test('one bad file in a pack stops the staging and names the file', async () => {
  const tmp = folder('stage-bad')
  const index = packOf([['mods/a.jar', 'alpha'], ['mods/b.jar', 'bravo']])
  const fetchImpl = scripted(reply('alpha'), reply('bravX')) // the right length, so only the checksum can catch it
  await assert.rejects(stagePackFiles(index, tmp, () => {}, { fetchImpl }), /"mods\/b\.jar" did not match the checksum/)
  assert.equal(fetchImpl.calls.length, 2)
})

// ---- loader versions reach the jars store only as versions -------------------------------------

test('a loader or game version that is not a version is refused before any request or write', async (t) => {
  const asked = []
  t.mock.method(globalThis, 'fetch', async (url) => { asked.push(String(url)); throw new Error('no network in this test') })
  const before = fs.existsSync(JARS_DIR) ? fs.readdirSync(JARS_DIR) : []

  for (const bad of ['1/../x', '../../escape', 'a/b', '..', 'x y', '1.0?x=1']) {
    await assert.rejects(fabric.fetchLauncher('1.21.1', { loader: bad }), /not a valid version/, `fabric loader ${bad}`)
    await assert.rejects(fabric.fetchLauncher(bad, { loader: '0.16.9' }), /not a valid version/, `fabric game ${bad}`)
    await assert.rejects(neoforge.fetchInstaller(bad), /not a valid version/, `neoforge ${bad}`)
  }
  assert.deepEqual(asked, [], 'nothing was fetched')
  assert.deepEqual(fs.existsSync(JARS_DIR) ? fs.readdirSync(JARS_DIR) : [], before, 'nothing was written')
  assert.equal(fs.existsSync(path.join(scratch, 'x')), false)
})

// ---- tar members -------------------------------------------------------------------------------

test('a name that tar would read as an option or an archive gets a ./ in front, and no other does', () => {
  assert.equal(tarMember('--checkpoint-action=exec=sh x'), './--checkpoint-action=exec=sh x')
  assert.equal(tarMember('-T'), './-T')
  assert.equal(tarMember('-C'), './-C')
  assert.equal(tarMember('@other.tar'), './@other.tar')
  for (const plain of ['world', 'plugins', 'server.properties', 'my-world', 'a@b', 'a-b', '.hidden', './already']) {
    assert.equal(tarMember(plain), plain)
  }
})

test('a full backup of a folder holding option-shaped file names runs nothing and keeps the files', async () => {
  const dir = folder('hostile')
  // tar runs in the server folder, so a command that creates a file by its bare name creates it here.
  const proof = path.join(dir, 'PWNED')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\n')
  fs.mkdirSync(path.join(dir, 'world'))
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world')
  // On GNU tar these three together run `touch PWNED` once per file archived.
  fs.writeFileSync(path.join(dir, '--checkpoint=1'), 'x')
  fs.writeFileSync(path.join(dir, '--checkpoint-action=exec=touch PWNED'), 'x')
  fs.writeFileSync(path.join(dir, '--use-compress-program=touch PWNED2'), 'x')

  const snap = await backup.createSnapshot({ name: 'hardening-hostile', dir }, { scope: 'full', flush: false })

  assert.equal(fs.existsSync(proof), false, 'tar ran a command named by a file')
  assert.equal(fs.existsSync(path.join(dir, 'PWNED2')), false)
  const listing = spawnSync(tarBinary(), ['-tzf', snap.file], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  const entries = listing.stdout.split('\n').filter(Boolean)
  assert.ok(entries.some((e) => e === 'world/level.dat'), 'ordinary members keep their names')
  assert.ok(entries.some((e) => e === 'server.properties'))
  assert.ok(entries.some((e) => e.endsWith('--checkpoint=1')), 'the odd file was archived, not skipped')
  assert.ok(entries.some((e) => e.endsWith('--use-compress-program=touch PWNED2')))
})

test('a leading @ is a file name, not an archive to copy from', async () => {
  const dir = folder('at')
  fs.mkdirSync(path.join(dir, 'world'))
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world')
  fs.writeFileSync(path.join(dir, '@secret.tar'), 'not a tar archive, and must not be read as one')
  const snap = await backup.createSnapshot({ name: 'hardening-at', dir }, { scope: 'full', flush: false })
  const listing = spawnSync(tarBinary(), ['-tzf', snap.file], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.ok(listing.stdout.split('\n').some((e) => e.endsWith('@secret.tar')))
})

// ---- what a snapshot's manifest may name ----------------------------------------------------------

const dump = (file) => ({ service: 'db', engine: 'mariadb', version: '11', database: 'd', user: 'u', file, bytes: 1 })

test('a manifest dump path that climbs out of the server folder is not imported', async () => {
  const base = folder('dump-base')
  const outside = path.join(scratch, `outside-${crypto.randomBytes(3).toString('hex')}.sql`)
  fs.writeFileSync(outside, 'DROP DATABASE everything;')
  const rel = path.relative(base, outside)
  const dumps = [rel, rel.replace(/\\/g, '/'), outside, 'databases/../../x.sql', '../x.sql', '/etc/passwd', 'C:/x.sql', 'other/x.sql', '', 'databases'].map(dump)
  const { imported, skipped } = await services.importDumps('anything', dumps, base)
  assert.deepEqual(imported, [])
  assert.equal(skipped.length, dumps.length)
  for (const s of skipped) assert.match(s.reason, /outside|not imported/, JSON.stringify(s.file))
  assert.equal(fs.readFileSync(outside, 'utf8'), 'DROP DATABASE everything;', 'and nothing touched it')
})

test('a dump that is a link out of the server folder is not imported', async (t) => {
  const base = folder('dump-link')
  const outside = path.join(folder('dump-link-target'), 'evil.sql')
  fs.writeFileSync(outside, 'SELECT 1;')
  fs.mkdirSync(path.join(base, 'databases'))
  try {
    fs.symlinkSync(outside, path.join(base, 'databases', 'x__y.sql'))
  } catch {
    t.skip('this account cannot create symbolic links')
    return
  }
  const { imported, skipped } = await services.importDumps('anything', [dump('databases/x__y.sql')], base)
  assert.deepEqual(imported, [])
  assert.match(skipped[0].reason, /leads outside the server folder/)
})

test('a dump where a snapshot puts it is still looked for', async () => {
  const base = folder('dump-ok')
  const { skipped } = await services.importDumps('anything', [dump('databases/db__d.sql')], base)
  assert.match(skipped[0].reason, /missing from the archive/, 'it got past the path check')
})

test('a clean restore will not clear a path the manifest names outside the server folder', async () => {
  const dir = folder('restore-inst')
  const victim = path.join(folder('restore-victim'), 'precious')
  fs.writeFileSync(victim, 'keep me')
  fs.mkdirSync(path.join(dir, 'world'))
  for (const members of [[path.relative(dir, victim)], ['world', '../../../etc'], ['/tmp'], ['C:/Windows']]) {
    const snapshot = { name: 'forged', path: path.join(dir, 'nope.tar.gz'), members, databases: [] }
    await assert.rejects(
      backup.restoreSnapshot({ name: 'hardening-restore', dir }, snapshot, { clean: true, quiet: true }),
      /not inside the server folder, so it cannot clear anything first; nothing was changed/,
      JSON.stringify(members),
    )
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me')
  assert.ok(fs.existsSync(path.join(dir, 'world')))
})
