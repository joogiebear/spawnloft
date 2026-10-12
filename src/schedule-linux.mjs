import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { DATA_ROOT } from './paths.mjs'
import { fail } from './util.mjs'
import { writeShim as writePosixShim, nextCalendarRun } from './schedule-mac.mjs'

// systemd user units that call back into `mcctl task run <id>`; what a task does stays in
// schedules.json. No root needed. Without lingering, user units only run while logged in.

// namespaced per data folder so separate installs don't replace each other's units
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

// unit files expand %-specifiers everywhere and $VARIABLES in ExecStart, so paths containing
// either must be escaped
const literal = value => String(value).replaceAll('%', '%%')
const argument = value => '"' + literal(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$') + '"'

const SYSTEMD_DAYS = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' }
const intervalSeconds = schedule => schedule.every * (schedule.kind === 'minutes' ? 60 : 3600)

// the [Timer] lines, or null for onlogon, which has no timer
export function trigger(schedule) {
  switch (schedule.kind) {
    case 'minutes':
    case 'hourly': {
      const seconds = intervalSeconds(schedule)
      // OnActiveSec starts the clock at load; OnUnitActiveSec keeps it going
      return [`OnActiveSec=${seconds}s`, `OnUnitActiveSec=${seconds}s`, 'AccuracySec=1s']
    }
    case 'daily':
    case 'weekly': {
      if (schedule.kind === 'weekly' && !SYSTEMD_DAYS[schedule.day]) throw new Error('Unknown systemd weekday')
      const day = schedule.kind === 'weekly' ? SYSTEMD_DAYS[schedule.day] + ' ' : ''
      // Persistent: a run missed while the machine was off fires once on return
      return [`OnCalendar=${day}*-*-* ${schedule.at}:00`, 'Persistent=true', 'AccuracySec=1s']
    }
    // "at logon" is the service itself, wanted by default.target, which is reached when the
    // user's systemd starts: sign-in without lingering, boot with it (later sign-ins aren't seen,
    // as systemd has no logon event covering SSH too)
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
    // server daemons must outlive the task; with the default control-group mode systemd kills
    // everything the task spawned when it exits
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
    // what a container or WSL without systemd says
    if (/Failed to connect to bus|No medium found/i.test(said)) fail('Linux scheduler: this session has no systemd user instance, so tasks cannot be scheduled here.')
    fail(`Linux scheduler: ${said}`)
  }
  return res.stdout
}
// a running oneshot is "activating", never "active"
const running = id => /^(activating|active|deactivating)$/.test((systemctl(['is-active', service(id)]).stdout || '').trim())
const enabled = unit => (systemctl(['is-enabled', unit]).stdout || '').trim() === 'enabled'

export function writeShim(id) {
  label(id)
  return writePosixShim(id)
}

function unload(id) {
  // unknown units are fine; real problems surface at the reload
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
  // no --now for the logon service: enabling must not run it
  checked(task.schedule.kind === 'onlogon' ? ['enable', service(id)] : ['enable', '--now', timer(id)])
}

export function write(id, task) {
  // don't interrupt a running backup or restart to edit its schedule
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
  // a failed unit is remembered after its file is gone
  systemctl(['reset-failed', service(id), timer(id)])
}

export function runNow(id) {
  if (running(id)) fail('This task is already running.')
  // --no-block: the caller wants it started, not finished
  checked(['start', '--no-block', service(id)])
}

// Without lingering the user's systemd stops at last logout and takes every timer with it.
// Null when there is no logind to ask.
export function linger() {
  const res = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'],
    { encoding: 'utf8', timeout: 5000 })
  if (res.error || res.status !== 0) return null
  return res.stdout.trim() === 'yes'
}

// Desktop vs headless decides how loudly to warn that lingering is off. SSH is checked first
// because a session with X forwarding has a DISPLAY but is still remote.
export function sessionKind(env = process.env) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'headless'
  return env.DISPLAY || env.WAYLAND_DISPLAY ? 'desktop' : 'headless'
}

// If policy requires a password (which a panel can't supply), the failure gives the command to
// run in a terminal instead of a polkit error.
export function enableLinger() {
  const user = os.userInfo().username
  const res = spawnSync('loginctl', ['enable-linger', user], { encoding: 'utf8', timeout: 15000 })
  if (res.error?.code === 'ENOENT') fail('This machine has no loginctl, so lingering cannot be turned on from here.')
  if (res.error || res.status !== 0 || linger() !== true) {
    fail(`This account is not allowed to turn lingering on by itself. Run this in a terminal, then reload: sudo loginctl enable-linger ${user}`)
  }
  return { linger: true }
}

// `systemctl show` output for several units: Key=Value blocks separated by blank lines
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
// systemctl prints times like "Sun 2026-09-20 21:52:14 UTC" (query forces UTC so zone names
// don't matter); an event that hasn't happened prints nothing or "n/a". --timestamp=unix
// needs systemd 247 and is ignored by some properties, LastTriggerUSec among them.
const systemdTime = value => {
  const at = /^\w{3} (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(String(value || '').trim())
  return at ? new Date(`${at[1]}T${at[2]}Z`).toISOString() : null
}

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
    // interval timers elapse on the monotonic clock (time since boot), so compute next run as
    // last firing (or load time) plus the interval
    const from = systemdTime(clock.LastTriggerUSec) ?? systemdTime(clock.ActiveEnterTimestamp)
    if (from) row.nextRun = new Date(Date.parse(from) + intervalSeconds(task.schedule) * 1000).toISOString()
  }
  return { ...row, state: 'Ready' }
}

const SHOWN = 'Id,LoadState,ActiveState,ExecMainStatus,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec,ActiveEnterTimestamp'

export async function query(tasks, recentRuns) {
  const ids = Object.keys(tasks)
  if (!ids.length) return new Map()
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
