import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { listProfiles, status } from './client.mjs'
import { profileDir, versionJson, versionJar } from './client-paths.mjs'
import { harnessFor, HARNESS_FILE, readHarnessFile, removeHarnessFile } from './client-harness.mjs'
import { fabricApiJars } from './client-fabric.mjs'
import { requiredMajor, DOWNLOAD_URL } from './java.mjs'
import { readJson } from './util.mjs'

// `javas` is what the doctor's Java probe found: [{ path, major, version }]. Nothing here probes
// Java or touches the network; `repair` only removes a stale harness file.
export function checkClientProfiles({ repair = false, javas = [] } = {}) {
  const problems = []
  const notes = []

  for (const p of listProfiles()) {
    const prefix = `client ${p.name}: `

    // A pinned Java is used as given, so only its presence is checked; the probe's list decides otherwise.
    const needs = requiredMajor(p.mc)
    if (p.java && p.java !== 'java') {
      if (!fs.existsSync(p.java)) {
        problems.push(`${prefix}pinned Java ${p.java} does not exist; spawnloft client set ${p.name} java=<path>, or java= to let SpawnLoft pick`)
      }
    } else if (needs !== null && !javas.some((j) => j.major >= needs)) {
      problems.push(`${prefix}Minecraft ${p.mc} needs Java ${needs} or newer and none was found. ${DOWNLOAD_URL}`)
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

  return { problems, notes }
}
