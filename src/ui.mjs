import http from 'node:http'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import * as supervisor from './supervisor.mjs'
import * as registry from './registry.mjs'
import * as create from './create.mjs'
import * as manage from './manage.mjs'
import { LAYOUT, BACKUPS_DIR } from './paths.mjs'
import * as java from './java.mjs'
import * as backup from './backup.mjs'
import * as schedule from './schedule.mjs'
import { readProps, writeProps } from './props.mjs'
import { storedPlayers } from './players.mjs'
import * as players from './players.mjs'
import * as metrics from './metrics.mjs'
import { platformCapabilities, PREVIEW_LIMITS } from './platform.mjs'
import * as settings from './settings.mjs'
import { readTheme, saveTheme } from './appearance.mjs'
import * as plugins from './plugins.mjs'
import * as pluginActions from './plugin-actions.mjs'
import * as upgrade from './upgrade.mjs'
import * as sources from './sources.mjs'
import { repairAfterMove } from './relocate.mjs'
import * as services from './services.mjs'
import * as software from './software.mjs'
import * as mrpack from './mrpack.mjs'
import * as neoforge from './neoforge.mjs'
import * as worlds from './worlds.mjs'
import * as mclogs from './mclogs.mjs'
import * as configFiles from './config-files.mjs'
import * as files from './files.mjs'
import * as activity from './activity.mjs'
import * as client from './client.mjs'
import { platformRefusal } from './client-meta.mjs'
import * as clientAuth from './client-auth.mjs'
import * as clientLogin from './client-login.mjs'
import { diagnose, crashReports } from './diagnose.mjs'
import { buildBundle, writeBundle } from './diag-bundle.mjs'
import { scrubber } from './mcp-tools.mjs'
import { rconExposure } from './exposure.mjs'
import { acceptableWebhook } from './notify.mjs'
import { fail, refreshProcessTable, UserError, cleanLabel, slugFor, safeRelativePath, isInside, humanBytes } from './util.mjs'
import { activeBlock } from './control.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Local control panel. Keep it on 127.0.0.1: it can start/stop servers and type into their
// consoles, so exposing it on a LAN address would hand out an unauthenticated server console.
export function serve({ port = 8770, host = '127.0.0.1', open = true } = {}) {
  guardProcess()
  watchEventLoop()
  // synchronous on purpose (see util.mjs); do it now rather than inside the first poll
  refreshProcessTable()

  // task shims and launchers name this install by absolute path; rewrite them if it moved
  // before anything can run one (the desktop app always starts the panel, see relocate.mjs)
  try {
    const repaired = repairAfterMove()
    if (repaired.moved) {
      panelLog(`installation moved: rewrote ${repaired.shims} task shim(s) and launchers for ${repaired.launchers} server(s)`)
    }
  } catch (err) {
    panelLog(`could not check whether the installation moved: ${err?.message ?? err}`)
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        return json(res, 403, { error: 'this panel only answers requests addressed to localhost' })
      }
      await activity.asActor({ kind: 'panel' }, () => route(req, res))
    } catch (err) {
      // SSE routes write their headers first; writeHead here would throw ERR_HTTP_HEADERS_SENT
      // out of this catch and take the process down. Close the stream and let the page reconnect.
      if (res.headersSent) {
        res.end()
        return
      }
      // user-fixable refusals are 400, anything else is ours
      const refusal = err instanceof UserError || err?.userFacing === true
      json(res, refusal ? 400 : 500, { error: err?.message ?? String(err), ...(err?.code ? { code: err.code } : {}) })
    }
  })

  clientLogin.setLoginHooks({ log: panelLog })
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // the desktop app passes port 0, so report the port actually bound
      const bound = server.address().port
      // the sign-in callback's redirect URI carries this port (Microsoft matches localhost on any port)
      panelPort = bound
      const url = `http://${host}:${bound}/`
      if (open) openBrowser(url)
      resolve({ server, url, port: bound })
    })
  })
}

let panelPort = null

// The panel process's own log. Never rotated: it only gets a line when something is wrong.
export function panelLog(msg) {
  try {
    fs.mkdirSync(LAYOUT.runDir, { recursive: true })
    fs.appendFile(path.join(LAYOUT.runDir, 'panel.log'), `[${new Date().toISOString()}] ${msg}\n`, () => {})
  } catch {
    /* losing a log line is fine */
  }
}

// Node exits on an unhandled rejection, which here would close the whole desktop app. Log instead.
let guarded = false
function guardProcess() {
  if (guarded) return
  guarded = true
  process.on('unhandledRejection', (reason) => {
    panelLog(`unhandled rejection: ${reason?.stack ?? reason?.message ?? String(reason)}`)
  })
}

// Everything runs on one event loop, so synchronous work stalls every request and the console
// stream. Log any stall over LAG_LOG_MS.
const LAG_LOG_MS = 250
function watchEventLoop() {
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  const timer = setInterval(() => {
    const worst = Math.round(h.max / 1e6)
    h.reset()
    if (worst >= LAG_LOG_MS) panelLog(`event loop held for ${worst}ms`)
  }, 1000)
  timer.unref()
}

function panelLogTail(count) {
  try {
    const lines = fs.readFileSync(path.join(LAYOUT.runDir, 'panel.log'), 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-count)
  } catch {
    return []
  }
}

function packageInfo() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

// GitHub URL from package.json's `repository`, so a fork only changes it in one place.
export function projectUrl() {
  const repo = String(packageInfo().repository ?? '')
  const m = /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repo) ?? /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo)
  return m ? `https://github.com/${m[1]}` : null
}

const IDEAS_URL = () => `${projectUrl()}/discussions/new?category=ideas`
const QUESTION_URL = () => `${projectUrl()}/discussions/new?category=q-a`

// Plain-text bug report bundle. It gets pasted publicly, so no RCON password and no webhook URL.
async function diagnostics(instanceName, { short = false } = {}) {
  const lines = []
  const add = (k, v) => lines.push(`${k}: ${v}`)
  const version = packageInfo().version ?? 'unknown'
  lines.push('== SpawnLoft diagnostics ==')
  add('SpawnLoft', version)
  add('node', process.version + (process.versions.electron ? ` (electron ${process.versions.electron})` : ''))
  add('os', `${process.platform} ${os.release()} ${os.arch()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1073741824)} GB`)
  add('generated', new Date().toISOString())
  const jv = await java.health()
  add('java', jv.found && jv.path ? `${jv.version} (${jv.reason})${jv.onPath ? '' : ` at ${jv.path}, not on PATH`}` : jv.message)
  for (const other of jv.others ?? []) {
    if (other.path !== jv.path) add('java (also)', `${other.version} at ${other.path}`)
  }
  lines.push('')
  lines.push('== where things live ==')
  for (const k of ['dataRoot', 'instancesDir', 'jarsDir', 'backupsDir', 'runDir']) add(k, LAYOUT[k])
  lines.push('')
  lines.push('== servers ==')
  const all = registry.listInstances()
  if (!all.length) lines.push('(none)')
  for (const i of all) {
    let row
    try {
      row = supervisor.statusOf(i.name)
    } catch (err) {
      row = { ...i, status: `unknown (${err?.message ?? err})` }
    }
    lines.push(`- ${row.name}: ${row.status}, ${row.loader ?? 'paper'}${row.mcVersion ? ` ${row.mcVersion}` : ''}, `
      + `${row.memory}, port ${row.port}, jar ${row.jar}`
      + `${row.javaPid ? `, java pid ${row.javaPid}` : ''}${row.autoRestart ? ', auto-restart' : ''}`
      + `${row.lastError ? `, last error: ${row.lastError}` : ''}`)
  }
  const tail = panelLogTail(short ? 5 : 20)
  lines.push('')
  lines.push(`== panel log (last ${short ? 5 : 20}) ==`)
  lines.push(...(tail.length ? tail : ['(empty)']))
  if (instanceName && registry.hasInstance(instanceName)) {
    const inst = registry.getInstance(instanceName)
    const recent = supervisor.tailLog(instanceName, 60)
    const findings = diagnose(supervisor.tailLog(instanceName, 400), {
      port: inst.port, memory: inst.memory, dir: inst.dir, crashDir: path.join(inst.dir, 'crash-reports'),
    })
    lines.push('')
    lines.push(`== ${instanceName}: diagnosis ==`)
    lines.push(...(findings.length ? findings.map((f) => `- ${f.title}: ${f.advice}`) : ['(nothing recognised)']))
    // the console tail doesn't fit in a URL, so the short form leaves it to the clipboard
    if (!short) {
      lines.push('')
      lines.push(`== ${instanceName}: console (last 60) ==`)
      lines.push(...(recent.length ? recent : ['(empty)']))
    }
  }
  return lines.join('\n') + '\n'
}

// URLs for the Feedback sheet. The bug link prefills GitHub's new-issue form with the short
// diagnostics (URLs are capped); the full bundle goes to the clipboard. Nothing is sent from here.
async function feedback(instanceName, { title = '' } = {}) {
  const home = projectUrl()
  if (!home) return { bug: null, ideas: null, question: null, full: '' }
  const short = await diagnostics(instanceName, { short: true })
  const full = await diagnostics(instanceName)
  const body = [
    '**What happened**',
    '',
    '<!-- What you did, what you expected, what you got instead. -->',
    '',
    '**Diagnostics**',
    '',
    '```',
    short.trimEnd(),
    '```',
    '',
    '<!-- The full diagnostics, console lines included, are on your clipboard: paste them here. -->',
    '',
  ].join('\n')
  const params = new URLSearchParams({ template: 'bug_report.md', labels: 'bug', title, body })
  let bug = `${home}/issues/new?${params}`
  if (bug.length > 7500) {
    params.set('body', body.slice(0, 7500 - `${home}/issues/new?`.length - 400) + '\n```\n\n(trimmed - paste the full diagnostics from your clipboard)\n')
    bug = `${home}/issues/new?${params}`
  }
  return { bug, ideas: IDEAS_URL(), question: QUESTION_URL(), full }
}

// Progress for long-running creates, streamed to the page. In memory, keyed by a caller-supplied
// id; losing them on restart is fine.
const jobs = new Map()
const JOB_LIMIT = 32

