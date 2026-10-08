import fs from 'node:fs'

/**
 * Minimal server.properties reader/writer that preserves comment lines and
 * key order. Rewriting via a generic properties dump would scramble the file
 * every time we touch one key, which makes diffs useless.
 */
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

  // Keys that did not already exist get appended at the end.
  while (out.length && out[out.length - 1] === '') out.pop()
  for (const [key, value] of pending) out.push(`${key}=${value}`)
  out.push('')

  // Atomic (temp file + rename): this runs on every server start, so a crash mid-write would
  // truncate the file and the next start would read it back empty - silently dropping the RCON
  // password and port back to Minecraft's defaults instead of the ones mcctl just set.
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, out.join('\n'))
  fs.renameSync(tmp, file)
}

/** All world directories the server owns, derived from level-name. */
export function worldDirs(props) {
  const level = props.get('level-name') || 'world'
  return [level, `${level}_nether`, `${level}_the_end`]
}
