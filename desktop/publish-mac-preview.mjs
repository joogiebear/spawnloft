import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, 'dist/mac-release')
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
if (!version.includes('-')) throw new Error('Only a development version may refresh the Mac preview')
const tag = `v${version}`
const repo = 'joogiebear/spawnloft'
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const release = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,isPrerelease,body']))
if (release.isDraft || !release.isPrerelease) throw new Error('The rolling target must already be a published prerelease')
const commit = gh(['api', `repos/${repo}/commits/dev`, '--jq', '.sha'])
// Do not let a queued, older workflow replace the current development downloads.
if (commit !== process.env.GITHUB_SHA) throw new Error('dev moved while this build ran; publish the newer build instead')
const assets = []
for (const arch of ['arm64', 'x64']) {
  const manifestName = `mac-build-${arch}.json`
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, manifestName), 'utf8'))
  if (manifest.arch !== arch || manifest.version !== version || manifest.commit !== commit || manifest.dirty) {
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
// Only the explicit Mac allowlist is replaced; Windows binaries, update feeds,
// the original tag, and stable/latest are never changed by this workflow.
gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'])
const guide = fs.readFileSync(path.join(here, 'MAC-PREVIEW.md'), 'utf8')
const section = `<!-- mac-preview:start -->\n${guide}\n\nMac build source: [\`${commit.slice(0, 12)}\`](https://github.com/${repo}/commit/${commit}). Refreshed ${new Date().toISOString()}.\n<!-- mac-preview:end -->`
const previous = release.body.replace(/<!-- mac-preview:start -->[\s\S]*?<!-- mac-preview:end -->\s*/g, '').trim()
const notes = path.join(dir, 'release-notes.md')
fs.writeFileSync(notes, section + '\n\n---\n\n' + previous + '\n')
gh(['release', 'edit', tag, '--repo', repo, '--notes-file', notes])
console.log(`Refreshed Mac previews on ${tag}; stable and Windows assets are unchanged.`)
