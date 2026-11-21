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
scenario ever downloads anything real. A scenario may not set `SPAWNLOFT_CORE_IMPL` or
`SPAWNLOFT_TEST_ORIGINS` itself, in its own `env` or a step's: the rig refuses it.

Not isolated: the system's scheduler (`schtasks`, `launchctl`, `systemctl --user`) and the
Windows user PATH. Scenarios do not create tasks until C6 brings a way to point the scheduler at
a scratch folder.

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
- `platforms`: run the scenario only there.
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
| a JSON file holding half of a surrogate pair (`"\ud83d"`) | kept; printed as U+FFFD, re-escaped as `\ud83d` in JSON output | read as U+FFFD, printed and written as that character | evened out (`lone-surrogate`) |
| a JSON file holding a number beyond the double range (`1e400`) | read as Infinity | refused as a file that does not parse | no SpawnLoft writer can produce one (JSON.stringify writes Infinity as null); scenarios do not hand-write one |
| a state file whose `daemonStartTime` (written by 2.0's daemon) differs from the live process under that pid | the field is ignored; the pid and the image name decide | the creation time decides where the system reports one | the Node daemon never writes the field; scenarios write it only as the running daemon's own |
| a settings value of the wrong type (`"dataRoot": 5`) | an uncaught crash: source excerpt, the error line, the stack, `{ code: ... }` and `Node.js v<version>` | the error line alone, exit 1 | evened out (`settings-type-crash`) |
| Windows: `start`, `restart` and `db create` for a server (which starts it) read through a pipe (the rig, a script capturing the output) | the pipe stays open after the command exits, until the server stops (the rig waits 10 s and notes it) | the pipe closes when the command exits | evened out (`windows-daemon-holds-pipes`) |
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
