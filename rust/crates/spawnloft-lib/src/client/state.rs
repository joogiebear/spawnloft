//! A profile's running game, as `client-launch.mjs` records it: state.json while it runs (its
//! pid, the image name and start time that tell it from a later owner of the pid, the harness
//! token), last-exit.json and played.json after. `status`, `stop` and the readers here are what
//! the command line, the panel and MCP all go by.

use serde_json::{Map, Value, json};

use super::paths::Paths;
use super::{harness, or_null, prop, read_json};
use crate::control;
use crate::failure::Failure;
use crate::js;

/// Field 22 of `/proc/<pid>/stat` (when the process started, in clock ticks since boot), Linux
/// only; counted from the last `)` because the command name may hold spaces and brackets.
pub fn proc_start_ticks(pid: Option<&Value>) -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let stat = std::fs::read(format!("/proc/{}/stat", js::string(pid))).ok()?;
    let stat = String::from_utf8_lossy(&stat);
    let close = stat.rfind(')')?;
    let ticks = stat.get(close + 2..)?.split(' ').nth(19)?;
    (!ticks.is_empty() && ticks.bytes().all(|b| b.is_ascii_digit())).then(|| ticks.to_string())
}

/// `fromBeforeBoot(startedAt)`: a record written before this machine last started (a minute's
/// slack covers a clock set at boot).
pub fn from_before_boot(started_at: Option<&Value>, now: f64, uptime_secs: f64) -> bool {
    let at = crate::jsdate::parse(&js::string(started_at));
    at.is_finite() && at < now - uptime_secs * 1000.0 - 60000.0
}

/// `stateAlive(state)`.
pub fn alive(state: &Value) -> bool {
    let pid = prop(Some(state), "pid");
    if !control::pid_alive(pid) {
        return false;
    }
    // where the process's own start time can be read it decides, both ways
    let ticks = if js::truthy(prop(Some(state), "procStart")) {
        proc_start_ticks(pid)
    } else {
        None
    };
    let started_at = prop(Some(state), "startedAt");
    if let Some(t) = ticks {
        if prop(Some(state), "procStart") != Some(&Value::String(t)) {
            return false;
        }
    } else if from_before_boot(
        started_at,
        crate::util::now(),
        crate::platform::uptime_secs() as f64,
    ) {
        return false;
    }
    let at = crate::jsdate::parse(&js::string(started_at));
    control::same_image_of(
        pid,
        prop(Some(state), "javaExe"),
        if at.is_nan() || at == 0.0 { 0.0 } else { at },
    )
}

/// `readClientState(name)`: the running game's record, or `None` (a record of a game that has
/// gone is removed, unless another launch rewrote it meanwhile).
pub fn read(paths: &Paths, name: &str) -> Result<Option<Value>, Failure> {
    let file = paths.state_file(name);
    let Some(state) = read_json(&file)? else {
        return Ok(None);
    };
    if state.is_null() {
        return Ok(None);
    }
    if alive(&state) {
        return Ok(Some(state));
    }
    let again = read_json(&file)?;
    if super::strict_eq(prop(again.as_ref(), "pid"), prop(Some(&state), "pid")) {
        super::rm_force(&file)?;
    }
    Ok(None)
}

/// `status(name)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub running: bool,
    /// `uptimeMs` as a number: NaN for a start time that does not parse, which JSON writes as
    /// null and the text line as NaN.
    pub uptime_ms: Option<f64>,
    pub json: Value,
}

