//! `supervisor.mjs`: a server's status record (`statusOf`), the tail of its console (`tailLog`)
//! and following it (`followLog`), pulled forward for C1; and since C2 the lifecycle itself:
//! starting a daemon and waiting for ready (`start`), stopping and force-killing it, and lines
//! to its console (`sendConsole`).

use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::activity::{self, Actor};
use crate::control::{self, Status};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{daemon_launch, js, jsjson, time, util};

/// `x ?? null`.
fn or_null(state: Option<&Map<String, Value>>, key: &str) -> Value {
    state.and_then(|s| s.get(key)).cloned().unwrap_or(Value::Null)
}

/// `statusOf(name)`: the registry record with the live status and the state file's figures.
pub fn status_of(layout: &Layout, name: &str) -> Result<(Instance, Status), Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    status_of_instance(layout, inst, name)
}

/// [`status_of`] for a record already read. The run folder is the one of `key`, the name it was
/// looked up by, even when the record carries a `name` of its own.
pub fn status_of_instance(layout: &Layout, inst: Instance, key: &str) -> Result<(Instance, Status), Failure> {
    let name = key.to_string();
    let (status, state) = control::read_state(Path::new(&layout.state_file(&name)))?;
    let s = state.as_ref();
    let mut fields = inst.fields;
    let started = s.and_then(|m| m.get("startedAt"));
    let uptime = if status == Status::Running && js::truthy(started) {
        jsjson::num(time::now_ms() as f64 - js::number(started))
    } else {
        Value::Null
    };
    let restarts = match s.and_then(|m| m.get("restarts")) {
        None | Some(Value::Null) => json!(0),
        Some(v) => v.clone(),
    };
    let rows = [
        ("status", json!(status.as_str())),
        ("javaPid", or_null(s, "javaPid")),
        ("daemonPid", or_null(s, "daemonPid")),
        ("startedAt", or_null(s, "startedAt")),
        ("exitCode", or_null(s, "exitCode")),
        ("crashed", json!(js::truthy(s.and_then(|m| m.get("crashed"))))),
        ("restarts", restarts),
        ("stoppedAt", or_null(s, "stoppedAt")),
        ("lastError", or_null(s, "error")),
        ("uptimeMs", uptime),
        ("stateFile", json!(layout.state_file(&name))),
        ("consoleLog", json!(layout.console_log(&name))),
        (
            "javaAlive",
            json!(s.is_some() && control::pid_alive(s.and_then(|m| m.get("javaPid")))),
        ),
    ];
    for (k, v) in rows {
        fields.insert(k.into(), v);
    }
    Ok((
        Instance {
            name: inst.name,
            fields,
        },
        status,
    ))
}

/// `array.slice(start)`'s first index for a JavaScript number `start`.
pub fn slice_start(len: usize, start: f64) -> usize {
    let rel = if start.is_nan() { 0.0 } else { start.trunc() };
    let len_f = len as f64;
    if rel < 0.0 {
        (len_f + rel).max(0.0) as usize
    } else {
        rel.min(len_f) as usize
    }
}

/// Splits on `\r?\n` as `text.split(/\r?\n/)` does.
pub fn split_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            let end = if i > start && b[i - 1] == b'\r' { i - 1 } else { i };
            out.push(text[start..end].to_string());
            start = i + 1;
        }
        i += 1;
    }
    out.push(text[start..].to_string());
    out
}

