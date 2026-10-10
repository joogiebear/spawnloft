import fs from 'node:fs'
import path from 'node:path'

import { BACKUPS_DIR, RUN_DIR, consoleLog } from './paths.mjs'
import { fail, humanBytes, stamp, writeFileWithMode, PRIVATE_FILE_MODE } from './util.mjs'

export const MAX_LINES = 25000
export const MAX_BYTES = 10 * 1024 * 1024

const UPLOAD_URL = 'https://api.mclo.gs/1/log'
const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

function readConsole(sourceFile) {
  if (!fs.existsSync(sourceFile)) {
    fail('this server has no console log yet - start it once, and the log appears')
  }
  const text = fs.readFileSync(sourceFile, 'utf8')
  if (!text.trim()) fail('the console log is empty - there is nothing to export yet')
  return text
}

function splitLines(text) {
  const parts = text.split('\n')
  const trailing = parts.length > 1 && parts[parts.length - 1] === ''
  if (trailing) parts.pop()
  return { parts, trailing }
}

/**
 * Take the person's account name out of the paths before the log goes public.
 *
 * <p>A server log is full of paths - the working directory, every plugin's data folder, every
 * stack trace with a file in it - and on Windows those paths carry the account name:
 * C:\Users\Josh\AppData\... mclo.gs removes IP addresses on its side, best effort, and nothing
 * else; Aternos's own upload mod strips the system username on the device before sending, and
 * this is the same courtesy. Player names, plugin output and everything else are left as they
 * are, and the consent dialog says so.
 */
export function redactAccountName(text) {
  return String(text)
    // Up to the next separator first, so "Josh Smith" goes whole; then a name with no separator
    // after it. The second pass cannot touch what the first wrote, because it stops at "<".
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\r\n"'<>|:*?]+?)(?=[\\/])/g, '$1<user>')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s"'<>|:*?]+)/g, '$1<user>')
    .replace(/(\/(?:home|Users)\/)([^/\s"'<>|:]+)/g, '$1<user>')
}

export function trimForUpload(text) {
  const { parts, trailing } = splitLines(text.replace(/\r\n?/g, '\n'))
  const join = (lines) => lines.join('\n') + (trailing ? '\n' : '')

  let kept = parts
  let trimmed = false
  if (kept.length > MAX_LINES) {
    kept = kept.slice(-MAX_LINES)
    trimmed = true
  }

  if (Buffer.byteLength(join(kept)) > MAX_BYTES) {
    trimmed = true
    const budget = MAX_BYTES - (trailing ? 1 : 0)
    let used = 0
    let first = kept.length
    for (let i = kept.length - 1; i >= 0; i--) {
      const cost = Buffer.byteLength(kept[i]) + (i === kept.length - 1 ? 0 : 1)
      if (used + cost > budget) break
      used += cost
      first = i
    }
    kept = first === kept.length
      ? [Buffer.from(kept[kept.length - 1]).subarray(-budget).toString('utf8')]
      : kept.slice(first)
  }

  return { content: join(kept), lines: kept.length, trimmed }
}

export function exportConsole(inst, { sourceFile = consoleLog(inst.name), outDir = path.join(BACKUPS_DIR, inst.name, 'exports') } = {}) {
  const text = readConsole(sourceFile)
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${inst.name}_console_${stamp()}.log`)
  fs.writeFileSync(file, text)
  const size = fs.statSync(file).size
  return { file, size, sizeHuman: humanBytes(size), lines: splitLines(text).parts.length }
}

function rememberToken(tokenFile, entry) {
  let kept = []
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    if (Array.isArray(parsed)) kept = parsed
  } catch {}
  kept.push(entry)
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    // Deletion tokens: whoever holds one can delete the uploaded log, so the file is owner-only.
    writeFileWithMode(tokenFile, JSON.stringify(kept, null, 2), PRIVATE_FILE_MODE)
  } catch {}
}

export async function shareConsole(inst, {
  sourceFile = consoleLog(inst.name),
  tokenFile = path.join(RUN_DIR, 'mclogs.json'),
  fetchImpl = fetch,
} = {}) {
  const { content, lines, trimmed } = trimForUpload(redactAccountName(readConsole(sourceFile)))

  let res
  try {
    res = await fetchImpl(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
      body: JSON.stringify({ content, source: 'mcctl' }),
      signal: AbortSignal.timeout(60000),
    })
  } catch (err) {
    fail(`could not reach mclo.gs: ${err.cause?.message || err.message}`)
  }

  let body
  try {
    body = await res.json()
  } catch {
    fail(`mclo.gs answered ${res.status} with something that was not a log`)
  }
  if (!body?.success) fail(`mclo.gs refused the log: ${body?.error ?? `it answered ${res.status}`}`)

  if (body.token) {
    rememberToken(tokenFile, {
      id: body.id,
      url: body.url,
      token: body.token,
      instance: inst.name,
      at: new Date().toISOString(),
    })
  }

  return { url: body.url, id: body.id, raw: body.raw ?? null, lines, trimmed, expires: body.expires ?? null }
}
