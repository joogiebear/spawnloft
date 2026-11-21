//! Scheduled tasks and the commands that move or drop a server with its tasks (C6): `task`
//! (list, add, run, rm, enable, disable, linger), `rm` (and `remove`) and `rename`, as
//! `cmdTask`, `runTask`, `cmdRemove` and `cmdRename` in mcctl.mjs answer them, over
//! spawnloft-lib's `schedule` and `manage`.

use std::path::Path;

use serde_json::{Value, json};

use spawnloft_lib::activity::Actor;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::schedule::{self, Sched, steps};
use spawnloft_lib::supervisor::{self, StartOptions};
use spawnloft_lib::{backup, control, js, jsdate, manage, notify, registry, text};

use super::args::Flag;
use super::create::flag_value;
use super::lifecycle::cli;
use super::{Ctx, require_name};

fn sched(ctx: &Ctx<'_>, by: Actor) -> Sched {
    Sched::new(&ctx.layout.data_root, &ctx.layout.run_dir, by)
}

fn positional(ctx: &Ctx<'_>, i: usize) -> Option<String> {
    ctx.args.positional.get(i).filter(|s| !s.is_empty()).cloned()
}

/// `localMinute(iso)`: Windows reports local time with an offset, launchd and systemd UTC, so
/// the string is read as a time and shown as this machine's local minute.
fn local_minute(iso: &str) -> String {
    let at = jsdate::parse(iso);
    match jsdate::local_fields(at) {
        Some(f) => format!(
            "{}-{:02}-{:02} {:02}:{:02}",
            f.year, f.month, f.day, f.hour, f.minute
        ),
        None => {
            let t = iso.replace('T', " ");
            let units: Vec<u16> = t.encode_utf16().take(16).collect();
            String::from_utf16_lossy(&units)
        }
    }
}

/// `describeSchedule(s)`.
fn describe_schedule(s: &Value) -> String {
    let f = |k: &str| js::string(s.get(k));
    match s.get("kind").and_then(Value::as_str).unwrap_or("") {
        "hourly" => {
            if js::number(s.get("every")) > 1.0 {
                format!("every {}h", f("every"))
            } else {
                "hourly".into()
            }
        }
        "minutes" => format!("every {}m", f("every")),
        "weekly" => format!("{} {}", f("day"), f("at")),
        "onlogon" => "at logon".into(),
        _ => format!("daily {}", f("at")),
    }
}

pub fn task(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let sub = positional(ctx, 0).unwrap_or_else(|| "list".into());
    let s = sched(ctx, cli());
    match sub.as_str() {
        "list" => list(ctx, &s),
        "linger" => {
            // Linux only: whether this account's tasks outlive its login session
            match ctx.args.positional.get(1).map(String::as_str) {
                Some("on") => {
                    schedule::keep_running_logged_out()?;
                    ctx.out
                        .line("Lingering is on. Tasks now run whether or not you are logged in, from boot.");
                }
                Some(_) => return Err(Failure::user("usage: spawnloft task linger [on]")),
                None => {
                    for line in schedule::logged_out_note() {
                        ctx.out.line(&line);
                    }
                }
            }
            Ok(())
        }
        "run" => {
            let Some(id) = positional(ctx, 1) else {
                return Err(Failure::user("usage: spawnloft task run <id>"));
            };
            // the task's actions are the schedule's, in the activity log
            let data = s.load()?;
            let name = Sched::tasks(&data)
                .get(&id)
                .and_then(|t| t.get("name"))
                .filter(|n| !n.is_null())
                .map_or_else(|| id.clone(), |n| js::string(Some(n)));
            run_task(ctx, &id, Actor::new("schedule", Some(&name)))
        }
        "add" => add(ctx, &s),
        "rm" => {
            let Some(id) = positional(ctx, 1) else {
                return Err(Failure::user("usage: spawnloft task rm <id>"));
            };
            s.remove(&id)?;
            ctx.out.line(&format!("Removed \"{id}\"."));
            Ok(())
        }
        "enable" | "disable" => {
            let Some(id) = positional(ctx, 1) else {
                return Err(Failure::user(format!("usage: spawnloft task {sub} <id>")));
            };
            let on = sub == "enable";
            s.set_enabled(&id, on)?;
            ctx.out
                .line(&format!("{} \"{id}\".", if on { "Enabled" } else { "Disabled" }));
            Ok(())
        }
        _ => Err(Failure::user(
            "usage: spawnloft task [list|add|run|rm|enable|disable|linger]",
        )),
    }
}

