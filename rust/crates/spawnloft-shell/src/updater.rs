//! The window's half of the updater (INSTALLER-UPDATER-DESIGN.md 5.5 to 5.6).
//!
//! The core decides (`spawnloft-core update check --json` discovers, verifies the signed envelope
//! and applies the policy); this file only acts on the pinned record it prints: it has
//! `tauri-plugin-updater` download the artifact named by that record and nothing else, checks the
//! bytes against the record again (minisign signature with the pinned key, signed version, size,
//! sha512), keeps a copy in the config folder's cache, and installs on request (the panel's
//! `update-request.json`) or on quit.
//!
//! The plugin never fetches a `latest.json`: the release manifest it works from is built from the
//! record (`Update::restore_update`), which also forces its signed-version check, and the
//! `version_comparator` pins version, URL and signature once more. A rollback is the same path
//! with the lower version the core verified, `/ROLLBACK` for the Windows template and no `/R`
//! (the template relaunches on its own, so the flag never reaches the new app).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use spawnloft_lib::update::store::{Request, Store};
use spawnloft_lib::update::{CACHE_KEEP, Pinned, keys, verify_artifact};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// First check after start, then the interval (1.x used the same six hours).
const FIRST_CHECK: Duration = Duration::from_secs(20);
const INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// How often the panel's request file is looked at.
const REQUEST_POLL: Duration = Duration::from_secs(2);

/// A verified, downloaded update waiting for an install moment.
#[derive(Debug, Default)]
pub struct Ready {
    staged: Mutex<Option<(Pinned, Vec<u8>)>>,
}

impl Ready {
    pub fn take_for(&self, version: Option<&str>) -> Option<(Pinned, Vec<u8>)> {
        let mut g = self.staged.lock().ok()?;
        match (&*g, version) {
            (Some((p, _)), Some(v)) if p.version != v => None,
            (Some(_), _) => g.take(),
            (None, _) => None,
        }
    }

    fn put(&self, pinned: Pinned, bytes: Vec<u8>) {
        if let Ok(mut g) = self.staged.lock() {
            *g = Some((pinned, bytes));
        }
    }
}

fn store() -> Store {
    Store::default_location()
}

fn log(event: &str, fields: &[(&str, &str)]) {
    store().log(&format!("shell-{event}"), fields);
}

