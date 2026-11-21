//! `schedule-linux.mjs`: systemd user units that run `spawnloft task run <id>`; what a task
//! does stays in `schedules.json`. No root needed. Without lingering, user units only run while
//! the person is logged in.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::run::{self, Ran};
use super::{Sched, fail};
use crate::failure::Failure;
use crate::{js, jspath};

pub fn label(s: &Sched, id: &str) -> Result<String, Failure> {
    super::mac::check_id(id)?;
    Ok(format!("spawnloft-{}-{id}", super::mac::namespace(&s.data_root)))
}

fn unit_dir() -> String {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| jspath::join(&[&super::mac::homedir(), ".config"]));
    jspath::join(&[&base, "systemd", "user"])
}

fn service(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(format!("{}.service", label(s, id)?))
}
fn timer(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(format!("{}.timer", label(s, id)?))
}
pub fn service_file(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(jspath::join(&[&unit_dir(), &service(s, id)?]))
}
pub fn timer_file(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(jspath::join(&[&unit_dir(), &timer(s, id)?]))
}
fn shim_file(s: &Sched, id: &str) -> String {
    jspath::join(&[&s.data_root, "tasks", &format!("{id}.sh")])
}

/// Unit files expand `%` specifiers everywhere and `$VARIABLES` in `ExecStart`.
fn literal(v: &str) -> String {
    v.replace('%', "%%")
}
fn argument(v: &str) -> String {
    format!(
        "\"{}\"",
        literal(v)
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "$$")
    )
}

fn day_of(d: &str) -> Option<&'static str> {
    Some(match d {
        "MON" => "Mon",
        "TUE" => "Tue",
        "WED" => "Wed",
        "THU" => "Thu",
        "FRI" => "Fri",
        "SAT" => "Sat",
        "SUN" => "Sun",
        _ => return None,
    })
}

fn interval_seconds(schedule: &Value) -> f64 {
    let unit = if schedule.get("kind") == Some(&json!("minutes")) {
        60.0
    } else {
        3600.0
    };
    js::number(schedule.get("every")) * unit
}

fn internal(message: &str) -> Failure {
    Failure::Internal {
        head: "Error".into(),
        message: message.into(),
        code: None,
    }
}

/// `trigger(schedule)`: the `[Timer]` lines, `None` for at-logon, which has no timer.
pub fn trigger(schedule: &Value) -> Result<Option<Vec<String>>, Failure> {
    let kind = schedule.get("kind").and_then(Value::as_str).unwrap_or("");
    Ok(Some(match kind {
        "minutes" | "hourly" => {
            let secs = js::number_to_string(interval_seconds(schedule));
            // OnActiveSec starts the clock at load; OnUnitActiveSec keeps it going
            vec![
                format!("OnActiveSec={secs}s"),
                format!("OnUnitActiveSec={secs}s"),
                "AccuracySec=1s".into(),
            ]
        }
        "daily" | "weekly" => {
            let day = if kind == "weekly" {
                let d = js::string(schedule.get("day"));
                format!(
                    "{} ",
                    day_of(&d).ok_or_else(|| internal("Unknown systemd weekday"))?
                )
            } else {
                String::new()
            };
            // Persistent: a run missed while the machine was off fires once on return
            vec![
                format!("OnCalendar={day}*-*-* {}:00", js::string(schedule.get("at"))),
                "Persistent=true".into(),
                "AccuracySec=1s".into(),
            ]
        }
        // the service itself, wanted by default.target: reached when the user's systemd starts
        "onlogon" => return Ok(None),
        _ => return Err(internal("Unknown systemd schedule")),
    }))
}

