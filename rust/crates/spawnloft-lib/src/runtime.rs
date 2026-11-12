//! The Node.js runtime the 2.0 package carries until the core port (2.1) removes it, and the one
//! way into the Node core: `spawnloft-core <command>` forwards every command it does not own here
//! (PLAN-2.0-REMAINING.md section 4, items 1 and 2).
//!
//! Layout, relative to the resources folder (`resources\` on Windows and Linux,
//! `Contents/Resources/resources/` in a macOS `.app`), the same on every platform:
//!
//! ```text
//! resources/bin/spawnloft-core[.exe]
//! resources/core/spawnloft.mjs, src/ ...          the Node core
//! resources/runtime/runtime.json                  {"node":"<ver>","exe":"node-<ver>/bin/node"}
//! resources/runtime/node-<ver>/bin/node           (Windows: node-<ver>/node.exe)
//! ```
//!
//! The folder is versioned so a 2.x update that moves Node writes a new folder instead of
//! overwriting a `node.exe` a long-lived process (`spawnloft mcp`, the bot host, a console) still
//! runs; the installer removes old folders once nothing holds them (A6).
//!
//! Which Node runs: the bundled one whenever there is a `resources/runtime` folder, whatever the
//! environment says (an installed copy runs only what was tested; a stray `SPAWNLOFT_NODE` or
//! system Node is never picked up). Only without that folder (a `cargo build` run from the
//! repository, the 1.x Electron internal builds) `SPAWNLOFT_NODE`, then the first `node` on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What forwarding sets for the Node core: the absolute path of the `spawnloft-core` that ran
/// it. The Node core writes this path, never a Node path, into task shims, server launchers, the
/// launchd and systemd units, `runtime.json` and the MCP config (A5), so everything a user copies
/// keeps working when 2.1 removes Node.
pub const ENTRY_ENV: &str = "SPAWNLOFT_ENTRY";

/// The resources folder this binary sits in (`resources/bin/<exe>` -> `resources`).
pub fn resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.parent()?.to_path_buf())
}

/// `resources/runtime` beside this binary's folder.
pub fn runtime_dir() -> Option<PathBuf> {
    Some(resources_dir()?.join("runtime"))
}

/// Where the bundled Node is, read from `<runtime>/runtime.json`; `Err` says why there is none.
pub fn bundled_node(runtime: &Path) -> Result<PathBuf, String> {
    let record = runtime.join("runtime.json");
    let text = std::fs::read_to_string(&record).map_err(|e| format!("{}: {e}", record.display()))?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{}: {e}", record.display()))?;
    let exe = v
        .get("exe")
        .and_then(|e| e.as_str())
        .ok_or_else(|| format!("{} names no exe", record.display()))?;
    // a relative path inside the runtime folder, nothing else
    let rel = Path::new(exe);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "{}: `{exe}` is not a path inside the runtime folder",
            record.display()
        ));
    }
    let path = runtime.join(rel);
    if !path.is_file() {
        return Err(format!("{} is missing", path.display()));
    }
    Ok(path)
}

/// The Node the core runs on (see the module text for the order), or why there is none.
pub fn node() -> Result<PathBuf, String> {
    node_with(
        std::env::var_os("SPAWNLOFT_NODE")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
        runtime_dir(),
    )
}

/// [`node`] with its inputs given, for tests.
pub fn node_with(env: Option<PathBuf>, runtime: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(runtime) = runtime
        && runtime.exists()
    {
        return bundled_node(&runtime)
            .map_err(|e| format!("the bundled Node.js is damaged ({e}); reinstall SpawnLoft"));
    }
    if let Some(p) = env {
        return Ok(p);
    }
    crate::panel::path_node().ok_or_else(|| {
        "Node.js was not found: this is a development build with no bundled runtime \
         (install Node 20 or later, or set SPAWNLOFT_NODE)"
            .to_string()
    })
}

/// The Node core's folder: `resources/core` beside this binary's folder; `SPAWNLOFT_CORE_DIR`
/// only counts without a bundled runtime (a development build), as `SPAWNLOFT_NODE` does.
pub fn core_dir() -> Option<PathBuf> {
    let installed = runtime_dir().is_some_and(|r| r.exists());
    if !installed && let Some(p) = std::env::var_os("SPAWNLOFT_CORE_DIR").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    Some(resources_dir()?.join("core"))
}

