import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { DATA_ROOT } from './paths.mjs'
import { fail } from './util.mjs'
import { writeShim as writePosixShim, nextCalendarRun } from './schedule-mac.mjs'

/**
 * Scheduled work, run by the user's own systemd.
 *
 * <p>The same bargain as Task Scheduler and launchd: systemd holds a trigger that calls back into
 * `mcctl task run <id>`, and what a task DOES stays in schedules.json. Only user units are written,
 * so nothing here needs root, and nothing outside this user's unit folder is touched.
 *
 * <p>User units run while that user's systemd instance is alive - which, without lingering, means
 * while they are logged in. That is the same promise Windows makes ("interactive only"), and
 * {@link linger} is how the panel can say so instead of leaving it to be found at 3am.
 */

// A separate namespace per data folder prevents test installations and independent
// libraries from replacing one another's units. Only this user's units are touched.
const namespace = crypto.createHash('sha256').update(DATA_ROOT).digest('hex').slice(0, 16)
export function label(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(id)) fail('Invalid scheduled task id')
  return `spawnloft-${namespace}-${id}`
}
const unitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user')
const service = id => `${label(id)}.service`
const timer = id => `${label(id)}.timer`
export const serviceFile = id => path.join(unitDir(), service(id))
export const timerFile = id => path.join(unitDir(), timer(id))
const shimFile = id => path.join(DATA_ROOT, 'tasks', `${id}.sh`)

// Unit files expand %-specifiers everywhere and $VARIABLES in ExecStart; a data folder is allowed
// to contain either, and must arrive as the path it is.
const literal = value => String(value).replaceAll('%', '%%')
const argument = value => '"' + literal(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$') + '"'

const SYSTEMD_DAYS = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' }
const intervalSeconds = schedule => schedule.every * (schedule.kind === 'minutes' ? 60 : 3600)

/** The [Timer] lines for a schedule, or null for the one kind that is not a timer at all. */
export function trigger(schedule) {
  switch (schedule.kind) {
    case 'minutes':
    case 'hourly': {
      const seconds = intervalSeconds(schedule)
      // OnActiveSec starts the clock when the timer is loaded; OnUnitActiveSec keeps it going.
      return [`OnActiveSec=${seconds}s`, `OnUnitActiveSec=${seconds}s`, 'AccuracySec=1s']
    }
    case 'daily':
    case 'weekly': {
      if (schedule.kind === 'weekly' && !SYSTEMD_DAYS[schedule.day]) throw new Error('Unknown systemd weekday')
      const day = schedule.kind === 'weekly' ? SYSTEMD_DAYS[schedule.day] + ' ' : ''
      // Persistent: a run missed while the machine was off happens once when it comes back.
      return [`OnCalendar=${day}*-*-* ${schedule.at}:00`, 'Persistent=true', 'AccuracySec=1s']
    }
    // "At logon" is the service itself, wanted by the user's default target.
    case 'onlogon': return null
    default: throw new Error('Unknown systemd schedule')
  }
}

export function serviceUnit(id, task) {
  const lines = [
    '[Unit]',
    `Description=SpawnLoft task ${id}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/bin/sh ${argument(shimFile(id))}`,
    `WorkingDirectory=${literal(DATA_ROOT)}`,
    // Server daemons intentionally survive the short-lived task that starts them. Under the
    // default, control-group, systemd kills everything the task spawned the moment it exits: a
    // scheduled start reports success and the server is gone a second later, with nothing logged.
    'KillMode=process',
    `StandardOutput=append:${literal(path.join(DATA_ROOT, 'tasks', `${id}.stdout.log`))}`,
    `StandardError=append:${literal(path.join(DATA_ROOT, 'tasks', `${id}.stderr.log`))}`,
  ]
  if (task.schedule.kind === 'onlogon') lines.push('', '[Install]', 'WantedBy=default.target')
  return lines.join('\n') + '\n'
}

export function timerUnit(id, task) {
  const lines = trigger(task.schedule)
  if (!lines) return null
  return ['[Unit]', `Description=SpawnLoft schedule ${id}`, '', '[Timer]', ...lines, '',
    '[Install]', 'WantedBy=timers.target'].join('\n') + '\n'
}

function systemctl(args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15000 })
}
function checked(args) {
  const res = systemctl(args)
  if (res.error?.code === 'ENOENT') fail('Linux scheduler: systemd is not available on this machine, so tasks cannot be scheduled here.')
  if (res.error || res.status !== 0) {
    const said = res.error?.message || res.stderr?.trim() || res.stdout?.trim() || 'systemctl failed'
    // What a container, or a WSL without systemd enabled, says in place of an answer.
    if (/Failed to connect to bus|No medium found/i.test(said)) fail('Linux scheduler: this session has no systemd user instance, so tasks cannot be scheduled here.')
    fail(`Linux scheduler: ${said}`)
  }
  return res.stdout
}
// A oneshot that is doing its work is "activating"; it is never "active".
const running = id => /^(activating|active|deactivating)$/.test((systemctl(['is-active', service(id)]).stdout || '').trim())
const enabled = unit => (systemctl(['is-enabled', unit]).stdout || '').trim() === 'enabled'

