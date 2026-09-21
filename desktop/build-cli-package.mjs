#!/usr/bin/env node
/**
 * The command line on its own, as a .deb and an .rpm, for a machine with no screen.
 *
 *   node desktop/build-cli-package.mjs              # after electron-builder, on the native Linux host
 *   node desktop/build-cli-package.mjs --deb-only   # on a machine without rpmbuild; not a release
 *
 * <p>The desktop packages already carry the command line, but they carry it on Electron's runtime:
 * a few hundred megabytes of browser, and a list of graphical libraries for apt to pull onto a VPS
 * that will never draw a window. The core needs none of it. It is plain Node with no dependencies,
 * so this package is the core, one Node binary, and a four-line /usr/bin/spawnloft.
 *
 * <p>Node is bundled rather than depended on. "No Node needed" is what the desktop packages already
 * promise, and the distributions this is for do not agree about Node: Ubuntu 22.04 ships 12, which
 * cannot run the core at all. The binary is the official one, pinned by version and checked against
 * the hash nodejs.org published before anything is unpacked. It is the same major version Electron
 * carries, so the core runs on one runtime everywhere it is packaged.
 *
 * <p>The two packages are made with dpkg-deb and rpmbuild directly. electron-builder makes the
 * desktop ones through fpm, but fpm is its private toolchain, fetched into a cache; reaching into
 * that is more fragile than thirty lines of control file and spec.
 *
 * <p>It conflicts with the desktop package rather than sitting beside it: both own /usr/bin/spawnloft,
 * and a machine with the app installed already has everything this provides.
 *
 * <p>There is no updater. A package manager owns these files, and a headless machine has nobody to
 * show a prompt to; a newer release is installed the way this one was.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setPackageVersion } from './set-version.mjs'

export const NODE_VERSION = '24.21.0'
/** sha256 of node-v<version>-linux-<arch>.tar.xz, from https://nodejs.org/dist/v<version>/SHASUMS256.txt */
export const NODE_SHA256 = {
  x64: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  arm64: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
}
export const PACKAGE = 'spawnloft-cli'
export const PREFIX = '/opt/spawnloft-cli'
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
const RPM_ARCH = { x64: 'x86_64', arm64: 'aarch64' }

/**
 * Lowercase on purpose. The workflows install the desktop package by the glob
 * `SpawnLoft-*-linux-<arch>.deb`, and a second file matching that would be handed to apt with it.
 */
export const cliPackageNames = ({ arch, version }) => [
  `${PACKAGE}-${version}-linux-${DEB_ARCH[arch]}.deb`,
  `${PACKAGE}-${version}-linux-${RPM_ARCH[arch]}.rpm`,
]

/**
 * The version as a package manager must read it.
 *
 * <p>To dpkg, `1.2.0-beta.65` is version 1.2.0 at revision `beta.65`, which is NEWER than a bare
 * `1.2.0`: someone moving from a beta to the release would be told they were downgrading. rpm does
 * not allow the hyphen at all. Both sort `~` before everything, including the end of the string, so
 * `1.2.0~beta.65` comes before `1.2.0` in each.
 */
export const packageVersion = version => String(version).replace('-', '~')

export const WRAPPER = `#!/bin/sh
# /usr/bin/spawnloft: the command line, on the Node this package carries. No Node needed on PATH.
exec ${PREFIX}/bin/node ${PREFIX}/core/mcctl.mjs "$@"
`

const SUMMARY = 'Minecraft servers from the command line, for a machine with no screen'
const DESCRIPTION = [
  'SpawnLoft runs Minecraft servers as supervised background processes: console capture, RCON,',
  'snapshots, scheduled backups and restarts, managed MySQL and Redis, and a local web panel',
  '(spawnloft ui) that an SSH tunnel can reach. This package is the command line alone, on its own',
  'Node runtime. The desktop package, spawnloft, contains it too; install one or the other.',
  'Java is separate, and which one depends on the Minecraft version.',
]

export function debControl({ version, arch, installedKb }) {
  return [
    `Package: ${PACKAGE}`,
    `Version: ${packageVersion(version)}`,
    `Architecture: ${DEB_ARCH[arch]}`,
    'Maintainer: joogiebear <joogiebear@protonmail.com>',
    `Installed-Size: ${installedKb}`,
    // What the Node binary links against, and what unpacking a database engine shells out to.
    'Depends: libc6 (>= 2.28), libstdc++6, libgcc-s1, tar, xz-utils',
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
    // The payload is one prebuilt binary and some text. Nothing here is to be compiled, stripped,
    // scanned for dependencies or split into a debuginfo package.
    'AutoReqProv: no',
    'Requires: glibc >= 2.28, libstdc++, tar, xz',
    'Conflicts: spawnloft',
    '%define debug_package %{nil}',
    '%define __os_install_post %{nil}',
    '%define _build_id_links none',
    // xz is read by every rpm this could meet; the builder's own default is not.
    '%define _binary_payload w6.xzdio',
    '%description',
    ...DESCRIPTION,
    '%install',
    `cp -a "${staging}/." "%{buildroot}/"`,
    '%files',
    `%attr(-, root, root) ${PREFIX}`,
    '%attr(0755, root, root) /usr/bin/spawnloft',
    '',
  ].join('\n')
}

