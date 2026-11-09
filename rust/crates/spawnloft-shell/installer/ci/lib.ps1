# Shared by the installer scenarios (installer.yml, design section 11). Dot-source it:
#   . "$PSScriptRoot\lib.ps1"
# Every scenario fills $script:result and calls Finish; a broken expectation throws through
# Check, which writes the result first. Results go to $env:RESULTS\<scenario>.json and into the
# job log (artifacts cannot be downloaded from every place that reads them).
$ErrorActionPreference = 'Stop'
$script:inst = Join-Path $env:LOCALAPPDATA 'Programs\SpawnLoft'
$script:guid = 'bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3'
$script:uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
$script:installKey = "HKCU:\Software\$guid"
$script:fixtures = Join-Path $env:RUNNER_TEMP 'installer-fixtures'
$script:result = [ordered]@{}
$script:scenario = 'scenario'
$script:failures = 0

function Start-Scenario($name) {
  $script:scenario = $name
  $script:result = [ordered]@{ scenario = $name; startedAt = (Get-Date).ToString('o') }
  New-Item -ItemType Directory -Force -Path $env:RESULTS | Out-Null
  # the fixtures live outside the install folder and the data root, at a path both 1.x and 2.0
  # daemons can run them from
  New-Item -ItemType Directory -Force -Path $fixtures | Out-Null
  Copy-Item -Force "$PSScriptRoot\fake-java.mjs" $fixtures
  Copy-Item -Recurse -Force (Join-Path $env:GITHUB_WORKSPACE 'test\fixtures\fake-mariadb') $fixtures
  # scheduled tasks and the 2.0 core find Node on the user PATH, as on a machine with Node
  $nodeDir = Split-Path (Get-Command node).Source
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $nodeDir })) {
    [Environment]::SetEnvironmentVariable('Path', "$nodeDir;$userPath", 'User')
  }
}

function Save-Result {
  $file = Join-Path $env:RESULTS "$scenario.json"
  $script:result | ConvertTo-Json -Depth 8 | Set-Content $file
}

function Check($what, [bool] $ok, $detail = '') {
  $line = if ($ok) { "ok    $what" } else { "FAIL  $what" }
  if ($detail) { $line += "  ($detail)" }
  Write-Host $line
  $script:result["check: $what"] = if ($ok) { 'ok' } else { "FAIL $detail" }
  if (-not $ok) {
    Save-Result
    throw "$scenario`: $what"
  }
}

# Recorded, never fails the run: what CI cannot decide (an app launch that needs explorer)
function Note($what, $value) {
  Write-Host "note  $what = $($value | ConvertTo-Json -Compress -Depth 6)"
  $script:result["note: $what"] = $value
}

function Finish {
  $script:result.finishedAt = (Get-Date).ToString('o')
  Save-Result
  Write-Host "$scenario`: all checks passed"
  exit 0
}

