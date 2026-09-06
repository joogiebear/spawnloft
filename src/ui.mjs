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
import { LAYOUT } from './paths.mjs'
import * as java from './java.mjs'
import * as backup from './backup.mjs'
import * as schedule from './schedule.mjs'
import { readProps, writeProps } from './props.mjs'
import { storedPlayers } from './players.mjs'
import * as players from './players.mjs'
import * as metrics from './metrics.mjs'
import * as settings from './settings.mjs'
import * as plugins from './plugins.mjs'
import * as upgrade from './upgrade.mjs'
import * as sources from './sources.mjs'
import { repairAfterMove } from './relocate.mjs'
import * as services from './services.mjs'
import * as software from './software.mjs'
import * as mrpack from './mrpack.mjs'
import * as neoforge from './neoforge.mjs'
import * as worlds from './worlds.mjs'
import * as mclogs from './mclogs.mjs'
import { diagnose, crashReports } from './diagnose.mjs'
import { acceptableWebhook } from './notify.mjs'
import { fail, refreshProcessTable, UserError, cleanLabel, slugFor } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * A local control panel for mcctl.
 *
 * <p>Bound to 127.0.0.1 and nothing else. This exposes start/stop and console input, which is
 * remote code execution by another name — it is a convenience for the person at this keyboard, not
 * a service. Binding it to a LAN address would put an unauthenticated server console on the network.
 *
 * <p>Served from Node's own http module with the page as one embedded file: no framework, no build
 * step, and no dependency that can rot between the day this is written and the day it is needed.
 */
export function serve({ port = 8770, host = '127.0.0.1', open = true } = {}) {
  guardProcess()
  watchEventLoop()
  // The first read of the process table is synchronous by design (see util.mjs). Taken now,
  // while nothing is waiting on it, rather than inside the first poll.
  refreshProcessTable()

  // Task shims and launchers name this installation by absolute path. If it moved since they were
  // written (the rename from mcctl to SpawnLoft moved it), they are rewritten before anything can
  // run one. Here because the desktop app always starts the panel; see relocate.mjs.
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
      await route(req, res)
    } catch (err) {
      // A route that threw after starting a stream (the SSE routes write their headers first)
      // cannot be answered with JSON: writeHead would throw ERR_HTTP_HEADERS_SENT from inside
      // this catch, which is an unhandled rejection, which exits the process - and the desktop
      // app's panel with it. Close the stream and let the page reconnect.
      if (res.headersSent) {
        res.end()
        return
      }
      // A refusal ("the server is running", "that is not a port") is the person's to fix and
      // answers 400; anything else is mcctl's fault and answers 500. Both used to be 500.
      const refusal = err instanceof UserError || err?.userFacing === true
      json(res, refusal ? 400 : 500, { error: err?.message ?? String(err), ...(err?.code ? { code: err.code } : {}) })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // Report the port actually bound, not the one asked for: the desktop app passes 0 so the OS
      // picks a free one, and a URL built from the request would point at port zero.
      const bound = server.address().port
      const url = `http://${host}:${bound}/`
      if (open) openBrowser(url)
      resolve({ server, url, port: bound })
    })
  })
}

/**
 * The panel's own log: what went wrong in the panel process, and when it stalled.
 *
 * <p>The console log is the server's; the daemon log is the daemon's. Until this existed the
 * panel process had nowhere to say anything, so a stall or a swallowed failure was invisible to
 * the person reporting "it hesitates sometimes" and to whoever read the report. Appended, never
 * rotated: it only gets a line when something is wrong, and it is included in the diagnostics.
 */
export function panelLog(msg) {
  try {
    fs.mkdirSync(LAYOUT.runDir, { recursive: true })
    fs.appendFile(path.join(LAYOUT.runDir, 'panel.log'), `[${new Date().toISOString()}] ${msg}\n`, () => {})
  } catch {
    /* a log line lost is not worth an error */
  }
}

/**
 * Do not die on a promise nobody caught.
 *
 * <p>Node's default for an unhandled rejection is to exit the process. Here that process is the
 * panel - and in the desktop app, the whole application window - so one forgotten catch on a
 * webhook, a mirror copy or a stream write after the socket closed took everything down with no
 * message. The servers survive either way; the panel should too. Logged, so the leak is found.
 */
let guarded = false
function guardProcess() {
  if (guarded) return
  guarded = true
  process.on('unhandledRejection', (reason) => {
    panelLog(`unhandled rejection: ${reason?.stack ?? reason?.message ?? String(reason)}`)
  })
}

/**
 * Notice when the panel stops answering.
 *
 * <p>Everything the panel does runs on one event loop, so anything synchronous - a child
 * process waited on, a directory walked - holds every request and the console stream for as
 * long as it takes. That is exactly the "weird hesitation" nobody can reproduce on demand.
 * Sampled every second and written to the panel log whenever the loop was held for longer
 * than a quarter of a second, so a report of a stutter comes with the time and the size of it.
 */
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

/** The last lines of the panel log, for the diagnostics bundle. */
function panelLogTail(count) {
  try {
    const lines = fs.readFileSync(path.join(LAYOUT.runDir, 'panel.log'), 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-count)
  } catch {
    return []
  }
}

