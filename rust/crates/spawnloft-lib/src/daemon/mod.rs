//! The per-server daemon (R1): `spawnloft-core daemon <name>`, spawned detached by the Node
//! supervisor in place of `daemon.mjs` when `SPAWNLOFT_DAEMON=rust`. It owns the server process,
//! mirrors its output into `console.log`, serves the control channel (ping, send, stop, kill),
//! writes `state.json`, samples `metrics.log`, and relaunches after a crash under the crash guard.
//!
//! Everything it writes is read by the Node core, so the files and the protocol are the contract
//! of the 2026-11-05 plan, section 7. Where it behaves differently on purpose:
//!
//! - Windows: the server is held in a Job Object, so `kill` takes its whole tree; the control
//!   pipe has an owner-only DACL and rejects remote clients.
//! - `ping` also answers `protocol`, `daemon` and `version`.
//! - A database's program is handed over by the supervisor on stdin (see [`program`]).
//!
//! All state lives on the main thread. Output readers, the control channel, samplers and webhooks
//! run on threads of their own and talk to it through [`Event`]s.

pub mod control;
pub mod program;

use serde_json::{Map, Value, json};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::crashguard::{self, CRASH_LIMIT, CRASH_WINDOW_MS, Verdict};
use crate::paths::{self, Roots};
use crate::platform::{self, Tree};
use crate::registry::{self, Instance};
use crate::tick::TickSampler;
use crate::{activity, diagnose, fsx, metrics, notify, patterns, resp, time};
use program::{Program, Stop};

/// What the daemon's own lines in `console.log` start with. Matches `daemon.mjs` on this branch.
pub const CONSOLE_PREFIX: &str = "[spawnloft]";
/// The control protocol's version, answered by `ping`. 1 is the four ops of 1.x.
pub const PROTOCOL: u64 = 1;
/// A stop with no timeout of its own waits this long before forcing.
pub const DEFAULT_STOP_MS: u64 = 90_000;
/// How long a forced stop or a kill waits for the process to go.
const KILL_WAIT: Duration = Duration::from_secs(10);
/// How long shutdown waits for the last webhook, then a little more for the logs to land.
const NOTIFY_GRACE: Duration = Duration::from_secs(4);
const EXIT_DELAY: Duration = Duration::from_millis(250);
/// The console tail kept to explain a crash, and the window searched for the ready line.
const RECENT_BYTES: usize = 32_768;
const READY_TAIL: usize = 4096;

/// What threads tell the main loop.
#[derive(Debug)]
pub enum Event {
    /// A control request and where its reply goes.
    Control { req: Value, reply: Sender<Value> },
    /// The relaunched server printed its ready line.
    Ready { generation: u64 },
    /// The control channel is listening.
    Bound(String),
    /// The control channel could not be bound.
    BindFatal(String),
    /// Garnet's checkpoint before a stop finished.
    RespDone { result: Result<(), String> },
}

/// `daemon.log`: one timestamped line per event. A failing log is dropped, never fatal.
#[derive(Debug)]
pub struct Log {
    file: Mutex<Option<File>>,
}

impl Log {
    pub fn open(path: &Path) -> Log {
        Log {
            file: Mutex::new(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .ok(),
            ),
        }
    }
    pub fn line(&self, msg: &str) {
        if let Ok(mut f) = self.file.lock()
            && let Some(file) = f.as_mut()
        {
            let _ = file.write_all(format!("[{}] {msg}\n", time::iso_now()).as_bytes());
        }
    }
}

/// `console.log`, shared by both output readers and the daemon's own lines. A write failure
/// (a full disk) stops capture with one log line; the readers keep draining the pipes.
#[derive(Debug)]
struct Console {
    file: Mutex<Option<File>>,
    log: Arc<Log>,
}

impl Console {
    fn write(&self, bytes: &[u8]) {
        let Ok(mut guard) = self.file.lock() else { return };
        if let Some(f) = guard.as_mut()
            && let Err(e) = f.write_all(bytes)
        {
            *guard = None;
            self.log
                .line(&format!("console log write failed: {e}; console capture stopped"));
        }
    }
    fn say(&self, text: &str) {
        self.write(text.as_bytes());
    }
}

/// How the daemon was started.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub name: String,
    /// The data root the supervisor resolved; when absent it is resolved here.
    pub data_root: Option<PathBuf>,
    /// The Node runtime for `.mjs` stand-in programs (the lifecycle tests' fake java).
    pub node: Option<PathBuf>,
    /// A database's launch spec, read from stdin.
    pub spec: Option<Value>,
}

// what the panic path writes over: the last state written
static LAST_STATE: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

enum LaunchError {
    /// The program could not be started at all (`spawn` failed).
    Spawn(String),
    /// Anything before that: the registry, the program, the state file.
    Other(String),
}

/// Who is waiting for a stop or kill to finish.
#[derive(Debug)]
enum Replier {
    Control(Sender<Value>),
    /// SIGTERM: exit once the server is down, stay up if the stop failed.
    Sigterm,
}

#[derive(Debug)]
enum Waiter {
    /// A stop waiting for the server to exit; past the deadline it is forced, then waits again.
    Stop {
        reply: Replier,
        deadline: Instant,
        forced: bool,
    },
    /// A stop waiting on Garnet's checkpoint before anything is terminated.
    Checkpoint {
        reply: Replier,
        timeout: Duration,
    },
    Kill {
        reply: Replier,
        deadline: Instant,
    },
}

