import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { listProfiles, status } from './client.mjs'
import { profileDir, versionJson, versionJar } from './client-paths.mjs'
import { harnessFor, publishedHarnessIds, HARNESS_FILE, readHarnessFile, removeHarnessFile } from './client-harness.mjs'
import { harnessIndexStatus } from './client-harness-index.mjs'
import { fabricApiJars } from './client-fabric.mjs'
import { requiredMajor, DOWNLOAD_URL } from './java.mjs'
import { readJson } from './util.mjs'
import { installedRuntimes, runtimeDamage, platformKey } from './client-java.mjs'
import { currentOs } from './client-meta.mjs'

// `javas` is what the doctor's Java probe found: [{ path, major, version }]. Nothing here probes
// Java or touches the network; `repair` only removes a stale harness file.
export function checkClientProfiles({ repair = false, javas = [] } = {}) {
  const problems = []
  const notes = []

  for (const p of listProfiles()) {
    const prefix = `client ${p.name}: `

    // A pinned Java is used as given, so only its presence is checked; the probe's list decides otherwise.
    const needs = requiredMajor(p.mc)
    if (p.java === 'mojang') {
      // Mojang's runtime, downloaded at launch
    } else if (p.java && p.java !== 'java') {
      if (!fs.existsSync(p.java)) {
        problems.push(`${prefix}pinned Java ${p.java} does not exist; spawnloft client set ${p.name} java=<path>, or java= to let SpawnLoft pick`)
      }
    } else if (needs !== null && !javas.some((j) => j.major >= needs) && !platformKey(currentOs().name, currentOs().arch)) {
      problems.push(`${prefix}Minecraft ${p.mc} needs Java ${needs} or newer and none was found. ${DOWNLOAD_URL}`)
    } else if (needs !== null && !javas.some((j) => j.major >= needs)) {
      // the launch downloads Mojang's own runtime when nothing installed fits
      notes.push(`${prefix}Minecraft ${p.mc} needs Java ${needs} or newer and none is installed; the first launch downloads Mojang's (or install one: ${DOWNLOAD_URL})`)
    }

    const installed = fs.existsSync(versionJson(p.mc)) && fs.existsSync(versionJar(p.mc))

    if (p.harness) {
      const row = harnessFor(p.mc)
      if (!row) {
        problems.push(`${prefix}no harness mod is published for Minecraft ${p.mc}; spawnloft client set ${p.name} harness=false`)
      } else {
        const modsDir = path.join(profileDir(p.name), 'mods')
        const harnessFile = `spawnloft-harness-${row.version}+${row.minecraft}.jar`
        const harnessPresent = fs.existsSync(path.join(modsDir, harnessFile))
        if (harnessPresent) {
          const buf = fs.readFileSync(path.join(modsDir, harnessFile))
          const hash = crypto.createHash('sha256').update(buf).digest('hex')
          if (hash !== row.sha256) {
            problems.push(`${prefix}mods/${harnessFile} is not the published harness mod ${row.version}; delete it and launch again`)
          }
          // launch uses a Fabric API someone put in mods/ by hand, so the doctor counts one too
          const modsJson = readJson(path.join(modsDir, '.spawnloft-mods.json'), null)
          const hasFabricApi = (modsJson && modsJson.managed && Object.entries(modsJson.managed).some(
            ([filename, entry]) => entry.project === 'fabric-api' && fs.existsSync(path.join(modsDir, filename)),
          )) || fabricApiJars(modsDir).length > 0
          if (!hasFabricApi) {
            problems.push(`${prefix}the harness mod is installed but Fabric API is not; launch again to install it`)
          }
        }
      }
    }

    const st = status(p.name)
    const info = readHarnessFile(p.name)
    if (info !== null && (!st.running || info.pid !== st.pid)) {
      if (!repair) {
        problems.push(`${prefix}stale ${HARNESS_FILE} from an earlier run; run doctor without --json to clear it`)
      } else {
        removeHarnessFile(p.name)
        notes.push(`${prefix}cleared stale ${HARNESS_FILE}`)
      }
    }

    const installStr = installed ? 'installed' : `not installed yet: spawnloft client install ${p.name}`
    const runStr = st.running ? 'running' : 'stopped'
    notes.push(`${prefix}Minecraft ${p.mc} ${p.loader}, ${installStr}, ${runStr}`)
  }

  for (const r of installedRuntimes()) {
    let damaged
    try {
      damaged = runtimeDamage(r.component, r.platform)
    } catch (err) {
      damaged = [err.message]
    }
    if (damaged.length) {
      problems.push(`client Java runtime ${r.component} (${r.platform}): ${damaged.length} file(s) missing or the wrong size, such as ${damaged[0]}; the next launch that needs it downloads them again`)
    } else {
      notes.push(`client Java runtime ${r.component} ${r.version} (${r.platform}): whole`)
    }
  }

  // the signed harness list, once per machine, when a profile uses the harness
  if (listProfiles().some((p) => p.harness)) {
    const line = harnessListLine(harnessIndexStatus())
    if (line.problem) problems.push(line.text)
    else notes.push(line.text)
  }

  return { problems, notes }
}

const REJECTED = ['harness-index-signature', 'harness-index-format', 'harness-index-serial']

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

// One line on where the harness builds come from: the signed list (its serial, age and key) or
// the built-in rows, and why the last check did not take a list. A list that was fetched and
// refused is a problem: someone published something wrong.
export function harnessListLine(st) {
  const ids = publishedHarnessIds().join(', ')
  const head = st.source === 'index'
    ? `harness list: serial ${st.serial}${st.generated ? ` from ${st.generated.slice(0, 10)}` : ''}${st.key && st.key !== 'primary' ? `, signed with the ${st.key} key` : ''}${st.fetchedAt ? `, fetched ${ago(st.fetchedAt)}` : ''} (${ids})`
    : `harness list: built-in only (${ids})`
  if (!st.outcome || st.outcome === 'accepted' || st.outcome === 'unchanged') {
    return { problem: false, text: st.lastCheck ? head : `${head}; the published list has not been checked yet` }
  }
  const when = st.lastCheck ? ` ${ago(st.lastCheck)}` : ''
  if (REJECTED.includes(st.outcome)) return { problem: true, text: `${head}; the published list was rejected${when}: ${st.reason}` }
  return { problem: false, text: `${head}; the published list was last tried${when} and could not be read (${st.reason})` }
}
