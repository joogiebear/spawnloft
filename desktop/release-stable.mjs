#!/usr/bin/env node
/**
 * Release day, on the Windows signing machine, as one command.
 *
 *   npm run release:stable                 # everything up to publishing, then stops
 *   npm run release:stable -- --publish    # the same, and makes the release public
 *
 * <p>A stable release is four platforms verified together. Two Macs and two Linux architectures
 * are built, signed where that applies, installed and exercised by the `desktop-stable` workflow.
 * Windows is built and signed here, because the Azure signing profile lives on this machine. Then
 * publish-stable.mjs checks every package's bytes against its manifest before anything is exposed.
 *
 * <p>Done by hand that is ten commands in a fixed order, run once a month, which is exactly often
 * enough to forget one. This runs them, in that order, and stops at the first thing that is wrong.
 * It adds no check of its own to the release: every gate is the one the individual steps already
 * had. What it adds is the order, and the refusals at the top, which are the mistakes that are
 * cheap to make and expensive to find out about afterwards.
 *
 * <p>Publishing is a separate flag on purpose. A stable release reaches every installed copy
 * through the updater and cannot be recalled, so the default is to get everything verified and
 * sitting in one folder, and say so.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const REPO = 'joogiebear/spawnloft'
const WORKFLOW = 'desktop-stable.yml'
const PUBLISH = process.argv.includes('--publish')
const REBUILD = process.argv.includes('--rebuild')
const STAGING = path.join(HERE, 'dist', 'stable-release')

const step = title => console.log(`\n== ${title}`)
const stop = message => { console.error(`\nStopped: ${message}`); process.exit(1) }

/** Run something and show what it says. npm, npx and az are .cmd files here, hence the shell. */
function run(cmd, args, { cwd = ROOT, env = process.env, shell = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true, shell })
  if (res.error) stop(`${cmd} could not be run: ${res.error.message}`)
  if (res.status !== 0) stop(`${cmd} ${args.join(' ')} exited ${res.status}`)
}
// The releases listing grows with every beta and passed Node's default 1 MB between 1.2.0 and
// 1.3.0; past it spawnSync fails with ENOBUFS and the release stops at its first check.
const MAX_OUTPUT = 256 * 1024 * 1024

