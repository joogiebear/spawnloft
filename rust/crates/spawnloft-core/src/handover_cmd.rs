//! `handover stop|resume`, `repair` and `uninstall`: the commands the 2.0 installer and
//! uninstaller run (rust/INSTALLER-UPDATER-DESIGN.md sections 2.3 to 2.5 and 9).

use std::path::{Path, PathBuf};
use std::time::Duration;

use spawnloft_lib::handover::legacy::{self, CliLegacy, OwnRead};
use spawnloft_lib::handover::resume::{self, ResumeOptions, Starter};
use spawnloft_lib::handover::tasks::WindowsTasks;
use spawnloft_lib::handover::{self as h, Ctx, Files, Journal, Kind, Log, Marker, Record, Watch};
use spawnloft_lib::nodecore::NodeCore;
use spawnloft_lib::serde_json::json;
use spawnloft_lib::{build, paths, platform, procid, time};

use crate::cli::{Outcome, usage_error};

/// A resume lock older than this belongs to a resume that died.
const STALE_LOCK: Duration = Duration::from_secs(30 * 60);

/// How long the installer's resume waits for another resume to finish.
const RESUME_WAIT: Duration = Duration::from_secs(20 * 60);

/// How long a stop or a restore waits for another handover step (a restore at sign-in, say).
const STEP_WAIT: Duration = Duration::from_secs(60);

/// The value under `HKCU\...\RunOnce` that puts an unfinished handover back at the next sign-in.
const SIGN_IN_NAME: &str = "SpawnLoftHandover";

/// The record on disk while a handover step runs. The first save of a stop also arms the
/// sign-in command (`sign_in_for`): from then on something outside is about to change, and if
/// this process and the installer both end without warning (a shutdown on the install-on-quit
/// path, power loss), the next sign-in puts it back.
struct FileJournal<'a> {
    file: PathBuf,
    log: &'a Log,
    sign_in_for: Option<&'a Path>,
    armed: std::cell::Cell<bool>,
}

impl<'a> FileJournal<'a> {
    fn new(file: PathBuf, log: &'a Log) -> FileJournal<'a> {
        FileJournal {
            file,
            log,
            sign_in_for: None,
            armed: std::cell::Cell::new(false),
        }
    }
}

impl Journal for FileJournal<'_> {
    fn save(&self, record: &Record) {
        if let Err(e) = record.write(&self.file) {
            self.log
                .line(&format!("could not write {}: {e}", self.file.display()));
        }
        if let Some(dir) = self.sign_in_for
            && !self.armed.replace(true)
        {
            arm_sign_in(dir, self.log);
        }
    }
}

/// `"<this exe>" handover restore --legacy-dir "<dir>" --logon`, to run once at the next sign-in.
/// Where that is too long for RunOnce (a long profile name, a custom folder) the folder is left
/// out: the record names it too.
fn sign_in_command(exe: &Path, legacy_dir: &Path) -> String {
    let dir = legacy_dir.to_string_lossy();
    // no trailing backslash before the closing quote: `\"` would escape it
    let dir = dir.trim_end_matches(['\\', '/']);
    let full = format!(
        "\"{}\" handover restore --legacy-dir \"{dir}\" --logon",
        exe.display()
    );
    if full.encode_utf16().count() <= platform::RUN_ONCE_MAX {
        return full;
    }
    format!("\"{}\" handover restore --logon", exe.display())
}

fn arm_sign_in(legacy_dir: &Path, log: &Log) {
    if !cfg!(windows) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    match platform::run_once_set(SIGN_IN_NAME, &sign_in_command(&exe, legacy_dir)) {
        Ok(()) => log.line("if this update is cut short, the next sign-in puts back what it stopped"),
        Err(e) => log.line(&format!("could not register the sign-in restore: {e}")),
    }
}

fn disarm_sign_in(log: &Log) {
    if !cfg!(windows) {
        return;
    }
    if let Err(e) = platform::run_once_remove(SIGN_IN_NAME) {
        log.line(&format!("could not remove the sign-in restore: {e}"));
    }
}

/// The folder of the record takes a file, flushed, and lets it go again.
fn journal_writable(record: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let dir = record.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let probe = dir.join("handover.probe");
    let mut f = std::fs::File::create(&probe)?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    drop(f);
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Yes once the installer `pid` (by pid and creation time) no longer runs.
fn installer_gone(pid: u32) -> Watch {
    let start_time = procid::start_time(pid);
    Watch::new(move || {
        !procid::same_process(&procid::Recorded {
            pid,
            exe: None,
            start_time,
        })
    })
}

/// SpawnLoft 1.x is still installed in `dir`, whole enough to start servers through.
fn legacy_intact(legacy: &CliLegacy) -> bool {
    legacy.exe().is_file()
        && legacy.script().is_file()
        && legacy.dir.join("resources").join("app.asar").is_file()
}

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
            "usage: handover stop --legacy-dir <dir> [...] | handover resume [--pending] [--skip-start] | handover restore --legacy-dir <dir> [--logon] | handover cleanup",
        ),
    }
}