function jobUpdate(id, patch) {
  if (!id) return
  const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
  Object.assign(job, patch)
  jobs.set(id, job)
  for (const send of job.listeners ?? []) send(job)
  // Map keeps insertion order, so this drops the oldest
  while (jobs.size > JOB_LIMIT) jobs.delete(jobs.keys().next().value)
}

// server.properties keys the panel offers. Allowlist: the ports and RCON password are owned by the
// registry and rewritten by syncProps on every launch, so editing them here would silently revert.
// `type` is what the page renders; `note` shows next to the control.
const EDITABLE_PROPS = [
  {
    key: 'online-mode',
    group: 'access',
    label: 'Require a Minecraft account',
    type: 'bool',
    fallback: 'true',
    note: 'Off lets anyone join as any name, which is what multi-account testing needs - but it '
      + 'gives players name-derived UUIDs instead of real ones, and puts an OFFLINE/INSECURE '
      + 'banner in every log. Plugin authors often refuse a bug report carrying it.',
  },
  { key: 'motd', group: 'world', label: 'Message of the day', type: 'text', fallback: 'A Minecraft Server' },
  { key: 'difficulty', group: 'gameplay', label: 'Difficulty', type: 'enum', fallback: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'gamemode', group: 'gameplay', label: 'Default game mode', type: 'enum', fallback: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'max-players', group: 'access', label: 'Max players', type: 'int', fallback: '20', min: 1, max: 1000 },
  { key: 'pvp', group: 'gameplay', label: 'PvP', type: 'bool', fallback: 'true' },
  { key: 'white-list', group: 'access', label: 'Whitelist', type: 'bool', fallback: 'false', note: 'Only listed players can join. Add them from the console with "whitelist add <name>".' },
  { key: 'view-distance', group: 'world', label: 'View distance', type: 'int', fallback: '10', min: 2, max: 32 },
  { key: 'spawn-protection', group: 'gameplay', label: 'Spawn protection', type: 'int', fallback: '16', min: 0, max: 256 },
]

// A field with no group here still renders, in a section at the end.
const PROP_GROUPS = [
  { key: 'access', icon: 'user', title: 'Who can join',
    blurb: 'Identity, the whitelist, and how many people at once.' },
  { key: 'gameplay', icon: 'play', title: 'Gameplay',
    blurb: 'The rules the world is played by.' },
  { key: 'world', icon: 'server', title: 'World and load',
    blurb: 'What players see before they join, and how much the server draws for them.' },
]

const PROP_BY_KEY = new Map(EDITABLE_PROPS.map((p) => [p.key, p]))

function coerceProp(spec, raw) {
  const value = String(raw).trim()
  if (spec.type === 'bool') {
    if (value !== 'true' && value !== 'false') fail(`${spec.key} must be true or false`)
    return value
  }
  if (spec.type === 'enum') {
    if (!spec.options.includes(value)) fail(`${spec.key} must be one of: ${spec.options.join(', ')}`)
    return value
  }
  if (spec.type === 'int') {
    const n = Number(value)
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      fail(`${spec.key} must be a whole number from ${spec.min} to ${spec.max}`)
    }
    return String(n)
  }
  // a newline would split the line and create a second key
  if (/[\r\n]/.test(value)) fail(`${spec.key} cannot contain a line break`)
  return value
}

// A database's own backups (plain SQL dumps). Every non-download answer returns the current list.
async function handleDatabaseBackups(req, res, name, seg, url) {
  const verb = seg[4] ?? null
  const answer = async (extra = {}) => json(res, 200, {
    ...services.databaseBackupStatus(name),
    backups: await services.listDatabaseBackups(name),
    ...extra,
  })

  if (req.method === 'GET' && verb === 'download') {
    const file = services.databaseBackupFile(name, String(url.searchParams.get('file') ?? ''))
    const { size } = await fs.promises.stat(file)
    res.writeHead(200, {
      'content-type': 'application/sql; charset=utf-8',
      'content-length': size,
      'content-disposition': `attachment; filename="${path.basename(file)}"`,
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
    return
  }
  if (req.method === 'GET' && !verb) return answer()
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  if (!verb) return answer({ taken: await services.backupDatabase(name, { label: body.label ?? 'manual' }) })
  if (verb === 'restore') return answer(await services.restoreDatabaseBackup(name, String(body.file ?? '')))
  if (verb === 'delete') return answer(await services.deleteDatabaseBackup(name, String(body.file ?? '')))
  return json(res, 404, { error: 'not found' })
}

// Raw server.properties editor. Same path as the assistant's write_config_file: hidden values
// (RCON password) are restored from disk on save, port/RCON changes are refused, and the file is
// snapshotted first.
async function handleRawProps(req, res, name) {
  const inst = registry.getInstance(name)
  if (req.method === 'GET') {
    const out = configFiles.readConfigFile(inst, 'server.properties')
    return json(res, 200, { text: out.text, redacted: out.redacted })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)
  if (typeof body.text !== 'string') return json(res, 400, { error: 'text is required' })
  const { full, shown } = configFiles.resolveConfigPath(inst, 'server.properties')
  const before = await fs.promises.readFile(full, 'utf8')
  const plan = configFiles.planConfigWrite(inst, shown, {
    content: configFiles.restoreHidden(before, body.text),
    hiddenRestored: true,
  })
  const snap = await backup.createSnapshot(inst, { scope: 'config', label: 'before-edit', members: [plan.shown], flush: false })
  // the server may have rewritten its properties while the snapshot ran
  if (!configFiles.unchangedSince(plan)) fail('server.properties changed while it was being snapshotted; reload it and try again')
  configFiles.applyConfigWrite(plan)
  activity.record(name, 'config-edit', { detail: 'server.properties', snapshot: path.basename(snap.file) })
  return json(res, 200, {
    snapshot: path.basename(snap.file),
    appliesOnRestart: supervisor.isRunning(name),
    diff: configFiles.summarizeChange(plan.before, plan.after),
  })
}

// Files tool; see files.mjs for what is refused. An upload body is raw file bytes, not JSON, with
// the destination in the query string.
async function handleFiles(req, res, name, seg, url) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null
  const running = supervisor.isRunning(name)
  const q = (k) => url.searchParams.get(k) ?? ''

  if (req.method === 'GET') {
    if (!verb) return json(res, 200, { ...files.listDir(inst, q('path'), { running }), running })
    if (verb === 'read') return json(res, 200, await files.readFile(inst, q('path')))
    if (verb === 'search') return json(res, 200, { ...await files.searchNames(inst, q('path'), q('q'), { running }), running })
    if (verb === 'download') {
      const out = await files.downloadable(inst, q('path'))
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': out.size,
        // filename* carries non-ASCII names; the plain one is the fallback
        'content-disposition': `attachment; filename="${out.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(out.name)}`,
        'cache-control': 'no-store',
      })
      const stream = fs.createReadStream(out.file)
      stream.on('close', out.done)
      stream.pipe(res)
      return
    }
    return json(res, 404, { error: 'not found' })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  if (verb === 'upload') {
    return json(res, 200, await files.uploadFile(inst, q('dir'), q('name'), req, { overwrite: q('overwrite') === '1', running }))
  }
  const body = await readBody(req)
  if (verb === 'write') {
    return json(res, 200, {
      ...await files.writeFile(inst, body.path, { text: body.text, version: body.version ?? null, create: body.create === true, force: body.force === true }),
      appliesOnRestart: running,
    })
  }
  if (verb === 'mkdir') return json(res, 200, files.makeFolder(inst, body.dir, body.name))
  if (verb === 'move') return json(res, 200, files.movePath(inst, body.from, body.to, { running }))
  if (verb === 'delete') return json(res, 200, await files.deletePaths(inst, body.paths, { withoutCopy: body.withoutCopy === true, running }))
  if (verb === 'archive') return json(res, 200, await files.archivePaths(inst, body.paths, body.name))
  if (verb === 'extract') return json(res, 200, await files.extractArchive(inst, body.path, { running }))
  return json(res, 404, { error: 'not found' })
}

// server-icon.png: Minecraft ignores it unless it is a 64x64 PNG. The page scales before sending.
async function handleIcon(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const file = path.join(inst.dir, 'server-icon.png')
  if (req.method === 'GET') {
    let bytes
    try { bytes = await fs.promises.readFile(file) } catch { return json(res, 404, { error: 'no icon' }) }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    return res.end(bytes)
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  if (seg[4] === 'remove') {
    await fs.promises.rm(file, { force: true })
    activity.record(name, 'settings', { detail: 'server icon removed' })
    return json(res, 200, { icon: false })
  }
  const body = await readBody(req)
  const png = Buffer.from(String(body.png ?? '').replace(/^data:image\/png;base64,/, ''), 'base64')
  const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) return json(res, 400, { error: 'the icon must be a PNG image' })
  if (png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64) return json(res, 400, { error: 'the icon must be 64 by 64 pixels' })
  if (png.length > 256 * 1024) return json(res, 400, { error: 'that icon is too large' })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.promises.writeFile(tmp, png)
  await fs.promises.rename(tmp, file)
  activity.record(name, 'settings', { detail: 'server icon changed' })
  return json(res, 200, { icon: true, appliesOnRestart: supervisor.isRunning(name) })
}

function activityQuery(url, server = null) {
  const q = (k) => url.searchParams.get(k) || null
  const limit = Math.min(500, Math.max(1, Number(q('limit')) || 100))
  return { server: server ?? q('server'), before: q('before'), since: q('since'), by: q('by'), limit }
}

// One server's history, plus undo for changes that kept a copy. An undo is recorded too.
async function handleActivity(req, res, name, seg, url) {
  if (req.method === 'GET' && !seg[4]) return json(res, 200, { ...activity.readActivity(activityQuery(url, name)), running: supervisor.isRunning(name) })
  if (req.method === 'POST' && seg[4] === 'undo') {
    const body = await readBody(req)
    if (!body.snapshot) return json(res, 400, { error: 'which change?' })
    return json(res, 200, await files.undoSnapshot(registry.getInstance(name), String(body.snapshot), { running: supervisor.isRunning(name) }))
  }
  return json(res, 404, { error: 'not found' })
}

