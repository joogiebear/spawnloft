import fs from 'node:fs'
import path from 'node:path'
import { UserError, humanBytes, readJson, writeJson, sleep, lockHolder } from './util.mjs'
import { copyTree, compareTrees, treeStats, removeTree, TreeError } from './tree.mjs'

// Moves the data folder and leaves a link at the old path (a junction on Windows, which needs no
// elevation; a symlink elsewhere). The registry, database configs, task shims and systemd units
// all store absolute paths, so the link keeps them valid without rewriting anything. It also
// escapes Windows' private AppData copies (see private-copy.mjs).
//
// Same drive: a single atomic rename. Another drive: copy, compare, then rename the original to a
// parked name beside the link. The move never deletes the original; finishMove does that later.
//
// Between the rename and makeLink there is no folder at the old path (two adjacent sync calls).
// Nothing may touch the data root in that gap or it would be recreated empty where the link goes.

export const journalPath = (root) => `${path.resolve(root)}.move.json`

const stamp = (when) => when.toISOString().replace(/[:.]/g, '-')
const plural = (n, one, many) => (n === 1 ? one : many)
const same = (a, b) => (process.platform === 'win32' ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b))
const trimmed = (p) => path.normalize(p).replace(/[\\/]+$/, '')

function inside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function describeLink(p) {
  let stat
  try {
    stat = fs.lstatSync(p)
  } catch {
    return { exists: false, isLink: false }
  }
  if (!stat.isSymbolicLink()) return { exists: true, isLink: false, isDirectory: stat.isDirectory() }
  let target = null
  try {
    target = fs.readlinkSync(p)
  } catch { /* unreadable link: reported with no target */ }
  let dangling = false
  try {
    fs.statSync(p)
  } catch {
    dangling = true
  }
  return { exists: true, isLink: true, target, dangling }
}

export function makeLink(target, at) {
  fs.symlinkSync(path.resolve(target), at, process.platform === 'win32' ? 'junction' : 'dir')
}

// refuses a path that isn't a link, since that would delete data
export function removeLink(at) {
  if (!describeLink(at).isLink) throw new UserError(`${at} is not a link, so it was not removed`)
  fs.rmSync(at, { recursive: true, force: true })
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Windows fails a folder rename while any file inside is open (the app's logs, a scanner), so
// retry briefly and then report it as that.
function renameFolder(from, to, delays = [100, 300, 900]) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (attempt < delays.length && ['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
        sleepSync(delays[attempt])
        continue
      }
      if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
        throw new UserError(`${from} could not be renamed (${err.code}): something still has a file in it open. Close the SpawnLoft app and any program using the data folder, then try again`)
      }
      throw err
    }
  }
}

// true if a folder tree holds no files, only the empty folders a command can leave behind
function isSkeleton(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSkeleton(path.join(dir, entry.name))) return false
    }
    return true
  } catch {
    return false
  }
}

function nearestExisting(p) {
  let here = path.resolve(p)
  while (!fs.existsSync(here)) {
    const up = path.dirname(here)
    if (up === here) break
    here = up
  }
  return here
}