/// Console lines queued for the server: at most this many wait while it is not reading.
const CONSOLE_QUEUE: usize = 1024;

/// The server's stdin, written by its own thread, so a server that stops reading its console
/// (a deadlocked JVM) can never block the main loop: ping, stop and kill keep working.
struct ConsoleInput {
    queue: mpsc::SyncSender<Vec<u8>>,
    closed: Arc<AtomicBool>,
}

impl ConsoleInput {
    fn start(mut stdin: ChildStdin, log: Arc<Log>) -> Option<Self> {
        let (queue, lines) = mpsc::sync_channel::<Vec<u8>>(CONSOLE_QUEUE);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        std::thread::Builder::new()
            .name("console-in".into())
            .spawn(move || {
                // ends when the sender is dropped (the server is gone) or the pipe breaks
                for line in lines {
                    if let Err(e) = stdin.write_all(&line).and_then(|()| stdin.flush()) {
                        // the server closed its console while we still held it (EPIPE)
                        log.line(&format!("stdin error: {e}"));
                        flag.store(true, Ordering::SeqCst);
                        return;
                    }
                }
            })
            .ok()?;
        Some(Self { queue, closed })
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn write(&self, text: &str) -> Result<(), &'static str> {
        if self.is_closed() {
            return Err("the server console is closed");
        }
        match self.queue.try_send(text.as_bytes().to_vec()) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => Err("the server console is not reading input"),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.closed.store(true, Ordering::SeqCst);
                Err("the server console is closed")
            }
        }
    }
}

struct Running {
    child: Child,
    stdin: Option<ConsoleInput>,
    tree: Tree,
    readers_done: Arc<AtomicUsize>,
    sampler: metrics::Sampler,
    ticks: TickSampler,
}

struct Daemon {
    name: String,
    roots: Roots,
    node: Option<PathBuf>,
    spec: Option<Value>,
    control: String,
    log: Arc<Log>,
    console: Arc<Console>,
    recent: Arc<Mutex<Vec<u8>>>,
    events: Sender<Event>,
    inst: Option<Instance>,
    program: Option<Program>,
    running: Option<Running>,
    generation: u64,
    last_pid: Option<u32>,
    last_exit: (Option<i64>, Option<String>),
    state: Map<String, Value>,
    stopping: bool,
    stop_sent: bool,
    respawn_at: Option<Instant>,
    crashes: Vec<i64>,
    waiters: Vec<Waiter>,
    last_notify: Option<std::thread::JoinHandle<()>>,
    shutdown_at: Option<Instant>,
    exit_at: Option<Instant>,
}

/// The daemon's process name as the state file records it, for the pid-reuse check.
/// `daemonStartTime`: this process's kernel creation time, the half of its identity that survives
/// an update renaming the binary it runs from (crate::procid). 1.x readers ignore the field. A
/// string: a Windows FILETIME is above 2^53, and the Node core reads this file with JSON.parse.
fn insert_start_time(state: &mut Map<String, Value>) {
    if let Some(t) = crate::procid::own_start_time() {
        state.insert("daemonStartTime".into(), json!(t.to_string()));
    }
}

fn own_exe() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "spawnloft-core.exe".into()
            } else {
                "spawnloft-core".into()
            }
        })
}

fn basename(cmd: &str) -> String {
    Path::new(cmd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| cmd.to_string())
}

/// `spawn java ENOENT`, as Node words a program that could not be started.
fn spawn_message(cmd: &str, e: &std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => e.to_string(),
    };
    format!("spawn {cmd} {code}")
}

fn exit_parts(status: ExitStatus) -> (Option<i64>, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return (None, Some(platform::signal_name(sig)));
        }
        (status.code().map(i64::from), None)
    }
    #[cfg(windows)]
    {
        // a DWORD, as Node reports it (3221225786, not -1073741510)
        (status.code().map(|c| i64::from(c as u32)), None)
    }
}

fn null_or<T: Into<Value>>(v: Option<T>) -> Value {
    v.map(Into::into).unwrap_or(Value::Null)
}

fn text(v: &Option<i64>) -> String {
    v.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
}

impl Daemon {
    fn write_state(&self) -> std::io::Result<()> {
        if let Ok(mut last) = LAST_STATE.lock() {
            *last = Some(self.state.clone());
        }
        fsx::write_json(
            &self.roots.state_file(&self.name),
            &Value::Object(self.state.clone()),
        )
    }

    fn save_state(&self) {
        if let Err(e) = self.write_state() {
            self.log.line(&format!("could not write the state file: {e}"));
        }
    }

    /// Crash messages go to the activity history as well as the webhook.
    fn tell(&mut self, message: &str) {
        activity::record(&self.roots, &self.name, "crash", Some(message), false);
        let webhook = self.inst.as_ref().and_then(Instance::webhook);
        let log = self.log.clone();
        if let Some(handle) = notify::notify(&self.name, webhook, message, move |l| log.line(&l)) {
            self.last_notify = Some(handle);
        }
    }

    fn program_for(&self, inst: &Instance) -> Result<Program, String> {
        if inst.is_database() {
            let spec = self
                .spec
                .as_ref()
                .ok_or("this database's launch spec was not handed over by the supervisor (--spec -)")?;
            return program::from_spec(spec);
        }
        program::minecraft(inst, self.node.as_deref())
    }

