// The child make-c6-fixtures.mjs runs with the data root in its environment (paths.mjs reads it
// when first imported): builds the server folder and the files the scrubber reads, runs the
// operations in order and prints the answers.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [casesFile, root] = process.argv.slice(2)
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
const data = path.join(root, 'data')
const dir = path.join(data, 'instances', 'srv')
for (const f of cases.tree) {
  const full = path.join(dir, ...f.path.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, f.text)
}
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
const { secrets } = cases
write(path.join(data, 'instances.json'), secrets.registry)
write(path.join(data, 'client', 'accounts.json'), secrets.accounts)
write(path.join(data, 'client', 'profiles.json'), secrets.profiles)
for (const [name, state] of Object.entries(secrets.states)) write(path.join(data, 'client', 'run', name, 'state.json'), state)

const players = await import('../../src/players.mjs')
const mclogs = await import('../../src/mclogs.mjs')
const { scrubber, hideIps } = await import('../../src/mcp-tools.mjs')
const { offlineUuid } = await import('../../src/client-auth.mjs')

const inst = { name: 'srv', dir, ...cases.instance }

// the answer as the Rust tests compare it: the scratch root, stamps, times and ban stamps evened out
function even(v) {
  const text = JSON.stringify(v ?? null)
    .split(JSON.stringify(root).slice(1, -1)).join('<root>')
    .replace(/\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?/g, '<stamp>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}/g, '<ban stamp>')
  return JSON.parse(text)
}
const failure = (err) => ({ error: even(err.message), code: err.code ?? null })

// a console that answers from the case: `replies` by command, `writes` the lists the server
// would write before answering, `fail` the error every command throws
function consoleOf(c) {
  const seen = []
  const exec = async (_inst, [cmd]) => {
    seen.push(cmd)
    if (c.fail) throw new Error(c.fail)
    for (const [file, rows] of Object.entries(c.writes ?? {})) fs.writeFileSync(path.join(dir, file), JSON.stringify(rows))
    return [c.replies?.[cmd]]
  }
  return { opts: { running: !!c.running, exec }, seen }
}
const fetchOf = (answer, sent) => async (url, opts) => {
  sent.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
  if (answer.throws) throw new TypeError('fetch failed', { cause: new Error(answer.throws) })
  return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => JSON.parse(answer.body) }
}
const lookupOf = (l) => async () => {
  if (l.error) throw new Error(l.error)
  return l.found ?? null
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const OPS = {
  listPlayers: () => players.listPlayers(inst),
  storedPlayers: () => players.storedPlayers(dir),
  whitelistOn: () => players.whitelistOn(inst),
  whitelistEnforced: () => players.whitelistEnforced(inst),
  readFile: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
  writeFile: (rel, text) => { fs.writeFileSync(path.join(dir, rel), text); return 'ok' },
  setOp: (uuid, on, c) => withConsole(c, (o) => players.setOp(inst, uuid, on, o)),
  setBan: (uuid, on, reason, c) => withConsole(c, (o) => players.setBan(inst, uuid, on, reason, o)),
  setWhitelisted: (uuid, on, c) => withConsole(c, (o) => players.setWhitelisted(inst, uuid, on, o)),
  setWhitelistOn: (on, c) => withConsole(c, (o) => players.setWhitelistOn(inst, on, o)),
  addByName: (name, as, reason, c, l) => withConsole(c, (o) => players.addByName(inst, name, as, { reason, ...o, lookup: lookupOf(l) })),
  forgetPlayer: async (uuid, running) => {
    // forgetPlayer asks the supervisor: a running server is stood in for by its state file
    const state = path.join(data, 'run', 'srv', 'state.json')
    if (running) write(state, { running: true, daemonPid: process.pid, javaPid: process.pid })
    try {
      return players.forgetPlayer(inst, uuid)
    } finally {
      fs.rmSync(path.join(data, 'run', 'srv'), { recursive: true, force: true })
    }
  },
  exportConsole: (rel) => {
    const r = mclogs.exportConsole(inst, { sourceFile: path.join(dir, rel), outDir: path.join(data, 'exports') })
    return { ...r, copied: fs.readFileSync(r.file, 'utf8') }
  },
  shareConsole: async (rel, answer) => {
    const sent = []
    try {
      const r = await mclogs.shareConsole(inst, { sourceFile: path.join(dir, rel), tokenFile: path.join(data, 'run', 'mclogs.json'), fetchImpl: fetchOf(answer, sent) })
      return { result: r, sent }
    } catch (err) {
      return { ...failure(err), sent }
    }
  },
  readTokens: () => JSON.parse(fs.readFileSync(path.join(data, 'run', 'mclogs.json'), 'utf8')),
  scrubber: (text, showIps) => scrubber({ showIps })(text),
}
async function withConsole(c, f) {
  const { opts, seen } = consoleOf(c)
  try {
    return { answer: await f(opts), commands: seen }
  } catch (err) {
    return { ...failure(err), commands: seen }
  }
}

const ops = []
for (const { op, args } of cases.ops) {
  try {
    ops.push({ result: even(await OPS[op](...args)) })
  } catch (err) {
    ops.push(failure(err))
  }
}
const mojang = []
for (const { args: [name, answer] } of cases.mojang) {
  const sent = []
  try {
    mojang.push({ result: await players.mojangLookup(name, { fetchImpl: fetchOf(answer, sent) }), urls: sent.map((s) => s.url) })
  } catch (err) {
    mojang.push({ error: err.message, urls: sent.map((s) => s.url) })
  }
}
const PURE = {
  redactAccountName: (t) => mclogs.redactAccountName(t),
  trimForUpload: (t) => mclogs.trimForUpload(t),
  hideIps: (t) => hideIps(t),
  scrub: (t, secrets, showIps) => scrubber({ showIps, secrets: () => secrets })(t),
  offlineUuid: (n) => offlineUuid(n),
}
const pure = []
for (const c of cases.pure) {
  try {
    if (c.gen) {
      const line = c.gen.unit.repeat(c.gen.repeat)
      const text = Array(c.gen.count).fill(line).join('\n') + (c.gen.trailing ? '\n' : '')
      const r = mclogs.trimForUpload(text)
      pure.push({ result: { lines: r.lines, trimmed: r.trimmed, bytes: Buffer.byteLength(r.content), sha256: sha(r.content), head: r.content.slice(0, 12), tail: r.content.slice(-12) } })
    } else {
      pure.push({ result: PURE[c.op](...c.args) })
    }
  } catch (err) {
    pure.push(failure(err))
  }
}
process.stdout.write(JSON.stringify({ ops, mojang, pure }))
