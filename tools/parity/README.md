# The parity rig

Phase C0 of the core port (`rust/PLAN-CORE-PORT.md`, sections 3.1, 6 and 6.2). It proves that a
command the Rust core answers behaves exactly as the Node core's twin: the same stdout and
stderr, the same exit code, the same requests to the download hosts, and the same files left in
the data folder.

A scenario is a JSON file of steps. The rig runs it twice in one scratch folder, first with
`SPAWNLOFT_CORE_IMPL=node` (`spawnloft-core` forwards every command to the Node core) and then
without it (the ownership table in `rust/crates/spawnloft-core/src/cli.rs` decides), and compares
the two runs. Until C1 moves its first commands into `PORTED`, both runs are the Node core; the
rig, its fakes and the golden files are what C1 inherits.

## Running it

```
cd rust && cargo build -p spawnloft-core --features test-hooks && cd ..
node tools/parity/run.mjs                          # scenarios/ and selftest/
node tools/parity/run.mjs tools/parity/scenarios/downloads-paper.json --keep
node tools/parity/run.mjs --only cli-json --update-golden
node tools/parity/run.mjs --declared               # the declared-differences table below
```

`--core <bin>` picks the binary (default `SPAWNLOFT_CORE_BIN`, then the newest
`rust/target/{debug,release}/spawnloft-core`). `--keep` leaves both sides' folders (`node/`
and `rust/`) for a look. `--out <dir>` writes `report.json` with everything each side printed
and its whole data tree. `--sides node` runs one side. The core must be a `test-hooks` build:
without it the Rust side ignores `SPAWNLOFT_TEST_ORIGINS`. `rust-internal.yml`'s `parity` job
runs all of it on Linux x64 and arm64, Windows and macOS on every pull request. `run.mjs` asks
the core for `--version --json` first and refuses one that is not a `test-hooks` build.

## What each side gets

Each side runs in `<scratch>/run` with the data root at `run/data` and `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA` and the XDG folders under `run/home`, so a file written anywhere a
core might write lands in the compared tree. Both sides use the same path, one after the other,
so absolute paths in shims and records compare exactly. The machine's own `SPAWNLOFT_*`,
`MCCTL_*` and `NODE_OPTIONS` never reach a side. Each side also gets `NODE_ENV=test`,
`TZ=UTC`, `LANG=LC_ALL=en_US.UTF-8` and the bundled-runtime stand-ins `SPAWNLOFT_NODE` and
`SPAWNLOFT_CORE_DIR`. `SPAWNLOFT_TEST_ORIGINS` is always set: it holds the scenario's fake
hosts, and with none it is `{}`. That refuses every host that is not on this machine, so no
scenario ever downloads anything real. A scenario may not set `SPAWNLOFT_CORE_IMPL`,
`SPAWNLOFT_TEST_ORIGINS`, `SPAWNLOFT_TEST_SCHEDULER` or `FAKE_SCHEDULER_DIR` itself, in its own `env` or a
step's: the rig refuses it.

The system's scheduler is played by `fake-scheduler` (spawnloft-fakes, built beside the core,
or `SPAWNLOFT_FAKE_SCHEDULER`): each side gets `SPAWNLOFT_TEST_SCHEDULER` naming it and
`FAKE_SCHEDULER_DIR=run/scheduler`, so every run of `schtasks`, `powershell`, `launchctl`,
`systemctl` or `loginctl` runs `fake-scheduler <tool> <args...>` instead (the Node core with
NODE_ENV=test, `installScheduler` in `src/test-origins.mjs`; the Rust core in a `test-hooks`
build, `test_origins::scheduler_command`). Without the fake the variable names a file that is not
there, so a side fails to start the tool rather than reaching the machine's own scheduler. The fake
keeps its state in `run/scheduler/state.json` and appends every call that changes something to
`run/scheduler/calls.log`, so the two sides' calls are compared in order. A scenario can seed
`state.json` with failures to inject (`"fail": [{ "tool", "args", "status", "stderr", "times" }]`),
tasks shown as running (`"running"`) and `"linger"`; see the top of
`rust/crates/spawnloft-fakes/src/bin/fake-scheduler.rs`.

Not isolated: the Windows user PATH.

## Scenario format

