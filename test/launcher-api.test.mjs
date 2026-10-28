import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-launcher-api-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
process.env.MCCTL_FAKE_CLIENT = path.resolve(process.cwd(), 'test', 'fixtures', 'fake-client.mjs')
process.env.NODE_ENV = 'test'
const { serve } = await import('../src/ui.mjs')
const registry = await import('../src/registry.mjs')
const client = await import('../src/client.mjs')
const clientPaths = await import('../src/client-paths.mjs')
const { saveAccounts } = await import('../src/client-auth.mjs')
const { acquireLock } = await import('../src/util.mjs')
const { platformRefusal } = await import('../src/client-meta.mjs')

const fixtures = path.resolve(process.cwd(), 'test', 'fixtures', 'client')
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'version_manifest_v2.json'), 'utf8'))
const mc = manifest.latest.release
fs.mkdirSync(clientPaths.versionDir(mc), { recursive: true })
fs.copyFileSync(path.join(fixtures, `${mc}.json`), clientPaths.versionJson(mc))
// the picker's version list, fresh, in the shared cache: no network in this file
fs.mkdirSync(clientPaths.CLIENT_CACHE_DIR, { recursive: true })
fs.copyFileSync(path.join(fixtures, 'version_manifest_v2.json'), path.join(clientPaths.CLIENT_CACHE_DIR, 'version_manifest_v2.json'))
fs.writeFileSync(path.join(clientPaths.CLIENT_CACHE_DIR, 'version_manifest_v2.json.fetched-at'), String(Date.now()))

function addServer(name, port, props) {
  const dir = path.join(scratch, 'data', 'instances', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'paper.jar'), '')
  fs.writeFileSync(path.join(dir, 'server.properties'), props)
  registry.putInstance(name, { dir, jar: 'paper.jar', memory: '2G', port, mcVersion: mc, rcon: { port: port + 1, password: 'x' } })
}
addServer('open', 45911, 'online-mode=false\n')
addServer('strict', 45913, 'online-mode=true\n')

const ACCESS = 'fake-access-token-7f3a91'
const REFRESH = 'fake-refresh-token-c2d8e4'
const HARNESS = 'abcdef0123456789abcdef0123456789'
// a token refreshed out of accounts.json since the crash, so the scrubber does not know it
const OLD_ACCESS = 'stale-access-token-9b1e55'
saveAccounts([{ type: 'microsoft', name: 'Wunga_', uuid: '11111111-2222-3333-4444-555555555555', accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(Date.now() + 86400000).toISOString() }])

