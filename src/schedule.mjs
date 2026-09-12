import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'

import { DATA_ROOT, ROOT, RUN_DIR } from './paths.mjs'
import { readJson, writeJson, fail, validateName } from './util.mjs'
import { platformCapabilities, PREVIEW_LIMITS } from './platform.mjs'
import * as mac from './schedule-mac.mjs'

/**
 * Scheduled work, run by Windows.
 *
 * <p>Anything that has to happen while nobody is watching - a nightly backup, a restart at 5am -
 * needs something alive to run it, and mcctl has nothing that qualifies. The per-instance daemons
 * only exist while their server runs, so a stopped server would never be backed up. The desktop app
 * is a window someone closes. Writing a service of our own would mean owning startup, restart after
 * reboot, and the question of whether it is running at all.
 *
 * <p>Windows already has that daemon. Task Scheduler survives reboots, needs no privileges to use
 * for the current user, and records the exit code and next run time of everything it fires - which
 * is most of what a schedule screen has to show, without inventing a log.
 *
 * <p>Tasks run <b>interactive only</b>: while the person is logged in, including with the screen
 * locked, but not after a sign-out. Running regardless would mean storing a Windows password in the
 * task definition, which is not a thing to do quietly for a nightly backup. The panel shows the
 * mode rather than leaving it to be discovered at 3am.
 *
 * <p>The definitions live here, in mcctl's own file, and Task Scheduler holds only a trigger that
 * calls back into `mcctl task run <id>`. Two reasons: what a task DOES stays inside mcctl, where it
 * can be constrained to the handful of things a task is allowed to be; and editing a task's action
 * does not mean recreating a Windows task.
 */

const TASKS_FILE = () => path.join(DATA_ROOT, 'schedules.json')

/** One folder, so everything mcctl created can be removed in a single call at uninstall. */
export const TASK_FOLDER = 'mcctl'

const EMPTY = { version: 1, tasks: {} }

/**
 * What a scheduled task is allowed to do.
 *
 * <p>An allowlist rather than a command string, because a scheduler that runs arbitrary commands is
 * a way to execute anything as the logged-in user, written into a file that nothing guards.
 */
export const ACTIONS = {
  backup: { label: 'Take a backup', needsRunning: false },
  // A backup only exists at restore time; this reads every snapshot back on a clock so a
  // corrupt one is found the week it happened, and the webhook hears about it at 3am
  // instead of nobody hearing about it on the day it mattered.
  verify: { label: 'Verify the backups', needsRunning: false },
  command: { label: 'Run a server command', needsRunning: true },
  restart: { label: 'Restart the server', needsRunning: false },
  stop: { label: 'Stop the server', needsRunning: true },
  start: { label: 'Start the server', needsRunning: false },
}

/**
 * What Task Scheduler's last-result codes mean.
 *
 * <p>They are HRESULTs, and the informational ones look exactly like failures: a task that has
 * simply never run reports 267011, which rendered as "exit 267011" reads like something broke at
 * 3am. Only 0 means it ran and succeeded; anything not listed here is a genuine exit code from
 * whatever the task invoked.
 */
const TASK_RESULT = {
  0: 'ok',
  267008: 'ready',
  267009: 'running',
  267010: 'disabled',
  267011: 'not run yet',
  267012: 'no more runs scheduled',
  267014: 'stopped by user',
  267045: 'queued',
  2147750687: 'already running, so this run was skipped',
  2147943645: 'not run - the machine was not logged in',
}

/** Days schtasks accepts for /SC WEEKLY, in the order a week is usually drawn. */
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

export const SCHEDULE_KINDS = ['minutes', 'hourly', 'daily', 'weekly', 'onlogon']

/**
 * Check a schedule before Windows sees it.
 *
 * <p>schtasks is not a validator. Handed a time it cannot parse it fails loudly, which is fine; but
 * handed `/MO 0` or `/MO 9999` it can create a task that simply never fires, and a backup schedule
 * that silently never runs is the worst outcome this module has. Everything is therefore checked
 * and clamped here, once, so the panel and the CLI cannot disagree about what is allowed.
 *
 * <p>Returns a new object rather than editing the caller's: what gets stored should be exactly what
 * was validated, not whatever shape arrived over HTTP.
 */
