// Builds the loopback update feeds the updater scenarios run against (design section 11,
// scenarios 5 to 7): a `good` feed with every release, and one variant per refusal, each a folder
// `feed-server.cjs` serves at <base>: releases.atom, api/releases, download/<tag>/<asset>.
//
//   node make-feed.mjs --out <root> --base http://127.0.0.1:<port>/ --tauri <tauri cli>
//        --key <release private key file> --pubkey <its .pub> --next-key <file> --next-pubkey <.pub>
//        --other-key <an untrusted key> --other-pubkey <.pub>
//        --release <version>=<path to that version's setup exe> [--release ...]
//
// The throwaway keys come from `tauri signer generate` in the job (password empty). Every setup
// is copied under its release name (SpawnLoft-Setup-<v>.exe) and signed again with
// `tauri signer sign --app-version <v>` on that name, as the release pipeline does after
// renaming. Variants change the highest release only; the others are copied unchanged.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { main: envelopeMain, parsePublicKey, ENVELOPE_FILE } = await import(pathToFileURL(path.join(here, '..', '..', '..', '..', 'desktop', 'update-envelope.mjs')).href)

const args = process.argv.slice(2)
const opt = { releases: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  const v = () => args[++i]
  if (a === '--out') opt.out = v()
  else if (a === '--base') opt.base = v()
  else if (a === '--tauri') opt.tauri = v()
  else if (a === '--key') opt.key = v()
  else if (a === '--pubkey') opt.pubkey = v()
  else if (a === '--next-key') opt.nextKey = v()
  else if (a === '--next-pubkey') opt.nextPubkey = v()
  else if (a === '--other-key') opt.otherKey = v()
  else if (a === '--other-pubkey') opt.otherPubkey = v()
  else if (a === '--release') { const [ver, file] = v().split('='); opt.releases.push({ version: ver, setup: file }) }
  else throw new Error(`unknown argument ${a}`)
}
for (const k of ['out', 'base', 'tauri', 'key', 'pubkey', 'nextKey', 'nextPubkey', 'otherKey', 'otherPubkey']) if (!opt[k]) throw new Error(`--${k} is required`)
if (opt.releases.length < 2) throw new Error('at least two --release entries are needed')
const base = opt.base.endsWith('/') ? opt.base : `${opt.base}/`
const downloadBase = `${base}download/`

const semverKey = v => {
  const [core, pre] = v.split('-')
  const nums = core.split('.').map(Number)
  const preNum = pre ? Number(pre.split('.')[1] ?? 0) : Number.MAX_SAFE_INTEGER
  return [...nums, preNum]
}
const byVersionDesc = (a, b) => {
  const ka = semverKey(a.version), kb = semverKey(b.version)
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]
  return 0
}
opt.releases.sort(byVersionDesc)
const highest = opt.releases[0]
const lower = opt.releases[1]

// `--tauri` may point at npm's .bin shim, which is a shell script Windows cannot exec: run the
// CLI's JS entry with this node instead.
const tauriCommand = (() => {
  const m = opt.tauri.match(/^(.*)[\\/]\.bin[\\/]tauri(\.cmd)?$/)
  if (m) return [process.execPath, path.join(m[1], '@tauri-apps', 'cli', 'tauri.js')]
  return [opt.tauri]
})()

function sign(file, version, keyFile) {
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }
  const cliArgs = [...tauriCommand.slice(1), 'signer', 'sign']
  if (version) cliArgs.push('--app-version', version)
  cliArgs.push(file)
  execFileSync(tauriCommand[0], cliArgs, { env, stdio: ['ignore', 'pipe', 'inherit'] })
  return fs.readFileSync(`${file}.sig`, 'utf8').trim()
}

