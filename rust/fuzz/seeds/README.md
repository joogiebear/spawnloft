Frozen fuzz seeds, committed (fuzz/corpus/ is not: libFuzzer grows it). The zip-fuzz job of
rust-internal.yml copies `seeds/<target>/` into `corpus/<target>/` before it runs.

- `zip_read/1x*.zip`: archives the 1.x writer made (src/zip.mjs at v1.6.0-beta.413, the same as
  1.5.0's), so the readers keep being fuzzed from what 1.x backups and exports look like after
  the Node code is gone. `crates/spawnloft-fakes/tests/zip_1x.rs` says how they were made and
  checks that the Rust reader extracts them byte for byte.
