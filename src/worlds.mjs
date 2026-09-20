/**
 * Worlds: what an instance actually holds, imported, exported and switched.
 *
 * <p>Until now the world was a name in server.properties and a folder mcctl walked around.
 * This module makes it a first-class thing: list what exists (a downloaded map, an old
 * world, the current one), bring a new one in from a zip or a folder, hand one out as a
 * zip, and choose which one the server runs - which is what stock's enforce-access setup
 * has been quietly prepared for all along.
 *
 * <p>The safety shape mirrors the rest of the tool. Importing never overwrites anything -
 * a name that already exists is refused, so no snapshot is needed. Switching only writes
 * one line of server.properties. The two genuinely destructive moments - deleting a world,
 * exporting the live one out from under a running server - are refused or gated where they
 * are dangerous, in the core, not just greyed out in a page.
 */
import fs from 'node:fs'
import path from 'node:path'

import { BACKUPS_DIR } from './paths.mjs'
import { readProps, writeProps } from './props.mjs'
import { readState } from './control.mjs'
import { runTar, EXCLUDE_ARGS } from './backup.mjs'
import { tarHandlesZip } from './tar.mjs'
import { createZip, extractZip, isZip } from './zip.mjs'
import { fail, dirSizeAsync, humanBytes, stamp, validateName } from './util.mjs'

/** The dimension companions a Bukkit-family server keeps beside a world. */
const DIM_SUFFIXES = ['_nether', '_the_end']

function isWorldDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'level.dat')).isFile()
  } catch {
    return false
  }
}

/**
 * A world name must be a plain directory entry of this instance - no separators, no
 * traversal. Names arrive over HTTP, and the world list is the only authority on them.
 */
function safeWorldName(name) {
  const n = String(name)
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') fail(`"${name}" is not a world name`)
  return n
}

/** The world the server saves into, as server.properties names it. */
export function activeWorld(inst) {
  return readProps(path.join(inst.dir, 'server.properties')).get('level-name') || 'world'
}

/**
 * Every world this instance holds. The active one first, then alphabetical; dimension
 * companions are folded into their world's row rather than listed as worlds of their own.
 *
 * <p>Async for the sizes alone. A mature world is tens of thousands of region, entity and poi
 * files, and walking them synchronously held the whole panel - every request, and the console
 * stream - for the seconds it took whenever the Worlds tab opened.
 */
export async function listWorlds(inst) {
  let entries = []
  try {
    entries = fs.readdirSync(inst.dir, { withFileTypes: true })
  } catch {
    return { active: null, worlds: [] }
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const worldDirsHere = new Set(dirs.filter((d) => isWorldDir(path.join(inst.dir, d))))

  const active = activeWorld(inst)
  const rows = []
  for (const name of worldDirsHere) {
    // A companion belongs to its base world's row when the base is a world here too.
    const suffix = DIM_SUFFIXES.find((s) => name.endsWith(s))
    if (suffix && worldDirsHere.has(name.slice(0, -suffix.length))) continue

    const dims = DIM_SUFFIXES.filter((s) => worldDirsHere.has(`${name}${s}`))
    let size = 0
    for (const d of [name, ...dims.map((s) => `${name}${s}`)]) size += await dirSizeAsync(path.join(inst.dir, d))
    rows.push({
      name,
      active: name === active,
      dimensions: dims.map((s) => s.slice(1)),
      size,
      sizeHuman: humanBytes(size),
    })
  }
  rows.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name)))
  return { active, worlds: rows }
}

/**
 * Point the server at a different world. One line of server.properties, and the server
 * reads it at the next start - but only written while stopped, because a running server
 * saving into a world the registry no longer names is how two worlds get interleaved.
 */
export function activateWorld(inst, name) {
  safeWorldName(name)
  const { status } = readState(inst.name)
  if (status === 'running' || status === 'stopping') {
    fail(`"${inst.name}" is running - stop it before switching worlds`)
  }
  if (!isWorldDir(path.join(inst.dir, name))) {
    fail(`"${name}" is not a world in ${inst.dir} (no level.dat)`)
  }
  writeProps(path.join(inst.dir, 'server.properties'), { 'level-name': name })
  return { active: name }
}

/**
 * Find the world inside whatever somebody downloaded.
 *
 * <p>Map archives arrive in every shape: level.dat at the root, one wrapping folder, a
 * README beside a folder, or a folder of folders. The shallowest directory holding a
 * level.dat is the world; breadth-first, so a nested backup inside the map can never win
 * over the map itself. Exported pure-ish for its tests.
 */
export function findWorldRoot(dir, { maxDepth = 4 } = {}) {
  let layer = [dir]
  for (let depth = 0; depth <= maxDepth && layer.length; depth++) {
    const next = []
    for (const candidate of layer) {
      if (isWorldDir(candidate)) return candidate
      try {
        for (const e of fs.readdirSync(candidate, { withFileTypes: true })) {
          if (e.isDirectory()) next.push(path.join(candidate, e.name))
        }
      } catch {
        /* unreadable branches simply are not the world */
      }
    }
    layer = next
  }
  return null
}

function copyWorld(srcRoot, dest) {
  fs.cpSync(srcRoot, dest, { recursive: true })
  // A downloaded world often ships the lock of whatever server last ran it.
  fs.rmSync(path.join(dest, 'session.lock'), { force: true })
}

/**
 * Bring a world in from a zip (or tar.gz) or a folder, as a NEW world.
 *
 * <p>Never an overwrite: a taken name is refused, which is why this needs no snapshot and
 * is safe on a running server - the new folder is invisible until someone activates it.
 * If the source keeps Bukkit-style dimension folders beside the world, they come along
 * under the new name's own suffixes.
 */
