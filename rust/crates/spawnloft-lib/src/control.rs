//! The client side of `control.mjs`: a server's state file reconciled against the live
//! processes (`readState`), requests to its daemon over the control channel (`controlRequest`),
//! and the restore marker and the guards built on them (`activeBlock`).

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
/// pid to image name, and when it was read (epoch ms). Read again when older than two seconds,
/// or at once when `force` (sameProcess's recheck), as util.mjs does.
fn process_image(pid: f64, force: bool) -> (Option<String>, i64) {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    type Table = Option<(Instant, i64, Option<Vec<(f64, String)>>)>;
    static TABLE: Mutex<Table> = Mutex::new(None);
    let mut held = TABLE.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = held
        .as_ref()
        .is_some_and(|(at, _, _)| at.elapsed() <= Duration::from_secs(2));
    if force || !fresh {
        let (at, wall) = (Instant::now(), crate::time::now_ms());
        match read_process_table() {
            Some(rows) => *held = Some((at, wall, Some(rows))),
            // a failed recheck keeps the table it had, as util.mjs does
            None if force && held.is_some() => {}
            None => *held = Some((at, wall, None)),
        }
    }
    let Some((_, wall, rows)) = held.as_ref() else {
        return (None, 0);
    };
    let name = rows
        .as_ref()
        .and_then(|rows| rows.iter().rfind(|(p, _)| *p == pid))
        .map(|(_, name)| name.clone());
    (name, *wall)
}

/// `readProcessTable()`: `None` when the command fails or takes over 10 s.
fn read_process_table() -> Option<Vec<(f64, String)>> {
    use std::io::Read;
    let (cmd, args): (&str, &[&str]) = if cfg!(windows) {
        ("tasklist", &["/FO", "CSV", "/NH"])
    } else {
        ("ps", &["-A", "-o", "pid=,comm="])
    };
    let mut command = std::process::Command::new(cmd);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, as windowsHide
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let left = deadline.saturating_duration_since(std::time::Instant::now());
    let out = rx.recv_timeout(left).ok()?;
    if !status.success() {
        return None;
    }
    Some(parse_process_table(&String::from_utf8_lossy(&out), cfg!(windows)))
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
    same_image_of(raw, state.get(exe_key), js::number(state.get("startedAt")))
}

/// `sameProcess(pid, expectedImage, startedAt)` of util.mjs, for a pid already known to be
/// alive: the image's file name against the recorded one (none recorded: yes). `started_at` is
/// epoch ms; a process table older than that which contradicts the record is read again.
pub fn same_image_of(raw: Option<&Value>, expected: Option<&Value>, started_at: f64) -> bool {
    let Some(pid) = pid_of(raw) else {
        return true;
    };
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
    let (mut actual, table_at) = process_image(key, false);
    // pids are reused: a table older than this launch that contradicts the record is read again
    // before it is believed, so a new daemon is not taken for the previous owner of its pid
    if let Some(a) = &actual
        && started_at > table_at as f64
        && !same_image(a, &expected, linux)
    {
        actual = process_image(key, true).0;
    }
    match actual {
        Some(actual) => same_image(&actual, &expected, linux),
        None => true,
    }
}

/// Whether a state file's bytes are what a power cut leaves of a write that never reached the
/// disk: nothing, or only NUL bytes (NTFS keeps the new length and zeroes the data). Such a file
/// was being written when the machine went down, so nothing it could name is still running.
pub fn is_torn_state(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| b == 0 || b.is_ascii_whitespace())
}

