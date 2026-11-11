#!/usr/bin/env node
// The 2.0 Linux desktop packages (rust/INSTALLER-UPDATER-DESIGN.md 5.7): `spawnloft` as a .deb
// and an .rpm, built with dpkg-deb and rpmbuild from a built shell and core, on the 1.x layout.
//
//   node linux-package.mjs config <version> <pubkey file> <out dir>
//       writes <out dir>/overlay.json for `tauri build --no-bundle --config` (version, updater key)
//   node linux-package.mjs package --version <v> --arch x64|arm64 --shell <SpawnLoft binary>
//       --core <spawnloft-core> --out <dir> [--runtime <dir>] [--commit <sha>] [--deb-only]
//       writes SpawnLoft-<v>-linux-<deb arch>.deb, SpawnLoft-<v>-linux-<rpm arch>.rpm and
//       build-info.json into <dir>
//
// Why not the Tauri bundler's deb/rpm targets (checked against tauri-bundler 2.10.4, the one
// @tauri-apps/cli 2.12.4 carries): it names the package after the kebab-cased product name
// (`spawn-loft`, so it would install beside 1.x's `spawnloft` instead of upgrading it), puts the
// binary in /usr/bin and the resources in /usr/lib/SpawnLoft (1.x's paths are under /opt/SpawnLoft
// and are what 1.x task shims, MCP configs and electron-updater's relaunch name), and writes the
// semver prerelease into the rpm Version as-is. So `tauri build --no-bundle` builds the shell
// (frontend, custom protocol and config compiled in, exactly as a bundled build) and this script
// lays out the files and writes the package metadata, as desktop/build-cli-package.mjs does for
// the command-line package.
//
// The layout keeps every path 1.x installs and other programs remember:
//   /opt/SpawnLoft/spawnloft-desktop             the shell (1.x: Electron), what the .desktop entry,
//                                                electron-updater's relaunch and 1.x task shims run
//   /opt/SpawnLoft/resources/bin/spawnloft-core  the Rust core
//   /opt/SpawnLoft/resources/bin/spawnloft       1.x's command-line launchers, now forwarders to
//   /opt/SpawnLoft/resources/bin/mcctl           the core (design A4 / Q-W)
//   /opt/SpawnLoft/resources/core/...            the Node core (until 2.1)
//   /opt/SpawnLoft/resources/runtime/...         the bundled Node runtime (W1), when --runtime
//   /opt/SpawnLoft/resources/package-type        deb | rpm: how 1.x's updater, and the core's,
//                                                tell which kind of install this is
//   /usr/bin/spawnloft                           runs the core
//   /usr/share/applications/spawnloft-desktop.desktop, the 256px icon: same names as 1.x
// /usr/bin/spawnloft-desktop is an update-alternatives link, as 1.x made it; it is not a packaged
// file because 1.x's own removal script deletes that path during the upgrade (deb: before our
// postinst; rpm: after our %post, hence %posttrans), through update-alternatives --remove.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packageVersion } from '../../../../desktop/build-cli-package.mjs'
import { setPackageVersion } from '../../../../desktop/set-version.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../../..')

export const PACKAGE = 'spawnloft'
export const INSTALL_DIR = '/opt/SpawnLoft'
export const EXECUTABLE = 'spawnloft-desktop'
export const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
export const RPM_ARCH = { x64: 'x86_64', arm64: 'aarch64' }

// Kept in step with desktop/release-feed.mjs releaseNames and update-envelope.mjs artifactTargets.
export const desktopPackageNames = ({ arch, version }) => [
  `SpawnLoft-${version}-linux-${DEB_ARCH[arch]}.deb`,
  `SpawnLoft-${version}-linux-${RPM_ARCH[arch]}.rpm`,
]

export const CORE = `${INSTALL_DIR}/resources/bin/spawnloft-core`

export const USR_BIN = `#!/bin/sh
# /usr/bin/spawnloft: the command line. The Rust core runs it, forwarding what it does not own yet
# to the Node core on the runtime this package carries. No Node needed on PATH.
exec ${CORE} "$@"
`

// 1.x wrote these paths into PATH entries, MCP configs and scripts of its users (CLI.md).
export const forwarder = name => `#!/bin/sh
# ${INSTALL_DIR}/resources/bin/${name}: the command-line path 1.x installed, kept for everything that
# remembers it. Runs the core.
exec ${CORE} "$@"
`

export const DESKTOP_ENTRY = `[Desktop Entry]
Name=SpawnLoft
Exec=${INSTALL_DIR}/${EXECUTABLE} %U
Terminal=false
Type=Application
Icon=${EXECUTABLE}
StartupWMClass=${EXECUTABLE}
Keywords=minecraft;server;paper;spigot;
Comment=Minecraft servers on your own PC, without the terminal
Categories=Utility;
`

