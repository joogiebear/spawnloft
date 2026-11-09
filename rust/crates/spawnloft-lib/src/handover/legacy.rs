//! The installed SpawnLoft 1.x: its CLI (`SpawnLoft.exe resources\core\mcctl.mjs ...` with
//! `ELECTRON_RUN_AS_NODE=1`, the form every 1.x task shim runs), its state files when the CLI
//! cannot run, and its control pipe as the last resort.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;

use super::{CLI_STOP_TIMEOUT_SECS, CliStop, Cutoff, Kind, Legacy, Listed, Log, PipeStop};
use crate::procid;

/// How long a `list`, `start` or `status` through the 1.x CLI may take.
const CLI_QUERY_TIMEOUT: Duration = Duration::from_secs(120);

/// 1.x in `dir` (the install folder).
#[derive(Debug, Clone)]
pub struct CliLegacy {
    pub dir: PathBuf,
    /// Where the CLI's output goes while it runs (files, not pipes: a daemon the CLI starts
    /// inherits its handles and would hold a pipe open for as long as it runs).
    pub scratch: PathBuf,
    /// The data root, for the state-file fallback and the pipe owner check.
    pub data_root: PathBuf,
}

/// The outcome of one CLI run.
#[derive(Debug)]
enum Ran {
    Exited(i32, String),
    TimedOut,
    NotRun(String),
}

impl CliLegacy {
    pub fn exe(&self) -> PathBuf {
        self.dir.join(if cfg!(windows) {
            "SpawnLoft.exe"
        } else {
            "spawnloft-desktop"
        })
    }
    pub fn script(&self) -> PathBuf {
        self.dir.join("resources").join("core").join("mcctl.mjs")
    }

    /// The 1.x version, from the copy of its package.json the install carries.
    pub fn version(&self) -> Option<String> {
        let text =
            std::fs::read_to_string(self.dir.join("resources").join("core").join("package.json")).ok()?;
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        v.get("version")?.as_str().map(str::to_string)
    }

    fn run(&self, args: &[&str], cut: &Cutoff, log: &Log) -> Ran {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = std::fs::create_dir_all(&self.scratch);
        let out_file = self
            .scratch
            .join(format!("handover-cli-{}-{n}.out", std::process::id()));
        let file = match std::fs::File::create(&out_file) {
            Ok(f) => f,
            Err(e) => return Ran::NotRun(format!("{}: {e}", out_file.display())),
        };
        let err = match file.try_clone() {
            Ok(f) => f,
            Err(e) => return Ran::NotRun(e.to_string()),
        };
        log.line(&format!("1.x: spawnloft {}", args.join(" ")));
        let mut cmd = Command::new(self.exe());
        cmd.arg(self.script())
            .args(args)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .stdout(file)
            .stderr(err);
        no_window(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&out_file);
                return Ran::NotRun(format!("{}: {e}", self.exe().display()));
            }
        };
        let result = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status.code().unwrap_or(1)),
                Ok(None) if cut.passed() => break None,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break Some(1),
            }
        };
        if result.is_none() {
            // the CLI client only: the daemon it talks to is another process and is not touched
            let _ = child.kill();
            let _ = child.wait();
        }
        let output = std::fs::read_to_string(&out_file).unwrap_or_default();
        let _ = std::fs::remove_file(&out_file);
        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            log.line(&format!("1.x| {line}"));
        }
        match result {
            Some(code) => Ran::Exited(code, output),
            None => Ran::TimedOut,
        }
    }
}

impl Legacy for CliLegacy {
    /// What 1.x's `readState` would say for every registered server and database, read from the
    /// data folder: no shipped 1.x has `list --json` (its CLI refuses --json for `list`), and the
    /// files are what that command would read anyway.
    fn list(&self) -> Result<Vec<Listed>, String> {
        read_state_files(&self.data_root).map_err(|e| format!("{e:?}"))
    }

    fn stop(&self, name: &str, cut: &Cutoff, log: &Log) -> CliStop {
        let timeout = CLI_STOP_TIMEOUT_SECS.to_string();
        match self.run(&["stop", name, "--timeout", &timeout], cut, log) {
            Ran::Exited(code, output) => CliStop::Exited { code, output },
            Ran::TimedOut => CliStop::DeadlinePassed,
            Ran::NotRun(e) => CliStop::NotRun(e),
        }
    }

    fn pipe_stop(&self, entry: &Listed, cut: &Cutoff, log: &Log) -> PipeStop {
        pipe_stop(entry, cut, log)
    }

    fn start(&self, name: &str, log: &Log) -> Result<(), String> {
        match self.run(
            &["start", name, "--detach"],
            &Cutoff::after(CLI_QUERY_TIMEOUT),
            log,
        ) {
            Ran::Exited(0, _) => Ok(()),
            Ran::Exited(code, out) => Err(format!(
                "exit {code}: {}",
                out.trim().lines().last().unwrap_or("")
            )),
            Ran::TimedOut => Err("did not answer in 120 s".into()),
            Ran::NotRun(e) => Err(e),
        }
    }
}