pub fn status(paths: &Paths, name: &str) -> Result<Status, Failure> {
    super::profiles::get(paths, name)?;
    let st = read(paths, name)?;
    let s = st.as_ref();
    let field = |k: &str| or_null(prop(s, k));
    let uptime_ms = st
        .as_ref()
        .map(|st| crate::util::now() - crate::jsdate::parse(&js::string(prop(Some(st), "startedAt"))));
    let harness = match prop(s, "harness") {
        h if js::truthy(h) => {
            let port = harness::read_file(paths, name, Some(&or_null(prop(s, "pid"))))?
                .and_then(|f| prop(Some(&f), "port").cloned());
            json!({ "port": or_null(port.as_ref()) })
        }
        _ => Value::Null,
    };
    Ok(Status {
        running: st.is_some(),
        uptime_ms,
        json: json!({
            "name": name,
            "running": st.is_some(),
            "pid": field("pid"),
            "startedAt": field("startedAt"),
            "uptimeMs": uptime_ms.map(crate::jsjson::num).unwrap_or(Value::Null),
            "account": field("account"),
            "launchedBy": field("launchedBy"),
            "server": field("server"),
            "address": field("address"),
            "harness": harness,
        }),
    })
}

/// The `client status` line.
pub fn status_text(name: &str, status: &Status) -> String {
    let st = &status.json;
    if status.running {
        let up = status.uptime_ms.unwrap_or(0.0) / 1000.0;
        let account = match prop(prop(Some(st), "account"), "name") {
            v if super::nullish(v) => "?".to_string(),
            v => js::string(v),
        };
        format!(
            "\"{name}\" is running (pid {}, up {}s) as {account}",
            js::string(prop(Some(st), "pid")),
            js::number_to_string(up.floor())
        )
    } else {
        format!("\"{name}\" is stopped")
    }
}

/// `readLastExit(name)`: the last recorded exit, or `None`; a record that cannot be read is none.
pub fn read_last_exit(paths: &Paths, name: &str) -> Option<Value> {
    match read_json(&paths.last_exit(name)) {
        Ok(Some(rec @ Value::Object(_))) if matches!(rec.get("endedAt"), Some(Value::String(_))) => Some(rec),
        _ => None,
    }
}

/// `readPlayed(name)`: when the profile was last played, the time in all and the launches.
pub fn read_played(paths: &Paths, name: &str) -> Value {
    let rec = read_json(&paths.played(name)).ok().flatten();
    let rec = rec.as_ref();
    let known = match prop(rec, "lastPlayedAt") {
        Some(v @ Value::String(_)) => Some(v.clone()),
        _ => read_last_exit(paths, name).and_then(|e| e.get("startedAt").cloned()),
    };
    let total = prop(rec, "totalMs").and_then(Value::as_f64);
    let launches = prop(rec, "launches").and_then(Value::as_f64);
    json!({
        "lastPlayedAt": match known { Some(v @ Value::String(_)) => v, _ => Value::Null },
        "totalMs": match total { Some(t) if t.is_finite() && t > 0.0 => crate::jsjson::num(t), _ => json!(0) },
        "launches": match launches { Some(n) if n.fract() == 0.0 && n > 0.0 && n <= 9007199254740991.0 => crate::jsjson::num(n), _ => json!(0) },
    })
}

/// `waitGone(state, ms)`.
fn wait_gone(state: &Value, ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < deadline && alive(state) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    !alive(state)
}

fn pid_number(state: &Value) -> i32 {
    control::pid_of(prop(Some(state), "pid")).unwrap_or(0)
}

/// `stopClient(name, { quit })`: politely first (the harness's quit when there is one, else a
/// close request so the JVM's shutdown hooks run), then by force after ten seconds.
pub fn stop_client(
    paths: &Paths,
    name: &str,
    quit: Option<&dyn Fn() -> Result<(), Failure>>,
) -> Result<Value, Failure> {
    stop_client_with(paths, name, quit, 10_000)
}

