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

/// The first `node` on PATH, for the forwarding tests (skipped without one).
fn node_on_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

#[test]
fn a_command_it_does_not_own_goes_to_the_node_core() {
    let Some(node) = node_on_path() else {
        eprintln!("skipped: no node on PATH");
        return;
    };
    let core = TempDir::new("forward-core");
    // a stand-in Node core: prints what it was given and exits with the code it was told
    std::fs::write(
        core.path().join("spawnloft.mjs"),
        r#"let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  console.log(JSON.stringify({ args: process.argv.slice(2), entry: process.env.SPAWNLOFT_ENTRY ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, stdin }))
  process.exitCode = Number(process.argv[3] ?? 0)
})
"#,
    )
    .unwrap();
    use std::io::Write;
    let mut child = std::process::Command::new(BIN)
        .args(["list", "7", "--json", "a b"])
        .env("SPAWNLOFT_CORE_DIR", core.path())
        .env("SPAWNLOFT_NODE", &node)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"hello mcp").unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(7),
        "stdout {stdout} stderr {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["args"], serde_json::json!(["list", "7", "--json", "a b"]));
    assert_eq!(v["stdin"], "hello mcp");
    assert_eq!(
        v["electron"],
        serde_json::Value::Null,
        "ELECTRON_RUN_AS_NODE is removed"
    );
    let entry = std::path::PathBuf::from(v["entry"].as_str().unwrap());
    assert_eq!(
        std::fs::canonicalize(entry).unwrap(),
        std::fs::canonicalize(BIN).unwrap(),
        "SPAWNLOFT_ENTRY names this binary"
    );
}

#[test]
fn a_missing_node_core_is_reported_not_a_crash() {
    let core = TempDir::new("forward-missing");
    let out = std::process::Command::new(BIN)
        .arg("list")
        .env("SPAWNLOFT_CORE_DIR", core.path())
        .env("SPAWNLOFT_NODE", "node")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("spawnloft.mjs is missing"));
}

#[test]
fn a_bad_argument_to_its_own_command_is_a_usage_error() {
    let out = run(BIN, &["update", "--nope"]);
    assert_eq!(out.code, Some(64), "stderr: {}", out.stderr);
}
