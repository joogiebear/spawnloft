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

export function parseLine(line) {
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

function combineDateTime(dateObj, hms) {
  const [h, mi, s] = hms.split(':').map(Number)
  dateObj.setHours(h, mi, s, 0)
  return dateObj.toISOString()
}

export function parseLog(lines, { source, anchor = null, mtime = null }) {
  let baseDate
  if (anchor !== null) {
    baseDate = new Date(typeof anchor === 'number' ? anchor : anchor)
  } else if (mtime !== null) {
    baseDate = new Date(mtime)
  } else {
    baseDate = new Date()
  }

  const currentDate = new Date(baseDate)
  const entries = []
  let prevTimeMs = null

  for (const line of lines) {
    const parsed = parseLine(line)

    if (parsed.time === null && parsed.iso === null) {
      if (entries.length > 0) {
        entries[entries.length - 1].text += '\n' + line
      } else {
        entries.push({
          at: currentDate.toISOString(),
          source,
          level: null,
          thread: null,
          text: line,
          raw: line,
        })
      }
      continue
    }

    if (parsed.iso !== null) {
      entries.push({
        at: parsed.iso,
        source,
        level: null,
        thread: null,
        text: parsed.text,
        raw: line,
      })
      continue
    }

    const timeMs = hmsToMs(parsed.time)
    if (prevTimeMs !== null && prevTimeMs - timeMs > 3600000) {
      currentDate.setDate(currentDate.getDate() + 1)
    }
    prevTimeMs = timeMs

    const at = combineDateTime(currentDate, parsed.time)
    entries.push({
      at,
      source,
      level: parsed.level,
      thread: parsed.thread,
      text: parsed.text,
      raw: line,
    })
  }

  return entries
}

export function mergeTimelines(...lists) {
  return lists.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
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
