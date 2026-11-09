// Packages one notarized, stapled SpawnLoft.app into the two macOS update artifacts, from the one
// bundle (design section 6):
//   SpawnLoft-<v>-mac-arm64.zip  for Squirrel.Mac and 1.x's latest-mac.yml / beta-mac.yml
//   SpawnLoft.app.tar.gz + .sig  Tauri's own artifacts, for tauri-plugin-updater (2.x -> 2.y)
// and writes the feeds that point at them:
//   latest-mac.yml, beta-mac.yml   electron-updater generic feed (JSON is valid YAML)
//   latest-mac.json                tauri-plugin-updater manifest (url left relative; the caller
//                                  rewrites it to the release or loopback base)
//
// Both artifacts are verified by extracting and running `codesign --verify --deep --strict` before
// any feed is written, so a feed never points at an unsigned or damaged bundle.
//
//   node mac-package.mjs <app path> <version> <out dir>
//
// Apple Silicon is the only macOS architecture built (arm64 / darwin-aarch64).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import crypto from 'node:crypto'

const [appArg, version, outArg] = process.argv.slice(2)
if (!appArg || !version || !outArg) {
  console.error('usage: node mac-package.mjs <app path> <version> <out dir>')
  process.exit(64)
}
if (process.platform !== 'darwin') {
  console.error('mac-package.mjs runs on macOS')
  process.exit(64)
}
const app = resolve(appArg)
if (!app.endsWith('.app') || !existsSync(app)) {
  console.error(`not a .app bundle: ${app}`)
  process.exit(66)
}
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const ditto = (...args) => execFileSync('/usr/bin/ditto', args, { stdio: 'inherit' })
const codesignVerify = (target) => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { stdio: 'inherit' })
const sha512b64 = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64')
// guard against a stale bundle left in rust/target by the cache: both artifacts must be this build
function assertVersion(bundle) {
  const res = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  if (res !== version) throw new Error(`packaged bundle is version ${res}, expected ${version} - a stale build?`)
}

// 1. The Squirrel.Mac zip. --keepParent makes SpawnLoft.app the top entry, which both
// Squirrel.Mac and 1.x's updater expect; --sequesterRsrc matches electron-builder's zip.
const zipName = `SpawnLoft-${version}-mac-arm64.zip`
const zipPath = join(out, zipName)
ditto('-c', '-k', '--sequesterRsrc', '--keepParent', app, zipPath)

// extract it to a scratch folder and check the packaged bundle is intact and signed
const scratch = mkdtempSync(join(tmpdir(), 'sl-mac-pkg-'))
try {
  ditto('-x', '-k', zipPath, scratch)
  codesignVerify(join(scratch, 'SpawnLoft.app'))
  assertVersion(join(scratch, 'SpawnLoft.app'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// 2. Tauri's updater artifacts, produced beside the bundle by createUpdaterArtifacts:true.
const bundleDir = app.slice(0, app.lastIndexOf('/'))
const tarName = 'SpawnLoft.app.tar.gz'
const tar = join(bundleDir, tarName)
const sig = `${tar}.sig`
if (!existsSync(tar) || !existsSync(sig)) {
  console.error(`missing Tauri updater artifacts: ${tarName}(.sig) beside the bundle - build with bundle.createUpdaterArtifacts = true`)
  process.exit(66)
}
// check the tar unpacks to a signed bundle too
const scratch2 = mkdtempSync(join(tmpdir(), 'sl-mac-tar-'))
try {
  execFileSync('/usr/bin/tar', ['-xzf', tar, '-C', scratch2], { stdio: 'inherit' })
  codesignVerify(join(scratch2, 'SpawnLoft.app'))
  assertVersion(join(scratch2, 'SpawnLoft.app'))
} finally {
  rmSync(scratch2, { recursive: true, force: true })
}
const outTar = join(out, `SpawnLoft-${version}-mac-arm64.app.tar.gz`)
copyFileSync(tar, outTar)
copyFileSync(sig, `${outTar}.sig`)

// 3. The feeds, from the verified bytes only.
const zipBytes = readFileSync(zipPath)
const electronFeed = JSON.stringify({
  version,
  files: [{ url: zipName, sha512: sha512b64(zipBytes), size: zipBytes.length }],
  path: zipName,
  sha512: sha512b64(zipBytes),
}, null, 2) + '\n'
for (const name of ['beta-mac.yml', 'latest-mac.yml']) writeFileSync(join(out, name), electronFeed)

// the Tauri manifest; the url is a bare filename so the caller can host it anywhere
const tauriManifest = JSON.stringify({
  version,
  notes: `https://github.com/joogiebear/spawnloft/releases/tag/v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: readFileSync(`${outTar}.sig`, 'utf8').trim(),
      url: basename(outTar),
    },
  },
}, null, 2) + '\n'
writeFileSync(join(out, 'latest-mac.json'), tauriManifest)

console.log(`packaged ${version}:`)
for (const n of [zipName, basename(outTar), `${basename(outTar)}.sig`, 'beta-mac.yml', 'latest-mac.yml', 'latest-mac.json']) {
  console.log(`  ${n}`)
}
