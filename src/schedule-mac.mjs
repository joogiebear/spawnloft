import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { DATA_ROOT, ROOT } from './paths.mjs'
import { fail } from './util.mjs'

// A separate namespace per data folder prevents test installations and independent
// libraries from replacing one another's agents. Only this user's agents are touched.
const namespace = crypto.createHash('sha256').update(DATA_ROOT).digest('hex').slice(0, 16)
export function label(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(id)) fail('Invalid scheduled task id')
  return `io.github.joogiebear.mcctl.${namespace}.${id}`
}
const domain = () => `gui/${process.getuid()}`
const target = id => `${domain()}/${label(id)}`
export const agentFile = id => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(id)}.plist`)
const shimFile = id => path.join(DATA_ROOT, 'tasks', `${id}.sh`)
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

export function trigger(schedule) {
  switch (schedule.kind) {
    case 'minutes': return { StartInterval: schedule.every * 60 }
    case 'hourly': return { StartInterval: schedule.every * 3600 }
    case 'onlogon': return { RunAtLoad: true }
    case 'daily':
    case 'weekly': {
      const [Hour, Minute] = schedule.at.split(':').map(Number)
      return { StartCalendarInterval: { Hour, Minute,
        ...(schedule.kind === 'weekly' ? { Weekday: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].indexOf(schedule.day) } : {}) } }
    }
    default: throw new Error('Unknown launchd schedule')
  }
}
function plistValue(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') return `<integer>${value}</integer>`
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`
  if (value && typeof value === 'object') return '<dict>' + Object.entries(value).map(([k, v]) => `<key>${xml(k)}</key>${plistValue(v)}`).join('') + '</dict>'
  return `<string>${xml(value)}</string>`
}
export function plist(id, task) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + plistValue({
    Label: label(id), ProgramArguments: ['/bin/sh', shimFile(id)],
    WorkingDirectory: DATA_ROOT, Disabled: !task.enabled,
    // Server daemons intentionally survive the short-lived task that starts them.
    AbandonProcessGroup: true,
    AssociatedBundleIdentifiers: ['io.github.joogiebear.mcctl'],
    ...trigger(task.schedule),
    StandardOutPath: path.join(DATA_ROOT, 'tasks', `${id}.stdout.log`),
    StandardErrorPath: path.join(DATA_ROOT, 'tasks', `${id}.stderr.log`),
  }) + '</plist>\n'
}
function launchctl(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 })
}
function checked(args) {
  const res = launchctl(args)
  if (res.error || res.status !== 0) fail(`macOS scheduler: ${res.error?.message || res.stderr?.trim() || res.stdout?.trim() || 'launchctl failed'}`)
  return res.stdout
}
export function writeShim(id) {
  label(id)
  const file = shimFile(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const env = { MCCTL_DATA_ROOT: DATA_ROOT, ELECTRON_RUN_AS_NODE: '1' }
  // Preserve explicit settings locations, not the caller's entire environment or secrets.
  for (const key of ['HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) if (process.env[key]) env[key] = process.env[key]
  const script = '#!/bin/sh\n' + Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join('') +
    `exec ${quote(process.execPath)} ${quote(path.join(ROOT, 'mcctl.mjs'))} task run ${quote(id)}\n`
  fs.writeFileSync(file, script, { mode: 0o700 })
  return file
}
function unload(id) {
  const res = launchctl(['bootout', target(id)])
  // ESRCH (3) means the agent is already absent. Other failures must not orphan a trigger.
  if (res.error || (res.status !== 0 && res.status !== 3)) {
    fail(`Could not unload macOS task ${id}: ${res.error?.message || res.stderr?.trim()}`)
  }
}
export function write(id, task) {
  const file = agentFile(id)
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null
  // Do not interrupt a backup or a restart halfway through to edit its schedule.
  const state = launchctl(['print', target(id)])
  if (/^\s*pid = \d+/m.test(state.stdout || '')) fail('This task is running. Wait for it to finish before editing it.')
  writeShim(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  unload(id)
  try {
    fs.writeFileSync(file, plist(id, task), { mode: 0o600 })
    checked([task.enabled ? 'enable' : 'disable', target(id)])
    if (task.enabled) checked(['bootstrap', domain(), file])
  } catch (error) {
    if (previous) {
      fs.writeFileSync(file, previous)
      const disabled = /<key>Disabled<\/key><true\/>/.test(previous.toString())
      launchctl([disabled ? 'disable' : 'enable', target(id)])
      if (!disabled) launchctl(['bootstrap', domain(), file])
    } else fs.rmSync(file, { force: true })
    throw error
  }
}
export function remove(id) {
  const state = launchctl(['print', target(id)])
  if (/^\s*pid = \d+/m.test(state.stdout || '')) fail('This task is running. Wait for it to finish before removing it.')
  unload(id)
  fs.rmSync(agentFile(id), { force: true })
  fs.rmSync(shimFile(id), { force: true })
  // Clear the persistent disabled override as well as the plist.
  checked(['enable', target(id)])
}
export function runNow(id, task) {
  if (!task.enabled) fail('Enable this task before running it through the macOS scheduler.')
  checked(['kickstart', target(id)])
}
export function nextCalendarRun(schedule, now = new Date()) {
  if (!['daily', 'weekly'].includes(schedule.kind)) return null
  const next = new Date(now)
  const [hour, minute] = schedule.at.split(':').map(Number)
  next.setHours(hour, minute, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  if (schedule.kind === 'weekly') {
    const day = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].indexOf(schedule.day)
    next.setDate(next.getDate() + (day - next.getDay() + 7) % 7)
  }
  return next.toISOString()
}
export async function query(tasks, recentRuns) {
  const rows = await Promise.all(Object.entries(tasks).map(async ([id, task]) => {
    if (!task.enabled && fs.existsSync(agentFile(id))) return [id, { state: 'Disabled', lastResult: null, lastRun: null, nextRun: null }]
    const state = await new Promise(resolve => execFile('/bin/launchctl', ['print', target(id)],
      { encoding: 'utf8', timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout)))
    if (!state) return [id, null]
    const last = recentRuns(task.instance).find(run => run.id === id)
    const code = /^\s*last exit code = (\d+)/m.exec(state)
    return [id, { state: /^\s*pid = \d+/m.test(state) ? 'Running' : 'Ready',
      lastRun: last?.at ?? null, lastResult: code ? Number(code[1]) : null,
      // launchd does not publish an exact next firing time for interval jobs.
      nextRun: nextCalendarRun(task.schedule) }]
  }))
  return new Map(rows.filter(([, row]) => row))
}
