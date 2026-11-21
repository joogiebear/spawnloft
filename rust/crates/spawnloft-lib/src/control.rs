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

/// The pid `process.kill(pid, 0)` would signal: a truthy value equal to its own int32
/// (`pid != (pid | 0)` throws, and `pidAlive` answers false). Strings, `true` and one-element
/// arrays coerce as they do in JavaScript.
pub fn pid_of(v: Option<&Value>) -> Option<i32> {
    if !js::truthy(v) {
        return None;
    }
    let n = js::number(v);
    (n.is_finite() && n.fract() == 0.0 && n >= f64::from(i32::MIN) && n <= f64::from(i32::MAX))
        .then_some(n as i32)
}

/// `pidAlive(pid)`.
pub fn pid_alive(v: Option<&Value>) -> bool {
    pid_of(v).is_some_and(crate::platform::signal_zero)
}

/// The process table `processImage` reads (`ps -A -o pid=,comm=`, or `tasklist` on Windows),
/// pid to image name. Read again when older than two seconds, as util.mjs does.
fn process_image(pid: f64) -> Option<String> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    type Table = Option<(Instant, Option<Vec<(f64, String)>>)>;
    static TABLE: Mutex<Table> = Mutex::new(None);
    let mut held = TABLE.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = held
        .as_ref()
        .is_some_and(|(at, _)| at.elapsed() <= Duration::from_secs(2));
    if !fresh {
        *held = Some((Instant::now(), read_process_table()));
    }
    let rows = held.as_ref().and_then(|(_, rows)| rows.as_ref())?;
    rows.iter()
        .rfind(|(p, _)| *p == pid)
        .map(|(_, name)| name.clone())
}

fn read_process_table() -> Option<Vec<(f64, String)>> {
    let (cmd, args): (&str, &[&str]) = if cfg!(windows) {
        ("tasklist", &["/FO", "CSV", "/NH"])
    } else {
        ("ps", &["-A", "-o", "pid=,comm="])
    };
    let mut command = std::process::Command::new(cmd);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, as windowsHide
    }
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_process_table(
        &String::from_utf8_lossy(&out.stdout),
        cfg!(windows),
    ))
}

/// `parseProcessTable`.
pub fn parse_process_table(stdout: &str, windows: bool) -> Vec<(f64, String)> {
    use std::sync::LazyLock;
    static WIN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"^"([^"]*)","([0-9]+)""#).expect("valid"));
    static UNIX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*([0-9]+)[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+(.+?)[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$")
            .expect("valid")
    });
    let mut rows = Vec::new();
    if windows {
        for line in stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(m) = WIN.captures(line) {
                rows.push((js::string_to_number(&m[2]), m[1].to_string()));
            }
        }
    } else {
        for line in stdout.split('\n') {
            if let Some(m) = UNIX.captures(line) {
                rows.push((js::string_to_number(&m[1]), posix_basename(&m[2]).to_string()));
            }
        }
    }
    rows
}

/// `path.posix.basename`: the last segment, trailing slashes ignored.
fn posix_basename(p: &str) -> &str {
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `sameImage(actual, expected)`: case-insensitive, without `.exe`; on Linux a table name of
/// exactly fifteen bytes (the kernel's limit) matches any name it starts.
pub fn same_image(actual: &str, expected: &str, linux: bool) -> bool {
    let strip = |s: &str| {
        let low = s.to_lowercase();
        low.strip_suffix(".exe").map(str::to_string).unwrap_or(low)
    };
    let (a, e) = (strip(actual), strip(expected));
    a == e || (linux && a.len() == 15 && e.starts_with(&a))
}

/// `sameProcess(pid, expectedImage)` as the Node core decides it, with one addition: a record
/// carrying `daemonStartTime` (written by 2.0's daemon) is decided by the kernel creation time
/// when the system reports one (declared difference `process-start-time`).
fn same(state: &Map<String, Value>, pid_key: &str, exe_key: &str, start_key: Option<&str>) -> bool {
    let raw = state.get(pid_key);
    let Some(pid) = pid_of(raw) else {
        return false;
    };
    if !crate::platform::signal_zero(pid) {
        return false;
    }
    if let Some(want) = start_key.and_then(|k| procid::parse_start_time(state.get(k)))
        && let Some(got) = u32::try_from(pid).ok().and_then(procid::start_time)
    {
        return want == got;
    }
    let expected = state.get(exe_key);
    if !js::truthy(expected) {
        return true;
    }
    let expected = js::string(expected);
    let linux = cfg!(target_os = "linux");
    if linux && let Ok(link) = std::fs::read_link(format!("/proc/{pid}/exe")) {
        let link = link.to_string_lossy();
        let link = link.strip_suffix(" (deleted)").unwrap_or(&link);
        if same_image(posix_basename(link), &expected, linux) {
            return true;
        }
    }

    // the table is keyed by number: a pid recorded as a string finds nothing there
    let Some(key) = raw.and_then(Value::as_f64) else {
        return true;
    };
    match process_image(key) {
        Some(actual) => same_image(&actual, &expected, linux),
        None => true,
    }
}

/// `readState(name)`: the status and the state file's record. A file that is not JSON fails as
/// it does in the Node core.
pub fn read_state(state_file: &Path) -> Result<(Status, Option<Map<String, Value>>), Failure> {
    let text = match std::fs::read(state_file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if crate::jspath::is_enoent(&e) => return Ok((Status::Stopped, None)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pids_coerce_as_process_kill_does() {
        assert_eq!(pid_of(Some(&json!(42))), Some(42));
        assert_eq!(pid_of(Some(&json!("42"))), Some(42));
        assert_eq!(pid_of(Some(&json!([7]))), Some(7));
        assert_eq!(pid_of(Some(&json!(true))), Some(1));
        assert_eq!(pid_of(Some(&json!(-1))), Some(-1));
        for none in [
            json!(0),
            json!(1.5),
            json!(""),
            json!(null),
            json!("x"),
            json!(4_294_967_296u64),
        ] {
            assert_eq!(pid_of(Some(&none)), None, "{none}");
        }
    }

    #[test]
    fn the_process_table_reads_as_util_mjs_reads_it() {
        let ps = "    1 /sbin/init\n  42 java\n 77 spawnloft-deskt\nbad line\n  42 later\n";
        let rows = parse_process_table(ps, false);
        assert_eq!(rows[0], (1.0, "init".to_string()));
        assert_eq!(rows.iter().rfind(|(p, _)| *p == 42.0).unwrap().1, "later");
        let tasklist = "\"java.exe\",\"1234\",\"Console\",\"1\",\"100 K\"\r\n\"x\",\"y\"\r\n";
        assert_eq!(
            parse_process_table(tasklist, true),
            vec![(1234.0, "java.exe".to_string())]
        );
        assert!(same_image("spawnloft-deskt", "spawnloft-desktop", true));
        assert!(!same_image("spawnloft-deskt", "spawnloft-desktop", false));
        assert!(same_image("JAVA.EXE", "java", false));
        assert!(!same_image("javaw", "java", true));
    }
}
