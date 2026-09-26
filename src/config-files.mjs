import fs from 'node:fs'
import path from 'node:path'
import { parseProps, readProps, worldDirs } from './props.mjs'
import { fail } from './util.mjs'

/**
 * A server's text configuration, as an AI assistant may see and change it: plugin configs,
 * Paper's and Bukkit's own files, server.properties. Nothing else.
 *
 * <p>Confined to the server's own folder, to text formats a person edits by hand, and away from
 * the worlds, logs and the files that hold players' IP addresses. Values under a key that names a
 * password, token or secret are replaced with `[redacted]` on the way out, and any write that
 * would put a placeholder back into a file is refused - an assistant that read a redacted file and
 * wrote it back whole would otherwise replace a real password with the word "redacted".
 *
 * <p>The keys SpawnLoft itself writes into server.properties at every start (ports, RCON) are
 * refused too: a change there would be undone at the next start, and until then would leave
 * SpawnLoft talking to the wrong port.
 */

export const EXTENSIONS = new Set(['.yml', '.yaml', '.json', '.json5', '.properties', '.toml', '.conf', '.cfg', '.ini', '.txt', '.hocon'])
export const MAX_BYTES = 512 * 1024
const MAX_LISTED = 400
const MAX_DEPTH = 6

// Regenerable or not configuration; the worlds are added per server from level-name.
const EXCLUDED_DIRS = new Set(['cache', 'libraries', 'versions', 'logs', 'crash-reports', 'databases', '.paper-remapped'])
// eula.txt is the owner's own agreement to make. The other two hold players' IP addresses.
const REFUSED_FILES = new Set(['eula.txt', 'banned-ips.json', 'usercache.json'])
// Written by syncProps before every launch; see supervisor.mjs.
export const MANAGED_PROPS = ['server-port', 'enable-rcon', 'rcon.port', 'rcon.password', 'broadcast-rcon-to-ops']

export const PLACEHOLDERS = ['[redacted]', '[ip hidden]']
// A key that names a credential. "token" only as the whole last word, so an eco currency called
// tokens, or a token-cost, is not taken for one.
const SECRET_KEY = /password|passwd|secret|webhook|api[-_.]?key|(?:^|[-_.])(?:token|pass|pwd)$/i
// key: value / key = value / "key": "value", with the value up to the end of the line (or the
// closing quote).
const KEY_VALUE = /^(\s*-?\s*["']?)([\w.-]+)(["']?\s*[:=]\s*)(["']?)(.+?)\4(\s*,?\s*)$/
// Credentials inside a URL: scheme://user:password@host, or scheme://:password@host with no user,
// which is how a Redis URL usually carries one.
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/gi
// Nothing to hide in an empty value or a switch.
const NOT_A_SECRET = /^(null|~|none|true|false|""|''|\[\]|\{\})$/i

/** Replace every secret-looking value in a config file's text. */
export function redactConfig(text) {
  return text.split('\n').map((line) => {
    const eol = line.endsWith('\r') ? '\r' : ''
    let body = eol ? line.slice(0, -1) : line
    const m = KEY_VALUE.exec(body)
    if (m && SECRET_KEY.test(m[2]) && m[5].trim() && !NOT_A_SECRET.test(m[5].trim())) {
      body = `${m[1]}${m[2]}${m[3]}${m[4]}[redacted]${m[4]}${m[6]}`
    }
    return body.replace(URL_CREDENTIAL, '$1[redacted]$3') + eol
  }).join('\n')
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function excludedTops(inst) {
  const worlds = worldDirs(readProps(path.join(inst.dir, 'server.properties')))
  return new Set([...EXCLUDED_DIRS, ...worlds].map((d) => d.toLowerCase()))
}

/**
 * A path an assistant gave, checked and resolved inside the server's folder. Throws a
 * UserError the model can act on for anything outside what this module serves.
 */
export function resolveConfigPath(inst, relative, { mustExist = true } = {}) {
  if (typeof relative !== 'string' || !relative.trim()) fail('path is required, relative to the server folder, e.g. "plugins/EcoItems/config.yml"')
  const clean = relative.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean.includes('\0') || path.isAbsolute(clean) || /^[a-z]:/i.test(clean) || clean.startsWith('/')) {
    fail(`"${relative}" must be a path inside the server folder, such as "plugins/EcoItems/config.yml"`)
  }
  const parts = clean.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.includes('..')) fail(`"${relative}" must stay inside the server folder`)
  const base = fs.realpathSync(inst.dir)
  const full = path.join(base, ...parts)
  const shown = parts.join('/')

  if (excludedTops(inst).has(parts[0].toLowerCase())) fail(`${shown} is in ${parts[0]}/, which holds worlds, logs or downloads rather than configuration`)
  const fileName = parts.at(-1).toLowerCase()
  if (parts.length === 1 && REFUSED_FILES.has(fileName)) {
    fail(fileName === 'eula.txt'
      ? 'eula.txt is the server owner\'s acceptance of the Minecraft EULA; they change it themselves'
      : `${fileName} holds players' IP addresses and is not available here`)
  }
  if (!EXTENSIONS.has(path.extname(fileName))) {
    fail(`${shown} is not a text configuration file (${[...EXTENSIONS].join(', ')})`)
  }

  // A link inside the folder may point anywhere; follow what exists and check where it lands.
  let existing = full
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  if (!isInside(base, fs.realpathSync(existing))) fail(`${shown} leads outside the server folder`)
  const exists = existing === full
  if (exists && !fs.statSync(full).isFile()) fail(`${shown} is not a file`)
  if (mustExist && !exists) fail(`${shown} does not exist. list_config_files shows what does.`)
  return { full, shown, exists }
}

