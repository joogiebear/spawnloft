import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_ROOT, LAYOUT } from './paths.mjs'
import { settingsFile as defaultSettingsFile } from './settings.mjs'
import { humanBytes } from './util.mjs'

/**
 * A second copy of SpawnLoft's data that Windows keeps for a program installed as a package.
 *
 * <p>A program installed that way - an MSIX, which is how some desktop apps ship - is given a
 * private copy of whatever it writes under AppData: the write lands in
 * `Packages\<family>\LocalCache\Local\...`, beside the original, and from then on the program reads
 * the copy, not the file in the usual place, even after the original changes. The programs it starts
 * inherit that. So an AI client installed like that, which starts `spawnloft mcp`, can write the
 * registry once and then keep seeing the servers as they were that day: a server made later in the
 * panel is missing, a setting changed there reads as it used to, and the backups and the activity it
 * records pile up in a folder the panel never opens. Nothing is wrong with any file; two programs
 * are reading two files that share a path.
 *
 * <p>Found by looking where Windows puts the copy, which can be done from any process: the private
 * folder is an ordinary folder at an ordinary path. What cannot be known from a program that is itself
 * redirected is which side it is on - what it reads as the registry IS the copy - so a copy that
 * matches is reported as a copy, and only one that differs, or holds things the real folder lacks, as a
 * problem. A comparison made from a program that is not redirected (a terminal, the app) is the one
 * that can tell, and that is what the advice sends a redirected one to.
 *
 * <p>Read-only, and meant never to throw: this runs inside doctor and at the start of the MCP server,
 * and a check that fails must not take them with it.
 */

/** How many files of a server's folder are counted before the count stops: enough to say "some". */
const FILE_LIMIT = 50

export async function findPrivateCopies({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  roamingAppData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  dataRoot = DATA_ROOT,
  backupsDir = LAYOUT.backupsDir,
  settingsFile = defaultSettingsFile(),
} = {}) {
  if (platform !== 'win32') return []
  try {
    return await look({ localAppData, roamingAppData, dataRoot, backupsDir, settingsFile })
  } catch {
    // Whatever went wrong is not worth stopping doctor or the MCP server for.
    return []
  }
}

