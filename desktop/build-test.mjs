#!/usr/bin/env node
/**
 * Build a local test installer that has something to update to.
 *
 * <p>Two problems make a plain `npx electron-builder --publish never` awkward for trying the
 * update flow, and this script exists for both.
 *
 * <p><b>Signing.</b> Azure Trusted Signing is configured in package.json and electron-builder has
 * no switch to leave it out, so a machine without the certificate cannot build at all. The same
 * configuration minus `azureSignOptions` is written to dist/ and passed as the config instead -
 * the trick release.mjs already uses for `--unsigned`. Windows SmartScreen warns about the result,
 * which is the price of a build that can be made today.
 *
 * <p><b>Version.</b> A build at the current version has nothing newer on the release feed, so
 * installing it proves the app starts and nothing else. Built at a version BELOW the latest
 * release, it finds that release twenty seconds after starting and walks the whole path: background
 * download, "Restart to update", silent install, relaunch on the real version.
 *
 * <p>The version is a plain one on purpose. A prerelease tag like `-test.1` would make
 * electron-builder derive an update channel from it and write `channel: test` into app-update.yml,
 * and the installed app would then look for a `test.yml` that no release has.
 *
 * <p>package.json is restored whatever happens, including on a failed build.
 *
 *   node build-test.mjs [version]     # default 0.12.9
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const TEST_VERSION = process.argv[2] ?? '0.12.9'
const original = fs.readFileSync('package.json', 'utf8')
const pkg = JSON.parse(original)

try {
  pkg.version = TEST_VERSION
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

  const config = { ...pkg.build, win: { ...pkg.build.win } }
  delete config.win.azureSignOptions
  fs.mkdirSync('dist', { recursive: true })
  fs.writeFileSync('dist/testbuild.config.json', JSON.stringify(config, null, 2) + '\n')

  process.stdout.write(`  ok   building UNSIGNED at ${TEST_VERSION}, below the latest release\n`)
  const res = spawnSync(
    'npx',
    ['electron-builder', '--publish', 'never', '--config', 'dist/testbuild.config.json'],
    { stdio: 'inherit', shell: true },
  )
  process.exitCode = res.status ?? 1
} finally {
  fs.writeFileSync('package.json', original)
}
