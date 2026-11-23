// Records the target triple for `--version`, and makes Cargo rebuild when the build identity
// that CI passes in (SPAWNLOFT_VERSION, SPAWNLOFT_COMMIT) changes between runs. The updater's
// two build-time settings are validated here, so a typo fails the build instead of shipping a
// binary that trusts nothing (or trusts the wrong thing).
fn main() {
    panel_assets();
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=SPAWNLOFT_TARGET={target}");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_VERSION");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_COMMIT");
    // the updater's trust anchors and the feed-freshness floor (update/keys.rs, update/policy.rs)
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_UPDATE_PUBKEYS");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_FEED_BASELINE");
    println!("cargo:rerun-if-changed=build.rs");
    if let Ok(list) = std::env::var("SPAWNLOFT_UPDATE_PUBKEYS")
        && !list.trim().is_empty()
    {
        for item in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let Some((id, key)) = item.split_once('=') else {
                panic!("SPAWNLOFT_UPDATE_PUBKEYS: `{item}` is not <key id>=<key line>");
            };
            let (id, key) = (id.trim(), key.trim());
            assert!(
                id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                "SPAWNLOFT_UPDATE_PUBKEYS: key id `{id}` is not 16 hex digits"
            );
            assert!(
                key.len() == 56
                    && key.starts_with("RW")
                    && key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='),
                "SPAWNLOFT_UPDATE_PUBKEYS: `{key}` is not a minisign public key line"
            );
        }
        println!(
            "cargo:warning=SPAWNLOFT_UPDATE_PUBKEYS is set: this build trusts a test key list, not the release keys"
        );
    }
    if let Ok(baseline) = std::env::var("SPAWNLOFT_FEED_BASELINE")
        && !baseline.is_empty()
    {
        let b = baseline.as_bytes();
        let ok = b.len() == 20
            && b[4] == b'-'
            && b[7] == b'-'
            && b[10] == b'T'
            && b[13] == b':'
            && b[16] == b':'
            && b[19] == b'Z'
            && b.iter()
                .enumerate()
                .all(|(i, c)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19) || c.is_ascii_digit());
        assert!(
            ok,
            "SPAWNLOFT_FEED_BASELINE must be an ISO instant like 2026-12-01T00:00:00Z, got `{baseline}`"
        );
    }
}

/// The panel's stylesheets, scripts and bundled typefaces (`src/panel/css`, `src/panel/js`,
/// `src/panel/fonts`), compiled in as a table of exact names (`panel/pages.rs`): the `/assets/`
/// route answers those names and nothing else. Only `.css` and `.js` files are taken from the
/// first two and only `.woff2` from the third (the licences beside the fonts stay in the
/// checkout); the names are plain path segments of lower-case letters, digits, `-` and `.`, so a
/// file that would need escaping or could read as a different path stops the build instead.
fn panel_assets() {
    use std::path::{Path, PathBuf};
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest.join("../../../src/panel");
    fn walk(dir: &Path, base: &Path, kinds: &[&str], out: &mut Vec<(String, PathBuf)>) {
        println!("cargo:rerun-if-changed={}", dir.display());
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .map(|e| e.expect("read_dir").path())
            .collect();
        entries.sort();
        for path in entries {
            // a link could loop, or pull in a file from outside the checkout
            let meta = std::fs::symlink_metadata(&path).expect("symlink_metadata");
            assert!(
                !meta.file_type().is_symlink(),
                "{}: a link is not taken into the panel; put the file itself there",
                path.display()
            );
            if meta.is_dir() {
                walk(&path, base, kinds, out);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !kinds.contains(&ext) {
                continue;
            }
            println!("cargo:rerun-if-changed={}", path.display());
            let name = path
                .strip_prefix(base)
                .expect("under src/panel")
                .components()
                .map(|c| c.as_os_str().to_str().expect("a UTF-8 file name").to_string())
                .collect::<Vec<_>>()
                .join("/");
            assert!(
                name.split('/').all(|seg| !seg.is_empty()
                    && !seg.starts_with('.')
                    && seg
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')),
                "src/panel/{name}: an asset name is lower-case letters, digits, `-` and `.` only"
            );
            out.push((name, path));
        }
    }
    let mut assets = Vec::new();
    for (top, kinds) in [
        ("css", &["css"][..]),
        ("js", &["js"][..]),
        ("fonts", &["woff2"][..]),
    ] {
        walk(&root.join(top), &root, kinds, &mut assets);
    }
    assets.sort();
    let mut table = String::from("&[\n");
    for (name, path) in &assets {
        table.push_str(&format!(
            "    ({name:?}, include_bytes!({:?}).as_slice()),\n",
            path.display().to_string()
        ));
    }
    table.push_str("]\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("panel_assets.rs");
    std::fs::write(out, table).expect("write panel_assets.rs");
}
