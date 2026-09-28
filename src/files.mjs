import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseProps, readProps, worldDirs } from './props.mjs'
import { checkFormat, MANAGED_PROPS } from './config-files.mjs'
import * as backup from './backup.mjs'
import { createZip, extractZip, isZip } from './zip.mjs'
import { runTar } from './tar.mjs'
import { fail, humanBytes } from './util.mjs'

/**
 * A server's folder, as its owner sees it in the Files tool.
 *
 * <p>This is not the assistant's view (config-files.mjs), which is confined to text configuration
 * and hides passwords. The owner sees every file, as it is: they could open the folder in Explorer
 * anyway, and a file manager that hid things from the person who owns them would only send them
 * there. What it keeps from that module is the confinement - nothing outside the server's folder,
 * links included - and the rule that a change can be taken back: every edit, overwrite and delete
 * snapshots what it replaces first, one file or folder at a time, so the Backups tool can put back
 * exactly that.
 *
 * <p>While the server runs, the files it holds open are not moved, replaced or deleted from under
 * it: the active worlds, its jar, and the folders it loads code from. Editing text is allowed
 * everywhere, since that is what a config reload is for.
 */

// Past this the editor is not offered; the file downloads instead. A textarea holding more than a
// couple of megabytes is slow to type into, and no config is that size.
export const MAX_EDIT_BYTES = 2 * 1024 * 1024
// A delete bigger than this asks before it copies: gzipping a whole world can take minutes.
export const MAX_COPY_BYTES = 1024 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_VISITS = 50000

const FILE_NAME_BAD = /[<>:"|?*\u0000-\u001f]/

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const toSlash = (p) => p.split(path.sep).join('/')

/**
 * A path from the panel, checked and resolved inside the server's folder. '' is the folder itself.
 *
 * <p>The target itself is not followed if it is a link: deleting or renaming a link acts on the
 * link. Its parent chain is, so a linked folder that leads out of the server cannot be walked into.
 */
export function resolvePath(inst, relative, { mustExist = true, allowRoot = false } = {}) {
  const raw = typeof relative === 'string' ? relative : ''
  const clean = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (clean.includes('\0') || path.isAbsolute(clean) || /^[a-z]:/i.test(clean) || clean.startsWith('/')) {
    fail(`"${raw}" must be a path inside the server folder`)
  }
  const parts = clean.split('/').filter((p) => p && p !== '.')
  if (parts.includes('..')) fail(`"${raw}" must stay inside the server folder`)
  if (!parts.length && !allowRoot) fail('choose a file or folder inside the server folder')

  const base = fs.realpathSync(inst.dir)
  const full = path.join(base, ...parts)
  const rel = parts.join('/')
  let existing = parts.length ? path.dirname(full) : base
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  if (!isInside(base, fs.realpathSync(existing))) fail(`${rel} leads outside the server folder`)

  let stat = null
  try { stat = fs.lstatSync(full) } catch { /* not there */ }
  if (mustExist && !stat) fail(`${rel || 'the server folder'} does not exist`)
  return { base, full, rel, stat }
}

/** A name for something new in a folder: one segment, and one Windows can hold. */
function checkName(name) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\')) fail('a name is one file or folder name, with no slashes')
  if (FILE_NAME_BAD.test(n) || /[. ]$/.test(n)) fail(`"${n}" is not a name a file can have here`)
  if (n.length > 200) fail('that name is too long')
  return n
}

/**
 * What the running server holds, as lower-cased top-level names. Empty while it is stopped.
 * `libraries` and `versions` are Paper's own code, and a plugin jar is loaded until the server
 * stops, so `plugins/*.jar` is checked separately.
 */
export function inUse(inst, running) {
  if (!running) return new Set()
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const names = [...worldDirs(props), 'libraries', 'versions', 'cache']
  if (inst.jar) names.push(inst.jar.split(/[\\/]/)[0])
  return new Set(names.map((n) => n.toLowerCase()))
}

