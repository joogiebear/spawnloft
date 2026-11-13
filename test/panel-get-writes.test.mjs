import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// No GET changes anything (rust/PANEL-AUTH-DESIGN.md 3.4, step 3). The panel lets a signed-in
// request through without `Sec-Fetch-Site` (older WebKit sends none), and the cookie goes with
// any GET a page on another loopback port makes (an <img>, a <script>): such a request cannot read
// the answer, so it is harmless only as long as no GET writes. This test is that rule.
//
// The routes are not a table in ui.mjs, so the requests are made from the route code itself:
// every literal the router compares a path segment with, in every position it could stand, with a
// real server, database and client profile where a name goes. The data and config folders are
// compared, file by file, before and after each request.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-get-writes-'))
const config = path.join(scratch, 'config')
const data = path.join(scratch, 'data')
const home = path.join(scratch, 'home')
// a Windows profile always has these; a program started with USERPROFILE pointed at an empty
// folder makes them, which is the profile being filled in, not a write of the panel's
for (const dir of [['AppData', 'Local'], ['AppData', 'Roaming']]) fs.mkdirSync(path.join(home, ...dir), { recursive: true })
process.env.APPDATA = config
process.env.XDG_CONFIG_HOME = config
process.env.MCCTL_DATA_ROOT = data
// everywhere else a write could land is in the scratch folder too, and compared
process.env.HOME = home
process.env.USERPROFILE = home
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
process.env.XDG_DATA_HOME = path.join(home, 'share')
process.env.XDG_CACHE_HOME = path.join(home, 'cache')
process.env.SPAWNLOFT_HARNESS_INDEX_FETCH = 'off'
const HERE = path.dirname(fileURLToPath(import.meta.url))

// Nothing here goes past this machine: a GET that would fetch from the internet gets a refusal.
// So the download caches some GETs refresh (Minecraft's version list, the harness index) are not
// written here; those are caches, not state. The server is stopped: what a running server's GETs
// do is read RCON and the daemon. Loopback requests (this test's own) go through.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('no network in this test'))
  return realFetch(input, init)
}

// a stopped server with the folders the panel's tools read, and an external database
const name = 'getcheck'
const dir = path.join(data, 'instances', name)
fs.mkdirSync(path.join(dir, 'plugins', 'Example'), { recursive: true })
fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true })
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
fs.writeFileSync(path.join(dir, 'server.jar'), '')
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=get check\nserver-port=45965\n')
fs.writeFileSync(path.join(dir, 'plugins', 'Example', 'config.yml'), 'enabled: true\n')
fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'not really nbt')
fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), '[00:00:00 INFO]: Done (1.0s)!\n')
fs.writeFileSync(path.join(dir, 'whitelist.json'), '[]')
fs.writeFileSync(path.join(dir, 'ops.json'), '[]')
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    [name]: { dir, jar: 'server.jar', java: process.execPath, memory: '1G', port: 45965, rcon: { port: 45975, password: 'get-check' }, autoRestart: false },
    getdb: { kind: 'database', engine: 'mariadb', external: true, host: '127.0.0.1', port: 45985, root: { user: 'root', password: 'get-check' }, autoRestart: false },
  },
}))

const { serve } = await import('../src/ui.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')
const client = await import('../src/client.mjs')

const panel = await serve({ port: 0 })
after(async () => {
  panel.server.closeAllConnections()
  await new Promise((resolve) => panel.server.close(resolve))
  globalThis.fetch = realFetch
  fs.rmSync(scratch, { recursive: true, force: true })
})

// a client profile (made directly: the panel's POST checks the version against the internet)
client.createProfile('getcheck-profile', { mc: '1.21.4' })
const profile = 'getcheck-profile'

// path -> what it is, for every file and folder under the two roots
function snapshot() {
  const out = new Map()
  const walk = (at) => {
    let entries
    try {
      entries = fs.readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(at, e.name)
      if (e.isDirectory()) {
        out.set(full, 'dir')
        walk(full)
      } else {
        let body = ''
        try {
          body = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        } catch {
          body = 'unreadable'
        }
        out.set(full, body)
      }
    }
  }
  walk(config)
  walk(data)
  walk(home)
  return out
}

function changes(before, afterwards) {
  const diff = []
  for (const [p, v] of afterwards) if (before.get(p) !== v) diff.push(`${before.has(p) ? 'changed' : 'added'} ${path.relative(scratch, p)}`)
  for (const p of before.keys()) if (!afterwards.has(p)) diff.push(`removed ${path.relative(scratch, p)}`)
  return diff
}

