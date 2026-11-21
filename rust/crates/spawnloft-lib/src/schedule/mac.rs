//! `schedule-mac.mjs`: launchd agents that run `spawnloft task run <id>` through a shell shim.
//! The posix shim is shared with Linux.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::run::{self, Ran};
use super::{Sched, fail};
use crate::failure::Failure;
use crate::{js, jspath};

/// Agents are named per data folder, so separate installs do not replace each other's.
pub fn namespace(data_root: &str) -> String {
    crate::sha256::hex(data_root.as_bytes())[..16].to_string()
}

/// `/^[a-z0-9][a-z0-9_-]{0,100}$/i`.
pub(crate) fn check_id(id: &str) -> Result<(), Failure> {
    let b = id.as_bytes();
    let ok = !b.is_empty()
        && b.len() <= 101
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
    if ok {
        Ok(())
    } else {
        fail("Invalid scheduled task id")
    }
}

pub fn label(s: &Sched, id: &str) -> Result<String, Failure> {
    check_id(id)?;
    Ok(format!(
        "io.github.joogiebear.mcctl.{}.{id}",
        namespace(&s.data_root)
    ))
}

fn domain() -> String {
    #[cfg(unix)]
    let uid = crate::platform::uid();
    #[cfg(not(unix))]
    let uid = 0;
    format!("gui/{uid}")
}

fn target(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(format!("{}/{}", domain(), label(s, id)?))
}

/// `os.homedir()`: `HOME` when set.
pub(crate) fn homedir() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| crate::paths::home().to_string_lossy().into_owned())
}

pub fn agent_file(s: &Sched, id: &str) -> Result<String, Failure> {
    Ok(jspath::join(&[
        &homedir(),
        "Library",
        "LaunchAgents",
        &format!("{}.plist", label(s, id)?),
    ]))
}

fn shim_file(s: &Sched, id: &str) -> String {
    jspath::join(&[&s.data_root, "tasks", &format!("{id}.sh")])
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A plist value.
#[derive(Debug, Clone)]
pub enum Pv {
    Bool(bool),
    Int(f64),
    Str(String),
    List(Vec<Pv>),
    Dict(Vec<(String, Pv)>),
}

fn plist_value(v: &Pv) -> String {
    match v {
        Pv::Bool(b) => if *b { "<true/>" } else { "<false/>" }.to_string(),
        Pv::Int(n) => format!("<integer>{}</integer>", js::number_to_string(*n)),
        Pv::List(items) => format!(
            "<array>{}</array>",
            items.iter().map(plist_value).collect::<String>()
        ),
        Pv::Dict(entries) => format!(
            "<dict>{}</dict>",
            entries
                .iter()
                .map(|(k, v)| format!("<key>{}</key>{}", xml(k), plist_value(v)))
                .collect::<String>()
        ),
        Pv::Str(s) => format!("<string>{}</string>", xml(s)),
    }
}

/// `trigger(schedule)`: the plist keys that fire it.
pub fn trigger(schedule: &Value) -> Result<Vec<(String, Pv)>, Failure> {
    let every = js::number(schedule.get("every"));
    let kind = schedule.get("kind").and_then(Value::as_str).unwrap_or("");
    Ok(match kind {
        "minutes" => vec![("StartInterval".into(), Pv::Int(every * 60.0))],
        "hourly" => vec![("StartInterval".into(), Pv::Int(every * 3600.0))],
        "onlogon" => vec![("RunAtLoad".into(), Pv::Bool(true))],
        "daily" | "weekly" => {
            let at = js::string(schedule.get("at"));
            let mut parts = at.split(':').map(js::string_to_number);
            let mut dict = vec![
                ("Hour".to_string(), Pv::Int(parts.next().unwrap_or(f64::NAN))),
                ("Minute".to_string(), Pv::Int(parts.next().unwrap_or(f64::NAN))),
            ];
            if kind == "weekly" {
                let days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
                let want = js::string(schedule.get("day"));
                let day = days.iter().position(|d| *d == want).map_or(-1.0, |p| p as f64);
                dict.push(("Weekday".into(), Pv::Int(day)));
            }
            vec![("StartCalendarInterval".into(), Pv::Dict(dict))]
        }
        _ => {
            return Err(Failure::Internal {
                head: "Error".into(),
                message: "Unknown launchd schedule".into(),
                code: None,
            });
        }
    })
}

/// `plist(id, task)`: the agent's file.
pub fn plist(s: &Sched, id: &str, task: &Value) -> Result<String, Failure> {
    let tasks = jspath::join(&[&s.data_root, "tasks"]);
    let mut dict = vec![
        ("Label".to_string(), Pv::Str(label(s, id)?)),
        (
            "ProgramArguments".into(),
            Pv::List(vec![Pv::Str("/bin/sh".into()), Pv::Str(shim_file(s, id))]),
        ),
        ("WorkingDirectory".into(), Pv::Str(s.data_root.clone())),
        ("Disabled".into(), Pv::Bool(!js::truthy(task.get("enabled")))),
        // server daemons must outlive the task that starts them
        ("AbandonProcessGroup".into(), Pv::Bool(true)),
        (
            "AssociatedBundleIdentifiers".into(),
            Pv::List(vec![Pv::Str("io.github.joogiebear.mcctl".into())]),
        ),
    ];
    dict.extend(trigger(task.get("schedule").unwrap_or(&Value::Null))?);
    dict.push((
        "StandardOutPath".into(),
        Pv::Str(jspath::join(&[&tasks, &format!("{id}.stdout.log")])),
    ));
    dict.push((
        "StandardErrorPath".into(),
        Pv::Str(jspath::join(&[&tasks, &format!("{id}.stderr.log")])),
    ));
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">{}</plist>\n",
        plist_value(&Pv::Dict(dict))
    ))
}

