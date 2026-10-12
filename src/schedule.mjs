import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'

import { DATA_ROOT, ROOT, RUN_DIR } from './paths.mjs'
import { readJson, writeJson, fail, validateName, acquireLock } from './util.mjs'
import { platformCapabilities, PREVIEW_LIMITS } from './platform.mjs'
import * as mac from './schedule-mac.mjs'
import * as linux from './schedule-linux.mjs'
import * as activity from './activity.mjs'
import { normaliseSteps } from './task-steps.mjs'

// launchd and systemd are driven through the same five calls; Windows is the code in this file.
const native = process.platform === 'darwin' ? mac : process.platform === 'linux' ? linux : null

// Scheduled work on Windows uses Task Scheduler, which survives reboots and records exit codes
// and next run times. It holds only a trigger that calls back into `mcctl task run <id>`; the
// definitions live in schedules.json, so what a task can do stays inside mcctl and editing one
// doesn't mean recreating the Windows task.
//
// Tasks run interactive only (logged in, screen lock is fine, not after sign-out). Running
// regardless would mean storing a Windows password in the task definition.

const TASKS_FILE = () => path.join(DATA_ROOT, 'schedules.json')
const TASKS_LOCK = () => path.join(DATA_ROOT, 'schedules.lock')

// Every change is read-modify-write on schedules.json, so concurrent callers (panel, MCP
// server, CLI) would drop each other's changes. Nested calls already hold the lock and pass through.
let tasksLockDepth = 0
function withTasksLock(fn) {
  if (tasksLockDepth > 0) return fn()
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  let release
  try { release = acquireLock(TASKS_LOCK(), { mode: 'wait', timeoutMs: 10000 }) }
  catch { fail('another change to the scheduled tasks is still in progress; try again in a moment') }
  tasksLockDepth++
  try { return fn() } finally { tasksLockDepth--; release() }
}

// one folder so uninstall can remove everything mcctl created
export const TASK_FOLDER = 'mcctl'

const EMPTY = { version: 1, tasks: {} }

// An allowlist rather than a command string, so a task can't execute arbitrary commands.
export const ACTIONS = {
  backup: { label: 'Take a backup', needsRunning: false },
  // reads every snapshot back on a clock so a corrupt one is found when it happens
  verify: { label: 'Verify the backups', needsRunning: false },
  command: { label: 'Run a server command', needsRunning: true },
  restart: { label: 'Restart the server', needsRunning: false },
  stop: { label: 'Stop the server', needsRunning: true },
  start: { label: 'Start the server', needsRunning: false },
  // see task-steps.mjs
  steps: { label: 'Several steps in order', needsRunning: false },
}

// Task Scheduler last-result HRESULTs. The informational ones look like failures (267011 is a
// task that never ran); anything not listed is a real exit code from the task.
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

// days schtasks accepts for /SC WEEKLY
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

export const SCHEDULE_KINDS = ['minutes', 'hourly', 'daily', 'weekly', 'onlogon']

// schtasks doesn't validate: `/MO 0` or `/MO 9999` creates a task that never fires, so
// everything is checked here. Returns a new object so only validated fields are stored.
export function normaliseSchedule(input) {
  const kind = String(input?.kind ?? '')
  if (!SCHEDULE_KINDS.includes(kind)) {
    fail(`unknown schedule kind "${kind}" - expected one of ${SCHEDULE_KINDS.join(', ')}`)
  }
  if (kind === 'onlogon') return { kind }

  if (kind === 'minutes' || kind === 'hourly') {
    const every = Number(input.every)
    if (!Number.isInteger(every) || every < 1) fail('the interval must be a whole number of at least 1')
    // past 1439 minutes / 23 hours schtasks creates the task but it never fires
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

// Keeps only the fields the action uses; schedules.json causes code to run on a timer, so
// nothing a caller invented is stored.
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
    // minutes of console warning before the restart; 0 is valid, the cap guards against typos
    const warn = Number(input.warnMinutes)
    return { type, warnMinutes: Number.isInteger(warn) && warn > 0 ? Math.min(warn, 60) : 0 }
  }
  if (type === 'steps') return normaliseSteps(input)
  return { type }
}

export function describeResult(code) {
  if (code == null) return 'unknown'
  return TASK_RESULT[code] ?? `failed (exit ${code})`
}

// Fixed "no" on Windows and macOS. On Linux the user's systemd and its timers stop at last
// logout unless lingering is on. `linger` is null where it doesn't apply or couldn't be asked;
// `session` says how loudly to warn.
export function background() {
  if (process.platform !== 'linux') return { linger: null, session: null }
  return { linger: linux.linger(), session: linux.sessionKind() }
}

