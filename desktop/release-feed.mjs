// Assembles the full update asset set of one 2.x release (rust/INSTALLER-UPDATER-DESIGN.md 5.2)
// from the raw `tauri build` bundles, from verified bytes:
//
//   - copies each bundle to its release name (SpawnLoft-Setup-<v>.exe,
//     SpawnLoft-<v>-mac-arm64.app.tar.gz / .dmg / .zip, SpawnLoft-<v>-linux-<arch>.deb / .rpm),
//   - RE-SIGNS the signed ones (installer, mac updater tarball) with the release key on the
//     release name, because `tauri build`'s own .sig carries the raw file name in its trusted
//     comment and the client binds the signature by `file:` (5.3); update-envelope.mjs refuses a
//     .sig whose comment names another file,
//   - writes the signed envelope `spawnloft-updates.json` (+ .sig) and `latest.json` through
//     desktop/update-envelope.mjs (T2), and
//   - writes the 1.x electron-updater feeds (latest*.yml / beta*.yml) from the same verified
//     bytes, so a 1.x install finds the 2.0 installer and does the handover (5.2, last row).
//
//   node release-feed.mjs --out <dir> --version <v> --pubkey <file.pub>
//        [--win <setup.exe>] [--mac-updater <app.tar.gz>] [--mac-dmg <dmg>] [--mac-zip <zip>]
//        [--deb <deb> --rpm <rpm>] [--deb-arm64 <deb> --rpm-arm64 <rpm>] [--cli <file> ...]
//        [--channel stable|beta] [--min-version <v>] [--data-format <n>] [--expires-days <n>]
//        [--notes <url>] [--generated-at <iso>] [--tauri <path>] [--date <iso>]
//
// Signing uses the Tauri CLI (--tauri, or $TAURI_CLI) and TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)
// from the environment, the same key and secrets as `tauri build`. Tests inject their own signer
// as the second argument to assemble(). release-gate.mjs checks the finished folder before
// anything is published.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { main: envelopeMain, artifactTargets, ENVELOPE_FILE, parsePublicKey, verifyEnvelope } =
  await import(pathToFileURL(path.join(HERE, 'update-envelope.mjs')).href)

// A signer that calls `tauri signer sign --app-version <v> <file>`, writes <file>.sig and returns
// it. npm's `.bin/tauri` is an extensionless shell shim Node cannot exec on Windows, so when the
// path points at it, run the CLI's JS entry with this node instead (as updater-tests/make-feed.mjs
// does). TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) come from the environment, as for `tauri build`.
// Resolves `tauriArg` to a runnable argv. npm's `.bin/tauri` is an extensionless shell shim Node
// cannot exec on Windows, so point at the CLI's JS entry run by this node instead.
export function resolveTauriCommand(tauriArg = process.env.TAURI_CLI || 'tauri') {
  const m = String(tauriArg).match(/^(.*)[\\/]\.bin[\\/]tauri(\.cmd)?$/)
  return m ? [process.execPath, path.join(m[1], '@tauri-apps', 'cli', 'tauri.js')] : [tauriArg]
}

export function makeTauriSigner(tauriArg = process.env.TAURI_CLI || 'tauri') {
  const cmd = resolveTauriCommand(tauriArg)
  return (file, version) => {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('TAURI_SIGNING_PRIVATE_KEY (or _PATH) is not set')
    execFileSync(cmd[0], [...cmd.slice(1), 'signer', 'sign', '--app-version', version, file], { stdio: ['ignore', 'pipe', 'inherit'] })
    if (!fs.existsSync(`${file}.sig`)) throw new Error(`tauri signer sign wrote no ${file}.sig`)
    return fs.readFileSync(`${file}.sig`, 'utf8').trim()
  }
}

const sha512b64 = bytes => crypto.createHash('sha512').update(bytes).digest('base64')

// ---- the 1.x electron-updater feeds -------------------------------------------------------------
// Written in electron-builder's own YAML shape (keys in the order desktop/preview-artifacts.mjs
// verifies: version, files[].{url,sha512,size}, path, sha512, releaseDate), so a 1.x install reads
// them exactly as it reads a 1.x release's feed. The hashes come only from the shipped bytes.
const fileLines = ({ name, sha512, size }) => `  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\n`

// One installer or ZIP: latest.yml / beta.yml (Windows) and latest-mac.yml / beta-mac.yml.
export function singleFileFeed(name, bytes, version, date) {
  const sha512 = sha512b64(bytes)
  let text = `version: ${version}\nfiles:\n${fileLines({ name, sha512, size: bytes.length })}path: ${name}\nsha512: ${sha512}\n`
  if (date) text += `releaseDate: '${date}'\n`
  return text
}

// Every Linux package for one architecture (.deb and .rpm); the installed app picks the one that
// matches its own package marker. `path`/top hash name the .deb, as electron-builder writes it.
export function linuxFeed(packages, version, date) {
  const files = packages.map(({ name, bytes }) => ({ name, sha512: sha512b64(bytes), size: bytes.length }))
  const primary = files[0]
  let text = `version: ${version}\nfiles:\n${files.map(fileLines).join('')}path: ${primary.name}\nsha512: ${primary.sha512}\n`
  if (date) text += `releaseDate: '${date}'\n`
  return text
}

// electron-updater names the Linux feed per machine: latest-linux.yml on x64, latest-linux-arm64.yml
// on arm64, each with a beta- twin for the beta channel.
export const linuxFeedNames = arch => ['latest', 'beta'].map(channel => `${channel}-linux${arch === 'x64' ? '' : `-${arch}`}.yml`)

function writeBoth(dir, names, body) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), body)
}

