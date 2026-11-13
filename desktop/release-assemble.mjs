#!/usr/bin/env node
// One 2.x release from the three platforms (rust/beta-review/REVIEW.md B4), on Victor's signing
// machine, as one command. Each platform is built where it can be:
//
//   Windows  release-windows.mjs on Desktop-Main: the Authenticode-signed setup, in
//            desktop/dist/v2-signed/<v>/, with <that folder>.gate-record.json beside it (the
//            Authenticode and trust checks, bound to the setup's sha256);
//   macOS    installer-mac.yml dispatched with release_version=<v>: artifact
//            installer-mac-release-<v> (the notarized .dmg, the Squirrel.Mac .zip, the updater
//            tarball);
//   Linux    installer-linux.yml dispatched with version=<v>: artifact installer-linux-release-<n>
//            (the four desktop and four spawnloft-cli packages and release-gate-record.json, the
//            dpkg/rpm checks bound to each package's sha256).
//
// This script takes the three, signs the update set ONCE with the release key on the release names
// (desktop/release-feed.mjs: the installer and mac tarball signatures, the envelope, latest.json,
// every 1.x feed), and runs the release gate in release mode over the whole folder, with the two
// records as --evidence for the checks this machine cannot make. It publishes nothing; the folder
// it leaves is what release-publish.mjs takes (dry run first, then --confirm, Victor's call).
//
//   node desktop/release-assemble.mjs --version <v> --key <release minisign secret key file>
//        --windows <release-windows.mjs output folder>
//        (--mac <folder> | --mac-run <run id>) (--linux <folder> | --linux-run <run id>)
//        [--out <dir>] (default desktop/dist/release/<v>)  [--repo joogiebear/spawnloft]
//        [--tauri <tauri CLI>] (default: the pinned CLI, installed for the run)
//        [--min-version <v>] (default 2.0.0-beta.1)  [--allow-mixed-commits]
//
// The key's password is read from TAURI_SIGNING_PRIVATE_KEY_PASSWORD (set it in the terminal, not
// in a file). The --*-run forms download the workflow artifacts with gh, and check that both runs
// built the commit the Windows signing report names. A report of the assembly is written beside
// the folder (<out>.assembly-report.json), never into it; downloaded artifacts go to <out>.inputs/.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { assemble, makeTauriSigner, releaseNames } = await import(pathToFileURL(path.join(HERE, 'release-feed.mjs')).href)
const { gate } = await import(pathToFileURL(path.join(HERE, 'release-gate.mjs')).href)
export const TAURI_CLI_VERSION = '2.12.4'
export const LINUX_RECORD = 'release-gate-record.json'

