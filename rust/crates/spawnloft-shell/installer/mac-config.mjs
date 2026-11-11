// Writes what one macOS build needs beside the base tauri.conf.json, into <out dir>:
//   overlay.json   passed to `tauri build --config`
//
//   node mac-config.mjs <version> <pubkey file> <out dir> [--feed-http] [--icons=<dir>]
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
import { writeCorePackage } from './core-package.mjs'

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

const shell = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = resolve(shell, '../../target/release/spawnloft-core')
if (!existsSync(core)) {
  console.error(`${core} is missing: cargo build --release -p spawnloft-core first`)
  process.exit(66)
}
const out = resolve(outDir)
mkdirSync(out, { recursive: true })

// the Node core's package.json, stamped with this build's version (the repository's says 1.x)
const corePackage = writeCorePackage(version, out)

// the Node core still starts Rust daemons on first launch until R4 (design 2.3), so it ships
// beside the Rust core, exactly as the Windows build does
const defaults = join(out, 'internal-defaults.json')
writeFileSync(defaults, JSON.stringify({ daemon: 'rust' }, null, 2) + '\n')

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
      '../../../mcctl.mjs': 'resources/core/mcctl.mjs',
      '../../../spawnloft.mjs': 'resources/core/spawnloft.mjs',
      [corePackage]: 'resources/core/package.json',
      '../../../src/': 'resources/core/src/',
      [defaults]: 'resources/core/internal-defaults.json',
    },
  },
  plugins: {
    updater: {
      pubkey: readFileSync(pubkeyFile, 'utf8').trim(),
      // test feeds are a loopback HTTP server; a release feed is HTTPS
      ...(feedHttp ? { dangerousInsecureTransportProtocol: true } : {}),
    },
  },
}
writeFileSync(join(out, 'overlay.json'), JSON.stringify(overlay, null, 2))
console.log(`wrote ${join(out, 'overlay.json')} for ${version}`)