/// `list --json`'s envelope: `{ schemaVersion: 1, ok, data: { instances: [...], databases: [...] } }`.
pub fn parse_list(text: &str) -> Result<Vec<Listed>, String> {
    // the envelope is the last JSON line; a warning may come before it
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("`list --json` printed no JSON")?;
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| format!("`list --json`: {e}"))?;
    let data = v.get("data").ok_or("`list --json` has no data")?;
    let mut out = Vec::new();
    for (field, default_kind) in [("instances", Kind::Server), ("databases", Kind::Database)] {
        for row in data.get(field).and_then(Value::as_array).into_iter().flatten() {
            let Some(name) = row.get("name").and_then(Value::as_str) else {
                continue;
            };
            let kind = match row.get("kind").and_then(Value::as_str) {
                Some(k) => Kind::parse(k),
                None => default_kind,
            };
            let external = row.get("external").and_then(Value::as_bool).unwrap_or(false);
            let status = if external {
                "external".to_string()
            } else {
                row.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("stopped")
                    .to_string()
            };
            out.push(Listed {
                name: name.into(),
                kind,
                status,
                java_pid: pid(row.get("javaPid")),
                daemon_pid: pid(row.get("daemonPid")),
            });
        }
    }
    Ok(out)
}

fn pid(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|&n| n > 0)
}

/// Why the state files could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum OwnRead {
    /// The data root itself is not there (an unplugged drive, a deleted folder).
    RootMissing,
    Unreadable(String),
}

/// The fallback when the 1.x CLI cannot run: `instances.json` and every `run/<name>/state.json`,
/// reconciled the way 1.x's `readState` does (pid alive and the same process).
pub fn read_state_files(data_root: &Path) -> Result<Vec<Listed>, OwnRead> {
    if !data_root.is_dir() {
        return Err(OwnRead::RootMissing);
    }
    let reg = match std::fs::read_to_string(data_root.join("instances.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(OwnRead::Unreadable(e.to_string())),
    };
    let reg: Value = serde_json::from_str(reg.trim_start_matches('\u{feff}'))
        .map_err(|e| OwnRead::Unreadable(format!("instances.json: {e}")))?;
    let mut out = Vec::new();
    let Some(map) = reg.get("instances").and_then(Value::as_object) else {
        return Ok(out);
    };
    for (name, inst) in map {
        let kind = Kind::parse(inst.get("kind").and_then(Value::as_str).unwrap_or("server"));
        if inst.get("external").and_then(Value::as_bool) == Some(true) {
            out.push(Listed {
                name: name.clone(),
                kind,
                status: "external".into(),
                java_pid: None,
                daemon_pid: None,
            });
            continue;
        }
        let state: Option<Value> =
            std::fs::read_to_string(data_root.join("run").join(name).join("state.json"))
                .ok()
                .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok());
        let (status, java_pid, daemon_pid) = match &state {
            None => ("stopped".to_string(), None, None),
            Some(st) => {
                let d = pid(st.get("daemonPid"));
                let j = pid(st.get("javaPid"));
                let up = |p: Option<u32>, exe: &str, start: Option<u64>| {
                    p.is_some_and(|pid| {
                        procid::same_process(&procid::Recorded {
                            pid,
                            exe: st.get(exe).and_then(Value::as_str),
                            start_time: start,
                        })
                    })
                };
                let daemon_up = up(
                    d,
                    "daemonExe",
                    procid::parse_start_time(st.get("daemonStartTime")),
                );
                let java_up = up(j, "javaExe", None);
                (
                    reconcile(
                        st.get("running").and_then(Value::as_bool).unwrap_or(false),
                        daemon_up,
                        java_up,
                    )
                    .to_string(),
                    j,
                    d,
                )
            }
        };
        out.push(Listed {
            name: name.clone(),
            kind,
            status,
            java_pid,
            daemon_pid,
        });
    }
    Ok(out)
}

