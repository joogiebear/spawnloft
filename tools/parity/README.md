# The parity rig

Built in phase C0 of the core port (`rust/PLAN-CORE-PORT.md`, sections 3.1, 6 and 6.2) to prove
that a command the Rust core answers behaves exactly as the Node core's twin: the same stdout and
stderr, the same exit code, the same requests to the download hosts, and the same files left in
the data folder.

A scenario is a JSON file of steps. Until C10 the rig ran it twice in one scratch folder, once on
the Node core (`SPAWNLOFT_CORE_IMPL=node`) and once on the Rust core, and compared the two runs.
Before the Node core left, its side of every scenario was frozen per platform under `frozen/`
(below); the rig now runs each scenario on the Rust core and compares it with that record in the
same way.

## Frozen records

`frozen/<platform>-<arch>/<scenario>.json` holds, for each platform the parity job runs (Linux x64
and arm64, Windows x64, macOS arm64), every step's output and exit code, the fake-host requests
and the whole data tree of the Node core's run, with the machine's paths (`<run>`, `<repo>`,
`<node>`, `<core>`), the fake hosts' loopback ports (`<fake https://...>`) and the rig's pid
(`<rig-pid>`) named. A scenario with no record for the platform it runs on fails, and
`test/parity-frozen.test.mjs` checks that every scenario has one for each platform.

A record is the CLI's behaviour. A change to it is a change to what a person sees, made on
purpose: run the scenario with `--record` on each platform (the record is written only when the
run had no problem) and say why in the pull request. A step with `"frozen": false` is run and its
`expect` checked, but left out of the record (for output that depends on the machine).

