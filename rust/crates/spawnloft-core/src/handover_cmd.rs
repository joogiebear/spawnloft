//! `handover stop|resume`, `repair` and `uninstall`: the commands the 2.0 installer and
//! uninstaller run (rust/INSTALLER-UPDATER-DESIGN.md sections 2.3 to 2.5 and 9).

use std::path::{Path, PathBuf};
use std::time::Duration;

use spawnloft_lib::handover::legacy::{self, CliLegacy, OwnRead};
use spawnloft_lib::handover::resume::{self, ResumeOptions, Starter};
use spawnloft_lib::handover::tasks::WindowsTasks;
use spawnloft_lib::handover::{self as h, Files, Kind, Log, Marker, Record};
use spawnloft_lib::nodecore::NodeCore;
use spawnloft_lib::serde_json::json;
use spawnloft_lib::{build, paths, procid, time};

use crate::cli::{Outcome, usage_error};

/// A resume lock older than this belongs to a resume that died.
const STALE_LOCK: Duration = Duration::from_secs(30 * 60);

/// How long the installer's resume waits for another resume to finish.
const RESUME_WAIT: Duration = Duration::from_secs(20 * 60);

fn flags(
    rest: &[String],
    with_value: &[&str],
    switches: &[&str],
) -> Result<Vec<(String, Option<String>)>, Outcome> {
    let mut out = Vec::new();
    let mut it = rest.iter();
    while let Some(f) = it.next() {
        if with_value.contains(&f.as_str()) {
            let v = it
                .next()
                .ok_or_else(|| usage_error(&format!("{f} needs a value")))?;
            out.push((f.clone(), Some(v.clone())));
        } else if switches.contains(&f.as_str()) {
            out.push((f.clone(), None));
        } else {
            return Err(usage_error(&format!("unexpected argument `{f}`")));
        }
    }
    Ok(out)
}

fn get<'a>(f: &'a [(String, Option<String>)], name: &str) -> Option<&'a str> {
    f.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.as_deref())
}

fn has(f: &[(String, Option<String>)], name: &str) -> bool {
    f.iter().any(|(k, _)| k == name)
}

fn done(code: u8, summary: spawnloft_lib::serde_json::Value) -> Outcome {
    Outcome {
        stdout: format!("{summary}\n"),
        stderr: String::new(),
        code,
    }
}

pub fn handover(rest: &[String]) -> Outcome {
    match rest.split_first() {
        Some((sub, rest)) if sub == "stop" => stop(rest),
        Some((sub, rest)) if sub == "resume" => resume_cmd(rest),
        Some((sub, rest)) if sub == "restore" => restore_cmd(rest),
        Some((sub, rest)) if sub == "cleanup" => cleanup_cmd(rest),
        _ => usage_error(
            "usage: handover stop --legacy-dir <dir> [...] | handover resume [--pending] [--skip-start] | handover restore --legacy-dir <dir> | handover cleanup",
        ),
    }
}

/// `handover stop --legacy-dir <dir> [--legacy-version <v>] [--deadline <s>] [--log <file>]
/// [--silent] [--status-dir <dir>]`. With `--status-dir` (the installer's stopping page) the
/// last lines go to `handover-progress.txt`, a `handover-cancel` file there cancels, and the exit
/// code and the blocking servers are written to `handover-exit.txt` at the end.
fn stop(rest: &[String]) -> Outcome {
    let f = match flags(
        rest,
        &[
            "--legacy-dir",
            "--legacy-version",
            "--deadline",
            "--log",
            "--status-dir",
        ],
        &["--silent"],
    ) {
        Ok(f) => f,
        Err(o) => return o,
    };
    let status_dir = get(&f, "--status-dir").map(PathBuf::from);
    let out = stop_with(&f, status_dir.as_deref());
    if let Some(dir) = &status_dir {
        let blocked = spawnloft_lib::serde_json::from_str::<spawnloft_lib::serde_json::Value>(&out.stdout)
            .ok()
            .and_then(|v| {
                v.get("blockedBy")?
                    .as_array()
                    .map(|a| a.iter().filter_map(|n| n.as_str()).collect::<Vec<_>>().join(", "))
            })
            .unwrap_or_default();
        // written aside and renamed, so the page never reads a half-written file
        let tmp = dir.join("handover-exit.tmp");
        if std::fs::write(&tmp, format!("{}\r\n{blocked}\r\n", out.code)).is_ok() {
            let _ = spawnloft_lib::fsx::rename_over(&tmp, &dir.join("handover-exit.txt"));
        }
    }
    out
}