export function writeShim(id) {
  label(id)
  return writePosixShim(id)
}

function unload(id) {
  // Unknown units are the state being headed for; anything else surfaces at the reload below.
  systemctl(['disable', '--now', timer(id)])
  systemctl(['disable', service(id)])
}
function install(id, task) {
  const timerText = timerUnit(id, task)
  fs.writeFileSync(serviceFile(id), serviceUnit(id, task), { mode: 0o600 })
  if (timerText) fs.writeFileSync(timerFile(id), timerText, { mode: 0o600 })
  else fs.rmSync(timerFile(id), { force: true })
  checked(['daemon-reload'])
  if (!task.enabled) return
  // No --now for the logon service: enabling it must not run it, only arrange for next logon.
  checked(task.schedule.kind === 'onlogon' ? ['enable', service(id)] : ['enable', '--now', timer(id)])
}

export function write(id, task) {
  // Do not interrupt a backup or a restart halfway through to edit its schedule.
  if (running(id)) fail('This task is running. Wait for it to finish before editing it.')
  const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null
  const previous = { service: read(serviceFile(id)), timer: read(timerFile(id)),
    timerOn: enabled(timer(id)), serviceOn: enabled(service(id)) }
  writeShim(id)
  fs.mkdirSync(unitDir(), { recursive: true })
  unload(id)
  try {
    install(id, task)
  } catch (error) {
    unload(id)
    for (const [file, bytes] of [[serviceFile(id), previous.service], [timerFile(id), previous.timer]]) {
      if (bytes) fs.writeFileSync(file, bytes)
      else fs.rmSync(file, { force: true })
    }
    systemctl(['daemon-reload'])
    if (previous.timerOn) systemctl(['enable', '--now', timer(id)])
    if (previous.serviceOn) systemctl(['enable', service(id)])
    throw error
  }
}

export function remove(id) {
  if (running(id)) fail('This task is running. Wait for it to finish before removing it.')
  unload(id)
  fs.rmSync(timerFile(id), { force: true })
  fs.rmSync(serviceFile(id), { force: true })
  fs.rmSync(shimFile(id), { force: true })
  checked(['daemon-reload'])
  // A unit that last failed is remembered after its file is gone; forget that too.
  systemctl(['reset-failed', service(id), timer(id)])
}

export function runNow(id) {
  if (running(id)) fail('This task is already running.')
  // --no-block: a backup takes minutes, and the caller asked for it to start, not to finish.
  checked(['start', '--no-block', service(id)])
}

/**
 * Will this user's tasks run while they are logged out?
 *
 * <p>Without lingering the user's systemd stops at their last logout and takes every timer with it.
 * `loginctl enable-linger` changes that and, on most distributions, needs no root for one's own
 * account. Null when there is no logind to ask.
 */
export function linger() {
  const res = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'],
    { encoding: 'utf8', timeout: 5000 })
  if (res.error || res.status !== 0) return null
  return res.stdout.trim() === 'yes'
}