async function look({ localAppData, roamingAppData, dataRoot, backupsDir, settingsFile }) {
  const within = (base, target) => {
    if (!base) return null
    const rel = path.relative(base, target)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }
  // Only what lives under AppData is redirected. Each of the three is asked separately: a data root on
  // another drive is not redirected while the settings that chose it, under Roaming, still can be.
  const dataRel = within(localAppData, dataRoot)
  const backupsRel = within(localAppData, backupsDir)
  const settingsRel = within(roamingAppData, settingsFile)
  if (!dataRel && !backupsRel && !settingsRel) return []

  let families
  try {
    families = (await fs.promises.readdir(path.join(localAppData, 'Packages'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }

  const found = []
  for (const family of families) {
    const store = path.join(localAppData, 'Packages', family, 'LocalCache')
    const dir = dataRel ? path.join(store, 'Local', dataRel) : null
    const hasDir = dir !== null && (await isDirectory(dir))
    const backups = backupsRel && (await isDirectory(path.join(store, 'Local', backupsRel)))
      ? await backupsOnlyHere(backupsDir, path.join(store, 'Local', backupsRel))
      : { dir: null, archives: 0, bytes: 0 }
    const settingsCopy = settingsRel ? path.join(store, 'Roaming', settingsRel) : null
    const settings = settingsCopy ? await compareFiles(settingsFile, settingsCopy) : 'absent'
    if (!hasDir && !backups.dir && settings === 'absent') continue
    found.push({
      package: family,
      dir: hasDir ? dir : null,
      registry: hasDir ? await compareRegistries(path.join(dataRoot, 'instances.json'), path.join(dir, 'instances.json')) : absentRegistry(null),
      backups,
      activity: { entries: hasDir ? await countLines(path.join(dir, 'activity.jsonl')) : 0 },
      instances: { files: hasDir ? await countFiles(path.join(dir, 'instances'), FILE_LIMIT) : 0 },
      settingsFile: settingsCopy,
      settings,
    })
  }
  return found
}

async function isDirectory(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function countLines(file) {
  const text = await readText(file)
  return text === null ? 0 : text.split(/\r?\n/).filter((line) => line.trim()).length
}

/** Files under a folder, counted until `limit`: a server's folder can hold a world, and "some" is the answer. */
async function countFiles(dir, limit) {
  let count = 0
  const pending = [dir]
  while (pending.length && count < limit) {
    const current = pending.pop()
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name))
      else if (++count >= limit) break
    }
  }
  return count
}

/** The same values with their keys in one order, so two writers' habits do not look like a disagreement. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]))
  return value
}

/** JSON as its values, whatever the key order or spacing; anything else as the text it is. */
function canonical(text) {
  if (text === null) return null
  try {
    return JSON.stringify(sorted(JSON.parse(text)))
  } catch {
    return text
  }
}

/** 'absent' when the copy has no such file, 'same' when it holds the same values, 'differs' otherwise. */
async function compareFiles(real, copy) {
  const there = await readText(copy)
  if (there === null) return 'absent'
  return canonical(there) === canonical(await readText(real)) ? 'same' : 'differs'
}

const absentRegistry = (file) => ({ state: 'absent', file, onlyInCopy: [], onlyInRegistry: [], changed: [], realMissing: false })

/** The servers in a registry document, as an object, whatever the document turns out to be. */
const serversOf = (doc) => (doc && typeof doc === 'object' && doc.instances && typeof doc.instances === 'object' && !Array.isArray(doc.instances) ? doc.instances : {})

/**
 * The registry read here against the copy's: which servers are in one and not the other, and which are in
 * both with settings that differ - the last being how a server's memory read 8G in one place and 4G in the
 * other. "Registry" is the one this process reads at the usual path, "copy" the private one.
 */
async function compareRegistries(real, copy) {
  const there = await readText(copy)
  if (there === null) return absentRegistry(copy)
  const here = await readText(real)
  const base = { file: copy, onlyInCopy: [], onlyInRegistry: [], changed: [], realMissing: here === null }
  if (canonical(there) === canonical(here)) return { ...base, state: 'same' }
  let copyDoc
  let realDoc = null
  try {
    copyDoc = JSON.parse(there)
  } catch {
    return { ...base, state: 'unreadable' }
  }
  try {
    if (here !== null) realDoc = JSON.parse(here)
  } catch {
    // The registry read here is the broken one, so the copy must not be blamed for it.
    return { ...base, state: 'registry-unreadable' }
  }
  const inCopy = serversOf(copyDoc)
  const inRegistry = serversOf(realDoc)
  const names = (o) => Object.keys(o).sort()
  return {
    ...base,
    state: 'differs',
    onlyInCopy: names(inCopy).filter((n) => !Object.hasOwn(inRegistry, n)),
    onlyInRegistry: names(inRegistry).filter((n) => !Object.hasOwn(inCopy, n)),
    changed: names(inCopy).filter((n) => Object.hasOwn(inRegistry, n) && JSON.stringify(sorted(inCopy[n])) !== JSON.stringify(sorted(inRegistry[n]))),
  }
}

/**
 * The archives in the copy's backups folder that the real one does not have, by instance and name.
 * Only a file that is plainly not there counts: one that cannot be checked is left out, not counted.
 */
async function backupsOnlyHere(realDir, copyDir) {
  let archives = 0
  let bytes = 0
  let instances = []
  try {
    instances = (await fs.promises.readdir(copyDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { dir: copyDir, archives, bytes }
  }
  for (const inst of instances) {
    let files = []
    try {
      files = (await fs.promises.readdir(path.join(copyDir, inst))).filter((f) => f.endsWith('.tar.gz'))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        await fs.promises.access(path.join(realDir, inst, file))
      } catch (err) {
        if (err.code !== 'ENOENT') continue
        try {
          bytes += (await fs.promises.stat(path.join(copyDir, inst, file))).size
          archives++
        } catch { /* gone since it was listed */ }
      }
    }
  }
  return { dir: copyDir, archives, bytes }
}

const list = (names) => names.map((n) => `"${n}"`).join(', ')
const plural = (n, one, many) => (n === 1 ? one : many)

/**
 * What to tell a person, as doctor's two kinds of line: problems for what is out of step, a note for a
 * copy that matches today.
 *
 * <p>The way out offered is the one that works without moving anything: rename the copy's file, so the
 * programs that were reading it read the real one. It is not a cure - the next time one of them writes,
 * Windows makes a new copy - and the text says so. And it is not offered blind: a server that is only in
 * the copy goes with it. The cure is `spawnloft data move <folder>` (data-move.mjs), which moves the data
 * out of AppData and leaves a link, so the problem text points there. `config set-root` is not it: that
 * leaves existing servers where they are and starts a new, empty registry.
 */
export function describePrivateCopies(copies, { backupsDir } = {}) {
  const problems = []
  const notes = []
  for (const copy of copies) {
    const mine = problems.length
    const { registry } = copy
    if (registry.state === 'differs') {
      const sides = [
        registry.onlyInRegistry.length && `only in the registry read here: ${list(registry.onlyInRegistry)}`,
        registry.onlyInCopy.length && `only in the copy: ${list(registry.onlyInCopy)}`,
        registry.changed.length && `set up differently in the two: ${list(registry.changed)}`,
      ].filter(Boolean).join('; ') || 'they differ outside the list of servers'
      const loses = registry.onlyInCopy.length || registry.realMissing
        ? `Renaming the copy's registry would drop ${registry.realMissing ? 'every server in it' : list(registry.onlyInCopy)}, which the registry read here does not have: copy ${registry.realMissing ? 'its entries' : 'their entries'} across first. `
        : ''
      problems.push(
        `${copy.package} has its own copy of SpawnLoft's registry, ${registry.file}, and it disagrees with the one read here (${sides}). ` +
          `Windows gives a program installed as a package a private copy of what it writes under AppData, and every program that one starts - "spawnloft mcp" among them - reads that copy from then on, ` +
          `so what they report about servers and their settings can differ from the SpawnLoft app's. ` +
          `${loses}To stop them reading different registries, rename ${registry.file}: those programs then read the real one. It can come back the next time one of them writes to it; to stop it for good, \`spawnloft data move <folder>\` moves the data out of AppData and leaves a link, so nothing else needs changing.`,
      )
    } else if (registry.state === 'unreadable') {
      problems.push(`${copy.package} has its own copy of SpawnLoft's registry, ${registry.file}, and it could not be read, so what the programs it starts report about servers cannot be trusted. Rename it so they read the real registry.`)
    } else if (registry.state === 'registry-unreadable') {
      problems.push(`${copy.package} has its own copy of SpawnLoft's registry, ${registry.file}, which could not be compared with the one read here because that one could not be read. Mend that one first.`)
    }
    if (copy.instances.files > 0) {
      const n = copy.instances.files
      problems.push(
        `${n}${n >= FILE_LIMIT ? ' or more' : ''} ${plural(n, 'file', 'files')} from servers' folders ${plural(n, 'is', 'are')} in ${copy.package}'s copy, under ${path.join(copy.dir, 'instances')}, ` +
          `so the programs it starts can also read and write different server files from the app's - plugin settings, for one. Renaming the registry does not undo that.`,
      )
    }
    if (copy.backups.archives > 0) {
      const n = copy.backups.archives
      problems.push(
        `${n} ${plural(n, 'backup', 'backups')} (${humanBytes(copy.backups.bytes)}) ${plural(n, 'is', 'are')} only in ${copy.package}'s copy, ${copy.backups.dir}, ` +
          `so the panel's Backups tab does not list ${plural(n, 'it', 'them')}, and ${plural(n, 'it', 'they')} may go if that program is reset or uninstalled. ` +
          `To keep ${plural(n, 'it', 'them')}, copy the .tar.gz and .json files of each server's folder there into the same folder under ${backupsDir ?? 'the backups folder'}.`,
      )
    }
    if (copy.settings === 'differs') {
      problems.push(
        `${copy.package}'s copy of SpawnLoft's settings, ${copy.settingsFile}, differs from the ones read here, so a program it starts may use a different data folder from the app's. ` +
          `Rename ${copy.settingsFile} if the ones read here are right: those programs then read them.`,
      )
    }
    if (problems.length === mine) {
      const where = copy.dir ?? copy.backups.dir ?? copy.settingsFile
      const about = copy.registry.state === 'same'
        ? "; its registry matches the one read here today, but it does not follow changes the app makes later"
        : '; it holds no copy of the registry now, and Windows makes one the next time a program it started writes the registry'
      const extra = copy.activity.entries ? `; its own activity log, which the panel does not read, holds ${copy.activity.entries} ${plural(copy.activity.entries, 'entry', 'entries')}` : ''
      notes.push(`${copy.package} keeps a copy of SpawnLoft's data at ${where}${about}${extra}`)
    }
  }
  return { problems, notes }
}

/**
 * Whether a copy is worth telling an AI client about: it holds a registry, or something the real
 * folder lacks. A copy with only an activity log, or one whose registry has been renamed away, is not -
 * which is also how the notice goes quiet once the way out in the problem text has been followed.
 */
const concerns = (copy) => copy.registry.state !== 'absent' || copy.backups.archives > 0 || copy.instances.files > 0 || copy.settings === 'differs'

/**
 * One paragraph for the instructions the MCP server hands its client when it starts, and for what its
 * doctor tool says.
 *
 * <p>The client cannot see this for itself - to it the registry just reads as it does - and it is the
 * one most likely to act on a server list that is out of date, so it is told at the start. It is not
 * told which side is right, because a process cannot know that about itself: if it is the one being
 * redirected, its own doctor reads the same copy and finds nothing to compare. So it is sent to a
 * program that is not redirected.
 */
export function mcpNotice(copies) {
  const relevant = copies.filter(concerns)
  if (!relevant.length) return ''
  return `NOTE: Windows keeps a second copy of SpawnLoft's data for programs installed as a package (${relevant.map((c) => c.dir ?? c.backups.dir ?? c.settingsFile).join('; ')}), and this process may be reading it. ` +
    `What the tools report - which servers exist, their settings, which backups there are - can be out of date compared with the SpawnLoft app, and this process cannot tell. ` +
    `Ask the person to run "spawnloft doctor" from a terminal outside this assistant, and say so if a server they mention is missing.`
}
