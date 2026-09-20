import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLdd, parseLdconfig, packageFamily, installHint, libraryEnv, libsDirFor, ensureLibraries, LIBS_FOLDER } from '../src/linux-libs.mjs'

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
