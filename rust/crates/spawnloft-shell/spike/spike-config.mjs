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
    // paths are relative to rust/crates/spawnloft-shell; the core binary sits where 1.x's layout
    // has it (resources\bin\spawnloft-core.exe). There is no Node core to carry since C10: the
    // shell hands 1.x's `... resources\core\mcctl.mjs <command>` form to the core.
    resources: {
      [`../../target/release/${exe}`]: `resources/bin/${exe}`,
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
