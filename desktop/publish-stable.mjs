import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyRelease } from './preview-artifacts.mjs'
import { prepareMacFeeds } from './mac-update-feeds.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(process.argv[2] || path.join(here, 'dist/stable-release'))
const runId = process.argv[3]
if (process.platform !== 'win32' || !/^\d+$/.test(runId || '')) throw new Error('Publish from the Windows signing host with the successful desktop-stable run ID')
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
const repo = 'joogiebear/spawnloft'
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'))).version
if (JSON.parse(fs.readFileSync(path.join(here, '../package.json'))).version !== version) throw new Error('Core and desktop versions differ')
const commit = gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha'])
const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}`]))
if (run.path !== '.github/workflows/desktop-stable.yml' || run.head_branch !== 'main' || run.head_sha !== commit ||
    run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success') {
  throw new Error('Both native Mac builds, the Linux build and the installed upgrade checks must pass on the current main commit')
}
const verified = verifyRelease(dir, { stable: true, version, sourceVersion: version, commit, macSigningMode: 'signed' })
const installer = path.join(dir, `SpawnLoft-Setup-${version}.exe`).replaceAll("'", "''")
execFileSync('powershell', ['-NoProfile', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${installer}'; if ($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.Subject -notmatch 'CN=victor zemeckis(,|$)') { throw 'Invalid Windows publisher signature' }`], { stdio: 'inherit', windowsHide: true })
verified.assets.push(...prepareMacFeeds(dir, verified))
const tag = `v${version}`
let taggedCommit
try { taggedCommit = gh(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']) }
catch (error) { if (!/HTTP (404|422)/.test(String(error.stderr))) throw error }
if (taggedCommit && taggedCommit !== commit) throw new Error('Existing tag names a different commit')
const releases = JSON.parse(gh(['api', `repos/${repo}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.tag_name === tag || r.name === tag)
if (releases.length > 1) throw new Error('Multiple releases claim this version')
const release = releases[0]
const checkUploaded = actual => {
  if (actual.assets.length !== verified.assets.length) throw new Error('Unexpected published asset count')
  for (const a of verified.assets) {
    const remote = actual.assets.filter(b => b.name === a.name)
    if (remote.length !== 1 || remote[0].state !== 'uploaded' || remote[0].size !== a.size || remote[0].digest !== `sha256:${a.sha256}`) throw new Error(`Uploaded bytes differ: ${a.name}`)
  }
}
if (release && !release.draft) {
  if (release.prerelease || taggedCommit !== commit) throw new Error('Published release has a different identity')
  checkUploaded(release)
  console.log(`${tag} is already published with the verified artifacts.`)
} else {
  if (release && (release.prerelease || release.target_commitish !== commit || release.assets.some(a => !verified.assets.some(b => a.name === b.name)))) throw new Error('Refusing to reuse a different draft')
  const notes = path.join(dir, 'release-notes.md')
  fs.writeFileSync(notes, fs.readFileSync(path.join(here, 'STABLE.md'), 'utf8') + `\n\nBuilt together from [\`${commit.slice(0, 12)}\`](https://github.com/${repo}/commit/${commit}). Native Mac signing, notarization and installed upgrades verified in [build ${runId}](https://github.com/${repo}/actions/runs/${runId}).\n`)
  if (!release) gh(['release', 'create', tag, '--repo', repo, '--target', commit, '--draft', '--title', `SpawnLoft ${version}`, '--notes-file', notes])
  gh(['release', 'upload', tag, ...verified.assets.map(a => a.path), '--repo', repo, '--clobber'])
  // Drafts are not consistently indexed by the public tag endpoint. Use the
  // authenticated release listing, which also detects duplicate draft names.
  const uploaded = JSON.parse(gh(['api', `repos/${repo}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.tag_name === tag || r.name === tag)
  if (uploaded.length !== 1 || !uploaded[0].draft || uploaded[0].prerelease || uploaded[0].target_commitish !== commit) throw new Error('Uploaded draft has a different identity')
  checkUploaded(uploaded[0])
  if (gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha']) !== commit) throw new Error('main moved; leaving release as a draft')
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease=false', '--latest'])
  console.log(`Published ${tag}: signed Windows, Apple Silicon and Intel Mac packages and the Linux package, with stable and beta updater feeds.`)
}
