'use strict'
// verify-build for the macOS 2.0 bundle (design section 6). Asserts on both the app and the
// separately-signed Rust core, then that the app is notarized, stapled and accepted by Gatekeeper:
//
//   app  (SpawnLoft.app)                             Developer ID authority, team, timestamp,
//                                                    hardened runtime; bundle id, version;
//                                                    stapled ticket; spctl "Notarized Developer ID"
//   core (Contents/Resources/resources/bin/...)      Developer ID authority, team, timestamp,
//                                                    hardened runtime (signed before `tauri build`)
//   node (Contents/Resources/resources/runtime/...)  the same, plus the JIT entitlements; arm64;
//                                                    the pinned version; `node -e 1` runs, and
//                                                    `spawnloft --version` through the forwarder
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
const runtimeDir = path.join(app, 'Contents', 'Resources', 'resources', 'runtime')

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

  // --- the bundled Node (A7): signed with the JIT entitlements, or V8 dies at start under the
  // hardened runtime while notarization still passes ---
  const { NODE_VERSION } = await import(path.resolve(__dirname, '../../../../desktop/node-pin.mjs'))
  const record = JSON.parse(require('node:fs').readFileSync(path.join(runtimeDir, 'runtime.json'), 'utf8'))
  if (record.node !== NODE_VERSION) throw new Error(`runtime.json says Node ${record.node}, the pin is ${NODE_VERSION}`)
  const node = path.join(runtimeDir, record.exe)
  execFileSync('codesign', ['--verify', '--strict', node], { stdio: 'inherit' })
  verifySignatureDetails(signatureOf(node), 'signed', teamId)
  const ent = spawnSync('codesign', ['--display', '--entitlements', '-', '--xml', node], { encoding: 'utf8' })
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']) {
    if (!`${ent.stdout}`.includes(key)) throw new Error(`the bundled Node is not signed with ${key}: ${ent.stdout || ent.stderr}`)
  }
  const nodeArchs = spawnSync('/usr/bin/lipo', ['-archs', node], { encoding: 'utf8' })
  if (nodeArchs.status !== 0 || !/\barm64\b/.test(nodeArchs.stdout)) throw new Error(`the bundled Node is not arm64: ${nodeArchs.stdout || nodeArchs.stderr}`)
  const nodeRan = spawnSync(node, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8', timeout: 30000 })
  if (nodeRan.status !== 0 || nodeRan.stdout !== `v${NODE_VERSION}`) {
    throw new Error(`the bundled Node does not run: exited ${nodeRan.status ?? nodeRan.error?.message}, printed ${nodeRan.stdout} ${nodeRan.stderr}`)
  }
  console.log(`node: Developer ID, team, timestamp, hardened runtime, JIT entitlements; arm64, runs as ${nodeRan.stdout}`)
  // the CLI through the 1.x path, on the bundled Node with nothing on PATH
  const cli = path.join(app, 'Contents', 'Resources', 'bin', 'spawnloft')
  const help = spawnSync(cli, ['help'], { encoding: 'utf8', timeout: 60000, env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' } })
  if (help.status !== 0 || !/spawnloft/i.test(help.stdout)) throw new Error(`Contents/Resources/bin/spawnloft help failed (${help.status}): ${help.stderr}`)
  console.log('cli: Contents/Resources/bin/spawnloft runs the CLI on the bundled Node with no Node on PATH')

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
