//! `SpawnLoft <command...>` typed in a terminal is handed to the core and returns with its answer;
//! before, the window ignored the command line, opened, and held the terminal until it was closed
//! (`SpawnLoft.exe update --help`, found in the 2.0.0-beta.1 checks).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SHELL: &str = env!("CARGO_BIN_EXE_SpawnLoft");

/// The core cargo built beside the window (`cargo test --workspace` builds both).
fn core() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "spawnloft-core.exe"
    } else {
        "spawnloft-core"
    };
    let p = PathBuf::from(SHELL).parent()?.join(name);
    p.is_file().then_some(p)
}

/// Runs the window binary with `args`; panics if it has not exited within 60 seconds (it would
/// have opened a window).
fn run(core: &std::path::Path, args: &[&str]) -> (i32, String, String) {
    let data = std::env::temp_dir().join(format!("sl-shell-forward-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let out_path = data.join("out.txt");
    let err_path = data.join("err.txt");
    let mut child = Command::new(SHELL)
        .args(args)
        .env("SPAWNLOFT_CORE_BIN", core)
        .env("SPAWNLOFT_DATA_ROOT", &data)
        .stdin(Stdio::null())
        .stdout(std::fs::File::create(&out_path).unwrap())
        .stderr(std::fs::File::create(&err_path).unwrap())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if started.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("`SpawnLoft {}` did not return within 60 seconds", args.join(" "));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let out = std::fs::read_to_string(&out_path).unwrap();
    let err = std::fs::read_to_string(&err_path).unwrap();
    (status.code().unwrap_or(-1), out, err)
}

#[test]
fn a_command_line_is_the_cores_not_a_window() {
    let Some(core) = core() else {
        eprintln!("skipped: spawnloft-core is not built beside {SHELL} (run cargo test --workspace)");
        return;
    };
    let (code, out, err) = run(&core, &["update", "--help"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("update check [--json]"), "{out}");

    let (code, out, err) = run(&core, &["--help"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("spawnloft list"), "{out}");

    // a command's --help answers without running it (`ui` would serve the panel and not return)
    let (code, out, err) = run(&core, &["ui", "--help"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("spawnloft ui"), "{out}");

    let (code, out, _) = run(&core, &["--version"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("spawnloft-core "), "{out}");
}

#[test]
fn a_missing_core_fails_the_command_rather_than_opening_a_window() {
    let missing = std::env::temp_dir().join("sl-shell-forward-no-such-core");
    let (code, _, _) = run(&missing, &["update", "--help"]);
    assert_eq!(code, 1);
}