function writable(dir) {
  const probe = path.join(dir, `.spawnloft-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return null
  } catch (err) {
    return err.message
  }
}

// the environment around a move (running servers, tasks, locks); tests replace it
async function realEnv() {
  const { listAll } = await import('./registry.mjs')
  const { readState, isActiveStatus } = await import('./control.mjs')
  const schedule = await import('./schedule.mjs')
  const { findPrivateCopies } = await import('./private-copy.mjs')
  const { REGISTRY_FILE, BACKUPS_DIR, runDir } = await import('./paths.mjs')
  return {
    running: () => listAll().filter((i) => !i.external)
      .filter((i) => isActiveStatus(readState(i.name).status)).map((i) => i.name),
    tasks: {
      list: async () => (await schedule.list()).filter((t) => t.enabled).map((t) => ({ id: t.id, instance: t.instance, name: t.name })),
      setEnabled: (id, on) => schedule.setEnabled(id, on),
    },
    heldLocks: () => {
      // a starting server reads as stopped until its daemon publishes state, and a backup of a
      // stopped server never shows as running; only their locks reveal them
      const held = []
      if (lockHolder(`${REGISTRY_FILE}.lock`)) held.push('the server registry (being changed)')
      for (const i of listAll().filter((i) => !i.external)) {
        if (lockHolder(path.join(runDir(i.name), 'start.lock'))) held.push(`${i.name} (being started)`)
        if (lockHolder(path.join(BACKUPS_DIR, i.name, '.snapshot.lock'))) held.push(`${i.name} (being backed up)`)
      }
      return held
    },
    privateCopies: () => findPrivateCopies(),
    now: () => new Date(),
  }
}

// splits private copies into blockers (hold data found nowhere else) and shadows (only get in the way)
function sortPrivateCopies(copies) {
  const blockers = []
  const shadows = []
  for (const copy of copies) {
    if (!copy.dir) continue
    const found = []
    if (copy.backups.archives > 0) found.push(`${copy.backups.archives} ${plural(copy.backups.archives, 'backup', 'backups')} (${humanBytes(copy.backups.bytes)}) that ${plural(copy.backups.archives, 'exists', 'exist')} only there`)
    if (copy.registry.onlyInCopy?.length) found.push(`${copy.registry.onlyInCopy.length} ${plural(copy.registry.onlyInCopy.length, 'server', 'servers')} (${copy.registry.onlyInCopy.join(', ')}) that ${plural(copy.registry.onlyInCopy.length, 'exists', 'exist')} only there`)
    if (copy.instances.files > 0) found.push('files from servers\' folders')
    if (found.length) {
      blockers.push(`${copy.package} keeps a copy of the data folder at ${copy.dir} holding ${found.join(' and ')}. Moving the folder would hide them; run \`spawnloft doctor\` for what to copy out first`)
    } else {
      shadows.push(copy.dir)
    }
  }
  return { blockers, shadows }
}

