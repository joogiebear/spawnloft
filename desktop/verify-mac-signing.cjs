'use strict'
const { execFileSync } = require('node:child_process')
const { signingMode, verifySignatureDetails } = require('./mac-signing.cjs')
if (process.platform !== 'darwin') throw new Error('Mac trust verification requires macOS')
const app = process.argv[2]
if (!app?.endsWith('.app')) throw new Error('Supply the packaged .app path')
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
run('codesign', ['--verify', '--deep', '--strict', app])
// codesign writes its metadata to stderr even on success.
const { spawnSync } = require('node:child_process')
const result = spawnSync('codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' })
if (result.status !== 0) throw new Error('Could not inspect the Mac signature')
const mode = signingMode()
verifySignatureDetails(result.stderr.replace(/\r\n/g, '\n'), mode, process.env.APPLE_TEAM_ID)
if (mode === 'signed') {
  run('xcrun', ['stapler', 'validate', app])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
}
console.log(mode === 'signed'
  ? 'Verified Developer ID, team, timestamp, hardened runtime, stapled ticket, and Gatekeeper acceptance'
  : 'Verified ad-hoc Mac test signature; this is not a notarized build')
