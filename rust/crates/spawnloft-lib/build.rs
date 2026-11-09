// Records the target triple for `--version`, and makes Cargo rebuild when the build identity
// that CI passes in (SPAWNLOFT_VERSION, SPAWNLOFT_COMMIT) changes between runs.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=SPAWNLOFT_TARGET={target}");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_VERSION");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_COMMIT");
    // the updater's trust anchors and the feed-freshness floor (update/keys.rs, update/policy.rs)
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_UPDATE_PUBKEYS");
    println!("cargo:rerun-if-env-changed=SPAWNLOFT_FEED_BASELINE");
    println!("cargo:rerun-if-changed=build.rs");
}
