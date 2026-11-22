import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { cliPackageNames, packageVersion, debControl, rpmSpec, stage, WRAPPER_2X, PACKAGE, PREFIX } from '../desktop/build-cli-package.mjs'

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
  assert.doesNotMatch(control, /nodejs|libstdc\+\+/, 'no Node is carried or depended on')
  assert.ok(control.endsWith('\n'))
  for (const line of control.split('\n').slice(control.split('\n').findIndex(l => l.startsWith('Description:')) + 1, -1)) {
    assert.match(line, /^ \S/, 'a description continues on indented, non-empty lines')
  }

  const spec = rpmSpec({ version: '1.2.0-beta.65', staging: '/tmp/stage' })
  assert.match(spec, /^Name: spawnloft-cli$/m)
  assert.match(spec, /^Version: 1\.2\.0~beta\.65$/m)
  assert.match(spec, /^Conflicts: spawnloft$/m)
  assert.match(spec, /^Requires: .*\btar, xz$/m)
  assert.doesNotMatch(spec, /libstdc\+\+/)
  // A prebuilt binary: rpmbuild must not strip it, scan it, or split debug information out of it.
  assert.match(spec, /^AutoReqProv: no$/m)
  assert.match(spec, /^%define __os_install_post %\{nil\}$/m)
  assert.match(spec, /^cp -a "\/tmp\/stage\/\." "%\{buildroot\}\/"$/m)
  assert.ok(spec.includes(`${PREFIX}\n`) && spec.includes('/usr/bin/spawnloft\n'))
})

test('the launcher runs the core, and is a program', () => {
  assert.ok(WRAPPER_2X.startsWith('#!/bin/sh\n'))
  assert.doesNotMatch(WRAPPER_2X, /\r/, '"#!/bin/sh\\r" is not a program')
  assert.match(WRAPPER_2X, new RegExp(`^exec ${PREFIX}/bin/spawnloft-core "\\$@"$`, 'm'))
  assert.equal(PACKAGE, 'spawnloft-cli')
})

