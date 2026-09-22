import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLdd, parseLdconfig, packageFamily, installHint, libraryEnv, libsDirFor, ensureLibraries, LIBS_FOLDER, fetchWithDnf, dnfPackagesFor, RPM_ARCH } from '../src/linux-libs.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-libs-test-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// What ldd really said about Oracle's mysqld on a stock Ubuntu 24.04.
const LDD = [
  '\tlinux-vdso.so.1 (0x00007ffd1c5f2000)',
  '\tlibpthread.so.0 => /lib/x86_64-linux-gnu/libpthread.so.0 (0x00007f2a1c000000)',
  '\tlibaio.so.1 => not found',
  '\tlibnuma.so.1 => not found',
  '\tlibprotobuf-lite.so.24.4.0 => /home/u/engine/bin/../lib/private/libprotobuf-lite.so.24.4.0 (0x00007f2a1b000000)',
  '\tlibaio.so.1 => not found',
].join('\n')

test('what a binary cannot load is read from ldd, once each', () => {
  assert.deepEqual(parseLdd(LDD), ['libaio.so.1', 'libnuma.so.1'])
  assert.deepEqual(parseLdd('\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n'), [])
  assert.deepEqual(parseLdd('\tnot a dynamic executable\n'), [])
})

test('the library Debian renamed is found under its new name', () => {
  const system = parseLdconfig([
    '1234 libs found in cache `/etc/ld.so.cache\'',
    '\tlibaio.so.1t64 (libc6,x86-64) => /lib/x86_64-linux-gnu/libaio.so.1t64',
    '\tlibtinfo.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libtinfo.so.6',
    '\tlibtinfo.so.6 (libc6) => /lib/i386-linux-gnu/libtinfo.so.6',
  ].join('\n'))
  assert.equal(system.get('libaio.so.1t64'), '/lib/x86_64-linux-gnu/libaio.so.1t64')
  // The first listing is the one the loader prefers on this machine.
  assert.equal(system.get('libtinfo.so.6'), '/lib/x86_64-linux-gnu/libtinfo.so.6')
  assert.equal(system.get('libaio.so.1'), undefined)
})

test('the distribution family is read from os-release, including derivatives', () => {
  assert.equal(packageFamily('ID=ubuntu\nID_LIKE=debian\n'), 'apt')
  assert.equal(packageFamily('ID=linuxmint\nID_LIKE="ubuntu debian"\n'), 'apt')
  assert.equal(packageFamily('ID=fedora\n'), 'dnf')
  assert.equal(packageFamily('ID="rocky"\nID_LIKE="rhel centos fedora"\n'), 'dnf')
  assert.equal(packageFamily('ID=arch\n'), 'pacman')
  assert.equal(packageFamily('ID=manjaro\nID_LIKE=arch\n'), 'pacman')
  assert.equal(packageFamily('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n'), 'zypper')
  assert.equal(packageFamily('ID=nixos\n'), null)
  assert.equal(packageFamily(''), null)
})

test('a refusal names what is missing and the one command that supplies it', () => {
  assert.equal(installHint(['libaio.so.1', 'libnuma.so.1'], 'apt'),
    'MySQL needs system libraries this machine does not have: libaio.so.1, libnuma.so.1. Install them with: sudo apt install libaio1t64 libnuma1 - then retry.')
  // Two libraries from one package are one package on the command line.
  assert.match(installHint(['libncurses.so.6', 'libtinfo.so.6'], 'dnf'), /sudo dnf install ncurses-libs - then retry/)
  assert.match(installHint(['libaio.so.1'], 'pacman'), /sudo pacman -S libaio /)
  // An unknown distribution, or an unknown library, still says what is missing.
  assert.match(installHint(['libaio.so.1'], null), /libaio\.so\.1\. Install them with your package manager/)
  assert.match(installHint(['libstrange.so.9'], 'apt'), /libstrange\.so\.9\. Install them with your package manager/)
})

test('an engine runs with its private libraries first, and only where it has any', () => {
  const engine = path.join(scratch, 'engine')
  const tool = path.join(engine, 'bin', 'mysqld')
  fs.mkdirSync(path.dirname(tool), { recursive: true })
  assert.equal(libsDirFor(tool), path.join(engine, LIBS_FOLDER))
  const env = { PATH: '/usr/bin' }
  assert.equal(libraryEnv(tool, env, 'linux'), env, 'no private folder, so nothing to add')
  fs.mkdirSync(path.join(engine, LIBS_FOLDER))
  assert.equal(libraryEnv(tool, env, 'linux').LD_LIBRARY_PATH, path.join(engine, LIBS_FOLDER))
  assert.equal(libraryEnv(tool, { LD_LIBRARY_PATH: '/opt/lib' }, 'linux').LD_LIBRARY_PATH, `${path.join(engine, LIBS_FOLDER)}:/opt/lib`)
  assert.equal(libraryEnv(tool, env, 'darwin'), env)
  assert.equal(libraryEnv(tool, env, 'win32'), env)
})

test('a binary with nothing missing needs no private folder', { skip: process.platform !== 'linux' }, () => {
  const engine = path.join(scratch, 'whole')
  fs.mkdirSync(path.join(engine, 'bin'), { recursive: true })
  // This Node is as good a dynamically linked binary as any, and it is known to run here.
  const result = ensureLibraries(engine, [process.execPath], { allowFetch: false })
  assert.deepEqual(result, { missing: [], supplied: [] })
  assert.ok(!fs.existsSync(path.join(engine, LIBS_FOLDER)))
})

