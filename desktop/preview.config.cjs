'use strict'

// One version for three native builds. The workflow starts at run 1; adding one
// avoids the already-published beta.1 without rewriting either source package.
const source = require('./package.json')
const { signingMode, requireCredentials } = require('./mac-signing.cjs')
const signedMac = signingMode() === 'signed'
if (signedMac && process.platform === 'darwin') requireCredentials()
const build = process.env.PREVIEW_BUILD
if (!source.version.includes('-')) throw new Error('Desktop previews require a development source version')
if (!/^[1-9]\d*$/.test(build || '') || !Number.isSafeInteger(Number(build) + 1)) {
  throw new Error('PREVIEW_BUILD must be a positive workflow run number')
}
const version = `${source.version.split('-')[0]}-beta.${Number(build) + 1}`
const win = { ...source.build.win }
// A beta pushed to dev is signed with the same Azure profile as a release, through the workflow's
// federated login. It has to be: a signed install that turns on betas refuses an update whose
// publisher does not match its own. Pull requests and local test builds stay unsigned.
const signedWin = process.env.WINDOWS_SIGNING_MODE === 'signed'
if (!signedWin) delete win.azureSignOptions
module.exports = {
  ...source.build,
  extraMetadata: { version },
  win,
  ...(signedWin && process.platform === 'win32' ? { forceCodeSigning: true } : {}),
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.utilities',
    icon: 'build/icon-mac.png',
    minimumSystemVersion: '13.0',
    ...(signedMac ? {
      type: 'distribution',
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
      entitlements: 'build/entitlements.spawnloft.plist',
      entitlementsInherit: 'build/entitlements.spawnloft.plist',
    } : { identity: '-', hardenedRuntime: false, notarize: false }),
    artifactName: 'SpawnLoft-${version}-mac-${arch}.${ext}',
  },
}
