# SpawnLoft 2.0: what is left, and how to finish it

2026-11-11, rev 2 (planning thread "Plan remaining 2.0 work"; rev 1 reviewed by a fresh Opus
thread against `v2` at e75a9de, 7 blockers and 12 should-fix findings folded in, every one
checked against the code before it was taken). Companion to `rust/INSTALLER-UPDATER-DESIGN.md`
(rev 3, "the design") and `/mnt/project-files/rust-gpui-plan-2026-11-08/PLAN-RUST-TAURI.md`
(rev 3.1, "the plan"). Planning only. Nothing in this document is published, and nothing Rust
reaches `dev` until Victor says "push to beta" (plan section 13).

## 0. Summary

Two days of threads built the whole 2.0 *outer shell* on `v2`: the Windows installer with the 1.x
handover (T1), the signed updater with rollback and hold (T2), notarised macOS packaging that
Squirrel.Mac accepts (T3), the release pipeline dry run and gate (T4), and the panel's update UX
(T5). All merged, green in their own workflows, proven on Victor's PC and Mac mini.

What those threads did **not** do is the plan's step 2, the Rust core port (R2 to R6). The 2.0
app today is a Tauri window over `spawnloft-core ui`, and `spawnloft-core ui` is a reverse proxy
to the **Node** panel: the installer ships `src/` as `resources/core/` and runs it on **whatever
Node.js the machine has**. Victor's machines have Node, so every test passed. A user's machine
does not (section 3A spells out what happens on each platform).

**Decided (Victor, decision card, 2026-11-11 01:48 UTC): "Bundle Node, port core in 2.1".**
2.0 ships the Tauri shell, the Rust core (daemon, updater, handover, repair, uninstall) and a
pinned Node runtime inside the package; the core port continues on `v2` after the beta and ships
as 2.1. Section 4 records the shape that decision has to take so that 2.1 can remove Node again
without breaking anything a user has (a stable entry point for everything written to disk).

The rest of the remaining work: the Tauri shell's missing window features, the command-line tool
the handover currently removes, Linux packages including arm64, Windows code signing of the Tauri
build, the real release workflow (the dry run is Windows-only and the `dev` branch would
auto-publish an **Electron** build at the merge), the pre-beta review and the runs on Victor's
hardware. Section 5 turns it into threads; section 6 lists what is still open.

## 1. Where `v2` stands (checked 2026-11-11)

