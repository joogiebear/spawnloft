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
| (none yet) | | | The skeleton is std only. The daemon (P0-D) brings the first ones. |