fn stop_with(f: &[(String, Option<String>)], status_dir: Option<&Path>) -> Outcome {
    let Some(dir) = get(f, "--legacy-dir") else {
        return usage_error("handover stop needs --legacy-dir <the 1.x install folder>");
    };
    let deadline = match get(f, "--deadline").map(str::parse::<u64>) {
        None => h::DEFAULT_DEADLINE,
        Some(Ok(s)) if s > 0 => Duration::from_secs(s),
        Some(_) => return usage_error("--deadline takes a whole number of seconds"),
    };
    let silent = has(f, "--silent");
    let data_root = paths::resolve_data_root();
    let files = Files::new(&data_root);
    let log_path = get(f, "--log").map(PathBuf::from).unwrap_or_else(|| files.log());
    let mut log = Log::open(Some(&log_path), true);
    if let Some(dir) = status_dir {
        log = log.with_progress(dir.join("handover-progress.txt"));
    }
    let legacy = CliLegacy {
        dir: PathBuf::from(dir),
        scratch: std::env::temp_dir(),
        data_root: data_root.clone(),
    };
    let version = get(f, "--legacy-version")
        .map(str::to_string)
        .filter(|v| !v.is_empty())
        .or_else(|| legacy.version())
        .unwrap_or_else(|| "1.x".into());
    let opts = h::StopOptions {
        legacy_version: version,
        to_version: build::current().version.to_string(),
        deadline,
        silent,
        cancel_file: status_dir.map(|d| d.join("handover-cancel")),
        restore_wait: h::RESTORE_WAIT,
    };
    log.line(&format!(
        "handover stop: 1.x {} in {dir}, data root {}, deadline {} s, {}",
        opts.legacy_version,
        data_root.display(),
        deadline.as_secs(),
        if silent { "silent" } else { "interactive" }
    ));

    // 1.x's own view, from the files its `readState` reads (no shipped 1.x lists as JSON)
    let listed = match legacy::read_state_files(&data_root) {
        Ok(l) => l,
        Err(why) => return unreadable_root(&data_root, why, &log),
    };

    // No Node check here (PLAN-2.0-REMAINING.md A8): this runs from staging\ before the payload
    // is extracted, and the payload carries the Node that starts the servers again.

    let previous = Marker::read(&files.marker());
    let out = h::run_stop(
        &opts,
        listed,
        &legacy,
        &WindowsTasks,
        previous,
        &data_root.to_string_lossy(),
        &log,
    );
    let early = out.code == h::EXIT_BLOCKED && out.record.servers.is_empty();
    if !early && let Err(e) = out.record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    match &out.marker {
        Some(m) => {
            if let Err(e) = m.write(&files.marker()) {
                log.line(&format!("could not write {}: {e}", files.marker().display()));
            }
        }
        None => {
            let _ = std::fs::remove_file(files.marker());
        }
    }
    log.line(&format!("handover stop exits {}", out.code));
    done(
        out.code,
        json!({ "exit": out.code, "record": files.record(), "blockedBy": out.marker.map(|m| m.blocked_by) }),
    )
}

/// The data root cannot be read (an unplugged drive): no 1.x daemon can be running from it, which
/// one read-only process query confirms (design 2.3.1 step 1).
fn unreadable_root(data_root: &Path, why: OwnRead, log: &Log) -> Outcome {
    log.line(&format!(
        "data root {} cannot be read: {why:?}",
        data_root.display()
    ));
    match legacy::legacy_daemons_running() {
        Some(false) => {
            log.line("no 1.x daemon is running; nothing to stop");
            done(h::EXIT_OK, json!({ "exit": 0, "dataRoot": "unreadable" }))
        }
        Some(true) => {
            log.line("1.x daemons are running but their data root cannot be read: not updating");
            done(h::EXIT_INTERNAL, json!({ "exit": 2, "dataRoot": "unreadable" }))
        }
        None => {
            log.line("could not tell whether 1.x daemons are running: not updating");
            done(h::EXIT_INTERNAL, json!({ "exit": 2, "dataRoot": "unreadable" }))
        }
    }
}

/// Starts nothing and says why, when the 2.0 core cannot be reached.
struct Unavailable(String);
impl Starter for Unavailable {
    fn start(&self, _name: &str, _kind: Kind, _log: &Log) -> Result<(), String> {
        Err(self.0.clone())
    }
    fn registered(&self) -> Option<std::collections::BTreeSet<String>> {
        None
    }
}

