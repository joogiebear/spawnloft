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
fn daemon_for_an_unknown_server_says_why_in_its_state_file() {
    let root = TempDir::new("daemon-unknown");
    let data = root.path().to_string_lossy().into_owned();
    let out = spawnloft_fakes::run_in(BIN, &["daemon", "survival", "--data-root", &data], root.path());
    assert_eq!(out.code, Some(1), "stderr: {}", out.stderr);
    let state = std::fs::read_to_string(root.path().join("run/survival/state.json")).unwrap();
    assert!(state.contains("\"running\": false"), "{state}");
    assert!(state.contains("no instance named \\\"survival\\\""), "{state}");
    let log = std::fs::read_to_string(root.path().join("run/survival/daemon.log")).unwrap();
    assert!(log.contains("failed to start: no instance named"), "{log}");
}

#[test]
fn daemon_refuses_a_name_that_is_not_one() {
    let root = TempDir::new("daemon-badname");
    let data = root.path().to_string_lossy().into_owned();
    let out = spawnloft_fakes::run_in(BIN, &["daemon", "../etc", "--data-root", &data], root.path());
    assert_eq!(out.code, Some(2), "stderr: {}", out.stderr);
    assert!(root.is_empty(), "nothing is written for a bad name");
}

#[test]
fn unknown_command_is_a_usage_error() {
    let out = run(BIN, &["nope"]);
    assert_eq!(out.code, Some(64));
}
