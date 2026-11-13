# One installer scenario of rust/INSTALLER-UPDATER-DESIGN.md section 11, on a fresh windows-latest
# machine (installer.yml runs each in a job of its own).
#
#   scenario.ps1 -Name s1|s2a|s2b|s3|s4|s5|s8|s9 -Feed <dir with the 2.0 installers> -Beta <1.6 setup>
#                -Stable <1.5.0 setup> -VersionA <2.x a> -VersionB <2.x b> [-NodeMode none|decoy]
#
# Every scenario runs with no Node.js on PATH (2.0 carries its own); -NodeMode decoy puts a
# node.exe on PATH that fails and logs each run, and the scenario fails if anything ran it.
#
# Writes $env:RESULTS\<name>.json; exits non-zero on the first broken expectation.
param(
  [Parameter(Mandatory)] [string] $Name,
  [Parameter(Mandatory)] [string] $Feed,
  [string] $Beta = '',
  [string] $Stable = '',
  [Parameter(Mandatory)] [string] $VersionA,
  [Parameter(Mandatory)] [string] $VersionB,
  [ValidateSet('none', 'decoy')] [string] $NodeMode = 'none'
)
. "$PSScriptRoot\lib.ps1"
$script:nodeMode = $NodeMode

$setupA = Join-Path $Feed "SpawnLoft_${VersionA}_x64-setup.exe"
$setupB = Join-Path $Feed "SpawnLoft_${VersionB}_x64-setup.exe"
$nodeExe = $script:harnessNode

function Use-Layout([string] $layout, [string] $dataRoot = '') {
  # new: %APPDATA%\spawnloft\settings.json, data in %LOCALAPPDATA%\spawnloft (since the rename)
  # old: %APPDATA%\mcctl\settings.json, data in %LOCALAPPDATA%\mcctl (1.5.0 and earlier installs)
  $cfgName = if ($layout -eq 'old') { 'mcctl' } else { 'spawnloft' }
  if (-not $dataRoot) { $dataRoot = Join-Path $env:LOCALAPPDATA $cfgName }
  New-Item -ItemType Directory -Force (Join-Path $env:APPDATA $cfgName), $dataRoot | Out-Null
  @{ dataRoot = $dataRoot } | ConvertTo-Json | Set-Content (Join-Path $env:APPDATA "$cfgName\settings.json")
  $script:result.layout = @{ layout = $layout; dataRoot = $dataRoot }
  $dataRoot
}

function Start-Running1([string[]] $names) {
  foreach ($n in $names) { Cli1 @('start', $n, '--detach') | Out-Null }
  $ok = Wait-Until { $l = List1; @($names | Where-Object { $l[$_].status -ne 'running' }).Count -eq 0 } 90
  Check "1.x started $($names -join ', ')" $ok
}