// Changes nothing. `problems` stop the move, `warnings` are informational. Everything checkable is
// checked up front because a move that fails halfway is expensive.
export async function planMove({ root, dest, forceCopy = false, setAsidePrivateCopies = false, env = null }) {
  env ??= await realEnv()
  const problems = []
  const warnings = []
  const from = path.resolve(root)
  const to = path.resolve(dest)

  const here = describeLink(from)
  if (!here.exists) {
    problems.push(`there is no data folder at ${from}`)
  } else if (here.isLink) {
    problems.push(`${from} is already a link${here.target ? ` to ${here.target}` : ''}, so the data has been moved; \`spawnloft data status\` says where it is`)
  } else if (!here.isDirectory) {
    problems.push(`${from} is not a folder`)
  }
  if (fs.existsSync(journalPath(from))) {
    const earlier = readJson(journalPath(from), null)
    if (earlier && earlier.step !== 'done') {
      problems.push(`an earlier move was interrupted at "${earlier.step}"; \`spawnloft data rollback\` puts everything back, and then this can be run again`)
    }
  }
  if (same(from, to)) problems.push('that is the data folder already')
  else if (inside(from, to)) problems.push(`${to} is inside the folder being moved`)
  else if (inside(to, from)) problems.push(`the data folder is inside ${to}, which would have to be emptied first`)
  if (path.parse(to).root === to || trimmed(path.parse(to).root) === trimmed(to)) problems.push(`${to} is a whole drive; choose a folder on it`)
  if (process.platform === 'win32' && /^[\\/]{2}/.test(to)) problems.push(`${to} is a network location; a link cannot lead to one, so the data cannot live there`)

  // destination must be absent or an empty folder; never merged into
  const existed = fs.existsSync(to)
  if (existed) {
    const kind = describeLink(to)
    if (kind.isLink || !kind.isDirectory) problems.push(`${to} exists and is not a folder`)
    else if (fs.readdirSync(to).length) problems.push(`${to} is not empty; choose a folder that is new, or empty`)
  }
  const probeIn = existed ? to : nearestExisting(to)
  const cannotWrite = fs.existsSync(probeIn) && describeLink(probeIn).isDirectory ? writable(probeIn) : `${probeIn} is not a folder`
  if (cannotWrite) problems.push(`cannot write to ${probeIn} (${cannotWrite})`)

  let mode = 'rename'
  let sameDrive = false
  try {
    sameDrive = fs.statSync(from).dev === fs.statSync(nearestExisting(to)).dev
  } catch { /* unknown counts as a different drive; copying is the safe mode */ }
  if (!sameDrive || forceCopy) mode = 'copy'

  let stats = null
  if (here.exists && !here.isLink && here.isDirectory) {
    stats = await treeStats(from)
    if (stats.other) warnings.push(`${stats.other} ${plural(stats.other, 'item', 'items')} in the data folder ${plural(stats.other, 'is', 'are')} neither ${plural(stats.other, 'a file, folder nor link', 'files, folders or links')} and will not be copied`)
    if (mode === 'copy') {
      try {
        const free = fs.statfsSync(nearestExisting(to))
        const available = Number(free.bavail) * Number(free.bsize)
        const needed = Math.ceil(stats.bytes * 1.05) + 256 * 1024 * 1024
        if (available < needed) problems.push(`${to} needs about ${humanBytes(needed)} free for the copy and has ${humanBytes(available)}`)
      } catch { warnings.push('could not tell how much room there is at the new place') }
    }
  }

  // nothing may be running: a database or world can't be copied or renamed while being written
  const busy = env.running()
  if (busy.length) problems.push(`${busy.join(', ')} ${plural(busy.length, 'is', 'are')} running; stop ${plural(busy.length, 'it', 'them')} first (\`spawnloft stop <name>\`)`)
  // a start or backup in progress doesn't show as running, but holds a lock
  const locked = env.heldLocks?.() ?? []
  if (locked.length) problems.push(`${locked.join(', ')} ${plural(locked.length, 'is', 'are')} in use right now; wait for ${plural(locked.length, 'it', 'them')} to finish and try again`)

  // tasks are paused so none starts a server or backup mid-move
  let pauseTasks = []
  try {
    pauseTasks = (await env.tasks.list()).map((t) => t.id)
  } catch (err) {
    warnings.push(`could not read the scheduled tasks (${err.message}); any that fire during the move are not paused`)
  }
  if (pauseTasks.length) warnings.push(`${pauseTasks.length} scheduled ${plural(pauseTasks.length, 'task', 'tasks')} will be paused for the move and switched back on after`)

  // a private copy would hide the link from the program that has it
  let asidePrivate = []
  const copies = await env.privateCopies()
  if (copies.length) {
    const { blockers, shadows } = sortPrivateCopies(copies)
    problems.push(...blockers)
    if (shadows.length) {
      if (setAsidePrivateCopies) {
        asidePrivate = shadows
        warnings.push(`${shadows.length === 1 ? 'a private copy' : `${shadows.length} private copies`} of the data folder will be renamed so the link is what that program sees: ${shadows.join(', ')}`)
      } else {
        problems.push(`a program installed as a package keeps a private copy of the data folder, ${shadows.join(', ')}, which would hide the link from that program; rerun with --set-aside-private-copies to rename it (nothing in it is deleted)`)
      }
    }
    warnings.push('run this from a terminal or the app, not from a program installed as a package: it would be reading the private copy as if it were the data')
  }
  warnings.push('close the SpawnLoft app first; it keeps log files in the data folder, and a folder with a file open cannot be moved')

  return { from, to, mode, destExisted: existed, stats, problems, warnings, pauseTasks, asidePrivate, ok: problems.length === 0 }
}

// the journal is written before each step so an interrupted move can be put back
function journalWriter(file, journal) {
  return (patch) => {
    Object.assign(journal, patch)
    writeJson(file, journal)
  }
}