function atom(versions) {
  const entries = versions.map(v => `  <entry>\n    <id>tag:github.com,2008:Repository/1/v${v}</id>\n    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v${v}"/>\n    <title>v${v}</title>\n  </entry>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n${entries}\n</feed>\n`
}

// Every variant carries the same generatedAt: the scenarios check them in any order, and a feed
// stamped a second before one already accepted would trip the replay floor.
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

// Puts a release into a feed folder: the renamed, re-signed setup and a signed envelope.
function placeRelease(feedDir, release, { keyFile = opt.key, pubkeyFile = opt.pubkey, generatedAt = stamp, expiresAt, minVersion, envelopeEdit } = {}) {
  const dist = path.join(feedDir, 'download', `v${release.version}`)
  fs.mkdirSync(dist, { recursive: true })
  const setup = path.join(dist, `SpawnLoft-Setup-${release.version}.exe`)
  fs.copyFileSync(release.setup, setup)
  sign(setup, release.version, keyFile)
  const envArgs = ['--dist', dist, '--version', release.version, '--pubkey', pubkeyFile, '--download-base', downloadBase, '--no-sign', '--min-version', minVersion ?? '2.0.0-beta.1']
  if (generatedAt) envArgs.push('--generated-at', generatedAt)
  if (expiresAt !== undefined) envArgs.push('--expires-days', String(expiresAt))
  envelopeMain(envArgs)
  const envelopeFile = path.join(dist, ENVELOPE_FILE)
  if (envelopeEdit) {
    const doc = JSON.parse(fs.readFileSync(envelopeFile, 'utf8'))
    envelopeEdit(doc, dist)
    fs.writeFileSync(envelopeFile, JSON.stringify(doc, null, 2) + '\n')
  }
  sign(envelopeFile, release.version, keyFile)
  return dist
}

// Signs the envelope with a trusted comment made for another file: write the payload under that
// name in a scratch folder, sign it there, and use the signature for the envelope.
function signEnvelopeAs(dist, release, asFile, version) {
  const scratch = fs.mkdtempSync(path.join(dist, 'as-'))
  const file = path.join(scratch, asFile)
  fs.copyFileSync(path.join(dist, ENVELOPE_FILE), file)
  const sig = sign(file, version, opt.key)
  fs.writeFileSync(path.join(dist, `${ENVELOPE_FILE}.sig`), sig + '\n')
  fs.rmSync(scratch, { recursive: true, force: true })
}

const variants = {
  // every release as it should be
  good: () => {},
  // a byte of the signed envelope changed
  'tampered-envelope': dist => {
    const f = path.join(dist, ENVELOPE_FILE)
    const text = fs.readFileSync(f, 'utf8').replace('"dataFormat": 1', '"dataFormat": 1 ')
    fs.writeFileSync(f, text)
  },
  // the whole highest release signed by a key this build does not trust
  'wrong-key': null,
  // the envelope's signature was made for the setup file, not spawnloft-updates.json
  'wrong-comment': dist => signEnvelopeAs(dist, highest, `SpawnLoft-Setup-${highest.version}.exe`, highest.version),
  // the envelope's signature carries no version (signed without --app-version)
  'no-version-comment': dist => {
    const scratch = fs.mkdtempSync(path.join(dist, 'nv-'))
    const file = path.join(scratch, ENVELOPE_FILE)
    fs.copyFileSync(path.join(dist, ENVELOPE_FILE), file)
    const sig = sign(file, null, opt.key)
    fs.writeFileSync(path.join(dist, `${ENVELOPE_FILE}.sig`), sig + '\n')
    fs.rmSync(scratch, { recursive: true, force: true })
  },
  // payload names a key id that is not the signing key's
  'unknown-keyid': null,
  // generatedAt before the build's baseline
  'old-generated': null,
  // the setup's signature belongs to the lower release's setup
  'artifact-wrong-sig': null,
  // the setup signed without --app-version
  'artifact-no-version': null,
  // expiresAt in the past: accepted, reported stale
  expired: null,
  // minVersion above the installed version with no release in between
  'min-version': null,
  // the lower release only (a feed that offers nothing newer than the installed higher version)
  'only-lower': null,
  // the highest release signed by the "next" key, which the build trusts too (a rotation)
  rotation: null,
}

fs.rmSync(opt.out, { recursive: true, force: true })
for (const name of Object.keys(variants)) {
  const feedDir = path.join(opt.out, name)
  fs.mkdirSync(path.join(feedDir, 'api'), { recursive: true })
  const listed = name === 'only-lower' ? opt.releases.slice(1) : opt.releases
  fs.writeFileSync(path.join(feedDir, 'releases.atom'), atom(listed.map(r => r.version)))
  fs.writeFileSync(path.join(feedDir, 'api', 'releases'), JSON.stringify(listed.map(r => ({ tag_name: `v${r.version}`, draft: false, prerelease: r.version.includes('-') }))))
  // lower releases, unchanged
  for (const r of listed.slice(name === 'only-lower' ? 0 : 1)) placeRelease(feedDir, r)
  if (name === 'only-lower') continue
  switch (name) {
    case 'wrong-key':
      placeRelease(feedDir, highest, { keyFile: opt.otherKey, pubkeyFile: opt.otherPubkey })
      break
    case 'rotation':
      placeRelease(feedDir, highest, { keyFile: opt.nextKey, pubkeyFile: opt.nextPubkey })
      break
    case 'unknown-keyid':
      placeRelease(feedDir, highest, { envelopeEdit: doc => { doc.keyId = parsePublicKey(fs.readFileSync(opt.otherPubkey, 'utf8')).keyId } })
      break
    case 'old-generated':
      placeRelease(feedDir, highest, { generatedAt: '2020-01-01T00:00:00Z' })
      break
    case 'artifact-wrong-sig': {
      const lowerSig = fs.readFileSync(path.join(feedDir, 'download', `v${lower.version}`, `SpawnLoft-Setup-${lower.version}.exe.sig`), 'utf8').trim()
      placeRelease(feedDir, highest, { envelopeEdit: doc => { doc.platforms['windows-x86_64'].signature = lowerSig } })
      break
    }
    case 'artifact-no-version':
      placeRelease(feedDir, highest, {
        envelopeEdit: (doc, dist) => {
          const legacy = sign(path.join(dist, `SpawnLoft-Setup-${highest.version}.exe`), null, opt.key)
          doc.platforms['windows-x86_64'].signature = legacy
        },
      })
      break
    case 'expired':
      placeRelease(feedDir, highest, { expiresAt: -1 })
      break
    case 'min-version':
      placeRelease(feedDir, highest, { minVersion: highest.version })
      break
    default: {
      const dist = placeRelease(feedDir, highest)
      variants[name](dist)
    }
  }
}
console.log(`feeds written under ${opt.out}: ${Object.keys(variants).join(', ')}`)
