#!/usr/bin/env node
// A signed pre-beta Windows build of v2, on Victor's signing machine (Desktop-Main), as one
// command. Victor's call (2026-11-12, plan Q-T): pre-beta 2.0 builds are Authenticode-signed
// there, with the Azure signing profile 1.x stables already use, rather than through a new Azure
// federated credential for CI. Nothing is tagged, uploaded or published: the result is a folder.
//
//   node rust/crates/spawnloft-shell/installer/release-windows.mjs --version 2.0.0-beta.N
//        [--key <minisign secret key file> [--pubkey <its .pub>]]  (default: a throwaway key;
//                                                     --pubkey defaults to the shell's release.pub)
//        [--out <dir>]                                          (default: desktop/dist/v2-signed/<version>)
//        [--any-branch]                                         (sign a branch other than v2, on purpose)
//
// In order, stopping at the first problem:
//   1. checks: Windows, a clean checkout at the commit its upstream branch (v2) is at, an
//      `az login` session, a signing module, a beta version;
//   2. builds spawnloft-core.exe at that version and signs it (sign-windows.ps1): the bundler
//      copies resources as they are, so the core is signed before it is bundled;
//   3. stages the bundled Node (installer-config.mjs); node.exe keeps the OpenJS Foundation
//      signature it ships with, so its bytes still match the pinned archive (payload-gate);
//   4. `tauri build` with bundle.windows.signCommand = sign-windows.ps1, which signs the shell,
//      the uninstaller (inside makensis) and the setup;
//   5. assembles the update asset set (desktop/release-feed.mjs), the same step as release.yml;
//   6. runs the release gate with --authenticode-cn "victor zemeckis" and --signed for the
//      shell, the core and node.exe, --check-binary-versions, --runtime and --payload;
//   7. writes <out>.signing-report.json beside the folder (commit, version, key, each file's
//      sha256 and signer), so the folder itself holds only the release assets.
//
// It signs from v2 only (the branch the checkout tracks), unless --any-branch says otherwise.
//
// It never installs the build: on this machine that would replace the installed SpawnLoft. The
// installed-copy checks (--installed, the uninstaller's signature) belong to the W8 runs on a
// clean VM, with this folder's setup.
//
// The release key: without --key a throwaway minisign key is made for the run, and the build's
// updater trusts only that key, so these builds can never take or offer a real update. With the
// real key (UPDATER-KEYS.md), pass --key/--pubkey and put the password in
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD; it is read from the environment and never written down.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.resolve(HERE, '..')
const RUST = path.resolve(SHELL, '../..')
const ROOT = path.resolve(RUST, '..')
export const TAURI_CLI_VERSION = '2.12.4'
export const OPENJS_CN = 'OpenJS Foundation'
const { windowsPowerShellEnv } = await import(pathToFileURL(path.join(ROOT, 'desktop', 'windows-powershell.mjs')).href)

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--version': out.version = value(); break
      case '--key': out.key = value(); break
      case '--pubkey': out.pubkey = value(); break
      case '--out': out.out = value(); break
      // a branch other than v2 (a PR's branch, to try the script itself before it merges)
      case '--any-branch': out.anyBranch = true; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  if (!out.version) throw new Error('--version is required (2.0.0-beta.N)')
  // a pre-beta build is a beta of 2.x: release-gate's semverKey shape, never a stable version
  if (!/^2\.\d+\.\d+-beta\.\d+$/.test(out.version)) throw new Error(`${out.version} is not a 2.x beta version (2.0.0-beta.N)`)
  if (out.pubkey && !out.key) throw new Error('--pubkey is the public half of --key; pass both')
  return out
}

