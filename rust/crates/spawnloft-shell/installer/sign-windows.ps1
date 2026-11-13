# Authenticode-signs one or more files with SpawnLoft's Azure Artifact Signing (formerly Trusted
# Signing) profile, on Victor's Windows signing machine (Desktop-Main), the way 1.x stables are
# signed there (desktop/package.json build.win.azureSignOptions): the account and profile below,
# an `az login` session as the credential, SHA256 digests, a Microsoft RFC 3161 timestamp.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sign-windows.ps1 <file> [<file>...]
#
# release-windows.mjs runs it for the Rust core before the bundler copies it, and hands it to
# `tauri build` as bundle.windows.signCommand, which calls it once per file it signs: the shell
# (SpawnLoft.exe), the uninstaller (from inside makensis) and the setup. After signing, every file
# must carry a valid, timestamped signature whose subject CN is the publisher, or this exits 1 and
# the build stops. No secret is read or written here: the credential is the signed-in az session.
#
# The account settings can be overridden through the environment (release-windows.mjs sets them
# from desktop/package.json so there is one source): SPAWNLOFT_SIGN_ENDPOINT, _ACCOUNT, _PROFILE,
# _PUBLISHER.
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]] $Files)
$ErrorActionPreference = 'Stop'

function Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable("SPAWNLOFT_SIGN_$name")
  if ($v) { $v } else { $default }
}
$endpoint = Setting 'ENDPOINT' 'https://eus.codesigning.azure.net/'
$account = Setting 'ACCOUNT' 'Mcctl'
$profileName = Setting 'PROFILE' 'MCCTL'
$publisher = Setting 'PUBLISHER' 'victor zemeckis'

# The TrustedSigning module (PowerShell Gallery), the one electron-builder used for 1.x.
if (Get-Module -ListAvailable -Name TrustedSigning) { Import-Module TrustedSigning -ErrorAction SilentlyContinue }
$command = if (Get-Command Invoke-TrustedSigning -ErrorAction SilentlyContinue) { 'Invoke-TrustedSigning' } else { $null }
if (-not $command) {
  Write-Error 'No signing module. Install it once: Install-Module -Name TrustedSigning -Scope CurrentUser'
  exit 1
}

$paths = @()
foreach ($f in $Files) {
  $full = (Resolve-Path -LiteralPath $f).Path
  # the module takes one comma-separated list
  if ($full.Contains(',')) { Write-Error "cannot sign a path with a comma: $full"; exit 1 }
  $paths += $full
}

$params = @{
  Endpoint               = $endpoint
  CodeSigningAccountName = $account
  CertificateProfileName = $profileName
  Files                  = ($paths -join ',')
  FileDigest             = 'SHA256'
  TimestampRfc3161       = 'http://timestamp.acs.microsoft.com'
  TimestampDigest        = 'SHA256'
}
# The timestamp service drops a request now and then; a signature is only ever added, so trying
# again is safe.
$signed = $false
for ($attempt = 1; $attempt -le 3 -and -not $signed; $attempt++) {
  try {
    & $command @params
    $signed = $true
  } catch {
    Write-Warning "signing attempt $attempt of 3 failed: $($_.Exception.Message)"
    if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
  }
}
if (-not $signed) { Write-Error "could not sign $($paths -join ', ')"; exit 1 }

$bad = 0
foreach ($p in $paths) {
  $s = Get-AuthenticodeSignature -LiteralPath $p
  $cn = if ($s.SignerCertificate) { ([regex]::Match($s.SignerCertificate.Subject, 'CN=([^,]+)')).Groups[1].Value } else { '' }
  if ($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or $cn -ne $publisher) {
    Write-Host "NOT SIGNED  $p  ($($s.Status), CN '$cn', timestamp $($null -ne $s.TimeStamperCertificate))"
    $bad++
  } else {
    Write-Host "signed      $p  (CN '$cn', thumbprint $($s.SignerCertificate.Thumbprint))"
  }
}
if ($bad) { exit 1 }
exit 0
