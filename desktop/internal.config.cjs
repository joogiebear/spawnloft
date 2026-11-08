'use strict'

// Internal test builds of the v2 branch (PLAN-RUST-TAURI.md section 13). Built only by
// .github/workflows/rust-internal.yml, and by hand on Victor's machines:
//
//   INTERNAL_BUILD=<n> npx electron-builder --config internal.config.cjs --win --x64 --publish never
//
// What makes them internal:
// - version 2.0.0-internal.<n>, which no 1.x feed names and no 1.x install is ever offered;
// - no publish configuration, so electron-builder writes no app-update.yml and no latest*.yml;
// - the update check is off in the app itself (extraMetadata.spawnloft.updates, read by main.js);
// - unsigned on Windows and ad-hoc signed on the Mac: CI signing is only trusted on dev pushes;
// - the Rust core binary rides along at resources/bin/spawnloft-core(.exe), or
//   Contents/MacOS/spawnloft-core on the Mac (an executable under Contents/Resources breaks the
//   nested-code rules), staged first by stage-core.mjs into build/bin/<platform>-<arch>/.
const path = require('node:path')
const fs = require('node:fs')
const source = require('./package.json')

const build = process.env.INTERNAL_BUILD
if (!/^[1-9]\d*$/.test(build || '') || !Number.isSafeInteger(Number(build))) {
  throw new Error('INTERNAL_BUILD must be a positive number (the workflow run number)')
}
const version = `2.0.0-internal.${Number(build)}`

// electron-builder loads this once per run and every run here is native, so the binary staged for
// this machine is the one packaged
const platform = process.platform
const arch = process.env.INTERNAL_ARCH || process.arch
const exe = platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core'
const staged = path.join('build', 'bin', `${platform}-${arch}`, exe)
if (!fs.existsSync(path.join(__dirname, staged))) {
  throw new Error(`${staged} is missing: build the Rust core and run node stage-core.mjs first`)
}

// Internal builds run servers on the Rust daemon unless the tester says otherwise
// (SPAWNLOFT_DAEMON or "daemon" in settings.json win): read by src/daemon-launch.mjs from
// resources/core/internal-defaults.json, a file 1.x builds never have.
const defaults = path.join('build', 'internal-defaults.json')
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true })
fs.writeFileSync(path.join(__dirname, defaults), JSON.stringify({ daemon: 'rust' }) + '\n')

const win = { ...source.build.win }
delete win.azureSignOptions
win.extraResources = [{ from: staged, to: `bin/${exe}` }]

const linux = {
  ...source.build.linux,
  extraResources: [...(source.build.linux.extraResources || []), { from: staged, to: `bin/${exe}` }],
}

module.exports = {
  ...source.build,
  // Not a release, so nothing to publish to; also stops app-update.yml being written.
  publish: null,
  extraResources: [...(source.build.extraResources || []), { from: defaults, to: 'core/internal-defaults.json' }],
  extraMetadata: { version, spawnloft: { channel: 'internal', updates: 'off' } },
  win,
  linux,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.utilities',
    icon: 'build/icon-mac.png',
    minimumSystemVersion: '13.0',
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    extraFiles: [{ from: staged, to: `MacOS/${exe}` }],
    artifactName: 'SpawnLoft-${version}-mac-${arch}.${ext}',
  },
}
