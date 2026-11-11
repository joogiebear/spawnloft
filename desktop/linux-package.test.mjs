// The 2.0 Linux desktop packages (rust/crates/spawnloft-shell/installer/linux-package.mjs) and the
// 2.x command-line package: names, layout and metadata. Building them needs dpkg-deb and rpmbuild
// and runs in installer-linux.yml; these checks run everywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  desktopPackageNames, layout, debControl, rpmSpec, glibcFloor, elfArch, debPostrm, forwarder,
  USR_BIN, DESKTOP_ENTRY, CORE, INSTALL_DIR, overlay,
} from '../rust/crates/spawnloft-shell/installer/linux-package.mjs'
import { releaseNames } from './release-feed.mjs'
import { cliPackageNames, isTwoX, runtimeJson, WRAPPER_2X, NODE_VERSION } from './build-cli-package.mjs'

const V = '2.0.0-beta.3'

test('package names are the ones release-feed and the envelope expect', () => {
  const names = releaseNames(V)
  assert.deepEqual(desktopPackageNames({ arch: 'x64', version: V }), [names.deb.name, names.rpm.name])
  assert.deepEqual(desktopPackageNames({ arch: 'arm64', version: V }), [names['deb-arm64'].name, names['rpm-arm64'].name])
  // the workflows' glob SpawnLoft-*-linux-<arch>.deb must not also match the CLI package
  for (const n of cliPackageNames({ arch: 'x64', version: V })) assert.ok(!n.startsWith('SpawnLoft-'))
})

test('the layout keeps both 1.x paths and differs between deb and rpm only in package-type', () => {
  const args = { version: V, info: { version: V }, shell: '/b/SpawnLoft', core: '/b/spawnloft-core' }
  const deb = layout({ kind: 'deb', ...args })
  const rpm = layout({ kind: 'rpm', ...args })
  const paths = deb.map(([p]) => p)
  // what 1.x's .desktop entry, electron-updater's relaunch and task shims run
  assert.ok(paths.includes(`${INSTALL_DIR}/spawnloft-desktop`))
  assert.equal(deb.find(([p]) => p === `${INSTALL_DIR}/spawnloft-desktop`)[1].from, '/b/SpawnLoft')
  // what /usr/bin/spawnloft execed in 1.x and what MCP configs may hold
  assert.ok(paths.includes(`${INSTALL_DIR}/resources/bin/spawnloft`))
  assert.ok(paths.includes(`${INSTALL_DIR}/resources/bin/mcctl`))
  assert.ok(paths.includes(CORE))
  assert.ok(paths.includes('/usr/bin/spawnloft'))
  assert.ok(paths.includes('/usr/share/applications/spawnloft-desktop.desktop'))
  // /usr/bin/spawnloft-desktop is an alternatives link made after install, never a packaged file
  assert.ok(!paths.includes('/usr/bin/spawnloft-desktop'))
  assert.ok(!paths.some(p => p.includes('/runtime')), 'no runtime without --runtime')
  assert.ok(layout({ kind: 'deb', ...args, runtime: '/r' }).some(([p, s]) => p === `${INSTALL_DIR}/resources/runtime` && s.tree === '/r'))
  const marker = files => files.find(([p]) => p.endsWith('/package-type'))[1].text
  assert.equal(marker(deb), 'deb')
  assert.equal(marker(rpm), 'rpm')
  assert.deepEqual(rpm.map(([p]) => p), paths)
  const pkgJson = JSON.parse(deb.find(([p]) => p.endsWith('/resources/core/package.json'))[1].text)
  assert.equal(pkgJson.version, V)
})

test('every command-line entry runs the core', () => {
  assert.match(USR_BIN, new RegExp(`^exec ${CORE} "\\$@"$`, 'm'))
  for (const name of ['spawnloft', 'mcctl']) assert.match(forwarder(name), new RegExp(`^exec ${CORE} "\\$@"$`, 'm'))
  assert.match(DESKTOP_ENTRY, /^Exec=\/opt\/SpawnLoft\/spawnloft-desktop %U$/m)
  assert.match(DESKTOP_ENTRY, /^StartupWMClass=spawnloft-desktop$/m)
})

test('package metadata: same name as 1.x, tilde prerelease, conflicts with the CLI package', () => {
  const control = debControl({ version: V, arch: 'arm64', installedKb: 10, glibc: '2.35' })
  assert.match(control, /^Package: spawnloft$/m)
  assert.match(control, /^Version: 2\.0\.0~beta\.3$/m)
  assert.match(control, /^Architecture: arm64$/m)
  assert.match(control, /^Depends: libc6 \(>= 2\.35\), libwebkit2gtk-4\.1-0, libgtk-3-0, /m)
  assert.match(control, /^Conflicts: spawnloft-cli$/m)
  const spec = rpmSpec({ version: V, staging: '/s', glibc: '2.35' })
  assert.match(spec, /^Name: spawnloft$/m)
  assert.match(spec, /^Version: 2\.0\.0~beta\.3$/m)
  assert.match(spec, /^Requires: glibc >= 2\.35, webkit2gtk4\.1, gtk3, /m)
  assert.match(spec, /^Conflicts: spawnloft-cli$/m)
  // after the old package's %postun, which removes 1.x's alternatives link
  assert.match(spec, /^%posttrans\n.*--install \/usr\/bin\/spawnloft-desktop spawnloft-desktop \/opt\/SpawnLoft\/spawnloft-desktop 100/ms)
  assert.match(spec, /^%preun\nif \[ "\$1" -eq 0 \]; then\n/m)
  // the deb removal script leaves the link alone on an upgrade
  assert.match(debPostrm(), /remove\|purge\) ;;\n {2}\*\) exit 0 ;;/)
})