/**
 * Turn lingering on for this user, so their tasks run whether or not they are logged in.
 *
 * <p>One's own account is usually allowed this without a password. Where policy says otherwise
 * loginctl asks for one, which a panel cannot answer, so the refusal hands over the command to run
 * in a terminal instead of a polkit error.
 */
export function enableLinger() {
  const user = os.userInfo().username
  const res = spawnSync('loginctl', ['enable-linger', user], { encoding: 'utf8', timeout: 15000 })
  if (res.error?.code === 'ENOENT') fail('This machine has no loginctl, so lingering cannot be turned on from here.')
  if (res.error || res.status !== 0 || linger() !== true) {
    fail(`This account is not allowed to turn lingering on by itself. Run this in a terminal, then reload: sudo loginctl enable-linger ${user}`)
  }
  return { linger: true }
}

/** `systemctl show` for several units: blocks of Key=Value, separated by blank lines. */
export function parseShow(text) {
  const units = new Map()
  for (const block of String(text).split(/\n\s*\n/)) {
    const props = {}
    for (const line of block.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) props[line.slice(0, at)] = line.slice(at + 1)
    }
    if (props.Id) units.set(props.Id, props)
  }
  return units
}
// systemctl formats times itself, in its own timezone, as "Sun 2026-09-20 21:52:14 UTC"; an event
// that has not happened prints nothing, or "n/a". Asked in UTC (see query) so that the reading does
// not depend on this machine's zone names. --timestamp=unix would be tidier, but needs systemd 247
// and is ignored by some properties even there - LastTriggerUSec among them.
const systemdTime = value => {
  const at = /^\w{3} (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(String(value || '').trim())
  return at ? new Date(`${at[1]}T${at[2]}Z`).toISOString() : null
}

/** One task's row, from what systemd said about its two units. */
export function describe(id, task, units, lastRun, now = new Date()) {
  const svc = units.get(service(id))
  if (!svc || svc.LoadState !== 'loaded') return null
  const clock = units.get(timer(id))
  const kind = task.schedule.kind
  if (kind !== 'onlogon' && (!clock || clock.LoadState !== 'loaded')) return null
  const ran = systemdTime(svc.ExecMainExitTimestamp)
  const row = { lastRun: lastRun ?? ran, lastResult: ran ? Number(svc.ExecMainStatus) : null, nextRun: null }
  if (/^(activating|active|deactivating)$/.test(svc.ActiveState)) return { ...row, state: 'Running' }
  if (!task.enabled) return { ...row, state: 'Disabled' }
  if (kind === 'daily' || kind === 'weekly') {
    row.nextRun = systemdTime(clock.NextElapseUSecRealtime) ?? nextCalendarRun(task.schedule, now)
  } else if (kind !== 'onlogon') {
    // Interval timers elapse on the monotonic clock, which systemd reports as time since boot.
    // The last firing - or the moment the timer was loaded - plus the interval is the same instant.
    const from = systemdTime(clock.LastTriggerUSec) ?? systemdTime(clock.ActiveEnterTimestamp)
    if (from) row.nextRun = new Date(Date.parse(from) + intervalSeconds(task.schedule) * 1000).toISOString()
  }
  return { ...row, state: 'Ready' }
}

const SHOWN = 'Id,LoadState,ActiveState,ExecMainStatus,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec,ActiveEnterTimestamp'

export async function query(tasks, recentRuns) {
  const ids = Object.keys(tasks)
  if (!ids.length) return new Map()
  // One spawn for every task, however many there are.
  const text = await new Promise(resolve => execFile('systemctl',
    ['--user', 'show', `--property=${SHOWN}`, ...ids.flatMap(id => [service(id), timer(id)])],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } },
    (error, stdout) => resolve(error ? null : stdout)))
  if (text === null) return new Map()
  const units = parseShow(text)
  const rows = ids.map(id => {
    const last = recentRuns(tasks[id].instance).find(run => run.id === id)
    return [id, describe(id, tasks[id], units, last?.at ?? null)]
  })
  return new Map(rows.filter(([, row]) => row))
}