function assertFree(inst, rel, running, doing) {
  if (!running) return
  const top = rel.split('/')[0].toLowerCase()
  const busy = inUse(inst, true)
  const loadedJar = /^(plugins|mods)\/[^/]+\.jar$/i.test(rel)
  if (busy.has(top) || loadedJar || rel === '') {
    fail(`${rel || 'the server folder'} is in use by the running server. Stop it first to ${doing} it.`)
  }
}

/** One folder's contents: folders first, then files, each by name. */
export function listDir(inst, relative = '', { running = false } = {}) {
  const { full, rel, stat } = resolvePath(inst, relative, { allowRoot: true })
  if (!stat.isDirectory() && !(stat.isSymbolicLink() && fs.statSync(full).isDirectory())) fail(`${rel} is not a folder`)
  const busy = inUse(inst, running)
  const entries = []
  for (const d of fs.readdirSync(full, { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name
    let s
    try { s = fs.lstatSync(path.join(full, d.name)) } catch { continue }
    let type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'other'
    if (type === 'link') {
      // A link that stays inside reads as what it points at; one that leaves is shown and inert.
      try {
        const target = fs.realpathSync(path.join(full, d.name))
        if (isInside(fs.realpathSync(inst.dir), target)) type = fs.statSync(target).isDirectory() ? 'dir' : 'file'
      } catch { /* a dangling link stays a link */ }
    }
    const top = p.split('/')[0].toLowerCase()
    entries.push({
      name: d.name,
      path: p,
      type,
      size: type === 'file' ? s.size : null,
      modified: s.mtime.toISOString(),
      inUse: running && (busy.has(top) || /^(plugins|mods)\/[^/]+\.jar$/i.test(p)),
    })
  }
  entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir')
    ? (a.type === 'dir' ? -1 : 1)
    : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return { path: rel, entries }
}

const versionOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

/**
 * One file for the editor. A file too big, or one that is not text, comes back without its text,
 * and the panel offers the download instead.
 */
export async function readFile(inst, relative) {
  const { full, rel } = resolvePath(inst, relative)
  const s = await fs.promises.stat(full)
  if (!s.isFile()) fail(`${rel} is not a file`)
  const base = { path: rel, size: s.size, modified: s.mtime.toISOString() }
  if (s.size > MAX_EDIT_BYTES) return { ...base, text: null, reason: 'large' }
  const buf = await fs.promises.readFile(full)
  // A NUL in the first stretch is the usual sign of a binary file: a jar, a world, an image.
  if (buf.subarray(0, 8192).includes(0)) return { ...base, text: null, reason: 'binary' }
  return { ...base, text: buf.toString('utf8'), version: versionOf(buf) }
}

/**
 * Take a copy of what is about to change, on its own, so the Backups tool can put back exactly it.
 * A file that does not exist yet has nothing to copy.
 */
async function snapshotFirst(inst, rels, label) {
  const members = rels.filter((r) => fs.existsSync(path.join(inst.dir, ...r.split('/'))))
  if (!members.length) return null
  const snap = await backup.createSnapshot(inst, { scope: 'files', label, members, flush: false })
  return path.basename(snap.file)
}

function atomicWrite(full, data) {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const tmp = `${full}.spawnloft-${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, full)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Save a file from the editor.
 *
 * <p>`version` is what readFile said the file was: a save over a file that changed since - the
 * server rewrote it, or it was edited somewhere else - is refused rather than silently undoing that
 * change. The two mistakes that stop a plugin loading its config at all, a tab in YAML and broken
 * JSON, are refused unless `force`, with a code the panel turns into "Save anyway".
 */
export async function writeFile(inst, relative, { text, version = null, create = false, force = false } = {}) {
  if (typeof text !== 'string') fail('text is required')
  const { full, rel, stat } = resolvePath(inst, relative, { mustExist: !create })
  if (create && stat) fail(`${rel} already exists`)
  if (create) checkName(path.basename(rel))
  if (stat && !stat.isFile()) fail(`${rel} is not a file`)
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) fail(`that would make ${rel} over ${humanBytes(MAX_EDIT_BYTES)}`)

  const beforeBuf = stat ? await fs.promises.readFile(full) : null
  if (beforeBuf && version !== versionOf(beforeBuf)) {
    const err = new Error(`${rel} has changed on disk since it was opened. Reload it to see the change, then make yours again.`)
    err.userFacing = true
    err.code = 'changed'
    throw err
  }
  const before = beforeBuf ? beforeBuf.toString('utf8') : null

  let after = text
  // The file's own line endings and byte-order mark, which a textarea does not keep.
  if (before !== null && before.includes('\r\n') && !after.includes('\r\n')) after = after.replace(/\n/g, '\r\n')
  if (before !== null && before.charCodeAt(0) === 0xfeff && after.charCodeAt(0) !== 0xfeff) after = '﻿' + after

  if (rel.toLowerCase() === 'server.properties') {
    const was = parseProps(before ?? '')
    const now = parseProps(after)
    const touched = MANAGED_PROPS.filter((k) => (was.get(k) ?? '').trim() !== (now.get(k) ?? '').trim())
    if (touched.length) {
      fail(`${touched.join(', ')} ${touched.length > 1 ? 'are' : 'is'} set by SpawnLoft at every start and would be put back. ` +
        'Change the port and RCON in the server\'s Settings instead.')
    }
  }
  if (!force) {
    try {
      checkFormat(rel, after)
    } catch (err) {
      err.code = 'format'
      throw err
    }
  }

  const snapshot = await snapshotFirst(inst, stat ? [rel] : [], 'file-edit')
  // The copy took a moment; a server that rewrote the file meanwhile must not lose that write.
  if (beforeBuf && versionOf(await fs.promises.readFile(full)) !== versionOf(beforeBuf)) {
    fail(`${rel} changed while it was being copied; reload it and try again`)
  }
  atomicWrite(full, after)
  return { path: rel, version: versionOf(Buffer.from(after)), snapshot }
}

/** A new, empty folder. */
export function makeFolder(inst, parent, name) {
  const { rel: dir } = resolvePath(inst, parent, { allowRoot: true })
  const n = checkName(name)
  const { full, rel, stat } = resolvePath(inst, dir ? `${dir}/${n}` : n, { mustExist: false })
  if (stat) fail(`${rel} already exists`)
  fs.mkdirSync(full)
  return { path: rel }
}

/**
 * A file arriving from the person's own machine: a plugin jar dragged in, a config sent by a plugin
 * author. Streamed to a temporary name beside where it lands, then renamed, so a server reading
 * the folder never sees half a jar. Replacing a file copies the old one first.
 */
export async function uploadFile(inst, parent, name, stream, { overwrite = false, running = false } = {}) {
  const { rel: dir, stat: dirStat } = resolvePath(inst, parent, { allowRoot: true })
  if (!dirStat.isDirectory()) fail(`${dir} is not a folder`)
  const n = checkName(name)
  const { full, rel, stat } = resolvePath(inst, dir ? `${dir}/${n}` : n, { mustExist: false })
  if (stat && !overwrite) {
    const err = new Error(`${rel} already exists`)
    err.userFacing = true
    err.code = 'exists'
    throw err
  }
  if (stat && !stat.isFile()) fail(`${rel} is a folder; a file cannot replace it`)
  // Adding a file is harmless to a running server - a new plugin loads at the next start - but
  // replacing one it holds open is not.
  if (stat) assertFree(inst, rel, running, 'replace')

  const tmp = `${full}.spawnloft-${process.pid}-${Date.now()}.part`
  let size = 0
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp)
      stream.on('data', (c) => { size += c.length })
      stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      stream.pipe(out)
    })
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  let snapshot = null
  try {
    snapshot = stat ? await snapshotFirst(inst, [rel], 'file-replace') : null
    fs.renameSync(tmp, full)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  return { path: rel, size, snapshot }
}

/**
 * Rename in place, or move to another folder: `to` is the new path from the server folder.
 * Nothing is copied, since nothing is lost - the old name is the undo.
 */
export function movePath(inst, from, to, { running = false } = {}) {
  const src = resolvePath(inst, from)
  const dstRaw = typeof to === 'string' ? to.trim().replace(/\\/g, '/') : ''
  checkName(dstRaw.split('/').filter(Boolean).pop() ?? '')
  const dst = resolvePath(inst, dstRaw, { mustExist: false })
  if (dst.stat) fail(`${dst.rel} already exists`)
  if (dst.rel === src.rel) fail('that is its name already')
  if (dst.rel.toLowerCase().startsWith(src.rel.toLowerCase() + '/')) fail('a folder cannot be moved inside itself')
  assertFree(inst, src.rel, running, 'move')
  assertFree(inst, dst.rel, running, 'move into')
  const parent = path.dirname(dst.full)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail(`${toSlash(path.relative(src.base, parent))} is not a folder`)
  fs.renameSync(src.full, dst.full)
  return { from: src.rel, path: dst.rel }
}

async function sizeOf(full) {
  const s = await fs.promises.lstat(full)
  if (!s.isDirectory()) return s.size
  let total = 0
  for (const d of await fs.promises.readdir(full, { withFileTypes: true })) total += await sizeOf(path.join(full, d.name))
  return total
}

/**
 * Delete files and folders, after a copy of them is taken.
 *
 * <p>A copy of a few gigabytes of world is minutes of gzip, so past MAX_COPY_BYTES this refuses
 * with code 'large' and says how big, and the panel asks whether to delete without one.
 */
export async function deletePaths(inst, paths, { withoutCopy = false, running = false } = {}) {
  if (!Array.isArray(paths) || !paths.length) fail('choose something to delete')
  const targets = paths.map((p) => resolvePath(inst, p))
  for (const t of targets) assertFree(inst, t.rel, running, 'delete')
  // A folder and something inside it, both chosen, is the folder.
  const rels = [...new Set(targets.map((t) => t.rel))]
    .filter((r, _, all) => !all.some((o) => o !== r && r.startsWith(o + '/')))

  let snapshot = null
  if (!withoutCopy) {
    let bytes = 0
    for (const r of rels) bytes += await sizeOf(path.join(inst.dir, ...r.split('/')))
    if (bytes > MAX_COPY_BYTES) {
      const err = new Error(`that is ${humanBytes(bytes)}; keeping a copy first would take a while and as much space again`)
      err.userFacing = true
      err.code = 'large'
      err.bytes = bytes
      throw err
    }
    snapshot = await snapshotFirst(inst, rels, 'file-delete')
  }
  for (const r of rels) await fs.promises.rm(path.join(inst.dir, ...r.split('/')), { recursive: true, force: true })
  return { deleted: rels, snapshot }
}

/** Zip files and folders of one folder into a new archive beside them. */
export async function archivePaths(inst, paths, name) {
  if (!Array.isArray(paths) || !paths.length) fail('choose something to archive')
  const targets = paths.map((p) => resolvePath(inst, p))
  const dir = path.posix.dirname(targets[0].rel)
  if (targets.some((t) => path.posix.dirname(t.rel) !== dir)) fail('archive things from one folder at a time')
  let n = checkName(name || (targets.length === 1 ? targets[0].rel.split('/').pop() : 'archive'))
  if (!/\.zip$/i.test(n)) n += '.zip'
  const out = resolvePath(inst, dir === '.' ? n : `${dir}/${n}`, { mustExist: false })
  if (out.stat) fail(`${out.rel} already exists`)
  const cwd = dir === '.' ? out.base : path.join(out.base, ...dir.split('/'))
  const tmp = `${out.full}.spawnloft-${process.pid}.part`
  try {
    await createZip(tmp, cwd, targets.map((t) => t.rel.split('/').pop()))
    fs.renameSync(tmp, out.full)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  return { path: out.rel, size: fs.statSync(out.full).size }
}

/**
 * Unpack a .zip or .tar.gz into a new folder beside it, named after it. Never over existing files:
 * a map or a config pack that is meant to merge is moved into place afterwards, by a person who
 * can see what it holds.
 */
export async function extractArchive(inst, relative, { running = false } = {}) {
  const src = resolvePath(inst, relative)
  if (!src.stat.isFile()) fail(`${src.rel} is not a file`)
  const lower = src.rel.toLowerCase()
  const kind = lower.endsWith('.zip') || lower.endsWith('.mrpack') ? 'zip'
    : lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ? 'tgz' : null
  if (!kind) fail(`${src.rel} is not a .zip or .tar.gz`)
  const stem = src.rel.split('/').pop().replace(/\.(zip|mrpack|tar\.gz|tgz)$/i, '') || 'archive'
  const dir = path.posix.dirname(src.rel)
  let target = null
  for (let i = 0; i < 100 && !target; i++) {
    const candidate = (dir === '.' ? '' : dir + '/') + (i ? `${stem} (${i + 1})` : stem)
    if (!fs.existsSync(path.join(src.base, ...candidate.split('/')))) target = candidate
  }
  if (!target) fail(`there are already too many folders named ${stem}`)
  assertFree(inst, target, running, 'extract into')

  const full = path.join(src.base, ...target.split('/'))
  const staging = fs.mkdtempSync(path.join(path.dirname(full), '.spawnloft-extract-'))
  try {
    if (kind === 'zip') {
      if (!isZip(src.full)) fail(`${src.rel} is not a zip archive`)
      await extractZip(src.full, staging)
    } else {
      const { code, stderr } = await runTar(['-xzf', src.full, '-C', staging], staging)
      if (code !== 0) fail(`could not unpack ${src.rel}: ${stderr.trim().split(/\r?\n/)[0] || `tar exited ${code}`}`)
    }
    fs.renameSync(staging, full)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
  return { path: target }
}

/**
 * Files and folders whose name contains `query`, under a folder. Breadth first and capped, so a
 * search from the top of a server with a large world answers quickly with what is nearest.
 */
export async function searchNames(inst, relative, query, { running = false } = {}) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q.length < 2) fail('search for at least two characters')
  const { full, rel } = resolvePath(inst, relative, { allowRoot: true })
  const base = fs.realpathSync(inst.dir)
  const busy = inUse(inst, running)
  const results = []
  let visits = 0
  let level = [full]
  while (level.length && results.length < MAX_SEARCH_RESULTS && visits < MAX_SEARCH_VISITS) {
    const next = []
    for (const dir of level) {
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const d of entries) {
        if (++visits > MAX_SEARCH_VISITS || results.length >= MAX_SEARCH_RESULTS) break
        const abs = path.join(dir, d.name)
        const p = toSlash(path.relative(base, abs))
        if (d.name.toLowerCase().includes(q)) {
          let s = null
          try { s = await fs.promises.lstat(abs) } catch { continue }
          results.push({
            name: d.name,
            path: p,
            type: s.isDirectory() ? 'dir' : 'file',
            size: s.isFile() ? s.size : null,
            modified: s.mtime.toISOString(),
            inUse: running && busy.has(p.split('/')[0].toLowerCase()),
          })
        }
        if (d.isDirectory()) next.push(abs)
      }
    }
    level = next
  }
  return { path: rel, query: q, results, truncated: results.length >= MAX_SEARCH_RESULTS || visits >= MAX_SEARCH_VISITS }
}

/**
 * What a download sends: a file as itself, a folder zipped into a temporary file first. The
 * caller streams `file` and calls `done` when the response has finished with it.
 */
export async function downloadable(inst, relative) {
  const { full, rel, stat } = resolvePath(inst, relative)
  const real = stat.isSymbolicLink() ? fs.statSync(full) : stat
  if (real.isFile()) return { file: full, name: rel.split('/').pop(), size: real.size, done: () => {} }
  if (!real.isDirectory()) fail(`${rel} cannot be downloaded`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dl-'))
  const name = `${rel.split('/').pop()}.zip`
  const file = path.join(tmpDir, name)
  try {
    await createZip(file, path.dirname(full), [path.basename(full)])
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
  return { file, name, size: fs.statSync(file).size, done: () => fs.rmSync(tmpDir, { recursive: true, force: true }) }
}