    /// The state file at a launch (daemon.mjs `state = {...}`); `pid` is None when the spawn failed.
    fn launch_state(&self, inst: &Instance, program: &Program, pid: Option<u32>) -> Map<String, Value> {
        let mut state = Map::new();
        state.insert("name".into(), json!(self.name));
        state.insert("kind".into(), json!(inst.kind()));
        state.insert("daemonPid".into(), json!(std::process::id()));
        // javaPid/javaExe describe the child, whatever it runs
        if let Some(pid) = pid {
            state.insert("javaPid".into(), json!(pid));
        }
        state.insert("daemonExe".into(), json!(own_exe()));
        insert_start_time(&mut state);
        state.insert("javaExe".into(), json!(basename(&program.cmd)));
        state.insert("startedAt".into(), json!(time::now_ms()));
        if let Some(dir) = inst.get("dir") {
            state.insert("dir".into(), dir.clone());
        }
        state.insert("jar".into(), inst.get("jar").cloned().unwrap_or(Value::Null));
        state.insert(
            "memory".into(),
            inst.get("memory").cloned().unwrap_or(Value::Null),
        );
        if let Some(port) = inst.get("port") {
            state.insert("port".into(), port.clone());
        }
        state.insert("rconPort".into(), inst.rcon_port_value());
        state.insert("control".into(), json!(self.control));
        state.insert("running".into(), json!(true));
        state.insert("restarts".into(), json!(self.crashes.len()));
        state
    }

    fn launch(&mut self, first: bool) -> Result<(), LaunchError> {
        // re-read each launch so edits apply at the next respawn
        let inst =
            registry::get_instance(&self.roots.registry_file(), &self.name).map_err(LaunchError::Other)?;
        let program = self.program_for(&inst).map_err(LaunchError::Other)?;
        self.log.line(&format!(
            "starting {} {} (cwd={}){}",
            program.cmd,
            program::mask_secret_args(&program.args).join(" "),
            program.cwd.display(),
            if first { "" } else { " [auto-restart]" }
        ));

        let mut cmd = Command::new(&program.cmd);
        cmd.args(&program.args)
            .current_dir(&program.cwd)
            .envs(program.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        platform::prepare_server(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // as daemon.mjs: the launch's state, with no javaPid since there is no process
                self.state = self.launch_state(&inst, &program, None);
                self.inst = Some(inst);
                return Err(LaunchError::Spawn(spawn_message(&program.cmd, &e)));
            }
        };
        let tree = Tree::attach(&child);
        if let Some(why) = &tree.fallback_reason {
            self.log.line(&format!(
                "process tree: {why}; a force kill uses taskkill /T instead"
            ));
        }
        platform::set_kill_target(Some(&tree));
        self.generation += 1;
        let pid = child.id();

        // output: console file, the crash tail, and on a relaunch the ready line ("back up")
        if let Ok(mut r) = self.recent.lock() {
            r.clear();
        }
        let readers_done = Arc::new(AtomicUsize::new(0));
        let watch = (!first).then(|| {
            Arc::new(ReadyWatch {
                seen: AtomicBool::new(false),
                tail: Mutex::new(Vec::new()),
                ready: patterns::for_instance(&inst).0,
                generation: self.generation,
                events: self.events.clone(),
            })
        });
        let out = child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        let err = child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        for stream in [out, err].into_iter().flatten() {
            spawn_reader(
                stream,
                self.console.clone(),
                self.recent.clone(),
                watch.clone(),
                readers_done.clone(),
            );
        }
        let stdin = child
            .stdin
            .take()
            .and_then(|s| ConsoleInput::start(s, self.log.clone()));

        self.state = self.launch_state(&inst, &program, Some(pid));

        let ticks = if inst.is_database() {
            TickSampler::none()
        } else {
            let log = self.log.clone();
            TickSampler::start(
                inst.rcon_port(),
                inst.rcon_password(),
                Duration::from_secs(10),
                Duration::from_secs(8),
                move |e| log.line(&format!("tick and player readings unavailable: {e}")),
            )
        };
        self.running = Some(Running {
            child,
            stdin,
            tree,
            readers_done,
            sampler: metrics::Sampler::default_stopped(),
            ticks: ticks.clone(),
        });
        self.last_pid = Some(pid);
        self.last_exit = (None, None);
        self.inst = Some(inst);
        self.program = Some(program);
        self.write_state()
            .map_err(|e| LaunchError::Other(format!("could not write the state file: {e}")))?;
        self.log.line(&format!("child pid {pid}"));

        // the history starts empty each run so a graph never splices two processes together
        let _ = std::fs::remove_file(self.roots.metrics_file(&self.name));
        let log = self.log.clone();
        let sampler = metrics::start(
            pid,
            self.roots.metrics_file(&self.name),
            move || ticks.latest(),
            move |e| log.line(&format!("performance sampling unavailable: {e}")),
        );
        if let Some(r) = self.running.as_mut() {
            r.sampler = sampler;
        }
        Ok(())
    }