/**
 * Everything a bug report needs, as one block of text.
 *
 * <p>Without this a report is a screenshot and "it doesn't work". With it, it is the version,
 * the Java, where things live, every server with its status, the panel's own log, and the last
 * lines of the console for the server being looked at. Nothing secret goes in: no RCON
 * password, and no webhook URL - a Discord webhook is a credential, and this text is meant to
 * be pasted somewhere public.
 */
function packageInfo() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  } catch {
    // A checkout without package.json is still a checkout.
    return {}
  }
}

/**
 * Where this project lives on GitHub, from package.json's `repository`.
 *
 * <p>One field, read rather than repeated: the desktop's update feed, the issue template and the
 * feedback links all have to agree on it, and a fork that changes it in one place should not be
 * sending its users' reports to this one.
 */
export function projectUrl() {
  const repo = String(packageInfo().repository ?? '')
  const m = /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repo) ?? /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo)
  return m ? `https://github.com/${m[1]}` : null
}

/**
 * Where ideas and questions go: GitHub Discussions, each straight into its category, so an idea
 * lands in Ideas and a question in Q&A without the person choosing from a list first. A Discord
 * invite belongs here the day one exists, which is why these are strings rather than derived.
 */
const IDEAS_URL = () => `${projectUrl()}/discussions/new?category=ideas`
const QUESTION_URL = () => `${projectUrl()}/discussions/new?category=q-a`

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
    // The console tail is the part that does not fit in a URL; the short form leaves it to the
    // clipboard, and the issue body says so.
    if (!short) {
      lines.push('')
      lines.push(`== ${instanceName}: console (last 60) ==`)
      lines.push(...(recent.length ? recent : ['(empty)']))
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * The two doors of the Feedback sheet, as URLs the page opens in the real browser.
 *
 * <p>A bug report opens GitHub's new-issue form already filled in: the template, a title, and
 * the short diagnostics in the body. Browsers and GitHub both cap a URL at a few thousand
 * characters, so the body carries what fits - version, Java, servers, the panel log tail and
 * the diagnosis - and the full bundle goes to the clipboard for pasting under it. The person
 * only has to say what they were doing. Nothing is sent by mcctl itself; the browser hop is
 * the consent.
 */
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
  // Over the limit, the body is trimmed to what always fits rather than the link failing.
  if (bug.length > 7500) {
    params.set('body', body.slice(0, 7500 - `${home}/issues/new?`.length - 400) + '\n```\n\n(trimmed - paste the full diagnostics from your clipboard)\n')
    bug = `${home}/issues/new?${params}`
  }
  return { bug, ideas: IDEAS_URL(), question: QUESTION_URL(), full }
}

/**
 * Progress for long-running creates.
 *
 * <p>Creating an instance downloads a ~50MB server jar. That is the slowest thing a new user does
 * and the one place where silence reads as a hang, so the create call reports where it has got to
 * and the page streams it. Kept in memory and keyed by an id the caller supplies: a job is only
 * interesting while the page that started it is still open, and a restart losing them is correct.
 */
const jobs = new Map()
const JOB_LIMIT = 32

function jobUpdate(id, patch) {
  if (!id) return
  const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
  Object.assign(job, patch)
  jobs.set(id, job)
  for (const send of job.listeners ?? []) send(job)
  // Oldest first: Map preserves insertion order, so this drops the job least likely to be watched.
  while (jobs.size > JOB_LIMIT) jobs.delete(jobs.keys().next().value)
}

/**
 * The server.properties keys the panel offers.
 *
 * <p>An allowlist, for two reasons. server.properties has around fifty keys and a panel that showed
 * all of them would be a worse text editor than the file already is - `mcctl props` exists for the
 * rest. And several keys are owned by mcctl rather than by the person: the ports and the RCON
 * password come from the registry and syncProps rewrites them on every launch, so letting the page
 * set them would produce a value that silently reverts.
 *
 * <p>`type` is what the page renders. `note` is shown next to the control when the choice has a
 * consequence worth knowing before making it.
 */
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

/**
 * How the settings screen is divided up.
 *
 * <p>Declared beside the fields rather than in the page, so the two cannot drift: a field added
 * above without a group still renders, in a section at the end, instead of quietly vanishing from
 * the only screen that can edit it.
 */
const PROP_GROUPS = [
  { key: 'access', icon: 'user', title: 'Who can join',
    blurb: 'Identity, the whitelist, and how many people at once.' },
  { key: 'gameplay', icon: 'play', title: 'Gameplay',
    blurb: 'The rules the world is played by.' },
  { key: 'world', icon: 'server', title: 'World and load',
    blurb: 'What players see before they join, and how much the server draws for them.' },
]

const PROP_BY_KEY = new Map(EDITABLE_PROPS.map((p) => [p.key, p]))

/** Reject a value the server would reject, before it reaches the file. */
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
  // Text. A newline would split the line and silently create a second key.
  if (/[\r\n]/.test(value)) fail(`${spec.key} cannot contain a line break`)
  return value
}

