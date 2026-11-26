//! `schedule.mjs`: scheduled tasks. The definitions live in `schedules.json`; the system's
//! scheduler holds only a trigger that runs `spawnloft task run <id>` through a small shim, so
//! what a task can do stays inside SpawnLoft. Windows is Task Scheduler (`schtasks`, read back
//! through PowerShell), macOS is launchd ([`mac`]) and Linux is systemd user units ([`linux`]),
//! each called exactly as the Node core calls them (rust/PLAN-CORE-PORT.md C6): a native Task
//! Scheduler client is not part of the port.

pub mod linux;
pub mod mac;
pub mod run;
pub mod steps;

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::activity::{self, Actor};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::{js, jspath, registry};

use steps::{cut16, keep_of, len16, text_or_empty};
pub use steps::{describe_step, normalise_steps};

/// The Task Scheduler folder every task is in, so uninstall can remove what SpawnLoft made.
pub const TASK_FOLDER: &str = "mcctl";

/// The one task per server the Backups tab's toggle owns.
pub const OWNER_BACKUPS: &str = "backups";

/// `ACTIONS`: an allowlist rather than a command string. (type, label, needsRunning).
pub const ACTIONS: [(&str, &str, bool); 7] = [
    ("backup", "Take a backup", false),
    ("verify", "Verify the backups", false),
    ("command", "Run a server command", true),
    ("restart", "Restart the server", false),
    ("stop", "Stop the server", true),
    ("start", "Start the server", false),
    ("steps", "Several steps in order", false),
];

fn action_label(kind: &str) -> &'static str {
    ACTIONS.iter().find(|a| a.0 == kind).map_or("", |a| a.1)
}

/// What a task does, for the Activity list.
fn action_words(kind: &str) -> String {
    match kind {
        "backup" => "backs up",
        "restart" => "restarts the server",
        "command" => "runs a command",
        "steps" => "runs several steps",
        other => return other.to_string(),
    }
    .to_string()
}

/// Task Scheduler's last-result codes that are not failures.
const TASK_RESULT: [(&str, &str); 10] = [
    ("0", "ok"),
    ("267008", "ready"),
    ("267009", "running"),
    ("267010", "disabled"),
    ("267011", "not run yet"),
    ("267012", "no more runs scheduled"),
    ("267014", "stopped by user"),
    ("267045", "queued"),
    ("2147750687", "already running, so this run was skipped"),
    ("2147943645", "not run - the machine was not logged in"),
];

/// The days `schtasks /SC WEEKLY` takes.
pub const DAYS: [&str; 7] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
pub const SCHEDULE_KINDS: [&str; 5] = ["minutes", "hourly", "daily", "weekly", "onlogon"];

/// Where the scheduled tasks of one data folder live, and who is changing them.
#[derive(Debug, Clone)]
pub struct Sched {
    pub data_root: String,
    pub run_dir: String,
    pub by: Actor,
}

enum Native {
    Mac,
    Linux,
}

const fn native() -> Option<Native> {
    if cfg!(target_os = "macos") {
        Some(Native::Mac)
    } else if cfg!(target_os = "linux") {
        Some(Native::Linux)
    } else {
        None
    }
}

/// `fail(message)`.
pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure::user(message))
}

