# The updater scenarios of INSTALLER-UPDATER-DESIGN.md section 11 (5: 2.x cycle a to b, 6: rollback
# b to a with the hold, 7: refusals), against the loopback feeds make-feed.mjs wrote and
# feed-server.cjs serves. Version a must be installed first (the job installs it with /S).
#
#   scenarios.ps1 -Port <feed port> -A <ver> -B <ver> -Out <dir>
#
# The app under test reads the feed through SPAWNLOFT_UPDATE_SOURCE (a core built with the
# `internal-feed` feature) and the plugin downloads over plain loopback HTTP (installer-config.mjs
# --feed-http sets dangerousInsecureTransportProtocol). Neither exists in a release build.
param(
  [Parameter(Mandatory)] [int] $Port,
  [Parameter(Mandatory)] [string] $A,
  [Parameter(Mandatory)] [string] $B,
  [Parameter(Mandatory)] [string] $Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$inst = Join-Path $env:LOCALAPPDATA 'Programs\SpawnLoft'
$core = Join-Path $inst 'resources\bin\spawnloft-core.exe'
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3'
$config = Join-Path $env:APPDATA 'spawnloft'
$base = "http://127.0.0.1:$Port/"
$env:SPAWNLOFT_UPDATE_SOURCE = $base
$env:SPAWNLOFT_SPIKE_LOG = Join-Path $Out 'shell.log'
$result = [ordered]@{ a = $A; b = $B }
$resultFile = Join-Path $Out 'updater-scenarios.json'

function Save { $script:result | ConvertTo-Json -Depth 6 | Set-Content $resultFile }
function Check($what, [bool] $ok, $detail = '') {
  $line = if ($ok) { "ok    $what" } else { "FAIL  $what" }
  if ($detail) { $line += "  ($detail)" }
  Write-Host $line
  $script:result["check: $what"] = if ($ok) { 'ok' } else { "FAIL $detail" }
  Save
  if (-not $ok) { throw "updater scenarios: $what" }
}
function Version { try { (Get-ItemProperty -Path $uninstKey -Name DisplayVersion).DisplayVersion } catch { '' } }
function Variant($name) { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base`__variant/$name" | Out-Null }
function CoreUpdate { param([string[]] $Args)
  $text = & $core update @Args --json 2>&1 | Out-String
  $line = ($text -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) { throw "spawnloft-core update $Args printed no JSON: $text" }
  $line | ConvertFrom-Json
}
function UpdateLog { if (Test-Path (Join-Path $config 'update.log')) { Get-Content (Join-Path $config 'update.log') -Raw } else { '' } }
function RunApp($seconds, $until) {
  Start-Process (Join-Path $inst 'SpawnLoft.exe') | Out-Null
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if ($until -and (Version) -eq $until) { break }
  }
}
function StopApp {
  Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function Reset {
  StopApp
  Remove-Item (Join-Path $config 'update-state.json'), (Join-Path $config 'update-hold.json'), (Join-Path $config 'update-request.json') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $config 'updates') -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  Check "version a ($A) is installed" ((Version) -eq $A) (Version)
  Check 'the installed core answers `update status`' ((CoreUpdate status).installed -eq $A)
  Reset

  # ---- scenario 5: a to b through the shell, with a running core surviving ----------------------
  Variant good
  $held = Start-Process $core -ArgumentList 'ui', '--port', '0' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Check 'a long-running spawnloft-core holds the binary before the update' (-not $held.HasExited)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  RunApp 150 $B
  $result.s5Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Check "scenario 5: updated a to b ($B) through the signed feed" ((Version) -eq $B) (Version)
  Start-Sleep -Seconds 8
  $result.s5Relaunched = @(Get-Process SpawnLoft -ErrorAction SilentlyContinue).Count -gt 0
  Check 'scenario 5: the app came back after the update (/R)' $result.s5Relaunched
  $held.Refresh()
  Check 'scenario 5: the running core survived the update' (-not $held.HasExited)
  $old = @(Get-ChildItem (Join-Path $inst 'resources\bin') -Recurse -Filter 'spawnloft-core*.exe' | Where-Object { $_.FullName -ne $core })
  Check 'scenario 5: the held core was moved aside, not deleted' ($old.Count -ge 1) (($old | ForEach-Object { $_.FullName }) -join ', ')
  $result.s5OldCore = ($old | ForEach-Object { $_.FullName.Substring($inst.Length) }) -join ', '
  Check 'scenario 5: update.log has the check, the download and the install' ((UpdateLog) -match 'shell-download' -and (UpdateLog) -match 'shell-install' -and (UpdateLog) -match ' result ')
  Check 'scenario 5: the verified download was kept in the cache' (Test-Path (Join-Path $config "updates\$B\SpawnLoft-Setup-$B.exe"))
  $exe = Get-Item (Join-Path $inst 'SpawnLoft.exe')
  Check 'scenario 5: SpawnLoft.exe is the new build' ($exe.VersionInfo.ProductVersion -eq $B) $exe.VersionInfo.ProductVersion
  StopApp
  Stop-Process -Id $held.Id -Force -ErrorAction SilentlyContinue
  $result.s5Log = UpdateLog

  # ---- scenario 6: rollback b to a from the panel's request, then the hold ----------------------
  Remove-Item (Join-Path $config 'update.log') -ErrorAction SilentlyContinue
  @{ action = 'rollback'; version = $A; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $config 'update-request.json')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  RunApp 150 $A
  $result.s6Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Check "scenario 6: rolled back b to a ($A)" ((Version) -eq $A) (Version)
  Start-Sleep -Seconds 5
  $cmdlines = @(Get-CimInstance Win32_Process -Filter "Name = 'SpawnLoft.exe'" | ForEach-Object { $_.CommandLine })
  Check 'scenario 6: no relaunched app carries /ROLLBACK' (-not ($cmdlines | Where-Object { $_ -match 'ROLLBACK' })) ($cmdlines -join ' | ')
  StopApp
  $hold = Get-Content (Join-Path $config 'update-hold.json') -Raw | ConvertFrom-Json
  Check 'scenario 6: the hold names the version rolled back from' ($hold.below -eq $B) $hold.below
  Check 'scenario 6: update.log records the rollback install with /ROLLBACK' ((UpdateLog) -match 'rollback-planned' -and (UpdateLog) -match 'shell-install .*rollback=yes')
  $check = CoreUpdate check
  Check 'scenario 6: the next check offers nothing while the hold stands' ($check.result -eq 'up-to-date' -and ($check.steps -join ' ') -match 'held') ($check | ConvertTo-Json -Compress)
  CoreUpdate hold clear | Out-Null
  $check = CoreUpdate check
  Check 'scenario 6: clearing the hold offers b again' ($check.result -eq 'update' -and $check.update.version -eq $B) ($check | ConvertTo-Json -Compress)
  $result.s6Log = UpdateLog

  # ---- scenario 7: refusals, through the installed core against each feed variant ---------------
  Reset
  Remove-Item (Join-Path $config 'update.log') -ErrorAction SilentlyContinue
  $refusals = [ordered]@{
    'tampered-envelope' = 'refused \(signature\)'
    'wrong-key' = 'refused \(signature\)'
    'wrong-comment' = 'refused \(trusted-comment\)'
    'no-version-comment' = 'refused \(trusted-comment\)'
    'unknown-keyid' = 'refused \(key-id\)'
    'old-generated' = 'replayed'
  }
  foreach ($name in $refusals.Keys) {
    Variant $name
    $check = CoreUpdate check
    Check "scenario 7: $name is refused" ($check.result -eq 'unreachable' -and $check.reason -match $refusals[$name]) ($check | ConvertTo-Json -Compress)
    Check "scenario 7: $name left no pending update" ($null -eq (CoreUpdate status).pending)
  }
  Variant expired
  $check = CoreUpdate check
  Check 'scenario 7: an expired feed is accepted and reported stale' ($check.result -eq 'update' -and $check.staleFeed -eq $true) ($check | ConvertTo-Json -Compress)
  Variant min-version
  $check = CoreUpdate check
  Check 'scenario 7: minVersion above the installed version blocks' ($check.result -eq 'blocked' -and $check.reason -match 'needs at least') ($check | ConvertTo-Json -Compress)
  Variant only-lower
  $check = CoreUpdate check
  Check 'scenario 7: a feed with nothing above the installed version offers nothing' ($check.result -eq 'up-to-date') ($check | ConvertTo-Json -Compress)
  Variant rotation
  $check = CoreUpdate check
  Check 'scenario 7: a release signed with the next key is accepted (rotation)' ($check.result -eq 'update' -and $check.update.version -eq $B) ($check | ConvertTo-Json -Compress)
  # artifact checks: the headless verifier first, then the plugin in the shell
  Variant artifact-wrong-sig
  $check = CoreUpdate check
  Check 'scenario 7: an envelope whose artifact signature is another file''s still verifies' ($check.result -eq 'update')
  $apply = & $core update apply --no-run --json 2>&1 | Out-String
  Check 'scenario 7: apply refuses the artifact whose signature belongs to another file' ($LASTEXITCODE -ne 0 -and $apply -match 'signature') $apply.Trim()
  RunApp 70 $null
  StopApp
  Check 'scenario 7: the shell refused it too (plugin signature check) and nothing was installed' (((Version) -eq $A) -and ((UpdateLog) -match 'shell-check-failed|shell-download-refused')) (Version)
  Variant artifact-no-version
  CoreUpdate check | Out-Null
  $apply = & $core update apply --no-run --json 2>&1 | Out-String
  Check 'scenario 7: apply refuses an artifact signed without a version' ($LASTEXITCODE -ne 0 -and $apply -match 'no version') $apply.Trim()
  Reset
  Variant good
  CoreUpdate check | Out-Null
  $apply = & $core update apply --no-run --json 2>&1 | Out-String
  Check 'scenario 7: apply verifies and caches the good artifact' ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $config "updates\$B\SpawnLoft-Setup-$B.exe"))) $apply.Trim()
  $result.s7Log = UpdateLog
  $result.hits = (Invoke-WebRequest -UseBasicParsing -Uri "$base`__hits").Content
} finally {
  StopApp
  Save
}
Write-Host 'updater scenarios: all checks passed'
exit 0