// The signing account, from the one place 1.x keeps it.
export function signingSettings(desktopPackage) {
  const o = desktopPackage?.build?.win?.azureSignOptions
  if (!o?.endpoint || !o.codeSigningAccountName || !o.certificateProfileName || !o.publisherName) throw new Error('desktop/package.json has no build.win.azureSignOptions')
  return { SPAWNLOFT_SIGN_ENDPOINT: o.endpoint, SPAWNLOFT_SIGN_ACCOUNT: o.codeSigningAccountName, SPAWNLOFT_SIGN_PROFILE: o.certificateProfileName, SPAWNLOFT_SIGN_PUBLISHER: o.publisherName }
}

// The gate's command line for the assembled folder.
export function gateArgs({ out, version, pubkey, publisher, shellExe, coreExe, nodeExe, runtime, payload }) {
  return ['--dir', out, '--version', version, '--pubkey', pubkey, '--authenticode-cn', publisher, '--check-binary-versions',
    '--signed', shellExe, '--signed', coreExe, '--signed', `${nodeExe}=${OPENJS_CN}`, '--runtime', runtime, '--payload', payload]
}

const withoutKey = e => Object.fromEntries(Object.entries(e).filter(([k]) => !/^TAURI_SIGNING_PRIVATE_KEY/i.test(k)))
const step = title => console.log(`\n== ${title}`)
const stop = message => { console.error(`\nStopped: ${message}`); process.exit(1) }
function run(cmd, args, { cwd = ROOT, env = process.env, shell = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true, shell })
  if (res.error) stop(`${cmd} could not be run: ${res.error.message}`)
  if (res.status !== 0) stop(`${cmd} ${args.join(' ')} exited ${res.status}`)
}
function read(cmd, args, { cwd = ROOT, shell = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, shell })
  if (res.error || res.status !== 0) {
    if (allowFail) return null
    stop(`${cmd} ${args.join(' ')} failed: ${res.error?.message || res.stderr?.trim() || `exit ${res.status}`}`)
  }
  return res.stdout.trim()
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const psFile = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
// Which PowerShell has the signing module: PowerShell 7 first (Install-Module from a PowerShell 7
// prompt puts it there), then Windows PowerShell 5.1. Each is asked with its own module path.
function signingHost() {
  for (const host of ['pwsh.exe', 'powershell.exe']) {
    const res = spawnSync(host, ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Module -ListAvailable -Name TrustedSigning) { 'yes' }"],
      { encoding: 'utf8', windowsHide: true, env: windowsPowerShellEnv() })
    if (!res.error && res.stdout.trim() === 'yes') return host
  }
  return null
}

