#!/usr/bin/env node
// Publishes one assembled 2.x release to GitHub Releases in the order the scratch-repo findings
// (release-ordering-4b) force, so no install's update check ever 404s on a half-made release:
//
//   1. the release gate (release-gate.mjs) must pass on <dir> first;
//   2. a DRAFT release is created or reused — a draft creates no git tag and no releases.atom
//      entry, so discovery never sees the tag before its assets exist (a bare tag or an
//      unfinished release newer than the newest beta makes every beta check 404);
//   3. every asset is uploaded and the uploaded bytes are read back and compared to the local
//      bytes (size and sha256) before anything is made public;
//   4. only then is the draft flipped to published, atomically carrying its prerelease and
//      make_latest flags. make_latest follows the rule in release-gate.releaseFlags: a beta is a
//      prerelease and is never latest; a stable release is latest unless deliberately held back.
//
// Nothing publishes without --confirm, and the publish step is never run by the dry-run workflow.
// The real run needs the TAURI signing secrets (already spent at build time) and gh auth.
//
//   node release-publish.mjs --dir <assembled dir> --version <v> --commit <sha>
//        [--channel stable|beta] [--make-latest true|false] [--repo joogiebear/spawnloft]
//        [--notes <file>] [--confirm]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { gate, releaseFlags } = await import(pathToFileURL(path.join(HERE, 'release-gate.mjs')).href)
const { channelOf } = await import(pathToFileURL(path.join(HERE, 'update-envelope.mjs')).href)

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function parseArgs(argv) {
  const out = { repo: 'joogiebear/spawnloft', confirm: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--dir': out.dir = value(); break
      case '--version': out.version = value(); break
      case '--commit': out.commit = value(); break
      case '--channel': out.channel = value(); break
      case '--make-latest': out.makeLatest = value() === 'true'; break
      case '--repo': out.repo = value(); break
      case '--notes': out.notes = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--confirm': out.confirm = true; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  for (const k of ['dir', 'version', 'commit']) if (!out[k]) throw new Error(`--${k} is required`)
  if (!/^[0-9a-f]{40}$/.test(out.commit)) throw new Error('--commit must be a full 40-character sha')
  out.channel ??= channelOf(out.version)
  out.pubkey ??= path.join(HERE, '..', 'rust', 'crates', 'spawnloft-shell', 'release.pub')
  return out
}

// The ordered list of asset paths in <dir>: everything the gate accounted for.
function assetPaths(dir) {
  return fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isFile()).map(n => path.join(dir, n))
}

export function main(argv) {
  const opts = parseArgs(argv)
  const { prerelease, makeLatest } = releaseFlags(opts.channel, opts.makeLatest)

  // 1. the gate, on the exact bytes about to be published
  const result = gate({ dir: opts.dir, version: opts.version, pubkey: opts.pubkey, channel: opts.channel, makeLatest: opts.makeLatest })
  if (!result.ok) {
    for (const p of result.problems) console.error(`  FAIL ${p}`)
    throw new Error('the release gate did not pass; nothing was published')
  }

  const tag = `v${opts.version}`
  const assets = assetPaths(opts.dir)
  const local = assets.map(p => { const bytes = fs.readFileSync(p); return { name: path.basename(p), size: bytes.length, sha256: sha256(bytes), path: p } })

  if (!opts.confirm) {
    console.log(`DRY: would publish ${tag} to ${opts.repo} from ${opts.commit.slice(0, 12)}: ${assets.length} assets, prerelease=${prerelease}, make_latest=${makeLatest}.`)
    console.log('Pass --confirm (with gh authenticated and the signing already done) to publish.')
    return { tag, prerelease, makeLatest, assets: local.map(a => a.name) }
  }

  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim()
  // no bare tag may exist ahead of the release (it would be seen by discovery before the assets)
  let taggedCommit
  try { taggedCommit = gh(['api', `repos/${opts.repo}/commits/${tag}`, '--jq', '.sha']) }
  catch (error) { if (!/HTTP (404|422)/.test(String(error.stderr))) throw error }
  if (taggedCommit && taggedCommit !== opts.commit) throw new Error(`${tag} already exists on a different commit`)

  const existing = JSON.parse(gh(['api', `repos/${opts.repo}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.tag_name === tag || r.name === tag)
  if (existing.length > 1) throw new Error('more than one release claims this tag')
  const release = existing[0]
  if (release && !release.draft) {
    verifyUploaded(release, local)
    console.log(`${tag} is already published with these exact assets.`)
    return { tag, prerelease, makeLatest, assets: local.map(a => a.name), alreadyPublished: true }
  }

  // 2. a draft (creates no tag yet) with the notes
  const notes = opts.notes ?? writeNotes(opts)
  if (!release) gh(['release', 'create', tag, '--repo', opts.repo, '--target', opts.commit, '--draft', '--title', `SpawnLoft ${opts.version}`, '--notes-file', notes])
  else if (release.target_commitish !== opts.commit) throw new Error('an existing draft targets a different commit')

  // 3. upload every asset, then read the uploaded bytes back
  gh(['release', 'upload', tag, ...local.map(a => a.path), '--repo', opts.repo, '--clobber'])
  const uploaded = JSON.parse(gh(['api', `repos/${opts.repo}/releases`, '--paginate', '--slurp'])).flat().filter(r => r.tag_name === tag || r.name === tag)
  if (uploaded.length !== 1 || !uploaded[0].draft || uploaded[0].target_commitish !== opts.commit) throw new Error('the uploaded draft has a different identity')
  verifyUploaded(uploaded[0], local)

  // 4. publish atomically with the channel's flags (this is when the tag and the atom entry appear)
  gh(['release', 'edit', tag, '--repo', opts.repo, `--draft=false`, `--prerelease=${prerelease}`, `--latest=${makeLatest}`])
  console.log(`Published ${tag}: ${local.length} assets, prerelease=${prerelease}, make_latest=${makeLatest}.`)
  return { tag, prerelease, makeLatest, assets: local.map(a => a.name) }
}

function verifyUploaded(release, local) {
  if (!Array.isArray(release.assets) || release.assets.length !== local.length) throw new Error('the published asset count differs from the built set')
  for (const a of local) {
    const remote = release.assets.filter(b => b.name === a.name)
    if (remote.length !== 1 || remote[0].state !== 'uploaded' || remote[0].size !== a.size || remote[0].digest !== `sha256:${a.sha256}`) {
      throw new Error(`the uploaded bytes of ${a.name} differ from the built asset`)
    }
  }
}

function writeNotes(opts) {
  const file = path.join(opts.dir, 'release-notes.md')
  const lead = opts.channel === 'beta'
    ? 'This is a 2.0 beta.'
    : 'SpawnLoft 2.0.'
  fs.writeFileSync(file, `${lead}\n\nServers are stopped and started again for this update. If you need to go back, see the release page.\n\nBuilt from \`${opts.commit.slice(0, 12)}\`.\n`)
  return file
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`release-publish: ${err.message}`)
    process.exit(1)
  }
}