export function normaliseSchedule(input) {
  const kind = String(input?.kind ?? '')
  if (!SCHEDULE_KINDS.includes(kind)) {
    fail(`unknown schedule kind "${kind}" - expected one of ${SCHEDULE_KINDS.join(', ')}`)
  }
  if (kind === 'onlogon') return { kind }

  if (kind === 'minutes' || kind === 'hourly') {
    const every = Number(input.every)
    if (!Number.isInteger(every) || every < 1) fail('the interval must be a whole number of at least 1')
    // schtasks tops out at 1439 minutes and 23 hours for /MO; past that the task is created and
    // never fires, which looks exactly like a working schedule until the night it matters.
    const max = kind === 'minutes' ? 1439 : 23
    if (every > max) fail(`the largest ${kind} interval Windows accepts is ${max}`)
    return { kind, every }
  }

  const at = String(input.at ?? '')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) fail(`"${at}" is not a time - use HH:MM on a 24 hour clock`)
  if (kind === 'daily') return { kind, at }

  const day = String(input.day ?? '').toUpperCase()
  if (!DAYS.includes(day)) fail(`"${input.day}" is not a day - use one of ${DAYS.join(', ')}`)
  return { kind, day, at }
}

/**
 * Check an action, and keep only the fields that action actually uses.
 *
 * <p>Whatever else arrived is dropped rather than stored. schedules.json is a file that causes code
 * to run on a timer; it should hold the five things a task can be and nothing a caller invented.
 */
export function normaliseAction(input) {
  const type = String(input?.type ?? '')
  if (!Object.hasOwn(ACTIONS, type)) {
    fail(`unknown action "${type}" - expected one of ${Object.keys(ACTIONS).join(', ')}`)
  }
  if (type === 'command') {
    const line = String(input.line ?? '').trim()
    if (!line) fail('a command is required')
    if (line.length > 400) fail('that command is too long for a console line')
    return { type, line }
  }
  if (type === 'backup') {
    const keep = Number(input.keep)
    return { type, keep: Number.isInteger(keep) && keep > 0 ? Math.min(keep, 365) : null }
  }
  if (type === 'restart') {
    // Minutes of warning the players get first, said over the console. Zero is a legitimate
    // choice - a restart at 5am on an empty server has nobody to warn - and the cap keeps a
    // typo from becoming a task that spends an hour counting down.
    const warn = Number(input.warnMinutes)
    return { type, warnMinutes: Number.isInteger(warn) && warn > 0 ? Math.min(warn, 60) : 0 }
  }
  return { type }
}

export function describeResult(code) {
  if (code == null) return 'unknown'
  return TASK_RESULT[code] ?? `failed (exit ${code})`
}

export function load() {
  const data = readJson(TASKS_FILE(), EMPTY)
  if (!data.tasks) data.tasks = {}
  return data
}

export async function list() {
  const data = load()
  const live = process.platform === 'darwin' ? await mac.query(data.tasks, recentRuns) : await queryWindows()
  return Object.entries(data.tasks)
    .map(([id, task]) => ({ id, ...task, windows: live.get(id) ?? null }))
    .sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name))
}

/**
 * The scheduler's answer, kept for a few seconds.
 *
 * <p>Asking Windows means starting PowerShell and loading its ScheduledTasks module, which is
 * the better part of a second on a good day and several on a cold one. The panel asks on every
 * Backups tab load and every Scheduler tab load, and the Backups tab asks just to find its own
 * one task. A three-second memory turns a burst of those into one spawn, and a burst that lands
 * while one is in flight joins it rather than starting a second PowerShell. Any write to the
 * scheduler forgets it, so a task just made or removed never shows its old state.
 *
 * <p>Asked asynchronously. The panel is one process, and a synchronous PowerShell held every
 * other request - and the console stream - for as long as it took, which read on the page as
 * the whole panel hesitating whenever the Backups tab opened.
 */