fn list(ctx: &mut Ctx<'_>, s: &Sched) -> Result<(), Failure> {
    let tasks = s.list()?;
    if tasks.is_empty() {
        ctx.out.line("No scheduled tasks.");
        ctx.out.line("");
        ctx.out
            .line("  Add one with: spawnloft task add <instance> --do backup --daily 03:00");
        return Ok(());
    }
    let mut rows = vec![
        ["ID", "INSTANCE", "DOES", "WHEN", "STATE", "LAST", "NEXT"]
            .map(String::from)
            .to_vec(),
    ];
    for t in &tasks {
        let w = t.get("windows").filter(|w| js::truthy(Some(w)));
        let action = t.get("action").cloned().unwrap_or(Value::Null);
        let does = if action.get("type") == Some(&json!("steps")) {
            action
                .get("steps")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(steps::describe_step)
                        .collect::<Vec<_>>()
                        .join(", then ")
                })
                .unwrap_or_default()
        } else {
            js::string(action.get("type"))
        };
        let state = if !js::truthy(t.get("enabled")) {
            "disabled".to_string()
        } else {
            match w {
                Some(w) => js::string(w.get("state")),
                None => "NOT IN SCHEDULER".into(),
            }
        };
        let next = w
            .and_then(|w| w.get("nextRun"))
            .filter(|n| js::truthy(Some(n)))
            .map_or_else(|| "-".to_string(), |n| local_minute(&js::string(Some(n))));
        rows.push(vec![
            js::string(t.get("id")),
            js::string(t.get("instance")),
            does,
            describe_schedule(t.get("schedule").unwrap_or(&Value::Null)),
            state,
            w.map_or_else(|| "-".into(), |w| schedule::describe_result(w.get("lastResult"))),
            next,
        ]);
    }
    ctx.out.line(&text::table(&rows));
    ctx.out.line("");
    for line in schedule::logged_out_note() {
        ctx.out.line(&line);
    }
    Ok(())
}

fn add(ctx: &mut Ctx<'_>, s: &Sched) -> Result<(), Failure> {
    let Some(instance) = positional(ctx, 1) else {
        return Err(Failure::user(
            "usage: spawnloft task add <instance> --do <backup|command|restart|stop|start> [when]",
        ));
    };
    registry::lookup(Path::new(&ctx.layout.registry_file), &instance)?;
    let kind = match flag_value(ctx, "do") {
        Value::Null => "backup".to_string(),
        v => js::string(Some(&v)),
    };
    let mut action = json!({ "type": kind });
    if kind == "command" {
        if !ctx.args.get("line").is_some_and(Flag::truthy) {
            return Err(Failure::user("--do command needs --line \"<what to send>\""));
        }
        action["line"] = json!(js::string(Some(&flag_value(ctx, "line"))));
    }
    let truthy = |k: &str| ctx.args.get(k).is_some_and(Flag::truthy);
    let or_number = |k: &str, d: f64| {
        let n = ctx.args.get(k).map_or(f64::NAN, Flag::number);
        if n.is_nan() || n == 0.0 { d } else { n }
    };
    let text_or = |k: &str, d: &str| match flag_value(ctx, k) {
        Value::Null => d.to_string(),
        v => js::string(Some(&v)),
    };
    let num = spawnloft_lib::jsjson::num;
    let when = if truthy("hourly") {
        json!({ "kind": "hourly", "every": num(or_number("hourly", 1.0)) })
    } else if truthy("minutes") {
        json!({ "kind": "minutes", "every": num(or_number("minutes", 30.0)) })
    } else if truthy("weekly") {
        json!({ "kind": "weekly", "day": text_or("weekly", ""), "at": text_or("at", "03:00") })
    } else if truthy("onLogon") {
        json!({ "kind": "onlogon" })
    } else {
        let at = if ctx.args.get("daily") == Some(&Flag::Bool(true)) {
            "03:00".to_string()
        } else {
            match flag_value(ctx, "daily") {
                Value::Null => text_or("at", "03:00"),
                v => js::string(Some(&v)),
            }
        };
        json!({ "kind": "daily", "at": at })
    };
    let made = s.create(&json!({
        "instance": instance,
        "name": flag_value(ctx, "name"),
        "action": action,
        "schedule": when,
    }))?;
    ctx.out.line(&format!(
        "Created \"{}\" - {}, {}.",
        js::string(made.get("id")),
        js::string(made.get("name")),
        describe_schedule(made.get("schedule").unwrap_or(&Value::Null))
    ));
    // warned at creation, not only when listing
    let note = schedule::logged_out_note();
    if note.first().is_some_and(|l| l.starts_with("WARNING")) {
        ctx.out.line("");
        for line in note {
            ctx.out.line(&line);
        }
    }
    Ok(())
}

