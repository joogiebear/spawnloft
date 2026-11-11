//! `SpawnLoft` (`SpawnLoft.exe`): the window. Phase 0 spike (P0-F, PLAN-RUST-TAURI.md section 3
//! item 5), internal only.
//!
//! It spawns `spawnloft-core ui --port 0` and opens one window on the address that prints,
//! exactly as step 2's Electron will, so step 3 changes nothing below the window. Everything the
//! panel does goes through that HTTP endpoint; what only a window can do (pickers, the interface
//! size, the system browser, the file manager, extra windows, downloads) is `bridge.rs`, granted
//! to exactly the panel's origin.
//!
//! Also here, because they are what the spike has to prove:
//! - the argv compatibility form (REVIEW-REV3 B1): `SpawnLoft.exe <...>\mcctl.mjs <command...>`,
//!   which every 1.x task shim, server launcher and MCP config runs, is forwarded to the Node core
//!   so those keep working after the shell replaces Electron;
//! - start-time numbers, written when `SPAWNLOFT_SPIKE_MEASURE` names a file.
//!
//! Updates (2.x to 2.y) are in `updater.rs`: the core verifies the signed feed, the plugin
//! installs exactly what the core pinned.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitCode, Stdio};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod bridge;
mod local;
mod updater;
mod winstate;
mod zoom;

/// How long the core may take to print its address before the window says it could not start.
const CORE_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// The running `spawnloft-core ui` and the pipe that keeps it alive (it exits when stdin closes).
#[derive(Debug, Default)]
pub struct Core {
    child: Mutex<Option<(Child, ChildStdin)>>,
    /// Times the core was started again after it ended by itself (a crash, a kill).
    restarts: std::sync::atomic::AtomicU32,
}

/// How many times a core that ends by itself is started again before the window gives up.
const CORE_RESTARTS: u32 = 3;
/// A core up this long before it ended counts as having worked: the restart count starts over.
const CORE_STABLE: std::time::Duration = std::time::Duration::from_secs(300);

impl Core {
    pub fn is_running(&self) -> bool {
        self.child.lock().is_ok_and(|g| g.is_some())
    }

    /// Whether the core with this pid is the one the window uses now (a restart may have
    /// replaced it while its address line was on the way).
    fn is_current(&self, pid: u32) -> bool {
        self.child
            .lock()
            .is_ok_and(|g| g.as_ref().is_some_and(|(c, _)| c.id() == pid))
    }

