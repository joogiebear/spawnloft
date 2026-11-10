# SpawnLoft 2.0: installer and updater design

2026-11-09, rev 3: Victor decided every open question by its recommendation (02:59 UTC, "I trust
recommendations"); section 13 records them as decisions. Rev 2 (rev 1 reviewed by a fresh Fable thread the same day; the twenty findings and
what changed are in section 15). Internal, `v2` branch, planning only (no code). Follows P0-F in
`PHASE0-FINDINGS.md` and PLAN-RUST-TAURI.md section 4 (which points at PLAN.md sections 6 and 7).
Where this document and those differ, this one is newer and says so. Every statement about
software outside this repository is marked **(verified)** when a Phase 0 run established it or
**(verify)** when it comes from reading code or documentation and a test must confirm it.

## 0. Summary

A person on SpawnLoft 1.5.0 (stable) or 1.6.0-beta.413 (the last beta) gets 2.0 through the
updater they already have, with servers, scheduled tasks, backups and settings intact, and the
servers that were running are running again when the update is over. From 2.0 on, updates go
through `tauri-plugin-updater` wrapped in SpawnLoft's own signed feed, never stop a server, and
can be rolled back one or more versions from the Preferences page.

The decisions, each argued in its section:

| # | Decision | Section |
| --- | --- | --- |
| D1 | The 2.0 Windows installer stops running servers **gracefully through the installed 1.x CLI** before it runs the 1.x uninstaller, driven by the new `spawnloft-core` binary extracted first. The deadline is enforced on the **CLI client**, never passed to the daemon (which would force-kill at its timeout), so no JVM is ever terminated by the update. Servers first, then databases; the task folder is disabled meanwhile. A server that will not stop in time **aborts the update**, restarts what was already stopped, and leaves 1.x in place with a marker that stops silent retries from repeating the stop (decided, Q-B). | 2.3 |
| D2 | The installer **starts the servers it stopped again**, silent or not: databases first, then servers; on the Restart path the app is launched first and the resume runs behind the first-launch banner. 2.0's first launch reports what happened and offers Start only for the ones that failed (decided, Q-A; supersedes PHASE0-FINDINGS Q14's "offer on first launch"). | 2.5, 8 |
| D3 | The running-app check matches **only the panel**, by the full path of `SpawnLoft.exe` through Restart Manager (Tauri's check, **verified** not to match the core). Daemons are never "the running app". A single-instance mutex keeps a second installer out. | 3 |
| D4 | 2.x updates **rename a held `spawnloft-core.exe` into a dated subfolder**, keeping its file name; 2.0 records the process creation time and identifies daemons by (pid, creation time) first, with the file-name rule as the fallback for old records. Which Windows APIs report a renamed image under which name **needs a test** (section 4); the folder rename is harmless either way and the creation-time identity is the real fix. | 4 |
| D5 | Updates use `tauri-plugin-updater` for download, artifact signature and install, with **SpawnLoft's signed envelope** (`spawnloft-updates.json` + minisign signature, carrying a `keyId`) fetched and verified first; the plugin's `version_comparator` **pins** what the plugin fetched to what the envelope said, and `require_signed_version` pins the artifact's signed version to it. One minisign key pair signs artifacts and envelopes; the envelope is signed with `minisign`/`rsign2` and a fixed trusted comment (`tauri signer sign` writes its own comment; **needs a test**). | 5 |
| D6 | The feed lives on **GitHub Releases only**: `releases.atom` for discovery, the envelope as a release asset. No site dependency and no new secret (differs from PLAN-RUST-TAURI Q17; decided, Q-C). | 5.2 |
| D7 | **Rollback** is "install a lower version that the verified feed lists and whose data format matches", in app, for 2.x to 2.y; the Windows template takes `/ROLLBACK` to allow that one downgrade, and the rollback is exempt from the feed-freshness rule but not from the signature checks. Nothing keeps a previous bundle or installer as the source of truth: the feed does. 2.0 to 1.x stays a manual reinstall with documented steps. | 5.6 |
| D8 | macOS: `spawnloft-core` ships in `Contents/Resources/resources/bin/` and is **signed separately** (hardened runtime, timestamp) before `tauri build`; the Squirrel.Mac zip and the Tauri `.app.tar.gz` are both made from the one notarized, stapled `.app`. | 6 |
| D9 | Windows per-user config: `%APPDATA%\SpawnLoft` and `%APPDATA%\spawnloft` are **one folder** (NTFS is case-insensitive). 2.0 treats it as its config folder, reads Electron's small JSON files in place, and deletes Electron's Chromium cache folders on first launch (allowlist). No copy, no second folder. | 7 |
| D10 | Uninstall runs `spawnloft-core uninstall --yes [--data]`, never the Node core (P0-F H3). | 9 |

## 1. What the design stands on

Facts about the installs in the field, because no 1.x release ships again (Victor, 2026-11-08):

- **1.5.0 (stable) and 1.6.0-beta.413 (last beta) behave the same on the update path.** Both set
  `autoInstallOnAppQuit = true` and `autoDownload = true`; both install on quit with `/S --updated`
  and on "Restart" with `/S --updated --force-run`. **Neither has the major-version guard**
  (`desktop/major-update.js` is not in the `v1.6.0-beta.413` tree; checked 2026-11-09), so a 1.x
  install **will** install 2.0 on quit with servers running. The guard exists only in `v2`.
- The 1.x uninstaller (electron-builder 26.15.3) **kills every process whose image is under the
  install folder** through PowerShell `Stop-Process`. Node daemons run as `SpawnLoft.exe` and
  die without saving, **and their JVMs die with them** (libuv's job object has kill-on-close;
  **verified**, P0-E 4a: daemon and java gone within 0.6 s). A Rust daemon's JVM would instead be
  orphaned. So the stop must happen before that uninstaller runs.
- The 1.x daemon's `stop` op force-kills the JVM when the timeout it was given elapses
  (`daemon.mjs handleStop`: `forceKill()` after `waitForExit(timeoutMs)`, reported as
  `{ ok: true, forced: true }`), and the 1.x CLI then prints "was killed" and exits 0. So a
  deadline must never be passed to the daemon as the stop timeout (section 2.3.1).
- 1.x `supervisor.stop` refuses an `orphaned` server (java alive, daemon dead) and points at
  `spawnloft kill`; the orphaned JVM is outside the install folder and the 1.x uninstaller does
  not touch it.
- 1.x's `customUnInstall` honours `--updated` on 1.4.0 through 1.6.0-beta.413 (**verified** by
  reading `desktop/build/installer.nsh` at `v1.5.0`; the macro is unchanged since).
