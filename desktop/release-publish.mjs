#!/usr/bin/env node
// Publishes one assembled 2.x release to GitHub Releases in the order the scratch-repo findings
// (release-ordering-4b) force, so no install's update check ever 404s on a half-made release:
//
//   1. the release gate (release-gate.mjs) must pass on <dir> first;
//   2. a DRAFT release is created or reused — a draft creates no git tag and no releases.atom
//      entry, so discovery never sees the tag before its assets exist (a bare tag or an
//      unfinished release newer than the newest beta makes every beta check 404);
//   3. every asset is uploaded and the size and sha256 digest GitHub reports for each uploaded
//      asset are compared to the local bytes before anything is made public (as publish-stable
//      does; GitHub computes the digest from the stored bytes);
//   4. only then is the draft flipped to published, atomically carrying its prerelease and
//      make_latest flags. make_latest follows the rule in release-gate.releaseFlags: a beta is a
//      prerelease and is never latest; a stable release is latest unless deliberately held back.
//
// The gate runs in release mode (release-gate.mjs --release; rust/beta-review/REVIEW.md B5): at
// least everything the build checked, so a publish never takes bytes the build gate would refuse.
// That is the setup's Authenticode publisher, the Linux packages, the binary versions, what every
// build trusts (B6), a complete platform set (B4) and a feed signed by a release key. A check
// this machine cannot make (Authenticode off Windows; the Linux packages without dpkg-deb and
// rpm) must be covered by an --evidence record a passing gate wrote on a machine that could, for
// the same bytes; otherwise nothing is published. --partial, --throwaway-key and --unsigned exist
// for the dry runs; --confirm refuses the last two.
//
// Nothing publishes without --confirm, and the publish step is never run by the dry-run workflow.
// The real run needs the TAURI signing secrets (already spent at build time) and gh auth.
//
//   node release-publish.mjs --dir <assembled dir> --version <v> --commit <sha>
//        [--channel stable|beta] [--make-latest true|false] [--repo joogiebear/spawnloft]
//        [--notes <file>] [--installed <dir>]... [--binary <file>]... [--evidence <record>]...
//        [--authenticode-cn <name>] [--partial] [--throwaway-key] [--unsigned] [--confirm]
//        [--allow-prebeta-number]   (beta.1000 and up are pre-beta build numbers; refused otherwise)
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { gate, releaseFlags, semverLess, semverKey } = await import(pathToFileURL(path.join(HERE, 'release-gate.mjs')).href)
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
      case '--make-latest': { const v = value(); if (v !== 'true' && v !== 'false') throw new Error('--make-latest takes true or false'); out.makeLatest = v === 'true'; break }
      case '--repo': out.repo = value(); break
      case '--notes': out.notes = value(); break
      case '--pubkey': out.pubkey = value(); break
      // always on now (release mode); accepted so older command lines keep working
      case '--check-binary-versions': break
      case '--installed': (out.installed ??= []).push(value()); break
      case '--binary': (out.binaries ??= []).push(value()); break
      case '--evidence': (out.evidence ??= []).push(value()); break
      case '--authenticode-cn': out.authenticodeCn = value(); break
      case '--partial': out.partial = true; break
      // a real publish of fewer than all platforms: 1.x installs on the missing ones get no update
      case '--allow-partial-publish': out.allowPartialPublish = true; break
      case '--throwaway-key': out.throwawayKey = true; break
      case '--unsigned': out.unsigned = true; break
      case '--confirm': out.confirm = true; break
      case '--allow-prebeta-number': out.allowPrebetaNumber = true; break
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

