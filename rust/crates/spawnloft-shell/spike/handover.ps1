# The 1.x -> 2.0 handover on Windows, as far as a CI runner can take it (P0-F).
#
#   handover.ps1 [-Setup16 <SpawnLoft-Setup-1.6.x.exe>] -SpikeA <SpawnLoft_..._x64-setup.exe> -Out <dir>
#
# Without -Setup16 the 1.6 install already on the machine is used.
# 1. installs the 1.6 beta silently, the way a user's install looks;
# 2. through 1.6's own CLI, adopts a (stopped) server and adds a scheduled backup task, then runs
#    the task once so there is a baseline;
# 3. runs the spike installer exactly as electron-updater's NsisUpdater does for an update
#    (`--updated /S --force-run`; only the publisher check before it is skipped, since this spike
#    installer is unsigned - Victor's PC runs the real electron-updater against a signed one);
# 4. checks the result: same folder, same uninstall key, 1.x's uninstaller gone, the Tauri exe in
#    place of Electron's, the shortcuts still pointing at it, the task still registered and still
#    running green through the argv compatibility form;
# 5. leaves the spike installed for update-cycle.ps1 (-Uninstall runs the uninstall checks instead).
#
# Writes handover.json to -Out. Exits non-zero on the first broken expectation.
param(
  [string] $Setup16 = '',
  [string] $SpikeA = '',
  [Parameter(Mandatory)] [string] $Out,
  [switch] $Uninstall
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$inst = Join-Path $env:LOCALAPPDATA 'Programs\SpawnLoft'
$guid = 'bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3'
$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
$installKey = "HKCU:\Software\$guid"
$result = [ordered]@{}

function Check($what, [bool] $ok, $detail = '') {
  $line = if ($ok) { "ok    $what" } else { "FAIL  $what" }
  if ($detail) { $line += "  ($detail)" }
  Write-Host $line
  $script:result["check: $what"] = if ($ok) { 'ok' } else { "FAIL $detail" }
  if (-not $ok) {
    $script:result | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'handover.json')
    throw "handover: $what"
  }
}