function signer(file) {
  const literal = file.replaceAll("'", "''")
  const res = spawnSync('powershell', ['-NoProfile', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject; Write-Output $s.SignerCertificate.Thumbprint`],
    { encoding: 'utf8', windowsHide: true, env: windowsPowerShellEnv() })
  const [status, subject, thumbprint] = String(res.stdout ?? '').trim().split(/\r?\n/)
  return { status: status?.trim() || 'unreadable', cn: /CN=([^,]+)/.exec(subject || '')?.[1] ?? null, thumbprint: thumbprint?.trim() || null }
}

async function main(argv) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { stop(e.message) }
  const { version } = opts
  const out = path.resolve(opts.out ?? path.join(ROOT, 'desktop', 'dist', 'v2-signed', version))

  step('Checking this machine can make a signed build')
  if (process.platform !== 'win32') stop('signed Windows builds are made on the Windows signing machine')
  if (read('git', ['status', '--porcelain'])) stop('the working tree has changes. A signed build is made from a clean commit, and its report says which.')
  const branch = read('git', ['branch', '--show-current'])
  if (!branch) stop('check out a branch (v2): a detached checkout has no upstream to compare with')
  // the branch it tracks on GitHub, whatever the local branch is called
  const upstream = read('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true })
  const slash = upstream ? upstream.indexOf('/') : -1
  if (slash < 0) stop(`${branch} tracks no branch on GitHub. Set one: git branch --set-upstream-to=origin/v2`)
  const [remote, remoteBranch] = [upstream.slice(0, slash), upstream.slice(slash + 1)]
  if (remoteBranch !== 'v2' && !opts.anyBranch) stop(`${upstream} is not v2. Signed builds come from v2; pass --any-branch to sign another branch on purpose.`)
  run('git', ['fetch', '--quiet', remote, remoteBranch])
  const commit = read('git', ['rev-parse', 'HEAD'])
  if (commit !== read('git', ['rev-parse', '@{u}'])) stop(`this checkout is not at ${upstream}. Pull (or push) first, so the build names a commit everyone can see.`)
  if (read('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv'], { shell: true, allowFail: true }) === null) {
    stop('there is no Azure session to sign with. Run: az login --tenant <the tenant holding the signing account>')
  }
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'))
  const settings = signingSettings(desktopPackage)
  const publisher = settings.SPAWNLOFT_SIGN_PUBLISHER
  const host = signingHost()
  if (!host) stop('no signing module. Install it once: Install-Module -Name TrustedSigning -Scope CurrentUser')
  if (fs.existsSync(out) && fs.readdirSync(out).length) stop(`${out} already holds a build. Move it away or pick another --out.`)
  console.log(`${version} from ${branch} at ${commit.slice(0, 12)}, signed as "${publisher}" (through ${host})`)

  // under rust/target (ignored by git), not os.tmpdir(): tauri-build drops the drive letter of an
  // absolute resource path, so with the checkout on S: a C:\...\Temp resource resolves to S:\...
  // and the build stops. On the checkout's own drive every resource path resolves.
  const workParent = path.join(RUST, 'target', 'signed-work')
  fs.mkdirSync(workParent, { recursive: true })
  const work = fs.mkdtempSync(path.join(workParent, 'spawnloft-signed-'))
  // the throwaway key and the staged files go with the folder, on success or not
  process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }) } catch {} })
  // no PSModulePath: each PowerShell builds its own (desktop/windows-powershell.mjs). No release
  // key either: only the two steps that sign with it (tauri build, release-feed.mjs) get keyEnv.
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  const env = { ...withoutKey(windowsPowerShellEnv()), ...settings, SPAWNLOFT_SIGN_HOST: host, SPAWNLOFT_VERSION: version, SPAWNLOFT_COMMIT: commit }
  const signScript = path.join(HERE, 'sign-windows.ps1')

  step('Installing the pinned Tauri CLI')
  const cliPrefix = path.join(work, 'tauri-cli')
  // npm's own JS through this node: no shell, so a profile path with a space is one argument;
  // no install scripts run on the signing machine
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) stop(`npm is not beside this node (${npmCli})`)
  run(process.execPath, [npmCli, 'install', '--prefix', cliPrefix, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', `@tauri-apps/cli@${TAURI_CLI_VERSION}`], { env })
  const tauri = path.join(cliPrefix, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  if (!fs.existsSync(tauri)) stop(`the Tauri CLI is not at ${tauri}`)

  step('The release key')
  let keyFile, pubB64File, pubFile
  if (opts.key) {
    keyFile = path.resolve(opts.key)
    // installer-config.mjs and the gate take the two-line minisign file as well as its base64
    pubB64File = path.resolve(opts.pubkey ?? path.join(SHELL, 'release.pub'))
    if (password === undefined) stop('set TAURI_SIGNING_PRIVATE_KEY_PASSWORD for the real key (in this terminal, not in a file)')
    console.log(`the release key ${keyFile}`)
  } else {
    keyFile = path.join(work, 'throwaway.key')
    run(process.execPath, [tauri, 'signer', 'generate', '--ci', '-p', '', '-w', keyFile, '-f'], { env })
    pubB64File = `${keyFile}.pub`
    console.log('a THROWAWAY key: this build trusts only it, so it can never take or offer a real update')
  }
  // the CLI writes the .pub as one base64 line of the two-line minisign file; the gate takes the decoded form
  const pubText = fs.readFileSync(pubB64File, 'utf8')
  pubFile = path.join(work, 'release.pub')
  fs.writeFileSync(pubFile, pubText.includes('\n') && pubText.trim().includes('\n') ? pubText : Buffer.from(pubText.trim(), 'base64').toString('utf8'))
  const keyEnv = { ...env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: opts.key ? password : '' }

  step(`Building the Rust core at ${version}`)
  run('cargo', ['build', '--release', '--locked', '-p', 'spawnloft-core'], { cwd: RUST, env })
  const coreExe = path.join(RUST, 'target', 'release', 'spawnloft-core.exe')
  const reported = read(coreExe, ['--version'])
  if (!reported.includes(version)) stop(`spawnloft-core.exe reports "${reported}", not ${version}`)

  step('Signing the Rust core (the bundler does not sign resources)')
  run(host, [...psFile(signScript), coreExe], { env })

  step('Staging the installer configuration and the bundled Node')
  const cfg = path.join(work, 'cfg')
  run(process.execPath, [path.join(HERE, 'installer-config.mjs'), version, pubB64File, cfg, '--sign-script', signScript], { cwd: SHELL, env })
  const runtimeRecord = JSON.parse(fs.readFileSync(path.join(cfg, 'runtime', 'runtime.json'), 'utf8'))
  const nodeExe = path.join(cfg, 'runtime', runtimeRecord.exe)

  step('Building and signing the shell, uninstaller and setup')
  run(process.execPath, [tauri, 'build', '--ci', '--bundles', 'nsis', '--config', path.join(cfg, 'overlay.json')], { cwd: SHELL, env: keyEnv })
  const shellExe = path.join(RUST, 'target', 'release', 'SpawnLoft.exe')
  const setup = path.join(RUST, 'target', 'release', 'bundle', 'nsis', `SpawnLoft_${version}_x64-setup.exe`)
  if (!fs.existsSync(setup)) stop(`the setup was not produced at ${setup}`)

  step('Assembling the update asset set')
  fs.mkdirSync(out, { recursive: true })
  run(process.execPath, [path.join(ROOT, 'desktop', 'release-feed.mjs'), '--out', out, '--version', version, '--pubkey', pubFile,
    '--tauri', tauri, '--win', setup, '--min-version', '2.0.0-beta.1', '--date', new Date().toISOString().replace(/\.\d+Z$/, 'Z')], { env: keyEnv })

  step('The release gate')
  run(process.execPath, [path.join(ROOT, 'desktop', 'release-gate.mjs'), ...gateArgs({ out, version, pubkey: pubFile, publisher, shellExe, coreExe, nodeExe, runtime: path.join(cfg, 'runtime'), payload: cfg })])

  // beside the folder, not in it: the folder holds exactly the release assets, so the gate (and a
  // later publish step) find nothing unaccounted for
  const reportFile = `${out}.signing-report.json`
  step(`Writing ${reportFile}`)
  const files = {
    [`SpawnLoft-Setup-${version}.exe`]: path.join(out, `SpawnLoft-Setup-${version}.exe`),
    'SpawnLoft.exe': shellExe,
    'resources/bin/spawnloft-core.exe': coreExe,
    [`resources/runtime/${runtimeRecord.exe.replaceAll('\\', '/')}`]: nodeExe,
  }
  const report = {
    version, commit, branch, builtAt: new Date().toISOString(), machine: os.hostname(),
    releaseKey: opts.key ? 'release' : 'throwaway', publisher,
    files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { sha256: sha256(file), ...signer(file) }])),
    published: false,
  }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  if (!opts.key) fs.copyFileSync(pubFile, `${out}.throwaway-release.pub`)

  console.log(`\nSigned ${version} is in ${out}. Nothing has been published.`)
  console.log('Next: install that setup on a clean Windows VM for the W8 runs (that is where the installed copy and the uninstaller are checked).')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => stop(e.stack || e.message))
}