/// `handover stop --legacy-dir <dir> [--legacy-version <v>] [--deadline <s>] [--log <file>]
/// [--silent] [--status-dir <dir>] [--installer-pid <pid>]`. With `--status-dir` (the installer's
/// stopping page) the last lines go to `handover-progress.txt`, a `handover-cancel` file there
/// cancels, and the exit code and the blocking servers are written to `handover-exit.txt` at the
/// end. With `--installer-pid` the stop ends like a Cancel once that process is gone.
fn stop(rest: &[String]) -> Outcome {
    let f = match flags(
        rest,
        &[
            "--legacy-dir",
            "--legacy-version",
            "--deadline",
            "--log",
            "--status-dir",
            "--installer-pid",
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
    let installer = match get(f, "--installer-pid").map(str::parse::<u32>) {
        None => None,
        Some(Ok(pid)) if pid > 0 => Some(pid),
        Some(_) => return usage_error("--installer-pid takes a process id"),
    };
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
        legacy_dir: Some(dir.to_string()),
        deadline,
        silent,
        cancel_file: status_dir.map(|d| d.join("handover-cancel")),
        restore_wait: h::RESTORE_WAIT,
        installer_gone: installer.map(installer_gone),
        session_ending: Some(Watch::new(platform::session_ending)),
    };
    log.line(&format!(
        "handover stop: 1.x {} in {dir}, data root {}, deadline {} s, {}",
        opts.legacy_version,
        data_root.display(),
        deadline.as_secs(),
        if silent { "silent" } else { "interactive" }
    ));

    // One handover step at a time: a restore from the last sign-in may still be starting servers.
    let Some(_lock) = wait_lock(&files.lock(), STEP_WAIT) else {
        log.line("another handover step is still running: not updating now");
        return done(h::EXIT_INTERNAL, json!({ "exit": 2, "busy": true }));
    };

    // Not into a shutdown (install on quit as Windows goes down): the servers would be stopped
    // for an update nobody is there to finish.
    if platform::session_ending() {
        log.line("Windows is shutting down: not updating now; nothing was changed");
        return done(h::EXIT_INTERNAL, json!({ "exit": 2, "sessionEnding": true }));
    }
    // The record must be writable before anything is changed: without it a cut-short stop could
    // not be put back.
    if let Err(e) = journal_writable(&files.record()) {
        log.line(&format!(
            "cannot write the handover record in {}: {e}; not updating now, nothing was changed",
            data_root.join("run").display()
        ));
        return done(h::EXIT_INTERNAL, json!({ "exit": 2, "record": "unwritable" }));
    }

    // 1.x's own view, from the files its `readState` reads (no shipped 1.x lists as JSON)
    let listed = match legacy::read_state_files(&data_root) {
        Ok(l) => l,
        Err(why) => return unreadable_root(&data_root, why, &log),
    };

    // No Node check here (PLAN-2.0-REMAINING.md A8): this runs from staging\ before the payload
    // is extracted, and the payload carries the Node that starts the servers again.

    // what an attempt that never finished left: this one takes it over (design 2.4)
    let unfinished = Record::read(&files.record()).filter(|r| !r.settled());
    let took_over = unfinished.is_some();
    let journal = FileJournal {
        sign_in_for: Some(&legacy.dir),
        ..FileJournal::new(files.record(), &log)
    };
    let out = h::run_stop(
        &opts,
        listed,
        Ctx {
            legacy: &legacy,
            tasks: &WindowsTasks,
            journal: &journal,
            log: &log,
        },
        h::Found {
            marker: Marker::read(&files.marker()),
            unfinished,
        },
        &data_root.to_string_lossy(),
    );
    // a silent retry that stopped nothing and had nothing to take over keeps the last record
    let untouched = out.code == h::EXIT_BLOCKED
        && out.record.servers.is_empty()
        && out.record.tasks_disabled.is_empty()
        && !took_over;
    if !untouched && let Err(e) = out.record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    if !out.interrupted {
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
    }
    // put back already (an abort, a cancel) or nothing was changed: the sign-in has nothing to do.
    // After a stop that went through it stays until `handover resume` or `restore` has run.
    if out.record.settled() {
        disarm_sign_in(&log);
    } else if !journal.armed.get() {
        // owed without a save on the way (only servers an earlier blocked attempt left stopped)
        arm_sign_in(&legacy.dir, &log);
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

/// [`take_lock`], waiting up to `wait` for another step to let go of it.
fn wait_lock(file: &Path, wait: Duration) -> Option<Lock> {
    let until = std::time::Instant::now() + wait;
    loop {
        if let Some(lock) = take_lock(file) {
            return Some(lock);
        }
        if std::time::Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(500));
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
    let journal = FileJournal::new(files.record(), &log);
    resume::run_resume(&mut record, opts, starter, &WindowsTasks, &journal, &log);
    if let Err(e) = record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    if record.settled() {
        disarm_sign_in(&log);
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

/// `handover restore --legacy-dir <dir> [--logon]`: the update did not complete after servers were
/// stopped (the 1.x uninstaller failed, a later step of the install failed, the person cancelled,
/// or the installer and the stop ended without warning and this is the next sign-in, `--logon`).
/// What the stop stopped is started again under the 1.x that is still installed, and the tasks
/// are enabled again. Does nothing when nothing is owed, and leaves the record alone when 1.x is
/// no longer there (2.0's first start resumes it then).
fn restore_cmd(rest: &[String]) -> Outcome {
    let f = match flags(rest, &["--legacy-dir", "--log"], &["--logon"]) {
        Ok(f) => f,
        Err(o) => return o,
    };
    let logon = has(&f, "--logon");
    if logon {
        // Windows gives a console program it starts at sign-in a window of its own
        platform::detach_console();
    }
    let data_root = paths::resolve_data_root();
    let files = Files::new(&data_root);
    let log_path = get(&f, "--log").map(PathBuf::from).unwrap_or_else(|| files.log());
    let log = Log::open(Some(&log_path), !logon);
    // the folder as given, or as the stop wrote it down (a sign-in command too long to carry it)
    let dir_of = |r: Option<&Record>| {
        get(&f, "--legacy-dir")
            .map(str::to_string)
            .or_else(|| r.and_then(|r| r.legacy_dir.clone()))
    };
    // Everything under the lock, the sign-in command too: a stop that has just registered it
    // must not lose it to a restore that looked a moment earlier.
    let Some(_lock) = wait_lock(&files.lock(), STEP_WAIT) else {
        log.line("handover restore: another handover step is running; leaving it to that one");
        // Windows has already removed a sign-in command it is running: if that step is cut short
        // too, the next sign-in must still find one.
        let seen = Record::read(&files.record()).filter(|r| !r.settled());
        if let Some(dir) = dir_of(seen.as_ref()).filter(|_| seen.is_some()) {
            let legacy = CliLegacy {
                dir: PathBuf::from(dir),
                scratch: std::env::temp_dir(),
                data_root: data_root.clone(),
            };
            if legacy_intact(&legacy) {
                arm_sign_in(&legacy.dir, &log);
            }
        }
        return done(0, json!({ "exit": 0, "busy": true }));
    };
    let Some(mut record) = Record::read(&files.record()).filter(|r| !r.settled()) else {
        disarm_sign_in(&log);
        return done(0, json!({ "exit": 0, "record": null }));
    };
    let Some(dir) = dir_of(Some(&record)) else {
        return usage_error("handover restore needs --legacy-dir <the 1.x install folder>");
    };
    let dir = dir.as_str();
    let legacy = CliLegacy {
        dir: PathBuf::from(dir),
        scratch: std::env::temp_dir(),
        data_root: data_root.clone(),
    };
    if !legacy_intact(&legacy) {
        log.line(&format!(
            "handover restore: SpawnLoft 1 is no longer installed in {dir}; the record is left for SpawnLoft 2's first start"
        ));
        return done(0, json!({ "exit": 0, "legacy": "gone" }));
    }
    log.line(if logon {
        "handover restore (sign-in): an update did not finish; starting the stopped servers again under 1.x"
    } else {
        "handover restore: the update did not complete; starting the stopped servers again under 1.x"
    });
    let journal = FileJournal::new(files.record(), &log);
    h::restore(
        &mut record,
        Ctx {
            legacy: &legacy,
            tasks: &WindowsTasks,
            journal: &journal,
            log: &log,
        },
    );
    if let Err(e) = record.write(&files.record()) {
        log.line(&format!("could not write {}: {e}", files.record().display()));
    }
    if record.settled() {
        disarm_sign_in(&log);
        log.line("handover restore done");
    } else {
        // Windows removed the sign-in command as it ran it: something is still owed (a task that
        // would not enable, a shutdown under way), so the next sign-in tries again.
        arm_sign_in(&legacy.dir, &log);
        log.line("handover restore: not everything could be put back; the next sign-in tries again");
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

/// `user-path add|remove`: the install's `resources\\bin` on the user's PATH (Windows,
/// spawnloft-lib user_path.rs). The installer runs `add` on a new install and on the 1.x handover,
/// never on a 2.x update (the PATH stays as the user has it); the uninstaller runs `remove` on a
/// real uninstall only. Logged to the handover log; the exit code is 0 unless the registry refused.
pub fn user_path(rest: &[String]) -> Outcome {
    use spawnloft_lib::user_path;
    let result = match rest {
        [a] if a == "add" => user_path::add(),
        [a] if a == "remove" => user_path::remove(),
        _ => return usage_error("user-path takes add or remove"),
    };
    let data_root = paths::resolve_data_root();
    let log = Log::open(Some(&Files::new(&data_root).log()), false);
    match result {
        Ok(c) => {
            log.line(&format!("user-path {}: {c:?}", rest[0]));
            Outcome::default()
        }
        Err(e) => {
            log.line(&format!("user-path {}: not changed: {e}", rest[0]));
            Outcome {
                stdout: String::new(),
                stderr: format!("{}: user-path {}: {e}\n", build::NAME, rest[0]),
                code: 1,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-hocmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_sign_in_command_is_quoted_and_short_enough() {
        let exe = Path::new(
            r"C:\Users\A Person\AppData\Local\Programs\SpawnLoft\resources\bin\staging\spawnloft-core.exe",
        );
        let dir = Path::new(r"C:\Users\A Person\AppData\Local\Programs\SpawnLoft");
        let cmd = sign_in_command(exe, dir);
        assert_eq!(
            cmd,
            format!(
                "\"{}\" handover restore --legacy-dir \"{}\" --logon",
                exe.display(),
                dir.display()
            )
        );
        // what Windows runs from RunOnce
        assert!(cmd.len() <= 260, "{}", cmd.len());
        // a trailing backslash would escape the closing quote
        let slashed = sign_in_command(exe, Path::new(r"C:\Programs\SpawnLoft\"));
        assert!(
            slashed.contains(r#"--legacy-dir "C:\Programs\SpawnLoft" --logon"#),
            "{slashed}"
        );
        // too long for RunOnce with the folder (a long profile name): the record names it instead
        let long = "N".repeat(60);
        let exe = PathBuf::from(format!(
            r"C:\Users\{long}\AppData\Local\Programs\SpawnLoft\resources\bin\staging\spawnloft-core.exe"
        ));
        let dir = PathBuf::from(format!(r"C:\Users\{long}\AppData\Local\Programs\SpawnLoft"));
        let cmd = sign_in_command(&exe, &dir);
        assert_eq!(cmd, format!("\"{}\" handover restore --logon", exe.display()));
        assert!(
            cmd.encode_utf16().count() <= platform::RUN_ONCE_MAX,
            "{}",
            cmd.len()
        );
    }

    #[test]
    fn the_journal_keeps_the_record_on_disk() {
        let d = tmp("journal");
        let files = Files::new(&d);
        let log = Log::none();
        let journal = FileJournal::new(files.record(), &log);
        let mut rec = Record::new("1.5.0", "2.0.0", "silent", "/d");
        rec.tasks_disabled = vec!["backup".into()];
        journal.save(&rec);
        let back = Record::read(&files.record()).unwrap();
        assert_eq!(back, rec);
        assert!(!back.settled(), "unfinished on disk");
        rec.tasks_reenabled = true;
        journal.save(&rec);
        assert!(Record::read(&files.record()).unwrap().settled());
        assert!(!files.run_dir.join("handover.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn one_handover_step_at_a_time() {
        let d = tmp("lock");
        let file = Files::new(&d).lock();
        let first = take_lock(&file).expect("free");
        assert!(
            wait_lock(&file, Duration::from_millis(50)).is_none(),
            "held by a live process"
        );
        drop(first);
        assert!(wait_lock(&file, Duration::from_millis(50)).is_some());
        // a lock whose owner is gone (the stop was cut short) is taken over
        std::fs::write(&file, "4294967294 1 2026-01-01T00:00:00Z").unwrap();
        assert!(take_lock(&file).is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_watched_installer_that_never_ran_counts_as_gone() {
        // no process has this id
        assert!(installer_gone(4_294_967_294).yes());
        assert!(!installer_gone(std::process::id()).yes());
    }
}