// Writes every electron-updater feed the finished `out` folder should carry, from the release
// artifacts already renamed into it. Both channel names ship on every release so a beta install
// can move to stable and a stable install always finds the newest it may take.
export function writeElectronFeeds(out, version, date) {
  const read = name => fs.readFileSync(path.join(out, name))
  const installer = `SpawnLoft-Setup-${version}.exe`
  if (fs.existsSync(path.join(out, installer))) {
    writeBoth(out, ['latest.yml', 'beta.yml'], singleFileFeed(installer, read(installer), version, date))
  }
  const macZip = `SpawnLoft-${version}-mac-arm64.zip`
  if (fs.existsSync(path.join(out, macZip))) {
    writeBoth(out, ['latest-mac.yml', 'beta-mac.yml'], singleFileFeed(macZip, read(macZip), version, date))
  }
  for (const arch of ['x64', 'arm64']) {
    const packages = [
      `SpawnLoft-${version}-linux-${arch === 'x64' ? 'amd64' : 'arm64'}.deb`,
      `SpawnLoft-${version}-linux-${arch === 'x64' ? 'x86_64' : 'aarch64'}.rpm`,
    ].filter(name => fs.existsSync(path.join(out, name))).map(name => ({ name, bytes: read(name) }))
    if (packages.length) writeBoth(out, linuxFeedNames(arch), linuxFeed(packages, version, date))
  }
}

// ---- renaming and re-signing --------------------------------------------------------------------

// Copies `from` to `out/<releaseName>`; if `signed`, signs the copy on its release name so the
// trusted comment names the shipped file. `sign(file, version)` defaults to the Tauri CLI.
export function placeArtifact(out, from, releaseName, version, { signed = false, sign } = {}) {
  const dest = path.join(out, releaseName)
  fs.copyFileSync(from, dest)
  if (signed) (sign ?? makeTauriSigner())(dest, version)
  return dest
}

// The release names of the raw bundles handed in, by the kind of input. Kept in step with
// update-envelope.mjs's artifactTargets (the envelope reads these names back).
export function releaseNames(version) {
  return {
    win: { name: `SpawnLoft-Setup-${version}.exe`, signed: true },
    'mac-updater': { name: `SpawnLoft-${version}-mac-arm64.app.tar.gz`, signed: true },
    'mac-dmg': { name: `SpawnLoft-${version}-mac-arm64.dmg`, signed: false },
    'mac-zip': { name: `SpawnLoft-${version}-mac-arm64.zip`, signed: false },
    deb: { name: `SpawnLoft-${version}-linux-amd64.deb`, signed: false },
    rpm: { name: `SpawnLoft-${version}-linux-x86_64.rpm`, signed: false },
    'deb-arm64': { name: `SpawnLoft-${version}-linux-arm64.deb`, signed: false },
    'rpm-arm64': { name: `SpawnLoft-${version}-linux-aarch64.rpm`, signed: false },
  }
}

// ---- the command --------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { sign: true, cli: [], extraEnvelope: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--out': out.out = value(); break
      case '--version': out.version = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--win': out.win = value(); break
      case '--mac-updater': out['mac-updater'] = value(); break
      case '--mac-dmg': out['mac-dmg'] = value(); break
      case '--mac-zip': out['mac-zip'] = value(); break
      case '--deb': out.deb = value(); break
      case '--rpm': out.rpm = value(); break
      case '--deb-arm64': out['deb-arm64'] = value(); break
      case '--rpm-arm64': out['rpm-arm64'] = value(); break
      case '--cli': out.cli.push(value()); break
      case '--date': out.date = value(); break
      case '--tauri': out.tauri = value(); break
      // forwarded to update-envelope.mjs
      case '--channel': case '--min-version': case '--data-format':
      case '--expires-days': case '--notes': case '--generated-at':
        out.extraEnvelope.push(a, value()); break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  for (const k of ['out', 'version', 'pubkey']) if (!out[k]) throw new Error(`--${k} is required`)
  return out
}

export function assemble(opts, sign) {
  const signer = sign ?? makeTauriSigner(opts.tauri)
  fs.mkdirSync(opts.out, { recursive: true })
  const names = releaseNames(opts.version)
  for (const kind of Object.keys(names)) {
    if (!opts[kind]) continue
    placeArtifact(opts.out, opts[kind], names[kind].name, opts.version, { signed: opts.sign && names[kind].signed, sign: signer })
  }
  for (const file of opts.cli) fs.copyFileSync(file, path.join(opts.out, path.basename(file)))

  // The unsigned envelope + latest.json, over the release-named, re-signed artifacts just written;
  // update-envelope.mjs already checks every artifact signature against the public key here. The
  // envelope is then signed through the same injectable signer, and self-verified, so one code
  // path signs the installer, the tarball and the envelope.
  const envelope = envelopeMain(['--dist', opts.out, '--version', opts.version, '--pubkey', opts.pubkey, '--no-sign', ...opts.extraEnvelope])
  if (opts.sign) {
    // the signer writes <file>.sig (as `tauri signer sign` does); self-verify before it ships
    const envelopeFile = path.join(opts.out, ENVELOPE_FILE)
    const sig = signer(envelopeFile, opts.version)
    verifyEnvelope(fs.readFileSync(envelopeFile), sig, parsePublicKey(fs.readFileSync(opts.pubkey, 'utf8')))
  }

  writeElectronFeeds(opts.out, opts.version, opts.date)
  return envelope
}

export function main(argv) {
  const opts = parseArgs(argv)
  const envelope = assemble(opts)
  const present = artifactTargets(opts.version).filter(t => fs.existsSync(path.join(opts.out, t.file))).map(t => t.target)
  console.log(`release-feed: ${opts.out} assembled for ${opts.version} (${envelope.channel}); targets ${present.join(', ') || 'none'}`)
  return envelope
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`release-feed: ${err.message}`)
    process.exit(1)
  }
}
