//! Black-box tests: the built binary, run as a process, the way the Node supervisor and
//! verify-build.mjs will run it.

use spawnloft_fakes::{TempDir, run};

const BIN: &str = env!("CARGO_BIN_EXE_spawnloft-core");

#[test]
fn version_exits_zero_and_names_the_target() {
    let out = run(BIN, &["--version"]);
    assert_eq!(out.code, Some(0), "stderr: {}", out.stderr);
    assert!(
        out.stdout.starts_with("spawnloft-core "),
        "stdout: {}",
        out.stdout
    );
    assert!(out.stdout.trim_end().ends_with(')'));
}

#[test]
fn version_json_is_parseable_shape() {
    let out = run(BIN, &["--version", "--json"]);
    assert_eq!(out.code, Some(0));
    let line = out.stdout.trim();
    assert!(line.starts_with('{') && line.ends_with('}'));
    for key in ["\"name\":", "\"version\":", "\"commit\":", "\"target\":"] {
        assert!(line.contains(key), "missing {key} in {line}");
    }
}

#[test]
fn daemon_stub_exits_69_without_touching_the_data_root() {
    let root = TempDir::new("daemon-stub");
    let out = spawnloft_fakes::run_in(BIN, &["daemon", "survival"], root.path());
    assert_eq!(out.code, Some(69), "stderr: {}", out.stderr);
    assert!(out.stdout.is_empty());
    assert!(root.is_empty(), "the stub must not write anything");
}

#[test]
fn unknown_command_is_a_usage_error() {
    let out = run(BIN, &["nope"]);
    assert_eq!(out.code, Some(64));
}