let windowsCache = { at: 0, rows: null }
let windowsInFlight = null
// Bumped by every write. A query that was already running when a task was changed answers
// about the scheduler as it was, and must not be remembered as the scheduler as it is.
let windowsGeneration = 0
const WINDOWS_CACHE_MS = 3000

function forgetWindows() {
  windowsCache = { at: 0, rows: null }
  windowsInFlight = null
  windowsGeneration++
}

/**
 * What Windows says about the tasks it is holding for us.
 *
 * <p>Read from the scheduler rather than remembered here, because the scheduler is the thing that
 * actually ran them. A task mcctl believes in that Windows has never heard of - someone deleted it
 * in Task Scheduler - shows as null rather than as working.
 */
function queryWindows() {
  if (windowsCache.rows && Date.now() - windowsCache.at < WINDOWS_CACHE_MS) {
    return Promise.resolve(windowsCache.rows)
  }
  if (windowsInFlight) return windowsInFlight
  // Everywhere but Windows there is no scheduler to ask, and spawning powershell to find that
  // out would cost a failed spawn per call.
  if (process.platform !== 'win32') {
    windowsCache = { at: Date.now(), rows: new Map() }
    return Promise.resolve(windowsCache.rows)
  }
  const generation = windowsGeneration
  const query = new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-ScheduledTask -TaskPath '\\${TASK_FOLDER}\\' -ErrorAction SilentlyContinue | ` +
        'ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; ' +
        // Round-trip ("o") rather than [string]. Casting a DateTime to a string gives whatever the
        // machine's locale prints, and on a machine that writes 31/08/2026 the panel's Date() saw an
        // invalid date and fell back to showing the raw text. ISO parses the same everywhere, and the
        // page formats it into the reader's own locale afterwards.
        '[pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; ' +
        'lastRun=$(if ($i.LastRunTime) { $i.LastRunTime.ToString("o") }); ' +
        'lastResult=$i.LastTaskResult; ' +
        'nextRun=$(if ($i.NextRunTime) { $i.NextRunTime.ToString("o") }) } } | ' +
        // No -AsArray: that needs PowerShell 6+, and Windows ships 5.1. A single task therefore
        // comes back as an object rather than a one-element array, which is handled below.
        'ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const current = generation === windowsGeneration
        if (current) windowsInFlight = null
        const out = new Map()
        if (current) windowsCache = { at: Date.now(), rows: out }
        if (err || !String(stdout ?? '').trim()) return resolve(out)
        try {
          const parsed = JSON.parse(stdout)
          for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
            // Task Scheduler reports a task that has never run as having run in 1999. Passing that
            // on would put "Nov 30 1999" in front of someone as the last time their backup happened.
            if (row.lastRun && new Date(row.lastRun).getFullYear() < 2000) row.lastRun = null
            out.set(row.name, row)
          }
        } catch {
          /* nothing usable from the scheduler; every task reports as unknown */
        }
        resolve(out)
      },
    )
  })
  windowsInFlight = query
  return query
}

/**
 * The batch file a task actually runs.
 *
 * <p>A scheduled task starts with no environment, so ELECTRON_RUN_AS_NODE cannot be inherited - and
 * without it the desktop build's own executable would relaunch the application rather than run the
 * CLI. Putting it in a file also keeps a command line with three quoted paths out of the task
 * definition, where quoting it correctly is its own small nightmare.
 */
function writeShim(id) {
  if (process.platform === 'darwin') return mac.writeShim(id)
  const dir = path.join(DATA_ROOT, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  const shim = path.join(dir, `${id}.cmd`)
  const cli = path.join(ROOT, 'mcctl.mjs')
  const exe = process.execPath
  const viaElectron = Boolean(process.versions.electron)
  const runner = /[\\/]node(?:\.exe)?$/i.test(exe) ? 'node' : `"${exe}"`
  const lines = [
    '@echo off',
    viaElectron ? 'set ELECTRON_RUN_AS_NODE=1' : null,
    `${runner} "${cli}" task run ${id}`,
    'exit /b %errorlevel%',
  ].filter(Boolean)
  fs.writeFileSync(shim, lines.join('\r\n') + '\r\n')
  return shim
}

/**
 * Rewrite every task's shim for the runtime running now.
 *
 * <p>A shim names the executable and the code folder by absolute path, so an installation that
 * moved - the rename from mcctl to SpawnLoft moved it - leaves every scheduled task pointing at a
 * file that is no longer there, and a nightly backup that fails silently. Task Scheduler only ever
 * holds the shim's path, which lives in the data folder and did not move, so rewriting the shims is
 * the whole repair. See relocate.mjs for when this runs.
 */
export function rewriteShims() {
  const ids = Object.keys(load().tasks)
  for (const id of ids) writeShim(id)
  return ids.length
}

/** Translate a schedule into the schtasks flags that express it. */
function triggerArgs(schedule) {
  const at = schedule.at || '03:00'
  switch (schedule.kind) {
    case 'hourly':
      return ['/SC', 'HOURLY', '/MO', String(schedule.every || 1)]
    case 'daily':
      return ['/SC', 'DAILY', '/ST', at]
    case 'weekly':
      return ['/SC', 'WEEKLY', '/D', (schedule.day || 'SUN').toUpperCase(), '/ST', at]
    case 'minutes':
      return ['/SC', 'MINUTE', '/MO', String(schedule.every || 30)]
    case 'onlogon':
      return ['/SC', 'ONLOGON']
    default:
      fail(`unknown schedule kind "${schedule.kind}"`)
  }
}

function schtasks(args) {
  if (!platformCapabilities().scheduler) fail(PREVIEW_LIMITS.scheduler)
  forgetWindows()
  const res = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (res.error) fail(`could not run schtasks: ${res.error.message}`)
  if (res.status !== 0) fail(`schtasks failed: ${(res.stderr || res.stdout || '').trim()}`)
  return res.stdout
}

/**
 * Put the trigger into Windows, or replace the one already there.
 *
 * <p>`/F` overwrites by name, which is what makes editing a task possible without it becoming a
 * different task: the id stays, so the run history written against it stays attached.
 *
 * <p>The shim path is wrapped in its own quotes before it reaches /TR. Node quotes an argument
 * with spaces for the command line, but schtasks strips that layer and stores what is left bare -
 * so for a Windows user called "John Smith" the task's command became `C:\Users\John` with
 * arguments `Smith\AppData\...\backup.cmd`, and the nightly backup failed to find a program.
 * Verified by creating a task from a path with spaces and reading the XML back: unquoted splits,
 * quoted is stored whole.
 */
function writeWindowsTask(id, task) {
  if (process.platform === 'darwin') return mac.write(id, task)
  // Refuse before writing a Windows launcher into a Mac server's data folder.
  if (!platformCapabilities().scheduler) fail(PREVIEW_LIMITS.scheduler)
  const shim = writeShim(id)
  schtasks(['/Create', '/TN', `${TASK_FOLDER}\\${id}`, '/TR', `"${shim}"`, ...triggerArgs(task.schedule), '/F'])
  // /Create always makes an enabled task, so a disabled one is disabled immediately afterwards
  // rather than being created in the state it is meant to be in. Windows offers no way to do the
  // latter through schtasks.
  if (!task.enabled) schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, '/DISABLE'])
  return shim
}

/**
 * Which part of the app created a task, when it was not a person.
 *
 * <p>The Backups tab owns exactly one task per server - the automatic backup behind its toggle -
 * and has to find it again later. Finding it by "any task on this server whose action is backup"
 * was wrong the moment the Scheduler tab let people make backup tasks of their own: the lookup
 * matched whichever sorted first by name, so turning automatic backups off deleted a task the user
 * had written, and turning them on left two.
 */
export const OWNER_BACKUPS = 'backups'

export function create({ instance, name, action, schedule, enabled = true, owner = null }) {
  validateName(instance)
  const cleanAction = normaliseAction(action)
  const cleanSchedule = normaliseSchedule(schedule)

  const data = load()
  // Readable in Task Scheduler next to everything else on the machine, and unique without a clock.
  // validateName has already restricted the instance to characters that are safe in a task name,
  // a path segment and a filename, which is what the id becomes.
  const base = `${instance}-${cleanAction.type}`
  let id = base
  for (let n = 2; data.tasks[id]; n++) id = `${base}-${n}`

  const task = {
    instance,
    name: String(name || ACTIONS[cleanAction.type].label).slice(0, 60),
    action: cleanAction,
    schedule: cleanSchedule,
    enabled: Boolean(enabled),
    owner: owner || null,
    createdAt: new Date().toISOString(),
  }

  // RunAtLoad may fire as soon as launchd accepts the agent. Publish its action
  // first on Mac, rolling it back if registration fails.
  if (process.platform === 'darwin') {
    data.tasks[id] = task
    writeJson(TASKS_FILE(), data)
    try { writeWindowsTask(id, task) }
    catch (error) { delete data.tasks[id]; writeJson(TASKS_FILE(), data); throw error }
  } else writeWindowsTask(id, task)
  // Written to disk only once Windows has accepted it. A definition mcctl believes in that has no
  // trigger behind it is a schedule that silently never runs; the reverse - a trigger with no
  // definition - fails loudly on its next fire, which is the better half of the trade.
  data.tasks[id] = task
  writeJson(TASKS_FILE(), data)
  return { id, ...task }
}

/**
 * Change an existing task in place.
 *
 * <p>Remove-and-recreate would have been less code, but it hands the task a new id, and the id is
 * what the run log is keyed by - so editing the time on a nightly backup would have orphaned every
 * record of it having ever run.
 */
export function update(id, patch) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  const current = data.tasks[id]
  const task = {
    ...current,
    name: patch.name === undefined ? current.name : String(patch.name || '').slice(0, 60),
    action: patch.action === undefined ? current.action : normaliseAction(patch.action),
    schedule: patch.schedule === undefined ? current.schedule : normaliseSchedule(patch.schedule),
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    // Ownership can be claimed but never taken. An unowned task - one made before the mark existed
    // - becomes owned the first time the tab that made it touches it, which is how those migrate;
    // an owned one cannot be reassigned by an edit, so the Backups tab's toggle never has to guess
    // again.
    owner: current.owner || (patch.owner === undefined ? null : patch.owner) || null,
  }
  if (!task.name) task.name = ACTIONS[task.action.type].label
  // The Backups tab owns a task because it takes backups. Edited into a restart, it is no longer
  // the thing that tab is a toggle for, so it stops being that tab's - and the toggle reads Off
  // rather than pointing at a task that no longer backs anything up.
  if (task.owner === OWNER_BACKUPS && task.action.type !== 'backup') task.owner = null
  if (process.platform === 'darwin') {
    data.tasks[id] = task
    writeJson(TASKS_FILE(), data)
    try { writeWindowsTask(id, task) }
    catch (error) { data.tasks[id] = current; writeJson(TASKS_FILE(), data); throw error }
  } else writeWindowsTask(id, task)
  data.tasks[id] = task
  writeJson(TASKS_FILE(), data)
  return { id, ...task }
}

export function setEnabled(id, enabled) {
  if (process.platform === 'darwin') return update(id, { enabled })
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, enabled ? '/ENABLE' : '/DISABLE'])
  data.tasks[id].enabled = Boolean(enabled)
  writeJson(TASKS_FILE(), data)
  return { id, ...data.tasks[id] }
}

/**
 * Does Windows still hold this task?
 *
 * <p>The question a failed delete actually needs answered. An exit code says something went wrong;
 * only the scheduler can say whether the thing is still there afterwards, and that answer is the
 * same in every language.
 */
function stillInWindows(id) {
  const res = spawnSync('schtasks', ['/Query', '/TN', `${TASK_FOLDER}\\${id}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  // Cannot tell - treat it as still there. Keeping a record of a task that may exist is recoverable;
  // dropping the record of one that does is not.
  if (res.error) return true
  return res.status === 0
}

