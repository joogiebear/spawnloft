# Experiment 4a (PHASE0-FINDINGS.md): one snapshot of everything the installer could touch.
#
#   powershell -ExecutionPolicy Bypass -File observe.ps1 [-Label before] [-Instance p0e-test]
#
# Prints every process whose image lives under the SpawnLoft install folder (what electron-builder
# 26's FIND_PROCESS matches), every java.exe, the daemon's state.json, and leftovers in %TEMP%.
# Run it before quitAndInstall, in a loop during the update (-Watch), and after the relaunch.
param([string]$Label = (Get-Date -Format HH:mm:ss), [string]$Instance = 'p0e-test', [switch]$Watch)

$inst = Join-Path $env:LOCALAPPDATA 'Programs\SpawnLoft'
$data = if ($env:SPAWNLOFT_DATA_ROOT) { $env:SPAWNLOFT_DATA_ROOT } elseif ($env:MCCTL_DATA_ROOT) { $env:MCCTL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA 'mcctl' }

function Snapshot([string]$tag) {
  Write-Host "===== $tag ====="
  Write-Host "-- processes under $inst (electron-builder's match):"
  Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($inst, 'CurrentCultureIgnoreCase') } |
    ForEach-Object { "{0,7} {1,-22} {2}" -f $_.ProcessId, $_.Name, ($_.CommandLine -replace '\s+', ' ') } | Write-Host
  Write-Host "-- java processes:"
  Get-CimInstance Win32_Process -Filter "Name='java.exe' or Name='javaw.exe'" |
    ForEach-Object { "{0,7} {1,-22} parent {2,-7} {3}" -f $_.ProcessId, $_.Path, $_.ParentProcessId, (($_.CommandLine -replace '\s+', ' ').Substring(0, [Math]::Min(120, ($_.CommandLine -replace '\s+', ' ').Length))) } | Write-Host
  $state = Join-Path $data "run\$Instance\state.json"
  if (Test-Path $state) { Write-Host "-- $state"; Get-Content $state | Write-Host } else { Write-Host "-- no state.json at $state" }
  Write-Host "-- version installed:"
  $pkg = Join-Path $inst 'resources\app-update.yml'
  if (Test-Path $pkg) { Get-Content $pkg | Write-Host } else { Write-Host "no app-update.yml (internal build)" }
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'SpawnLoft*' } | Select-Object DisplayVersion, InstallLocation | Format-List | Out-String).Trim() | Write-Host
  Write-Host "-- installer leftovers in %TEMP%:"
  Get-ChildItem $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Write-Host
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'mcctl-desktop-updater') -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Write-Host
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'SpawnLoft-updater') -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Write-Host
}

if ($Watch) { while ($true) { Snapshot (Get-Date -Format HH:mm:ss.fff); Start-Sleep -Milliseconds 500 } } else { Snapshot $Label }
