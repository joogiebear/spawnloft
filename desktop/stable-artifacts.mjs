import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createManifest, manifestName } from './preview-artifacts.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const target = { platform: process.argv[2], arch: process.argv[3] }
if (target.platform !== process.platform || target.arch !== process.arch) throw new Error('Verify artifacts on their native build host')
const info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json')))
if (target.platform === 'darwin' && info.macSigningMode !== 'signed') throw new Error('Stable Mac builds must be signed')
if (target.platform === 'win32') {
  for (const file of [`SpawnLoft-Setup-${info.version}.exe`, 'win-unpacked/SpawnLoft.exe']) {
    const literal = path.join(dir, file).replaceAll("'", "''")
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; if ($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.Subject -notmatch 'CN=victor zemeckis(,|$)') { throw 'Expected valid timestamped SpawnLoft publisher signature' }`
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit', windowsHide: true })
  }
  fs.copyFileSync(path.join(dir, 'latest.yml'), path.join(dir, 'beta.yml'))
}
// Linux has no signature to check: no Authenticode, no notarization. The package is verified by the
// hash in its feed, and both feed names ship so a beta installation can move to the stable.
if (target.platform === 'linux') fs.copyFileSync(path.join(dir, 'latest-linux.yml'), path.join(dir, 'beta-linux.yml'))
const manifest = createManifest(dir, info, target, { stable: true })
fs.writeFileSync(path.join(dir, manifestName(target)), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Verified ${target.platform === 'linux' ? '' : 'signed '}stable artifacts for ${target.platform}/${target.arch}: ${info.version}`)