/// Removes every `run/<name>/state.json` under `data_root` that [`is_torn_state`]: 1.x's
/// `readState` stops every command on one ("JSON parse error"), so the handover clears them
/// before it asks 1.x to list or start anything, and Paper caches a cut zeroed
/// ([`clear_torn_paper_remap`]). Returns what it cleared, one phrase each.
pub fn clear_torn_states(data_root: &Path) -> Vec<String> {
    let mut cleared = Vec::new();
    let Ok(dirs) = std::fs::read_dir(data_root.join("run")) else {
        return cleared;
    };
    for d in dirs.flatten() {
        let file = d.path().join("state.json");
        if let Ok(b) = std::fs::read(&file)
            && is_torn_state(&b)
            && std::fs::remove_file(&file).is_ok()
        {
            cleared.push(format!("{}'s run-state file", d.file_name().to_string_lossy()));
        }
    }
    // Paper's cache too: the handover's restore starts servers under 1.x, which has no daemon
    // that clears it, so a cut there would leave Paper refusing to start
    let registry = std::fs::read(data_root.join("instances.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(Value::Object(instances)) = registry.as_ref().and_then(|r| r.get("instances")) {
        for (name, inst) in instances {
            if let Some(dir) = inst.get("dir").and_then(Value::as_str)
                && clear_torn_paper_remap(Path::new(dir))
            {
                cleared.push(format!("{name}'s Paper plugin cache"));
            }
        }
    }
    cleared.sort();
    cleared
}

/// Paper's plugin remapping cache (`plugins/.paper-remapped`) when a power cut zeroed one of its
/// `index.json` files: Paper then refuses to start ("Failed to create PluginRemapper, try deleting
/// the 'plugins\.paper-remapped' directory"). The folder is a cache Paper rebuilds from the
/// plugin jars at the next start, so it is removed before a launch. Returns whether it was.
pub fn clear_torn_paper_remap(server_dir: &Path) -> bool {
    let cache = server_dir.join("plugins").join(".paper-remapped");
    let mut torn = false;
    let mut stack = vec![cache.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if e.file_name() == "index.json" && std::fs::read(&path).is_ok_and(|b| is_torn_state(&b)) {
                torn = true;
            }
        }
    }
    torn && std::fs::remove_dir_all(&cache).is_ok()
}

