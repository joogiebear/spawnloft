#!/usr/bin/env node
// Checks that a build came out right: the icon reached the exe, the core is in resources, and the
// panel (src/ui.html) is present. Run by the afterPack hook (structure only, since the icon is
// applied after that hook) and again by `npm run verify` on the finished artifact.
//
// The icon check matters because electron-builder applies it with rcedit from a toolchain it
// downloads on first use; if extraction fails (it needs symlink permission, which Windows withholds
// without Developer Mode) the build carries on and ships Electron's default icon.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// electron-builder passes the packed directory; run by hand, the default is assumed
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const UNPACKED = args[0] ? path.resolve(args[0]) : path.join(HERE, 'dist', 'win-unpacked')
// afterPack runs before the icon is applied, so it asks for structural checks only
const STRUCTURE_ONLY = process.argv.includes('--structure-only')
const MAC = process.argv.includes('--platform=darwin') || UNPACKED.endsWith('.app')
const LINUX = process.argv.includes('--platform=linux')
// launchers are executable shell scripts here, not .cmd files
const POSIX = MAC || LINUX
const APP = UNPACKED.endsWith('.app') ? UNPACKED : path.join(UNPACKED, 'SpawnLoft.app')
const RESOURCES = MAC ? path.join(APP, 'Contents', 'Resources') : path.join(UNPACKED, 'resources')
const EXE = MAC ? path.join(APP, 'Contents', 'MacOS', 'SpawnLoft')
  : LINUX ? path.join(UNPACKED, 'spawnloft-desktop') : path.join(UNPACKED, 'SpawnLoft.exe')
const ICO = path.join(HERE, 'build', 'icon.ico')

const problems = []
const notes = []

const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
// honour the same --config override electron-builder used, or a deliberately unsigned dev package
// is judged against the production Azure signing profile
const configArg = process.argv.find(arg => arg.startsWith('--config='))
const buildConfig = configArg
  ? createRequire(import.meta.url)(path.resolve(configArg.slice('--config='.length)))
  : pkg.build
if (configArg) {
  const info = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'build-info.json'), 'utf8'))
  if (info.version !== (buildConfig.extraMetadata?.version || pkg.version) || info.sourceVersion !== pkg.version) {
    problems.push('the verification configuration does not match the packaged version')
  }
}

// .ico layout: 6-byte header, then 16 bytes per entry
function icoFrames(file) {
  const ico = fs.readFileSync(file)
  const count = ico.readUInt16LE(4)
  const frames = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const w = ico[at] || 256
    const size = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    frames.push({ label: `${w}x${w}`, bytes: ico.subarray(offset, offset + size) })
  }
  return frames
}

if (STRUCTURE_ONLY) {
  notes.push('icon: checked separately once the build has finished')
} else if (!fs.existsSync(EXE)) {
  problems.push(`no packaged executable at ${EXE} - did the build finish?`)
} else if (MAC) {
  if (!fs.readdirSync(RESOURCES).some(name => name.endsWith('.icns'))) problems.push('the Mac bundle has no application icon')
  else notes.push('icon: present in the Mac application bundle')
} else if (LINUX) {
  // a Linux executable carries no icon; the window's comes from a file beside the app
  if (!fs.existsSync(path.join(RESOURCES, 'icon.png'))) problems.push('resources/icon.png is missing, so the window would have no icon')
  else notes.push('icon: resources/icon.png is packaged for the window')
} else if (!fs.existsSync(ICO)) {
  problems.push(`build/icon.ico is missing, so nothing could have been applied to the executable`)
} else {
  const exe = fs.readFileSync(EXE)
  const missing = icoFrames(ICO).filter((f) => !exe.includes(f.bytes)).map((f) => f.label)
  if (missing.length) {
    problems.push(
      `the app icon did not reach SpawnLoft.exe (missing ${missing.join(', ')}).\n` +
        `    electron-builder applies it with rcedit from its winCodeSign toolchain. If that\n` +
        `    toolchain failed to extract - the usual cause is Windows refusing to create the\n` +
        `    symlinks in its unused macOS files - the build carries on and ships Electron's\n` +
        `    default icon. See desktop/build/README.md.`,
    )
  } else {
    notes.push('icon: all sizes present in SpawnLoft.exe')
  }
}