// Never deletes the original; deletes the copy only once the original is back.
export async function undoMove(journal, { env = null } = {}) {
  env ??= await realEnv()
  const notes = []
  const { from, to, parked } = journal
  let at = describeLink(from)
  if (at.isLink) {
    if (at.target && same(at.target, to)) removeLink(from)
    else notes.push(`${from} is a link to ${at.target}, not to ${to}, so it was left`)
    at = describeLink(from)
  }
  // A command run meanwhile may have recreated empty folders where the link was to go. Clear them
  // only when the data is known to be elsewhere; an empty original (fresh install) is left alone.
  const dataElsewhere = (parked && fs.existsSync(parked)) || (journal.mode === 'rename' && fs.existsSync(to) && !isSkeleton(to))
  if (at.exists && !at.isLink && at.isDirectory && dataElsewhere && isSkeleton(from)) {
    await removeTree(from)
    at = describeLink(from)
  }
  if (!at.exists) {
    if (parked && fs.existsSync(parked)) {
      renameFolder(parked, from)
    } else if (journal.mode === 'rename' && fs.existsSync(to)) {
      renameFolder(to, from)
    }
  }
  // a destination that was an empty folder stays one
  if (journal.mode === 'rename' && journal.destExisted && !fs.existsSync(to)) fs.mkdirSync(to, { recursive: true })
  const home = describeLink(from)
  if (journal.mode === 'copy' && home.exists && !home.isLink && fs.existsSync(to) && journal.step !== 'done') {
    // the original is home, so remove what the move made
    if (journal.destExisted) {
      for (const name of fs.readdirSync(to)) await removeTree(path.join(to, name))
    } else {
      await removeTree(to)
    }
  } else if (journal.mode === 'copy' && !(home.exists && !home.isLink)) {
    notes.push(`the original could not be put back at ${from}; the copy at ${to} was left`)
  }
  for (const id of journal.pausedTasks ?? []) {
    try {
      await env.tasks.setEnabled(id, true)
    } catch (err) {
      notes.push(`scheduled task ${id} could not be switched back on (${err.message})`)
    }
  }
  return notes
}

// checks the link leads to `to` and that writes through it arrive there
function probeLink(from, to) {
  const link = describeLink(from)
  if (!link.isLink) throw new UserError(`${from} is not a link`)
  if (!same(fs.realpathSync(from), fs.realpathSync(to))) throw new UserError(`the link at ${from} does not lead to ${to}`)
  const name = `.spawnloft-move-probe-${process.pid}`
  const through = path.join(from, name)
  fs.writeFileSync(through, 'probe')
  try {
    if (!fs.existsSync(path.join(to, name))) throw new UserError(`a file written through the link at ${from} did not arrive in ${to}`)
    if (fs.readFileSync(path.join(to, name), 'utf8') !== 'probe') throw new UserError('a file written through the link was changed on the way')
  } finally {
    fs.rmSync(through, { force: true })
  }
  const registry = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, 'instances.json'), 'utf8')
    } catch {
      return null
    }
  }
  if (registry(from) !== registry(to)) throw new UserError('the registry reads differently through the link than in the new folder')
}