async function handleProps(req, res, name) {
  const inst = registry.getInstance(name)
  const file = path.join(inst.dir, 'server.properties')
  // a server that has never booted lacks most keys; show the effective default, flagged as not set
  const shape = (current) => EDITABLE_PROPS.map((spec) => ({
    ...spec,
    value: current.get(spec.key) ?? spec.fallback,
    set: current.has(spec.key),
  }))

  if (req.method === 'GET') {
    // stored players let the page warn before online-mode changes: switching gives everyone a different identity
    return json(res, 200, { fields: shape(readProps(file)), groups: PROP_GROUPS, file, players: storedPlayers(inst.dir) })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  const updates = {}
  for (const [key, raw] of Object.entries(body)) {
    const spec = PROP_BY_KEY.get(key)
    if (!spec) return json(res, 400, { error: `${key} is not editable from here` })
    updates[key] = coerceProp(spec, raw)
  }
  if (!Object.keys(updates).length) return json(res, 400, { error: 'nothing to change' })

  writeProps(file, updates)
  activity.record(name, 'settings', { detail: Object.entries(updates).map(([k, v]) => `${k} = ${v}`).join(', ') })
  return json(res, 200, {
    changed: Object.keys(updates),
    appliesOnRestart: supervisor.isRunning(name),
    fields: shape(readProps(file)),
  })
}

// Snapshots. Restore refuses on a running server (like the CLI) instead of trusting the page to
// have disabled the button.
async function handleBackups(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const action = seg[4] ?? null

  if (req.method === 'GET' && action === 'download') {
    const url = new URL(req.url, 'http://localhost')
    const snap = backup.resolveSnapshot(name, String(url.searchParams.get('snapshot') ?? ''))
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': snap.size,
      'content-disposition': `attachment; filename="${snap.name}"`,
      'cache-control': 'no-store',
    })
    fs.createReadStream(snap.path).pipe(res)
    return
  }

  if (req.method === 'GET') {
    const history = {
      snapshots: backup.listSnapshots(name),
      exclude: backup.excludePatterns(inst),
      dir: path.join(LAYOUT.backupsDir, name),
      root: LAYOUT.backupsDir,
      mirror: backup.mirrorRoot(),
      running: supervisor.isRunning(name),
      scopes: backup.SCOPES,
    }
    // the tab draws this first and polls it; the scheduler lookup (PowerShell on Windows) can take
    // seconds on a cold machine and must not block it
    if (action === 'history') return json(res, 200, history)
    const auto = await autoBackupTask(name)
    const automatic = {
      auto: auto && {
        id: auto.id,
        enabled: auto.enabled,
        schedule: auto.schedule,
        keep: auto.action.keep ?? null,
        state: auto.windows?.state ?? null,
        lastResult: auto.windows ? schedule.describeResult(auto.windows.lastResult) : null,
        nextRun: auto.windows?.nextRun ?? null,
      },
      automaticAvailable: platformCapabilities().scheduler,
      automaticUnavailableReason: PREVIEW_LIMITS.scheduler,
      background: schedule.background(),
    }
    if (action === 'auto') return json(res, 200, automatic)
    return json(res, 200, { ...history, ...automatic })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  if (!action) {
    // snapshotting a running server is allowed; createSnapshot skips files the server holds locked
    const running = supervisor.isRunning(name)
    const out = await backup.createSnapshot(inst, {
      scope: backup.SCOPES.includes(body.scope) ? body.scope : 'standard',
      label: body.label ? String(body.label).slice(0, 40) : 'manual',
      running,
    })
    return json(res, 200, {
      created: path.basename(out.file),
      size: out.size,
      members: out.members,
      skipped: out.skipped,
      mirrored: out.mirrored,
      mirrorError: out.mirrorError,
      saveOnWarning: out.saveOnWarning,
    })
  }

  if (action === 'restore') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    const blocked = activeBlock(name, 'restoring')
    if (blocked) {
      return json(res, 409, {
        error: `${blocked} Extracting over a server that has those files open corrupts a world `
          + 'rather than replacing it.',
      })
    }
    const snap = backup.resolveSnapshot(name, String(body.snapshot))
    const out = await backup.restoreSnapshot(inst, snap, { clean: body.clean === true })
    return json(res, 200, out)
  }

  if (action === 'lock') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    return json(res, 200, backup.setSnapshotLocked(name, String(body.snapshot), body.locked !== false))
  }
  if (action === 'note') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    return json(res, 200, backup.setSnapshotNote(name, String(body.snapshot), body.note))
  }
  if (action === 'exclude') {
    const patterns = backup.cleanExcludePatterns(body.patterns)
    registry.updateInstance(name, { backupExclude: patterns.length ? patterns : null })
    activity.record(name, 'settings', { detail: patterns.length ? `backups leave out ${patterns.join(', ')}` : 'backups leave nothing out' })
    return json(res, 200, { exclude: patterns })
  }

  if (action === 'delete') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    return json(res, 200, backup.removeSnapshot(name, String(body.snapshot)))
  }

  if (action === 'auto') {
    if (!platformCapabilities().scheduler) return json(res, 400, { error: PREVIEW_LIMITS.scheduler })
    const existing = await autoBackupTask(name)
    if (body.enabled === false) {
      if (existing) schedule.remove(existing.id)
      return json(res, 200, { auto: null })
    }
    // one automatic backup per server: a second would race the first for the same tar and prune
    // its output. Update in place rather than remove and recreate, so a failed create (scheduler
    // service stopped, schtasks error) doesn't leave the server with no schedule.
    const keep = Number(body.keep)
    const action = { type: 'backup', keep: Number.isInteger(keep) && keep > 0 ? keep : null }
    const when = body.schedule ?? { kind: 'daily', at: '03:00' }
    const made = existing
      ? schedule.update(existing.id, { action, schedule: when, enabled: true, owner: schedule.OWNER_BACKUPS })
      : schedule.create({ instance: name, name: 'Automatic backup', action, schedule: when, owner: schedule.OWNER_BACKUPS })
    return json(res, 200, { auto: { id: made.id, schedule: made.schedule, keep: made.action.keep } })
  }

  return json(res, 404, { error: 'not found' })
}

// The automatic backup the Backups tab owns. Match by owner mark, not by action type: the
// Scheduler tab can make backup tasks too. The fallback adopts an unowned task with the exact
// default name (made before the mark existed).
async function autoBackupTask(name) {
  const mine = (await schedule.list()).filter((t) => t.instance === name && t.action.type === 'backup')
  return mine.find((t) => t.owner === schedule.OWNER_BACKUPS)
    ?? mine.find((t) => !t.owner && t.name === 'Automatic backup')
    ?? null
}

// Read from the file the daemon writes: the panel may have started after the server, and CPU is
// a rate that needs two readings.
function handleMetrics(req, res, name, url) {
  registry.getInstance(name)
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
  if (!platformCapabilities().performance) {
    return json(res, 200, { available: false, reason: PREVIEW_LIMITS.performance, samples: [] })
  }

  const asked = Number(url.searchParams.get('seconds'))
  // capped at what is kept
  const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 18000) : 3600
  const status = supervisor.statusOf(name)
  const all = metrics.readSamples(name)
  const cutoff = Math.floor(Date.now() / 1000) - seconds
  // history lets the page tell "never measured" from "nothing in this range"
  const newest = all.length ? all[all.length - 1].at : null
  return json(res, 200, {
    samples: all.filter((s) => s.at >= cutoff),
    history: {
      count: all.length,
      oldest: all.length ? all[0].at : null,
      newest,
      // how far back a range must reach to catch anything
      staleSeconds: newest === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - newest),
    },
    everySeconds: metrics.SAMPLE_SECONDS,
    cores: metrics.CPU_CORES,
    running: supervisor.isRunning(name),
    uptimeMs: status.uptimeMs ?? null,
    startedAt: status.startedAt ?? null,
    memory: status.memory ?? null,
  })
}

// GET queries the upstream project (on demand only). POST with no version is a build update; with
// a version it crosses Minecraft versions, which the page has already had confirmed. applyUpgrade
// snapshots first.
async function handleUpgrade(req, res, name) {
  const inst = registry.getInstance(name)
  if (req.method === 'GET') {
    return json(res, 200, await upgrade.checkUpgrade(inst))
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)
  const result = await upgrade.applyUpgrade(name, {
    version: body.version ? String(body.version) : null,
    running: supervisor.isRunning(name),
  })
  return json(res, 200, { ...result, running: supervisor.isRunning(name) })
}

async function handleConsole(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  if (verb === 'export') return json(res, 200, mclogs.exportConsole(inst))
  if (verb === 'share') return json(res, 200, await mclogs.shareConsole(inst))
  return json(res, 404, { error: 'not found' })
}

