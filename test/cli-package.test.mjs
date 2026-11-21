import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliPackageNames, packageVersion, debControl, rpmSpec, WRAPPER, NODE_VERSION, NODE_SHA256, PACKAGE, PREFIX } from '../desktop/build-cli-package.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the packages are named for their own packaging system, and never match the desktop globs', () => {
  assert.deepEqual(cliPackageNames({ arch: 'x64', version: '1.2.0' }), ['spawnloft-cli-1.2.0-linux-amd64.deb', 'spawnloft-cli-1.2.0-linux-x86_64.rpm'])
  assert.deepEqual(cliPackageNames({ arch: 'arm64', version: '1.2.0-beta.7' }), ['spawnloft-cli-1.2.0-beta.7-linux-arm64.deb', 'spawnloft-cli-1.2.0-beta.7-linux-aarch64.rpm'])
  // The workflows hand `SpawnLoft-*-linux-<arch>.deb` to apt. A second match would be installed
  // with the desktop package, and the two conflict.
  for (const name of cliPackageNames({ arch: 'x64', version: '1.2.0' })) assert.doesNotMatch(name, /^SpawnLoft-/)
  // The Electron workflows that used to build them are retired on the 2.0 line; the Linux installer
  // workflow builds the packages now.
  const text = fs.readFileSync(path.join(root, '.github', 'workflows', 'installer-linux.yml'), 'utf8')
  assert.match(text, /node desktop\/build-cli-package\.mjs/, 'installer-linux.yml builds them')
})

test('a beta sorts before its release for a package manager', () => {
  // dpkg reads 1.2.0-beta.65 as revision "beta.65" of 1.2.0, which is newer than a bare 1.2.0, and
  // rpm refuses the hyphen. A tilde sorts before the end of the string in both.
  assert.equal(packageVersion('1.2.0-beta.65'), '1.2.0~beta.65')
  assert.equal(packageVersion('1.2.0'), '1.2.0')
})

test('the control file and the spec say the same things', () => {
  const control = debControl({ version: '1.2.0-beta.65', arch: 'arm64', installedKb: 1234 })
  assert.match(control, /^Package: spawnloft-cli$/m)
  assert.match(control, /^Version: 1\.2\.0~beta\.65$/m)
  assert.match(control, /^Architecture: arm64$/m)
  assert.match(control, /^Installed-Size: 1234$/m)
  // Both own /usr/bin/spawnloft.
  assert.match(control, /^Conflicts: spawnloft$/m)
  // Unpacking a database engine shells out to these, and a minimal server image has neither.
  assert.match(control, /^Depends: .*\btar, xz-utils$/m)
  assert.doesNotMatch(control, /nodejs/, 'Node is carried, not depended on')
  assert.ok(control.endsWith('\n'))
  for (const line of control.split('\n').slice(control.split('\n').findIndex(l => l.startsWith('Description:')) + 1, -1)) {
    assert.match(line, /^ \S/, 'a description continues on indented, non-empty lines')
  }

  const spec = rpmSpec({ version: '1.2.0-beta.65', staging: '/tmp/stage' })
  assert.match(spec, /^Name: spawnloft-cli$/m)
  assert.match(spec, /^Version: 1\.2\.0~beta\.65$/m)
  assert.match(spec, /^Conflicts: spawnloft$/m)
  assert.match(spec, /^Requires: .*\btar, xz$/m)
  // A prebuilt binary: rpmbuild must not strip it, scan it, or split debug information out of it.
  assert.match(spec, /^AutoReqProv: no$/m)
  assert.match(spec, /^%define __os_install_post %\{nil\}$/m)
  assert.match(spec, /^cp -a "\/tmp\/stage\/\." "%\{buildroot\}\/"$/m)
  assert.ok(spec.includes(`${PREFIX}\n`) && spec.includes('/usr/bin/spawnloft\n'))
})

test('the launcher runs the core on the runtime beside it, and is a program', () => {
  assert.ok(WRAPPER.startsWith('#!/bin/sh\n'))
  assert.doesNotMatch(WRAPPER, /\r/, '"#!/bin/sh\\r" is not a program')
  assert.match(WRAPPER, new RegExp(`^exec ${PREFIX}/bin/node ${PREFIX}/core/mcctl\\.mjs "\\$@"$`, 'm'))
  assert.equal(PACKAGE, 'spawnloft-cli')
})

test('the runtime is pinned to a version and a published hash for each architecture', () => {
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(NODE_SHA256).sort(), ['arm64', 'x64'])
  for (const hash of Object.values(NODE_SHA256)) assert.match(hash, /^[0-9a-f]{64}$/)
  const wanted = Number(/>=(\d+)/.exec(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node)[1])
  assert.ok(Number(NODE_VERSION.split('.')[0]) >= wanted)
})

// Swapping the 1.x desktop package for this one leaves task shims naming the removed
// /opt/SpawnLoft, so the 2.x package repairs them as each user who has SpawnLoft data.
test('a 2.x package repairs the task shims of every user with SpawnLoft data after install', async () => {
  const { AFTER_INSTALL_2X, debPostinst2x } = await import('../desktop/build-cli-package.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  if (process.platform === 'win32') return

  const spec2 = rpmSpec({ version: '2.0.0-beta.1010', staging: '/tmp/stage' })
  assert.match(spec2, /\n%posttrans\n[\s\S]*spawnloft repair --quiet/, 'the rpm runs the repair after the old package is gone')
  assert.doesNotMatch(rpmSpec({ version: '1.6.0', staging: '/tmp/stage' }), /%posttrans/, 'a 1.x package has no 2.x repair')
  assert.match(debPostinst2x(), /^#!\/bin\/sh\ncase "\$1" in\n  configure\)/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-cli-postinst-'))
  try {
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'calls.log')
    fs.mkdirSync(bin)
    const homes = { victor: path.join(dir, 'victor'), olduser: path.join(dir, 'olduser'), fresh: path.join(dir, 'fresh'), daemon: path.join(dir, 'daemon') }
    fs.mkdirSync(path.join(homes.victor, '.local', 'share', 'mcctl'), { recursive: true })
    fs.mkdirSync(path.join(homes.olduser, '.config', 'spawnloft'), { recursive: true })
    fs.mkdirSync(homes.fresh)
    fs.mkdirSync(path.join(homes.daemon, '.local', 'share', 'spawnloft'), { recursive: true })
    const passwd = [
      `victor:x:1000:1000::${homes.victor}:/bin/bash`,
      `olduser:x:1001:1001::${homes.olduser}:/bin/bash`,
      `fresh:x:1002:1002::${homes.fresh}:/bin/bash`,
      `daemon:x:2:2::${homes.daemon}:/usr/sbin/nologin`,
      `nobody:x:65534:65534::${homes.victor}:/usr/sbin/nologin`,
      `gone:x:1003:1003::${path.join(dir, 'missing')}:/bin/bash`,
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'passwd'), passwd + '\n')
    const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    tool('getent', `cat '${path.join(dir, 'passwd')}'`)
    tool('timeout', 'shift; exec "$@"')
    // a failing repair must not fail the install
    tool('runuser', `echo "$*" >> '${log}'; exit 1`)

    const res = spawnSync('sh', ['-c', AFTER_INSTALL_2X], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 2, calls.join('\n'))
    assert.match(calls[0], new RegExp(`^-u victor -- env -i HOME=${homes.victor} USER=victor .* /usr/bin/spawnloft repair --quiet$`))
    assert.match(calls[1], /^-u olduser -- /)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
