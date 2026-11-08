import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { exportConsole, shareConsole, trimForUpload, redactAccountName, MAX_LINES, MAX_BYTES } from '../src/mclogs.mjs'
import { UserError } from '../src/util.mjs'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-mclogs-'))

function fixture(consoleText) {
  const dir = scratch()
  const sourceFile = path.join(dir, 'console.log')
  if (consoleText != null) fs.writeFileSync(sourceFile, consoleText)
  return {
    inst: { name: 'mclogs-test-not-registered', dir },
    sourceFile,
    outDir: path.join(dir, 'exports'),
    tokenFile: path.join(dir, 'mclogs.json'),
  }
}

function stubFetch(body, { status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  impl.calls = calls
  return impl
}

test('exporting writes the console beside the snapshots and reports where it went', () => {
  const f = fixture('[12:00:00] [Server thread/INFO]: Done\n[12:00:01] hello\n')
  const out = exportConsole(f.inst, { sourceFile: f.sourceFile, outDir: f.outDir })
  assert.ok(fs.existsSync(out.file), 'the export file exists')
  assert.equal(path.dirname(out.file), f.outDir)
  assert.match(path.basename(out.file), /^mclogs-test-not-registered_console_\d{4}-\d{2}-\d{2}_\d{6}\.log$/)
  assert.equal(fs.readFileSync(out.file, 'utf8'), fs.readFileSync(f.sourceFile, 'utf8'))
  assert.equal(out.lines, 2)
  assert.ok(out.sizeHuman.endsWith('B'), `sizeHuman was ${out.sizeHuman}`)
})

test('exporting keeps the file byte for byte, carriage returns included', () => {
  const text = 'line one\r\nline two\r\n'
  const f = fixture(text)
  const out = exportConsole(f.inst, { sourceFile: f.sourceFile, outDir: f.outDir })
  assert.equal(fs.readFileSync(out.file, 'utf8'), text)
  assert.equal(out.lines, 2)
})

test('exporting a server that has never run says so instead of writing an empty file', () => {
  const f = fixture(null)
  assert.throws(() => exportConsole(f.inst, { sourceFile: f.sourceFile, outDir: f.outDir }), UserError)
  assert.equal(fs.existsSync(f.outDir), false, 'no exports folder is left behind')
})

test('exporting an empty console is refused rather than producing a 0-byte log', () => {
  const f = fixture('')
  assert.throws(() => exportConsole(f.inst, { sourceFile: f.sourceFile, outDir: f.outDir }), UserError)
})

test('a log inside both limits goes up whole', () => {
  const text = 'one\ntwo\nthree\n'
  const out = trimForUpload(text)
  assert.equal(out.content, text)
  assert.equal(out.lines, 3)
  assert.equal(out.trimmed, false)
})

test('a Windows console goes up with Unix line endings, because mclo.gs keeps a stray carriage return inside the line', () => {
  const out = trimForUpload('line one\r\nline two\r\nline three\r\n')
  assert.equal(out.content, 'line one\nline two\nline three\n')
  assert.equal(out.lines, 3)
  assert.equal(out.trimmed, false)
})

test('a lone carriage return is a line break too, not a character inside the line', () => {
  const out = trimForUpload('one\rtwo\r')
  assert.equal(out.content, 'one\ntwo\n')
  assert.equal(out.lines, 2)
})

test('too many lines keeps the tail, because the crash is at the end', () => {
  const text = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`).join('\n')
  const out = trimForUpload(text)
  assert.equal(out.lines, MAX_LINES)
  assert.equal(out.trimmed, true)
  assert.equal(out.content.split('\n').at(-1), `line ${MAX_LINES + 499}`)
  assert.equal(out.content.split('\n')[0], 'line 500')
})

test('too many bytes keeps the tail and stays under the size the API accepts', () => {
  const big = 'x'.repeat(1024 * 1024)
  const text = Array.from({ length: 12 }, (_, i) => `${i}${big}`).join('\n')
  const out = trimForUpload(text)
  assert.ok(Buffer.byteLength(out.content) <= MAX_BYTES, 'trimmed content fits the byte cap')
  assert.equal(out.trimmed, true)
  assert.equal(out.content.split('\n').at(-1)[0], '1', 'the last line survived')
})

test('sharing posts the console and hands back the link to open', async () => {
  const f = fixture('[12:00:00] [Server thread/INFO]: Done\n')
  const fetchImpl = stubFetch({ success: true, id: 'WnMMikq', url: 'https://mclo.gs/WnMMikq', token: 'deadbeef' })
  const out = await shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl })

  assert.equal(out.url, 'https://mclo.gs/WnMMikq')
  assert.equal(out.id, 'WnMMikq')
  assert.equal(out.lines, 1)
  assert.equal(out.trimmed, false)

  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://api.mclo.gs/1/log')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['Content-Type'], 'application/json')
  assert.match(call.init.headers['User-Agent'], /spawnloft/i)
  const sent = JSON.parse(call.init.body)
  assert.equal(sent.content, '[12:00:00] [Server thread/INFO]: Done\n')
  assert.equal(sent.source, 'mcctl')
})

test('the delete token is recorded, because it is the only way the log is ever removable', async () => {
  const f = fixture('a line\n')
  const fetchImpl = stubFetch({ success: true, id: 'WnMMikq', url: 'https://mclo.gs/WnMMikq', token: 'deadbeef' })
  await shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl })

  const kept = JSON.parse(fs.readFileSync(f.tokenFile, 'utf8'))
  assert.equal(kept.length, 1)
  assert.equal(kept[0].id, 'WnMMikq')
  assert.equal(kept[0].token, 'deadbeef')
  assert.equal(kept[0].instance, 'mclogs-test-not-registered')
  assert.ok(kept[0].at, 'when it was shared is recorded')
})

test('a second share appends rather than losing the first token', async () => {
  const f = fixture('a line\n')
  const one = stubFetch({ success: true, id: 'aaa', url: 'https://mclo.gs/aaa', token: 't1' })
  const two = stubFetch({ success: true, id: 'bbb', url: 'https://mclo.gs/bbb', token: 't2' })
  await shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl: one })
  await shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl: two })

  const kept = JSON.parse(fs.readFileSync(f.tokenFile, 'utf8'))
  assert.deepEqual(kept.map((k) => k.id), ['aaa', 'bbb'])
})

test("mclo.gs refusing the log is reported in mclo.gs's own words", async () => {
  const f = fixture('a line\n')
  const fetchImpl = stubFetch({ success: false, error: "Required field 'content' not found." }, { status: 400 })
  await assert.rejects(
    () => shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl }),
    (err) => err instanceof UserError && /Required field 'content' not found\./.test(err.message),
  )
})

test('an unreachable mclo.gs is a plain sentence, not a raw fetch rejection', async () => {
  const f = fixture('a line\n')
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(
    () => shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl }),
    (err) => err instanceof UserError && /mclo\.gs/.test(err.message),
  )
})

test('sharing a server that has never run is refused before anything is sent', async () => {
  const f = fixture(null)
  const fetchImpl = stubFetch({ success: true, id: 'x', url: 'https://mclo.gs/x', token: 't' })
  await assert.rejects(
    () => shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl }),
    UserError,
  )
  assert.equal(fetchImpl.calls.length, 0, 'nothing left the machine')
})

// The account name is in every path a server logs. It is removed before the log goes public;
// nothing else is touched, because nothing else is promised.
test('the account name is taken out of paths, on both kinds of machine', () => {
  assert.equal(
    redactAccountName('at C:\\Users\\Josh Smith\\AppData\\Local\\spawnloft\\instances\\smp\\plugins\\x.jar'),
    'at C:\\Users\\<user>\\AppData\\Local\\spawnloft\\instances\\smp\\plugins\\x.jar',
  )
  assert.equal(redactAccountName('cwd=D:/Users/josh/servers'), 'cwd=D:/Users/<user>/servers')
  assert.equal(redactAccountName('home is C:\\Users\\josh'), 'home is C:\\Users\\<user>')
  assert.equal(redactAccountName('/home/josh/mc/plugins and /Users/josh/mc'), '/home/<user>/mc/plugins and /Users/<user>/mc')
  // Not paths: a player called Users, a plugin folder of its own.
  assert.equal(redactAccountName('Users joined the game'), 'Users joined the game')
  assert.equal(redactAccountName('C:\\Servers\\smp\\plugins'), 'C:\\Servers\\smp\\plugins')
})

test('sharing sends the redacted log, and exporting to disk keeps the original', async () => {
  const text = 'cwd=C:\\Users\\Josh\\smp\n'
  const f = fixture(text)
  const fetchImpl = stubFetch({ success: true, id: 'x', url: 'https://mclo.gs/x', token: 't' })
  await shareConsole(f.inst, { sourceFile: f.sourceFile, tokenFile: f.tokenFile, fetchImpl })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).content, 'cwd=C:\\Users\\<user>\\smp\n')
  const out = exportConsole(f.inst, { sourceFile: f.sourceFile, outDir: f.outDir })
  assert.equal(fs.readFileSync(out.file, 'utf8'), text, 'a local export is the log as it is')
})
