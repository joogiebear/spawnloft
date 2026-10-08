import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { UserError, sleep } from './util.mjs'

/**
 * Copying a folder tree and checking the copy, for moving a whole data folder.
 *
 * <p>Not `fs.cp`, for what a data folder needs that it does not promise: every modification time kept
 * (backup history is ordered by them, so a copier that resets them makes "latest" arbitrary and lets
 * retention delete the newest snapshots), links inside the tree recreated and not followed (a server
 * folder may hold one, and following it copies the data twice), a file that is held open retried for a
 * moment and then named instead of failing the lot silently, nothing ever overwritten, and every
 * failure collected before any is reported - one run says everything that is locked.
 */

/** Some files that could not be copied, or a copy that is not the original: what the person needs to read. */
export class TreeError extends UserError {
  constructor(message, problems) {
    super(problems.length ? `${message}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}` : message)
    this.problems = problems
  }
}

const plural = (n, one, many) => (n === 1 ? one : many)

/** Everything under a root, in name order, links reported as links and never followed. */
async function* walk(root, rel = '') {
  const entries = (await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const here = rel ? path.join(rel, entry.name) : entry.name
    const abs = path.join(root, here)
    const stat = await fs.promises.lstat(abs)
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'
    yield { rel: here, abs, type, stat }
    if (type === 'dir') yield* walk(root, here)
  }
}

/** How much is in a tree: files, folders, links, anything else, and the bytes in the files. */
export async function treeStats(root) {
  const stats = { files: 0, dirs: 0, links: 0, other: 0, bytes: 0 }
  for await (const entry of walk(root)) {
    if (entry.type === 'file') {
      stats.files++
      stats.bytes += entry.stat.size
    } else if (entry.type === 'dir') stats.dirs++
    else if (entry.type === 'link') stats.links++
    else stats.other++
  }
  return stats
}

/** Held open by something else, for the moment: Windows says so with one of these. */
const LOCKED = ['EBUSY', 'EPERM', 'EACCES']

async function copyFile(from, to, delays) {
  for (let attempt = 0; ; attempt++) {
    try {
      // Never over something that is there: a destination that is not empty is somebody's data.
      return await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    } catch (err) {
      if (attempt >= delays.length || !LOCKED.includes(err.code)) throw err
      await sleep(delays[attempt])
    }
  }
}

/** A link recreated with the target it had. A directory link on Windows is a junction, which needs no elevation. */
async function copyLink(entry, to) {
  const target = await fs.promises.readlink(entry.abs)
  let type
  if (process.platform === 'win32') {
    let isDirectory = false
    try {
      isDirectory = (await fs.promises.stat(entry.abs)).isDirectory()
    } catch { /* a link to nothing: kept as the file link it has to be */ }
    type = isDirectory ? 'junction' : 'file'
  }
  await fs.promises.symlink(target, to, type)
}

/**
 * Copy `src` to `dest`, which must not hold any of the same files.
 *
 * <p>Returns what was copied, and what was left out and why (`skipped`: a pipe or a device, say, which
 * a server folder has no business holding). Throws a TreeError naming every file that could not be
 * copied, after trying the rest - so the person learns all that is locked in one go, not one per run.
 * What was copied before the error is left where it is: the caller knows whether it made the folder.
 */