/// A lock file, removed on drop.
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn take_lock(file: &Path) -> Option<Lock> {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    for _ in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(file)
        {
            Ok(mut f) => {
                use std::io::Write;
                // the owner by (pid, creation time): a lock is stale when its owner is gone,
                // however long a resume of many servers takes
                let _ = write!(
                    f,
                    "{} {} {}",
                    std::process::id(),
                    procid::own_start_time()
                        .map(|t| t.to_string())
                        .unwrap_or_default(),
                    time::iso_now()
                );
                return Some(Lock(file.to_path_buf()));
            }
            Err(_) => {
                let text = std::fs::read_to_string(file).unwrap_or_default();
                let mut parts = text.split_whitespace();
                let owner = parts.next().and_then(|p| p.parse::<u32>().ok());
                let start = parts.next().and_then(|t| t.parse::<u64>().ok());
                let stale = match owner {
                    Some(pid) => !procid::same_process(&procid::Recorded {
                        pid,
                        exe: None,
                        start_time: start,
                    }),
                    // unreadable or half-written: by age
                    None => std::fs::metadata(file)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK),
                };
                if !stale {
                    return None;
                }
                let _ = std::fs::remove_file(file);
            }
        }
    }
    None
}

/// `handover resume [--pending] [--skip-start] [--log <file>]`
fn resume_cmd(rest: &[String]) -> Outcome {
    let f = match flags(rest, &["--log"], &["--pending", "--skip-start"]) {
        Ok(f) => f,
        Err(o) => return o,
    };
    let opts = ResumeOptions {
        pending_only: has(&f, "--pending"),
        skip_start: has(&f, "--skip-start"),
    };
    let data_root = paths::resolve_data_root();
    let files = Files::new(&data_root);
    let log_path = get(&f, "--log").map(PathBuf::from).unwrap_or_else(|| files.log());
    let log = Log::open(Some(&log_path), !opts.pending_only);
    let Some(mut record) = Record::read(&files.record()) else {
        return done(0, json!({ "exit": 0, "record": null }));
    };
    if resume::candidates(&record, opts, time::now_ms()).is_empty() && record.tasks_reenabled {
        return done(0, json!({ "exit": 0, "started": 0 }));
    }
    // The installer's resume waits for one already running (the relaunched app's pending
    // resume, say), so the install ends with the servers back; the shell's own never waits.
    let mut lock = take_lock(&files.lock());
    if lock.is_none() && !opts.pending_only {
        log.line("another handover resume is running; waiting for it");
        let until = std::time::Instant::now() + RESUME_WAIT;
        while lock.is_none() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(500));
            lock = take_lock(&files.lock());
        }
    }
    let Some(_lock) = lock else {
        log.line("another handover resume is running; leaving it to that one");
        return done(0, json!({ "exit": 0, "busy": true }));
    };
    // read again under the lock: the other resume may have finished meanwhile
    let Some(fresh) = Record::read(&files.record()) else {
        return done(0, json!({ "exit": 0, "record": null }));
    };
    record = fresh;
    let core = NodeCore::find(&data_root);
    let unavailable;
    let starter: &dyn Starter = match &core {
        Ok(c) => c,
        Err(e) => {
            log.line(&format!("the 2.0 core cannot start servers: {e}"));
            unavailable = Unavailable(e.clone());
            &unavailable
        }
    };
    resume::run_resume(&mut record, opts, starter, &WindowsTasks, &log);
    if let Err(e) = record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    let failed: Vec<&str> = record
        .servers
        .iter()
        .filter(|e| e.start.as_deref() == Some("failed"))
        .map(|e| e.name.as_str())
        .collect();
    log.line(&format!(
        "handover resume done{}",
        if failed.is_empty() {
            String::new()
        } else {
            format!("; did not start: {}", failed.join(", "))
        }
    ));
    done(0, json!({ "exit": 0, "failed": failed }))
}

