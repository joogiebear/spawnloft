//! The 1.x to 2.0 handover on Windows (rust/INSTALLER-UPDATER-DESIGN.md sections 2.3 to 2.5).
//!
//! `handover stop` runs from the 2.0 installer, before the 1.x uninstaller (whose running-app
//! check terminates every process under the install folder, Node daemons and their JVMs with
//! them). It stops what 1.x runs, gracefully, through the installed 1.x CLI, servers before
//! databases, with the deadline enforced on the CLI client and never handed to the 1.x daemon
//! (which force-kills the JVM when its own stop timeout passes). Nothing here ever terminates a
//! JVM or a daemon. A server that will not stop in time aborts the update: what was stopped is
//! started again under 1.x, the scheduled tasks are enabled again, and a marker keeps silent
//! retries (electron-updater reruns the pending installer at every quit) from repeating the stop.
//!
//! `handover resume` runs after the 2.0 files are in place and starts again, through the 2.0
//! core, what the stop stopped: databases first, then servers.
//!
//! The engines here take the 1.x side ([`Legacy`]), the scheduled tasks ([`Tasks`]) and the 2.0
//! side ([`resume::Starter`]) as traits, so the order, the deadline and the abort path are tested
//! on any platform with fakes; `legacy`, `tasks` and `crate::nodecore` hold the real ones.

pub mod cleanup;
pub mod legacy;
pub mod resume;
pub mod tasks;

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::{fsx, time};

/// The record's format.
pub const FORMAT: u64 = 1;
/// The whole stop phase (Q-H, decided: 300 s).
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(300);
/// How many stops or starts run at once within a tier.
pub const PARALLEL: usize = 4;
/// The stop timeout handed to the 1.x CLI, in seconds. It becomes the daemon's `waitForExit`
/// bound, after which 1.x force-kills the JVM, so it is far beyond any deadline; with the CLI's
/// own 30 s margin it stays under setTimeout's 2^31 - 1 ms limit (above it Node fires at once).
pub const CLI_STOP_TIMEOUT_SECS: u64 = 2_000_000;
/// The error of an entry whose turn came after the deadline: it was never asked to stop.
pub const NOT_REACHED: &str = "the deadline had passed before its turn";
/// A blocked marker older than this no longer holds a silent retry back.
pub const MARKER_HOLD: Duration = Duration::from_secs(24 * 3600);

/// Exit codes of `handover stop` the installer acts on (design 2.3 step 2).
pub const EXIT_OK: u8 = 0;
pub const EXIT_INTERNAL: u8 = 2;
pub const EXIT_BLOCKED: u8 = 3;

/// A server or a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Server,
    Database,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Server => "server",
            Kind::Database => "database",
        }
    }
    pub fn parse(s: &str) -> Kind {
        if s == "database" {
            Kind::Database
        } else {
            Kind::Server
        }
    }
}

/// One entry as 1.x reports it (`list --json`, or the state files when the CLI cannot run).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    pub kind: Kind,
    /// `running`, `stopping`, `orphaned`, `stale`, `stopped`, `external`
    pub status: String,
    pub java_pid: Option<u32>,
    pub daemon_pid: Option<u32>,
}

impl Listed {
    /// 1.x's ACTIVE_STATUSES, minus a database that runs elsewhere.
    pub fn active(&self) -> bool {
        matches!(self.status.as_str(), "running" | "stopping" | "orphaned")
    }
    pub fn orphaned(&self) -> bool {
        self.status == "orphaned"
    }
    /// Active with a daemon to stop it through.
    pub fn stoppable(&self) -> bool {
        self.active() && !self.orphaned()
    }
}

/// When the stop phase must give up: its deadline, or the installer page's Cancel (a file the page
/// creates in the status folder).
#[derive(Debug, Clone)]
pub struct Cutoff {
    pub deadline: Instant,
    pub cancel_file: Option<PathBuf>,
}

impl Cutoff {
    pub fn after(d: Duration) -> Cutoff {
        Cutoff {
            deadline: Instant::now() + d,
            cancel_file: None,
        }
    }
    pub fn cancelled(&self) -> bool {
        self.cancel_file.as_deref().is_some_and(Path::exists)
    }
    pub fn passed(&self) -> bool {
        Instant::now() >= self.deadline || self.cancelled()
    }
}

/// How one stop through the 1.x CLI ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliStop {
    /// The CLI exited with this code; its output is in the log.
    Exited { code: i32, output: String },
    /// The deadline passed and the CLI client was terminated (the daemon was not touched).
    DeadlinePassed,
    /// The CLI could not be started at all.
    NotRun(String),
}

