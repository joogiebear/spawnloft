'use strict'
/**
 * The bot host: the one process in SpawnLoft that loads mineflayer.
 *
 * The core ships nothing from npm, and mineflayer is a tree of prismarine packages plus half a
 * gigabyte of game data. So it lives in its own folder under the data root, installed on demand
 * by `spawnloft bot setup`, and only this child process ever loads it. The core starts the host
 * with one job file, reads one JSON report back on stdout, and is done. Nothing here opens a
 * port or keeps state between runs.
 *
 * A job is a scenario plus what the core resolved for it: where the server listens, which
 * Minecraft version it runs, and where its console log is. Bots join as offline-mode players
 * (no account, name only), then the steps run in order and the first failure stops the run.
 *
 * CommonJS rather than ESM so that `createRequire` can point at the install folder: the module
 * is not next to this file and must not be found by walking up from it.
 */
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const DEFAULT_STEP_TIMEOUT = 5000
const JOIN_TIMEOUT = 30000
// Paper's bukkit.yml throttles a second connection from the same address inside four seconds and
// kicks it with "Connection throttled!". Every bot here comes from 127.0.0.1, so joining them in a
// row trips it unless the test instance has connection-throttle: -1. Retrying after the window is
// cheaper than asking everyone to edit bukkit.yml first.
const THROTTLE_RETRY_MS = 4500
const THROTTLE_RETRIES = 3

function loadMineflayer(dir) {
  try {
    return createRequire(path.join(dir, 'package.json'))('mineflayer')
  } catch (err) {
    throw new Error(`mineflayer could not be loaded from ${dir}: ${err.message}\n  Run "spawnloft bot setup" (or "spawnloft bot setup --force" to reinstall)`)
  }
}

function now() { return Date.now() }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** "/foo/i" is a regular expression; anything else is matched as plain text. */
function matcher(pattern) {
  if (typeof pattern !== 'string') throw new Error(`a pattern must be a string, got ${JSON.stringify(pattern)}`)
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern)
  if (m) {
    const re = new RegExp(m[1], m[2])
    return (text) => re.test(text)
  }
  return (text) => text.includes(pattern)
}

function describe(step) {
  const { bot, timeout, ...rest } = step
  return (bot ? `${bot}: ` : '') + JSON.stringify(rest)
}

/**
 * One bot and everything it saw. Messages are kept in order with a running index so a step can
 * wait for something said after a point in time, not just anything ever received: a plugin that
 * printed "You bought" during setup must not satisfy a later purchase check.
 */
class Player {
  constructor(name, bot) {
    this.name = name
    this.bot = bot
    this.messages = []
    this.mark = 0
    this.gone = null
    bot.on('messagestr', (text, position) => {
      this.messages.push({ at: now(), kind: position === 'game_info' ? 'actionbar' : position ?? 'chat', text })
    })
    bot.on('title', (text) => { this.messages.push({ at: now(), kind: 'title', text: String(text) }) })
    bot.on('kicked', (reason) => { this.gone = `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` })
    bot.on('end', (reason) => { if (!this.gone) this.gone = `disconnected (${reason})` })
    bot.on('error', (err) => { if (!this.gone) this.gone = `error: ${err.message}` })
  }

  assertPresent() {
    if (this.gone) throw new Error(`${this.name} is no longer on the server: ${this.gone}`)
  }

  /** Everything received since the bot's last action, for a report or a wait. */
  since(mark = this.mark) {
    return this.messages.slice(mark)
  }

  async waitFor(predicate, timeout, what) {
    const deadline = now() + timeout
    for (;;) {
      this.assertPresent()
      const hit = predicate()
      if (hit !== undefined && hit !== false) return hit
      if (now() >= deadline) {
        const seen = this.since().map((m) => `  [${m.kind}] ${m.text}`).join('\n')
        throw new Error(`timed out after ${timeout} ms waiting for ${what}` + (seen ? `\n  seen since the last action:\n${seen}` : '\n  nothing was received since the last action'))
      }
      await sleep(50)
    }
  }