pub fn service_unit(s: &Sched, id: &str, task: &Value) -> Result<String, Failure> {
    let tasks = jspath::join(&[&s.data_root, "tasks"]);
    let mut lines = vec![
        "[Unit]".to_string(),
        format!("Description=SpawnLoft task {id}"),
        String::new(),
        "[Service]".into(),
        "Type=oneshot".into(),
        format!("ExecStart=/bin/sh {}", argument(&shim_file(s, id))),
        format!("WorkingDirectory={}", literal(&s.data_root)),
        // server daemons must outlive the task: the default control-group mode kills everything
        // the task spawned when it exits
        "KillMode=process".into(),
        format!(
            "StandardOutput=append:{}",
            literal(&jspath::join(&[&tasks, &format!("{id}.stdout.log")]))
        ),
        format!(
            "StandardError=append:{}",
            literal(&jspath::join(&[&tasks, &format!("{id}.stderr.log")]))
        ),
    ];
    if task.get("schedule").and_then(|s| s.get("kind")) == Some(&json!("onlogon")) {
        lines.extend([
            String::new(),
            "[Install]".into(),
            "WantedBy=default.target".into(),
        ]);
    }
    Ok(lines.join("\n") + "\n")
}

pub fn timer_unit(id: &str, task: &Value) -> Result<Option<String>, Failure> {
    let Some(lines) = trigger(task.get("schedule").unwrap_or(&Value::Null))? else {
        return Ok(None);
    };
    let mut all = vec![
        "[Unit]".to_string(),
        format!("Description=SpawnLoft schedule {id}"),
        String::new(),
        "[Timer]".into(),
    ];
    all.extend(lines);
    all.extend([String::new(), "[Install]".into(), "WantedBy=timers.target".into()]);
    Ok(Some(all.join("\n") + "\n"))
}

fn systemctl(args: &[&str]) -> Ran {
    let mut all = vec!["--user".to_string()];
    all.extend(args.iter().map(|a| a.to_string()));
    run::run("systemctl", &all, 15_000, &[])
}

fn checked(args: &[&str]) -> Result<String, Failure> {
    let res = systemctl(args);
    if res.error_code() == Some("ENOENT") {
        return fail(
            "Linux scheduler: systemd is not available on this machine, so tasks cannot be scheduled here.",
        );
    }
    if !res.ok() {
        let said = [
            res.error_message().unwrap_or(""),
            js::trim(&res.stderr),
            js::trim(&res.stdout),
            "systemctl failed",
        ]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or("")
        .to_string();
        let lower = said.to_lowercase();
        // what a container or WSL without systemd says
        if lower.contains("failed to connect to bus") || lower.contains("no medium found") {
            return fail(
                "Linux scheduler: this session has no systemd user instance, so tasks cannot be scheduled here.",
            );
        }
        return fail(format!("Linux scheduler: {said}"));
    }
    Ok(res.stdout)
}

fn is_running_state(state: &str) -> bool {
    matches!(state, "activating" | "active" | "deactivating")
}

/// A running oneshot is `activating`, never `active`.
fn running(s: &Sched, id: &str) -> Result<bool, Failure> {
    Ok(is_running_state(js::trim(
        &systemctl(&["is-active", &service(s, id)?]).stdout,
    )))
}

fn enabled(unit: &str) -> bool {
    js::trim(&systemctl(&["is-enabled", unit]).stdout) == "enabled"
}

fn unload(s: &Sched, id: &str) -> Result<(), Failure> {
    // unknown units are fine; real problems surface at the reload
    systemctl(&["disable", "--now", &timer(s, id)?]);
    systemctl(&["disable", &service(s, id)?]);
    Ok(())
}

fn install(s: &Sched, id: &str, task: &Value) -> Result<(), Failure> {
    let timer_text = timer_unit(id, task)?;
    super::mac::write_mode(
        &service_file(s, id)?,
        service_unit(s, id, task)?.as_bytes(),
        0o600,
    )?;
    match timer_text {
        Some(t) => super::mac::write_mode(&timer_file(s, id)?, t.as_bytes(), 0o600)?,
        None => super::rm_force(&timer_file(s, id)?),
    }
    checked(&["daemon-reload"])?;
    if !js::truthy(task.get("enabled")) {
        return Ok(());
    }
    // no --now for the logon service: enabling must not run it
    if task.get("schedule").and_then(|s| s.get("kind")) == Some(&json!("onlogon")) {
        checked(&["enable", &service(s, id)?])?;
    } else {
        checked(&["enable", "--now", &timer(s, id)?])?;
    }
    Ok(())
}