    /// Puts a new core in the slot; one already there (two starts that overlapped) is stopped
    /// and reaped, never left running unowned.
    fn replace(&self, child: Child, stdin: ChildStdin) {
        let old = self.child.lock().ok().and_then(|mut g| g.replace((child, stdin)));
        if let Some((mut c, stdin)) = old {
            drop(stdin);
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// The core with this pid ended by itself (it is still the one in the slot, so nobody stopped
    /// it): reap it and say so.
    fn ended_by_itself(&self, pid: u32) -> bool {
        let Ok(mut guard) = self.child.lock() else {
            return false;
        };
        if guard.as_ref().is_none_or(|(c, _)| c.id() != pid) {
            return false;
        }
        if let Some((mut child, _)) = guard.take() {
            let _ = child.wait();
        }
        true
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock()
            && let Some((mut child, stdin)) = guard.take()
        {
            drop(stdin);
            // it exits on its own once stdin closes; give it a moment, then make sure
            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() -> ExitCode {
    let started = Instant::now();
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(code) = argv_compat(&args) {
        return code;
    }
    // Arguments the installer may pass (`/ARGS`, a stray `/ROLLBACK`) are not for the window:
    // nothing below reads argv, so they are ignored by construction (design 5.6).
    resume_pending_handover();

    local::carry_over_electron_files();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window(bridge::MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        // used from Rust only: no capability grants the page any of its commands
        .plugin(tauri_plugin_dialog::init())
        .manage(Core::default())
        .manage(updater::Ready::default())
        .manage(bridge::Shell::new())
        .invoke_handler(bridge::handler())
        .setup(move |app| {
            if let Err(e) = bridge::build_main(app.handle()) {
                // on Windows this is where a missing WebView2 runtime ends up (design 2.6)
                fatal(
                    "SpawnLoft could not open its window",
                    &format!(
                        "{e}\n\nOn Windows, SpawnLoft needs Microsoft Edge WebView2. Install the \
                         Evergreen runtime from https://developer.microsoft.com/microsoft-edge/webview2/ \
                         and open SpawnLoft again. Your servers keep running either way."
                    ),
                );
            }
            start_core(app.handle().clone());
            if let Some(core) = core_binary() {
                updater::start(app.handle().clone(), core);
            }
            Ok(())
        })
        .on_page_load(move |_webview, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().scheme() == "http" {
                measure(started);
            }
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(a) => a,
        Err(e) => fatal("SpawnLoft could not start", &e.to_string()),
    };
    app.run(|app, event| match event {
        // the last window closed: a verified, downloaded update installs now (on Windows the
        // installer runs silently and this process exits inside install())
        RunEvent::ExitRequested { code: None, api, .. } => {
            if updater::install_on_quit(app) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            app.state::<bridge::Shell>().flush();
            app.state::<Core>().stop();
        }
        _ => {}
    });
    ExitCode::SUCCESS
}

/// Where the bundle puts the core binary and the Node core: `<exe dir>/resources` on Windows and
/// Linux, as 1.x does; `Contents/Resources/resources` in a macOS `.app` (Tauri's resource dir).
fn resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        return Some(dir.parent()?.join("Resources").join("resources"));
    }
    Some(dir.join("resources"))
}

fn core_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SPAWNLOFT_CORE_BIN").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let name = if cfg!(windows) {
        "spawnloft-core.exe"
    } else {
        "spawnloft-core"
    };
    Some(resources_dir()?.join("bin").join(name))
}

/// The Node core (`mcctl.mjs`, `spawnloft.mjs`, `src/`): `SPAWNLOFT_CORE_DIR`, then the bundled copy.
fn core_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SPAWNLOFT_CORE_DIR").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    Some(resources_dir()?.join("core"))
}

/// After a 1.x handover whose resume never ran (installer closed, power lost; design 2.5): the
/// core starts what is still pending, under its lock, and exits at once when nothing is. Not
/// waited for; the banner that reports it is the panel's (T5).
fn resume_pending_handover() {
    let Some(bin) = core_binary() else {
        return;
    };
    // the pending resume, and the once-only cleanup of Electron's leftovers (design section 7);
    // both exit at once when there is nothing to do
    for args in [
        &["handover", "resume", "--pending"][..],
        &["handover", "cleanup"][..],
    ] {
        let mut cmd = Command::new(&bin);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.spawn() {
            // reaped when it ends, so no zombie stays behind on macOS and Linux
            Ok(mut child) => {
                std::thread::spawn(move || child.wait());
            }
            Err(e) => local::log(&format!("{}: {e}", args.join(" "))),
        }
    }
}

pub(crate) fn start_core(app: tauri::AppHandle) {
    let (Some(bin), Some(dir)) = (core_binary(), core_dir()) else {
        cannot_start(&app, "this installation has no core program (resources/bin)");
        return;
    };
    let mut cmd = Command::new(&bin);
    // the core's stderr, and the Node panel's under it, go where `doctor` already looks
    let stderr = local::panel_log().map_or_else(Stdio::null, Stdio::from);
    cmd.args(["ui", "--port", "0", "--exit-with-stdin", "--core-dir"])
        .arg(&dir)
        .env("SPAWNLOFT_SHELL", "tauri")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cannot_start(&app, &format!("{} did not start: {e}", bin.display()));
            return;
        }
    };
    // Windows: the core also ends if this process is killed before it can close the pipe
    spawnloft_lib::platform::end_with_this_process(&child);
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return;
    };
    let pid = child.id();
    let started = std::time::Instant::now();
    app.state::<Core>().replace(child, stdin);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watchdog = app.clone();
    std::thread::spawn(move || {
        if rx.recv_timeout(CORE_READY_TIMEOUT) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            cannot_start(&watchdog, "the core did not print its address within 90 seconds");
        }
    });
    std::thread::spawn(move || {
        let mut opened = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if opened {
                continue;
            }
            let Some(url) = line.trim().strip_prefix(spawnloft_lib::panel::READY_PREFIX) else {
                continue;
            };
            opened = true;
            let _ = tx.send(());
            // a core replaced in the meantime must not point the window at its port
            if app.state::<Core>().is_current(pid) {
                open_panel(&app, url.trim());
            }
        }
        // stdout ended: the core exited, or was stopped (quit, restart), which takes it out of
        // the slot first
        let core = app.state::<Core>();
        if !core.ended_by_itself(pid) {
            return;
        }
        if !opened {
            let _ = tx.send(());
            return cannot_start(&app, "the core exited before the panel was ready; see panel.log");
        }
        // it was serving the window: start it again, a few times, and open the panel once more
        // (servers are separate processes and never noticed)
        // a core that served for a while before it ended starts the count again
        if started.elapsed() > CORE_STABLE {
            core.restarts.store(0, std::sync::atomic::Ordering::SeqCst);
        }
        let n = core.restarts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if n > CORE_RESTARTS {
            return cannot_start(&app, "the core keeps stopping; see panel.log");
        }
        local::log(&format!(
            "the core ended by itself; starting it again ({n} of {CORE_RESTARTS})"
        ));
        bridge::clear_panel(&app);
        start_core(app.clone());
    });
}