export async function copyTree(src, dest, { onProgress = null, retryDelays = [100, 300, 900] } = {}) {
  const totals = await treeStats(src)
  await fs.promises.mkdir(dest, { recursive: true })
  const done = { files: 0, dirs: 0, links: 0, bytes: 0, skipped: [] }
  const problems = []
  const folders = []
  for await (const entry of walk(src)) {
    const to = path.join(dest, entry.rel)
    if (entry.type === 'dir') {
      await fs.promises.mkdir(to, { recursive: true })
      folders.push(entry)
      done.dirs++
    } else if (entry.type === 'file') {
      try {
        await copyFile(entry.abs, to, retryDelays)
        await fs.promises.utimes(to, entry.stat.atime, entry.stat.mtime)
        done.files++
        done.bytes += entry.stat.size
        if (onProgress) onProgress({ files: done.files, bytes: done.bytes, totalFiles: totals.files, totalBytes: totals.bytes })
      } catch (err) {
        problems.push(`${entry.rel} (${err.message})`)
      }
    } else if (entry.type === 'link') {
      try {
        await copyLink(entry, to)
        done.links++
      } catch (err) {
        problems.push(`${entry.rel} (link: ${err.message})`)
      }
    } else {
      done.skipped.push({ path: entry.rel, reason: 'not a file, folder or link' })
    }
  }
  // A folder's own time moves whenever something is put in it, so it is set last, deepest first.
  for (const entry of folders.reverse()) {
    try {
      await fs.promises.utimes(path.join(dest, entry.rel), entry.stat.atime, entry.stat.mtime)
    } catch { /* a folder's time is not worth failing a copy for */ }
  }
  if (problems.length) throw new TreeError(`${problems.length} ${plural(problems.length, 'file', 'files')} could not be copied`, problems)
  return done
}

/** Files up to this size are compared byte for byte; larger ones by size and time, unless asked to be thorough. */
const SMALL = 1024 * 1024

async function hashOf(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function sameContents(a, b, size, thorough) {
  if (size <= SMALL) return Buffer.compare(await fs.promises.readFile(a), await fs.promises.readFile(b)) === 0
  return (await hashOf(a)) === (await hashOf(b))
}

async function index(root) {
  const map = new Map()
  for await (const entry of walk(root)) {
    const item = { type: entry.type, abs: entry.abs, size: entry.stat.size, mtimeMs: entry.stat.mtimeMs }
    if (entry.type === 'link') item.link = await fs.promises.readlink(entry.abs).catch(() => null)
    map.set(entry.rel, item)
  }
  return map
}

const sameLink = (a, b) => {
  if (a === null || b === null) return a === b
  const norm = (p) => path.normalize(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/**
 * Whether `copy` is `original`: the same files, sizes, links, and modification times (within
 * `mtimeToleranceMs`, since a drive that keeps times coarsely rounds them), and the same contents - byte
 * for byte for small files, and for larger ones only when `thorough`, since reading several gigabytes
 * twice is a cost the person should choose. Folders are compared for being there, not for their times.
 *
 * <p>Reports at most `maxProblems`, then how many more there were.
 */
export async function compareTrees(original, copy, { thorough = false, mtimeToleranceMs = 2000, maxProblems = 50 } = {}) {
  const left = await index(original)
  const right = await index(copy)
  const problems = []
  let total = 0
  let files = 0
  const add = (text) => {
    total++
    if (problems.length < maxProblems) problems.push(text)
  }
  for (const [rel, a] of left) {
    const b = right.get(rel)
    if (!b) {
      add(`${rel}: missing from the copy`)
      continue
    }
    if (a.type !== b.type) {
      add(`${rel}: is a ${a.type} in the original and a ${b.type} in the copy`)
      continue
    }
    if (a.type === 'link' && !sameLink(a.link, b.link)) add(`${rel}: link points somewhere else (${b.link}, not ${a.link})`)
    if (a.type !== 'file') continue
    files++
    if (a.size !== b.size) {
      add(`${rel}: size differs (${a.size} bytes, copy ${b.size})`)
      continue
    }
    if (Math.abs(a.mtimeMs - b.mtimeMs) > mtimeToleranceMs) add(`${rel}: modified time differs`)
    if ((a.size <= SMALL || thorough) && !(await sameContents(a.abs, b.abs, a.size, thorough))) add(`${rel}: contents differ`)
  }
  for (const rel of right.keys()) if (!left.has(rel)) add(`${rel}: not in the original`)
  if (total > problems.length) problems.push(`and ${total - problems.length} more`)
  return { ok: total === 0, problems, files }
}

/** Delete a tree. A link in it is removed as a link; what it points at is left alone. */
export async function removeTree(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
