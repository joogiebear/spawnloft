# SpawnLoft Rust workspace (internal)

**C10 status (2026-11-22).** The Node core is deleted from this branch (`PLAN-CORE-PORT.md` section 5.7). Node.js 22 or later is needed only for test players, and by the black-box tests (`node tools/run-tests.mjs`) and the parity rig (`node tools/parity/run.mjs`), which run against a `test-hooks` build of `spawnloft-core`.

**Internal only.** This lives on the `v2` branch. No Rust code, binary or build change reaches
`dev`, a beta, a release or a feed until Victor says "push to beta"
(PLAN-RUST-TAURI.md section 13).

| Crate | What it is |
| --- | --- |
| `spawnloft-lib` | The library: the whole core (every CLI command, the per-server daemon, the panel, the client launcher, the bot harness driver, the MCP server, the updater) |
| `spawnloft-core` | The console binary (`spawnloft-core`, `spawnloft-core.exe`): every command, `daemon`, `ui`, `mcp` and `update`. Since C10 it is the whole core: no Node runtime and no `.mjs` core ships in any package, and `mcctl.mjs` or `spawnloft.mjs` as a first argument (1.x shims and MCP configs) is dropped, never run |
| `spawnloft-shell` | The window (`SpawnLoft.exe`), a Tauri 2 shell over the panel `spawnloft-core ui` serves. Phase 0 spike (P0-F): its NSIS template installs over 1.x; see `crates/spawnloft-shell/spike/` |
| `spawnloft-fakes` | Test helpers: temp dirs and running the built binary; fake java, CDNs and token endpoints later |

## Build and check

From `rust/` (the toolchain in `rust-toolchain.toml` is installed by rustup on first use):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo deny check            # cargo install cargo-deny --locked
cargo build --release --locked -p spawnloft-core
./target/release/spawnloft-core --version
cargo build -p spawnloft-core --features test-hooks   # what the Node tests and the parity rig drive
cd .. && node tools/run-tests.mjs && node tools/parity/run.mjs
```

The shell links webkit2gtk on Linux: `sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev
librsvg2-dev` before building the workspace there. To run it against a checkout, build the core
and point the shell at it:

```sh
cargo build -p spawnloft-core -p spawnloft-shell
SPAWNLOFT_CORE_BIN=target/debug/spawnloft-core SPAWNLOFT_CORE_DIR=.. ./target/debug/SpawnLoft
```

`SPAWNLOFT_CORE_DIR` is read only by a debug or `test-hooks` build, to take the panel's pages from
`<dir>/src` instead of the copies compiled in. `SPAWNLOFT_DAEMON`, `SPAWNLOFT_CORE_IMPL` and the
`daemon` setting mean nothing since C10.

On Windows this needs rustup and the Visual Studio 2022 Build Tools with the "Desktop
development with C++" workload (MSVC linker and Windows SDK).

## How it ships (internal phase)

`.github/workflows/rust-internal.yml` runs on pushes to `v2`: the checks above, the Node tests
(run against the Rust build), then packages for Windows x64, macOS arm64 and Linux x64 with the binary inside the Electron app
at `resources/bin/spawnloft-core` (`Contents/MacOS/spawnloft-core` on the Mac), plus the
`spawnloft-cli` deb and rpm. Everything is a workflow artifact kept for 14 days, versioned
`2.0.0-internal.<run>`, unsigned on Windows, ad-hoc signed on the Mac, with the app's update
check turned off. The workflow never publishes, tags, writes a feed or makes a release.

`.github/workflows/updater.yml` runs on `v2` when `rust/**` or `desktop/update-envelope.mjs`
change: throwaway minisign keys made in the job (`SPAWNLOFT_UPDATE_PUBKEYS` overrides the
compiled-in release keys), two shell builds, a loopback feed with every refusal variant
(`crates/spawnloft-shell/updater-tests/`), and the design's scenarios 5 to 7 (update, rollback
with the hold, refusals) on windows-latest. Nothing leaves the runner.

To place a locally built binary where electron-builder picks it up:

```sh
node desktop/stage-core.mjs        # copies rust/target/release/spawnloft-core into desktop/build/bin/<platform>-<arch>/
```