fn launchctl(args: &[&str]) -> Ran {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    run::run("/bin/launchctl", &args, 15_000, &[])
}

fn first_text<'a>(texts: &[&'a str]) -> &'a str {
    texts.iter().copied().find(|t| !t.is_empty()).unwrap_or("")
}

fn checked(args: &[&str]) -> Result<String, Failure> {
    let res = launchctl(args);
    if !res.ok() {
        let said = first_text(&[
            res.error_message().unwrap_or(""),
            js::trim(&res.stderr),
            js::trim(&res.stdout),
            "launchctl failed",
        ]);
        return fail(format!("macOS scheduler: {said}"));
    }
    Ok(res.stdout)
}

/// `/^\s*pid = \d+/m` on what `launchctl print` said.
pub(crate) fn shows_pid(text: &str) -> bool {
    text.split('\n').any(|line| {
        line.trim_start()
            .strip_prefix("pid = ")
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    })
}

/// `/^\s*last exit code = (\d+)/m`.
fn last_exit(text: &str) -> Option<f64> {
    text.split('\n').find_map(|line| {
        let rest = line.trim_start().strip_prefix("last exit code = ")?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty()).then(|| js::string_to_number(&digits))
    })
}

/// `writeShim(id)`: the shell shim, naming this command line and the settings locations only
/// (not the caller's whole environment).
pub fn write_shim(s: &Sched, id: &str) -> Result<String, Failure> {
    check_id(id)?;
    let file = shim_file(s, id);
    crate::fsx::mkdir_all(Path::new(&jspath::dirname(&file)))?;
    let cli = crate::entry::cli_command(std::env::var(crate::entry::ENTRY_ENV).ok().as_deref());
    let mut env: Vec<(String, String)> = vec![("SPAWNLOFT_DATA_ROOT".into(), s.data_root.clone())];
    env.extend(cli.env.iter().cloned());
    for key in ["HOME", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] {
        if let Some(v) = std::env::var(key).ok().filter(|v| !v.is_empty()) {
            match env.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = v,
                None => env.push((key.into(), v)),
            }
        }
    }
    let mut script = String::from("#!/bin/sh\n");
    for (k, v) in &env {
        script.push_str(&format!("export {k}={}\n", quote(v)));
    }
    let mut words: Vec<String> = vec![quote(&cli.exe)];
    words.extend(cli.args.iter().map(|a| quote(a)));
    script.push_str(&format!("exec {} task run {}\n", words.join(" "), quote(id)));
    write_mode(&file, script.as_bytes(), 0o700)?;
    Ok(file)
}

/// `fs.writeFileSync(file, data, { mode })`: the mode applies when the file is made.
pub(crate) fn write_mode(file: &str, data: &[u8], mode: u32) -> Result<(), Failure> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let p = Path::new(file);
    let mut f = o.open(p).map_err(|e| Failure::io(&e, "open", Some(p)))?;
    f.write_all(data).map_err(|e| Failure::io(&e, "write", None))
}

fn unload(s: &Sched, id: &str) -> Result<(), Failure> {
    let res = launchctl(&["bootout", &target(s, id)?]);
    // 3 (ESRCH): the agent is already absent
    if res.error.is_some() || (res.status != Some(0) && res.status != Some(3)) {
        let said = first_text(&[res.error_message().unwrap_or(""), js::trim(&res.stderr)]);
        return fail(format!("Could not unload macOS task {id}: {said}"));
    }
    Ok(())
}