/// `tailLog(name, count)`: the last `count` lines of the console, read from the last
/// `max(64 KB, count * 512)` bytes. `count` is a JavaScript number, so a nonsense one fails the
/// way Node's `Buffer.alloc` does.
pub fn tail_log(file: &Path, count: f64) -> Result<Vec<String>, Failure> {
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(Vec::new());
    };
    let size = meta.len() as f64;
    // Math.max and Math.min keep a NaN, where f64::max and min drop it
    let scaled = count * 512.0;
    let want = if scaled.is_nan() {
        f64::NAN
    } else {
        scaled.max(65536.0)
    };
    let read_bytes = if want.is_nan() { f64::NAN } else { size.min(want) };
    if read_bytes.is_nan() {
        return Err(Failure::Internal {
            head: "RangeError [ERR_OUT_OF_RANGE]".into(),
            message:
                "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received NaN"
                    .into(),
            code: Some("ERR_OUT_OF_RANGE".into()),
        });
    }
    // readSync's position, size - readBytes, must be whole once the read starts past the start
    if size > read_bytes && read_bytes.fract() != 0.0 {
        return Err(Failure::Internal {
            head: "RangeError [ERR_OUT_OF_RANGE]".into(),
            message: format!(
                "The value of \"position\" is out of range. It must be an integer. Received {}",
                crate::js::number_to_string(size - read_bytes)
            ),
            code: Some("ERR_OUT_OF_RANGE".into()),
        });
    }
    // Buffer.alloc rounds the size down
    let n = read_bytes.trunc() as u64;
    // buf.toString refuses more bytes than V8's longest string; refuse before allocating them
    if n > 0x1fff_ffe8 {
        return Err(Failure::Internal {
            head: "Error".into(),
            message: "Cannot create a string longer than 0x1fffffe8 characters".into(),
            code: Some("ERR_STRING_TOO_LONG".into()),
        });
    }
    let mut f = match std::fs::File::open(file) {
        Ok(f) => f,
        // Windows will not open a folder, which Node opens and then fails to read
        Err(e) if file.is_dir() => return Err(Failure::read(&e, file)),
        Err(e) => return Err(Failure::io(&e, "open", Some(file))),
    };
    f.seek(SeekFrom::Start(meta.len() - n))
        .map_err(|e| Failure::io(&e, "read", None))?;
    let mut buf = vec![0u8; n as usize];
    let mut got = 0;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(e) => return Err(Failure::io(&e, "read", None)),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = split_lines(&text);
    if size > read_bytes && !lines.is_empty() {
        // a partial first line
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let from = slice_start(lines.len(), -count);
    Ok(lines.split_off(from))
}