/**
 * Read or update the properties the panel offers.
 *
 * <p>Writes go through writeProps, which rewrites only the keys it is handed and leaves every other
 * line - and every comment - where it was. The server reads this file once at boot, so a change
 * made while it is running takes effect on the next start, and the response says so rather than
 * leaving someone to wonder why nothing happened.
 */
async function handleProps(req, res, name) {
  const inst = registry.getInstance(name)
  const file = path.join(inst.dir, 'server.properties')
  // A server that has never booted has only the keys mcctl wrote; Paper fills the rest in on its
  // first start. Showing those as blank would be wrong - the server has a value for them, it just
  // has not written it down yet - so the effective default is shown, flagged as not-yet-set.
  const shape = (current) => EDITABLE_PROPS.map((spec) => ({
    ...spec,
    value: current.get(spec.key) ?? spec.fallback,
    set: current.has(spec.key),
  }))

  if (req.method === 'GET') {
    // Who the world already knows about, so the page can warn before online mode is changed under
    // them. Switching does not migrate anyone - it hands everybody a different identity.
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
  return json(res, 200, {
    changed: Object.keys(updates),
    appliesOnRestart: supervisor.isRunning(name),
    fields: shape(readProps(file)),
  })
}

/**
 * Snapshots: what exists, making one, restoring one, throwing one away.
 *
 * <p>Restore is the dangerous one - it extracts over a live server's files while the server holds
 * them open and its own state in memory, which corrupts a world rather than replacing it. The CLI
 * has always refused on a running server; this refuses for the same reason rather than trusting the
 * page to have disabled a button.
 */
async function handleBackups(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const action = seg[4] ?? null

  if (req.method === 'GET') {
    const auto = await autoBackupTask(name)
    return json(res, 200, {
      snapshots: backup.listSnapshots(name),
      dir: path.join(LAYOUT.backupsDir, name),
      root: LAYOUT.backupsDir,
      mirror: backup.mirrorRoot(),
      scopes: backup.SCOPES,
      running: supervisor.isRunning(name),
      auto: auto && {
        id: auto.id,
        enabled: auto.enabled,
        schedule: auto.schedule,
        keep: auto.action.keep ?? null,
        state: auto.windows?.state ?? null,
        lastResult: auto.windows ? schedule.describeResult(auto.windows.lastResult) : null,
        nextRun: auto.windows?.nextRun ?? null,
      },
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  if (!action) {
    // A snapshot of a running server is legitimate - it is what "back up before I try this" means -
    // and createSnapshot excludes the one file the server holds locked.
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
      mirrored: out.mirrored,
      mirrorError: out.mirrorError,
    })
  }

  if (action === 'restore') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    if (supervisor.isRunning(name)) {
      return json(res, 409, {
        error: `"${name}" is running. Stop it before restoring - extracting over a server that has `
          + 'those files open corrupts a world rather than replacing it.',
      })
    }
    const snap = backup.resolveSnapshot(name, String(body.snapshot))
    const out = await backup.restoreSnapshot(inst, snap)
    return json(res, 200, out)
  }

  if (action === 'delete') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    return json(res, 200, backup.removeSnapshot(name, String(body.snapshot)))
  }

  if (action === 'auto') {
    const existing = await autoBackupTask(name)
    if (body.enabled === false) {
      if (existing) schedule.remove(existing.id)
      return json(res, 200, { auto: null })
    }
    // One automatic backup per server - the one this tab owns. A second would race the first for
    // the same tar and prune each other's output. Tasks the user made in the Scheduler tab are not
    // this tab's to touch, and autoBackupTask is what keeps them out of it.
    //
    // Changed in place rather than removed and remade. The old order deleted a working schedule
    // first, so a create that then failed - Task Scheduler service stopped, a transient schtasks
    // error - left the server with no automatic backup at all and a toggle that still read On.
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

/**
 * The one automatic backup the Backups tab owns for this server.
 *
 * <p>Identified by its owner mark, never by "a task whose action is backup" - the Scheduler tab
 * lets people make those too, and matching one of theirs meant the toggle deleted it.
 *
 * <p>The fallback adopts a task made before the mark existed. It is deliberately narrow: the
 * Backups tab has only ever created this task under one name, so a task with that exact name and
 * no owner is one of ours, and anything else is left alone.
 */
async function autoBackupTask(name) {
  const mine = (await schedule.list()).filter((t) => t.instance === name && t.action.type === 'backup')
  return mine.find((t) => t.owner === schedule.OWNER_BACKUPS)
    ?? mine.find((t) => !t.owner && t.name === 'Automatic backup')
    ?? null
}

/**
 * How hard this server has been working.
 *
 * <p>Read from the file the daemon writes rather than measured here: the panel is a different
 * process that may have been started after the server, and CPU is a rate that needs two readings
 * taken by whoever was watching at the time.
 */
function handleMetrics(req, res, name, url) {
  registry.getInstance(name)
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

  const asked = Number(url.searchParams.get('seconds'))
  // Capped at what is kept. Asking for a day gets everything there is rather than an error.
  const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 18000) : 3600
  const status = supervisor.statusOf(name)
  const all = metrics.readSamples(name)
  const cutoff = Math.floor(Date.now() / 1000) - seconds
  // Both the window and what lies outside it. A stopped server whose last run ended an hour ago
  // has nothing in the last five minutes and plenty on disk, and the page has to be able to tell
  // "never measured" from "not in this range" - they call for opposite things to say.
  const newest = all.length ? all[all.length - 1].at : null
  return json(res, 200, {
    samples: all.filter((s) => s.at >= cutoff),
    history: {
      count: all.length,
      oldest: all.length ? all[0].at : null,
      newest,
      // How far back the shortest range would have to reach to catch anything, so the page can
      // name one rather than inviting someone to try all five.
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

/**
 * The server software itself: what Paper offers, and moving to it.
 *
 * <p>GET asks PaperMC what exists - on demand only, so the panel stays off the network until
 * the person clicks. POST with no version is a routine build update; POST naming a version
 * crosses Minecraft versions, which the page has already made someone confirm, and
 * applyUpgrade takes a standard snapshot before anything is swapped.
 */
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

/**
 * Worlds: what the instance holds, switched, imported, exported, deleted.
 *
 * <p>The dangerous gates live in worlds.mjs - a running server cannot switch, export its
 * live world, or delete - so this stays a thin translation layer, the way players.mjs's
 * routes are.
 */
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
    return json(res, 200, worlds.activateWorld(inst, String(body.name)))
  }
  if (verb === 'import') {
    if (!body.source || !body.name) return json(res, 400, { error: 'a source path and a name are required' })
    return json(res, 200, await worlds.importWorld(inst, String(body.source), { name: String(body.name) }))
  }
  if (verb === 'export') {
    return json(res, 200, await worlds.exportWorld(inst, String(body.name)))
  }
  if (verb === 'delete') {
    return json(res, 200, worlds.deleteWorld(inst, String(body.name)))
  }
  return json(res, 404, { error: 'not found' })
}

/**
 * A modpack server's pack: what release it runs, whether a newer one exists, and moving to
 * it. The update refuses a running server in the core - files must not change under a live
 * JVM - and narrates through the same job stream creation uses, because it is the same
 * dozens-of-downloads shape.
 */
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

/**
 * Plugins: what the server loads, and what Modrinth can add to it.
 *
 * <p>The installed list needs no network and always answers. Search, install and the update
 * check reach Modrinth and fail with a readable message when they cannot - the panel offline
 * still manages what is already on disk.
 */
async function handlePlugins(req, res, name, seg, url) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null
  const gameVersion = plugins.mcVersionOf(inst)
  // Plugins on a Paper-family server, mods on a Fabric one - same tab, different folder,
  // vocabulary and Modrinth facet. Hangar hosts only plugins, so mods skip it entirely.
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
      // Enough for the page to say what built this server and what a joining player needs.
      pack: pack ? { name: pack.name, version: pack.versionNumber, project: pack.project } : null,
    })
  }
  if (req.method === 'GET' && verb === 'search') {
    const q = String(url.searchParams.get('q') || '').trim()
    if (!q) return json(res, 200, { results: [], errors: [] })
    // Vanilla loads nothing; a search would send Modrinth an empty loader facet and get a 400.
    if (kind.kind === 'none') return json(res, 200, { results: [], errors: [`${kind.label} runs no plugins or mods`] })
    // Both sources at once. One being down must not blank the other's answers, so each
    // failure becomes a note beside the results rather than an error instead of them.
    const asks = [
      plugins.searchPlugins(q, {
        loaders: plugins.loadersFor(inst),
        projectType: kind.projectType,
      }),
    ]
    if (kind.hangar) asks.push(plugins.searchHangar(q))
    const [modrinthHits, hangarHits] = await Promise.allSettled(asks)
    const errors = []
    if (modrinthHits.status === 'rejected') errors.push(modrinthHits.reason?.message ?? 'Modrinth search failed')
    if (hangarHits && hangarHits.status === 'rejected') errors.push(hangarHits.reason?.message ?? 'Hangar search failed')
    return json(res, 200, {
      results: [
        ...(modrinthHits.value ?? []),
        ...(hangarHits?.value ?? []),
      ],
      errors,
    })
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
    const result = body.source === 'hangar'
      ? await plugins.installFromHangar(inst, String(body.projectId), { gameVersion })
      : await plugins.installPlugin(inst, String(body.projectId), { gameVersion })
    return json(res, 200, result)
  }
  if (verb === 'updates') {
    return json(res, 200, { updates: await plugins.checkUpdates(inst, { gameVersion }) })
  }
  if (verb === 'update') {
    // A snapshot of the plugins alone before anything is replaced: small, fast, and the way
    // back when the new build turns out to be the wrong one.
    await backup.createSnapshot(inst, {
      scope: 'plugins', label: 'pre-update', running: supervisor.isRunning(name),
    })
    return json(res, 200, await plugins.updatePlugin(inst, String(body.file), { gameVersion }))
  }
  return json(res, 404, { error: 'not found' })
}

