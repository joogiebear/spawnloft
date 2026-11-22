// Writes what one macOS build needs beside the base tauri.conf.json, into <out dir>:
//   overlay.json   passed to `tauri build --config`
//   bin/           the `spawnloft` and `mcctl` forwarders at 1.x's path, Contents/Resources/bin/
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      minimumSystemVersion: '11.0',
      hardenedRuntime: true,
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