    /// The program could not be started: say so in the state file `start` is polling, and end.
    fn spawn_failed(&mut self, message: String) -> ! {
        self.log.line(&format!("spawn error: {message}"));
        self.console.say(&format!(
            "\n{CONSOLE_PREFIX} failed to launch server: {message}\n"
        ));
        // launch() fills the launch's state before a spawn error reaches here; this is only for a
        // caller that fails before any launch
        if self.state.is_empty() {
            self.state.insert("name".into(), json!(self.name));
            self.state.insert(
                "kind".into(),
                json!(self.inst.as_ref().map(Instance::kind).unwrap_or("server")),
            );
            self.state.insert("daemonPid".into(), json!(std::process::id()));
            self.state.insert("daemonExe".into(), json!(own_exe()));
            insert_start_time(&mut self.state);
            self.state.insert("startedAt".into(), json!(time::now_ms()));
            self.state.insert("control".into(), json!(self.control));
        }
        self.state.remove("javaPid");
        self.state.insert("running".into(), json!(false));
        self.state.insert("error".into(), json!(message));
        self.save_state();
        std::thread::sleep(EXIT_DELAY);
        self.leave(1);
    }

    /// `die()`: the reason in the daemon log and the state file, the server killed if it was
    /// started (a daemonless server would hold the port and world while the state says stopped).
    fn die(&mut self, reason: &str) -> ! {
        self.log.line(&format!("failed to start: {reason}"));
        let java = self.running.as_ref().map(|r| r.child.id());
        if let Some(r) = &self.running {
            self.log.line("force killing");
            r.tree.kill();
        }
        let mut st = if java.is_some() {
            self.state.clone()
        } else {
            Map::new()
        };
        st.insert("name".into(), json!(self.name));
        st.insert("daemonPid".into(), json!(std::process::id()));
        st.insert("running".into(), json!(false));
        st.insert("error".into(), json!(reason));
        st.insert("failedAt".into(), json!(time::now_ms()));
        if let Some(pid) = java {
            st.insert("javaPid".into(), json!(pid));
            st.insert("killedOnDaemonFailure".into(), json!(true));
        }
        let _ = fsx::write_json(&self.roots.state_file(&self.name), &Value::Object(st));
        self.leave(1);
    }

    fn force_kill(&self) {
        if let Some(r) = &self.running {
            self.log.line("force killing");
            r.tree.kill();
        }
    }

    fn on_exit(&mut self, status: ExitStatus) {
        let Some(run) = self.running.take() else { return };
        platform::set_kill_target(None);
        let (code, signal) = exit_parts(status);
        self.log.line(&format!(
            "java exited code={} signal={}",
            text(&code),
            signal.as_deref().unwrap_or("null")
        ));
        run.sampler.stop();
        run.ticks.stop();
        // let the readers drain what the process wrote last, without waiting on a fork that
        // kept the pipe open
        let deadline = Instant::now() + Duration::from_millis(500);
        while run.readers_done.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(run);
        self.last_exit = (code, signal.clone());
        self.console.say(&format!(
            "\n{CONSOLE_PREFIX} server process exited (code={}{})\n",
            text(&code),
            signal
                .as_deref()
                .map(|s| format!(", signal={s}"))
                .unwrap_or_default()
        ));

        let crashed = (code.is_some() && code != Some(0)) || signal.is_some();
        if crashed && !self.stopping {
            self.crashes.push(time::now_ms());
        }
        // an exit code alone can't tell a crash from a stop, since a forced stop exits non-zero
        self.state
            .insert("crashed".into(), json!(crashed && !self.stopping));

        let database = self.inst.as_ref().is_some_and(Instance::is_database);
        let mut cause = String::new();
        if crashed && !self.stopping && !database {
            let tail = self
                .recent
                .lock()
                .map(|r| String::from_utf8_lossy(&r).into_owned())
                .unwrap_or_default();
            let lines: Vec<&str> = tail
                .split('\n')
                .map(|l| l.strip_suffix('\r').unwrap_or(l))
                .collect();
            let inst = self.inst.as_ref();
            let ctx = diagnose::Context {
                port: inst
                    .and_then(|i| i.get("port"))
                    .map(|p| crate::js::string(Some(p))),
                memory: inst
                    .and_then(|i| i.get("memory"))
                    .map(|m| crate::js::string(Some(m))),
                dir: inst.and_then(|i| i.dir()).map(String::from),
            };
            if let Some(finding) = diagnose::diagnose(&lines, &ctx).into_iter().next() {
                cause = format!(" Likely cause: {}.", finding.title.to_lowercase());
                self.console.say(&format!(
                    "{CONSOLE_PREFIX} likely cause: {} \u{2014} {}\n",
                    finding.title, finding.advice
                ));
            }
        }

        // re-read so turning auto-restart off applies from the very next exit
        let mut enabled = self.inst.as_ref().is_some_and(Instance::auto_restart);
        if let Ok(fresh) = registry::get_instance(&self.roots.registry_file(), &self.name) {
            enabled = fresh.auto_restart();
            self.inst = Some(fresh);
        }
        let exit_text = signal.clone().unwrap_or_else(|| text(&code));
        let minutes = CRASH_WINDOW_MS / 60_000;
        match crashguard::verdict(
            enabled,
            self.stopping,
            code,
            signal.as_deref(),
            &self.crashes,
            time::now_ms(),
            crashguard::restart_delay_ms(),
        ) {
            Verdict::Restart { delay_ms, recent } => {
                let wait = (delay_ms as f64 / 1000.0).round() as u64;
                self.console.say(&format!(
                    "{CONSOLE_PREFIX} crash {recent} of {CRASH_LIMIT} allowed per {minutes} minutes \u{2014} restarting in {wait}s\n"
                ));
                self.tell(&format!(
                    "crashed (exit {exit_text}).{cause} Restarting in {wait}s."
                ));
                // running stays true during the delay, so a status reads "stopping", not
                // "stopped": a start racing into this window would collide with the respawn
                self.state.insert("restarting".into(), json!(true));
                self.save_state();
                self.respawn_at = Some(Instant::now() + Duration::from_millis(delay_ms));
            }
            Verdict::GiveUp { recent } => {
                let why = format!("crashed {recent} times in {minutes} minutes; auto-restart gave up");
                self.console.say(&format!(
                    "{CONSOLE_PREFIX} {why}. See the lines above for the reason it keeps dying.\n"
                ));
                self.tell(&format!("{why}. It is staying down until someone looks at it."));
                self.shut_down(code, signal, Some(why));
            }
            Verdict::StayDown(_) => {
                if crashed && !self.stopping {
                    self.tell(&format!(
                        "crashed (exit {exit_text}) and is staying down \u{2014} auto-restart is off.{cause}"
                    ));
                }
                self.shut_down(code, signal, None);
            }
        }
    }

