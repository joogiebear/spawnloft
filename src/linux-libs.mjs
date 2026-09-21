import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fail } from './util.mjs'

/**
 * The shared libraries a downloaded Linux engine expects the system to have.
 *
 * <p>Oracle's MySQL tarball is built against libaio, libnuma and ncurses, and says nothing about it:
 * on a machine without them mysqld exits with "error while loading shared libraries", which to
 * someone who clicked Add database is no explanation at all. A stock Ubuntu or Debian server has
 * none of the three. Windows and macOS archives carry what they need, so none of this runs there.
 *
 * <p>Three answers are tried, cheapest first, and the engine is only installed if one works:
 * <ol>
 *   <li>The system already has them.</li>
 *   <li>The system has them under the name Debian's 64-bit time_t transition gave them. Ubuntu
 *       24.04 ships libaio as libaio.so.1t64, so mysqld cannot find it EVEN AFTER the package it
 *       asked for is installed. A link under the old name, in a folder of the engine's own, is the
 *       whole fix.</li>
 *   <li>The packages are fetched with `apt-get download` - which needs no root, and verifies what
 *       it fetches against the distribution's signed index like any apt install - and unpacked
 *       beside the engine. Nothing is installed on the system and nothing outside the engine's
 *       folder is written.</li>
 * </ol>
 * Failing all three, the refusal names the command that fixes it for this distribution.
 */

export const LIBS_FOLDER = 'spawnloft-libs'

/** The engine's private library folder, given any binary inside its bin/. */
export function libsDirFor(binaryPath) {
  return path.join(path.dirname(path.dirname(binaryPath)), LIBS_FOLDER)
}

/** The environment a tool from this engine should run with: its private libraries first. */
export function libraryEnv(binaryPath, env = process.env, platform = process.platform) {
  if (platform !== 'linux') return env
  const dir = libsDirFor(binaryPath)
  if (!fs.existsSync(dir)) return env
  return { ...env, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir }
}

/** The names ldd could not resolve, from its output. */
export function parseLdd(text) {
  const missing = new Set()
  for (const line of String(text).split('\n')) {
    const hit = /^\s*(\S+)\s+=>\s+not found/.exec(line)
    if (hit) missing.add(hit[1])
  }
  return [...missing]
}

/** Null when there is no ldd to ask, which is an unknown rather than a clean bill of health. */
export function missingLibraries(binaries, env = process.env) {
  const missing = new Set()
  for (const file of binaries) {
    const res = spawnSync('ldd', [file], { encoding: 'utf8', timeout: 15000, env: { ...env, LC_ALL: 'C' } })
    if (res.error) return null
    for (const name of parseLdd(res.stdout)) missing.add(name)
  }
  return [...missing]
}

/** `ldconfig -p` lines look like "\tlibaio.so.1t64 (libc6,x86-64) => /lib/x86_64-linux-gnu/libaio.so.1t64". */
export function parseLdconfig(text) {
  const found = new Map()
  for (const line of String(text).split('\n')) {
    const hit = /^\s*(\S+)\s+\([^)]*\)\s+=>\s+(\S+)/.exec(line)
    if (hit && !found.has(hit[1])) found.set(hit[1], hit[2])
  }
  return found
}

/** Which package carries a library, by distribution family. First name that exists wins. */
export const PACKAGES = Object.freeze({
  'libaio.so.1': { apt: ['libaio1t64', 'libaio1'], dnf: 'libaio', pacman: 'libaio', zypper: 'libaio1' },
  'libnuma.so.1': { apt: ['libnuma1'], dnf: 'numactl-libs', pacman: 'numactl', zypper: 'libnuma1' },
  'libncurses.so.6': { apt: ['libncurses6'], dnf: 'ncurses-libs', pacman: 'ncurses', zypper: 'libncurses6' },
  'libtinfo.so.6': { apt: ['libtinfo6'], dnf: 'ncurses-libs', pacman: 'ncurses', zypper: 'libtinfo6' },
})

/** apt, dnf, pacman or zypper, from /etc/os-release; null for a distribution this does not know. */
export function packageFamily(osRelease) {
  const ids = [...String(osRelease).matchAll(/^(?:ID|ID_LIKE)=(.*)$/gm)].flatMap(m => m[1].replaceAll('"', '').split(/\s+/))
  if (ids.some(id => ['debian', 'ubuntu'].includes(id))) return 'apt'
  if (ids.some(id => ['fedora', 'rhel', 'centos'].includes(id))) return 'dnf'
  if (ids.some(id => ['arch'].includes(id))) return 'pacman'
  if (ids.some(id => ['suse', 'opensuse'].includes(id))) return 'zypper'
  return null
}