test('glibc floor is the highest GLIBC_ symbol version referenced', () => {
  const bin = Buffer.from('\0GLIBC_2.17\0xx\0GLIBC_2.34\0GLIBC_2.4\0GLIBC_PRIVATE\0GLIBC_2.28\0')
  assert.equal(glibcFloor([bin]), '2.34')
  assert.equal(glibcFloor([Buffer.from('static')]), '2.17')
  assert.equal(glibcFloor([bin, Buffer.from('\0GLIBC_2.35\0')]), '2.35')
})

test('ELF machine check', () => {
  const elf = machine => { const b = Buffer.alloc(64); b.writeUInt32BE(0x7f454c46, 0); b.writeUInt16LE(machine, 18); return b }
  assert.equal(elfArch(elf(0x3e)), 'x64')
  assert.equal(elfArch(elf(0xb7)), 'arm64')
  assert.equal(elfArch(Buffer.from('MZ')), null)
})

test('the overlay carries the version and the updater key in the plugin\'s base64 form', () => {
  const two = 'untrusted comment: minisign public key: 1D6FA7724F159315\nRWQVkxVPcqdvHbvBfjZVJEFH+NZIDDnnOEzIFpjLDcgnbP0ex5p7+VJd\n'
  const o = overlay(V, two)
  assert.equal(o.version, V)
  assert.equal(Buffer.from(o.plugins.updater.pubkey, 'base64').toString('utf8'), two)
  assert.equal(overlay(V, ' abc ').plugins.updater.pubkey, 'abc')
})

test('the 2.x command-line package runs the core and names the runtime as the desktop packages do', () => {
  assert.ok(isTwoX('2.0.0-beta.1') && isTwoX('2.0.0-internal.5') && !isTwoX('1.6.0-beta.413'))
  assert.match(WRAPPER_2X, /^exec \/opt\/spawnloft-cli\/bin\/spawnloft-core "\$@"$/m)
  assert.deepEqual(JSON.parse(runtimeJson()), { node: NODE_VERSION, exe: `node-${NODE_VERSION}/bin/node` })
})

test('the release gate reads each Linux package against its release name', async () => {
  const { expectedLinuxPackage, linuxPackageProblems } = await import('./release-gate.mjs')
  assert.deepEqual(expectedLinuxPackage(`SpawnLoft-${V}-linux-arm64.deb`, V), { package: 'spawnloft', version: '2.0.0~beta.3', arch: 'arm64', kind: 'deb', desktop: true })
  assert.equal(expectedLinuxPackage(`spawnloft-cli-${V}-linux-x86_64.rpm`, V).package, 'spawnloft-cli')
  assert.equal(expectedLinuxPackage(`SpawnLoft-2.0.0-beta.2-linux-arm64.deb`, V), null)
  const deb = (fields, listing) => (cmd, args) => (args[0] === '-f' ? fields : listing)
  const good = ['drwxr-xr-x root/root 0 2026-11-11 02:12 ./opt/SpawnLoft/', '-rwxr-xr-x root/root 9 2026-11-11 02:12 ./opt/SpawnLoft/spawnloft-desktop',
    '-rwxr-xr-x root/root 9 2026-11-11 02:12 ./opt/SpawnLoft/resources/bin/spawnloft', '-rwxr-xr-x root/root 9 2026-11-11 02:12 ./usr/bin/spawnloft'].join('\n')
  assert.deepEqual(linuxPackageProblems('f', `SpawnLoft-${V}-linux-arm64.deb`, V, deb('Package: spawnloft\nVersion: 2.0.0~beta.3\nArchitecture: arm64\n', good)), [])
  // an x64 build under the arm64 name, a hyphenated version, a missing 1.x path: each is refused
  const bad = linuxPackageProblems('f', `SpawnLoft-${V}-linux-arm64.deb`, V, deb('Package: spawn-loft\nVersion: 2.0.0-beta.3\nArchitecture: amd64\n', good.split('\n').slice(0, 2).join('\n')))
  assert.equal(bad.length, 5)
  const rpm = (cmd, args) => (args[0] === '-qp' ? 'spawnloft-cli\n2.0.0~beta.3\naarch64\n' : '/opt/spawnloft-cli/bin/spawnloft-core\n/usr/bin/spawnloft\n')
  assert.deepEqual(linuxPackageProblems('f', `spawnloft-cli-${V}-linux-aarch64.rpm`, V, rpm), [])
})