fn is_hhmm(at: &str) -> bool {
    let b = at.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!((b[0], b[1]), (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}

/// `normaliseSchedule(input)`: `schtasks` checks nothing (`/MO 0` makes a task that never
/// fires), so everything is checked here; only the checked fields are kept.
pub fn normalise_schedule(input: &Value) -> Result<Value, Failure> {
    let kind = text_or_empty(input.get("kind"));
    if !SCHEDULE_KINDS.contains(&kind.as_str()) {
        return fail(format!(
            "unknown schedule kind \"{kind}\" - expected one of {}",
            SCHEDULE_KINDS.join(", ")
        ));
    }
    if kind == "onlogon" {
        return Ok(json!({ "kind": kind }));
    }
    if kind == "minutes" || kind == "hourly" {
        let every = js::number(input.get("every"));
        if !(every.is_finite() && every.fract() == 0.0) || every < 1.0 {
            return fail("the interval must be a whole number of at least 1");
        }
        // past 1439 minutes or 23 hours schtasks makes the task but it never fires
        let max = if kind == "minutes" { 1439.0 } else { 23.0 };
        if every > max {
            return fail(format!(
                "the largest {kind} interval Windows accepts is {}",
                js::number_to_string(max)
            ));
        }
        return Ok(json!({ "kind": kind, "every": crate::jsjson::num(every) }));
    }
    let at = text_or_empty(input.get("at"));
    if !is_hhmm(&at) {
        return fail(format!("\"{at}\" is not a time - use HH:MM on a 24 hour clock"));
    }
    if kind == "daily" {
        return Ok(json!({ "kind": kind, "at": at }));
    }
    let day = text_or_empty(input.get("day")).to_uppercase();
    if !DAYS.contains(&day.as_str()) {
        return fail(format!(
            "\"{}\" is not a day - use one of {}",
            js::string(input.get("day")),
            DAYS.join(", ")
        ));
    }
    Ok(json!({ "kind": kind, "day": day, "at": at }))
}

/// `normaliseAction(input)`: only the fields the action uses, since `schedules.json` causes
/// code to run on a timer.
pub fn normalise_action(input: &Value) -> Result<Value, Failure> {
    let kind = text_or_empty(input.get("type"));
    if !ACTIONS.iter().any(|a| a.0 == kind) {
        let all: Vec<&str> = ACTIONS.iter().map(|a| a.0).collect();
        return fail(format!(
            "unknown action \"{kind}\" - expected one of {}",
            all.join(", ")
        ));
    }
    Ok(match kind.as_str() {
        "command" => {
            let raw = text_or_empty(input.get("line"));
            let line = js::trim(&raw);
            if line.is_empty() {
                return fail("a command is required");
            }
            if len16(line) > 400 {
                return fail("that command is too long for a console line");
            }
            json!({ "type": kind, "line": line })
        }
        "backup" => json!({ "type": kind, "keep": keep_of(input.get("keep")) }),
        "restart" => {
            // minutes of console warning before the restart; the cap guards against typos
            let warn = js::number(input.get("warnMinutes"));
            let warn = if warn.is_finite() && warn.fract() == 0.0 && warn > 0.0 {
                warn.min(60.0)
            } else {
                0.0
            };
            json!({ "type": kind, "warnMinutes": crate::jsjson::num(warn) })
        }
        "steps" => normalise_steps(input)?,
        _ => json!({ "type": kind }),
    })
}

/// `describeResult(code)`.
pub fn describe_result(code: Option<&Value>) -> String {
    match code {
        None | Some(Value::Null) => "unknown".into(),
        Some(c) => {
            let key = js::string(Some(c));
            TASK_RESULT
                .iter()
                .find(|(k, _)| *k == key)
                .map_or_else(|| format!("failed (exit {key})"), |(_, v)| v.to_string())
        }
    }
}

/// `background()`: on Linux whether lingering is on (null when it cannot be asked) and how the
/// person is connected; null for both elsewhere.
pub fn background() -> (Option<bool>, Option<&'static str>) {
    if !cfg!(target_os = "linux") {
        return (None, None);
    }
    (linux::linger(), Some(linux::session_kind()))
}

/// `loggedOutNote()`: the command line's note about tasks and logging out.
pub fn logged_out_note() -> Vec<String> {
    let (linger, session) = background();
    logged_out_note_for(linger, session, cfg!(target_os = "linux"))
}

pub fn logged_out_note_for(linger: Option<bool>, session: Option<&str>, linux: bool) -> Vec<String> {
    let plain =
        "Tasks run while you are logged in, including with the screen locked - not after signing out.";
    let lines: &[&str] = if !linux {
        &[plain]
    } else if linger == Some(true) {
        &["Lingering is on for your account: tasks run whether or not you are logged in, from boot."]
    } else if session == Some("headless") {
        &[
            "WARNING: tasks stop when you log out, and this looks like a machine you connect to rather than sit at.",
            "A backup scheduled for 03:00 will not run unless you are connected at 03:00. To keep them running:",
            "  spawnloft task linger on",
        ]
    } else {
        &[
            plain,
            "To run them from boot instead, logged in or not: spawnloft task linger on",
        ]
    };
    lines.iter().map(|s| s.to_string()).collect()
}

/// `keepRunningLoggedOut()`.
pub fn keep_running_logged_out() -> Result<(), Failure> {
    if !cfg!(target_os = "linux") {
        return fail("Lingering is a Linux setting; there is nothing to turn on here.");
    }
    linux::enable_linger()
}

/// One task as `{ id, ...task }`.
pub fn with_id(id: &str, task: &Value) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    if let Value::Object(t) = task {
        for (k, v) in t {
            m.insert(k.clone(), v.clone());
        }
    }
    Value::Object(m)
}

impl Sched {
    pub fn new(data_root: &str, run_dir: &str, by: Actor) -> Sched {
        Sched {
            data_root: data_root.to_string(),
            run_dir: run_dir.to_string(),
            by,
        }
    }

    pub fn tasks_file(&self) -> PathBuf {
        PathBuf::from(jspath::join(&[&self.data_root, "schedules.json"]))
    }
    fn lock_file(&self) -> PathBuf {
        PathBuf::from(jspath::join(&[&self.data_root, "schedules.lock"]))
    }
    pub(crate) fn tasks_dir(&self) -> String {
        jspath::join(&[&self.data_root, "tasks"])
    }

    /// `load()`: the document, with `tasks` made `{}` when it is missing.
    pub fn load(&self) -> Result<Map<String, Value>, Failure> {
        let file = self.tasks_file();
        let mut data = match std::fs::read(&file) {
            // a file a power cut or crash zeroed: never read as "no tasks", which the next
            // change would write back over the person's schedules
            Ok(b) if crate::control::is_torn_state(&b) => {
                return Err(Failure::user(format!(
                    "{} is empty: a power cut or crash cut it off while it was being saved. The scheduled tasks themselves are still registered with the system; restore that file from a copy of the data folder, or delete it and add the schedules again with \"spawnloft task add\"",
                    file.display()
                )));
            }
            Ok(b) => match crate::jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax)? {
                Value::Object(m) => m,
                Value::Null => {
                    return Err(Failure::type_error(
                        "Cannot read properties of null (reading 'tasks')",
                    ));
                }
                _ => Map::new(),
            },
            Err(e) if jspath::is_enoent(&e) => {
                let mut m = Map::new();
                m.insert("version".into(), json!(1));
                m
            }
            Err(e) => return Err(Failure::read(&e, &file)),
        };
        if !matches!(data.get("tasks"), Some(Value::Object(_))) {
            data.insert("tasks".into(), Value::Object(Map::new()));
        }
        Ok(data)
    }

    /// The tasks of a loaded document.
    pub fn tasks(data: &Map<String, Value>) -> &Map<String, Value> {
        data.get("tasks")
            .and_then(Value::as_object)
            .expect("load makes tasks an object")
    }
    fn tasks_mut(data: &mut Map<String, Value>) -> &mut Map<String, Value> {
        data.get_mut("tasks")
            .and_then(Value::as_object_mut)
            .expect("load makes tasks an object")
    }

    fn save(&self, data: &Map<String, Value>) -> Result<(), Failure> {
        crate::fsx::write_json_node(&self.tasks_file(), &Value::Object(data.clone()), None, false).map(|_| ())
    }

    fn record(&self, instance: &Value, action: &str, detail: &str) {
        activity::record_by(
            &Roots::new(&self.data_root),
            &self.by,
            &js::string(Some(instance)),
            action,
            Some(detail),
            None,
            true,
        );
    }

    /// `withTasksLock(fn)`: every change is a read-modify-write of `schedules.json`.
    fn locked<T>(&self, f: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
        crate::fsx::mkdir_all(Path::new(&self.data_root))?;
        let lock = match crate::lock::acquire(&self.lock_file(), crate::lock::Options::wait(10_000)) {
            Ok(Some(l)) => l,
            _ => {
                return fail(
                    "another change to the scheduled tasks is still in progress; try again in a moment",
                );
            }
        };
        let out = f();
        let _ = lock.release();
        out
    }

    /// `list()`: every task with what the scheduler says of it (`windows`, null when the
    /// scheduler does not have it), by server then name.
    pub fn list(&self) -> Result<Vec<Value>, Failure> {
        let data = self.load()?;
        let tasks = Self::tasks(&data);
        let live = match native() {
            Some(Native::Mac) => mac::query(self, tasks),
            Some(Native::Linux) => linux::query(self, tasks),
            None => query_windows(),
        };
        let mut rows: Vec<Value> = tasks
            .iter()
            .map(|(id, task)| {
                let key = if native().is_some() {
                    id.clone()
                } else {
                    id.to_lowercase()
                };
                let mut row = with_id(id, task);
                row["windows"] = live.get(&key).cloned().unwrap_or(Value::Null);
                row
            })
            .collect();
        let text = |v: &Value, k: &str| js::string(v.get(k));
        rows.sort_by(|a, b| {
            crate::collate::compare(&text(a, "instance"), &text(b, "instance"))
                .then_with(|| crate::collate::compare(&text(a, "name"), &text(b, "name")))
        });
        Ok(rows)
    }

    /// `writeShim(id)`: the file the scheduler runs. On Windows a batch file naming this
    /// command line by absolute path.
    fn write_shim(&self, id: &str) -> Result<String, Failure> {
        if native().is_some() {
            return mac::write_shim(self, id);
        }
        let dir = self.tasks_dir();
        crate::fsx::mkdir_all(Path::new(&dir))?;
        let shim = jspath::join(&[&dir, &format!("{id}.cmd")]);
        let cli = crate::entry::cli_command(std::env::var(crate::entry::ENTRY_ENV).ok().as_deref());
        let mut lines = vec!["@echo off".to_string()];
        lines.extend(crate::entry::windows_run(&cli, &format!("task run {id}")));
        lines.push("exit /b %errorlevel%".into());
        let body = format!("{}\r\n", lines.join("\r\n"));
        std::fs::write(&shim, body).map_err(|e| Failure::io(&e, "open", Some(Path::new(&shim))))?;
        Ok(shim)
    }

    /// `rewriteShims()`: every task's shim written again for this install (relocate's repair).
    pub fn rewrite_shims(&self) -> Result<usize, Failure> {
        let data = self.load()?;
        let ids: Vec<String> = Self::tasks(&data).keys().cloned().collect();
        for id in &ids {
            self.write_shim(id)?;
        }
        Ok(ids.len())
    }

    /// `writeWindowsTask(id, task)`: the trigger written, overwriting by name (`/F`), so an edit
    /// keeps the id and the run history.
    fn write_task(&self, id: &str, task: &Value) -> Result<(), Failure> {
        match native() {
            Some(Native::Mac) => return mac::write(self, id, task),
            Some(Native::Linux) => return linux::write(self, id, task),
            None => {}
        }
        let shim = self.write_shim(id)?;
        let mut args = vec![
            "/Create".to_string(),
            "/TN".into(),
            format!("{TASK_FOLDER}\\{id}"),
            "/TR".into(),
            format!("\"{shim}\""),
        ];
        args.extend(trigger_args(task.get("schedule").unwrap_or(&Value::Null))?);
        args.push("/F".into());
        schtasks(&args)?;
        // /Create always makes an enabled task
        if !js::truthy(task.get("enabled")) {
            schtasks(&[
                "/Change".into(),
                "/TN".into(),
                format!("{TASK_FOLDER}\\{id}"),
                "/DISABLE".into(),
            ])?;
        }
        Ok(())
    }

    fn native_remove(&self, id: &str) -> Result<(), Failure> {
        match native() {
            Some(Native::Mac) => mac::remove(self, id),
            Some(Native::Linux) => linux::remove(self, id),
            None => Ok(()),
        }
    }

    /// `create({ instance, name, action, schedule, enabled, owner })`.
    pub fn create(&self, spec: &Value) -> Result<Value, Failure> {
        self.locked(|| self.create_locked(spec))
    }

    fn create_locked(&self, spec: &Value) -> Result<Value, Failure> {
        let instance = js::string(spec.get("instance"));
        registry::validate_name(&instance).map_err(Failure::user)?;
        let action = normalise_action(spec.get("action").unwrap_or(&Value::Null))?;
        let schedule = normalise_schedule(spec.get("schedule").unwrap_or(&Value::Null))?;
        let mut data = self.load()?;
        let kind = action["type"].as_str().unwrap_or("").to_string();
        // readable in Task Scheduler; validateName keeps the instance safe for a name and a path
        let base = format!("{instance}-{kind}");
        let mut id = base.clone();
        let mut n = 2;
        while js::truthy(Self::tasks(&data).get(&id)) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let name = if js::truthy(spec.get("name")) {
            js::string(spec.get("name"))
        } else {
            action_label(&kind).to_string()
        };
        let owner = spec
            .get("owner")
            .filter(|o| js::truthy(Some(o)))
            .cloned()
            .unwrap_or(Value::Null);
        let enabled = spec.get("enabled").is_none_or(|e| js::truthy(Some(e)));
        let task = json!({
            "instance": instance,
            "name": cut16(&name, 60),
            "action": action,
            "schedule": schedule,
            "enabled": enabled,
            "owner": owner,
            "createdAt": crate::time::iso_now(),
        });
        // RunAtLoad can fire as soon as launchd accepts the agent, so on launchd and systemd the
        // definition is saved first and taken back if the scheduler refuses
        if native().is_some() {
            Self::tasks_mut(&mut data).insert(id.clone(), task.clone());
            self.save(&data)?;
            if let Err(e) = self.write_task(&id, &task) {
                Self::tasks_mut(&mut data).shift_remove(&id);
                self.save(&data)?;
                return Err(e);
            }
        } else {
            self.write_task(&id, &task)?;
        }
        // saved only once the scheduler has it: a definition with no trigger never runs, while a
        // trigger with no definition fails loudly
        Self::tasks_mut(&mut data).insert(id.clone(), task.clone());
        self.save(&data)?;
        self.record(
            &task["instance"],
            "schedule-add",
            &format!("{} ({})", js::string(task.get("name")), action_words(&kind)),
        );
        Ok(with_id(&id, &task))
    }

    /// `update(id, patch)`: in place rather than removed and made again, since the id keys the
    /// run log. A key absent from `patch` keeps its value.
    pub fn update(&self, id: &str, patch: &Map<String, Value>) -> Result<Value, Failure> {
        self.locked(|| self.update_locked(id, patch))
    }

    /// `update(id, patch)` where the patch names `keys`, some of them undefined (left out of
    /// `patch`): the panel's edit names all four fields, so it is never only a toggle.
    pub fn update_naming(
        &self,
        id: &str,
        patch: &Map<String, Value>,
        keys: &[&str],
    ) -> Result<Value, Failure> {
        self.locked(|| self.update_locked_naming(id, patch, Some(keys)))
    }

    fn update_locked(&self, id: &str, patch: &Map<String, Value>) -> Result<Value, Failure> {
        self.update_locked_naming(id, patch, None)
    }

    fn update_locked_naming(
        &self,
        id: &str,
        patch: &Map<String, Value>,
        keys: Option<&[&str]>,
    ) -> Result<Value, Failure> {
        let mut data = self.load()?;
        let Some(current) = Self::tasks(&data).get(id).cloned() else {
            return fail(format!("no scheduled task \"{id}\""));
        };
        let mut task = match &current {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        if let Some(n) = patch.get("name") {
            let text = if js::truthy(Some(n)) {
                js::string(Some(n))
            } else {
                String::new()
            };
            task.insert("name".into(), json!(cut16(&text, 60)));
        }
        if let Some(a) = patch.get("action") {
            task.insert("action".into(), normalise_action(a)?);
        }
        if let Some(s) = patch.get("schedule") {
            task.insert("schedule".into(), normalise_schedule(s)?);
        }
        if let Some(e) = patch.get("enabled") {
            task.insert("enabled".into(), json!(js::truthy(Some(e))));
        }
        // ownership can be claimed (unowned tasks move this way) but not handed on
        let owner = [current.get("owner"), patch.get("owner")]
            .into_iter()
            .flatten()
            .find(|o| js::truthy(Some(o)))
            .cloned()
            .unwrap_or(Value::Null);
        task.insert("owner".into(), owner);
        let kind = task
            .get("action")
            .and_then(|a| a.get("type"))
            .map(|t| js::string(Some(t)))
            .unwrap_or_default();
        if !js::truthy(task.get("name")) {
            task.insert("name".into(), json!(action_label(&kind)));
        }
        // edited into something other than a backup, it leaves the Backups toggle
        if task.get("owner") == Some(&json!(OWNER_BACKUPS)) && kind != "backup" {
            task.insert("owner".into(), Value::Null);
        }
        let task = Value::Object(task);
        if native().is_some() {
            Self::tasks_mut(&mut data).insert(id.to_string(), task.clone());
            self.save(&data)?;
            if let Err(e) = self.write_task(id, &task) {
                Self::tasks_mut(&mut data).insert(id.to_string(), current);
                self.save(&data)?;
                return Err(e);
            }
        } else {
            self.write_task(id, &task)?;
        }
        Self::tasks_mut(&mut data).insert(id.to_string(), task.clone());
        self.save(&data)?;
        let toggle = |k: &str| k == "enabled" || k == "owner";
        let only_toggled = match keys {
            Some(keys) => keys.iter().all(|k| toggle(k)),
            None => patch.keys().all(|k| toggle(k)),
        };
        let action = if !only_toggled {
            "schedule-change"
        } else if js::truthy(task.get("enabled")) {
            "schedule-enable"
        } else {
            "schedule-disable"
        };
        self.record(&task["instance"], action, &js::string(task.get("name")));
        Ok(with_id(id, &task))
    }

    /// `setEnabled(id, enabled)`.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Value, Failure> {
        self.locked(|| self.set_enabled_locked(id, enabled))
    }

    fn set_enabled_locked(&self, id: &str, enabled: bool) -> Result<Value, Failure> {
        if native().is_some() {
            let mut patch = Map::new();
            patch.insert("enabled".into(), json!(enabled));
            return self.update_locked(id, &patch);
        }
        let mut data = self.load()?;
        if !Self::tasks(&data).contains_key(id) {
            return fail(format!("no scheduled task \"{id}\""));
        }
        schtasks(&[
            "/Change".into(),
            "/TN".into(),
            format!("{TASK_FOLDER}\\{id}"),
            if enabled { "/ENABLE" } else { "/DISABLE" }.into(),
        ])?;
        let tasks = Self::tasks_mut(&mut data);
        let task = tasks.get_mut(id).expect("checked above");
        if !task.is_object() {
            *task = Value::Object(Map::new());
        }
        task["enabled"] = json!(enabled);
        let task = task.clone();
        self.save(&data)?;
        self.record(
            &task["instance"],
            if enabled {
                "schedule-enable"
            } else {
                "schedule-disable"
            },
            &js::string(task.get("name")),
        );
        Ok(with_id(id, &task))
    }

    /// `remove(id)`.
    pub fn remove(&self, id: &str) -> Result<(), Failure> {
        self.locked(|| self.remove_locked(id))
    }

    fn remove_locked(&self, id: &str) -> Result<(), Failure> {
        let mut data = self.load()?;
        // the id also makes a path below
        let Some(gone) = Self::tasks(&data).get(id).cloned() else {
            return fail(format!("no scheduled task \"{id}\""));
        };
        let instance = gone.get("instance").cloned().unwrap_or(Value::Null);
        if native().is_some() {
            self.native_remove(id)?;
            Self::tasks_mut(&mut data).shift_remove(id);
            self.save(&data)?;
            self.record(&instance, "schedule-remove", &js::string(gone.get("name")));
            return Ok(());
        }
        // Windows first: a definition with no trigger is inert, a trigger with no definition
        // fails when it fires
        let res = run::run(
            "schtasks",
            &[
                "/Delete".into(),
                "/TN".into(),
                format!("{TASK_FOLDER}\\{id}"),
                "/F".into(),
            ],
            30_000,
            &[],
        );
        let said = format!("{}{}", res.stderr, res.stdout);
        if let Some(message) = res.error_message()
            && res.error_code() != Some("ENOENT")
        {
            return fail(format!("could not reach schtasks to delete \"{id}\": {message}"));
        }
        // "not there" is fine; any other refusal must not drop the record of a task Windows
        // still runs. The scheduler is asked, since schtasks words its errors per language.
        if res.status != Some(0) && still_in_windows(id) {
            return fail(format!(
                "Windows would not delete the task for \"{id}\", so it has been left alone: {}",
                js::trim(&said)
            ));
        }
        rm_force(&jspath::join(&[&self.tasks_dir(), &format!("{id}.cmd")]));
        Self::tasks_mut(&mut data).shift_remove(id);
        self.save(&data)?;
        self.record(&instance, "schedule-remove", &js::string(gone.get("name")));
        Ok(())
    }

    /// `runNow(id)`: starts a task through the scheduler, as its trigger would.
    pub fn run_now(&self, id: &str) -> Result<(), Failure> {
        let data = self.load()?;
        let Some(task) = Self::tasks(&data).get(id) else {
            return fail(format!("no scheduled task \"{id}\""));
        };
        match native() {
            Some(Native::Mac) => mac::run_now(self, id, task),
            Some(Native::Linux) => linux::run_now(self, id),
            None => schtasks(&["/Run".into(), "/TN".into(), format!("{TASK_FOLDER}\\{id}")]).map(|_| ()),
        }
    }

    /// `recentRuns(instance, limit)`: SpawnLoft's own lines in the server's `tasks.log`, newest
    /// first: `time, task id, status, action, detail`, or the older line without an id.
    pub fn recent_runs(&self, instance: &str, limit: usize) -> Result<Vec<Value>, Failure> {
        registry::validate_name(instance).map_err(Failure::user)?;
        let file = jspath::join(&[&self.run_dir, instance, "tasks.log"]);
        let Ok(bytes) = std::fs::read(&file) else {
            return Ok(Vec::new());
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut rows = Vec::new();
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if js::trim(line).is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            // an id is always "<instance>-<action>", never an outcome word
            let legacy = parts[1] == "ok" || parts[1] == "FAILED";
            let at = parts[0];
            let raw = if legacy { parts[1] } else { parts[2] };
            let status = if raw == "ok" || raw == "skipped" {
                raw
            } else {
                "FAILED"
            };
            let action = parts.get(if legacy { 2 } else { 3 }).copied();
            let detail = parts[if legacy { 3 } else { 4 }.min(parts.len())..].join("\t");
            if crate::jsdate::parse(at).is_nan() {
                continue;
            }
            let mut row = serde_json::Map::new();
            row.insert("at".into(), json!(at));
            row.insert("id".into(), if legacy { Value::Null } else { json!(parts[1]) });
            row.insert("status".into(), json!(status));
            // a line too short to name one leaves the key out, as `undefined` does in JSON
            if let Some(a) = action {
                row.insert("action".into(), json!(a));
            }
            row.insert("detail".into(), json!(detail));
            rows.push(Value::Object(row));
        }
        rows.reverse();
        rows.truncate(limit);
        Ok(rows)
    }

    /// `renameInstance(oldName, newName)`: task ids are `<instance>-<action>`, so they move with
    /// the server. Run log lines keep the old id, which is what the task was called when it ran.
    pub fn rename_instance(&self, old: &str, new: &str) -> Result<(usize, Vec<String>), Failure> {
        self.locked(|| self.rename_instance_locked(old, new))
    }

    fn rename_instance_locked(&self, old: &str, new: &str) -> Result<(usize, Vec<String>), Failure> {
        let mut data = self.load()?;
        struct Move {
            from: String,
            to: String,
            task: Value,
        }
        let mut moved = Vec::new();
        // ids taken during this rename count as taken, or two tasks falling back to the same
        // suffix would pick the same new id
        let mut claimed: std::collections::HashSet<String> = Self::tasks(&data).keys().cloned().collect();
        for (id, task) in Self::tasks(&data) {
            if task.get("instance") != Some(&json!(old)) {
                continue;
            }
            let suffix = match id.strip_prefix(&format!("{old}-")) {
                Some(s) => s.to_string(),
                None => js::string(task.get("action").and_then(|a| a.get("type"))),
            };
            let mut next = format!("{new}-{suffix}");
            let mut n = 2;
            while next != *id && claimed.contains(&next) {
                next = format!("{new}-{suffix}-{n}");
                n += 1;
            }
            claimed.insert(next.clone());
            let mut t = task.clone();
            t["instance"] = json!(new);
            moved.push(Move {
                from: id.clone(),
                to: next,
                task: t,
            });
        }
        if moved.is_empty() {
            return Ok((0, Vec::new()));
        }

        if native().is_some() {
            for m in &moved {
                // the new agent is staged disabled so a login trigger cannot fire mid-rename
                let mut staged = m.task.clone();
                staged["enabled"] = json!(false);
                Self::tasks_mut(&mut data).insert(m.to.clone(), staged.clone());
                self.save(&data)?;
                let original = Self::tasks(&data).get(&m.from).cloned().unwrap_or(Value::Null);
                let swapped = swap_registration(
                    &m.from,
                    &m.to,
                    |id| self.write_task(id, if id == m.to { &staged } else { &original }),
                    |id| self.native_remove(id),
                );
                if let Err(e) = swapped {
                    Self::tasks_mut(&mut data).shift_remove(&m.to);
                    self.save(&data)?;
                    return Err(e);
                }
                Self::tasks_mut(&mut data).shift_remove(&m.from);
                self.save(&data)?;
                if js::truthy(m.task.get("enabled")) {
                    let mut patch = Map::new();
                    patch.insert("enabled".into(), json!(true));
                    self.update_locked(&m.to, &patch)?;
                    Self::tasks_mut(&mut data).insert(m.to.clone(), m.task.clone());
                }
            }
            return Ok((moved.len(), Vec::new()));
        }

        // the new trigger goes in before the old one comes out, so a rename that fails half way
        // never loses the schedule
        let mut stranded = Vec::new();
        let tn = |id: &str| format!("{TASK_FOLDER}\\{id}");
        for m in &moved {
            if case_only_change(&m.from, &m.to) {
                let original = Self::tasks(&data).get(&m.from).cloned().unwrap_or(Value::Null);
                swap_registration(
                    &m.from,
                    &m.to,
                    |id| self.write_task(id, if id == m.to { &m.task } else { &original }),
                    // tolerant: a task Windows keeps is overwritten in place by the /F of the write
                    |id| {
                        let _ = schtasks(&["/Delete".into(), "/TN".into(), tn(id), "/F".into()]);
                        rm_force(&jspath::join(&[&self.tasks_dir(), &format!("{id}.cmd")]));
                        Ok(())
                    },
                )?;
                Self::tasks_mut(&mut data).shift_remove(&m.from);
                Self::tasks_mut(&mut data).insert(m.to.clone(), m.task.clone());
                self.save(&data)?;
                continue;
            }
            self.write_task(&m.to, &m.task)?;
            if m.to != m.from {
                let _ = schtasks(&["/Delete".into(), "/TN".into(), tn(&m.from), "/F".into()]);
                if still_in_windows(&m.from) {
                    // Windows kept the old trigger: its batch file stays, so the run finds no
                    // definition under the old id and logs that, rather than failing on a
                    // missing file
                    stranded.push(m.from.clone());
                } else {
                    rm_force(&jspath::join(&[&self.tasks_dir(), &format!("{}.cmd", m.from)]));
                }
                Self::tasks_mut(&mut data).shift_remove(&m.from);
            }
            Self::tasks_mut(&mut data).insert(m.to.clone(), m.task.clone());
            // written per task, so a failure part way keeps the record of the tasks moved
            self.save(&data)?;
        }
        Ok((moved.len(), stranded))
    }

    /// `removeForInstance(name)`: every task of a server, a stuck one passed over. Answers how
    /// many there were.
    pub fn remove_for_instance(&self, name: &str) -> Result<usize, Failure> {
        self.locked(|| {
            let data = self.load()?;
            let ids: Vec<String> = Self::tasks(&data)
                .iter()
                .filter(|(_, t)| t.get("instance") == Some(&json!(name)))
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                let _ = self.remove_locked(id);
            }
            Ok(ids.len())
        })
    }

    /// `removeAll()`, for uninstall: every task, then Task Scheduler's folder. Answers whether
    /// all went and the ids that did not.
    pub fn remove_all(&self) -> Result<(bool, Vec<String>), Failure> {
        self.locked(|| {
            let data = self.load()?;
            for id in Self::tasks(&data).keys() {
                let _ = self.remove_locked(id);
            }
            // schtasks cannot delete folders; the COM interface can, once the folder is empty
            if cfg!(windows) {
                run::run(
                    "powershell",
                    &[
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-Command".into(),
                        format!("$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteFolder('{TASK_FOLDER}', 0)"),
                    ],
                    30_000,
                    &[],
                );
            }
            // failed removals keep their shims and definitions
            let remaining: Vec<String> = Self::tasks(&self.load()?).keys().cloned().collect();
            if remaining.is_empty() {
                let _ = crate::manage::rm_rf(Path::new(&self.tasks_dir()));
            }
            Ok((remaining.is_empty(), remaining))
        })
    }
}