const SUMMARY = 'Minecraft servers on your own PC, without the terminal'
const DESCRIPTION = [
  'SpawnLoft creates and runs Minecraft servers on your own machine: Paper, Purpur, Fabric,',
  'Forge and more, with backups, schedules, plugins, managed MySQL and Redis, and a launcher.',
  'Everything stays local. This package carries the desktop app and the spawnloft command;',
  'spawnloft-cli is the command line alone, for a machine with no screen. Install one or the other.',
]

// After the files are in place (deb postinst configure; rpm %posttrans, which runs after the old
// package's %postun has removed its own link). `update-alternatives` is Debian's name; Fedora and
// RHEL have `alternatives` with the same arguments.
export const AFTER_INSTALL = `ua=update-alternatives
command -v "$ua" >/dev/null 2>&1 || ua=alternatives
if command -v "$ua" >/dev/null 2>&1; then
  "$ua" --install /usr/bin/${EXECUTABLE} ${EXECUTABLE} ${INSTALL_DIR}/${EXECUTABLE} 100 >/dev/null 2>&1 || ln -sf ${INSTALL_DIR}/${EXECUTABLE} /usr/bin/${EXECUTABLE}
else
  ln -sf ${INSTALL_DIR}/${EXECUTABLE} /usr/bin/${EXECUTABLE}
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
exit 0
`

// On removal only (never on an upgrade, where the next version keeps the link).
export const ON_REMOVE = `ua=update-alternatives
command -v "$ua" >/dev/null 2>&1 || ua=alternatives
if command -v "$ua" >/dev/null 2>&1; then
  "$ua" --remove ${EXECUTABLE} ${INSTALL_DIR}/${EXECUTABLE} >/dev/null 2>&1 || true
fi
# the ln -s fallback (no alternatives tool): ours when it points at the app; on rpm this runs in
# %preun, while the app is still there, so test the target rather than whether it resolves
if [ -L /usr/bin/${EXECUTABLE} ] && [ "$(readlink /usr/bin/${EXECUTABLE})" = ${INSTALL_DIR}/${EXECUTABLE} ]; then rm -f /usr/bin/${EXECUTABLE}; fi
exit 0
`

export const debPostinst = () => `#!/bin/sh
set -e
${AFTER_INSTALL}`

export const debPostrm = () => `#!/bin/sh
case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac
${ON_REMOVE}`

// The lowest glibc the binaries need, from the versioned symbols they reference (GLIBC_2.x).
// The shell is built on the oldest supported distribution, so this is the honest floor.
export function glibcFloor(buffers) {
  let best = [2, 17]
  for (const buf of buffers) {
    for (const m of buf.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)(?:\.\d+)?\0/g)) {
      const v = [Number(m[1]), Number(m[2])]
      if (v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v
    }
  }
  return best.join('.')
}

export function debControl({ version, arch, installedKb, glibc }) {
  return [
    `Package: ${PACKAGE}`,
    `Version: ${packageVersion(version)}`,
    `Architecture: ${DEB_ARCH[arch]}`,
    'Maintainer: joogiebear <joogiebear@protonmail.com>',
    `Installed-Size: ${installedKb}`,
    // the window (WebKitGTK 4.1, GTK 3: Ubuntu 22.04 / Debian 12 and later), the bundled Node
    // (libstdc++), what unpacking a database engine shells out to, and opening links
    `Depends: libc6 (>= ${glibc}), libwebkit2gtk-4.1-0, libgtk-3-0, libstdc++6, libgcc-s1, tar, xz-utils, xdg-utils`,
    'Conflicts: spawnloft-cli',
    'Section: utils',
    'Priority: optional',
    'Homepage: https://github.com/joogiebear/spawnloft',
    `Description: ${SUMMARY}`,
    ...DESCRIPTION.map(line => ` ${line}`),
    '',
  ].join('\n')
}