/// 1.x `readState`'s table.
pub fn reconcile(running: bool, daemon_up: bool, java_up: bool) -> &'static str {
    match (running, daemon_up, java_up) {
        (true, true, true) => "running",
        (true, false, true) => "orphaned",
        (true, true, false) => "stopping",
        (true, false, false) => "stale",
        _ => "stopped",
    }
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// The 1.x `stop` op on `\\.\pipe\mcctl-<name>`, with the same enormous timeout the CLI gets,
/// after checking that the pipe's server is the daemon the state file names: the 1.x pipe name
/// is machine-global and another user's server of the same name could be listening.
#[cfg(windows)]
fn pipe_stop(entry: &Listed, cut: &Cutoff, log: &Log) -> PipeStop {
    use std::io::{BufRead, Write};
    let Some(daemon) = entry.daemon_pid else {
        return PipeStop::Failed("no daemon pid recorded".into());
    };
    let Some(java) = entry.java_pid else {
        return PipeStop::Failed("no java pid recorded".into());
    };
    let path = format!(r"\\.\pipe\mcctl-{}", entry.name);
    let mut pipe = None;
    for _ in 0..20 {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(f) => {
                pipe = Some(f);
                break;
            }
            // ERROR_PIPE_BUSY: every instance is serving someone; try again shortly
            Err(e) if e.raw_os_error() == Some(231) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return PipeStop::Failed(format!("{path}: {e}")),
        }
    }
    let Some(mut pipe) = pipe else {
        return PipeStop::Failed(format!("{path} stayed busy"));
    };
    match crate::platform::pipe_server_pid(&pipe) {
        Some(owner) if owner == daemon => {}
        Some(owner) => {
            return PipeStop::Failed(format!(
                "{path} belongs to process {owner}, not to the daemon {daemon} the state file names"
            ));
        }
        None => return PipeStop::Failed(format!("{path}: the server process is unknown")),
    }
    let req = format!(
        "{{\"op\":\"stop\",\"timeout\":{}}}\n",
        CLI_STOP_TIMEOUT_SECS * 1000
    );
    if let Err(e) = pipe.write_all(req.as_bytes()) {
        return PipeStop::Failed(format!("{path}: {e}"));
    }
    log.line(&format!("{}: stop sent over {path}", entry.name));
    // the reply comes when the server has exited; read it on the side, decide by the JVM
    if let Ok(reader) = pipe.try_clone() {
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::BufReader::new(reader).read_line(&mut line);
        });
    }
    while !cut.passed() {
        if !procid::alive(java) {
            return PipeStop::Stopped;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    PipeStop::DeadlinePassed
}

#[cfg(not(windows))]
fn pipe_stop(_entry: &Listed, _cut: &Cutoff, _log: &Log) -> PipeStop {
    PipeStop::Failed("the 1.x control pipe exists on Windows only".into())
}

/// For an unreadable data root: is any 1.x Node daemon (SpawnLoft.exe running daemon.mjs) alive?
/// `None` when that cannot be told.
pub fn legacy_daemons_running() -> Option<bool> {
    if !cfg!(windows) {
        return Some(false);
    }
    let out = super::tasks::powershell(
        "@(Get-CimInstance Win32_Process -Filter \"Name='SpawnLoft.exe'\" | \
         Where-Object { $_.CommandLine -match 'daemon\\.mjs' }).Count",
    )
    .ok()?;
    out.trim().parse::<u32>().ok().map(|n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_envelope() {
        let text = concat!(
            "warning: something\n",
            r#"{"schemaVersion":1,"command":"list","ok":true,"data":{"instances":[{"name":"survival","kind":"server","status":"running","javaPid":10,"daemonPid":11},{"name":"old","status":"stopped","javaPid":null,"daemonPid":null}],"databases":[{"name":"db","kind":"database","status":"running","javaPid":20,"daemonPid":21},{"name":"far","kind":"database","status":"external","external":true}]}}"#,
            "\n"
        );
        let l = parse_list(text).unwrap();
        assert_eq!(l.len(), 4);
        assert_eq!(l[0].name, "survival");
        assert_eq!(l[0].daemon_pid, Some(11));
        assert!(l[0].stoppable());
        assert_eq!(l[1].java_pid, None);
        assert!(!l[1].active());
        assert_eq!(l[2].kind, Kind::Database);
        assert_eq!(l[3].status, "external");
        assert!(!l[3].active());
        assert!(parse_list("nothing").is_err());
    }

    #[test]
    fn state_table() {
        assert_eq!(reconcile(true, true, true), "running");
        assert_eq!(reconcile(true, false, true), "orphaned");
        assert_eq!(reconcile(true, true, false), "stopping");
        assert_eq!(reconcile(true, false, false), "stale");
        assert_eq!(reconcile(false, true, true), "stopped");
    }

    #[test]
    fn state_files() {
        let dir = std::env::temp_dir().join(format!("sl-legacy-{}", std::process::id()));
        assert_eq!(read_state_files(&dir.join("nope")), Err(OwnRead::RootMissing));
        std::fs::create_dir_all(dir.join("run").join("live")).unwrap();
        std::fs::write(
            dir.join("instances.json"),
            "\u{feff}{\"instances\":{\"live\":{\"dir\":\"x\"},\"db\":{\"kind\":\"database\"},\"far\":{\"kind\":\"database\",\"external\":true}}}",
        )
        .unwrap();
        let me = std::process::id();
        std::fs::write(
            dir.join("run").join("live").join("state.json"),
            format!("{{\"running\":true,\"daemonPid\":{me},\"javaPid\":{me}}}"),
        )
        .unwrap();
        let l = read_state_files(&dir).unwrap();
        let get = |n: &str| l.iter().find(|x| x.name == n).unwrap().clone();
        assert_eq!(get("live").status, "running");
        assert_eq!(get("db").status, "stopped");
        assert_eq!(get("db").kind, Kind::Database);
        assert_eq!(get("far").status, "external");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