/// `fs.rmSync(file, { force: true })` for a file.
pub(crate) fn rm_force(file: &str) {
    let _ = std::fs::remove_file(file);
}

fn trigger_args(schedule: &Value) -> Result<Vec<String>, Failure> {
    let or = |k: &str, d: &str| {
        let v = schedule.get(k);
        if js::truthy(v) {
            js::string(v)
        } else {
            d.to_string()
        }
    };
    let at = or("at", "03:00");
    let kind = js::string(schedule.get("kind"));
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    Ok(match kind.as_str() {
        "hourly" => v(&["/SC", "HOURLY", "/MO", &or("every", "1")]),
        "daily" => v(&["/SC", "DAILY", "/ST", &at]),
        "weekly" => v(&[
            "/SC",
            "WEEKLY",
            "/D",
            &or("day", "SUN").to_uppercase(),
            "/ST",
            &at,
        ]),
        "minutes" => v(&["/SC", "MINUTE", "/MO", &or("every", "30")]),
        "onlogon" => v(&["/SC", "ONLOGON"]),
        other => return fail(format!("unknown schedule kind \"{other}\"")),
    })
}

/// `schtasks(args)`: the call, its failures in the Node core's words.
fn schtasks(args: &[String]) -> Result<String, Failure> {
    let res = run::run("schtasks", args, 30_000, &[]);
    if let Some(m) = res.error_message() {
        return fail(format!("could not run schtasks: {m}"));
    }
    if res.status != Some(0) {
        let said = if !res.stderr.is_empty() {
            &res.stderr
        } else {
            &res.stdout
        };
        return fail(format!("schtasks failed: {}", js::trim(said)));
    }
    Ok(res.stdout)
}