```json
{
  "about": "what it proves",
  "hosts": { "https://fill.papermc.io": { "routes": { "GET /v3/projects/paper": { "json": {} } } } },
  "env": { "SOME_VAR": "1" },
  "normalize": [{ "pattern": "\"sizeBytes\":\\d+", "replace": "\"sizeBytes\":<n>" }],
  "ignore": ["data/run/**/daemon.log"],
  "acl": false,
  "golden": "test/fixtures/contracts/cli/x.json",
  "steps": [
    { "write": "data/instances.json", "json": {} },
    { "write": "data/x.txt", "text": "...", "mode": "600", "mtime": "2026-11-01T10:00:00Z" },
    { "mkdir": "data/instances/alpha" },
    { "remove": "data/x.txt" },
    { "hardlink": "data/y.txt", "to": "data/x.txt" },
    { "run": ["list", "--json"], "stdin": "", "env": {}, "timeoutMs": 120000,
      "expect": { "code": 0, "stdoutIncludes": "alpha" }, "golden": true }
  ]
}
```

- `{run}`, `{data}`, `{home}` and `{repo}` in any string are this side's paths.
- `expect` is checked on both sides. It stops a scenario from passing only because both sides
  failed the same way, for example when a host was not faked.
- `hosts`: see `lib/fake-host.mjs`. A route answers with `json`, `text`, `base64`,
  `bytes: {size, seed}` or `file`. It can also set `status`, `headers`, `redirect` and
  `delayMs`. A `redirect` must point at a faked origin (or a path on this one): one to anywhere
  else is answered with a 500 and logged, since the client would follow it to the network.
  A route can be `{ "sequence": [route, ...] }` instead: the n-th request gets the n-th answer,
  and the last one once they run out; the count starts over for each side.
  `${sha256:<url>}` (also sha1, sha512, md5 and size) fills in another route's checksum. Every
  request is logged and the two sides' logs are compared, sorted, so two cores that ask in a
  different order but for the same things agree: method, path and query, user agent, accept, the
  body's size and its sha256.
- `normalize` adds patterns this scenario knows are volatile, on top of the built-in ones
  (`lib/normalize.mjs`: times, dates, file-name stamps, pids, lock tokens, epoch milliseconds
  under a key that names a time, and measured durations by name: `uptimeMs`, `totalMs`,
  `durationMs` and a few more. A configured duration such as `timeoutMs`, a count, a size and
  MCP's `protocolVersion` are compared exactly). Nothing else is evened out between the sides except the declared differences.
- `golden`: the Node side's steps, with this machine's paths replaced by `<run>` and `<repo>`,
  must equal the file. A step with `"golden": false` is compared between the sides but kept out
  of the golden file. Use it for answers that depend on the machine. `goldenPlatforms` limits the
  check to some platforms.
- `platforms`: run the scenario only there: a platform (`linux`, `darwin`, `win32`) or a platform and arch (`linux-x64`).
- `acl`: on Windows, also compare each entry's `icacls` listing. POSIX modes are always compared.

The data tree records each file's mode and, by kind: a zip's entries in order with their method,
flags, sizes, CRC and attributes; a tar's (or `.tar.gz`'s) members with name, type, mode, size
and sha256, from the rig's own reader; text, evened out; anything else by size and sha256. A
file name with a stamp is evened out like text, and two names that come out the same are kept
apart as `name` and `name#2`.

## Self-tests

`selftest/` holds scenarios with `"expect": "differ"`. Each one seeds a difference with steps
marked `"side": "rust"`, and names the difference in `expectDifferences`. The rig passes such a
scenario only when it reports that exact difference. They cover stdout, the exit code and stderr,
an extra and a changed file in the tree, a file mode, a tar member's bytes, and the fake-host
request list. A
`side`-only step anywhere else is refused, so a real scenario can never run different steps on
the two sides. `test/parity-rig.test.mjs` tests the rig's parts with no binary, and runs the
self-tests end to end when `SPAWNLOFT_CORE_BIN` is set.

## Scenarios today

