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
runs all of it on Linux x64 and arm64, Windows and macOS on every pull request.

## What each side gets

Each side runs in `<scratch>/run` with the data root at `run/data` and `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA` and the XDG folders under `run/home`, so a file written anywhere a
core might write lands in the compared tree. Both sides use the same path, one after the other,
so absolute paths in shims and records compare exactly. The machine's own `SPAWNLOFT_*`,
`MCCTL_*` and `NODE_OPTIONS` never reach a side. Each side also gets `NODE_ENV=test`,
`TZ=UTC`, `LANG=LC_ALL=en_US.UTF-8` and the bundled-runtime stand-ins `SPAWNLOFT_NODE` and
`SPAWNLOFT_CORE_DIR`. `SPAWNLOFT_TEST_ORIGINS` is always set: it holds the scenario's fake
hosts, and with none it is `{}`. That refuses every host that is not on this machine, so no
scenario ever downloads anything real.

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
    { "write": "data/x.txt", "text": "...", "mode": "600" },
    { "mkdir": "data/instances/alpha" },
    { "remove": "data/x.txt" },
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
  `delayMs`. `${sha256:<url>}` (also sha1, sha512, md5 and size) fills in another route's
  checksum. Every request is logged and the two sides' logs are compared: method, path and query,
  user agent, accept.
- `normalize` adds patterns this scenario knows are volatile, on top of the built-in ones
  (`lib/normalize.mjs`: times, dates, file-name stamps, pids, lock tokens, epoch milliseconds,
  durations). Nothing else is evened out between the sides except the declared differences.
- `golden`: the Node side's steps, with this machine's paths replaced by `<run>` and `<repo>`,
  must equal the file. A step with `"golden": false` is compared between the sides but kept out
  of the golden file. Use it for answers that depend on the machine. `goldenPlatforms` limits the
  check to some platforms.
- `platforms`: run the scenario only there.
- `acl`: on Windows, also compare each entry's `icacls` listing. POSIX modes are always compared.

## Self-tests

`selftest/` holds scenarios with `"expect": "differ"`. Each one seeds a difference with steps
marked `"side": "rust"`, and names the difference in `expectDifferences`. The rig passes such a
scenario only when it reports that exact difference. They cover stdout, the exit code and stderr,
an extra and a changed file in the tree, a file mode, and the fake-host request list. A
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
| `cli-json` | all 61 command names with `--json`, then the forms that answer with data. Golden: `test/fixtures/contracts/cli/cli-json.json` |

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
| number grouping (`toLocaleString`, mcctl.mjs) | the system locale | fixed en-US grouping | the rig runs both sides with LANG and LC_ALL set to en_US.UTF-8 (Windows runners are en-US) |
| a run-time pattern using lookaround or a backreference (`logs --grep`, MCP `get_logs`, bot scenarios) | accepted | refused with a clear message | scenarios give such a pattern only in a step that expects the refusal, and test/fixtures/contracts/regex.json lists the sites |
| the error text for an invalid run-time pattern | V8's (`Invalid regular expression: /(/: Unterminated group`) | the `regex` crate's | evened out (`invalid-pattern-text`) |

## The download-host override

`SPAWNLOFT_TEST_ORIGINS` is a JSON map from an origin to a loopback origin. Node honours it only
with `NODE_ENV=test` (`src/test-origins.mjs`, which wraps `fetch` before any module runs). This
is the one named exception to the Node freeze. Rust honours it only in a build with the
`test-hooks` feature (`spawnloft-lib/src/test_origins.rs`, `test_origins::rewrite`, which every
Rust download calls from C1 on). Such a build adds `"testHooks":true` to `--version --json`,
and `desktop/release-gate.mjs` refuses a package that contains one. Both sides are held to
`test/fixtures/contracts/test-origins.json`. To change the rules, change
`make-test-origins-fixture.mjs` and regenerate the fixture from the Node module.
