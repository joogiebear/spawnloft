# Rust supply chain

Policy (agreed 2026-11-05, kept by the 2026-11-08 Rust + Tauri plan):

- `Cargo.lock` is committed and every CI build runs with `--locked`.
- `cargo deny check` runs on every push: crates.io only, no git sources, the licence allowlist
  in `deny.toml`, and RustSec advisories (a yanked or vulnerable crate fails the build).
- The toolchain is pinned in `rust-toolchain.toml`.
- A direct dependency is added only by a commit that also adds it to the table below, saying who
  maintains it and why a smaller option or std would not do.

## Direct dependencies

| Crate | Used by | Maintainer | Why |
| --- | --- | --- | --- |
| `serde_json` (feature `preserve_order`) | spawnloft-lib: state files, the control protocol, the registry, metrics, the webhook body | dtolnay and the serde-rs team | Every file and message the daemon shares with Node is JSON. A hand parser would be a second JSON implementation to keep right on escapes, numbers and UTF-8; serde_json is the most used crate for it. `preserve_order` keeps keys in the order Node writes them, so state.json reads the same under both daemons. Its tree adds indexmap, hashbrown, foldhash, itoa, zmij and memchr. |
| `regex` | spawnloft-lib: the ready and failure patterns, the crash diagnosis shapes, TPS and `list` parsing | the rust-lang team | The patterns are shared with the Node daemon as JavaScript regexes; porting them by hand into string matching would drift. `regex` is maintained by the Rust project, linear time (no catastrophic backtracking on server log lines), and pulls only its own regex-automata, regex-syntax and aho-corasick. |
| `windows-sys` (Windows only) | spawnloft-lib `platform/windows.rs`: Job Objects, the named pipe and its DACL, process times and memory | Microsoft | Raw bindings to the Win32 calls the daemon needs and nothing else (feature-gated per API set). Generated from Microsoft's metadata; the alternative is hand-written `extern` declarations, which is where layout bugs come from. |