/** The sentence someone can act on: what is missing and the one command that supplies it. */
export function installHint(missing, family, engineLabel = 'MySQL') {
  const names = missing.join(', ')
  const packages = [...new Set(missing.map(name => {
    const entry = PACKAGES[name]?.[family]
    return Array.isArray(entry) ? entry[0] : entry
  }).filter(Boolean))]
  const command = { apt: 'sudo apt install', dnf: 'sudo dnf install', pacman: 'sudo pacman -S', zypper: 'sudo zypper install' }[family]
  if (!command || !packages.length) {
    return `${engineLabel} needs system libraries this machine does not have: ${names}. Install them with your package manager, then retry.`
  }
  return `${engineLabel} needs system libraries this machine does not have: ${names}. Install them with: ${command} ${packages.join(' ')} - then retry.`
}

function readOsRelease() {
  try { return fs.readFileSync('/etc/os-release', 'utf8') } catch { return '' }
}

/** Step two: the library is here, under its t64 name. Link it under the name that was asked for. */
function linkRenamed(missing, libs) {
  const res = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, LC_ALL: 'C' } })
  // ldconfig lives in /sbin, which a user's PATH may not include.
  const text = res.error ? spawnSync('/sbin/ldconfig', ['-p'], { encoding: 'utf8', timeout: 15000 }).stdout : res.stdout
  const system = parseLdconfig(text)
  for (const name of missing) {
    const renamed = system.get(`${name}t64`)
    if (renamed) fs.symlinkSync(renamed, path.join(libs, name))
  }
}

/** Step three: the distribution's own packages, downloaded and unpacked without installing them. */
function fetchWithApt(missing, libs, onProgress) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-libs-'))
  try {
    for (const name of missing) {
      for (const pkg of PACKAGES[name]?.apt ?? []) {
        onProgress?.({ message: `Fetching ${pkg} from your distribution` })
        const got = spawnSync('apt-get', ['download', pkg], { cwd: work, encoding: 'utf8', timeout: 120000 })
        if (got.error || got.status !== 0) continue
        const deb = fs.readdirSync(work).find(file => file.startsWith(`${pkg}_`) && file.endsWith('.deb'))
        if (!deb) continue
        const out = path.join(work, `x-${pkg}`)
        const unpacked = spawnSync('dpkg-deb', ['-x', path.join(work, deb), out], { encoding: 'utf8', timeout: 60000 })
        if (unpacked.error || unpacked.status !== 0) continue
        copyLibraries(out, libs)
        break
      }
      // The package that supplies libaio.so.1 on a t64 system supplies it as libaio.so.1t64.
      const target = path.join(libs, name)
      if (!fs.existsSync(target) && fs.existsSync(`${target}t64`)) fs.symlinkSync(`${name}t64`, target)
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** Every shared object under a package's tree, links kept as links so the sonames still resolve. */
function copyLibraries(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    if (entry.isDirectory()) { copyLibraries(source, to); continue }
    if (!/\.so(\.|$)/.test(entry.name)) continue
    const target = path.join(to, entry.name)
    fs.rmSync(target, { force: true })
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target)
    else fs.copyFileSync(source, target)
  }
}

/**
 * Make sure everything these binaries load is loadable, or refuse with a reason.
 *
 * <p>`engineRoot` is the folder holding bin/; the private library folder is made beside it, and
 * only if something was actually missing. Called before an engine is moved into place, so an
 * engine that cannot run is never left looking installed.
 */
export function ensureLibraries(engineRoot, binaries, { onProgress = null, engineLabel = 'MySQL', allowFetch = true } = {}) {
  if (process.platform !== 'linux') return { missing: [], supplied: [] }
  const libs = path.join(engineRoot, LIBS_FOLDER)
  const check = () => missingLibraries(binaries, libraryEnv(binaries[0]))
  let missing = check()
  if (missing === null || !missing.length) return { missing: [], supplied: [] }
  const wanted = [...missing]
  onProgress?.({ message: `Checking the system libraries ${engineLabel} needs` })
  fs.mkdirSync(libs, { recursive: true })

  linkRenamed(missing, libs)
  missing = check() ?? []
  const family = packageFamily(readOsRelease())
  if (missing.length && allowFetch && family === 'apt') {
    fetchWithApt(missing, libs, onProgress)
    missing = check() ?? []
  }
  if (missing.length) {
    fs.rmSync(libs, { recursive: true, force: true })
    fail(installHint(missing, family, engineLabel))
  }
  return { missing: [], supplied: wanted }
}