/// `handover restore --legacy-dir <dir>`: the installer failed after a successful stop (the 1.x
/// uninstaller failed, the person cancelled on a later page): what the stop stopped is started
/// again under the 1.x that is still installed, and the tasks are enabled again.
fn restore_cmd(rest: &[String]) -> Outcome {
    let f = match flags(rest, &["--legacy-dir", "--log"], &[]) {
        Ok(f) => f,
        Err(o) => return o,
    };
    let Some(dir) = get(&f, "--legacy-dir") else {
        return usage_error("handover restore needs --legacy-dir <the 1.x install folder>");
    };
    let data_root = paths::resolve_data_root();
    let files = Files::new(&data_root);
    let log_path = get(&f, "--log").map(PathBuf::from).unwrap_or_else(|| files.log());
    let log = Log::open(Some(&log_path), true);
    let Some(mut record) = Record::read(&files.record()) else {
        return done(0, json!({ "exit": 0, "record": null }));
    };
    let legacy = CliLegacy {
        dir: PathBuf::from(dir),
        scratch: std::env::temp_dir(),
        data_root: data_root.clone(),
    };
    log.line("handover restore: the update did not complete; starting the stopped servers again under 1.x");
    h::restore(&mut record, &legacy, &WindowsTasks, &log);
    if let Err(e) = record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    done(0, json!({ "exit": 0 }))
}

/// `handover cleanup`: Electron's Chromium profile and electron-updater's cache removed from
/// `<config>` by allowlist, once (design section 7). Windows only; elsewhere 1.x's profile is
/// in its own folder and stays. The shell runs it at launch.
fn cleanup_cmd(rest: &[String]) -> Outcome {
    if let Err(o) = flags(rest, &[], &[]) {
        return o;
    }
    if !cfg!(windows) {
        return done(0, json!({ "skipped": true, "reason": "not windows" }));
    }
    let r = h::cleanup::run(
        &paths::config_dir(),
        &paths::local_base().join("spawnloft-desktop-updater"),
        time::now_ms(),
    );
    done(
        0,
        json!({ "skipped": r.skipped, "removed": r.removed, "failed": r.failed }),
    )
}

/// `repair [--quiet]`: task shims and server launchers rewritten for this install (the Node
/// core's `repair` until R4; design 2.3 step 8). `--quiet` logs to `run/handover.log` only.
pub fn repair(rest: &[String]) -> Outcome {
    let f = match flags(rest, &[], &["--quiet"]) {
        Ok(f) => f,
        Err(o) => return o,
    };
    let data_root = paths::resolve_data_root();
    let core = match NodeCore::find(&data_root) {
        Ok(c) => c,
        Err(e) => {
            return Outcome {
                stdout: String::new(),
                stderr: format!("{}: repair: {e}\n", build::NAME),
                code: 1,
            };
        }
    };
    if has(&f, "--quiet") {
        let log = Log::open(Some(&Files::new(&data_root).log()), false);
        let code = match core.run_logged(&["repair", "--json"], Duration::from_secs(120), &log) {
            Ok((c, _)) => c,
            Err(e) => {
                log.line(&format!("repair: {e}"));
                1
            }
        };
        return Outcome {
            code: u8::try_from(code).unwrap_or(1),
            ..Outcome::default()
        };
    }
    exit_of(core.run_inherit(&["repair"]))
}

/// `uninstall --yes [--data]`: what the uninstaller runs (design section 9). Through the Node
/// core until R4; when that cannot run, the scheduled tasks are at least removed here (P0-F H3).
pub fn uninstall(rest: &[String]) -> Outcome {
    let args: Vec<&str> = std::iter::once("uninstall")
        .chain(rest.iter().map(String::as_str))
        .collect();
    let data_root = paths::resolve_data_root();
    match NodeCore::find(&data_root) {
        Ok(core) => exit_of(core.run_inherit(&args)),
        Err(e) => {
            let removed = remove_tasks();
            Outcome {
                stdout: String::new(),
                stderr: format!(
                    "{}: uninstall: {e}; removed {removed} scheduled task(s); servers were not stopped\n",
                    build::NAME
                ),
                code: 1,
            }
        }
    }
}

fn remove_tasks() -> usize {
    use spawnloft_lib::handover::Tasks;
    let names = match WindowsTasks.enabled() {
        Ok(n) => n,
        Err(_) => return 0,
    };
    let mut n = 0;
    for t in names {
        let ok = std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", &format!("\\mcctl\\{t}"), "/F"])
            .output()
            .is_ok_and(|o| o.status.success());
        n += usize::from(ok);
    }
    n
}

fn exit_of(r: Result<i32, String>) -> Outcome {
    match r {
        Ok(c) => Outcome {
            code: u8::try_from(c).unwrap_or(1),
            ..Outcome::default()
        },
        Err(e) => Outcome {
            stdout: String::new(),
            stderr: format!("{}: {e}\n", build::NAME),
            code: 1,
        },
    }
}