// Returns { plan, executed, result }. A plan with problems is returned without doing anything.
// Any failure undoes the move (original put back, copy removed, tasks re-enabled).
export async function moveData({ root, dest, dryRun = true, thorough = false, forceCopy = false, setAsidePrivateCopies = false, onStep = () => {}, onProgress = null, env = null }) {
  env ??= await realEnv()
  const plan = await planMove({ root, dest, forceCopy, setAsidePrivateCopies, env })
  if (dryRun || !plan.ok) return { plan, executed: false }

  const started = env.now()
  const file = journalPath(plan.from)
  const journal = { version: 1, from: plan.from, to: plan.to, mode: plan.mode, step: 'started', destExisted: plan.destExisted, parked: null, pausedTasks: [], privateAside: [], startedAt: started.toISOString() }
  const save = journalWriter(file, journal)
  save({})
  const notes = []
  try {
    for (const id of plan.pauseTasks) {
      await env.tasks.setEnabled(id, false)
      journal.pausedTasks.push(id)
    }
    save({})

    if (plan.mode === 'rename') {
      onStep('moving')
      save({ step: 'moving' })
      if (plan.destExisted) fs.rmdirSync(plan.to)
      fs.mkdirSync(path.dirname(plan.to), { recursive: true })
      renameFolder(plan.from, plan.to)
      // no folder at the old path now; keep the link call directly after the rename
      makeLink(plan.to, plan.from)
    } else {
      onStep('copying')
      save({ step: 'copying' })
      await copyTree(plan.from, plan.to, { onProgress })
      onStep('verifying')
      save({ step: 'verifying' })
      const verdict = await compareTrees(plan.from, plan.to, { thorough })
      if (!verdict.ok) throw new TreeError('the copy does not match the original', verdict.problems)
      onStep('parking the original')
      const parked = `${plan.from}.moved-${stamp(started)}`
      save({ step: 'parking', parked })
      renameFolder(plan.from, parked)
      makeLink(plan.to, plan.from)
    }
    save({ step: 'linked' })

    onStep('checking the link')
    probeLink(plan.from, plan.to)

    for (const dir of plan.asidePrivate) {
      const aside = `${dir}.set-aside-${stamp(started)}`
      try {
        fs.renameSync(dir, aside)
        journal.privateAside.push({ from: dir, to: aside })
      } catch (err) {
        notes.push(`the private copy ${dir} could not be renamed (${err.message}); that program may still read it`)
      }
    }
    for (const id of journal.pausedTasks) {
      try {
        await env.tasks.setEnabled(id, true)
      } catch (err) {
        notes.push(`scheduled task ${id} could not be switched back on (${err.message}); switch it on in the Scheduler tab`)
      }
    }
    journal.pausedTasks = []
    save({ step: 'done', finishedAt: env.now().toISOString() })
  } catch (err) {
    let undone
    try {
      undone = await undoMove(journal, { env })
    } catch (undoErr) {
      undone = [`putting things back failed (${undoErr.message}); \`spawnloft data rollback\` tries again`]
    }
    const stuck = undone.some((n) => /failed|could not be put back/.test(n))
    if (!stuck) fs.rmSync(file, { force: true })
    const detail = [err.message, ...(err.problems ?? []).slice(0, 5).map((p) => `  ${p}`), ...undone].join('\n')
    throw Object.assign(new UserError(`the move did not complete and ${stuck ? 'could not be fully undone' : 'was undone'}:\n${detail}`), { problems: err.problems, cause: err })
  }
  return {
    plan,
    executed: true,
    result: { from: plan.from, to: plan.to, mode: plan.mode, parked: journal.parked, privateAside: journal.privateAside, notes, seconds: Math.round((env.now() - started) / 100) / 10 },
  }
}

// only for interrupted moves; a finished one has already been written to
export async function rollbackMove(root, { env = null } = {}) {
  const file = journalPath(root)
  const journal = readJson(file, null)
  if (!journal) throw new UserError(`no move is recorded for ${path.resolve(root)}, so there is nothing to put back`)
  if (journal.step === 'done') {
    throw new UserError('that move finished, and the data has been used since: putting the old folder back would lose what was written. Move the data again with `spawnloft data move`, or run `spawnloft data finish` to delete the old copy')
  }
  const notes = await undoMove(journal, { env })
  if (!notes.some((n) => /failed|could not be put back/.test(n))) fs.rmSync(file, { force: true })
  return { notes }
}

// deletes the parked original; the point of no return, hence its own command
export async function finishMove(root) {
  const file = journalPath(root)
  const journal = readJson(file, null)
  if (!journal) throw new UserError(`no move is recorded for ${path.resolve(root)}`)
  if (journal.step !== 'done') throw new UserError(`the move stopped at "${journal.step}"; \`spawnloft data rollback\` puts it back`)
  let removed = 0
  if (journal.parked && fs.existsSync(journal.parked)) {
    if (describeLink(journal.parked).isLink) throw new UserError(`${journal.parked} is a link, not the parked copy, so it was not removed`)
    removed = (await treeStats(journal.parked)).bytes
    await removeTree(journal.parked)
  }
  fs.rmSync(file, { force: true })
  return { parked: journal.parked, removedBytes: removed }
}

export async function moveStatus(root) {
  const from = path.resolve(root)
  const here = describeLink(from)
  const journal = readJson(journalPath(from), null)
  const leftovers = []
  const base = path.basename(from)
  try {
    for (const name of fs.readdirSync(path.dirname(from))) {
      if (name.startsWith(`${base}.moved-`)) leftovers.push(path.join(path.dirname(from), name))
    }
  } catch { /* parent not listable: report no leftovers */ }
  const sizes = []
  for (const p of leftovers) {
    try {
      sizes.push({ path: p, bytes: (await treeStats(p)).bytes })
    } catch {
      sizes.push({ path: p, bytes: null })
    }
  }
  return { root: from, link: here, journal, leftovers: sizes }
}