export function parseArgs(argv) {
  const out = { repo: 'joogiebear/spawnloft', minVersion: '2.0.0-beta.1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--version': out.version = value(); break
      case '--key': out.key = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--windows': out.windows = value(); break
      case '--mac': out.mac = value(); break
      case '--linux': out.linux = value(); break
      case '--mac-run': out.macRun = value(); break
      case '--linux-run': out.linuxRun = value(); break
      case '--out': out.out = value(); break
      case '--repo': out.repo = value(); break
      case '--tauri': out.tauri = value(); break
      case '--min-version': out.minVersion = value(); break
      case '--allow-mixed-commits': out.allowMixedCommits = true; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  if (!out.version) throw new Error('--version is required')
  if (!/^2\.\d+\.\d+(-beta\.\d+)?$/.test(out.version)) throw new Error(`${out.version} is not a 2.x release version (2.x.y or 2.x.y-beta.N)`)
  if (!out.key) throw new Error('--key is required: the release is signed with the release key (UPDATER-KEYS.md)')
  if (!out.windows) throw new Error('--windows is required (the release-windows.mjs output folder)')
  if (!out.mac === !out.macRun) throw new Error('give exactly one of --mac <folder> and --mac-run <run id>')
  if (!out.linux === !out.linuxRun) throw new Error('give exactly one of --linux <folder> and --linux-run <run id>')
  out.pubkey ??= path.join(ROOT, 'rust', 'crates', 'spawnloft-shell', 'release.pub')
  out.out ??= path.join(HERE, 'dist', 'release', out.version)
  return out
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// The three platform inputs, by release name, and the two evidence records. Throws with every
// missing file at once, so a half-downloaded artifact is seen before anything is signed.
export function collectInputs({ version, windows, mac, linux }) {
  const names = releaseNames(version)
  const missing = []
  const need = (dir, name) => { const p = path.join(dir, name); if (!fs.existsSync(p)) missing.push(p); return p }
  const inputs = {
    win: need(windows, names.win.name),
    'mac-updater': need(mac, names['mac-updater'].name),
    'mac-dmg': need(mac, names['mac-dmg'].name),
    'mac-zip': need(mac, names['mac-zip'].name),
    deb: need(linux, names.deb.name),
    rpm: need(linux, names.rpm.name),
    'deb-arm64': need(linux, names['deb-arm64'].name),
    'rpm-arm64': need(linux, names['rpm-arm64'].name),
    cli: ['amd64.deb', 'x86_64.rpm', 'arm64.deb', 'aarch64.rpm'].map(s => need(linux, `spawnloft-cli-${version}-linux-${s}`)),
  }
  const evidence = [need(path.dirname(path.resolve(windows)), `${path.basename(path.resolve(windows))}.gate-record.json`), need(linux, LINUX_RECORD)]
  const report = path.join(path.dirname(path.resolve(windows)), `${path.basename(path.resolve(windows))}.signing-report.json`)
  if (missing.length) throw new Error(`these inputs are missing:\n  ${missing.join('\n  ')}`)
  return { inputs, evidence, signingReport: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null }
}

// Signs and gates. `sign` and `tools` are injectable for the tests; the real run uses the Tauri CLI
// and what this host has.
export function assembleRelease({ version, out, pubkey, minVersion, date }, { inputs, evidence }, { sign, tools } = {}) {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} already holds files; move it away or pick another --out`)
  assemble({ out, version, pubkey, sign: true, date: date ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'), cli: inputs.cli,
    extraEnvelope: ['--min-version', minVersion], ...Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== 'cli')) }, sign)
  const result = gate({ dir: out, version, pubkey, release: true, evidence, tools })
  return result
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).trim()
}

// Downloads one run's artifact (by exact name or a pattern) into a fresh folder and returns it,
// with the commit the run built.
function download(repo, run, { name, pattern }, into) {
  fs.mkdirSync(into, { recursive: true })
  gh(['run', 'download', String(run), '--repo', repo, '--dir', into, ...(name ? ['--name', name] : ['--pattern', pattern])])
  // a pattern download puts each artifact in its own folder
  const dirs = fs.readdirSync(into).map(n => path.join(into, n)).filter(p => fs.statSync(p).isDirectory())
  const dir = name ? into : (dirs.length === 1 ? dirs[0] : null)
  if (!dir) throw new Error(`run ${run}: expected one ${pattern} artifact, found ${dirs.length}`)
  const commit = gh(['api', `repos/${repo}/actions/runs/${run}`, '--jq', '.head_sha'])
  return { dir, commit }
}

function installTauri(work) {
  const prefix = path.join(work, 'tauri-cli')
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const [cmd, pre] = fs.existsSync(npmCli) ? [process.execPath, [npmCli]] : ['npm', []]
  const res = spawnSync(cmd, [...pre, 'install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', `@tauri-apps/cli@${TAURI_CLI_VERSION}`], { stdio: 'inherit', shell: cmd === 'npm' && process.platform === 'win32' })
  if (res.status !== 0) throw new Error('the pinned Tauri CLI could not be installed')
  return path.join(prefix, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
}

async function main(argv) {
  const opts = parseArgs(argv)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-assemble-'))
  try {
    const commits = {}
    // downloads are kept beside the folder: the Linux record is the publish step's --evidence too
    const inputsDir = `${opts.out}.inputs`
    if ((opts.macRun || opts.linuxRun) && fs.existsSync(inputsDir)) throw new Error(`${inputsDir} already exists; move it away first`)
    if (opts.macRun) {
      const d = download(opts.repo, opts.macRun, { name: `installer-mac-release-${opts.version}` }, path.join(inputsDir, 'mac'))
      opts.mac = d.dir; commits.mac = d.commit
    }
    if (opts.linuxRun) {
      const d = download(opts.repo, opts.linuxRun, { pattern: 'installer-linux-release-*' }, path.join(inputsDir, 'linux'))
      opts.linux = d.dir; commits.linux = d.commit
    }
    const collected = collectInputs(opts)
    if (collected.signingReport?.commit) commits.windows = collected.signingReport.commit
    if (collected.signingReport && collected.signingReport.releaseKey !== 'release') {
      throw new Error('the Windows build was signed for a throwaway key run (its signing report says so); build it again with --key')
    }
    const distinct = [...new Set(Object.values(commits))]
    if (distinct.length > 1 && !opts.allowMixedCommits) throw new Error(`the platforms were built from different commits: ${JSON.stringify(commits)}`)
    if (!commits.mac || !commits.linux) console.warn('note: the mac or Linux folder was given by hand, so its commit is not checked against the Windows build')

    const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    if (password === undefined) throw new Error('set TAURI_SIGNING_PRIVATE_KEY_PASSWORD for the release key (in this terminal, not in a file)')
    process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(opts.key, 'utf8')
    const tauri = opts.tauri ?? installTauri(work)

    console.log(`Assembling ${opts.version} into ${opts.out}`)
    const result = assembleRelease(opts, collected, { sign: makeTauriSigner(tauri) })
    for (const n of result.notes) console.log(`  ok   ${n}`)
    const report = {
      version: opts.version, assembledAt: new Date().toISOString(), machine: os.hostname(), commits,
      inputs: Object.fromEntries([...Object.entries(collected.inputs).filter(([k]) => k !== 'cli'), ...collected.inputs.cli.map(f => [path.basename(f), f])].map(([k, f]) => [k, { file: f, sha256: sha256(f) }])),
      evidence: collected.evidence, gate: { ok: result.ok, problems: result.problems }, published: false,
    }
    fs.writeFileSync(`${opts.out}.assembly-report.json`, JSON.stringify(report, null, 2) + '\n')
    if (!result.ok) {
      for (const p of result.problems) console.error(`  FAIL ${p}`)
      throw new Error('the release gate did not pass on the assembled folder; nothing may be published from it')
    }
    const commit = distinct[0] ?? '<the commit all three were built from>'
    console.log(`\n${opts.version} is assembled and gated in ${opts.out}. Nothing has been published.`)
    console.log('The publish step (dry run first; --confirm is Victor\'s call):')
    console.log(`  node desktop/release-publish.mjs --dir "${opts.out}" --version ${opts.version} --commit ${commit} ${collected.evidence.map(e => `--evidence "${e}"`).join(' ')}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(`release-assemble: ${e.message}`); process.exit(1) })
}