/// `readState(name)`: the status and the state file's record. A file that is not JSON fails as
/// it does in the Node core, except one a power cut left empty or zeroed ([`is_torn_state`]),
/// which reads as stopped: otherwise one cut while a server stops locks out every command.
pub fn read_state(state_file: &Path) -> Result<(Status, Option<Map<String, Value>>), Failure> {
    let text = match std::fs::read(state_file) {
        Ok(b) if is_torn_state(&b) => return Ok((Status::Stopped, None)),
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
    let java_up = same(&state, "javaPid", "javaExe", Some("javaStartTime"));
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

/// `ACTIVE_STATUSES`: a status whose process still owns the instance's files.
pub fn is_active_status(status: Status) -> bool {
    matches!(status, Status::Running | Status::Stopping | Status::Orphaned)
}

/// `clearState(name)`: removes the state file, if any.
pub fn clear_state(state_file: &Path) {
    let _ = std::fs::remove_file(state_file);
}

/// `restoreMarker(name)`: `restoring.json` beside the state file.
pub fn restore_marker(state_file: &Path) -> std::path::PathBuf {
    state_file
        .parent()
        .map(|d| d.join("restoring.json"))
        .unwrap_or_else(|| "restoring.json".into())
}

/// `isRestoring(name)`: a marker whose `pid` is a whole number naming a live process. A marker
/// that is not JSON reads as none (`readJson` with a fallback).
pub fn is_restoring(state_file: &Path) -> bool {
    let Ok(b) = std::fs::read(restore_marker(state_file)) else {
        return false;
    };
    let Ok(Value::Object(mark)) = crate::jsjson::parse(&String::from_utf8_lossy(&b)) else {
        return false;
    };
    let pid = mark.get("pid");
    let whole = pid
        .and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0);
    whole && pid_alive(pid)
}

/// `restoreBlock(name, verb)`.
pub fn restore_block(state_file: &Path, name: &str, verb: &str) -> Option<String> {
    is_restoring(state_file).then(|| {
        format!("A backup is being put back into \"{name}\" right now. Wait for it to finish before {verb}.")
    })
}

/// `activeBlock(name, verb)`: why an operation on this instance's files has to wait, or `None`.
pub fn active_block(state_file: &Path, name: &str, verb: &str) -> Result<Option<String>, Failure> {
    if let Some(r) = restore_block(state_file, name, verb) {
        return Ok(Some(r));
    }
    let (status, state) = read_state(state_file)?;
    Ok(match status {
        Status::Running => Some(format!("\"{name}\" is running - stop it before {verb}.")),
        Status::Stopping => Some(format!(
            "\"{name}\" is still shutting down - wait for it to finish before {verb}."
        )),
        Status::Orphaned => Some(format!(
            "\"{name}\" is still running but out of reach (java pid {}, nothing looking after it) - force stop it before {verb}: the button on its page, or \"spawnloft kill {name}\".",
            js::string(state.as_ref().and_then(|s| s.get("javaPid")))
        )),
        _ => None,
    })
}

/// How a control request ended without a reply.
/// The net module's words: `connect ECONNRESET /path`, `write EPIPE`, `read ECONNRESET`.
fn channel_failure(name: &str, syscall: &str, addr: &str, e: &std::io::Error) -> Failure {
    let (code, _) = crate::jspath::error_code(e);
    if matches!(code, "ENOENT" | "ECONNREFUSED") {
        Failure::user(format!("instance \"{name}\" is not running"))
    } else if syscall == "connect" {
        Failure::user(format!("control channel error: connect {code} {addr}"))
    } else {
        Failure::user(format!("control channel error: {syscall} {code}"))
    }
}

#[cfg(unix)]
fn open_channel(addr: &str) -> std::io::Result<Box<dyn ReadWrite>> {
    Ok(Box::new(std::os::unix::net::UnixStream::connect(addr)?))
}

#[cfg(windows)]
fn open_channel(addr: &str) -> std::io::Result<Box<dyn ReadWrite>> {
    // all instances busy (ERROR_PIPE_BUSY): libuv waits for one to come free, so does this
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(addr) {
            Ok(f) => return Ok(Box::new(f)),
            Err(e) if e.raw_os_error() == Some(231) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

trait ReadWrite: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> ReadWrite for T {}

/// `controlRequest(name, req, { timeout })`: one JSON line to the daemon at `addr`, one JSON
/// line back. The wait runs on a thread of its own so the timeout holds however the channel
/// behaves; `timeout_ms` is a JavaScript number, waited as `setTimeout` waits it.
pub fn control_request(addr: &str, name: &str, req: &Value, timeout_ms: f64) -> Result<Value, Failure> {
    use std::io::{Read, Write};
    let op = js::string(req.get("op"));
    let line = format!("{}\n", crate::jsjson::stringify(req));
    let (tx, rx) = std::sync::mpsc::channel::<Result<Value, Failure>>();
    let (addr_t, name_t, op_t) = (addr.to_string(), name.to_string(), op.clone());
    std::thread::spawn(move || {
        let answer = (|| -> Result<Value, Failure> {
            let mut ch =
                open_channel(&addr_t).map_err(|e| channel_failure(&name_t, "connect", &addr_t, &e))?;
            ch.write_all(line.as_bytes())
                .map_err(|e| channel_failure(&name_t, "write", &addr_t, &e))?;
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match ch.read(&mut chunk) {
                    Ok(0) => {
                        return Err(Failure::user(format!(
                            "daemon for \"{name_t}\" closed the connection without replying to \"{op_t}\""
                        )));
                    }
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                            let text = String::from_utf8_lossy(&buf[..nl]).into_owned();
                            return crate::jsjson::parse(&text)
                                .map_err(|e| Failure::user(format!("bad response from daemon: {e}")));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    // a pipe whose server end went away mid-read: Node sees the close
                    Err(e) if matches!(e.raw_os_error(), Some(109)) && cfg!(windows) => {
                        return Err(Failure::user(format!(
                            "daemon for \"{name_t}\" closed the connection without replying to \"{op_t}\""
                        )));
                    }
                    Err(e) => return Err(channel_failure(&name_t, "read", &addr_t, &e)),
                }
            }
        })();
        let _ = tx.send(answer);
    });
    match rx.recv_timeout(crate::util::timer(timeout_ms)) {
        Ok(answer) => answer,
        Err(_) => Err(Failure::user(format!(
            "control request \"{op}\" timed out for \"{name}\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_zeroed_paper_remap_index_removes_the_cache_and_a_good_one_does_not() {
        let dir = std::env::temp_dir().join(format!("sl-ctl-remap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = dir.join("plugins").join(".paper-remapped");
        std::fs::create_dir_all(cache.join("extra-plugins")).unwrap();
        std::fs::write(cache.join("index.json"), b"{\"v\":1}").unwrap();
        std::fs::write(cache.join("extra-plugins").join("index.json"), b"{}").unwrap();
        assert!(!clear_torn_paper_remap(&dir));
        assert!(cache.exists());
        std::fs::write(cache.join("extra-plugins").join("index.json"), vec![0u8; 127]).unwrap();
        assert!(clear_torn_paper_remap(&dir));
        assert!(!cache.exists() && dir.join("plugins").exists());
        // no cache at all: nothing to do
        assert!(!clear_torn_paper_remap(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_registry_a_power_cut_zeroed_says_so_and_is_not_read_as_empty() {
        let dir = std::env::temp_dir().join(format!("sl-ctl-reg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let reg = dir.join("instances.json");
        std::fs::write(&reg, vec![0u8; 300]).unwrap();
        let err = crate::registry::load(&reg).unwrap_err();
        assert!(
            err.message().contains("is empty: a power cut or crash"),
            "{}",
            err.message()
        );
        assert!(crate::registry::lookup(&reg, "survival").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_state_file_a_power_cut_zeroed_reads_as_stopped_and_is_cleared() {
        let root = std::env::temp_dir().join(format!("sl-ctl-torn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (name, bytes) in [
            ("zeroed", vec![0u8; 502]),
            ("empty", Vec::new()),
            ("good", br#"{"running":false}"#.to_vec()),
            ("garbage", b"{not json".to_vec()),
        ] {
            std::fs::create_dir_all(root.join("run").join(name)).unwrap();
            std::fs::write(root.join("run").join(name).join("state.json"), bytes).unwrap();
        }
        let state = |n: &str| root.join("run").join(n).join("state.json");
        assert_eq!(read_state(&state("zeroed")).unwrap(), (Status::Stopped, None));
        assert_eq!(read_state(&state("empty")).unwrap(), (Status::Stopped, None));
        assert_eq!(read_state(&state("good")).unwrap().0, Status::Stopped);
        // anything else that is not JSON still fails as the Node core does
        assert!(read_state(&state("garbage")).is_err());
        // a server whose Paper cache was zeroed too, named in instances.json
        let srv = root.join("srv");
        std::fs::create_dir_all(srv.join("plugins").join(".paper-remapped")).unwrap();
        std::fs::write(
            srv.join("plugins").join(".paper-remapped").join("index.json"),
            vec![0u8; 9],
        )
        .unwrap();
        let reg = json!({ "version": 1, "instances": { "zeroed": { "dir": srv.to_string_lossy() } } });
        std::fs::write(root.join("instances.json"), reg.to_string()).unwrap();
        assert_eq!(
            clear_torn_states(&root),
            vec![
                "empty's run-state file".to_string(),
                "zeroed's Paper plugin cache".to_string(),
                "zeroed's run-state file".to_string()
            ]
        );
        assert!(!srv.join("plugins").join(".paper-remapped").exists());
        assert!(!state("zeroed").exists() && !state("empty").exists());
        assert!(state("good").exists() && state("garbage").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn the_control_channel_fails_as_the_node_client_does() {
        let dir = std::env::temp_dir().join(format!("sl-ctl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("control.sock");
        let addr = sock.to_string_lossy().into_owned();
        // nothing there: not running
        let f = control_request(&addr, "s", &json!({ "op": "ping" }), 1000.0).unwrap_err();
        assert_eq!(f.message(), "instance \"s\" is not running");
        // a listener that hangs up, one that answers garbage, one that never answers
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let serve = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut b = [0u8; 64];
            // read the request, then hang up (a hang-up with it unread is a reset instead)
            let (mut c, _) = listener.accept().unwrap();
            let _ = c.read(&mut b);
            drop(c);
            let (mut c, _) = listener.accept().unwrap();
            let _ = c.read(&mut b);
            c.write_all(b"not json\n").unwrap();
            let (c, _) = listener.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(400));
            drop(c);
        });
        let f = control_request(&addr, "s", &json!({ "op": "ping" }), 1000.0).unwrap_err();
        assert_eq!(
            f.message(),
            "daemon for \"s\" closed the connection without replying to \"ping\""
        );
        let f = control_request(&addr, "s", &json!({ "op": "ping" }), 1000.0).unwrap_err();
        assert!(
            f.message().starts_with("bad response from daemon: "),
            "{}",
            f.message()
        );
        let f = control_request(&addr, "s", &json!({ "op": "stop" }), 100.0).unwrap_err();
        assert_eq!(f.message(), "control request \"stop\" timed out for \"s\"");
        serve.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

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
