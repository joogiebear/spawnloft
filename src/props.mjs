import fs from 'node:fs'
import { writeFileWithMode, renameOver, PRIVATE_FILE_MODE } from './util.mjs'

// Minimal server.properties reader/writer that keeps comments and key order, so diffs stay useful.
export function parseProps(text) {
  const map = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1))
  }
  return map
}

export function readProps(file) {
  try {
    return parseProps(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return new Map()
    throw err
  }
}

export function writeProps(file, updates) {
  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const pending = new Map(Object.entries(updates))
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line
    const eq = line.indexOf('=')
    if (eq === -1) return line
    const key = line.slice(0, eq).trim()
    if (!pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return `${key}=${value}`
  })

  while (out.length && out[out.length - 1] === '') out.pop()
  for (const [key, value] of pending) out.push(`${key}=${value}`)
  out.push('')

  // atomic write (temp + rename): this runs on every start, and a truncated file would reset the RCON
  // password and port to Minecraft's defaults
  const tmp = `${file}.tmp-${process.pid}`
  // owner-only: it contains rcon.password
  writeFileWithMode(tmp, out.join('\n'), PRIVATE_FILE_MODE)
  renameOver(tmp, file)
}

export function worldDirs(props) {
  const level = props.get('level-name') || 'world'
  return [level, `${level}_nether`, `${level}_the_end`]
}
