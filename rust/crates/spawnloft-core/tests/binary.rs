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

/// Every file under `root`, with its contents.
fn tree(root: &std::path::Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut todo = vec![root.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.insert(p.clone(), b"<dir>".to_vec());
                todo.push(p);
            } else {
                out.insert(p.clone(), std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    out
}

/// No GET writes (rust/PANEL-AUTH-DESIGN.md 3.4): a signed-in browser's cookie goes with any GET
/// another loopback page makes, and without `Sec-Fetch-Site` the panel cannot tell. The routes the
/// proxy answers itself are checked here; the Node panel's in test/panel-get-writes.test.mjs.
/// `GET /api/update/rollbacks` reads the release list from the internet and is left out; it
/// only reads. The list below must name every route in the route tables at the top of
/// `update/api.rs` and `handover/api.rs`, which this test reads, so a new route is not missed.
#[test]
fn the_proxys_own_get_routes_write_nothing() {
    use std::io::{BufRead, Read, Write};
    let home = TempDir::new("get-writes");
    let config = home.path().join("config");
    let data = home.path().join("data");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    /// stops the panel however the test ends
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = std::process::Command::new(BIN)
        // nothing listens upstream: these routes never reach it
        .args(["ui", "--port", "0", "--upstream", "http://127.0.0.1:1/"])
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("XDG_CONFIG_HOME", &config)
        .env("XDG_DATA_HOME", &data)
        .env("APPDATA", &config)
        .env("LOCALAPPDATA", &data)
        .env("SPAWNLOFT_DATA_ROOT", &data)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let _panel = Kill(child);
    let mut line = String::new();
    std::io::BufReader::new(stdout).read_line(&mut line).unwrap();
    let port: u16 = line
        .trim()
        .strip_prefix(spawnloft_lib::panel::READY_PREFIX)
        .and_then(|u| u.strip_prefix("http://127.0.0.1:"))
        .and_then(|p| p.trim_end_matches('/').parse().ok())
        .unwrap_or_else(|| panic!("no ready line: {line:?}"));
    let key = spawnloft_lib::panel_auth::load_key_at(&config.join("spawnloft").join("panel.key")).unwrap();
    let get = |route: &str| -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .unwrap();
        let auth = spawnloft_lib::panel_auth::authorization(&key, port);
        write!(
            s,
            "GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut answer = String::new();
        let _ = s.read_to_string(&mut answer);
        answer
    };
    let asked = [
        "/api/update",
        "/api/update/log?n=5",
        "/api/update/nothing",
        "/api/update/hold",
        "/api/update/check",
        "/api/update/install",
        "/api/update/rollback",
        "/api/update/channel",
        "/api/handover",
        "/api/handover/dismiss",
    ];
    let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spawnloft-lib/src");
    for table in ["update/api.rs", "handover/api.rs"] {
        let text = std::fs::read_to_string(lib.join(table)).unwrap();
        for row in text.lines().filter(|l| l.starts_with("//! | `")) {
            let route = row
                .split('`')
                .nth(1)
                .and_then(|r| r.split_whitespace().nth(1))
                .unwrap_or_default()
                .split('?')
                .next()
                .unwrap_or_default();
            if route == "/api/update/rollbacks" {
                continue;
            }
            assert!(
                asked.iter().any(|a| a.split('?').next() == Some(route)),
                "{table} lists {route}; add it to this test"
            );
        }
    }
    let mut before = tree(home.path());
    let mut wrote = Vec::new();
    for route in asked {
        let answer = get(route);
        assert!(answer.starts_with("HTTP/1.1 "), "{route}: no answer: {answer:?}");
        assert!(!answer.starts_with("HTTP/1.1 401"), "{route}: {answer}");
        let after = tree(home.path());
        if after != before {
            let changed: Vec<_> = after
                .keys()
                .chain(before.keys())
                .filter(|p| after.get(*p) != before.get(*p))
                .map(|p| p.display().to_string())
                .collect();
            wrote.push(format!("GET {route}: {changed:?}"));
        }
        before = after;
    }
    assert!(wrote.is_empty(), "GET requests that wrote: {wrote:#?}");
}