export function rpmSpec({ version, staging, glibc }) {
  return [
    `Name: ${PACKAGE}`,
    `Version: ${packageVersion(version)}`,
    'Release: 1',
    `Summary: ${SUMMARY}`,
    'License: MIT',
    'URL: https://github.com/joogiebear/spawnloft',
    // prebuilt binaries and text: no stripping, dependency scanning or debuginfo
    'AutoReqProv: no',
    `Requires: glibc >= ${glibc}, webkit2gtk4.1, gtk3, libstdc++, tar, xz, xdg-utils`,
    'Conflicts: spawnloft-cli',
    '%define debug_package %{nil}',
    '%define __os_install_post %{nil}',
    '%define _build_id_links none',
    '%define _binary_payload w6.xzdio',
    '%description',
    ...DESCRIPTION,
    '%install',
    `cp -a "${staging}/." "%{buildroot}/"`,
    '%posttrans',
    AFTER_INSTALL.trimEnd(),
    '%preun',
    // $1 is 0 when the package is being removed, 1 or more on an upgrade
    'if [ "$1" -eq 0 ]; then',
    ON_REMOVE.trimEnd().replace(/\nexit 0$/, ''),
    'fi',
    'exit 0',
    '%files',
    `%attr(-, root, root) ${INSTALL_DIR}`,
    '%attr(0755, root, root) /usr/bin/spawnloft',
    `%attr(0644, root, root) /usr/share/applications/${EXECUTABLE}.desktop`,
    `%attr(0644, root, root) /usr/share/icons/hicolor/256x256/apps/${EXECUTABLE}.png`,
    '',
  ].join('\n')
}

// Every file the package installs, as [path inside the package, { from | text, mode }]. One list
// for both kinds, so the .deb and the .rpm cannot drift apart; only package-type differs.
export function layout({ kind, version, info, shell, core, runtime }) {
  const files = []
  const add = (to, spec) => files.push([to, spec])
  add(`${INSTALL_DIR}/${EXECUTABLE}`, { from: shell, mode: 0o755 })
  add(CORE, { from: core, mode: 0o755 })
  for (const name of ['spawnloft', 'mcctl']) add(`${INSTALL_DIR}/resources/bin/${name}`, { text: forwarder(name), mode: 0o755 })
  for (const file of ['mcctl.mjs', 'spawnloft.mjs', 'LICENSE']) add(`${INSTALL_DIR}/resources/core/${file}`, { from: path.join(ROOT, file), mode: 0o644 })
  add(`${INSTALL_DIR}/resources/core/package.json`, {
    text: setPackageVersion(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), version).text,
    mode: 0o644,
  })
  add(`${INSTALL_DIR}/resources/core/src`, { tree: path.join(ROOT, 'src') })
  // the Node core starts Rust daemons (design 2.3, until R4), as the Windows and macOS builds do
  add(`${INSTALL_DIR}/resources/core/internal-defaults.json`, { text: JSON.stringify({ daemon: 'rust' }, null, 2) + '\n', mode: 0o644 })
  if (runtime) add(`${INSTALL_DIR}/resources/runtime`, { tree: runtime })
  add(`${INSTALL_DIR}/resources/package-type`, { text: kind, mode: 0o644 })
  add(`${INSTALL_DIR}/resources/build-info.json`, { text: JSON.stringify({ ...info, package: PACKAGE, kind }, null, 2) + '\n', mode: 0o644 })
  add(`${INSTALL_DIR}/resources/icon.png`, { from: path.join(ROOT, 'desktop/build/icon.png'), mode: 0o644 })
  add('/usr/bin/spawnloft', { text: USR_BIN, mode: 0o755 })
  add(`/usr/share/applications/${EXECUTABLE}.desktop`, { text: DESKTOP_ENTRY, mode: 0o644 })
  add(`/usr/share/icons/hicolor/256x256/apps/${EXECUTABLE}.png`, { from: path.join(ROOT, 'desktop/build/icon.png'), mode: 0o644 })
  return files
}

function stage(root, files) {
  for (const [to, spec] of files) {
    const dest = path.join(root, to)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (spec.tree) {
      // a tree keeps its own modes (the runtime's node is executable); symlinks stay symlinks
      fs.cpSync(spec.tree, dest, { recursive: true, verbatimSymlinks: true })
      continue
    }
    if (spec.from) fs.copyFileSync(spec.from, dest)
    else fs.writeFileSync(dest, spec.text)
    fs.chmodSync(dest, spec.mode)
  }
  // directories 0755 whatever the umask said
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755)
  }
  fs.chmodSync(root, 0o755)
}

function kilobytes(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size
  }
  return Math.ceil(bytes / 1024)
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (res.error) throw new Error(`${cmd} could not be run: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`)
}

// The ELF machine of a binary, so an x64 shell never lands in an arm64 package.
export function elfArch(buf) {
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x7f454c46) return null
  const machine = buf.readUInt16LE(18)
  return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `machine-${machine}`
}

