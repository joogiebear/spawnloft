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
# the harness's own Node (setup-node), by full path: seeding and list.mjs run on it; nothing of
# 2.0 may (the scenarios hide every other Node from 2.0, see Set-NodeMode)
$script:harnessNode = (Get-Command node).Source
# the checkout's Node core (src\), which the harness's own readers import: 2.0 ships none
# (rust/PLAN-CORE-PORT.md 5.1), and its registry and state files are the same as 2.0's
$script:checkoutCore = $env:GITHUB_WORKSPACE
$script:nodeMode = 'none'
$script:decoyLog = Join-Path $env:RUNNER_TEMP 'decoy-node.log'

function Start-Scenario($name) {
  $script:scenario = $name
  $script:result = [ordered]@{ scenario = $name; startedAt = (Get-Date).ToString('o') }
  New-Item -ItemType Directory -Force -Path $env:RESULTS | Out-Null
  # the fixtures live outside the install folder and the data root, at a path both 1.x and 2.0
  # daemons can run them from
  New-Item -ItemType Directory -Force -Path $fixtures | Out-Null
  # the JVM stand-in is native (spawnloft-fakes' fake-java, which installer.yml builds and names
  # in FAKE_JAVA_EXE): 1.x's daemon and 2.0's both run it as they run a real java, where a
  # release 2.0 core runs no .mjs stand-in
  if (-not $env:FAKE_JAVA_EXE -or -not (Test-Path $env:FAKE_JAVA_EXE)) { throw "FAKE_JAVA_EXE does not name fake-java.exe: '$env:FAKE_JAVA_EXE'" }
  Copy-Item -Force $env:FAKE_JAVA_EXE (Join-Path $fixtures 'fake-java.exe')
  # the MariaDB tools likewise: spawnloft-fakes' fake-mariadb (FAKE_MARIADB_EXE) under each
  # tool's name in bin\, where both cores look for <name>.exe before <name>.mjs
  if (-not $env:FAKE_MARIADB_EXE -or -not (Test-Path $env:FAKE_MARIADB_EXE)) { throw "FAKE_MARIADB_EXE does not name fake-mariadb.exe: '$env:FAKE_MARIADB_EXE'" }
  $mariaBin = Join-Path $fixtures 'fake-mariadb\bin'
  New-Item -ItemType Directory -Force -Path $mariaBin | Out-Null
  foreach ($t in 'mariadbd', 'mariadb', 'mariadb-admin', 'mariadb-dump', 'mariadb-install-db') {
    Copy-Item -Force $env:FAKE_MARIADB_EXE (Join-Path $mariaBin "$t.exe")
  }
  Set-NodeMode $script:nodeMode
}

# 2.0 runs no Node at all (rust/PLAN-CORE-PORT.md 5.1), so every scenario runs with no Node.js on
# any PATH 2.0 could read: this process's (which the installer, the core and the CLI inherit)
# and the persisted user and machine PATH (which Task Scheduler and the app read).
#   none   no node.exe on any PATH
#   decoy  a node.exe first on every PATH that logs each run to $decoyLog and fails; Finish
#          fails the scenario if anything ran it
function Set-NodeMode([string] $mode) {
  $script:result.nodeMode = $mode
  $strip = {
    param($value)
    @("$value" -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'node.exe')) }) -join ';'
  }
  $env:Path = & $strip $env:Path
  foreach ($scope in 'User', 'Machine') {
    $v = [Environment]::GetEnvironmentVariable('Path', $scope)
    $nv = & $strip $v
    if ($nv -ne $v) { [Environment]::SetEnvironmentVariable('Path', $nv, $scope) }
  }
  if ($mode -eq 'decoy') {
    $dir = Join-Path $env:RUNNER_TEMP 'decoy-node'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $src = Join-Path $dir 'decoy.cs'
    Set-Content $src @"
class Decoy {
  static int Main() {
    System.IO.File.AppendAllText(@"$($script:decoyLog)", System.Environment.CommandLine + "\r\n");
    System.Console.Error.WriteLine("decoy node.exe: SpawnLoft 2 must not run a Node");
    return 1;
  }
}
"@
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /target:exe "/out:$dir\node.exe" $src | Out-Host
    if (-not (Test-Path "$dir\node.exe")) { throw 'could not build the decoy node.exe' }
    $env:Path = "$dir;$env:Path"
    foreach ($scope in 'User', 'Machine') {
      [Environment]::SetEnvironmentVariable('Path', "$dir;" + [Environment]::GetEnvironmentVariable('Path', $scope), $scope)
    }
  }
  $seen = (Get-Command node -ErrorAction SilentlyContinue).Source
  $script:result.nodeOnPath = $seen
  if ($mode -eq 'none' -and $seen) { throw "a node.exe is still on PATH: $seen" }
  if ($mode -eq 'decoy' -and $seen -notlike '*decoy-node*') { throw "the decoy is not first on PATH: $seen" }
}