function Reg($key, $name) {
  try { (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name } catch { $null }
}

function Run($file, $argList, $seconds, [hashtable] $extra = @{}) {
  # Start-Process -Wait also waits for every descendant (a daemon, the app --force-run starts):
  # wait for the process itself only
  Write-Host "run: $(Split-Path $file -Leaf) $argList"
  $p = Start-Process -FilePath $file -ArgumentList $argList -PassThru @extra
  $null = $p.Handle
  if (-not $p.WaitForExit($seconds * 1000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw "$scenario`: $(Split-Path $file -Leaf) $argList did not finish within $seconds s"
  }
  $p
}

function Run-Captured($file, [string[]] $argList, $seconds, [hashtable] $envs = @{}) {
  # GUI-subsystem programs (SpawnLoft.exe) are neither waited for nor captured by &; output to
  # fresh files, which a daemon started meanwhile may keep open
  $stamp = [guid]::NewGuid().ToString('N')
  $o = Join-Path $env:RUNNER_TEMP "out-$stamp.txt"
  $e = Join-Path $env:RUNNER_TEMP "err-$stamp.txt"
  $saved = @{}
  foreach ($k in $envs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envs[$k]) }
  try {
    $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $p = Run $file $quoted $seconds @{ NoNewWindow = $true; RedirectStandardOutput = $o; RedirectStandardError = $e }
    [pscustomobject]@{ code = $p.ExitCode; out = "$(Get-Content $o -Raw)"; err = "$(Get-Content $e -Raw)" }
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
}

# 1.x's CLI, the way its task shims run it
function Cli1([string[]] $cliArgs, [switch] $AllowFail) {
  $r = Run-Captured "$inst\SpawnLoft.exe" (@("$inst\resources\core\mcctl.mjs") + $cliArgs) 180 @{ ELECTRON_RUN_AS_NODE = '1' }
  Write-Host "1.x $($cliArgs -join ' ') -> $($r.code)`n$($r.out)$($r.err)"
  if ($r.code -ne 0 -and -not $AllowFail) { throw "1.x CLI $($cliArgs -join ' ') failed ($($r.code)): $($r.out)$($r.err)" }
  $r
}

# 2.0's core binary
function Core([string[]] $cliArgs, [switch] $AllowFail, $seconds = 300) {
  $r = Run-Captured "$inst\resources\bin\spawnloft-core.exe" $cliArgs $seconds
  Write-Host "core $($cliArgs -join ' ') -> $($r.code)`n$($r.out)$($r.err)"
  if ($r.code -ne 0 -and -not $AllowFail) { throw "core $($cliArgs -join ' ') failed ($($r.code)): $($r.out)$($r.err)" }
  $r
}

function Install-Legacy($setup) {
  $p = Run $setup @('/S') 300
  Check "1.x installer exit code 0" ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
  Check '1.x is in %LOCALAPPDATA%\Programs\SpawnLoft' (Test-Path "$inst\SpawnLoft.exe")
  # its updater pointed at nothing, so a newer beta cannot install itself during the run
  Set-Content "$inst\resources\app-update.yml" "provider: generic`nurl: http://127.0.0.1:9/`nupdaterCacheDirName: spawnloft-updater"
  Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force
  $v = Reg $uninstKey 'DisplayVersion'
  $script:result.legacyVersion = $v
  $v
}

function Seed-Legacy($servers, $databases) {
  $spec = @{ servers = @($servers); databases = @($databases); fixtures = $fixtures } | ConvertTo-Json -Depth 4
  $specFile = Join-Path $env:RUNNER_TEMP 'seed-spec.json'
  Set-Content $specFile $spec
  $r = Run-Captured "$inst\SpawnLoft.exe" @("$PSScriptRoot\seed-1x.mjs", "$inst\resources\core", $specFile) 180 @{ ELECTRON_RUN_AS_NODE = '1' }
  if ($r.code -ne 0) { throw "seed failed ($($r.code)): $($r.out)$($r.err)" }
  $seed = ($r.out.Trim() -split "`n")[-1] | ConvertFrom-Json
  $script:result.seed = $seed
  $seed
}

function Parse-List($r) {
  $map = @{}
  if ($r.code -ne 0) { Write-Host "list failed ($($r.code)): $($r.out)$($r.err)"; return $map }
  foreach ($i in @((($r.out.Trim() -split "`n")[-1]) | ConvertFrom-Json)) { if ($i) { $map[$i.name] = $i } }
  $map
}

# 1.x's view of every server and database (its own readState, through SpawnLoft.exe as Node)
function List1 {
  Parse-List (Run-Captured "$inst\SpawnLoft.exe" @("$PSScriptRoot\list.mjs", "$inst\resources\core") 120 @{ ELECTRON_RUN_AS_NODE = '1' })
}

# 2.0's CLI: the bundled Node core on the machine's Node until R4 (the core binary has no `list`)
function Cli2([string[]] $cliArgs, [switch] $AllowFail) {
  $r = Run-Captured (Get-Command node).Source (@("$inst\resources\core\spawnloft.mjs") + $cliArgs) 240
  Write-Host "2.0 $($cliArgs -join ' ') -> $($r.code)`n$($r.out)$($r.err)"
  if ($r.code -ne 0 -and -not $AllowFail) { throw "2.0 CLI $($cliArgs -join ' ') failed ($($r.code)): $($r.out)$($r.err)" }
  $r
}

# 2.0's view (the bundled Node core on the machine's Node, until R4)
function Status2 {
  Parse-List (Run-Captured (Get-Command node).Source @("$PSScriptRoot\list.mjs", "$inst\resources\core") 120)
}

function Wait-Until([scriptblock] $cond, $seconds = 60) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $seconds) {
    if (& $cond) { return $true }
    Start-Sleep -Milliseconds 500
  }
  [bool] (& $cond)
}

