// Spigot and CraftBukkit, compiled locally with SpigotMC's BuildTools (SpigotMC publishes no jars).
// Needs a JDK, and the first build for a version takes five to ten minutes and about 1 GB.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { JARS_DIR } from './paths.mjs'
import { fail, UserError, humanBytes } from './util.mjs'
import { downloadFile } from './download.mjs'

const BUILDTOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar'
const VERSIONS_URL = 'https://hub.spigotmc.org/versions/'

// The index lists Minecraft versions (`1.21.4.json`) beside Jenkins build numbers (`4647.json`)
// and `latest.json`; only the Minecraft-shaped ones are versions.
export function parseVersionIndex(html) {
  const seen = new Set()
  for (const m of String(html).matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)) seen.add(m[1])
  const parts = (v) => v.split('.').map(Number)
  return [...seen].sort((a, b) => {
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < 3; i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0)
      if (d) return d
    }
    return 0
  })
}

export async function versions() {
  let res
  try {
    res = await fetch(VERSIONS_URL, { headers: { 'User-Agent': 'SpawnLoft (github.com/joogiebear/spawnloft)' }, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    fail(`could not reach hub.spigotmc.org: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) fail(`hub.spigotmc.org answered ${res.status}`)
  return parseVersionIndex(await res.text())
}

export function jarName(flavour, mc) {
  return `${flavour}-${mc}.jar`
}

// javac beside the java that will run the server, or on PATH. A JRE can't compile.
function assertJdk(java) {
  const javac = /[\\/]/.test(java) ? path.join(path.dirname(java), process.platform === 'win32' ? 'javac.exe' : 'javac') : 'javac'
  const res = spawnSync(javac, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (res.error || res.status !== 0) {
    fail('BuildTools needs a JDK - javac was not found beside java. A JRE runs servers but cannot compile one; '
      + 'install a JDK (https://adoptium.net/temurin/releases/) and try again.')
  }
}

// Progress is BuildTools' own output a line at a time; a compile has no percentage.
export async function build(mc, { flavour = 'spigot', java = 'java', force = false, onProgress = null } = {}) {
  if (flavour !== 'spigot' && flavour !== 'craftbukkit') fail(`BuildTools does not build "${flavour}"`)
  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = jarName(flavour, mc)
  const dest = path.join(JARS_DIR, name)
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ message: `Using the ${name} already built`, cached: true })
    return { name, path: dest, version: mc, flavour, cached: true }
  }
  assertJdk(java)

  const work = path.join(JARS_DIR, 'buildtools')
  const outDir = path.join(work, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  // Always re-download: an old BuildTools fails on a newer Minecraft version with a vague error.
  onProgress?.({ message: 'Downloading BuildTools from SpigotMC' })
  await downloadFile(BUILDTOOLS_URL, path.join(work, 'BuildTools.jar'), { minBytes: 100 * 1024, label: 'BuildTools.jar' })

  const args = ['-jar', 'BuildTools.jar', '--rev', mc, '--output-dir', outDir, '--final-name', name]
  if (flavour === 'craftbukkit') args.push('--compile', 'craftbukkit')
  onProgress?.({ message: `Building ${flavour} ${mc} - this takes several minutes the first time` })

  await new Promise((resolve, reject) => {
    const child = spawn(java, args, { cwd: work, windowsHide: true })
    let tail = ''
    let carry = ''
    const onChunk = (c) => {
      tail = (tail + c.toString()).slice(-4000)
      carry += c.toString()
      const lines = carry.split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const said = line.trim()
        if (said) onProgress?.({ message: said.slice(0, 160) })
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (err) => reject(new UserError(
      err.code === 'ENOENT' ? `could not run ${java} to build ${flavour}` : `BuildTools failed to start: ${err.message}`)))
    child.on('close', (code) => {
      const built = path.join(outDir, name)
      if (code === 0 && fs.existsSync(built)) {
        resolve()
      } else {
        reject(new UserError(`BuildTools exited ${code} without producing ${name}. Its last words:\n`
          + tail.trim().split(/\r?\n/).slice(-6).join('\n')))
      }
    })
  })

  fs.renameSync(path.join(outDir, name), dest)
  const size = fs.statSync(dest).size
  return { name, path: dest, version: mc, flavour, cached: false, size, sizeHuman: humanBytes(size) }
}