/// `write(id, task)`: the agent replaced, put back as it was when launchd refuses the new one.
pub fn write(s: &Sched, id: &str, task: &Value) -> Result<(), Failure> {
    let file = agent_file(s, id)?;
    let previous = std::fs::read(&file).ok();
    let t = target(s, id)?;
    // a running backup or restart is not interrupted to edit its schedule
    if shows_pid(&launchctl(&["print", &t]).stdout) {
        return fail("This task is running. Wait for it to finish before editing it.");
    }
    write_shim(s, id)?;
    crate::fsx::mkdir_all(Path::new(&jspath::dirname(&file)))?;
    unload(s, id)?;
    let enabled = js::truthy(task.get("enabled"));
    let attempt = (|| {
        write_mode(&file, plist(s, id, task)?.as_bytes(), 0o600)?;
        checked(&[if enabled { "enable" } else { "disable" }, &t])?;
        if enabled {
            checked(&["bootstrap", &domain(), &file])?;
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        match previous {
            Some(bytes) => {
                let _ = std::fs::write(&file, &bytes);
                let disabled = String::from_utf8_lossy(&bytes).contains("<key>Disabled</key><true/>");
                launchctl(&[if disabled { "disable" } else { "enable" }, &t]);
                if !disabled {
                    launchctl(&["bootstrap", &domain(), &file]);
                }
            }
            None => super::rm_force(&file),
        }
        return Err(e);
    }
    Ok(())
}

/// `remove(id)`.
pub fn remove(s: &Sched, id: &str) -> Result<(), Failure> {
    let t = target(s, id)?;
    if shows_pid(&launchctl(&["print", &t]).stdout) {
        return fail("This task is running. Wait for it to finish before removing it.");
    }
    unload(s, id)?;
    super::rm_force(&agent_file(s, id)?);
    super::rm_force(&shim_file(s, id));
    // the persistent disabled override goes as well as the plist
    checked(&["enable", &t])?;
    Ok(())
}

/// `runNow(id, task)`.
pub fn run_now(s: &Sched, id: &str, task: &Value) -> Result<(), Failure> {
    if !js::truthy(task.get("enabled")) {
        return fail("Enable this task before running it through the macOS scheduler.");
    }
    checked(&["kickstart", &target(s, id)?]).map(|_| ())
}

/// `query(tasks, recentRuns)`: what launchd says of each task; a task it does not have is absent.
pub fn query(s: &Sched, tasks: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let now = crate::time::now_ms() as f64;
    for (id, task) in tasks {
        let Ok(file) = agent_file(s, id) else { continue };
        if !js::truthy(task.get("enabled")) && Path::new(&file).exists() {
            out.insert(
                id.clone(),
                json!({ "state": "Disabled", "lastResult": null, "lastRun": null, "nextRun": null }),
            );
            continue;
        }
        let Ok(t) = target(s, id) else { continue };
        let Some(state) = run::exec_file("/bin/launchctl", &["print".into(), t], 5_000, &[]) else {
            continue;
        };
        let instance = js::string(task.get("instance"));
        let last = s
            .recent_runs(&instance, 40)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.get("id") == Some(&json!(id)));
        let schedule = task.get("schedule").cloned().unwrap_or(Value::Null);
        out.insert(
            id.clone(),
            json!({
                "state": if shows_pid(&state) { "Running" } else { "Ready" },
                "lastRun": last.and_then(|l| l.get("at").cloned()).unwrap_or(Value::Null),
                "lastResult": last_exit(&state).map_or(Value::Null, crate::jsjson::num),
                // launchd publishes no next firing time for interval jobs
                "nextRun": super::next_calendar_run(&schedule, now),
            }),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched() -> Sched {
        Sched::new("/d", "/d/run", crate::activity::Actor::new("cli", None))
    }

    #[test]
    fn the_plist_names_the_shim_and_its_trigger() {
        let p = plist(
            &sched(),
            "a-backup",
            &json!({ "enabled": false, "schedule": { "kind": "weekly", "day": "SUN", "at": "03:05" } }),
        )
        .unwrap();
        assert!(p.contains("<key>Disabled</key><true/>"));
        assert!(p.contains("<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>5</integer><key>Weekday</key><integer>0</integer></dict>"));
        assert!(p.contains("<string>/d/tasks/a-backup.sh</string>"));
        assert!(label(&sched(), "../x").is_err());
        assert!(shows_pid("x = {\n\tpid = 12\n}"));
        assert!(!shows_pid("x = {\n\tlast exit code = 0\n}"));
        assert_eq!(last_exit("\tlast exit code = 78: x\n"), Some(78.0));
        assert_eq!(last_exit("\tlast exit code = (never exited)\n"), None);
    }
}