/// How the fallback stop over the 1.x control pipe ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeStop {
    Stopped,
    DeadlinePassed,
    Failed(String),
}

/// The installed 1.x, as the handover drives it.
pub trait Legacy: Sync {
    /// Every server and database with its status, as 1.x reconciles it.
    fn list(&self) -> Result<Vec<Listed>, String>;
    /// `stop <name> --timeout CLI_STOP_TIMEOUT_SECS`, the client terminated at the cutoff.
    fn stop(&self, name: &str, cut: &Cutoff, log: &Log) -> CliStop;
    /// Own client on the 1.x pipe after checking its owner is `entry.daemon_pid`; then waits for
    /// the JVM until the cutoff. Never kills anything.
    fn pipe_stop(&self, entry: &Listed, cut: &Cutoff, log: &Log) -> PipeStop;
    /// `start <name> --detach`, for the abort path.
    fn start(&self, name: &str, log: &Log) -> Result<(), String>;
}

/// The `\mcctl` Task Scheduler folder.
pub trait Tasks: Sync {
    /// The task names in the folder that are enabled now.
    fn enabled(&self) -> Result<Vec<String>, String>;
    fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String>;
}

/// `run/handover.log`: one line per step, the 1.x CLI's output included. Writes are best effort:
/// a log that cannot be written must not stop the handover.
#[derive(Debug)]
pub struct Log {
    file: Mutex<Option<std::fs::File>>,
    echo: bool,
    /// the installer page's view: the last lines, rewritten on every line
    progress: Option<(PathBuf, Mutex<Vec<String>>)>,
}

impl Log {
    pub fn open(path: Option<&Path>, echo: bool) -> Log {
        let file = path.and_then(|p| {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        });
        Log {
            file: Mutex::new(file),
            echo,
            progress: None,
        }
    }
    pub fn none() -> Log {
        Log {
            file: Mutex::new(None),
            echo: false,
            progress: None,
        }
    }
    /// Also keeps the last lines (without the 1.x CLI's own output) in `file`.
    pub fn with_progress(mut self, file: PathBuf) -> Log {
        self.progress = Some((file, Mutex::new(Vec::new())));
        self
    }
    pub fn line(&self, msg: &str) {
        let text = format!("{} {msg}\n", time::iso_now());
        if let Ok(mut f) = self.file.lock()
            && let Some(f) = f.as_mut()
        {
            let _ = f.write_all(text.as_bytes());
        }
        if self.echo {
            let _ = std::io::stderr().write_all(text.as_bytes());
        }
        if let Some((file, lines)) = &self.progress
            && !msg.starts_with("1.x")
            && let Ok(mut lines) = lines.lock()
        {
            lines.push(msg.to_string());
            let skip = lines.len().saturating_sub(12);
            let _ = std::fs::write(file, lines[skip..].join("\r\n"));
        }
    }
}

/// One entry of the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// `stopped`, `was-stopped`, `still-running`, `orphaned`, `failed`
    pub stop: String,
    pub stop_ms: Option<u64>,
    /// when the stop finished, ms since the epoch (ordering checks)
    pub stopped_at: Option<i64>,
    /// `running`, `failed`, `skipped`, `restored-1x`; `None` until resume or abort ran
    pub start: Option<String>,
    pub started_at: Option<i64>,
    pub error: Option<String>,
}

impl Entry {
    fn new(name: &str, kind: Kind, stop: &str) -> Entry {
        Entry {
            name: name.into(),
            kind,
            stop: stop.into(),
            stop_ms: None,
            stopped_at: None,
            start: None,
            started_at: None,
            error: None,
        }
    }
    /// Stopped by the handover (or gone while it looked): what resume and abort start again.
    pub fn to_restart(&self) -> bool {
        matches!(self.stop.as_str(), "stopped" | "was-stopped")
    }
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("kind".into(), json!(self.kind.as_str()));
        m.insert("stop".into(), json!(self.stop));
        if let Some(v) = self.stop_ms {
            m.insert("stopMs".into(), json!(v));
        }
        if let Some(v) = self.stopped_at {
            m.insert("stoppedAt".into(), json!(v));
        }
        m.insert("start".into(), json!(self.start));
        if let Some(v) = self.started_at {
            m.insert("startedAt".into(), json!(v));
        }
        if let Some(v) = &self.error {
            m.insert("error".into(), json!(v));
        }
        Value::Object(m)
    }
    fn from_json(v: &Value) -> Option<Entry> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Entry {
            name: s("name")?,
            kind: Kind::parse(&s("kind").unwrap_or_default()),
            stop: s("stop")?,
            stop_ms: v.get("stopMs").and_then(Value::as_u64),
            stopped_at: v.get("stoppedAt").and_then(Value::as_i64),
            start: s("start"),
            started_at: v.get("startedAt").and_then(Value::as_i64),
            error: s("error"),
        })
    }
}

