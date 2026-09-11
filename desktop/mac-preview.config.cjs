'use strict'

// Separate from package.json so refreshing a rolling Mac preview does not
// trigger a new Windows installer or modify the existing Windows beta assets.
module.exports = {
  ...require('./package.json').build,
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