function Pid-Alive([int] $id) {
  [bool] (Get-Process -Id $id -ErrorAction SilentlyContinue)
}

function Read-Json($file) {
  if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { $null }
}

function State($dataRoot, $name) {
  Read-Json (Join-Path $dataRoot "run\$name\state.json")
}

function Task-Result($taskName) {
  $info = schtasks /Query /TN $taskName /V /FO CSV | ConvertFrom-Csv
  [ordered]@{ lastRun = $info.'Last Run Time'; lastResult = $info.'Last Result'; status = $info.Status; state = $info.'Scheduled Task State' }
}

function Run-Task($taskName) {
  $before = (Task-Result $taskName).lastRun
  schtasks /Run /TN $taskName | Out-Null
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 1
    $r = Task-Result $taskName
    if ($r.lastRun -ne $before -and $r.status -ne 'Running') { return $r }
  }
  Task-Result $taskName
}

function Tasks-Under-Mcctl {
  @(Get-ScheduledTask -TaskPath '\mcctl\' -ErrorAction SilentlyContinue)
}

function Kill-Everything {
  # between steps of a scenario that reuses the machine; never part of an assertion
  Get-Process SpawnLoft, spawnloft-core -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# The 2.0 installer as electron-updater's NsisUpdater starts it (only its publisher check is
# skipped: CI's installers are unsigned)
function Run-Installer($setup, [string[]] $argList, $seconds = 600) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Run $setup $argList $seconds
  [pscustomobject]@{ code = $p.ExitCode; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

function Check-Layout2 {
  $exe = Get-Item "$inst\SpawnLoft.exe"
  Check 'SpawnLoft.exe is the 2.0 shell' ($exe.VersionInfo.ProductVersion -like '2.*') $exe.VersionInfo.ProductVersion
  Check 'no Electron left (resources\app.asar gone)' (-not (Test-Path "$inst\resources\app.asar"))
  Check '1.x uninstaller gone' (-not (Test-Path "$inst\Uninstall SpawnLoft.exe"))
  Check '2.0 uninstaller present' (Test-Path "$inst\uninstall.exe")
  Check 'core at resources\bin\spawnloft-core.exe' (Test-Path "$inst\resources\bin\spawnloft-core.exe")
  Check 'Node core at resources\core\mcctl.mjs' (Test-Path "$inst\resources\core\mcctl.mjs")
  Check 'staging folder removed' (-not (Test-Path "$inst\resources\bin\staging"))
  $v2 = Reg $uninstKey 'DisplayVersion'
  Check 'same uninstall key, 2.x version' ($v2 -like '2.*') "DisplayVersion $v2"
  Check 'no stray Tauri-default key' (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpawnLoft'))
  $startLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'SpawnLoft.lnk'
  if (Test-Path $startLnk) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($startLnk).TargetPath
    Check 'Start menu shortcut opens the new exe' ($target -eq "$inst\SpawnLoft.exe") $target
  }
}

# The app the installer started, if any, and its command line (no installer flags may reach it)
function App-CommandLines {
  @(Get-CimInstance Win32_Process -Filter "Name = 'SpawnLoft.exe'" | ForEach-Object { $_.CommandLine })
}