    fn respawn(&mut self) {
        self.respawn_at = None;
        let (code, signal) = self.last_exit.clone();
        if self.stopping {
            return self.shut_down(code, signal, None);
        }
        match self.launch(false) {
            Ok(()) => {}
            Err(LaunchError::Spawn(msg)) => self.spawn_failed(msg),
            Err(LaunchError::Other(msg)) => {
                if self.running.is_some() {
                    // started, but its state could not be written: it cannot be managed
                    self.die(&msg);
                }
                self.log.line(&format!("auto-restart failed: {msg}"));
                self.console
                    .say(&format!("\n{CONSOLE_PREFIX} auto-restart failed: {msg}\n"));
                self.tell(&format!("auto-restart failed: {msg}"));
                self.shut_down(code, signal, Some(format!("auto-restart failed: {msg}")));
            }
        }
    }

    /// The final state, and the one way out for a server staying down.
    fn shut_down(&mut self, code: Option<i64>, signal: Option<String>, error: Option<String>) {
        self.state.insert("running".into(), json!(false));
        self.state.remove("restarting");
        self.state.insert("exitCode".into(), null_or(code));
        self.state.insert("exitSignal".into(), null_or(signal));
        self.state.insert("stoppedAt".into(), json!(time::now_ms()));
        if let Some(e) = error {
            self.state.insert("error".into(), json!(e));
        }
        self.save_state();
        for waiter in std::mem::take(&mut self.waiters) {
            match waiter {
                Waiter::Stop {
                    reply, forced: false, ..
                } => self.answer(reply, json!({ "ok": true, "code": code })),
                Waiter::Stop {
                    reply, forced: true, ..
                } => self.answer(reply, json!({ "ok": true, "forced": true, "code": code })),
                Waiter::Kill { reply, .. } => {
                    self.answer(reply, json!({ "ok": true, "code": code, "forced": true }))
                }
                Waiter::Checkpoint { reply, .. } => self.answer(reply, json!({ "ok": true, "code": code })),
            }
        }
        self.shutdown_at.get_or_insert_with(Instant::now);
    }

    fn answer(&mut self, reply: Replier, value: Value) {
        match reply {
            Replier::Control(tx) => {
                let _ = tx.send(value);
            }
            Replier::Sigterm => {
                if value.get("ok") == Some(&Value::Bool(true)) {
                    // leave through the main loop's exit path, so every other waiter answered
                    // in this same pass has its reply delivered first
                    self.shutdown_at.get_or_insert_with(Instant::now);
                    return;
                }
                let why = value.get("error").and_then(Value::as_str).unwrap_or("unknown");
                self.log.line(&format!(
                    "SIGTERM: stop did not complete ({why}); staying up to supervise the server"
                ));
            }
        }
    }