The records were captured on the GitHub runners (`.github/workflows` capture run of 2026-11-22),
and they hold what is particular to those machines: a scheduled task's name carries a hash of the
data folder's path (the rig always uses `<TMPDIR>/sl-parity`, and CI sets `TMPDIR` to the
runner's temp folder), a tar's entries are in the runner's directory order, and Java discovery
lists the runner's JVMs (`/usr/lib/jvm/...`). So the check is CI's: on another machine those
scenarios differ. When a runner image changes what it carries (a new JDK, say), the scenarios
that list Java fail on that platform; rewrite them there with `--record` (from the Rust side,
which was held to the Node core's records when they were frozen) and say so in the pull request.
A scenario's `normalize` rules also run over its record at check time, so a rule added later
(as `c6b-doctor`'s for the Java and tar versions) needs no new record.

## Running it

```
cd rust && cargo build -p spawnloft-core --features test-hooks && cd ..
node tools/parity/run.mjs                          # scenarios/ and selftest/
node tools/parity/run.mjs tools/parity/scenarios/downloads-paper.json --keep
node tools/parity/run.mjs --only cli-json --update-golden
node tools/parity/run.mjs --declared               # the declared-differences table below
node tools/parity/run.mjs --only c1-edges --record # rewrite one scenario's record for this platform
```

`--core <bin>` picks the binary (default `SPAWNLOFT_CORE_BIN`, then the newest
`rust/target/{debug,release}/spawnloft-core`). `--keep` leaves the run's folder (`rust/`) for a
look. `--out <dir>` writes `report.json` with everything the run printed and its whole data
tree. `--frozen off` skips the records. The core must be a `test-hooks` build:
without it the Rust side ignores `SPAWNLOFT_TEST_ORIGINS`. `rust-internal.yml`'s `parity` job
runs all of it on Linux x64 and arm64, Windows and macOS on every pull request. `run.mjs` asks
the core for `--version --json` first and refuses one that is not a `test-hooks` build.

## What each side gets

Since C10 there is one side, the Rust core; the text below says "both sides" where the rig used to run
the Node core as well, and the frozen records were made under these same rules.

Each side runs in `<scratch>/run` with the data root at `run/data` and `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA` and the XDG folders under `run/home`, so a file written anywhere a
core might write lands in the compared tree. Both sides use the same path, one after the other,
so absolute paths in shims and records compare exactly. The machine's own `SPAWNLOFT_*`,
`MCCTL_*` and `NODE_OPTIONS` never reach a side. Each side also gets `NODE_ENV=test`,
`TZ=UTC`, `LANG=LC_ALL=en_US.UTF-8`, `SPAWNLOFT_NODE` (the Node that runs the tests' `.mjs`
stand-ins, in a `test-hooks` build) and `SPAWNLOFT_CORE_DIR` (a `test-hooks` or debug build reads the
panel's pages from this checkout's `src/`). `SPAWNLOFT_DAEMON=rust` is still set but means nothing: there
is one daemon. `SPAWNLOFT_TEST_ORIGINS` is always set: it holds the scenario's fake
hosts, and with none it is `{}`. That refuses every host that is not on this machine, so no
scenario ever downloads anything real. `SPAWNLOFT_CORE_IMPL` means nothing now. A scenario may not set it,
`SPAWNLOFT_TEST_ORIGINS`, `SPAWNLOFT_TEST_SCHEDULER` or `FAKE_SCHEDULER_DIR` itself, in its own `env` or a
step's: the rig refuses it.

The system's scheduler is played by `fake-scheduler` (spawnloft-fakes, built beside the core,
or `SPAWNLOFT_FAKE_SCHEDULER`): each side gets `SPAWNLOFT_TEST_SCHEDULER` naming it and
`FAKE_SCHEDULER_DIR=run/scheduler`, so every run of `schtasks`, `powershell`, `launchctl`,
`systemctl` or `loginctl` runs `fake-scheduler <tool> <args...>` instead (the Rust core in a
`test-hooks` build, `test_origins::scheduler_command`; the Node core did the same with `NODE_ENV=test`). Without the fake the variable names a file that is not
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
      "expect": { "code": 0, "stdoutIncludes": "alpha" }, "golden": true },
    { "panel": [
        { "get": "/api/settings" },
        { "post": "/api/appearance", "json": { "theme": "classic" } },
        { "get": "/api/health", "anonymous": true }
      ], "window": false, "expect": { "includes": "\"theme\": \"classic\"" } }
  ]
}
```

- `{run}`, `{data}`, `{home}` and `{repo}` in any string are this side's paths.
- `rpc: true` writes `stdin` one line at a time: a JSON-RPC request waits for the reply with its
  id, a notification for nothing, and any other line for one more line of output. A server that
  answers requests side by side (the MCP server) is then compared in the order of the requests.
- A value that is exactly `"{rig-pid}"` becomes the number of the rig's own process: one that is alive on every system while the scenario runs.
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
- `panel` (C8, plan section 6 layer 2): starts the side's panel (`ui --port 0`), sends it the
  requests one after another and compares what came back as a command's output is compared: the
  status, the headers a page or a script can see (not `date`, `connection`, the length or the
  transfer encoding) and the body. A request is `get`, `post`, `delete` or `patch` with a path
  (or `method` and `path`), and a body as `json`, `text`, `base64` or `file` (`type` names its
  content type). Each is signed as a program holding the install's key signs it, unless it says
  `"anonymous": true` or brings an `authorization` header; `host` and `headers` set what a
  browser would (`{port}` in a header value is the panel's port, `null` drops a header). JSON
  answers are laid out one value per line in the order they came, so a key that moved is a
  difference; an event stream keeps its `data:` events (`"stream": { "events": 2, "ms": 5000 }`
  reads that many and hangs up); a body that is not text is its size and sha256, as is any body
  with `"body": "sha256"`, and `"body": "skip"` leaves it out. The panel's port reads
  `<panel-port>` wherever it shows. `"waitMs"` waits before a request. `"window": true` on the
  step runs both panels as the desktop window does (`SPAWNLOFT_SHELL=tauri`). `expect.includes`
  is text the answers must hold on both sides. The install's key is made by each side, so a
  scenario with a panel step ignores `home/**/panel.key`.
- `golden`: the Node side's steps, with this machine's paths replaced by `<run>` and `<repo>`,
  must equal the file. A step with `"golden": false` is compared between the sides but kept out
  of the golden file. Use it for answers that depend on the machine. `goldenPlatforms` limits the
  check to some platforms.
- `platforms`: run the scenario only there: a platform (`linux`, `darwin`, `win32`) or a platform and arch (`linux-x64`).
- `acl`: on Windows, also compare each entry's `icacls` listing. POSIX modes are always compared.

The data tree records each file's mode and, by kind: a zip's entries in order with their method,
flags, sizes, CRC and attributes (evened out by the scenario's `normalize` like text); a tar's (or `.tar.gz`'s) members with name, type, mode, size
and sha256, from the rig's own reader; text, evened out; anything else by size and sha256. A
file name with a stamp is evened out like text, and two names that come out the same are kept
apart as `name` and `name#2`.