// The CLI's note about tasks and logging out. On a headless Linux box with lingering off the
// schedule stops when the person disconnects, so that case warns.
export function loggedOutNote({ linger, session } = background(), platform = process.platform) {
  if (platform !== 'linux') return ['Tasks run while you are logged in, including with the screen locked - not after signing out.']
  if (linger === true) return ['Lingering is on for your account: tasks run whether or not you are logged in, from boot.']
  if (session === 'headless') return [
    'WARNING: tasks stop when you log out, and this looks like a machine you connect to rather than sit at.',
    'A backup scheduled for 03:00 will not run unless you are connected at 03:00. To keep them running:',
    '  spawnloft task linger on',
  ]
  return ['Tasks run while you are logged in, including with the screen locked - not after signing out.',
    'To run them from boot instead, logged in or not: spawnloft task linger on']
}

export function keepRunningLoggedOut() {
  if (process.platform !== 'linux') fail('Lingering is a Linux setting; there is nothing to turn on here.')
  return linux.enableLinger()
}

export function load() {
  const data = readJson(TASKS_FILE(), EMPTY)
  if (!data.tasks) data.tasks = {}
  return data
}

export async function list() {
  const data = load()
  const live = native ? await native.query(data.tasks, recentRuns) : await queryWindows()
  return Object.entries(data.tasks)
    .map(([id, task]) => ({ id, ...task, windows: live.get(id) ?? null }))
    .sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name))
}

// The scheduler's answer is cached for a few seconds because starting PowerShell and loading
// ScheduledTasks takes seconds and several tabs ask at once; concurrent callers join the
// in-flight query. Any write to the scheduler clears it. Async so it doesn't block the panel.
let windowsCache = { at: 0, rows: null }
let windowsInFlight = null
// bumped by every write so a query already running during a change isn't cached as current
let windowsGeneration = 0
const WINDOWS_CACHE_MS = 3000

function forgetWindows() {
  windowsCache = { at: 0, rows: null }
  windowsInFlight = null
  windowsGeneration++
}

// A task missing from Task Scheduler (deleted by hand) comes back as null rather than as working.
function queryWindows() {
  if (windowsCache.rows && Date.now() - windowsCache.at < WINDOWS_CACHE_MS) {
    return Promise.resolve(windowsCache.rows)
  }
  if (windowsInFlight) return windowsInFlight
  // no scheduler to ask off Windows; don't spawn powershell just to fail
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
        // round-trip ("o") rather than [string], which uses the machine's locale (31/08/2026
        // doesn't parse in the panel's Date())
        '[pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; ' +
        'lastRun=$(if ($i.LastRunTime) { $i.LastRunTime.ToString("o") }); ' +
        'lastResult=$i.LastTaskResult; ' +
        'nextRun=$(if ($i.NextRunTime) { $i.NextRunTime.ToString("o") }) } } | ' +
        // no -AsArray (needs PowerShell 6+, Windows ships 5.1), so a single task comes back as a
        // bare object
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
            // a task that never ran is reported as having run in 1999
            if (row.lastRun && new Date(row.lastRun).getFullYear() < 2000) row.lastRun = null
            out.set(row.name, row)
          }
        } catch {
          /* unparseable output: every task reports as unknown */
        }
        resolve(out)
      },
    )
  })
  windowsInFlight = query
  return query
}

// The batch file a task runs. A scheduled task starts with no environment, so
// ELECTRON_RUN_AS_NODE has to be set here or the desktop build would relaunch the app instead
// of running the CLI. It also keeps a multi-path command line out of the task definition.
function writeShim(id) {
  if (native) return native.writeShim(id)
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

// A shim names the executable and code folder by absolute path, so after an install moves
// every task points at a missing file. Task Scheduler only holds the shim's path (in the data
// folder), so rewriting the shims is the whole repair. See relocate.mjs.
export function rewriteShims() {
  const ids = Object.keys(load().tasks)
  for (const id of ids) writeShim(id)
  return ids.length
}

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

// `/F` overwrites by name, so editing keeps the id and the run history attached.
// The shim path gets its own quotes for /TR: schtasks strips the layer Node adds, and a path
// with spaces ("John Smith") is then stored split into command and arguments.
function writeWindowsTask(id, task) {
  if (native) return native.write(id, task)
  // refuse before writing a Windows launcher into a Mac server's data folder
  if (!platformCapabilities().scheduler) fail(PREVIEW_LIMITS.scheduler)
  const shim = writeShim(id)
  schtasks(['/Create', '/TN', `${TASK_FOLDER}\\${id}`, '/TR', `"${shim}"`, ...triggerArgs(task.schedule), '/F'])
  // /Create always makes an enabled task and schtasks can't create one disabled
  if (!task.enabled) schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, '/DISABLE'])
  return shim
}