const core = path.join(RESOURCES, 'core')
for (const rel of ['mcctl.mjs', 'spawnloft.mjs', 'src/mysql.mjs', 'src/cli-output.mjs', 'src/cli-metrics.mjs', 'src/ui.html', 'src/ui.mjs', 'src/appearance.mjs', 'src/platform.mjs', 'src/daemon.mjs', 'src/java.mjs']) {
  if (!fs.existsSync(path.join(core, rel))) problems.push(`resources/core/${rel} is missing from the build`)
}
if (!problems.some((p) => p.includes('resources/core'))) notes.push('core: bundled into resources/core')
for (const name of ['spawnloft', 'mcctl']) {
  const launcher = path.join(RESOURCES, 'bin', POSIX ? name : `${name}.cmd`)
  if (!fs.existsSync(launcher)) problems.push(`terminal launcher ${name} is missing`)
  else if (POSIX && (fs.statSync(launcher).mode & 0o111) === 0) problems.push(`terminal launcher ${name} is not executable`)
}

const asar = path.join(RESOURCES, 'app.asar')
if (!fs.existsSync(asar)) {
  problems.push('resources/app.asar is missing')
} else {
  // package.json's `files` is an allowlist; anything added to desktop/ and not listed is silently left out
  const bytes = fs.readFileSync(asar)
  for (const name of ['main.js', 'preload.js', 'setup.html', 'window-state.js', 'update-channel.js']) {
    if (!bytes.includes(Buffer.from(name))) problems.push(`${name} is not in app.asar - check the "files" list in package.json`)
  }
  if (!problems.some((p) => p.includes('app.asar'))) notes.push('app: main.js, preload.js, window-state.js, update-channel.js and setup.html are packaged')
}

// Artifact Signing certificates live about three days, so without a timestamp every signature
// stops validating within the week. A missing timestamp is a failure.
function checkSignature(file) {
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      `$s = Get-AuthenticodeSignature '${file}'; ` +
      `Write-Output $s.Status; ` +
      `Write-Output $s.SignerCertificate.Subject; ` +
      `Write-Output ($s.TimeStamperCertificate -ne $null)`],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  )
  if (ps.status !== 0) return { ok: false, why: 'could not read the signature' }
  const [status, subject, stamped] = String(ps.stdout).trim().split(/\r?\n/)
  if (status !== 'Valid') return { ok: false, why: `signature status is ${status || 'unreadable'}` }
  if (String(stamped).trim() !== 'True') {
    return { ok: false, why: 'the signature has no timestamp, so it dies when the certificate expires' }
  }
  const cn = /CN=([^,]+)/.exec(subject || '')
  return { ok: true, publisher: cn ? cn[1] : subject }
}

// setup.html loads from disk before the panel server exists, so it can't share a stylesheet with
// ui.html; the two :root token blocks are duplicated and must stay identical.
function checkTokensMatch() {
  const grab = (file) => {
    let text
    try {
      // normalise line endings: autocrlf can check one file out CRLF and the other LF
      text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      return null
    }
    const m = /( {2}:root \{[\s\S]*?\n {2}\})/.exec(text)
    return m ? m[1] : null
  }
  const panel = grab(path.join(HERE, '..', 'src', 'ui.html'))
  const wizard = grab(path.join(HERE, 'setup.html'))
  if (!panel || !wizard) return { ok: false, why: 'a :root block could not be found in one of them' }
  if (panel === wizard) return { ok: true, count: (panel.match(/^ {4}--/gm) || []).length }

  const a = panel.split('\n')
  const b = wizard.split('\n')
  let at = 0
  while (at < Math.max(a.length, b.length) && a[at] === b[at]) at++
  return {
    ok: false,
    why: `they differ at line ${at + 1} of the block - the panel has `
      + `${JSON.stringify((a[at] || '(end)').trim())} and the wizard has `
      + `${JSON.stringify((b[at] || '(end)').trim())}`,
  }
}

if (LINUX) {
  // no Authenticode or notarization equivalent on Linux
  notes.push('signing: not applicable on Linux')
} else if (!STRUCTURE_ONLY && !MAC && fs.existsSync(EXE)) {
  const configured = Boolean(buildConfig?.win?.azureSignOptions || buildConfig?.win?.signtoolOptions)
  if (!configured) {
    notes.push('signing: not configured for this build, so not checked')
  } else {
    const res = checkSignature(EXE)
    if (res.ok) notes.push(`signing: valid and timestamped, published as "${res.publisher}"`)
    else problems.push(`SpawnLoft.exe is configured to be signed but ${res.why}.`)
  }
}

const tokens = checkTokensMatch()
if (tokens.ok) notes.push(`tokens: the panel and the wizard share the same ${tokens.count}`)
else problems.push(`the design tokens in src/ui.html and desktop/setup.html have drifted - ${tokens.why}.`)

for (const note of notes) process.stdout.write(`  ok   ${note}\n`)
if (problems.length) {
  process.stdout.write('\n')
  for (const p of problems) process.stdout.write(`  FAIL ${p}\n`)
  process.stdout.write('\nThis build should not be released.\n')
  process.exit(1)
}
process.stdout.write('\nBuild looks right.\n')