function Reg($key, $name) {
  try { (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name } catch { $null }
}

function Cli16([string[]] $cliArgs) {
  # SpawnLoft.exe is a GUI-subsystem program: PowerShell neither waits for it nor captures its
  # output when called with &, so start it explicitly and read its output from files
  $env:ELECTRON_RUN_AS_NODE = '1'
  $o = Join-Path $env:RUNNER_TEMP 'cli16.out'
  $e = Join-Path $env:RUNNER_TEMP 'cli16.err'
  try {
    $argList = @("`"$inst\resources\core\mcctl.mjs`"") + ($cliArgs | ForEach-Object { "`"$_`"" })
    $p = Start-Process -FilePath "$inst\SpawnLoft.exe" -ArgumentList $argList -Wait -PassThru -NoNewWindow `
      -RedirectStandardOutput $o -RedirectStandardError $e
    $output = "$(Get-Content $o -Raw)$(Get-Content $e -Raw)"
    if ($p.ExitCode -ne 0) { throw "1.6 CLI $($cliArgs -join ' ') failed ($($p.ExitCode)): $output" }
    Write-Host $output
    $output
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
}

function TaskResult($taskName) {
  $info = schtasks /Query /TN $taskName /V /FO CSV | ConvertFrom-Csv
  [ordered]@{ lastRun = $info.'Last Run Time'; lastResult = $info.'Last Result'; status = $info.Status }
}

function RunTask($taskName) {
  $before = (TaskResult $taskName).lastRun
  schtasks /Run /TN $taskName | Out-Null
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $r = TaskResult $taskName
    if ($r.lastRun -ne $before -and $r.status -ne 'Running') { return $r }
  }
  TaskResult $taskName
}

# Scheduled tasks start with the user's registered environment, not this job's: put the job's
# Node on the user PATH so the forwarded task can find it, as a user's Node install would be.
$nodeDir = Split-Path (Get-Command node).Source
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $nodeDir })) {
  [Environment]::SetEnvironmentVariable('Path', "$nodeDir;$userPath", 'User')
}

# 1. SpawnLoft 1.6, silently, per user
if (-not $Uninstall) {
  if ($Setup16) {
    $p = Start-Process -FilePath $Setup16 -ArgumentList '/S' -Wait -PassThru
    Check '1.6 installer exit code 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
  }
  Check '1.6 is in %LOCALAPPDATA%\Programs\SpawnLoft' (Test-Path "$inst\SpawnLoft.exe")
  $v16 = Reg $uninstKey 'DisplayVersion'
  Check '1.6 registered under the electron-builder uninstall key' ($v16 -like '1.*') "DisplayVersion $v16"
  $result.uninstallString16 = Reg $uninstKey 'UninstallString'
  $result.installLocation16 = Reg $installKey 'InstallLocation'
  Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force

  # 2. a server and a task, made by 1.6
  $srv = Join-Path $env:RUNNER_TEMP 'spike-server'
  New-Item -ItemType Directory -Force -Path $srv | Out-Null
  Set-Content -Path (Join-Path $srv 'server.jar') -Value 'not a real jar'
  Set-Content -Path (Join-Path $srv 'eula.txt') -Value 'eula=true'
  Cli16 @('adopt', 'spike', $srv) | Out-Null
  Cli16 @('task', 'add', 'spike', '--do', 'backup', '--daily', '03:00') | Out-Null
  $taskName = (schtasks /Query /FO CSV /NH | ConvertFrom-Csv -Header 'TaskName', 'Next', 'Status' |
      Where-Object { $_.TaskName -like '\mcctl\*' } | Select-Object -First 1).TaskName
  Check '1.6 registered a task under \mcctl\' ([bool] $taskName) $taskName
  $result.task = $taskName
  $result.shim = Get-Content (Join-Path $env:LOCALAPPDATA 'mcctl\tasks\*.cmd') -Raw
  $result.taskRunUnder16 = RunTask $taskName
  Check 'the task runs green under 1.6' ($result.taskRunUnder16.lastResult -eq '0') "$($result.taskRunUnder16.lastResult)"
  $backups16 = @(Get-ChildItem -Recurse -File (Join-Path $env:LOCALAPPDATA 'mcctl\backups') -ErrorAction SilentlyContinue).Count
  $result.backupsAfter16 = $backups16

  $startLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'SpawnLoft.lnk'
  $desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SpawnLoft.lnk'
  $result.startMenuShortcutBefore = Test-Path $startLnk
  $result.desktopShortcutBefore = Test-Path $desktopLnk

  # 3. the spike, the way electron-updater starts an NSIS update
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $SpikeA -ArgumentList '--updated', '/S', '--force-run' -Wait -PassThru
  $result.handoverSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Check 'spike installer exit code 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"

  # 4. what it left
  $exe = Get-Item "$inst\SpawnLoft.exe"
  $result.exeProductVersion = $exe.VersionInfo.ProductVersion
  $result.exeSizeBytes = $exe.Length
  Check 'SpawnLoft.exe is the Tauri shell now' ($exe.VersionInfo.ProductVersion -like '2.0.0*') $exe.VersionInfo.ProductVersion
  Check 'no Electron left (resources\app.asar gone)' (-not (Test-Path "$inst\resources\app.asar"))
  Check '1.x uninstaller gone' (-not (Test-Path "$inst\Uninstall SpawnLoft.exe"))
  Check 'Tauri uninstaller present' (Test-Path "$inst\uninstall.exe")
  Check 'core binary at resources\bin\spawnloft-core.exe' (Test-Path "$inst\resources\bin\spawnloft-core.exe")
  Check 'Node core at resources\core\mcctl.mjs' (Test-Path "$inst\resources\core\mcctl.mjs")
  $v2 = Reg $uninstKey 'DisplayVersion'
  Check 'same uninstall key, new version' ($v2 -like '2.0.0*') "DisplayVersion $v2"
  $result.uninstallString2 = Reg $uninstKey 'UninstallString'
  $result.installLocation2 = Reg $installKey 'InstallLocation'
  Check 'InstallLocation unchanged' ($result.installLocation2 -eq $result.installLocation16 -or $result.installLocation2 -eq $inst) $result.installLocation2
  Check 'no stray Tauri-default key' (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpawnLoft'))
  Check 'no stray Tauri-default folder' (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'SpawnLoft\SpawnLoft.exe')))
  if ($result.startMenuShortcutBefore) { Check 'Start menu shortcut kept' (Test-Path $startLnk) }
  if ($result.desktopShortcutBefore) { Check 'desktop shortcut kept' (Test-Path $desktopLnk) }
  if (Test-Path $startLnk) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($startLnk).TargetPath
    Check 'Start menu shortcut opens the new exe' ($target -eq "$inst\SpawnLoft.exe") $target
  }
  Check 'task still registered' ([bool] (schtasks /Query /TN $taskName 2>$null))
  $result.taskRunUnder2 = RunTask $taskName
  Check 'the 1.x task runs green through the Tauri exe' ($result.taskRunUnder2.lastResult -eq '0') "$($result.taskRunUnder2.lastResult)"
  $backups2 = @(Get-ChildItem -Recurse -File (Join-Path $env:LOCALAPPDATA 'mcctl\backups') -ErrorAction SilentlyContinue).Count
  $result.backupsAfter2 = $backups2
  Check 'and it made a backup' ($backups2 -gt $backups16) "$backups16 -> $backups2"

  # --force-run: the app should have been started; record, do not fail (RunAsUser needs explorer)
  Start-Sleep -Seconds 5
  $running = @(Get-Process SpawnLoft -ErrorAction SilentlyContinue)
  $result.startedAfterHandover = $running.Count -gt 0
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process spawnloft-core, node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$inst*" } | Stop-Process -Force -ErrorAction SilentlyContinue
} else {
  # uninstall: in place (_?=) so this waits for it; silent means "keep the data"
  $taskName = (schtasks /Query /FO CSV /NH | ConvertFrom-Csv -Header 'TaskName', 'Next', 'Status' |
      Where-Object { $_.TaskName -like '\mcctl\*' } | Select-Object -First 1).TaskName
  $p = Start-Process -FilePath "$inst\uninstall.exe" -ArgumentList '/S', "_?=$inst" -Wait -PassThru
  Check 'uninstaller exit code 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
  Remove-Item -Force "$inst\uninstall.exe" -ErrorAction SilentlyContinue
  Check 'SpawnLoft.exe removed' (-not (Test-Path "$inst\SpawnLoft.exe"))
  Check 'uninstall key removed' (-not (Test-Path $uninstKey))
  Check 'install key removed' (-not (Test-Path $installKey))
  if ($taskName) { Check 'scheduled task removed by uninstall --yes' (-not (schtasks /Query /TN $taskName 2>$null)) }
  Check 'data kept (silent uninstall keeps it)' (Test-Path (Join-Path $env:LOCALAPPDATA 'mcctl\instances.json'))
}

$result | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out ($(if ($Uninstall) { 'uninstall.json' } else { 'handover.json' })))
Write-Host 'handover: all checks passed'