/// `write(id, task)`: the units replaced, put back as they were when systemd refuses them.
pub fn write(s: &Sched, id: &str, task: &Value) -> Result<(), Failure> {
    // a running backup or restart is not interrupted to edit its schedule
    if running(s, id)? {
        return fail("This task is running. Wait for it to finish before editing it.");
    }
    let svc_file = service_file(s, id)?;
    let tmr_file = timer_file(s, id)?;
    let prev_service = std::fs::read(&svc_file).ok();
    let prev_timer = std::fs::read(&tmr_file).ok();
    let timer_on = enabled(&timer(s, id)?);
    let service_on = enabled(&service(s, id)?);
    super::mac::write_shim(s, id)?;
    crate::fsx::mkdir_all(Path::new(&unit_dir()))?;
    unload(s, id)?;
    if let Err(e) = install(s, id, task) {
        unload(s, id)?;
        for (file, bytes) in [(&svc_file, &prev_service), (&tmr_file, &prev_timer)] {
            match bytes {
                Some(b) => {
                    let _ = std::fs::write(file, b);
                }
                None => super::rm_force(file),
            }
        }
        systemctl(&["daemon-reload"]);
        if timer_on {
            systemctl(&["enable", "--now", &timer(s, id)?]);
        }
        if service_on {
            systemctl(&["enable", &service(s, id)?]);
        }
        return Err(e);
    }
    Ok(())
}

/// `remove(id)`.
pub fn remove(s: &Sched, id: &str) -> Result<(), Failure> {
    if running(s, id)? {
        return fail("This task is running. Wait for it to finish before removing it.");
    }
    unload(s, id)?;
    super::rm_force(&timer_file(s, id)?);
    super::rm_force(&service_file(s, id)?);
    super::rm_force(&shim_file(s, id));
    checked(&["daemon-reload"])?;
    // a failed unit is remembered after its file is gone
    systemctl(&["reset-failed", &service(s, id)?, &timer(s, id)?]);
    Ok(())
}

/// `runNow(id)`.
pub fn run_now(s: &Sched, id: &str) -> Result<(), Failure> {
    if running(s, id)? {
        return fail("This task is already running.");
    }
    // --no-block: the caller wants it started, not finished
    checked(&["start", "--no-block", &service(s, id)?]).map(|_| ())
}

/// `os.userInfo().username`: this user's entry in the password database.
fn username() -> String {
    #[cfg(target_os = "linux")]
    if let Some(name) = crate::platform::user_name(crate::platform::uid()) {
        return name;
    }
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default()
}

/// `linger()`: whether this account's systemd outlives its login sessions; `None` when there
/// is no logind to ask.
pub fn linger() -> Option<bool> {
    let user = username();
    let res = run::run(
        "loginctl",
        &[
            "show-user".into(),
            user,
            "--property=Linger".into(),
            "--value".into(),
        ],
        5_000,
        &[],
    );
    if !res.ok() {
        return None;
    }
    Some(js::trim(&res.stdout) == "yes")
}

/// `sessionKind()`: desktop or headless, which decides how loudly to warn that lingering is
/// off. SSH first: a session with X forwarding has a display but is still remote.
pub fn session_kind() -> &'static str {
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if set("SSH_CONNECTION") || set("SSH_TTY") {
        return "headless";
    }
    if set("DISPLAY") || set("WAYLAND_DISPLAY") {
        "desktop"
    } else {
        "headless"
    }
}