/// `run/handover.json` (design 2.4).
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub from: String,
    pub to: String,
    pub started_at: String,
    pub started_ms: i64,
    pub mode: String,
    pub data_root: String,
    pub servers: Vec<Entry>,
    pub tasks_disabled: Vec<String>,
    pub tasks_reenabled: bool,
    pub stop_exit: Option<u8>,
    pub resume_exit: Option<u8>,
    pub shown: bool,
}

impl Record {
    pub fn new(from: &str, to: &str, mode: &str, data_root: &str) -> Record {
        let ms = time::now_ms();
        Record {
            from: from.into(),
            to: to.into(),
            started_at: time::iso(ms),
            started_ms: ms,
            mode: mode.into(),
            data_root: data_root.into(),
            servers: Vec::new(),
            tasks_disabled: Vec::new(),
            tasks_reenabled: false,
            stop_exit: None,
            resume_exit: None,
            shown: false,
        }
    }

    pub fn entry_mut(&mut self, name: &str) -> Option<&mut Entry> {
        self.servers.iter_mut().find(|e| e.name == name)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "format": FORMAT,
            "from": self.from,
            "to": self.to,
            "startedAt": self.started_at,
            "startedMs": self.started_ms,
            "mode": self.mode,
            "dataRoot": self.data_root,
            "servers": self.servers.iter().map(Entry::to_json).collect::<Vec<_>>(),
            "tasksDisabled": self.tasks_disabled,
            "tasksReenabled": self.tasks_reenabled,
            "stopExit": self.stop_exit,
            "resumeExit": self.resume_exit,
            "shown": self.shown,
        })
    }

    pub fn from_json(v: &Value) -> Option<Record> {
        if v.get("format").and_then(Value::as_u64) != Some(FORMAT) {
            return None;
        }
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let code = |k: &str| {
            v.get(k)
                .and_then(Value::as_u64)
                .and_then(|n| u8::try_from(n).ok())
        };
        Some(Record {
            from: s("from"),
            to: s("to"),
            started_at: s("startedAt"),
            started_ms: v.get("startedMs").and_then(Value::as_i64).unwrap_or(0),
            mode: s("mode"),
            data_root: s("dataRoot"),
            servers: v
                .get("servers")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Entry::from_json).collect())
                .unwrap_or_default(),
            tasks_disabled: v
                .get("tasksDisabled")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            tasks_reenabled: v.get("tasksReenabled").and_then(Value::as_bool).unwrap_or(false),
            stop_exit: code("stopExit"),
            resume_exit: code("resumeExit"),
            shown: v.get("shown").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    pub fn read(file: &Path) -> Option<Record> {
        let text = std::fs::read_to_string(file).ok()?;
        Record::from_json(&serde_json::from_str(&text).ok()?)
    }

    pub fn write(&self, file: &Path) -> std::io::Result<()> {
        fsx::write_json(file, &self.to_json())
    }
}

/// Where the handover keeps its files: `<data root>/run/`.
#[derive(Debug, Clone)]
pub struct Files {
    pub run_dir: PathBuf,
}

impl Files {
    pub fn new(data_root: &Path) -> Files {
        Files {
            run_dir: data_root.join("run"),
        }
    }
    pub fn record(&self) -> PathBuf {
        self.run_dir.join("handover.json")
    }
    pub fn log(&self) -> PathBuf {
        self.run_dir.join("handover.log")
    }
    pub fn marker(&self) -> PathBuf {
        self.run_dir.join("handover-blocked.json")
    }
    pub fn lock(&self) -> PathBuf {
        self.run_dir.join("handover.lock")
    }
}

/// `run/handover-blocked.json`: which servers blocked the last attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub blocked_by: Vec<String>,
    pub at_ms: i64,
    pub attempts: u64,
}