/// Runs `spawnloft-core update <args> --json` and parses what it printed.
fn core_update(core: &PathBuf, args: &[&str]) -> Result<Value, String> {
    let mut cmd = Command::new(core);
    cmd.arg("update").args(args).arg("--json");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run {}: {e}", core.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("");
    let value: Value = serde_json::from_str(line).map_err(|e| {
        format!(
            "spawnloft-core update {} did not answer in JSON ({e}): {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let why = value
            .get("error")
            .or_else(|| value.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("failed");
        return Err(why.to_string());
    }
    Ok(value)
}

/// The plugin, pinned to one record: its key, its version, its URL and its signature.
fn updater(app: &AppHandle, pinned: &Pinned, restart: bool) -> Result<tauri_plugin_updater::Updater, String> {
    let pin = pinned.clone();
    let target = pinned.target.clone();
    let stopper = app.clone();
    let mut builder = app
        .updater_builder()
        .pubkey(pinned.pubkey.clone())
        .target(target.clone())
        .version_comparator(move |_current, remote| {
            remote.version.to_string() == pin.version
                && remote
                    .download_url(&target)
                    .map(|u| u.as_str() == pin.url)
                    .unwrap_or(false)
                && remote.signature(&target).ok() == pin.signature.as_ref()
        })
        // the installer replaces resources\bin\spawnloft-core.exe: the core must not hold it
        .on_before_exit(move || stopper.state::<crate::Core>().stop())
        .restart_after_install(restart);
    if pinned.rollback {
        // the template skips its downgrade abort and relaunches through its own path (design 5.6)
        builder = builder.installer_args(["/ROLLBACK"]);
    }
    builder.build().map_err(|e| e.to_string())
}

fn pinned_update(app: &AppHandle, pinned: &Pinned, restart: bool) -> Result<Update, String> {
    updater(app, pinned, restart)?
        .restore_update(pinned.plugin_manifest())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "the plugin did not accept the pinned release (version, url or signature differ)".to_string()
        })
}

/// The artifact bytes for `pinned`: the verified cached copy, or a fresh download through the
/// plugin, verified against the record and cached.
async fn fetch_artifact(app: &AppHandle, pinned: &Pinned) -> Result<Vec<u8>, String> {
    let store = store();
    let trusted = keys::trusted();
    let cached = store.cache_file(&pinned.version, &pinned.file);
    if let Ok(bytes) = std::fs::read(&cached) {
        if verify_artifact(&bytes, pinned, &trusted).is_ok() {
            log("cache-hit", &[("version", &pinned.version)]);
            return Ok(bytes);
        }
        store.remove_cached(&pinned.version);
        log("cache-dropped", &[("version", &pinned.version)]);
    }
    let update = pinned_update(app, pinned, true)?;
    log("download", &[("version", &pinned.version), ("url", &pinned.url)]);
    // the plugin verifies the minisign signature and the signed version inside download()
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // and the record's own checks: size and sha512 bind the bytes to the envelope
    if let Err(why) = verify_artifact(&bytes, pinned, &trusted) {
        log("download-refused", &[("version", &pinned.version), ("why", &why)]);
        return Err(why);
    }
    match store.store_artifact(&pinned.version, &pinned.file, &bytes, CACHE_KEEP) {
        Ok(_) => {
            let mut state = store.state();
            if state
                .pending
                .as_ref()
                .is_some_and(|p| p.version == pinned.version)
            {
                state.downloaded = true;
                let _ = store.save_state(&state);
            }
        }
        Err(e) => log("cache-write-failed", &[("why", &e.to_string())]),
    }
    log(
        "downloaded",
        &[("version", &pinned.version), ("bytes", &bytes.len().to_string())],
    );
    Ok(bytes)
}

/// Runs the installer (Windows exits inside; macOS swaps the bundle, then we restart or exit).
fn install(app: &AppHandle, pinned: &Pinned, bytes: &[u8], on_quit: bool) -> Result<(), String> {
    let restart = !on_quit && !pinned.rollback;
    let update = pinned_update(app, pinned, restart)?;
    log(
        "install",
        &[
            ("version", &pinned.version),
            ("rollback", if pinned.rollback { "yes" } else { "no" }),
            ("on-quit", if on_quit { "yes" } else { "no" }),
        ],
    );
    app.state::<crate::Core>().stop();
    update.install(bytes).map_err(|e| {
        log(
            "install-failed",
            &[("version", &pinned.version), ("why", &e.to_string())],
        );
        e.to_string()
    })?;
    // not reached on Windows; on macOS the bundle has been replaced
    if on_quit {
        app.exit(0);
    } else {
        app.restart();
    }
    Ok(())
}

async fn check(app: &AppHandle, core: &PathBuf, reason: &str) -> Result<(), String> {
    log("check", &[("reason", reason)]);
    let report = core_update(core, &["check"])?;
    let Some(update) = report.get("update").filter(|u| !u.is_null()) else {
        return Ok(());
    };
    let pinned = Pinned::from_json(update).ok_or("the core's update record is malformed")?;
    let bytes = fetch_artifact(app, &pinned).await?;
    app.state::<Ready>().put(pinned, bytes);
    Ok(())
}

async fn serve(app: &AppHandle, core: &PathBuf, req: Request) -> Result<(), String> {
    match req.action.as_str() {
        "check" => check(app, core, "panel").await,
        "install" => {
            let state = store().state();
            let Some(pinned) = state.pending else {
                return Err("nothing verified to install".to_string());
            };
            if let Some(v) = &req.version
                && *v != pinned.version
            {
                return Err(format!(
                    "the panel asked for {v} but the verified update is {}",
                    pinned.version
                ));
            }
            let bytes = match app.state::<Ready>().take_for(Some(&pinned.version)) {
                Some((_, bytes)) => bytes,
                None => fetch_artifact(app, &pinned).await?,
            };
            install(app, &pinned, &bytes, false)
        }
        "rollback" => {
            let version = req.version.as_deref().ok_or("rollback needs a version")?;
            // the core verifies the envelope and the rollback rules and writes the hold
            let planned = core_update(core, &["rollback", version])?;
            let pinned = planned
                .get("update")
                .and_then(Pinned::from_json)
                .ok_or("the core's rollback record is malformed")?;
            let bytes = fetch_artifact(app, &pinned).await?;
            install(app, &pinned, &bytes, false)
        }
        other => Err(format!("unknown request `{other}`")),
    }
}

/// Starts the schedule and the request watcher. Nothing runs when the build has updates off.
pub fn start(app: AppHandle, core: PathBuf) {
    if updates_off() {
        log("off", &[("why", "SPAWNLOFT_UPDATES=off")]);
        return;
    }
    let scheduled = app.clone();
    let core_a = core.clone();
    tauri::async_runtime::spawn(async move {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(FIRST_CHECK))
            .await
            .ok();
        loop {
            if let Err(e) = check(&scheduled, &core_a, "schedule").await {
                log("check-failed", &[("why", &e)]);
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(INTERVAL))
                .await
                .ok();
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(REQUEST_POLL))
                .await
                .ok();
            if let Some(req) = store().take_request() {
                log(
                    "request",
                    &[
                        ("action", &req.action),
                        ("version", req.version.as_deref().unwrap_or("-")),
                    ],
                );
                if let Err(e) = serve(&app, &core, req).await {
                    log("request-failed", &[("why", &e)]);
                }
            }
        }
    });
}

/// Internal builds and tests set `SPAWNLOFT_UPDATES=off` (the Electron internal config's
/// `updates: 'off'` had the same job).
fn updates_off() -> bool {
    std::env::var("SPAWNLOFT_UPDATES").is_ok_and(|v| v == "off")
}

/// Install on quit: a staged update is installed silently when the last window closes
/// (`autoInstallOnAppQuit`, as 1.x). Returns true when it took over the exit.
pub fn install_on_quit(app: &AppHandle) -> bool {
    let Some((pinned, bytes)) = app.state::<Ready>().take_for(None) else {
        return false;
    };
    if pinned.rollback {
        // a rollback is only ever run on request
        app.state::<Ready>().put(pinned, bytes);
        return false;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = install(&handle, &pinned, &bytes, true) {
            log("quit-install-failed", &[("why", &e)]);
            handle.exit(0);
        }
    });
    true
}
