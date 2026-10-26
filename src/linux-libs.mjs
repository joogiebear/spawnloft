import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fail } from './util.mjs'

// Shared libraries a downloaded Linux engine expects the system to have. Oracle's MySQL tarball needs
// libaio, libnuma and ncurses and says nothing when they are missing; mysqld just exits with a loader
// error. Windows and macOS archives bundle theirs. Tried cheapest first, and the engine is installed
// only if one works: already present; present under Debian's t64 name (Ubuntu 24.04 ships
// libaio.so.1t64), fixed with a link in the engine's own folder; or fetched with apt-get/dnf download
// (no root, verified by the distribution's signed metadata) and unpacked beside the engine.
// Failing all three, the refusal names the command that fixes it.

export const LIBS_FOLDER = 'spawnloft-libs'

export function libsDirFor(binaryPath) {
  return path.join(path.dirname(path.dirname(binaryPath)), LIBS_FOLDER)
}

// the engine's private libraries go first on LD_LIBRARY_PATH
export function libraryEnv(binaryPath, env = process.env, platform = process.platform) {
  if (platform !== 'linux') return env
  const dir = libsDirFor(binaryPath)
  if (!fs.existsSync(dir)) return env
  return { ...env, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir }
}

export function parseLdd(text) {
  const missing = new Set()
  for (const line of String(text).split('\n')) {
    const hit = /^\s*(\S+)\s+=>\s+not found/.exec(line)
    if (hit) missing.add(hit[1])
  }
  return [...missing]
}

// null when there is no ldd to ask: unknown, not a clean bill of health
export function missingLibraries(binaries, env = process.env) {
  const missing = new Set()
  for (const file of binaries) {
    const res = spawnSync('ldd', [file], { encoding: 'utf8', timeout: 15000, env: { ...env, LC_ALL: 'C' } })
    if (res.error) return null
    for (const name of parseLdd(res.stdout)) missing.add(name)
  }
  return [...missing]
}

// ldconfig -p lines look like "\tlibaio.so.1t64 (libc6,x86-64) => /lib/x86_64-linux-gnu/libaio.so.1t64"
export function parseLdconfig(text) {
  const found = new Map()
  for (const line of String(text).split('\n')) {
    const hit = /^\s*(\S+)\s+\([^)]*\)\s+=>\s+(\S+)/.exec(line)
    if (hit && !found.has(hit[1])) found.set(hit[1], hit[2])
  }
  return found
}

export const PACKAGES = Object.freeze({
  'libaio.so.1': { apt: ['libaio1t64', 'libaio1'], dnf: 'libaio', pacman: 'libaio', zypper: 'libaio1' },
  'libnuma.so.1': { apt: ['libnuma1'], dnf: 'numactl-libs', pacman: 'numactl', zypper: 'libnuma1' },
  'libncurses.so.6': { apt: ['libncurses6'], dnf: 'ncurses-libs', pacman: 'ncurses', zypper: 'libncurses6' },
  'libtinfo.so.6': { apt: ['libtinfo6'], dnf: 'ncurses-libs', pacman: 'ncurses', zypper: 'libtinfo6' },
})

export function packageFamily(osRelease) {
  const ids = [...String(osRelease).matchAll(/^(?:ID|ID_LIKE)=(.*)$/gm)].flatMap(m => m[1].replaceAll('"', '').split(/\s+/))
  if (ids.some(id => ['debian', 'ubuntu'].includes(id))) return 'apt'
  if (ids.some(id => ['fedora', 'rhel', 'centos'].includes(id))) return 'dnf'
  if (ids.some(id => ['arch'].includes(id))) return 'pacman'
  if (ids.some(id => ['suse', 'opensuse'].includes(id))) return 'zypper'
  return null
}

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

