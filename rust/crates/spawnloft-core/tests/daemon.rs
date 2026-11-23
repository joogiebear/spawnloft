//! End to end: the built core starts its daemon, the daemon runs the native JVM stand-in
//! (spawnloft-fakes' fake-java), and `stop` and `kill` are checked by what is left running
//! afterwards, not by what they print. On all three platforms (the `rust` job of
//! rust-internal.yml); the test-hooks build adds a kill the server outlives.

use spawnloft_fakes::{Ran, TempDir};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_spawnloft-core");

/// fake-java, from the same target folder as the core. `cargo test --workspace` builds it for
/// spawnloft-fakes' own tests; a `-p spawnloft-core` run builds it here.
fn fake_java() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let name = format!("fake-java{}", std::env::consts::EXE_SUFFIX);
        let path = Path::new(BIN).with_file_name(name);
        if !path.exists() {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
            let mut cmd = Command::new(cargo);
            cmd.args(["build", "--locked", "-p", "spawnloft-fakes", "--bin", "fake-java"]);
            if !cfg!(debug_assertions) {
                cmd.arg("--release");
            }
            let status = cmd.status().expect("run cargo build for fake-java");
            assert!(status.success(), "could not build fake-java");
        }
        assert!(path.exists(), "no fake-java at {}", path.display());
        path
    })
}

/// A data root with one server, `t`, whose java is fake-java.
struct Server {
    root: TempDir,
    envs: Vec<(String, String)>,
}

impl Server {
    fn new(label: &str, port: u16, auto_restart: bool) -> Server {
        let root = TempDir::new(label);
        let dir = root.path().join("instances").join("t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("eula.txt"), "eula=true\n").unwrap();
        std::fs::write(dir.join("server.jar"), "").unwrap();
        let registry = serde_json::json!({
            "version": 1,
            "instances": { "t": {
                "dir": dir.to_string_lossy(),
                "jar": "server.jar",
                "java": fake_java().to_string_lossy(),
                "memory": "1G",
                "port": port,
                "rcon": { "port": port + 10, "password": "daemon-e2e" },
                "autoRestart": auto_restart,
            } }
        });
        std::fs::write(root.path().join("instances.json"), registry.to_string()).unwrap();
        Server {
            root,
            envs: Vec::new(),
        }
    }

    fn env(mut self, k: &str, v: &str) -> Server {
        self.envs.push((k.into(), v.into()));
        self
    }

    fn dir(&self) -> PathBuf {
        self.root.path().join("instances").join("t")
    }

    fn run(&self, args: &[&str]) -> Ran {
        let mut cmd = Command::new(BIN);
        cmd.args(args)
            .current_dir(self.root.path())
            .env("SPAWNLOFT_DATA_ROOT", self.root.path())
            .env("MCCTL_DATA_ROOT", self.root.path())
            .envs(self.envs.iter().map(|(k, v)| (k, v)));
        let out = cmd.output().expect("run spawnloft-core");
        Ran {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code(),
        }
    }

    fn state(&self) -> serde_json::Value {
        let text = std::fs::read_to_string(self.root.path().join("run/t/state.json")).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
    }

    fn pids(&self) -> (u32, u32) {
        let st = self.state();
        let pid = |k: &str| {
            st.get(k)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| panic!("no {k} in {st}")) as u32
        };
        (pid("javaPid"), pid("daemonPid"))
    }

    fn daemon_log(&self) -> String {
        std::fs::read_to_string(self.root.path().join("run/t/daemon.log")).unwrap_or_default()
    }

    fn status(&self) -> String {
        let out = self.run(&["status", "t", "--json"]);
        let v: serde_json::Value =
            serde_json::from_str(out.stdout.trim()).unwrap_or_else(|_| panic!("status: {out:?}"));
        v["data"]["status"].as_str().unwrap_or_default().to_string()
    }

    fn start(&self) {
        let out = self.run(&["start", "t"]);
        assert_eq!(out.code, Some(0), "start: {out:?}\n{}", self.daemon_log());
        assert!(out.stdout.contains("Ready"), "start: {out:?}");
    }
}

impl Drop for Server {
    /// Nothing outlives a failed test: whatever the state file still names is ended.
    fn drop(&mut self) {
        let st = self.state();
        for k in ["javaPid", "daemonPid"] {
            if let Some(pid) = st.get(k).and_then(serde_json::Value::as_u64) {
                spawnloft_lib::util::kill_tree(pid as i32);
            }
        }
    }
}

fn alive(pid: u32) -> bool {
    spawnloft_lib::platform::pid_alive(pid)
}

fn wait_until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn kill_ends_the_server_and_its_daemon_before_it_answers() {
    let s = Server::new("daemon-kill", 45_711, false);
    s.start();
    let (java, daemon) = s.pids();
    assert!(alive(java) && alive(daemon));
    let out = s.run(&["kill", "t"]);
    assert_eq!(out.code, Some(0), "kill: {out:?}");
    assert!(out.stdout.contains("force-killed"), "kill: {out:?}");
    // the check the parity rig could not make on Windows (its daemonGone is a no-op there):
    // by the time kill answers, neither process is left
    assert!(!alive(java), "java {java} is still running after kill");
    assert!(
        !alive(daemon),
        "daemon {daemon} is still running after kill\n{}",
        s.daemon_log()
    );
    assert_eq!(s.status(), "stopped");
    assert!(
        !s.dir().join("fake-exit.json").exists(),
        "a kill is not a graceful stop"
    );
}

