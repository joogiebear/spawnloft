'use strict'

// A custom prerelease channel is ignored by existing Windows beta updaters.
// Each immutable GitHub release gets its own monotonically increasing build.
const source = require('./package.json')
const build = process.env.MAC_PREVIEW_BUILD || 'local'
if (!/^(\d+|local)$/.test(build)) throw new Error('Invalid Mac preview build number')
const version = `${source.version.split('-')[0]}-mac.${build}`
module.exports = {
  ...source.build,
  extraMetadata: { version },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.utilities',
    icon: 'build/icon-mac.png',
    minimumSystemVersion: '13.0',
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    artifactName: 'SpawnLoft-${version}-mac-${arch}.${ext}',
  },
}