function read(cmd, args, { cwd = ROOT, shell = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, shell, maxBuffer: MAX_OUTPUT })
  if (res.error || res.status !== 0) {
    if (allowFail) return null
    stop(`${cmd} ${args.join(' ')} failed: ${res.error?.message || res.stderr?.trim() || `exit ${res.status}`}`)
  }
  return res.stdout.trim()
}
const gh = args => read('gh', args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- what must be true before anything is built ------------------------------------------------

step('Checking this is a release that can be made')
if (process.platform !== 'win32') stop('stable releases are assembled on the Windows signing machine')
const version = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) stop(`${version} is not a stable version. Releases are cut from main after a release branch has set one (node desktop/set-version.mjs X.Y.Z).`)
if (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version !== version) stop('the core and the desktop disagree about the version')
if (read('git', ['branch', '--show-current']) !== 'main') stop('check out main: a release is built from what was merged to it')
if (read('git', ['status', '--porcelain'])) stop('the working tree has changes. A release is built from a clean commit, and says so in its manifest.')
run('git', ['fetch', '--quiet', 'origin', 'main'])
const commit = read('git', ['rev-parse', 'HEAD'])
if (commit !== read('git', ['rev-parse', 'origin/main'])) stop('this checkout is not at origin/main. Pull first: every platform has to be built from the same commit.')
if (read('gh', ['auth', 'status'], { allowFail: true }) === null) stop('gh is not signed in (gh auth login)')
// Signing goes through an az session rather than credentials in the environment.
if (read('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv'], { shell: true, allowFail: true }) === null) {
  stop('there is no Azure session to sign with. Run: az login --tenant <the tenant holding the signing account>')
}
const tag = `v${version}`
const existing = JSON.parse(gh(['api', `repos/${REPO}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.tag_name === tag)
if (existing.some(r => !r.draft)) stop(`${tag} is already published`)
console.log(`${tag} from ${commit.slice(0, 12)}${PUBLISH ? '' : '  (not publishing: pass --publish for that)'}`)

// ---- the other three platforms, in CI ------------------------------------------------------------

step('Finding the desktop-stable run for this commit')
const runsFor = () => JSON.parse(gh(['api', `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${commit}&event=workflow_dispatch&per_page=20`])).workflow_runs
// A failed or cancelled run is not reused; a new one replaces it rather than being re-run here,
// so that what gets published names a run that passed from start to finish.
let ci = runsFor().find(r => r.status !== 'completed' || r.conclusion === 'success')
if (!ci) {
  console.log('None yet. Starting one.')
  run('gh', ['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', 'main'])
  for (let tries = 0; !ci && tries < 30; tries++) { await sleep(4000); ci = runsFor().find(r => r.status !== 'completed') }
  if (!ci) stop('the workflow was started but no run for this commit appeared. Check the Actions tab.')
}
console.log(`Run ${ci.id} (${ci.status}) - ${ci.html_url}`)

// ---- Windows, here --------------------------------------------------------------------------------

const manifestFile = path.join(HERE, 'dist', 'preview-build-win32-x64.json')
const windowsFiles = [`SpawnLoft-Setup-${version}.exe`, `SpawnLoft-Setup-${version}.exe.blockmap`, 'latest.yml', 'beta.yml', 'preview-build-win32-x64.json']
function alreadyBuilt() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    return manifest.commit === commit && manifest.version === version && manifest.dirty === false &&
      windowsFiles.every(name => fs.existsSync(path.join(HERE, 'dist', name)))
  } catch { return false }
}
if (alreadyBuilt() && !REBUILD) {
  // A CI job that needed re-running should not cost another build, signature and smoke test here.
  step('Windows: using the verified build already made from this commit (--rebuild to make it again)')
} else {
  step('Windows: installing the desktop toolchain')
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: HERE, shell: true })
  step('Windows: building and signing')
  run(process.execPath, [path.join(HERE, 'release.mjs')])
  step('Windows: verifying the packaged app and its signature')
  run(process.execPath, [path.join(HERE, 'verify-build.mjs'), path.join(HERE, 'dist', 'win-unpacked')])
  step('Windows: opening the packaged app and running the smoke test')
  // Playwright drives the app and is nobody's dependency, so it lives in a folder of its own.
  const tool = path.join(os.tmpdir(), 'spawnloft-smoke-tool')
  if (!fs.existsSync(path.join(tool, 'node_modules', 'playwright'))) {
    run('npm', ['install', '--prefix', tool, '--no-save', '--no-package-lock', 'playwright@1.63.0'], { shell: true })
  }
  run(process.execPath, [path.join(HERE, 'smoke-desktop.cjs'), path.join(HERE, 'dist', 'win-unpacked'), path.join(HERE, 'dist', 'smoke-win32-x64')],
    { env: { ...process.env, NODE_PATH: path.join(tool, 'node_modules') } })
  step('Windows: recording the manifest')
  run(process.execPath, [path.join(HERE, 'stable-artifacts.mjs'), 'win32', 'x64'])
}

// ---- wait for CI, then put everything in one folder ----------------------------------------------

step(`Waiting for run ${ci.id}`)
for (;;) {
  ci = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${ci.id}`]))
  if (ci.status === 'completed') break
  process.stdout.write('.')
  await sleep(30000)
}
console.log('')
if (ci.conclusion !== 'success') {
  const jobs = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${ci.id}/jobs`])).jobs.filter(job => job.conclusion !== 'success')
  for (const job of jobs) console.error(`  ${job.conclusion}  ${job.name}`)
  // Most red jobs on a release day have been GitHub's download servers, not the code. A re-run of
  // the failed jobs keeps the run id; start this script again afterwards and the Windows build is reused.
  stop(`run ${ci.id} did not pass. Read the log; if it is a download failure or a dmgbuild crash: gh run rerun ${ci.id} --failed --repo ${REPO}`)
}

step('Collecting every platform into desktop/dist/stable-release')
// This folder is this script's own staging area and holds nothing but copies.
fs.rmSync(STAGING, { recursive: true, force: true })
fs.mkdirSync(STAGING, { recursive: true })
const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-stable-'))
run('gh', ['run', 'download', String(ci.id), '--repo', REPO, '--pattern', 'desktop-stable-*', '--dir', downloaded])
for (const folder of fs.readdirSync(downloaded)) {
  for (const name of fs.readdirSync(path.join(downloaded, folder))) fs.copyFileSync(path.join(downloaded, folder, name), path.join(STAGING, name))
}
fs.rmSync(downloaded, { recursive: true, force: true })
for (const name of windowsFiles) fs.copyFileSync(path.join(HERE, 'dist', name), path.join(STAGING, name))
console.log(`${fs.readdirSync(STAGING).length} files`)

step('Verifying all platforms together')
const { verifyRelease } = await import('./preview-artifacts.mjs')
const verified = verifyRelease(STAGING, { stable: true, version, sourceVersion: version, commit, macSigningMode: 'signed' })
for (const asset of verified.assets.filter(a => !a.name.endsWith('.json') && !a.name.endsWith('.yml'))) {
  console.log(`  ${(asset.size / 1048576).toFixed(0).padStart(4)} MB  ${asset.name}`)
}

if (!PUBLISH) {
  console.log(`\nEverything verifies, and nothing has been published.`)
  console.log(`The release text will be desktop/STABLE.md as it stands - read it once more.`)
  console.log(`To publish ${tag} to every installed copy:  npm run release:stable -- --publish`)
  process.exit(0)
}

step(`Publishing ${tag}`)
run(process.execPath, [path.join(HERE, 'publish-stable.mjs'), STAGING, String(ci.id)])

// ---- what is left, which is not this script's to do ----------------------------------------------

const [major, minor] = version.split('.').map(Number)
const betas = JSON.parse(gh(['api', `repos/${REPO}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.prerelease).map(r => r.tag_name)
console.log(`
${tag} is published. What is left:

1. Check it arrives. Open an installed copy of the previous version; it should find ${version}
   within half a minute of starting, and install it when it is closed.

2. Bring dev back in line, which publishes nothing because the version is a stable one:
     git checkout dev && git merge --ff-only origin/main && git push

3. Start the next month. dev has to carry a prerelease version or the beta pipeline stays off,
   and CI refuses a pull request into dev that does not. In the first branch of the month:
     node desktop/set-version.mjs ${major}.${minor + 1}.0-beta.1
   and start the next release's notes at the top of desktop/STABLE.md.
${betas.length ? `
4. Once the update has been seen to work, the ${betas.length} beta pre-release${betas.length === 1 ? '' : 's'} can go. Stable installs never saw them and
   beta installs have moved across. It is permanent, so it is left to you (PowerShell):
     ${betas.map(t => `"${t}"`).join(',')} | ForEach-Object { gh release delete $_ --repo ${REPO} --cleanup-tag --yes }
` : ''}`)
