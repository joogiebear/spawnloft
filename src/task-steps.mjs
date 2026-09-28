import { fail } from './util.mjs'

/**
 * A scheduled task that is several things in order: warn the players, wait, back up, restart.
 *
 * <p>The single-action tasks each do one thing, and the one people most want - a nightly restart
 * with a warning and a backup before it - was two tasks timed against each other and hoping the
 * backup finished first. A chain runs its steps one after another in one run, so the restart waits
 * for the backup however long it takes.
 *
 * <p>What a step does to the server comes in through `deps`, so the chain's own rules - skipping,
 * stopping at a failure, the wait budget - are tested without a server or a system scheduler.
 */

export const STEP_KINDS = {
  say: { label: 'Tell the players' },
  command: { label: 'Run a server command' },
  wait: { label: 'Wait' },
  countdown: { label: 'Count down, telling the players' },
  backup: { label: 'Take a backup' },
  verify: { label: 'Verify the backups' },
  stop: { label: 'Stop the server' },
  start: { label: 'Start the server' },
  restart: { label: 'Restart the server' },
}
export const MAX_STEPS = 12
// Waits and countdowns added up. A chain that sleeps for most of a day is a typo, and it holds a
// scheduler slot and a process for all of it.
export const MAX_WAIT_SECONDS = 2 * 60 * 60

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt
}

