// Lists, imports, exports, switches and deletes the worlds an instance holds. The destructive
// cases (deleting a world, exporting the live one) are refused here in the core, not just in the UI.
import fs from 'node:fs'
import path from 'node:path'

import { BACKUPS_DIR } from './paths.mjs'
import { readProps, writeProps } from './props.mjs'
import { readState, activeBlock, isActiveStatus } from './control.mjs'
import { runTar, tarMember, EXCLUDE_ARGS } from './backup.mjs'
import { tarHandlesZip } from './tar.mjs'
import { createZip, extractZip, isZip } from './zip.mjs'
import { fail, dirSizeAsync, humanBytes, stamp, validateName } from './util.mjs'

// dimension folders a Bukkit-family server keeps beside a world
const DIM_SUFFIXES = ['_nether', '_the_end']

function isWorldDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'level.dat')).isFile()
  } catch {
    return false
  }
}

// names arrive over HTTP, so reject separators and traversal
function safeWorldName(name) {
  const n = String(name)
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') fail(`"${name}" is not a world name`)
  return n
}

export function activeWorld(inst) {
  return readProps(path.join(inst.dir, 'server.properties')).get('level-name') || 'world'
}

// Active world first, then alphabetical; dimension folders are folded into their world's row.
// Async for the sizes: a mature world is tens of thousands of files and a sync walk blocks the panel.
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

// Only while stopped: a running server saving into a world server.properties no longer names
// can interleave two worlds.
export function activateWorld(inst, name) {
  safeWorldName(name)
  const why = activeBlock(inst.name, 'switching worlds')
  if (why) fail(why)
  if (!isWorldDir(path.join(inst.dir, name))) {
    fail(`"${name}" is not a world in ${inst.dir} (no level.dat)`)
  }
  writeProps(path.join(inst.dir, 'server.properties'), { 'level-name': name })
  return { active: name }
}

// Map archives come in many shapes (wrapping folder, README beside a folder, ...). The world is
// the shallowest directory with a level.dat; breadth-first so a nested backup can't win.
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
        /* unreadable branches can't be the world */
      }
    }
    layer = next
  }
  return null
}

function copyWorld(srcRoot, dest) {
  fs.cpSync(srcRoot, dest, { recursive: true })
  // downloaded worlds often ship the lock of the server that last ran them
  fs.rmSync(path.join(dest, 'session.lock'), { force: true })
}

// Imports from a zip, tar.gz or folder as a new world. A taken name is refused, so it never
// overwrites and is safe on a running server. Dimension folders beside the world come along.
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
      // inside the instance dir so the final move is a same-volume rename, not a second copy
      tmp = path.join(inst.dir, `.mcctl-import-${Date.now()}`)
      fs.mkdirSync(tmp, { recursive: true })
      // bsdtar reads zip and tar.gz and refuses absolute and ".." members (zip-slip guard).
      // GNU tar can't read zips, so extractZip does it with its own guard.
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

// Exports as a zip into its own `exports` folder so Backups history doesn't list it. The active
// world of a running server is refused (torn copy); a backup flushes first instead.
export async function exportWorld(inst, name) {
  safeWorldName(name)
  if (!isWorldDir(path.join(inst.dir, name))) {
    fail(`"${name}" is not a world in ${inst.dir}`)
  }
  const active = activeWorld(inst)
  const { status } = readState(inst.name)
  if (name === active && isActiveStatus(status)) {
    fail(`"${name}" is the world the running server is saving into - stop the server first, or take a backup instead`)
  }

  const outDir = path.join(BACKUPS_DIR, inst.name, 'exports')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${name}_${stamp()}.zip`)
  const members = [name, ...DIM_SUFFIXES.map((s) => `${name}${s}`)
    .filter((d) => isWorldDir(path.join(inst.dir, d)))]
  // -a makes bsdtar pick the format from the extension. GNU tar accepts the flags but writes a
  // tar archive named .zip, so it is never used here.
  if (tarHandlesZip()) await runTar(['-a', '-cf', file, ...EXCLUDE_ARGS, ...members.map(tarMember)], inst.dir)
  else await createZip(file, inst.dir, members, { exclude: EXCLUDE_ARGS.filter((arg) => arg !== '--exclude') })
  const size = fs.statSync(file).size
  if (size === 0) {
    fs.rmSync(file, { force: true })
    fail(`the export of "${name}" came out empty and has been discarded`)
  }
  return { file, size, sizeHuman: humanBytes(size), members }
}

// Callers must confirm with the person first: only the active world appears in snapshots, so an
// inactive world deleted here is gone unless it was exported.
export function deleteWorld(inst, name) {
  safeWorldName(name)
  const why = activeBlock(inst.name, 'deleting worlds')
  if (why) fail(why)
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
