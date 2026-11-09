# Phase 0 findings

Internal, `v2` branch (PLAN-RUST-TAURI.md section 13). Each section names the plan item it
answers, what was established, how, and what is still a prediction waiting for a live run.
P0-F (the Tauri spike) is at the end.

## P0-E: experiments 4a and 4b (plan section 3 item 4, section 12 item 6)

Status, 2026-11-09: **complete.** The code reading is written up below, and both experiments
have run live on Victor's Windows desktop (Desktop-Main). 4a ran twice for the Node daemon and
twice for the Rust daemon (00:27 to 00:50 UTC); 4b ran all seven release-ordering scenarios
against the scratch repository `joogiebear/spawnloft-update-test` (00:53 to 01:15 UTC; the
repository is Victor's to delete, nothing was created on the real repository). The result
tables carry the observations; the "Running the experiments" section is the runbook. Raw files
(process snapshots every 500 ms, installer child-process log, feed log, state and status after,
Chromium net logs of every update check, `4b-results.md`) are in `S:\VMs\spawnloft-win\p0e\`
on Desktop-Main. The machine was left on `2.0.0-internal.16` with no servers running.

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
     handler runs, so neither stops its server gracefully first. What happens to the JVM then
     differs: under the **Node daemon it dies with the daemon**, because libuv on Windows puts
     every non-detached child in a job object with `KILL_ON_JOB_CLOSE` (`daemon.mjs` spawns
     java with `detached: false` on Windows; the "JVM is detached and outlives us" comment in
     that file is true only on macOS and Linux). That is a hard kill of a server that was never
     asked to save. Under the **Rust daemon the JVM survives**: its Job Object is created without
     `KILL_ON_JOB_CLOSE`, so the server keeps running with no daemon.
   - After the update the state file still says `running` with a dead `daemonPid`. Node:
     `javaPid` is dead too, `readState` reports **`stale`**, the server shows as stopped with
     no record of why. Rust: `javaPid` alive, `readState` reports **`orphaned`**, `start` and
     `stop` refuse, and the only way out is `spawnloft kill <name>`.
2. **The panel's update dialog promises the opposite.** `src/ui.html` says "Running servers
   keep running — SpawnLoft supervises them as separate processes", and `desktop/main.js`
   repeats "Servers survive (detached daemons)". **Confirmed false on Windows by the live run**
   (Node daemon, 2026-11-09): the server was terminated with no save. Since Victor decided on
   2026-11-08 to ship no further 1.x releases, the fix lives in the 2.0 installer (see Q14).
3. **Locked files are not the problem.** The old uninstaller moves every file out of the
   install folder with `Rename` (`un.atomicRMDir`), which Windows allows on a running image;
   only a rename that fails aborts the update ("File is busy"). A daemon that somehow survived
   the kill (elevated, or another user's) would keep running from a file moved to
   `%TEMP%\ns*.tmp\old-install\`, which NSIS then fails to delete on exit. So the installer's
   policy is "kill", never "fail".
4. **Release ordering (4b) is decided by commit dates, not publish order or version.
   Confirmed live in all seven scenarios (2026-11-09), plus one surprise: a pushed tag with no
   finished release breaks every beta install's check until the release is complete.**
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

**Result table (predictions replaced by the live observations):**

| Step | Node daemon (1.6.0-beta.400 updated to .407, Victor's desktop, 2026-11-09 00:27 UTC) | Rust daemon (2.0.0-internal.N updated by the .407 installer run by hand with the updater's arguments) |
| --- | --- | --- |
| Panel quits | gone (`CloseMainWindow`, the on-quit install fired) | gone (`CloseMainWindow`; updates are off in internal builds, so nothing fired); daemon and JVM still alive 10 s later |
| Installer's first `FIND_PROCESS` | not visible from outside; the kill followed 5 s after the quit | not visible; see "Which check ran" below |
| Daemon after the install | **killed**: pid 25540 last seen 18:27:19.669 local, gone at 18:27:20.301 | **alive**: pid 27916 present in all 67 snapshots across the install (18:31:23 to 18:32:05), running from `%TEMP%\nsoCFF.tmp\old-install\resources\bin\spawnloft-core.exe` after the uninstaller's rename; Windows still reports its original path |
| JVM after the install | **killed in the same 0.6 s window** (pid 27948, child of the daemon) | **alive** (pid 28080) |
| Server console | **no Stopping or Saving lines**; last line 2 minutes before the update | no new lines during the update; a later `stop` through the surviving daemon (with the 1.6.0-beta.407 CLI) produced "sending stop to console", "java exited code=0" and 10 Stopping/Saving lines |
| `state.json` after | unchanged: `running: true`, daemonPid 25540, javaPid 27948; `status --json` says **`stale`**, `list` shows stale | unchanged and true: `status --json` says **`running`**, `list` shows 1m 36s uptime (`daemonExe` is `spawnloft-core.exe`, which `sameProcess` still matches) |
| Panel after | **did not relaunch**: the on-quit path is `install(true, false)`, no `--force-run` (`BaseUpdater.js` line 88) | relaunched 19 s after the installer started (`--force-run` was passed by hand, as `quitAndInstall(true, true)` does) |
| Installer duration | uninstall key showed 1.6.0-beta.407 9.7 s after the quit | exit 0 after 19.5 s |
| Leftovers | none new in `%TEMP%\ns*.tmp`; `mcctl-desktop-updater\pending\` kept the .407 exe and `update-info.json` | `%TEMP%\nsoCFF.tmp\old-install\` kept (it holds the running binary); after the stop the folder can be deleted |
| Also killed | the **MCP server** `SpawnLoft.exe resources\core\spawnloft.mjs mcp` left behind by the Claude desktop app, already by the .400 install that preceded the test: anything under the install folder is "the running app" | |
| Differential download | the .400 blockmap was never published (404), so a full 112 MB download; harmless | |

**Which check ran (settled by a second run with the helper processes logged).** The
installer on Victor's machine took the **PowerShell path**, not the image-name fallback: both
the installer and the old uninstaller each spawned the three PowerShell probes
(`Get-Command Get-CimInstance`, the execution-policy test, then the
`Win32_Process | ? Path.StartsWith($INSTDIR)` find). Neither spawned any `Stop-Process`,
`taskkill` or `cmd.exe`. So the find step reported nothing to kill, and the Rust daemon and its
JVM lived. Run by hand at the same moment, that identical path query **does** match
`spawnloft-core.exe` under the install folder, so the query is capable of seeing it; the
installer's own find did not act on it. The exact reason the find returned empty at install
time is the one loose end (candidates: the old uninstaller had begun moving files so the
daemon's reported path no longer started with the install folder, or the probe could not read
the core process's path); it does not change the outcome, which reproduced on both runs.

The practical conclusion holds either way and is now backed by two live runs: **today's
electron-builder installer does not kill `spawnloft-core.exe`.** The earlier worry that the
path check would catch the renamed Rust binary did not happen in practice. Because a different
machine (no PowerShell, a `Restricted` policy) would fall to the image-name branch, which also
spares `spawnloft-core.exe`, both branches leave the Rust core alone. The Node daemon dies
under both branches, since it runs as `SpawnLoft.exe`.

**Extra observation.** The relaunched 1.6.0-beta.407 panel carried the stock GitHub
`app-update.yml` and within a minute downloaded and, on its next quit, installed
1.6.0-beta.413 from the real releases, while a `spawnloft-core` daemon from the internal build
had just been stopped. Nothing broke, but it shows how quickly a test install re-attaches to
the public feed once `app-update.yml` is back to stock.

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

**Scenario table, as run (2026-11-09, test install 1.6.0-beta.407 with `app-update.yml`
pointed at the scratch repository; "fetched" is the `releases/download/<tag>/*.yml` the updater
requested, read from a Chromium `--log-net-log` of each check):**

| # | Releases in the scratch repo (atom order = tagged commit date, newest first) | Install | Predicted | Fetched (observed) | Match |
| --- | --- | --- | --- | --- | --- |
| S1 | `v2.0.0-beta.1` (newer commit), `v1.6.0-beta.450` (older commit) | beta.407, betas on | `2.0.0-beta.1` (first entry) | `v2.0.0-beta.1/beta.yml` | yes |
| S2 | S1 plus `v1.6.0-beta.460` on a commit newer than both, published last | same | `1.6.0-beta.460` (first entry again) | `v1.6.0-beta.460/beta.yml` | yes |
| S3 | S2 but `v2.0.0-beta.1` re-tagged on a commit newer than `.460` | same | `2.0.0-beta.1`: publish order is irrelevant, commit date decides | `v2.0.0-beta.1/beta.yml` | yes |
| S4 | S3 plus `v2.0.0-next.1` on the newest commit (`next.yml` only) | same | `2.0.0-beta.1`: `next` is a custom channel, skipped | `v2.0.0-beta.1/beta.yml` | yes |
| S5 | S4 plus stable `v1.6.1` and `v2.0.0` (newer commit) | beta.407, **betas off** | `2.0.0` (GitHub's `latest`) | `v2.0.0/latest.yml`, via `releases/latest` → `tag/v2.0.0` | yes |
| S6 | S5 plus stable `v1.6.2` on the newest commit | same | `1.6.2` (now GitHub's `latest`) | 20 s after publishing: **`v2.0.0/latest.yml`** (stale web redirect); 2.5 min later: `v1.6.2/latest.yml` | yes, after the cache expired |
| S7 | S6 with `v1.6.2` set `make_latest: false` and `v2.0.0` `make_latest: true` | same | `2.0.0` | `v2.0.0/latest.yml` (20 s and 2.5 min after the edit) | yes |

Every check then requested `SpawnLoft-Setup-<version>.exe` and its `.blockmap` from the chosen
tag, which returned 404 as intended (the yml copies carried edited `version:` fields and a wrong
`sha512`); nothing downloaded or installed. The planned S5 variant (a stable install with betas
turned on taking the `-next` entry and failing on the missing channel file) was not run; it
follows from the code path in step 2 above and from S4, and it is avoided by the rule below
(no custom channels on the real repository). S8 (`v2.0.0` with `make_latest: false`) is the
mirror image of S7 and was not run either.

**What the live run added to the reading:**

1. **Bare tags appear in `releases.atom` too**, newest commit first, with or without a release.
   The first S1 attempt had all seven tags pushed before any release existed; the updater took
   the first entry (`v1.6.2`, no release, no yml) and the check failed with a 404 on its
   `beta.yml`. After deleting the tags without a release and pushing each tag right before
   its release, every scenario matched. **Consequence for real releases:** a pushed tag with no
   release, a draft being filled, or a release whose yml has not finished uploading, on a
   commit newer than the newest beta, breaks every beta install's check ("Update failed")
   until the release is complete. CI already tags and uploads in one job, but a manual tag
   push or a stalled upload reproduces this.
2. **`/releases/latest` on `github.com` lags the API by a couple of minutes.** 20 s after
   `v1.6.2` was published the API already answered `v1.6.2`, while the web redirect the updater
   follows still pointed at `tag/v2.0.0`; about 2.5 min later it had caught up. A `make_latest`
   flip was visible within 20 s. Harmless, but a "check for updates" right after a publish may
   show the previous stable once.
3. **Asset `download_count` is no signal for a single check:** it lagged by more than ten
   minutes and the repository, being public, was fetched from elsewhere once. Net logs are
   the way to read which yml a check used.
4. Tags on the test machine are annotated (its git config refuses lightweight tags); GitHub's
   `created_at` still followed the tagged commit's committer date, as the docs say.

**Release rules that follow (for the time when 2.0 goes public):**

- Nothing 2.0 is tagged or released on `joogiebear/spawnloft` until "push to beta". A
  `v2.0.0-beta.1` release on a commit newer than the last 1.6 beta is offered to **every**
  1.6 beta install at once (S1, S3), whatever is published after it, unless a later 1.6 beta
  sits on a newer commit (S2). Commit date, not publish time, is the order.
- No `-next`/`-internal` tags or releases on the real repository: beta installs skip them (S4),
  but a stable install with the beta switch on takes the first entry regardless of channel and
  fails on the missing `latest.yml`. Internal builds stay on `rust-internal.yml` artifacts.
- Tag and publish atomically (CI does), never push a tag by hand ahead of its release, and
  keep drafts out of the feed until the yml is uploaded (a draft is not in the feed; a
  published release with a missing yml is).
- Stable 1.x installs follow `make_latest` (S5 to S7): publishing `v2.0.0` with
  `make_latest: false` keeps stable 1.x on 1.x until the flag flips, which is the lever for a
  staged 2.0 rollout to stable users; beta users cannot be held back that way.

### Q14 recommendation: Windows updates while servers run

Based on the reading above and confirmed by the live runs (4a: the Node daemon and its JVM
die, the Rust daemon and its JVM survive; 4b: commit-date ordering, `next` skipped,
`make_latest` honoured). Victor decided on 2026-11-08 that no further 1.x releases ship, so
item 1 is kept as the record of what a 1.7 bridge would have been; what actually ships is
items 2 to 4, all in 2.0.

1. **1.x bridge (not shipping; recorded for the reasoning):** the panel's "Running servers keep
   running" text is false on Windows today. Making it true would have been cheap:
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
2. **1.x → 2.0 handover (the 2.0 NSIS template, P0-F), the decision:** **the 2.0 installer
   stops the running servers gracefully before it runs the old 1.6 uninstaller, and 2.0 offers
   to restart them on first launch.** Reason: at the handover the daemons are 1.x Node daemons
   running as `SpawnLoft.exe`, and the installed 1.6 uninstaller (which the 2.0 installer must
   run, `/S --updated`) kills every process under the install folder, JVMs included, with no
   save (4a, Node run). Since no 1.7 ships, the stop cannot live in 1.x; it lives in the 2.0
   installer and must work silently too (the updater runs the installer with `/S`):
   - before the old uninstaller: run the installed 1.6 CLI,
     `"$INSTDIR\SpawnLoft.exe" "$INSTDIR\resources\core\spawnloft.mjs" stop --all --json`
     (the 1.6 CLI speaks its own pipe protocol, so no reimplementation), with a timeout of a
     few minutes for large worlds, and record what was running in
     `%LOCALAPPDATA%\mcctl\run\restart-after-update.json`; if the CLI is missing or fails, fall
     back to a graceful console close and then wait for the JVMs under the install folder to
     exit before continuing, never `TerminateProcess` on a JVM.
   - then the old uninstaller, then the 2.0 files; 2.0's first launch reads the list and asks
     "start these again?" (silent mode: start them again without asking).
   - the 2.0 installer's own `customCheckAppRunning` matches **only the panel** (full path
     `$INSTDIR\SpawnLoft.exe` with no `daemon` argument) and never kills a daemon or a JVM;
     in the handover case there are none left by then.
   - P0-B's "never install a major on quit" item stays as belt and braces for the 1.6 side
     that is already in the field: 1.6 installs betas on quit, so the 2.0 beta will be
     installed on quit by 1.6; the stop in the installer is what makes that safe.
3. **2.x → 2.y (Tauri updater):** rename-under-running as the plan says, now **demonstrated**:
   the Rust daemon kept supervising its server from a renamed binary through a whole
   uninstall-and-reinstall cycle and stopped it cleanly afterwards. The custom template renames
   `SpawnLoft.exe`/`spawnloft-core.exe` to `*.old.exe` when in use (or lets NSIS move them, as
   electron-builder's uninstaller does today), the daemons keep running, the next start cleans
   up. The custom check matches the panel by full path only. One caveat from the run: the
   surviving daemon is the **old** build's daemon talking to the **new** build's CLI and panel,
   so the control protocol must stay compatible across adjacent 2.x releases (the `protocol`
   field in `ping` is for exactly this).
4. **Job Object flag:** keep the Rust daemon's job **without** `KILL_ON_JOB_CLOSE`. With it a
   killed daemon takes the JVM down hard, mid-save, which is exactly what the Node daemon does
   today through libuv's own job; without it the server survives and is reported `orphaned`,
   which is recoverable by `kill` and loses at most one autosave interval. The right fix is not
   killing the daemon (item 1), not killing the server with it.
   If a later decision wants "no orphans ever", add the flag together with a daemon-side
   handler that stops the server on `CTRL_CLOSE`/console events; `TerminateProcess` gives no
   such chance, so the flag alone is a world-corruption risk.

What the live runs settled: the Node daemon and its JVM die (item 2 is mandatory, not
optional); the Rust daemon and its JVM survive today's installer (item 3 works without a
custom check, but the custom check ships anyway so that survival stops depending on which
branch of electron-builder's probe runs); the job-object reading held (item 4 stands). Open
loose end, not blocking: why the installer's PowerShell find reported nothing for
`spawnloft-core.exe` while the same query by hand matches it (most likely the old uninstaller
had already moved the files when the probe ran); the custom check removes the dependency on it.

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

**4b (as run):**

1. Victor created the empty public repository `joogiebear/spawnloft-update-test`. Releases,
   tags and feeds lived only there; the repository is his to delete.
2. Per scenario: an empty commit with a chosen `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE`, its tag
   pushed **right before** its release is created (never ahead of it, see finding 1), the
   release created with the prerelease flag and `make_latest` the table says, and a copy of
   an existing signed beta's `beta.yml`/`latest.yml` uploaded with `version:` edited and a
   wrong `sha512`.
3. On the test install (1.6.0-beta.407 over internal.16): `app-update.yml` set to
   `provider: github, owner: joogiebear, repo: spawnloft-update-test`,
   `%LOCALAPPDATA%\mcctl-desktop-updater\pending\` emptied, then
   `SpawnLoft.exe --log-net-log=<file>` for 40 s per check and the fetched
   `releases/download/<tag>/*.yml` read from the net log (download counts are useless for
   this). The beta switch in Settings turned off before S5.
4. Internal.16 reinstalled over the result.

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

## P0-F: the Tauri 2 shell spike (plan section 3 item 5, section 12 item 7)

Status, 2026-11-09: **the CI part is done and green.** `.github/workflows/tauri-spike.yml` run
42541789349 (commit 30ef14a; the same checks passed in run 42541115034) built spike-a
(2.0.0-spike.1) and spike-b (2.0.0-spike.2) with the custom NSIS template, installed the signed
1.6.0-beta.413 setup on `windows-latest`, measured it, handed over to spike-a the way
electron-updater runs an NSIS update, measured the Tauri shell, ran one Tauri updater cycle
spike-a to spike-b, and uninstalled. Every check passed. (Its final step reported exit code 1
after all six uninstall checks passed: pwsh ended the step with the last `schtasks` exit code.
Fixed in 959d7b9.)

**The signed run on Victor's PC passed too (2026-11-09 01:28 UTC, details below).** Still to
run: the Squirrel.Mac acceptance test on the Mac mini (same bundle id, signed and notarized,
offered to an installed signed beta). Victor on the window at 1440p and 4K: "It looks ok right
now."

Q24 (does the plugin install `.deb` and `.rpm` on Linux) was not checked: the spike builds NSIS
only.

### What the spike is

- `spawnloft-core ui` (`rust/crates/spawnloft-lib/src/panel.rs`): a 127.0.0.1 endpoint that
  starts the Node panel (`spawnloft.mjs ui --port 0 --no-open`) and proxies to it, with ui.mjs's
  Host/Origin rule applied before forwarding. It exits when its stdin closes.
- `SpawnLoft.exe` (`rust/crates/spawnloft-shell`): a Tauri 2.12.5 window. It spawns
  `resources\bin\spawnloft-core.exe ui --port 0 --exit-with-stdin` and navigates to the address
  it prints. No Tauri API is exposed to the page. Single instance. It accepts the argv
  compatibility form (`SpawnLoft.exe <...>\mcctl.mjs <command...>`), which it forwards to Node,
  so 1.x task shims, server launchers and MCP configs keep working.
- `windows/installer.nsi`: a fork of tauri-bundler 2.10.4's template, changes marked
  `SPAWNLOFT:`, upstream copy beside it. It installs into `%LOCALAPPDATA%\Programs\SpawnLoft`
  under the electron-builder uninstall key `bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3`, and takes
  electron-updater's flags (`--updated /S --force-run`) as well as Tauri's (`/P /UPDATE /R`).
  It removes 1.x with 1.x's own uninstaller (`/S /KEEP_APP_DATA --keep-shortcuts --updated`),
  verified by `app.asar` being gone, and keeps the shortcuts and `InstallLocation`.

### Numbers (windows-latest runner, run 42541789349)

| | 1.6.0-beta.413 (Electron) | spike (Tauri 2) |
|---|---|---|
| Installer | 112,672,360 B (107.5 MiB) | 3,357,667 B (3.2 MiB) |
| Update download (spike-b) | | 3,355,206 B |
| `SpawnLoft.exe` | 246,708,496 B | 6,904,320 B |
| Start to panel loaded, runs 1 / 2 / 3 | 1196 / 727 / 659 ms | 528 / 518 / 488 ms |
| Same, previous run (42541115034) | 1016 / 496 / 497 ms | 437 / 451 / 1785 ms |
| Memory, whole tree, working set / private | 350 MB / 169 MB (5 processes) | 405 MB / 184 MB (11 processes) |
| of which the shell (exe + WebView2 / Electron) | 350 MB / 169 MB, panel inside | 331 MB / 120 MB |
| of which the panel behind it | (in Electron's main process) | 73 MB / 64 MB: `spawnloft-core` 5.7 / 1.4, `node` 54 / 60, two `conhost` |

How it was measured (`spike/measure.cjs`): start time runs from spawning the exe to the panel
page's load event (Electron through Playwright; Tauri through the webview's page-load-finished
event). Memory is the summed process tree 15 s after the panel loaded, empty panel, no servers.
Runners have no GPU and vary from run to run (see the 1785 ms outlier), so treat these as
proportions, not as Victor's numbers.

Against section 0's promises ("installer 100 MB to 15 to 25 MB, start under a second, shell
memory about halved"):

- **Installer: better than promised.** 3.2 MiB, against 15 to 25. But the spike ships the Node
  core as files and uses the system Node; the 2.0 package adds the Rust core in its final form
  and the panel assets, and WebView2 comes through the bootstrapper. A few MiB more, not 15.
- **Start: met.** About 0.5 s warm and cold, against 0.5 to 1.2 s for 1.6.
- **Shell memory: not halved. Correct the promise.** WebView2 costs about what Electron's
  Chromium costs: its six processes are 303 MB working set and 116 MB private. The shell on its
  own is 331 / 120 MB against Electron's 350 / 169 MB with the panel inside, so about 30 % less
  private and the same working set. Today the Node panel behind the shell adds 73 / 64 MB, so
  the spike as a whole uses a little more than 1.6. When the Rust core serves the panel itself
  (step 2), the panel's part should drop to a few MB, and the total should come out at about
  125 MB private against 169, a quarter less. Suggested wording for section 0: "shell memory
  about a quarter lower; working set about the same (WebView2 is Chromium too)".

### The handover from 1.6 (`spike/handover.ps1`)

1.6 was installed per user. Its own CLI adopted a stopped server and added a daily backup task
(`\mcctl\spike-backup`, shim `SpawnLoft.exe "...\resources\core\mcctl.mjs" task run
spike-backup` under `ELECTRON_RUN_AS_NODE=1`), and the task ran once (result 0, 2 backups).
Then `SpawnLoft_2.0.0-spike.1_x64-setup.exe --updated /S --force-run` ran, the command line
electron-updater's NsisUpdater uses. It took 2.6 s and exited 0. After it:

- `SpawnLoft.exe` was the Tauri shell (product version 2.0.0-spike.1), `resources\app.asar` and
  `Uninstall SpawnLoft.exe` were gone, and `uninstall.exe`, `resources\bin\spawnloft-core.exe`
  and `resources\core\mcctl.mjs` were present;
- the uninstall key was the same, now with DisplayVersion 2.0.0-spike.1 and
  `UninstallString "...\uninstall.exe"`, `InstallLocation` was unchanged, and no Tauri-default
  key or folder appeared;
- the Start menu and desktop shortcuts were kept and opened the new exe;
- **the 1.x task was still registered and ran green through the Tauri exe** (result 0, 2 to 4
  backups), through the argv compatibility form, with the shim text unchanged;
- `--force-run` started the app (`startedAfterHandover: true`).

Not covered in CI: the publisher-name check electron-updater makes before it runs the
installer. The runner's spike is unsigned, so this run started the installer the way NsisUpdater
does after that check. Victor's PC run (next section) covers it.

Uninstall (`handover.ps1 -Uninstall`, silent): exit 0, exe removed, uninstall key and install
key removed, the scheduled task removed by `spawnloft uninstall --yes`, data kept.

### The signed handover on Victor's PC (Desktop-Main, 2026-11-09)

The real electron-updater path, publisher check included. Raw files are in
`S:\VMs\spawnloft-win\p0f\` on Desktop-Main.

- The CI-built `SpawnLoft_2.0.0-spike.1_x64-setup.exe` was Authenticode-signed with the release
  profile (Azure Trusted Signing, account Mcctl, profile MCCTL; signer CN "victor zemeckis",
  SHA256, Microsoft timestamp). Only the outer setup was signed; the inner exe stayed unsigned.
- The signed `SpawnLoft-Setup-1.6.0-beta.413.exe` was installed over 2.0.0-internal.16, its
  `app-update.yml` pointed at a loopback generic feed (`publisherName: victor zemeckis`), and a
  test server and a daily backup task were made with the 1.6 CLI (first run: result 0).
- 1.6 found 2.0.0-spike.1, fetched `latest.yml`, got a 404 for the blockmap (none published)
  and fell back to a full download (3,373,304 B). It then wrote `pending\update-info.json`.
  electron-updater 6.8.9's NsisUpdater only gets that far after `verifySignature` against
  `publisherName` passes; a mismatch deletes the file and raises
  `ERR_UPDATER_INVALID_SIGNATURE`. There is no log line to quote, because 1.6 sets
  `autoUpdater.logger = null` (`desktop/main.js`). **2.0 needs an updater log** if a release
  check is to show the publisher check.
- Victor pressed "Restart and update" (quitAndInstall, so `--force-run`). 1.6 was gone and the
  signed setup running at 01:27:59.465, DisplayVersion read 2.0.0-spike.1 at 01:28:01.893, and
  the Tauri `SpawnLoft.exe`, started by the setup itself, was running at 01:28:02.117: **2.65 s
  from the button to the new app.**
- Every check from the CI run passed again: same key with `UninstallString` on `uninstall.exe`,
  product version 2.0.0-spike.1, `app.asar` and the 1.x uninstaller gone, core and Node core in
  place, shortcuts on the new exe, no Tauri-default key, `InstallLocation` unchanged, the task
  still registered and **green through the Tauri exe (result 0, backups 2 to 4)**. The shell's
  core served the panel (`/api/instances` listed the test server) with six WebView2 processes.
- Restore: the internal.16 setup ran silently over the spike (exit 0, 4.3 s). Electron-builder
  called the spike's `uninstall.exe` with `--updated`, which left the task and the data alone;
  the task ran green under internal.16 afterwards (backups 4 to 6). So the 2.0 uninstaller's
  update mode also works for a rollback from 2.0 to a 1.x-style install.
- The installed 1.6 calls its updater cache `spawnloft-desktop-updater`, not
  `mcctl-desktop-updater` as the P0-E runbook says.

### Q21: Tauri's updater plugin or our own

**Answer: use the plugin (tauri-plugin-updater 2.14.1) with the custom template.** One real cycle
ran on Windows (`spike/update-cycle.ps1`):

- **A feed whose signature belongs to another artifact is refused.** The plugin downloaded
  spike-b, failed with "The signature verification failed" and installed nothing. The version
  stayed 2.0.0-spike.1. Note: the download-finished callback runs before the signature check,
  so "downloaded" in a log does not mean "verified". The spike's log line said "downloaded,
  verified" and is corrected.
- **The right feed updates.** Check, download (3.3 MB from a loopback feed), verify, then the
  plugin runs our NSIS installer with its passive flags (`/P /UPDATE /R`) and exits. 3.1 s from
  launch to the uninstall key showing 2.0.0-spike.2. `SpawnLoft.exe` was the new build, still in
  the 1.x folder under the 1.x key, and **the app came back up afterwards** (`/R`,
  `restartedAfterUpdate: true`).
- `on_before_exit` stopped `spawnloft-core` before the installer replaced it.

So the install-mode flags and the custom template work together, which was the open question.
Two things the plugin does not give, as rev 3.1 said, stay as own code on top of it: a signed
envelope around the feed JSON (the feed itself is unsigned; only the artifact is signed) and a
kept-previous-artifact rollback. For 2.0 also: `requireSignedVersion`-style checks, no
downgrades from a feed (Fable review M2), and the env-var feed override compiled out.

### Q22: binary topology

**Confirmed as written:** two binaries. `SpawnLoft.exe` (the shell, GUI subsystem) and
`spawnloft-core.exe` (console, at `resources\bin\spawnloft-core.exe`, as during steps 0 to 2).
The shell spawns the core and talks to it only over 127.0.0.1 HTTP, and the core is the only
thing the page sees. Tauri's running-app check (RestartManager on the full path of
`$INSTDIR\SpawnLoft.exe`) does not match the core. P0-E found the same for electron-builder
26.15.3's check after the second Rust run (above). The update replaced the core binary
in place after `on_before_exit` stopped it; the template also renames a held core aside
(`spawnloft-core.old-<tick>.exe`). That path is in the template but was not forced in this run.

### Review (Fable) and what is deferred to 2.0

The NSIS template and the updater use were reviewed before the CI runs. Fixed in 50e9e07: 1.x
recognised by its uninstaller's file alone, so a 1.x rollback is handled; 1.x removal counted
only when `app.asar` is gone; failures exit with code 2; `--updated` and `--force-run` read
from the parameters, not the whole command line; no directory choice when replacing 1.x; a core
that cannot be moved aside aborts the install.

Deferred to 2.0, not fixed in the spike:

- **H3:** uninstall runs `spawnloft uninstall --yes` through the system Node. Without Node, the
  tasks stay registered. 2.0's uninstall must run the Rust core.
- **M2:** a feed can offer a lower version. 2.0 needs signed-version checks, no downgrades, and
  no env-var feed override.
- **M3 and L4:** RestartManager can kill argv-compatibility wrappers, and a killed shell can
  orphan the Node panel. Use a job object for the shell's children.
- **L5:** proxy read timeouts in `spawnloft-core ui`, and a signed uninstaller.

### Caveats

- The runner installers are unsigned, the updater key was thrown away after the run, and the
  feed was plain HTTP on loopback (`dangerousInsecureTransportProtocol`, spike only).
- The spike needs Node.js on the machine, for the panel and for the argv compatibility form.
  The job puts the runner's Node on the user PATH, as a user's Node install would be. 2.0 removes
  that dependency.
- Two script bugs held the job until fixed: PowerShell's `&` does not wait for a GUI-subsystem
  exe (49cbb6c), and `Start-Process -Wait` waits for every descendant, including the daemon the
  1.6 CLI starts and the app `--force-run` launches (184fbeb).
