// Minecraft and Paper stamp lines with a local time of day and no date, so entries are dated from an
// anchor (the process's start, else the file's mtime) in local time, and the timeline prints local
// time too: what a person reads here must match what they read in the raw log beside it.

export const SOURCES = ['server', 'daemon', 'client', 'client-process']

const PAPER_RE = /^\[(\d{2}:\d{2}:\d{2}) (\w+)\]: (.*)$/
const FABRIC_RE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)\/(\w+)\]: (.*)$/
const FABRIC_MOD_RE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)\/(\w+)\] \(([^)]+)\) (.*)$/
const DAEMON_RE = /^\[(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\] (.*)$/

function normalizeLevel(level) {
  if (!level) return null
  const upper = level.toUpperCase()
  return upper === 'SEVERE' ? 'ERROR' : upper
}

export function parseLine(raw) {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  let m = FABRIC_MOD_RE.exec(line)
  if (m) {
    return { time: m[1], iso: null, level: normalizeLevel(m[3]), thread: m[2], text: m[5] }
  }

  m = FABRIC_RE.exec(line)
  if (m) {
    return { time: m[1], iso: null, level: normalizeLevel(m[3]), thread: m[2], text: m[4] }
  }

  m = PAPER_RE.exec(line)
  if (m) {
    return { time: m[1], iso: null, level: normalizeLevel(m[2]), thread: null, text: m[3] }
  }

  m = DAEMON_RE.exec(line)
  if (m) {
    return { time: null, iso: m[1], level: null, thread: null, text: m[2] }
  }

  return { time: null, iso: null, level: null, thread: null, text: line }
}

function hmsToMs(hms) {
  const [h, mi, s] = hms.split(':').map(Number)
  return h * 3600000 + mi * 60000 + s * 1000
}

function msOfDay(d) {
  return d.getHours() * 3600000 + d.getMinutes() * 60000 + d.getSeconds() * 1000
}

function dateAt(base, dayOffset, hms) {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  const [h, mi, s] = hms.split(':').map(Number)
  d.setHours(h, mi, s, 0)
  return d.toISOString()
}

function isoOf(text) {
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? text : d.toISOString()
}

// Lines carry a time of day only, so each gets a day offset from the first (a line more than an hour
// earlier than the one before it crossed midnight) and the offsets are pinned to a calendar date by
// `mtime` when given (the last line was written at the file's mtime, which is right even when `lines`
// is a tail of a log days long), else by `anchor` (the first line is after the process started), else
// by now.
export function parseLog(lines, { source, anchor = null, mtime = null }) {
  const entries = []
  let dayOffset = 0
  let prevTimeMs = null

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const parsed = parseLine(line)

    if (parsed.time === null && parsed.iso === null) {
      if (entries.length > 0) {
        entries[entries.length - 1].text += '\n' + parsed.text
        entries[entries.length - 1].raw += '\n' + line
      } else {
        entries.push({ at: null, day: null, source, level: null, thread: null, text: parsed.text, raw: line })
      }
      continue
    }

    if (parsed.iso !== null) {
      entries.push({ at: isoOf(parsed.iso), day: null, source, level: null, thread: null, text: parsed.text, raw: line })
      continue
    }

    const timeMs = hmsToMs(parsed.time)
    if (prevTimeMs !== null && prevTimeMs - timeMs > 3600000) dayOffset += 1
    prevTimeMs = timeMs
    entries.push({ at: null, day: dayOffset, time: parsed.time, source, level: parsed.level, thread: parsed.thread, text: parsed.text, raw: line })
  }

  const timed = entries.filter((e) => e.day !== null)
  let base
  if (mtime !== null && timed.length) {
    base = new Date(mtime)
    const last = timed[timed.length - 1]
    if (hmsToMs(last.time) > msOfDay(base) + 1000) base.setDate(base.getDate() - 1)
    base.setDate(base.getDate() - last.day)
  } else if (anchor !== null) {
    base = new Date(anchor)
    if (timed.length && hmsToMs(timed[0].time) + 1000 < msOfDay(base)) base.setDate(base.getDate() + 1)
  } else {
    base = new Date(mtime ?? Date.now())
  }

  return entries.map(({ day, time, ...e }) => ({
    ...e,
    at: e.at ?? (day === null ? base.toISOString() : dateAt(base, day, time)),
  }))
}

export function mergeTimelines(...lists) {
  const ms = (e) => Date.parse(e.at) || 0
  return lists.flat().sort((a, b) => ms(a) - ms(b))
}

function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const two = (n) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export function formatTimeline(entries, { width = 0 } = {}) {
  return entries
    .map((e) => {
      const time = localTime(e.at)
      const src = width > 0 ? e.source.padEnd(width) : e.source
      const level = e.level ?? ''
      const text = e.text.replace(/\n/g, '\n  ')
      return `${time} ${src}  ${level}  ${text}`
    })
    .join('\n')
}
