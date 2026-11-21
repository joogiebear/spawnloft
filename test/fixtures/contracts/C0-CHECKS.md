# C0 checks

Two things rust/PLAN-CORE-PORT.md asks C0 to confirm before any phase relies on them.

## 1. 1.5.0 keeps settings keys it does not know (plan 5.4, `bot.node`)

Confirmed. 1.5.0 is commit `c6abe19` ("chore(release): 1.5.0", merged as `62b0c27`, the tip of
`main`). Its `src/settings.mjs` `save(patch)` reads the file and writes
`{ ...found.settings, ...patch }` (line 77), as JSON with two spaces and a newline, through a temp
file and a rename. Every 1.5.0 caller passes a patch of its own keys (`config set-root`,
`set-instances`, the mirror and backups folders, the theme, the desktop's first-run wizard); none
builds a settings object from scratch, and nothing else in 1.5.0 writes the file.

Run, not only read: 1.5.0's own `src/settings.mjs` (`git archive c6abe19 src`) was given a settings
file holding `"bot.node": "/usr/bin/node"` and a nested `"bot": { "node": ... }`, and then
`save({ theme: 'spawnloft' })`. Both keys came back unchanged, in place, with `theme` added last;
the file stayed mode 0600. So a `bot.node` key written by 2.0 survives a rollback to 1.5.0 and is
there again on the way back.

One caveat for the rollback story, not for this key: 1.5.0 reads and writes only
`<config>/mcctl/settings.json`. 2.0 (and 1.6) keeps using `mcctl/` on a machine that already had it,
but a machine that started on 2.0 has only `<config>/spawnloft/settings.json`, which 1.5.0 never
sees: after a rollback there it starts with no settings at all (default data folder, default
theme). That is true of every key, not only `bot.node`. `settings.json` in this folder records the
rule.

## 2. No installed build has `instances.json` in its code folder (plan 3.4, the data root)

Confirmed: no SpawnLoft package or writer puts it there, so Rust can drop the
`settings.mjs:169-173` rule (code folder holding `instances.json` is the data root). The code
folder is `<resources>/core`, and every package names the files that go into it:

- 1.x Electron builds: `desktop/package.json` `extraResources` copies `..` to `core` with a filter
  that admits only `mcctl.mjs`, `spawnloft.mjs`, `src/**` and `package.json` (and excludes
  `instances/`, `jars/`, `backups/`, `run/`), so a builder's own checkout data cannot ride along.
- 2.0 Tauri builds: `rust/crates/spawnloft-shell/installer/installer-config.mjs` (Windows) and
  `mac-config.mjs` (macOS) map `mcctl.mjs`, `spawnloft.mjs`, the stamped `package.json`, `src/` and
  `internal-defaults.json` into `resources/core`, one entry each; `linux-package.mjs` `layout()`
  lists the same files for the .deb and .rpm.
- The CLI package: `desktop/build-cli-package.mjs` `copyCore` copies the same four files and `src/`
  into `/opt/spawnloft-cli/core`, plus `internal-defaults.json`.

Nothing at run time writes `instances.json` anywhere but the data root, and the data root is the
code folder only by this rule itself or because a person chose it: `SPAWNLOFT_DATA_ROOT` set to the
code folder, or `config set-root` (or the first-run wizard) pointed at it. Both of those win over the
rule anyway, so it only decides anything after such a person also deletes `settings.json`. The
Linux packages install under `/opt` and `/usr`, owned by root, so not even that is possible there;
the Windows per-user install folder and a macOS app bundle are writable, so it is possible there
only by that deliberate choice, never by SpawnLoft. The other reader of the rule is
`desktop/main.js` `needsSetup` (1.x), which uses it to skip the first-run wizard in a checkout.

So the state is reachable from a checkout (`node spawnloft.mjs`, the developer's case the rule was
written for) and not from any installed build except by a person pointing the data folder at the
program folder. Dropping the rule in Rust is a declared difference for that case only.