/// The panel answers at `url`: grant it the bridge, then show the first-run wizard if the panel
/// says this machine has no locations yet, the panel otherwise.
fn open_panel(app: &tauri::AppHandle, url: &str) {
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(_) => return cannot_start(app, &format!("the core printed a bad address `{url}`")),
    };
    if let Err(e) = bridge::set_panel(app, &parsed) {
        return cannot_start(app, &e);
    }
    let mut target = parsed.clone();
    if let Some(addr) = app.state::<bridge::Shell>().panel_addr() {
        match local::panel_get(addr, "/api/setup") {
            Ok(v) if v["needed"] == serde_json::Value::Bool(true) => target.set_path("/setup"),
            Ok(_) => {}
            Err(e) => local::log(&format!("could not ask the panel about first-run setup: {e}")),
        }
    }
    match app.get_webview_window(bridge::MAIN) {
        Some(w) => {
            if let Err(e) = w.navigate(target) {
                local::log(&format!("navigate: {e}"));
            }
        }
        None => local::log("no main window to show the panel in"),
    }
}

/// The window is up but the core is not: say so in a dialog (1.x showed one too), with where
/// to look. Servers are separate processes and are not affected.
fn cannot_start(app: &tauri::AppHandle, why: &str) {
    local::log(&format!("could not start the panel: {why}"));
    let log = local::run_dir().join("panel.log");
    app.dialog()
        .message(format!(
            "{why}\n\nRunning servers are not affected. Details are in {}.",
            log.display()
        ))
        .title("SpawnLoft could not start its panel")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// Before there is an event loop (no window could be made): a native message box, then exit.
fn fatal(title: &str, text: &str) -> ! {
    local::log(&format!("{title}: {text}"));
    message_box(title, text);
    std::process::exit(1);
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn message_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (t, m) = (wide(title), wide(text));
    // SAFETY: two NUL-terminated UTF-16 strings that outlive the call, and no owner window.
    unsafe { MessageBoxW(std::ptr::null_mut(), m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONERROR) };
}

#[cfg(not(windows))]
fn message_box(title: &str, text: &str) {
    eprintln!("{title}\n{text}");
}

/// `SpawnLoft.exe <path ending in mcctl.mjs or spawnloft.mjs> <command...>`: what 1.x task shims,
/// server launchers and MCP configs run (with ELECTRON_RUN_AS_NODE, ignored here). Forwarded to
/// Node with the same arguments; `None` when the command line is not that form.
fn argv_compat(args: &[std::ffi::OsString]) -> Option<ExitCode> {
    let first = args.get(1)?.to_string_lossy().to_ascii_lowercase();
    if !(first.ends_with("mcctl.mjs") || first.ends_with("spawnloft.mjs")) {
        return None;
    }
    let script = Path::new(&args[1]);
    // the shim names the 1.x path; the same file ships at the same place in this install
    let script = if script.is_file() {
        script.to_path_buf()
    } else {
        core_dir()?.join(script.file_name()?)
    };
    let Some(node) = spawnloft_lib::panel::find_node(None) else {
        local::log("argv compatibility: Node.js not found");
        return Some(ExitCode::from(127));
    };
    // a forwarder that is killed takes its Node along on Windows too (plan 3C, A6)
    let status = Command::new(node)
        .arg(script)
        .args(&args[2..])
        .env_remove("ELECTRON_RUN_AS_NODE")
        .spawn()
        .and_then(|mut child| {
            spawnloft_lib::platform::end_with_this_process(&child);
            child.wait()
        });
    Some(match status {
        Ok(s) => ExitCode::from(u8::try_from(s.code().unwrap_or(1)).unwrap_or(1)),
        Err(e) => {
            local::log(&format!("argv compatibility: {e}"));
            ExitCode::from(1)
        }
    })
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn measure(started: Instant) {
    let Some(path) = std::env::var_os("SPAWNLOFT_SPIKE_MEASURE") else {
        return;
    };
    let line = format!(
        "{{\"panelLoadedEpochMs\":{},\"sinceMainMs\":{}}}\n",
        epoch_ms(),
        started.elapsed().as_millis()
    );
    let _ = std::fs::write(path, line);
}
