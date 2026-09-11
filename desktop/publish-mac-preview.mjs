import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, 'dist/mac-release')
const sourceVersion = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
if (!sourceVersion.includes('-')) throw new Error('Only a development version may publish a Mac preview')
const repo = 'joogiebear/spawnloft'
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = gh(['api', `repos/${repo}/commits/dev`, '--jq', '.sha'])
// Do not let a queued, older workflow publish after a newer development commit.
if (commit !== process.env.GITHUB_SHA) throw new Error('dev moved while this build ran; publish the newer build instead')
const version = JSON.parse(fs.readFileSync(path.join(dir, 'mac-build-arm64.json'), 'utf8')).version
const base = sourceVersion.split('-')[0]
if (!version.startsWith(base + '-mac.') || !/^\d+$/.test(version.slice((base + '-mac.').length))) {
  throw new Error('Expected a numbered Mac preview version')
}
const tag = `v${version}`
const assets = []
for (const arch of ['arm64', 'x64']) {
  const manifestName = `mac-build-${arch}.json`
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, manifestName), 'utf8'))
  if (manifest.arch !== arch || manifest.version !== version || manifest.sourceVersion !== sourceVersion || manifest.commit !== commit || manifest.dirty) {
    throw new Error(`Unexpected build identity in ${manifestName}`)
  }
  for (const ext of ['dmg', 'zip']) {
    const name = `SpawnLoft-${version}-mac-${arch}.${ext}`
    const recorded = manifest.assets.find(asset => asset.name === name)
    const bytes = fs.readFileSync(path.join(dir, name))
    if (!recorded || bytes.length !== recorded.size || crypto.createHash('sha256').update(bytes).digest('hex') !== recorded.sha256) {
      throw new Error(`Artifact verification failed: ${name}`)
    }
    assets.push(path.join(dir, name))
  }
  assets.push(path.join(dir, manifestName))
}
const guide = fs.readFileSync(path.join(here, 'MAC-PREVIEW.md'), 'utf8')
const notes = path.join(dir, 'release-notes.md')
fs.writeFileSync(notes, guide + `\n\nBuilt from [\`${commit.slice(0, 12)}\`](https://github.com/${repo}/commit/${commit}), based on development version ${sourceVersion}.\n`)
// Upload every verified asset while still a draft. Publishing locks the release,
// so no client can ever see a half-uploaded Mac build. Existing releases are untouched.
let release
try { release = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,isPrerelease'])) }
catch (error) {
  if (!String(error.stderr).includes('release not found')) throw error
}
if (release && !release.isDraft) {
  if (!release.isPrerelease) throw new Error('Refusing to change a stable release')
  console.log(`${tag} is already published; immutable assets are unchanged.`)
} else {
  if (!release) gh(['release', 'create', tag, '--repo', repo, '--target', commit, '--draft', '--prerelease', '--title', `SpawnLoft ${version} — Mac preview`, '--notes-file', notes])
  gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'])
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false'])
  console.log(`Published ${tag}; stable and Windows assets are unchanged.`)
}