| Item (plan / design name) | State | Evidence |
| --- | --- | --- |
| P0-G rename `mcctl` → `spawnloft` | Merged into `dev` (#173) and into `v2` (#174) | `docs/RENAME.md` on `v2` |
| P0-C workspace, CI, internal builds | Done | `rust/`, `rust-internal.yml` |
| P0-D Rust daemon (R1) | Done, Fable-reviewed, default in every Tauri build (`internal-defaults.json` `{"daemon":"rust"}`) | `rust/crates/spawnloft-lib/src/daemon/` |
| P0-A contract fixtures | **Merged**: PR #175 squash-merged into `v2` 2026-11-10 as 7f06d31 | `test/fixtures/contracts/`, `test/contracts*.test.mjs` |
| P0-B bridge items | Merged into `v2` (#176). Not done inside it: the "what's coming" notice, the stay-on-1 switch, `disableDifferentialDownload`; all three only matter if another 1.x ships, which the design (sections 1 and 12) says it does not | memory `bridge-items-p0b` |
| P0-E experiments 4a and 4b | Done | `rust/PHASE0-FINDINGS.md` |
| P0-F Tauri spike | Done, incl. signed PC handover and Squirrel.Mac on the mini | `rust/PHASE0-FINDINGS.md` |
| Installer and updater design | Rev 3, all questions decided by Victor | `rust/INSTALLER-UPDATER-DESIGN.md` |
| T1 Windows installer + handover | Done; `installer.yml` scenarios 1, 2a, 2b, 3, 4, 5, 8, 9 green against published 1.5.0 and 1.6.0-beta.413 | design section 4 probe result |
| T2 signed updater | Merged (#177, b98a82a); live wrong-key test passed on Desktop-Main | `updater.yml` |
| T3 macOS packaging | Merged; `installer-mac.yml` green incl. plugin cycle; mini Test 1 (1.6.0-beta.413 → 2.0) and Test 2 (a → b) passed | memory `t3-mini-acceptance` |
| T4 release pipeline and gate | Merged (#179, 98ab8ce); **Windows-only dry run**, `workflow_dispatch` and PRs into `v2` only; no mac or Linux assembly job, no publish path, no signing | `desktop/release-*.mjs`, `release.yml` |
| T5 panel update UX, handover banners | Merged (#178, c5d71c8) | `installer-updater-2026-11-09/t5-screens/` |
| `dev` merged into `v2` | Up to date: `origin/dev` is an ancestor of `v2` | `git merge-base --is-ancestor` |
| Updater signing secrets | Set by Victor 2026-11-09; the dry run still uses a throwaway key by design | memory `release-pipeline-t4` |

### 1.1 The CI question the coordinator asked: the first contract-test run after #175

`rust-internal.yml` run 47 (7f06d31, the #175 squash) was **cancelled** by the workflow's
`cancel-in-progress` concurrency when aaed853 was pushed two minutes later. Runs 48 (aaed853) and
49 (19fd235) both include #175, and in both every `daemons` job passed, which is where
`contracts-daemon.test.mjs` runs:

| Run | daemons (ubuntu, node) | daemons (ubuntu, rust) | daemons (windows, node) | daemons (windows, rust) | Whole run |
| --- | --- | --- | --- | --- | --- |
| 48 (aaed853) | pass | pass | pass | pass | **failed**: `rust (ubuntu-24.04)` Formatting |
| 49 (19fd235) | pass | pass | pass | pass | **failed**: same |

So the contract suite is green under both daemons on both platforms, but the workflow as a whole
has been **red on every push since c5d71c8 (the T5 merge, run 46)**: T5 formatted
`handover/api.rs` and `panel.rs` with rustfmt's default width instead of the repo's
`max_width = 110`, and the Linux job's `cargo fmt --check` fails before Clippy and the tests run.
Runs 43 to 45 were red for other reasons (43: a flaky `metrics::tests::samples_this_process`
on Linux; 44, 45: the same fmt problem once it landed). The last fully green run is 42 (0f7d4f5, T3).

Fixed today, pushed to `v2` as two commits (author and committer joogiebear, no attribution):

- 6da4200 `cargo fmt --all` on the two files (reproduced locally with the pinned 1.97.0
  toolchain: same diff as CI, clean afterwards).
- e75a9de the metrics test waited for the log file to exist, then read its first line; the file
  is created before the first sample is written, so it read an empty file once. It now waits
  for a complete line. `cargo test -p spawnloft-lib --lib metrics` passes locally.

Run 50 (e75a9de) is the one to look at. **Gotcha kept from memory:** the `daemons` jobs run only
on pushes to `v2`, never on a PR, so a Rust state change can break `contracts-daemon` silently
until after the merge. Note for whoever fixes it: every job in `rust-internal.yml` carries
`if: github.ref == 'refs/heads/v2'`, so adding a `pull_request` trigger alone would skip every job
and report green.

## 2. What 2.0 is today, and what the plan said it would be

The plan (section 0) was a staircase: step 1 sidecar inside Electron, step 2 core port with
Electron as a window on the Rust HTTP server, step 3 the Tauri shell swap = 2.0. The installer
and updater design, and the T1 to T5 threads, built **step 3 first**, around a core that is still
the Node one. The result on `v2`:

```
SpawnLoft.exe (Tauri 2 shell: main.rs 294 lines + updater.rs 352)
  └─ spawns resources\bin\spawnloft-core.exe ui --port 0 --exit-with-stdin
       ├─ answers /api/update*, /api/handover* itself (Rust, T2 and T5)
       └─ proxies everything else to:  <system node> resources\core\spawnloft.mjs ui --port 0
            └─ the whole Node core (src/, 22,800 lines): registry, supervisor, panel API,
               MCP, scheduler, plugins, client launcher, databases, backups, ...
                 └─ spawns spawnloft-core.exe daemon <name>   (Rust, R1)
```

The Rust core also runs `handover stop|resume`, `repair`, `uninstall` and `update`; of these,
`resume`, `repair` and `uninstall` call back into the Node core on the system Node
(`nodecore.rs`, "the seam ... until R4 lands"). MCP is still the Node one. **There is no
command-line tool after the handover at all** (section 3, A4).

Relative to the plan's promises for 2.0:

| Promise (plan section 0, step 3) | Status |
| --- | --- |
| Installer 100 MB → 15 to 25 MB | 3.2 MiB today **because it leans on a Node the user must already have**; about 30 MB compressed with a bundled Node (`node.exe` 24.21.0 is 93.6 MB on disk, 27 to 32 MB compressed) |
| Start under a second | True for the window; the panel waits for Node to start the core |
| Shell memory halved | Measured false in P0-F (WebView2 costs about what Chromium does); plan text still to correct |
| Headless Linux package without Node | Not built (T6 not started); 1.x's `spawnloft-cli` deb already bundles Node from nodejs.org |
| Fast CLI, fast MCP, one language in the core | Not started (R2 to R6); now the 2.1 track |
| 1.x → 2.0 update path, own installers and updater | **Done** on Windows and macOS; Linux not started |

## 3. The remaining work, by area

Each item names the plan or design section it comes from, its state, and what "done" is. Sizes
are thread weeks as the plan defines them (one Opus thread full time for a week); the T1 to T5
threads ran at roughly a thread week per calendar day, so read them as relative weights.

### A. The Node dependency and what sits on it (blocker for any public build)

- **A1. What a Node-less user gets today, per platform.**
  - *Windows, a server running:* `handover stop` checks for Node only when something is
    stoppable (`handover_cmd.rs:161-173`) and exits 5 with "needs Node.js" in the full UI; in the
    silent install-on-quit path 1.x shows its generic "Update failed" at every quit (design 2.3.3
    keeps the retries silent), so the update never completes and the user never learns why.
  - *Windows, nothing running:* no check runs. 2.0 installs, `repair --quiet` fails and the
    installer discards its exit code (`installer.nsi:1122-1123`, `Pop $0`), the 1.x task shims
    stay and route through `SpawnLoft.exe`'s argv compatibility, which exits 127 without Node
    (`shell/main.rs:250-253`). **Every scheduled backup and restart then fails silently**, and the
    window shows the "no Node" page.
  - *macOS and Linux:* Squirrel.Mac and `pkexec dpkg -i` run no pre-install code of ours. The user
    always lands on the "no Node" page with dead tasks. **No gate is possible on these platforms**,
    which is why "require system Node" was never an option.
- **A2. Bundled Node has a precedent.** `desktop/build-cli-package.mjs` already downloads a pinned
  Node (24.21.0) from nodejs.org for the 1.x `spawnloft-cli` deb and rpm, with the sha256 of each
  tarball pinned in source (Linux x64 and arm64), npm stripped, "because Electron's browser is not
  wanted on a server". The bot host runs on `process.execPath` (`bots.mjs:309`), so it would run on
  the bundled Node too; `bot setup` needs npm, as it does in the 1.x CLI package, so that stays
  "system Node or `bot.node` setting" as the plan already says.
- **A3. Internal strings must not ship.** The installer's own messages are specific ("needs
  Node.js (nodejs.org)", `installer.nsi:645-648, 968-972`); the gaps are the "no Node" page titled
  "SpawnLoft (internal spike)" (`panel.rs:437`), the core's help "Internal build: not for release."
  (`cli.rs:47`), `tauri.conf.json` at `2.0.0-spike.0`, and the `internal-defaults.json` file name.
  The release gate gets a check that no `spike`/`internal` string ships.
- **A4. The handover removes the command-line tool.** 1.x ships `resources\bin\spawnloft.cmd`,
  `mcctl.cmd` and `Contents/Resources/bin/spawnloft` (`desktop/cli-launchers.cjs`, `CLI.md`). The
  Tauri resource maps ship neither (`installer-config.mjs:52-59`, `mac-config.mjs:60-67`),
  `spawnloft-core` rejects unknown commands (`cli.rs:223-233`), and `SpawnLoft.exe` is a
  GUI-subsystem binary that cannot serve a terminal (plan section 0). After the handover
  `spawnloft list` is gone. Fix: `spawnloft-core` forwards every command it does not own
  (including `mcp` and `task run`) to the Node core on the bundled Node, and the `spawnloft` /
  `mcctl` forwarders ship at the 1.x paths. This also gives `MCP.md` a 2.0 config form
  (`<install>\resources\bin\spawnloft-core.exe mcp`) that 2.1 keeps unchanged.
- **A5. What the Node core writes to disk names Node, not SpawnLoft.** Task shims, server
  launchers, the launchd plist, `runtime.json` and the MCP config shown in Settings all record
  `process.execPath`, and the bare word `node` whenever that path ends in `node` or `node.exe`
  (`schedule.mjs:253-255`, `create.mjs:72-77`, `schedule-mac.mjs:71`, `relocate.mjs:20`,
  `ui.mjs:1454`). With a bundled runtime that rule writes `node`, a PATH lookup that misses the
  bundled copy; with the full path, everything a user copies breaks when 2.1 removes it. Mac Test
  1's `runtime.json` pointing at `/usr/local/bin/node` is this effect. The design's text that
  shims "now name `spawnloft-core.exe`" (2.3 step 8) is **not true today**, and `RUNTIME_FORMAT`
  is still 1. Fix: everything written to disk names `spawnloft-core` (A4's forwarding makes that
  work), `RUNTIME_FORMAT` bumps to 2 so `repairAfterMove` rewrites existing shims and launchers.
- **A6. A bundled `node.exe` is a held file during 2.x updates.** Long-lived processes would
  run on it: `spawnloft mcp` (hours), the bot host, console attach, `task run`, and any Node
  fallback daemon. The design's held-file rule renames only `spawnloft-core.exe` (section 4) and
  Restart Manager matches only `SpawnLoft.exe` (section 3); an NSIS `/UPDATE` overwrite of a held
  `node.exe` fails. The argv forwarder in the shell has no kill-on-close job object either
  (`main.rs:255-260`), so a killed forwarder orphans its Node child. Fix: install Node into a
  versioned folder (`resources/runtime/node-<ver>/`) so an update writes a new folder and the
  cleanup rule removes the old one when no longer held; job object on the forwarder; design
  scenario 5 gains "with an MCP server running".
- **A7. The bundled Node must run under the hardened runtime on macOS.** Design D8 signs the
  core with no entitlements, which is right for a Rust binary and wrong for Node: V8 needs
  `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory`; signed without them
  Node dies at start **and notarisation still passes**. Either keep the OpenJS signature and
  confirm notarisation accepts a foreign Team ID inside the bundle, or re-sign with an
  entitlements file. The core is signed inline in `installer-mac.yml:128-133`, not in
  `mac-package.mjs`, so that is where the step goes. Done-when must include "the installed,
  notarised `.app` on the mini runs the bundled `node -e 1`".
- **A8. The staging-time check.** `handover stop` runs from `staging\` before the payload is
  extracted (`nodecore.rs:36-37`), so the bundled Node is not there yet; if the check "uses" it,
  every handover exits 5. Drop the check (the payload guarantees Node) or stage Node too.
- **A9. Removal in 2.1 is a template step.** Tauri's `/UPDATE` never deletes files missing from
  the new manifest (design 5.6). The 2.1 installer removes `resources/runtime` and
  `resources/core/src` explicitly, with the held-file handling of A6. Recorded now so the 2.1
  brief has it.
- **A10. The Rust daemon is now a requirement, not a default.** Under Tauri a Node daemon would
  hold the bundled `node.exe` for the life of a server, so 2.0 effectively requires
  `daemon: rust`. Plan 13.7 ("merge into `dev` with the daemon off") no longer fits; the R1 gate
  (plan section 3: Victor's servers on the Rust daemon for a week, `rust-internal.yml` with
  `repeat: 5` green on both platforms) becomes a **must-pass before beta.1**, and memory records
  neither as done. The week should start now on Victor's PC with the current internal build.

### B. The Rust core port (plan step 2: R2 to R6), the 2.1 track

Plan estimate 18 to 28 thread weeks; nothing of it exists on `v2` beyond R1 and the update and
handover modules. Order unchanged: **B1** CLI `--json` and panel-route fixtures (1 to 2 weeks),
**B2** = R2 archives (2 to 3), **B3** = R3 process helpers (1 to 2), **B4** = R4 business core
behind `SPAWNLOFT_CORE_IMPL` (8 to 12), **B5** = R5 client launcher (4 to 6), **B6** = R6 panel
API, MCP, command table (4 to 6), after which `nodecore.rs`, the forwarding of A4, the bundled
Node and `resources/core/src` all go (A9). Each ships as a 2.x update on the new updater. The
Java runtime download for servers is built once, in Rust, inside B4.

### C. The Tauri shell: feature parity with the Electron window (plan step 3 list)

The shell has single instance, the core child, argv compatibility, the updater and the handover
resume. The Electron `main.js` it replaces (1,800 lines with preload and the two extra windows)
provides the `window.spawnloftDesktop` bridge that `ui.html` calls at about 18 sites and
`launcher.html` at 5, plus behaviours outside the bridge. The shell's capability file says it:
"Nothing yet ... Pickers, zoom and open-in-folder arrive with a remote.urls entry in step 3."
Today the panel runs in **browser mode** inside the Tauri window, which the page supports by
design, so nothing crashes, but:

| Electron behaviour | In the Tauri shell today | Needed for 2.0 |
| --- | --- | --- |
| `pickFolder` / `pickFile` (data root, import world, backup mirror) | typed paths only | yes, **in the shell** (the core is headless on mac and Linux, no GUI toolkit) |
| `getZoom` / `setZoom`, Auto interface size by display (#127, #149), window state per display | fixed 1280×800, browser zoom | yes |
| `openExternal`, `openProfileFolder`, navigation lockdown (`main.js:209-213, 291-299`) | the webview navigates anywhere a link points | yes: exact-origin navigation guard plus validated open commands |
| `openMicrosoftLogin` (launcher sign-in) | `launcher.html:2002` falls back to `window.open`, which a Tauri webview does not open as a window | yes: system browser with the loopback redirect, as design 7 and plan step 3 chose; the callback lands on the Node panel's own port (`ui.mjs:1341-1343`), not the window's, so the proxy must pass it |
| Console and Play/launcher windows via `window.open` (`main.js:224-266`) | nothing opens | yes: a 1.x feature, not optional |
| `a.download` links (`ui.html` four sites: exports, diagnostics bundle) | untested on WKWebView and webkit2gtk | yes: a download handler |
| `getSetup` / `saveSetup` / `checkJava` (first-run `setup.html`) | first run goes straight to the panel | yes: served by the core at `/setup`, as plan step 3 and design 8 already say |
| Startup-failure dialogs (`main.js:200-206, 676-684`), WebView2-missing message (design 2.6) | shell logs only to an env-gated spike log and discards the core's stderr (`main.rs:198, 290-294`) | yes: a shell log, the core's stderr in `panel.log`, a dialog when the core cannot start |
| `appInfo`, `checkUpdate`, `updateChannel`, `installUpdate`, `onUpdate` | replaced by T5's `/api/update*` section; dead Electron branches remain in the page | tidy |
| Deferred from the P0-F review: **M3/L4** job object for children, **L5** proxy read timeouts, signed uninstaller | `--exit-with-stdin` already ends the core and its Node panel when the shell dies (`panel.rs:36-38, 86-94`); the orphan cases left are a killed **core** (its Node panel stays) and the argv forwarder (A6) | job object on both; L5 before beta; signed uninstaller with D2 |

Security note for the capability work: the panel's port is random, so a `remote.urls` entry
would have to be `http://127.0.0.1:*`, which hands the Tauri API to any loopback page the window
can reach (a plugin's web map, for example). The navigation guard above is therefore part of the
same change, and the bridge is a small set of validated custom commands, never a generic shell
open. Fable reviews it.

Estimate 2 to 4 weeks (Sonnet for the page side, Opus for the Tauri side), plus `smoke-desktop.cjs`
pointed at the Tauri window and Microsoft sign-in end to end on three platforms.

### D. Packaging, signing, release workflow and CI

- **D1. Two product lines on `v2`, and a live hazard on `dev`.** `rust-internal.yml`'s `package`
  job still builds the **Electron** app with the Rust binary inside (plan step 1 topology,
  `desktop/internal.config.cjs`); the installer, mac, updater and release workflows build the
  **Tauri** app. Worse: `desktop-preview.yml` runs on every push to `dev` touching `src/**` or
  `desktop/**` and its `publish` job publishes whenever `desktop/package.json` holds a prerelease
  version (it holds `1.6.0-beta.2`). **The "push to beta" merge of `v2` into `dev` would publish
  an Electron build of the `v2` tree to every 1.6 beta user.** `desktop-preview.yml` and
  `desktop-stable.yml` must be retired or retargeted **before** that merge, and the Electron
  shell (`main.js`, `preload.js`, the window modules, the three electron-builder configs) deleted
  once C reaches parity; `desktop/` keeps the release tooling (plan Q7).
- **D2. A real release workflow and Windows code signing.** `release.yml` is a Windows-only dry
  run on `workflow_dispatch` and PRs into `v2`: no mac or Linux assembly, no publish job, no
  signing, throwaway updater key. 1.x signs `dev` betas in CI through Azure OIDC (trusted on
  `refs/heads/dev` only) and stables on Victor's signing machine. For Tauri: the bundler's
  `signCommand` signs the installer and the shell but **not resource binaries**
  (`installer-mac.yml:128-130`, PHASE0-FINDINGS P0-F: the inner exe stayed unsigned on the PC
  run), so the core and the bundled Node need an explicit signing step before `tauri build`, and
  the template needs `UNINSTALLERSIGNCOMMAND` (design 2.6); `node.exe` keeps its OpenJS signature
  or is re-signed, and the gate's CN rule says which. Signing a `v2` build needs either a new
  Azure federated credential for `v2` (a security call for Victor) or his signing machine through
  Remote Control. Done when: a `dev`/`main` release workflow builds Windows, mac and Linux,
  signs everything, assembles the full asset set, passes the gate with `--authenticode-cn` and
  publishes only on Victor's confirmation; the `v2` dry run keeps the throwaway key.
- **D3. Linux (T6, design 5.7, Q24), x64 and arm64, a hard prerequisite of beta.1.** 1.x ships
  arm64 desktop deb/rpm and an arm64 CLI package, and the release tooling already expects
  `beta-linux-arm64.yml` (`release-feed.mjs:84`, `release-gate.mjs:219-220`); a release missing a
  feed file breaks every 1.x beta check (design 11). Tauri `spawnloft` deb and rpm with the two
  1.x paths present, `spawnloft-cli` rebuilt from the Rust core plus the bundled Node (A2),
  `installer-linux.yml` in containers over the 1.x packages on `ubuntu-24.04` and
  `ubuntu-24.04-arm`, the four Linux feed files, the **new** Proxmox test VM (plan 13.5). Q24
  answered on the way; Q-F already decided "notify and show the command". 2 to 3 weeks.
- **D4. Version stamping.** `installer.yml` builds the core without `SPAWNLOFT_VERSION`
  (`installer-mac.yml` sets it), so a Windows CI core reports `2.0.0-internal.0`. The larger gap:
  `resources/core/package.json` ships `1.6.0-beta.2` and `release.yml` never runs
  `set-version.mjs`, so the panel version (`ui.mjs:176`), `data-format.json`'s `writtenBy`
  (`data-format.mjs:38`), the diagnostics bundle and the launcher all report 1.x from inside 2.0.
  Stamp both; the gate checks `spawnloft-core --version` and the Node core's version against the
  release. Small.
- **D5. Microsoft analysis submission** of the signed binaries before the first public build
  (plan 3.1 and 13.7). Needs D2's artifacts; Victor's account.
- **D6. `rust-internal.yml` on PRs.** Run `rust`, `deny`, `daemons` and `node` on
  `pull_request` into `v2`, **changing the per-job `if: github.ref == 'refs/heads/v2'`** so they
  do not skip-and-pass; no `package` job on PRs. Key the push concurrency group by sha, or drop
  `cancel-in-progress`, so a push two minutes after a merge no longer erases the merge's run.
- **D7. Pins and bumps.** Tauri CLI 2.12.4, Tauri 2.12.5, the NSIS template fork (1,506 lines)
  carries an upstream copy from bundler 2.10.4; W7 confirms that is the bundler this CLI uses
  (plan Q25) and re-syncs if not, with a Fable review. Dependabot for Cargo grouped monthly is
  not configured; nodejs.org hashes are pinned in source, so the Node bump needs a scheduled check
  of its own (Dependabot cannot do it). CI tests on Node 22 while the pinned runtime is 24.21.0:
  test on the pinned version.

### E. Verification still owed (design section 11, plan section 3 gates)

- **E1.** Design scenario 4's one-minute `restart` task during the handover (T1 left it out).
- **E2.** Design 6 "verify" marks: the plugin's in-place replace on the mini was run in T3 Test 2
  (**now verified**); "no quarantine attribute is added by our own extraction" is still unverified.
- **E3.** The R1 gate (A10): `repeat: 5` green on both platforms and Victor's week on the Rust
  daemon. Calendar time; start now.
- **E4.** The "on Victor's machines before push to beta" list (design 11): the real
  electron-updater handover on his PC from a **signed 1.5.0** install, both Restart and
  install-on-quit, servers running; the mini from 1.6.0-beta.413 with the final build; a rollback
  on each. The PC has done 1.6 → spike and the live wrong-key test, never the 1.5.0 stable path
  with the real T1 installer. electron-updater checks the Authenticode publisher, so this needs
  D2 first.
- **E5.** A clean Windows VM or user account **with no Node**, with a system Node also tried on
  PATH in a second run asserting the bundled one ran: handover end to end, a scheduled task to
  green, `spawnloft list --json` from a terminal, `spawnloft mcp` answering.
- **E6.** The 1440p and 4K check of the finished window (P0-F had Victor's "looks ok" on the spike).
- **E7.** The daemon soak week on the test VM (plan section 7) once the Linux package exists;
  calendar time.
- **E8.** The channel rule (design 7): a 1.6 beta install lands on `2.0.0-beta.1`, a 1.5.0 stable
  install waits for `2.0.0`, a 1.5.0 install that opted into betas takes `beta.1`. A test, not a
  question.

### F. Documentation and release text

`README`, `CLI.md`, `MCP.md` (the 2.0 config form from A4), `STABLE.md` and `PREVIEW.md` for the
Tauri build and the new release workflow, `docs/RENAME.md`, `rust/README.md` (stale: "Today:
`--version`, a `daemon` stub ..."), the design's 2.3 step 8 text corrected per A5, the plan's
section 0 memory claim corrected per P0-F, release notes with "servers are stopped and started
again for this update", "If you need to go back", and "2.0 carries a Node.js runtime for the
parts not yet in Rust; 2.1 removes it". Sonnet, 1 week, after A4, A5 and C are decided in code.

## 4. The decision, and the shape it has to take

Victor chose **"Bundle Node, port core in 2.1"** (card, 2026-11-11 01:48 UTC) over finishing
the port first (18 to 28 thread weeks with 1.x users on unguarded builds meanwhile) and over
requiring a system Node (impossible to gate on mac and Linux, A1). The review of rev 1 showed
that "the tested layout plus a binary" undersells it: the bundle touches the NSIS fork's
held-file rule (A6), the macOS entitlements (A7), the staging check (A8) and, most of all, the
Node code that writes paths to disk (A5). So the decision is carried out as:

1. **A versioned, signed runtime folder** (`resources/runtime/node-<ver>/`), Node pinned and
   hash-checked from nodejs.org on all three platforms, signed with the Developer ID **with JIT
   entitlements** on macOS, Authenticode kept or re-signed on Windows; `find_node` prefers it and
   falls back to a system Node only when `SPAWNLOFT_NODE` says so.
2. **`spawnloft-core` as the only external entry point.** It forwards every command it does not
   own to the Node core (A4), so the CLI, `mcp` and `task run` work from a terminal; shims,
   launchers, plists, `runtime.json` and the MCP config name `spawnloft-core`, never a Node path
   (A5); `RUNTIME_FORMAT` bumps; the forwarders `spawnloft` / `mcctl` ship at the 1.x paths.
3. **2.1 removes Node without touching any user-visible path**, through the template step of A9.
4. Optional, if time allows before beta: `repair` and `uninstall` ported to Rust (text rewrite,
   pipe stop, task removal), so the installer and uninstaller never run Node at all.

What this costs over rev 1's estimate: about one thread week more (2 to 3 instead of 1 to 2),
and a Node security release becomes a signed, gated 2.x release until B6 lands, which is still
less than 1.x's Electron cadence (Chromium and Node both). Nothing a user copies from 2.0 breaks
in 2.1.

## 5. Threads to start (for the coordinator)

All on `v2`, pushing directly or through PRs into `v2` as the T threads did; author and
committer joogiebear, no attribution anywhere; each brief carries this document, the design, the
plan and `PHASE0-FINDINGS.md`, and a done-when line. Models per Victor's routing: Opus to build,
Sonnet for pages and docs, **Fable 5.2** (never 5.1) for security and review.

**Now, in parallel:**

1. **W1, Opus, Fable review: the runtime and the entry point (section 4 items 1 to 3; A1 to A9).**
   Done when: `installer.yml` scenarios 1 to 9 green with no Node on PATH and again with a decoy
   system Node on PATH (asserting the bundled one ran, A5's shims naming `spawnloft-core`, a task
   run to green, `spawnloft list --json` from a terminal, `spawnloft mcp` answering);
   `installer-mac.yml` green with the bundled Node signed, entitled and notarised, and
   `node -e 1` running from the installed `.app` on a runner; design scenario 5 passes with an
   MCP server running; the gate checks the Node version and hash and refuses internal strings
   (A3); `RUNTIME_FORMAT` is 2. 2 to 3 weeks.
2. **W2, Opus (Tauri) + Sonnet (page), Fable review: shell parity (section C).** Done when:
   every `desktop.*` call in `ui.html` and `launcher.html` works in the Tauri window or is gone;
   navigation is locked to the panel's origin; console and launcher windows open; downloads work
   on all three webviews; Microsoft sign-in completes end to end on Windows, the mini and a Linux
   VM; a killed core leaves no Node panel behind; screenshots at 1440p and 4K are in the project
   files; `smoke-desktop.cjs` drives the Tauri window. 2 to 4 weeks.
3. **W3, Opus: Linux packages (D3), x64 and arm64.** Done when: `installer-linux.yml` installs the
   deb and rpm over the 1.x packages in containers on both architectures, the two 1.x paths exist,
   `spawnloft-cli` carries the Rust core and the W1 runtime, the four Linux feed files assemble,
   Q24 is answered in the design, and the new Proxmox VM runs a server from the package. 2 to 3
   weeks. Needs W1's runtime layout, so it starts with the packaging and takes the runtime when
   W1 lands.
4. **W4, Opus: version stamping and CI hygiene (D4, D6, D7).** Done when: `set-version.mjs` runs
   in every Tauri build, the gate checks both cores' versions, `rust-internal.yml` runs its checks
   on PRs into `v2` without skipping, merges are not cancelled by the next push, Dependabot
   covers Cargo and a scheduled job reports a newer Node LTS, CI tests on the pinned Node.
   1 week.
5. **E3 starts now:** Victor runs his servers on the Rust daemon (current internal build) for a
   week; the coordinator dispatches `rust-internal.yml` with `repeat: 5`.

**Then, in this order:**

6. **W5, Opus, Fable review: the release workflow and the end of the Electron line (D1, D2).**
   `desktop-preview.yml` and `desktop-stable.yml` retired or retargeted so the `v2` → `dev` merge
   publishes nothing by itself; a `dev`/`main` release workflow building Windows, mac and Linux
   from the Tauri bundler with signing of installer, shell, core, runtime and uninstaller,
   assembling the full asset set, gate with `--authenticode-cn`, publish only with `--confirm`
   on Victor's word; `rust-internal.yml` packages the Tauri app; the Electron shell files
   deleted. Needs W2 at parity and **Victor's call on how `v2` builds get signed** (new federated
   credential or his machine). 1 to 2 weeks.
7. **W6, Sonnet: documentation (F).** 1 week, after W1, W2 and W5 have settled the forms the docs
   describe.
8. **W7, Fable: the pre-beta review of `v2` as a whole** (plan 13.7): the NSIS fork against the
   pinned bundler (D7), the capability surface from W2, the runtime and forwarding from W1, the
   signing and workflows from W5, the Linux packages from W3, everything that reads a feed or a
   record. Small fixes land in the same thread. 1 week, after W1 to W5.
9. **W8, Victor's hands through Remote Control, Fable driving: E1, E2, E4, E5, E6, E8** on the
   PC, the mini, a clean Windows VM and the Proxmox VM with the signed release artifacts; D5
   Microsoft submission. His go for each step.
10. **"Push to beta"**: Victor's word; one reviewed PR `v2` → `dev`; `2.0.0-beta.1` published by
    `release-publish.mjs --confirm` after the gate and the W8 runs on **the release artifacts
    themselves** (design 12). Publishing is irreversible and always Victor's call.

**After the beta (2.1 track):** B1 fixtures, then B2 to B6, each a thread with its switch and
fixtures, each shipped as a 2.x update; the runtime and `resources/core/src` leave with B6 (A9).
Briefs keep the plan's R2 to R6 names.

Rough total to `2.0.0-beta.1`: 11 to 17 thread weeks plus Victor's hands, with two fixed
calendar floors underneath (the R1 week now, the Linux soak week once W3 lands). At the pace of
the last two days, four to six weeks of calendar.

## 6. Open questions

Already answered by the design or the plan, and so **not** asked again: no further 1.x release
(design 1 and 12); the channel default rule (design 7; E8 tests it); the first-run page served by
the core (plan step 3, design 8); the system browser for Microsoft sign-in (design 7, plan step 3);
the R1 gate is a gate, not a question (plan section 3; A10 makes it a must-pass).

Still open, each with a recommendation; "I trust recommendations" closes all but Q-T, which is a
security call:

- **Q-S, the Rust daemon as 2.0's only daemon** (A10): accept that 2.0 requires `daemon: rust`,
  drop plan 13.7's "merge with the daemon off", keep `SPAWNLOFT_DAEMON=node` for CI and support
  only, and rename `internal-defaults.json` to a public name. Recommendation: yes.
- **Q-T, signing `v2` builds** (D2): a new Azure federated credential trusting `refs/heads/v2`
  (widens what CI can sign, revocable), or Victor's signing machine through Remote Control for
  the pre-beta artifacts (his time, no new trust). Recommendation: his machine for the pre-beta
  runs, the credential only when `v2` becomes the release branch, if ever.
- **Q-U, the `dev` beta cadence at the merge** (D1): `desktop-preview.yml` publishes on every
  `dev` push today. Recommendation: retire it with W5; 2.x betas publish from the new workflow on
  Victor's confirmation, never automatically.
- **Q-V, Linux arm64 in 2.0** (D3): in, because the release tooling and 1.x's arm64 users expect
  its feed files. Recommendation: in.
- **Q-W, the command-line tool on PATH** (A4): keep `spawnloft` and `mcctl` forwarders at the 1.x
  paths, pointing at `spawnloft-core`. Recommendation: yes, forever.
- **Q-X, Node pin policy** (D7): current LTS (24.21.0, the CLI package's pin), bumped in its own
  commit through the full installer workflows, a scheduled job that opens an issue when a newer
  LTS exists. Recommendation: yes.
- **Q-N, console window and tray:** the console window is a 1.x feature and stays (section C);
  no tray in 2.0. Recommendation: as stated.
- **Q-R, 1.x roadmap items before 2.0:** `ROADMAP.md` lists only the post-1.0 Share screen.
  Recommendation: nothing new before 2.0; features in R4 areas wait for the port (plan Q4).

## 7. Facts checked today, for the record

- `origin/dev` is an ancestor of `v2` at e75a9de: nothing on `dev` is missing from `v2`.
- No other thread is working on `v2` (project thread list: every T thread resolved).
- The Tauri installer's resource map (`installer-config.mjs`): `resources/bin/spawnloft-core.exe`,
  `resources/core/{mcctl.mjs,spawnloft.mjs,package.json,src/,internal-defaults.json}`. No Node,
  no `bin/spawnloft.cmd`.
- `rust/crates/spawnloft-shell/capabilities/default.json`: `"permissions": []`.
- `release.yml`: `unit` and `dry-run` jobs, Windows only, no signing; `release-gate.mjs`
  `--authenticode-cn` opt-in.
- `desktop-preview.yml`: push trigger `branches: [dev]`, publish job on `refs/heads/dev` and a
  prerelease `desktop/package.json` version (`1.6.0-beta.2` today).
- `ci.yml` runs on `main` pushes and on every PR, including PRs into `v2`; `rust-internal.yml`
  is the only workflow on `v2` pushes, and every job in it is `if: github.ref == 'refs/heads/v2'`.
- `rust-internal.yml` `package` job builds the Electron app (`desktop/internal.config.cjs`).
- `handover_cmd.rs:161-173` Node check only when a server is stoppable; `installer.nsi:1122-1123`
  discards `repair --quiet`'s result; `shell/main.rs:250-253` argv forwarder exits 127 without Node.
- `schedule.mjs:253-255` and `create.mjs:72-77` write bare `node` when `process.execPath` ends in
  `node`/`node.exe`; `relocate.mjs:17` `RUNTIME_FORMAT = 1`; `tauri.conf.json` version `2.0.0-spike.0`.
- Rust on `v2`: 15,200 lines across four crates; the Node core `src/` 22,800 lines; `ui.html`
  14,286, `launcher.html` 2,354; NSIS template 1,506 lines, upstream copy from bundler 2.10.4.

## 8. Review log

Rev 1 (2026-11-11) reviewed by a fresh Opus thread, read-only, against `v2` e75a9de. Seven
blockers (A1 understated per platform; A5 shim writers; A6 held `node.exe`; A7 macOS
entitlements; D1 `desktop-preview.yml` auto-publish and no real release workflow; A4 no CLI after
the handover; D3 arm64 and Linux as a beta.1 prerequisite), twelve should-fix items (A3, A8, D2
resource signing and the `v2` credential, D4 `package.json` version, section C additions, the
capability surface, M3/L4 misdescribed, A9, D6 skip trap, thread order and done-whens, Option 1
figures, A10) and the "fourth option" that section 4 now is. Three claims from the review were
checked and taken as stated without running them: the V8 entitlement requirement (A7), the
`node.exe` size (93.6 MB on disk, 27 to 32 MB compressed), and WKWebView/webkit2gtk download
handling being untested.
