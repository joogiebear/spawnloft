#!/usr/bin/env node
// The command line on its own, as a .deb and an .rpm, for headless machines.
//
//   node desktop/build-cli-package.mjs --dist <dir> [--core <spawnloft-core>] [--deb-only]
//                     beside linux-package.mjs's packages in <dir> (its build-info.json is read)
//
// The package is the Rust core alone (static, musl), with no browser and no graphical
// libraries. It is built with dpkg-deb and rpmbuild directly. It conflicts with the desktop
// package since both own /usr/bin/spawnloft. There is no updater; the package manager owns
// these files. --deb-only skips rpmbuild and is not a release.
//
// From 2.0 (rust/INSTALLER-UPDATER-DESIGN.md 5.7) /usr/bin/spawnloft runs the Rust core at
// bin/spawnloft-core. Since C10 (rust/PLAN-CORE-PORT.md 5.1, 5.2) no Node and no Node core ship:
// bin/node stays, as a link to spawnloft-core, because task shims and MCP configs written by the
// 1.x package run `/opt/spawnloft-cli/bin/node /opt/spawnloft-cli/core/mcctl.mjs <command>`, and
// the core drops a first argument naming mcctl.mjs without ever reading it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkNoNode } from './payload-gate.mjs'

export const PACKAGE = 'spawnloft-cli'
export const PREFIX = '/opt/spawnloft-cli'
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
const RPM_ARCH = { x64: 'x86_64', arm64: 'aarch64' }

// lowercase on purpose: the workflows install the desktop package by the glob
// `SpawnLoft-*-linux-<arch>.deb`, and a second match would be handed to apt too
export const cliPackageNames = ({ arch, version }) => [
  `${PACKAGE}-${version}-linux-${DEB_ARCH[arch]}.deb`,
  `${PACKAGE}-${version}-linux-${RPM_ARCH[arch]}.rpm`,
]

// To dpkg, `1.2.0-beta.65` is 1.2.0 at revision `beta.65`, which sorts NEWER than `1.2.0`, and rpm
// disallows the hyphen. `~` sorts before everything in both, so `1.2.0~beta.65` < `1.2.0`.
export const packageVersion = version => String(version).replace('-', '~')

// 2.x: the Rust core is the entry point
export const WRAPPER_2X = `#!/bin/sh
# /usr/bin/spawnloft: the command line, the Rust core this package carries. No Node needed.
exec ${PREFIX}/bin/spawnloft-core "$@"
`

export const isTwoX = version => Number(String(version).split('.')[0]) >= 2

// Swapping the desktop package for this one (the only 2.0 route on EL9, which lacks the desktop
// package's webkit2gtk4.1) removes /opt/SpawnLoft, and every task shim 1.x wrote names a binary
// there, so each task fails with exit 127. The desktop app repairs on its first start; a machine
// with no screen has no such start, so the package runs the repair, as each user with SpawnLoft
// data, after the files are in place (deb postinst; rpm %posttrans, after the old package's
// removal). Idempotent, so an upgrade of this package running it again does no harm. Never fails
// the install: a user it misses can run `spawnloft repair`.
// A user with tasks is found by their systemd units too, since data under a custom XDG_DATA_HOME
// or dataRoot is not in the folders checked. As that user (never as root: the shim is theirs), the
// data root and XDG folders a task shim exports are read back, so the repair finds the same data.
// No single quotes in it: it is passed inside them. `spawnloft` is a parameter only for the test.
export const REPAIR_AS_USER = `units="$HOME/.config/systemd/user"
for unit in "$units"/spawnloft-*.service; do
  [ -f "$unit" ] || continue
  shim=$(sed -n "s|^ExecStart=/bin/sh \\"\\(.*\\)\\"$|\\1|p" "$unit" | head -n 1)
  [ -n "$shim" ] && [ -f "$shim" ] || continue
  eval "$(grep -E "^export (SPAWNLOFT_DATA_ROOT|XDG_CONFIG_HOME|XDG_DATA_HOME)=" "$shim")"
  break
done
exec "$0" repair --quiet`