impl Marker {
    pub fn read(file: &Path) -> Option<Marker> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
        Some(Marker {
            blocked_by: v
                .get("blockedBy")?
                .as_array()?
                .iter()
                .filter_map(|n| n.as_str().map(str::to_string))
                .collect(),
            at_ms: v.get("atMs").and_then(Value::as_i64).unwrap_or(0),
            attempts: v.get("attempts").and_then(Value::as_u64).unwrap_or(1),
        })
    }
    pub fn write(&self, file: &Path) -> std::io::Result<()> {
        fsx::write_json(
            file,
            &json!({
                "blockedBy": self.blocked_by,
                "at": time::iso(self.at_ms),
                "atMs": self.at_ms,
                "attempts": self.attempts,
            }),
        )
    }
    /// Whether a silent retry must exit at once: young enough, and a server it names still active.
    pub fn holds(&self, now_ms: i64, active: &[Listed]) -> bool {
        let young = now_ms.saturating_sub(self.at_ms) < MARKER_HOLD.as_millis() as i64;
        young
            && active
                .iter()
                .any(|l| l.stoppable() && self.blocked_by.iter().any(|b| b == &l.name))
    }
}

/// What `handover stop` was asked to do.
#[derive(Debug, Clone)]
pub struct StopOptions {
    pub legacy_version: String,
    pub to_version: String,
    pub deadline: Duration,
    /// silent and passive installs: the blocked marker applies
    pub silent: bool,
    /// the installer page's Cancel
    pub cancel_file: Option<PathBuf>,
}

/// The outcome: the exit code and the record to write.
#[derive(Debug)]
pub struct StopOutcome {
    pub code: u8,
    pub record: Record,
    pub marker: Option<Marker>,
}

