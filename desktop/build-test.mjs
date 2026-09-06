#!/usr/bin/env node
/**
 * Build a local test installer that has something to update to.
 *
 * <p>A plain `npx electron-builder --publish never` is awkward for trying the update flow, for two
 * reasons, and this script exists for both.
 *
 * <p><b>Version.</b> A build at the current version has nothing newer on the release feed, so
 * installing it proves the app starts and nothing else. Built at a version BELOW the latest
 * release, it finds that release twenty seconds after starting and walks the whole path:
 * background download, "Restart to update", silent install, relaunch on the real version.
 *
 * <p>The version is a plain one on purpose. A prerelease tag like `-test.1` would make
 * electron-builder derive an update channel from it and write `channel: test` into app-update.yml,
 * and the installed app would then look for a `test.yml` that no release has.
 *
 * <p><b>Signing.</b> Two builds are worth making, and they test different halves:
 *
 * <ul>
 *   <li><b>Unsigned</b> (the default). Azure Trusted Signing is configured in package.json and
 *       electron-builder has no switch to leave it out, so the same configuration minus
 *       `azureSignOptions` is written to dist/ and passed instead - the trick release.mjs already
 *       uses for `--unsigned`. Builds anywhere, on any machine, with no certificate. SmartScreen
 *       warns about the result.</li>
 *   <li><b>Signed</b> (`--signed`). The configuration a real release is built from, so
 *       app-update.yml carries `publisherName` and the installed app therefore VERIFIES the
 *       signature of whatever it downloads before installing it. That check is skipped entirely by
 *       an unsigned build, so it is the half only this one can exercise. Needs the signing
 *       credentials the release machine has.</li>
 * </ul>
 *
 * <p>package.json is restored whatever happens, including on a failed build.
 *
 *   node build-test.mjs [version] [--signed]     # version defaults to 0.12.9
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const signed = argv.includes('--signed')
const TEST_VERSION = argv.find((a) => !a.startsWith('--')) ?? '0.12.9'

const original = fs.readFileSync('package.json', 'utf8')
const pkg = JSON.parse(original)

try {
  pkg.version = TEST_VERSION
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

  const args = ['electron-builder', '--publish', 'never']
  if (!signed) {
    const config = { ...pkg.build, win: { ...pkg.build.win } }
    delete config.win.azureSignOptions
    fs.mkdirSync('dist', { recursive: true })
    fs.writeFileSync('dist/testbuild.config.json', JSON.stringify(config, null, 2) + '\n')
    args.push('--config', 'dist/testbuild.config.json')
  }

  process.stdout.write(
    `  ok   building ${signed ? 'SIGNED' : 'UNSIGNED'} at ${TEST_VERSION}, below the latest release\n`,
  )
  const res = spawnSync('npx', args, { stdio: 'inherit', shell: true })
  process.exitCode = res.status ?? 1
} finally {
  fs.writeFileSync('package.json', original)
}