function readText(full, shown) {
  const size = fs.statSync(full).size
  if (size > MAX_BYTES) fail(`${shown} is ${Math.round(size / 1024)} KB; files over ${MAX_BYTES / 1024} KB are not served`)
  const buf = fs.readFileSync(full)
  if (buf.includes(0)) fail(`${shown} is not a text file`)
  return buf.toString('utf8')
}

/** The configuration files under a folder of a server, as paths relative to the server. */
export function listConfigFiles(inst, folder = '') {
  const base = fs.realpathSync(inst.dir)
  let start = base
  if (folder && folder.trim() && folder.trim() !== '.') {
    const clean = folder.trim().replace(/\\/g, '/').replace(/^\.\/|\/$/g, '')
    const parts = clean.split('/').filter(Boolean)
    if (path.isAbsolute(clean) || /^[a-z]:/i.test(clean) || parts.includes('..')) fail(`"${folder}" must be a folder inside the server folder`)
    if (excludedTops(inst).has(parts[0].toLowerCase())) fail(`${clean}/ holds worlds, logs or downloads rather than configuration`)
    start = path.join(base, ...parts)
    if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) fail(`${clean}/ is not a folder in ${inst.name}`)
    if (!isInside(base, fs.realpathSync(start))) fail(`${clean}/ leads outside the server folder`)
  }
  const excluded = excludedTops(inst)
  const files = []
  let truncated = false
  // Breadth first, so a long listing that is cut short loses the depths of one plugin's folder,
  // never server.properties or a plugin's own config.yml.
  let level = [start]
  for (let depth = 0; level.length && depth <= MAX_DEPTH && !truncated; depth++) {
    const next = []
    for (const dir of level) {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!(dir === base && excluded.has(e.name.toLowerCase()))) next.push(full)
        } else if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
          if (dir === base && REFUSED_FILES.has(e.name.toLowerCase())) continue
          if (files.length >= MAX_LISTED) { truncated = true; break }
          files.push({ path: path.relative(base, full).split(path.sep).join('/'), sizeBytes: fs.statSync(full).size })
        }
      }
      if (truncated) break
    }
    level = next
  }
  return { files, truncated }
}

/** One file's text, redacted. */
export function readConfigFile(inst, relative) {
  const { full, shown } = resolveConfigPath(inst, relative)
  const raw = readText(full, shown)
  const text = redactConfig(raw)
  return { path: shown, text, sizeBytes: Buffer.byteLength(raw), redacted: text !== raw }
}

/**
 * Work out the new text of a file without touching it: either `content` (the whole file) or an
 * exact `oldText` -> `newText` replacement that must match once. Everything that would be refused
 * is refused here, so the caller can snapshot and write knowing the write is acceptable.
 */