export const afterInstall2x = ({ spawnloft = '/usr/bin/spawnloft' } = {}) => `if command -v runuser >/dev/null 2>&1 && command -v getent >/dev/null 2>&1; then
  getent passwd | while IFS=: read -r user _ uid _ _ home _; do
    case "$uid" in ''|*[!0-9]*) continue ;; esac
    if [ "$uid" -ne 0 ] && { [ "$uid" -lt 1000 ] || [ "$uid" -eq 65534 ]; }; then continue; fi
    [ -d "$home" ] || continue
    found=
    for dir in .local/share/spawnloft .local/share/mcctl .config/spawnloft .config/mcctl; do
      [ -e "$home/$dir" ] && found=1
    done
    for unit in "$home"/.config/systemd/user/spawnloft-*.service; do
      [ -f "$unit" ] && found=1
    done
    [ -n "$found" ] || continue
    # a generous limit: a repair that hangs must not hold the package manager for ever
    timeout 150 runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" PATH=/usr/bin:/bin \\
      /bin/sh -c '${REPAIR_AS_USER}' ${spawnloft} </dev/null >/dev/null 2>&1 || true
  done
fi
exit 0
`
export const AFTER_INSTALL_2X = afterInstall2x()

export const debPostinst2x = () => `#!/bin/sh
case "$1" in
  configure) ;;
  *) exit 0 ;;
esac
${AFTER_INSTALL_2X}`


const SUMMARY = 'Minecraft servers from the command line, for a machine with no screen'
const DESCRIPTION = [
  'SpawnLoft runs Minecraft servers as supervised background processes: console capture, RCON,',
  'snapshots, scheduled backups and restarts, managed MySQL and Redis, and a local web panel',
  '(spawnloft ui) that an SSH tunnel can reach. This package is the command line alone, one',
  'program with no runtime to install. The desktop package, spawnloft, contains it too; install',
  'one or the other.',
  'Java is separate, and which one depends on the Minecraft version.',
]

export function debControl({ version, arch, installedKb }) {
  return [
    `Package: ${PACKAGE}`,
    `Version: ${packageVersion(version)}`,
    `Architecture: ${DEB_ARCH[arch]}`,
    'Maintainer: joogiebear <joogiebear@protonmail.com>',
    `Installed-Size: ${installedKb}`,
    // the core is static (musl): only what unpacking a database engine shells out to
    'Depends: tar, xz-utils',
    'Conflicts: spawnloft',
    'Section: utils',
    'Priority: optional',
    'Homepage: https://github.com/joogiebear/spawnloft',
    `Description: ${SUMMARY}`,
    ...DESCRIPTION.map(line => ` ${line}`),
    '',
  ].join('\n')
}

export function rpmSpec({ version, staging }) {
  return [
    `Name: ${PACKAGE}`,
    `Version: ${packageVersion(version)}`,
    'Release: 1',
    `Summary: ${SUMMARY}`,
    'License: MIT',
    'URL: https://github.com/joogiebear/spawnloft',
    // the payload is a prebuilt binary and text: no stripping, dependency scanning or debuginfo
    'AutoReqProv: no',
    'Requires: tar, xz',
    'Conflicts: spawnloft',
    '%define debug_package %{nil}',
    '%define __os_install_post %{nil}',
    '%define _build_id_links none',
    // xz is readable by every rpm this could meet; the builder's default is not
    '%define _binary_payload w6.xzdio',
    '%description',
    ...DESCRIPTION,
    '%install',
    `cp -a "${staging}/." "%{buildroot}/"`,
    '%files',
    `%attr(-, root, root) ${PREFIX}`,
    '%attr(0755, root, root) /usr/bin/spawnloft',
    ...(isTwoX(version) ? ['%posttrans', AFTER_INSTALL_2X.trimEnd()] : []),
    '',
  ].join('\n')
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (res.error) throw new Error(`${cmd} could not be run: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`)
}