pub fn stop_client_with(
    paths: &Paths,
    name: &str,
    quit: Option<&dyn Fn() -> Result<(), Failure>>,
    timeout_ms: u64,
) -> Result<Value, Failure> {
    let Some(state) = read(paths, name)? else {
        return Ok(json!({ "stopped": false, "wasRunning": false }));
    };
    // for the exit record: this exit, however it comes, was asked for
    let _ = super::write_json(
        &paths.stop_mark(name),
        &json!({ "pid": or_null(prop(Some(&state), "pid")), "at": crate::time::iso_now() }),
    );
    let mut asked = false;
    if let Some(quit) = quit {
        asked = quit().is_ok();
    }
    if !asked {
        asked = crate::platform::ask_to_close(pid_number(&state));
    }
    let mut gone = asked && wait_gone(&state, timeout_ms);
    if !gone {
        crate::util::kill_tree(pid_number(&state));
        gone = wait_gone(&state, 5000);
    }
    if !gone {
        super::rm_force(&paths.stop_mark(name))?;
        return Ok(json!({ "stopped": false, "wasRunning": true }));
    }
    super::rm_force(&paths.state_file(name))?;
    Ok(json!({ "stopped": true, "wasRunning": true }))
}

/// `stop(name)` of client.mjs: through the harness when the game was launched with it.
pub fn stop(paths: &Paths, name: &str) -> Result<Value, Failure> {
    super::profiles::get(paths, name)?;
    let st = read(paths, name)?;
    let harness_state = st
        .as_ref()
        .filter(|s| js::truthy(prop(Some(s), "harness")))
        .cloned();
    match harness_state {
        Some(st) => {
            let quit = || quit_via_harness(paths, name, &st);
            stop_client(paths, name, Some(&quit))
        }
        None => stop_client(paths, name, None),
    }
}

/// `quitViaHarness(name, st)`.
fn quit_via_harness(paths: &Paths, name: &str, st: &Value) -> Result<(), Failure> {
    let pid = or_null(prop(Some(st), "pid"));
    if harness::read_file(paths, name, Some(&pid))?.is_none() {
        return Err(Failure::user(
            "the harness file is missing; the game may still be loading",
        ));
    }
    let token = prop(prop(Some(st), "harness"), "token");
    let mut channel = harness::connect(paths, name, token, 3000, Some(&pid))?;
    channel.call("quit", Map::new(), 5000)?;
    channel.close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_from_before_boot_is_stale() {
        let now = 1_000_000_000_000.0;
        let at = |ms: f64| json!(crate::time::iso(ms as i64));
        // up for an hour: a game started two hours ago cannot be running
        assert!(from_before_boot(Some(&at(now - 7_200_000.0)), now, 3600.0));
        assert!(!from_before_boot(Some(&at(now - 3_000_000.0)), now, 3600.0));
        // within the minute's slack
        assert!(!from_before_boot(Some(&at(now - 3_650_000.0)), now, 3600.0));
        assert!(!from_before_boot(Some(&json!("not a date")), now, 3600.0));
        assert!(!from_before_boot(None, now, 3600.0));
    }

    #[test]
    fn this_process_is_alive_and_a_dead_pid_is_not() {
        let me = std::process::id();
        let started = crate::time::iso_now();
        assert!(alive(&json!({ "pid": me, "startedAt": started })));
        #[cfg(target_os = "linux")]
        {
            let ticks = proc_start_ticks(Some(&json!(me))).unwrap();
            assert!(alive(
                &json!({ "pid": me, "procStart": ticks, "startedAt": started })
            ));
            assert!(!alive(
                &json!({ "pid": me, "procStart": "1", "startedAt": started })
            ));
        }
        assert!(!alive(&json!({ "pid": 0 })));
        assert!(!alive(
            &json!({ "pid": me, "javaExe": "surely-not-this-image", "startedAt": started })
        ));
    }

    #[test]
    fn status_text_reads_like_the_node_line() {
        let of = |running: bool, uptime: Option<f64>, json: Value| Status {
            running,
            uptime_ms: uptime,
            json,
        };
        let st = of(
            true,
            Some(61999.0),
            json!({ "pid": 5, "account": { "name": "Alex" } }),
        );
        assert_eq!(status_text("p", &st), "\"p\" is running (pid 5, up 61s) as Alex");
        let st = of(true, Some(f64::NAN), json!({ "pid": 5, "account": null }));
        assert_eq!(status_text("p", &st), "\"p\" is running (pid 5, up NaNs) as ?");
        assert_eq!(status_text("p", &of(false, None, json!({}))), "\"p\" is stopped");
    }
}
