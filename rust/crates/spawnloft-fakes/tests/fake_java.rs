//! The native JVM stand-in (src/bin/fake-java.rs) behaves as the installer scenarios expect.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use spawnloft_fakes::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_fake-java");

#[test]
fn starts_echoes_and_stops_gracefully() {
    let dir = TempDir::new("fake-java");
    std::fs::write(dir.path().join("fake-exit.json"), "stale").unwrap();
    let mut child = Command::new(BIN)
        .args(["-Xmx1G", "-jar", "server.jar", "nogui"])
        .current_dir(dir.path())
        .env_remove("FAKE_JAVA_FAIL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut next = || {
        let mut l = String::new();
        out.read_line(&mut l).unwrap();
        l.trim_end().to_string()
    };
    assert_eq!(next(), "[00:00:00 INFO]: Starting minecraft server (fake)");
    assert_eq!(next(), "[00:00:00 INFO]: Done (0.042s)! For help, type \"help\"");
    // the start removed the last run's exit record
    assert!(!dir.path().join("fake-exit.json").exists());
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "say hi").unwrap();
    assert_eq!(next(), "[00:00:00 INFO]: fake got: say hi");
    writeln!(stdin, "stop").unwrap();
    assert_eq!(next(), "[00:00:00 INFO]: Stopping server");
    assert_eq!(next(), "[00:00:00 INFO]: Saving worlds");
    assert_eq!(child.wait().unwrap().code(), Some(0));

    let pid = child.id();
    let exit = std::fs::read_to_string(dir.path().join("fake-exit.json")).unwrap();
    assert!(
        exit.starts_with(&format!("{{\"pid\":{pid},\"graceful\":true,\"at\":")),
        "{exit}"
    );
    let starts = std::fs::read_to_string(dir.path().join("fake-starts.log")).unwrap();
    // the runtime that ran it is the fake itself
    assert!(
        starts.starts_with(&format!("{{\"pid\":{pid},\"runtime\":\"")) && starts.contains("fake-java"),
        "{starts}"
    );
    let stops = std::fs::read_to_string(dir.path().join("fake-stops.log")).unwrap();
    assert!(stops.starts_with(&format!("{{\"pid\":{pid},")), "{stops}");
}

#[test]
fn holds_a_stop_while_ignore_stop_exists_and_outlives_its_console() {
    let dir = TempDir::new("fake-java");
    std::fs::write(dir.path().join("ignore-stop"), "").unwrap();
    let mut child = Command::new(BIN)
        .current_dir(dir.path())
        .env_remove("FAKE_JAVA_FAIL")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "stop").unwrap();
    // the console closes: the server keeps running, the stop still held
    drop(stdin);
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        child.try_wait().unwrap().is_none(),
        "exited with ignore-stop present"
    );
    assert!(!dir.path().join("fake-exit.json").exists());
    std::fs::remove_file(dir.path().join("ignore-stop")).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < until, "the held stop was never carried out");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.code(), Some(0));
    assert!(dir.path().join("fake-exit.json").exists());
}

#[test]
fn fails_at_start_and_answers_a_version_probe() {
    let dir = TempDir::new("fake-java");
    let out = Command::new(BIN)
        .current_dir(dir.path())
        .env("FAKE_JAVA_FAIL", "start")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("Failed to start the minecraft server"));

    let out = Command::new(BIN)
        .args(["-XshowSettings:properties", "-version"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("os.arch = ") && err.contains("openjdk version \"21.0.2\""),
        "{err}"
    );
    // the failed start was logged; a probe is not a start
    let starts = std::fs::read_to_string(dir.path().join("fake-starts.log")).unwrap();
    assert_eq!(starts.lines().count(), 1, "{starts}");
}