/// How long an unattended start waits for ready before calling it a failure.
const TASK_START_TIMEOUT: f64 = 180_000.0;

fn sleep_ms(ms: f64) {
    if ms > 0.0 && ms.is_finite() {
        std::thread::sleep(std::time::Duration::from_millis(ms as u64));
    }
}

/// `runTask(id)`: what Task Scheduler, launchd or systemd runs. Unattended, so every outcome is
/// one line in the server's `tasks.log` and on stdout, and a failure sets the exit code the
/// scheduler sees. Three outcomes: ok, FAILED, and skipped (a command task with the server
/// down), which counts as success so the log and the scheduler agree.
fn run_task(ctx: &mut Ctx<'_>, id: &str, by: Actor) -> Result<(), Failure> {
    let s = sched(ctx, by.clone());
    let data = s.load()?;
    let Some(task) = Sched::tasks(&data).get(id).cloned() else {
        return Err(Failure::user(format!("no scheduled task \"{id}\"")));
    };
    let instance = js::string(task.get("instance"));
    let action = task.get("action").cloned().unwrap_or(Value::Null);
    let kind = js::string(action.get("type"));
    let task_name = js::string(task.get("name"));
    let started = std::time::Instant::now();
    let layout = ctx.layout;

    let record = |ctx: &mut Ctx<'_>, status: &str, detail: &str| {
        // the id is in the line because one server can have several tasks of one type; tabs and
        // line ends go, so a run stays one line
        let mut flat = String::new();
        let mut in_run = false;
        for c in detail.chars() {
            if matches!(c, '\t' | '\r' | '\n') {
                if !in_run {
                    flat.push(' ');
                }
                in_run = true;
            } else {
                flat.push(c);
                in_run = false;
            }
        }
        let line = format!(
            "{}\t{id}\t{status}\t{kind}\t{flat}",
            spawnloft_lib::time::iso_now()
        );
        let file = spawnloft_lib::jspath::join(&[&layout.run_dir_of(&instance), "tasks.log"]);
        let _ = (|| -> std::io::Result<()> {
            use std::io::Write;
            std::fs::create_dir_all(Path::new(&file).parent().unwrap_or(Path::new(".")))?;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)?;
            f.write_all(format!("{line}\n").as_bytes())
        })();
        ctx.out.line(&line);
    };
    // nobody watches a scheduled run, which is what the webhook is for; best-effort
    let alert = |detail: &str| {
        if let Ok(inst) = registry::lookup(Path::new(&layout.registry_file), &instance)
            && let Some(url) = inst.webhook()
        {
            let _ = notify::post(
                &url,
                &notify::format_discord(
                    &inst.name,
                    &format!("scheduled task \"{task_name}\" FAILED: {detail}"),
                ),
            );
        }
    };
    let start_and_report = |ctx: &mut Ctx<'_>, verb: &str| -> Result<(), Failure> {
        let res = supervisor::start(
            layout,
            &by,
            &instance,
            StartOptions {
                timeout: TASK_START_TIMEOUT,
                ..StartOptions::default()
            },
        )?;
        if res.failed {
            ctx.out.set_code(1);
            let d = format!(
                "{verb}, but it stopped again: {}",
                res.reason.clone().unwrap_or_default()
            );
            alert(&d);
            record(ctx, "FAILED", &d);
        } else if res.timed_out {
            ctx.out.set_code(1);
            let d = format!(
                "{verb}, but it had not finished starting after {}s",
                js::number_to_string(TASK_START_TIMEOUT / 1000.0)
            );
            alert(&d);
            record(ctx, "FAILED", &d);
        } else {
            record(ctx, "ok", verb);
        }
        Ok(())
    };

    // Ok(true): the run line is written and "done in" follows; Ok(false): it is written and the
    // run ends there
    let outcome = (|| -> Result<bool, Failure> {
        let inst = registry::lookup(Path::new(&layout.registry_file), &instance)?;
        let running = supervisor::is_running(layout, &instance)?;
        match kind.as_str() {
            "backup" => {
                let opts = backup::Options {
                    label: json!("scheduled"),
                    running,
                    task_id: json!(id),
                    ..backup::Options::default()
                };
                let res = backup::create_snapshot(layout, &by, &inst, &opts)?;
                let mut pruned = String::new();
                // pruned after the new snapshot exists, so a failed backup leaves no fewer
                let keep = js::number(action.get("keep"));
                if keep.is_finite() && keep.fract() == 0.0 && keep > 0.0 {
                    let gone =
                        backup::prune_snapshots(layout, &by, &instance, keep, Some("scheduled"), Some(id))?;
                    if !gone.is_empty() {
                        pruned = format!(
                            ", pruned {} over the limit of {}",
                            gone.len(),
                            js::number_to_string(keep)
                        );
                    }
                }
                let warn = res
                    .save_on_warning
                    .as_ref()
                    .map(|w| format!("; WARNING: {w}"))
                    .unwrap_or_default();
                record(
                    ctx,
                    "ok",
                    &format!(
                        "{} ({}){pruned}{warn}",
                        res.file,
                        text::human_bytes(Some(res.size as f64))
                    ),
                );
                Ok(true)
            }
            "verify" => {
                let snaps = backup::list_snapshots(layout, &instance)?;
                if snaps.is_empty() {
                    record(ctx, "skipped", "no backups to check yet");
                    return Ok(false);
                }
                let mut failed = Vec::new();
                for snap in &snaps {
                    let (_, _, r) = backup::verify_snapshot(layout, &instance, &snap.name)?;
                    if !r.ok {
                        failed.push(format!(
                            "{}: {}",
                            snap.name,
                            r.problems.first().map_or("undefined", String::as_str)
                        ));
                    }
                }
                if !failed.is_empty() {
                    ctx.out.set_code(1);
                    let d = format!(
                        "{} of {} backups failed the check: {}",
                        failed.len(),
                        snaps.len(),
                        failed.join("; ")
                    );
                    alert(&d);
                    record(ctx, "FAILED", &d);
                    return Ok(false);
                }
                record(ctx, "ok", &format!("all {} backups read back whole", snaps.len()));
                Ok(true)
            }
            "command" => {
                if !running {
                    record(ctx, "skipped", "the server was not running, so nothing was sent");
                    return Ok(false);
                }
                let line = js::string(action.get("line"));
                supervisor::send_console(layout, &by, &instance, &line)?;
                record(ctx, "ok", &line);
                Ok(true)
            }
            "restart" => {
                let warn = js::number(action.get("warnMinutes"));
                if running && warn > 0.0 {
                    // the full time, one minute and ten seconds; best-effort, since the stop below
                    // copes with a server that died mid-countdown
                    let say = |m: &str| {
                        let _ = supervisor::send_console(layout, &by, &instance, &format!("say {m}"));
                    };
                    let mut remaining = warn * 60.0;
                    say(&format!(
                        "Server restarting in {} minute{}",
                        js::number_to_string(warn),
                        if warn == 1.0 { "" } else { "s" }
                    ));
                    if remaining > 60.0 {
                        sleep_ms((remaining - 60.0) * 1000.0);
                        remaining = 60.0;
                        say("Server restarting in 1 minute");
                    }
                    sleep_ms((remaining - 10.0) * 1000.0);
                    say("Server restarting in 10 seconds");
                    sleep_ms(10_000.0);
                }
                if running {
                    supervisor::stop(layout, &by, &instance, 90_000.0)?;
                }
                let verb = if warn > 0.0 && running {
                    format!("restarted after a {}-minute warning", js::number_to_string(warn))
                } else {
                    "restarted".into()
                };
                start_and_report(ctx, &verb)?;
                Ok(false)
            }
            "stop" => {
                if !running {
                    record(ctx, "skipped", "it was already stopped");
                    return Ok(false);
                }
                supervisor::stop(layout, &by, &instance, 90_000.0)?;
                record(ctx, "ok", "stopped");
                Ok(true)
            }
            "start" => {
                if running {
                    record(ctx, "skipped", "it was already running");
                    return Ok(false);
                }
                start_and_report(ctx, "started")?;
                Ok(false)
            }
            "steps" => {
                let mut deps = StepDeps {
                    layout,
                    by: &by,
                    id,
                    inst: &inst,
                };
                let res = steps::run_steps(&action, &mut deps);
                if res.status == "FAILED" {
                    ctx.out.set_code(1);
                    alert(&res.failures.join("; "));
                }
                record(ctx, res.status, &res.detail);
                Ok(false)
            }
            other => Err(Failure::user(format!("unknown action \"{other}\""))),
        }
    })();
    match outcome {
        Ok(true) => {
            let secs = (started.elapsed().as_secs_f64() + 0.5).floor();
            ctx.out.line(&format!("done in {}s", js::number_to_string(secs)));
        }
        Ok(false) => {}
        Err(f) => {
            record(ctx, "FAILED", f.message());
            ctx.out.set_code(1);
            alert(f.message());
        }
    }
    Ok(())
}