function normaliseStep(input, i) {
  const kind = String(input?.do ?? '')
  if (!Object.hasOwn(STEP_KINDS, kind)) fail(`step ${i + 1}: "${kind}" is not a step - one of ${Object.keys(STEP_KINDS).join(', ')}`)
  if (kind === 'say' || kind === 'command') {
    const text = String(kind === 'say' ? input.text ?? '' : input.line ?? '').trim()
    if (!text) fail(`step ${i + 1}: ${kind === 'say' ? 'what should the players be told?' : 'which command?'}`)
    if (text.length > 400) fail(`step ${i + 1}: that is too long for a console line`)
    return kind === 'say' ? { do: kind, text } : { do: kind, line: text.replace(/^\//, '') }
  }
  if (kind === 'wait') return { do: kind, seconds: clampInt(input.seconds, 5, 3600, 60) }
  if (kind === 'countdown') {
    const message = String(input.message ?? '').trim().slice(0, 120) || 'Server restarting'
    return { do: kind, minutes: clampInt(input.minutes, 1, 60, 5), message }
  }
  if (kind === 'backup') {
    const keep = Number(input.keep)
    return { do: kind, keep: Number.isInteger(keep) && keep > 0 ? Math.min(keep, 365) : null }
  }
  return { do: kind }
}

/** A chain as the task file stores it, checked. */
export function normaliseSteps(input) {
  const raw = Array.isArray(input?.steps) ? input.steps : []
  if (!raw.length) fail('add at least one step')
  if (raw.length > MAX_STEPS) fail(`a task holds at most ${MAX_STEPS} steps`)
  const steps = raw.map(normaliseStep)
  const waited = steps.reduce((n, s) => n + (s.do === 'wait' ? s.seconds : s.do === 'countdown' ? s.minutes * 60 : 0), 0)
  if (waited > MAX_WAIT_SECONDS) fail(`the waits add up to ${Math.round(waited / 60)} minutes; keep them under ${MAX_WAIT_SECONDS / 60}`)
  return { type: 'steps', steps, onlyWhenRunning: input.onlyWhenRunning === true, keepGoing: input.keepGoing === true }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const duration = (s) => (s % 60 === 0 ? plural(s / 60, 'minute') : s < 60 ? plural(s, 'second') : `${Math.floor(s / 60)}m ${s % 60}s`)

/** One step, as a phrase for the task list and the run log. */
export function describeStep(step) {
  switch (step.do) {
    case 'say': return `tell the players "${step.text}"`
    case 'command': return `run "${step.line}"`
    case 'wait': return `wait ${duration(step.seconds)}`
    case 'countdown': return `a ${plural(step.minutes, 'minute')} countdown`
    case 'backup': return step.keep ? `back up, keeping ${step.keep}` : 'back up'
    case 'verify': return 'verify the backups'
    default: return step.do
  }
}

/**
 * Run the chain.
 *
 * <p>A step that has nothing to act on is skipped, not failed, the way a single command task is:
 * telling an empty, stopped server something is not an error, and stopping one that is already
 * stopped is done. A step that fails ends the chain - a restart after a backup that did not happen
 * is exactly what a chain exists to prevent - unless the task says to keep going.
 *
 * @param deps isRunning(), send(line), sleep(ms), backup({ keep }) -> text, verify() -> text,
 *        stop(), start() -> { failed, timedOut, reason }
 * @returns { status: 'ok' | 'skipped' | 'FAILED', detail, failures }
 */
export async function runSteps(action, deps) {
  if (action.onlyWhenRunning && !(await deps.isRunning())) {
    return { status: 'skipped', detail: 'the server was not running, and this task only runs while it is', failures: [] }
  }
  const done = []
  const failures = []
  for (const [i, step] of action.steps.entries()) {
    const n = `step ${i + 1}`
    try {
      const said = await runStep(step, deps)
      done.push(said)
    } catch (err) {
      const why = err?.message ?? String(err)
      failures.push(`${n} (${describeStep(step)}) failed: ${why}`)
      done.push(`${describeStep(step)} FAILED`)
      if (!action.keepGoing) {
        const left = action.steps.length - i - 1
        return {
          status: 'FAILED',
          detail: `${done.join('; ')}${left ? `; stopped there, ${plural(left, 'step')} not run` : ''}`,
          failures,
        }
      }
    }
  }
  return { status: failures.length ? 'FAILED' : 'ok', detail: done.join('; '), failures }
}

async function runStep(step, deps) {
  const running = await deps.isRunning()
  switch (step.do) {
    case 'say':
      if (!running) return 'nobody to tell (not running)'
      await deps.send(`say ${step.text}`)
      return `told the players "${step.text}"`
    case 'command':
      if (!running) return `"${step.line}" not sent (not running)`
      await deps.send(step.line)
      return `ran "${step.line}"`
    case 'wait':
      await deps.sleep(step.seconds * 1000)
      return `waited ${duration(step.seconds)}`
    case 'countdown': {
      if (!running) return 'no countdown (not running)'
      // The shape the single restart task has always used: the full figure, then one minute, then
      // ten seconds. Announcements are best-effort; a server that dies mid-countdown made it moot.
      const say = (msg) => deps.send(`say ${msg}`).catch(() => {})
      let remaining = step.minutes * 60
      await say(`${step.message} in ${plural(step.minutes, 'minute')}`)
      if (remaining > 60) {
        await deps.sleep((remaining - 60) * 1000)
        remaining = 60
        await say(`${step.message} in 1 minute`)
      }
      await deps.sleep((remaining - 10) * 1000)
      await say(`${step.message} in 10 seconds`)
      await deps.sleep(10000)
      return `counted down ${plural(step.minutes, 'minute')}`
    }
    case 'backup':
      return await deps.backup({ keep: step.keep })
    case 'verify':
      return await deps.verify()
    case 'stop':
      if (!running) return 'already stopped'
      await deps.stop()
      return 'stopped'
    case 'start': {
      if (running) return 'already running'
      const res = await deps.start()
      if (res.failed || res.timedOut) throw new Error(res.failed ? `it stopped again: ${res.reason}` : 'it had not finished starting')
      return 'started'
    }
    case 'restart': {
      if (running) await deps.stop()
      const res = await deps.start()
      if (res.failed || res.timedOut) throw new Error(res.failed ? `it stopped again: ${res.reason}` : 'it had not finished starting')
      return running ? 'restarted' : 'started (it was not running)'
    }
    default:
      throw new Error(`unknown step "${step.do}"`)
  }
}