// Everything below assumes glibc's ldd/ldconfig output, and the engines are built against glibc. On musl
// (Alpine) no package fixes that ABI mismatch, and musl's ldd output doesn't match parseLdd, so
// missingLibraries() would report nothing missing for an engine that can't run. Checked by name so the
// refusal says what is actually wrong.
export function isMusl(run = spawnSync) {
  try {
    const res = run('ldd', ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (/musl/i.test(res.stdout || '') || /musl/i.test(res.stderr || '')) return true
  } catch { /* fall through to the loader check */ }
  return ['ld-musl-x86_64.so.1', 'ld-musl-aarch64.so.1', 'ld-musl-armhf.so.1'].some(
    (f) => fs.existsSync(path.join('/lib', f)),
  )
}

// the library exists under its t64 name; link it under the name that was asked for
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

// dnf's arch name; without it a 64-bit Fedora is handed the i686 package too
export const RPM_ARCH = Object.freeze({ x64: 'x86_64', arm64: 'aarch64' })

// one package can supply several libraries: ncurses-libs is both libncurses and libtinfo
export function dnfPackagesFor(missing) {
  return [...new Set(missing.map(name => PACKAGES[name]?.dnf).filter(Boolean))]
}

// fetchWithApt for the Fedora and RHEL families. `dnf download` is in dnf 5 and dnf-plugins-core; where
// it is missing the command fails and the refusal names the packages. rpm2cpio | cpio unpacks the rpm,
// with bsdtar as the fallback. run is injectable so the order can be tested without a Fedora.
export function fetchWithDnf(missing, libs, onProgress = null, { run = spawnSync, arch = process.arch } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-libs-'))
  try {
    for (const pkg of dnfPackagesFor(missing)) {
      onProgress?.({ message: `Fetching ${pkg} from your distribution` })
      const dest = path.join(work, pkg)
      fs.mkdirSync(dest)
      const got = run('dnf', ['download', '--destdir', dest, ...(RPM_ARCH[arch] ? ['--arch', RPM_ARCH[arch]] : []), pkg],
        { cwd: dest, encoding: 'utf8', timeout: 180000, env: { ...process.env, LC_ALL: 'C' } })
      if (got.error || got.status !== 0) continue
      const rpm = fs.readdirSync(dest).find(file => file.startsWith(`${pkg}-`) && file.endsWith('.rpm'))
      if (!rpm) continue
      const out = path.join(work, `x-${pkg}`)
      fs.mkdirSync(out)
      const file = path.join(dest, rpm)
      const unpackers = [
        ['sh', ['-c', 'rpm2cpio "$1" | cpio -idm --quiet', 'sh', file]],
        ['bsdtar', ['-xf', file]],
      ]
      for (const [cmd, args] of unpackers) {
        const res = run(cmd, args, { cwd: out, encoding: 'utf8', timeout: 60000 })
        if (!res.error && res.status === 0) break
      }
      copyLibraries(out, libs)
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// links are kept as links so the sonames still resolve
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

// Makes everything these binaries load loadable, or refuses with a reason. engineRoot is the folder
// holding bin/; the private library folder is created beside it only if something is missing. Called
// before an engine is moved into place so one that can't run is never left looking installed.
export function ensureLibraries(engineRoot, binaries, { onProgress = null, engineLabel = 'MySQL', allowFetch = true } = {}) {
  if (process.platform !== 'linux') return { missing: [], supplied: [] }
  if (isMusl()) {
    fail(`${engineLabel} needs glibc, which this system's C library (musl, as on Alpine Linux) does not provide. ` +
      'No package install fixes this - run SpawnLoft on a glibc-based distribution (Debian, Ubuntu, Fedora, and most others) instead.')
  }
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
  const fetch = { apt: fetchWithApt, dnf: fetchWithDnf }[family]
  if (missing.length && allowFetch && fetch) {
    fetch(missing, libs, onProgress)
    missing = check() ?? []
  }
  if (missing.length) {
    fs.rmSync(libs, { recursive: true, force: true })
    fail(installHint(missing, family, engineLabel))
  }
  return { missing: [], supplied: wanted }
}