/// The steps of a `steps` task, making the same calls as the single-action tasks.
struct StepDeps<'a> {
    layout: &'a spawnloft_lib::settings::Layout,
    by: &'a Actor,
    id: &'a str,
    inst: &'a registry::Instance,
}

impl steps::Deps for StepDeps<'_> {
    fn is_running(&mut self) -> bool {
        supervisor::is_running(self.layout, &self.inst.name).unwrap_or(false)
    }
    fn send(&mut self, line: &str) -> Result<(), String> {
        supervisor::send_console(self.layout, self.by, &self.inst.name, line)
            .map_err(|f| f.message().to_string())
    }
    fn sleep(&mut self, ms: f64) {
        sleep_ms(ms);
    }
    fn backup(&mut self, keep: &Value) -> Result<String, String> {
        let name = &self.inst.name;
        let opts = backup::Options {
            label: json!("scheduled"),
            running: self.is_running(),
            task_id: json!(self.id),
            ..backup::Options::default()
        };
        let snap = backup::create_snapshot(self.layout, self.by, self.inst, &opts)
            .map_err(|f| f.message().to_string())?;
        let gone = if js::truthy(Some(keep)) {
            backup::prune_snapshots(
                self.layout,
                self.by,
                name,
                js::number(Some(keep)),
                Some("scheduled"),
                Some(self.id),
            )
            .map_err(|f| f.message().to_string())?
        } else {
            Vec::new()
        };
        Ok(format!(
            "backed up {} ({}){}{}",
            spawnloft_lib::jspath::basename(&snap.file),
            text::human_bytes(Some(snap.size as f64)),
            if gone.is_empty() {
                String::new()
            } else {
                format!(", pruned {}", gone.len())
            },
            snap.save_on_warning
                .map(|w| format!("; WARNING: {w}"))
                .unwrap_or_default()
        ))
    }
    fn verify(&mut self) -> Result<String, String> {
        let name = &self.inst.name;
        let snaps = backup::list_snapshots(self.layout, name).map_err(|f| f.message().to_string())?;
        let mut bad = Vec::new();
        for s in &snaps {
            let (_, _, r) =
                backup::verify_snapshot(self.layout, name, &s.name).map_err(|f| f.message().to_string())?;
            if !r.ok {
                bad.push(s.name.clone());
            }
        }
        if !bad.is_empty() {
            return Err(format!(
                "{} of {} backups do not read back: {}",
                bad.len(),
                snaps.len(),
                bad.join(", ")
            ));
        }
        Ok(format!("verified {} backups", snaps.len()))
    }
    fn stop(&mut self) -> Result<(), String> {
        supervisor::stop(self.layout, self.by, &self.inst.name, 90_000.0)
            .map(|_| ())
            .map_err(|f| f.message().to_string())
    }
    fn start(&mut self) -> Result<(bool, bool, String), String> {
        let res = supervisor::start(
            self.layout,
            self.by,
            &self.inst.name,
            StartOptions {
                timeout: TASK_START_TIMEOUT,
                ..StartOptions::default()
            },
        )
        .map_err(|f| f.message().to_string())?;
        Ok((res.failed, res.timed_out, res.reason.unwrap_or_default()))
    }
}

