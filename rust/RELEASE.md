# Making a 2.x release

The sequence that turns one commit of `v2` into one release folder for all three platforms, and
what each step proves. Nothing here publishes until the last step, which is Victor's.
[beta-review/CHECKLIST.md](beta-review/CHECKLIST.md) says when a release may be made at all; this
file says how.

Pick the version first (`2.0.0-beta.N`, or `2.0.0`): it must be higher than every published
release, and the same on every platform. Build all three platforms from the same commit.

## 1. macOS (CI)

Actions → `installer-mac` → Run workflow on `v2`, with `release_version` set to the version.

The `release` job builds the release core (no `internal-feed` feature, no key override), the shell
from `release.pub` with HTTPS only, the app and a `.dmg`; `tauri build` notarizes and staples the
app, the job signs, notarizes and staples the `.dmg`, runs `verify-mac-build`, reads what the core
and shell trust (`desktop/build-trust.mjs`), asks the built core `update status --json`, and runs
the release gate on the mac half. It also unpacks the zip and mounts the dmg, checks the app in
each is notarized, stapled and trusts the release keys, and writes `mac-release-record.json`
(those checks, bound to each file's sha256: no other machine can make them). Its artifact
`installer-mac-release-<version>` holds `SpawnLoft-<v>-mac-arm64.{app.tar.gz,zip,dmg}` and that
record.

Secrets it uses (all already set for `installer-mac`): `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The updater key is not one of them: the
bundler's own tarball signature is made with a throwaway key and replaced in step 4.

## 2. Linux (CI)

Actions → `installer-linux` → Run workflow on `v2`, with `version` set to the version.

The packages are built, upgraded over 1.x in containers, opened under Xvfb and gated in release
mode. The feed job writes `release-gate-record.json`: the package checks and the trust checks
(dpkg-deb, rpm2cpio), each bound to the package's sha256, so the Windows machine that cannot run
them can rely on them. Its artifact `installer-linux-release-<run number>` holds the four desktop
and four `spawnloft-cli` packages and that record.

## 3. Windows (Desktop-Main)

In `S:\Projects\spawnloft-sign`, on the same commit, with the real key
([SIGNING-WINDOWS.md](SIGNING-WINDOWS.md)):

```
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<typed, never saved>'
node rust/crates/spawnloft-shell/installer/release-windows.mjs --version <v> --key <release .key file>
```

It leaves `desktop/dist/v2-signed/<v>/` (the signed setup and a Windows-only feed), and beside it
`<v>.signing-report.json` and `<v>.gate-record.json` (the Authenticode check, and what the signed
shell and core trust, bound to the setup's sha256: the setup is compressed, so this is the only
machine that sees those binaries before an install).

## 4. Assemble (Desktop-Main)

```
node desktop/release-assemble.mjs --version <v> --key <release .key file> `
  --windows desktop/dist/v2-signed/<v> --mac-run <installer-mac run id> --linux-run <installer-linux run id>
```

It downloads the two artifacts with `gh` (into `desktop/dist/release/<v>.inputs/`), stops if the
three were built from different commits, signs the whole update set once with the release key on
the release names (installer and tarball signatures, envelope, `latest.json`, every 1.x feed) and
runs the release gate in release mode over the complete folder, with the three records as evidence.
The folder is `desktop/dist/release/<v>/`; a report goes beside it.

The gate in release mode (`release-gate.mjs --release`) fails, rather than notes, anything it cannot
prove: a missing platform or a half platform; a setup without the "victor zemeckis" Authenticode
publisher; a Linux package that fails `dpkg-deb`/`rpm`; any core or shell that trusts a key other
than the release keys or a core built with the test feed; a feed not signed by a release key; a
binary version that is not the release version. A check this host cannot run is accepted only from
an evidence record for the same bytes.

## 5. Publish (Victor)

The assembly prints the command. Dry run first, read it, then the same with `--confirm`:

```
node desktop/release-publish.mjs --dir desktop/dist/release/<v> --version <v> --commit <sha> `
  --evidence desktop/dist/v2-signed/<v>.gate-record.json `
  --evidence desktop/dist/release/<v>.inputs/linux/release-gate-record.json `
  --evidence desktop/dist/release/<v>.inputs/mac/mac-release-record.json `
  --notes <notes file>
```

The publish step re-runs the release-mode gate on the exact bytes, refuses the dry-run waivers
(`--throwaway-key`, `--unsigned`) and pre-beta numbers (`beta.1000` and up) with `--confirm`, then
publishes as a draft, checks every uploaded byte and only then makes the release public. A
one-platform publish needs `--partial --allow-partial-publish` on purpose.

An evidence record is only taken from a gate that ran in release mode, for the same version, file
and sha256 (and, for Authenticode, the same publisher). The Windows trust proof is the shell and
core the signing run built (their sha256 is in the record); nothing reads them back out of the
compressed setup, so the clean-VM install with `--installed` (CHECKLIST D) is what closes that.
