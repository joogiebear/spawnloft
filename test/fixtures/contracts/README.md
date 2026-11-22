# R1 contract fixtures

What the per-server daemon and the files around it promise, written down once so a second
implementation (the Rust daemon on `v2`) can be held to exactly what the Node code does. Plan:
PLAN-RUST-TAURI.md section 3 item 2 and section 12 (P0-A).

**C10 status.** The Node core these fixtures were written from is gone (2.0 has no Node: commit
`fe21ece` deleted `src/*.mjs` and `mcctl.mjs`; `git show fe21ece^:src/<file>` shows what a "Written
by" column names). The fixtures stay, and the Rust core is now the only thing held to them: the
`cargo test` suites of `spawnloft-lib` and `spawnloft-core` read these files, and the parity rig
holds the CLI to the records in `tools/parity/frozen/`. The Node tests described under "The tests"
and "How the C0 fixtures are checked" (`test/contracts*.test.mjs`, `test/panel-auth.test.mjs`) left
with the Node core, and `SPAWNLOFT_DAEMON` no longer picks a daemon: `spawnloft-core daemon` is the only
one. A Node-side column below is history. The generators that still run on Node are
`tools/make-ordering-fixture.mjs` and `tools/make-panel-auth-fixture.mjs`.

| File | Contract | Written by | Read by |
| --- | --- | --- | --- |
| `control-protocol.json` | the control channel: transport, the four ops, every reply | `src/daemon.mjs` | `src/control.mjs`, `src/supervisor.mjs` |
| `state.json` | `run/<name>/state.json` in every situation, and the status each reads as | `src/daemon.mjs` | `src/control.mjs` `readState` |
| `metrics.json` | `run/<name>/metrics.log` lines | `src/metrics.mjs` (in the daemon) | `readSamples`, `latestSample` |
| `activity.json` | `activity.jsonl` entries, actor kinds, every action name | `src/activity.mjs` (everyone; the daemon writes `crash`) | `readActivity`, the panel |
| `webhook.json` | the crash/recovery webhook request and every daemon message | `src/notify.mjs`, `src/daemon.mjs` | Discord or any http(s) endpoint |
| `instances.json` | the registry, every field the code has written, servers and databases | `src/registry.mjs` and its callers | the daemon (unlocked), everyone |
| `schedules.json` | scheduled task definitions, every action, step and schedule kind | `src/schedule.mjs`, `src/task-steps.mjs` | `spawnloft task run` |
| `panel-auth.json` | who may call the panel's HTTP API: the sign-in tokens, and the answer to whole requests in order | `tools/make-panel-auth-fixture.mjs` | `src/panel-auth.mjs` (the Node panel) and `rust/crates/spawnloft-lib/src/panel_auth.rs` (`spawnloft-core ui`), which must agree |

The C0 fixtures (rust/PLAN-CORE-PORT.md 3.4): every file the Node core and the Rust core will both
write, and the rules both must sort and match by. Held by `test/contracts-files.test.mjs` unless
the row says otherwise.

| File | Contract | Written by | Read by |
| --- | --- | --- | --- |
| `instances-writes.json` | the exact text `instances.json` has after each registry call: key order, two-space JSON, the newline, owner-only mode | `src/registry.mjs` (`util.mjs` writeJson) | everyone; `instances.json` has the shapes |
| `settings.json` | the per-user settings file: where it lives, the text of a save, that a save merges a patch and keeps keys it does not know, the refusal of a damaged file | `src/settings.mjs` save | every process, and 1.x after a rollback |
| `data-format.json` | `<data>/data-format.json`, the newest release that used the folder, and when a reader warns | Node never writes it; 2.0 does | `src/data-format.mjs` |
| `runtime.json` | `run/runtime.json` `{format, exe, root}`, when it counts as moved, and the text it is rewritten with | `src/relocate.mjs` (the panel at each start, `repair`) | the same |
| `task-files.json` | the task shims (`.sh`, `.cmd`), the server launchers (`.sh`, `.bat`), launchd plists, systemd units and the `schtasks` and `systemctl` command lines, as exact text per platform | `src/schedule*.mjs`, `src/create.mjs`, `src/entry.mjs` | Task Scheduler, launchd, systemd, a double-click |
| `task-runs.json` | `run/<server>/tasks.log` lines and how they are read back; `schedules.json` as create and update write it | `mcctl.mjs` runTask, `src/schedule.mjs` | the panel's task history, `spawnloft task run` |
| `backups.json` | backup names and folder layout, the manifest's text and key order, archive members, every `tar` command line (`EXCLUDE_ARGS`, `tarMember`), the database dump manifest | `src/backup.mjs`, `src/tar.mjs`, `src/services.mjs` | restore and verify, 1.x and 2.0 both ways |
| `zip.json` | zips as zip.mjs writes them: entry order, names, flags, methods, versions | `src/zip.mjs` (world export without a zip-capable tar, the file browser, diagnostics) | any unzip, `extractZip` |
| `engines.json` | the engine store's folder names and `spawnloft-engine.json` markers with Node's platform names | `src/garnet.mjs`, `src/mysql.mjs`, `src/mariadb.mjs` | `hasEngine` |
| `provenance.json` | the plugin store `.mcctl-plugins.json`, the modpack record `.mcctl-pack.json`, the client's `.spawnloft-mods.json` | `src/plugins.mjs`, `src/mrpack.mjs`, `src/client-fabric.mjs` | update checks |
| `client-files.json` | the launcher's files: `profiles.json`, `accounts.json` (owner-only), the version store layout, a profile's `servers.dat` and SpawnLoft's memory of it | `src/client*.mjs` | the launcher, the game |
| `activity.json` (`sites`, `dynamicSites`) | every `activity.record` call by file and line, with the actions it can record | every module | the panel's Activity page |
| `ordering.json`, `ordering-pairs.json` | the order `localeCompare` gives, for each variant the source calls, every call site, and random pairs with Node's answers | `tools/make-ordering-fixture.mjs` | `rust/crates/spawnloft-lib/src/collate.rs` (`cargo test -p spawnloft-lib collate`) |
| `regex.json` | the regular expressions the Rust `regex` crate cannot run (lookaround, backreferences), the four that take a pattern at run time and the policy for them, every other `new RegExp` | the source itself | each phase's rewrite |
| `locks.json`, `EXCLUSION.md` | lock files and exclusive-create files: every `acquireLock` site, the record, the stale rules, the `.install-lock`, `.pending` and marker files | `src/util.mjs` and several | held by `test/contracts-locks.test.mjs` and `test/lock-cross-process.test.mjs` |

`C0-CHECKS.md` records two confirmations the plan asks C0 for: that 1.5.0 keeps settings keys it
does not know, and that no installed build can have `instances.json` in its code folder.

Shapes are written in the small language described at the top of `shape.mjs`, which also checks
them. Examples are concrete values; the tests substitute live pids and paths where needed.

## The tests

- `test/contracts.test.mjs` holds each fixture against the Node functions that write and read the
  file (`sampleLine`, `readSamples`, `record`, `formatDiscord`, `readState`, the registry, the
  schedule normalisers) and scans the source for new state fields, control replies (by their field
  set and error text), activity actions and webhook message sites. The scans read one-line
  literals in top-level `src/*.mjs`: an action passed in a variable or a reply built over several
  lines is not seen, so keep to that style or extend the scan.
- `test/contracts-daemon.test.mjs` runs a real daemon with the fake java and fake Garnet and checks
  every control case marked `"asserted": "live"`, the exact field set of `state.json` in each
  situation, the webhook posts and crash entries, and a daemon run on the fullest registry record.
  It runs under whichever daemon `SPAWNLOFT_DAEMON` picks; `rust-internal.yml` runs it under both.
  Cases marked `"asserted": "source"` need a real engine failure or a race to reach and are checked
  against `src/daemon.mjs` instead.

`panel-auth.json` is different in kind: it is not a file format but a rule two listeners apply,
and it is generated (its tokens carry real HMACs, made with test keys and `node:crypto` alone).
`test/panel-auth.test.mjs` and the `panel_auth` tests under `cargo test` run every token and
every request in it; a request the two sides would answer differently is a hole in one of them.
Design: `rust/PANEL-AUTH-DESIGN.md`.

## Changing a contract

A failing contract test means the code and the fixture disagree. If the change is intended, update
the fixture in the same commit and say in the commit message that it changes a contract, because
the Rust daemon (and any reader of these files) has to follow. A new control op, a changed reply or
a changed pipe name is a protocol change: it also needs the protocol version in `ping` raised.
Readers must accept fields they do not know; writers must not drop fields the fixture lists.

Known quirk kept on purpose: a stop or kill during the restart delay replies `code: null` and leaves
`exitCode: null` in the state, not the crash's code (see `control-protocol.json`).

## How the C0 fixtures are checked

`test/contracts-files.test.mjs` imports `test/contracts-files-observe.mjs` first, which points the
data root, the settings folder and `HOME` at a scratch folder and then loads the Node modules. Each
test makes the real Node call with the fixture's inputs and compares the exact text, with the
scratch paths written back as placeholders (`<data>`, `<entry>`, `<code>`, `<node>`, `<mcctl>`,
`<config>`, `<home>`, `<ns>`) and times stamped with "now" as `<at>`. Where a writer only runs on
another platform it is run anyway when it only looks at `process.platform` at call time (the
launchers); otherwise its template is checked in the source and its formula run (the Windows `.cmd`
shim off Windows, `schtasks` everywhere), marked `"asserted": "source"`. Writers that need a
network or a running database (engine installs, modpacks, database dumps) are held against the
source. The launchd and systemd texts are compared on macOS and Linux, the `systemctl` calls and
`schedules.json` writes on Linux only (a stand-in `systemctl` on PATH); everything else runs on all
three.

The order fixtures are generated: run `node tools/make-ordering-fixture.mjs` only when the order is
meant to change, and say so in the commit. The test fails when this Node (its ICU, or the machine's
default locale) sorts differently from the fixture.

## Still not covered here

The CLI `--json` output fixtures and the MCP tool list are being added under `cli/` in this folder.
Panel routes (C8), `console.log` text beyond the daemon's own lines, and the files only the panel
writes for itself (the panel key, the window's state) are not covered yet.
