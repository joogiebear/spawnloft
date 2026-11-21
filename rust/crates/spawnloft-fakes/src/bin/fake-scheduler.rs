//! Test-only: the system scheduler's programs played by one binary, for the parity rig (C6 of
//! rust/PLAN-CORE-PORT.md). Both cores run `fake-scheduler <tool> <args...>` in place of
//! `schtasks`, `powershell`, `launchctl`, `systemctl` and `loginctl` when
//! `SPAWNLOFT_TEST_SCHEDULER` names it (src/test-origins.mjs, spawnloft-lib test_origins.rs).
//!
//! State lives in `$FAKE_SCHEDULER_DIR/state.json` and every call that changes something is
//! appended to `$FAKE_SCHEDULER_DIR/calls.log`, one line per call, so the rig compares the two
//! cores' calls in order. Reads (`launchctl print`, `systemctl show`, `is-active`,
//! `is-enabled`, `schtasks /Query`, `Get-ScheduledTask`, `loginctl show-user`) are not logged:
//! the Node core asks launchd about several tasks at once, in no fixed order.
//!
//! A scenario can seed `state.json` (a `write` step) with:
//! - `"fail": [{ "tool": "systemctl", "args": ["enable"], "status": 1, "stderr": "...", "times": 1 }]`:
//!   the next call of that tool whose arguments include all of `args` fails so (`times` calls,
//!   every call when absent); it is still logged, with `-> <status>`
//! - `"running": ["<id or label part>"]`: launchd prints a pid, systemd says `activating`
//! - `"linger": true`

use std::io::Write;
use std::path::PathBuf;

use serde_json::{Map, Value, json};

struct Fake {
    dir: PathBuf,
    state: Map<String, Value>,
}

struct Answer {
    status: i32,
    stdout: String,
    stderr: String,
}

fn ok(stdout: impl Into<String>) -> Answer {
    Answer {
        status: 0,
        stdout: stdout.into(),
        stderr: String::new(),
    }
}

fn fail(status: i32, stderr: impl Into<String>) -> Answer {
    Answer {
        status,
        stdout: String::new(),
        stderr: stderr.into(),
    }
}

impl Fake {
    fn obj(&mut self, key: &str) -> &mut Map<String, Value> {
        let v = self
            .state
            .entry(key.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !v.is_object() {
            *v = Value::Object(Map::new());
        }
        v.as_object_mut().expect("an object")
    }

    fn running(&self, name: &str) -> bool {
        self.state
            .get("running")
            .and_then(Value::as_array)
            .is_some_and(|r| r.iter().filter_map(Value::as_str).any(|s| name.contains(s)))
    }

    /// A seeded failure for this call, used up as it is given.
    fn injected(&mut self, tool: &str, args: &[String]) -> Option<Answer> {
        let list = self.state.get_mut("fail")?.as_array_mut()?;
        let at = list.iter().position(|f| {
            f.get("tool").and_then(Value::as_str) == Some(tool)
                && f.get("args").and_then(Value::as_array).is_none_or(|want| {
                    want.iter()
                        .filter_map(Value::as_str)
                        .all(|w| args.iter().any(|a| a == w))
                })
                && f.get("times").and_then(Value::as_i64).is_none_or(|t| t > 0)
        })?;
        let f = &mut list[at];
        let answer = fail(
            f.get("status").and_then(Value::as_i64).unwrap_or(1) as i32,
            f.get("stderr")
                .and_then(Value::as_str)
                .unwrap_or("injected failure")
                .to_string(),
        );
        if let Some(t) = f.get("times").and_then(Value::as_i64) {
            f["times"] = json!(t - 1);
        }
        Some(answer)
    }
}

fn arg<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a.eq_ignore_ascii_case(flag))?;
    args.get(i + 1).map(String::as_str)
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a.eq_ignore_ascii_case(flag))
}

/// Task Scheduler: names ignore case, and a task overwritten with /F keeps the case it had.
fn schtasks(f: &mut Fake, args: &[String]) -> (Answer, bool) {
    let Some(tn) = arg(args, "/TN").map(str::to_string) else {
        return (fail(1, "ERROR: Invalid syntax.\n"), true);
    };
    let key = tn.to_lowercase();
    let missing = || fail(1, "ERROR: The system cannot find the file specified.\n");
    let tasks = f.obj("windows");
    let verb = args.first().map(|a| a.to_ascii_lowercase()).unwrap_or_default();
    match verb.as_str() {
        "/create" => {
            let existed = tasks.get(&key).cloned();
            if existed.is_some() && !has(args, "/F") {
                return (
                    fail(1, "ERROR: Cannot create a file when that file already exists.\n"),
                    true,
                );
            }
            let name = existed
                .as_ref()
                .and_then(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| tn.clone());
            let trigger: Vec<&String> = args
                .iter()
                .skip_while(|a| !a.eq_ignore_ascii_case("/SC"))
                .take_while(|a| !a.eq_ignore_ascii_case("/F"))
                .collect();
            tasks.insert(
                key,
                json!({ "name": name, "run": arg(args, "/TR"), "trigger": trigger, "enabled": true }),
            );
            (
                ok(format!(
                    "SUCCESS: The scheduled task \"{name}\" has successfully been created.\n"
                )),
                true,
            )
        }
        "/change" => match tasks.get_mut(&key) {
            Some(t) => {
                t["enabled"] = json!(!has(args, "/DISABLE"));
                (
                    ok(format!(
                        "SUCCESS: The parameters of scheduled task \"{tn}\" have been changed.\n"
                    )),
                    true,
                )
            }
            None => (missing(), true),
        },
        "/delete" => match tasks.remove(&key) {
            Some(_) => (
                ok(format!(
                    "SUCCESS: The scheduled task \"{tn}\" was successfully deleted.\n"
                )),
                true,
            ),
            None => (missing(), true),
        },
        "/query" => match tasks.get(&key) {
            Some(_) => (ok(format!("Folder: \\\n{tn}\n")), false),
            None => (missing(), false),
        },
        "/run" => match tasks.get(&key) {
            Some(_) => (
                ok(format!(
                    "SUCCESS: Attempted to run the scheduled task \"{tn}\".\n"
                )),
                true,
            ),
            None => (missing(), true),
        },
        _ => (fail(1, "ERROR: Invalid argument/option.\n"), true),
    }
}

