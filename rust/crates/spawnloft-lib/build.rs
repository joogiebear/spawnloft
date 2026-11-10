// Records the target triple for `--version`, and makes Cargo rebuild when the build identity
// that CI passes in (SPAWNLOFT_VERSION, SPAWNLOFT_COMMIT) changes between runs. The updater's
// two build-time settings are validated here, so a typo fails the build instead of shipping a
// binary that trusts nothing (or trusts the wrong thing).
fn main() {
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