fn still_in_windows(id: &str) -> bool {
    let res = run::run(
        "schtasks",
        &["/Query".into(), "/TN".into(), format!("{TASK_FOLDER}\\{id}")],
        30_000,
        &[],
    );
    // cannot tell: assume it is there, since keeping a record is recoverable and dropping one is not
    if res.error.is_some() {
        return true;
    }
    res.status == Some(0)
}

/// `queryWindows()`: Task Scheduler's view of SpawnLoft's folder, by lower-cased task name. A
/// task missing there (deleted by hand) is absent rather than shown as working.
fn query_windows() -> Map<String, Value> {
    let mut out = Map::new();
    if !cfg!(windows) {
        return out;
    }
    let script = format!(
        "Get-ScheduledTask -TaskPath '\\{TASK_FOLDER}\\' -ErrorAction SilentlyContinue | ForEach-Object {{ $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{{ name=$_.TaskName; state=[string]$_.State; lastRun=$(if ($i.LastRunTime) {{ $i.LastRunTime.ToString(\"o\") }}); lastResult=$i.LastTaskResult; nextRun=$(if ($i.NextRunTime) {{ $i.NextRunTime.ToString(\"o\") }}) }} }} | ConvertTo-Json -Compress"
    );
    let Some(stdout) = run::exec_file(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script,
        ],
        30_000,
        &[],
    ) else {
        return out;
    };
    if js::trim(&stdout).is_empty() {
        return out;
    }
    let Ok(parsed) = crate::jsjson::parse(&stdout) else {
        return out;
    };
    let rows = match parsed {
        Value::Array(a) => a,
        one => vec![one],
    };
    for mut row in rows {
        // a task that never ran is reported as having run in 1999
        let early = row
            .get("lastRun")
            .filter(|v| js::truthy(Some(v)))
            .map(|v| crate::jsdate::parse(&js::string(Some(v))))
            .and_then(crate::jsdate::local_fields)
            .is_some_and(|f| f.year < 2000);
        if early && let Value::Object(m) = &mut row {
            m.insert("lastRun".into(), Value::Null);
        }
        out.insert(js::string(row.get("name")).to_lowercase(), row);
    }
    out
}