/// The two PowerShell lines the cores run: the task listing and the folder removal.
fn powershell(f: &mut Fake, args: &[String]) -> (Answer, bool) {
    let script = args.last().cloned().unwrap_or_default();
    if script.contains("Get-ScheduledTask") {
        let folder = script
            .split("-TaskPath '\\")
            .nth(1)
            .and_then(|r| r.split('\\').next())
            .unwrap_or("mcctl")
            .to_lowercase();
        let rows: Vec<Value> = f
            .obj("windows")
            .values()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?;
                let (dir, leaf) = name.rsplit_once('\\')?;
                (dir.to_lowercase() == folder).then(|| {
                    json!({
                        "name": leaf,
                        "state": if t["enabled"] == json!(false) { "Disabled" } else { "Ready" },
                        "lastRun": null,
                        "lastResult": 267011,
                        "nextRun": null,
                    })
                })
            })
            .collect();
        let text = match rows.len() {
            0 => String::new(),
            1 => format!("{}\n", rows[0]),
            _ => format!("{}\n", Value::Array(rows)),
        };
        return (ok(text), false);
    }
    if script.contains("DeleteFolder") {
        let left = !f.obj("windows").is_empty();
        return if left {
            (
                fail(
                    1,
                    "The directory is not empty. (Exception from HRESULT: 0x80070091)\n",
                ),
                true,
            )
        } else {
            (ok(""), true)
        };
    }
    (fail(1, "fake-scheduler: an unknown PowerShell script\n"), true)
}

fn launchctl(f: &mut Fake, args: &[String]) -> (Answer, bool) {
    let verb = args.first().map(String::as_str).unwrap_or("");
    let target = args.get(1).cloned().unwrap_or_default();
    let label = target.rsplit('/').next().unwrap_or("").to_string();
    match verb {
        "print" => {
            let loaded = f.obj("launchd").contains_key(&label);
            if !loaded {
                return (
                    fail(
                        113,
                        format!(
                            "Could not find service \"{label}\" in domain for user gui: {}\n",
                            target.split('/').nth(1).unwrap_or("")
                        ),
                    ),
                    false,
                );
            }
            let pid = if f.running(&label) { "\tpid = 4242\n" } else { "" };
            (
                ok(format!(
                    "{target} = {{\n\tactive count = 0\n\tpath = (fake)\n\tstate = waiting\n{pid}\tlast exit code = (never exited)\n}}\n"
                )),
                false,
            )
        }
        "bootout" => {
            if f.obj("launchd").remove(&label).is_some() {
                (ok(""), true)
            } else {
                (fail(3, "Boot-out failed: 3: No such process\n"), true)
            }
        }
        "bootstrap" => {
            let file = args.get(2).cloned().unwrap_or_default();
            let Ok(text) = std::fs::read_to_string(&file) else {
                return (fail(5, "Bootstrap failed: 5: Input/output error\n"), true);
            };
            let name = text
                .split("<key>Label</key><string>")
                .nth(1)
                .and_then(|r| r.split('<').next())
                .unwrap_or("")
                .to_string();
            if f.obj("launchd-disabled").contains_key(&name) {
                return (fail(5, "Bootstrap failed: 5: Input/output error\n"), true);
            }
            f.obj("launchd").insert(name, json!(true));
            (ok(""), true)
        }
        "enable" => {
            f.obj("launchd-disabled").remove(&label);
            (ok(""), true)
        }
        "disable" => {
            f.obj("launchd-disabled").insert(label, json!(true));
            (ok(""), true)
        }
        "kickstart" => {
            if f.obj("launchd").contains_key(&label) {
                (ok(""), true)
            } else {
                (fail(113, "Could not find service\n"), true)
            }
        }
        _ => (fail(64, "Unrecognized subcommand\n"), true),
    }
}