// Marks the one task per server owned by the Backups tab toggle, so it can be found again
// without matching backup tasks the user made themselves.
export const OWNER_BACKUPS = 'backups'

function createLocked({ instance, name, action, schedule, enabled = true, owner = null }) {
  validateName(instance)
  const cleanAction = normaliseAction(action)
  const cleanSchedule = normaliseSchedule(schedule)

  const data = load()
  // readable in Task Scheduler; validateName keeps the instance safe for a task name, path and filename
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

  // RunAtLoad can fire as soon as launchd accepts the agent, so on native schedulers the
  // definition is saved first and rolled back if registration fails
  if (native) {
    data.tasks[id] = task
    writeJson(TASKS_FILE(), data)
    try { writeWindowsTask(id, task) }
    catch (error) { delete data.tasks[id]; writeJson(TASKS_FILE(), data); throw error }
  } else writeWindowsTask(id, task)
  // saved only after the scheduler accepts it: a definition with no trigger silently never
  // runs, while a trigger with no definition fails loudly
  data.tasks[id] = task
  writeJson(TASKS_FILE(), data)
  activity.record(instance, 'schedule-add', { detail: `${task.name}: ${task.action.type}` })
  return { id, ...task }
}

// Edits in place rather than remove-and-recreate: the id keys the run log.
function updateLocked(id, patch) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  const current = data.tasks[id]
  const task = {
    ...current,
    name: patch.name === undefined ? current.name : String(patch.name || '').slice(0, 60),
    action: patch.action === undefined ? current.action : normaliseAction(patch.action),
    schedule: patch.schedule === undefined ? current.schedule : normaliseSchedule(patch.schedule),
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    // ownership can be claimed (unowned tasks migrate this way) but not reassigned
    owner: current.owner || (patch.owner === undefined ? null : patch.owner) || null,
  }
  if (!task.name) task.name = ACTIONS[task.action.type].label
  // edited into something other than a backup, it no longer belongs to the Backups toggle
  if (task.owner === OWNER_BACKUPS && task.action.type !== 'backup') task.owner = null
  if (native) {
    data.tasks[id] = task
    writeJson(TASKS_FILE(), data)
    try { writeWindowsTask(id, task) }
    catch (error) { data.tasks[id] = current; writeJson(TASKS_FILE(), data); throw error }
  } else writeWindowsTask(id, task)
  data.tasks[id] = task
  writeJson(TASKS_FILE(), data)
  const onlyToggled = Object.keys(patch).every((k) => k === 'enabled' || k === 'owner')
  activity.record(task.instance, onlyToggled ? (task.enabled ? 'schedule-enable' : 'schedule-disable') : 'schedule-change', { detail: task.name })
  return { id, ...task }
}

function setEnabledLocked(id, enabled) {
  if (native) return update(id, { enabled })
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, enabled ? '/ENABLE' : '/DISABLE'])
  data.tasks[id].enabled = Boolean(enabled)
  writeJson(TASKS_FILE(), data)
  activity.record(data.tasks[id].instance, enabled ? 'schedule-enable' : 'schedule-disable', { detail: data.tasks[id].name })
  return { id, ...data.tasks[id] }
}

