/** Stopping a long job part way: the pieces, a download, a child process, a create and a launch. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cancel-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')

const { Cancelled, isCancelled, withCancel, cancelSignal, checkCancelled, orCancelled, stopOnCancel } = await import('../src/cancel.mjs')
const { downloadFile, fetchRetry } = await import('../src/download.mjs')
const { UserError } = await import('../src/util.mjs')
const registry = await import('../src/registry.mjs')
const { JARS_DIR } = await import('../src/paths.mjs')
const { serve } = await import('../src/ui.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// a wait nothing ends, which does not keep the test run alive after it is abandoned
const long = () => new Promise((resolve) => setTimeout(resolve, 60000).unref())
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(20) }
  return false
}

// A server that sends the start of a file and then holds: a download that will not end by itself.
const held = new Set()
const slow = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': 8 * 1024 * 1024 })
  res.write(Buffer.alloc(64 * 1024, 1))
  held.add(res)
  res.on('close', () => held.delete(res))
})
await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
const slowUrl = `http://127.0.0.1:${slow.address().port}/big.jar`
after(() => {
  slow.closeAllConnections()
  slow.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('outside a job nothing is cancelled, and inside one the signal is found through awaits and timers', async () => {
  assert.equal(cancelSignal(), null)
  checkCancelled()
  assert.equal(await orCancelled(Promise.resolve(3)), 3)
  const c = new AbortController()
  await withCancel(c.signal, async () => {
    await sleep(5)
    assert.equal(cancelSignal(), c.signal)
    checkCancelled()
    await new Promise((resolve) => setTimeout(() => { assert.equal(cancelSignal(), c.signal); resolve() }, 5))
    c.abort()
    assert.throws(() => checkCancelled(), (err) => err instanceof Cancelled && err instanceof UserError && err.code === 'cancelled' && isCancelled(err))
  })
  // the job is over: its signal does not leak into what runs next
  assert.equal(cancelSignal(), null)
  assert.equal(isCancelled(new Error('x')), false)
})

test('a wait ends when the job is cancelled, and is left alone when it is not', async () => {
  const c = new AbortController()
  const waited = withCancel(c.signal, () => orCancelled(long()))
  setTimeout(() => c.abort(), 20)
  await assert.rejects(waited, Cancelled)
  const d = new AbortController()
  assert.equal(await withCancel(d.signal, () => orCancelled(sleep(10).then(() => 'done'))), 'done')
  await assert.rejects(withCancel(d.signal, () => orCancelled(Promise.reject(new Error('its own failure')))), /its own failure/)
  d.abort()
  await assert.rejects(withCancel(d.signal, () => orCancelled(long())), Cancelled)
})

test('a download is stopped half way and its half is removed', async () => {
  const dest = path.join(scratch, 'big.jar')
  const c = new AbortController()
  const parts = () => fs.readdirSync(scratch).filter((f) => f.startsWith('big.jar.') && f.endsWith('.part'))
  const going = withCancel(c.signal, () => downloadFile(slowUrl, dest, { label: 'big.jar' }))
  assert.ok(await until(() => parts().some((f) => fs.statSync(path.join(scratch, f)).size > 0), 15000), 'the download never started')
  // someone else fetching the same file at the same time, in no job: theirs is not touched
  const other = downloadFile(slowUrl, dest, { label: 'big.jar' })
  other.catch(() => {})
  assert.ok(await until(() => parts().length === 2, 15000), 'the second download never started')
  c.abort()
  await assert.rejects(going, Cancelled)
  assert.equal(parts().length, 1, 'the cancelled half was left, or the other download lost its file')
  assert.equal(fs.existsSync(dest), false)
  // the other one is ended from the far side, and that is a failure, not a cancel
  for (const res of held) res.destroy()
  await assert.rejects(other, (err) => !isCancelled(err))
  // cancelled before it began: no request is made at all
  const before = held.size
  await assert.rejects(withCancel(c.signal, () => downloadFile(slowUrl, dest)), Cancelled)
  assert.equal(held.size <= before, true)
})

test('a child process is ended when its job is cancelled, and the caller can tell', async () => {
  const c = new AbortController()
  let cancelled
  const closed = withCancel(c.signal, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    cancelled = stopOnCancel(child)
    child.on('close', (code, signal) => resolve({ code, signal }))
    setTimeout(() => c.abort(), 150)
  }))
  const out = await closed
  assert.equal(cancelled(), true)
  assert.ok(out.code !== 0 || out.signal, 'the child ended by itself')
  // a child that ends by itself in a job nobody cancelled is not called cancelled
  const d = new AbortController()
  let other
  await withCancel(d.signal, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    other = stopOnCancel(child)
    child.on('close', resolve)
  }))
  assert.equal(other(), false)
})

test('a server having a bad moment is not waited on once the job is cancelled', async () => {
  const c = new AbortController()
  let asked = 0
  const fetcher = async () => { asked++; return new Response('', { status: 504 }) }
  const going = fetchRetry('https://example.invalid/x', { signal: c.signal }, { attempts: 4, delayMs: 30, fetcher })
  setTimeout(() => c.abort(), 10)
  await assert.rejects(going, (err) => err.name === 'AbortError')
  assert.equal(asked, 1)
})

test('what a cancelled child had started is ended with it', { skip: process.platform === 'win32' && 'taskkill does this on Windows; there is no shell to build the case with' }, async () => {
  const { OWN_GROUP, inOwnGroup } = await import('../src/cancel.mjs')
  const c = new AbortController()
  const mark = path.join(scratch, 'grandchild.pid')
  const started = Date.now()
  const out = await withCancel(c.signal, () => new Promise((resolve) => {
    // a shell that starts something of its own and waits for it, as a build does
    const child = inOwnGroup(spawn('sh', ['-c', `sleep 30 & echo $! > "${mark}"; wait`], { stdio: ['ignore', 'pipe', 'ignore'], ...OWN_GROUP }))
    const cancelled = stopOnCancel(child)
    child.on('close', () => resolve(cancelled()))
    until(() => fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').trim()).then(() => c.abort())
  }))
  assert.equal(out, true)
  // "close" came because the grandchild let go of the pipe, not because its 30 seconds ran out
  assert.ok(Date.now() - started < 20000)
  const pid = Number(fs.readFileSync(mark, 'utf8').trim())
  assert.ok(await until(() => { try { process.kill(pid, 0); return false } catch { return true } }), 'the grandchild is still running')
})

// ---- through the panel ---------------------------------------------------------------------

// Purpur's API, standing in: the version list, the build, and a jar that never finishes arriving.
const realFetch = globalThis.fetch
let jarRequests = 0
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input)
  if (!url.startsWith('https://api.purpurmc.org/')) return realFetch(input, init)
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/1.21.4')) return json({ builds: { latest: '7', all: ['6', '7'] } })
  if (url.endsWith('/1.21.4/7')) return json({ md5: null })
  if (url.endsWith('/1.21.4/7/download')) { jarRequests++; return realFetch(slowUrl, init) }
  return new Response('{}', { status: 404 })
}
after(() => { globalThis.fetch = realFetch })

test('a create is cancelled from the page: nothing is made, and the job says so', async () => {
  const panel = await serve({ port: 0 })
  const post = (route, body) => panelFetch(panel.url + 'api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // nothing by that id: said, not an error
    assert.deepEqual(await (await post('jobs/none-such/cancel', {})).json(), { cancelling: false })

    const creating = post('instances', { name: 'stopme', label: 'Stop me', loader: 'purpur', version: '1.21.4', force: true, jobId: 'job-create-1' })
    // (a long limit: Java is looked for first, and a slow machine takes its time over that)
    const up = await until(() => held.size > 0, 30000)
    if (!up) creating.catch(() => {})
    assert.ok(up, 'the jar download never started')
    // a second job under the same id is refused while the first runs, and leaves it alone
    const twice = await post('instances', { name: 'other', loader: 'purpur', version: '1.21.4', force: true, jobId: 'job-create-1' })
    assert.equal(twice.status, 400)
    assert.match((await twice.json()).error, /already running/)

    assert.deepEqual(await (await post('jobs/job-create-1/cancel', {})).json(), { cancelling: true })
    const res = await creating
    assert.equal(res.status, 409)
    assert.deepEqual(await res.json(), { error: 'Cancelled. No server was created.', code: 'cancelled' })
    assert.equal(registry.hasInstance('stopme'), false)
    assert.equal(registry.hasInstance('other'), false)
    assert.deepEqual(fs.existsSync(JARS_DIR) ? fs.readdirSync(JARS_DIR).filter((f) => /purpur/.test(f)) : [], [], 'half a jar was left in the store')
    assert.equal(jarRequests, 1)
    // done with: cancelling it again finds nothing, and the id can be used again
    assert.deepEqual(await (await post('jobs/job-create-1/cancel', {})).json(), { cancelling: false })

    // the job's own stream ends on "cancelled", for a page that is watching it
    const stream = await panelFetch(panel.url + 'api/jobs/job-create-1/stream')
    const reader = stream.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    const job = JSON.parse(first.replace(/^data: /, ''))
    assert.deepEqual([job.stage, job.done, job.message], ['cancelled', true, 'Cancelled'])

    // a job id that is not one is refused before anything starts
    assert.equal((await post('instances', { name: 'bad', loader: 'purpur', version: '1.21.4', force: true, jobId: 'a/b' })).status, 400)
    // cancelling is not a way to read or change anything by GET
    assert.ok((await panelFetch(panel.url + 'api/jobs/job-create-1/cancel')).status >= 400)
  } finally {
    panel.server.closeAllConnections()
    await new Promise((resolve) => panel.server.close(resolve))
  }
})

test('a launch that was cancelled does not start the game', async () => {
  const { launch, status, createProfile } = await import('../src/client.mjs')
  const { versionDir, versionJson } = await import('../src/client-paths.mjs')
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', 'version_manifest_v2.json'), 'utf8'))
  const mc = manifest.latest.release
  fs.mkdirSync(versionDir(mc), { recursive: true })
  fs.copyFileSync(path.join(here, 'fixtures', 'client', `${mc}.json`), versionJson(mc))
  createProfile('halt', { mc })
  const fakeJava = path.join(here, 'fixtures', 'fake-client.mjs')

  // cancelled as it reaches a given step, each of them before the game is started
  for (const at of ['java', 'spawn']) {
    const c = new AbortController()
    const stages = []
    await assert.rejects(
      withCancel(c.signal, () => launch('halt', { fakeJava, onStage: ({ stage }) => { stages.push(stage); if (stage === at) c.abort() } })),
      (err) => isCancelled(err),
      `cancelled at ${at}`)
    assert.equal(status('halt').running, false, `the game was started after a cancel at ${at}`)
    if (at === 'java') assert.ok(!stages.includes('spawn'))
  }
  // cancelled inside the downloads: still a cancel when it comes out, not "could not download"
  const { ensureVersion } = await import('../src/client-install.mjs')
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(withCancel(gone.signal, () => ensureVersion(mc)), (err) => isCancelled(err) && !/could not download/.test(err.message))
  // and the setup is not left locked: the next launch goes through
  const out = await launch('halt', { fakeJava })
  assert.ok(out.pid)
  const { stop } = await import('../src/client.mjs')
  await stop('halt')
})

// ---- a download that stops arriving, or is cut part way, is asked for again ----

test('a download that stalls is given up after its quiet time, retried, and then fails with a code', async () => {
  let asked = 0
  const quiet = http.createServer((req, res) => {
    asked++
    res.writeHead(200, { 'content-length': 1024 })
    res.write(Buffer.alloc(16, 1))
    // and nothing more
  })
  await new Promise((resolve) => quiet.listen(0, '127.0.0.1', resolve))
  const dest = path.join(scratch, 'stalled.bin')
  const began = Date.now()
  try {
    await assert.rejects(
      downloadFile(`http://127.0.0.1:${quiet.address().port}/x`, dest, { stallMs: 150, attempts: 2, retryDelayMs: 10, label: 'the stalled file' }),
      (err) => err instanceof UserError && err.code === 'download-failed' && /nothing arrived/.test(err.message),
    )
  } finally {
    quiet.closeAllConnections()
    quiet.close()
  }
  assert.equal(asked, 2)
  assert.ok(Date.now() - began < 5000, 'it did not wait for ever')
  assert.ok(!fs.existsSync(dest))
  assert.deepEqual(fs.readdirSync(scratch).filter((f) => f.endsWith('.part')), [], 'no half file is left')
})

test('a download cut part way succeeds on the second ask', async () => {
  let asked = 0
  const body = Buffer.alloc(4096, 7)
  const flaky = http.createServer((req, res) => {
    asked++
    res.writeHead(200, { 'content-length': body.length })
    if (asked === 1) { res.write(body.subarray(0, 100)); setTimeout(() => res.destroy(), 20); return }
    res.end(body)
  })
  await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve))
  const dest = path.join(scratch, 'flaky.bin')
  try {
    const out = await downloadFile(`http://127.0.0.1:${flaky.address().port}/x`, dest, { retryDelayMs: 10 })
    assert.equal(out.size, body.length)
  } finally {
    flaky.closeAllConnections()
    flaky.close()
  }
  assert.equal(asked, 2)
  assert.deepEqual(fs.readFileSync(dest), body)
})