function kilobytes(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size
  }
  return Math.ceil(bytes / 1024)
}

export function stage(work, kind, info, rustCore) {
  const root = path.join(work, `root-${kind}`)
  const prefix = path.join(root, PREFIX)
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  fs.copyFileSync(rustCore, path.join(prefix, 'bin', 'spawnloft-core'))
  fs.chmodSync(path.join(prefix, 'bin', 'spawnloft-core'), 0o755)
  // the 1.x path, for shims and MCP configs it wrote: the core, which drops their mcctl.mjs
  // argument (rust/PLAN-CORE-PORT.md 5.2); relative, so the staging root can move
  fs.symlinkSync('spawnloft-core', path.join(prefix, 'bin', 'node'))
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(prefix, 'LICENSE'))
  fs.writeFileSync(path.join(prefix, 'build-info.json'), JSON.stringify({ ...info, package: PACKAGE }, null, 2) + '\n')
  fs.writeFileSync(path.join(prefix, 'package-type'), kind)
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'spawnloft'), WRAPPER_2X, { mode: 0o755 })
  fs.chmodSync(path.join(root, 'usr', 'bin', 'spawnloft'), 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755)
  }
  // the release gate's rule, before anything is packed (payload-gate.mjs)
  const problems = checkNoNode([root])
  if (problems.length) throw new Error(problems.join('\n'))
  return root
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || !DEB_ARCH[process.arch]) throw new Error('The CLI packages are built on their native Linux host')
  const arch = process.arch
  const argValue = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined }
  const dist = path.resolve(argValue('--dist') ?? path.join(HERE, 'dist'))
  // reuse the identity linux-package.mjs recorded so these match the desktop packages built beside them
  const built = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'))
  const info = { version: built.version, sourceVersion: built.sourceVersion, commit: built.commit, shortCommit: built.shortCommit, dirty: built.dirty, builtAt: built.builtAt, platform: 'linux', arch }
  if (!isTwoX(info.version)) throw new Error(`${info.version} is not a 2.x version: this branch builds the 2.x command-line package only`)
  const [debName, rpmName] = cliPackageNames(info)
  const rustCore = path.resolve(argValue('--core') ?? path.join(HERE, 'build', 'bin', `linux-${arch}`, 'spawnloft-core'))
  if (!fs.existsSync(rustCore)) throw new Error(`${rustCore} is missing: the command-line package is the Rust core`)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-cli-'))
  try {
    const debRoot = stage(work, 'deb', info, rustCore)
    fs.mkdirSync(path.join(debRoot, 'DEBIAN'))
    fs.writeFileSync(path.join(debRoot, 'DEBIAN', 'control'), debControl({ ...info, installedKb: kilobytes(debRoot) }))
    fs.writeFileSync(path.join(debRoot, 'DEBIAN', 'postinst'), debPostinst2x(), { mode: 0o755 })
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', debRoot, path.join(dist, debName)])

    // not releasable: the manifest step requires both files
    if (process.argv.includes('--deb-only')) { console.log(debName); process.exit(0) }

    const rpmRoot = stage(work, 'rpm', info, rustCore)
    const spec = path.join(work, `${PACKAGE}.spec`)
    fs.writeFileSync(spec, rpmSpec({ ...info, staging: rpmRoot }))
    const out = path.join(work, 'rpms')
    run('rpmbuild', ['-bb', spec, '--target', RPM_ARCH[arch], '--define', `_topdir ${path.join(work, 'rpmbuild')}`,
      '--define', `_rpmdir ${out}`, '--define', `_rpmfilename ${rpmName}`])
    fs.copyFileSync(path.join(out, rpmName), path.join(dist, rpmName))

    for (const name of [debName, rpmName]) console.log(`${(fs.statSync(path.join(dist, name)).size / 1048576).toFixed(1).padStart(6)} MB  ${name}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