// ---- building ------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (res.error) throw new Error(`${cmd} could not be run: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`)
}

async function fetchNode(arch, into) {
  const name = `node-v${NODE_VERSION}-linux-${arch}`
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz`
  const { fetchRetry } = await import('../src/download.mjs')
  const res = await fetchRetry(url, {}, { timeoutMs: 600000 })
  if (!res.ok) throw new Error(`Node download failed (${res.status}) from ${url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(bytes).digest('hex')
  if (got !== NODE_SHA256[arch]) throw new Error(`Node checksum mismatch for ${name}\n  expected ${NODE_SHA256[arch]}\n  got      ${got}`)
  const archive = path.join(into, `${name}.tar.xz`)
  fs.writeFileSync(archive, bytes)
  // Only the runtime and the licence it must travel with. npm, corepack and the headers stay behind.
  run('tar', ['-xJf', archive, '-C', into, `${name}/bin/node`, `${name}/LICENSE`])
  return path.join(into, name)
}

function copyCore(to, version) {
  fs.mkdirSync(to, { recursive: true })
  // The same files the desktop packages put in resources/core.
  for (const file of ['mcctl.mjs', 'spawnloft.mjs', 'package.json', 'LICENSE']) fs.copyFileSync(path.join(ROOT, file), path.join(to, file))
  fs.cpSync(path.join(ROOT, 'src'), path.join(to, 'src'), { recursive: true })
  // The source says 1.2.0-beta.1 for every beta of 1.2.0. Diagnostics should name the build this is.
  const manifest = path.join(to, 'package.json')
  fs.writeFileSync(manifest, setPackageVersion(fs.readFileSync(manifest, 'utf8'), version).text)
}

function kilobytes(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size
  }
  return Math.ceil(bytes / 1024)
}

function stage(work, kind, node, info) {
  const root = path.join(work, `root-${kind}`)
  const prefix = path.join(root, PREFIX)
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(node, 'bin', 'node'), path.join(prefix, 'bin', 'node'))
  fs.chmodSync(path.join(prefix, 'bin', 'node'), 0o755)
  fs.copyFileSync(path.join(node, 'LICENSE'), path.join(prefix, 'NODE-LICENSE'))
  copyCore(path.join(prefix, 'core'), info.version)
  // What this copy is and how it got here, where a bug report or a later updater can read it.
  fs.writeFileSync(path.join(prefix, 'build-info.json'), JSON.stringify({ ...info, package: PACKAGE, node: NODE_VERSION }, null, 2) + '\n')
  fs.writeFileSync(path.join(prefix, 'package-type'), kind)
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'spawnloft'), WRAPPER, { mode: 0o755 })
  fs.chmodSync(path.join(root, 'usr', 'bin', 'spawnloft'), 0o755)
  return root
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || !NODE_SHA256[process.arch]) throw new Error('The CLI packages are built on their native Linux host')
  const arch = process.arch
  const dist = path.join(HERE, 'dist')
  // The identity electron-builder's after-pack recorded, so that these packages carry the same
  // version and commit as the desktop ones built beside them.
  const built = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'))
  const info = { version: built.version, sourceVersion: built.sourceVersion, commit: built.commit, shortCommit: built.shortCommit, dirty: built.dirty, builtAt: built.builtAt, platform: 'linux', arch }
  const [debName, rpmName] = cliPackageNames(info)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-cli-'))
  try {
    const node = await fetchNode(arch, work)

    const debRoot = stage(work, 'deb', node, info)
    fs.mkdirSync(path.join(debRoot, 'DEBIAN'))
    fs.writeFileSync(path.join(debRoot, 'DEBIAN', 'control'), debControl({ ...info, installedKb: kilobytes(debRoot) }))
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', debRoot, path.join(dist, debName)])

    // For trying the .deb on a machine without rpmbuild. A release cannot be made this way: the
    // manifest step requires both files.
    if (process.argv.includes('--deb-only')) { console.log(debName); process.exit(0) }

    const rpmRoot = stage(work, 'rpm', node, info)
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