/// `followLog(name, onLine)`: polls the console every 250 ms from its current end (or the start
/// after a restart truncated it) and hands each whole new line to `on_line`. Returns when
/// `on_line` says to stop (`false`); read errors are retried at the next poll.
pub fn follow_log(file: &Path, mut on_line: impl FnMut(&str) -> bool) {
    let mut offset = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let mut carry = String::new();
    loop {
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        if size < offset {
            offset = 0;
            carry.clear();
        }
        if size > offset
            && let Ok(mut f) = std::fs::File::open(file)
            && f.seek(SeekFrom::Start(offset)).is_ok()
        {
            let mut buf = vec![0u8; (size - offset) as usize];
            if f.read_exact(&mut buf).is_ok() {
                offset = size;
                carry.push_str(&String::from_utf8_lossy(&buf));
                let mut parts = split_lines(&carry);
                carry = parts.pop().unwrap_or_default();
                for line in parts {
                    if !on_line(&line) {
                        return;
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

// ------------------------------------------------------------------------- the lifecycle (C2)

fn roots(layout: &Layout) -> Roots {
    Roots::new(&layout.data_root)
}

fn state_path(layout: &Layout, name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(layout.state_file(name))
}

fn control_addr(layout: &Layout, name: &str) -> Result<String, Failure> {
    crate::paths::control_path(&roots(layout), name).map_err(Failure::user)
}

/// `readState(name)` for a layout.
pub fn read_state(layout: &Layout, name: &str) -> Result<(Status, Option<Map<String, Value>>), Failure> {
    control::read_state(&state_path(layout, name))
}

/// `inst.rcon.<key>`, failing as JavaScript does when the record has no `rcon`.
fn rcon_field(inst: &Instance, key: &str) -> Result<Value, Failure> {
    match inst.get("rcon") {
        None => Err(Failure::type_error(format!(
            "Cannot read properties of undefined (reading '{key}')"
        ))),
        Some(Value::Null) => Err(Failure::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Some(r) => Ok(r.get(key).cloned().unwrap_or(Value::Null)),
    }
}

/// `String(x)` of a field that may be missing (`undefined`).
fn text(v: Option<&Value>) -> String {
    js::string(v)
}

/// `syncProps(inst)`: the registry's port and RCON pushed into server.properties on every launch.
pub fn sync_props(inst: &Instance) -> Result<(), Failure> {
    let file = crate::jspath::join_path(&text(inst.get("dir")), &["server.properties"]);
    let rcon_port = rcon_field(inst, "port")?;
    let rcon_password = rcon_field(inst, "password")?;
    let undefined_if_missing = |v: &Value, key: &str| {
        if inst.get("rcon").and_then(|r| r.get(key)).is_none() {
            "undefined".to_string()
        } else {
            js::string(Some(v))
        }
    };
    let mut updates = vec![
        ("server-port".to_string(), text(inst.get("port"))),
        ("enable-rcon".into(), "true".into()),
        ("rcon.port".into(), undefined_if_missing(&rcon_port, "port")),
        (
            "rcon.password".into(),
            undefined_if_missing(&rcon_password, "password"),
        ),
        ("broadcast-rcon-to-ops".into(), "true".into()),
    ];
    if js::truthy(inst.get("bind")) {
        updates.push(("server-ip".into(), text(inst.get("bind"))));
    }
    crate::props::write(&file, &updates)
}

/// `assertEula(inst)`.
pub fn assert_eula(inst: &Instance) -> Result<(), Failure> {
    use std::sync::LazyLock;
    // /^\s*eula\s*=\s*true\s*$/im with JavaScript's \s (U+FEFF and U+2028 among it, no U+0085)
    // and its line ends for ^ and $ (\n, \r, U+2028, U+2029)
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        let ws = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
        let eol = r"[\n\r\u{2028}\u{2029}]";
        regex::Regex::new(&format!(
            r"(?i)(?:\A|{eol}){ws}*eula{ws}*={ws}*true{ws}*(?:\z|{eol})"
        ))
        .expect("valid")
    });
    let eula = crate::jspath::join(&[&text(inst.get("dir")), "eula.txt"]);
    let body = if Path::new(&eula).exists() {
        match std::fs::read(&eula) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => return Err(Failure::read(&e, Path::new(&eula))),
        }
    } else {
        String::new()
    };
    if RE.is_match(&body) {
        return Ok(());
    }
    Err(Failure::user(format!(
        "EULA not accepted for \"{}\".\n  Read https://aka.ms/MinecraftEULA then set eula=true in {eula}\n  or re-create the instance with --accept-eula.",
        inst.name
    )))
}

fn java_patch(layout: &Layout, name: &str, java: &str) -> Result<Instance, Failure> {
    let patch = Map::from_iter([("java".to_string(), json!(java))]);
    registry::update_instance(Path::new(&layout.registry_file), name, &patch)
}

/// `ensureJava(inst, { force })`: a missing Java found elsewhere (and saved), one too old for the
/// version refused unless forced, an explicit path that has gone refused.
fn ensure_java(layout: &Layout, inst: Instance, force: bool) -> Result<Instance, Failure> {
    use crate::java;
    let bin = if js::truthy(inst.get("java")) {
        text(inst.get("java"))
    } else {
        "java".into()
    };
    if java::is_script(&bin) {
        return Ok(inst);
    }
    let mc = crate::plugins::mc_version_of(&inst);
    let needs = java::required_major(mc.as_deref());
    let state = java::probe(&bin);
    let mc_text = mc.clone().unwrap_or_else(|| "null".into());
    if state.found {
        let Some(needs) = needs else { return Ok(inst) };
        let Some(major) = state.major else { return Ok(inst) };
        if major >= needs || force {
            return Ok(inst);
        }
        if bin == "java"
            && let Some(fit) = java::java_for(needs)
            && fit.path != "java"
        {
            return java_patch(layout, &inst.name, &fit.path);
        }
        return Err(Failure::user(format!(
            "\"{n}\" runs Minecraft {mc_text}, which needs Java {needs}, but {bin} is Java {major}.\n  Pick another in the panel under Settings → Java, or: spawnloft set {n} java=<path-to-java.exe>\n  Install Java {needs} from {url}. To start on Java {major} anyway: spawnloft start {n} --force",
            n = inst.name,
            url = java::DOWNLOAD_URL
        )));
    }
    if bin != "java" {
        return Err(Failure::user(format!(
            "\"{n}\" could not start: {bin} could not be run ({msg})\n  Point it at another Java with: spawnloft set {n} java=<path-to-java.exe>",
            n = inst.name,
            msg = state.message
        )));
    }
    let found = needs.and_then(java::java_for).map(|f| f.path);
    let fallback = match found {
        Some(p) => Some(p),
        None => java::default_java(),
    };
    match fallback {
        Some(f) if f != "java" => java_patch(layout, &inst.name, &f),
        _ => Err(Failure::user(format!(
            "\"{}\" could not start: Java was not found on PATH or in the usual install folders.\n  Install it from {} - then restart SpawnLoft, which reads PATH once at launch.",
            inst.name,
            java::DOWNLOAD_URL
        ))),
    }
}

/// The options of `start`.
#[derive(Debug, Clone, Copy)]
pub struct StartOptions {
    pub wait: bool,
    /// milliseconds, a JavaScript number
    pub timeout: f64,
    pub sync: bool,
    pub force: bool,
}

impl Default for StartOptions {
    fn default() -> Self {
        StartOptions {
            wait: true,
            timeout: 180000.0,
            sync: true,
            force: false,
        }
    }
}

/// What `start` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Started {
    pub java_pid: Value,
    pub ready: bool,
    pub ready_line: Option<String>,
    pub failed: bool,
    pub timed_out: bool,
    pub reason: Option<String>,
}

/// `start(name, options)`: activity is recorded only once a daemon was actually launched.
pub fn start(layout: &Layout, by: &Actor, name: &str, opts: StartOptions) -> Result<Started, Failure> {
    let mut launched = false;
    match launch(layout, name, opts, &mut launched) {
        Ok(out) => {
            let failed = out.failed || out.timed_out;
            let detail = failed.then(|| {
                out.reason
                    .clone()
                    .unwrap_or_else(|| "had not finished starting when SpawnLoft stopped waiting".into())
            });
            activity::record_by(
                &roots(layout),
                by,
                name,
                "start",
                detail.as_deref(),
                None,
                !failed,
            );
            Ok(out)
        }
        Err(e) => {
            if launched {
                activity::record_by(&roots(layout), by, name, "start", Some(e.message()), None, false);
            }
            Err(e)
        }
    }
}

fn launch(layout: &Layout, name: &str, opts: StartOptions, launched: &mut bool) -> Result<Started, Failure> {
    let reg = Path::new(&layout.registry_file);
    let mut inst = registry::lookup(reg, name)?;
    let database = inst.is_database();
    let sp = state_path(layout, name);
    if !database && let Some(r) = control::restore_block(&sp, name, "starting it") {
        return Err(Failure::user(r));
    }
    if js::truthy(inst.get("external")) {
        let host = match inst.get("host") {
            None | Some(Value::Null) => "127.0.0.1".to_string(),
            v => text(v),
        };
        return Err(Failure::user(format!(
            "\"{name}\" is a database that runs elsewhere ({host}:{}); it is not started or stopped from here",
            text(inst.get("port"))
        )));
    }
    registry::assert_instance_dir(&inst)?;
    if !database {
        assert_eula(&inst)?;
        inst = ensure_java(layout, inst, opts.force)?;
    }
    let run = layout.run_dir_of(name);
    crate::fsx::mkdir_all(Path::new(&run))?;
    let lock_file = Path::new(&run).join("start.lock");
    let lock =
        crate::lock::acquire(&lock_file, crate::lock::Options::fail()).map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: e.to_string(),
            code: None,
        })?;
    let Some(lock) = lock else {
        return Err(Failure::user(format!(
            "\"{name}\" is already being started by another request - wait for it to finish."
        )));
    };
    let live = (|| -> Result<Map<String, Value>, Failure> {
        let (status, state) = control::read_state(&sp)?;
        let java_pid = || text(state.as_ref().and_then(|s| s.get("javaPid")));
        match status {
            Status::Running => {
                return Err(Failure::user(format!(
                    "instance \"{name}\" is already running (java pid {})",
                    java_pid()
                )));
            }
            Status::Stopping => {
                return Err(Failure::user(format!(
                    "instance \"{name}\" is still shutting down - wait for it to finish"
                )));
            }
            Status::Orphaned => {
                return Err(Failure::user(format!(
                    "instance \"{name}\" has an orphaned java process (pid {}) with no daemon.\n  Reattach is not possible; stop it with: spawnloft kill {name}",
                    java_pid()
                )));
            }
            Status::Stale => control::clear_state(&sp),
            _ => {}
        }
        if js::truthy(state.as_ref().and_then(|s| s.get("error"))) {
            control::clear_state(&sp);
        }
        if opts.sync && !database {
            sync_props(&inst)?;
        }
        let child_pid = spawn_daemon(layout, name, &inst, database)?;
        *launched = true;
        let deadline = util::now() + 15000.0;
        while util::now() < deadline {
            util::sleep(150.0);
            let (_, cur) = control::read_state(&sp)?;
            let Some(cur) = cur else { continue };
            // only this child's state can acknowledge this start or report its failure
            if cur.get("daemonPid").and_then(Value::as_f64) != Some(f64::from(child_pid)) {
                continue;
            }
            if js::truthy(cur.get("error")) {
                return Err(Failure::user(format!(
                    "\"{name}\" could not start: {}",
                    text(cur.get("error"))
                )));
            }
            if js::truthy(cur.get("startedAt")) {
                return Ok(cur);
            }
        }
        let log = roots(layout).daemon_log(name);
        Err(Failure::user(if log.exists() {
            format!("\"{name}\" did not start - see {}", log.display())
        } else {
            format!("\"{name}\" did not start: the supervisor process never came up.")
        }))
    })();
    let _ = lock.release();
    let live = live?;
    let java_pid = live.get("javaPid").cloned().unwrap_or(Value::Null);
    if !opts.wait {
        return Ok(Started {
            java_pid,
            ready: false,
            ready_line: None,
            failed: false,
            timed_out: false,
            reason: None,
        });
    }
    let mut out = wait_for_ready(layout, name, opts.timeout)?;
    out.java_pid = java_pid;
    Ok(out)
}

/// The spawn errors that prove nothing was launched (`FALLBACK_CODES`).
const FALLBACK_CODES: [&str; 4] = ["ENOENT", "EACCES", "ENOEXEC", "UNKNOWN"];

/// The environment the Node supervisor gives a daemon: its own (as forwarding prepared it) and
/// `ELECTRON_RUN_AS_NODE`.
fn daemon_command(program: &str, args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(daemon_launch::daemon_cwd())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::runtime::prepare(&mut cmd);
    cmd.env("ELECTRON_RUN_AS_NODE", "1");
    crate::platform::detach(&mut cmd);
    cmd
}

/// Reaps a daemon when it exits, as libuv does for Node, so a pid check in this process never
/// sees a zombie of it as alive.
fn reap(mut child: std::process::Child) -> u32 {
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    pid
}

fn spawn_node_daemon(name: &str) -> Result<u32, Failure> {
    let node = crate::runtime::node().map_err(|e| {
        Failure::user(format!(
            "\"{name}\" could not start: the Node daemon needs the Node runtime ({e})"
        ))
    })?;
    let script = daemon_launch::daemon_cwd().join("daemon.mjs");
    // without the Node core there is nothing to run: say so now, not after the 15 s wait
    if !script.is_file() {
        return Err(Failure::user(format!(
            "\"{name}\" could not start: the Node daemon is not installed ({} is missing)",
            script.display()
        )));
    }
    let mut cmd = daemon_command(
        &node.to_string_lossy(),
        &[script.to_string_lossy().into_owned(), name.to_string()],
    );
    cmd.stdin(std::process::Stdio::null());
    let child = cmd
        .spawn()
        .map_err(|e| Failure::io(&e, &format!("spawn {}", node.display()), None))?;
    Ok(reap(child))
}

/// `spawnDaemon(name, inst, database)`: the Node or the Rust daemon. A Rust binary that could
/// not be run at all falls back to the Node daemon with a logged line; once it ran, its failures
/// are its own.
fn spawn_daemon(layout: &Layout, name: &str, inst: &Instance, database: bool) -> Result<u32, Failure> {
    let (settings, _) = crate::settings::load();
    if daemon_launch::daemon_choice(&settings) != "rust" {
        return spawn_node_daemon(name);
    }
    let bin = daemon_launch::core_binary();
    // worked out before the spawn, so a missing engine fails the start with its own message
    let spec = if database {
        Some(crate::jsjson::stringify(&daemon_launch::database_spec(
            layout, inst,
        )?))
    } else {
        None
    };
    let mut cmd = daemon_command(&bin, &daemon_launch::rust_daemon_args(layout, name, database));
    cmd.stdin(if database {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let (code, _) = crate::jspath::error_code(&e);
            // libuv's names where the generic mapping has none: ENOEXEC on Unix; on Windows
            // EFTYPE for a file that is not a program (193) or not for this machine (216), which
            // Node does not fall back on either
            let code = match e.raw_os_error() {
                Some(8) if cfg!(unix) => "ENOEXEC",
                Some(193 | 216) if cfg!(windows) => "EFTYPE",
                _ => code,
            };
            if !FALLBACK_CODES.contains(&code) {
                return Err(Failure::user(format!(
                    "\"{name}\" could not start: the Rust daemon at {bin} could not be run (spawn {bin} {code})"
                )));
            }
            daemon_launch::note_fallback(
                layout,
                name,
                &format!(
                    "SPAWNLOFT_DAEMON=rust, but {bin} could not be run ({code}); started the Node daemon instead"
                ),
            );
            return spawn_node_daemon(name);
        }
    };
    if let (Some(spec), Some(mut stdin)) = (spec, child.stdin.take()) {
        use std::io::Write;
        let _ = stdin.write_all(spec.as_bytes());
    }
    Ok(reap(child))
}

/// `waitForReady(name, timeout)`: tails the captured console until the server reports ready,
/// dies, or the time is up.
pub fn wait_for_ready(layout: &Layout, name: &str, timeout: f64) -> Result<Started, Failure> {
    let file = std::path::PathBuf::from(layout.console_log(name));
    let deadline = util::now() + timeout;
    let mut offset: u64 = 0;
    let mut carry = String::new();
    let (ready, failed) = match registry::lookup(Path::new(&layout.registry_file), name) {
        Ok(inst) => crate::patterns::for_instance(&inst),
        Err(_) => (&*crate::patterns::READY, &*crate::patterns::FAILED),
    };
    let result =
        |ready: bool, line: Option<String>, failed: bool, timed_out: bool, reason: Option<String>| Started {
            java_pid: Value::Null,
            ready,
            ready_line: line,
            failed,
            timed_out,
            reason,
        };
    while util::now() < deadline {
        let mut text_read = String::new();
        match std::fs::File::open(&file) {
            Ok(mut f) => {
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                if size > offset {
                    let mut buf = vec![0u8; (size - offset) as usize];
                    f.seek(SeekFrom::Start(offset))
                        .map_err(|e| Failure::io(&e, "read", None))?;
                    let mut got = 0;
                    while got < buf.len() {
                        match f.read(&mut buf[got..]) {
                            Ok(0) => break,
                            Ok(k) => got += k,
                            Err(e) => return Err(Failure::io(&e, "read", None)),
                        }
                    }
                    buf.truncate(got);
                    offset = size;
                    text_read = String::from_utf8_lossy(&buf).into_owned();
                }
            }
            Err(e) if crate::jspath::is_enoent(&e) => {}
            Err(e) => return Err(Failure::io(&e, "open", Some(&file))),
        }
        if !text_read.is_empty() {
            let scan = format!("{carry}{text_read}");
            if let Some(m) = ready.find(&scan) {
                return Ok(result(true, Some(m.as_str().to_string()), false, false, None));
            }
            if let Some(m) = failed.find(&scan) {
                return Ok(result(false, None, true, false, Some(m.as_str().to_string())));
            }
            let units: Vec<u16> = scan.encode_utf16().collect();
            carry = String::from_utf16_lossy(&units[units.len().saturating_sub(512)..]);
        }
        let (status, state) = read_state(layout, name)?;
        if !matches!(status, Status::Running | Status::Stopping) {
            let code = match state.as_ref().and_then(|s| s.get("exitCode")) {
                None | Some(Value::Null) => "?".to_string(),
                v => text(v),
            };
            return Ok(result(
                false,
                None,
                true,
                false,
                Some(format!("process exited (code {code})")),
            ));
        }
        util::sleep(400.0);
    }
    Ok(result(false, None, false, true, None))
}

/// `waitForPidExit(pid, timeout)`.
fn wait_for_pid_exit(pid: Option<&Value>, timeout: f64) -> bool {
    if !js::truthy(pid) {
        return true;
    }
    let deadline = util::now() + timeout;
    while util::now() < deadline {
        if !control::pid_alive(pid) {
            return true;
        }
        util::sleep(100.0);
    }
    !control::pid_alive(pid)
}

/// `killTree(pid)`.
fn kill_tree(pid: Option<&Value>) {
    if !control::pid_alive(pid) {
        return;
    }
    let n = js::number(pid);
    // killProcessGroup takes safe integers above 1 only
    if n.is_finite()
        && n.fract() == 0.0
        && n > 1.0
        && n <= 9_007_199_254_740_991.0
        && n <= f64::from(i32::MAX)
    {
        util::kill_tree(n as i32);
    }
}

/// What `stop` and `kill` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Stopped {
    pub already_stopped: bool,
    pub forced: bool,
    /// the daemon's answer (`code`, `forced`, ...), when it gave one
    pub reply: Option<Map<String, Value>>,
    /// what `stop` and `kill` return in the Node core, as the MCP tools spread it: the daemon's
    /// answer, `{ alreadyStopped: true }`, or `{ forced: true, orphan | viaPid: true }`
    pub detail: Map<String, Value>,
}