export function remove(id) {
  const data = load()
  // Checked, like every other id-addressed call here. Without it a mistyped id reported success
  // while the real task kept firing, and the id went on to build a path that rmSync would follow.
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)

  if (process.platform === 'darwin') {
    mac.remove(id)
    delete data.tasks[id]
    writeJson(TASKS_FILE(), data)
    return { id, removed: true }
  }

  // Windows first: a definition without a trigger is inert, a trigger without a definition fires
  // into nothing and fails at 3am.
  forgetWindows()
  const res = spawnSync('schtasks', ['/Delete', '/TN', `${TASK_FOLDER}\\${id}`, '/F'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const said = `${res.stderr || ''}${res.stdout || ''}`
  if (res.error && res.error.code !== 'ENOENT') {
    fail(`could not reach schtasks to delete "${id}": ${res.error.message}`)
  }
  // "It was not there" is the state we were heading for anyway. Anything else - schtasks missing
  // from PATH, a timeout, access denied - is a real failure, and swallowing it used to mean
  // deleting mcctl's only record of a task that Windows still holds and still runs.
  //
  // Asked of the scheduler rather than read out of the error text. schtasks prints its messages
  // from localized resources, so matching "cannot find" worked on an English Windows and inverted
  // the meaning on any other - turning a task that was simply absent into a permanent failure
  // nobody could clear.
  if (res.status !== 0 && stillInWindows(id)) {
    fail(`Windows would not delete the task for "${id}", so it has been left alone: ${said.trim()}`)
  }

  fs.rmSync(path.join(DATA_ROOT, 'tasks', `${id}.cmd`), { force: true })
  delete data.tasks[id]
  writeJson(TASKS_FILE(), data)
  return { id, removed: true }
}

/** Fire one now, without waiting for its trigger. */
export function runNow(id) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  if (process.platform === 'darwin') mac.runNow(id, data.tasks[id])
  else schtasks(['/Run', '/TN', `${TASK_FOLDER}\\${id}`])
  return { id, started: true }
}

