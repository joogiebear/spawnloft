# SpawnLoft 2.0: review of `v2` for public-beta readiness

2026-11-13, against `v2` at 5bb0266 (#193). Companion files: [CHECKLIST.md](CHECKLIST.md) (what
has to be true before "push to beta") and [RELEASE-NOTES-DRAFT.md](RELEASE-NOTES-DRAFT.md).

## 0. Verdict

**Not ready to publish yet. The app itself is close; the release path is not.** The code a user
runs (installer, handover, updater trust chain, shell, packages) held up well: no remote security
hole was found, the signature chain is sound, and no path was found where the handover kills a
Minecraft server. What stands between `v2` and `2.0.0-beta.1` is mostly on the build side: there is
no macOS release build, nothing assembles the three platforms into one release, and the gate would
let a partial or wrongly keyed release through. On the product side one handover bug can silently
switch a user's scheduled tasks off for good, and it should be fixed first.

Six blockers remain open (section 2; the seventh, the Node bump, merged while this was being
written). Eight small bugs were fixed in this branch (section 1),
three of which would have been blockers.

How the review was done: four independent read-throughs (security; upgrade from 1.5.0; update and
rollback; CI and release gate), then every finding listed as a blocker or fixed here was checked
again against the code by the main reviewer. Findings further down the list were spot-checked;
where one rests on a single read it says so. Tests run locally at the end: `cargo test` for
`spawnloft-lib` and `spawnloft-core` (163 pass), `cargo clippy -D warnings` and `cargo fmt --check`
clean, root suite 1249 pass / 7 skipped / 0 fail, `desktop` suite 78 pass. Nothing was run on
Windows or macOS, and nothing was installed anywhere.

CI on `v2` at 5bb0266 when the review started: `rust-internal`, `installer-mac` and
`installer-linux` green; `installer` and `updater` still running. `installer-mac` failed once on
f964b7f and passed on the next push; that failure was not investigated (the notarisation stapler
is a known flake).

## 1. Fixed in this branch

| # | What was wrong | Fix |
| --- | --- | --- |
| F1 | **Updates could not download on a slow line.** Artifact downloads used the feed client's 30-second end-to-end budget (`update/fetch.rs`). A 30 MB installer needs about 8 Mbit/s to fit; below that the download failed every six hours with only a log line. | Artifact downloads have their own client: 60 s stall timeout, one-hour total. New `Fetch::download`. |
| F2 | **`spawnloft update apply` always failed on Linux.** Linux packages are published without a minisign signature by design, and `verify_artifact` refused anything unsigned, after downloading it. `installCommand` was therefore never offered. | A `linux-*` artifact is bound by the signed envelope's size and sha512. Every other platform must still be signed (tested). |
| F3 | **A rollback of more than one step deleted its own installer.** `store_artifact` pruned to the two highest cached versions right after writing, so a lower rollback target was removed before it ran, with the hold already written. | The version just stored is never pruned (tested). |
| F4 | **A macOS build made with `release.pub` could not verify any update.** `mac-config.mjs` wrote the two-line key file into the plugin's `pubkey` without the base64 step the Windows and Linux configs do. CI never saw it because CI passes the base64 form. | Same conversion as `installer-config.mjs`. |
| F5 | **A signed Windows build could silently trust a test key list.** `release-windows.mjs` handed the terminal's whole environment to `cargo build`; a leftover `SPAWNLOFT_UPDATE_PUBKEYS` is compiled into the core with only a warning. | The three test switches are stripped from the build environment. The script and `SIGNING-WINDOWS.md` also said a throwaway-key build "trusts only that key"; it does not (the core always trusts the compiled-in release keys), and the text now says so. |
| F6 | **A pre-beta build number could be published.** `2.0.0-beta.1001` passes every publish check; afterwards the ordering rule would refuse `2.0.0-beta.1` for good. | `release-publish.mjs --confirm` refuses `beta.1000` and up unless `--allow-prebeta-number` (tested; the dry run is unaffected). |
| F7 | **On Linux the "still run by SpawnLoft 1" banner never showed.** After a package upgrade `/proc/<pid>/exe` reads `... (deleted)`, so the Rust reader took the 1.x daemon for dead and reported its server as orphaned. | The suffix is dropped, as the Node reader already does (tested). |
| F8 | `adopt` accepted a jar path that climbs out of the adopted folder (`../other/x.jar`). `ci.yml` was the only workflow without a `permissions` block. | The jar must be inside the folder (tested). `contents: read`. |

