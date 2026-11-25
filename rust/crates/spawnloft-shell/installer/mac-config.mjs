// Writes what one macOS build needs beside the base tauri.conf.json, into <out dir>:
//   overlay.json   passed to `tauri build --config`
//   bin/           the `spawnloft` and `mcctl` forwarders at 1.x's path, Contents/Resources/bin/
//   Squirrel.framework  the ShipIt stand-in (mac-shipit/ShipIt.c) that reopens the app after 1.x's
//                  Squirrel.Mac swapped in this bundle, at Contents/Frameworks/; signed here with
//                  $SIGNING_IDENTITY (and $KEYCHAIN) when set, as the core is before `tauri build`
//
//   node mac-config.mjs <version> <pubkey file> <out dir> [--feed-http] [--icons=<dir>]
//
// The bundle carries the shell, the core, those forwarders and the licence
// (Contents/Resources/resources/LICENSE): no Node and no Node core since C10
// (rust/PLAN-CORE-PORT.md 5.1), so nothing in it is signed with JIT entitlements. An update
// replaces the bundle whole, so nothing of an older build's resources/runtime or core is left.
//
// The base tauri.conf.json stays buildable with plain `cargo build`; everything that needs a
// built core binary, a signing key, a macOS icon or a test feed is added here. The macOS layout
// matches Windows and Linux: the Rust core sits at Contents/Resources/resources/bin/spawnloft-core
// (NOT externalBin, which would move it to Contents/MacOS and change the path the shell, the task
// shims, the server launchers and the MCP configs share). The core is signed separately before
// `tauri build`; `tauri build` signs, notarizes and staples the app (design section 6, D8).
//
// Paths in `resources` are relative to rust/crates/spawnloft-shell or absolute.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBuildVersion } from './build-version.mjs'

const args = process.argv.slice(2)
const feedHttp = args.includes('--feed-http')
const iconsArg = args.find((a) => a.startsWith('--icons='))
const [version, pubkeyFile, outDir] = args.filter((a) => !a.startsWith('--'))
if (!version || !pubkeyFile || !outDir) {
  console.error('usage: node mac-config.mjs <version> <pubkey file> <out dir> [--feed-http] [--icons=<dir>]')
  process.exit(64)
}
if (process.platform !== 'darwin') {
  console.error('mac-config.mjs builds the macOS app; run it on macOS')
  process.exit(64)
}
checkBuildVersion(version)

const shell = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = resolve(shell, '../../target/release/spawnloft-core')
if (!existsSync(core)) {
  console.error(`${core} is missing: cargo build --release -p spawnloft-core first`)
  process.exit(66)
}
const out = resolve(outDir)
mkdirSync(out, { recursive: true })

// `spawnloft` and `mcctl` in a terminal, at 1.x's Contents/Resources/bin/ (CLI.md): the core
// binary in Contents/Resources/resources/bin/
mkdirSync(join(out, 'bin'), { recursive: true })
const forwarder = `#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
exec "$SCRIPT_DIR/../resources/bin/spawnloft-core" "$@"
`
for (const name of ['spawnloft', 'mcctl']) writeFileSync(join(out, 'bin', name), forwarder, { mode: 0o755 })

// Squirrel.framework, for the 1.x -> 2.0 relaunch (mac-shipit/ShipIt.c): 1.x's ShipIt runs
// <app>/Contents/Frameworks/Squirrel.framework/Resources/ShipIt inside the new bundle to open it.
// A real versioned framework (Versions/A, Current, and the top-level symlinks), because codesign
// seals anything under Contents/Frameworks as nested code. Tauri copies it (symlinks kept) and
// signs the framework; ShipIt sits in Resources, which Tauri does not sign, so both binaries are
// signed here first, with the hardened runtime and a timestamp, as notarization wants.
const shipitSrc = resolve(dirname(fileURLToPath(import.meta.url)), 'mac-shipit')
const framework = join(out, 'Squirrel.framework')
rmSync(framework, { recursive: true, force: true })
const versionA = join(framework, 'Versions', 'A')
mkdirSync(join(versionA, 'Resources'), { recursive: true })
const clang = (...a) => execFileSync('/usr/bin/xcrun', ['clang', '-O2', '-arch', 'arm64', '-mmacosx-version-min=13.0', ...a], { stdio: 'inherit' })
clang('-o', join(versionA, 'Resources', 'ShipIt'), join(shipitSrc, 'ShipIt.c'))
clang('-dynamiclib', '-install_name', '@rpath/Squirrel.framework/Versions/A/Squirrel', '-o', join(versionA, 'Squirrel'), join(shipitSrc, 'Squirrel.c'))
writeFileSync(join(versionA, 'Resources', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Squirrel</string>
  <key>CFBundleIdentifier</key><string>io.github.joogiebear.mcctl.shipit</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Squirrel</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>${version.split('-')[0]}</string>
  <key>CFBundleVersion</key><string>${version}</string>
</dict>
</plist>
`)
symlinkSync('A', join(framework, 'Versions', 'Current'))
symlinkSync('Versions/Current/Squirrel', join(framework, 'Squirrel'))
symlinkSync('Versions/Current/Resources', join(framework, 'Resources'))
const identity = process.env.SIGNING_IDENTITY
if (identity) {
  const keychain = process.env.KEYCHAIN ? ['--keychain', process.env.KEYCHAIN] : []
  const sign = (target, runtime) => execFileSync('/usr/bin/codesign', ['--force', ...(runtime ? ['--options', 'runtime'] : []), '--timestamp', '--sign', identity, ...keychain, target], { stdio: 'inherit' })
  sign(join(versionA, 'Resources', 'ShipIt'), true)
  sign(join(versionA, 'Squirrel'), false)
  sign(framework, false)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', framework], { stdio: 'inherit' })
}

// a macOS .app bundle needs an .icns; the workflow generates one with `tauri icon` and passes its
// folder, otherwise the base PNG icons are kept (plain `cargo build` does not bundle)
const icon = iconsArg
  ? [join(resolve(iconsArg.slice('--icons='.length)), 'icon.icns'), join(resolve(iconsArg.slice('--icons='.length)), 'icon.png')]
  : undefined

const overlay = {
  version,
  bundle: {
    createUpdaterArtifacts: true,
    ...(icon ? { icon } : {}),
    macOS: {
      // macOS 13: the panel's container queries and :has() want its WebKit (README: macOS 13+)
      minimumSystemVersion: '13.0',
      hardenedRuntime: true,
      frameworks: [framework],
    },
    resources: {
      [core]: 'resources/bin/spawnloft-core',
      [join(out, 'bin', 'spawnloft')]: 'bin/spawnloft',
      [join(out, 'bin', 'mcctl')]: 'bin/mcctl',
      '../../../LICENSE': 'resources/LICENSE',
    },
  },
  plugins: {
    updater: {
      // the plugin base64-decodes `pubkey`; accept either the base64 the CLI's .pub holds or the
      // decoded two-line minisign file (UPDATER-KEYS.md release.pub), emitting the base64 form
      pubkey: (text => (text.includes('\n') ? Buffer.from(text.trimEnd() + '\n').toString('base64') : text.trim()))(readFileSync(pubkeyFile, 'utf8')),
      // test feeds are a loopback HTTP server; a release feed is HTTPS
      ...(feedHttp ? { dangerousInsecureTransportProtocol: true } : {}),
    },
  },
}
writeFileSync(join(out, 'overlay.json'), JSON.stringify(overlay, null, 2))
console.log(`wrote ${join(out, 'overlay.json')} for ${version}`)