  windowTitle() {
    const w = this.bot.currentWindow
    if (!w) return null
    const t = w.title
    if (typeof t === 'string') {
      try { return chatToString(JSON.parse(t)) } catch { return t }
    }
    return chatToString(t)
  }

  state() {
    const b = this.bot
    const pos = b.entity?.position
    return {
      gameMode: b.game?.gameMode ?? null,
      health: b.health ?? null,
      food: b.food ?? null,
      position: pos ? { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 } : null,
      dimension: b.game?.dimension ?? null,
      heldItem: b.heldItem ? { name: b.heldItem.name, count: b.heldItem.count } : null,
      window: this.windowTitle(),
      players: Object.keys(b.players ?? {}),
    }
  }

  inventory() {
    const items = this.bot.inventory?.items() ?? []
    return items.map((i) => ({ slot: i.slot, name: i.name, count: i.count, displayName: i.customName ? chatToString(safeJson(i.customName)) : null }))
  }

  windowSlots() {
    const w = this.bot.currentWindow
    if (!w) return null
    return w.slots.map((i, slot) => i ? { slot, name: i.name, count: i.count, displayName: i.customName ? chatToString(safeJson(i.customName)) : null } : null).filter(Boolean)
  }
}

function safeJson(text) {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch { return text }
}

/** Flatten a chat component to its plain text, whatever shape the server sent. */
function chatToString(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (typeof c.toString === 'function' && c.toString !== Object.prototype.toString) return c.toString()
  let out = c.text ?? (c.translate ? c.translate : '')
  for (const extra of c.extra ?? []) out += chatToString(extra)
  return out
}

function itemMatches(items, want) {
  const name = typeof want === 'string' ? want : want.name
  const minCount = typeof want === 'string' ? 1 : (want.count ?? 1)
  const bare = String(name).replace(/^minecraft:/, '')
  const total = items.filter((i) => i.name === bare || i.displayName === name).reduce((n, i) => n + i.count, 0)
  return total >= minCount ? total : false
}

/** The console lines written since the job began: a plugin's exceptions land here, not in chat. */
function logSince(job) {
  if (!job.consoleLog) return []
  try {
    const fd = fs.openSync(job.consoleLog, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.min(job.logOffset ?? 0, size)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean)
    } finally { fs.closeSync(fd) }
  } catch { return [] }
}

async function join(mineflayer, job, name) {
  for (let attempt = 1; ; attempt++) {
    const bot = mineflayer.createBot({
      host: job.host, port: job.port, username: name, auth: 'offline',
      ...(job.version ? { version: job.version } : {}),
      hideErrors: true, checkTimeoutInterval: 60000,
    })
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: `no spawn within ${JOIN_TIMEOUT} ms` }), JOIN_TIMEOUT)
      bot.once('spawn', () => { clearTimeout(timer); resolve({ ok: true }) })
      bot.once('kicked', (reason) => { clearTimeout(timer); resolve({ kicked: typeof reason === 'string' ? reason : JSON.stringify(reason) }) })
      bot.once('error', (err) => { clearTimeout(timer); resolve({ error: err.message }) })
      bot.once('end', (reason) => { clearTimeout(timer); resolve({ error: `connection ended (${reason})` }) })
    })
    if (outcome.ok) return new Player(name, bot)
    try { bot.quit() } catch { /* already gone */ }
    if (outcome.kicked && /throttl/i.test(outcome.kicked) && attempt <= THROTTLE_RETRIES) {
      process.stderr.write(`${name}: connection throttled by the server, retrying in ${THROTTLE_RETRY_MS} ms\n`)
      await sleep(THROTTLE_RETRY_MS)
      continue
    }
    throw new Error(`${name} could not join ${job.host}:${job.port}: ${outcome.kicked ? `kicked: ${outcome.kicked}` : outcome.error}`)
  }
}