#[test]
fn a_stop_past_its_timeout_is_forced_and_said_so() {
    let s = Server::new("daemon-stop-timeout", 45_721, false);
    s.start();
    let (java, daemon) = s.pids();
    // the server that holds its stop for as long as this file is there
    std::fs::write(s.dir().join("ignore-stop"), "").unwrap();
    let began = Instant::now();
    let out = s.run(&["stop", "t", "--timeout", "1"]);
    assert_eq!(out.code, Some(0), "stop: {out:?}\n{}", s.daemon_log());
    assert!(
        out.stdout.contains("did not shut down gracefully and was killed"),
        "stop: {out:?}"
    );
    assert!(
        began.elapsed() < Duration::from_secs(20),
        "stop took {:?}",
        began.elapsed()
    );
    assert!(!alive(java), "java {java} is still running after the forced stop");
    assert!(
        !alive(daemon),
        "daemon {daemon} is still running after the forced stop"
    );
    assert!(
        s.daemon_log().contains("graceful stop timed out"),
        "{}",
        s.daemon_log()
    );
    assert!(!s.dir().join("fake-exit.json").exists());
    assert_eq!(s.status(), "stopped");
}

#[test]
fn a_graceful_stop_waits_for_the_server_and_the_daemon() {
    let s = Server::new("daemon-stop", 45_731, false);
    s.start();
    let (java, daemon) = s.pids();
    let out = s.run(&["stop", "t"]);
    assert_eq!(out.code, Some(0), "stop: {out:?}");
    assert!(out.stdout.contains("stopped (exit code 0)"), "stop: {out:?}");
    assert!(
        !alive(java) && !alive(daemon),
        "left running: java {java} {}, daemon {daemon} {}",
        alive(java),
        alive(daemon)
    );
    assert!(
        s.dir().join("fake-exit.json").exists(),
        "the stop was not graceful"
    );
    assert_eq!(s.status(), "stopped");
}

#[test]
fn a_crash_loop_is_restarted_then_given_up_on() {
    // every start dies the way a taken port does; restarts 200 ms apart
    let s = Server::new("daemon-crash-loop", 45_741, true)
        .env("FAKE_JAVA_FAIL", "start")
        .env("SPAWNLOFT_RESTART_DELAY_MS", "200");
    let out = s.run(&["start", "t"]);
    assert_ne!(
        out.code,
        Some(0),
        "a server that dies at start did not fail its start: {out:?}"
    );
    wait_until("auto-restart to give up", Duration::from_secs(30), || {
        s.state()
            .get("error")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|e| e.contains("auto-restart gave up"))
    });
    let st = s.state();
    assert_eq!(st["running"], serde_json::json!(false), "{st}");
    let starts = std::fs::read_to_string(s.dir().join("fake-starts.log")).unwrap_or_default();
    assert_eq!(
        starts.lines().count(),
        3,
        "three starts before giving up:\n{starts}"
    );
    if let Some(daemon) = st.get("daemonPid").and_then(serde_json::Value::as_u64) {
        wait_until("the daemon to leave", Duration::from_secs(15), || {
            !alive(daemon as u32)
        });
    }
    assert_eq!(s.status(), "stopped");
}

/// The daemon's kill is skipped (a server that outlives it): the daemon must not answer "ok",
/// and the CLI must fall back to killing by pid rather than report the server gone.
#[cfg(feature = "test-hooks")]
#[test]
fn a_kill_the_server_outlives_is_not_reported_done_by_the_daemon() {
    let s = Server::new("daemon-kill-outlived", 45_751, false).env("SPAWNLOFT_TEST_KILL_SKIP", "1");
    s.start();
    let (java, daemon) = s.pids();
    let out = s.run(&["kill", "t"]);
    assert_eq!(out.code, Some(0), "kill: {out:?}\n{}", s.daemon_log());
    let log = s.daemon_log();
    assert!(log.contains("test hook: the kill was not sent"), "{log}");
    assert!(
        log.contains("was still running 10 s after it was killed"),
        "{log}"
    );
    assert!(!alive(java), "java {java} is still running after kill");
    assert!(!alive(daemon), "daemon {daemon} is still running after kill");
    assert_eq!(s.status(), "stopped");
}

/// A `java` that is a wrapper script running the real one under another name (a version
/// manager's shim, say): the server is still known as the daemon's child after the exec, so it
/// reads "running", not "stopping". Linux records the start time that survives the exec.
#[cfg(target_os = "linux")]
#[test]
fn a_java_that_is_a_wrapper_script_still_reads_running() {
    use std::os::unix::fs::PermissionsExt;
    let s = Server::new("daemon-wrapper", 45_761, false);
    let wrapper = s.root.path().join("java-wrapper");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nexec '{}' \"$@\"\n", fake_java().display()),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let registry = std::fs::read_to_string(s.root.path().join("instances.json")).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&registry).unwrap();
    v["instances"]["t"]["java"] = serde_json::json!(wrapper.to_string_lossy());
    std::fs::write(s.root.path().join("instances.json"), v.to_string()).unwrap();
    s.start();
    // the exec has happened by the time the server printed its ready line
    assert_eq!(s.status(), "running", "{}", s.state());
    let out = s.run(&["stop", "t"]);
    assert_eq!(out.code, Some(0), "stop: {out:?}");
    assert_eq!(s.status(), "stopped");
}