| Scenario | Covers |
| --- | --- |
| `basics` | usage, help, an unknown command, empty lists, usage errors with and without `--json` |
| `registry-read` | C1's read-only commands over two stopped servers, text and `--json`, with the failure paths |
| `downloads-paper` | faked downloads: Paper's fill API and data host, the jar store, checksum mismatch, HTTP 503, the cache, `jars` |
| `mcp` | the MCP server over stdio. Golden: `test/fixtures/contracts/cli/mcp-tools.json` (the tool list C9 must equal) |
| `network-refused` | a host with no fake is refused on both sides, with the same message, and nothing is sent |
| `cli-json` | all 61 command names with `--json`, then the forms that answer with data. Golden: `test/fixtures/contracts/cli/cli-json.json` |
| `c1-edges` | C1's commands (`help`, `list`, `status`, `logs`, `why`, `metrics`) over damaged registries, state files, logs, metrics and crash reports, every flag and its usage errors |
| `c1-settings` | the data root and the other folders chosen by `settings.json` (XDG and Windows locations), a damaged settings file and its warning |
| `c1-running` | the same commands against a running server (the fake JVM), text and `--json` |
| `c1-review` | what the C1 review found: half an emoji or a record's own `name` in the registry, pids as `process.kill` coerces them, crash reports with equal times, `/i` patterns beyond ASCII and Annex B escapes, a large console with a count that is not whole, a sample past the year 9999 |
| `c2-lifecycle` | C2's lifecycle over the JVM stand-in answering RCON (`FAKE_JAVA_RCON=1`): `start`, `stop`, `restart`, `kill`, `cmd`/`rcon`, `players`, `send`, `console` fed from a pipe, `set` with every key and `props`, their refusals and usage errors |
| `c2-rust-daemon` | the same lifecycle with `SPAWNLOFT_DAEMON=rust`, so both supervisors start `spawnloft-core daemon` |
| `c2-databases-node`, `c2-databases-rust` | databases under each daemon: the MariaDB and Garnet stand-ins in the engine store (copied in by `write` with `copy`), a missing engine, an external database, start, stop, restart and kill |
| `c2-failed-start` | a start that fails, for a server and a database under each daemon (the activity log left out: two processes write it in either order) |
| `c2-db` | the `db` command: list, versions, add (Garnet from the stand-in store, MySQL against a faked download whose bytes are wrong), attach and detach with and without `--drop`, creds, connect and address for an external database, root, create for a server (one that starts, one that fails) and remove, with the usage errors; random passwords evened out |
| `c3-backups` | C3's backups over stopped servers: `backup` (and `snapshot`) with every scope, label and flag and their usage errors, the leave-out list, `snapshots` and `backups` in text and `--json`, `verify` by name, part of a name and `--all`, a damaged archive, `restore` with its preview and the copy it keeps of what it replaces, `prune` and `--keep`, and `config` with the backup mirror and a damaged settings file. Archive sizes evened out: tar records each file's time, so gzip comes out a byte or two apart |
| `c3-running-gone` | a running server that goes away after save-off: the backup is still taken, the flush reported as failed. Linux and macOS only: on Windows the Node core's CLI exits 0 there having written nothing (its event loop drains while the flush is pending) |
| `c3-running` | the same against a running server (the JVM stand-in answering RCON, `FAKE_JAVA_RCON_OPTS` to drop replies) with attached databases: the flush and save-on, a flush that fails, a save-on not confirmed, the SQL dump of the MariaDB stand-in (`FAKE_MARIADB_STABLE_DUMP`), a stopped database and a Garnet one left out, restore refused while running, and restores that import the dump and leave it, and `worlds` refusing to export, switch or delete while it runs |
| `c3-worlds` | `worlds`: the list with dimension folders folded in and the active world first, `use` and its refusals, `import` from a folder (a wrapped map with a companion), a `.tar.gz`, a `.zip`, a zip that reaches outside its folder and archives with no world, names derived and given, `export` of the active world and another into `exports/` (the zip listing compared entry by entry), and `delete` with a copy kept and with `--no-copy` |
| `c4-create` | C4's making of servers without a download: the jar store (`jars`, `jars import` with `--as`, a folder, a missing file), `new` from a stored jar, a path, a template and `--from` another server with every flag and its refusals (a bad name or memory value, `--jar` with no value, a folder in the way), `clone` with and without worlds, `templates save` and the listing over damaged and bare template folders, `adopt` (the jar picked or given and kept inside the folder, ports and password kept from `server.properties`, the loader guessed), `launchers`, and `rebuild` with and without a snapshot. RCON passwords evened out |
| `c4-running` | the same against a running server: `rebuild` refused, a template and a clone made from it anyway, `rebuild` once it stopped |
| `c4-reveal` | `reveal` and `open` on Linux: no display, a stand-in `xdg-open` on PATH, and no file manager at all. Linux only, so nothing opens on a desktop runner |
| `c4-fetch` | `new` with every software flag against faked Paper, Folia, Purpur, Mojang, InfernalSuite, Fabric, NeoForge and SpigotMC hosts (sha256, sha1 and md5 checks, size floors, missing versions and builds), Java picked or refused before a download, BuildTools and the NeoForge installer played by a stand-in `java` (a failed install removes the server), `upgrade` with `--check`, `--build` and `--version --yes`, and `paper`'s listing flags. Linux and macOS (the stand-in is a shell script) |
| `c5-plugins` | C5's `plugins`: the list in text and `--json` over plugin.yml, paper-plugin.yml, fabric.mod.json and NeoForge mods.toml manifests (stored and deflated entries, a jar that is not a zip, a folder named like a jar), the records SpawnLoft keeps and odd ones (a number, a `managed` that is an array, a store that is not JSON), names that are not text (a list, a number: the lookup and the sort throw as in Node), `enable` and `disable` by name and by file, no-ops, and every refusal and usage error |
| `c5-modpack` | C5 part 2, modpacks: `new --modpack` from faked Modrinth hosts (a Fabric pack with overrides, server-overrides and a client-only file; the release preferred over a newer beta), every refusal of a pack or one of its files before anything is made, and `pack` status, check and update (the snapshot first, only files the old pack owned and the new one dropped retired, Minecraft moving, managed records following). Linux and macOS; snapshot sizes evened out |
| `c5-modpack-neo` | C5 part 2, a NeoForge modpack: `new --modpack` with the NeoForge installer played by a stand-in java found on a relative PATH, then `pack` status. Linux only: on macOS the two sides resolve a relative PATH entry differently once the installer runs in the server folder, so the stand-in is not what both run (c4-fetch covers the installer on macOS, given `--java`) |
| `c6-tasks` | C6's `task` against the fake scheduler on each system: `add` with every schedule kind and its refusals, a registration the scheduler refuses taken back, `list`, `enable`, `disable`, `rm`, `linger`, then `rename` (its refusals, the snapshots, run folder and tasks moving with the server, a capitals-only rename, #233) and `rm` with and without `--purge` dropping the server's tasks |
| `c6-task-run` | `task run`, what the scheduler starts: each single action skipped, done and failed over the JVM stand-in, `steps` chains written as the panel writes them (skipped steps, a failed step ending the chain, `keepGoing`, `onlyWhenRunning`), a backup task pruning its own, and a failed check posted to the server's webhook (faked) |
| `c6-maintenance` | `repair` (text and `--json`, its refusals) rewriting task shims and launchers and recording `run/runtime.json`, and `uninstall`: refused without `--yes`; with it a running server stopped and every task removed; with `--data` SpawnLoft's own servers (not an adopted one), jars, templates, run, tasks, the registry, both settings files and the 1.x desktop folder deleted, and from a chosen backups folder only what SpawnLoft provably wrote. The executable `repair` names is normalised: Node names its own `node`, the Rust core the binary that the shims and launchers run |
| `c6-data` | `data`: `move` with its usage errors and every refusal (inside the folder, holding it, not empty, not a folder, the folder itself, a move already made, an interrupted one), the dry run as text and `--json`, a same-drive move with `--yes` (folder renamed, link left, its task paused and switched back on), `status` as text and `--json`, `finish` with and without `--yes`, `rollback` refused and then putting back a move interrupted at "moving". The copy mode (another drive) is covered by spawnloft-lib's tests |
| `c7-client-store` | C7's client subcommands that need no network: `client list`, `status`, `logs` (the capture's log4j events turned into plain lines, `--latest`, `-n` and its refusals), `accounts`, `logout`, `remove` with and without `--purge` and `stop`, over damaged and hand-made profile, account and state files, then around a game the Node core launches (the fake client, `MCCTL_FAKE_CLIENT`) |
| `c7-client-edges` | damaged accounts files for those subcommands: `accounts` that is not a list, null and nameless entries, an empty default account, a world-readable file that `logout` rewrites owner-only, and `-n 0x2` and an empty `--n=` |
| `c7-client-versions` | `client versions`, `new` and `set` over faked Mojang, Fabric, Quilt, Forge and NeoForge lists: the table and its filters, versions on disk, each loader's refusals, near ids for a typo, every field check of a new profile, `set`'s value rules and its re-check when the version or loader changes, and the cache each list leaves |
| `c7-client-versions-offline` | the same with no list reachable: downloaded versions only, with a note and `?` for every loader, `new` from a version on disk, a stale cached list used when the network fails, and damaged cached lists |
| `c7-client-harness-index` | `client versions` with the signed harness list's refresh on and GitHub faked: a malformed signature, an unsigned cached copy dropped with its reason, the hour's wait after a failure, and a status file holding null (exit 1 on both sides) |
| `c7-client-login` | `client login`: the Microsoft device code and the Xbox Live, XSTS and Minecraft chain after it, over fakes answering in turn (a route's `sequence`): every refusal and hiccup sentence, `SPAWNLOFT_MSA_CLIENT_ID`, the stale same-name entry a fresh sign-in replaces, and accounts lists that are not arrays |
| `c7-client-login-odd` | `client login` on odd answers: Mojang's refusal cut at 200 UTF-16 units through a surrogate pair, and a profile name that is a number, with an empty list and next to another entry |
| `c7-client-install` | `client install` over faked Mojang hosts, made by `make-c7-install-scenario.mjs`: a modern version with natives for every OS and arch, the checked-files list, a damaged library, natives extracted again, `--verify`, the virtual and resources asset layouts, old-style natives with excludes, the refusals (unknown layout, an index path leaving its folder, a missing library, a checksum mismatch, a loader-made library, an unlisted version), and a Fabric profile, which the Node core still sets up. Not on Linux arm64, where the client is refused |
| `c7-client-launch` | `client launch` with the fake game over Mojang's version file on disk: offline players by `--as`, by the profile and by default, a Microsoft account as saved and as the default, a sign-in renewed (refused as over, then Microsoft unreachable and the saved one used with a warning), every refusal before the game starts, a stopped server joined by quick play with its warnings and the Multiplayer list filled, `--wait` over a game that exits at once, and a Fabric profile, which the Node core still launches |

Each phase adds its own scenarios before it flips its commands, failure paths included (plan
rule 5).

## Declared differences

The only ways a ported command may differ from its Node twin (plan section 6.1). The table is
`declared-differences.mjs`, and adding a row needs a reason in the pull request.

| Where | Node | Rust | How the rig holds it |
| --- | --- | --- | --- |
| `doctor`, the diagnostics bundle, the panel's diagnostics | a `node: <version>` line and the code `root` | the core's version; no `root` | evened out (`doctor-node-line`) |
| `repair` text and `--json` | `runtime: <node path>` | the core's own path | evened out (`repair-runtime`) |
| free-text sort order outside ASCII | ICU collation | the port's comparison function (spawnloft-lib collate.rs) | scenarios sort ASCII names only; test/fixtures/contracts/ordering.json pins the ASCII order on both sides |
| sort order on a machine whose locale tailors ASCII letters (da, nb, lt, et, ...) | that locale's order | the root order (what an en-US machine shows) | the rig runs both sides with LANG and LC_ALL set to en_US.UTF-8 |
| number grouping (`toLocaleString`, mcctl.mjs) | the system locale | fixed en-US grouping | the rig runs both sides with LANG and LC_ALL set to en_US.UTF-8 (Windows runners are en-US) |
| a run-time pattern using lookaround, a backreference, a lone surrogate escape (`\uD83D`), a repetition count beyond 2^32, or more than the matcher's size or nesting allows (`logs --grep`, MCP `get_logs`, bot scenarios) | accepted | refused with a clear message | scenarios give such a pattern only in a step that expects the refusal, and test/fixtures/contracts/regex.json lists the sites |
| the error text for an invalid run-time pattern | V8's (`Invalid regular expression: /(/: Unterminated group`) | the `regex` crate's | evened out (`invalid-pattern-text`) |
| an unexpected failure (a file that is not JSON or cannot be read, a nonsense argument) | the error line, then JavaScript's stack (`    at ...` lines) | the error line alone | evened out (`internal-error-stack`) |
| the text of a JSON file that does not parse (registry, state file, settings) | V8's `JSON.parse` message | `JSON parse error: ` and serde_json's message | evened out (`json-parse-error-text`) |
| a run-time pattern meeting a character outside the Basic Multilingual Plane (an emoji) | matched as two UTF-16 units (`^.{2} x` matches `😀 x`) | matched as one character (`^. x` matches `😀 x`) | scenarios grep consoles whose emoji the pattern matches whole or not at all; test/fixtures/contracts/js-patterns.json has no pattern that splits one |
| a JSON file holding half of a surrogate pair (`"\ud83d"`), or a jar manifest string the reader cuts inside a pair (an unterminated `'''` string in mods.toml) | kept; printed as U+FFFD, re-escaped as `\ud83d` in JSON output | read as U+FFFD, printed and written as that character | evened out (`lone-surrogate`) |
| a JSON file holding a number beyond the double range (`1e400`) | read as Infinity | refused as a file that does not parse | no SpawnLoft writer can produce one (JSON.stringify writes Infinity as null); a mod's own fabric.mod.json could, and its row then falls back to mods.toml or the file name (no published mod writes one); scenarios do not hand-write one |
| a zip entry (a jar, a modpack override) whose deflate data is corrupt | zlib's message (`invalid code lengths set`, `invalid distance too far back`, ...) | `invalid compressed data` or `unexpected end of file` | the exit code and the cleanup are the same; scenarios ship no corrupt deflate stream |
| a download or an API answer sent with `Content-Encoding` (gzip, deflate, br) | asks for it (`accept-encoding`) and decodes it | asks for none and reads the bytes as sent, so a compressed answer fails its size or checksum, or does not parse | a server compresses only when asked, and Rust never asks; the fake hosts never compress |
| `plugins` on a folder of 64 or more jars, one of whose manifests gives a name that is not text | lists, unless V8's merge happens to compare that name on the left | can fail with `a.name.localeCompare is not a function` where Node lists | scenarios list fewer than 64 jars, or only text names |
| a state file whose `daemonStartTime` (written by 2.0's daemon) differs from the live process under that pid | the field is ignored; the pid and the image name decide | the creation time decides where the system reports one | the Node daemon never writes the field; scenarios write it only as the running daemon's own |
| a settings value of the wrong type (`"dataRoot": 5`) | an uncaught crash: source excerpt, the error line, the stack, `{ code: ... }` and `Node.js v<version>` | the error line alone, exit 1 | evened out (`settings-type-crash`) |
| Windows: `start`, `restart`, `db create` for a server (which starts it), `task run` of a start or restart task and `client launch` (the game), read through a pipe (the rig, a script capturing the output) | the pipe stays open after the command exits, until the server or the game stops (the rig waits 10 s and notes it) | the pipe closes when the command exits | evened out (`windows-daemon-holds-pipes`) |
| `console` (`attach`) given `/detach` or `/exit` with more lines behind it in the same read (piped input) | the lines after it in that read are still sent to the server | nothing after `/detach` or `/exit` is sent | scenarios feed `console` input that ends at `/detach` or `/exit`, or none |
| a checkout whose code folder holds `instances.json` and no settings choose a data root | the code folder is the data root (and is listed among other registries) | the per-user data folder; the code folder is never a data root | no installed build can be in that state (C0-CHECKS.md section 2); the rig's code folder is the checkout, which has no instances.json |

## The download-host override

`SPAWNLOFT_TEST_ORIGINS` is a JSON map from an origin to a loopback origin. Node honours it only
with `NODE_ENV=test` (`src/test-origins.mjs`, which wraps `fetch` before any module runs). This
is the one named exception to the Node freeze. Rust honours it only in a build with the
`test-hooks` feature (`spawnloft-lib/src/test_origins.rs`, `test_origins::rewrite`). Every Rust
client that reaches the network calls it: the updater's fetch and the webhook post today, every
download from C1 on. Node follows redirects one hop at a time, so a redirect cannot lead past
the map. Such a build adds `"testHooks":"spawnloft-test-hooks:on"` to `--version --json`;
`desktop/release-gate.mjs` refuses a core that reports it, and `desktop/build-trust.mjs` refuses
a binary that contains the marker. Not covered: the Node daemon's own webhook post
(`src/daemon.mjs`), since the Node daemon is not the default and is frozen. Both sides are held to
`test/fixtures/contracts/test-origins.json`. To change the rules, change
`make-test-origins-fixture.mjs` and regenerate the fixture from the Node module.
