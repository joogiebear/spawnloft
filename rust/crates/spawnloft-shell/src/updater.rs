//! The window's half of the updater (INSTALLER-UPDATER-DESIGN.md 5.5 to 5.6).
//!
//! The core decides (`spawnloft-core update check --json` discovers, verifies the signed envelope
//! and applies the policy) and downloads (`update apply --no-run` fetches the artifact the record
//! names, capped at the size the envelope signed, verifies it and keeps it in the config folder's
//! cache); this file only acts on the pinned record: it reads the cached file, checks the bytes
//! against the record again (minisign signature with the compiled-in key the record's `keyId`
//! names, signed version, size, sha512), hands them to `tauri-plugin-updater`, which verifies
//! once more and runs the installer, on request (the panel's `update-request.json`) or on quit.
//!
//! The plugin never fetches anything: the release manifest it works from is built from the
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
use spawnloft_lib::update::{Pinned, keys, verify_artifact};
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

    /// Drops what is staged: the feed no longer offers it.
    fn clear(&self) {
        if let Ok(mut g) = self.staged.lock() {
            *g = None;
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

/// The plugin, pinned to one record: the compiled-in key its `keyId` names (never a key the
/// record carries), its version, its URL and its signature.
fn updater(app: &AppHandle, pinned: &Pinned, restart: bool) -> Result<tauri_plugin_updater::Updater, String> {
    let pubkey = keys::trusted()
        .into_iter()
        .find(|k| k.id == pinned.key_id)
        .map(|k| k.plugin_pubkey())
        .ok_or_else(|| format!("key {} is not trusted by this build", pinned.key_id))?;
    let pin = pinned.clone();
    let target = pinned.target.clone();
    let stopper = app.clone();
    // `build()` refuses an updater with no endpoint, although `restore_update` never fetches one:
    // the record was fetched and verified by the core. A fixed https placeholder satisfies the
    // check (the pinned URL itself may be plain http in the CI scenario builds).
    let placeholder: tauri::Url = "https://github.com/joogiebear/spawnloft/releases"
        .parse()
        .map_err(|e| format!("placeholder endpoint: {e}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![placeholder])
        .map_err(|e| e.to_string())?
        .pubkey(pubkey)
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

/// The artifact bytes for `pinned`, fetched through the core (`update apply --no-run`): the core
/// serves its verified cached copy or downloads one capped at the signed size, verifies it, keeps
/// it, and marks its saved offer downloaded. The bytes are verified here again before use.
fn fetch_artifact(core: &PathBuf, pinned: &Pinned) -> Result<Vec<u8>, String> {
    let store = store();
    let trusted = keys::trusted();
    let cached = store.cache_file(&pinned.version, &pinned.file);
    // the core downloads what its own saved offer names; that must be this record. It goes
    // through the core even when the file is cached, so the core's state (downloaded) is the
    // one record of what is staged and nothing here writes the core's files.
    log("download", &[("version", &pinned.version), ("url", &pinned.url)]);
    let applied = core_update(core, &["apply", "--no-run"])?;
    if applied.get("version").and_then(Value::as_str) != Some(pinned.version.as_str()) {
        return Err(format!(
            "the core's offer is {}, not {}",
            applied.get("version").and_then(Value::as_str).unwrap_or("-"),
            pinned.version
        ));
    }
    let bytes = std::fs::read(&cached).map_err(|e| format!("could not read {}: {e}", cached.display()))?;
    if let Err(why) = verify_artifact(&bytes, pinned, &trusted) {
        store.remove_cached(&pinned.version);
        log("download-refused", &[("version", &pinned.version), ("why", &why)]);
        return Err(why);
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
    // Windows: the plugin verifies and extracts first and calls on_before_exit (which stops the
    // core) right before it starts the installer, so a refused or failed install leaves the core
    // running. macOS swaps the bundle in place, so the core is stopped first and started again
    // when the swap fails.
    #[cfg(not(windows))]
    app.state::<crate::Core>().stop();
    if let Err(e) = update.install(bytes) {
        log(
            "install-failed",
            &[("version", &pinned.version), ("why", &e.to_string())],
        );
        if !app.state::<crate::Core>().is_running() {
            crate::start_core(app.clone());
        }
        return Err(e.to_string());
    }
    // not reached on Windows; on macOS the bundle has been replaced
    if on_quit {
        app.exit(0);
    } else {
        app.restart();
    }
    Ok(())
}

fn check(app: &AppHandle, core: &PathBuf, reason: &str) -> Result<(), String> {
    log("check", &[("reason", reason)]);
    let report = core_update(core, &["check"])?;
    let Some(update) = report.get("update").filter(|u| !u.is_null()) else {
        // nothing offered (up to date, blocked, or the feed withdrew it): nothing stays staged
        app.state::<Ready>().clear();
        return Ok(());
    };
    let pinned = Pinned::from_json(update).ok_or("the core's update record is malformed")?;
    let bytes = fetch_artifact(core, &pinned)?;
    app.state::<Ready>().put(pinned, bytes);
    Ok(())
}

fn serve(app: &AppHandle, core: &PathBuf, req: Request) -> Result<(), String> {
    match req.action.as_str() {
        "check" => check(app, core, "panel"),
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
                Some((staged, bytes)) if staged.sha512 == pinned.sha512 => bytes,
                _ => fetch_artifact(core, &pinned)?,
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
            let bytes = fetch_artifact(core, &pinned)?;
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
    // everything here is blocking work (the core runs as a subprocess), on plain threads
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            if let Err(e) = check(&scheduled, &core_a, "schedule") {
                log("check-failed", &[("why", &e)]);
            }
            std::thread::sleep(INTERVAL);
        }
    });
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(REQUEST_POLL);
            if let Some(req) = store().take_request() {
                log(
                    "request",
                    &[
                        ("action", &req.action),
                        ("version", req.version.as_deref().unwrap_or("-")),
                    ],
                );
                if let Err(e) = serve(&app, &core, req) {
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
    // only what the core still offers: a check since may have withdrawn it
    let still_offered = store()
        .state()
        .pending
        .is_some_and(|p| p.version == pinned.version && p.sha512 == pinned.sha512 && !p.rollback);
    if !still_offered {
        log(
            "quit-install-skipped",
            &[("version", &pinned.version), ("why", "no longer offered")],
        );
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