impl Stopped {
    fn already() -> Stopped {
        Stopped {
            already_stopped: true,
            forced: false,
            reply: None,
            detail: one(&[("alreadyStopped", true)]),
        }
    }
    fn of_reply(reply: Map<String, Value>) -> Stopped {
        Stopped {
            already_stopped: false,
            forced: js::truthy(reply.get("forced")),
            detail: reply.clone(),
            reply: Some(reply),
        }
    }
    fn forced(how: &str) -> Stopped {
        Stopped {
            already_stopped: false,
            forced: true,
            reply: None,
            detail: one(&[("forced", true), (how, true)]),
        }
    }
}

fn one(pairs: &[(&str, bool)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect()
}

/// `stop(name, { timeout })`.
pub fn stop(layout: &Layout, by: &Actor, name: &str, timeout: f64) -> Result<Stopped, Failure> {
    let sp = state_path(layout, name);
    let (status, state) = control::read_state(&sp)?;
    if matches!(status, Status::Stopped | Status::Stale) {
        control::clear_state(&sp);
        return Ok(Stopped::already());
    }
    let state = state.unwrap_or_default();
    if status == Status::Orphaned {
        return Err(Failure::user(format!(
            "instance \"{name}\" is orphaned (java pid {}, no daemon). Use: spawnloft kill {name}",
            text(state.get("javaPid"))
        )));
    }
    let req = json!({ "op": "stop", "timeout": jsjson::num(timeout) });
    let res = control::control_request(&control_addr(layout, name)?, name, &req, timeout + 30000.0)?;
    let res = match res {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if !js::truthy(res.get("ok")) {
        return Err(Failure::user(error_or(&res, "stop failed")));
    }
    wait_for_pid_exit(state.get("daemonPid"), 15000.0);
    activity::record_by(&roots(layout), by, name, "stop", None, None, true);
    Ok(Stopped::of_reply(res))
}

/// `res.error || fallback`.
fn error_or(res: &Map<String, Value>, fallback: &str) -> String {
    if js::truthy(res.get("error")) {
        text(res.get("error"))
    } else {
        fallback.into()
    }
}

/// `kill(name)`.
pub fn kill(layout: &Layout, by: &Actor, name: &str) -> Result<Stopped, Failure> {
    let out = force_stop(layout, name)?;
    if !out.already_stopped {
        activity::record_by(&roots(layout), by, name, "kill", None, None, true);
    }
    Ok(out)
}

fn force_stop(layout: &Layout, name: &str) -> Result<Stopped, Failure> {
    let sp = state_path(layout, name);
    let (status, state) = control::read_state(&sp)?;
    if matches!(status, Status::Stopped | Status::Stale) {
        control::clear_state(&sp);
        return Ok(Stopped::already());
    }
    let state = state.unwrap_or_default();
    if status == Status::Orphaned {
        kill_tree(state.get("javaPid"));
        wait_for_pid_exit(state.get("javaPid"), 15000.0);
        control::clear_state(&sp);
        return Ok(Stopped::forced("orphan"));
    }
    // the daemon first, so it can clean up; the pids when the channel cannot be reached
    if let Ok(addr) = control_addr(layout, name)
        && let Ok(Value::Object(res)) =
            control::control_request(&addr, name, &json!({ "op": "kill" }), 30000.0)
        && js::truthy(res.get("ok"))
    {
        wait_for_pid_exit(state.get("daemonPid"), 15000.0);
        return Ok(Stopped::of_reply(res));
    }
    kill_tree(state.get("javaPid"));
    kill_tree(state.get("daemonPid"));
    wait_for_pid_exit(state.get("javaPid"), 15000.0);
    wait_for_pid_exit(state.get("daemonPid"), 15000.0);
    control::clear_state(&sp);
    Ok(Stopped::forced("viaPid"))
}

/// `sendConsole(name, line)`.
pub fn send_console(layout: &Layout, by: &Actor, name: &str, line: &str) -> Result<(), Failure> {
    let req = json!({ "op": "send", "line": line });
    let res = control::control_request(&control_addr(layout, name)?, name, &req, 120000.0)?;
    let res = match res {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if !js::truthy(res.get("ok")) {
        return Err(Failure::user(error_or(&res, "send failed")));
    }
    activity::record_by(&roots(layout), by, name, "command", Some(line), None, true);
    Ok(())
}

/// `isRunning(name)`: up and answering a command.
pub fn is_running(layout: &Layout, name: &str) -> Result<bool, Failure> {
    Ok(read_state(layout, name)?.0 == Status::Running)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_eula_is_read_as_javascript_reads_it() {
        let dir = std::env::temp_dir().join(format!("sl-eula-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inst = crate::registry::spread("e", &json!({ "dir": dir.to_string_lossy() }));
        let check = |body: &str| {
            std::fs::write(dir.join("eula.txt"), body).unwrap();
            assert_eula(&inst).is_ok()
        };
        assert!(check("\u{feff}eula=true\n"));
        assert!(check("#by\r\nEULA = TRUE\r\n"));
        assert!(check("eula=true\u{2028}zzz"));
        assert!(check("eula\n=\ntrue"));
        assert!(!check("eula=true\u{85}"));
        assert!(!check("eula=false\n"));
        assert!(!check("# eula=true"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slices_like_javascript() {
        assert_eq!(slice_start(3, -1.0), 2);
        assert_eq!(slice_start(3, -0.0), 0);
        assert_eq!(slice_start(3, -1.5), 2);
        assert_eq!(slice_start(3, f64::NEG_INFINITY), 0);
        assert_eq!(slice_start(3, 5.0), 3);
        assert_eq!(slice_start(3, f64::NAN), 0);
    }

    #[test]
    fn lines_split_on_crlf_and_lf() {
        assert_eq!(split_lines("a\r\nb\nc"), ["a", "b", "c"]);
        assert_eq!(split_lines("a\n"), ["a", ""]);
        assert_eq!(split_lines("\r"), ["\r"]);
    }

    #[test]
    fn tail_reads_the_last_lines() {
        let dir = std::env::temp_dir().join(format!("sl-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("console.log");
        std::fs::write(&f, "a\nb\nc\n\n").unwrap();
        assert_eq!(tail_log(&f, 2.0).unwrap(), ["b", "c"]);
        assert_eq!(tail_log(&f, 0.0).unwrap(), ["a", "b", "c"]);
        assert!(matches!(tail_log(&f, f64::NAN), Err(Failure::Internal { .. })));
        assert!(tail_log(&dir.join("none"), f64::NAN).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
