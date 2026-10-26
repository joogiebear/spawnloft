'use strict'
const fs = require('node:fs')
const path = require('node:path')

// paths resolve relative to the launcher so moving or replacing the app leaves nothing stale;
// the bundled Electron runs the core as Node, so no separate install is needed
exports.writeCliLaunchers = function (resources, platform) {
  const bin = path.join(resources, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['spawnloft', 'mcctl']) {
    if (platform === 'darwin') {
      const script = `#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
exec env ELECTRON_RUN_AS_NODE=1 "$SCRIPT_DIR/../../MacOS/SpawnLoft" "$SCRIPT_DIR/../core/${name}.mjs" "$@"
`
      fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 })
    } else if (platform === 'linux') {
      // resources/bin -> resources -> the application folder, where the executable sits
      const script = `#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
exec env ELECTRON_RUN_AS_NODE=1 "$SCRIPT_DIR/../../spawnloft-desktop" "$SCRIPT_DIR/../core/${name}.mjs" "$@"
`
      fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 })
    } else if (platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), [
        '@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1',
        `"%~dp0..\\..\\SpawnLoft.exe" "%~dp0..\\core\\${name}.mjs" %*`,
        'exit /b %errorlevel%', '',
      ].join('\r\n'))
    }
  }
}
