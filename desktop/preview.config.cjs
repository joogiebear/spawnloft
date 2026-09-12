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
// The same unsigned Windows test packaging used by dev-build. Production builds
// keep their Azure signing configuration in package.json and release.mjs.
delete win.azureSignOptions
module.exports = {
  ...source.build,
  extraMetadata: { version },
  win,
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
