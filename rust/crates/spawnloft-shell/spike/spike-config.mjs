// Writes the tauri.conf.json overlay for one spike build (passed to `tauri build --config`).
//   node spike-config.mjs <version> <pubkey file> <out.json>
// The base tauri.conf.json stays buildable with plain `cargo build`; everything that needs a
// built core binary, a signing key or a test feed is added here.
import { readFileSync, writeFileSync } from 'node:fs'

const [version, pubkeyFile, out] = process.argv.slice(2)
if (!version || !pubkeyFile || !out) {
  console.error('usage: node spike-config.mjs <version> <pubkey file> <out.json>')
  process.exit(64)
}
const exe = process.platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core'
const overlay = {
  version,
  bundle: {
    createUpdaterArtifacts: true,
    // paths are relative to rust/crates/spawnloft-shell; the layout under the install folder is
    // the one 1.x has (resources\bin\spawnloft-core.exe, resources\core\mcctl.mjs), so task
    // shims, server launchers and MCP configs written by 1.x find the same files
    resources: {
      [`../../target/release/${exe}`]: `resources/bin/${exe}`,
      '../../../mcctl.mjs': 'resources/core/mcctl.mjs',
      '../../../spawnloft.mjs': 'resources/core/spawnloft.mjs',
      '../../../package.json': 'resources/core/package.json',
      '../../../src/': 'resources/core/src/',
    },
  },
  plugins: {
    updater: {
      pubkey: readFileSync(pubkeyFile, 'utf8').trim(),
      // the spike's feed is a loopback HTTP server; a release feed is HTTPS
      dangerousInsecureTransportProtocol: true,
      windows: { installMode: 'passive' },
    },
  },
}
writeFileSync(out, JSON.stringify(overlay, null, 2))
console.log(`wrote ${out} for ${version}`)
