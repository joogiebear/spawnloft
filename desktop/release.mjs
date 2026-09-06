#!/usr/bin/env node
/**
 * Build, sign and upload a release.
 *
 * <p>Exists for one reason: electron-builder reads its GitHub credential from `GH_TOKEN` and
 * nowhere else. The `gh` CLI is already authenticated on any machine that publishes from here -
 * every other release step uses it - but it keeps its token in its own config, so a shell without
 * that variable set builds for four minutes, signs everything, and then fails on the upload with
 * "GitHub Personal Access Token is not set". That happened on v0.3.0.
 *
 * <p>So the token is fetched from `gh` when the variable is absent, and the whole thing fails in
 * the first second rather than the fourth minute when it cannot be found at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', ...opts })
}

function fail(message) {
  process.stdout.write(`\n  FAIL ${message}\n\nNothing has been built.\n`)
  process.exit(1)
}

let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  const res = run('gh', ['auth', 'token'])
  if (res.status === 0 && res.stdout.trim()) {
    token = res.stdout.trim()
    process.stdout.write('  ok   using the token gh is already signed in with\n')
  }
}
if (!token) {
  fail(
    'no GitHub token. Either sign in with "gh auth login", or set GH_TOKEN.\n' +
      '  electron-builder reads that variable and nothing else, and it only notices at upload time.',
  )
}

// The draft is created first, once, so the concurrent uploads have something to upload into
// rather than each creating a release of their own. See ensure-draft.mjs.
const draft = run('node', ['ensure-draft.mjs'], { stdio: 'inherit', encoding: undefined })
if (draft.status !== 0) process.exit(draft.status ?? 1)

// --unsigned: build without the signing profile. Azure Trusted Signing is configured in
// package.json and electron-builder has no switch to leave it out, so the same configuration minus
// azureSignOptions is written to dist/ and passed as the config instead. This is how the CI
// workflow (.github/workflows/dev-build.yml) makes a test build: the runner has no certificate,
// and a build that can be tried today beats a signed one that cannot be made at all. Windows
// SmartScreen warns about an unsigned installer, and the release notes say so.
const args = ['electron-builder', '--publish', 'always']
if (process.argv.includes('--unsigned')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
  const config = { ...pkg.build, win: { ...pkg.build.win } }
  delete config.win.azureSignOptions
  fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true })
  const file = path.join(HERE, 'dist', 'unsigned.config.json')
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  args.push('--config', file)
  process.stdout.write('  ok   building UNSIGNED: azureSignOptions left out of the configuration\n')
}

const build = run('npx', args, {
  stdio: 'inherit',
  encoding: undefined,
  env: { ...process.env, GH_TOKEN: token },
})
process.exit(build.status ?? 1)