/**
 * Who a server knows about, and what it thinks of them.
 *
 * <p>Every write goes through players.mjs rather than being decided here, because whether a change
 * belongs in a file or down the console depends on whether the server is running - and getting
 * that wrong is invisible until the next restart undoes it.
 */
async function handlePlayers(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null

  if (req.method === 'GET') {
    const here = new Set((await players.onlineNow(inst)).map((n) => n.toLowerCase()))
    const rows = players.listPlayers(inst).map((p) => ({
      ...p,
      online: Boolean(p.name && here.has(p.name.toLowerCase())),
      // Somebody standing in the world has joined it, whatever the files say - the .dat is not
      // written until they log out or the world saves.
      joined: p.joined || Boolean(p.name && here.has(p.name.toLowerCase())),
    }))
    return json(res, 200, {
      players: rows,
      running: supervisor.isRunning(name),
      // Whether a name can be recovered at all depends on this, and the tab explains the
      // difference rather than leaving an id where a name should be.
      onlineMode: safeInstance(supervisor.statusOf(name)).onlineMode,
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  if (!body.uuid) return json(res, 400, { error: 'which player?' })
  const uuid = String(body.uuid)

  if (verb === 'op') return json(res, 200, await players.setOp(inst, uuid, body.on !== false))
  if (verb === 'ban') return json(res, 200, await players.setBan(inst, uuid, body.on !== false, body.reason))
  if (verb === 'forget') return json(res, 200, players.forgetPlayer(inst, uuid))

  return json(res, 404, { error: 'not found' })
}

/**
 * Scheduled tasks for one server.
 *
 * <p>Scoped to an instance rather than global, and every id is checked to belong to the instance in
 * the URL. Without that check the instance name would be decoration: any name plus another server's
 * task id would delete that server's backup schedule.
 */
async function handleSchedules(req, res, name, seg) {
  registry.getInstance(name)
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
    // Windows is the authority on whether this actually exists and when it last ran. A task mcctl
    // believes in that the scheduler has never heard of reports known:false rather than as working.
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
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  // Reserved, because autoBackupTask still recognises a task by this name when it has no owner
  // mark - that is how a schedule made before the mark existed is adopted. A task the user named
  // the same thing would be adopted instead, and the toggle would then delete it.
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

  // Every id-addressed route below acts on a task, so the ownership check happens once, here.
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
    // Fired, not finished: schtasks /Run returns as soon as Windows has started the task. What it
    // did shows up in the run log a moment later, which is what the panel re-reads.
    return json(res, 200, { started: true })
  }

  if (verb === 'delete') {
    return json(res, 200, schedule.remove(id))
  }

  return json(res, 404, { error: 'not found' })
}

/**
 * An instance as the page is allowed to see it.
 *
 * <p>The RCON password is a credential. The page has never needed it, but only the list route was
 * stripping it - every start, stop, restart and settings response was handing it back, where it
 * lands in a browser cache, a screenshot, or a pasted bug report.
 */
/**
 * Record the display name a creation request carried, once the instance exists, and hand back
 * the instance as the panel will see it. Four creation paths share this rather than each
 * learning about labels.
 */
function labelled(name, raw) {
  const label = cleanLabel(raw)
  if (label && label !== name) registry.updateInstance(name, { label })
  return supervisor.statusOf(name)
}

/**
 * A database for the page. The root password and every attachment's password are stripped: the
 * page asks for one set of credentials when someone clicks, and never holds them otherwise.
 */
function safeDatabase(row) {
  const { root, attachments, tools, ...safe } = row
  const shown = {}
  for (const [server, a] of Object.entries(attachments ?? {})) {
    shown[server] = { database: a.database, user: a.user, createdAt: a.createdAt ?? null, applied: a.applied ?? {} }
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

function safeInstance(row) {
  const { rcon, ...safe } = row
  // Whether anyone can join as any name is a property of the server, not of the registry, so it is
  // read from the file. The panel badges it: an offline server behaves differently for any plugin
  // that keys data by UUID, and its logs get bug reports refused.
  let onlineMode = null
  let levelName = null
  try {
    const props = readProps(path.join(row.dir, 'server.properties'))
    onlineMode = props.get('online-mode') !== 'false'
    levelName = props.get('level-name') || 'world'
  } catch {
    /* a directory that has gone missing is already reported through status */
  }
  return { ...safe, rconPort: rcon?.port ?? null, onlineMode, levelName, javaNeeds: java.requiredMajor(plugins.mcVersionOf(row)) }
}

/**
 * Whether this request was actually addressed to the loopback panel.
 *
 * <p>Binding to 127.0.0.1 stops other machines connecting; it does not stop the browser already on
 * this machine. Any web page can point a script at http://127.0.0.1:8770, and DNS rebinding lets a
 * page reach it under its own origin. This endpoint can start processes and type into a server
 * console, so "local" has to mean local, not merely reachable.
 *
 * <p>Two checks, both cheap: the Host header must name a loopback address, which defeats rebinding
 * (the attacker's own hostname is what arrives); and an Origin, when there is one, must match that
 * Host exactly - port included. Requests with no Origin - the panel's own fetches, curl, the CLI -
 * are allowed through, because that is what a first-party request looks like.
 *
 * <p>The port is the half that matters here and was missing. Comparing only the hostname made
 * every page on loopback first-party, and this machine is full of them: dynmap, BlueMap, Plan and
 * friends all serve web UIs on their own loopback ports, all of them rendering names and chat that
 * players chose. One stored-content injection in a map plugin was enough to reach an endpoint that
 * can type into a server console.
 */
const LOOPBACK_HOST = /^(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)(?::\d+)?$/i

function isLocalRequest(req) {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOST.test(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    // Exact match against our own Host, not merely "also on loopback".
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
    const html = readFileSync(path.join(HERE, 'ui.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  if (seg[0] !== 'api') return json(res, 404, { error: 'not found' })

  if (seg[1] === 'jars' && req.method === 'GET') {
    return json(res, 200, create.listJars().map((j) => ({ name: j.name, size: j.sizeHuman })))
  }

  // ---- prerequisites ---------------------------------------------------------
  // Java is the one thing mcctl needs and cannot provide. Asked here so the panel can say so up
  // front instead of letting it surface as "spawn java ENOENT" after a fifty-megabyte download.
  if (seg[1] === 'health' && req.method === 'GET') {
    return json(res, 200, { java: await java.health(), javaDownload: java.DOWNLOAD_URL })
  }

  // ---- what Java each version needs, next to what is installed -----------------
  if (seg[1] === 'java' && seg[2] === 'needs' && req.method === 'GET') {
    const versions = String(url.searchParams.get('versions') ?? '').split(',').filter(Boolean).slice(0, 500)
    const { best } = await java.discover()
    const needs = {}
    for (const v of versions) needs[v] = java.requiredMajor(v)
    return json(res, 200, { needs, have: best?.major ?? null, download: java.DOWNLOAD_URL })
  }

  // ---- every Java on this machine, for the per-server picker ----------------
  if (seg[1] === 'java' && seg.length === 2 && req.method === 'GET') {
    const { best, onPath, all } = await java.discover()
    return json(res, 200, {
      best: best?.path ?? null,
      onPath: onPath.found ? { major: onPath.major, version: onPath.version } : null,
      found: all.map(({ path: p, source, major, version, reason }) => ({ path: p, source, major, version, reason })),
      download: java.DOWNLOAD_URL,
    })
  }

  // ---- the feedback doors: prefilled issue, discussions, full bundle ---------
  if (seg[1] === 'feedback' && req.method === 'GET') {
    return json(res, 200, await feedback(url.searchParams.get('instance'), {
      title: String(url.searchParams.get('title') ?? '').slice(0, 120),
    }))
  }

  // ---- a bug report's worth of facts, as text ------------------------------
  if (seg[1] === 'diagnostics' && req.method === 'GET') {
    const text = await diagnostics(url.searchParams.get('instance'))
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
    return
  }

  // ---- where everything lives, for the settings screen ----------------------
  // The data root itself stays read-only here: it is resolved at import, and a process that
  // created an instance in one directory and looked for it in another would be worse than a
  // restart. backupsDir is settable because nothing holds a snapshot open across the change - but
  // it still only takes effect on restart, and the response says so rather than implying otherwise.
  if (seg[1] === 'settings' && req.method === 'POST') {
    const body = await readBody(req)
    // The mirror reads live from settings, so unlike backupsDir it needs no restart.
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
    })
  }

  // ---- progress for a create in flight -------------------------------------
  if (seg[1] === 'jobs' && seg[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const id = seg[2]
    const send = (job) => res.write(`data: ${JSON.stringify(job)}\n\n`)
    const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
    // Replay first: the page opens this stream immediately after firing the POST, and the two
    // race. Whatever has already happened is sent before anything new is.
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

  // ---- what can be created, and the versions each offers ---------------------
  // The page builds its Software dropdown from this, so the list of kinds lives in one table.
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

  // ---- databases -----------------------------------------------------------
  // Listed apart from the servers: the page draws them under their own heading, and nothing that
  // iterates servers should ever see one.
  if (seg[1] === 'databases' && seg.length === 2 && req.method === 'GET') {
    // An external database has no daemon to ask, so it is asked itself, briefly, in parallel.
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
      engine: body.engine ? String(body.engine) : 'mariadb',
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
    return json(res, 200, Object.entries(services.ENGINES).map(([id, e]) => ({ id, label: e.label, defaultPort: e.defaultPort })))
  }
  if (seg[1] === 'databases' && seg[2] === 'versions' && req.method === 'GET') {
    const engine = String(url.searchParams.get('engine') || 'mariadb')
    return json(res, 200, await services.versionsFor(engine))
  }
  if (seg[1] === 'databases' && seg.length === 2 && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    if (!body.version) return json(res, 400, { error: 'a version is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    try {
      const db = await services.createDatabase(String(body.name), {
        engine: body.engine ? String(body.engine) : 'mariadb',
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
    // Root, for the person: shown on a click under the database's Settings, never in the list.
    if (seg[3] === 'root' && req.method === 'GET') {
      const inst = services.getDatabase(db)
      return json(res, 200, { host: inst.host ?? '127.0.0.1', port: inst.port, user: inst.root?.user ?? 'root', password: inst.root?.password ?? '' })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readBody(req)
    if (seg[3] === 'attach') {
      if (!body.server) return json(res, 400, { error: 'server is required' })
      return json(res, 200, services.attach(db, String(body.server)))
    }
    if (seg[3] === 'detach') {
      if (!body.server) return json(res, 400, { error: 'server is required' })
      return json(res, 200, services.detach(db, String(body.server), { drop: body.drop === true }))
    }
    if (seg[3] === 'apply') {
      if (!body.server || !body.plugin) return json(res, 400, { error: 'server and plugin are required' })
      return json(res, 200, services.applyToPlugin(db, String(body.server), String(body.plugin)))
    }
    if (seg[3] === 'delete') {
      return json(res, 200, services.removeDatabase(db, { purge: body.purge === true }))
    }
    return json(res, 404, { error: 'not found' })
  }
  if (seg[1] === 'databases' && seg[2]) return json(res, 404, { error: 'no such database' })

  // ---- instances -----------------------------------------------------------
  if (seg[1] === 'instances' && seg.length === 2 && req.method === 'GET') {
    const rows = registry.listInstances().map((i) => {
      let row
      try {
        row = supervisor.statusOf(i.name)
      } catch {
        row = { ...i, status: 'unknown' }
      }
      // The page never needs the RCON password, so it never receives it. Local-only or not,
      // a credential that is not sent cannot be read out of a browser cache or a screenshot.
      return safeInstance(row)
    })
    return json(res, 200, rows)
  }

  // ---- adopt a server that already exists ----------------------------------
  // The most likely person to download mcctl already runs a Minecraft server. Registering the
  // folder they have is a first-class path, not an advanced one, so the empty panel offers it
  // next to "create". Nothing is moved or rewritten - the core reads the ports and RCON password
  // out of the directory's own server.properties.
  if (seg[1] === 'instances' && seg[2] === 'adopt' && req.method === 'POST') {
    const body = await readBody(req)
    // A label alone is enough: the name - the folder, the registry key - is derived from it, and
    // made unique if the obvious one is taken. The panel derives it too, so the person sees it.
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
    // A label alone is enough: the name - the folder, the registry key - is derived from it, and
    // made unique if the obvious one is taken. The panel derives it too, so the person sees it.
    if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))
    if (!body.name) return json(res, 400, { error: 'name is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    try {
      let jar = body.jar || null
      // A modpack is a whole different creation path: the pack decides the loader, the
      // Minecraft version, the mods and the config; the person decides the name and memory.
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
      // NeoForge is its own creation path too: installer-laid, starter-jar launched, and the
      // whole build-or-tear-down flow lives in neoforge.createServer.
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
      // Every jar-shaped kind - Paper, Purpur, Folia, ASP, vanilla, Spigot, CraftBukkit, Fabric -
      // takes the same road: resolve the version, fetch or build the jar into the store, place
      // it. `version` is the field; the older per-loader names are still read for a page that
      // was loaded before this changed.
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
      // Which Java, decided before the download: the one named, or the newest installed that
      // the version can run on. A version nothing here can run is refused now, not at first
      // start - unless the page asked to go ahead anyway.
      const chosenJava = await java.pickJava({
        explicit: body.java ? String(body.java) : null,
        needs: version ? java.requiredMajor(String(version)) : null,
        force: body.force === true,
        what: version ? `Minecraft ${version}` : 'this version',
      })
      if (version) {
        const label = sources.labelFor(loader)
        jobUpdate(jobId, { stage: 'resolve', percent: null, message: `Finding ${label} ${version}` })
        // BuildTools compiles with a JDK: hand it the same Java the server will get.
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
        // The panel is local and the person clicking Create is the operator; making them re-accept
        // the EULA in a second place would be ceremony, not consent.
        acceptEula: true,
      })
      jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${inst.name}`, done: true })
      return json(res, 200, safeInstance(labelled(inst.name, body.label)))
    } catch (err) {
      // The POST answers with the error too; the job carries it as well so a page that is watching
      // the stream shows the failure at the step it happened on rather than a bare rejected fetch.
      jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
      throw err
    }
  }

  const name = seg[2]
  if (!name || !registry.hasInstance(name)) return json(res, 404, { error: 'no such instance' })

  // ---- console stream (SSE) ------------------------------------------------
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
    // A heartbeat keeps proxies and idle-timeouts from silently dropping a console that is simply
    // quiet — a stopped server produces no output, and a dead stream looks exactly the same.
    const beat = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => {
      clearInterval(beat)
      stop()
    })
    return
  }

  // Reads and writes, so it sits above the gate that allows only POST past this point.
  if (seg[3] === 'props') return handleProps(req, res, name)
  if (seg[3] === 'backups') return handleBackups(req, res, name, seg)
  if (seg[3] === 'schedules') return handleSchedules(req, res, name, seg)
  if (seg[3] === 'players') return handlePlayers(req, res, name, seg)
  if (seg[3] === 'plugins') return handlePlugins(req, res, name, seg, url)
  if (seg[3] === 'upgrade') return handleUpgrade(req, res, name)
  if (seg[3] === 'pack') return handlePack(req, res, name)
  if (seg[3] === 'worlds') return handleWorlds(req, res, name, seg)
  if (seg[3] === 'console') return handleConsole(req, res, name, seg)

  // What went wrong, in words: the known failure shapes found in this server's console,
  // plus the crash reports Minecraft itself wrote.
  if (seg[3] === 'diagnose' && req.method === 'GET') {
    const inst = registry.getInstance(name)
    const findings = diagnose(supervisor.tailLog(name, 400), {
      port: inst.port,
      memory: inst.memory,
      dir: inst.dir,
      crashDir: path.join(inst.dir, 'crash-reports'),
    })
    const crashes = crashReports(inst, { limit: 5 })
    return json(res, 200, {
      // The line each finding was read from rides along, so the panel can put it in front of
      // the person in the console rather than telling them to go and look for it.
      findings: findings.map(({ id, title, advice, line }) => ({ id, title, advice, line })),
      crashes: { count: crashes.reports.length, newest: crashes.reports[0] ?? null, dir: crashes.dir },
    })
  }
  if (seg[3] === 'metrics') return handleMetrics(req, res, name, url)
  // The databases this server is attached to, without passwords; those are one click further.
  if (seg[3] === 'databases' && seg[4] === 'helpers' && req.method === 'GET') {
    const engine = url.searchParams.get('engine')
    return json(res, 200, services.helpersFor(name, { engine: engine || null }))
  }
  if (seg[3] === 'databases' && req.method === 'GET') {
    return json(res, 200, services.serverAttachments(name))
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  /**
   * Start, and say so only if it actually started.
   *
   * <p>supervisor.start waits for Paper to report ready and returns whether it did. That result was
   * being thrown away, so a server that died on a bad jar, a taken port or an unaccepted EULA
   * answered 200 and the panel said "started" over a console full of the reason it had not.
   */
  const started = async () => {
    const out = await supervisor.start(name)
    const status = safeInstance(supervisor.statusOf(name))
    if (out.failed) return json(res, 500, { error: `"${name}" started but stopped again: ${out.reason}`, status })
    if (out.timedOut) return json(res, 504, { error: `"${name}" is taking longer than usual to come up. Watch the console - it may still finish.`, status })
    return json(res, 200, status)
  }

  if (seg[3] === 'start') return started()
  // A database of this server's own, in one step: made on the port after the game port, started,
  // attached. Progress goes out on the job stream the Add sheet uses, since the download is the
  // long part and a button that sits there for a minute with nothing to say looks broken.
  if (seg[3] === 'databases' && seg[4] === 'create') {
    const body = await readBody(req)
    const jobId = body.jobId ? String(body.jobId) : null
    try {
      const out = await services.createForServer(name, {
        engine: body.engine ? String(body.engine) : 'mariadb',
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
    return json(res, 200, { dir: manage.reveal(name, body.sub ? String(body.sub) : null) })
  }
  if (seg[3] === 'settings') {
    const body = await readBody(req)
    // Only the fields the panel offers. An allowlist rather than a merge: a settings endpoint that
    // writes whatever it is handed is how a typo in the page silently rewrites the registry.
    const patch = {}
    if (body.memory) {
      // parseMemoryGb throws a readable message for anything that is not 4G or 6144M, and it is
      // the same parser the launcher uses - so what the panel accepts is exactly what will start.
      const memory = String(body.memory).trim()
      registry.parseMemoryGb(memory)
      patch.memory = memory
    }
    if (body.port) {
      // Range and collision, the same check the CLI's `set` runs. A port already spoken for by
      // another instance would collide the next time both start, and the failure would show up
      // minutes later as a server that would not boot. Throws a UserError, which answers 400.
      patch.port = registry.assertPortUsable(name, Number(body.port))
    }
    if (body.jar) {
      // Placed before it is recorded, for the reason spelled out on placeJar: an instance runs the
      // jar in its own directory, and a registry entry naming one that is not there is a server
      // that cannot start. Throws a readable message when the jar is not in the store.
      patch.jar = String(body.jar)
      create.placeJar(registry.getInstance(name).dir, patch.jar)
    }
    if (body.java) {
      // Asked its version before it is recorded. A path that cannot be run would otherwise sit in
      // the registry and fail at the next start, which is when nobody is looking at this screen.
      // Any Java that runs is accepted, whatever its version: a test server for an old plugin may
      // want 17 on purpose, and which Java a server runs on is the person's call, not this one's.
      const bin = String(body.java).trim()
      const state = await java.probe(bin)
      if (!state.found) return json(res, 400, { error: `${bin} could not be run: ${state.message}` })
      patch.java = bin
    }
    if (Object.hasOwn(body, 'autoRestart')) patch.autoRestart = body.autoRestart === true
    // Empty clears it, and the panel falls back to the name.
    if (Object.hasOwn(body, 'label')) patch.label = cleanLabel(body.label)
    if (Object.hasOwn(body, 'webhook')) {
      const url = String(body.webhook ?? '').trim()
      if (url && !acceptableWebhook(url)) {
        return json(res, 400, { error: 'the webhook must be an http(s) URL - paste the one Discord gives you.' })
      }
      patch.webhook = url || null
    }
    registry.updateInstance(name, patch)
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
      // No browser is not an error: the URL is printed either way.
    }
  })
}