    fn handle_stop(&mut self, timeout: Duration, reply: Replier) {
        self.stopping = true;
        // a stop during the respawn delay cancels the respawn
        if self.respawn_at.take().is_some() {
            self.log.line("stop received during restart delay; staying down");
            let code = self.state.get("exitCode").and_then(Value::as_i64);
            self.shut_down(code, None, None);
            return self.answer(reply, json!({ "ok": true, "code": code, "already": true }));
        }
        if self.running.is_none() {
            let code = self.last_exit.0;
            return self.answer(reply, json!({ "ok": true, "code": code, "already": true }));
        }
        if !self.stop_sent {
            self.stop_sent = true;
            match self
                .program
                .as_ref()
                .map(|p| p.stop.clone())
                .unwrap_or(Stop::None)
            {
                Stop::Stdin(line) => {
                    self.log.line("sending stop to console");
                    if let Err(e) = self.write_console_input(&line) {
                        self.log
                            .line(&format!("stop not delivered: {e}; killing at the deadline"));
                    }
                }
                Stop::Command { cmd, args, env } => {
                    self.log.line(&format!(
                        "asking for shutdown: {cmd} {}",
                        program::mask_secret_args(&args).join(" ")
                    ));
                    self.run_shutdown_tool(&cmd, &args, &env);
                }
                Stop::Resp {
                    host,
                    port,
                    password,
                    commands,
                    terminate_after_save,
                } => {
                    self.log.line(&format!(
                        "asking for shutdown over the Redis protocol at {host}:{port}"
                    ));
                    let events = self.events.clone();
                    let failed = self.events.clone();
                    let log = self.log.clone();
                    let wait = if terminate_after_save {
                        timeout
                    } else {
                        Duration::from_secs(5)
                    };
                    let spawned = std::thread::Builder::new().name("resp".into()).spawn(move || {
                        let result =
                            resp::send(&host, port, &commands, password.as_deref(), wait).map(|_| ());
                        if terminate_after_save {
                            let _ = events.send(Event::RespDone { result });
                        } else if let Err(e) = result {
                            log.line(&format!("shutdown request: {e}"));
                        }
                    });
                    if let Err(e) = spawned {
                        self.log.line(&format!("shutdown request: could not start: {e}"));
                        if terminate_after_save {
                            // answered on the next pass, after the waiter below is in place
                            let _ = failed.send(Event::RespDone {
                                result: Err(format!("could not start the request: {e}")),
                            });
                        }
                    }
                    if terminate_after_save {
                        self.waiters.push(Waiter::Checkpoint { reply, timeout });
                        return;
                    }
                }
                Stop::None => self
                    .log
                    .line("no graceful stop for this program; waiting, then killing"),
            }
        }
        self.waiters.push(Waiter::Stop {
            reply,
            deadline: Instant::now() + timeout,
            forced: false,
        });
    }

    fn on_checkpoint(&mut self, result: Result<(), String>) {
        let (checkpoints, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.waiters)
            .into_iter()
            .partition(|w| matches!(w, Waiter::Checkpoint { .. }));
        self.waiters = rest;
        match result {
            Ok(()) => {
                self.log.line("Redis checkpoint saved; terminating the managed process (Garnet has no SHUTDOWN command)");
                if let Some(r) = self.running.as_mut() {
                    platform::terminate(&mut r.child);
                }
                for w in checkpoints {
                    if let Waiter::Checkpoint { reply, timeout } = w {
                        self.waiters.push(Waiter::Stop {
                            reply,
                            deadline: Instant::now() + timeout,
                            forced: false,
                        });
                    }
                }
            }
            Err(e) => {
                self.stop_sent = false;
                self.stopping = false;
                for w in checkpoints {
                    if let Waiter::Checkpoint { reply, .. } = w {
                        self.answer(reply, json!({ "ok": false, "error": format!("Redis checkpoint failed; the process was left running: {e}") }));
                    }
                }
            }
        }
    }

    fn handle_kill(&mut self, reply: Replier) {
        self.stopping = true;
        if self.respawn_at.take().is_some() {
            let code = self.state.get("exitCode").and_then(Value::as_i64);
            self.shut_down(code, None, None);
            return self.answer(reply, json!({ "ok": true, "code": code, "forced": true }));
        }
        if self.running.is_none() {
            let code = self.last_exit.0;
            return self.answer(reply, json!({ "ok": true, "code": code, "forced": true }));
        }
        self.force_kill();
        self.waiters.push(Waiter::Kill {
            reply,
            deadline: Instant::now() + KILL_WAIT,
        });
    }