// The game client: profiles, the version picker, launches and their logs. The launcher page and
// the server cards' Play use these; everything here is behind the same loopback checks as the
// rest of the panel, which matters because a profile's `java` is a path launch runs.
async function handleClient(req, res, seg, url) {
  if (seg[2] === 'versions' && seg.length === 3 && req.method === 'GET') {
    return json(res, 200, await client.listVersions())
  }
  if (seg[2] === 'launcher' && seg.length === 3 && req.method === 'GET') {
    return json(res, 200, launcherSummary())
  }
  if (seg[2] !== 'profiles') return json(res, 404, { error: 'not found' })

  if (seg.length === 3) {
    if (req.method === 'GET') return json(res, 200, client.listProfiles().map(clientProfileRow))
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = (await readBody(req)) ?? {}
    if (typeof body.name !== 'string') fail('a profile needs a name')
    if (typeof body.mc !== 'string') fail('a profile needs a Minecraft version')
    // assistantAccount is not taken here: a new profile starts with it off, whoever makes it
    const fields = {}
    for (const key of ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness', 'server', 'account']) {
      if (body[key] !== undefined) fields[key] = body[key]
    }
    const made = client.createProfile(body.name, fields)
    return json(res, 200, clientProfileRow(client.getProfile(made.name)))
  }

  const profileName = seg[3]
  if (seg.length === 4) {
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('send the keys to change as a JSON object')
      const before = client.getProfile(profileName)
      client.updateProfile(profileName, body)
      const warnings = []
      if (typeof body.mc === 'string' && body.mc !== before.mc && await hasModJars(profileName)) {
        warnings.push(`Mods in this profile's folder were installed for ${before.mc} and may not load`)
      }
      return json(res, 200, { profile: clientProfileRow(client.getProfile(profileName)), warnings })
    }
    if (req.method === 'DELETE') {
      const purge = ['1', 'true'].includes(url.searchParams.get('purge') ?? '')
      client.removeProfile(profileName, { purge })
      return json(res, 200, { removed: profileName, purged: purge })
    }
    return json(res, 405, { error: 'method not allowed' })
  }
  if (seg.length !== 5) return json(res, 404, { error: 'not found' })

  const verb = seg[4]
  if (verb === 'status' && req.method === 'GET') {
    return json(res, 200, client.status(profileName))
  }
  if (verb === 'log' && req.method === 'GET') {
    client.getProfile(profileName)
    const asked = Number(url.searchParams.get('lines') ?? 20)
    const count = Number.isInteger(asked) && asked > 0 ? Math.min(asked, LOG_LINES_MAX) : 20
    const scrub = scrubber()
    return json(res, 200, { lines: client.tailClientLog(profileName, count).map((l) => scrub(client.redactClientLine(l))) })
  }
  if (verb === 'diag' && req.method === 'POST') {
    client.getProfile(profileName)
    const bundle = await buildBundle({ client: profileName, scrub: scrubber() })
    const result = await writeBundle(bundle, { outDir: path.join(BACKUPS_DIR, 'client', 'exports') })
    return json(res, 200, { file: result.file, size: result.size, sizeHuman: result.sizeHuman, findings: bundle.findings })
  }
  if (verb === 'launch' && req.method === 'POST') {
    const body = (await readBody(req)) ?? {}
    const opts = {
      server: body.server === false ? false : (typeof body.server === 'string' && body.server ? body.server : null),
      account: typeof body.account === 'string' && body.account ? body.account : null,
      // a server SpawnLoft does not run, host[:port]; launch checks it
      address: typeof body.address === 'string' ? body.address : null,
      fakeJava: client.fakeClientJava(),
    }
    if (body.jobId === undefined || body.jobId === null) {
      const out = await client.launch(profileName, { ...opts, launchedBy: 'panel' })
      return json(res, 200, { pid: out.pid, version: out.version, account: out.account, warnings: out.warnings })
    }
    const jobId = String(body.jobId)
    if (!JOB_ID.test(jobId)) fail('jobId must be 1 to 64 letters, digits, dashes or underscores')
    client.getProfile(profileName)
    // Answered now: the page has opened the job stream, and every refusal from here on (the
    // launch lock among them) arrives there as the job's error.
    launchJob(jobId, profileName, { ...opts, startServer: body.startServer === true })
    return json(res, 202, { jobId })
  }
  if (verb === 'stop' && req.method === 'POST') {
    return json(res, 200, await client.stop(profileName))
  }
  return json(res, 405, { error: 'method not allowed' })
}

const LOG_LINES_MAX = 500
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/
// how long "Start server and launch" waits for the server before giving up on the launch
const LAUNCH_SERVER_WAIT_MS = 120000

function clientProfileRow(p) {
  const st = client.status(p.name)
  return {
    name: p.name, mc: p.mc, loader: p.loader, loaderVersion: p.loaderVersion, memory: p.memory, java: p.java,
    // the key may be a uuid; the page shows the name and tells offline from Microsoft by the type
    harness: p.harness, server: p.server, account: p.account, accountName: client.accountInfo(p.account).name, accountType: client.accountInfo(p.account).type, assistantAccount: p.assistantAccount,
    running: st.running, pid: st.pid, runningAccount: st.account, launchedBy: st.launchedBy, launchTarget: st.address ?? st.server,
  }
}

async function hasModJars(profileName) {
  try {
    return (await fs.promises.readdir(path.join(client.profileFolder(profileName), 'mods'))).some((f) => /\.jar$/i.test(f))
  } catch {
    return false
  }
}

// Names, uuids and the two dates only: no route hands a token to a page.
function publicAccounts() {
  let list = []
  try { list = clientAuth.loadAccounts() } catch { /* an unreadable file lists nothing; sign-in rewrites it */ }
  return list.filter((a) => a && typeof a.name === 'string').map(clientAuth.publicAccount)
}

// One read for the launcher's poll: profiles with their running state (from state.json and the
// cached process table, no fresh tasklist), accounts, and the servers a profile can join.
function launcherSummary() {
  const accounts = publicAccounts()
  const wanted = client.loadProfiles().defaultAccount ?? null
  const servers = registry.listInstances().map((inst) => {
    let row
    try { row = safeInstance(supervisor.statusOf(inst.name)) } catch { row = { ...inst, status: 'unknown', onlineMode: null } }
    return { name: row.name, label: row.label ?? null, mc: plugins.mcVersionOf(row) ?? null, status: row.status, onlineMode: row.onlineMode }
  })
  return {
    profiles: client.listProfiles().map(clientProfileRow),
    accounts,
    // a uuid no longer signed in is no default at all
    defaultAccount: accounts.some((a) => a.uuid === wanted) ? wanted : null,
    servers,
    machineRefusal: platformRefusal(null),
  }
}

async function startServerForLaunch(name) {
  const out = await supervisor.start(name, { timeout: LAUNCH_SERVER_WAIT_MS })
  if (out.failed) fail(`server "${name}" started but stopped again: ${out.reason}; the game was not launched`)
  if (out.timedOut) fail(`server "${name}" had not finished starting after about 2 minutes, so the game was not launched; watch its console, then launch again`)
}

// `startServer` is the page's "Start server and launch": without it a stopped server is a warning.
function launchJob(jobId, profileName, { startServer, ...opts }) {
  // a reused id must not carry the last run's outcome into this one
  jobUpdate(jobId, { stage: 'start', percent: null, message: 'Preparing', done: false, pid: undefined, version: undefined, account: undefined, warnings: undefined })
  client.launch(profileName, {
    ...opts,
    launchedBy: 'launcher',
    ensureServer: startServer ? startServerForLaunch : null,
    onStage: ({ stage, message }) => jobUpdate(jobId, { stage, message, percent: null }),
    onProgress: ({ phase, done, total, bytes }) => jobUpdate(jobId, {
      stage: phase === 'harness mod' ? 'harness' : phase,
      message: `Downloading ${phase} · ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} files · ${humanBytes(bytes)}`,
      percent: total ? Math.min(100, Math.round((done / total) * 100)) : null,
    }),
  }).then(
    (out) => jobUpdate(jobId, {
      stage: 'running', percent: 100, message: `Running · pid ${out.pid}`, done: true,
      pid: out.pid, version: out.version, account: out.account, warnings: out.warnings,
    }),
    (err) => jobUpdate(jobId, { stage: 'error', percent: null, message: err?.message ?? String(err), done: true }),
  )
}

async function handleDiag(req, res, name, seg, url) {
  registry.getInstance(name)
  const outDir = path.join(BACKUPS_DIR, name, 'exports')

  const verb = seg[4] ?? null
  if (req.method === 'POST' && !verb) {
    const bundle = await buildBundle({ server: name, scrub: scrubber() })
    const result = await writeBundle(bundle, { outDir })
    return json(res, 200, { file: result.file, size: result.size, sizeHuman: result.sizeHuman, findings: bundle.findings })
  }
  if (req.method !== 'GET' || verb !== 'download') return json(res, 404, { error: 'not found' })

  const rel = safeRelativePath(url.searchParams.get('file'))
  if (rel === null) return json(res, 400, { error: 'file must be a basename' })
  if (rel.includes('/')) return json(res, 400, { error: 'file must be a basename' })
  if (!rel.endsWith('.zip')) return json(res, 400, { error: 'file must end in .zip' })
  if (!isInside(outDir, path.resolve(outDir, rel))) return json(res, 400, { error: 'file is not inside the exports folder' })

  const file = path.resolve(outDir, rel)
  let size
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return json(res, 404, { error: 'not found' })
  }

  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': size,
    'content-disposition': 'attachment; filename="' + rel + '"',
    'cache-control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
}