export async function importWorld(inst, source, { name } = {}) {
  validateName(name ?? '')
  const dest = path.join(inst.dir, name)
  if (fs.existsSync(dest)) fail(`"${name}" already exists in ${inst.dir} - pick another name`)

  const src = path.resolve(String(source ?? ''))
  if (!fs.existsSync(src)) fail(`there is nothing at ${src}`)

  let root = null
  let tmp = null
  try {
    if (fs.statSync(src).isDirectory()) {
      root = findWorldRoot(src)
      if (!root) fail(`no level.dat found under ${src} - that folder does not hold a world`)
    } else {
      // Extracted inside the instance's own directory so the final move is a same-volume
      // rename, not a second copy of a multi-gigabyte world across drives.
      tmp = path.join(inst.dir, `.mcctl-import-${Date.now()}`)
      fs.mkdirSync(tmp, { recursive: true })
      // bsdtar reads zip and tar.gz alike, and refuses absolute paths and ".." members on
      // extraction - the zip-slip guard comes with the tool. GNU tar reads no zip at all, so
      // there the zip is read here, with the same guard written out by hand.
      if (!tarHandlesZip() && isZip(src)) await extractZip(src, tmp)
      else await runTar(['-xf', src], tmp)
      root = findWorldRoot(tmp)
      if (!root) fail(`no level.dat found inside ${path.basename(src)} - that archive does not hold a world`)
    }

    const moveOrCopy = (from, to) => {
      if (tmp) fs.renameSync(from, to)
      else copyWorld(from, to)
    }
    moveOrCopy(root, dest)
    fs.rmSync(path.join(dest, 'session.lock'), { force: true })

    // Bukkit-style companions sitting beside the world come along under the new name.
    const base = path.basename(root)
    const dims = []
    for (const suffix of DIM_SUFFIXES) {
      const companion = path.join(path.dirname(root), `${base}${suffix}`)
      if (fs.existsSync(companion) && isWorldDir(companion)) {
        moveOrCopy(companion, path.join(inst.dir, `${name}${suffix}`))
        fs.rmSync(path.join(inst.dir, `${name}${suffix}`, 'session.lock'), { force: true })
        dims.push(suffix.slice(1))
      }
    }

    let size = 0
    for (const d of [name, ...dims.map((d) => `${name}_${d}`)]) size += await dirSizeAsync(path.join(inst.dir, d))
    return { name, dimensions: dims, size, sizeHuman: humanBytes(size) }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Hand a world out as a zip - the format people actually share maps in, and one Windows
 * opens bare-handed. Exports land beside the instance's snapshots but in their own
 * folder, so the Backups history never mistakes one for a snapshot.
 *
 * <p>The ACTIVE world of a RUNNING server is refused: the server holds its files mid-write
 * and the result would be a torn copy wearing a healthy filename. Take a backup instead -
 * that path flushes the world first. Inactive worlds export any time.
 */
export async function exportWorld(inst, name) {
  safeWorldName(name)
  if (!isWorldDir(path.join(inst.dir, name))) {
    fail(`"${name}" is not a world in ${inst.dir}`)
  }
  const active = activeWorld(inst)
  const { status } = readState(inst.name)
  if (name === active && (status === 'running' || status === 'stopping')) {
    fail(`"${name}" is the world the running server is saving into - stop the server first, or take a backup instead`)
  }

  const outDir = path.join(BACKUPS_DIR, inst.name, 'exports')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${name}_${stamp()}.zip`)
  const members = [name, ...DIM_SUFFIXES.map((s) => `${name}${s}`)
    .filter((d) => isWorldDir(path.join(inst.dir, d)))]
  // -a lets bsdtar pick the format from the extension: .zip in, zip out. GNU tar takes the same
  // flags, exits 0, and writes a tar archive called .zip - so it is never asked.
  if (tarHandlesZip()) await runTar(['-a', '-cf', file, ...EXCLUDE_ARGS, ...members], inst.dir)
  else await createZip(file, inst.dir, members, { exclude: EXCLUDE_ARGS.filter((arg) => arg !== '--exclude') })
  const size = fs.statSync(file).size
  if (size === 0) {
    fs.rmSync(file, { force: true })
    fail(`the export of "${name}" came out empty and has been discarded`)
  }
  return { file, size, sizeHuman: humanBytes(size), members }
}

/**
 * Delete a world for good. The active one is refused outright - deactivate it first by
 * switching, which is itself gated on a stopped server - and the caller is expected to
 * have made the person confirm, because ONLY the active world ever appears in snapshots:
 * an inactive world deleted here has no way back unless it was exported.
 */
export function deleteWorld(inst, name) {
  safeWorldName(name)
  const { status } = readState(inst.name)
  if (status === 'running' || status === 'stopping') {
    fail(`"${inst.name}" is running - stop it before deleting worlds`)
  }
  const active = activeWorld(inst)
  if (name === active) {
    fail(`"${name}" is the active world - switch to another world first, or use rebuild to reset it`)
  }
  if (!isWorldDir(path.join(inst.dir, name))) {
    fail(`"${name}" is not a world in ${inst.dir}`)
  }
  const removed = [name]
  fs.rmSync(path.join(inst.dir, name), { recursive: true, force: true })
  for (const suffix of DIM_SUFFIXES) {
    const companion = path.join(inst.dir, `${name}${suffix}`)
    if (fs.existsSync(companion)) {
      fs.rmSync(companion, { recursive: true, force: true })
      removed.push(`${name}${suffix}`)
    }
  }
  return { removed }
}
