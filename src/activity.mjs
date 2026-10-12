import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DATA_ROOT } from './paths.mjs'

// Audit log of what was done to each server and by whom. Entry points call asActor once and
// everything recorded underneath carries that actor; outside one it's 'spawnloft' unless
// setDefaultActor says otherwise (the CLI does).
//
// One shared jsonl file, appended a line at a time by the panel, CLI, tasks, MCP server and
// daemons. Past MAX_BYTES it rotates to the previous file, so history is about twice that.

export const MAX_BYTES = 2 * 1024 * 1024
const FILE = () => path.join(DATA_ROOT, 'activity.jsonl')
const PREVIOUS = () => path.join(DATA_ROOT, 'activity.1.jsonl')

// panel and cli are a person; the rest are automation
const ACTOR_KINDS = new Set(['panel', 'cli', 'assistant', 'schedule', 'spawnloft'])

const context = new AsyncLocalStorage()
let fallback = { kind: 'spawnloft' }

export function setDefaultActor(actor) {
  fallback = cleanActor(actor)
}

export function asActor(actor, fn) {
  return context.run(cleanActor(actor), fn)
}

export function currentActor() {
  return context.getStore() ?? fallback
}

function cleanActor(actor) {
  const kind = ACTOR_KINDS.has(actor?.kind) ? actor.kind : 'spawnloft'
  const out = { kind }
  // free text from outside (assistant app or task name), so sanitised and capped
  if (actor?.name) out.name = String(actor.name).replace(/[\r\n\t]+/g, ' ').slice(0, 80)
  return out
}

// Never throws: a full disk must not turn a successful operation into an error.
// `snapshot` is the snapshot taken first, i.e. what an undo would restore.
export function record(server, action, { detail = null, snapshot = null, ok = true } = {}) {
  const entry = { at: new Date().toISOString(), server: String(server), action: String(action), by: currentActor() }
  if (detail) entry.detail = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 500)
  if (snapshot) entry.snapshot = String(snapshot)
  if (!ok) entry.ok = false
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true })
    rotate()
    // a writer that died mid-line left no newline; without one this line would be glued onto it
    fs.appendFileSync(FILE(), (endsMidLine() ? '\n' : '') + JSON.stringify(entry) + '\n')
  } catch {
    /* logging is best-effort */
  }
  return entry
}

function endsMidLine() {
  let fd
  try {
    fd = fs.openSync(FILE(), 'r')
    const size = fs.fstatSync(fd).size
    if (!size) return false
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function rotate() {
  let size = 0
  try { size = fs.statSync(FILE()).size } catch { return }
  if (size < MAX_BYTES) return
  try {
    fs.renameSync(FILE(), PREVIOUS())
  } catch {
    /* another process rotated it first */
  }
}

function readLines(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* truncated by a crash mid-write */ }
  }
  return out
}

// Newest first. `since`/`before` are ISO times, `by` is an actor kind, `more` says whether
// older entries matched beyond `limit`.
export function readActivity({ server = null, since = null, before = null, by = null, limit = 100 } = {}) {
  const all = [...readLines(PREVIOUS()), ...readLines(FILE())]
  const matched = []
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]
    if (server && e.server !== server) continue
    if (since && e.at < since) break
    if (before && e.at >= before) continue
    // 'you' means panel or cli
    if (by && (by === 'you' ? !['panel', 'cli'].includes(e.by?.kind) : e.by?.kind !== by)) continue
    matched.push(e)
    if (matched.length > limit) break
  }
  return { entries: matched.slice(0, limit), more: matched.length > limit }
}

export function renameServer(from, to) {
  for (const file of [PREVIOUS(), FILE()]) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n').map((line) => {
      if (!line.trim()) return line
      try {
        const e = JSON.parse(line)
        if (e.server !== from) return line
        return JSON.stringify({ ...e, server: to })
      } catch {
        return line
      }
    })
    try {
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, lines.join('\n'))
      fs.renameSync(tmp, file)
    } catch {
      /* entries keep the old name */
    }
  }
}