    /// Queues a line for the server's console; never blocks, a closed console is never fatal.
    fn write_console_input(&mut self, text: &str) -> Result<(), &'static str> {
        let Some(r) = self.running.as_mut() else {
            return Err("server process is not running");
        };
        let Some(stdin) = r.stdin.as_ref() else {
            return Err("the server console is closed");
        };
        stdin.write(text)
    }

    fn run_shutdown_tool(&self, cmd: &str, args: &[String], env: &[(String, String)]) {
        let mut c = Command::new(cmd);
        c.args(args)
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        platform::hide_window(&mut c);
        match c.spawn() {
            Ok(mut child) => {
                let log = self.log.clone();
                let stderr = child.stderr.take();
                // the tool's outcome is not awaited; the stop's wait watches the process exit
                let _ = std::thread::Builder::new()
                    .name("shutdown-tool".into())
                    .spawn(move || {
                        if let Some(mut e) = stderr {
                            let mut buf = [0u8; 4096];
                            while let Ok(n) = e.read(&mut buf) {
                                if n == 0 {
                                    break;
                                }
                                log.line(&format!(
                                    "shutdown tool: {}",
                                    String::from_utf8_lossy(&buf[..n]).trim()
                                ));
                            }
                        }
                        let _ = child.wait();
                    });
            }
            Err(e) => self.log.line(&format!("shutdown tool failed to run: {e}")),
        }
    }

    fn handle_request(&mut self, req: Value, reply: Sender<Value>) {
        let op = crate::js::string(req.get("op"));
        let answer = match op.as_str() {
            "ping" => json!({
                "ok": true,
                "javaPid": self.last_pid,
                "startedAt": self.state.get("startedAt").cloned().unwrap_or(Value::Null),
                "alive": self.running.is_some(),
                "protocol": PROTOCOL,
                "daemon": "rust",
                "version": crate::build::current().version,
            }),
            "send" => self.handle_send(&req),
            "stop" => {
                let ms = crate::js::number(req.get("timeout"));
                let timeout = if ms > 0.0 {
                    Duration::from_millis(ms as u64)
                } else {
                    Duration::from_millis(DEFAULT_STOP_MS)
                };
                return self.handle_stop(timeout, Replier::Control(reply));
            }
            "kill" => return self.handle_kill(Replier::Control(reply)),
            _ => json!({ "ok": false, "error": format!("unknown op \"{op}\"") }),
        };
        let _ = reply.send(answer);
    }

    fn handle_send(&mut self, req: &Value) -> Value {
        if self.inst.as_ref().is_some_and(Instance::is_database) {
            return json!({ "ok": false, "error": "a database has no console input - use its client, or the panel" });
        }
        let Some(r) = self.running.as_ref() else {
            return json!({ "ok": false, "error": "server process is not running" });
        };
        let Some(line) = req.get("line").and_then(Value::as_str) else {
            return json!({ "ok": false, "error": "send requires a line" });
        };
        if r.stdin.as_ref().is_none_or(ConsoleInput::is_closed) {
            return json!({ "ok": false, "error": "the server console is closed" });
        }
        let clean = line
            .strip_suffix('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .unwrap_or(line);
        if let Err(e) = self.write_console_input(&format!("{clean}\n")) {
            return json!({ "ok": false, "error": e });
        }
        self.log.line(&format!("console <- {line}"));
        json!({ "ok": true })
    }

    fn on_bind_fatal(&mut self, message: &str) -> ! {
        self.log.line(&format!("control socket fatal: {message}"));
        self.console.say(&format!(
            "\n{CONSOLE_PREFIX} control channel unavailable ({message}); stopping the server\n"
        ));
        self.state.insert("running".into(), json!(false));
        self.state.insert(
            "error".into(),
            json!(format!("control channel unavailable: {message}")),
        );
        self.save_state();
        self.force_kill();
        std::thread::sleep(Duration::from_secs(1));
        self.leave(1);
    }

    /// Ends the daemon, removing the control socket it bound (as daemon.mjs's server.close()).
    fn leave(&self, code: i32) -> ! {
        control::remove_socket(&self.control);
        std::process::exit(code);
    }

    fn tick_waiters(&mut self) {
        let now = Instant::now();
        let mut keep = Vec::new();
        for waiter in std::mem::take(&mut self.waiters) {
            match waiter {
                Waiter::Stop {
                    reply,
                    deadline,
                    forced,
                } if now >= deadline => {
                    if forced {
                        let code = self.last_exit.0;
                        self.answer(reply, json!({ "ok": true, "forced": true, "code": code }));
                    } else {
                        self.log.line("graceful stop timed out");
                        self.force_kill();
                        keep.push(Waiter::Stop {
                            reply,
                            deadline: now + KILL_WAIT,
                            forced: true,
                        });
                    }
                }
                Waiter::Kill { reply, deadline } if now >= deadline => {
                    let code = self.last_exit.0;
                    self.answer(reply, json!({ "ok": true, "code": code, "forced": true }));
                }
                other => keep.push(other),
            }
        }
        // answering can add none, but keep any that arrived meanwhile
        keep.append(&mut self.waiters);
        self.waiters = keep;
    }

    fn main_loop(&mut self, events: Receiver<Event>) -> ! {
        loop {
            if platform::take_sigterm() {
                // exit only when the server is actually down; after a failed stop, exiting
                // would orphan it
                self.handle_stop(Duration::from_millis(DEFAULT_STOP_MS), Replier::Sigterm);
            }
            let exited = self
                .running
                .as_mut()
                .and_then(|r| r.child.try_wait().ok().flatten());
            if let Some(status) = exited {
                self.on_exit(status);
            }
            if self.respawn_at.is_some_and(|t| Instant::now() >= t) {
                self.respawn();
            }
            self.tick_waiters();
            if let Some(since) = self.shutdown_at {
                if self.exit_at.is_none() {
                    let notified = self.last_notify.as_ref().is_none_or(|h| h.is_finished());
                    if notified || since.elapsed() >= NOTIFY_GRACE {
                        self.exit_at = Some(Instant::now() + EXIT_DELAY);
                    }
                }
                if self.exit_at.is_some_and(|t| Instant::now() >= t) {
                    self.leave(0);
                }
            }
            match events.recv_timeout(Duration::from_millis(50)) {
                Ok(Event::Control { req, reply }) => {
                    // an exit that already happened is handled before the request is answered
                    let exited = self
                        .running
                        .as_mut()
                        .and_then(|r| r.child.try_wait().ok().flatten());
                    if let Some(status) = exited {
                        self.on_exit(status);
                    }
                    self.handle_request(req, reply)
                }
                Ok(Event::Ready { generation }) => {
                    if generation == self.generation && self.running.is_some() {
                        self.log.line("recovered: reports ready");
                        let msg = format!(
                            "back up after a crash \u{2014} restart {} of {CRASH_LIMIT} allowed per {} minutes.",
                            self.crashes.len(),
                            CRASH_WINDOW_MS / 60_000
                        );
                        self.tell(&msg);
                    }
                }
                Ok(Event::Bound(addr)) => self.log.line(&format!("control socket listening on {addr}")),
                Ok(Event::BindFatal(message)) => self.on_bind_fatal(&message),
                Ok(Event::RespDone { result }) => self.on_checkpoint(result),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {}
            }
        }
    }
}