/// The stop phase (design 2.3.1). `previous` is the blocked marker found, if any; the caller
/// writes the record and the marker (or removes it) from the outcome.
pub fn run_stop(
    opts: &StopOptions,
    listed: Vec<Listed>,
    legacy: &dyn Legacy,
    tasks: &dyn Tasks,
    previous: Option<Marker>,
    data_root: &str,
    log: &Log,
) -> StopOutcome {
    let started = Instant::now();
    let cut = Cutoff {
        deadline: started + opts.deadline,
        cancel_file: opts.cancel_file.clone(),
    };
    let mode = if opts.silent { "silent" } else { "ui" };
    let mut record = Record::new(&opts.legacy_version, &opts.to_version, mode, data_root);

    let active: Vec<Listed> = listed.into_iter().filter(Listed::active).collect();
    log.line(&format!(
        "handover stop from {} to {}: {} active ({})",
        opts.legacy_version,
        opts.to_version,
        active.len(),
        active
            .iter()
            .map(|l| format!("{} {} {}", l.kind.as_str(), l.name, l.status))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    // A silent retry while the server that blocked the last attempt still runs: stop nothing.
    if opts.silent
        && let Some(m) = &previous
        && m.holds(time::now_ms(), &active)
    {
        let marker = Marker {
            attempts: m.attempts + 1,
            ..m.clone()
        };
        log.line(&format!(
            "blocked: {} still running since the attempt at {}; nothing stopped (attempt {})",
            marker.blocked_by.join(", "),
            time::iso(m.at_ms),
            marker.attempts
        ));
        record.stop_exit = Some(EXIT_BLOCKED);
        return StopOutcome {
            code: EXIT_BLOCKED,
            record,
            marker: Some(marker),
        };
    }

    for o in active.iter().filter(|l| l.orphaned()) {
        log.line(&format!(
            "{} {} is orphaned (java pid {}, no daemon): left alone",
            o.kind.as_str(),
            o.name,
            o.java_pid.unwrap_or(0)
        ));
        record.servers.push(Entry::new(&o.name, o.kind, "orphaned"));
    }

    // The task folder off first, so a restart or start task cannot launch a 1.x daemon meanwhile.
    if active.iter().any(Listed::stoppable) {
        disable_tasks(tasks, &mut record, log);
    }

    let mut seen: BTreeSet<String> = record.servers.iter().map(|e| e.name.clone()).collect();
    stop_in_order(&active, &mut seen, &mut record, legacy, &cut, log);

    // Anything that started meanwhile (a task that fired before the disable landed).
    let after = legacy.list();
    if let Ok(now) = &after {
        let newcomers: Vec<Listed> = now
            .iter()
            .filter(|l| l.active() && !seen.contains(&l.name))
            .cloned()
            .collect();
        for o in newcomers.iter().filter(|l| l.orphaned()) {
            record.servers.push(Entry::new(&o.name, o.kind, "orphaned"));
            seen.insert(o.name.clone());
        }
        if newcomers.iter().any(Listed::stoppable) {
            log.line("started during the handover; stopping them too");
            if record.tasks_disabled.is_empty() {
                disable_tasks(tasks, &mut record, log);
            }
            stop_in_order(&newcomers, &mut seen, &mut record, legacy, &cut, log);
        }
    }

    // The truth after all that: whatever is still active and has a daemon blocks the update.
    let last = legacy.list();
    let still: Vec<Listed> = match &last {
        Ok(now) => now.iter().filter(|l| l.stoppable()).cloned().collect(),
        Err(e) => {
            log.line(&format!("could not list again after the stop: {e}"));
            // without a fresh list, trust each stop's own result
            record
                .servers
                .iter()
                .filter(|e| matches!(e.stop.as_str(), "still-running" | "failed"))
                .map(|e| Listed {
                    name: e.name.clone(),
                    kind: e.kind,
                    status: "running".into(),
                    java_pid: None,
                    daemon_pid: None,
                })
                .collect()
        }
    };
    if let Ok(now) = &last {
        for e in record.servers.iter_mut() {
            if let Some(l) = now.iter().find(|l| l.name == e.name) {
                if l.orphaned() && e.stop != "orphaned" {
                    e.stop = "orphaned".into();
                } else if !l.active() && matches!(e.stop.as_str(), "still-running" | "failed") {
                    // it finished on its own after all
                    e.stop = "was-stopped".into();
                }
            }
        }
    }
    for s in &still {
        match record.entry_mut(&s.name) {
            Some(e) => e.stop = "still-running".into(),
            None => record.servers.push(Entry::new(&s.name, s.kind, "still-running")),
        }
    }

    if still.is_empty() {
        log.line(&format!(
            "stop phase done in {} ms: nothing left running under 1.x",
            started.elapsed().as_millis()
        ));
        record.stop_exit = Some(EXIT_OK);
        return StopOutcome {
            code: EXIT_OK,
            record,
            marker: None,
        };
    }

    let cancelled = cut.cancelled();
    if cancelled {
        log.line("cancelled: everything that was stopped is started again under 1.x");
    }
    // Abort (2.3.3): put back what was stopped, databases first, and the tasks. The marker names
    // what was asked to stop and did not; what the deadline never reached is not to blame.
    let asked = |n: &str| {
        record
            .servers
            .iter()
            .find(|e| e.name == n)
            .is_none_or(|e| e.error.as_deref() != Some(NOT_REACHED))
    };
    let mut names: Vec<String> = still
        .iter()
        .map(|s| s.name.clone())
        .filter(|n| asked(n))
        .collect();
    if names.is_empty() {
        names = still.iter().map(|s| s.name.clone()).collect();
    }
    if !cancelled {
        log.line(&format!(
            "{} did not stop within the deadline: the update is abandoned and 1.x is left as it was",
            names.join(", ")
        ));
    }
    restore(&mut record, legacy, tasks, log);
    let attempts = previous
        .filter(|m| m.blocked_by == names)
        .map(|m| m.attempts + 1)
        .unwrap_or(1);
    record.stop_exit = Some(EXIT_BLOCKED);
    StopOutcome {
        code: EXIT_BLOCKED,
        record,
        // the person cancelled: nothing to hold a silent retry back for
        marker: (!cancelled).then(|| Marker {
            blocked_by: names,
            at_ms: time::now_ms(),
            attempts,
        }),
    }
}

/// Starts again under 1.x, databases first, every entry the stop stopped and nothing has started
/// since, and enables the tasks again: the abort path, and `handover restore` for an install that
/// failed after a successful stop.
pub fn restore(record: &mut Record, legacy: &dyn Legacy, tasks: &dyn Tasks, log: &Log) {
    let mut order: Vec<usize> = (0..record.servers.len())
        .filter(|&i| record.servers[i].to_restart() && record.servers[i].start.is_none())
        .collect();
    order.sort_by_key(|&i| std::cmp::Reverse(record.servers[i].kind));
    for i in order {
        let name = record.servers[i].name.clone();
        let res = legacy.start(&name, log);
        let e = &mut record.servers[i];
        e.started_at = Some(time::now_ms());
        match res {
            Ok(()) => {
                log.line(&format!("{name} started again under 1.x"));
                e.start = Some("restored-1x".into());
            }
            Err(err) => {
                log.line(&format!("{name} could not be started again under 1.x: {err}"));
                e.start = Some("failed".into());
                e.error = Some(err);
            }
        }
    }
    reenable_tasks(tasks, record, log);
}

fn disable_tasks(tasks: &dyn Tasks, record: &mut Record, log: &Log) {
    match tasks.enabled() {
        Ok(list) => {
            for t in list {
                match tasks.set_enabled(&t, false) {
                    Ok(()) => {
                        log.line(&format!("task {t} disabled for the handover"));
                        record.tasks_disabled.push(t);
                    }
                    Err(e) => log.line(&format!("task {t} could not be disabled: {e}")),
                }
            }
        }
        Err(e) => log.line(&format!("could not read the scheduled tasks: {e}")),
    }
}

/// Enables the tasks the record disabled, once.
pub fn reenable_tasks(tasks: &dyn Tasks, record: &mut Record, log: &Log) {
    if record.tasks_reenabled {
        return;
    }
    for t in &record.tasks_disabled {
        match tasks.set_enabled(t, true) {
            Ok(()) => log.line(&format!("task {t} enabled again")),
            Err(e) => log.line(&format!("task {t} could not be enabled again: {e}")),
        }
    }
    record.tasks_reenabled = true;
}

/// Servers, then databases; up to [`PARALLEL`] at a time within a tier.
fn stop_in_order(
    active: &[Listed],
    seen: &mut BTreeSet<String>,
    record: &mut Record,
    legacy: &dyn Legacy,
    cut: &Cutoff,
    log: &Log,
) {
    for kind in [Kind::Server, Kind::Database] {
        let tier: Vec<&Listed> = active
            .iter()
            .filter(|l| l.kind == kind && l.stoppable() && !seen.contains(&l.name))
            .collect();
        for chunk in tier.chunks(PARALLEL) {
            let results: Vec<Entry> = std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|l| s.spawn(move || stop_one(l, legacy, cut, log)))
                    .collect();
                handles
                    .into_iter()
                    .zip(chunk.iter())
                    .map(|(h, l)| {
                        h.join().unwrap_or_else(|_| {
                            let mut e = Entry::new(&l.name, l.kind, "failed");
                            e.error = Some("the stop thread panicked".into());
                            e
                        })
                    })
                    .collect()
            });
            for e in results {
                seen.insert(e.name.clone());
                record.servers.push(e);
            }
        }
    }
}