# The decoy logs every run; 2.0 must never have started it
function Check-No-Decoy {
  if ($script:nodeMode -ne 'decoy') { return }
  $ran = if (Test-Path $script:decoyLog) { (Get-Content $script:decoyLog -Raw).Trim() } else { '' }
  Check 'nothing ran the decoy node.exe on PATH (2.0 runs no Node)' (-not $ran) $ran
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
  Check-No-Decoy
  $script:result.finishedAt = (Get-Date).ToString('o')
  Save-Result
  Write-Host "$scenario`: all checks passed"
  exit 0
}

function Reg($key, $name) {
  try { (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name } catch { $null }
}

# How many entries of the user's PATH (HKCU\Environment, as stored, then expanded) name $dir
function User-Path-Count([string] $dir) {
  $want = $dir.TrimEnd('\').ToLowerInvariant()
  @("$(Reg 'HKCU:\Environment' 'Path')" -split ';' | Where-Object {
    $_.Trim() -and [Environment]::ExpandEnvironmentVariables($_).Trim().TrimEnd('\').ToLowerInvariant() -eq $want
  }).Count
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

# 2.0's CLI: spawnloft-core, which answers every command itself
function Cli2([string[]] $cliArgs, [switch] $AllowFail) {
  $r = Run-Captured "$inst\resources\bin\spawnloft-core.exe" $cliArgs 240
  Write-Host "2.0 $($cliArgs -join ' ') -> $($r.code)`n$($r.out)$($r.err)"
  if ($r.code -ne 0 -and -not $AllowFail) { throw "2.0 CLI $($cliArgs -join ' ') failed ($($r.code)): $($r.out)$($r.err)" }
  $r
}

# 2.0's view (readState of the checkout's Node core, run on the harness's Node, over the same
# files 2.0 writes: orphaned and stale included)
function Status2 {
  Parse-List (Run-Captured $script:harnessNode @("$PSScriptRoot\list.mjs", $script:checkoutCore) 120)
}

# `spawnloft list --json` the way a person runs it in a terminal: the 1.x path's spawnloft.cmd
function Terminal-List {
  $r = Run-Captured "$env:WINDIR\System32\cmd.exe" @('/d', '/c', "$inst\resources\bin\spawnloft.cmd", 'list', '--json') 120
  Write-Host "spawnloft list --json -> $($r.code)`n$($r.out)$($r.err)"
  $r
}

# `spawnloft-core mcp` held open, as an AI client runs it: stdin and stdout are pipes
function Start-Mcp {
  $si = New-Object System.Diagnostics.ProcessStartInfo "$inst\resources\bin\spawnloft-core.exe", 'mcp'
  $si.UseShellExecute = $false
  $si.RedirectStandardInput = $true
  $si.RedirectStandardOutput = $true
  $si.RedirectStandardError = $true
  $si.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($si)
  $null = $p.StandardError.ReadToEndAsync()
  $p
}

# One JSON-RPC request to a Start-Mcp process; the parsed answer, or $null after $seconds
function Mcp-Call($p, [int] $id, [string] $method, $params = @{}) {
  $req = @{ jsonrpc = '2.0'; id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 6
  $p.StandardInput.WriteLine($req)
  $p.StandardInput.Flush()
  $read = $p.StandardOutput.ReadLineAsync()
  if (-not $read.Wait(60000)) { return $null }
  try { $read.Result | ConvertFrom-Json } catch { $null }
}

function Mcp-Initialize($p) {
  Mcp-Call $p 1 'initialize' @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'installer-ci'; version = '1' } }
}

# What a 2.0 build before C10 left in the install folder: its bundled Node and its Node core
# (installer.nsi SPAWNLOFT_REMOVE_NODE removes them, spawnloft-core repair too)
function Old-Node-Folders {
  @('runtime', 'core' | Where-Object { Test-Path "$inst\resources\$_" })
}

# Lays out, under the installed 2.x, what a 2.0 build before C10 shipped and every update since
# keeps (an update deletes no file the new package does not list): resources\runtime with a real
# node.exe (a copy of the harness's) and runtime.json, an older update's held old-<stamp> copy,
# and resources\core with the Node core's files. Then, with -Hold, starts that node.exe on a
# script from resources\core that sleeps, as an MCP session or a bot run started before the
# update would be. Returns the held process, or $null.
function Seed-Old-Node([switch] $Hold) {
  $ver = '24.22.3'
  $rt = "$inst\resources\runtime"
  New-Item -ItemType Directory -Force "$rt\node-$ver", "$rt\old-20261120-101500", "$inst\resources\core\src" | Out-Null
  Copy-Item -Force $script:harnessNode "$rt\node-$ver\node.exe"
  Copy-Item -Force $script:harnessNode "$rt\old-20261120-101500\node.exe"
  Set-Content "$rt\node-$ver\LICENSE" 'Node.js licence'
  @{ node = $ver; exe = "node-$ver/node.exe"; platform = 'win32'; arch = 'x64' } | ConvertTo-Json | Set-Content "$rt\runtime.json"
  Set-Content "$inst\resources\core\mcctl.mjs" '// the Node core of an older 2.0 build'
  @{ name = 'spawnloft'; version = '2.0.0-internal.900' } | ConvertTo-Json | Set-Content "$inst\resources\core\package.json"
  Set-Content "$inst\resources\core\internal-defaults.json" '{ "daemon": "rust" }'
  Set-Content "$inst\resources\core\src\hold.mjs" 'setInterval(() => {}, 1 << 30)'
  Check 'the older build''s resources\runtime and resources\core are laid out' ((Old-Node-Folders).Count -eq 2)
  if (-not $Hold) { return $null }
  $p = Start-Process "$rt\node-$ver\node.exe" -ArgumentList "`"$inst\resources\core\src\hold.mjs`"" -PassThru -WindowStyle Hidden
  $null = $p.Handle
  Start-Sleep -Seconds 2
  Check '  and its node.exe runs, holding the file' (-not $p.HasExited) "pid $($p.Id)"
  Check '  so it cannot be deleted' ((Get-Process -Id $p.Id -ErrorAction SilentlyContinue).Path -eq "$rt\node-$ver\node.exe") "$((Get-Process -Id $p.Id -ErrorAction SilentlyContinue).Path)"
  $p
}

# What 2.0 writes to disk names spawnloft-core, never a Node (A5): the files, and the record
function Check-Entry-Point($dataRoot) {
  $core = "$inst\resources\bin\spawnloft-core.exe"
  $ok = Wait-Until { $r = Read-Json (Join-Path $dataRoot 'run\runtime.json'); $r.format -eq 2 -and $r.exe -eq $core } 60
  $rt = Read-Json (Join-Path $dataRoot 'run\runtime.json')
  Check 'run\runtime.json is format 2 and names spawnloft-core' $ok "$($rt | ConvertTo-Json -Compress)"
  $shims = @(Get-ChildItem (Join-Path $dataRoot 'tasks') -Filter *.cmd -ErrorAction SilentlyContinue)
  Check 'there is a task shim to look at' ($shims.Count -ge 1)
  foreach ($f in $shims) {
    $t = Get-Content $f.FullName -Raw
    Check "task shim $($f.Name) runs spawnloft-core" ($t.Contains("`"$core`"") -and $t -notmatch 'node(\.exe)?\b' -and $t -notmatch '\.mjs') $t
  }
}

function Wait-Until([scriptblock] $cond, $seconds = 60) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $seconds) {
    if (& $cond) { return $true }
    Start-Sleep -Milliseconds 500
  }
  [bool] (& $cond)
}

