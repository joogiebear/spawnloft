#!/usr/bin/env node
/**
 * Check that a build actually came out the way it is supposed to.
 *
 * <p>There is no CI on this repository, so the only thing standing between a broken build and a
 * published release is a check that runs on the machine doing the building. These are the things
 * that have silently gone wrong before, each of which produces an artifact that looks completely
 * normal until someone installs it:
 *
 * <ul>
 *   <li>The icon not reaching the executable. electron-builder applies it with rcedit, which lives
 *       in a toolchain it downloads on first use; if that extraction fails - it needs permission to
 *       create symlinks, which Windows withholds unless Developer Mode is on - the build carries on
 *       and ships Electron's default atom.</li>
 *   <li>The core not being copied into resources, which makes the app start and then fail at the
 *       first thing it tries to do.</li>
 *   <li>src/ui.html missing, which is the entire panel.</li>
 * </ul>
 *
 * <p>Called from the afterPack hook during a build (structure only, because the icon is applied
 * after that hook runs) and again by `npm run verify` on the finished artifact. Zero dependencies,
 * like everything else here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// electron-builder passes the directory it just packed; run by hand, the usual one is assumed.
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const UNPACKED = args[0] ? path.resolve(args[0]) : path.join(HERE, 'dist', 'win-unpacked')
// The afterPack hook runs BEFORE electron-builder applies the icon, so it asks for the structural
// checks only. Run on a finished build, everything is checked.
const STRUCTURE_ONLY = process.argv.includes('--structure-only')
const EXE = path.join(UNPACKED, 'SpawnLoft.exe')
const ICO = path.join(HERE, 'build', 'icon.ico')

const problems = []
const notes = []

const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))

/** Every image in an .ico, as raw bytes. The format is a 6-byte header then 16 bytes per entry. */
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

const core = path.join(UNPACKED, 'resources', 'core')
for (const rel of ['mcctl.mjs', 'src/ui.html', 'src/ui.mjs', 'src/appearance.mjs', 'src/daemon.mjs', 'src/java.mjs']) {
  if (!fs.existsSync(path.join(core, rel))) problems.push(`resources/core/${rel} is missing from the build`)
}
if (!problems.some((p) => p.includes('resources/core'))) notes.push('core: bundled into resources/core')

const asar = path.join(UNPACKED, 'resources', 'app.asar')
if (!fs.existsSync(asar)) {
  problems.push('resources/app.asar is missing')
} else {
  // setup.html is listed in the build's `files` allowlist. Anything added to desktop/ and not
  // listed there is silently left out, and the first-run wizard is the screen that would go.
  const bytes = fs.readFileSync(asar)
  for (const name of ['main.js', 'preload.js', 'setup.html', 'window-state.js']) {
    if (!bytes.includes(Buffer.from(name))) problems.push(`${name} is not in app.asar - check the "files" list in package.json`)
  }
  if (!problems.some((p) => p.includes('app.asar'))) notes.push('app: main.js, preload.js, window-state.js and setup.html are packaged')
}

/**
 * Is the executable signed, and will the signature outlive its certificate?
 *
 * <p>Artifact Signing issues certificates that live about three days and rotate. That is by design,
 * and it is also why the timestamp matters more here than anywhere else: without one, every
 * signature stops validating within the week rather than staying good for the moment it was signed
 * in. So this checks both, and treats a missing timestamp as a failure rather than a detail.
 *
 * <p>Skipped entirely when the build is not configured to sign, so an unsigned local build is not
 * reported as broken.
 */
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

/**
 * The two design-token blocks have to stay identical.
 *
 * <p>setup.html is loaded from disk by Electron before the panel server exists, so it cannot share
 * a stylesheet with ui.html without a build step, and there is no build step. Both files say so in
 * a comment ending "change both or neither" - and that comment failed silently the first time a
 * real change tested it, because a comment cannot check anything.
 *
 * <p>This can. A wizard whose palette has drifted from the panel's is not a build worth shipping.
 */
function checkTokensMatch() {
  const grab = (file) => {
    let text
    try {
      // Normalised, because autocrlf checks one file out with CRLF and leaves the other LF, and
      // an identical palette must not fail the build over the line terminator.
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

if (!STRUCTURE_ONLY && fs.existsSync(EXE)) {
  const configured = Boolean(pkg?.build?.win?.azureSignOptions || pkg?.build?.win?.signtoolOptions)
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
