# 2.0.0-beta.1 release checklist

Work top to bottom. Nothing below "Publish" happens without Victor's word; publishing cannot be
undone. Findings are numbered as in [REVIEW.md](REVIEW.md).

## A. Code that must land on `v2` first

- [ ] This review branch merged (fixes F1 to F8).
- [x] B1: the handover record is written before and during the stop; an unfinished record is
      taken over by the next attempt. Test: kill `handover stop` mid-way, run again, tasks are
      enabled and the stopped servers start. (#198, scenario s10)
- [x] B2: `.onInstFailed` restores or resumes; a failed WebView2 bootstrapper no longer aborts
      over 1.x. (#198, scenario s11)
- [x] B7: bundled Node 24.22.3 (#194, merged as 35124db).
- [ ] All three installer workflows green on the Node 24.22.3 commit.
- [x] Decision recorded on the panel's local authentication (REVIEW section 3): fixed before the
      beta (rust/PANEL-AUTH-DESIGN.md; #200 mechanism, the handoffs and texts after it). Still owed:
      the hardware checks of its section 4, thread 3.
- [ ] Recommended before the beta although not blocking: the backups-folder uninstall fix
      (should-fix 1) and the Linux update texts in the panel (should-fix 2).

## B. Release path

- [x] B3: a macOS release job: no `internal-feed`, no `SPAWNLOFT_UPDATE_PUBKEYS`, `release.pub`,
      no `--feed-http`, `--bundles app,dmg`, version as an input (`installer-mac.yml`
      `release_version`; see [../RELEASE.md](../RELEASE.md)).
- [x] B4: `installer-linux.yml` takes the version as an input (`version`).
- [x] B4: one written sequence that runs `release-feed.mjs` once, with the real key, over every
      platform: `desktop/release-assemble.mjs`, steps in [../RELEASE.md](../RELEASE.md).
- [x] B4: the gate requires the full platform set unless `--partial` is passed.
- [x] B5: the publish step runs the gate in release mode: Authenticode publisher, Linux packages,
      binary versions, trust, a release feed key; a check the host cannot make needs an
      `--evidence` record for the same bytes, or the publish stops.
- [x] B6: the gate reads every core and shell (mac tarball, Linux packages, the Windows binaries
      or an installed copy) for exactly the release keys and the release feed code, and asks an
      installed core `update status --json` (`keysOverridden`, keys, `feed`, sources).
- [ ] The first real run of steps 1 to 4 of [../RELEASE.md](../RELEASE.md) at a pre-beta number
      (nothing published), so every piece has run once on the real machines.
- [ ] A real-key run of `release-windows.mjs --key` on Desktop-Main (it has only ever run with a
      throwaway key). The password is typed into that terminal, never written to a file.
- [ ] Release notes file ready ([RELEASE-NOTES-DRAFT.md](RELEASE-NOTES-DRAFT.md)) and passed with
      `--notes`.

## C. Build the candidate (the exact files that will be published)

- [ ] Version `2.0.0-beta.1`, one commit, the same on every platform.
- [ ] Windows: built and signed on Desktop-Main; setup, shell, core and uninstaller signed by
      "victor zemeckis"; `node.exe` keeps its OpenJS signature.
- [ ] macOS (Apple Silicon): core and Node signed, app notarised and stapled, dmg made.
- [ ] Linux: deb and rpm, x64 and arm64; `spawnloft-cli` packages.
- [ ] Assembled into one folder with `release-assemble.mjs`; the release-mode gate green.
- [ ] `spawnloft-core update status --json` from each platform's build says
      `keysOverridden: false`.

## D. Runs on real machines, with the candidate files

Windows (clean VM and the PC):

- [ ] Clean install on a VM with no Node and no WebView2; the uninstaller's signature is valid.
- [ ] Signed 1.5.0 with two servers, a database and a scheduled task: quit the app; servers come
      back under `spawnloft-core` with no window opened. Repeat with Restart. This is the real
      electron-updater path.
- [ ] The same, but shut Windows down right after quitting (B1). After the reboot the tasks are
      enabled and the servers are up or reported.
- [ ] Double-click the 2.0 setup over 1.x with WebView2 removed and the network off (B2).
- [ ] A profile path with a space and a non-ASCII character: a task runs green after the handover.
- [ ] An MCP config written by 1.x still starts a server after the handover.
- [ ] Update a → b → c through the app, then roll back to a (F3).
- [ ] Throttle the feed to 2 Mbit/s and update (F1).
- [ ] Make the installer fail during "Install and restart" (hold `SpawnLoft.exe` open); note what
      the user sees.
- [ ] A real server running across an update: console, stop and restart from the new panel.
- [ ] Microsoft sign-in end to end.
- [ ] 2.0 back to 1.5.0 by hand, as the release notes describe.

Mac mini:

- [ ] From signed 1.5.0 with a server running and a launchd task: the swap on quit, the task still
      runs, the banner shows, Restart moves the server to 2.0.
- [ ] 2.x update a → b through the plugin from `/Applications`; then from a mounted DMG and from
      Downloads with quarantine, noting what happens (never run before).
- [ ] Microsoft sign-in; a manual pass over the window.

Linux (the Proxmox VM):

- [ ] 1.5.0 deb with a server running, upgraded through the real in-app update; open the window
      and see the "still run by SpawnLoft 1" banner (F7).
- [ ] `spawnloft update check` then `update apply`: the printed `apt`/`dnf` command installs the
      verified file (F2). The same on an rpm system.
- [ ] A server run from the package for a few days.
- [ ] Microsoft sign-in.

- [ ] A few days of Victor's own use on the candidate.

## E. Order of operations at "push to beta"

1. [ ] Disable `desktop-preview` and `desktop-stable` in the repository's Actions settings.
2. [ ] One reviewed PR `v2` → `dev`. In it: `dev` (and `main`) added to the triggers and job
       conditions of every 2.0 workflow; the Electron leftovers removed (move
       `azureSignOptions` out of `desktop/package.json` before deleting the electron-builder
       config).
3. [ ] No pre-beta or internal build installed on the machines used for the final checks
       (Desktop-Main has `2.0.0-beta.1002`: uninstall it, or roll back to the public beta from
       Updates and clear the hold).
4. [ ] The release commit is newer than the newest published release's commit, and
       `2.0.0-beta.1` is higher than every published version (the publish script checks both).
5. [ ] Dry run: `release-publish.mjs --dir … --version 2.0.0-beta.1 --commit <sha> --notes …`
       without `--confirm`; read its output.
6. [ ] **Publish** (Victor): the same command with `--confirm`. Prerelease, not latest.
7. [ ] Straight after: the release has every asset; from a 1.6 beta install and from a 1.5.0
       install opted into betas, the update is offered and installs; from a 1.5.0 stable install
       nothing is offered.

## F. After publishing

- [ ] Watch for pasted `update.log` and `handover.json`; a data-affecting bug resets the
      one-month beta clock (design 12).
- [ ] Every later beta carries the 1.x feed files, so an offline 1.x install lands on the newest
      beta directly.
- [ ] Before 2.0.0 stable: the should-fix list in REVIEW section 4, in order.