/// `caseOnlyChange(a, b)`: Task Scheduler names ignore case, and so do the plist and shim file
/// names on a default Windows or macOS disk, so `gamma-backup` and `Gamma-backup` are one task.
pub fn case_only_change(a: &str, b: &str) -> bool {
    a != b && a.to_lowercase() == b.to_lowercase()
}

/// `swapRegistration(from, to, { write, remove })` (#233): normally the new registration goes
/// in before the old one comes out, so a failure never loses the schedule. When only the
/// capitals change that order would destroy the task (writing the new id overwrites the old one,
/// removing the old id then removes the new one), so the old one comes out first and is put back
/// if the write fails.
pub fn swap_registration(
    from: &str,
    to: &str,
    write: impl Fn(&str) -> Result<(), Failure>,
    remove: impl Fn(&str) -> Result<(), Failure>,
) -> Result<(), Failure> {
    if !case_only_change(from, to) {
        write(to)?;
        if let Err(e) = remove(from) {
            let _ = remove(to);
            return Err(e);
        }
        return Ok(());
    }
    // a removal that fails part way (files gone, then launchctl or systemctl refuses) is put back too
    let swapped = remove(from).and_then(|()| write(to));
    if let Err(e) = swapped {
        let _ = write(from);
        return Err(e);
    }
    Ok(())
}