/// `enableLinger()`: a policy that wants a password gets the command to run in a terminal.
pub fn enable_linger() -> Result<(), Failure> {
    let user = username();
    let res = run::run("loginctl", &["enable-linger".into(), user.clone()], 15_000, &[]);
    if res.error_code() == Some("ENOENT") {
        return fail("This machine has no loginctl, so lingering cannot be turned on from here.");
    }
    if !res.ok() || linger() != Some(true) {
        return fail(format!(
            "This account is not allowed to turn lingering on by itself. Run this in a terminal, then reload: sudo loginctl enable-linger {user}"
        ));
    }
    Ok(())
}

/// `parseShow(text)`: `systemctl show` for several units, `Key=Value` blocks between blank lines.
pub fn parse_show(text: &str) -> Map<String, Value> {
    let mut units = Map::new();
    let mut blocks = Vec::new();
    let mut cur = Vec::new();
    for line in text.split('\n') {
        if js::trim(line).is_empty() {
            blocks.push(std::mem::take(&mut cur));
        } else {
            cur.push(line);
        }
    }
    blocks.push(cur);
    for block in blocks {
        let mut props = Map::new();
        for line in block {
            if let Some(at) = line.find('=').filter(|a| *a > 0) {
                props.insert(line[..at].to_string(), json!(&line[at + 1..]));
            }
        }
        if let Some(id) = props.get("Id").and_then(Value::as_str).filter(|i| !i.is_empty()) {
            units.insert(id.to_string(), Value::Object(props));
        }
    }
    units
}

/// `Sun 2026-09-20 21:52:14 UTC` as an ISO time; `None` for nothing or `n/a`.
fn systemd_time(v: Option<&Value>) -> Option<String> {
    let text = js::trim(v.and_then(Value::as_str).unwrap_or("")).to_string();
    let b = text.as_bytes();
    let word = b.len() == 27
        && b[..3].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        && b[3] == b' '
        && b[23..] == *b" UTC";
    if !word {
        return None;
    }
    let date = &text[4..14];
    let time = &text[15..23];
    let shape = |s: &str, sep: u8, at: &[usize]| {
        s.bytes().enumerate().all(|(i, c)| {
            if at.contains(&i) {
                c == sep
            } else {
                c.is_ascii_digit()
            }
        })
    };
    if text.as_bytes()[14] != b' ' || !shape(date, b'-', &[4, 7]) || !shape(time, b':', &[2, 5]) {
        return None;
    }
    crate::jsdate::to_iso(crate::jsdate::parse(&format!("{date}T{time}Z")))
}

/// `describe(id, task, units, lastRun, now)`: one task's row; `None` when systemd does not have
/// its units.
pub fn describe(
    s: &Sched,
    id: &str,
    task: &Value,
    units: &Map<String, Value>,
    last_run: Option<Value>,
    now_ms: f64,
) -> Option<Value> {
    let svc = units.get(&service(s, id).ok()?)?;
    if svc.get("LoadState") != Some(&json!("loaded")) {
        return None;
    }
    let clock = units.get(&timer(s, id).ok()?);
    let schedule = task.get("schedule").cloned().unwrap_or(Value::Null);
    let kind = js::string(schedule.get("kind"));
    if kind != "onlogon" && clock.is_none_or(|c| c.get("LoadState") != Some(&json!("loaded"))) {
        return None;
    }
    let ran = systemd_time(svc.get("ExecMainExitTimestamp"));
    let last = last_run
        .filter(|v| !v.is_null())
        .or_else(|| ran.clone().map(Value::String))
        .unwrap_or(Value::Null);
    let result = if ran.is_some() {
        crate::jsjson::num(js::number(svc.get("ExecMainStatus")))
    } else {
        Value::Null
    };
    let row = |state: &str, next: Value| json!({ "lastRun": last, "lastResult": result, "nextRun": next, "state": state });
    if is_running_state(&js::string(svc.get("ActiveState"))) {
        return Some(row("Running", Value::Null));
    }
    if !js::truthy(task.get("enabled")) {
        return Some(row("Disabled", Value::Null));
    }
    let clock = clock.cloned().unwrap_or(Value::Null);
    let next = if kind == "daily" || kind == "weekly" {
        systemd_time(clock.get("NextElapseUSecRealtime"))
            .or_else(|| super::next_calendar_run(&schedule, now_ms))
    } else if kind != "onlogon" {
        // interval timers run on the monotonic clock: the next run is the last firing (or the
        // load) plus the interval
        systemd_time(clock.get("LastTriggerUSec"))
            .or_else(|| systemd_time(clock.get("ActiveEnterTimestamp")))
            .and_then(|from| {
                crate::jsdate::to_iso(crate::jsdate::parse(&from) + interval_seconds(&schedule) * 1000.0)
            })
    } else {
        None
    };
    Some(row("Ready", next.map_or(Value::Null, Value::String)))
}

