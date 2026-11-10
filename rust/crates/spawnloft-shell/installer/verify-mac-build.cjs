'use strict'
// verify-build for the macOS 2.0 bundle (design section 6). Asserts on both the app and the
// separately-signed Rust core, then that the app is notarized, stapled and accepted by Gatekeeper:
//
//   app  (SpawnLoft.app)                             Developer ID authority, team, timestamp,
//                                                    hardened runtime; bundle id, version;
//                                                    stapled ticket; spctl "Notarized Developer ID"
//   core (Contents/Resources/resources/bin/...)      Developer ID authority, team, timestamp,
//                                                    hardened runtime (signed before `tauri build`)
//
//   node verify-mac-build.cjs <app path> <expected version>
//   APPLE_TEAM_ID must be set to the 10-character team id.
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { verifySignatureDetails, validateStapled } = require(path.resolve(__dirname, '../../../../desktop/mac-signing.cjs'))

if (process.platform !== 'darwin') throw new Error('verify-mac-build.cjs runs on macOS')
const app = process.argv[2]
const expectedVersion = process.argv[3]
if (!app || !app.endsWith('.app')) throw new Error('usage: node verify-mac-build.cjs <app path> <expected version>')
if (!expectedVersion) throw new Error('supply the expected version')
const teamId = process.env.APPLE_TEAM_ID
if (!/^[A-Z0-9]{10}$/.test(teamId || '')) throw new Error('APPLE_TEAM_ID must be the 10-character team id')

const core = path.join(app, 'Contents', 'Resources', 'resources', 'bin', 'spawnloft-core')

function signatureOf(target) {
  // codesign writes its metadata to stderr even on success
  const res = spawnSync('codesign', ['--display', '--verbose=4', target], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`could not inspect the signature of ${target}: ${res.stderr || res.stdout}`)
  return res.stderr.replace(/\r\n/g, '\n')
}
function plistValue(key) {
  const res = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`Info.plist has no ${key}`)
  return res.stdout.trim()
}

async function main() {
  // --- the core, signed separately before tauri build ---
  execFileSync('codesign', ['--verify', '--strict', core], { stdio: 'inherit' })
  verifySignatureDetails(signatureOf(core), 'signed', teamId)
  // it must be an arm64 Mach-O that actually runs (a wrong-arch or non-executable copy would pass
  // the signature checks on its own)
  const archs = spawnSync('/usr/bin/lipo', ['-archs', core], { encoding: 'utf8' })
  if (archs.status !== 0 || !/\barm64\b/.test(archs.stdout)) throw new Error(`the core is not an arm64 binary: ${archs.stdout || archs.stderr}`)
  const ran = spawnSync(core, ['--version', '--json'], { encoding: 'utf8', timeout: 30000 })
  let printed = null
  try { printed = JSON.parse(ran.stdout) } catch { /* reported below */ }
  if (ran.status !== 0 || printed?.name !== 'spawnloft-core') {
    throw new Error(`the core does not run: --version exited ${ran.status ?? ran.error?.message}${ran.stderr ? ` (${ran.stderr.trim()})` : ''}`)
  }
  console.log(`core: Developer ID, team, timestamp, hardened runtime; arm64, runs as ${printed.name} ${printed.version}`)

  // --- the app ---
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  verifySignatureDetails(signatureOf(app), 'signed', teamId)

  const bundleId = plistValue('CFBundleIdentifier')
  if (bundleId !== 'io.github.joogiebear.mcctl') throw new Error(`bundle id is ${bundleId}, expected io.github.joogiebear.mcctl`)
  const shortVersion = plistValue('CFBundleShortVersionString')
  if (shortVersion !== expectedVersion) throw new Error(`CFBundleShortVersionString is ${shortVersion}, expected ${expectedVersion}`)
  console.log(`app: Developer ID, team, timestamp, hardened runtime; ${bundleId} ${shortVersion}`)

  await validateStapled(app, { run: (command, args) => spawnSync(command, args, { encoding: 'utf8' }) })
  const spctl = spawnSync('spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' })
  const spctlOut = `${spctl.stdout || ''}${spctl.stderr || ''}`
  if (spctl.status !== 0 || !/Notarized Developer ID/.test(spctlOut)) {
    throw new Error(`Gatekeeper did not accept the app as a notarized Developer ID build: ${spctlOut.trim()}`)
  }
  console.log('app: stapled ticket validated, Gatekeeper accepts it as "Notarized Developer ID"')
  console.log('\nBuild looks right.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
