// The release gate (rust/INSTALLER-UPDATER-DESIGN.md 5.3, "the release gate (verify-build)"):
// the last check on an assembled release folder before anything is tagged or published. Run on
// the output of release-feed.mjs. It re-does, from the bytes on disk, everything a client would
// check, so a release never ships a feed its own clients would refuse:
//
//   - the signed envelope verifies with the release public key, its keyId and trusted comment
//     agree with the payload (update-envelope.mjs verifyEnvelope),
//   - every signed artifact the envelope names verifies against its bytes, with the size and
//     sha512 the envelope records, by the same key,
//   - latest.json is exactly what the envelope derives,
//   - the 1.x electron-updater feeds (latest*.yml / beta*.yml) describe the shipped bytes and the
//     two channel files are identical,
//   - the version, channel and the make_latest/prerelease pair are consistent (the make_latest
//     rule, 12 and the scratch-repo ordering findings): a prerelease is never marked latest, a
//     stable release is latest unless it is deliberately held,
//   - nothing unexpected is in the folder.
//
//   node release-gate.mjs --dir <dir> --version <v> --pubkey <file.pub>
//        [--channel stable|beta] [--make-latest true|false] [--data-format <n>]
//
// Exits non-zero and prints every problem if the folder is not fit to publish.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyWindowsFeed, verifyLinuxFeed } from './preview-artifacts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const U = await import(pathToFileURL(path.join(HERE, 'update-envelope.mjs')).href)
const { ENVELOPE_FILE, parsePublicKey, verifyEnvelope, verifyMinisign, buildLatestJson, artifactTargets, channelOf } = U

const sha512hex = bytes => crypto.createHash('sha512').update(bytes).digest('hex')

// The make_latest / prerelease pair a channel allows. Betas are prereleases and can never be
// latest (electron-updater stable reads /releases/latest; betas follow releases.atom order).
// A stable release is latest by default; it may be held back (make_latest false) for a controlled
// rollout, e.g. a 1.x hotfix published after 2.0 or a 2.0.0 kept off stable during a bake.
export function releaseFlags(channel, makeLatest) {
  if (channel === 'beta') {
    if (makeLatest === true) throw new Error('a beta prerelease can never be marked the latest release')
    return { prerelease: true, makeLatest: false }
  }
  if (channel === 'stable') return { prerelease: false, makeLatest: makeLatest !== false }
  throw new Error(`${channel} has no update channel, so it is not a release`)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--dir': out.dir = value(); break
      case '--version': out.version = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--channel': out.channel = value(); break
      case '--make-latest': out.makeLatest = value() === 'true'; break
      case '--data-format': out.dataFormat = Number(value()); break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  for (const k of ['dir', 'version', 'pubkey']) if (!out[k]) throw new Error(`--${k} is required`)
  out.channel ??= channelOf(out.version)
  return out
}

