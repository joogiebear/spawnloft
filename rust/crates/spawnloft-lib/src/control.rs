//! The client side of `control.mjs` the read-only commands need: a server's state file
//! reconciled against the live processes (`readState`).

use serde_json::{Map, Value};
use std::path::Path;

use crate::failure::Failure;
use crate::{js, procid};

/// `readState(name).status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Stopped,
    Stopping,
    Orphaned,
    Stale,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Stopped => "stopped",
            Status::Stopping => "stopping",
            Status::Orphaned => "orphaned",
            Status::Stale => "stale",
        }
    }
    /// `STATUS_LABEL` in mcctl.mjs.
    pub fn label(self) -> &'static str {
        match self {
            Status::Orphaned => "ORPHANED",
            other => other.as_str(),
        }
    }
}

/// `pidAlive(pid)`: a positive whole pid the system says is there.
pub fn pid_of(v: Option<&Value>) -> Option<u32> {
    let n = v?.as_f64()?;
    (n >= 1.0 && n.fract() == 0.0 && n <= f64::from(u32::MAX)).then_some(n as u32)
}

pub fn pid_alive(v: Option<&Value>) -> bool {
    pid_of(v).is_some_and(procid::alive)
}

fn same(state: &Map<String, Value>, pid_key: &str, exe_key: &str, start_key: Option<&str>) -> bool {
    let Some(pid) = pid_of(state.get(pid_key)) else {
        return false;
    };
    if !procid::alive(pid) {
        return false;
    }
    // sameProcess: nothing recorded to compare against means the live pid is trusted
    let exe = state
        .get(exe_key)
        .filter(|v| js::truthy(Some(v)))
        .map(|v| js::string(Some(v)));
    let start_time = start_key.and_then(|k| procid::parse_start_time(state.get(k)));
    if exe.is_none() {
        return true;
    }
    procid::same_process(&procid::Recorded {
        pid,
        exe: exe.as_deref(),
        start_time,
    })
}

/// `readState(name)`: the status and the state file's record. A file that is not JSON fails as
/// it does in the Node core.
pub fn read_state(state_file: &Path) -> Result<(Status, Option<Map<String, Value>>), Failure> {
    let text = match std::fs::read(state_file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Status::Stopped, None)),
        Err(e) => return Err(Failure::read(&e, state_file)),
    };
    let value = crate::jsjson::parse(&text).map_err(Failure::syntax)?;
    if !js::truthy(Some(&value)) {
        return Ok((Status::Stopped, None));
    }
    let state = match value {
        Value::Object(m) => m,
        // a truthy non-object reads every field as undefined
        _ => Map::new(),
    };
    let daemon_up = same(&state, "daemonPid", "daemonExe", Some("daemonStartTime"));
    let java_up = same(&state, "javaPid", "javaExe", None);
    let running = js::truthy(state.get("running"));
    let status = match (running, daemon_up, java_up) {
        (true, true, true) => Status::Running,
        (true, false, true) => Status::Orphaned,
        (true, true, false) => Status::Stopping,
        (true, false, false) => Status::Stale,
        _ => Status::Stopped,
    };
    Ok((status, Some(state)))
}
