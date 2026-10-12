/**
 * Spigot and CraftBukkit, compiled here by SpigotMC's BuildTools.
 *
 * <p>SpigotMC publishes no server jars - it is not allowed to, so every Spigot server in the
 * world was built on somebody's machine from source. BuildTools is the tool that does it:
 * clone Bukkit, CraftBukkit and Spigot, decompile and patch the vanilla server, compile, and
 * leave a jar behind. mcctl runs it the way a person would, in a work folder under the jar
 * store, and moves the result into the store named like every other jar.
 *
 * <p>Two things make it unlike the other sources and are said wherever it is offered: it needs
 * a JDK (javac, not just java), and the first build for a version takes five to ten minutes and
 * about a gigabyte of clones and Maven cache. Later builds reuse the clones. BuildTools fetches
 * a portable git for itself on Windows when none is installed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { JARS_DIR } from './paths.mjs'
import { fail, UserError, humanBytes } from './util.mjs'
import { downloadFile } from './download.mjs'

const BUILDTOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar'
const VERSIONS_URL = 'https://hub.spigotmc.org/versions/'

/**
 * The versions BuildTools can build, out of the index page of hub.spigotmc.org/versions.
 *
 * <p>That page lists one JSON per revision: Minecraft versions (`1.21.4.json`, `26.2.json`)
 * beside plain Jenkins build numbers (`4647.json`) and `latest.json`. Only the ones shaped
 * like a Minecraft version are versions. Exported pure for its test.
 */
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

/** javac beside the java that will run the server, or on PATH. BuildTools compiles; a JRE cannot. */
function assertJdk(java) {
  const javac = /[\\/]/.test(java) ? path.join(path.dirname(java), process.platform === 'win32' ? 'javac.exe' : 'javac') : 'javac'
  const res = spawnSync(javac, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (res.error || res.status !== 0) {
    fail('BuildTools needs a JDK - javac was not found beside java. A JRE runs servers but cannot compile one; '
      + 'install a JDK (https://adoptium.net/temurin/releases/) and try again.')
  }
}

/**
 * Build one flavour for one Minecraft version into the jar store.
 *
 * <p>Progress is the tool's own output, a line at a time, because there is no percentage to
 * be had from a compile and its last line is the honest answer to "is it still going".
 */
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
  // Always refreshed: BuildTools is small and updates itself for every Minecraft release, and
  // an old copy fails on a new version with a message about nothing in particular.
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