// Returns { ok, problems, notes, flags, targets }. Pure: reads the folder, touches no network.
export function gate({ dir, version, pubkey, channel, makeLatest, dataFormat }) {
  const problems = []
  const notes = []
  const seen = new Set()
  const read = name => { seen.add(name); return fs.readFileSync(path.join(dir, name)) }
  const has = name => fs.existsSync(path.join(dir, name))

  channel ??= channelOf(version)
  let flags = null
  try { flags = releaseFlags(channel, makeLatest) } catch (e) { problems.push(e.message) }

  const key = parsePublicKey(fs.readFileSync(pubkey, 'utf8'))

  // The envelope and its signature.
  let envelope = null
  try {
    const bytes = read(ENVELOPE_FILE)
    const sig = read(`${ENVELOPE_FILE}.sig`).toString('utf8').trim()
    envelope = verifyEnvelope(bytes, sig, key)
  } catch (e) {
    problems.push(`${ENVELOPE_FILE}: ${e.message}`)
  }

  if (envelope) {
    if (envelope.version !== version) problems.push(`the envelope says ${envelope.version}, this release is ${version}`)
    if (envelope.channel !== channel) problems.push(`the envelope channel is ${envelope.channel}, expected ${channel}`)
    if (envelope.keyId !== key.keyId) problems.push(`the envelope names key ${envelope.keyId}, the public key is ${key.keyId}`)
    if (dataFormat !== undefined && envelope.dataFormat !== dataFormat) problems.push(`the envelope data format is ${envelope.dataFormat}, expected ${dataFormat}`)

    // Every artifact the envelope names must be present, match its size/sha512, and (signed ones)
    // verify with the release key on the bytes on disk.
    for (const target of artifactTargets(version)) {
      const entry = envelope.platforms[target.target]
      const present = has(target.file)
      if (!entry) {
        if (present) problems.push(`${target.file} is in the folder but not in the envelope`)
        continue
      }
      if (!present) { problems.push(`the envelope names ${target.file}, which is not in the folder`); continue }
      const bytes = read(target.file)
      if (entry.size !== bytes.length) problems.push(`${target.file}: the envelope size ${entry.size} is not the file's ${bytes.length}`)
      if (entry.sha512 !== sha512hex(bytes)) problems.push(`${target.file}: the envelope sha512 does not match the file`)
      if (target.signed) {
        const sigName = `${target.file}.sig`
        if (!has(sigName)) { problems.push(`${target.file}: no ${sigName} beside it`); continue }
        const sig = read(sigName).toString('utf8').trim()
        if (entry.signature !== sig) problems.push(`${target.file}: the envelope signature is not the .sig on disk`)
        else if (!verifyMinisign(bytes, sig, key)) problems.push(`${target.file}: its signature does not verify with the release key`)
        else notes.push(`${target.file}: signed and verified`)
      } else if (present) {
        notes.push(`${target.file}: present (${bytes.length} bytes)`) // package manager verifies the bytes
      }
    }
    if (!Object.keys(envelope.platforms).length) problems.push('the envelope names no platform')

    // latest.json must be exactly what the envelope derives.
    if (!has('latest.json')) problems.push('latest.json is missing')
    else {
      const got = read('latest.json').toString('utf8')
      const want = JSON.stringify(buildLatestJson(envelope), null, 2) + '\n'
      if (got !== want) problems.push('latest.json is not the manifest derived from the envelope')
      else notes.push('latest.json matches the envelope')
    }
  }

  // The 1.x electron-updater feeds, each pair identical, each describing the shipped bytes.
  const installer = `SpawnLoft-Setup-${version}.exe`
  if (has(installer)) {
    checkFeedPair(dir, ['latest.yml', 'beta.yml'], read, problems, notes, text =>
      verifyWindowsFeed(text, version, installer, read(installer)))
  }
  const macZip = `SpawnLoft-${version}-mac-arm64.zip`
  if (has(macZip)) {
    // the mac channel file has the same one-file shape as the Windows feed
    checkFeedPair(dir, ['latest-mac.yml', 'beta-mac.yml'], read, problems, notes, text =>
      verifyWindowsFeed(text, version, macZip, read(macZip)))
  }
  for (const [arch, debName, rpmName, names] of [
    ['x64', `SpawnLoft-${version}-linux-amd64.deb`, `SpawnLoft-${version}-linux-x86_64.rpm`, ['latest-linux.yml', 'beta-linux.yml']],
    ['arm64', `SpawnLoft-${version}-linux-arm64.deb`, `SpawnLoft-${version}-linux-aarch64.rpm`, ['latest-linux-arm64.yml', 'beta-linux-arm64.yml']],
  ]) {
    const packages = [debName, rpmName].filter(has).map(name => ({ name, bytes: read(name) }))
    if (packages.length) checkFeedPair(dir, names, read, problems, notes, text => verifyLinuxFeed(text, version, packages))
  }

  // Nothing unexpected. Every file in the folder should have been read by a check above.
  for (const name of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, name)).isFile()) { problems.push(`${name} is a directory; a release folder is flat`); continue }
    if (!seen.has(name)) problems.push(`${name} is in the release folder but no check accounts for it`)
  }

  const targets = envelope ? Object.keys(envelope.platforms) : []
  return { ok: problems.length === 0, problems, notes, flags, targets, channel, version }
}

function checkFeedPair(dir, names, read, problems, notes, verify) {
  const texts = names.map(n => { try { return read(n) } catch { problems.push(`${n} is missing`); return null } })
  if (texts.some(t => t === null)) return
  if (!texts[0].equals(texts[1])) { problems.push(`${names.join(' and ')} must be identical`); return }
  try { verify(texts[0].toString('utf8')); notes.push(`${names.join(' / ')}: describe the shipped bytes`) }
  catch (e) { problems.push(`${names[0]}: ${e.message}`) }
}

export function main(argv) {
  const opts = parseArgs(argv)
  const result = gate(opts)
  for (const note of result.notes) process.stdout.write(`  ok   ${note}\n`)
  if (!result.ok) {
    process.stdout.write('\n')
    for (const p of result.problems) process.stdout.write(`  FAIL ${p}\n`)
    process.stdout.write('\nThis release must not be published.\n')
    process.exit(1)
  }
  const { prerelease, makeLatest } = result.flags
  process.stdout.write(`\nRelease ${result.version} (${result.channel}) is fit to publish: ${result.targets.length} platform(s), prerelease=${prerelease}, make_latest=${makeLatest}.\n`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`release-gate: ${err.message}`)
    process.exit(1)
  }
}