async function runStep(step, players, job) {
  const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT
  const player = step.bot ? players.get(step.bot) : null
  if (step.bot && !player) throw new Error(`no bot named "${step.bot}" in this scenario`)
  if (player) player.assertPresent()

  if ('chat' in step) {
    player.mark = player.messages.length
    player.bot.chat(String(step.chat))
    return { sent: step.chat }
  }
  if ('command' in step) {
    const line = String(step.command).replace(/^\/?/, '/')
    player.mark = player.messages.length
    player.bot.chat(line)
    return { sent: line }
  }
  if ('expectMessage' in step) {
    const match = matcher(step.expectMessage)
    const hit = await player.waitFor(() => player.since().find((m) => match(m.text)), timeout, `a message matching ${JSON.stringify(step.expectMessage)}`)
    // The next expectMessage looks after this line, so two in a row want two messages, in order,
    // rather than both being satisfied by the first.
    player.mark = player.messages.indexOf(hit) + 1
    return { matched: hit.text }
  }
  if ('waitWindow' in step) {
    const match = matcher(step.waitWindow)
    const title = await player.waitFor(() => { const t = player.windowTitle(); return t != null && match(t) ? t : undefined },
      timeout, `a window titled ${JSON.stringify(step.waitWindow)}`)
    return { window: title, slots: player.windowSlots() }
  }
  if ('click' in step) {
    if (!player.bot.currentWindow) throw new Error(`${player.name} has no window open to click in`)
    const slot = Number(step.click)
    const item = player.bot.currentWindow.slots[slot]
    // clickWindow resolves when the server confirms the click, and a plugin that cancels the event
    // or closes the window first never confirms it: without a deadline this step would hang.
    let timer
    await Promise.race([
      player.bot.clickWindow(slot, step.button === 'right' ? 1 : 0, 0),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeout} ms waiting for the server to confirm a click on slot ${slot}`)), timeout) }),
    ]).finally(() => clearTimeout(timer))
    return { clicked: slot, item: item ? { name: item.name, count: item.count } : null }
  }
  if ('closeWindow' in step) {
    if (player.bot.currentWindow) player.bot.closeWindow(player.bot.currentWindow)
    return {}
  }
  if ('expectItem' in step) {
    const count = await player.waitFor(() => itemMatches(player.inventory(), step.expectItem), timeout, `${JSON.stringify(step.expectItem)} in the inventory`)
    return { count }
  }
  if ('expectState' in step) {
    const want = step.expectState
    const check = () => {
      const s = player.state()
      const problems = []
      if (want.gameMode !== undefined && s.gameMode !== want.gameMode) problems.push(`game mode is ${s.gameMode}, wanted ${want.gameMode}`)
      if (want.minHealth !== undefined && !(s.health >= want.minHealth)) problems.push(`health is ${s.health}, wanted at least ${want.minHealth}`)
      if (want.maxHealth !== undefined && !(s.health <= want.maxHealth)) problems.push(`health is ${s.health}, wanted at most ${want.maxHealth}`)
      if (want.dimension !== undefined && s.dimension !== want.dimension) problems.push(`dimension is ${s.dimension}, wanted ${want.dimension}`)
      if (want.near && s.position) {
        const d = Math.hypot(s.position.x - want.near.x, s.position.y - want.near.y, s.position.z - want.near.z)
        if (d > (want.near.radius ?? 2)) problems.push(`${d.toFixed(1)} blocks from ${want.near.x},${want.near.y},${want.near.z}, wanted within ${want.near.radius ?? 2}`)
      }
      if (want.nearBot) {
        const other = players.get(want.nearBot)
        if (!other) throw new Error(`no bot named "${want.nearBot}"`)
        const a = s.position; const b = other.state().position
        const d = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity
        if (d > (want.radius ?? 2)) problems.push(`${d === Infinity ? 'unknown distance' : d.toFixed(1) + ' blocks'} from ${want.nearBot}, wanted within ${want.radius ?? 2}`)
      }
      if (want.seesPlayer !== undefined && !s.players.includes(want.seesPlayer)) problems.push(`${want.seesPlayer} is not in the player list (${s.players.join(', ')})`)
      return problems.length ? { problems } : { ok: true, state: s }
    }
    // State lags the command that changed it by a tick or two; waiting the step's timeout for it
    // to settle is what keeps "/gamemode creative" then expectState from being flaky.
    let last = null
    const res = await player.waitFor(() => { last = check(); return last.ok ? last : undefined }, timeout, `state ${JSON.stringify(want)}`)
      .catch((err) => { throw new Error(last?.problems ? last.problems.join('; ') : err.message) })
    return { state: res.state }
  }
  if ('expectLog' in step) {
    const want = step.expectLog
    if (want.present !== undefined) {
      const match = matcher(want.present)
      const deadline = now() + timeout
      for (;;) {
        const hit = logSince(job).find(match)
        if (hit) return { line: hit }
        if (now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for a console line matching ${JSON.stringify(want.present)}`)
        await sleep(100)
      }
    }
    if (want.absent !== undefined) {
      const match = matcher(want.absent)
      const hit = logSince(job).find(match)
      if (hit) throw new Error(`the console has a line matching ${JSON.stringify(want.absent)}: ${hit}`)
      return { absent: want.absent }
    }
    throw new Error('expectLog needs "present" or "absent"')
  }
  if ('leave' in step) {
    player.bot.quit()
    player.gone = 'left'
    return {}
  }
  throw new Error(`unknown step: ${describe(step)}`)
}

