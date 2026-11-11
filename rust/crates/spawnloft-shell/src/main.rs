//! `SpawnLoft` (`SpawnLoft.exe`): the window. Phase 0 spike (P0-F, PLAN-RUST-TAURI.md section 3
//! item 5), internal only.
//!
//! It spawns `spawnloft-core ui --port 0` and opens one window on the address that prints,
//! exactly as step 2's Electron will, so step 3 changes nothing below the window. Everything the
//! panel does goes through that HTTP endpoint; the window itself has no Tauri API exposed to the
//! page (capabilities/default.json).
//!
//! Also here, because they are what the spike has to prove:
//! - the argv compatibility form (REVIEW-REV3 B1): `SpawnLoft.exe <...>\mcctl.mjs <command...>`,
//!   which every 1.x task shim, server launcher and MCP config runs, is forwarded to
//!   `spawnloft-core` so those keep working after the shell replaces Electron;
//! - start-time numbers, written when `SPAWNLOFT_SPIKE_MEASURE` names a file.
//!
//! Updates (2.x to 2.y) are in `updater.rs`: the core verifies the signed feed, the plugin
//! installs exactly what the core pinned.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitCode, Stdio};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

mod updater;

/// The running `spawnloft-core ui` and the pipe that keeps it alive (it exits when stdin closes).
#[derive(Debug, Default)]
pub struct Core {
    child: Mutex<Option<(Child, ChildStdin)>>,
}

impl Core {
    pub fn is_running(&self) -> bool {
        self.child.lock().is_ok_and(|g| g.is_some())
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Core::default())
        .manage(updater::Ready::default())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("SpawnLoft")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
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
        Err(e) => {
            spike_log(&format!("could not start: {e}"));
            return ExitCode::from(1);
        }
    };
    app.run(|app, event| match event {
        // the last window closed: a verified, downloaded update installs now (on Windows the
        // installer runs silently and this process exits inside install())
        RunEvent::ExitRequested { code: None, api, .. } => {
            if updater::install_on_quit(app) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => app.state::<Core>().stop(),
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
        if let Err(e) = cmd.spawn() {
            spike_log(&format!("{}: {e}", args.join(" ")));
        }
    }
}

pub(crate) fn start_core(app: tauri::AppHandle) {
    let (Some(bin), Some(dir)) = (core_binary(), core_dir()) else {
        spike_log("no core binary path");
        return;
    };
    let mut cmd = Command::new(&bin);
    cmd.args(["ui", "--port", "0", "--exit-with-stdin", "--core-dir"])
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            spike_log(&format!("could not start {}: {e}", bin.display()));
            return;
        }
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return;
    };
    if let Ok(mut guard) = app.state::<Core>().child.lock() {
        *guard = Some((child, stdin));
    }
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
            match (url.trim().parse(), app.get_webview_window("main")) {
                (Ok(url), Some(w)) => {
                    if let Err(e) = w.navigate(url) {
                        spike_log(&format!("navigate: {e}"));
                    }
                }
                _ => spike_log(&format!("bad panel address `{url}`")),
            }
        }
    });
}

/// `SpawnLoft.exe <path ending in mcctl.mjs or spawnloft.mjs> <command...>`: what 1.x task shims,
/// server launchers and MCP configs run (with ELECTRON_RUN_AS_NODE, ignored here). Forwarded to
/// `spawnloft-core <command...>`, the install's one entry point, which runs it on the bundled
/// Node; `None` when the command line is not that form. The first `repair` rewrites those files
/// to name `spawnloft-core` directly (RUNTIME_FORMAT 2), so this form only carries the time
/// between the handover and that repair, and MCP configs a user copied from 1.x.
fn argv_compat(args: &[std::ffi::OsString]) -> Option<ExitCode> {
    let first = args.get(1)?.to_string_lossy().to_ascii_lowercase();
    if !(first.ends_with("mcctl.mjs") || first.ends_with("spawnloft.mjs")) {
        return None;
    }
    let Some(core) = core_binary() else {
        spike_log("argv compatibility: no core binary path");
        return Some(ExitCode::from(127));
    };
    let mut cmd = Command::new(&core);
    cmd.args(&args[2..])
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    Some(match run_forwarder(cmd) {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(e) => {
            spike_log(&format!("argv compatibility: {}: {e}", core.display()));
            ExitCode::from(1)
        }
    })
}

/// The forwarded core in a kill-on-close job on Windows (a killed `SpawnLoft.exe` takes the core
/// and its Node with it; PLAN-2.0-REMAINING.md A6), a plain child elsewhere.
#[cfg(windows)]
fn run_forwarder(cmd: Command) -> std::io::Result<i32> {
    spawnloft_lib::platform::ignore_ctrl_c();
    spawnloft_lib::platform::run_in_kill_job(cmd)
}

#[cfg(not(windows))]
fn run_forwarder(mut cmd: Command) -> std::io::Result<i32> {
    Ok(cmd.status()?.code().unwrap_or(1))
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

fn spike_log(msg: &str) {
    let Some(path) = std::env::var_os("SPAWNLOFT_SPIKE_LOG") else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {msg}", epoch_ms());
    }
}
