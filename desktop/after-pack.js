'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Pre-release guard: there is no CI and `npm run release` publishes live, so this hook (checks
// the packed structure) plus `npm run verify` (checks the finished artifact) stand between a
// bad build and a public download.
//
// The icon can't be checked here: electron-builder applies it with rcedit after this hook runs,
// and afterSign is skipped for unsigned builds. So we check that rcedit exists; when it doesn't,
// electron-builder only warns and ships Electron's default icon.

// No public API for this. The internal one moved between electron-builder 24
// (getSignVendorPath) and 25+ (getRceditBundle), so try both and return null if neither exists.
async function findRcedit(context) {
  try {
    const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows')
    if (typeof getRceditBundle === 'function') {
      const bundle = await getRceditBundle(context.packager.config.toolsets?.winCodeSign)
      return bundle?.x64 ?? null
    }
  } catch {
    /* try the older shape */
  }
  try {
    const { getSignVendorPath } = require('app-builder-lib/out/codeSign/windowsCodeSign')
    if (typeof getSignVendorPath === 'function') return path.join(await getSignVendorPath(), 'rcedit-x64.exe')
  } catch {
    /* neither shape is available */
  }
  return null
}

// Which commit produced this build. Recorded at build time, not publish time, because a draft
// can sit for a week while the branch moves on.
function buildInfo() {
  const repo = path.resolve(__dirname, '..')
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    return res.status === 0 ? res.stdout.trim() : null
  }
  const commit = git(['rev-parse', 'HEAD'])
  const status = commit ? git(['status', '--porcelain']) : null
  const dirty = status === null ? null : status !== ''
  // list which files, capped at ten
  const changed = status
    ? status.split(/\r?\n/).filter(Boolean).map((l) => l.trim()).slice(0, 10)
    : []
  return {
    version: require('./package.json').version,
    commit,
    shortCommit: commit ? commit.slice(0, 12) : null,
    dirty,
    changed,
    builtAt: new Date().toISOString(),
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32' && context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) {
    const rcedit = await findRcedit(context)
    if (rcedit == null) {
      // warn only: failing a good build because electron-builder moved a private function is
      // worse than no guard. `npm run verify` checks the icon bytes in the finished exe.
      console.warn(
        '  warn rcedit could not be located through any known electron-builder internal, so the\n' +
          '       icon pre-flight was skipped. Run "npm run verify" after the build.',
      )
    } else if (!fs.existsSync(rcedit)) {
      throw new Error(
        `rcedit is missing from ${rcedit}, so the app icon would not reach SpawnLoft.exe and this ` +
          "build would ship Electron's default icon without failing. " +
          'See desktop/build/README.md. Nothing has been published.',
      )
    }
  }

  const info = buildInfo()
  info.sourceVersion = info.version
  info.version = context.packager.appInfo.version
  info.platform = context.electronPlatformName
  info.arch = require('builder-util').Arch[context.arch]
  if (info.platform === 'darwin') info.macSigningMode = require('./mac-signing.cjs').signingMode()
  if (info.platform === 'win32') info.windowsSigningMode = context.packager.platformSpecificBuildOptions.azureSignOptions ? 'azure' : 'unsigned'
  if (!info.commit) {
    console.warn('  warn could not read the source commit; this build will not say what produced it')
  } else if (info.dirty) {
    console.warn(`  warn building from a dirty tree - ${info.shortCommit} plus uncommitted changes`)
  }
  const body = JSON.stringify(info, null, 2) + '\n'
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, 'SpawnLoft.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  fs.writeFileSync(path.join(resources, 'build-info.json'), body)
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'dist', 'build-info.json'), body)
  require('./cli-launchers.cjs').writeCliLaunchers(resources, context.electronPlatformName)

  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-build.mjs'), context.appOutDir, '--structure-only', `--platform=${context.electronPlatformName}`],
    { stdio: 'inherit' },
  )
  if (res.status !== 0) {
    throw new Error('build verification failed - see the report above. Nothing has been published.')
  }
}
