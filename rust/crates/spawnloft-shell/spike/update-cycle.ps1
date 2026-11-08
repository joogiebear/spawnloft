# One real Tauri updater cycle on Windows, spike-a -> spike-b (P0-F, answers Q21 with facts).
#
#   update-cycle.ps1 -FeedDir <dir holding both setups and their .sig files> -From <ver> -To <ver> -Out <dir>
#
# spike-a must already be installed (handover.ps1 leaves it). This:
# 1. serves a Tauri updater feed on 127.0.0.1 whose signature does not belong to the offered
#    installer, starts the app with SPAWNLOFT_SPIKE_FEED, and checks the update is refused and
#    nothing changed;
# 2. serves the correct feed and checks the plugin downloads, verifies, runs the custom NSIS
#    template with its own flags (/P /UPDATE /R /ARGS), and the installed version becomes -To;
# 3. records whether the app came back up afterwards (the /R restart) and how long it all took.
param(
  [Parameter(Mandatory)] [string] $FeedDir,
  [Parameter(Mandatory)] [string] $From,
  [Parameter(Mandatory)] [string] $To,
  [Parameter(Mandatory)] [string] $Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$inst = Join-Path $env:LOCALAPPDATA 'Programs\SpawnLoft'
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3'
$result = [ordered]@{ from = $From; to = $To }
$log = Join-Path $Out 'spike-updater.log'

function Check($what, [bool] $ok, $detail = '') {
  $line = if ($ok) { "ok    $what" } else { "FAIL  $what" }
  if ($detail) { $line += "  ($detail)" }
  Write-Host $line
  $script:result["check: $what"] = if ($ok) { 'ok' } else { "FAIL $detail" }
  if (-not $ok) {
    $script:result | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'update-cycle.json')
    throw "update cycle: $what"
  }
}
function Version { (Get-ItemProperty -Path $uninstKey -Name DisplayVersion).DisplayVersion }

Check "spike-a ($From) installed" ((Version) -eq $From) (Version)

$setupB = Get-ChildItem $FeedDir -Filter "*_${To}_x64-setup.exe" | Select-Object -First 1
$setupA = Get-ChildItem $FeedDir -Filter "*_${From}_x64-setup.exe" | Select-Object -First 1
$sigB = Get-Content "$($setupB.FullName).sig" -Raw
$sigA = Get-Content "$($setupA.FullName).sig" -Raw
$result.updateArtifactBytes = $setupB.Length

# a tiny static server for the feed and the installer
$server = @'
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const [dir, portFile] = process.argv.slice(2)
http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''))
  if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-length': fs.statSync(file).size })
  fs.createReadStream(file).pipe(res)
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)) })
'@
$serverJs = Join-Path $env:RUNNER_TEMP 'feed-server.cjs'
Set-Content -Path $serverJs -Value $server
$portFile = Join-Path $env:RUNNER_TEMP 'feed-port.txt'
Remove-Item $portFile -ErrorAction SilentlyContinue
$srv = Start-Process node -ArgumentList $serverJs, $FeedDir, $portFile -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 50 -and -not (Test-Path $portFile); $i++) { Start-Sleep -Milliseconds 100 }
$port = Get-Content $portFile
$base = "http://127.0.0.1:$port"

function Feed($name, $signature) {
  $platform = @{ signature = $signature.Trim(); url = "$base/$($setupB.Name)" }
  $feed = [ordered]@{
    version = $To; notes = 'spike'; pub_date = '2026-11-08T00:00:00Z'
    platforms = [ordered]@{ 'windows-x86_64' = $platform; 'windows-x86_64-nsis' = $platform }
  }
  $feed | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $FeedDir $name)
  "$base/$name"
}

function RunApp($feedUrl, $seconds) {
  $env:SPAWNLOFT_SPIKE_FEED = $feedUrl
  $env:SPAWNLOFT_SPIKE_LOG = $log
  try {
    Start-Process "$inst\SpawnLoft.exe" | Out-Null
  } finally {
    Remove-Item Env:SPAWNLOFT_SPIKE_FEED, Env:SPAWNLOFT_SPIKE_LOG -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if ((Version) -eq $To) { break }
  }
}

function StopApp {
  Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process spawnloft-core -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$inst*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

try {
  # 1. a validly signed artifact under the wrong signature: refused
  RunApp (Feed 'tampered.json' $sigA) 25
  StopApp
  Check 'a feed with a signature for another artifact is refused' ((Version) -eq $From) (Version)
  $result.tamperedLog = (Get-Content $log -ErrorAction SilentlyContinue) -join "`n"
  Check 'and the log says why' ($result.tamperedLog -match 'signature|Signature') $result.tamperedLog

  # 2. the real cycle
  $sw = [Diagnostics.Stopwatch]::StartNew()
  RunApp (Feed 'latest.json' $sigB) 180
  $result.updateSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Check "updated to $To through the Tauri updater" ((Version) -eq $To) (Version)
  $exe = Get-Item "$inst\SpawnLoft.exe"
  Check 'SpawnLoft.exe is the new build' ($exe.VersionInfo.ProductVersion -eq $To) $exe.VersionInfo.ProductVersion
  Check 'still the 1.x folder and key (no Tauri-default install appeared)' (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'SpawnLoft\SpawnLoft.exe')))
  Start-Sleep -Seconds 8
  $result.restartedAfterUpdate = @(Get-Process SpawnLoft -ErrorAction SilentlyContinue).Count -gt 0
  $result.log = (Get-Content $log -ErrorAction SilentlyContinue) -join "`n"
} finally {
  StopApp
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  $result | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'update-cycle.json')
}
Write-Host 'update cycle: all checks passed'