/// `cmdRemove`: the record goes (and with `--purge --yes` the folder), then the server's
/// scheduled tasks, as the panel's delete drops them.
pub fn remove(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "rm")?.to_string();
    let reg = Path::new(&ctx.layout.registry_file);
    let inst = registry::lookup(reg, &name)?;
    if let Some(why) = control::active_block(Path::new(&ctx.layout.state_file(&name)), &name, "removing it")?
    {
        return Err(Failure::user(why));
    }
    let purge = ctx.args.get("purge").is_some_and(Flag::truthy);
    let dir = js::string(inst.get("dir"));
    if purge && !ctx.args.get("yes").is_some_and(Flag::truthy) {
        return Err(Failure::user(format!(
            "--purge deletes {dir} permanently. Re-run with --yes to confirm."
        )));
    }
    registry::remove_instance(reg, &name)?;
    // a trigger that outlives its server fails on every run; a stuck one is not a reason to refuse
    let dropped = sched(ctx, cli()).remove_for_instance(&name).unwrap_or(0);
    if purge {
        let path = spawnloft_lib::create::path_arg(inst.get("dir"), "path")?;
        manage::rm_rf(Path::new(path))?;
        ctx.out.line(&format!("Removed \"{name}\" and deleted {dir}"));
    } else {
        ctx.out
            .line(&format!("Unregistered \"{name}\". Files kept at {dir}"));
    }
    if dropped > 0 {
        ctx.out.line(&format!(
            "Also removed {dropped} scheduled task(s) that pointed at it."
        ));
    }
    manage::rm_rf(Path::new(&ctx.layout.run_dir_of(&name)))
}

/// `cmdRename`.
pub fn rename(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let (Some(from), Some(to)) = (positional(ctx, 0), positional(ctx, 1)) else {
        return Err(Failure::user("usage: spawnloft rename <old-name> <new-name>"));
    };
    let res = manage::rename(ctx.layout, &cli(), &from, &to)?;
    ctx.out.line(&format!("Renamed \"{from}\" -> \"{to}\""));
    if res.moved_dir {
        ctx.out.line(&format!("  directory moved to {}", res.dir));
    }
    Ok(())
}
