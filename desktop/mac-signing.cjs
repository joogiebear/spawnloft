'use strict'

const MODES = ['ad-hoc', 'signed']
exports.signingMode = function (env = process.env) {
  const mode = env.MAC_SIGNING_MODE || 'ad-hoc'
  if (!MODES.includes(mode)) throw new Error('MAC_SIGNING_MODE must be ad-hoc or signed')
  return mode
}

// Check before packaging. electron-builder otherwise permits missing credentials to
// skip notarization, which must never silently downgrade a signed release.
exports.requireCredentials = function (env = process.env) {
  const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const missing = required.filter(key => !env[key]?.trim())
  if (missing.length) throw new Error(`Missing Mac signing credentials: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be a 10-character Team ID')
  if (env.GITHUB_ACTIONS === 'true' &&
      (!['refs/heads/dev', 'refs/heads/main'].includes(env.GITHUB_REF) || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))) {
    throw new Error('Apple signing credentials may only be used on trusted dev or main builds')
  }
}

exports.verifySignatureDetails = function (details, mode, teamId) {
  if (!MODES.includes(mode)) throw new Error('Unknown Mac signing mode')
  if (mode === 'ad-hoc') {
    if (!/^Signature=adhoc$/m.test(details)) throw new Error('Expected an ad-hoc Mac test signature')
    return
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId || '') || !details.includes(`TeamIdentifier=${teamId}\n`)) {
    throw new Error('Mac signature does not match the configured Apple team')
  }
  if (!/^Authority=Developer ID Application:/m.test(details) || !/^Timestamp=.+/m.test(details) ||
      !/^CodeDirectory .*flags=.*\bruntime\b/m.test(details) || /^Signature=adhoc$/m.test(details)) {
    throw new Error('Expected a timestamped Developer ID signature with hardened runtime')
  }
}