/**
 * What actually happened, the last time each of these fired.
 *
 * <p>Task Scheduler records one exit code per task and nothing else, which answers "did it work"
 * but never "what did it do". mcctl writes its own line per run into the instance's run directory,
 * and this reads it back so the panel can show a backup's filename and size next to the task that
 * produced it rather than the number 0.
 *
 * <p>Two formats are parsed. The original line was `time \t ok \t type \t detail` and did not say
 * WHICH task wrote it, so an instance with two backup tasks could not tell them apart; the id was
 * added as a second field. Old lines are still read - a log written before the change is still the
 * only record of what ran that night, and dropping it would be worse than showing it unattributed.
 */
export function recentRuns(instance, limit = 40) {
  validateName(instance)
  let text
  try {
    text = fs.readFileSync(path.join(RUN_DIR, instance, 'tasks.log'), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    // Old lines put the outcome where new ones put the task id. An id is always
    // "<instance>-<action>", so it can never be mistaken for one of the outcome words.
    const legacy = parts[1] === 'ok' || parts[1] === 'FAILED'
    const at = parts[0]
    const id = legacy ? null : parts[1]
    const raw = legacy ? parts[1] : parts[2]
    const status = raw === 'ok' || raw === 'skipped' ? raw : 'FAILED'
    const action = legacy ? parts[2] : parts[3]
    // The detail is free text and may itself contain tabs, so it is everything that is left.
    const detail = parts.slice(legacy ? 3 : 4).join('\t')
    if (Number.isNaN(Date.parse(at))) continue
    rows.push({ at, id, status, action, detail })
  }
  return rows.reverse().slice(0, limit)
}

/**
 * Follow an instance that has been renamed.
 *
 * <p>Without this the tasks kept their old instance name and went on firing at a server that no
 * longer answered to it - every night, into a log, failing, with nothing in the panel to say why.
 *
 * <p>The ids move too. An id is `<instance>-<action>`, and leaving `survival-backup` attached to a
 * server now called `smp` would be wrong in Task Scheduler, in `mcctl task list`, and in the panel.
 * Lines already in the run log keep the old id, which is correct: that is what the task was called
 * when it ran.
 */
export function renameInstance(oldName, newName) {
  const data = load()
  const moved = []
  // Ids claimed during this rename count as taken. Checking only data.tasks would let two tasks
  // that fall back to the same suffix both pick the same new id, and the second would overwrite
  // the first in Windows and in the file.
  const claimed = new Set(Object.keys(data.tasks))
  for (const [id, task] of Object.entries(data.tasks)) {
    if (task.instance !== oldName) continue
    const suffix = id.startsWith(`${oldName}-`) ? id.slice(oldName.length + 1) : task.action.type
    let next = `${newName}-${suffix}`
    for (let n = 2; next !== id && claimed.has(next); n++) next = `${newName}-${suffix}-${n}`
    claimed.add(next)
    moved.push({ from: id, to: next, task: { ...task, instance: newName } })
  }
  if (!moved.length) return { moved: 0 }

  if (process.platform === 'darwin') {
    for (const m of moved) {
      // Stage the new agent disabled: a login trigger must not fire in the
      // middle of a rename, or while the old task might still be running.
      data.tasks[m.to] = { ...m.task, enabled: false }
      writeJson(TASKS_FILE(), data)
      try { mac.write(m.to, data.tasks[m.to]); mac.remove(m.from) }
      catch (error) {
        try { mac.remove(m.to) } catch {}
        delete data.tasks[m.to]
        writeJson(TASKS_FILE(), data)
        throw error
      }
      delete data.tasks[m.from]
      writeJson(TASKS_FILE(), data)
      if (m.task.enabled) { update(m.to, { enabled: true }); data.tasks[m.to] = m.task }
    }
    return { moved: moved.length, stranded: [] }
  }

  // The new trigger goes in before the old one comes out. The other order leaves a window where a
  // rename that fails half way has removed the schedule and put nothing back.
  const stranded = []
  for (const m of moved) {
    writeWindowsTask(m.to, m.task)
    if (m.to !== m.from) {
      try {
        schtasks(['/Delete', '/TN', `${TASK_FOLDER}\\${m.from}`, '/F'])
      } catch {
        /* checked properly below - an exit code is not an answer about what still exists */
      }
      if (stillInWindows(m.from)) {
        // Windows kept the old trigger. Its batch file stays, because a trigger pointing at a
        // file that is not there fails in a way nothing explains; this way it runs, finds no
        // definition under the old id, and says so in the log. Reported either way.
        stranded.push(m.from)
      } else {
        fs.rmSync(path.join(DATA_ROOT, 'tasks', `${m.from}.cmd`), { force: true })
      }
      delete data.tasks[m.from]
    }
    data.tasks[m.to] = m.task
    // Written per task, not once at the end. A failure part way through used to lose the record
    // of every task that had already moved, while their new triggers were live in Windows.
    writeJson(TASKS_FILE(), data)
  }
  return { moved: moved.length, stranded }
}

/**
 * Drop every task belonging to an instance that is being deleted.
 *
 * <p>A trigger outliving its server is the worst kind of leftover: it fires forever, fails every
 * time, and turns up months later in Task Scheduler with nothing to explain it.
 */
export function removeForInstance(name) {
  const data = load()
  const ids = Object.entries(data.tasks).filter(([, t]) => t.instance === name).map(([id]) => id)
  for (const id of ids) {
    try {
      remove(id)
    } catch {
      /* one stuck task should not stop an instance being deleted */
    }
  }
  return { removed: ids.length }
}

/**
 * Remove every task mcctl created.
 *
 * <p>For uninstall. Tasks left behind would keep firing at a program that is no longer there, which
 * is the kind of thing people find months later in Task Scheduler and cannot explain.
 */
export function removeAll() {
  const data = load()
  for (const id of Object.keys(data.tasks)) {
    try {
      remove(id)
    } catch {
      /* keep going; one stuck task should not strand the rest */
    }
  }
  // The folder too, once it is empty. schtasks cannot delete folders; the scheduler's own COM
  // interface can, and refuses while anything is still inside, which is the right refusal.
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteFolder('${TASK_FOLDER}', 0)`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  }
  // Failed removals must retain their shims and definitions for recovery.
  const remaining = Object.keys(load().tasks)
  if (!remaining.length) fs.rmSync(path.join(DATA_ROOT, 'tasks'), { recursive: true, force: true })
  return { removed: remaining.length === 0, remaining }
}