fn unit_dir() -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(c) => PathBuf::from(c),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"),
    }
    .join("systemd")
    .join("user")
}

fn systemctl(f: &mut Fake, args: &[String]) -> (Answer, bool) {
    let args: Vec<String> = args.iter().filter(|a| *a != "--user").cloned().collect();
    let verb = args.first().map(String::as_str).unwrap_or("");
    let units: Vec<String> = args
        .iter()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .cloned()
        .collect();
    match verb {
        "is-active" => {
            let u = units.first().cloned().unwrap_or_default();
            if f.running(&u) {
                (ok("activating\n"), false)
            } else {
                (
                    Answer {
                        status: 3,
                        stdout: "inactive\n".into(),
                        stderr: String::new(),
                    },
                    false,
                )
            }
        }
        "is-enabled" => {
            let u = units.first().cloned().unwrap_or_default();
            if f.obj("systemd").contains_key(&u) {
                (ok("enabled\n"), false)
            } else if unit_dir().join(&u).exists() {
                (
                    Answer {
                        status: 1,
                        stdout: "disabled\n".into(),
                        stderr: String::new(),
                    },
                    false,
                )
            } else {
                (
                    fail(
                        1,
                        format!("Failed to get unit file state for {u}: No such file or directory\n"),
                    ),
                    false,
                )
            }
        }
        "enable" => {
            for u in &units {
                if !unit_dir().join(u).exists() {
                    return (
                        fail(
                            1,
                            format!("Failed to enable unit: Unit file {u} does not exist.\n"),
                        ),
                        true,
                    );
                }
            }
            for u in units {
                f.obj("systemd").insert(u, json!(true));
            }
            (ok(""), true)
        }
        "disable" => {
            for u in units {
                f.obj("systemd").remove(&u);
            }
            (ok(""), true)
        }
        "daemon-reload" | "reset-failed" | "start" => (ok(""), true),
        "show" => {
            let mut text = String::new();
            for u in &units {
                if !text.is_empty() {
                    text.push('\n');
                }
                let loaded = unit_dir().join(u).exists();
                let timer = u.ends_with(".timer");
                let on = f.obj("systemd").contains_key(u);
                let state = if f.running(u) {
                    "activating"
                } else if on && timer {
                    "active"
                } else {
                    "inactive"
                };
                text.push_str(&format!(
                    "Id={u}\nLoadState={}\nActiveState={state}\nExecMainStatus=0\nExecMainExitTimestamp=\nNextElapseUSecRealtime={}\nLastTriggerUSec=\nActiveEnterTimestamp={}\n",
                    if loaded { "loaded" } else { "not-found" },
                    if timer && on { "Mon 2030-01-07 03:00:00 UTC" } else { "" },
                    if timer && on { "Sun 2030-01-06 03:00:00 UTC" } else { "" },
                ));
            }
            (ok(text), false)
        }
        _ => (fail(1, format!("Unknown command verb {verb}.\n")), true),
    }
}

fn loginctl(f: &mut Fake, args: &[String]) -> (Answer, bool) {
    match args.first().map(String::as_str) {
        Some("show-user") => {
            let on = f.state.get("linger") == Some(&json!(true));
            (ok(if on { "yes\n" } else { "no\n" }), false)
        }
        Some("enable-linger") => {
            f.state.insert("linger".into(), json!(true));
            (ok(""), true)
        }
        _ => (fail(1, "Unknown command verb.\n"), true),
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(dir) = std::env::var_os("FAKE_SCHEDULER_DIR").filter(|v| !v.is_empty()) else {
        eprintln!("fake-scheduler: FAKE_SCHEDULER_DIR is not set");
        std::process::exit(99);
    };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let state_file = dir.join("state.json");
    let state = std::fs::read_to_string(&state_file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut f = Fake { dir, state };
    let Some((tool, args)) = argv.split_first() else {
        eprintln!("fake-scheduler: no tool named");
        std::process::exit(99);
    };
    let (answer, logged) = match f.injected(tool, args) {
        Some(a) => (a, true),
        None => match tool.as_str() {
            "schtasks" => schtasks(&mut f, args),
            "powershell" => powershell(&mut f, args),
            "launchctl" => launchctl(&mut f, args),
            "systemctl" => systemctl(&mut f, args),
            "loginctl" => loginctl(&mut f, args),
            other => (fail(99, format!("fake-scheduler: unknown tool {other}\n")), true),
        },
    };
    if logged {
        let mut line = std::iter::once(tool.as_str())
            .chain(args.iter().map(String::as_str))
            .map(|a| {
                if a.contains(' ') || a.is_empty() {
                    format!("{a:?}")
                } else {
                    a.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        if answer.status != 0 {
            line.push_str(&format!(" -> {}", answer.status));
        }
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(f.dir.join("calls.log"))
        {
            let _ = writeln!(log, "{line}");
        }
        let text = serde_json::to_string_pretty(&Value::Object(f.state)).unwrap_or_default();
        let _ = std::fs::write(&state_file, text + "\n");
    }
    print!("{}", answer.stdout);
    eprint!("{}", answer.stderr);
    std::process::exit(answer.status);
}
