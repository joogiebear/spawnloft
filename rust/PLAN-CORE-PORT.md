# SpawnLoft 2.0: finishing the Rust core port

2026-11-21, rev 2 (planning thread "Plan finishing the Rust core port"; rev 1 reviewed by a fresh
Fable reviewer against the code, 6 blockers and 11 should-fix findings folded in, section 14).
Facts are from `v2` at c9f1ea1. Companion to `PLAN-2.0-REMAINING.md` ("the remaining-work
plan"), `INSTALLER-UPDATER-DESIGN.md` ("the design"), `PHASE0-FINDINGS.md` and the original
`PLAN-RUST-TAURI.md` rev 3.1 ("the original plan", in the project files). Planning only: this
document changes no code. Nothing is published, and nothing reaches `dev` or a feed until Victor
says "push to beta".

**What changed.** On 2026-11-10 Victor chose to ship 2.0 as the Tauri shell over a bundled Node
core and to port the core in 2.1. On 2026-11-21 he reversed the order: "I'm not worried about
beta. I want to keep building on 2.0, finish doing the port." So the core port (the original
plan's R2 to R6) moves into 2.0, and 2.0 ships with no Node.js inside it. This document
supersedes section 3B and the "after the beta (2.1 track)" paragraph of the remaining-work plan.
Everything else in that plan is done or unchanged.

## 0. Summary

The Node core is about 27,600 lines in 105 modules under `src/`, plus the 2,500-line command
table in `mcctl.mjs`. About 2,000 of those lines already have a Rust twin (the daemon and what it
needs, the panel's sign-in rule). The rest is ported in phases C0 to C10, in dependency order: a
parity rig first, then the foundation, server lifecycle, backups and files, server creation,
plugins, the scheduler and maintenance commands, the client launcher, the panel API, MCP, and
last the removal of Node from the package.

Three things make this safer than the original plan's "whole core behind one switch":

1. **The entry point already exists.** Since W1, every shim, launcher, task and MCP config runs
   `spawnloft-core`, which forwards what it does not own to Node (`cli::forwards`). A command
   moves to Rust by leaving that forward list. Nothing a user has on disk changes when it does.
2. **SpawnLoft was always several processes sharing files.** The CLI, the panel, the task runner
   and the daemons are separate processes today, coordinating through `instances.json`, lock
   and marker files, `state.json` and the control pipe. A Rust CLI beside a Node panel is the
   same arrangement as a Node CLI beside a Node panel, provided Rust honours the same file
   formats and the same exclusion files. Those become written contracts (section 3). The review
   looked for in-memory state in long-lived Node processes that a Rust writer would invalidate
   and found none beyond what a second Node process already has to live with.
3. **The Node source stays whole and frozen until the last phase.** No Node module is edited to
   call Rust, and none is deleted piecemeal. Rust takes over entry points (commands, then panel
   routes, then MCP); Node keeps answering whatever has not moved. `v2` builds and runs after
   every merge.

Size: 27 to 39 thread weeks (one Opus thread full time for a week), in two parallel tracks
after the lifecycle phase. The T and W threads ran at about a thread week per calendar day, so
this is weeks of calendar, not months, with Victor's three hardware gates (section 9) as the
floor. That calendar figure is an estimate from past pace, not a promise.

## 1. Where `v2` stands (c9f1ea1)

### 1.1 Rust on `v2`: 21,600 lines in four crates

| Area | Where | Lines | State |
| --- | --- | --- | --- |
| Per-server daemon (R1): control pipe, crash guard, metrics, tick, RCON, RESP, diagnosis, webhook, activity writer, read-only registry | `spawnloft-lib/src/daemon/`, `metrics.rs`, `tick.rs`, `rcon.rs`, `resp.rs`, `diagnose.rs`, `notify.rs`, `activity.rs`, `crashguard.rs`, `registry.rs`, `platform/` | about 5,800 | Done, default and required in every 2.0 build |
| Signed updater with rollback and hold | `update/` | about 4,700 | Done |
| 1.x handover, repair, uninstall, PATH | `handover/`, `spawnloft-core/src/handover_cmd.rs`, `user_path.rs` | about 4,500 | Done, but `resume`, `repair` and `uninstall` still call the Node core (`nodecore.rs`) |
| Panel endpoint: sign-in rule and reverse proxy to the Node panel | `panel.rs`, `panel_auth.rs` | about 2,100 | Done; answers `/api/update*` and `/api/handover*` itself, proxies the rest |
| Entry point, forwarding, bundled-Node lookup | `spawnloft-core/src/cli.rs`, `runtime.rs` | about 700 | Done |
| Tauri shell: window, bridge, zoom, window state, updater glue | `spawnloft-shell/src/` | 2,650 | Done |

The Rust core has no async runtime: std threads, blocking I/O, `ureq` for HTTPS. Its direct
dependencies are `serde_json`, `regex`, `windows-sys`, `minisign-verify`, `semver`, `sha2`,
`ureq`, `hmac` and `getrandom` (`SUPPLY-CHAIN.md`).

### 1.2 Node still in the package

| What | Lines | Note |
| --- | --- | --- |
| `src/*.mjs`, 105 modules | 27,645 | No npm dependencies; Node built-ins only |
| `mcctl.mjs`, the command table | 2,499 | 48 commands, 61 names with aliases |
| `src/bot-host.cjs` and its lockfile | 398 | Mineflayer host; stays Node (section 5.4) |
| `src/ui.html`, `launcher.html`, `setup.html` | 21,517 | The panel pages; not ported, served as they are |
| Bundled Node 24 runtime | about 30 MB compressed | `resources/runtime/node-<ver>/` |
| Tests: `test/*.test.mjs`, 138 files | 27,986 | About 1,650 tests; 123 files import `src/` modules directly |

Already twinned in Rust and still present in Node (2,042 lines): `daemon`, `crashguard`,
`metrics*`, `tick`, `ready`, `resp`, `rcon`, `diagnose`, `notify`, `panel-auth`.

### 1.3 How a 2.0 build runs today

```
SpawnLoft (Tauri shell)
  └─ spawnloft-core ui --port 0 --exit-with-stdin        Rust: sign-in, /api/update*, /api/handover*
       └─ proxies everything else to: <bundled node> resources/core/spawnloft.mjs ui
            └─ the whole Node core
                 └─ spawns spawnloft-core daemon <name>   Rust

spawnloft <command>  ->  spawnloft-core <command>
  ├─ own: --version, daemon, handover, update, user-path, ui (window form),
  │       repair --quiet, uninstall --yes                (three of these call Node)
  └─ every other command: forwarded to the Node core on the bundled Node
```

## 2. Rules of the port

1. **Parity, not features.** A ported command prints the same text, the same `--json`, the same
   exit code, and leaves the same files. Improvements wait until the Node twin is gone. Allowed
   differences are only those in the declared-differences table (section 6.1), which starts
   with: a shell-out replaced by a native call with the same result (`taskkill`, `tasklist`,
   `icacls`, PowerShell process queries), and output that names Node itself.
2. **Node is frozen and whole.** No new features in `src/`. A bug fix to a module whose Rust
   twin exists lands in both in one PR. No Node module is deleted before C10. One named
   exception: the test-only download-host override of section 6.2.
3. **One entry point, one owner per command line.** `spawnloft-core` answers a command in Rust
   or forwards it; never half of each. Ownership is a table in `cli.rs` keyed by command and,
   where needed, a flag (as `repair --quiet` is today; `new --modpack` stays with Node until
   C5).
4. **Same files, same exclusion.** Rust writes every shared file in the format the Node writer
   produces (key order, number form, line endings, file mode or ACL) and takes the same lock
   and marker files with the same record. `dataFormat` does not change during the port, so
   "Reinstall a previous version" and a manual return to 1.x keep working at every step.
5. **A command moves only when its parity scenarios are green on Windows, macOS and Linux.**
6. **No async runtime.** The core stays on std threads and blocking I/O. The panel holds a
   handful of connections and three event streams; downloads run on a small thread pool. This
   keeps the crate tree, the binary and the supply-chain review small (Q3).
7. **Context is passed, not ambient.** Node carries two things implicitly through
   `AsyncLocalStorage`: who is acting, for the activity log (`activity.mjs:20-27`), and the
   cancel handle of the running job (`cancel.mjs:13-40`). In Rust both travel in one explicit
   context value handed to every library call, including work sent to the download pool. Parity
   scenarios cover the actor recorded for a CLI, a task, a panel and an MCP call, and a cancel
   in the middle of a download (MCP `notifications/cancelled` included).
8. **Arguments are parsed the way `args.mjs` parses them** (43 lines, ported by hand), not with
   `clap`, because flag handling is part of the contract. A usage error exits 2, as Node's does
   (`mcctl.mjs:2487`); the installer-facing commands the core already owns keep their own
   codes.
9. **System tools stay system tools.** Where Node runs `tar`, `schtasks`, `launchctl`,
   `systemctl`, `loginctl`, `java` or `git`, Rust runs the same program with the same
   arguments. In particular there is no tar implementation to port: `tar.mjs` is a 56-line
   wrapper over the system `tar` (with the `System32\tar.exe` rule and the `./` member guard),
   and backups, restores, world exports and engine installs go through it.
10. **Security-sensitive phases get a Fable review before merge** (locks and private files, zip
    extraction, modpack install, uninstall and data moves, account tokens, the panel API, MCP).
    Others get the standard Opus review pass.

## 3. How Node and Rust coexist

### 3.1 Commands

`cli::forwards` becomes an ownership table. Each phase flips its commands (section 4). One
switch exists for CI and support only:

- `SPAWNLOFT_CORE_IMPL=node` makes `spawnloft-core` forward every command Node can still answer,
  whatever the table says. The parity rig uses it to run the same scenario on both sides.
  Unset, the table decides. It is never written into a shim and is removed in C10.

`task run`, `mcp` and `ui` are commands like any other: scheduled tasks stop starting Node when
`task run` flips in C6, MCP when `mcp` flips in C9.

### 3.2 The panel

The proxy stays until C8. Route families do **not** flip one at a time as their modules land,
because the Node panel keeps state in its own process: the job table and its cancel handles
(`ui.mjs:313-318`) are written by every route that starts a download, an install, a database
or a game launch, and read back through `/api/jobs/<id>` and the event streams. So between C1
and C8 the window keeps talking to the Node panel, which keeps calling Node modules, while the
command line runs Rust. Both sides meet at the files and the exclusion files, as two Node
processes do today. In C8 the 18 route families move in three groups (section 4, C8), and every
route that makes or reads a job moves in the same group.

### 3.3 MCP

`spawnloft-core mcp` forwards to the Node MCP server until C9. The Node tools call Node modules
in their own process, which is why the Node source stays whole. In C9 the server and its 39
tools move at once.

### 3.4 Shared files and exclusion

The contract fixtures under `test/fixtures/contracts/` cover the daemon's files today. C0 extends
them to everything two implementations will both write:

| Contract | Written by (Node) | Why it matters |
| --- | --- | --- |
| Lock files: `instances.json.lock` and every other `acquireLock` site. Record `{pid, token}`, legacy bare pid, the same-pid-is-alive rule, token-checked release, the `.break` breaker file with its 2 s write grace and 10 s staleness (`util.mjs:221-360`) | `util.mjs` | A Rust writer and a Node writer must exclude each other. C0 lists every site and adds a cross-process test in both directions |
| Every other exclusive-create file and pid marker: engine `.install-lock` (empty, no stale rule; `garnet.mjs:140`, `mysql.mjs:81`), backup and dump `.pending` reservations (`backup.mjs:139`, `services.mjs:455`), the restore marker (`control.mjs:92-130`), `stop-asked.json` (`client-launch.mjs:227`) | several | Same reason; these are not `acquireLock` and would be missed by a search for it |
| `instances.json` writes (the fixture exists for reads) | `registry.mjs` and callers | Rust becomes a writer in C1 |
| `settings.json`, `data-format.json` | `settings.mjs`, `data-format.mjs` | Read by 1.x after a rollback |
| `run/runtime.json`: `{format, exe, root}`, where `root` is the Node code folder (`relocate.mjs:22-38`) and the Node panel compares all three at every start (`ui.mjs:71`) | `relocate.mjs` | While both sides live, Rust writes `root` as `<resources>/core`, the string Node computes, or each side would rewrite every shim after the other ran. From C10 Rust ignores `root` when comparing |
| Task shims, server launchers, launchd plists, systemd units, Task Scheduler XML: the exact text per platform | `schedule*.mjs`, `create.mjs` | The text comes from `SPAWNLOFT_ENTRY`, which is the core's own path, so Rust can reproduce it; then `RUNTIME_FORMAT` stays 2 and nothing is rewritten on update |
| `tasks.log`, `schedules.json` writes | `schedule.mjs`, `task-steps.mjs` | Panel history |
| Backup manifests, snapshot folder layout, the `tar` argument lists (`EXCLUDE_ARGS`, `tarMember`), zip entry order and flags | `backup.mjs`, `tar.mjs`, `zip.mjs` | A 1.x build must restore a 2.0 backup and the reverse |
| Engine store markers: `spawnloft-engine.json` records Node's platform names (`win32`, `darwin`, `x64`, `arm64`) and is compared on read (`garnet.mjs:118,173`) | engine modules | Rust writes Node's names, not Rust target names |
| Plugin and modpack provenance records | `plugins.mjs`, `mrpack.mjs` | Update checks compare against them |
| Client files: profiles, accounts (owner-only), version store layout, the server list (`servers.dat`) | `client*.mjs` | Nobody should have to sign in again or re-download a version |
| Activity actions beyond `crash` | every module | The panel's Activity page |
| Sort order: `localeCompare` orders `list`, plugins, jars, tasks, files and worlds | several | Rust has no ICU. C0 adds an ordering fixture (mixed case, digits, `-`, `_`) and one comparison function every phase uses. Server names are limited to letters, digits, `-` and `_`, so their order can match exactly; free text with other scripts is a declared difference |

**Regular expressions.** The Rust `regex` crate has no lookaround and no backreferences. Seven
regex lines in the source use them; C0 lists them and each phase rewrites its own with a test
that feeds both sides the same inputs. Four places take a pattern at run time in JavaScript
dialect: `logs --grep` (`mcctl.mjs:293`), the MCP `get_logs` grep (`mcp-tools.mjs:116`), bot
scenario patterns (`bots.mjs:180`) and Mojang's `rule.os.version` (`client-meta.mjs:80`). Policy:
they run on the `regex` crate; a pattern using syntax it lacks is refused with a clear message
(a declared difference), and the Mojang patterns are checked against every manifest in the
captured fixtures.

**The data root.** Node treats its own code folder as the data root when `instances.json` sits
in it (`settings.mjs:169-173`), a rule for running from a checkout. Rust drops it; C0 confirms
no installed build can be in that state.

### 3.5 What Node still does for Rust, and when it stops

| Seam today | Ends in |
| --- | --- |
| `handover resume` starts servers through `node spawnloft.mjs start` (`nodecore.rs`) | C2 |
| The daemon takes a database's launch spec on stdin from the Node supervisor | C2 (the Rust supervisor passes the same spec; the flag stays so an older core can start a newer daemon) |
| `repair --quiet` and `uninstall --yes` run the Node core | C6 |
| The panel proxy | C8 |
| Command forwarding, `SPAWNLOFT_ENTRY`, the bundled runtime | C10 |

After C6 the installer and the uninstaller never start Node, which closes the whole class of
"Node could not run during an install" failures (remaining-work plan A1) well before the
runtime itself leaves.

## 4. Inventory and port order

Node lines per phase are measured; Rust lines and thread weeks are estimates. Rust runs about
1.2 to 1.4 times the JavaScript it replaces, tests not counted. A module is listed where most
of it is ported; a helper a phase needs from a later module is pulled forward by name.

| Phase | Node modules | Node lines | Commands that flip to Rust | Weeks |
| --- | --- | --- | --- | --- |
| **C0 Parity rig** | none ported | 0 | none | 1.5 to 2.5 |
| **C1 Foundation and status** | `util`, `settings`, `paths`, `env`, `platform`, `registry` (writes and lock), `control` (client), `private-files`, `props`, `args`, `cli-output`, `cli-query`, `cli-metrics`, `activity` (reader), `data-format`, `entry`, `exposure`, `log-timeline`, `download`, `cancel`, `tar`, `zip`. Pulled forward: `supervisor.statusOf`, `tailLog`, `followLog`; the engine labels of `services` | 3,079 | `help`, `list`, `status`, `logs`, `why`, `metrics` | 3 to 4 |
| **C2 Lifecycle and databases** | `supervisor`, `daemon-launch`, `java`, `services`, `mariadb`, `garnet`, `mysql`, `linux-libs`. Pulled forward: `plugins.mcVersionOf`, `client-auth.offlineUuid`, `create.placeJar` and `strayJars` | 2,778 | `start`, `stop`, `restart`, `kill`, `cmd`, `send`, `console`, `players`, `set`, `props`, `db` | 2.5 to 3.5 |
| **C3 Backups and files** | `backup`, `worlds`, `files`, `config-files` | 2,089 | `backup`, `snapshots`, `restore`, `prune`, `verify`, `worlds`, `config` | 2 to 2.5 |
| **C4 Creating and updating servers** | `create`, `manage`, `software`, `sources`, `paper`, `purpur`, `vanilla`, `asp`, `buildtools`, `fabric`, `neoforge`, `upgrade` | 1,741 | `new` (without `--modpack`), `clone`, `adopt`, `rebuild`, `paper`, `upgrade`, `launchers`, `templates`, `jars`, `reveal` | 1.5 to 2.5 |
| **C5 Plugins and modpacks** | `plugins`, `plugin-actions`, `mrpack` | 1,514 | `plugins`, `pack`, `new --modpack` | 1.5 to 2 |
| **C6 Scheduler and maintenance** | `schedule`, `schedule-mac`, `schedule-linux`, `task-steps`, `relocate`, `data-move`, `tree`, `private-copy`, `uninstall`, `mclogs`, `players`. Pulled forward: `scrubber` from `mcp-tools`, as its own module | 3,025 | `task`, `repair`, `data`, `uninstall`, `rm`, `rename` | 3 to 4 |
| **C7 Client launcher** | the 22 `client*.mjs` modules and `doctor-client`. Pulled forward if C5 has not landed: the Modrinth request helpers and the zip readers of `plugins`; `bots.checkInstance` | 6,645 | `client` | 5 to 7 |
| **C6b Diagnostics** | `doctor`, `diag-bundle` | 517 | `doctor`, `diag` | 0.5 to 1 |
| **C8 Panel API** | `ui`, `panel-open`, `first-run`, `appearance` | 2,718 | `ui` | 3 to 4 |
| **C9 MCP and bots** | `mcp`, `mcp-tools`, `mcp-client-tools`, `bots` | 1,497 | `mcp`, `bot` | 1.5 to 2.5 |
| **C10 Node leaves** | deletes `src/*.mjs`, `mcctl.mjs`, the runtime | 0 | none left to forward | 2 to 3 |
| **Total** | | 25,603, plus the 2,499-line command table spread over the phases | | **27 to 39** |

Why this order (each claim checked against the import graph and the handlers in `mcctl.mjs`):

- **C0 first** because nothing may flip without a way to prove parity (section 6).
- **C1** is the layer everything imports (`util` alone has 72 importers). `download`, `cancel`,
  `tar` and `zip` are here because the database engines (C2), backups (C3) and the client (C7)
  all need them. Its commands only read, and `list --json` and `status --json` are what scripts
  and task shims call most, so the rig is proven end to end on commands that cannot damage
  data. They need the read side of the supervisor, which is why that is pulled forward.
- **C2 before backups and creation** because a backup stops or flushes a running server and a
  new server is started at the end of `new`. It also removes the first Node seam (`resume`).
- **C3 before C4** because `manage` and `upgrade` import `backup` and `files`: a rebuild and an
  upgrade take a snapshot first.
- **C5 and C6 side by side after C4.** `rm` and `rename` flip in C6, not C4, because they call
  the scheduler (`manage.mjs:139,210`), and `relocate` in C6 imports `create`.
- **C7 is the second track**, starting when C2 has landed (it needs `java` and the foundation).
  It does not touch servers except through the registry.
- **C6b after C6 and C7** because `doctor` and `diag` import six client modules
  (`diag-bundle.mjs:14-21`, `doctor.mjs:12-15`).
- **C8 and C9 last** because the panel and MCP call every module. By then each route and tool
  is a thin layer over library code that the command line has already exercised for weeks.
- **C10** only when the forward table is empty.

```
C0 ─ C1 ─ C2 ─┬─ C3 ─ C4 ─┬─ C5 ───────────┐
              │           └─ C6 ─┐         ├─ C8 ─┐
              └─ C7a ─ C7b ──────┴─ C6b ───┴─ C9 ─┴─ C10
```

### Phase notes

**C0, parity rig.** Section 6 describes it. Also delivered: the exclusion-file inventory and the
cross-process lock test, the new contract fixtures of 3.4, the regex list, the ordering
fixture, the declared-differences table, the download-host override and the fake host behind
it (6.2), and the `--json` fixtures for every command and the MCP tool list (the original
plan's "first week of step 2").

**C1.** The registry becomes read-write in Rust under the shared lock. `private-files` moves
from `icacls.exe` to the owner-only DACL code the daemon already has (`platform/windows.rs`);
the resulting ACL is compared with what `icacls` produced. The zip reader and writer get
`cargo fuzz` targets and a cross-read test: archives made by Node are read by Rust and the
reverse, with non-ASCII names, the UTF-8 flag and path-traversal entries (refused the same
way). `plugins.mjs` has two more zip readers (`readZipEntry`, `extractZip`); all three become
one Rust module here. Check items: name resolution and TLS under musl on x64 and arm64, and
whether `ureq` reads proxy variables from the environment where Node's `fetch` does not; the
two must behave the same. Fable review (locks, private files, zip). New dependency candidates
across the port, each added under the `SUPPLY-CHAIN.md` rule in the phase that needs it: `sha1`
(Mojang and Modrinth hashes), `md-5` (Purpur's download hash, offline player UUIDs), `flate2`
(zip and gzip), an Ed25519 verifier for the signed harness index (`ed25519-dalek`, or the
Ed25519 inside `minisign-verify` if it can be reached).

C1 records, checked 2026-11-21:
- *Proxy variables.* `ureq` 3 reads `ALL_PROXY`, `HTTPS_PROXY` and `HTTP_PROXY` (either case) and
  `NO_PROXY` by default (`Proxy::try_from_env` in its default config). Node's `fetch` reads none
  of them unless `NODE_USE_ENV_PROXY` is set (checked on the pinned 24.22.3 and on 22: with
  `HTTPS_PROXY` pointing at a listener, `fetch` went straight to the host), and SpawnLoft never
  sets it. So `download.rs` builds every agent with the proxy off, and the two behave the same:
  `download::tests::proxy_variables_are_ignored_as_node_ignores_them` and the `musl-network` CI
  job, which runs both sides with every variable pointing at a port that refuses. The updater's
  agent (`update/fetch.rs`) still reads them; it has no Node twin. Honouring a proxy is a feature
  for both sides together, not a parity question.
- *musl.* The `musl-network` CI job builds a probe on `spawnloft-lib`'s download agent static for
  `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` and fetches from Mojang's and
  GitHub's hosts on the runner and in Debian slim and Alpine containers with their CA stores
  removed: names resolve through musl's own resolver and TLS verifies against the bundled
  `webpki-roots`.
- *The zip readers.* The cross-read test (`test/zip-cross-process.test.mjs`) found one Node bug,
  fixed on both sides in the same PR: a failure while writing an extracted entry (a folder in the
  way, a full disk, compressed data that does not inflate) was reported as `EBADF: bad file
  descriptor, close`, because the failed pipeline closed the archive's descriptor under the
  `finally`. Damaged compressed data is now the checksum sentence on both. The Fable review
  found a second, fixed on both sides too: the jar reader read an entry's declared compressed
  size even past the end of the file (zero-filled) and inflated it without bound, so a jar of a
  few hundred bytes in a mods folder could take gigabytes. It now reads only what the file holds
  and inflates no more than the entry's declared size (`null` past it, as for any unreadable
  entry). On Windows the Rust extraction hands the system `\\?\` paths, as Node's
  `toNamespacedPath` does, so names ending in a dot or space and device names stay literal.

**C2.** `console` is interactive: raw input and console modes on Windows, signals on Unix. The
database engines keep the layout of the engine store exactly, since a running database's files
are the user's data. `handover resume` starts servers in-process; `nodecore.rs`'s `Starter`
goes.

**C3.** Backups and restores keep calling the system `tar` with the argument lists Node builds
(rule 9). The macOS check owed from the design (no quarantine attribute added by our
extraction) is done here.

**C4.** Downloads keep every verification Node does (sha1, sha256, md5, sizes), the retry and
redirect rules, the user agent and the cancel behaviour. BuildTools still runs Java and Git as
it does today.

**C5.** Modpack install keeps the hardening tests (`modpack-hardening.test.mjs`) case for case.
Fable review.

**C6.** The scheduler keeps calling `schtasks`, `launchctl`, `systemctl --user` and `loginctl`
exactly as Node does; a native Task Scheduler client is not part of the port. The capitals-only
rename fix (#233) and the per-user repair of the CLI package (#234) are carried over with their
tests. `players.mjs` (bans, whitelist, name lookups) is used by the panel and MCP, not by the
`players` command, so its parity is proven by the route and tool replays of C8 and C9.
`uninstall` and `data move` delete and move user data: Fable review.

**C7.** The largest phase and the least coupled to servers. Microsoft sign-in (OAuth with PKCE,
the Xbox chain), the Mojang metadata, five loaders including the Forge installer engine, Java
runtime download, the harness socket and the signed harness index. Split in two threads: C7a
accounts, metadata, install and launch; C7b loaders. Beyond the foundation it imports `java`,
`registry`, `exposure`, `diagnose`, `cancel`, the Modrinth helpers and zip readers of
`plugins`, and `bots.checkInstance` (`client.mjs:12,25`). Token storage and signature checks:
Fable review. Sign-in is re-verified by Victor on all three platforms (gate G2).

**C6b.** Small, and only possible once both tracks have met.

**C8.** The Rust panel already terminates HTTP and applies the sign-in rule. It gains a router
and serves the three pages itself. Groups, in order: (a) static pages, `health`, `settings`,
`appearance`, `setup`, `java`, `jars`, `software`, `feedback`, `diagnostics`, `mcp`; (b)
`overview`, `activity`, `scheduler`; (c) everything that makes or reads a job, together:
`instances`, `jobs`, `modpacks`, `databases`, `client` and accounts with the loopback sign-in
callback, and the three event streams. The final PR removes the proxy and `start_node_panel`.
`panel-open`, the one-use browser sign-in link behind `spawnloft ui`, moves with group (a). The
pages are compiled into the binary, so the headless package is one file and a page can never
be a different version from the API behind it; `SPAWNLOFT_CORE_DIR` still reads them from disk
for development. Fable review of the whole API surface (path checks, upload limits, origin and
host rules, what each route may touch).

**C9.** The MCP server over stdio with the tool list byte-equal to the fixture, the scrubber,
`--allow-destructive` and `--show-ips`. `bot` moves; the Mineflayer host it drives does not
(section 5.4).

**C10.** Section 5.

## 5. What happens to the bundled Node, the CLI and MCP

### 5.1 The bundled runtime

It leaves the package in C10, together with everything that exists only to carry or check it:

- `resources/runtime/` and `resources/core/` (the Node source, the `.mjs` forwarders,
  `package.json`, `internal-defaults.json`, `LICENSE`, which moves beside the binary). The
  pages and the bot host files are inside the core binary from C8 and C9.
- Packaging: `stage-runtime.mjs`, `core-package.mjs`, `desktop/node-pin.mjs`,
  `node.entitlements` (the Mac build no longer signs anything with JIT entitlements), the
  `node-pin.yml` workflow, the resource maps in `installer-config.mjs`, `mac-config.mjs` and
  `linux-package.mjs`, the runtime blocks and the `SPAWNLOFT_NODE_DIR` requirement in
  `installer.nsi`, `verify-mac-build.cjs`, `ci/linux-upgrade.sh`, `libstdc++` from the Linux
  package dependencies, and the `bin/node` runtime link and `build-info.json` `node` field in
  `build-cli-package.mjs` (5.2).
- Gates: `release-gate.mjs` reads the installed version from `resources/core/package.json` and
  `payload-gate.mjs` checks the runtime; both switch to `spawnloft-core --version` and to the
  opposite rule, refusing a package that contains a `node` binary or a core `.mjs` file.
- Rust: `runtime.rs`, `nodecore.rs`, the forward path in `cli.rs`, the `--core-dir` the shell
  passes (`spawnloft-shell/src/main.rs:217-277`).
- What must **keep** reading a `resources\core`: `handover/legacy.rs` reads the 1.x install's
  `mcctl.mjs` and `package.json` to recognise and stop 1.x. The installer therefore removes the
  folder only after `handover stop` has run.
- `daemon.mjs` goes with the rest, so `SPAWNLOFT_DAEMON=node` and the `daemon` setting stop
  meaning anything; a leftover `"daemon": "node"` is ignored and `doctor` says so.

Expected effect, to be measured in C10 and not promised here: the Windows installer drops from
about 30 MB to under 10, a command line call from a Node start (hundreds of milliseconds) to a
few, and a scheduled backup no longer starts a JavaScript engine.

### 5.2 The command line

Nothing a person types changes. `spawnloft` and `mcctl` stay as forwarders to `spawnloft-core`
at the 1.x paths, on PATH where 2.0 already puts them. The 48 commands, their aliases, flags,
`--json` output and exit codes are the contract the rig holds. `--core-help` folds into `help`.

Compatibility forms that must keep working after Node is gone:

| Who still runs the old form | Form | What answers it after C10 |
| --- | --- | --- |
| 1.x task shims not yet rewritten, hand-written 1.x MCP configs (desktop) | `SpawnLoft.exe <...>\mcctl.mjs <command>` | The shell's argv compatibility, already there, hands the command to `spawnloft-core`. The `.mjs` file does not need to exist: the argument is dropped, never run |
| 1.x CLI package shims and MCP configs | `/opt/spawnloft-cli/bin/node /opt/spawnloft-cli/core/mcctl.mjs <command>` | `bin/node` becomes a link to `spawnloft-core`, and the core gains the same rule: a first argument ending in `mcctl.mjs` or `spawnloft.mjs` is dropped. It only ever strips that one argument and never executes it |
| 2.0 internal builds | `spawnloft-core <command>` | Unchanged |

Running from a checkout becomes `cargo run -p spawnloft-core -- <command>`; the root
`spawnloft.mjs` and `mcctl.mjs` go.

### 5.3 MCP

The config form `spawnloft-core mcp` has been the documented one since W1 and does not change.
The server name, the 39 tool names and their schemas are a fixture. An MCP session that was
started before an update keeps running the old program until the assistant restarts it; section
7 says what that needs.

### 5.4 The bot host and the harness mod

Both stay as they are. The harness mod is Java. The bot host is Mineflayer, which is npm
packages installed on demand by `bot setup`, and that already needs a Node.js with npm on the
machine (`BOTS.md`). Today the host then runs on the bundled Node; after C10:

- The core writes `bot-host.cjs` and the pinned lockfile from its embedded copy into the data
  folder's bot host directory before `npm ci` or a run (today they are read from the code
  folder, `bots.mjs:33-38`).
- It starts the system Node found on PATH, or named by a `bot.node` setting, with
  `NODE_OPTIONS` and `NODE_PATH` removed as `runtime::prepare` does today, after a minimum
  version check. `bot check` and `doctor` say when there is none.
- `bot.node` is a new settings key. `settings.save` merges a patch, so older builds keep keys
  they do not know; C0 confirms that for 1.5.0, and an environment variable is the fallback.

Bots are a plugin-testing tool, so asking for Node there is reasonable (Q4).

### 5.5 Tooling and test hooks

The release scripts and smokes under `desktop/`, the installer packaging scripts, the test
fakes (`fake-java.mjs`, fake MariaDB, fake Garnet, fake client) and the black-box tests stay
JavaScript and run on the developer's or the runner's Node. Node becomes a build and test tool,
not something a user's machine ever runs (Q5). The hooks those tests rely on are carried into
Rust as a list, so none is lost by accident:

| Hook | Today | In Rust |
| --- | --- | --- |
| A `java` or engine binary ending in `.mjs` runs on Node | `process.execPath` (`daemon-launch.mjs:91` `--node`, `garnet.mjs:124`, `mariadb.mjs:202`, `client-launch.mjs:139`) | Runs on `SPAWNLOFT_NODE`, then `node` on PATH, only in a build with the `test-hooks` feature, which release packages are built without and the gate checks for |
| The fake client | `MCCTL_FAKE_CLIENT`, only when `NODE_ENV === 'test'` | The same variable, only with `test-hooks` |
| Timing overrides: `RESTART_DELAY_MS`, `FLUSH_TIMEOUT_MS`, `RCON_TIMEOUT_MS` | read as `SPAWNLOFT_*` then `MCCTL_*` (`env.mjs`) | The same, both spellings, as the daemon already does |
| `SPAWNLOFT_DATA_ROOT` / `MCCTL_DATA_ROOT` | both, forever (launchd plists set the old one) | Both, forever |
| `SPAWNLOFT_HARNESS_INDEX_FETCH=off` | the only network switch today | Kept |
| Download hosts | hard-coded `https://` constants in about a dozen modules | The override of 6.2 |

## 6. What proves parity

The existing Node suite cannot be pointed at Rust as it is: 123 of the 138 test files import
`src/` modules and call their functions, and they fake the network inside the test process.
So the proof has six layers.

1. **Contract fixtures** (3.4): file formats and protocols, asserted by Node tests and by
   `cargo test` from the same JSON.
2. **The differential rig** (new, `tools/parity/`). A scenario is a list of command lines with
   the fakes it needs. The rig runs it twice in two scratch data roots, once with
   `SPAWNLOFT_CORE_IMPL=node` and once without, and compares stdout, stderr, the exit code and
   the resulting data tree: file list, JSON files after normalising pids, times, ports and
   paths, archive listings, file modes and ACLs. The same runner replays HTTP request lists
   against the Node panel and the Rust panel (C8) and JSON-RPC lists against both MCP servers
   (C9). It runs in `rust-internal.yml` on Windows, macOS and Linux (x64 and arm64) on every
   pull request. Each phase adds the scenarios for its commands before it flips them, including
   failure paths (wrong name, port in use, bad archive, download refused, cancelled job).
3. **The Node suite stays green.** It proves the frozen Node side did not move, and the daemon
   suites keep running under the Rust daemon. The 18 test files that already spawn the CLI, and
   the panel tests that only use HTTP, are switched to start `spawnloft-core`, so they test
   whichever side owns the command.
4. **Rust unit tests from the Node tests.** Each phase PR carries a table: Node test file, its
   cases, the Rust test that covers each. A dropped case needs a reason. About 1,650 tests are
   the checklist.
5. **Real servers and real clients.** The bot harness (`spawnloft bot check`, scenario runs)
   against a real Paper server created, started, backed up and restored by the Rust core, on
   Desktop-Main through Remote Control (never mc-test at .131). The harness mod and
   `client_launch` for C7. The installer workflows (`installer.yml`, `installer-mac.yml`,
   `installer-linux.yml`) with their no-Node-on-PATH scenarios. The panel in a real browser and
   in the Tauri window (`smoke-panel.cjs`, `smoke-tauri.cjs`) for C8.
6. **Fuzzing** of every reader of outside bytes that is our own code: zip, mrpack,
   `server.properties`, `servers.dat`, Mojang and loader metadata, JSON-RPC, HTTP request
   heads.

Before C10 deletes Node, the rig's Node-side outputs are frozen as golden files, so the same
scenarios keep guarding the Rust core against itself afterwards. The Node unit tests of deleted
modules are deleted with them; their cases live on as the Rust tests of layer 4.

### 6.1 Declared differences

The rig normalises these and nothing else; adding a row needs a reason in the PR.

| Where | Node | Rust |
| --- | --- | --- |
| `doctor`, the diagnostics bundle, the panel's diagnostics | a `node: <version>` line and the code `root` | the core's version; no `root` |
| `repair` text and `--json` | `runtime: <node path>` | the core's own path |
| Free-text sort order outside ASCII | ICU collation | the port's comparison function (3.4) |
| Number grouping (`toLocaleString`, `mcctl.mjs:921,939`) | the system locale | fixed en-US grouping |
| A run-time pattern using lookaround, a backreference, a lone surrogate escape, a count beyond 2^32 or more than the matcher's limits (the last three added in C1) | accepted | refused with a clear message (3.4) |
| The error text for an invalid run-time pattern | V8's | the `regex` crate's |
| An unexpected failure (added in C1) | the error line, then JavaScript's stack | the error line alone |
| The text of a JSON file that does not parse (added in C1) | V8's `JSON.parse` message | serde_json's |
| A checkout whose code folder holds `instances.json` (added in C1, C0-CHECKS.md section 2) | the code folder is the data root | the per-user data folder |
| A run-time pattern meeting a character outside the BMP (added in C1) | matched as two UTF-16 units | matched as one character |
| A JSON file holding half of a surrogate pair (added in C1) | kept, re-escaped in JSON output | read as U+FFFD, and written back so when the Rust core changes that file (the registry from C1) |
| A JSON number beyond the double range (added in C1) | Infinity | refused as unparseable |
| A state file's `daemonStartTime` (added in C1, design D4) | ignored | decides, where the system reports a creation time |
| A settings value of the wrong type (added in C1) | uncaught crash with excerpt, stack and version | the error line alone |
| Windows: why a secrets file is not owner-only, or could not be made so (added in C1; shown by `doctor` from C6b) | icacls's output: its account names and error text | the security API's: account names looked up from each SID, errors as the system words them |
| Windows: the local time zone of the log timeline (added in C1; shown by the diagnostics bundle from C6b) | `TZ` when set, else the system's | the system's |
| The bytes of a zip the core writes (added in C1; world exports from C3) | zlib's deflate | miniz_oxide's: the same entries, names, times, modes and contents, so the archive is not byte-identical |
| A jar entry whose compressed data is damaged part way (added in C1) | zlib's words for that damage (`invalid distance too far back`) | `invalid compressed data`; data cut short is `unexpected end of file` on both |
| The cause named when a download gets no answer at all (added in C1) | undici's (`getaddrinfo ENOTFOUND x`, `connect ECONNREFUSED`) | ureq's; the sentence around it is Node's |
| `console` given `/detach` or `/exit` with more lines behind it in the same piped read (added in C2) | the lines after it in that read are still sent | nothing after it is sent |

### 6.2 Faking the network for a spawned process

The rig runs real processes, so the in-process fakes of the Node tests do not reach them, and
every download endpoint in Node is a hard-coded constant. C0 adds one mechanism to both sides:
a test-only map from origin to replacement origin (`SPAWNLOFT_TEST_ORIGINS`), read by Node's
`fetchRetry` and its few direct `fetch` callers only when `NODE_ENV === 'test'`, and by Rust
only in a `test-hooks` build. It is the one named exception to the Node freeze. The alternative,
a TLS-intercepting proxy with a test CA, was set aside: it needs trust-store hooks in both
runtimes that are harder to keep out of release builds than one guarded lookup.

## 7. Migration and upgrade safety

**From 1.x (1.5.0 stable, 1.6 betas) to the all-Rust 2.0.** The handover is the one already
built and checked on 2026-11-20: stop servers, install over the 1.x folder, repair shims,
resume. What changes is that `resume`, `repair` and `uninstall` no longer start Node, so the
installer has no runtime to depend on. The data folder is untouched: same `instances.json`,
same backups, same schedules, same accounts. `dataFormat` is not bumped by the port.

**From a 2.0 internal build (the 1001 to 1010 builds on Victor's machines) to the all-Rust
build.** These are the only installs that carry the bundled Node; no public user has one unless
a hybrid beta is published first (Q1). The update still handles them properly:

- Windows: an update-mode install never deletes files the new package does not list (design
  5.6), so the C10 installer removes `resources\runtime` and `resources\core` itself. A Node
  process started before the update (an MCP session, a bot run) still holds `node.exe` and
  still loads files from `resources\core` after it started (lazy engine imports,
  `internal-defaults.json`, `package.json`, the pages). So the installer first tries to delete
  the runtime; if `node.exe` is held it leaves **both** folders in place for that run, and the
  cleanup at the next install or `repair` removes them once nothing holds them. The old session
  keeps working meanwhile against the same files and exclusion files. G3 checks this with an
  MCP session open.
- macOS: the bundle is replaced whole, and a session started before the update must be
  restarted; its failure message is checked at G3. Linux: the package manager removes what the
  new package does not ship, and running processes keep their deleted files.
- Shims and launchers already name `spawnloft-core`, so nothing is rewritten, provided Rust
  writes the same text and the same `runtime.json` (3.4). If C6 finds it cannot reproduce a
  shim's text exactly, `RUNTIME_FORMAT` goes to 3 and `repair` rewrites them once, as it did
  for 2.

**Going back.** "Reinstall a previous version" keeps working in both directions because the
data format is the same; an older hybrid build simply brings its Node back. The manual return
to 1.x in the release notes is unchanged. This is the reason for rule 4: at no point in the
port may Rust write a file an older build cannot read.

**Mixed versions at run time.** Daemons survive updates, so an old daemon talks to a new core
until its server restarts. That is already designed for (the protocol version in `ping`,
`doctor` naming servers on an older daemon); the port must not change the control protocol.

**What must be checked by hand before any release** (gate G3): 1.5.0 to all-Rust with servers
running and a scheduled task; a hybrid internal build to all-Rust with an MCP session open; a
machine with no Node.js at all; the Microsoft accounts still signed in afterwards; a rollback
each way.

## 8. Platforms

**Windows x64.**
- Shell-outs become native calls: `taskkill`, `tasklist`, `icacls`, PowerShell process queries.
  `schtasks` and `System32\tar.exe` stay as called today.
- No console window may flash when the window app starts a helper (#232's lesson): every spawn
  goes through the existing `hide_window` and `no_new_window_flag` helpers.
- File semantics: rename-over retries (`RENAME_RETRIES`), `EPERM` from antivirus and indexers,
  held files, case-insensitive names (the #233 class), long paths, CRLF in `.cmd` shims.
- `console` needs raw console input. Detached daemons must leave the caller's job object as
  they do now.
- The core binary grows from about 3 MB to perhaps 8 to 12. It is Authenticode-signed like
  today; because it is a new, larger signed binary, it goes to Microsoft's analysis submission
  before a public build (remaining-work plan D5, still owed).
- Windows arm64 is not built, as before.

**macOS, Apple Silicon only.**
- launchd plists are written as text, as Node does; no new crate.
- Rosetta: old Minecraft versions and Java 8 need x64 natives; the client code's `arch` checks
  are ported as they are and re-checked on the mini.
- The Node entitlements file goes, so no binary in the bundle is allowed JIT memory. Signing
  and notarization of the core are unchanged.
- The system `tar` is bsdtar here and GNU tar on most Linux; Node already asks which
  (`tarHandlesZip`), and Rust keeps that check.

**Linux, deb and rpm, x64 and arm64.**
- The core is already a static musl binary, so the CLI package keeps its low floor.
- systemd user units, `loginctl enable-linger`, the `linux-libs` checks for MariaDB (`ldd`,
  `ldconfig`) are ported as they are.
- The desktop package drops its `libstdc++` dependency with the runtime. The CLI package's
  `bin/node` becomes the compatibility link of 5.2. The EL9 package swap (#234) is re-run.
- arm64 runs every parity scenario on `ubuntu-24.04-arm`, not only x64.

**All three.** TLS roots stay the bundled `webpki-roots`; proxy handling, retries, redirects
and time-outs are compared with Node's in C1 rather than assumed; schedule times and time
zones; non-ASCII file names in archives and paths; JSON key order and number form.

## 9. Gates with Victor's hands

| Gate | After | What |
| --- | --- | --- |
| **G1** | C2 and C3 | His own servers on a build where start, stop, console, backups and restores are Rust, for a few days, on Desktop-Main. A bot scenario run against one of them |
| **G2** | C7 | Microsoft sign-in on Windows, the Mac mini and a Linux VM; launch vanilla, Fabric, Forge, NeoForge and Quilt once each, as in the 2026-11-20 checks |
| **G3** | C10 | The beta checklist again on the all-Rust build, plus the hand checks of section 7 |

Signed builds for these come from his signing machine as today. Publishing anything stays his
call and is not part of this plan.

## 10. Risks

| Risk | Answer |
| --- | --- |
| Two implementations of one operation disagree while both are live (a backup from the panel is Node, from the CLI is Rust) | The rig compares the data tree, not only the output; both call the same system `tar`; the panel moves last so the overlap is short |
| An exclusion file is missed and both sides write the same thing | C0's inventory covers lock files and every other exclusive-create file and marker; registry writes in Rust go through one function |
| The port drifts into redesign | Rule 1 and the declared-differences table; reviews check for behaviour changes; improvements are listed in a follow-up file, not made |
| C7 is underestimated (it was the freshest and largest Node work) | Split in two threads; loaders have captured real fixtures (`loader-fixtures.yml`) to hold Rust to |
| Pulled-forward helpers get ported twice | The phase table names each one and the phase that owns it; C1 fixes the module layout first, one Rust module per Node module |
| The frozen Node side needs a fix mid-port | Rule 2: fix both in one PR |
| The Tauri window and panel regress in C8 | The window smoke and browser smoke run on every PR; the proxy stays as the default route until each group's replay is green |
| A hybrid build is published and then needs Node security releases | Q1: hold the public beta until C10 |

## 11. Threads (for the coordinator)

All on `v2` through pull requests into `v2`; branch names `v2-port-<topic>`; author and
committer joogiebear; no attribution anywhere; never commit `.agents/` or `skills-lock.json`.
Each brief carries this document, the contract fixtures README, and a done-when line. Models
per Victor's routing: Opus builds, Fable 5.2 reviews the phases marked below, Sonnet for docs.

| Thread | Model | Needs | Done when |
| --- | --- | --- | --- |
| **C0** parity rig and contracts | Opus | nothing | The rig runs a scenario on both sides on three platforms and arm64 in `rust-internal.yml` and fails on a seeded difference; the exclusion inventory and cross-process lock test; the fixtures of 3.4; the declared-differences table; the download-host override and fake host; `--json` fixtures for all 48 commands and the MCP tool list; the regex list |
| **C1** foundation and status | Opus, **Fable review** | C0 | The C1 commands answer in Rust with scenarios green; the registry is written under the shared lock; zip fuzz targets and cross-read tests; the module layout for later phases is in place; the musl and proxy checks recorded |
| **C2** lifecycle and databases | Opus, Opus review | C1 | C2 commands flipped; `handover resume` in-process; the daemon and installer workflows green |
| **C3** backups and files | Opus, Opus review | C2 | C3 commands flipped; a 1.5.0 build restores a Rust-made backup and the reverse; quarantine check on macOS; G1 can start |
| **C4** creating and updating servers | Opus, Opus review | C3 | C4 commands flipped against the fake download host; a real Paper and a real Fabric server created once on a runner |
| **C5** plugins and modpacks | Opus, **Fable review** | C4 | C5 commands flipped, `new --modpack` included; hardening cases mapped one to one |
| **C6** scheduler and maintenance | Opus, **Fable review** | C4 | C6 commands flipped; installer and uninstaller run with no Node present at all; EL9 swap re-run; a real task fires on each platform |
| **C7a** client: accounts, metadata, install, launch | Opus, **Fable review** | C2 | `client` answers in Rust for vanilla behind the flag rule; fake-client lifecycle scenarios green |
| **C7b** client: loaders | Opus, Opus review | C7a | `client` flipped whole; five loaders against the captured fixtures; `loader-install.yml` green on the Rust core; G2 can start |
| **C6b** diagnostics | Opus, Opus review | C6, C7b | `doctor` and `diag` flipped |
| **C8** panel API | Opus, **Fable review** | C5, C6b | Every route family answered in Rust; route replay green; browser and window smokes green; proxy removed |
| **C9** MCP and bots | Opus, **Fable review** | C5, C6b | `mcp` and `bot` flipped; JSON-RPC replay green; tool list equal to the fixture |
| **C10** Node leaves | Opus, **Fable review of `v2` as a whole** | C8, C9 | No Node binary and no core `.mjs` in any package; golden files frozen; the removal step tested with a held `node.exe`; sizes and timings measured; docs updated (Sonnet); G3 can start |

Start now: **C0**. Then C1, then C2. After C2, two tracks at once: the server chain (C3, C4,
then C5 and C6 side by side) and the client (C7a, C7b). C8 and C9 run side by side at the end.

Owed from before this plan and independent of it: the 1010 build and re-test of #233 and #234 on
Victor's machines.

## 12. Open questions for Victor

Each has a recommendation; "go with your recommendations" closes all of them.

- **Q1. When is the first public 2.0 beta? Decided (Victor, decision card, 2026-11-21 02:56
  UTC): "Yes, beta after the port".** The first public beta is the all-Rust build, after C10.
  No public user then ever has a bundled Node, there is one upgrade path to test instead of
  two, and a Node security release never forces a SpawnLoft release. The cost is that the
  finished installer, updater and window wait for the port before real users try them. The
  port keeps `v2` shippable after every merge, so this can be revisited at any gate.
- **Q2. Feature freeze during the port.** Recommendation: fixes only in the Node core; new
  features wait until their area is Rust. Launcher and panel page work in the HTML files is not
  frozen.
- **Q3. No async runtime in the core** (rule 6). Recommendation: yes, stay on threads and
  blocking I/O. This reverses the original plan's `tokio` and `axum` line, on the evidence of
  what the daemon, updater and proxy needed.
- **Q4. Test players need Node.js installed** once the bundled one is gone (5.4).
  Recommendation: accept; `bot setup` already needs it for npm.
- **Q5. Build and test tooling stays JavaScript** (5.5). Recommendation: yes; porting release
  scripts buys users nothing.
- **Q6. Java download for servers** (the 2026-11-06 plan, never built). The original plan said
  to build it once, in Rust. Recommendation: as the first Rust-only feature right after C7,
  which ports the client's Java download it shares code with; in 2.0 if the beta waits for C10
  anyway, and it does not block removing Node.
- **Q7. Three hardware gates** (section 9) instead of one check at the end. Recommendation:
  yes; G1 in particular puts his own servers on the Rust lifecycle early, where a problem is
  cheap.

## 13. Facts checked for this plan

- `v2` at c9f1ea1 (#234). `src/*.mjs`: 105 files, 27,645 lines; `mcctl.mjs` 2,499;
  `bot-host.cjs` 398; pages 21,517. Rust: 21,573 lines (`spawnloft-lib` 16,908, `spawnloft-core`
  1,907, `spawnloft-shell` 2,652, `spawnloft-fakes` 106).
- The Node core imports only Node built-ins (`fs`, `net`, `http`, `crypto`, `zlib`,
  `child_process`, `readline`, `dns`, and a few more); the only npm packages are the bot
  host's.
- `mcctl.mjs:2385-2444`: 61 command names for 48 commands, each assigned to exactly one phase.
  `ui.mjs`: 18 top-level route families and three `text/event-stream` responses (lines 1690,
  1953, 2272); the job table at 313 to 318. MCP: 30 tools in `mcp-tools.mjs`, 9 in
  `mcp-client-tools.mjs`.
- `cli.rs` `forwards`: own commands are `--version`, `--core-help`, `daemon`, `probe-process`,
  `handover`, `update`, `user-path`, `ui` with a window flag, `repair --quiet`,
  `uninstall --yes`. `nodecore.rs` is the seam for `resume`, `repair` and `uninstall`.
- Tests: 138 files, 27,986 lines, about 1,650 `test(` calls; 123 files import `../src/`, 18
  spawn the CLI entry.
- Hashes used by Node: sha1, sha256, sha512, md5, HMAC-SHA256, one Ed25519 verify
  (`client-harness-index.mjs:98`). Compression: raw deflate and inflate, gunzip, crc32.
- External programs the Node core runs: `java`, `tar`, `taskkill`, `tasklist`, `schtasks`,
  `powershell`, `icacls`, `explorer.exe`, `systemctl`, `loginctl`, `launchctl`, `ldd`,
  `ldconfig`, `open`, `xdg-open`, `arch`, `ps`.
- Seven regex lines in `src/` and `mcctl.mjs` use lookaround or a backreference.
- The Linux core is built for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`
  (`installer-linux.yml`).
- The server Java download plan of 2026-11-06 was never built: there is no `java-runtime`
  module in `src/`.

## 14. Review log

Rev 1 (2026-11-21) was reviewed by a fresh Fable reviewer, read-only, against the code at
c9f1ea1. Its findings, each checked before it was taken:

- **Blockers.** (1) Most of rev 1's "read-only C1 commands" needed the supervisor, `create` or
  `manage`: C1 now pulls the supervisor's read side forward and `templates`, `jars`, `reveal`
  moved to C4. (2) Backward dependencies and a C4/C6 cycle: `download`, `cancel`, `tar`, `zip`
  moved to C1; C4 now follows C3; `rm` and `rename` flip in C6; `new --modpack` in C5. (3)
  `doctor` and `diag` import the client: new phase C6b; the scrubber becomes its own module in
  C6. (4) The rig could not fake downloads for a spawned Node: section 6.2. (5) There is no tar
  reader to port; Node calls the system `tar`: rule 9. (6) A Node session that survives the
  update still loads from `resources\core`: the removal rule in section 7.
- **Should-fix.** C7's real imports; the job table spans databases and client launch (C8
  groups); `runtime.json`'s `root` field; exclusion files beyond `acquireLock`; the two
  `AsyncLocalStorage` contexts (rule 7); the test hooks (5.5); declared differences and the
  usage exit code (6.1, rule 8); sort order and number grouping; run-time regex patterns; the
  full removal list and the `handover stop` ordering (5.1); the bot host on disk and its
  environment (5.4).
- **Notes taken.** Test counts corrected (138, 123, 18); `players.mjs` belongs to the panel
  and MCP; engine markers use Node's platform names; the code-root data-root rule; the proxy
  claim made a C1 check; `bot.node` as a new settings key.
- **Checked and sound in rev 1:** every command assigned exactly once; the phase line totals;
  no in-process-only mutex that a second process relies on, beyond the items above.

One reviewer claim was taken without running it: that `ureq` 3 reads proxy variables from the
environment by default. It is recorded as a C1 check, not as a fact.
