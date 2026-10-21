import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { statusRecord } from './cli-query.mjs'
import { getInstance, isDatabase } from './registry.mjs'
import { tailLog } from './supervisor.mjs'
import { listPlugins, mcVersionOf } from './plugins.mjs'
import { daemonLog, stateFile } from './paths.mjs'
import { diagnose, crashReports } from './diagnose.mjs'
import { health } from './java.mjs'
import { parseLog, mergeTimelines, formatTimeline } from './log-timeline.mjs'
import { redactAccountName } from './mclogs.mjs'
import { humanBytes, stamp, fail } from './util.mjs'
import { createZip, zipEntries } from './zip.mjs'

export const TAIL_LINES = 5000

// The daemon log is appended to forever, so only its tail is read, and asynchronously: this runs
// on the panel's request path.
async function readLines(file, count) {
  let fh
  try {
    fh = await fs.promises.open(file, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  try {
    const { size } = await fh.stat()
    const readBytes = Math.min(size, Math.max(64 * 1024, count * 512))
    const buf = Buffer.alloc(readBytes)
    await fh.read(buf, 0, readBytes, size - readBytes)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (size > readBytes && lines.length) lines.shift()
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-count)
  } finally {
    await fh.close()
  }
}

export async function collectServer(name, { lines = TAIL_LINES } = {}) {
  const inst = getInstance(name)
  if (isDatabase(inst)) fail(`"${name}" is a database, not a server - there is nothing to diagnose`)
  const rec = statusRecord(name)

  const software = inst.jar ? inst.jar.split('-')[0] : null
  const version = mcVersionOf(inst)

  let status = rec.status
  let consoleLines = []
  let daemonLines = []
  let timeline = []

  const consoleFile = rec.consoleLog
  if (!consoleFile || !fs.existsSync(consoleFile)) {
    status = 'never started'
  } else {
    consoleLines = tailLog(name, lines)
    daemonLines = await readLines(daemonLog(name), lines)

    let anchor = null
    try {
      const state = JSON.parse(await fs.promises.readFile(stateFile(name), 'utf8'))
      anchor = state.startedAt ?? null
    } catch { /* no state file: the mtime dates the lines */ }
    const mtime = (await fs.promises.stat(consoleFile)).mtimeMs

    const serverEntries = parseLog(consoleLines, { source: 'server', anchor, mtime })
    const daemonEntries = parseLog(daemonLines, { source: 'daemon' })
    timeline = mergeTimelines(serverEntries, daemonEntries)
  }

  const findings = diagnose(consoleLines, {
    port: inst.port,
    memory: inst.memory,
    dir: inst.dir,
    crashDir: path.join(inst.dir, 'crash-reports'),
  })

  const crash = crashReports(inst, { limit: 3 })
  const crashes = crash.reports.map(r => ({ file: r.file, description: r.description }))

  const javaInfo = await health()
  const java = javaInfo?.found ? { major: javaInfo.major, version: javaInfo.version, path: javaInfo.path } : null

  const pluginRows = listPlugins(inst)
  const isMods = /fabric|neoforge/i.test(inst.jar ?? '')
  const pluginKey = isMods ? 'mods' : 'plugins'

  const facts = {
    name,
    software,
    version,
    status,
    startedAt: rec.startedAt,
    memory: rec.memory,
    java,
    [pluginKey]: pluginRows.map(p => p.name),
  }

  const files = []
  files.push({ name: 'server-console.log', text: consoleLines.join('\n') })
  files.push({ name: 'server-daemon.log', text: daemonLines.join('\n') })

  const sp = path.join(inst.dir, 'server.properties')
  if (fs.existsSync(sp)) {
    let text = fs.readFileSync(sp, 'utf8')
    text = text.split('\n').map(line => {
      if (/password|secret|token/i.test(line)) {
        return line.replace(/=.*/, '=[redacted]')
      }
      return line
    }).join('\n')
    files.push({ name: 'server.properties', text })
  }

  for (const r of crash.reports) {
    const cp = path.join(inst.dir, 'crash-reports', r.file)
    if (fs.existsSync(cp)) {
      files.push({ name: `crash-reports/${r.file}`, text: fs.readFileSync(cp, 'utf8') })
    }
  }

  return { facts, timeline, findings, crashes, files }
}

export async function buildBundle({ server = null, client = null, lines = TAIL_LINES, scrub = (s) => s }) {
  const spawnloft = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

  const facts = {
    spawnloft,
    os: os.platform(),
    arch: os.arch(),
    node: process.version,
    server: null,
    client: null,
  }

  let timeline = []
  const findings = { server: [], client: [] }
  let files = []

  if (server) {
    const result = await collectServer(server, { lines })
    facts.server = result.facts
    timeline = result.timeline
    findings.server = result.findings
    files = result.files
  }

  // the timeline and findings reach summarise() and timeline.txt, not only files, so every text field is cleaned
  const clean = (s) => (typeof s === 'string' ? scrub(redactAccountName(s)) : s)
  for (const f of files) f.text = clean(f.text)
  for (const finding of findings.server) {
    finding.title = clean(finding.title)
    finding.advice = clean(finding.advice)
  }
  timeline = timeline.map(e => ({ ...e, text: clean(e.text), raw: clean(e.raw), thread: clean(e.thread) }))
  if (facts.server?.java) facts.server.java.path = clean(facts.server.java.path)

  return { facts, timeline, findings, files }
}

// The bundle without the timeline and without the files' text: the logs are in the zip as
// themselves, so summary.json (and `diag --json`) names them with their size instead.
export function summarySection(bundle) {
  const { timeline, files, ...rest } = bundle
  return { ...rest, files: files.map(f => ({ name: f.name, bytes: Buffer.byteLength(f.text) })) }
}

export async function writeBundle(bundle, { outDir }) {
  const serverName = bundle.facts.server?.name ?? 'server'
  await fs.promises.mkdir(outDir, { recursive: true })
  const file = path.join(outDir, `${serverName}_diag_${stamp()}.zip`)

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sl-diag-'))
  try {
    const members = []

    await fs.promises.writeFile(path.join(tmpDir, 'summary.json'), JSON.stringify(summarySection(bundle), null, 2))
    members.push('summary.json')

    await fs.promises.writeFile(path.join(tmpDir, 'timeline.txt'), formatTimeline(bundle.timeline))
    members.push('timeline.txt')

    for (const f of bundle.files) {
      const filePath = path.join(tmpDir, f.name)
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      await fs.promises.writeFile(filePath, f.text)
      members.push(f.name)
    }

    await createZip(file, tmpDir, members)
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }

  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const names = []
    for (const entry of zipEntries(fd, size)) {
      names.push(entry.name)
    }
    return { file, size, sizeHuman: humanBytes(size), entries: names }
  } finally {
    fs.closeSync(fd)
  }
}

export function summarise(bundle) {
  const parts = []

  const topFacts = { ...bundle.facts }
  delete topFacts.server
  delete topFacts.client
  for (const [k, v] of Object.entries(topFacts)) {
    parts.push(`${k}: ${v}`)
  }

  if (bundle.facts.server) {
    for (const [k, v] of Object.entries(bundle.facts.server)) {
      if (v === null) continue
      const val = Array.isArray(v) ? v.join(', ')
        : k === 'java' ? `${v.version} (major ${v.major}) at ${v.path}`
        : String(v)
      parts.push(`server ${k}: ${val}`)
    }
  }

  const allFindings = [...(bundle.findings.server ?? []), ...(bundle.findings.client ?? [])]
  for (const f of allFindings) {
    parts.push(`- ${f.title}. ${f.advice}`)
  }

  const last40 = bundle.timeline.slice(-40)
  if (last40.length > 0) {
    parts.push(formatTimeline(last40))
  }

  return parts.join('\n')
}