fn stop_one(l: &Listed, legacy: &dyn Legacy, cut: &Cutoff, log: &Log) -> Entry {
    let t0 = Instant::now();
    log.line(&format!("stopping {} {} through 1.x", l.kind.as_str(), l.name));
    let mut e = Entry::new(&l.name, l.kind, "failed");
    if cut.passed() {
        e.stop = "still-running".into();
        e.error = Some(NOT_REACHED.into());
        return e;
    }
    match legacy.stop(&l.name, cut, log) {
        CliStop::Exited { code: 0, output } => {
            e.stop = if output.contains("was not running") {
                "was-stopped".into()
            } else {
                "stopped".into()
            };
        }
        CliStop::DeadlinePassed => {
            log.line(&format!(
                "{}: deadline passed; the 1.x client was closed, the server was left to finish",
                l.name
            ));
            e.stop = "still-running".into();
        }
        other => {
            let why = match other {
                CliStop::Exited { code, output } => format!(
                    "the 1.x CLI exited {code}: {}",
                    output.trim().lines().last().unwrap_or("")
                ),
                CliStop::NotRun(err) => format!("the 1.x CLI could not run: {err}"),
                CliStop::DeadlinePassed => unreachable!(),
            };
            log.line(&format!("{}: {why}; trying the control pipe", l.name));
            match legacy.pipe_stop(l, cut, log) {
                PipeStop::Stopped => e.stop = "stopped".into(),
                PipeStop::DeadlinePassed => e.stop = "still-running".into(),
                PipeStop::Failed(err) => {
                    e.stop = "failed".into();
                    e.error = Some(format!("{why}; pipe: {err}"));
                }
            }
        }
    }
    e.stop_ms = Some(t0.elapsed().as_millis() as u64);
    e.stopped_at = Some(time::now_ms());
    log.line(&format!(
        "{} {}: {} after {} ms",
        l.kind.as_str(),
        l.name,
        e.stop,
        e.stop_ms.unwrap_or(0)
    ));
    e
}

#[cfg(test)]
mod tests;