## 2. Blockers, ranked

Each of these should be closed, or consciously waived by Victor, before `2.0.0-beta.1`.

*Update: B3 to B6 are addressed in the release tooling (`installer-mac.yml` release job,
`installer-linux.yml` version input, `desktop/release-assemble.mjs`, the release-mode gate and
`desktop/build-trust.mjs`; the sequence is in [../RELEASE.md](../RELEASE.md)). What is left of
them is the first real run on the machines.*

*Update: B1 and B2 are fixed (#198). The handover record is a journal written before each change,
an unfinished one is taken over by the next attempt, put back by `handover restore`, and put back
at the next sign-in; the installer restores when an install fails, and a WebView2 failure over 1.x
no longer aborts. Installer scenarios s10 and s11 cover both. What is left is the hardware run
(a real shutdown mid-stop; a PC without WebView2 and without network).*

**B1. An interrupted handover leaves scheduled tasks disabled for good and forgets the servers it
stopped.** `handover/mod.rs:579` disables the `\mcctl` task folder before the stops start, but
which tasks were disabled lives only in memory until `run_stop` returns
(`handover_cmd.rs:175`). If the installer dies in between (the person quits the app and shuts the
PC down, which is exactly the install-on-quit path; power loss; Task Manager), 1.x is still
installed, the tasks are off, and the stopped servers are in no record. The next attempt reads
only *enabled* tasks (`tasks.rs:76-81`), so it never learns what to turn back on. Backups and
restarts then stop running, silently. Fix: write the record right after `disable_tasks` and after
each stop, and have the next `run_stop` take over an unfinished record younger than 24 hours.
About 40 lines and a test. *Larger than a small fix, so not done here.*

**B2. An installer abort after the stop leaves servers down (no `.onInstFailed`).** In UI mode the
stop runs before the WebView2 section, which `Abort`s when the bootstrapper cannot download
(`installer.nsi:935,967`). A section abort never reaches `SpawnLoftUserAbort`, and the template has
no `.onInstFailed`, so nothing restarts the servers or re-enables the tasks. The design (2.6) says
a failed WebView2 bootstrapper must not stop the install at all. Fix: an `.onInstFailed` that runs
`RestoreLegacyServers` or `handover resume` by mode, and a non-fatal WebView2 failure over 1.x.
Small, but it is NSIS and needs the Windows installer workflow, so it is listed, not done.

**B3. There is no macOS release build.** Every mac build `installer-mac.yml` makes is a test build:
the core has the `internal-feed` feature (`:131`), trusts only that run's throwaway key (`:90`), the
shell allows an HTTP feed (`:142`), the version is fixed at `2.0.0-beta.901`, and no `.dmg` is made
(`--bundles app`). If such an artifact were handed to `release-feed.mjs` the gate would pass it, and
its users could never update. Needed: a release variant of the job (no feature, no key override,
`release.pub`, no `--feed-http`, `app,dmg`, a version input).

**B4. Nothing assembles one release from three platforms, and the gate does not notice a missing
one.** Windows is built and signed on Desktop-Main, Linux in `installer-linux.yml` (release-grade
packages, but `VERSION` is fixed at `2.0.0-beta.901` with no input), mac nowhere (B3). No script or
runbook runs `release-feed.mjs` once over all of them with the real key. `release-gate.mjs:219`
only requires that the envelope names *a* platform, so the Windows-only folder
`release-windows.mjs` produces would publish as a complete release. 1.x beta installs on mac and
Linux would then fail their update check on the missing `beta-mac.yml` / `beta-linux*.yml`, and
2.x installs there would find no target. Needed: version inputs on the mac and Linux workflows, an
assembly step, a required platform set in the gate with an explicit `--partial` escape, and the
sequence written down.

**B5. The publish step re-checks less than the build did.** `release-publish.mjs:72` calls the gate
without `authenticodeCn`, `signed`, `runtime` or `checkLinuxPackages`, and off Windows the gate
turns Authenticode into a note (`release-gate.mjs:224-226`). An unsigned setup re-signed with the
real updater key would pass the publish gate on any machine; every 1.x Windows install checks the
publisher and would refuse that update forever. Fix: require the publisher check whenever a setup
is present and fail (not note) when it cannot be made; pass the Linux check when packages are
present. Small, but it changes the publish contract, so it is Victor's to approve.

**B6. Nothing proves a release build trusts the real keys and carries no test switch.** The gate
verifies the feed against `--pubkey` but never asks the binaries what they trust.
`spawnloft-core update status --json` already reports `keysOverridden` and `sources`. F5 closes
the accidental path on Windows; the check itself is still missing, and B3's builds are the case it
would catch. Needed in the gate: `keysOverridden: false` and the expected key ids for the core, the
`release.pub` key and no `dangerousInsecureTransportProtocol` in the shell.

**B7. Closed: the bundled Node was one security release behind (24.22.2).** #194 moved it to
24.22.3 and merged into `v2` as 35124db during this review. What is left is to see the three
installer workflows green on that commit.

Two process items belong beside the blockers because getting them wrong breaks 1.x users:

- **`desktop-preview.yml` still publishes a 1.6 beta on every push to `dev`.** If `2.0.0-beta.1`
  is published before `v2` is merged, the next `dev` push publishes a 1.x beta that is newer in the
  feed: beta users take it and skip 2.0, and the commit-date ordering rule is broken. Merge `v2`
  into `dev` first (the plan's step 10), and disable both Electron workflows in the Actions
  settings before publishing.
- **After the merge all 2.0 CI goes quiet on `dev`.** Every 2.0 workflow triggers on `v2` only and
  its jobs test `github.ref == 'refs/heads/v2'`. The merge PR has to add `dev` (and `main`) to
  those lists, or PRs into `dev` run only the Node tests.

## 3. A decision for Victor: the panel has no authentication for local programs

Not a regression (1.x behaves the same) and not reachable from a web page: the Host and Origin
checks stop browser CSRF and DNS rebinding, and that was confirmed with requests. But any request
*without* an Origin header is accepted (`src/ui.mjs:1388-1398`, `panel.rs:353`), so any program of
any account on the same machine that can reach 127.0.0.1 has the whole API. The reviewer confirmed
on Linux that an unauthenticated `POST /api/instances/adopt` followed by the files API reads a
file under another directory; `adopt` plus `start` runs a jar as the panel's user. The daemon pipe
and the private files are per-user, so the panel is the one gap in that model.

It matters on a shared family PC (fast user switching) or a multi-user Linux box, and little on a
single-user machine. The fix is a per-launch secret the core hands to the Node panel and the window
(about 100 lines across `ui.mjs`, `panel.rs` and the shell). Recommendation: fix before 2.0.0
stable, and say so in the beta notes; treat it as a beta blocker only if shared machines are a
target for the beta.

## 4. Should fix (before stable; the beta can ship with these if the notes say so)

Ordered by how much a beta user would feel them.

1. **"Delete app data" on uninstall removes the whole backups folder the user chose**
   (`src/uninstall.mjs:27-30`). If backups point at `D:\Backups` with other things in it, ticking
   the box deletes all of it. The file's own header promises the opposite. Fix: remove only the
   per-server subfolders SpawnLoft made, then the folder if empty. Small to medium; it is data
   loss, so do it early. Whether 1.5.0 behaves the same was not checked.
2. **The panel's update texts are wrong on Linux and about the hold** (`src/ui.html:14037-14140`).
   On Linux the Install button and the "SpawnLoft closes, swaps itself" dialog appear and end in a
   409 toast; `installCommand` (now populated, F2) is never shown. The hold banner says "Updates to
   X and newer are paused"; the hold blocks X and below. "Last checked" is stamped on a failed
   check too, so a failed check looks like "up to date". "Check your connection" is appended to
   signature and replay refusals. Small text and logic changes.
3. **No install outcome is recorded** (`shell/src/updater.rs:191-222`). If the Windows installer
   aborts, nothing relaunches the app or records why, and the same update is tried again on every
   quit with no limit. Design 5.5 step 8 (`installed-version.json`, exit code read back) is not
   implemented. There is no guided way back if a new version crashes on launch other than the CLI.
4. **Recovery after a handover depends on opening the window** (`shell/src/main.rs:216-245`). The
   design promises `doctor` reports the handover and `doctor --fix` resumes it; the Node core has
   no handover code. A user who never opens the panel after an interrupted resume keeps servers
   down.
5. **Switching channel does not withdraw a staged offer** (`update/api.rs:147-165`). Untick beta to
   avoid a staged beta, quit, and it installs anyway.
6. **Requests to install never expire** (`update/store.rs:228-237`). Click Install in a browser
   panel with no window; days later, two seconds after the window opens, it runs.
7. **Update discovery reads only the newest ten tags** unless that window is empty or a hop is
   needed (`update/mod.rs:436-442`). With several 1.x betas a day a stable user can fall outside
   it and be told they are up to date. Cannot bite before a 2.x stable exists. *(One read.)*
8. **The replay floor is one timestamp for all channels** (`update/policy.rs:130-138`). After a
   beta offer, switching to stable can refuse an older-dated stable as "replayed". Cannot bite
   before a 2.x stable exists. *(One read.)*
9. **`data-format.json` is never written** (design 8 step 1), and nothing reads the daemon's
   `protocol` from `ping`. Harmless while every release is format 1 and the protocol is unchanged;
   both must land before either changes.
10. **The installed shell honours `SPAWNLOFT_CORE_BIN` and `SPAWNLOFT_CORE_DIR`**
    (`shell/src/main.rs:193-211`), while the core deliberately ignores such overrides once a
    bundled runtime exists. A user-level environment variable makes the signed app run a foreign
    binary on every launch (persistence under the app's identity, no privilege gain). Small, but
    the CI window smokes rely on these variables, so it needs their workflow.
11. **The mac app claims macOS 11 as its minimum** (`mac-config.mjs:94`) while the README says 13
    and the bundled Node 24 most likely needs 13.5. *(From memory; check Node's own build notes.)*
12. **The gate does not compare every binary's version or the uninstaller's signature** except
    with `--installed`, which no automated step passes. Make the clean-VM installed-copy gate a
    recorded step.
13. **`test/workflows.test.mjs` no longer runs in CI** (it skips without js-yaml, and the job that
    installed it was retired).
14. **Leftovers to remove before the merge:** `tauri-spike-mac.yml` (superseded, still holds the
    signing secrets), the Electron packaging in `rust-internal.yml:537-692`, `desktop/release.mjs`.
    Trap: `release-windows.mjs:76-79` reads the signing settings from `desktop/package.json`
    `build.win.azureSignOptions`; move them before deleting the electron-builder config.
15. **Docs that are false for 2.0:** `desktop/PREVIEW.md` and `STABLE.md` are 1.x texts (a
    `mac-arm64.dmg` 2.0 does not build yet); README and CONTRIBUTING point to a "Tauri release
    workflow" that does not exist; `PLAN-2.0-REMAINING.md` A1 and A5 still say system Node and
    `RUNTIME_FORMAT` 1; `docs/RENAME.md` says the `mcctl.*` localStorage keys survive, which they
    do not under WebView2; `tauri.conf.json` still says `2.0.0-spike.0` (overridden at build).

## 5. Nice to have

- Machines on an internal build (`2.0.0-beta.1002`, `2.0.0-internal.N`) are told they are on the
  newest beta until 2.0.0 stable. They do not need an uninstall: Updates → "Reinstall a previous
  version" → `2.0.0-beta.1` works, then clear the hold. A 15-line "internal build" notice would
  make that obvious.
- An interrupted resume reports "did not start" for servers that are already running
  (`handover/resume.rs:107-122`).
- A task already mid-run, or a `start` task firing when nothing was running, can start a server
  the 1.x uninstaller's sweep then kills unrecorded (`handover/mod.rs:579`). Narrow; always
  disabling the folder in LegacyMode closes it.
- No lock on `update-state.json`; concurrent writers can lose an update. Self-heals at the next
  check.
- The Node core spawns `schtasks`, `taskkill`, `powershell` and `tar` by bare name on Windows
  (`src/schedule.mjs`, `supervisor.mjs`, `daemon.mjs`); a planted exe in the current folder could
  be picked up. `private-files.mjs` already uses the System32 path for this reason. *(Search order
  from memory; verify on Windows.)*
- The main panel page sends no Content-Security-Policy (the launcher page does).
- RCON is enabled on every created server and listens on all interfaces with a random 20-character
  password; the exposure warning only fires on Linux with a public address.
- Task shims break under a non-ASCII profile path (`C:\Users\Jürgen`); same as 1.x.
- Intel Macs get no notice (no Intel 1.5.0 exists; 1.4.x Intel installs already get nothing).
- A server that always needs more than 300 s to stop makes the silent update retry daily and never
  finish, without telling anyone (accepted by design Q-B).
- Actions are first-party only but pinned by tag, not by commit; the mac signing secrets have no
  environment or branch restriction; test builds are signed with the real Developer ID and
  uploaded as artifacts.

## 6. What was checked and held

Security: panel and proxy bind to 127.0.0.1 only; browser CSRF and DNS rebinding are refused (Host
loopback, Origin equal to Host with port); no state-changing GET; the MCP server is stdio; the
databases bind to loopback; OAuth uses state and PKCE and no route returns tokens. The Tauri window
has an empty static capability, a run-time capability for the exact panel origin, nine commands
that each re-check the live URL, a navigation guard and https-only external opens. The updater
verifies the envelope and the artifact with compiled-in keys only, binds file name and version in
the trusted comment, requires the GitHub download prefix, checks size and sha512, refuses lower
versions and replayed or far-future feeds, and the shell verifies the cached bytes again before
installing; `internal-feed` is a cargo feature no release path enables. No workflow on `v2` reads
the real updater key, and fork PRs cannot reach secrets. The Windows installer runs unelevated and
per-user; data is deleted only with the box or `/DELETEAPPDATA`. The PATH edit keeps
`REG_EXPAND_SZ`, appends, and removes only its own entry. Linux maintainer scripts touch fixed
paths only. macOS uses the hardened runtime, and Node gets only the two JIT entitlements. The
bundled Node is fetched over HTTPS against pinned sha256s. Secret files are written 0600 or with a
single-user ACL, and the diagnostics bundle redacts them. Zip extraction refuses traversal,
absolute paths and symlinks.

Upgrade: the handover never kills a JVM (the deadline is on the CLI client, never the daemon);
servers stop before databases and start after them; the blocked marker stops silent retries from
repeating a stop; nothing starts twice (resume lock by pid and start time); the 1.5.0 state-file
fields match the Rust reader; shims, launchers and `runtime.json` are rewritten to
`spawnloft-core`; 1.x MCP configs and launchd/systemd units keep working through the forwarders;
a 1.x uninstall that fails restarts the servers under 1.x. **1.5.0 can take 2.0 directly; no
bridge release is needed.** A 1.5.0 stable install waits for 2.0.0 marked latest; one opted into
betas takes `beta.N` on its next quit.

Update: prerelease ordering is semver; `next`, `internal` and 1.x tags are never candidates; a
rollback re-verifies everything and is refused when the data format differs; a partial download
cannot be used; install-on-quit only runs what the last check still offers and never a rollback;
release notes are rendered as text.

Release: a beta is always `prerelease=true, make_latest=false`, so 1.5.0 stable users are not
moved by a beta; the publish is draft, upload, digest check, then one flip; the commit-date and
higher-version ordering is enforced; nothing publishes without `--confirm`; every workflow is
`contents: read` and `test/no-electron-publish.test.mjs` guards it.

## 7. What was not checked

- Anything that needs Windows or macOS at run time: the NSIS flow, junction behaviour of
  `RMDir /r`, WebView2 bootstrap, notarisation, the mac update path through the plugin (which has
  never been run from `/Applications`, a mounted DMG or a quarantined Downloads copy).
- Advisory databases for the 523 crates in `Cargo.lock` and for the npm tree (no access here;
  `cargo deny` runs in CI).
- `ui.html` and `launcher.html` line by line for XSS; the MCP tools' prompt-injection surface;
  zip-bomb limits; the 1.x Electron files.
- `updater.yml` and the installer scenarios were read, not run.
- The real updater key has never signed a build end to end (`release-windows.mjs --key` is
  documented but unexercised), and `release-publish.mjs --confirm` has never run.