const SHOWN: &str = "Id,LoadState,ActiveState,ExecMainStatus,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec,ActiveEnterTimestamp";

/// `query(tasks, recentRuns)`: what systemd says of each task (asked in UTC, in the C locale).
pub fn query(s: &Sched, tasks: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if tasks.is_empty() {
        return out;
    }
    let mut args = vec!["--user".to_string(), "show".into(), format!("--property={SHOWN}")];
    for id in tasks.keys() {
        let (Ok(a), Ok(b)) = (service(s, id), timer(s, id)) else {
            return out;
        };
        args.push(a);
        args.push(b);
    }
    let Some(text) = run::exec_file("systemctl", &args, 5_000, &[("TZ", "UTC"), ("LC_ALL", "C")]) else {
        return out;
    };
    let units = parse_show(&text);
    let now = crate::time::now_ms() as f64;
    for (id, task) in tasks {
        let instance = js::string(task.get("instance"));
        let last = s
            .recent_runs(&instance, 40)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.get("id") == Some(&json!(id)))
            .and_then(|r| r.get("at").cloned());
        if let Some(row) = describe(s, id, task, &units, last, now) {
            out.insert(id.clone(), row);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched() -> Sched {
        Sched::new("/d/100%", "/d/run", crate::activity::Actor::new("cli", None))
    }

    #[test]
    fn units_say_what_the_node_core_writes() {
        assert_eq!(
            trigger(&json!({ "kind": "minutes", "every": 17 }))
                .unwrap()
                .unwrap(),
            ["OnActiveSec=1020s", "OnUnitActiveSec=1020s", "AccuracySec=1s"]
        );
        assert_eq!(
            trigger(&json!({ "kind": "weekly", "day": "SUN", "at": "23:59" }))
                .unwrap()
                .unwrap(),
            [
                "OnCalendar=Sun *-*-* 23:59:00",
                "Persistent=true",
                "AccuracySec=1s"
            ]
        );
        assert!(trigger(&json!({ "kind": "onlogon" })).unwrap().is_none());
        let unit = service_unit(&sched(), "x-start", &json!({ "schedule": { "kind": "onlogon" } })).unwrap();
        assert!(unit.contains("ExecStart=/bin/sh \"/d/100%%/tasks/x-start.sh\"\n"));
        assert!(unit.ends_with("[Install]\nWantedBy=default.target\n"));
    }

    #[test]
    fn show_blocks_and_times() {
        let units = parse_show("Id=a\nLoadState=loaded\n\nId=b\nX=1=2\n");
        assert_eq!(units["b"]["X"], json!("1=2"));
        assert_eq!(
            systemd_time(Some(&json!("Sun 2026-09-13 08:00:00 UTC"))).as_deref(),
            Some("2026-09-13T08:00:00.000Z")
        );
        assert_eq!(systemd_time(Some(&json!("n/a"))), None);
    }
}