// Files the panel writes on its own clock, whatever is asked: its log. Anything else that changes
// while a GET runs is that GET's doing.
const ownClock = (line) => /(^|[\\/])panel\.log$/.test(line.replace(/^\w+ /, ''))

// every literal the router compares a segment with, by position
const source = fs.readFileSync(path.join(HERE, '..', 'src', 'ui.mjs'), 'utf8')
const words = new Map()
for (const m of source.matchAll(/seg\[(\d)\] === '([^']+)'/g)) {
  const at = Number(m[1])
  if (!words.has(at)) words.set(at, new Set())
  words.get(at).add(m[2])
}
const at = (i) => [...(words.get(i) ?? [])]

function requests() {
  const urls = new Set(['/', '/launcher', '/setup', '/api', '/api/nothing'])
  for (const a of at(1)) {
    urls.add(`/api/${a}`)
    for (const b of at(2)) urls.add(`/api/${a}/${b}`)
  }
  // where a segment names something, it names one that exists
  const named = { instances: name, databases: 'getdb' }
  for (const [kind, id] of Object.entries(named)) {
    urls.add(`/api/${kind}/${id}`)
    for (const c of at(3)) {
      urls.add(`/api/${kind}/${id}/${c}`)
      for (const d of at(4)) urls.add(`/api/${kind}/${id}/${c}/${d}`)
    }
  }
  for (const b of at(2)) {
    for (const c of at(3)) {
      urls.add(`/api/client/${b}/${c}`)
      urls.add(`/api/client/${b}/${profile}/${c}`)
    }
    urls.add(`/api/client/${b}/${profile}`)
  }
  // the routes that read a query, given one they accept
  for (const q of [
    `/api/instances/${name}/files?dir=`, `/api/instances/${name}/files?dir=plugins/Example`,
    `/api/instances/${name}/files/read?path=plugins/Example/config.yml`,
    `/api/instances/${name}/files/download?path=plugins/Example/config.yml`,
    `/api/instances/${name}/files/download?dir=plugins&name=Example`,
    `/api/instances/${name}/metrics?seconds=60`, `/api/instances/${name}/activity?limit=5`,
    `/api/instances/${name}/diag/log?lines=5`, `/api/instances/${name}/plugins/search?q=x`,
    `/api/instances/${name}/worlds/world/download`, `/api/instances/${name}/backups/download`,
    '/api/activity?limit=5', '/api/diagnostics?include=logs', '/api/modpacks/search?q=x',
    '/api/java/needs?version=1.21.4', `/api/client/versions/1.21.4`,
  ]) urls.add(q)
  return [...urls]
}

async function get(url) {
  // a stream that sends nothing yet has not sent its headers either
  const stream = /\/stream(\/|$)/.test(url)
  let res
  try {
    res = await panelFetch(panel.url + url.slice(1), { signal: AbortSignal.timeout(stream ? 1500 : 20000) })
  } catch (err) {
    if (stream && err.name === 'TimeoutError') return 'open stream'
    throw err
  }
  // event streams stay open: what they write, they write as they start
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await res.body?.cancel().catch(() => {})
  } else {
    await res.arrayBuffer().catch(() => {})
  }
  return res.status
}

test('the router\'s words were found', () => {
  // a reshaped router would otherwise make this test ask for nothing
  assert.ok(at(1).length >= 15, `segment 1 words: ${at(1)}`)
  assert.ok(at(3).length >= 15, `segment 3 words: ${at(3)}`)
})

test('no GET request writes to the data or config folder', { timeout: 600000 }, async () => {
  const list = requests()
  const found = []
  const answered = new Map()
  let before = snapshot()
  for (const url of list) {
    let status
    try {
      status = await get(url)
    } catch (err) {
      status = `failed: ${err.message}`
    }
    answered.set(status, (answered.get(status) ?? 0) + 1)
    // a write the route started and did not wait for still lands within this
    await new Promise((resolve) => setTimeout(resolve, 20))
    const now = snapshot()
    const diff = changes(before, now).filter((line) => !ownClock(line))
    if (diff.length) found.push(`GET ${url} (${status}): ${diff.join(', ')}`)
    before = now
  }
  // a write that lands late is still found, if not always on the request that made it
  await new Promise((resolve) => setTimeout(resolve, 500))
  const late = changes(before, snapshot()).filter((line) => !ownClock(line))
  if (late.length) found.push(`after the last GET: ${late.join(', ')}`)
  // most of the list must have reached a route, or the seed is wrong and this proves nothing
  const ok = answered.get(200) ?? 0
  assert.ok(ok >= 40, `only ${ok} of ${list.length} GETs answered 200: ${JSON.stringify([...answered])}`)
  assert.deepEqual(found, [], `GET requests that wrote:\n${found.join('\n')}`)
})
