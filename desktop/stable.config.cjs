'use strict'
const source = require('./package.json')
if (!/^\d+\.\d+\.\d+$/.test(source.version)) throw new Error('Stable builds require a stable source version')
if (process.platform === 'darwin') {
  if (require('./mac-signing.cjs').signingMode() !== 'signed') throw new Error('Stable Mac builds must be signed')
  require('./mac-signing.cjs').requireCredentials()
}
module.exports = {
  ...source.build,
  forceCodeSigning: true,
  mac: {
    target: ['dmg', 'zip'], category: 'public.app-category.utilities',
    icon: 'build/icon-mac.png', minimumSystemVersion: '13.0',
    type: 'distribution', hardenedRuntime: true, notarize: true,
    entitlements: 'build/entitlements.spawnloft.plist',
    entitlementsInherit: 'build/entitlements.spawnloft.plist',
    artifactName: 'SpawnLoft-${version}-mac-${arch}.${ext}',
  },
}