export function buildPackages(opts) {
  const { version, arch, shell, core, out, runtime, debOnly } = opts
  if (!DEB_ARCH[arch]) throw new Error(`--arch must be x64 or arm64, not ${arch}`)
  for (const [what, file] of [['shell', shell], ['core', core]]) {
    if (!file || !fs.existsSync(file)) throw new Error(`--${what} ${file ?? ''} does not exist`)
    const found = elfArch(fs.readFileSync(file))
    if (found !== arch) throw new Error(`${file} is a ${found ?? 'non-ELF'} binary, not ${arch}`)
  }
  if (runtime && !fs.existsSync(path.join(runtime, 'runtime.json'))) throw new Error(`${runtime} has no runtime.json`)
  const binaries = [shell]
  if (runtime) {
    const { exe } = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'))
    binaries.push(path.join(runtime, exe))
  }
  const glibc = glibcFloor(binaries.map(f => fs.readFileSync(f)))
  const info = {
    version,
    commit: opts.commit ?? null,
    shortCommit: opts.commit ? opts.commit.slice(0, 12) : null,
    builtAt: opts.builtAt ?? new Date().toISOString(),
    platform: 'linux',
    arch,
  }
  fs.mkdirSync(out, { recursive: true })
  // read by build-cli-package.mjs, so the command-line packages carry the same identity
  fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
  const [debName, rpmName] = desktopPackageNames({ arch, version })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-pkg-'))
  try {
    const debRoot = path.join(work, 'root-deb')
    stage(debRoot, layout({ kind: 'deb', version, info, shell, core, runtime }))
    const control = path.join(debRoot, 'DEBIAN')
    fs.mkdirSync(control)
    fs.writeFileSync(path.join(control, 'control'), debControl({ version, arch, installedKb: kilobytes(debRoot), glibc }))
    fs.writeFileSync(path.join(control, 'postinst'), debPostinst(), { mode: 0o755 })
    fs.writeFileSync(path.join(control, 'postrm'), debPostrm(), { mode: 0o755 })
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', debRoot, path.join(out, debName)])
    const built = [debName]
    if (!debOnly) {
      const rpmRoot = path.join(work, 'root-rpm')
      stage(rpmRoot, layout({ kind: 'rpm', version, info, shell, core, runtime }))
      const spec = path.join(work, `${PACKAGE}.spec`)
      fs.writeFileSync(spec, rpmSpec({ version, staging: rpmRoot, glibc }))
      const rpms = path.join(work, 'rpms')
      run('rpmbuild', ['-bb', spec, '--target', RPM_ARCH[arch], '--define', `_topdir ${path.join(work, 'rpmbuild')}`,
        '--define', `_rpmdir ${rpms}`, '--define', `_rpmfilename ${rpmName}`])
      fs.copyFileSync(path.join(rpms, rpmName), path.join(out, rpmName))
      built.push(rpmName)
    }
    for (const name of built) console.log(`${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1).padStart(6)} MB  ${name}  (glibc >= ${glibc})`)
    return built.map(name => path.join(out, name))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

export function overlay(version, pubkeyText) {
  return {
    version,
    plugins: {
      updater: {
        // the plugin base64-decodes `pubkey`; accept the CLI's base64 .pub or the two-line file
        pubkey: pubkeyText.includes('\n') ? Buffer.from(pubkeyText.trimEnd() + '\n').toString('base64') : pubkeyText.trim(),
      },
    },
  }
}

function parsePackageArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--version': out.version = value(); break
      case '--arch': out.arch = value(); break
      case '--shell': out.shell = path.resolve(value()); break
      case '--core': out.core = path.resolve(value()); break
      case '--out': out.out = path.resolve(value()); break
      case '--runtime': out.runtime = path.resolve(value()); break
      case '--commit': out.commit = value(); break
      case '--deb-only': out.debOnly = true; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  for (const k of ['version', 'arch', 'shell', 'core', 'out']) if (!out[k]) throw new Error(`--${k} is required`)
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2)
    if (command === 'config') {
      const [version, pubkeyFile, outDir] = rest
      if (!version || !pubkeyFile || !outDir) throw new Error('usage: linux-package.mjs config <version> <pubkey file> <out dir>')
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'overlay.json'), JSON.stringify(overlay(version, fs.readFileSync(pubkeyFile, 'utf8')), null, 2))
      console.log(`wrote ${path.join(outDir, 'overlay.json')} for ${version}`)
    } else if (command === 'package') {
      if (process.platform !== 'linux') throw new Error('the Linux packages are built on Linux')
      buildPackages(parsePackageArgs(rest))
    } else {
      throw new Error('usage: linux-package.mjs config|package ...')
    }
  } catch (err) {
    console.error(`linux-package: ${err.message}`)
    process.exit(1)
  }
}
