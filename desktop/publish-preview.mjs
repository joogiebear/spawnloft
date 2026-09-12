import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyRelease, verifyPublishedRelease } from './preview-artifacts.mjs'
import signing from './mac-signing.cjs'
import notesRenderer from './preview-notes.cjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, 'dist/preview-release')
const sourceVersion = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
const rootVersion = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8')).version
if (sourceVersion !== rootVersion) throw new Error('Desktop and core source versions differ')
if (process.env.GITHUB_REF !== 'refs/heads/dev' || !/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '') ||
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_NUMBER || '')) throw new Error('Only a numbered development workflow may publish')
const version = `${sourceVersion.split('-')[0]}-beta.${Number(process.env.GITHUB_RUN_NUMBER) + 1}`
const verified = verifyRelease(dir, { sourceVersion, version, commit: process.env.GITHUB_SHA, macSigningMode: signing.signingMode() })
const repo = 'joogiebear/spawnloft'
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const currentDev = () => gh(['api', `repos/${repo}/commits/dev`, '--jq', '.sha'])
if (currentDev() !== verified.commit) throw new Error('dev moved while this build ran; publish the newer build instead')
const tag = `v${verified.version}`
// A pre-existing git tag can outlive a removed draft. --target does not move
// such a tag, so check it before creating or completing any release.
let taggedCommit
try { taggedCommit = gh(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']) }
catch (error) {
  if (!/HTTP (404|422)/.test(String(error.stderr))) throw error
}
if (taggedCommit && taggedCommit !== verified.commit) throw new Error('Existing beta tag points to a different commit')
let release
try { release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`])) }
catch (error) {
  if (!String(error.stderr).includes('HTTP 404')) throw error
}
if (release && !release.draft) {
  verifyPublishedRelease(release, taggedCommit, verified)
  console.log(`${tag} is already published with the same verified files; nothing changed.`)
} else {
  if (release) {
    if (!release.prerelease || release.target_commitish !== verified.commit ||
        release.assets.some(asset => !verified.assets.some(local => local.name === asset.name))) {
      throw new Error('Refusing to reuse a draft with a different target or unexpected assets')
    }
  }
  const notes = path.join(dir, 'release-notes.md')
  fs.writeFileSync(notes, notesRenderer.renderPreviewNotes(fs.readFileSync(path.join(here, 'PREVIEW.md'), 'utf8'), verified.macSigningMode) +
    `\n\nBuilt together from [\`${verified.commit.slice(0, 12)}\`](https://github.com/${repo}/commit/${verified.commit}), based on development version ${sourceVersion}.\n`)
  // Nothing becomes public until every platform and the Windows updater feed are
  // uploaded. Published releases are immutable and are never overwritten here.
  if (!release) gh(['release', 'create', tag, '--repo', repo, '--target', verified.commit, '--draft', '--prerelease', '--title', `SpawnLoft ${verified.version} — Windows and Mac beta`, '--notes-file', notes])
  gh(['release', 'upload', tag, ...verified.assets.map(asset => asset.path), '--repo', repo, '--clobber'])
  if (currentDev() !== verified.commit) throw new Error('dev moved during upload; leaving the older build as a draft')
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false'])
  console.log(`Published ${tag} with Windows, Apple Silicon, and Intel Mac packages.`)
}