// `inject` is for the tests: { tools } stands in for what this host can check.
export function main(argv, inject = {}) {
  const opts = { ...parseArgs(argv), ...inject }
  const { prerelease, makeLatest } = releaseFlags(opts.channel, opts.makeLatest)

  // Pre-beta builds made on the signing machine are numbered beta.1001 and up so they never take
  // a public number (rust/SIGNING-WINDOWS.md). One of them published would sit above every real
  // beta: the ordering rule below would then refuse 2.0.0-beta.1 for good.
  if (opts.confirm && isPrebetaNumber(opts.version) && !opts.allowPrebetaNumber) {
    throw new Error(`${opts.version} is a pre-beta build number (beta.1000 and up are never published); nothing was published`)
  }
  // the two dry-run waivers never reach a real publish
  if (opts.confirm && opts.throwawayKey) throw new Error('--throwaway-key is for dry runs: a release is signed by a release key; nothing was published')
  if (opts.confirm && opts.partial && !opts.allowPartialPublish) throw new Error('--partial is for dry runs: a published release carries every platform (pass --allow-partial-publish only on purpose); nothing was published')
  if (opts.confirm && opts.unsigned) throw new Error('--unsigned is for dry runs: every 1.x Windows install checks the publisher; nothing was published')

  // 1. the gate in release mode, on the exact bytes about to be published (B5)
  const result = gate({ dir: opts.dir, version: opts.version, pubkey: opts.pubkey, channel: opts.channel, makeLatest: opts.makeLatest,
    release: true, authenticodeCn: opts.authenticodeCn, partial: opts.partial, throwawayKey: opts.throwawayKey, unsigned: opts.unsigned,
    installed: opts.installed, binaries: opts.binaries, evidence: opts.evidence, tools: opts.tools })
  if (!result.ok) {
    for (const p of result.problems) console.error(`  FAIL ${p}`)
    throw new Error('the release gate did not pass; nothing was published')
  }

  const tag = `v${opts.version}`
  const assets = assetPaths(opts.dir)
  const local = assets.map(p => { const bytes = fs.readFileSync(p); return { name: path.basename(p), size: bytes.length, sha256: sha256(bytes), path: p } })

  if (!opts.confirm) {
    for (const n of result.notes) console.log(`  ok   ${n}`)
    console.log(`DRY: would publish ${tag} to ${opts.repo} from ${opts.commit.slice(0, 12)}: ${assets.length} assets${opts.partial ? ` (PARTIAL: ${result.platforms.join(', ')})` : ''}, prerelease=${prerelease}, make_latest=${makeLatest}.`)
    console.log('Pass --confirm (with gh authenticated and the signing already done) to publish.')
    return { tag, prerelease, makeLatest, assets: local.map(a => a.name) }
  }

  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim()
  // no bare tag may exist ahead of the release (it would be seen by discovery before the assets)
  let taggedCommit
  try { taggedCommit = gh(['api', `repos/${opts.repo}/commits/${tag}`, '--jq', '.sha']) }
  catch (error) { if (!/HTTP (404|422)/.test(String(error.stderr))) throw error }
  if (taggedCommit && taggedCommit !== opts.commit) throw new Error(`${tag} already exists on a different commit`)
  if (taggedCommit === opts.commit) console.warn(`WARNING: ${tag} already points at ${opts.commit.slice(0, 12)} with no complete release; every beta install's check 404s until this finishes.`)

  const allReleases = JSON.parse(gh(['api', `repos/${opts.repo}/releases`, '--paginate', '--slurp'])).flat()
  const existing = allReleases.filter(r => r.tag_name === tag || r.name === tag)
  if (existing.length > 1) throw new Error('more than one release claims this tag')
  const release = existing[0]
  if (release && !release.draft) {
    verifyUploaded(release, local)
    console.log(`${tag} is already published with these exact assets.`)
    return { tag, prerelease, makeLatest, assets: local.map(a => a.name), alreadyPublished: true }
  }

  checkOrdering(gh, opts, tag, allReleases.filter(r => !r.draft && r.tag_name && r.tag_name !== tag))

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

// `X.Y.Z-beta.N` with N of 1000 or more: the numbers the pre-beta builds use.
export function isPrebetaNumber(version) {
  const m = /-beta\.(\d+)$/.exec(version)
  return !!m && Number(m[1]) >= 1000
}

// Ordering (P0-E 4b / design 11): a 2.x release must be a higher version than every published
// release and sit on a commit newer than the newest published one's, or a beta install's check is
// offered the wrong release (discovery is by tagged-commit date, and GitHub's own order lags).
function checkOrdering(gh, opts, tag, published) {
  if (!published.length) return
  for (const r of published) {
    const v = r.tag_name.replace(/^v/, '')
    if (semverKey(v) && !semverLess(v, opts.version)) {
      throw new Error(`${r.tag_name} is not below ${tag}; a release must be a higher version than every published one`)
    }
  }
  // the newest published release by creation time is the reference; our tagged commit must be newer
  const newest = published.reduce((a, b) => (new Date(a.created_at) >= new Date(b.created_at) ? a : b))
  const ourDate = new Date(gh(['api', `repos/${opts.repo}/commits/${opts.commit}`, '--jq', '.commit.committer.date']))
  let theirDate
  try { theirDate = new Date(gh(['api', `repos/${opts.repo}/commits/${newest.tag_name}`, '--jq', '.commit.committer.date'])) }
  catch { return } // a tag that no longer resolves can't be the reference
  if (ourDate.getTime() <= theirDate.getTime()) {
    throw new Error(`${tag}'s commit is not newer than ${newest.tag_name}'s; release ordering is by commit date (P0-E 4b)`)
  }
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
  // not into opts.dir: that folder is the gated, to-be-published asset set, and a retry re-gates it
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-notes-')), 'release-notes.md')
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