struct ReadyWatch {
    seen: AtomicBool,
    // shared by both streams, as in daemon.mjs: a database may report ready on stderr
    tail: Mutex<Vec<u8>>,
    ready: &'static regex::Regex,
    generation: u64,
    events: Sender<Event>,
}

fn spawn_reader(
    mut stream: Box<dyn Read + Send>,
    console: Arc<Console>,
    recent: Arc<Mutex<Vec<u8>>>,
    watch: Option<Arc<ReadyWatch>>,
    done: Arc<AtomicUsize>,
) {
    let finished = done.clone();
    let spawned = std::thread::Builder::new().name("output".into()).spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            console.write(chunk);
            if let Ok(mut r) = recent.lock() {
                r.extend_from_slice(chunk);
                let over = r.len().saturating_sub(RECENT_BYTES);
                r.drain(..over);
            }
            if let Some(w) = &watch
                && !w.seen.load(Ordering::SeqCst)
                && let Ok(mut tail) = w.tail.lock()
            {
                tail.extend_from_slice(chunk);
                let over = tail.len().saturating_sub(READY_TAIL);
                tail.drain(..over);
                if w.ready.is_match(&String::from_utf8_lossy(&tail)) && !w.seen.swap(true, Ordering::SeqCst) {
                    let _ = w.events.send(Event::Ready {
                        generation: w.generation,
                    });
                }
            }
        }
        finished.fetch_add(1, Ordering::SeqCst);
    });
    if spawned.is_err() {
        done.fetch_add(1, Ordering::SeqCst);
    }
}

fn install_panic_hook(roots: Roots, name: String, log_file: PathBuf) {
    // A panic aborts the process (panic = "abort"), so this is the last chance to do what die()
    // does: kill the server's tree so it does not hold the port and world with nobody watching,
    // and say why in the state file and the daemon log.
    std::panic::set_hook(Box::new(move |info| {
        let reason = format!("internal error: {info}");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
        {
            let _ = f.write_all(format!("[{}] daemon failed: {reason}\n", time::iso_now()).as_bytes());
        }
        let java = platform::kill_target_now();
        let mut st = match (java, LAST_STATE.try_lock()) {
            (Some(_), Ok(last)) => last.clone().unwrap_or_default(),
            _ => Map::new(),
        };
        st.insert("name".into(), json!(name));
        st.insert("daemonPid".into(), json!(std::process::id()));
        st.insert("running".into(), json!(false));
        st.insert("error".into(), json!(reason));
        st.insert("failedAt".into(), json!(time::now_ms()));
        if let Some(pid) = java {
            st.insert("javaPid".into(), json!(pid));
            st.insert("killedOnDaemonFailure".into(), json!(true));
        }
        let _ = fsx::write_json(&roots.state_file(&name), &Value::Object(st));
        // the same end in every profile: a debug build would otherwise unwind only the thread
        // that panicked and carry on supervising a server this hook just killed
        std::process::abort();
    }));
}

/// Runs the daemon for `opts.name`. Returns only on a usage problem (with the exit code); the
/// daemon itself always ends the process.
pub fn run(opts: Options) -> i32 {
    if let Err(e) = registry::validate_name(&opts.name) {
        eprintln!("daemon: {e}");
        return 2;
    }
    let roots = Roots::new(opts.data_root.clone().unwrap_or_else(paths::resolve_data_root));
    let name = opts.name.clone();
    let dir = roots.run_dir(&name);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("daemon: cannot create {}: {e}", dir.display());
        return 1;
    }
    let log = Arc::new(Log::open(&roots.daemon_log(&name)));
    install_panic_hook(roots.clone(), name.clone(), roots.daemon_log(&name));
    platform::install_signal_handlers();

    let (tx, rx) = mpsc::channel();
    // one console file per daemon, truncated once at first start; a crash restart appends so
    // the lines before the crash survive
    let console_file = File::create(roots.console_log(&name));
    let mut daemon = Daemon {
        name: name.clone(),
        roots: roots.clone(),
        node: opts.node,
        spec: opts.spec,
        control: String::new(),
        log: log.clone(),
        console: Arc::new(Console {
            file: Mutex::new(console_file.as_ref().ok().and_then(|f| f.try_clone().ok())),
            log: log.clone(),
        }),
        recent: Arc::new(Mutex::new(Vec::new())),
        events: tx.clone(),
        inst: None,
        program: None,
        running: None,
        generation: 0,
        last_pid: None,
        last_exit: (None, None),
        state: Map::new(),
        stopping: false,
        stop_sent: false,
        respawn_at: None,
        crashes: Vec::new(),
        waiters: Vec::new(),
        last_notify: None,
        shutdown_at: None,
        exit_at: None,
    };
    if let Err(e) = console_file {
        daemon.die(&format!(
            "cannot open {}: {e}",
            roots.console_log(&name).display()
        ));
    }
    match paths::control_path(&roots, &name) {
        Ok(addr) => daemon.control = addr,
        Err(e) => daemon.die(&e),
    }
    match daemon.launch(true) {
        Ok(()) => {}
        Err(LaunchError::Spawn(msg)) => daemon.spawn_failed(msg),
        Err(LaunchError::Other(msg)) => daemon.die(&msg),
    }
    control::serve(daemon.control.clone(), tx, log);
    daemon.main_loop(rx)
}
