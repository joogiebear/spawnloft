# Phase 0 findings

Internal, `v2` branch (PLAN-RUST-TAURI.md section 13). Each section names the plan item it
answers, what was established, how, and what is still a prediction waiting for a live run.
P0-F adds the Tauri spike's numbers here.

## P0-E: experiments 4a and 4b (plan section 3 item 4, section 12 item 6)

Status, 2026-11-08: the code reading is complete and is written up below as the predicted
outcome. The live runs are **not done yet**: 4a needs a Windows machine with a 1.6 install, and
4b needs a scratch repository on GitHub. Section "Running the experiments" is the runbook for
both; the result tables below have an "observed" column to fill in.

### Summary

1. **electron-builder 26.15.3 (every SpawnLoft release since at least 1.4.0 is built with it)
   does not find "the running app" by image name any more.** When PowerShell is available,
   the installer and the uninstaller run `Get-CimInstance Win32_Process` and match **every
   process whose executable path starts with the install folder**, then `Stop-Process` each
   one. Image name is only the fallback when PowerShell is missing or its process execution
   policy is `Restricted`. Consequences:
   - every Node daemon (`SpawnLoft.exe` with `ELECTRON_RUN_AS_NODE`, started by the installed
     app) is matched and killed during an update;
   - the Rust daemon shipped at `resources\bin\spawnloft-core.exe` is **also** matched and
     killed, because it lives under the install folder. Renaming the binary, which REVIEW-REV3
     B2 and plan section 0 rely on against the image-name check, does not help against this
     installer. Only a binary outside the install folder, or a custom running-app check, escapes;
   - the JVM is not matched (java lives in Program Files, `%LOCALAPPDATA%\Programs\<vendor>` or
     the data root, never under `Programs\SpawnLoft`), so it is **left running without a
     daemon**;
   - `Stop-Process` is `Process.Kill()`, that is `TerminateProcess`. Neither daemon's SIGTERM
     handler runs, so neither stops its server gracefully first. The Node daemon leaves the JVM
     (it is a plain child; Windows does not kill children with the parent). The Rust daemon's
     Job Object is created without `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so when the daemon's
     handle closes with the process the JVM survives there too.
   - After the update the state file still says `running` with a dead `daemonPid` and a live
     `javaPid`: `readState` reports **`orphaned`**, `start` and `stop` refuse, and the only way
     out is `spawnloft kill <name>`, a force kill of a JVM that was never asked to save.
2. **The panel's update dialog promises the opposite.** `src/ui.html` says "Running servers
   keep running — SpawnLoft supervises them as separate processes", and `desktop/main.js`
   repeats "Servers survive (detached daemons)". On the reading above that has been false on
   Windows for every 1.x update. 4a confirms or refutes this on a real machine; if confirmed,
   it is a 1.x bug to fix in 1.7 regardless of 2.0 (see Q14 below).
3. **Locked files are not the problem.** The old uninstaller moves every file out of the
   install folder with `Rename` (`un.atomicRMDir`), which Windows allows on a running image;
   only a rename that fails aborts the update ("File is busy"). A daemon that somehow survived
   the kill (elevated, or another user's) would keep running from a file moved to
   `%TEMP%\ns*.tmp\old-install\`, which NSIS then fails to delete on exit. So the installer's
   policy is "kill", never "fail".
4. **Release ordering (4b) is decided by commit dates, not publish order or version.**
   electron-updater's GitHub provider reads `releases.atom` and takes the **first** entry whose
   tag is a valid semver with no prerelease identifier or one of `alpha`/`beta` (for an install
   on a `-beta` version with betas enabled), then fetches that tag's `beta.yml`/`latest.yml`
   and offers it if `semver.gt(feed version, installed)`. GitHub orders that feed, the
   releases page and `/releases/latest` by the release's `created_at`, which GitHub documents
   as **the date of the tagged commit**, not the publish time. A `v2.0.0-beta.1` tagged on a
   `v2` commit newer than the newest `dev` commit is offered to every 1.x beta install
   immediately; the next `v1.6.0-beta.N` tagged on a newer `dev` commit takes the slot back.
   Stable installs (betas off) read `/releases/latest`, which `make_latest` overrides.
   Prerelease identifiers other than `alpha`/`beta` (`-next.1`, `-rc.1`, `-internal.8`) are
   skipped by 1.x beta installs, but a stable 1.x install that opted into betas picks the first
   entry **without** that filter, then fails to find `next.yml` and `latest.yml` on it and shows
   an update error. So "publish 2.0 prereleases under another channel name" is not a safe way
   to hide them from 1.x; keeping them out of the repository's releases (section 13) is.

### Experiment 4a: what the 1.x installer does to running processes

**Mechanism, from `app-builder-lib@26.15.3/templates/nsis` (the exact version in
`desktop/package-lock.json` on `dev`, `v2`, `v1.5.0` and `v1.4.0`):**

- The installer runs `CHECK_APP_RUNNING` first thing in the install section
  (`installSection.nsh`), before the old uninstaller; the old uninstaller runs it again in
  `un.onInit` because electron-updater always passes `/S` (`uninstaller.nsh`,
  `uninstallOldVersion` in `installUtil.nsh` adds `/S /KEEP_APP_DATA --updated`).
- `CHECK_APP_RUNNING` (`include/allowOnlyOneInstallerInstance.nsh`): if the installer's own
  image is not `SpawnLoft.exe`, `FIND_PROCESS`; if anything matched and `--updated` was
  passed, no prompt (`Sleep 1000` then straight to the kill; an interactive install would show
  "is running, close it?" with OK as the silent default). Then `KILL_PROCESS` without force,
  `Sleep 300`, `FIND_PROCESS` again, `Sleep 1000`, `KILL_PROCESS` with force, `FIND_PROCESS`;
  if still found, one more round, then "cannot be closed", which in silent mode is Cancel and
  `Quit` with the install not done (electron-updater then logs the installer's exit code and
  the app stays on the old version).
- `FIND_PROCESS` with PowerShell: `Get-CimInstance -ClassName Win32_Process | ? { $_.Path -and
  $_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }`. `$INSTDIR` is
  `%LOCALAPPDATA%\Programs\SpawnLoft`. `.Path` is empty for processes the user cannot query
  (another user, elevated), so those are invisible to it and unkillable anyway.
- `KILL_PROCESS` with PowerShell: the same query piped to `Stop-Process -Id <pid>` (`-Force`
  on the second round; for the current user's processes `-Force` changes nothing, both are
  `TerminateProcess`).
- Fallback without PowerShell: `tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq
  SpawnLoft.exe"` and `taskkill [/F] /IM SpawnLoft.exe /FI "PID ne <installer>" /FI "USERNAME
  eq %USERNAME%"`. Here the image name matters: Node daemons die, `spawnloft-core.exe`
  survives (and keeps running from `%TEMP%\ns*.tmp\old-install\resources\bin\` after the
  uninstaller's rename, with the pipe still up and `state.json` still true).
- `customCheckAppRunning`: electron-builder compiles `installer.nsh`'s macro of that name
  **instead of** its own check, in both the installer and the uninstaller. This is the hook
  for the 1.x bridge (below).

**What each process is, on a 1.6 install, Windows:**

| Process | Image and path | Matched by the path check | Matched by the image-name fallback |
| --- | --- | --- | --- |
| Panel (Electron) | `Programs\SpawnLoft\SpawnLoft.exe` | yes (already quit by `quitAndInstall`; on update-on-quit also gone) | yes |
| Node daemon per server | `Programs\SpawnLoft\SpawnLoft.exe resources\core\src\daemon.mjs <name>` (`ELECTRON_RUN_AS_NODE=1`) | yes, killed | yes, killed |
| Rust daemon per server (`SPAWNLOFT_DAEMON=rust`) | `Programs\SpawnLoft\resources\bin\spawnloft-core.exe daemon <name>` | yes, killed | no, survives |
| JVM | `java.exe` outside the install folder | no, orphaned | no, orphaned |
| Managed MariaDB / Garnet | engine binaries under the data root (`engines\`) | no | no |
| Bot host | system `node` | no | no |
| A fake java written as `.mjs` | runs **as** `SpawnLoft.exe` (`daemon.mjs` line 122) | yes, killed | yes, killed |

The last row matters for the experiment design: `test/fixtures/fake-java.mjs` would be killed
with the daemons and say nothing about a real JVM. 4a must run a real `java.exe`, which also
makes the "orphaned" state and the data at risk real.

**Predicted result table (fill "observed" from the live run):**

| Step | Node daemon (1.6.0-beta.400 updated to .407) | Rust daemon (2.0.0-internal.N updated by the .407 installer run by hand with the updater's arguments) |
| --- | --- | --- |
| Panel quits | gone | gone |
| Installer's first `FIND_PROCESS` | daemon found | daemon found |
| Daemon after the install | **killed** (predicted) / observed: | **killed** (predicted) / observed: |
| JVM after the install | **alive, orphaned** (predicted) / observed: | **alive, orphaned** (predicted) / observed: |
| `state.json` after relaunch | `running: true`, dead `daemonPid`; `status` reads `orphaned` / observed: | same / observed: |
| Panel after relaunch | server shown orphaned; stop refused; `kill` required / observed: | same / observed: |
| Installer exit code (updater log) | 0 / observed: | 0 / observed: |
| Leftovers | none expected; `%TEMP%\ns*.tmp` removed / observed: | same / observed: |
| Scheduled task present | survives (`customUnInstall` is skipped on `--updated`) / observed: | same / observed: |

Where to look on the machine: the updater's log is at
`%APPDATA%\SpawnLoft\logs\main.log` only if a logger is set (`main.js` sets `autoUpdater.logger
= null`), so the installer's own exit is best read from `rust/experiments/p0e/observe.ps1`
snapshots taken every 500 ms during the install (`-Watch`), plus the uninstaller log
`%LOCALAPPDATA%\Programs\SpawnLoft\Uninstall SpawnLoft.exe` writes nothing by default. A
`DetailPrint`-level log needs `nsis.customNsisBinary` with logging, not worth it here.

### Experiment 4b: which release a 1.x install is offered

**Mechanism, from `electron-updater@6.8.9/out/providers/GitHubProvider.js` and
`AppUpdater.js`, which is what every 1.x install runs:**

1. `GET https://github.com/joogiebear/spawnloft/releases.atom`. Entries are in GitHub's
   order; the code never sorts them and never compares versions between entries.
2. With `allowPrerelease` (a `-beta` install, or a stable install whose user turned betas on):
   - `currentChannel` = the installed version's prerelease identifier (`beta`), or `null` on a
     stable build.
   - `beta` current: walk entries in order; skip tags that are not valid semver; take the first
     whose channel is none/`alpha`/`beta`. (A `-alpha` is skipped by a `beta` current: "allow
     moving from alpha to beta but not down".)
   - `null` current: take the first entry whatever its channel.
3. Without `allowPrerelease`: `GET /releases/latest` (GitHub's choice: newest non-prerelease,
   non-draft by `created_at`, or the one marked `make_latest`), then the matching entry.
4. Fetch `<tag>/beta.yml` when the tag is a prerelease (channel = its identifier; `next.yml`
   for `-next.1`), else `<tag>/latest.yml`; with `allowPrerelease` a missing channel file falls
   back to `latest.yml`, and if that is missing too the check fails with
   `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` (the panel shows "Update failed").
5. Offer if `semver.gt(yml version, installed)`; never downgrade (`update-channel.js` forces
   `allowDowngrade` off). Then download, verify the Authenticode publisher against
   `app-update.yml`'s `publisherName`, install on quit or on request.

**GitHub's ordering** (docs, "About releases" / REST `releases/latest`): `created_at` "is the
date of the commit used for the release, and not the date when the release was drafted or
published". The `.atom` feed and the releases page use the same order (every release in this
repository today confirms `created_at` precedes `published_at` by the build time and the list
is in `created_at` order; it could not be fetched from the build container, which blocks
`github.com` pages, so the live run reads it from the test machine). What the feed order
alone decides is **which tag's yml is read**; the version inside the yml then has to beat the
installed one.

**Scenario table (fill "observed" from the live run against the scratch repository):**

| # | Releases in the scratch repo (tag → tagged commit date) | Install | Predicted offer | Observed |
| --- | --- | --- | --- | --- |
| S1 | `v1.6.0-beta.407` (older commit), `v2.0.0-beta.1` (newer commit) | 1.6.0-beta.400, betas on | **2.0.0-beta.1** (first entry) | |
| S2 | S1 plus `v1.6.0-beta.450` on a commit newer than both, published last | same | **1.6.0-beta.450** (first entry again) | |
| S3 | S2 but `v2.0.0-beta.1` re-tagged on a commit newer than `.450`, published before `.450` | same | **2.0.0-beta.1**: publish order is irrelevant | |
| S4 | `v2.0.0-next.1` newest commit, `v1.6.0-beta.407` | 1.6.0-beta.400, betas on | **1.6.0-beta.407**: `next` is a custom channel, skipped | |
| S5 | S4 | 1.5.0 stable with betas turned on in Settings | **error**: first entry taken without the filter, `next.yml` and `latest.yml` missing on it | |
| S6 | `v1.5.0` (old commit), `v2.0.0` (newer commit) stable, `v1.5.1` (newest commit) | 1.5.0, betas off | **1.5.1** (GitHub's latest by commit date) | |
| S7 | S6 with `v1.5.1` published with `make_latest: false` | same | **2.0.0** | |
| S8 | S6 with `v2.0.0` published with `make_latest: false` | same | **1.5.1**, and 2.0 stays invisible to stable 1.x until that flag flips | |

S1 to S3 need only prerelease tags and copies of an existing signed beta's `beta.yml` with
`version:` edited (and a wrong `sha512`, so nothing downloads and installs under a false
version; the offer is visible in the panel before the download fails). S6 to S8 need
`latest.yml` copies. Commit dates are set with `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` on
empty commits in the scratch repository; the releases carry no installer.

### Q14 recommendation: Windows updates while servers run

Based on the reading above, to be confirmed by 4a:

1. **1.x, now (bridge item for 1.7, `dev`):** stop telling users servers survive. Either make
   it true or say the truth. Making it true is cheap and is the recommendation:
   - add `customCheckAppRunning` to `desktop/build/installer.nsh` that matches **only the
     panel**: processes under `$INSTDIR` whose command line has no `daemon.mjs`, no
     `spawnloft-core`, and is not `ELECTRON_RUN_AS_NODE` work (Win32_Process has
     `CommandLine`; the environment is not visible, so match by the `resources\core\src\daemon.mjs`
     / `resources\bin\spawnloft-core.exe daemon` arguments and by the bot host and task shims
     the same way). Keep electron-builder's retry shape and messages. This lands in the 1.7
     installer **and uninstaller**, which is what matters: the 1.x → 2.0 handover runs the
     last 1.x's uninstaller with `/S --updated`, and today's uninstaller would kill the
     daemons no matter what the 2.0 installer does. So the bridge must ship before the last
     1.x, as section 3 item 6 already requires for the other bridge items.
   - the daemons then keep running from renamed files (NSIS `Rename` of the old
     `SpawnLoft.exe` to `%TEMP%\ns*.tmp\old-install\`, which fails to be deleted at exit while
     a daemon runs; the next `start` after a stop uses the new install). A Node daemon running
     old code from a moved folder is exactly the macOS/Linux case `PLAN.md` 6.3 item 4 fixes
     with eager imports: the daemon must not lazily import anything after start, or it imports
     from `old-install` (fine) or from the new install (version skew). Same bridge item.
   - `control.mjs` already tolerates a daemon whose `daemonExe` is unchanged
     (`SpawnLoft.exe`); the Rust daemon's `daemonExe` is `spawnloft-core.exe`, also unchanged.
   - the panel text becomes true again; the `autoInstallOnAppQuit` path also stops killing
     servers when the panel is closed with an update downloaded.
2. **1.x → 2.0 handover (the 2.0 NSIS template, P0-F):** the plan's recommendation stands and
   this reading strengthens it: **stop servers gracefully over the control pipe before the
   installer runs, and offer to restart them on first launch.** Reason: at the handover the
   daemons are 1.x Node daemons whose code and `SpawnLoft.exe` disappear (step 3 removes
   Electron); letting them run from `old-install` means a 1.x daemon supervising a server the
   2.0 panel cannot talk to across a protocol change, and a `SpawnLoft.exe` that lives on in
   `%TEMP%`. The stop belongs in **1.x** (the last 1.x's `quitAndInstall` path and its
   update-on-quit path: when the offered version's major is higher, stop every running server
   first, record the list in `run\restart-after-update.json`, then install), because 2.0's
   installer cannot speak the 1.x pipe protocol reliably and should not try. 2.0's first launch
   reads the list and asks "start these again?". The installer itself (2.0 template, custom
   check) matches by full path to `SpawnLoft.exe` only and never kills a daemon; in the
   handover case there are none left. P0-B's "never install a major on quit" item is the other
   half: a higher major is never installed silently on quit, only through the button, which
   is where the stop-and-record step runs.
3. **2.x → 2.y (Tauri updater):** rename-under-running as the plan says. The Rust daemon has
   no lazy imports and runs as `spawnloft-core.exe`; the custom template renames
   `SpawnLoft.exe`/`spawnloft-core.exe` to `*.old.exe` when in use, the daemons keep running,
   the next start cleans up. The custom check matches the panel by full path only.
4. **Job Object flag:** keep the Rust daemon's job **without** `KILL_ON_JOB_CLOSE`. With it a
   killed daemon would take the JVM down hard, mid-save; without it the server survives and is
   reported `orphaned`, which is recoverable by `kill` and loses at most one autosave
   interval. The right fix is not killing the daemon (item 1), not killing the server with it.
   If a later decision wants "no orphans ever", add the flag together with a daemon-side
   handler that stops the server on `CTRL_CLOSE`/console events; `TerminateProcess` gives no
   such chance, so the flag alone is a world-corruption risk.

What 4a can change in this: if the live run shows the daemons **surviving** (PowerShell
unavailable or policy `Restricted` on that machine, or `.Path` empty for `ELECTRON_RUN_AS_NODE`
processes), item 1 becomes "document the dependency on PowerShell and still ship the custom
check so the behaviour stops depending on it". If the JVM dies with the daemon, the Job Object
or child handling differs from the reading and item 4 is revisited.

### Running the experiments

Everything below runs on the test machine through Remote Control, with Victor present for the
installer runs. Nothing here touches the real repository's releases. Files:
`rust/experiments/p0e/feed-server.mjs` (local feed) and `rust/experiments/p0e/observe.ps1`
(process, state and leftovers snapshot).

**Choice of machine.** Victor's PC has `2.0.0-internal.8` installed, which the 1.6 installer
would replace (same `appId`, same folder). Options, least disruptive first:
(a) a fresh Windows VM on Proxmox (new VM, not 104/113); (b) his PC with backup and restore:
stop his servers, install the 1.6 beta over internal.8 for the Node run, then internal.8 over
it again for the Rust run (data under `%LOCALAPPDATA%\mcctl` is never touched by an update;
the uninstaller's "delete your data?" is only asked on a manual uninstall); (c) a second
Windows user on his PC (per-user install, separate folder and registry key), which needs a
login as that user, so not through Remote Control.

**4a, Node daemon:**

1. Download from the real releases: `SpawnLoft-Setup-1.6.0-beta.400.exe` (the install) and
   `SpawnLoft-Setup-1.6.0-beta.407.exe` plus its `beta.yml` and `.blockmap` (the update) into
   `C:\p0e\feed\`. Both are Azure-signed by "victor zemeckis", which the install's publisher
   check requires; `beta.yml` already carries the right `sha512`.
2. Install .400 silently without launching: `SpawnLoft-Setup-1.6.0-beta.400.exe /S`.
3. Before the first launch, edit `%LOCALAPPDATA%\Programs\SpawnLoft\resources\app-update.yml`
   to:
   ```yaml
   provider: generic
   url: http://127.0.0.1:8099/
   publisherName:
     - victor zemeckis
   updaterCacheDirName: mcctl-desktop-updater
   ```
   (the first check runs 20 s after launch; pointed at GitHub it would fetch the newest 1.6
   beta instead of the controlled one).
4. `node rust\experiments\p0e\feed-server.mjs C:\p0e\feed 8099` in a terminal that stays open.
5. Launch SpawnLoft, create a small real server (`p0e-test`, Paper, 1 GB, real Java), start it
   from the panel, join or wait for "Done". `observe.ps1 -Label before` and keep the output.
6. When the panel shows the update ready, start `observe.ps1 -Watch` in a second terminal, then
   press "Restart and update". Watch the snapshots: the daemon's pid disappears or not, the
   java pid stays or not, `state.json` content. The feed terminal shows the yml and installer
   requests.
7. After the relaunch on .407: `observe.ps1 -Label after`, the panel's view of `p0e-test`,
   `spawnloft status p0e-test --json` (through `SpawnLoft.exe resources\core\spawnloft.mjs`
   with `ELECTRON_RUN_AS_NODE=1`, or the Start menu terminal entry), then `spawnloft kill
   p0e-test` if orphaned. Also check the scheduled task still exists if one was made.
8. Fill the Node column of the table.

**4a, Rust daemon:** the kill question does not depend on who launched the installer, and the
internal build cannot be an update target (unsigned, no `app-update.yml`), so run the
installer by hand with the updater's exact arguments:

1. Install `2.0.0-internal.N` (Victor's current internal build), start `p0e-test` from its
   panel (internal builds default to the Rust daemon; `observe.ps1` must show
   `spawnloft-core.exe daemon p0e-test`), `observe.ps1 -Label before-rust`.
2. Quit the panel (`autoInstallOnAppQuit` is off in internal builds, nothing happens).
3. `observe.ps1 -Watch`, then `SpawnLoft-Setup-1.6.0-beta.407.exe /S --updated --force-run`.
4. Same checks as steps 7 and 8. The image-name fallback (PowerShell unavailable) is not worth
   forcing: `IS_POWERSHELL_AVAILABLE` only fails when `powershell.exe` cannot run or the
   process-scope execution policy is `Restricted`, which needs admin changes on the machine.
   The reading says it would leave `spawnloft-core.exe` running; record that as untested.
5. Restore internal.N over the result (`SpawnLoft-Setup-2.0.0-internal.N.exe /S`, a downgrade
   by version; the NSIS templates have no version comparison), and `spawnloft kill p0e-test` if needed.

**4b:**

1. Victor creates an empty public repository, say `joogiebear/spawnloft-update-test`, and it
   is added to the thread. Releases, tags and feeds live only there.
2. The thread pushes empty commits with chosen dates and tags per scenario, creates the
   releases (prerelease flags and `make_latest` as the table says) and uploads yml copies with
   edited `version:` and a wrong `sha512`.
3. On the test install (any 1.6 beta): set `app-update.yml` back to
   `provider: github, owner: joogiebear, repo: spawnloft-update-test`, delete
   `%LOCALAPPDATA%\mcctl-desktop-updater\pending\` if present, open Settings, "Check for
   updates", read the offered version or the error, and note `releases.atom`'s entry order
   from the machine's browser for the record. Repeat per scenario; for S5 to S8 toggle the
   beta switch in Settings or install `1.5.0` first.
4. Fill the "observed" column.

### Files read for this

`desktop/build/installer.nsh`, `desktop/package.json` (build config), `desktop/main.js`
(setupUpdates, installUpdate), `desktop/update-channel.js`, `desktop/internal.config.cjs`,
`src/ui.html` (update dialog), `src/daemon.mjs`, `src/supervisor.mjs`, `src/daemon-launch.mjs`,
`src/control.mjs` (`readState`), `src/util.mjs` (`sameProcess`), `src/java.mjs` (where java
is found), `rust/crates/spawnloft-lib/src/platform/windows.rs` (job object);
`app-builder-lib@26.15.3` `templates/nsis/{installSection.nsh, uninstaller.nsh,
include/allowOnlyOneInstallerInstance.nsh, include/installUtil.nsh}`;
`electron-updater@6.8.9` `out/{AppUpdater.js, NsisUpdater.js, providers/GitHubProvider.js,
providers/GenericProvider.js}`; the repository's release list (`created_at`, `published_at`).
