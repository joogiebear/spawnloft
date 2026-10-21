import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DATA_ROOT, LAYOUT, ROOT } from './paths.mjs'
import { describeServersElsewhere, inspect as inspectSettings } from './settings.mjs'
import { findPrivateCopies, describePrivateCopies } from './private-copy.mjs'
import { listInstances, serverJarPath } from './registry.mjs'
import { readState, clearState } from './control.mjs'
import { rconExposure } from './exposure.mjs'
import * as java from './java.mjs'
import { checkClientProfiles } from './doctor-client.mjs'
import { humanBytes, dirSize, isPortFree } from './util.mjs'

// Read-only unless `repair` is set, which only clears stale state files. Automation (--json, the
// MCP server) never repairs.
export async function runDoctor({ repair = false } = {}) {
  const problems = []
  const notes = []

  // same probe as the panel and first-run wizard, so they agree on what a usable Java is
  const javaCheck = await java.health()
  if (!javaCheck.ok) problems.push(`java: ${javaCheck.message} ${java.DOWNLOAD_URL}`)
  else notes.push(`java: ${javaCheck.version}${javaCheck.onPath ? '' : ` at ${javaCheck.path} (not on PATH)`}`)
  for (const other of javaCheck.others ?? []) {
    if (other.path !== javaCheck.path) notes.push(`java (also): ${other.version} at ${other.path}`)
  }

  const tarCheck = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (tarCheck.error) problems.push('tar is not on PATH (needed for snapshots)')
  else notes.push(`tar: ${(tarCheck.stdout || '').split('\n')[0].trim()}`)

  notes.push(`node: ${process.version}`)
  notes.push(`root: ${ROOT}`)
  notes.push(`data root: ${DATA_ROOT}`)
  // an unreadable settings file falls back to defaults (see settings.load)
  const stored = inspectSettings()
  if (!stored.ok) {
    problems.push(`settings file ${stored.file} could not be read (${stored.error}), so SpawnLoft is using the defaults and the data root in use may not be the data folder you chose. Fix the file or delete it.`)
  }
  if (!listInstances().length) {
    for (const line of describeServersElsewhere(DATA_ROOT)) problems.push(line)
  }

  // always checked: a redirected process can't tell it is reading a copy (see private-copy.mjs)
  const privateCopies = await findPrivateCopies()
  const described = describePrivateCopies(privateCopies, { backupsDir: LAYOUT.backupsDir })
  problems.push(...described.problems)
  notes.push(...described.notes)

  const seenPorts = new Map()
  for (const inst of listInstances()) {
    if (!fs.existsSync(inst.dir)) {
      problems.push(`${inst.name}: directory missing (${inst.dir})`)
      continue
    }
    if (!fs.existsSync(serverJarPath(inst))) {
      problems.push(`${inst.name}: jar missing (${serverJarPath(inst)})`)
    }
    const eula = path.join(inst.dir, 'eula.txt')
    const eulaText = fs.existsSync(eula) ? fs.readFileSync(eula, 'utf8') : ''
    if (!/^\s*eula\s*=\s*true\s*$/im.test(eulaText)) {
      problems.push(`${inst.name}: EULA not accepted (${eula})`)
    }
    for (const [label, port] of [['port', inst.port], ['rcon', inst.rcon?.port]]) {
      if (!port) continue
      if (seenPorts.has(port)) problems.push(`${inst.name}: ${label} ${port} collides with ${seenPorts.get(port)}`)
      else seenPorts.set(port, `${inst.name} ${label}`)
    }
    const { status } = readState(inst.name)
    if (status === 'orphaned') problems.push(`${inst.name}: orphaned java process - run "mcctl kill ${inst.name}"`)
    // checked even when stopped: the port opens as soon as it starts
    const exposed = rconExposure(inst)
    if (exposed) problems.push(`${inst.name}: ${exposed.title.toLowerCase()}. ${exposed.advice}`)
    if (status === 'stale') {
      if (!repair) problems.push(`${inst.name}: stale state file; run doctor without --json to clear it`)
      else {
        clearState(inst.name)
        notes.push(`${inst.name}: cleared stale state file`)
      }
    }
    if (status === 'stopped') {
      const free = await isPortFree(inst.port)
      if (!free) problems.push(`${inst.name}: port ${inst.port} is in use by something else while the instance is stopped`)
    }
    notes.push(`${inst.name}: ${humanBytes(dirSize(inst.dir))} on disk at ${inst.dir}`)
  }
  const client = checkClientProfiles({ repair, javas: javaCheck.others ?? [] })
  problems.push(...client.problems)
  notes.push(...client.notes)

  // `privateCopies` is for the MCP tool; the CLI's JSON names its fields so its shape is unchanged
  return { healthy: problems.length === 0, notes, problems, privateCopies }
}