- The 1.x `stop` command takes one server name and `--timeout <sec>` (default 90) and has no
  `--all` (PHASE0-FINDINGS' `stop --all --json` does not exist; corrected here). `status <name>
  --json` exists.
- 1.x Windows installs are per-user, no elevation, `%LOCALAPPDATA%\Programs\SpawnLoft`,
  uninstall key `HKCU\...\Uninstall\bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3`, install key
  `HKCU\Software\bd3d287b-...` with `InstallLocation`, publisher CN "victor zemeckis"
  (**verified**, P0-F).
- The spike template (`rust/crates/spawnloft-shell/windows/installer.nsi`) already: installs into
  the 1.x folder and keys, accepts both argument sets, runs the 1.x uninstaller with
  `/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=<dir>` and checks `app.asar` is
  gone, keeps shortcuts, uses Tauri's Restart Manager running-app check, renames a held core
  aside, keeps the "also delete your data?" question (**verified** end to end on CI and on
  Victor's PC, signed, with a task surviving).
- Squirrel.Mac accepts the notarized Tauri `.app` with the same bundle id and Team ID
  (**verified**, Mac mini). Tauri does not sign a binary shipped as a resource (**verified**:
  notarization refused the first run).
- `tauri-plugin-updater` 2.14.1 with the custom template: check, download, artifact signature
  check, `/P /UPDATE /R`, relaunch all work; a wrong artifact signature is refused; the
  download-finished callback fires before verification (**verified**).
- Rust daemons and their JVMs survive the 1.x installer and keep supervising from a renamed
  binary (**verified**, P0-E Rust runs). electron-updater on Windows runs the installer only after
  an Authenticode check against `publisherName` (**verified**, signed PC run).
- Data layout: settings at `%APPDATA%\spawnloft\settings.json` (new installs since the rename) or
  `%APPDATA%\mcctl\settings.json` (older); Electron userData at `%APPDATA%\SpawnLoft`; default
  data root `%LOCALAPPDATA%\spawnloft` or `mcctl`; `run/<name>/state.json` holds `daemonPid`,
  `daemonExe` (basename), `javaPid`, `startedAt` (wall clock of the start) and `status`.
  `uninstall --data` already claims Electron's `SpawnLoft` and `mcctl-desktop` folders when they
  hold `window-state.json` (`src/uninstall.mjs`).

## 2. Windows: the 2.0 installer

The forked Tauri NSIS template, per-user, no elevation, `installMode: currentUser`, installer
and uninstaller Authenticode-signed with the release profile (Tauri `bundle.windows.signCommand`
and the template's `UNINSTALLERSIGNCOMMAND`, both pointing at the Azure Trusted Signing step).

### 2.1 Modes and arguments

| Who runs it | Arguments | Behaviour |
| --- | --- | --- |
| 1.x electron-updater, "Restart to update" | `--updated /S --force-run` | silent handover, start `SpawnLoft.exe` after |
| 1.x electron-updater, install on quit | `--updated /S` | silent handover, no launch |
| 2.x updater (plugin), interactive | `/P /UPDATE /R` (+ `/ARGS`) | passive UI, no questions, relaunch |
| 2.x updater, install on quit | `/S /UPDATE` | silent, no relaunch |
| 2.x rollback | `/P /UPDATE /R /ROLLBACK` | as above, downgrade allowed once |
| a person, double-click | none | full UI; over 1.x: welcome, a "stopping servers" page, install, finish |
| a person, `/S` | `/S` | silent; over 1.x behaves like the handover |

`--updated` and `--force-run` are read from the parameters only (spike fix). `/ROLLBACK` is a
SpawnLoft addition (section 5.6). Downgrades without it keep aborting in silent and passive
mode, as Tauri's template does.

### 2.2 Detecting 1.x

`$INSTDIR\Uninstall SpawnLoft.exe` exists means 1.x (`LegacyMode`), as the spike does; 2.x never
ships a file by that name. The 1.x version is read from the uninstall key's `DisplayVersion`
(format "1.6.0-beta.413"; the DisplayName is "SpawnLoft <version>" on 1.x) and from
`resources\core\package.json` as a cross-check, and recorded in the handover record (section 2.4).

### 2.3 The handover sequence (LegacyMode)

```
.onInit        single-instance mutex (abort if another SpawnLoft setup runs); read mode flags;
               find 1.x; refuse downgrade unless /ROLLBACK
Install
  1. extract the new spawnloft-core.exe to $INSTDIR\resources\bin\staging\ (a per-user folder
     no AppLocker/SRP rule treats as temp); fall back to $PLUGINSDIR if that fails
  2. handover stop   : staging\spawnloft-core.exe handover stop
                          --legacy-dir "$INSTDIR" --legacy-version <1.x version>
                          --deadline 300 --log <data root>\run\handover.log [--silent]
                       exit 0  -> nothing was running, or everything stopped (orphans noted)
                       exit 3  -> a server is still running; what was stopped is running again,
                                  the blocked marker is written                 -> ABORT (2.3.3)
                       exit 2  -> internal error (could not run the 1.x CLI at all) -> ABORT
  3. RemoveLegacyInstall : 1.x's uninstaller, /S /KEEP_APP_DATA /currentuser
                           --keep-shortcuts --updated _?=$INSTDIR, retried, app.asar must be gone
                           (it force-closes the 1.x panel, MCP servers and bot host, by design)
  4. CheckIfAppIsRunning "$INSTDIR\SpawnLoft.exe"   (nothing left by now; harmless)
  5. move a held resources\bin\spawnloft-core.exe aside (section 4; none in the handover)
  6. File ...        : shell, core, resources (panel assets, bot host, forwarders); remove staging\
  7. registry, shortcuts (kept), AppUserModelId, uninstall key with the new version
  8. repair          : "$INSTDIR\resources\bin\spawnloft-core.exe" repair --quiet
                       (task shims and server launchers now name spawnloft-core.exe)
  9. with --force-run or /R : start SpawnLoft.exe as the user; the shell runs
                       `handover resume` itself behind the first-launch banner (section 8)
     without         : "$INSTDIR\resources\bin\spawnloft-core.exe" handover resume
                       (databases, then servers; records per-server results; re-enables tasks)
```

Steps 1, 2, 8 and 9 and the mutex are what this design adds to the spike. Step order matters:
the stop must come before the 1.x uninstaller (which would kill), repair before resume (so a
server launcher a daemon writes is already the new text), resume after the files are in place
(the daemons start from the new core), and on the Restart path the window before the resume,
or "Restart to update" would show nothing for minutes while large servers come up (review
item 16).

**2.3.1 `handover stop`, a `spawnloft-core` command.** Runs from the staging folder with no
install of its own. It:

1. Resolves roots exactly as 1.x does: `SPAWNLOFT_DATA_ROOT`/`MCCTL_DATA_ROOT` if set in the
   user's environment, else `settings.json` (`spawnloft/` then `mcctl/`), else the default data
   root (`spawnloft/` then `mcctl/`). It reads 1.x's `instances.json` and `services` registry and
   every `run/<name>/state.json` through the lenient readers the contract fixtures (P0-A) test.
   If the data root is unreadable (an unplugged drive), no 1.x daemon can be running from it;
   it confirms with one read-only process query (no `SpawnLoft.exe` with `daemon.mjs` on its
   command line), records `dataRoot: unreadable`, and exits 0.
2. **Disables the `\mcctl` Task Scheduler folder** (`schtasks /Change /DISABLE` per task,
   remembering which were enabled) so a `restart`, `start` or `steps` task cannot start a 1.x
   daemon during the minutes that follow; `handover resume` re-enables them, and so does the
   abort path.
3. Lists what is active: status in the active set and `daemonPid` or `javaPid` alive. Databases
   count too (their daemons are the same `SpawnLoft.exe` processes). An `orphaned` server (java
   alive, no daemon) is **recorded, not stopped, and does not block**: 1.x itself refuses to
   stop it, its JVM is not under the install folder, and 2.0's first launch shows it with the
   `kill` offer (section 8).
4. Stops them **in dependency order: servers first, then databases** (a server stopped after
   its database loses it mid-save), four at a time within a tier, through the **installed 1.x
   CLI**: `"<legacy-dir>\SpawnLoft.exe" "<legacy-dir>\resources\core\mcctl.mjs" stop <name>
   --timeout 2000000` with `ELECTRON_RUN_AS_NODE=1`, stdout and stderr to the log. The 1.x CLI
   speaks its own pipe protocol and does the console `stop`, the save wait and the state update,
   so nothing is reimplemented against a daemon this binary never ships with. **The timeout
   given to the CLI is deliberately enormous** (seconds; it becomes the daemon's `waitForExit`
   bound, after which 1.x force-kills the JVM): the deadline (default 300 s, `--deadline`) is
   enforced by `handover stop` on the **CLI client process**, which it terminates when the
   deadline passes. The daemon then stays in its "stop sent" state and the server keeps saving
   and exits on its own; nothing is killed. 300 s is long enough for a large world's save and
   short enough that an install-on-quit does not look hung (Q-H).
5. If the CLI is missing or exits non-zero without the server having stopped: falls back to its
   own client on the 1.x pipe (`\\.\pipe\mcctl-<name>`, the `stop` op with the same enormous
   timeout), **after** checking that the pipe's server process is `state.json`'s `daemonPid`
   (`GetNamedPipeServerProcessId`): the 1.x pipe name is machine-global and another user's
   server of the same name could be listening. Then waits for `javaPid` to exit within the
   deadline. **It never calls `TerminateProcess` on a JVM or a daemon.**
6. Re-reads the active set once more; anything that appeared (a task that fired before the
   disable landed) is stopped the same way, within the same deadline.
7. Writes the handover record (2.4) and exits 0, 3 or 2 as above. On 3 it first **starts again,
   through the 1.x CLI (`start <name> --detach`), every server and database it had stopped**,
   databases first, re-enables the tasks, and writes `run/handover-blocked.json`
   `{ "blockedBy": ["survival"], "at": ..., "attempts": 1 }`.

A `SpawnLoft.exe` panel still running (someone double-clicked the installer with the panel
open) is not this command's business: the 1.x uninstaller's own check **force-closes** it, in
silent and UI mode alike (review item 10; the earlier "UI mode asks" was wrong). The bot host
(Node, outside the install folder) and `spawnloft mcp` processes (SpawnLoft.exe as Node) are
closed the same way; they reconnect on their own (MCP clients restart the server on the next
call). Closing the 1.x panel gracefully is avoided on purpose: its install-on-quit would start
the pending 2.0 setup a second time; the mutex in `.onInit` makes that second setup exit at once
in any case.

**2.3.2 The interactive page.** In UI mode over 1.x, the installer shows one custom page,
"Stopping servers for the update", listing the active servers with a progress line each, fed
from the log file, with Cancel (runs the abort path: stopped servers restarted, 1.x untouched).
The silent modes skip it. UI mode ignores the blocked marker.

**2.3.3 Abort policy.** Exit 3 from `handover stop`: the installer writes nothing, leaves 1.x
exactly as it was (its servers running again), and exits with error level 4 (silent) or shows
"survival is still running and could not be stopped in 5 minutes; stop it and run the update
again" (UI). electron-updater reports an error to the 1.x panel ("Update failed"; the 1.x text
cannot be changed) and **reruns the pending installer at every quit and after every six-hour
check**. Without a guard that would stop and restart every server again each time (review
item 2), so `handover stop` in silent mode reads `handover-blocked.json` first and, while the
named server is still active and the marker is younger than 24 hours, exits 3 **before stopping
anything**, incrementing `attempts`; once that server is gone or stopped, or after 24 hours, the
full stop runs again. UI mode (the person is there) always runs the full stop. Exit 2 (the 1.x
CLI cannot be run at all) aborts the same way without a marker. Nothing is lost and nothing is
killed. Victor decides whether a server that does not stop within the deadline should instead
be killed so the update always goes through (Q-B); this design recommends not.

**2.3.4 Why the stop is not done by the shell or by Node 2.0 code.** No 1.x release ships again,
so the stop has to live in the 2.0 installer; the 2.0 core is the only binary in the installer
that can read the data folder, and the installed 1.x CLI is the only client guaranteed to match
the running 1.x daemons. NSIS itself only orchestrates and shows progress.

**2.3.5 Trust boundary.** The install is per-user with no elevation: the staging folder, the
handover record, the blocked marker and the `old-<stamp>` folders all sit inside the same
user's profile, written and read by that user's processes. There is no privilege boundary
for another process on the machine to cross, and nothing the installer runs comes from outside
its own signed payload except the installed 1.x CLI, which the same user installed.

### 2.4 The handover record

`<data root>/run/handover.json`, written by `handover stop`, completed by `handover resume`,
read by the first launch (section 8) and by `doctor`, deleted once the person has seen it:

```json
{
  "format": 1,
  "from": "1.6.0-beta.413",
  "to": "2.0.0",
  "startedAt": "2026-12-01T20:14:03Z",
  "mode": "silent",
  "servers": [
    { "name": "survival", "kind": "server", "stop": "stopped", "stopMs": 8400, "start": "running" },
    { "name": "creative", "kind": "server", "stop": "stopped", "stopMs": 2100, "start": "failed", "error": "..." },
    { "name": "mysql-main", "kind": "database", "stop": "stopped", "start": "running" }
  ],
  "stopExit": 0,
  "resumeExit": 0
}
```

`stop` is one of `stopped`, `was-stopped` (it exited while we looked), `still-running`,
`orphaned` (left alone), `failed`; `start` one of `running`, `failed`, `skipped` (resume not run:
`/NORESUME`), `restored-1x` (the abort path started it again under 1.x). The record also lists
the tasks it disabled (`tasksDisabled`) so resume and abort re-enable exactly those. The log
beside it, `run/handover.log`, keeps the 1.x CLI output.

### 2.5 `handover resume`

Starts, through the new core's own supervisor, every entry whose `stop` is `stopped` or
`was-stopped` and whose registry entry still exists, **databases first** (wait for `ready`),
then servers, four at a time within a tier, `ready` up to 180 s each, records `start`,
re-enables the disabled tasks, and exits 0 whatever happened (a failed start is reported, not
an installer error: the install is done). It runs under a lock file (`run/handover.lock`) so
two callers cannot double-start. The daemons it starts are detached from whoever called it the
way every daemon start is (new process group, no inherited handles, not in the caller's job).
Resume runs in **every** mode, including the 1.x install-on-quit path that launches no app,
because that is the path where nobody is there to press Start (D2). `/NORESUME` turns it off
for tests and for Victor if Q-A goes the other way.

Who may call it: the installer (no-launch path), the shell's first run after the handover
(Restart path, behind the banner), and `spawnloft doctor --fix` when a record has `skipped`
entries younger than 24 hours. **Never** an ordinary CLI command or a task run (review item 11:
a `spawnloft list` from a task must not start servers).

### 2.6 Registry, shortcuts, WebView2, signing

As the spike: same folder, same uninstall and install keys with 1.x's value names plus
`SpawnLoftShell=tauri`, `KeepShortcuts`, shortcuts kept (same path, same AppUserModelId
`io.github.joogiebear.mcctl`), `DisplayName "SpawnLoft"`. WebView2: `downloadBootstrapper`,
silent; if the bootstrapper fails (offline install), the install still completes and the shell
shows "SpawnLoft needs Microsoft Edge WebView2" with the Evergreen link on first start; the CLI,
daemons and MCP work without it. Signing: `SpawnLoft.exe`, `spawnloft-core.exe`, `uninstall.exe`
and the setup exe all carry the release signature (CN "victor zemeckis"); `verify-build` asserts
the CN on all four because the 1.x publisher check reads the setup's and users read the rest.

## 3. The running-app check

Tauri's `CheckIfAppIsRunning "$INSTDIR\SpawnLoft.exe"` registers that one file with Restart
Manager and acts on the processes holding it: silent and passive modes shut them down
(`RmShutdown` with force), UI mode asks, and a failure aborts (**verified** from the
tauri-bundler 2.10.4 `utils.nsh` source by the review; **verified** on the spike that
`spawnloft-core.exe` daemons are not matched, P0-F). This is "matching only the panel" (D3) and
replaces electron-builder's path-prefix sweep for good: nothing in the 2.x installer or
uninstaller enumerates processes under the folder. Tauri's template has no single-instance
guard (electron-builder's has), so the fork adds a named mutex in `.onInit` and `un.onInit`: a
second setup or uninstaller exits at once with error level 5.

Two processes other than the panel can hold `SpawnLoft.exe`:

- **argv-compatibility forwarders** (`SpawnLoft.exe <...>\mcctl.mjs task run <id>` from a 1.x
  task shim that has not been rewritten yet, or an MCP config). Closing one mid-run is
  acceptable: the task re-runs at its next trigger, the MCP client reconnects. Repair (step 8)
  rewrites every shim and launcher to `spawnloft-core.exe` right after the handover, so from the
  first 2.x update on, only MCP configs written by hand still go through the forwarder. The
  forwarder puts its child (the core) in a job object with kill-on-close so a closed forwarder
  does not orphan a core process (P0-F M3/L4).
- **the shell's own `spawnloft-core ui` child** exits when the shell's stdin pipe closes, and the
  updater's `on_before_exit` stops it first (**verified**).

The 1.x direction (a 1.x installer run over 2.0, section 5.6) still uses electron-builder's
sweep and will kill Rust daemons; the release notes say to stop servers before rolling back.

## 4. 2.x updates while daemons run

Rust daemons keep running through an update (D4). The template's handling of a held core:

```
Delete  resources\bin\spawnloft-core.exe
if that fails (in use):
  CreateDirectory resources\bin\old-<yyyymmdd-hhmmss>\
  Rename resources\bin\spawnloft-core.exe -> resources\bin\old-<stamp>\spawnloft-core.exe
  if that fails: abort (exit 2) "spawnloft-core.exe is in use and could not be moved aside"
File    resources\bin\spawnloft-core.exe (new)
```

and at the start of every install and in the uninstaller: `RMDir /r` every `old-*` folder whose
binary is no longer held (Delete fails silently on a held file; the folder stays).

**Why a folder, not `spawnloft-core.old-<tick>.exe`, and what is not yet known.** Both 1.x's
`sameProcess` and the Rust daemon's identity check compare the **basename** recorded in
`state.json` (`daemonExe: "spawnloft-core.exe"`) with what the process table reports. Which
name the table reports for a renamed image depends on the API: `Win32_Process.Name`/`Path` and
`tasklist` (what 1.x reads) come from the path fixed at process creation, while
`QueryFullProcessImageName` follows the file object and shows the new name. P0-E observed the
Rust daemon running from the uninstaller's `old-install\` folder with "Windows still reports
its original path" (via WMI; the file name had not changed there either). So the spike's
`.old-<tick>.exe` rename **may** make a reader that uses `QueryFullProcessImageName` call a
live daemon `stale`, and may not affect 1.x readers at all; this needed a test (both APIs,
rename to a new name and into a folder; test plan item 5), whose result follows. Renaming into a folder keeps the
file name and is harmless whatever the test shows, so it is the rule; the real fix is below.

**Probe result (installer.yml scenario 5, windows-latest, 2026-11-09, run 42558383080).** Three
running copies of one image, before and after a rename while running:

| Process | `Win32_Process.Name` / `ExecutablePath` | `tasklist` | `QueryFullProcessImageName` |
| --- | --- | --- | --- |
| renamed to `spawnloft-core.old-1234.exe` | `spawnloft-core.exe` / original path | `spawnloft-core.exe` | `...\spawnloft-core.old-1234.exe` (new name) |
| moved into `old-20261109-000000\` | `spawnloft-core.exe` / original path | `spawnloft-core.exe` | `...\old-20261109-000000\spawnloft-core.exe` |
| the Rust daemon after a real a-to-b update | `spawnloft-core.exe` / `resources\bin\spawnloft-core.exe` | `spawnloft-core.exe` | `resources\bin\old-<stamp>\spawnloft-core.exe` |

So WMI and `tasklist` (what 1.x reads) keep the name and path fixed at process creation, and
`QueryFullProcessImageName` (what 2.0's `procid::image` reads) follows the file. The spike's
`.old-<tick>.exe` rename would have made a 2.0 reader that compares basenames call a live daemon
`stale`; the folder rename keeps the basename for every API, and the creation time (which did not
change: `134386701153422829` before and after) decides first anyway. The rule above stands as
written, now measured.

Identity, the real fix: 2.0's daemon writes `daemonStartTime` (the kernel's process creation
time, an opaque integer) beside `daemonPid` in `state.json`; 2.0's readers check (pid, creation
time) first and fall back to the basename rule for records without it. 1.x readers (a rolled-back
install) ignore the new field.

What the surviving daemon is: the **previous** build's daemon talking to the **new** build's CLI
and panel until that server is next restarted. The control protocol therefore stays compatible
across adjacent 2.x releases (the `protocol` field in `ping`), `doctor` names servers whose
daemon is older than the installed core ("restart to update the server's supervisor"), and the
panel's update notice says "Servers keep running; each is on the new version after its next
restart". A protocol-breaking release sets `minVersion` in the feed (5.3) so installs hop
through a release that understands both.

Other held files: none. The shell is closed by the check; the core is the only long-running
binary; the panel assets and the bot host are files the core reads at start only. The Java
runtimes live under the data root, not the install folder.

## 5. The updater (2.x to 2.y)

### 5.1 Split of work

| Part | Who does it |
| --- | --- |
| Discover the newest release of the channel | SpawnLoft (`spawnloft-core update check`, also used by the shell) |
| Fetch and verify the signed envelope, policy (channel, no downgrade, `minVersion`, data format, freshness) | SpawnLoft |
| Download the artifact, verify its minisign signature, run the installer / replace the bundle, relaunch | `tauri-plugin-updater`, pinned to the envelope through `version_comparator` |
| Keep a copy of the downloaded artifact, choose and run a rollback | SpawnLoft |
| Linux deb/rpm | SpawnLoft notifies and shows the command (Q-F) |

The check runs in the core (`spawnloft-core update check --json`), so the CLI, the headless
Linux package and the panel share one implementation and one log; the shell only performs the
install step through the plugin when the core says there is something verified to install.
Headless installs (no shell) print the command or, on Windows and macOS, download and run the
installer themselves through the same verified path (`spawnloft update apply`).

### 5.2 Where the feed lives (D6)

Every 2.x release on GitHub Releases carries, beside its artifacts:

| Asset | For |
| --- | --- |
| `spawnloft-updates.json` | SpawnLoft's envelope (5.3) |
| `spawnloft-updates.json.sig` | its minisign signature |
| `latest.json` | the plugin's own format, derived from the same data, one entry per target |
| `SpawnLoft-Setup-<v>.exe`, `.exe.sig` | Windows installer and its artifact signature |
| `SpawnLoft-<v>-mac-arm64.app.tar.gz`, `.sig` | Tauri's macOS updater artifact |
| `SpawnLoft-<v>-mac-arm64.zip`, `SpawnLoft-<v>-mac-arm64.dmg` | Squirrel.Mac (1.x handover) and manual install |
| `SpawnLoft-<v>-linux-<arch>.deb`, `.rpm`, `spawnloft-cli-<v>-...` | packages |
| `latest.yml`, `beta.yml`, `latest-mac.yml`, `beta-mac.yml`, `latest-linux*.yml`, `beta-linux*.yml` | **1.x electron-updater**, written from the verified bytes as `stable-artifacts.mjs` does now; kept on every 2.x release for as long as any 1.x install exists |

Discovery reads `https://github.com/joogiebear/spawnloft/releases.atom` (no authentication, no
rate limit, what 1.x reads), takes every entry whose tag is valid semver and matches the
channel (stable: no prerelease part; beta: prerelease part `beta` or none), fetches
`<tag>/spawnloft-updates.json` and `.sig` for the **highest version** among them, and goes down
the list on a 404 (a 1.x release or a release without an envelope). It never trusts GitHub's
order (P0-E 4b) and never looks at `releases/latest`. The atom feed shows about ten entries, so
the GitHub releases API (paged, unauthenticated, 60 requests an hour is plenty for one check
every six hours) is used when the atom window is not enough: when the atom feed is unreachable,
when an install is more than ten releases behind and must walk `minVersion` hops, and for the
rollback list. Same selection rules either way.