// rust/PLAN-CORE-PORT.md 5.1 and 5.2: the core alone; bin/node, the path 1.x shims and MCP
// configs name, is a link to it; no Node, no Node core, no node field in build-info.json
test('the package carries the core alone, with bin/node a link to it', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-cli-stage-'))
  try {
    const core = path.join(work, 'spawnloft-core')
    fs.writeFileSync(core, 'core bytes')
    const info = { version: '2.0.0-beta.7', commit: 'abc', platform: 'linux', arch: 'x64' }
    const prefix = path.join(stage(work, 'deb', info, core), PREFIX)
    assert.deepEqual(fs.readdirSync(prefix).sort(), ['LICENSE', 'bin', 'build-info.json', 'package-type'])
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'bin')).sort(), ['node', 'spawnloft-core'])
    assert.equal(fs.readlinkSync(path.join(prefix, 'bin', 'node')), 'spawnloft-core')
    assert.equal(fs.readFileSync(path.join(prefix, 'bin', 'node'), 'utf8'), 'core bytes')
    const record = JSON.parse(fs.readFileSync(path.join(prefix, 'build-info.json'), 'utf8'))
    assert.equal(record.package, PACKAGE)
    assert.equal('node' in record, false)
    assert.equal(fs.readFileSync(path.join(prefix, 'package-type'), 'utf8'), 'deb')
    assert.equal(fs.readFileSync(path.join(prefix, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

// Swapping the 1.x desktop package for this one leaves task shims naming the removed
// /opt/SpawnLoft, so the 2.x package repairs them as each user who has SpawnLoft data.
test('a 2.x package repairs the task shims of every user with SpawnLoft data after install', async () => {
  const { afterInstall2x, REPAIR_AS_USER, debPostinst2x } = await import('../desktop/build-cli-package.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')

  const spec2 = rpmSpec({ version: '2.0.0-beta.1010', staging: '/tmp/stage' })
  assert.match(spec2, /\n%posttrans\n[\s\S]*\/usr\/bin\/spawnloft </, 'the rpm runs the repair after the old package is gone')
  assert.doesNotMatch(rpmSpec({ version: '1.6.0', staging: '/tmp/stage' }), /%posttrans/, 'a 1.x package has no 2.x repair')
  assert.doesNotMatch(REPAIR_AS_USER, /'/, 'the per-user script is passed inside single quotes')
  if (process.platform === 'win32') return

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-cli-postinst-'))
  try {
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'calls.log')
    fs.mkdirSync(bin)
    const home = (name) => path.join(dir, 'home', name)
    fs.mkdirSync(path.join(home('victor'), '.local', 'share', 'mcctl'), { recursive: true })
    fs.mkdirSync(path.join(home('olduser'), '.config', 'spawnloft'), { recursive: true })
    fs.mkdirSync(path.join(home('root'), '.local', 'share', 'spawnloft'), { recursive: true })
    fs.mkdirSync(home('fresh'), { recursive: true })
    fs.mkdirSync(path.join(home('daemon'), '.local', 'share', 'spawnloft'), { recursive: true })
    // data under a custom XDG_DATA_HOME: found only by its systemd unit, which names the shim
    const custom = path.join(dir, 'srv data', 'spawnloft')
    fs.mkdirSync(path.join(custom, 'tasks'), { recursive: true })
    const shim = path.join(custom, 'tasks', 'alpha-backup.sh')
    fs.writeFileSync(shim, `#!/bin/sh\nexport SPAWNLOFT_DATA_ROOT='${custom}'\nexport HOME='/elsewhere'\nexport XDG_DATA_HOME='${path.dirname(custom)}'\nexec '/opt/SpawnLoft/spawnloft-desktop' task run 'alpha-backup'\n`)
    const units = path.join(home('xdguser'), '.config', 'systemd', 'user')
    fs.mkdirSync(units, { recursive: true })
    fs.writeFileSync(path.join(units, 'spawnloft-0123456789abcdef-alpha-backup.service'), `[Unit]\nDescription=x\n[Service]\nType=oneshot\nExecStart=/bin/sh "${shim}"\n`)

    fs.writeFileSync(path.join(dir, 'passwd'), [
      `root:x:0:0::${home('root')}:/bin/bash`,
      `victor:x:1000:1000::${home('victor')}:/bin/bash`,
      `olduser:x:1001:1001::${home('olduser')}:/bin/bash`,
      `fresh:x:1002:1002::${home('fresh')}:/bin/bash`,
      `xdguser:x:1004:1004::${home('xdguser')}:/bin/bash`,
      `daemon:x:2:2::${home('daemon')}:/usr/sbin/nologin`,
      `nobody:x:65534:65534::${home('victor')}:/usr/sbin/nologin`,
      `gone:x:1003:1003::${path.join(dir, 'missing')}:/bin/bash`,
    ].join('\n') + '\n')
    const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    tool('getent', `cat '${path.join(dir, 'passwd')}'`)
    tool('timeout', `[ "$1" -gt 120 ] || exit 99\nshift\nexec "$@"`)
    tool('runuser', `[ "$1" = -u ] || exit 98\nprintf '%s ' "$2" >> '${log}'\nshift 3\nexec "$@"`)
    // a failing repair must not fail the install; HOME comes from passwd, never from the shim
    tool('spawnloft', `echo "$* | $HOME | $SPAWNLOFT_DATA_ROOT | $XDG_DATA_HOME" >> '${log}'\nexit 1`)

    const script = afterInstall2x({ spawnloft: path.join(bin, 'spawnloft') })
    const res = spawnSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(calls, [
      `root repair --quiet | ${home('root')} |  | `,
      `victor repair --quiet | ${home('victor')} |  | `,
      `olduser repair --quiet | ${home('olduser')} |  | `,
      `xdguser repair --quiet | ${home('xdguser')} | ${custom} | ${path.dirname(custom)}`,
    ])

    // the deb runs it on configure only, not on abort-upgrade and the like
    fs.rmSync(log)
    const deb = debPostinst2x().replace('/usr/bin/spawnloft', path.join(bin, 'spawnloft'))
    for (const arg of ['abort-upgrade', 'configure']) {
      assert.equal(spawnSync('sh', ['-c', deb, 'postinst', arg], { env: { PATH: `${bin}:/usr/bin:/bin` } }).status, 0)
    }
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 4, 'abort-upgrade ran the repair')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