function stillInWindows(id) {
  const res = spawnSync('schtasks', ['/Query', '/TN', `${TASK_FOLDER}\\${id}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  // can't tell: assume it's still there, since keeping a record is recoverable and dropping one isn't
  if (res.error) return true
  return res.status === 0
}

function removeLocked(id) {
  const data = load()
  // the id is also used to build a path below
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)

  const gone = data.tasks[id]
  if (native) {
    native.remove(id)
    delete data.tasks[id]
    writeJson(TASKS_FILE(), data)
    activity.record(gone.instance, 'schedule-remove', { detail: gone.name })
    return { id, removed: true }
  }

  // Windows first: a definition without a trigger is inert, a trigger without one fails when it fires
  forgetWindows()
  const res = spawnSync('schtasks', ['/Delete', '/TN', `${TASK_FOLDER}\\${id}`, '/F'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const said = `${res.stderr || ''}${res.stdout || ''}`
  if (res.error && res.error.code !== 'ENOENT') {
    fail(`could not reach schtasks to delete "${id}": ${res.error.message}`)
  }
  // "not there" is fine; other failures (missing schtasks, timeout, access denied) must not
  // drop our record of a task Windows still runs. Asks the scheduler instead of matching the
  // error text, which schtasks localizes.
  if (res.status !== 0 && stillInWindows(id)) {
    fail(`Windows would not delete the task for "${id}", so it has been left alone: ${said.trim()}`)
  }

  fs.rmSync(path.join(DATA_ROOT, 'tasks', `${id}.cmd`), { force: true })
  delete data.tasks[id]
  writeJson(TASKS_FILE(), data)
  activity.record(gone.instance, 'schedule-remove', { detail: gone.name })
  return { id, removed: true }
}

export function runNow(id) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  if (native) native.runNow(id, data.tasks[id])
  else schtasks(['/Run', '/TN', `${TASK_FOLDER}\\${id}`])
  return { id, started: true }
}

// Reads mcctl's own per-run lines from the instance's tasks.log, since Task Scheduler only
// keeps an exit code. Two line formats: `time, task id, status, action, detail` and the older
// `time, status, action, detail` without an id (still read, shown unattributed).
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
    // an id is always "<instance>-<action>", so it can't be mistaken for an outcome word
    const legacy = parts[1] === 'ok' || parts[1] === 'FAILED'
    const at = parts[0]
    const id = legacy ? null : parts[1]
    const raw = legacy ? parts[1] : parts[2]
    const status = raw === 'ok' || raw === 'skipped' ? raw : 'FAILED'
    const action = legacy ? parts[2] : parts[3]
    // detail is free text and may contain tabs
    const detail = parts.slice(legacy ? 3 : 4).join('\t')
    if (Number.isNaN(Date.parse(at))) continue
    rows.push({ at, id, status, action, detail })
  }
  return rows.reverse().slice(0, limit)
}

// Task ids are `<instance>-<action>`, so they move with the instance. Run log lines keep the
// old id, which is what the task was called when it ran.
function renameInstanceLocked(oldName, newName) {
  const data = load()
  const moved = []
  // ids claimed during this rename count as taken, or two tasks falling back to the same
  // suffix would pick the same new id
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

  if (native) {
    for (const m of moved) {
      // stage the new agent disabled so a login trigger can't fire mid-rename
      data.tasks[m.to] = { ...m.task, enabled: false }
      writeJson(TASKS_FILE(), data)
      try { native.write(m.to, data.tasks[m.to]); native.remove(m.from) }
      catch (error) {
        try { native.remove(m.to) } catch {}
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

  // new trigger goes in before the old one comes out, so a half-failed rename never loses the schedule
  const stranded = []
  for (const m of moved) {
    writeWindowsTask(m.to, m.task)
    if (m.to !== m.from) {
      try {
        schtasks(['/Delete', '/TN', `${TASK_FOLDER}\\${m.from}`, '/F'])
      } catch {
        /* checked below via stillInWindows */
      }
      if (stillInWindows(m.from)) {
        // Windows kept the old trigger. Keep its batch file so the run finds no definition
        // under the old id and logs that, instead of failing on a missing file.
        stranded.push(m.from)
      } else {
        fs.rmSync(path.join(DATA_ROOT, 'tasks', `${m.from}.cmd`), { force: true })
      }
      delete data.tasks[m.from]
    }
    data.tasks[m.to] = m.task
    // written per task so a failure part way through keeps the record of tasks already moved
    writeJson(TASKS_FILE(), data)
  }
  return { moved: moved.length, stranded }
}

function removeForInstanceLocked(name) {
  const data = load()
  const ids = Object.entries(data.tasks).filter(([, t]) => t.instance === name).map(([id]) => id)
  for (const id of ids) {
    try {
      remove(id)
    } catch {
      /* a stuck task shouldn't block deleting the instance */
    }
  }
  return { removed: ids.length }
}

// for uninstall
function removeAllLocked() {
  const data = load()
  for (const id of Object.keys(data.tasks)) {
    try {
      remove(id)
    } catch {
      /* keep going; reported via remaining */
    }
  }
  // schtasks can't delete folders; the COM interface can, and refuses while the folder isn't empty
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteFolder('${TASK_FOLDER}', 0)`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  }
  // failed removals keep their shims and definitions
  const remaining = Object.keys(load().tasks)
  if (!remaining.length) fs.rmSync(path.join(DATA_ROOT, 'tasks'), { recursive: true, force: true })
  return { removed: remaining.length === 0, remaining }
}

export const create = (...args) => withTasksLock(() => createLocked(...args))
export const update = (...args) => withTasksLock(() => updateLocked(...args))
export const setEnabled = (...args) => withTasksLock(() => setEnabledLocked(...args))
export const remove = (...args) => withTasksLock(() => removeLocked(...args))
export const renameInstance = (...args) => withTasksLock(() => renameInstanceLocked(...args))
export const removeForInstance = (...args) => withTasksLock(() => removeForInstanceLocked(...args))
export const removeAll = (...args) => withTasksLock(() => removeAllLocked(...args))