/// Sets what every Node core started by this binary needs: who to name as the entry point, no
/// Electron switch left over from a 1.x environment, and none of the machine's own Node settings
/// (`NODE_OPTIONS` could `--require` foreign code or open an inspector port in every SpawnLoft
/// process; `NODE_PATH` changes what resolves).
pub fn prepare(cmd: &mut Command) {
    match std::env::current_exe() {
        Ok(exe) => cmd.env(ENTRY_ENV, exe),
        // never pass on an entry inherited from someone else
        Err(_) => cmd.env_remove(ENTRY_ENV),
    };
    for var in ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"] {
        cmd.env_remove(var);
    }
}

/// `spawnloft-core <command...>` for a command the Rust core does not own (the CLI, `mcp`,
/// `task run`, `console`): the Node core runs it with this process's stdin, stdout and stderr,
/// and its exit code becomes ours. On Unix this process becomes Node (exec), so signals and the
/// terminal go straight to it. On Windows the child is held in a kill-on-close job object, so a
/// killed forwarder (an MCP client ending `spawnloft mcp`) never leaves Node behind; Ctrl+C is
/// left to Node, which gets it from the shared console.
pub fn forward(args: &[std::ffi::OsString]) -> u8 {
    let node = match node() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("{}: {e}", crate::build::NAME);
            return 127;
        }
    };
    let Some(dir) = core_dir() else {
        eprintln!(
            "{}: the Node core folder could not be worked out",
            crate::build::NAME
        );
        return 1;
    };
    let entry = dir.join("spawnloft.mjs");
    if !entry.is_file() {
        eprintln!(
            "{}: {} is missing; reinstall SpawnLoft",
            crate::build::NAME,
            entry.display()
        );
        return 1;
    }
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    prepare(&mut cmd);
    run_forwarded(cmd, &node)
}

#[cfg(unix)]
fn run_forwarded(mut cmd: Command, node: &Path) -> u8 {
    use std::os::unix::process::CommandExt;
    // only returns when the exec failed
    let e = cmd.exec();
    eprintln!("{}: could not run {}: {e}", crate::build::NAME, node.display());
    126
}

#[cfg(windows)]
fn run_forwarded(cmd: Command, node: &Path) -> u8 {
    crate::platform::ignore_ctrl_c();
    match crate::platform::run_in_kill_job(cmd) {
        Ok(code) => u8::try_from(code).unwrap_or(1),
        Err(e) => {
            eprintln!("{}: could not run {}: {e}", crate::build::NAME, node.display());
            126
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("spawnloft-runtime-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn env_counts_only_without_a_runtime_folder() {
        let rt = temp("env");
        let missing = rt.join("no-runtime-here");
        let got = node_with(Some("/x/node".into()), Some(missing)).unwrap();
        assert_eq!(got, PathBuf::from("/x/node"));
        // an installed copy ignores it: a damaged runtime is reported, not replaced
        let e = node_with(Some("/x/node".into()), Some(rt.clone())).unwrap_err();
        assert!(e.contains("damaged"), "{e}");
        let _ = std::fs::remove_dir_all(rt);
    }

    #[test]
    fn bundled_from_the_record() {
        let rt = temp("bundled");
        std::fs::create_dir_all(rt.join("node-24.21.0/bin")).unwrap();
        std::fs::write(rt.join("node-24.21.0/bin/node"), b"").unwrap();
        std::fs::write(
            rt.join("runtime.json"),
            "\u{feff}{\"node\":\"24.21.0\",\"exe\":\"node-24.21.0/bin/node\"}",
        )
        .unwrap();
        assert_eq!(
            node_with(None, Some(rt.clone())).unwrap(),
            rt.join("node-24.21.0/bin/node")
        );
        let _ = std::fs::remove_dir_all(rt);
    }

    #[test]
    fn a_runtime_folder_never_falls_back_to_path() {
        let rt = temp("broken");
        // no record
        let e = node_with(None, Some(rt.clone())).unwrap_err();
        assert!(e.contains("damaged"), "{e}");
        // a record naming a missing file
        std::fs::write(rt.join("runtime.json"), "{\"exe\":\"node-1/bin/node\"}").unwrap();
        assert!(node_with(None, Some(rt.clone())).unwrap_err().contains("missing"));
        let _ = std::fs::remove_dir_all(rt);
    }

    #[test]
    fn the_record_cannot_point_outside_the_folder() {
        let rt = temp("escape");
        for exe in ["../node", "/usr/bin/node", "node-1/../../node", "C:\\\\node.exe"] {
            std::fs::write(rt.join("runtime.json"), format!("{{\"exe\":\"{exe}\"}}")).unwrap();
            let e = bundled_node(&rt).unwrap_err();
            assert!(
                e.contains("not a path inside") || e.contains("missing"),
                "{exe}: {e}"
            );
        }
        let _ = std::fs::remove_dir_all(rt);
    }
}