/// `nextCalendarRun(schedule, now)`: the next daily or weekly firing, in this machine's local
/// time; null for the other kinds.
pub fn next_calendar_run(schedule: &Value, now_ms: f64) -> Option<String> {
    use crate::jsdate;
    let kind = schedule.get("kind").and_then(Value::as_str)?;
    if kind != "daily" && kind != "weekly" {
        return None;
    }
    let at = js::string(schedule.get("at"));
    let mut parts = at.split(':').map(js::string_to_number);
    let hour = parts.next().unwrap_or(f64::NAN);
    let minute = parts.next().unwrap_or(f64::NAN);
    let mut next = jsdate::set_hours(now_ms, hour, minute, 0.0, 0.0);
    let date_of = |t: f64| jsdate::local_fields(t).map_or(f64::NAN, |f| f64::from(f.day));
    if next <= now_ms {
        next = jsdate::set_date(next, date_of(next) + 1.0);
    }
    if kind == "weekly" {
        let days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
        let want = js::string(schedule.get("day"));
        let day = days.iter().position(|d| *d == want).map_or(-1.0, |p| p as f64);
        let local = next + jsdate::offset_at(next);
        let today = ((local / 86_400_000.0).floor() + 4.0).rem_euclid(7.0);
        next = jsdate::set_date(next, date_of(next) + (day - today + 7.0) % 7.0);
    }
    jsdate::to_iso(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_are_checked_like_the_node_core() {
        assert_eq!(
            crate::jsjson::stringify(
                &normalise_schedule(&json!({ "kind": "hourly", "every": 2, "x": 1 })).unwrap()
            ),
            crate::jsjson::stringify(&json!({ "kind": "hourly", "every": 2 }))
        );
        assert_eq!(
            normalise_schedule(&json!({ "kind": "minutes", "every": 1440 }))
                .unwrap_err()
                .message(),
            "the largest minutes interval Windows accepts is 1439"
        );
        assert_eq!(
            normalise_schedule(&json!({ "kind": "daily", "at": "24:00" }))
                .unwrap_err()
                .message(),
            "\"24:00\" is not a time - use HH:MM on a 24 hour clock"
        );
        assert_eq!(
            crate::jsjson::stringify(
                &normalise_schedule(&json!({ "kind": "weekly", "day": "mon", "at": "23:59" })).unwrap()
            ),
            crate::jsjson::stringify(&json!({ "kind": "weekly", "day": "MON", "at": "23:59" }))
        );
        assert_eq!(
            normalise_schedule(&json!({ "kind": "weekly", "at": "01:00" }))
                .unwrap_err()
                .message(),
            "\"undefined\" is not a day - use one of MON, TUE, WED, THU, FRI, SAT, SUN"
        );
        assert_eq!(
            normalise_schedule(&json!({ "kind": "yearly" }))
                .unwrap_err()
                .message(),
            "unknown schedule kind \"yearly\" - expected one of minutes, hourly, daily, weekly, onlogon"
        );
    }

    #[test]
    fn actions_keep_only_their_fields() {
        assert_eq!(
            crate::jsjson::stringify(&normalise_action(&json!({ "type": "backup", "keep": 3.5 })).unwrap()),
            crate::jsjson::stringify(&json!({ "type": "backup", "keep": null }))
        );
        assert_eq!(
            crate::jsjson::stringify(
                &normalise_action(&json!({ "type": "restart", "warnMinutes": 90 })).unwrap()
            ),
            crate::jsjson::stringify(&json!({ "type": "restart", "warnMinutes": 60 }))
        );
        assert_eq!(
            crate::jsjson::stringify(
                &normalise_action(&json!({ "type": "command", "line": "  say hi " })).unwrap()
            ),
            crate::jsjson::stringify(&json!({ "type": "command", "line": "say hi" }))
        );
        assert_eq!(
            crate::jsjson::stringify(&normalise_action(&json!({ "type": "stop", "line": "x" })).unwrap()),
            crate::jsjson::stringify(&json!({ "type": "stop" }))
        );
        assert!(normalise_action(&json!({ "type": "rm -rf" })).is_err());
    }

    #[test]
    fn results_read_as_words() {
        assert_eq!(describe_result(Some(&json!(267011))), "not run yet");
        assert_eq!(describe_result(Some(&json!(3))), "failed (exit 3)");
        assert_eq!(describe_result(None), "unknown");
    }

    #[test]
    fn a_capitals_only_change_takes_the_old_registration_out_first() {
        use std::cell::RefCell;
        let log = RefCell::new(Vec::new());
        swap_registration(
            "Gamma-backup",
            "gamma-backup",
            |id| {
                log.borrow_mut().push(format!("write {id}"));
                Ok(())
            },
            |id| {
                log.borrow_mut().push(format!("remove {id}"));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*log.borrow(), ["remove Gamma-backup", "write gamma-backup"]);
        log.borrow_mut().clear();
        let r = swap_registration(
            "Gamma-backup",
            "gamma-backup",
            |id| {
                log.borrow_mut().push(format!("write {id}"));
                if id == "gamma-backup" {
                    Err(Failure::user("no"))
                } else {
                    Ok(())
                }
            },
            |id| {
                log.borrow_mut().push(format!("remove {id}"));
                Ok(())
            },
        );
        assert!(r.is_err());
        assert_eq!(
            *log.borrow(),
            ["remove Gamma-backup", "write gamma-backup", "write Gamma-backup"]
        );
        log.borrow_mut().clear();
        swap_registration(
            "a-backup",
            "b-backup",
            |id| {
                log.borrow_mut().push(format!("write {id}"));
                Ok(())
            },
            |id| {
                log.borrow_mut().push(format!("remove {id}"));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*log.borrow(), ["write b-backup", "remove a-backup"]);
    }

    #[test]
    fn the_next_calendar_run_is_today_or_later() {
        // 2026-09-13 was a Sunday; TZ is the machine's, so only compare the shape and order
        let now = crate::jsdate::parse("2026-09-13T12:00:00Z");
        let next = next_calendar_run(&json!({ "kind": "weekly", "day": "MON", "at": "03:00" }), now).unwrap();
        assert!(crate::jsdate::parse(&next) > now);
        assert!(next_calendar_run(&json!({ "kind": "hourly", "every": 1 }), now).is_none());
    }
}