// Thin layer; the running-server gates live in worlds.mjs.
async function handleWorlds(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null

  if (req.method === 'GET' && !verb) {
    return json(res, 200, {
      ...(await worlds.listWorlds(inst)),
      running: supervisor.isRunning(name),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)

  if (verb === 'activate') {
    const out = worlds.activateWorld(inst, String(body.name))
    activity.record(name, 'world-activate', { detail: String(body.name) })
    return json(res, 200, out)
  }
  if (verb === 'import') {
    if (!body.source || !body.name) return json(res, 400, { error: 'a source path and a name are required' })
    const out = await worlds.importWorld(inst, String(body.source), { name: String(body.name) })
    activity.record(name, 'world-import', { detail: String(body.name) })
    return json(res, 200, out)
  }
  if (verb === 'export') {
    return json(res, 200, await worlds.exportWorld(inst, String(body.name)))
  }
  if (verb === 'delete') {
    const out = worlds.deleteWorld(inst, String(body.name))
    activity.record(name, 'world-delete', { detail: String(body.name) })
    return json(res, 200, out)
  }
  return json(res, 404, { error: 'not found' })
}

// Modpack version check and update. The core refuses a running server; progress goes through the
// same job stream as creation.
async function handlePack(req, res, name) {
  const inst = registry.getInstance(name)
  if (req.method === 'GET') {
    return json(res, 200, {
      ...(await mrpack.checkPackUpdate(inst)),
      running: supervisor.isRunning(name),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)
  const jobId = body.jobId ? String(body.jobId) : null
  try {
    const result = await mrpack.updatePack(name, {
      onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'pack', message, percent: percent ?? null }),
    })
    jobUpdate(jobId, { stage: 'done', percent: 100, message: 'Pack updated', done: true })
    return json(res, 200, result)
  } catch (err) {
    jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
    throw err
  }
}

// The installed list needs no network; search, install and update checks do.
async function handlePlugins(req, res, name, seg, url) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null
  const gameVersion = plugins.mcVersionOf(inst)
  // plugins on Paper-family servers, mods on Fabric; Hangar only hosts plugins
  const kind = plugins.contentKindFor(inst)

  if (req.method === 'GET' && !verb) {
    const pack = mrpack.packOf(inst)
    return json(res, 200, {
      plugins: plugins.listPlugins(inst),
      running: supervisor.isRunning(name),
      gameVersion,
      kind: kind.kind,
      word: kind.word,
      hangar: kind.hangar,
      software: kind.label,
      pack: pack ? { name: pack.name, version: pack.versionNumber, project: pack.project } : null,
    })
  }
  if (req.method === 'GET' && verb === 'search') {
    const q = String(url.searchParams.get('q') || '').trim()
    if (!q) return json(res, 200, { results: [], errors: [] })
    return json(res, 200, await pluginActions.searchEverywhere(inst, q))
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)

  if (verb === 'toggle') {
    return json(res, 200, plugins.setPluginEnabled(inst, String(body.file), body.enabled === true))
  }
  if (verb === 'delete') {
    return json(res, 200, plugins.removePlugin(inst, String(body.file)))
  }
  if (verb === 'install') {
    if (!body.projectId) return json(res, 400, { error: 'projectId is required' })
    return json(res, 200, await pluginActions.installWithSnapshot(inst, body.projectId, { source: body.source }))
  }
  if (verb === 'updates') {
    return json(res, 200, { updates: await plugins.checkUpdates(inst, { gameVersion }) })
  }
  if (verb === 'update') {
    return json(res, 200, await pluginActions.updateWithSnapshot(inst, body.file))
  }
  // one snapshot for all updates; the page asks for the restart separately
  if (verb === 'update-all') {
    const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : []
    if (!files.length) return json(res, 400, { error: 'files is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    const out = await pluginActions.updateAllWithSnapshot(inst, files, {
      onProgress: ({ file, index, total }) => jobUpdate(jobId, {
        stage: 'update',
        percent: Math.round((index / total) * 100),
        message: `Updating ${file} (${index + 1} of ${total})`,
      }),
    })
    jobUpdate(jobId, { stage: 'done', percent: 100, message: `Updated ${out.updated.length} of ${files.length}`, done: true })
    return json(res, 200, out)
  }
  return json(res, 404, { error: 'not found' })
}

// Writes go through players.mjs: whether a change belongs in a file or down the console depends
// on whether the server is running, and getting it wrong only shows after the next restart.
async function handlePlayers(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null

  if (req.method === 'GET') {
    const here = new Set((await players.onlineNow(inst)).map((n) => n.toLowerCase()))
    const rows = players.listPlayers(inst).map((p) => ({
      ...p,
      online: Boolean(p.name && here.has(p.name.toLowerCase())),
      // the player .dat isn't written until logout or a world save
      joined: p.joined || Boolean(p.name && here.has(p.name.toLowerCase())),
    }))
    return json(res, 200, {
      players: rows,
      running: supervisor.isRunning(name),
      // names can only be recovered in online mode
      onlineMode: safeInstance(supervisor.statusOf(name)).onlineMode,
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  if (!body.uuid) return json(res, 400, { error: 'which player?' })
  const uuid = String(body.uuid)

  const who = () => players.listPlayers(inst).find((p) => p.uuid === uuid)?.name ?? uuid
  if (verb === 'op') {
    const out = await players.setOp(inst, uuid, body.on !== false)
    activity.record(name, body.on !== false ? 'player-op' : 'player-deop', { detail: who() })
    return json(res, 200, out)
  }
  if (verb === 'ban') {
    const out = await players.setBan(inst, uuid, body.on !== false, body.reason)
    activity.record(name, body.on !== false ? 'player-ban' : 'player-unban', { detail: who() + (body.on !== false && body.reason ? `: ${body.reason}` : '') })
    return json(res, 200, out)
  }
  if (verb === 'forget') {
    const out = players.forgetPlayer(inst, uuid)
    activity.record(name, 'player-forget', { detail: out.name ?? uuid })
    return json(res, 200, out)
  }

  return json(res, 404, { error: 'not found' })
}

// Every task id is checked against the instance in the URL; otherwise any name plus another
// server's task id could delete that server's schedule.
async function handleSchedules(req, res, name, seg) {
  registry.getInstance(name)
  if (!platformCapabilities().scheduler) {
    return req.method === 'GET'
      ? json(res, 200, { available: false, reason: PREVIEW_LIMITS.scheduler, tasks: [], runs: [] })
      : json(res, 400, { error: PREVIEW_LIMITS.scheduler })
  }
  const id = seg[4] ?? null
  const verb = seg[5] ?? null

  const mine = async () => (await schedule.list()).filter((t) => t.instance === name)

  const shape = (t) => ({
    id: t.id,
    name: t.name,
    action: t.action,
    schedule: t.schedule,
    enabled: t.enabled,
    owner: t.owner ?? null,
    createdAt: t.createdAt,
    // the OS scheduler is the authority; a task it doesn't know reports known:false
    known: Boolean(t.windows),
    state: t.windows?.state ?? null,
    lastRun: t.windows?.lastRun ?? null,
    lastResult: t.windows ? schedule.describeResult(t.windows.lastResult) : null,
    nextRun: t.windows?.nextRun ?? null,
  })

  if (req.method === 'GET') {
    return json(res, 200, {
      tasks: (await mine()).map(shape),
      runs: schedule.recentRuns(name),
      actions: Object.entries(schedule.ACTIONS).map(([type, meta]) => ({
        type, label: meta.label, needsRunning: meta.needsRunning,
      })),
      kinds: schedule.SCHEDULE_KINDS,
      days: schedule.DAYS,
      running: supervisor.isRunning(name),
      background: schedule.background(),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  // reserved: autoBackupTask adopts unowned tasks by this name, so a user task with it would get
  // adopted and then deleted by the Backups toggle
  if (body.name !== undefined && String(body.name).trim().toLowerCase() === 'automatic backup') {
    return json(res, 400, {
      error: '"Automatic backup" is the name the Backups tab uses for the schedule behind its own '
        + 'toggle. Pick another so the two cannot be confused.',
    })
  }

  if (!id) {
    const made = schedule.create({
      instance: name,
      name: body.name,
      action: body.action,
      schedule: body.schedule,
      enabled: body.enabled !== false,
    })
    return json(res, 200, shape({ ...made, windows: null }))
  }

  const owned = (await mine()).find((t) => t.id === id)
  if (!owned) return json(res, 404, { error: `"${name}" has no scheduled task "${id}"` })

  if (!verb) {
    schedule.update(id, {
      name: body.name,
      action: body.action,
      schedule: body.schedule,
      enabled: body.enabled,
    })
    return json(res, 200, shape((await mine()).find((t) => t.id === id)))
  }

  if (verb === 'enable') {
    schedule.setEnabled(id, body.enabled !== false)
    return json(res, 200, shape((await mine()).find((t) => t.id === id)))
  }

  if (verb === 'run') {
    schedule.runNow(id)
    activity.record(name, 'schedule-run', { detail: owned.name })
    // fired, not finished: schtasks /Run returns once Windows has started the task
    return json(res, 200, { started: true })
  }

  if (verb === 'delete') {
    return json(res, 200, schedule.remove(id))
  }

  return json(res, 404, { error: 'not found' })
}

// Saves the display label from a creation request and returns the instance status.
function labelled(name, raw) {
  const label = cleanLabel(raw)
  if (label && label !== name) registry.updateInstance(name, { label })
  return supervisor.statusOf(name)
}

// strips the root and attachment passwords; the page fetches credentials on demand
function safeDatabase(row) {
  const { root, attachments, tools, ...safe } = row
  const shown = {}
  for (const [server, a] of Object.entries(attachments ?? {})) {
    shown[server] = { database: a.database, user: a.user, createdAt: a.createdAt ?? null }
  }
  const engine = services.ENGINES[row.engine]
  return {
    ...safe,
    engineLabel: engine?.label ?? row.engine,
    engineKind: engine?.kind ?? row.engine,
    external: Boolean(row.external),
    host: row.host ?? '127.0.0.1',
    rootUser: root?.user ?? 'root',
    attachments: shown,
  }
}

// never send the RCON password to the page (browser cache, screenshots, pasted reports)
function safeInstance(row) {
  const { rcon, ...safe } = row
  // online-mode lives in server.properties, not the registry
  let onlineMode = null
  let levelName = null
  try {
    const props = readProps(path.join(row.dir, 'server.properties'))
    onlineMode = props.get('online-mode') !== 'false'
    levelName = props.get('level-name') || 'world'
  } catch {
    /* a missing directory is already reported through status */
  }
  return {
    ...safe, rconPort: rcon?.port ?? null, onlineMode, levelName, javaNeeds: java.requiredMajor(plugins.mcVersionOf(row)),
    // what it would launch with if it had no Java arguments of its own
    ...(registry.isDatabase(row) ? {} : { defaultJvmFlags: registry.jvmFlagsFor(row.memory ?? '4G') }),
  }
}

// The launcher's accounts: the list, offline accounts, the default, sign-out, and the Microsoft
// sign-in (CLIENT.md, "Signing in from the launcher"). Everything here is behind the Host and
// Origin check like every other route, and no answer carries a token: an account is its name,
// uuid, type and two times. The one exception to the Origin rule is the callback, a top-level
// navigation Microsoft's page makes (so it has no Origin header and passes on the Host check);
// it is useless without the state of the one live sign-in, which exists only in this process.
async function handleAccounts(req, res, seg, url) {
  if (seg.length === 3) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    return json(res, 200, { accounts: publicAccounts(), defaultAccount: client.getDefaultAccount() })
  }
  if (seg[3] === 'offline' && seg.length === 4) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readBody(req)
    const account = clientAuth.addOfflineAccount(String(body?.name ?? ''))
    if (client.getDefaultAccount() === null) client.setDefaultAccount(account.uuid)
    return json(res, 200, { account: clientAuth.publicAccount(account), defaultAccount: client.getDefaultAccount() })
  }
  if (seg[3] === 'default' && seg.length === 4) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readBody(req)
    const uuid = body?.uuid === null || body?.uuid === undefined || body?.uuid === '' ? null : String(body.uuid)
    if (uuid !== null && !/^[0-9a-f-]{32,36}$/i.test(uuid)) return json(res, 400, { error: 'uuid must be the account\'s uuid' })
    return json(res, 200, { defaultAccount: client.setDefaultAccount(uuid) })
  }
  if (seg[3] === 'login') {
    if (seg.length === 4) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        return json(res, 200, clientLogin.startLogin({ redirectUri: callbackUri() }))
      } catch (err) {
        if (err instanceof clientLogin.LoginInProgress) return json(res, 409, { error: err.message })
        throw err
      }
    }
    if (seg[4] === 'callback' && seg.length === 5) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      // Answered before the exchange starts: the desktop closes this window as soon as it has
      // loaded, and the outcome goes to the launcher through the stream. Nothing from the query
      // is echoed or logged.
      const { ok } = clientLogin.handleCallback(url.searchParams)
      return callbackPage(res, ok)
    }
    const loginId = seg[4]
    if (typeof loginId !== 'string' || !/^[0-9a-f]{32}$/.test(loginId)) return json(res, 404, { error: 'no such sign-in' })
    if (seg.length === 5 && req.method === 'DELETE') {
      return json(res, 200, { cancelled: clientLogin.cancelLogin(loginId) })
    }
    if (seg.length === 6 && seg[5] === 'stream' && req.method === 'GET') {
      const detach = clientLogin.listenLogin(loginId, (event) => {
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        if (event.status !== 'pending') res.end()
      })
      if (!detach) return json(res, 404, { error: 'no such sign-in; start it again' })
      const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n') }, 20000)
      req.on('close', () => {
        clearInterval(beat)
        detach()
      })
      return
    }
    return json(res, 405, { error: 'method not allowed' })
  }
  if (seg.length === 4 && req.method === 'DELETE') {
    const gone = clientAuth.removeAccount(seg[3])
    if (!gone) return json(res, 404, { error: 'no such account' })
    // the registry drops a default that no longer exists on its next save; do it now so the
    // answer is right
    if (client.loadProfiles().defaultAccount !== undefined) client.saveProfiles(client.loadProfiles())
    return json(res, 200, { removed: gone, defaultAccount: client.getDefaultAccount() })
  }
  return json(res, 405, { error: 'method not allowed' })
}

function callbackUri() {
  if (!panelPort) fail('the panel has no port yet; try again')
  return `http://localhost:${panelPort}/api/client/accounts/login/callback`
}

// What Microsoft's window shows after the redirect: a few words and no script. The window is
// closed by the desktop app within a second; in a browser the tab stays until the person closes
// it. The outcome of the sign-in is never shown here (the stream carries it), so a replayed or
// forged callback learns nothing but "not valid".
function callbackPage(res, ok) {
  const title = ok ? 'Finishing sign-in' : 'This sign-in link is not valid any more'
  const body = ok
    ? 'Finishing the sign-in in SpawnLoft. You can close this window.'
    : 'Start the sign-in again from the SpawnLoft launcher.'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#bbb}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
  res.writeHead(ok ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

// Binding to 127.0.0.1 doesn't stop web pages in the local browser from calling this, and DNS
// rebinding lets a page reach it under its own origin. So: the Host header must be loopback
// (defeats rebinding), and any Origin must match Host exactly, port included. Plugin web UIs
// (dynmap, BlueMap, Plan) run on other loopback ports and render player-chosen text, so a
// hostname-only check would trust them. Requests with no Origin (own fetches, curl, CLI) pass.
const LOOPBACK_HOST = /^(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)(?::\d+)?$/i

function isLocalRequest(req) {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOST.test(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const seg = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/') {
    // the desktop gets a new localhost port (so a new origin) each launch, which loses
    // localStorage; inject the saved theme into the page instead
    const html = readFileSync(path.join(HERE, 'ui.html'), 'utf8')
      .replace('data-theme="classic"', `data-theme="${readTheme()}"`)
      .replace('name="spawnloft-platform" content="win32"', `name="spawnloft-platform" content="${process.platform}"`)
      .replace('name="spawnloft-managed-mysql" content="true"', `name="spawnloft-managed-mysql" content="${services.canManage('mysql')}"`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  // the game launcher's own page, opened as a window of its own; same theme injection as /
  if (url.pathname === '/launcher') {
    const html = readFileSync(path.join(HERE, 'launcher.html'), 'utf8')
      .replace('data-theme="classic"', `data-theme="${readTheme()}"`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  if (seg[0] !== 'api') return json(res, 404, { error: 'not found' })

  // separate from /settings so a palette change can't touch data locations
  if (seg[1] === 'appearance' && seg.length === 2) {
    if (req.method === 'GET') return json(res, 200, { theme: readTheme() })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readBody(req)
    return json(res, 200, { theme: saveTheme(body?.theme) })
  }

  if (seg[1] === 'jars' && req.method === 'GET') {
    return json(res, 200, create.listJars().map((j) => ({ name: j.name, size: j.sizeHuman })))
  }

  // real executable and script paths for an MCP client config; the .cmd launcher can't be started
  // by a client that spawns without a shell on Windows
  if (seg[1] === 'mcp' && seg.length === 2 && req.method === 'GET') {
    return json(res, 200, {
      command: process.execPath,
      args: [path.join(HERE, '..', 'spawnloft.mjs'), 'mcp'],
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    })
  }

  if (seg[1] === 'client' && seg[2] === 'accounts') return handleAccounts(req, res, seg, url)
  if (seg[1] === 'client') return handleClient(req, res, seg, url)

  if (seg[1] === 'health' && req.method === 'GET') {
    return json(res, 200, { java: await java.health(), javaDownload: java.DOWNLOAD_URL })
  }

  if (seg[1] === 'java' && seg[2] === 'needs' && req.method === 'GET') {
    const versions = String(url.searchParams.get('versions') ?? '').split(',').filter(Boolean).slice(0, 500)
    const { best } = await java.discover()
    const needs = {}
    for (const v of versions) needs[v] = java.requiredMajor(v)
    return json(res, 200, { needs, have: best?.major ?? null, download: java.DOWNLOAD_URL })
  }

  if (seg[1] === 'java' && seg.length === 2 && req.method === 'GET') {
    const { best, onPath, all } = await java.discover()
    return json(res, 200, {
      best: best?.path ?? null,
      onPath: onPath.found ? { major: onPath.major, version: onPath.version } : null,
      found: all.map(({ path: p, source, major, version, reason }) => ({ path: p, source, major, version, reason })),
      download: java.DOWNLOAD_URL,
    })
  }

  if (seg[1] === 'feedback' && req.method === 'GET') {
    return json(res, 200, await feedback(url.searchParams.get('instance'), {
      title: String(url.searchParams.get('title') ?? '').slice(0, 120),
    }))
  }

  if (seg[1] === 'diagnostics' && req.method === 'GET') {
    const text = await diagnostics(url.searchParams.get('instance'))
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
    return
  }

  // The data root stays read-only here: it is resolved at import, so changing it live would split
  // instance creation and lookup across directories. backupsDir is settable but applies on restart.
  if (seg[1] === 'settings' && req.method === 'POST') {
    const body = await readBody(req)
    // the mirror is read live, so no restart needed
    if (Object.hasOwn(body, 'backupsMirrorDir')) {
      const raw = String(body.backupsMirrorDir ?? '').trim()
      if (!raw) {
        settings.save({ backupsMirrorDir: null })
        return json(res, 200, { backupsMirrorDir: null })
      }
      const dir = path.resolve(raw)
      const writable = settings.checkWritable(dir)
      if (!writable.ok) return json(res, 400, { error: `SpawnLoft cannot write to ${dir}: ${writable.error}` })
      settings.save({ backupsMirrorDir: dir })
      return json(res, 200, { backupsMirrorDir: dir })
    }
    if (!Object.hasOwn(body, 'backupsDir')) {
      return json(res, 400, { error: 'only backupsDir and backupsMirrorDir can be set from here' })
    }
    const raw = String(body.backupsDir ?? '').trim()
    if (!raw) {
      const fallback = path.join(LAYOUT.dataRoot, 'backups')
      settings.save({ backupsDir: null })
      return json(res, 200, { backupsDir: fallback, restartRequired: fallback !== LAYOUT.backupsDir })
    }
    const dir = path.resolve(raw)
    const writable = settings.checkWritable(dir)
    if (!writable.ok) return json(res, 400, { error: `SpawnLoft cannot write to ${dir}: ${writable.error}` })
    settings.save({ backupsDir: dir })
    return json(res, 200, { backupsDir: dir, restartRequired: dir !== LAYOUT.backupsDir })
  }

  if (seg[1] === 'settings' && req.method === 'GET') {
    return json(res, 200, {
      theme: readTheme(),
      dataRoot: LAYOUT.dataRoot,
      instancesDir: LAYOUT.instancesDir,
      separateInstances: LAYOUT.separateInstances,
      jarsDir: LAYOUT.jarsDir,
      backupsDir: LAYOUT.backupsDir,
      templatesDir: LAYOUT.templatesDir,
      runDir: LAYOUT.runDir,
      settingsFile: LAYOUT.settingsFile,
      usingLegacyLayout: LAYOUT.usingLegacyLayout,
      platform: process.platform,
      capabilities: platformCapabilities(),
    })
  }

  if (seg[1] === 'scheduler' && seg[2] === 'linger' && req.method === 'POST') {
    return json(res, 200, schedule.keepRunningLoggedOut())
  }

  if (seg[1] === 'jobs' && seg[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const id = seg[2]
    const send = (job) => res.write(`data: ${JSON.stringify(job)}\n\n`)
    const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
    // replay current state first: the page opens this stream right after firing the POST, so they race
    const { listeners: _drop, ...snapshot } = job
    send(snapshot)
    job.listeners = job.listeners ?? []
    job.listeners.push(send)
    jobs.set(id, job)
    const beat = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => {
      clearInterval(beat)
      const live = jobs.get(id)
      if (live?.listeners) live.listeners = live.listeners.filter((fn) => fn !== send)
    })
    return
  }

  // the page builds its Software dropdown from this
  if (seg[1] === 'software' && seg.length === 2 && req.method === 'GET') {
    return json(res, 200, software.SOFTWARE.map(({ id, label, content, blurb, slow }) => ({
      id, label, content, blurb, slow: Boolean(slow),
    })))
  }
  if (seg[2] === 'versions' && seg.length === 3 && req.method === 'GET' && software.isSoftware(seg[1])) {
    return json(res, 200, await sources.versionsFor(seg[1]))
  }
  if (seg[1] === 'modpacks' && seg[2] === 'search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim()
    return json(res, 200, { results: q ? await plugins.searchModpacks(q) : [] })
  }

  // databases are kept out of the server list so nothing that iterates servers sees one
  if (seg[1] === 'databases' && seg.length === 2 && req.method === 'GET') {
    // an external database has no daemon to ask, so probe it directly
    const rows = await Promise.all(registry.listServices().map(async (i) => {
      let row
      try {
        row = supervisor.statusOf(i.name)
      } catch {
        row = { ...i, status: 'unknown' }
      }
      if (i.external) row.status = await services.externalStatus(i)
      return safeDatabase(row)
    }))
    return json(res, 200, rows)
  }
  if (seg[1] === 'databases' && seg[2] === 'external' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    const db = await services.registerExternal(String(body.name), {
      engine: services.assertNewEngine(body.engine ? String(body.engine) : services.defaultEngine()),
      host: body.host ? String(body.host) : '127.0.0.1',
      port: body.port ? Number(body.port) : null,
      user: body.user ? String(body.user) : 'root',
      password: body.password != null ? String(body.password) : '',
      tools: body.tools ? String(body.tools) : null,
      label: body.label ?? null,
    })
    return json(res, 200, safeDatabase({ ...db, status: 'reachable' }))
  }
  if (seg[1] === 'databases' && seg[2] === 'engines' && req.method === 'GET') {
    return json(res, 200, Object.entries(services.ENGINES).filter(([id]) => services.NEW_ENGINES.includes(id)).map(([id, e]) => ({ id, label: e.label, defaultPort: e.defaultPort, managed: services.canManage(id), default: id === services.defaultEngine() })))
  }
  if (seg[1] === 'databases' && seg[2] === 'versions' && req.method === 'GET') {
    const engine = services.assertNewEngine(String(url.searchParams.get('engine') || services.defaultEngine()))
    return json(res, 200, await services.versionsFor(engine))
  }
  if (seg[1] === 'databases' && seg.length === 2 && req.method === 'POST') {
    if (!platformCapabilities().managedDatabases) return json(res, 400, { error: PREVIEW_LIMITS.managedDatabases })
    const body = await readBody(req)
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    if (!body.version) return json(res, 400, { error: 'a version is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    if (!services.canManage(body.engine || services.defaultEngine())) return json(res, 400, { error: 'Managed installation of this engine is not available on this platform.' })
    try {
      const db = await services.createDatabase(String(body.name), {
        engine: services.assertNewEngine(body.engine ? String(body.engine) : services.defaultEngine()),
        version: String(body.version),
        port: body.port ? Number(body.port) : null,
        label: body.label ?? null,
        onProgress: (p) => {
          if (p.cached) return jobUpdate(jobId, { stage: 'cached', percent: 100, message: p.message })
          jobUpdate(jobId, {
            stage: p.total ? 'download' : 'setup',
            percent: p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null,
            message: p.message ?? 'Working',
          })
        },
      })
      jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${db.name}`, done: true })
      return json(res, 200, safeDatabase(supervisor.statusOf(db.name)))
    } catch (err) {
      jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
      throw err
    }
  }
  if (seg[1] === 'databases' && seg[2] && registry.hasInstance(seg[2])) {
    const db = seg[2]
    if (!registry.isDatabase(registry.getInstance(db))) return json(res, 404, { error: 'no such database' })
    if (seg[3] === 'credentials' && req.method === 'GET') {
      const server = String(url.searchParams.get('server') || '')
      if (!server) return json(res, 400, { error: 'server is required' })
      return json(res, 200, services.credentials(db, server))
    }
    // root credentials are only sent on request, never in the list
    if (seg[3] === 'root' && req.method === 'GET') {
      const inst = services.getDatabase(db)
      return json(res, 200, { host: inst.host ?? '127.0.0.1', port: inst.port, user: inst.root?.user ?? 'root', password: inst.root?.password ?? '' })
    }
    if (seg[3] === 'backups') return handleDatabaseBackups(req, res, db, seg, url)
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readBody(req)
    if (seg[3] === 'attach') {
      if (!body.server) return json(res, 400, { error: 'server is required' })
      return json(res, 200, await services.attach(db, String(body.server)))
    }
    if (seg[3] === 'detach') {
      if (!body.server) return json(res, 400, { error: 'server is required' })
      return json(res, 200, await services.detach(db, String(body.server), { drop: body.drop === true }))
    }
    if (seg[3] === 'delete') {
      return json(res, 200, services.removeDatabase(db, { purge: body.purge === true }))
    }
    if (seg[3] === 'address') {
      const updated = await services.updateExternal(db, {
        host: body.host != null ? String(body.host) : null,
        port: body.port != null && body.port !== '' ? Number(body.port) : null,
        user: body.user != null ? String(body.user) : null,
        // Left out, or blank, keeps the password it has: the form never holds the old one.
        password: body.password ? String(body.password) : null,
      })
      return json(res, 200, safeDatabase(updated))
    }
    return json(res, 404, { error: 'not found' })
  }
  if (seg[1] === 'databases' && seg[2]) return json(res, 404, { error: 'no such database' })

  if (seg[1] === 'instances' && seg.length === 2 && req.method === 'GET') {
    const rows = registry.listInstances().map((i) => {
      let row
      try {
        row = supervisor.statusOf(i.name)
      } catch {
        row = { ...i, status: 'unknown' }
      }
      return safeInstance(row)
    })
    // newest metrics sample per running server, read from the end of each file
    await Promise.all(rows.map(async (row) => {
      row.latest = row.status === 'running' ? await metrics.latestSample(row.name) : null
    }))
    return json(res, 200, rows)
  }

  if (seg[1] === 'activity' && seg.length === 2 && req.method === 'GET') {
    return json(res, 200, activity.readActivity(activityQuery(url)))
  }

  // The schedule comes from SpawnLoft's task file, not the OS scheduler, which spawns a process
  // per query and this covers every server at once.
  if (seg[1] === 'overview' && seg.length === 2 && req.method === 'GET') {
    const tasks = Object.values(schedule.load().tasks)
    const servers = {}
    await Promise.all(registry.listInstances().map(async (i) => {
      const mine = tasks.filter((t) => t.instance === i.name && t.action?.type === 'backup')
      const auto = mine.find((t) => t.owner === schedule.OWNER_BACKUPS) ?? mine.find((t) => !t.owner && t.name === 'Automatic backup') ?? null
      const kept = await backup.snapshotSummary(i.name)
      servers[i.name] = {
        lastBackupAt: kept.newestAt,
        backupCount: kept.count,
        autoBackup: auto ? { enabled: auto.enabled !== false, schedule: auto.schedule, keep: auto.action.keep ?? null } : null,
      }
    }))
    // No archive on disk is either "never backed up" or "backed up, then deleted"; the log tells
    // which, so the page does not call a server that had eighteen backups this morning "never".
    const bare = Object.keys(servers).filter((n) => !servers[n].backupCount)
    if (bare.length) {
      const trails = activity.backupTrails(bare)
      for (const n of bare) servers[n].backupTrail = trails[n]
    }
    return json(res, 200, {
      machine: { memoryMb: Math.round(os.totalmem() / 1048576) },
      automaticAvailable: platformCapabilities().scheduler,
      servers,
    })
  }

  // adopt an existing server folder; nothing is moved, ports and RCON password are read from its server.properties
  if (seg[1] === 'instances' && seg[2] === 'adopt' && req.method === 'POST') {
    const body = await readBody(req)
    // a label alone is enough; the name is derived from it (the page derives it too)
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    if (!body.dir) return json(res, 400, { error: 'a server folder is required' })
    const inst = await create.adoptInstance(String(body.name), String(body.dir), {
      jar: body.jar ? String(body.jar) : null,
      memory: body.memory ? String(body.memory) : '4G',
    })
    return json(res, 200, safeInstance(labelled(inst.name, body.label)))
  }

  if (seg[1] === 'instances' && req.method === 'POST' && seg.length === 2) {
    const body = await readBody(req)
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    try {
      let jar = body.jar || null
      // a modpack decides the loader, Minecraft version, mods and config itself
      if (body.modpack) {
        const result = await mrpack.createFromModpack(String(body.name), String(body.modpack), {
          memory: body.memory || '4G',
          port: body.port ? Number(body.port) : null,
          onlineMode: body.onlineMode !== false,
          onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'pack', message, percent: percent ?? null }),
        })
        jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${result.name}`, done: true })
        return json(res, 200, { ...safeInstance(labelled(String(body.name), body.label)), pack: result })
      }
      // NeoForge is installer-laid and launched from a starter jar; see neoforge.createServer
      if (body.loader === 'neoforge') {
        if (!body.neoforgeVersion) return json(res, 400, { error: 'a Minecraft version is required for a NeoForge server' })
        const result = await neoforge.createServer(String(body.name), String(body.neoforgeVersion), {
          java: await java.pickJava({
            explicit: body.java ? String(body.java) : null,
            needs: java.requiredMajor(String(body.neoforgeVersion)),
            force: body.force === true,
            what: `Minecraft ${body.neoforgeVersion}`,
          }),
          memory: body.memory || '4G',
          port: body.port ? Number(body.port) : null,
          onlineMode: body.onlineMode !== false,
          onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'neoforge', message, percent: percent ?? null }),
        })
        jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${result.name}`, done: true })
        return json(res, 200, safeInstance(labelled(String(body.name), body.label)))
      }
      // every jar-based loader: resolve the version, fetch or build the jar, place it.
      // The per-loader version field names are still read for pages loaded before `version` existed.
      const loader = sources.isJarSource(body.loader) ? body.loader : 'paper'
      const version = body.version ?? body[`${loader}Version`] ?? body.paperVersion ?? null
      let mcVersion = null
      const onProgress = (p) => {
        if (p.cached) return jobUpdate(jobId, { stage: 'cached', percent: 100, message: p.message ?? 'Server jar already downloaded' })
        if (p.message) return jobUpdate(jobId, { stage: 'build', percent: null, message: p.message })
        jobUpdate(jobId, {
          stage: 'download',
          percent: p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null,
          message: 'Downloading the server jar',
        })
      }
      // pick Java before downloading so an unrunnable version is refused now, not at first start
      const chosenJava = await java.pickJava({
        explicit: body.java ? String(body.java) : null,
        needs: version ? java.requiredMajor(String(version)) : null,
        force: body.force === true,
        what: version ? `Minecraft ${version}` : 'this version',
      })
      if (version) {
        const label = sources.labelFor(loader)
        jobUpdate(jobId, { stage: 'resolve', percent: null, message: `Finding ${label} ${version}` })
        // BuildTools compiles with a JDK; give it the Java the server will use
        const fetched = await sources.fetchJar(loader, String(version), { onProgress, java: chosenJava })
        jar = fetched.name
        mcVersion = String(version)
      } else if (loader !== 'paper') {
        return json(res, 400, { error: `a Minecraft version is required for a ${sources.labelFor(loader)} server` })
      }
      jobUpdate(jobId, { stage: 'create', percent: null, message: 'Setting up the server folder' })
      const inst = await create.newInstance(String(body.name), {
        jar,
        java: chosenJava,
        loader,
        mcVersion,
        memory: body.memory || '4G',
        port: body.port ? Number(body.port) : null,
        motd: body.motd || null,
        onlineMode: body.onlineMode !== false,
        // the person clicking Create is the local operator; no second EULA prompt
        acceptEula: true,
      })
      jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${inst.name}`, done: true })
      return json(res, 200, safeInstance(labelled(inst.name, body.label)))
    } catch (err) {
      // also put the error on the job stream so a watching page shows where it failed
      jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
      throw err
    }
  }

  const name = seg[2]
  if (!name || !registry.hasInstance(name)) return json(res, 404, { error: 'no such instance' })

  if (seg[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const line of supervisor.tailLog(name, 200)) {
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    }
    const stop = supervisor.followLog(name, (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    })
    // heartbeat so idle timeouts don't drop a quiet console
    const beat = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => {
      clearInterval(beat)
      stop()
    })
    return
  }

  // these take GET and POST, so they sit above the POST-only gate below
  if (seg[3] === 'props' && seg[4] === 'raw') return handleRawProps(req, res, name)
  if (seg[3] === 'props') return handleProps(req, res, name)
  if (seg[3] === 'backups') return handleBackups(req, res, name, seg)
  if (seg[3] === 'schedules') return handleSchedules(req, res, name, seg)
  if (seg[3] === 'players') return handlePlayers(req, res, name, seg)
  if (seg[3] === 'plugins') return handlePlugins(req, res, name, seg, url)
  if (seg[3] === 'upgrade') return handleUpgrade(req, res, name)
  if (seg[3] === 'pack') return handlePack(req, res, name)
  if (seg[3] === 'worlds') return handleWorlds(req, res, name, seg)
  if (seg[3] === 'files') return handleFiles(req, res, name, seg, url)
  if (seg[3] === 'activity') return handleActivity(req, res, name, seg, url)
  if (seg[3] === 'icon') return handleIcon(req, res, name, seg)
  if (seg[3] === 'console') return handleConsole(req, res, name, seg)
  if (seg[3] === 'diag') return handleDiag(req, res, name, seg, url)

  if (seg[3] === 'diagnose' && req.method === 'GET') {
    const inst = registry.getInstance(name)
    const findings = diagnose(supervisor.tailLog(name, 400), {
      port: inst.port,
      memory: inst.memory,
      dir: inst.dir,
      crashDir: path.join(inst.dir, 'crash-reports'),
    })
    const crashes = crashReports(inst, { limit: 5 })
    // only while running (a stopped server has no port open); first because the panel shows two findings
    const exposed = supervisor.isRunning(name) ? rconExposure(inst) : null
    if (exposed) findings.unshift({ ...exposed, line: null })
    return json(res, 200, {
      // `line` lets the panel show the console line each finding came from
      findings: findings.map(({ id, title, advice, line }) => ({ id, title, advice, line })),
      crashes: { count: crashes.reports.length, newest: crashes.reports[0] ?? null, dir: crashes.dir },
    })
  }
  if (seg[3] === 'metrics') return handleMetrics(req, res, name, url)
  // attached databases, without passwords
  if (seg[3] === 'databases' && req.method === 'GET') {
    if (seg.length !== 4) return json(res, 404, { error: 'not found' })
    return json(res, 200, services.serverAttachments(name))
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  // supervisor.start waits for ready and reports whether it got there
  const started = async () => {
    const out = await supervisor.start(name)
    const status = safeInstance(supervisor.statusOf(name))
    if (out.failed) return json(res, 500, { error: `"${name}" started but stopped again: ${out.reason}`, status })
    if (out.timedOut) return json(res, 504, { error: `"${name}" is taking longer than usual to come up. Watch the console - it may still finish.`, status })
    return json(res, 200, status)
  }

  if (seg[3] === 'start') return started()
  // create, start and attach a database on the port after the game port; progress goes out on the job stream
  if (seg[3] === 'databases' && seg[4] === 'create') {
    if (!platformCapabilities().managedDatabases) return json(res, 400, { error: PREVIEW_LIMITS.managedDatabases })
    const body = await readBody(req)
    const jobId = body.jobId ? String(body.jobId) : null
    if (!services.canManage(body.engine || services.defaultEngine())) return json(res, 400, { error: 'Managed installation of this engine is not available on this platform.' })
    try {
      const out = await services.createForServer(name, {
        engine: services.assertNewEngine(body.engine ? String(body.engine) : services.defaultEngine()),
        version: body.version ? String(body.version) : null,
        onProgress: (p) => {
          if (p.cached) return jobUpdate(jobId, { stage: 'cached', percent: 100, message: p.message })
          jobUpdate(jobId, {
            stage: p.done ? 'done' : p.total ? 'download' : 'setup',
            percent: p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : p.done ? 100 : null,
            message: p.message ?? 'Working',
            done: Boolean(p.done),
          })
        },
      })
      return json(res, 200, { database: safeDatabase(supervisor.statusOf(out.database.name)), credentials: out.credentials })
    } catch (err) {
      jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
      throw err
    }
  }
  if (seg[3] === 'stop') {
    await supervisor.stop(name)
    return json(res, 200, safeInstance(supervisor.statusOf(name)))
  }
  if (seg[3] === 'restart') {
    await supervisor.stop(name).catch(() => {})
    return started()
  }
  if (seg[3] === 'rename') {
    const body = await readBody(req)
    if (!body.to) return json(res, 400, { error: 'new name is required' })
    return json(res, 200, manage.rename(name, String(body.to)))
  }
  if (seg[3] === 'rebuild') {
    const body = await readBody(req)
    return json(res, 200, await manage.rebuild(name, {
      keepPlugins: body.keepPlugins !== false,
      snapshot: body.snapshot !== false,
    }))
  }
  if (seg[3] === 'delete') {
    const body = await readBody(req)
    return json(res, 200, await manage.destroy(name, { purge: body.purge === true }))
  }
  if (seg[3] === 'reveal') {
    const body = await readBody(req)
    return json(res, 200, { dir: manage.reveal(name, body.sub ? String(body.sub) : null, body.folder ? String(body.folder) : null) })
  }
  if (seg[3] === 'settings') {
    const body = await readBody(req)
    // allowlist, not a merge: a page typo must not rewrite arbitrary registry fields
    const patch = {}
    if (body.memory) {
      // same parser the launcher uses, so what is accepted here will start
      const memory = String(body.memory).trim()
      registry.parseMemoryGb(memory)
      patch.memory = memory
    }
    if (body.port) {
      // range and collision check, same as the CLI's `set`; throws a UserError (400)
      patch.port = registry.assertPortUsable(name, Number(body.port))
    }
    if (body.jar) {
      // place the jar before recording it: the instance runs the jar in its own directory (see placeJar)
      patch.jar = String(body.jar)
      create.placeJar(registry.getInstance(name).dir, patch.jar)
    }
    if (body.java) {
      // probe before recording so a bad path fails here, not at the next start. Any Java that runs
      // is accepted whatever its version; the user may want an old one on purpose.
      const bin = String(body.java).trim()
      const state = await java.probe(bin)
      if (!state.found) return json(res, 400, { error: `${bin} could not be run: ${state.message}` })
      patch.java = bin
    }
    if (Object.hasOwn(body, 'autoRestart')) patch.autoRestart = body.autoRestart === true
    if (Object.hasOwn(body, 'jvmFlags')) patch.jvmFlags = registry.cleanJvmFlags(body.jvmFlags)
    // empty clears it; the panel falls back to the name
    if (Object.hasOwn(body, 'label')) patch.label = cleanLabel(body.label)
    if (Object.hasOwn(body, 'webhook')) {
      const url = String(body.webhook ?? '').trim()
      if (url && !acceptableWebhook(url)) {
        return json(res, 400, { error: 'the webhook must be an http(s) URL - paste the one Discord gives you.' })
      }
      patch.webhook = url || null
    }
    registry.updateInstance(name, patch)
    // the webhook is a credential; history records that it changed, not the value
    const said = Object.entries(patch).map(([k, v]) => k === 'webhook' ? (v ? 'webhook set' : 'webhook removed')
      : k === 'jvmFlags' ? (v ? `Java arguments: ${v.join(' ')}` : 'Java arguments back to the recommended ones')
      : `${k} = ${v}`)
    if (said.length) activity.record(name, 'settings', { detail: said.join(', ') })
    return json(res, 200, safeInstance(supervisor.statusOf(name)))
  }
  if (seg[3] === 'command') {
    const body = await readBody(req)
    if (body.line == null || String(body.line).trim() === '') {
      return json(res, 400, { error: 'a command is required' })
    }
    await supervisor.sendConsole(name, String(body.line))
    return json(res, 200, { sent: true })
  }

  return json(res, 404, { error: 'not found' })
}

function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]]
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // no browser is fine; the URL is printed anyway
    }
  })
}