export function planConfigWrite(inst, relative, { content, oldText, newText } = {}) {
  const whole = content !== undefined
  const edit = oldText !== undefined || newText !== undefined
  if (whole === edit) fail('give either content (the whole new file) or old_text and new_text (one exact replacement), not both')
  if (edit && (typeof oldText !== 'string' || typeof newText !== 'string' || !oldText)) fail('old_text and new_text are both needed, and old_text must not be empty')

  const { full, shown, exists } = resolveConfigPath(inst, relative, { mustExist: edit })
  const before = exists ? readText(full, shown) : null
  const incoming = whole ? content : newText
  for (const p of PLACEHOLDERS) {
    if (incoming.includes(p)) {
      fail(`the new text contains "${p}", which is how SpawnLoft hides a value when it shows a file, not the value itself. ` +
        'Writing it would replace the real value. Change only the lines you mean to with old_text and new_text, leaving hidden values out; ' +
        'passwords and tokens are changed by the server owner, by hand.')
    }
  }

  // A whole-file write of a file with hidden values could only drop them or guess them.
  if (whole && before !== null && redactConfig(before) !== before) {
    fail(`${shown} has values SpawnLoft hides (passwords, tokens), so it is not rewritten whole. Use old_text and new_text to change the lines you mean to.`)
  }

  let after
  if (whole) {
    after = content
    // Keep the file's own line endings: a Windows-edited config stays CRLF.
    if (before !== null && before.includes('\r\n') && !after.includes('\r\n')) after = after.replace(/\n/g, '\r\n')
    if (before !== null && before.charCodeAt(0) === 0xfeff && after.charCodeAt(0) !== 0xfeff) after = '\ufeff' + after
  } else {
    const crlf = before.includes('\r\n')
    const find = crlf && !oldText.includes('\r\n') ? oldText.replace(/\n/g, '\r\n') : oldText
    const put = crlf && !newText.includes('\r\n') ? newText.replace(/\n/g, '\r\n') : newText
    const count = before.split(find).length - 1
    if (count === 0) {
      const hint = redactConfig(before).includes(oldText) || PLACEHOLDERS.some((p) => oldText.includes(p))
        ? ' It includes a hidden value; passwords and tokens are changed by the server owner, by hand.'
        : ' Read the file again with read_config_file and copy the text exactly, including indentation.'
      fail(`old_text was not found in ${shown}.${hint}`)
    }
    if (count > 1) fail(`old_text appears ${count} times in ${shown}; include more of the surrounding lines so it matches once`)
    const at = before.indexOf(find)
    after = before.slice(0, at) + put + before.slice(at + find.length)
  }
  if (after === before) fail(`that leaves ${shown} unchanged`)
  if (Buffer.byteLength(after) > MAX_BYTES) fail(`the new ${shown} would be over ${MAX_BYTES / 1024} KB`)

  checkFormat(shown, after)
  if (shown.toLowerCase() === 'server.properties') {
    const was = parseProps(before ?? '')
    const now = parseProps(after)
    const touched = MANAGED_PROPS.filter((k) => (was.get(k) ?? '').trim() !== (now.get(k) ?? '').trim())
    if (inst.bind && (was.get('server-ip') ?? '').trim() !== (now.get('server-ip') ?? '').trim()) touched.push('server-ip')
    if (touched.length) {
      fail(`${touched.join(', ')} in server.properties ${touched.length > 1 ? 'are' : 'is'} set by SpawnLoft at every start and would be put back. ` +
        'Ports and RCON are changed in SpawnLoft itself, where it can check the new port is free.')
    }
  }
  return { full, shown, existed: exists, before, after }
}

/**
 * The mistakes that would stop a plugin loading its config at all, caught before they are
 * written. Not a validator: YAML is only checked for tab indentation, which YAML forbids and
 * which is the usual way a hand- or model-edited file breaks. JSON is parsed.
 */
export function checkFormat(shown, text) {
  const ext = path.extname(shown).toLowerCase()
  if (ext === '.yml' || ext === '.yaml') {
    const lines = text.split(/\r?\n/)
    const bad = lines.findIndex((l) => /^ *\t/.test(l))
    if (bad !== -1) fail(`line ${bad + 1} of the new ${shown} is indented with a tab, which YAML does not allow; use spaces`)
  } else if (ext === '.json') {
    try { JSON.parse(text.replace(/^\ufeff/, '')) } catch (err) { fail(`the new ${shown} is not valid JSON: ${err.message}`) }
  }
}

/** Whether the file still holds what the plan was made from. */
export function unchangedSince(plan) {
  try {
    return fs.readFileSync(plan.full, 'utf8') === plan.before
  } catch (err) {
    if (err.code === 'ENOENT') return plan.before === null
    throw err
  }
}

/** Write a planned change: to a temporary file beside it, then renamed over it. */
export function applyConfigWrite(plan) {
  fs.mkdirSync(path.dirname(plan.full), { recursive: true })
  const tmp = `${plan.full}.spawnloft-${process.pid}.tmp`
  fs.writeFileSync(tmp, plan.after)
  try {
    fs.renameSync(tmp, plan.full)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** A small line diff for the reply: the lines that changed, with a line of context. */
export function summarizeChange(before, after, maxLines = 40) {
  // Shown the way read_config_file shows the file, hidden values and all.
  const a = redactConfig((before ?? '').replace(/^﻿/, '')).split(/\r?\n/)
  const b = redactConfig(after.replace(/^﻿/, '')).split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const out = [`@@ line ${start + 1} @@`]
  if (start > 0) out.push(`  ${a[start - 1]}`)
  for (const l of a.slice(start, endA + 1)) out.push(`- ${l}`)
  for (const l of b.slice(start, endB + 1)) out.push(`+ ${l}`)
  if (endA + 1 < a.length) out.push(`  ${a[endA + 1]}`)
  return out.length > maxLines ? [...out.slice(0, maxLines), `... ${out.length - maxLines} more line(s)`].join('\n') : out.join('\n')
}