/**
 * Setup runs once the bots are on the server, not before: "op alice" works on a name the server
 * has never seen, but "gamemode survival bob" answers "No player was found" for a bob who has not
 * joined yet. The core owns RCON, so the host says the bots are in, the core runs setup, and the
 * host waits for its word before the first step. A core that stops instead sends an abort.
 */
function awaitSetup(job) {
  if (!job.waitForSetup) return Promise.resolve()
  process.stdout.write(JSON.stringify({ event: 'joined' }) + '\n')
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      process.stdin.removeListener('data', onData)
      process.stdin.pause()
      let msg
      try { msg = JSON.parse(buf.slice(0, nl)) } catch (err) { return reject(new Error(`unreadable word from the core: ${err.message}`)) }
      if (msg.abort) return reject(new Error(msg.abort))
      resolve()
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.once('end', () => reject(new Error('the core went away before setup finished')))
  })
}

async function main() {
  const jobFile = process.argv[2]
  if (!jobFile) throw new Error('usage: bot-host.cjs <job.json>')
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  const mineflayer = loadMineflayer(job.hostDir)
  const startedAt = now()
  const players = new Map()
  const report = { name: job.name ?? null, ok: false, steps: [], bots: {}, startedAt: new Date(startedAt).toISOString() }

  try {
    for (const name of job.bots) {
      players.set(name, await join(mineflayer, job, name))
      process.stderr.write(`${name} joined\n`)
    }
    await awaitSetup(job)
    let failed = false
    for (const [index, step] of job.steps.entries()) {
      if (failed) { report.steps.push({ index, step, status: 'skipped' }); continue }
      const t0 = now()
      try {
        const detail = await runStep(step, players, job)
        report.steps.push({ index, step, status: 'passed', durationMs: now() - t0, ...detail })
      } catch (err) {
        failed = true
        report.steps.push({ index, step, status: 'failed', durationMs: now() - t0, error: err.message })
        process.stderr.write(`step ${index + 1} failed: ${err.message}\n`)
      }
    }
    report.ok = !failed
  } catch (err) {
    report.error = err.message
  } finally {
    for (const p of players.values()) {
      report.bots[p.name] = { messages: p.messages, state: p.gone ? null : p.state(), left: p.gone }
      try { p.bot.quit() } catch { /* already gone */ }
    }
  }
  report.log = logSince(job)
  report.durationMs = now() - startedAt
  await emit(report)
  // mineflayer keeps timers alive after quit; the report is out, so nothing else matters.
  setTimeout(() => process.exit(0), 200).unref()
}

/** Write the report and resolve once the pipe has taken it: exiting before that can lose it. */
function emit(report) {
  return new Promise((resolve) => process.stdout.write(JSON.stringify(report) + '\n', () => resolve()))
}

if (require.main === module) {
  main().catch(async (err) => {
    await emit({ ok: false, error: err.message, steps: [], bots: {} })
    process.exit(1)
  })
} else {
  // Required by the tests, which exercise the parts that need no server.
  module.exports = { matcher, itemMatches, chatToString, logSince, Player }
}