Why not the static feed on the site that PLAN-RUST-TAURI Q17 recommended: the envelope makes
the host untrusted anyway, so the site adds a second hosting dependency and a cross-repository
secret for the release workflow without adding safety. The client takes a **list** of feed
sources, so a site mirror can be added later as the first entry if GitHub availability becomes a
problem. Decided (Q-C).

### 5.3 The envelope

```json
{
  "format": 1,
  "product": "spawnloft",
  "keyId": "2026a",
  "channel": "beta",
  "version": "2.0.0-beta.3",
  "tag": "v2.0.0-beta.3",
  "generatedAt": "2026-12-01T18:02:11Z",
  "expiresAt": "2027-03-01T18:02:11Z",
  "notes": "https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0-beta.3",
  "minVersion": "2.0.0-beta.1",
  "dataFormat": 1,
  "platforms": {
    "windows-x86_64":  { "url": "https://github.com/joogiebear/spawnloft/releases/download/v2.0.0-beta.3/SpawnLoft-Setup-2.0.0-beta.3.exe", "size": 9123456, "sha512": "...", "signature": "<minisign signature of the file>" },
    "darwin-aarch64":  { "url": ".../SpawnLoft-2.0.0-beta.3-mac-arm64.app.tar.gz", "size": 0, "sha512": "...", "signature": "..." },
    "linux-x86_64-deb": { "url": ".../SpawnLoft-2.0.0-beta.3-linux-amd64.deb", "size": 0, "sha512": "..." },
    "linux-x86_64-rpm": { "url": "...", "size": 0, "sha512": "..." }
  }
}
```