## Self-tests

`selftest/` holds scenarios with `"expect": "differ"`. Each one seeds a difference with steps
marked `"side": "rust"`, and names the difference in `expectDifferences`. The rig passes such a
scenario only when it reports that exact difference. They cover stdout, the exit code and stderr,
an extra and a changed file in the tree, a file mode, a tar member's bytes, the fake-host
request list and a panel's answer. A
`side`-only step anywhere else is refused, so a real scenario can never run different steps on
the two sides. `test/parity-rig.test.mjs` tests the rig's parts with no binary, and runs the
self-tests end to end when `SPAWNLOFT_CORE_BIN` is set.

## Scenarios today

| Scenario | Covers |
| --- | --- |
| `basics` | usage, help, an unknown command, empty lists, usage errors with and without `--json` |
| `registry-read` | C1's read-only commands over two stopped servers, text and `--json`, with the failure paths |
| `downloads-paper` | faked downloads: Paper's fill API and data host, the jar store, checksum mismatch, HTTP 503, the cache, `jars` |
| `mcp` | the MCP server over stdio, as `rpc` steps. Golden: `test/fixtures/contracts/cli/mcp-tools.json` (the tool list the Rust server equals byte for byte) |
| `network-refused` | a host with no fake is refused on both sides, with the same message, and nothing is sent |
| `cli-json` | all 61 command names with `--json`, then the forms that answer with data. Golden: `test/fixtures/contracts/cli/cli-json.json` |
| `c1-edges` | C1's commands (`help`, `list`, `status`, `logs`, `why`, `metrics`) over damaged registries, state files, logs, metrics and crash reports, every flag and its usage errors |
| `c1-settings` | the data root and the other folders chosen by `settings.json` (XDG and Windows locations), a damaged settings file and its warning |
| `c1-running` | the same commands against a running server (the fake JVM), text and `--json` |
| `c1-review` | what the C1 review found: half an emoji or a record's own `name` in the registry, pids as `process.kill` coerces them, crash reports with equal times, `/i` patterns beyond ASCII and Annex B escapes, a large console with a count that is not whole, a sample past the year 9999 |
| `c2-lifecycle` | C2's lifecycle over the JVM stand-in answering RCON (`FAKE_JAVA_RCON=1`): `start`, `stop`, `restart`, `kill`, `cmd`/`rcon`, `players`, `send`, `console` fed from a pipe, `set` with every key and `props`, their refusals and usage errors |
| `c2-rust-daemon` | the same lifecycle with `SPAWNLOFT_DAEMON=rust` (now the only daemon), so the supervisor starts `spawnloft-core daemon` |
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
| `c7-client-forge` | Forge and NeoForge profiles over faked Mojang, Forge and NeoForge hosts, made by `make-c7-forge-scenario.mjs`, with a shell script standing in for Java: a modern installer's build steps run, stamped and skipped the next time, a changed output and a removed stamp built again, a step that fails or makes nothing, `--verify`; NeoForge's refusals (another game version, an unknown spec, a wrong id, a bad checksum, a build the list lacks); a legacy Forge installer converted, one naming another host, an unchecked one and a build too old; and the fake game launched on loader profiles. Not on Linux arm64 or Windows |
| `c7-client-harness-index` | `client versions` with the signed harness list's refresh on and GitHub faked: a malformed signature, an unsigned cached copy dropped with its reason, the hour's wait after a failure, and a status file holding null (exit 1 on both sides) |
| `c7-client-login` | `client login`: the Microsoft device code and the Xbox Live, XSTS and Minecraft chain after it, over fakes answering in turn (a route's `sequence`): every refusal and hiccup sentence, `SPAWNLOFT_MSA_CLIENT_ID`, the stale same-name entry a fresh sign-in replaces, and accounts lists that are not arrays |
| `c7-client-login-odd` | `client login` on odd answers: Mojang's refusal cut at 200 UTF-16 units through a surrogate pair, and a profile name that is a number, with an empty list and next to another entry |
| `c7-client-harness` | `client launch` of harness profiles with the fake game: the token on the command line and in state.json, a stale harness file removed first, `client stop` through the harness, and the refusal for a version with no harness build, with and without a failed read of the published list |
| `c7-client-install` | `client install` over faked Mojang hosts, made by `make-c7-install-scenario.mjs`: a modern version with natives for every OS and arch, the checked-files list, a damaged library, natives extracted again, `--verify`, the virtual and resources asset layouts, old-style natives with excludes, the refusals (unknown layout, an index path leaving its folder, a missing library, a checksum mismatch, a loader-made library, an unlisted version), and a Fabric profile with no Fabric host faked. Not on Linux arm64, where the client is refused |
| `c7-client-launch` | `client launch` with the fake game over Mojang's version file on disk: offline players by `--as`, by the profile and by default, a Microsoft account as saved and as the default, a sign-in renewed (refused as over, then Microsoft unreachable and the saved one used with a warning), every refusal before the game starts, a stopped server joined by quick play with its warnings and the Multiplayer list filled, `--wait` over a game that exits at once, and a Fabric profile with no build pinned |
| `c7-client-loaders` | Fabric and Quilt profiles over faked Mojang, Fabric and Quilt hosts, made by `make-c7-loader-scenario.mjs`: the stable Fabric build picked and pinned, a pinned build, a meta answering for another build or game version, a library checksum mismatch, a build the meta lacks, a snapshot and an old release with no loader; Quilt's newest non-beta from a list out of order, checksums from the `.sha1` beside each library, and its refusals (another host, an unknown shape, a checksum file with none, a wrong id); version files damaged and made again; and the fake game launched on loader profiles. Not on Linux arm64 |
| `c6b-doctor` | C6b's `doctor`, text and `--json`, and its usage checks (only `--json` checks flags and arguments): a missing folder, a missing jar, an EULA not accepted (and one accepted over CRLF), a port that collides with another server's RCON port, a port given as text, a stale state file reported by `--json` and cleared by the text form, a data-format marker from a newer release, world-readable secrets files made owner-only by the text form, and a client profile pinned to a missing Java |
| `c6b-diag` | `diag`: its usage and refusals, and bundles for a server, a client profile and both, text and `--json`, with every cleaning (secrets, player IPs, the account folder, the Microsoft account, harness, access, session and panel tokens). Zips are compared by entry names and order; sizes and checksums are evened out (summary.json's version, the deflate) |
| `c8-panel-basics` | the panel over HTTP, the routes the Rust panel answers itself (C8 group a): the three pages and their headers, with `/setup` only behind the window; who may call (no credential, another Host or Origin, a token for another port, a probe and its proof); the first-run wizard's calls and every refusal of a save; appearance, jars, the MCP command, health, the Java list and what versions need, the software list and version lists over faked hosts (one of them down), diagnostics and the feedback links for a server, a database and nothing, and each thing a settings save can be asked. Those steps are `own`; a last one sends longer paths and other methods, which fit no moved route and still reach the Node panel on both sides |
| `c8-panel-servers` | the panel's server routes that start no job, all in `own` steps: the list, history, the overview, linger, join, diagnose, metrics, attached databases without passwords, console export, the diagnostics download's refusals, settings and each refusal, a running server over the JVM stand-in (start, command, console stream, restart, stop), rebuild, rename and delete |
| `c8-panel-players` | a server's players over HTTP: the list, the whitelist switch, add by name with Mojang faked, op, ban, whitelist and forget against a stopped server's files and a running server's console |
| `c8-panel-props-files` | a server's settings page, raw properties, icon and file manager over HTTP: every value check, odd bodies, downloads and their header names, uploads, archives, and a running server's held files |
| `c8-panel-backups-schedules-worlds` | a server's backups, scheduled tasks and worlds over HTTP: every branch with odd bodies, download names past ASCII, a restore in progress and a running server |
| `c8-panel-databases` | the database routes over HTTP: the list with external databases probed, creates as jobs, credentials, SQL backups taken, downloaded, restored and deleted, attach and detach, and a server's own database |
| `c8-panel-creates` | making a server over HTTP: `POST /api/instances` for each kind of server against faked hosts with each job's last word read from its stream, and `POST /api/instances/adopt` |
| `c8-panel-plugins` | a server's plugins, modpack and upgrade over HTTP with Modrinth, Hangar, Paper, Purpur and Fabric faked: the plugin list, search and install plan with their refusals, toggle, remove and install (with `also`, a bad id, a file name or checksum that is refused, a wrong loader), update checks, one update and `update-all` as a job read back from its stream, the pack check and update as a job, the upgrade check and apply (a build, a cross-version upgrade with its snapshot, a version that does not exist), and the modpack search |
| `c8-panel-client` | the launcher's routes over HTTP with Mojang and the loader hosts faked: the version picker and one version described, loader builds, Java found and checked, profiles made, changed, renamed, duplicated and removed with their refusals, the log and its redaction, offline accounts, the default and sign-out, the Microsoft sign-in (its stream, a cancel, Microsoft's refusal, a missing code, a replayed or wrong `state`), and the fake game launched as a request and as a job, with a crash that leaves its exit record |
| `c9-bot` | C9's `bot`: usage errors; `bot check` on a missing server, a bad name, a database, a record with no folder, an online-mode server, stopped servers on loopback, a LAN address and every interface, and a running one with and without a stand-in mineflayer in the host folder, text and `--json`; `bot run` on a missing file, a folder, bad JSON and every refusal of the scenario check; then end to end over the JVM stand-in answering RCON, with the real `bot-host.cjs` driving a stand-in mineflayer: a passing run, setup over RCON (one that fails and aborts the host), a failing step, and a mineflayer that cannot load. Step and run times evened out |
| `c9-bot-setup` | `bot setup` with no npm on PATH: the pinned files copied first, the refusal, an install without this lockfile's marker (or with another) replaced, and a marker equal to the shipped stamp accepted unless `--force`. Linux and macOS only (a step's `PATH` would sit beside Windows' inherited `Path`) |
| `c9-mcp-protocol` | C9's MCP protocol edges on both eras, made by `make-c9-mcp-scenarios.mjs`: handshake versions, modern `_meta` with and without client capabilities, an unsupported version, ping, unknown methods, messages that are not requests, notifications, tools/call without a name or with an unknown tool, argument validation (types, enum, integers, required, Object.prototype names) and the `mcp` command's usage errors |
| `c9-mcp-tools` | the first session of `c9-mcp-running` alone, on every platform: the read tools, the config file tools and their path refusals, and the client and bot tools on a stopped server |
| `c9-mcp-running` | the MCP tools on a stopped and then a running server (the JVM stand-in answering RCON), made by `make-c9-mcp-scenarios.mjs`: every read tool, start with progress, run_command and its refusals, backup, write_config_file, stop and restart, the destructive previews and their absence without `--allow-destructive`, the download tools with every host refused, the client and bot tools with nothing to drive, the RCON password scrubbed and the activity left under the client's name. Linux and macOS only: on Windows the Node core's MCP server leaves the daemon it started holding its stdout, so the rig finds the pipe held after it exits (the Rust core's does not) |

Each phase adds its own scenarios before it flips its commands, failure paths included (plan
rule 5).

## Declared differences

The only ways a ported command may differ from its Node twin (plan section 6.1). Since C10 the "Node" column is what the frozen records hold, and the table is kept so a re-recorded scenario does not drop a difference by accident. The table is
`declared-differences.mjs`, and adding a row needs a reason in the pull request.

| Where | Node | Rust | How the rig holds it |
| --- | --- | --- | --- |
| `doctor`, the diagnostics bundle, the panel's diagnostics | a `node: <version>` line and the code `root`; the bundle's facts name Node's version and `spawnloft` is package.json's, as is the panel's `SpawnLoft:` line | a `core: spawnloft-core <version> (<target>)` line, no `root`; no `node` fact, and `spawnloft` (the panel's `SpawnLoft:` line too) is the core's own version | evened out (`doctor-node-line`) |
| `doctor` on Windows, a secrets file whose access list is all inherited | no problem when icacls prints the inherited entries without "(I)" (seen on the GitHub Windows runner's temp folder) | "other users on this computer can read ... (it inherits its folder's permissions ...)", read from the access list itself, and the text form makes the file owner-only | evened out (`windows-inherited-acl`): those lines and strings go, and on Windows the problem counts |
| `repair` text and `--json` | `runtime: <node path>` | the core's own path | evened out (`repair-runtime`) |
| `repair --json`'s `root`, `run/runtime.json`'s `root`, the first-run wizard's `coreDir` | the Node core's folder (`resources/core`, a checkout in the rig) | the folder holding spawnloft-core; `root` is written for 1.x and no longer compared | evened out (`code-folder`) |
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
| the panel's `/api/appearance` before a theme has been saved | `"theme": "classic"` | `"theme": "spawnloft"` (the SpawnLoft look is the default since the UX overhaul's phase 3) | evened out (`default-theme`): only answers before the first saved theme; after it both sides answer what was saved |
| a checkout whose code folder holds `instances.json` and no settings choose a data root | the code folder is the data root (and is listed among other registries) | the per-user data folder; the code folder is never a data root | no installed build can be in that state (C0-CHECKS.md section 2); the rig's code folder is the checkout, which has no instances.json |
| `bot run` once mineflayer is installed: where the Mineflayer host script lives and which Node runs it | runs `src/bot-host.cjs` from the code folder on its own Node | writes its embedded copy to `bot-host/bot-host.cjs` in the data folder and runs it there, on the bundled runtime's Node, else `node` on PATH, with `NODE_OPTIONS` and `NODE_PATH` removed | c9-bot ignores data/bot-host/bot-host.cjs; nothing but the host run reads it, and both sides run the same script on the same Node in the rig |

## The download-host override

`SPAWNLOFT_TEST_ORIGINS` is a JSON map from an origin to a loopback origin. The Node core honoured it only
with `NODE_ENV=test` (`src/test-origins.mjs`, which wrapped `fetch` before any module ran; the file
left with the Node core in C10). Rust honours it only in a build with the
`test-hooks` feature (`spawnloft-lib/src/test_origins.rs`, `test_origins::rewrite`). Every Rust
client that reaches the network calls it: the updater's fetch and the webhook post today, every
download from C1 on. Node follows redirects one hop at a time, so a redirect cannot lead past
the map. Such a build adds `"testHooks":"spawnloft-test-hooks:on"` to `--version --json`;
`desktop/release-gate.mjs` refuses a core that reports it, and `desktop/build-trust.mjs` refuses
a binary that contains the marker. The rules are
`test/fixtures/contracts/test-origins.json`, which the Node module's generator wrote before the
Node core left (C10) and `test_origins.rs`'s tests still hold the Rust side to. To change the
rules, change the fixture and those tests together.