function Make-Orphan($dataRoot, $name, $dir) {
  # what a crashed 1.x daemon leaves: java still running, the daemon gone, state.json saying
  # running. (Killing a real 1.x daemon takes its JVM with it: the JVM is in the daemon's job.)
  $java = Start-Process $script:harnessNode -ArgumentList "`"$fixtures\fake-java.mjs`"" -WorkingDirectory $dir -PassThru -WindowStyle Hidden
  $gone = Start-Process "$env:WINDIR\System32\cmd.exe" -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden
  $gone.WaitForExit()
  $runDir = Join-Path $dataRoot "run\$name"
  New-Item -ItemType Directory -Force $runDir | Out-Null
  @{ name = $name; running = $true; daemonPid = $gone.Id; daemonExe = 'SpawnLoft.exe'; javaPid = $java.Id; javaExe = 'node.exe'; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
    ConvertTo-Json | Set-Content (Join-Path $runDir 'state.json')
  Check "$name is orphaned under 1.x (java alive, daemon gone)" (Wait-Until { (List1)[$name].status -eq 'orphaned' } 30) "$((List1)[$name].status)"
  $java.Id
}

# the JVM as pid@start time (Proc-Key), so a reused pid is not taken for the old process
function Java-Pid($dataRoot, $name) { Proc-Key (State $dataRoot $name).javaPid }

function Record($dataRoot) { Read-Json (Join-Path $dataRoot 'run\handover.json') }

function Entry($record, $name) { @($record.servers | Where-Object { $_.name -eq $name })[0] }

function Starts($dir) {
  $f = Join-Path $dir 'fake-starts.log'
  if (Test-Path $f) { @(Get-Content $f | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() }
}

function Console-Has($dataRoot, $name, $text) {
  $f = Join-Path $dataRoot "run\$name\console.log"
  (Test-Path $f) -and [bool] (Select-String -LiteralPath $f -Pattern $text -SimpleMatch -Quiet)
}

function Check-Graceful($dataRoot, $name, $oldPid, $evidence = $null) {
  Check "$name's old process is gone" (Wait-Until { -not (Pid-Alive $oldPid) } 30) "pid $oldPid"
  if ($evidence) {
    # the fake MariaDB says "Normal shutdown" on a graceful stop and logs it in its data folder's
    # fake-shutdowns.log (a restart starts the console log again); a kill does neither
    $logs = @(Get-ChildItem (Join-Path $dataRoot "services\$name") -Recurse -Filter 'fake-shutdowns.log' -ErrorAction SilentlyContinue)
    Check "$name was stopped, not killed (${evidence}: fake-shutdowns.log or console)" ($logs.Count -gt 0 -or (Console-Has $dataRoot $name $evidence))
    return
  }
  # the fake java logs each graceful stop by pid in fake-stops.log (a restart rotates the console
  # log, so the console is not the evidence); a kill logs nothing
  $f = Join-Path $dataRoot "instances\$name\fake-stops.log"
  $stops = if (Test-Path $f) { @(Get-Content $f | ForEach-Object { ($_ | ConvertFrom-Json).pid }) } else { @() }
  Check "$name was stopped, not killed (a graceful stop in fake-stops.log)" ($stops.Count -gt 0) "java pid $oldPid, stops: $($stops -join ',')"
  Note "$name-stopPidMatches" ($stops -contains [int](("$oldPid" -split '@')[0]))
}

function Check-Rust-Daemon($dataRoot, $name) {
  $st = State $dataRoot $name
  Check "$name runs under 2.0's daemon" ($st.daemonExe -like '*spawnloft-core*') "daemonExe $($st.daemonExe)"
  Check "$name's state has daemonStartTime" ("$($st.daemonStartTime)" -match '^\d+$') "$($st.daemonStartTime)"
  $st
}

function Seed-Profile {
  # Electron's Chromium profile in %APPDATA%\SpawnLoft (the same folder as spawnloft on NTFS)
  $cfg = Join-Path $env:APPDATA 'spawnloft'
  New-Item -ItemType Directory -Force $cfg | Out-Null
  foreach ($d in 'Cache\Cache_Data', 'Code Cache\js', 'GPUCache', 'Local Storage\leveldb', 'Session Storage', 'Network', 'Crashpad\reports', 'blob_storage', 'DawnGraphiteCache', 'Shared Dictionary\cache') {
    New-Item -ItemType Directory -Force (Join-Path $cfg $d) | Out-Null
    Set-Content (Join-Path $cfg "$d\data_0") 'x'
  }
  foreach ($f in 'Preferences', 'Local State', 'Cookies', 'Cookies-journal', 'TransportSecurity', 'DIPS', 'LOCK', 'LOG') { Set-Content (Join-Path $cfg $f) '{}' }
  foreach ($k in 'window-state.json', 'launcher-window-state.json', 'ui-zoom.json', 'update-channel.json') { Set-Content (Join-Path $cfg $k) '{"kept":true}' }
  New-Item -ItemType Directory -Force (Join-Path $cfg 'servers-notes') | Out-Null
  $upd = Join-Path $env:LOCALAPPDATA 'spawnloft-desktop-updater\pending'
  New-Item -ItemType Directory -Force $upd | Out-Null
  Set-Content (Join-Path $upd 'SpawnLoft-Setup-1.6.0-beta.999.exe') 'x'
  $cfg
}

# ---------------------------------------------------------------------------------------------
# 1 (and 2): the handover from a published 1.x with servers in every state
function Handover-Scenario([string] $setup1, [string] $layout, [string[]] $installerArgs, [string] $envRoot = '') {
  $dataRoot = if ($envRoot) {
    # SPAWNLOFT_DATA_ROOT (MCCTL_DATA_ROOT for 1.5.0) on another drive letter, for every process
    # of this job: the installer, both CLIs, the daemons
    New-Item -ItemType Directory -Force $envRoot | Out-Null
    $env:SPAWNLOFT_DATA_ROOT = $envRoot
    $env:MCCTL_DATA_ROOT = $envRoot
    $script:result.layout = @{ layout = 'env'; dataRoot = $envRoot }
    $envRoot
  } else { $null }
  $v1 = Install-Legacy $setup1
  if (-not $dataRoot) { $dataRoot = Use-Layout $layout }
  $seed = Seed-Legacy @(@{ name = 'survival' }, @{ name = 'creative' }, @{ name = 'lost' }) @('mysql-main')
  Check 'seeded into the expected data root' ($seed.dataRoot -eq $dataRoot) "$($seed.dataRoot) vs $dataRoot"
  Start-Running1 @('mysql-main', 'survival')
  $lostJava = Make-Orphan $dataRoot 'lost' $seed.servers.lost
  $survivalJava = Java-Pid $dataRoot 'survival'
  $dbJava = Java-Pid $dataRoot 'mysql-main'
  Cli1 @('task', 'add', 'survival', '--do', 'backup', '--daily', '03:00') | Out-Null
  $task = @(Tasks-Under-Mcctl)[0]
  Check '1.x registered a task under \mcctl\' ($null -ne $task)
  $taskName = "\mcctl\$($task.TaskName)"
  $script:result.task = $taskName
  $shimBefore = Get-Content (Join-Path $dataRoot 'tasks\*.cmd') -Raw
  $script:result.shimBefore = $shimBefore

  $run = Run-Installer $setupA $installerArgs
  $script:result.handoverSeconds = $run.seconds
  Check "2.0 installer exit code 0 ($($installerArgs -join ' '))" ($run.code -eq 0) "exit $($run.code)"
  Check-Layout2

  $rec = Record $dataRoot
  Check 'handover.json written' ($null -ne $rec)
  $script:result.record = $rec
  Check 'record names the 1.x version' ("$($rec.from)" -eq $v1) "from $($rec.from), installed $v1"
  $s = Entry $rec 'survival'; $d = Entry $rec 'mysql-main'; $o = Entry $rec 'lost'
  Check 'survival: stopped, then running' ($s.stop -eq 'stopped' -and $s.start -eq 'running') "$($s.stop)/$($s.start) $($s.error)"
  Check 'mysql-main: stopped, then running' ($d.stop -eq 'stopped' -and $d.start -eq 'running') "$($d.stop)/$($d.start) $($d.error)"
  Check 'lost: orphaned, left alone' ($o.stop -eq 'orphaned' -and -not $o.start) "$($o.stop)/$($o.start)"
  Check 'creative (stopped) is not in the record' ($null -eq (Entry $rec 'creative'))
  Check 'servers stopped before databases' ([int64] $s.stoppedAt -le [int64] $d.stoppedAt) "$($s.stoppedAt) / $($d.stoppedAt)"
  Check 'databases started before servers' ([int64] $d.startedAt -le [int64] $s.startedAt) "$($d.startedAt) / $($s.startedAt)"
  Check 'the task folder was disabled for the stop' (@($rec.tasksDisabled) -contains $task.TaskName -or @($rec.tasksDisabled).Count -ge 1) "$($rec.tasksDisabled)"
  Check 'and enabled again' ([bool] $rec.tasksReenabled)

  Check-Graceful $dataRoot 'survival' $survivalJava
  Check-Graceful $dataRoot 'mysql-main' $dbJava 'Normal shutdown'
  Check "lost's JVM was not touched" (Pid-Alive $lostJava) "pid $lostJava"
  $starts = Starts $seed.servers.survival
  Check 'survival was started again on the bundled Node, not by SpawnLoft.exe or a system Node' ($starts.Count -ge 2 -and $starts[-1].runtime -like "$inst\resources\runtime\node-*\node.exe") "$($starts | ConvertTo-Json -Compress)"
  Check-Rust-Daemon $dataRoot 'survival' | Out-Null
  Check-Rust-Daemon $dataRoot 'mysql-main' | Out-Null
  $l2 = Status2
  Check '2.0 lists survival and mysql-main running' ($l2['survival'].status -eq 'running' -and $l2['mysql-main'].status -eq 'running') "$($l2['survival'].status) / $($l2['mysql-main'].status)"
  Check '2.0 lists creative stopped' ($l2['creative'].status -eq 'stopped') "$($l2['creative'].status)"

  $state = (Get-ScheduledTask -TaskPath '\mcctl\' -TaskName $task.TaskName).State
  Check 'the task is enabled again' ("$state" -ne 'Disabled') "$state"
  $shimAfter = Get-Content (Join-Path $dataRoot 'tasks\*.cmd') -Raw
  $script:result.shimAfter = $shimAfter
  Check 'the shim was rewritten for 2.0 (no Electron runner)' ($shimAfter -ne $shimBefore -and $shimAfter -notmatch 'ELECTRON_RUN_AS_NODE') $shimAfter
  Check-Entry-Point $dataRoot
  $script:result.taskRun = Run-Task $taskName
  if ($envRoot) {
    # a subst drive belongs to this logon session, which Task Scheduler's need not share
    Note 'task run with the data root on a subst drive' $script:result.taskRun
  } else {
    Check 'the task runs green after the handover' ("$($script:result.taskRun.lastResult)" -eq '0') "$($script:result.taskRun.lastResult)"
  }
  # the command line from a terminal, and an MCP server, both with no Node on PATH
  $tl = Terminal-List
  $listed = try { (($tl.out.Trim() -split "`n")[-1] | ConvertFrom-Json) } catch { $null }
  Check 'spawnloft list --json from a terminal lists the servers' ($tl.code -eq 0 -and $listed.ok -and @($listed.data.instances | Where-Object { $_.name -eq 'survival' }).Count -eq 1) "$($tl.code) $($tl.out)$($tl.err)"
  $mcp = Start-Mcp
  $init = Mcp-Initialize $mcp
  Check 'spawnloft-core mcp answers initialize' ($init.result.serverInfo.name -eq 'spawnloft') "$($init | ConvertTo-Json -Compress -Depth 6)"
  $mcp.StandardInput.Close()
  Check '  and ends when its client closes stdin' ($mcp.WaitForExit(30000))

  Check 'handover.log written' (Test-Path (Join-Path $dataRoot 'run\handover.log'))
  $script:result.handoverLog = Get-Content (Join-Path $dataRoot 'run\handover.log') -Raw

  Start-Sleep -Seconds 5
  $cmd = App-CommandLines
  Note 'app command lines after the install' $cmd
  Check 'no installer flag reached the app' (-not ($cmd | Where-Object { $_ -match '--updated|--force-run|/ROLLBACK|/S\b' }))
  if ($installerArgs -notcontains '--force-run') {
    Check 'no app launched without --force-run' ($cmd.Count -eq 0) "$cmd"
  }
}