- The signature file is minisign's format, made with the **same key pair** that signs the
  artifacts (Tauri's keys are minisign keys). **Settled by T2 (2026-11-09):** `tauri signer
  sign` 2.12.4 has no flag for a custom trusted comment, and none is needed. The envelope is
  signed with `tauri signer sign --app-version <version> spawnloft-updates.json`, whose comment
  is `timestamp:<t>\tfile:spawnloft-updates.json\tversion:<version>`; the client requires
  `file:` to be the envelope's own name and `version:` to equal the payload's `version`, so a
  signature cannot be moved between files or releases, and no second signing tool
  (`minisign`, `rsign2`) enters the release step. The same rule binds each artifact's
  signature (`file:<asset name>`, `version:`), which is why release artifacts are re-signed
  **after** being renamed to their release names (`desktop/update-envelope.mjs` refuses an
  artifact whose comment names another file). `keyId` names the
  key that signed the envelope and the artifacts of that release; it is inside the signed
  payload. The public keys are compiled into `spawnloft-core` and the shell as a list
  `{ id, pubkey, from }` with two slots (current and next) for rotation; the client picks the
  pubkey by `keyId` for the envelope check **and** hands the same one to the plugin. A key is
  retired by shipping a build without it, as the harness index does
  (`src/client-harness-index.mjs` is the model; the revocation-list part is not needed here
  because every client always has the full list).
- `version` must equal the tag's version, `channel` the channel asked for, `product`
  `spawnloft`, `format` one the client knows. **Freshness:** `generatedAt` must not be older
  than the newest envelope this install has accepted before, nor older than a baseline baked
  into each build (the build's own release date, as `HARNESS_INDEX_MIN_SERIAL` does), so a
  replayed old feed is refused, logged, and the next source tried, on a fresh install too. A
  feed whose `expiresAt` has passed is still accepted (it may simply be the newest) but the
  panel and `doctor` say "the update feed is older than expected" so a frozen host is noticed
  (review item 7). An explicit rollback is exempt from the freshness rule and never from the
  signature, `product`, `channel` and data-format rules. `minVersion` is the oldest version that
  may update straight to this one; an install below it is told to update to the newest release it
  may take first (the client walks the list down). `dataFormat` is compared with
  `data-format.json` (section 8) and with the running build's; a feed with a higher data format
  than the build understands is refused.
- Downgrades: never offered from a feed. The only downgrade is a rollback the person asked for
  (5.6), and it still requires a verified envelope and a matching data format (P0-F M2). The
  `SPAWNLOFT_SPIKE_FEED` override is compiled out of release builds; test builds set the feed
  through the internal config file only.
- `latest.json` (the plugin's format) is generated from the same records by the same step; the
  client never reads it itself.

### 5.4 Key custody (Q23, D5)

One minisign key pair, generated once on Victor's Windows signing machine with `tauri signer
generate`, password-protected, the private key kept in his password manager and as the GitHub
secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the release
workflows (`dev` and `main` only, as the Azure OIDC and Mac credentials already are). Stables
built on his machine read the same key from a file outside the repository. The public key
(and a second, pre-generated "next" key's public half, private half sealed away) ship in the
binaries. Rotation: a release that signs with "next" and lists a new "next"; the retired key is
dropped from the list two releases later. Documented in `desktop/UPDATER-KEYS.md` when built.
This adds no new class of trust: CI already holds the Authenticode and Apple credentials.

### 5.5 The check and install, step by step

```
every 6 h, 20 s after start, and on demand:
  core: update check
    1. read channel (update-channel.json, same rule as 1.x: a prerelease build defaults to beta)
    2. discover (5.2), fetch envelope + sig for the best candidate, verify (5.3)
    3. policy: version > installed; minVersion <= installed; dataFormat ok; generatedAt fresh
    4. write update.log; return { version, notes, platform entry, latestJsonUrl, pinned: {version,url,signature} }
  shell (or headless `update apply`):
    5. UpdaterBuilder: pubkey (the one envelope.keyId names), target, version_comparator =
         |_, remote| remote.version == pinned.version && remote.download_url == pinned.url
                      && remote.signature == pinned.signature
       then Updater::restore_update(<manifest built from the pinned record>) instead of
       check(): the plugin never fetches latest.json (as built by T2: one network read of the
       release data, the signed one; restore_update forces require_signed_version). Some(update)
       only when the plugin accepts exactly what the envelope named; None is logged
    6. the core downloads (`update apply --no-run`, as built by T2: the body is capped at the
       size the envelope signed, so a swapped multi-GB asset is refused before it is in
       memory), verifies signature, signed version, size and sha512, and keeps the copy in
       <config>/updates/<version>/<file> (last two versions, pruned); the shell reads that
       file and verifies it against the record again before staging it
    7. on Restart (or on quit when autoInstallOnAppQuit is on): install(bytes): the plugin
       verifies again, extracts, calls on_before_exit (which stops the core child) and runs the
       installer with /P /UPDATE /R (interactive) or /P /UPDATE (on quit: the plugin has one
       install mode per build, passive, so the on-quit install shows its progress bar and no
       /R), or replaces the bundle on macOS. A staged update is installed on quit only while
       the core's last check still offers that exact version and hash
    8. the new app starts; first launch (section 8) confirms the version and clears the pending state
```

Plugin facts this relies on (**verified** against `tauri-plugin-updater` 2.14.1 source by the
review): `endpoints`, `pubkey`, `version_comparator(Fn(Version, RemoteRelease) -> bool)`,
`installer_args`, `on_before_exit` (Windows), `download() -> Vec<u8>` verifying inside,
`install(bytes)` verifying again, static-manifest target keys `windows-x86_64` and
`darwin-aarch64` (the plugin tries `windows-x86_64-nsis` first). On Windows the plugin's
arguments are `/P /UPDATE /R /ARGS <current args…> <installer_args…>`: anything in
`installer_args` lands **after** `/ARGS` and is passed to the relaunched app by the template's
`.onInstSuccess`, which matters for `/ROLLBACK` (5.6).

Install on quit stays **on** for 2.x to 2.y (same as today): it never touches a server. The 1.x
major guard logic is not needed in 2.x because 2.x updates do not kill daemons; it returns only
if a future major ever needs a stop.

Log: `<config>/update.log`, one line per check (source, candidate, verification result,
policy result), per download (bytes, sha512 result), per install (installer exit code, read
back from the registry on the next start). P0-F asked for this because 1.x had none.

### 5.6 Rollback (D7)

**2.x to 2.y, in app.** Preferences → Updates → "Reinstall a previous version" lists the
releases below the installed one that the verified feed set knows (the atom feed's window,
typically the last ten releases), newest first, marking the ones whose `dataFormat` equals
the data folder's; others are shown disabled with "this version cannot read your data as it is
now". Choosing one runs the same path as 5.5 with the chosen envelope and `version_comparator`
allowing that exact lower version, and:

- Windows: `installer_args ["/ROLLBACK"]` with `restart_after_install(false)`, and the
  template relaunches through its own `--force-run` path instead of `/R`, so `/ROLLBACK` is not
  handed to the new `SpawnLoft.exe` as an argument (it would land after `/ARGS`; review item 5).
  The shell also ignores unknown `/X` arguments explicitly. The template's downgrade abort is
  skipped when `/ROLLBACK` is present, nothing else changes (same keys, same folder; a held
  core is moved aside as in section 4). An update-mode install never removes files the new
  manifest does not list (Tauri's template skips the uninstaller on `/UPDATE`), so a rollback
  can leave a newer panel asset or forwarder behind; the rollback therefore runs
  `uninstall.exe /S /UPDATE` of the current version first, which removes that version's file
  list and keeps keys, shortcuts, tasks and data. The kept copy in `<config>/updates/` is used
  when present and `Update::verify()` passes; otherwise the file is downloaded again.
- macOS: the plugin replaces the bundle with the older `.app.tar.gz`, which is signed like any
  other artifact. The plugin extracts into the temp folder (on the app's volume) or beside the
  app, swaps with a rename, and **removes** the old bundle; PLAN.md 6.5's "keep the previous
  bundle for one cycle" is not provided and not needed, since the feed is the source of every
  rollback.
- Linux: the package command for that version is shown.

After a rollback the updater would offer the newer version again at the next check; the
rollback writes `<config>/update-hold.json` `{ "below": "2.1.0" }` and the check skips versions
at or above it until the person clears the hold in Preferences or a newer version than the held
one appears. `data-format.json` is rewritten by the older build only if its format is the same
(it always is, by the disabled-entries rule). The rolled-back-to envelope is older than the
last accepted one by definition; the freshness rule (5.3) does not apply to a rollback.

**2.0 to 1.x, manual.** The release notes link the last 1.x installers under "If you need to go
back" with: stop every server first (the 1.x installer's sweep kills what it finds), run the
installer, and 1.x's `repairAfterMove` rewrites shims and launchers on its first start (the exe
path changes back). The 2.x uninstaller honours `--updated` (**verified**: internal.16 restored
over the spike, task and data intact) and leaves the folder and keys 1.x expects.
`data-format.json` makes 1.x say what happened (the P0-B warning is in `v2` only; 1.5.0 and
1.6.0-beta.413 do not read it, so they say nothing. Accepted: the formats are the same.)

### 5.7 Linux (outline; Q24 open)

Tauri-built `spawnloft` deb and rpm, Depends webkit2gtk 4.1 and GTK 3 (floor Ubuntu 22.04 /
Debian 12), providing `/opt/SpawnLoft/spawnloft-desktop` (what 1.x's `.desktop` entry and
electron-updater's relaunch run) and `/opt/SpawnLoft/resources/bin/spawnloft` (what the
`/usr/bin/spawnloft` wrapper execs and what MCP configs may hold) as the shell and core or
symlinks to them, through the bundler's extra-files mapping; `spawnloft-cli` as now with
`Conflicts: spawnloft`. 1.x's electron-updater installs the 2.0 deb or rpm through `pkexec`
(as today); 1.x Node daemons keep running from deleted files and are handled as section 8
describes for macOS. 2.x updates on Linux: the app and the CLI notify and show the
`apt`/`dnf` command; no `pkexec` from the app (Q-F), unless the Linux thread verifies the
plugin's deb/rpm path and Victor wants it. Headless `spawnloft-cli` boxes: notify only, as today.

## 6. macOS

- **Core signed separately (D8).** The build signs `spawnloft-core` with the Developer ID,
  `--options runtime --timestamp`, no entitlements (a Rust binary needs none; the JVMs it
  starts are separate signed binaries), then runs `tauri build`, which signs the app and
  notarizes and staples it (**verified** on the spike after the first refusal). `externalBin`
  is not used: it would move the core to `Contents/MacOS/` and change the path the shell, the
  shims and the Linux layout share. `verify-build` asserts on the core: Team ID, Developer ID
  authority, timestamp, hardened runtime; on the app: the same, bundle id
  `io.github.joogiebear.mcctl`, `CFBundleShortVersionString`, stapled ticket (`stapler validate`
  with the existing retry), `spctl` "Notarized Developer ID".
- **Two update artifacts from one bundle.** The notarized, stapled `SpawnLoft.app` is packed
  twice: `ditto -c -k --keepParent` to `SpawnLoft-<v>-mac-arm64.zip` for Squirrel.Mac and 1.x's
  `latest-mac.yml`/`beta-mac.yml` (sha512 and size from the bytes, as `mac-update-feeds.mjs`
  does), and Tauri's `.app.tar.gz` plus `.sig` for the plugin. Both are verified by extracting
  and running `codesign --verify --deep --strict` before the feeds are written.
- **The handover.** 1.x downloads the zip and ShipIt swaps the bundle on quit or on Restart
  (**verified**, install on quit). Running 1.x Node daemons keep running from the old bundle's
  deleted files; 1.5.0 and 1.6.0-beta.413 have lazy imports, so such a daemon can fail at a
  later crash diagnosis or restart. Section 8 handles it on first launch.
- **2.x updates.** The plugin extracts the tar beside the bundle and replaces it in place, then
  relaunches (**verify** on the mini: the Squirrel path was run, the plugin's was not). Rust
  daemons running from `Contents/Resources/resources/bin/spawnloft-core` keep running from the
  unlinked file (APFS), no rename needed. Gatekeeper: the replaced bundle is the notarized one;
  no quarantine attribute is added by our own extraction (**verify**).
- Signing credentials: CI only (Victor's choice, 2026-11-09), `MAC_CSC_LINK` and the `APPLE_*`
  secrets, trusted on `dev` and `main` pushes as now; the stable release flow stays Node under
  `desktop/` (Q7) and calls the Tauri build for the Mac job as the spike workflow does.

## 7. The Windows per-user config folder (D9)

Facts: the core writes `settings.json` to `%APPDATA%\spawnloft\` on new installs (since the
rename) and reads `%APPDATA%\mcctl\settings.json` on older ones; Electron's userData is
`%APPDATA%\SpawnLoft\` and holds `window-state.json`, `launcher-window-state.json`,
`ui-zoom.json`, `update-channel.json` and Chromium's profile (`Cache`, `Code Cache`, `GPUCache`,
`Local Storage`, `Session Storage`, `Network`, `Crashpad`, `Preferences`, `Local State`, ...),
often hundreds of MB. On NTFS `spawnloft` and `SpawnLoft` are **the same folder**; whichever
process created it first decided the case shown in Explorer. So on every Windows install made
or updated since the rename, the core's settings already sit inside Electron's profile folder.

Decision: **that is the 2.0 config folder, on purpose.**

- 2.0 (core and shell) resolves `<config>` as `%APPDATA%\spawnloft` (same as today), reads and
  writes `settings.json`, `update-channel.json`, `window-state.json`, `launcher-window-state.json`
  and `ui-zoom.json` **in place**. No copy, no migration, no second folder, and a rollback to 1.x
  finds everything where Electron left it. The channel default rule is kept (a prerelease build
  with no saved choice follows betas).
- Nothing of 2.0's goes into Tauri's identifier folders (`%APPDATA%\io.github.joogiebear.mcctl`,
  `~/Library/Application Support/io.github.joogiebear.mcctl`) except WebView2's own profile,
  which stays at Tauri's default `%LOCALAPPDATA%\io.github.joogiebear.mcctl\EBWebView` (cache
  and cookies of our own loopback panel; the Microsoft sign-in uses the system browser).
- **First-launch cleanup (Q-E).** On Windows, once, after the handover, the shell deletes
  Electron's profile folders from `<config>` by allowlist: `Cache`, `Code Cache`, `GPUCache`,
  `DawnGraphiteCache`, `DawnWebGPUCache`, `blob_storage`, `Crashpad`, `Network`, `Session Storage`,
  `Local Storage`, `IndexedDB`, `Service Worker`, `Shared Dictionary`, `databases`,
  `Dictionaries`, `Trust Tokens`, `SharedStorage`, `WebStorage`, `logs`, and the files
  `Preferences`, `Local State`, `Cookies`, `Cookies-journal`, `TransportSecurity`, `DIPS`,
  `DIPS-journal`, `LOCK`, `LOG`, `LOG.old`; and `%LOCALAPPDATA%\spawnloft-desktop-updater\`
  (electron-updater's pending installer, 100 MB+). Never anything else, never the four JSON
  files above, never `settings.json`. The panel keeps its UI state server-side; what it had in
  Electron's `Local Storage` (13 uses in `ui.html`) does not carry into WebView2's profile
  anyway, so nothing is lost that was not already lost. A 1.x rollback recreates its profile.
  `doctor` reports the leftovers if the cleanup has not run.
- `uninstall --data` keeps claiming the `SpawnLoft` and `mcctl-desktop` folders (it already
  requires `window-state.json` in them), and 2.0 also removes `%LOCALAPPDATA%\io.github.joogiebear.mcctl`
  and `<config>\updates\`.
- macOS and Linux have no collision: Electron's folder is `~/Library/Application Support/SpawnLoft`
  or `~/.config/SpawnLoft` and the core's is `~/.config/spawnloft` (case-sensitive on Linux;
  on macOS `~/.config` is the core's, Electron's is elsewhere). There 2.0 copies the four JSON
  files once into `<config>` on first launch (PLAN.md section 7), leaves Electron's folder, and
  `uninstall --data` claims both.
- Case-sensitive Windows folders (`fsutil file setCaseSensitiveInfo`, WSL-created trees) would
  make them two folders; `doctor` reports a `SpawnLoft` folder beside `spawnloft` and the shell
  reads its four files from either, preferring `spawnloft`. Not worth more than that.

## 8. First launch of 2.0

`SpawnLoft.exe` starts (by `--force-run`, `/R`, a shortcut, or by hand), spawns the core, and
the core's `first-run` step runs before the panel loads:

1. **Version marker.** Compare the installed version with `<config>/installed-version.json`;
   on change, write `data-format.json` `{ "writtenBy": "2.0.0", "format": 1 }` into the data root
   (only if the format there is not higher), and note the update in `update.log`.
2. **Repair.** `repairAfterMove` with the bumped `RUNTIME_FORMAT` (shims and launchers name
   `spawnloft-core.exe` and no `ELECTRON_RUN_AS_NODE`); idempotent after the installer did it.
3. **Handover record.** If `run/handover.json` exists and has not been shown: the panel opens
   with a banner. On the Restart path the shell is what runs `handover resume` (2.5), so the
   banner first shows "Starting mysql-main, survival, creative again after the update" with
   live progress, then "SpawnLoft stopped survival, creative and mysql-main for the update and
   started them again" or, per failed server, "creative did not start: <reason>" with a Start
   button and a link to the log. An `orphaned` entry says "survival's Java process is running
   with no supervisor since before the update" with the `kill` offer 1.x gives. Dismissing marks
   it shown; the file goes a week later.
4. **1.x daemons still running (macOS, Linux, and a Windows install that was aborted mid-way).**
   For each server whose `state.json` names a 1.x daemon (`daemonExe` of `SpawnLoft`,
   `spawnloft-desktop`, or `SpawnLoft.exe`, alive), the banner says "survival is still run by
   SpawnLoft 1; restart it to move it to this version" with a Restart button that does a
   graceful stop through the 1.x pipe protocol and a start through the new core. `doctor` says
   the same. Nothing happens on its own: those servers are serving players.
5. **Cleanup** (section 7) on Windows, once.
6. **Panel path check.** MCP configs that name the old form keep working through the forwarder;
   the Settings page shows the 2.0 form (`<install>\resources\bin\spawnloft-core.exe mcp`) with
   "update your assistant's config when convenient".

Headless (no shell): `spawnloft-core` runs steps 1 to 4 on its first command after an update and
prints the banner text instead.

## 9. Uninstall

The 2.x uninstaller (full UI or `/S`, not `/UPDATE`):

1. Restart Manager check on `SpawnLoft.exe` (close the panel).
2. `"$INSTDIR\resources\bin\spawnloft-core.exe" uninstall --yes [--data]`: graceful stop of every
   server (60 s each, then `kill` as 1.x does, because the program is going away), remove the
   scheduled tasks (`mcctl` folder) and launchd/systemd units, and with `--data` the purge list
   of `src/uninstall.mjs` plus the WebView2 folder and the updates cache. The box's default is
   off and the text is 1.x's.
3. Delete files, including any `old-*` core folders no longer held, keys, shortcuts, the
   `AppUserModelId`; leave `%APPDATA%\spawnloft\settings.json` unless `--data`.

With `/UPDATE` or `--updated` (a 2.x update or a 1.x rollback running it): nothing of step 2,
keys and shortcuts kept, the `SpawnLoftShell` marker cleared so the next installer knows the
state (**verified** for the rollback direction).

## 10. Failure modes

| Failure | Effect | Handling |
| --- | --- | --- |
| A server does not stop within the deadline during the handover | the 1.x uninstaller would kill it | the CLI client is terminated, never the daemon; `handover stop` restarts what it stopped under 1.x, writes the blocked marker, exits 3; installer aborts (error level 4), 1.x untouched; 1.x panel shows "Update failed"; silent retries exit 3 before stopping anything while the marker holds; UI mode names the server (Q-B) |
| A deadline passed to the 1.x daemon as its stop timeout | 1.x force-kills the JVM at that timeout and reports success | never done: the CLI gets a timeout of 2,000,000 s; the deadline lives in `handover stop` (review item 1) |
| An `orphaned` server (java alive, no daemon) | 1.x refuses to stop it; would block every attempt | recorded and skipped; its JVM is outside the install folder; first launch offers `kill` |
| `handover stop` cannot read the data folder (settings point at an unplugged drive) | no daemon can be running from it | one read-only process query confirms no `daemon.mjs` process, recorded, proceed |
| 1.x CLI missing or broken (`resources\core` damaged) | cannot stop through 1.x | own pipe client fallback after the pipe-owner pid check, then wait for the JVM; no kill |
| A scheduled task fires during the handover (`restart`, `start`, `steps`) | a fresh 1.x daemon the uninstaller would kill | the `\mcctl` task folder is disabled before the stop and re-enabled by resume or abort; the active set is re-read before the uninstaller runs |
| Servers and their database stopped or started in the wrong order | a server loses its database mid-save or starts without it | servers then databases on stop; databases then servers on resume |
| Another user's server of the same name on the machine-global 1.x pipe | the fallback could stop it | the pipe server's pid must equal `state.json`'s `daemonPid`, else `failed` |
| The 1.x panel is open when the handover runs | its install-on-quit could start the pending setup a second time | the 1.x uninstaller force-closes it (no graceful quit); the installer mutex makes a second setup exit at once |
| 1.x uninstaller fails or leaves `app.asar` | mixed folder | retried five times, then abort with 2 (spike); recorded servers are **restarted through the 1.x CLI** so the abort leaves them running |
| Installer closed or power lost between stop and resume | servers down | the record says `start: skipped`; the shell's first run or `doctor --fix` runs resume (under the lock) for entries younger than 24 h, then shows the banner; no ordinary command does |
| Running the core from the temp folder is refused by policy (AppLocker, SRP, ASR) | handover cannot start | the core is extracted to `resources\bin\staging\` first; `$PLUGINSDIR` is the fallback |
| `handover resume` fails to start a server | that server down | recorded `failed` with the reason; banner with Start; `doctor` lists it |
| Restart Manager closes an argv forwarder mid-task | a task run cut short | task re-runs at its trigger; the forwarder's job object takes its child down with it |
| 2.x update: core held and cannot be renamed (AV scanner, a `cmd` with the file open) | install cannot proceed | abort 2 before any file is written; message names the file; the updater retries later |
| Held core renamed, daemon keeps running from `old-<stamp>\` | mixed versions until restart | by design; identity by file name and (pid, start time); protocol compatibility; `doctor` note |
| Feed tampered or wrong key | an artifact offered under a wrong version or URL | envelope signature fails, or the plugin's second fetch does not match the pin: refused, logged, no download |
| Old envelope replayed | downgrade attempt | `generatedAt` older than the last accepted or than the build's baked-in baseline: refused |
| The host serves the last accepted envelope forever (freeze) | no updates, silently | `expiresAt` passed: accepted but reported by the panel and `doctor` as a stale feed |
| `/ROLLBACK` handed to the relaunched app | shell starts with a stray argument | `restart_after_install(false)` plus the template's own relaunch; the shell ignores unknown `/X` arguments |
| Key rotation: a release signed with the "next" key | old clients cannot verify it | both keys ship ahead of time; `keyId` in the envelope selects the key for the envelope and the plugin; tested before the first rotated release |
| Artifact signature wrong | plugin refuses after download (**verified**) | logged; cache entry removed |
| sha512 mismatch before install | corrupted or swapped download | own check refuses before the plugin runs it |
| `minVersion` above installed | protocol or data skip | offered the newest version it may take instead; notes say why |
| Data format of the feed higher than the build understands | newer data than this client | refused with a message naming the version |
| Installer exit code non-zero after the plugin ran it | app may not restart | the plugin reports the error; `update.log` has the code; the next start compares installed version |
| Rollback chosen for a version whose data format differs | data unreadable by the older build | entry disabled in the UI; the CLI refuses without `--force-data-format` |
| Mac: plugin replaces the bundle while a Rust daemon runs | none | daemon runs from the unlinked file; restart moves it over |
| Mac: 1.x Node daemon still running after the handover, later lazy import fails | crash diagnosis or auto-restart of that server fails | banner and `doctor` ask for a restart (section 8 item 4) |
| Mac: notarization refuses the core | release blocked | `verify-build` checks the core's signature before `tauri build`; the CI step signs it (spike) |
| WebView2 missing and bootstrapper offline | window blank or absent | shell detects, shows the Evergreen link; CLI, daemons and MCP unaffected |
| 1.x stable installs updating with servers running (1.5.0 has no guard) | would have been killed | the installer-side stop (D1) is exactly for them; verified in the test plan with 1.5.0 |
| 1.x publisher check fails (new Azure profile) | 1.x refuses the download forever | `verify-build` asserts CN "victor zemeckis" on every exe; the handover smoke runs the real electron-updater |
| A 1.x release ever published after 2.0.0 (hotfix) | `releases/latest` points back at 1.x for stable installs | `make_latest: false` on it; 2.x clients ignore GitHub order anyway |
| The release has `latest.json` and artifacts but no envelope | 2.x clients skip it; 1.x clients still update to it | release gate refuses to publish without the envelope |
| GitHub unreachable | no update | logged once; retry in 6 h; no error shown unless the person pressed Check |
| Two installs on one machine (per-user, two Windows users) | separate folders and keys, as today | nothing new |

## 11. Test plan

**Unit (Rust, `cargo test`):** envelope parse and verify (good, wrong key, moved signature,
wrong comment, replayed `generatedAt`, unknown `format`); release selection from atom samples
(interleaved 1.x and 2.x tags, `next` tags, missing envelope 404, highest wins); policy
(`minVersion`, data format, hold file, channel rules, no downgrade); `version_comparator` pin
(matching, differing url, differing signature); rollback candidate list; handover record
read/write and the resume-after-24-h rule; identity by (pid, start time) with and without the
field; `handover stop` planning against fixtures of 1.x `instances.json` and `state.json`
(P0-A fixtures), including databases and adopted servers.

**Installer workflow (`.github/workflows/installer.yml`, successor of `tauri-spike.yml`,
`windows-latest`, every push to the template, the handover command or the updater):**

1. Handover from **1.6.0-beta.413** (published, signed) with one fake-java server running, one
   database (fake MySQL) running, one stopped server, one **orphaned** server (fake java alive,
   daemon killed) and a scheduled task: run the 2.0 installer with `--updated /S --force-run`.
   Assert: the 1.x log shows `Stopping`/`Saving` for the running ones, server before database;
   no JVM was terminated (the fake java records its signal); `handover.json` has `stopped`,
   `orphaned` and `running`, databases started before servers; the tasks were disabled and are
   enabled again; the task is registered and runs green through `spawnloft-core.exe` (shim text
   rewritten); folder, keys, shortcuts as the spike asserts; the app started and its command
   line carries no installer flags.
2. The same from **1.5.0** (published, signed), the stable path; and with `--updated /S` (no
   force-run) asserting the servers are running with no app launched. Repeated with a
   pre-rename layout (`%APPDATA%\mcctl\settings.json`, data in `%LOCALAPPDATA%\mcctl`) and with
   `SPAWNLOFT_DATA_ROOT` on a second drive letter.
3. Handover with a server that **refuses to stop** (fake java ignores `stop`) beside one that
   stops: installer exits 4 within deadline + 30 s; 1.x intact (`app.asar` present, version
   unchanged); the stuck server still running and never signalled; **the other server running
   again under 1.x**; `handover-blocked.json` present; a second silent run exits 4 within 10 s
   without stopping anything; a UI run (scenario 4) performs the full stop again.
4. Handover UI mode (`-NoSilent`, driven by the page's automation ids): the stopping page
   appears, Cancel restarts the stopped servers and leaves 1.x intact; with the 1.x panel open
   the panel is closed and only one setup process ever runs (mutex); a one-minute `restart`
   task armed before the run does not start a daemon during it.
5. **2.x cycle a to b** with a Rust daemon running a fake server: the plugin updates
   (`/P /UPDATE /R`), the daemon and JVM survive, `status` says `running` throughout, the old
   core sits in `old-<stamp>\spawnloft-core.exe`, `stop` then `start` moves the server to the
   new core, the next install removes the folder. **Image-name probe:** the same run records,
   for the renamed daemon, what `Win32_Process.Name`/`ExecutablePath`, `tasklist` and
   `QueryFullProcessImageName` each report, for a rename to a new name and into a folder
   (section 4).
6. **Rollback b to a** from the Preferences path (CLI equivalent `spawnloft update rollback`):
   `/ROLLBACK` accepted, b's file list removed first, version a installed, hold file written,
   next check offers nothing, clearing the hold offers b, the relaunched app's command line has
   no `/ROLLBACK`.
7. Refusals: envelope with a wrong signature, wrong trusted comment, unknown `keyId`,
   `generatedAt` older than the baseline, `latest.json` whose url differs from the envelope (pin
   mismatch), artifact with a wrong signature, artifact whose signed version differs
   (`require_signed_version`), lower version in the feed, `minVersion` unmet, data format
   higher, `/S` downgrade without `/ROLLBACK`; plus the accepted-but-reported `expiresAt` case
   and a release signed with the "next" key (rotation).
8. Uninstall with and without data; `/UPDATE` uninstall leaves tasks and data; a **1.x installer
   over 2.0** (rollback) with servers stopped, then 1.x's repair rewrites shims; a 1.x uninstall
   key with no `DisplayVersion` (what `nsis_tauri_utils::SemverCompare` returns for "" is
   unknown).
9. The Chromium leftovers cleanup: a seeded Electron profile loses the allowlisted entries and
   keeps the four JSON files and `settings.json`.

Each scenario prints its result JSON into the job log (artifacts cannot be downloaded from the
cloud session, P0-F).

**macOS (`installer-mac.yml`, `macos-15`, signed, artifact only until the go):** build and
verify (core signed, app notarized, stapled, bundle id, Team ID); Squirrel.Mac from the
published 1.6.0-beta.413 to the candidate through a loopback generic feed (as
`smoke-mac-update.cjs`); plugin cycle a to b with a Rust daemon running; rollback; the first
launch banner for a 1.x daemon left running (simulated by a state file naming `SpawnLoft`).

**Linux (`installer-linux.yml`, later, with Q24):** deb and rpm over the 1.x packages in
containers; the two paths exist; `/usr/bin/spawnloft` is the core; `spawnloft-cli` conflicts.

**On Victor's machines, through Remote Control, before "push to beta":** the real
electron-updater handover on his PC from a signed 1.5.0 install (stable path, servers running,
both Restart and install-on-quit); the Mac mini from 1.6.0-beta.413 (already proven once; repeat
with the final build); a rollback on each. Each run writes its raw files under
`S:\VMs\spawnloft-win\p2\` as P0-E and P0-F did.

**Release gate (`verify-build` extended):** every exe signed with CN "victor zemeckis"; the core
binary's arch; the envelope signed from the verified bytes with the expected `keyId` and present
with `latest.json` and every electron-updater feed; version strings equal across tag, envelope,
`latest.json`, `VIProductVersion`, `Info.plist`; the template's upstream copy matches the pinned
bundler version (Q25). Publishing rules from P0-E 4b, enforced by the publish script: the tag and
the release with all its feed files appear together (a bare tag or a release without its `yml`
breaks every 1.x beta check with `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`); the tagged commit of a
2.x release is newer than the newest 1.x tagged commit (release ordering is by commit date);
no `-next`/`-internal` prerelease identifiers on the real repository.

## 12. Rollout

1. **Internal (now, `v2`).** The installer work lands behind `rust-internal.yml` and
   `installer.yml`; internal builds (`2.0.0-internal.N`) have updates off and no feed. Victor's PC
   and Mac mini run the scenarios above with his servers (nothing on them is production, Victor
   2026-11-09).
2. **"Push to beta" (Victor's word).** One reviewed PR `v2` into `dev`; the first public
   release is `2.0.0-beta.1`, a prerelease, published **after** the handover smokes are green on
   the release artifacts themselves (not a re-build). Because 1.6.0-beta.413 installs betas on
   quit with no guard, every beta install takes 2.0.0-beta.1 at its next quit: the first public
   beta must already be the complete handover installer; there is no soft launch for beta users.
   Release notes lead with "servers are stopped and started again for this update" and the
   "If you need to go back" section.
3. **Beta period.** At least a month (Q15) with the handover and update telemetry being
   `update.log` and `handover.json` that people paste; a data-affecting bug resets the clock.
   Every 2.0.0-beta.N carries the electron-updater feeds, so a 1.x beta install that was offline
   lands on the newest beta directly.
4. **2.0.0 stable.** Published as a normal release and marked latest. 1.5.0 installs update on
   their next quit (no guard) through the same installer. Stable-channel installs see it within
   six hours of running; the handover is the only path, as the plan says. No 1.x release follows;
   if a 1.x hotfix is ever unavoidable it is published with `make_latest: false` and its notes
   say it will be replaced by 2.0 on the next check.
5. **After.** Electron feeds kept on every release; the `--updated`/`--force-run` handling,
   `LegacyMode`, the handover command and the forwarder stay for the life of 2.x (they cost
   nothing and a 1.x install can appear from an old backup at any time).

## 13. Decisions on the open questions (Victor, 2026-11-09 02:59 UTC)

Victor: "I trust recommendations." Every question below is therefore decided as its
recommendation says; the text is kept so the alternative and the reasoning stay on record.
Nothing in this document is open.

- **Q-A, restart after the handover:** the servers that were stopped are started again without
  asking (**decided**: a 1.x install-on-quit launches no app, so "offer on first launch" would
  leave servers down until someone opens the panel; on the Restart path the window opens first
  and the restarts run behind the banner), or 2.0's first launch only offers (PHASE0-FINDINGS
  Q14 wording).
- **Q-B, a server that does not stop in 5 minutes:** abort the update, start the already
  stopped servers again under 1.x, and do not repeat the stop on silent retries until that
  server is gone (**decided**: nothing is ever killed; the person sees "Update failed" in 1.x
  and the panel keeps working), or kill the stuck server after the deadline so the update
  always goes through (what 1.x's own `stop` does at its timeout). Note that without the
  client-side deadline of 2.3.1 the 1.x code would make this choice "kill" by default.
- **Q-C, feed hosting:** GitHub Releases only (**decided**), or the static signed feed on the
  site as PLAN-RUST-TAURI Q17 had it (needs a cross-repository secret and a second host).
- **Q-D, key custody:** one minisign key for artifacts and envelopes, generated on Victor's
  machine, kept in his password manager and in GitHub secrets for `dev`/`main` workflows
  (**decided**, as Q23), with a pre-generated "next" key for rotation. Who generates it and when.
- **Q-E, Chromium leftovers:** delete Electron's cache folders from `%APPDATA%\SpawnLoft` on the
  first 2.0 launch by allowlist (**decided**), or leave them until uninstall.
- **Q-F, Linux updates:** notify and show the `apt`/`dnf` command (**decided** for 2.0, same as
  headless), or install through `pkexec` as 1.x does, or the plugin's deb/rpm path if the Linux
  thread verifies it.
- **Q-G, rollback scope:** in-app rollback for 2.x to 2.y only; 2.0 to 1.x manual with
  documented steps (**decided**).
- **Q-H, deadline:** 300 s for the whole stop phase (**decided**), or longer for very large
  worlds (the 1.x CLI's own default is 90 s per server).
- **Q-I, stable timing:** reaffirm Q15: 2.0.0 stable no sooner than a month after 2.0.0-beta.1
  with no data-affecting bug in the last two weeks.
- **Q-J, scheduled tasks during the handover:** disable the `\mcctl` task folder for the
  minutes of the stop and re-enable it after (**decided**; a backup due in that window runs at
  its next trigger), or leave tasks alone and accept that a `restart` task firing mid-handover
  starts a daemon the 1.x uninstaller then kills.

## 14. Threads to start (for the coordinator)

Ready to start now. All on `v2`, each with this document, PHASE0-FINDINGS.md, the spike template and a done-when;
Fable reviews T1 and T2 before they are called done.

1. **T1, Opus: the Windows installer.** Template changes (sections 2 to 4, 9: mutex, staging
   extraction, handover steps, stopping page, `/ROLLBACK`, `/NORESUME`, `old-<stamp>\` rename,
   uninstall through the core, old-folder cleanup), `spawnloft-core handover stop|resume` with
   the client-side deadline, task disabling, dependency order, the blocked marker and the abort
   restart, `repair --quiet`, the record and log, identity by (pid, creation time), the
   image-name probe. Done when: `installer.yml` scenarios 1 to 5, 8 and 9 are green on
   `windows-latest` with the published 1.5.0 and 1.6.0-beta.413 setups, and the probe's result
   is written into section 4 of this document.
2. **T2, Opus: the updater.** Envelope format and signer in the release tooling, key list in the
   binaries, discovery and policy in the core, plugin integration with the pin, cache, rollback
   and hold, `update.log`, Preferences UI hooks (API only; Sonnet does the page). Done when:
   scenarios 5 to 7 are green, unit tests cover 5.3's refusals, and a feed with a wrong key is
   refused on Victor's PC.
3. **T3, Opus: macOS packaging.** Core signing step, zip + tar.gz from one bundle, feeds,
   `verify-build` asserts, `installer-mac.yml` with the Squirrel.Mac smoke and the plugin cycle.
   Done when: the workflow is green and the mini takes the artifact from 1.6.0-beta.413 and then
   a to b.
4. **T4, Opus: release pipeline.** `desktop/` release scripts produce the full asset set of 5.2
   from verified bytes, the release gate, `UPDATER-KEYS.md`, the `make_latest` rule, internal
   config with updates off. Done when: a dry run on `v2` produces every asset into a workflow
   artifact and `verify-build` passes on it.
5. **T5, Sonnet: panel and shell UX.** Handover banner, 1.x-daemon banner, Updates section
   (channel, check, install, hold, rollback list), the installer's stopping page strings,
   release-notes text. Done when: every state in section 8 has a screenshot in the project files.
6. **T6, Opus, after Q24: Linux packages** (5.7).

**Needs Victor's own hands (nothing else is blocked on these; T2 can use a throwaway key until
they are done):**

1. Generate the release minisign key pair on his Windows signing machine (`tauri signer generate`
   with a password), store the private key and password in his password manager, and keep the
   public key for T2; generate the "next" pair the same way and seal its private half away.
2. Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository
   secrets (T4 scopes them to the `dev`/`main` release workflows, as the Azure and Apple secrets are).
3. Later, before "push to beta": the signed handover runs on his PC and the Mac mini listed in
   section 11, through Remote Control, with his go for each.

Order: T1 and T2 in parallel (T2 needs T1's `/ROLLBACK` only at the end), T3 and T4 after T1's
template is stable, T5 alongside, T6 last.

## 15. Review log

Rev 1 was reviewed on 2026-11-09 by a fresh Fable thread against this repository, PHASE0-FINDINGS,
the plans, the tauri-plugin-updater 2.14.1 source and the tauri-bundler 2.10.4 NSIS sources
(electron-updater and electron-builder were judged against P0-E's reading only). Twenty findings;
all folded into rev 2:

| # | Severity | Finding | Where it landed |
| --- | --- | --- | --- |
| 1 | Blocker | A deadline passed to the 1.x `stop` as its timeout makes the daemon force-kill the JVM and report success; "never kills" was false as written | 2.3.1 step 4: enormous CLI timeout, deadline enforced on the client; D1; Q-B reframed |
| 2 | Blocker | An abort after some servers stopped left them down, and electron-updater reruns the pending installer at every quit, so the stop would repeat nightly | 2.3.1 step 7, 2.3.3: restart under 1.x, `handover-blocked.json`, silent retries exit early |
| 3 | Blocker | `orphaned` servers cannot be stopped by 1.x and would block every attempt | 2.3.1 step 3: recorded, skipped, offered at first launch |
| 4 | Blocker | "Windows reports a renamed image under its new name" was marked verified but conflicts with P0-E (WMI showed the original path); API-dependent | Section 4 rewritten: needs a test, folder rename kept, (pid, creation time) is the fix; probe in scenario 5 |
| 5 | Should fix | `installer_args` land after `/ARGS` and reach the relaunched app | 5.6: `restart_after_install(false)`, own relaunch, shell ignores unknown `/X` |
| 6 | Should fix | `tauri signer sign` writes its own trusted comment; `require_signed_version` unused | 5.3: `minisign`/`rsign2` for the envelope (needs a test); 5.5: `require_signed_version(true)` |
| 6a | Settled by T2 | The CLI has no custom-comment flag; `tauri signer sign --app-version` on `spawnloft-updates.json` gives a comment the client can bind to (`file:`, `version:`), so no second tool | 5.3 rewritten; 5.5 uses `restore_update` |
| 7 | Should fix | Freshness rule refused rollbacks and did not detect a frozen feed; no baseline for fresh installs | 5.3: rollback exempt, `expiresAt`, baked-in baseline |
| 8 | Should fix | A `restart`/`start` task firing mid-handover starts a daemon the uninstaller kills | 2.3.1 step 2 and 6: task folder disabled, active set re-read; Q-J |
| 9 | Should fix | Servers and databases stopped and started in no order | 2.3.1 step 4, 2.5: servers then databases; databases then servers |
| 10 | Should fix | "UI mode asks" about the 1.x panel was wrong; a graceful close could start a second setup; no mutex in Tauri's template | 2.3.1, section 3: force-close stated, named mutex |
| 11 | Should fix | Resume from "any SpawnLoft binary" would start servers from a task's `list` | 2.5: only the installer, the shell's first run, `doctor --fix`, under a lock |
| 12 | Should fix | Running the core from `$PLUGINSDIR` has no policy fallback; trust boundary unstated | 2.3 step 1: staging under the install folder; 2.3.5 |
| 13 | Should fix | The 1.x pipe is machine-global; the fallback could stop another user's server | 2.3.1 step 5: pipe-owner pid check |
| 14 | Should fix | No key id on the wire; the plugin takes one pubkey | 5.3: `keyId`, key selected for both checks; rotation test |
| 15 | Should fix | Wording: JVMs die with Node daemons (not orphaned); `download()` already verifies; the macOS plugin removes the old bundle | Section 1, 5.5, 5.6 corrected |
| 16 | Should fix | Resume before relaunch makes "Restart to update" look hung for minutes | 2.3 step 9: window first, resume behind the banner |
| 17 | Nit | Unreadable data root means no daemon can run from it; aborting was over-cautious | 2.3.1 step 1: proceed after a read-only process check |
| 18 | Nit | P0-E 4b publishing rules missing from the gate; atom window is ten entries | 11 release gate; 5.2 API fallback |
| 19 | Nit | Update-mode installs never remove files; a rollback leaves newer files | 5.6: `uninstall.exe /S /UPDATE` first |
| 20 | Gaps | Test plan | Section 11 scenarios 1 to 8 extended |
