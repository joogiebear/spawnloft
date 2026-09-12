'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * Guard the build before it can become a release.
 *
 * <p>There is no CI on this repository, and `npm run release` publishes live rather than as a
 * draft, so this hook is the only thing between a wrong build and a public download.
 *
 * <p>Two jobs, because they have to happen at different moments:
 *
 * <ol>
 *   <li><b>Structure</b>, checked here and now: the core, the panel and the wizard are all present
 *       in what was just packed.</li>
 *   <li><b>The icon</b>, which cannot be checked here - electron-builder applies it with rcedit
 *       AFTER this hook runs, and the `afterSign` hook that comes later is skipped entirely for an
 *       unsigned build. So rather than checking the result, this checks the cause: whether rcedit
 *       is available at all. When it is not, electron-builder logs a warning and ships Electron's
 *       default atom, which is the silent failure that went out in v0.1.0.</li>
 * </ol>
 *
 * <p>`npm run verify` checks the finished artifact, and is the belt to this hook's braces.
 */
/**
 * Where rcedit is, according to whichever electron-builder this is.
 *
 * <p>There is no public API for this, and the internal one moved between 24 and 26 -
 * `getSignVendorPath` in codeSign/windowsCodeSign became `getRceditBundle` in toolsets/windows. So
 * this tries what it knows and returns null when it recognises nothing, rather than pretending a
 * missing resolver is a missing toolchain.
 */
async function findRcedit(context) {
  // electron-builder 25+
  try {
    const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows')
    if (typeof getRceditBundle === 'function') {
      const bundle = await getRceditBundle(context.packager.config.toolsets?.winCodeSign)
      return bundle?.x64 ?? null
    }
  } catch {
    /* fall through to the older shape */
  }
  // electron-builder 24
  try {
    const { getSignVendorPath } = require('app-builder-lib/out/codeSign/windowsCodeSign')
    if (typeof getSignVendorPath === 'function') return path.join(await getSignVendorPath(), 'rcedit-x64.exe')
  } catch {
    /* neither shape is available */
  }
  return null
}

/**
 * Which commit produced this build.
 *
 * <p>The source repository is private and the releases repository holds only binaries, so nothing
 * otherwise connects mcctl-Setup-0.2.7.exe to the code that made it. Six months later "what is
 * actually in this build" has no answer beyond trusting the version number, and a version number
 * is a label someone typed.
 *
 * <p>Recorded at build time rather than publish time, because those are not the same moment - a
 * draft can sit for a week while the branch moves on.
 */
function buildInfo() {
  const repo = path.resolve(__dirname, '..')
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    return res.status === 0 ? res.stdout.trim() : null
  }
  const commit = git(['rev-parse', 'HEAD'])
  // A build from a dirty tree is not reproducible from any commit, and saying so is the whole point.
  const status = commit ? git(['status', '--porcelain']) : null
  const dirty = status === null ? null : status !== ''
  // What was dirty, not just that something was. v0.3.0 shipped flagged because of one untracked
  // file that is not in the packaged set - true, and useless without knowing which file it was.
  // Ten is enough to tell "a stray script" from "half the source".
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
  // ---- 1. the icon toolchain has to exist, or the icon is silently skipped -------------------
  if (context.electronPlatformName === 'win32' && context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) {
    const rcedit = await findRcedit(context)
    if (rcedit == null) {
      // Not knowing is not the same as knowing it is broken, and a guard that fails a good build
      // because electron-builder moved a private function is worse than no guard. `npm run verify`
      // checks the finished executable for the icon bytes themselves and is the real authority.
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

  // ---- 2. record what built this, for the app and for the release notes ----------------------
  const info = buildInfo()
  info.sourceVersion = info.version
  info.version = context.packager.appInfo.version
  info.platform = context.electronPlatformName
  info.arch = require('builder-util').Arch[context.arch]
  if (info.platform === 'darwin') info.macSigningMode = require('./mac-signing.cjs').signingMode()
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

  // ---- 3. everything the app needs is actually in the package --------------------------------
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-build.mjs'), context.appOutDir, '--structure-only', `--platform=${context.electronPlatformName}`],
    { stdio: 'inherit' },
  )
  if (res.status !== 0) {
    throw new Error('build verification failed - see the report above. Nothing has been published.')
  }
}
