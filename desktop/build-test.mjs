#!/usr/bin/env node
// Build a local test installer that has something to update to.
//
//   node build-test.mjs [version] [--signed]     # version defaults to 0.12.9
//
// The build is versioned below the latest release so it finds that release shortly after start and
// exercises the whole update path. The version is a plain one on purpose: a prerelease tag like
// `-test.1` makes electron-builder write `channel: test` into app-update.yml, and the installed
// app would look for a test.yml that no release has.
//
// Unsigned (default): electron-builder can't leave out the Azure signing config in package.json,
// so the same config minus `azureSignOptions` is written to dist/ and passed instead. Builds
// anywhere; SmartScreen warns about the result.
// Signed (--signed): uses the real release config, so app-update.yml carries `publisherName` and
// the installed app verifies the signature of what it downloads. Needs the release signing
// credentials.
//
// package.json is restored afterwards, even on a failed build.
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
