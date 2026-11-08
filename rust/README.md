# SpawnLoft Rust workspace (internal)

**Internal only.** This lives on the `v2` branch. No Rust code, binary or build change reaches
`dev`, a beta, a release or a feed until Victor says "push to beta"
(PLAN-RUST-TAURI.md section 13).

| Crate | What it is |
| --- | --- |
| `spawnloft-lib` | The library: version and build identity now; the daemon, archives and the core later |
| `spawnloft-core` | The console binary (`spawnloft-core`, `spawnloft-core.exe`). Today: `--version` and a `daemon` stub |
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
```

The shell links webkit2gtk on Linux: `sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev
librsvg2-dev` before building the workspace there. To run it against a checkout, build the core
and point the shell at it:

```sh
cargo build -p spawnloft-core -p spawnloft-shell
SPAWNLOFT_CORE_BIN=target/debug/spawnloft-core SPAWNLOFT_CORE_DIR=.. ./target/debug/SpawnLoft
```

On Windows this needs rustup and the Visual Studio 2022 Build Tools with the "Desktop
development with C++" workload (MSVC linker and Windows SDK).

## How it ships (internal phase)

`.github/workflows/rust-internal.yml` runs on pushes to `v2`: the checks above, the Node tests,
then packages for Windows x64, macOS arm64 and Linux x64 with the binary inside the Electron app
at `resources/bin/spawnloft-core` (`Contents/MacOS/spawnloft-core` on the Mac), plus the
`spawnloft-cli` deb and rpm. Everything is a workflow artifact kept for 14 days, versioned
`2.0.0-internal.<run>`, unsigned on Windows, ad-hoc signed on the Mac, with the app's update
check turned off. The workflow never publishes, tags, writes a feed or makes a release.

To place a locally built binary where electron-builder picks it up:

```sh
node desktop/stage-core.mjs        # copies rust/target/release/spawnloft-core into desktop/build/bin/<platform>-<arch>/
```