// ---- dnf -----------------------------------------------------------------------------------------

/** A stand-in for spawnSync that plays dnf and the unpackers, and records what it was asked. */
function fakeDnf({ download = true, cpio = true, bsdtar = true } = {}) {
  const calls = []
  const unpack = (cwd, file) => {
    const pkg = /([a-z-]+?)-\d/.exec(path.basename(file))[1]
    const lib64 = path.join(cwd, 'usr', 'lib64')
    fs.mkdirSync(lib64, { recursive: true })
    const names = { libaio: ['libaio.so.1'], 'numactl-libs': ['libnuma.so.1'], 'ncurses-libs': ['libncurses.so.6', 'libtinfo.so.6'] }[pkg]
    for (const name of names) {
      fs.writeFileSync(path.join(lib64, `${name}.0.0`), `fixture ${name}`)
      fs.symlinkSync(`${name}.0.0`, path.join(lib64, name))
    }
    fs.writeFileSync(path.join(cwd, 'usr', 'README'), 'not a library')
  }
  const run = (cmd, args, options) => {
    calls.push([cmd, ...args])
    if (cmd === 'dnf') {
      if (!download) return { status: 1, stderr: 'No such command: download' }
      const pkg = args.at(-1)
      fs.writeFileSync(path.join(args[args.indexOf('--destdir') + 1], `${pkg}-1.0-1.fc42.x86_64.rpm`), 'rpm')
      return { status: 0 }
    }
    if (cmd === 'sh') { if (!cpio) return { status: 127 }; unpack(options.cwd, args.at(-1)); return { status: 0 } }
    if (cmd === 'bsdtar') { if (!bsdtar) return { error: Object.assign(new Error('no bsdtar'), { code: 'ENOENT' }) }; unpack(options.cwd, args.at(-1)); return { status: 0 } }
    throw new Error(`unexpected command ${cmd}`)
  }
  return { run, calls }
}

const symlinks = process.platform !== 'win32'

test('dnf is asked once per package, for this architecture only', { skip: !symlinks }, t => {
  const libs = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dnf-'))
  t.after(() => fs.rmSync(libs, { recursive: true, force: true }))
  const { run, calls } = fakeDnf()
  // ncurses-libs supplies both of the last two. Downloading it twice is a second trip to a mirror.
  assert.deepEqual(dnfPackagesFor(['libaio.so.1', 'libncurses.so.6', 'libtinfo.so.6', 'libunknown.so.9']), ['libaio', 'ncurses-libs'])
  fetchWithDnf(['libaio.so.1', 'libncurses.so.6', 'libtinfo.so.6'], libs, null, { run, arch: 'arm64' })
  const downloads = calls.filter(call => call[0] === 'dnf')
  assert.deepEqual(downloads.map(call => call.at(-1)), ['libaio', 'ncurses-libs'])
  // Without --arch a 64-bit Fedora is handed the i686 package too.
  for (const call of downloads) assert.deepEqual(call.slice(1, 2).concat(call.slice(4, 6)), ['download', '--arch', 'aarch64'])
  // Links kept as links so the soname resolves; nothing that is not a shared object comes along.
  assert.deepEqual(fs.readdirSync(libs).sort(), ['libaio.so.1', 'libaio.so.1.0.0', 'libncurses.so.6', 'libncurses.so.6.0.0', 'libtinfo.so.6', 'libtinfo.so.6.0.0'])
  assert.equal(fs.readlinkSync(path.join(libs, 'libaio.so.1')), 'libaio.so.1.0.0')
  assert.ok(calls.every(call => call[0] !== 'bsdtar'), 'cpio worked, so nothing else was tried')
})

test('an rpm is unpacked by bsdtar where there is no cpio, and a machine with neither supplies nothing', { skip: !symlinks }, t => {
  const libs = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dnf-'))
  t.after(() => fs.rmSync(libs, { recursive: true, force: true }))
  const noCpio = fakeDnf({ cpio: false })
  fetchWithDnf(['libnuma.so.1'], libs, null, { run: noCpio.run, arch: 'x64' })
  assert.deepEqual(noCpio.calls.map(call => call[0]), ['dnf', 'sh', 'bsdtar'])
  assert.ok(fs.existsSync(path.join(libs, 'libnuma.so.1')))

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dnf-'))
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  fetchWithDnf(['libnuma.so.1'], empty, null, { run: fakeDnf({ cpio: false, bsdtar: false }).run, arch: 'x64' })
  assert.deepEqual(fs.readdirSync(empty), [], 'ensureLibraries then refuses with the install command, as before')
})

test('a dnf without the download command supplies nothing and unpacks nothing', t => {
  const libs = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-dnf-'))
  t.after(() => fs.rmSync(libs, { recursive: true, force: true }))
  const { run, calls } = fakeDnf({ download: false })
  const progress = []
  fetchWithDnf(['libaio.so.1'], libs, p => progress.push(p.message), { run, arch: 'x64' })
  assert.deepEqual(calls.map(call => call[0]), ['dnf'])
  assert.deepEqual(fs.readdirSync(libs), [])
  assert.deepEqual(progress, ['Fetching libaio from your distribution'])
  assert.equal(RPM_ARCH.x64, 'x86_64')
})