# ---------------------------------------------------------------------------------------------
switch ($Name) {
  's1' {
    Start-Scenario 's1-handover-from-1.6'
    Handover-Scenario $Beta 'new' @('--updated', '/S', '--force-run')
  }
  's2a' {
    Start-Scenario 's2a-handover-from-1.5-old-layout'
    Handover-Scenario $Stable 'old' @('--updated', '/S', '--force-run')
  }
  's2b' {
    Start-Scenario 's2b-handover-from-1.5-env-root-no-force-run'
    # a second drive letter for the data root
    $real = Join-Path $env:RUNNER_TEMP 'second-drive'
    New-Item -ItemType Directory -Force $real | Out-Null
    subst S: $real
    Handover-Scenario $Stable 'old' @('--updated', '/S') 'S:\spawnloft-data'
  }

  's3' {
    Start-Scenario 's3-a-server-refuses-to-stop'
    $v1 = Install-Legacy $Beta
    $dataRoot = Use-Layout 'new'
    $seed = Seed-Legacy @(@{ name = 'stuck'; ignoreStop = $true }, @{ name = 'good' }) @()
    Start-Running1 @('stuck', 'good')
    $stuckJava = Java-Pid $dataRoot 'stuck'
    $goodJava = Java-Pid $dataRoot 'good'
    $run = Run-Installer $setupA @('--updated', '/S', '--force-run') 900
    $script:result.firstRun = $run
    Check 'installer exits 4' ($run.code -eq 4) "exit $($run.code)"
    Check 'within the deadline + 30 s (300 + 30)' ($run.seconds -le 330) "$($run.seconds) s"
    Check '1.x intact (app.asar present)' (Test-Path "$inst\resources\app.asar")
    Check '1.x uninstaller still there' (Test-Path "$inst\Uninstall SpawnLoft.exe")
    Check 'version unchanged' ((Reg $uninstKey 'DisplayVersion') -eq $v1) (Reg $uninstKey 'DisplayVersion')
    Check 'the stuck server still runs, never signalled' ((Pid-Alive $stuckJava) -and -not (Test-Path (Join-Path $seed.servers.stuck 'fake-exit.json')))
    $l = List1
    Check 'the other server runs again under 1.x' ($l['good'].status -eq 'running') "$($l['good'].status)"
    Check-Graceful $dataRoot 'good' $goodJava
    $st = State $dataRoot 'good'
    Check '  and is run by 1.x again' ($st.daemonExe -like '*SpawnLoft*') "daemonExe $($st.daemonExe)"
    $marker = Read-Json (Join-Path $dataRoot 'run\handover-blocked.json')
    $script:result.marker = $marker
    Check 'handover-blocked.json names the stuck server' ($marker -and @($marker.blockedBy) -contains 'stuck') "$($marker | ConvertTo-Json -Compress)"
    Check 'tasks folder not left disabled' (@(Tasks-Under-Mcctl | Where-Object { $_.State -eq 'Disabled' }).Count -eq 0)
    $rec = Record $dataRoot
    $script:result.record = $rec
    $goodStarts = (Starts $seed.servers.good).Count
    $run2 = Run-Installer $setupA @('--updated', '/S', '--force-run') 120
    $script:result.secondRun = $run2
    Check 'a second silent run exits 4' ($run2.code -eq 4) "exit $($run2.code)"
    Check '  within 10 s of its start (plus the installer''s own unpacking)' ($run2.seconds -le 20) "$($run2.seconds) s"
    Check '  without stopping anything' ((Starts $seed.servers.good).Count -eq $goodStarts -and (List1)['good'].status -eq 'running')
    $marker2 = Read-Json (Join-Path $dataRoot 'run\handover-blocked.json')
    Check '  and counts the attempt' ([int] $marker2.attempts -ge 2) "$($marker2.attempts)"
  }

  's4' {
    Start-Scenario 's4-ui-mode-cancel-mutex-panel'
    $v1 = Install-Legacy $Beta
    $dataRoot = Use-Layout 'new'
    $seed = Seed-Legacy @(@{ name = 'slow'; ignoreStop = $true }, @{ name = 'good' }) @()
    Start-Running1 @('slow', 'good')
    $goodJava = Java-Pid $dataRoot 'good'
    $p = Start-Process $setupA -PassThru
    $null = $p.Handle
    # plain Win32 for NSIS's dialogs: the main window is the visible #32770 of the setup's pid
    # with a Back button (id 3); its buttons are 1 Next/Install, 2 Cancel, 3 Back, pressed with
    # BM_CLICK; texts are read with WM_GETTEXT, which Windows marshals across processes
    Add-Type -Namespace Ci -Name Win -UsingNamespace System.Text, System.Collections.Generic -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
[DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
public static string Text(IntPtr h) { var s = new StringBuilder(4096); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)4096, s, 2, 2000, out r); return s.ToString(); }
public static List<IntPtr> Tops(int pid) {
  var l = new List<IntPtr>();
  EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
  return l;
}
public static IntPtr Main(int pid) {
  foreach (var h in Tops(pid)) if (Cls(h) == "#32770" && GetDlgItem(h, 3) != IntPtr.Zero) return h;
  return IntPtr.Zero;
}
public static string Dump(int pid) {
  var sb = new StringBuilder();
  foreach (var t in Tops(pid)) {
    sb.Append("[" + Cls(t) + " '" + Text(t) + "']");
    EnumChildWindows(t, (h, x) => { if (IsWindowVisible(h)) { var tx = Text(h); if (tx.Length > 0) sb.Append(" | " + tx.Replace("\r", " ").Replace("\n", " ")); } return true; }, IntPtr.Zero);
    sb.Append(" ;; ");
  }
  return sb.ToString();
}
public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
'@
    function Window { $h = [Ci.Win]::Main($p.Id); if ($h -eq [IntPtr]::Zero) { $null } else { $h } }
    function Button($w, $id) { if (-not $w) { return $null }; $b = [Ci.Win]::GetDlgItem($w, $id); if ($b -eq [IntPtr]::Zero) { $null } else { $b } }
    function Enabled($b) { $b -and [Ci.Win]::IsWindowEnabled($b) }
    function Press($b) { [Ci.Win]::Click($b) }
    function Texts { [Ci.Win]::Dump($p.Id) }
    Check 'the setup window appears' (Wait-Until { $null -ne (Window) } 60)
    # the mutex: a second setup (what the 1.x panel's install on quit would start) exits at once
    $second = Run-Installer $setupA @('--updated', '/S') 60
    $script:result.secondSetup = $second
    Check 'a second setup exits 5 at once (mutex)' ($second.code -eq 5) "exit $($second.code) after $($second.seconds) s"
    # Next through the welcome page until the stopping page shows
    $script:result.pageTrail = @()
    $onStopping = Wait-Until {
      $w = Window
      if (-not $w) { return $false }
      $t = Texts
      if ($script:result.pageTrail -notcontains $t) { $script:result.pageTrail += , $t }
      if ($t -match 'Stopping servers|Looking for running servers|good') { return $true }
      $n = Button $w 1
      if (Enabled $n) { Press $n; Start-Sleep -Milliseconds 700 }
      $false
    } 90
    $script:result.pageTexts = Texts
    Check 'the stopping page appears' $onStopping
    Check 'good is stopped by the page' (Wait-Until { -not (Pid-Alive $goodJava) } 120)
    Check-Graceful $dataRoot 'good' $goodJava
    Start-Sleep -Seconds 2
    $script:result.pageTextsDuringStop = Texts
    $cancel = Button (Window) 2
    Check 'Cancel is enabled during the stop' (Enabled $cancel)
    Press $cancel
    Check 'the setup ends after Cancel' ($p.WaitForExit(180000))
    $script:result.cancelExit = $p.ExitCode
    Check 'exit code 4 after Cancel' ($p.ExitCode -eq 4) "exit $($p.ExitCode)"
    Check '1.x intact' ((Test-Path "$inst\resources\app.asar") -and (Reg $uninstKey 'DisplayVersion') -eq $v1)
    $l = List1
    Check 'good runs again under 1.x' ($l['good'].status -eq 'running' -and (State $dataRoot 'good').daemonExe -like '*SpawnLoft*') "$($l['good'].status)"
    Check 'slow was never stopped' ($l['slow'].status -eq 'running' -and -not (Test-Path (Join-Path $seed.servers.slow 'fake-exit.json')))
    Check 'a cancel leaves no blocked marker' (-not (Test-Path (Join-Path $dataRoot 'run\handover-blocked.json')))
    Check 'tasks folder not left disabled' (@(Tasks-Under-Mcctl | Where-Object { $_.State -eq 'Disabled' }).Count -eq 0)

    # with the 1.x panel open: the update closes it and goes through
    # slow is still holding the stop it was sent; let it finish, then start it again under 1.x
    Remove-Item (Join-Path $seed.servers.slow 'ignore-stop')
    Check 'slow finishes the stop it held' (Wait-Until { (List1)['slow'].status -ne 'running' } 60) "$((List1)['slow'].status)"
    Cli1 @('start', 'slow', '--detach') | Out-Null
    Check 'slow runs again under 1.x' (Wait-Until { (List1)['slow'].status -eq 'running' } 90)
    # the app as a user starts it: no ELECTRON_RUN_AS_NODE, Electron's own log on stderr
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null)
    $script:result.panelEnvRunAsNode = "$env:ELECTRON_RUN_AS_NODE"
    $script:result.panelEnvSeen = @(foreach ($scope in 'Process', 'User', 'Machine') {
      $vars = [Environment]::GetEnvironmentVariables($scope)
      foreach ($k in $vars.Keys) { if ("$k" -match 'ELECTRON|^NODE_') { "$scope $k=$($vars[$k])" } }
    })
    # started from a direct launch it ran as Node (Electron saw ELECTRON_RUN_AS_NODE from somewhere):
    # start it the way a user does, through the shell, which gives it the session's environment
    $pOut = Join-Path $env:RUNNER_TEMP 'panel-out.txt'; $pErr = Join-Path $env:RUNNER_TEMP 'panel-err.txt'
    Set-Content $pOut ''; Set-Content $pErr ''
    $panel = Start-Process "$env:WINDIR\explorer.exe" -ArgumentList "`"$inst\SpawnLoft.exe`"" -PassThru
    # the panel is an app window, whichever SpawnLoft.exe process shows it (Electron may hand
    # over to another process of its own)
    $panelOpen = Wait-Until { @(Get-Process SpawnLoft -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0 } 45
    $panelPids = @(Get-Process SpawnLoft -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { Proc-Key $_.Id })
    $script:result.panelProcesses = @(Get-Process SpawnLoft -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) window=$($_.MainWindowHandle) '$($_.MainWindowTitle)'" })
    $script:result.panelFirstExited = $panel.HasExited
    if ($panel.HasExited) { $script:result.panelFirstExit = $panel.ExitCode }
    $script:result.panelStdout = "$(Get-Content $pOut -Raw -ErrorAction SilentlyContinue)"
    $script:result.panelStderr = "$(Get-Content $pErr -Raw -ErrorAction SilentlyContinue)" -replace '(?s)^(.{0,6000}).*$', '$1'
    $script:result.spawnloftCommandLines = @(Get-CimInstance Win32_Process -Filter "Name='SpawnLoft.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" })
    Check 'the 1.x panel is open' $panelOpen
    $run = Run-Installer $setupA @('--updated', '/S') 600
    $script:result.withPanel = $run
    Check 'the update goes through with the panel open' ($run.code -eq 0) "exit $($run.code)"
    Check 'the 1.x panel was closed' (@($panelPids | Where-Object { Pid-Alive $_ }).Count -eq 0) "$($panelPids -join ',')"
    Check-Layout2
    $l2 = Status2
    Check 'both servers run under 2.0' ($l2['good'].status -eq 'running' -and $l2['slow'].status -eq 'running') "$($l2['good'].status) / $($l2['slow'].status)"
  }

  's5' {
    Start-Scenario 's5-2x-update-with-a-rust-daemon'
    $run = Run-Installer $setupA @('/S') 300
    Check "2.x a installs (exit 0)" ($run.code -eq 0) "exit $($run.code)"
    Kill-Everything
    $dataRoot = Use-Layout 'new'
    # a server made by 2.0 (its registry, through the machine's Node)
    $spec = @{ servers = @(@{ name = 'live' }); databases = @(); fixtures = $fixtures } | ConvertTo-Json -Depth 4
    Set-Content (Join-Path $env:RUNNER_TEMP 'seed2.json') $spec
    $r = Run-Captured $nodeExe @("$PSScriptRoot\seed-1x.mjs", "$inst\resources\core", (Join-Path $env:RUNNER_TEMP 'seed2.json')) 120
    Check 'seeded through 2.0' ($r.code -eq 0) "$($r.out)$($r.err)"
    $seed = ($r.out.Trim() -split "`n")[-1] | ConvertFrom-Json
    Cli2 @('task', 'add', 'live', '--do', 'backup', '--daily', '03:00') | Out-Null
    Cli2 @('start', 'live', '--detach') | Out-Null
    Check 'live runs' (Wait-Until { (Status2)['live'].status -eq 'running' } 90)
    $st = Check-Rust-Daemon $dataRoot 'live'
    $daemon = [int] $st.daemonPid; $java = [int] $st.javaPid

    # what 1.x's and 2.0's readers would see, for the daemon and for two renamed copies of a
    # running exe (a new name, and the same name in a folder), before and after the rename
    function Probe([int] $id) {
      $w = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
      $t = (tasklist /FI "PID eq $id" /FO CSV /NH | ConvertFrom-Csv -Header 'Image', 'Pid', 'Session', 'SessionNo', 'Mem')
      $q = (Core @('probe-process', "$id") -AllowFail).out | ConvertFrom-Json
      [ordered]@{ wmiName = $w.Name; wmiPath = $w.ExecutablePath; tasklist = $t.Image; queryFullProcessImageName = $q.image; alive = $q.alive; startTime = $q.startTime }
    }
    $probeDir = Join-Path $env:RUNNER_TEMP 'probe'
    New-Item -ItemType Directory -Force "$probeDir\a", "$probeDir\b" | Out-Null
    Copy-Item "$env:WINDIR\System32\PING.EXE" "$probeDir\a\spawnloft-core.exe"
    Copy-Item "$env:WINDIR\System32\PING.EXE" "$probeDir\b\spawnloft-core.exe"
    $pa = Start-Process "$probeDir\a\spawnloft-core.exe" -ArgumentList '-n', '600', '127.0.0.1' -PassThru -WindowStyle Hidden
    $pb = Start-Process "$probeDir\b\spawnloft-core.exe" -ArgumentList '-n', '600', '127.0.0.1' -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    $probe = [ordered]@{ daemonBefore = Probe $daemon; newNameBefore = Probe $pa.Id; folderBefore = Probe $pb.Id }
    Rename-Item "$probeDir\a\spawnloft-core.exe" 'spawnloft-core.old-1234.exe'
    New-Item -ItemType Directory -Force "$probeDir\b\old-20261109-000000" | Out-Null
    Move-Item "$probeDir\b\spawnloft-core.exe" "$probeDir\b\old-20261109-000000\spawnloft-core.exe"
    $probe.newNameAfter = Probe $pa.Id
    $probe.folderAfter = Probe $pb.Id

    # an MCP server running through the update holds the bundled node.exe (A6, design scenario 5)
    $mcp = Start-Mcp
    Check 'an MCP server answers before the update' ((Mcp-Initialize $mcp).result.serverInfo.name -eq 'spawnloft')
    $mcpNode = @(Node-Children $mcp.Id)[0]
    Check '  on the bundled Node' ($mcpNode -and $mcpNode.ExecutablePath -like "$inst\resources\runtime\node-*\node.exe") "$($mcpNode.ExecutablePath)"

    $run = Run-Installer $setupB @('/P', '/UPDATE', '/R') 600
    $script:result.update = $run
    Check '2.x a -> b exit 0' ($run.code -eq 0) "exit $($run.code)"
    Check 'b is installed' ((Reg $uninstKey 'DisplayVersion') -eq $VersionB) (Reg $uninstKey 'DisplayVersion')
    $old = @(Get-ChildItem "$inst\resources\bin" -Directory -Filter 'old-*')
    Check 'the held core sits in resources\bin\old-<stamp>\spawnloft-core.exe' ($old.Count -eq 1 -and (Test-Path (Join-Path $old[0].FullName 'spawnloft-core.exe'))) "$($old.Name)"
    Check 'its stamp is old-yyyymmdd-hhmmss' ($old[0].Name -match '^old-\d{8}-\d{6}(-\d+)?$') $old[0].Name
    Check 'the daemon survived' (Pid-Alive $daemon)
    Check 'the JVM survived' (Pid-Alive $java)
    Check 'status says running through the update' ((Status2)['live'].status -eq 'running')
    $heldNode = @(Get-ChildItem "$inst\resources\runtime" -Directory -Filter 'old-*')
    Check 'the held node.exe sits in resources\runtime\old-<stamp>\node.exe' ($heldNode.Count -eq 1 -and (Test-Path (Join-Path $heldNode[0].FullName 'node.exe'))) "$($heldNode.Name)"
    $rt = Read-Json "$inst\resources\runtime\runtime.json"
    Check 'and the new one is in place' (Test-Path (Join-Path "$inst\resources\runtime" $rt.exe))
    $tools = Mcp-Call $mcp 2 'tools/list'
    Check 'the MCP server still answers after the update' (@($tools.result.tools).Count -gt 0) "$($tools | ConvertTo-Json -Compress -Depth 3)"
    # a killed forwarder takes its Node with it (the kill-on-close job, A6)
    $mcpNodePid = Proc-Key $mcpNode.ProcessId
    Stop-Process -Id $mcp.Id -Force
    Check 'killing spawnloft-core mcp ends its Node too' (Wait-Until { -not (Pid-Alive $mcpNodePid) } 30) "node $mcpNodePid"
    # a 2.x update runs no repair itself; the app's first start (or this) writes the record
    Cli2 @('repair', '--json') | Out-Null
    Check-Entry-Point $dataRoot
    $probe.daemonAfterUpdate = Probe $daemon
    $script:result.probe = $probe
    Stop-Process -Id $pa.Id, $pb.Id -Force -ErrorAction SilentlyContinue

    Cli2 @('stop', 'live') | Out-Null
    Check 'the old JVM stopped gracefully' (Test-Path (Join-Path $seed.servers.live 'fake-exit.json'))
    Cli2 @('start', 'live', '--detach') | Out-Null
    Check 'live runs again' (Wait-Until { (Status2)['live'].status -eq 'running' } 90)
    $st2 = Check-Rust-Daemon $dataRoot 'live'
    $img = ((Core @('probe-process', "$($st2.daemonPid)")).out | ConvertFrom-Json).image
    Check 'and its daemon is the new core' ($img -eq "$inst\resources\bin\spawnloft-core.exe") $img
    Cli2 @('stop', 'live') | Out-Null
    Check 'the old daemon is gone' (Wait-Until { -not (Pid-Alive $daemon) } 30)
    $run = Run-Installer $setupB @('/P', '/UPDATE') 600
    Check 'the next install (b again) exit 0' ($run.code -eq 0) "exit $($run.code)"
    Check 'and it removed the old-<stamp> folder' (@(Get-ChildItem "$inst\resources\bin" -Directory -Filter 'old-*').Count -eq 0)
    Check 'and the old node.exe folder' (@(Get-ChildItem "$inst\resources\runtime" -Directory -Filter 'old-*').Count -eq 0)
  }

  's8' {
    Start-Scenario 's8-uninstall-and-rollback-to-1x'
    $run = Run-Installer $setupA @('/S') 300
    Check '2.x installs (exit 0)' ($run.code -eq 0) "exit $($run.code)"
    # the install puts resources\bin on the user PATH (user_path.rs), once
    Check '  resources\bin on the user PATH once' ((User-Path-Count "$inst\resources\bin") -eq 1) (Reg 'HKCU:\Environment' 'Path')
    # from a folder of its own: cmd.exe looks in the current folder before PATH, and the checkout's
    # root holds the source tree's spawnloft.cmd (which runs a node from PATH)
    Push-Location $env:RUNNER_TEMP
    try {
      $r = Run-Captured "$env:WINDIR\System32\cmd.exe" @('/d', '/c', 'spawnloft', '--version') 60 @{ PATH = "$([Environment]::ExpandEnvironmentVariables((Reg 'HKCU:\Environment' 'Path')));$env:WINDIR\System32" }
    } finally { Pop-Location }
    Check '  a new terminal finds spawnloft' ($r.code -eq 0 -and $r.out -match 'spawnloft-core') "$($r.code) $($r.out)$($r.err)"
    Kill-Everything
    $dataRoot = Use-Layout 'new'
    $spec = @{ servers = @(@{ name = 'keep' }); databases = @(); fixtures = $fixtures } | ConvertTo-Json -Depth 4
    Set-Content (Join-Path $env:RUNNER_TEMP 'seed2.json') $spec
    $r = Run-Captured $nodeExe @("$PSScriptRoot\seed-1x.mjs", "$inst\resources\core", (Join-Path $env:RUNNER_TEMP 'seed2.json')) 120
    Check 'seeded through 2.0' ($r.code -eq 0) "$($r.out)$($r.err)"
    $seed = ($r.out.Trim() -split "`n")[-1] | ConvertFrom-Json
    Cli2 @('task', 'add', 'keep', '--do', 'backup', '--daily', '03:00') | Out-Null
    Check 'a task is registered' (@(Tasks-Under-Mcctl).Count -eq 1)
    Cli2 @('start', 'keep', '--detach') | Out-Null
    Check 'keep runs' (Wait-Until { (Status2)['keep'].status -eq 'running' } 90)

    # /UPDATE uninstall: servers, tasks and data stay
    $p = Run "$inst\uninstall.exe" @('/S', '/UPDATE', "_?=$inst") 300
    Check '/UPDATE uninstall exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Check '  task kept' (@(Tasks-Under-Mcctl).Count -eq 1)
    Check '  user PATH entry kept' ((User-Path-Count "$inst\resources\bin") -eq 1)
    Check '  data kept' (Test-Path (Join-Path $dataRoot 'instances.json'))
    # the program files are gone until the reinstall, so ask the process table, not a CLI
    $st = State $dataRoot 'keep'
    Check '  server still running (daemon and JVM alive)' ((Pid-Alive $st.daemonPid) -and (Pid-Alive $st.javaPid))
    $run = Run-Installer $setupA @('/S') 300
    Check 'reinstall exit 0' ($run.code -eq 0) "exit $($run.code)"
    Check '  still one user PATH entry' ((User-Path-Count "$inst\resources\bin") -eq 1)
    # only the shell: keep's daemon is a spawnloft-core.exe and must live to be stopped below
    Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # a 1.x installer over 2.0 (rollback), servers stopped first
    Cli2 @('stop', 'keep') | Out-Null
    $p = Run $Beta @('/S') 600
    Check '1.x over 2.0 exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Check '  1.x installed' ((Test-Path "$inst\resources\app.asar") -and (Reg $uninstKey 'DisplayVersion') -like '1.*') (Reg $uninstKey 'DisplayVersion')
    Check '  2.0 uninstaller gone' (-not (Test-Path "$inst\uninstall.exe"))
    Check '  task kept' (@(Tasks-Under-Mcctl).Count -eq 1)
    Check '  data kept' (Test-Path (Join-Path $dataRoot 'instances.json'))
    Get-Process SpawnLoft -ErrorAction SilentlyContinue | Stop-Process -Force
    # 1.x has no repair command: its repairAfterMove runs when the app starts (design 5.6)
    $app = Start-Process "$inst\SpawnLoft.exe" -PassThru
    $shimFixed = Wait-Until { $t = Get-Content (Join-Path $dataRoot 'tasks\*.cmd') -Raw; $t -match 'SpawnLoft\.exe' -and $t -match 'ELECTRON_RUN_AS_NODE' } 90
    $shim = Get-Content (Join-Path $dataRoot 'tasks\*.cmd') -Raw
    Check "  1.x's first start rewrote the shim for SpawnLoft.exe" $shimFixed $shim
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    Get-Process SpawnLoft -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$inst\SpawnLoft.exe" -and $_.MainWindowHandle -ne 0 } | Stop-Process -Force -ErrorAction SilentlyContinue
    Cli1 @('start', 'keep', '--detach') | Out-Null
    Check '  1.x starts the server' (Wait-Until { (List1)['keep'].status -eq 'running' } 90)
    Cli1 @('stop', 'keep') | Out-Null

    # a 1.x uninstall key with no DisplayVersion, then 2.0 over it
    Remove-ItemProperty -Path $uninstKey -Name 'DisplayVersion'
    $run = Run-Installer $setupA @('--updated', '/S') 600
    Check '2.0 over a 1.x key with no DisplayVersion exit 0' ($run.code -eq 0) "exit $($run.code)"
    $rec = Record $dataRoot
    $script:result.recordNoDisplayVersion = $rec
    Check '  the record names 1.x by its package.json' ("$($rec.from)" -like '1.*') "from $($rec.from)"
    Kill-Everything

    # uninstall without data: servers stopped, tasks removed, data kept
    Cli2 @('start', 'keep', '--detach') | Out-Null
    Check 'keep runs under 2.0' (Wait-Until { (Status2)['keep'].status -eq 'running' } 90)
    $p = Run "$inst\uninstall.exe" @('/S', "_?=$inst") 300
    Check 'uninstall exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Remove-Item -Force "$inst\uninstall.exe" -ErrorAction SilentlyContinue
    Check '  SpawnLoft.exe removed' (-not (Test-Path "$inst\SpawnLoft.exe"))
    Check '  keys removed' (-not (Test-Path $uninstKey) -and -not (Test-Path $installKey))
    Check '  tasks removed' (@(Tasks-Under-Mcctl).Count -eq 0)
    Check '  user PATH entry removed' ((User-Path-Count "$inst\resources\bin") -eq 0) (Reg 'HKCU:\Environment' 'Path')
    Check '  the server was stopped gracefully' (Test-Path (Join-Path $seed.servers.keep 'fake-exit.json'))
    Check '  data kept' (Test-Path (Join-Path $dataRoot 'instances.json'))
    Check '  settings kept' (Test-Path (Join-Path $env:APPDATA 'spawnloft\settings.json'))

    # uninstall with data
    $run = Run-Installer $setupA @('/S') 300
    Check 'install again exit 0' ($run.code -eq 0) "exit $($run.code)"
    Kill-Everything
    $p = Run "$inst\uninstall.exe" @('/S', '/DELETEAPPDATA', "_?=$inst") 300
    Check 'uninstall with data exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Check '  data removed' (-not (Test-Path (Join-Path $dataRoot 'instances.json')))
    Check '  WebView2 profile folder removed' (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'io.github.joogiebear.mcctl')))
  }

  's9' {
    Start-Scenario 's9-electron-leftovers-cleanup'
    Install-Legacy $Beta | Out-Null
    Use-Layout 'new' | Out-Null
    $cfg = Seed-Profile
    $run = Run-Installer $setupA @('--updated', '/S') 600
    Check '2.0 installer exit 0' ($run.code -eq 0) "exit $($run.code)"
    $app = Start-Process "$inst\SpawnLoft.exe" -PassThru
    Check 'the cleanup ran at first launch' (Wait-Until { Test-Path (Join-Path $cfg 'electron-cleanup.json') } 90)
    $script:result.marker = Read-Json (Join-Path $cfg 'electron-cleanup.json')
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    Kill-Everything
    foreach ($d in 'Cache', 'Code Cache', 'GPUCache', 'Local Storage', 'Session Storage', 'Network', 'Crashpad', 'blob_storage', 'DawnGraphiteCache', 'Shared Dictionary', 'Preferences', 'Local State', 'Cookies', 'Cookies-journal', 'TransportSecurity', 'DIPS', 'LOCK', 'LOG') {
      Check "  $d removed" (-not (Test-Path -LiteralPath (Join-Path $cfg $d)))
    }
    Check '  electron-updater cache removed' (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'spawnloft-desktop-updater')))
    foreach ($k in 'window-state.json', 'launcher-window-state.json', 'ui-zoom.json', 'update-channel.json', 'settings.json', 'servers-notes') {
      Check "  $k kept" (Test-Path -LiteralPath (Join-Path $cfg $k))
    }
    $script:result.left = @(Get-ChildItem -Force $cfg | ForEach-Object { $_.Name })
  }

  default { throw "unknown scenario $Name" }
}
Finish
