import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DATA_ROOT } from './paths.mjs'

/**
 * What was done to each server, when, and by whom.
 *
 * <p>Whom is the point. The same stop can come from the panel, a terminal, a scheduled task, an AI
 * assistant or SpawnLoft's own crash guard, and "who restarted it at 3am" or "what did the assistant
 * change" is the question this exists to answer. The operations themselves do not know who called
 * them, and threading a caller through every function would touch all of them, so each entry point
 * says who it is once - `asActor` - and every entry recorded underneath it, however deep, carries
 * that. Anything recorded outside one is SpawnLoft's own doing, unless the process says otherwise
 * with `setDefaultActor` (the command line does).
 *
 * <p>One file for every server, appended a line at a time by whichever process did the thing: the
 * panel, the CLI, a task, the MCP server and the daemons all write here. A line is small enough
 * that an append from one never lands inside another's. Past MAX_BYTES the file becomes the
 * previous one and a new one starts, so history is bounded at about twice that.
 */

export const MAX_BYTES = 2 * 1024 * 1024
const FILE = () => path.join(DATA_ROOT, 'activity.jsonl')
const PREVIOUS = () => path.join(DATA_ROOT, 'activity.1.jsonl')

/** Who: 'panel' (a person, in the app), 'cli' (a person, in a terminal), 'assistant', 'schedule', 'spawnloft'. */
const ACTOR_KINDS = new Set(['panel', 'cli', 'assistant', 'schedule', 'spawnloft'])

const context = new AsyncLocalStorage()
let fallback = { kind: 'spawnloft' }

export function setDefaultActor(actor) {
  fallback = cleanActor(actor)
}

/** Run `fn` with everything it records attributed to `actor`. */
export function asActor(actor, fn) {
  return context.run(cleanActor(actor), fn)
}

export function currentActor() {
  return context.getStore() ?? fallback
}

function cleanActor(actor) {
  const kind = ACTOR_KINDS.has(actor?.kind) ? actor.kind : 'spawnloft'
  const out = { kind }
  // The assistant's app, or the task's name: free text from outside, kept short.
  if (actor?.name) out.name = String(actor.name).replace(/[\r\n\t]+/g, ' ').slice(0, 80)
  return out
}

/**
 * Write one entry. Never throws: a full disk or a read-only data folder must not turn a stop that
 * worked into an error, so a failure here is swallowed and the operation stands.
 *
 * @param server the server (or database) it was done to
 * @param action a short verb phrase: 'start', 'file-edit', 'plugin-install'
 * @param detail what it was done with, in a sentence: the file, the plugin, the command
 * @param snapshot the snapshot taken first, when there is one: what an undo would put back
 */
export function record(server, action, { detail = null, snapshot = null, ok = true } = {}) {
  const entry = { at: new Date().toISOString(), server: String(server), action: String(action), by: currentActor() }
  if (detail) entry.detail = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 500)
  if (snapshot) entry.snapshot = String(snapshot)
  if (!ok) entry.ok = false
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true })
    rotate()
    // A writer that died mid-line left no newline, and this line would be glued onto the end of
    // that one and lost with it.
    fs.appendFileSync(FILE(), (endsMidLine() ? '\n' : '') + JSON.stringify(entry) + '\n')
  } catch {
    /* the history is a record of what happened, not a condition of it happening */
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
    try { out.push(JSON.parse(line)) } catch { /* a line cut short by a crash mid-write */ }
  }
  return out
}

/**
 * Entries, newest first. `server` narrows to one; `since` and `before` are ISO times; `by` is an
 * actor kind. `limit` caps what comes back, and `more` says whether anything older matched.
 */
export function readActivity({ server = null, since = null, before = null, by = null, limit = 100 } = {}) {
  const all = [...readLines(PREVIOUS()), ...readLines(FILE())]
  const matched = []
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]
    if (server && e.server !== server) continue
    if (since && e.at < since) break
    if (before && e.at >= before) continue
    // 'you' is the person, whichever door they came in by.
    if (by && (by === 'you' ? !['panel', 'cli'].includes(e.by?.kind) : e.by?.kind !== by)) continue
    matched.push(e)
    if (matched.length > limit) break
  }
  return { entries: matched.slice(0, limit), more: matched.length > limit }
}

/** A renamed server keeps its history: every entry under the old name moves to the new one. */
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
      /* the old name stays on those entries; nothing else depends on it */
    }
  }
}