const panel = await serve({ port: 0, open: false })
after(async () => {
  for (const p of client.listProfiles()) {
    try { await client.stop(p.name) } catch { /* not running */ }
  }
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

const call = (route, { method = 'GET', body, headers = {} } = {}) => fetch(panel.url + 'api/' + route, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

// The job's events until the terminal one; the stream replays the current state first.
async function jobEvents(jobId, start) {
  const res = await fetch(panel.url + `api/jobs/${jobId}/stream`)
  const reader = res.body.getReader()
  const events = []
  let buf = ''
  let started = false
  const deadline = Date.now() + 15000
  try {
    while (Date.now() < deadline) {
      if (!started) {
        started = true
        await start()
      }
      let timer
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the job stream went quiet: ' + JSON.stringify(events))), deadline - Date.now()) }),
      ]).finally(() => clearTimeout(timer))
      if (done) break
      buf += Buffer.from(value).toString('utf8')
      let cut
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        if (!chunk.startsWith('data: ')) continue
        const event = JSON.parse(chunk.slice(6))
        events.push(event)
        if (event.done) return events
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  throw new Error('the job never finished: ' + JSON.stringify(events))
}

function request(route, { method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: panel.port, path: '/api/' + route, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

test('every launcher route refuses another origin and a non-loopback Host', async () => {
  client.createProfile('guarded', { mc })
  const routes = [
    ['GET', 'client/versions'],
    ['GET', 'client/launcher'],
    ['GET', 'client/profiles'],
    ['POST', 'client/profiles'],
    ['PATCH', 'client/profiles/guarded'],
    ['DELETE', 'client/profiles/guarded'],
    ['POST', 'client/profiles/guarded/launch'],
    ['GET', 'client/profiles/guarded/log'],
    ['POST', 'client/profiles/guarded/diag'],
  ]
  for (const [method, route] of routes) {
    // a plugin's web UI on another loopback port is another origin
    assert.equal(await request(route, { method, headers: { host: `127.0.0.1:${panel.port}`, origin: 'http://127.0.0.1:8123' } }), 403, `${method} ${route} other origin`)
    assert.equal(await request(route, { method, headers: { host: `evil.example:${panel.port}` } }), 403, `${method} ${route} rebinding`)
  }
  assert.equal(client.getProfile('guarded').mc, mc)
  assert.equal(fs.existsSync(clientPaths.clientStateFile('guarded')), false)
  client.removeProfile('guarded')
})

test('the version picker reads the shared cache and drops ids a launch would refuse', async () => {
  // the installed version counts as downloaded once its jar has the size the JSON names
  const json = JSON.parse(fs.readFileSync(clientPaths.versionJson(mc), 'utf8'))
  fs.writeFileSync(clientPaths.versionJar(mc), '')
  let out = await (await call('client/versions')).json()
  assert.equal(out.offline, null)
  assert.deepEqual(out.versions.map((v) => v.id), ['1.21.11', '26.3'])
  assert.equal(out.versions[0].downloaded, false)
  fs.truncateSync(clientPaths.versionJar(mc), json.downloads.client.size)
  out = await (await call('client/versions')).json()
  const [row, newer] = out.versions
  assert.deepEqual(row, { id: '1.21.11', type: 'release', releaseTime: row.releaseTime, downloaded: true, javaNeeds: 21, harness: true, refusal: platformRefusal(json), note: null })
  assert.equal(newer.downloaded, false)
  assert.equal(newer.javaNeeds, 25)
  assert.equal(newer.harness, false)
  assert.equal(newer.refusal, null, 'no JSON on disk, so no per-version refusal')
})

test('the version picker shows the machine refusal once and notes old versions on Windows arm64', async () => {
  const linuxArm = await client.listVersions({ os: { name: 'linux', arch: 'arm64' } })
  assert.match(linuxArm.machineRefusal, /no Linux arm64 build/)
  const winArm = await client.listVersions({ os: { name: 'windows', arch: 'arm64' } })
  assert.equal(winArm.machineRefusal, null)
  // 1.21.11 is not older than 1.21; an old release would be
  assert.equal(winArm.versions.find((v) => v.id === '1.21.11').note, null)
  fs.mkdirSync(clientPaths.versionDir('1.12.2'), { recursive: true })
  fs.writeFileSync(clientPaths.versionJson('1.12.2'), JSON.stringify({ id: '1.12.2', type: 'release', releaseTime: '2017-09-18T08:39:46+00:00', libraries: [] }))
  // offline (no cache, no network): only what is on disk, and why
  const cache = path.join(clientPaths.CLIENT_CACHE_DIR, 'version_manifest_v2.json')
  const saved = fs.readFileSync(cache)
  fs.rmSync(cache)
  try {
    const offline = await client.listVersions({ os: { name: 'windows', arch: 'arm64' }, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') } })
    assert.match(offline.offline, /could not be read .*ENOTFOUND.*only downloaded versions/)
    assert.deepEqual(offline.versions.map((v) => v.id).sort(), ['1.12.2', '1.21.11'])
    const old = offline.versions.find((v) => v.id === '1.12.2')
    assert.equal(old.note, 'old launcher arguments; untested; may not run on this machine; checked at launch')
    assert.equal(old.downloaded, false)
  } finally {
    fs.writeFileSync(cache, saved)
    fs.rmSync(clientPaths.versionDir('1.12.2'), { recursive: true, force: true })
  }
})

test('profiles are created, edited and removed through the panel', async () => {
  for (const [body, error] of [
    [{ name: 'bad name', mc }, /invalid profile name/],
    [{ name: 'p1', mc: '1.21.11-pre1' }, /invalid Minecraft version/],
    [{ name: 'p1', mc, memory: '1.5G' }, /whole number/],
    [{ name: 'p1', mc, harness: true }, /needs the fabric loader/],
    [{ name: 'p1' }, /Minecraft version/],
  ]) {
    const res = await call('client/profiles', { method: 'POST', body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match((await res.json()).error, error)
  }
  const made = await call('client/profiles', { method: 'POST', body: { name: 'p1', mc, loader: 'fabric', loaderVersion: '0.17.3', server: 'open', assistantAccount: true } })
  assert.equal(made.status, 200)
  const row = await made.json()
  assert.equal(row.assistantAccount, false, 'a new profile never starts with assistantAccount on')
  assert.equal(row.loaderVersion, '0.17.3')
  assert.equal(row.running, false)

  // a new Minecraft version drops the loader build made for the old one, and says the mods may not load
  fs.mkdirSync(path.join(clientPaths.profileDir('p1'), 'mods'), { recursive: true })
  fs.writeFileSync(path.join(clientPaths.profileDir('p1'), 'mods', 'something.jar'), '')
  let res = await call('client/profiles/p1', { method: 'PATCH', body: { mc: '26.3' } })
  assert.equal(res.status, 200)
  let out = await res.json()
  assert.equal(out.profile.mc, '26.3')
  assert.equal(out.profile.loaderVersion, null)
  assert.deepEqual(out.warnings, [`Mods in this profile's folder were installed for ${mc} and may not load`])
  res = await call('client/profiles/p1', { method: 'PATCH', body: { mc, loader: 'vanilla', assistantAccount: true } })
  out = await res.json()
  assert.deepEqual(out.warnings, [`Mods in this profile's folder were installed for 26.3 and may not load`])
  assert.equal(out.profile.assistantAccount, true)
  res = await call('client/profiles/p1', { method: 'PATCH', body: { memory: '3G' } })
  assert.deepEqual((await res.json()).warnings, [])
  res = await call('client/profiles/p1', { method: 'PATCH', body: { mc: 1.21 } })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /must be text/)
  // a launch under way holds the lock and reads the profile again while it downloads
  const release = acquireLock(clientPaths.clientLaunchLock('p1'), { mode: 'fail' })
  try {
    res = await call('client/profiles/p1', { method: 'PATCH', body: { memory: '4G' } })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /is being launched .*before changing memory/)
    assert.equal((await call('client/profiles/p1', { method: 'PATCH', body: { server: 'strict' } })).status, 200)
  } finally {
    release()
  }
  res = await call('client/profiles/p1', { method: 'PATCH', body: { nonsense: 1 } })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /unknown profile key "nonsense"/)

  assert.equal((await call('client/profiles/p1', { method: 'DELETE' })).status, 200)
  assert.equal(client.listProfiles().some((p) => p.name === 'p1'), false)
  assert.ok(fs.existsSync(clientPaths.profileDir('p1')), 'kept without purge')
  client.createProfile('p1', { mc })
  assert.equal((await call('client/profiles/p1?purge=1', { method: 'DELETE' })).status, 200)
  assert.equal(fs.existsSync(clientPaths.profileDir('p1')), false)
  assert.equal((await call('client/profiles/p1', { method: 'DELETE' })).status, 400)
})

test('a launch with a job id answers at once and reports its stages on the job stream', async () => {
  client.createProfile('job', { mc, server: 'open' })
  let answer
  const events = await jobEvents('launch-job-1', async () => {
    answer = await call('client/profiles/job/launch', { method: 'POST', body: { jobId: 'launch-job-1', server: false } })
  })
  assert.equal(answer.status, 202)
  assert.deepEqual(await answer.json(), { jobId: 'launch-job-1' })
  const stages = events.map((e) => e.stage).filter((s, i, all) => s !== all[i - 1])
  assert.deepEqual(stages, ['start', 'java', 'spawn', 'running'])
  const last = events.at(-1)
  assert.equal(last.done, true)
  assert.equal(typeof last.pid, 'number')
  assert.deepEqual(last.account, { type: 'offline', name: 'job' })
  assert.deepEqual(last.warnings, [])
  assert.equal(client.status('job').launchedBy, 'launcher')
  assert.equal(JSON.parse(fs.readFileSync(clientPaths.clientStateFile('job'), 'utf8')).launchedBy, 'launcher')

  // a command-changing key is refused while it runs; the next-launch keys are not
  let res = await call('client/profiles/job', { method: 'PATCH', body: { memory: '4G' } })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /is running; stop it before changing memory/)
  res = await call('client/profiles/job', { method: 'PATCH', body: { server: 'strict', account: 'offline:Someone', assistantAccount: true, memory: client.getProfile('job').memory } })
  assert.equal(res.status, 200)

  const listed = (await (await call('client/profiles')).json()).find((p) => p.name === 'job')
  assert.equal(listed.running, true)
  assert.equal(listed.launchedBy, 'launcher')
  assert.deepEqual(listed.runningAccount, { type: 'offline', name: 'job' })
  // the launcher's "since 14:02" and its data folder line
  assert.equal(listed.startedAt, client.status('job').startedAt)
  assert.equal(listed.folder, clientPaths.profileDir('job'))
  assert.equal(listed.accountUuid, null, 'an offline selector has no uuid')
  // a key an older CLI wrote as a name still resolves to the account's uuid for the page's picker
  const reg = client.loadProfiles()
  reg.profiles.named = { ...reg.profiles.job, account: 'Wunga_', server: null }
  client.saveProfiles(reg)
  const named = (await (await call('client/profiles')).json()).find((p) => p.name === 'named')
  assert.equal(named.accountUuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(named.accountName, 'Wunga_')
  client.removeProfile('named')

  const again = await jobEvents('launch-job-2', () => call('client/profiles/job/launch', { method: 'POST', body: { jobId: 'launch-job-2', server: false } }))
  assert.equal(again.at(-1).stage, 'error')
  assert.match(again.at(-1).message, /already running/)
  await client.stop('job')
})

test('a launch held by the lock, or refused by an online-mode server, is an error event, not a 400', async () => {
  client.createProfile('locked', { mc })
  const release = acquireLock(clientPaths.clientLaunchLock('locked'), { mode: 'fail' })
  try {
    let answer
    const events = await jobEvents('lock-job', async () => {
      answer = await call('client/profiles/locked/launch', { method: 'POST', body: { jobId: 'lock-job' } })
    })
    assert.equal(answer.status, 202)
    assert.equal(events.at(-1).stage, 'error')
    assert.match(events.at(-1).message, /"locked" is being launched/)
  } finally {
    release()
  }
  const refused = await jobEvents('strict-job', () => call('client/profiles/locked/launch', { method: 'POST', body: { jobId: 'strict-job', server: 'strict' } }))
  assert.equal(refused.at(-1).stage, 'error')
  assert.equal(refused.at(-1).message, 'strict requires a Microsoft account (online-mode=true); sign in or pick another server')
  assert.equal(client.status('locked').running, false)

  const badId = await call('client/profiles/locked/launch', { method: 'POST', body: { jobId: '../x' } })
  assert.equal(badId.status, 400)
  const unknown = await call('client/profiles/nosuch/launch', { method: 'POST', body: { jobId: 'x1' } })
  assert.equal(unknown.status, 400)
})

test('a launch job starts the picked server when it is stopped, and a failed start launches nothing', async () => {
  client.createProfile('serverjob', { mc, server: 'open' })
  // "open" has an empty jar, so its start fails one way or another (no Java, no EULA, a bad jar)
  const warned = await jobEvents('server-job-0', () => call('client/profiles/serverjob/launch', { method: 'POST', body: { jobId: 'server-job-0' } }))
  assert.ok(warned.at(-1).warnings.some((w) => /server "open" is not running/.test(w)), 'without startServer a stopped server is only a warning')
  await client.stop('serverjob')
  const events = await jobEvents('server-job', () => call('client/profiles/serverjob/launch', { method: 'POST', body: { jobId: 'server-job', startServer: true } }))
  const stages = events.map((e) => e.stage).filter((s, i, all) => s !== all[i - 1])
  assert.deepEqual(stages, ['start', 'java', 'server', 'error'])
  assert.match(events.at(-1).message, /EULA/i)
  assert.equal(client.status('serverjob').running, false)
})

test('the card\'s one-click Play stays synchronous and is marked as the panel\'s', async () => {
  client.createProfile('card', { mc })
  const res = await call('client/profiles/card/launch', { method: 'POST', body: { server: false } })
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(typeof out.pid, 'number')
  assert.deepEqual(out.warnings, [])
  assert.equal(client.status('card').launchedBy, 'panel')
  await client.stop('card')
})

test('"Start server and launch" starts a stopped server inside the launch, before the game', async () => {
  client.createProfile('starter', { mc, server: 'open' })
  const stages = []
  const started = []
  const out = await client.launch('starter', {
    fakeJava: process.env.MCCTL_FAKE_CLIENT,
    launchedBy: 'launcher',
    onStage: ({ stage }) => stages.push(stage),
    ensureServer: async (name) => { started.push(name) },
  })
  assert.deepEqual(started, ['open'])
  assert.deepEqual(stages, ['java', 'server', 'spawn'])
  assert.deepEqual(out.warnings, [], 'a server being started is not a warning')
  await client.stop('starter')

  // a failed start fails the launch, and nothing is spawned
  await assert.rejects(client.launch('starter', {
    fakeJava: process.env.MCCTL_FAKE_CLIENT,
    ensureServer: async () => { throw new Error('server "open" started but stopped again') },
  }), /started but stopped again/)
  assert.equal(client.status('starter').running, false)

  // an assistant's launch says so, and the CLI is the default
  await client.launch('starter', { fakeJava: process.env.MCCTL_FAKE_CLIENT, server: false, assistant: true, launchedBy: 'launcher' })
  assert.equal(client.status('starter').launchedBy, 'assistant')
  await client.stop('starter')
  await client.launch('starter', { fakeJava: process.env.MCCTL_FAKE_CLIENT, server: false })
  assert.equal(client.status('starter').launchedBy, 'cli')
  await client.stop('starter')
})

test('no client route hands a page a token, the log route included', async () => {
  client.createProfile('leaky', { mc })
  fs.mkdirSync(clientPaths.clientRunDir('leaky'), { recursive: true })
  fs.writeFileSync(clientPaths.clientLog('leaky'), [
    '[12:00:00] [Render thread/INFO]: Setting user: Wunga_',
    '---- Minecraft Crash Report ----',
    `\tJVM Flags: 3 total; -Xmx2G -Dspawnloft.harness.token=${HARNESS} -XX:+UseG1GC`,
    `\tLaunched Version: 1.21.11 --username Wunga_ --accessToken ${OLD_ACCESS} --userType msa`,
    '',
  ].join('\n'))
  const log = await (await call('client/profiles/leaky/log?lines=10')).json()
  assert.equal(log.lines.length, 4)
  assert.ok(log.lines.some((l) => l.includes('spawnloft.harness.token=[redacted]')))
  assert.ok(log.lines.some((l) => l.includes('--accessToken [redacted]')))
  assert.equal((await (await call('client/profiles/leaky/log?lines=2')).json()).lines.length, 2)

  const summary = await (await call('client/launcher')).json()
  assert.deepEqual(summary.accounts, [{ name: 'Wunga_', uuid: '11111111-2222-3333-4444-555555555555', type: 'microsoft', expiresAt: summary.accounts[0].expiresAt, refreshFailedAt: null }])
  assert.equal(summary.defaultAccount, null)
  assert.deepEqual(summary.servers.map((s) => [s.name, s.mc, s.status, s.onlineMode]), [['open', mc, 'stopped', false], ['strict', mc, 'stopped', true]])
  assert.ok(summary.profiles.some((p) => p.name === 'leaky'))
  assert.ok(Number.isInteger(summary.machine.totalMemory) && summary.machine.totalMemory > 0)
  assert.ok(Number.isInteger(summary.machine.freeMemory) && summary.machine.freeMemory <= summary.machine.totalMemory)

  // a launch as the Microsoft account: its job events carry the name, never the token
  const msEvents = await jobEvents('ms-job', () => call('client/profiles/leaky/launch', { method: 'POST', body: { jobId: 'ms-job', account: 'Wunga_', server: false } }))
  assert.deepEqual(msEvents.at(-1).account, { type: 'microsoft', name: 'Wunga_' })
  await client.stop('leaky')
  fs.writeFileSync(clientPaths.clientLog('leaky'), fs.readFileSync(clientPaths.clientLog('leaky'), 'utf8') + `\tJVM Flags: -Dspawnloft.harness.token=${HARNESS}\n\t--accessToken ${OLD_ACCESS}\n`)
  const bodies = [JSON.stringify(msEvents)]
  for (const route of ['client/launcher', 'client/profiles', 'client/versions', 'client/profiles/leaky/status', 'client/profiles/leaky/log?lines=50']) {
    bodies.push(await (await call(route)).text())
  }
  const diag = await call('client/profiles/leaky/diag', { method: 'POST', body: {} })
  assert.equal(diag.status, 200)
  const diagBody = await diag.text()
  assert.ok(fs.existsSync(JSON.parse(diagBody).file))
  bodies.push(diagBody)
  for (const text of bodies) {
    for (const secret of [ACCESS, REFRESH, HARNESS, OLD_ACCESS]) assert.ok(!text.includes(secret), `${secret} in ${text.slice(0, 200)}`)
    const walk = (v) => {
      if (!v || typeof v !== 'object') return
      for (const [k, inner] of Object.entries(v)) {
        assert.ok(!['accessToken', 'refreshToken', 'device_code'].includes(k), `key ${k} in ${text.slice(0, 200)}`)
        walk(inner)
      }
    }
    walk(JSON.parse(text))
  }
})

test('a default account that is no longer signed in is no default', async () => {
  const data = client.loadProfiles()
  data.defaultAccount = '11111111-2222-3333-4444-555555555555'
  client.saveProfiles(data)
  assert.equal((await (await call('client/launcher')).json()).defaultAccount, '11111111-2222-3333-4444-555555555555')
  data.defaultAccount = '99999999-2222-3333-4444-555555555555'
  client.saveProfiles(data)
  assert.equal((await (await call('client/launcher')).json()).defaultAccount, null)
})

test('/launcher is served with the saved theme and no-store', async () => {
  assert.equal((await call('appearance', { method: 'POST', body: { theme: 'spawnloft' } })).status, 200)
  const res = await fetch(panel.url + 'launcher')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(await res.text(), /<html lang="en" data-theme="spawnloft">/)
  // no other site may frame it
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'")
})

test('a server address outside SpawnLoft is parsed strictly', () => {
  assert.deepEqual(client.parseServerAddress('play.example.net'), { host: 'play.example.net', port: 25565 })
  assert.deepEqual(client.parseServerAddress(' 192.168.1.20:25566 '), { host: '192.168.1.20', port: 25566 })
  assert.deepEqual(client.parseServerAddress('[2001:db8::1]:25570'), { host: '2001:db8::1', port: 25570 })
  assert.deepEqual(client.parseServerAddress('localhost'), { host: 'localhost', port: 25565 })
  for (const bad of ['', '   ', '-Dx=1', 'host -Dx=1', 'mc.example.net:0', 'mc.example.net:65536', 'mc.example.net:', 'a:b:c', 'http://mc.example.net',
    'mc.example.net/path', '[zz::1]', '[::1]x', '-host.net', 'host-.net', 'a..b', 'x'.repeat(64) + '.net', 'mc.example.net:2556a', 42, null]) {
    assert.throws(() => client.parseServerAddress(bad), /is not a server address/, String(bad))
  }
})

test('a launch can join an address SpawnLoft does not run', async () => {
  const { buildCommand } = await import('../src/client-launch.mjs')
  const version = JSON.parse(fs.readFileSync(clientPaths.versionJson(mc), 'utf8'))
  const account = { type: 'offline', name: 'tester', uuid: '00000000-0000-0000-0000-000000000000', accessToken: '0' }
  const args = buildCommand({ version, profile: { mc, memory: '2G', server: 'open' }, profileName: 'addr', account, java: 'java', address: { host: '2001:db8::1', port: 25570 } }).args
  assert.equal(args[args.indexOf('--quickPlayMultiplayer') + 1], '[2001:db8::1]:25570')

  client.createProfile('addr', { mc, server: 'open' })
  const events = await jobEvents('addr-job', () => call('client/profiles/addr/launch', { method: 'POST', body: { jobId: 'addr-job', address: 'play.example.net:25570' } }))
  const last = events.at(-1)
  assert.equal(last.stage, 'running', JSON.stringify(last))
  // not the profile's server: nothing was started, and the offline player is warned about online mode
  assert.deepEqual(events.filter((e) => e.stage === 'server'), [])
  assert.ok(last.warnings.some((w) => /addr is an offline player, so play.example.net:25570 will refuse the join unless/.test(w)), JSON.stringify(last.warnings))
  const st = client.status('addr')
  assert.equal(st.address, 'play.example.net:25570')
  assert.equal(st.server, null)
  assert.equal((await (await call('client/profiles')).json()).find((p) => p.name === 'addr').launchTarget, 'play.example.net:25570')
  await client.stop('addr')

  for (const [body, error] of [
    [{ jobId: 'addr-bad', address: '-Dfoo=bar' }, /is not a server address/],
    [{ jobId: 'addr-both', address: 'play.example.net', server: 'open' }, /not both/],
  ]) {
    const refused = await jobEvents(body.jobId, () => call('client/profiles/addr/launch', { method: 'POST', body }))
    assert.equal(refused.at(-1).stage, 'error')
    assert.match(refused.at(-1).message, error)
  }
  assert.equal(client.status('addr').running, false)
})