# a pid, or "pid@ticks" from Proc-Key: Windows hands a freed pid out again within seconds, so a
# process is the same one only if its start time matches too
function Pid-Alive($id) {
  $pid0, $ticks = "$id" -split '@'
  if (-not $pid0) { return $false }
  $p = Get-Process -Id ([int] $pid0) -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  if (-not $ticks) { return $true }
  try { "$($p.StartTime.ToUniversalTime().Ticks)" -eq $ticks } catch { $true }
}

function Proc-Key($id) {
  if (-not $id) { return $id }
  $p = Get-Process -Id ([int] $id) -ErrorAction SilentlyContinue
  if (-not $p) { return "$id" }
  try { "$id@$($p.StartTime.ToUniversalTime().Ticks)" } catch { "$id" }
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
  Check 'the licence at resources\LICENSE' (Test-Path "$inst\resources\LICENSE")
  # no Node and no Node core in 2.x (rust/PLAN-CORE-PORT.md 5.1); over 1.x, its resources\core
  # was read by `handover stop` before anything removed it
  Check 'no resources\runtime and no resources\core' ((Old-Node-Folders).Count -eq 0) "$(Old-Node-Folders)"
  $leftNode = @(Get-ChildItem $inst -Recurse -File -Include 'node.exe', '*.mjs' -ErrorAction SilentlyContinue | ForEach-Object FullName)
  Check 'no node.exe and no .mjs anywhere in the install folder' ($leftNode.Count -eq 0) "$leftNode"
  Check 'the CLI forwarders at 1.x''s paths' ((Test-Path "$inst\resources\bin\spawnloft.cmd") -and (Test-Path "$inst\resources\bin\mcctl.cmd"))
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
