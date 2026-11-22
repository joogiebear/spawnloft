//! `first-run.mjs`: the first-run wizard's three calls (`getSetup`, `saveSetup`, `checkJava`),
//! served by the panel at `/api/setup` so the window needs nothing of its own. The shell asks
//! `needed` once the panel is up and shows `/setup` instead of `/` when it is true; after a save
//! it restarts the core, because the data root is resolved once, at start.

use serde_json::{Map, Value, json};
use std::path::Path;

use crate::settings::{self, Layout};
use crate::{java, js, jspath};

/// `needsSetup()`: settings.json survives an uninstall and the data folder may be on an
/// unplugged drive, so a saved root only counts if it still exists. (The Node core also took a
/// checkout that holds `instances.json` as configured; no installed build is one.)
pub fn needs_setup() -> bool {
    let (saved, _) = settings::load();
    let root = saved.get("dataRoot");
    // `existsSync` of anything but a path is false
    !matches!(root, Some(Value::String(s)) if !s.is_empty() && Path::new(s).exists())
}

/// `getSetup()`.
pub fn get_setup() -> Result<Value, crate::failure::Failure> {
    let (saved, _) = settings::load();
    // the core's own folder: no Node core ships
    let core_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Ok(json!({
        "needed": needs_setup(),
        "defaultDataRoot": settings::default_data_root(),
        "current": Layout::resolve(&saved)?.to_json(),
        "coreDir": core_dir,
        "coreMode": "bundled",
        // nobody sees stderr in the desktop app, so an unreadable settings file is told to the wizard
        "settingsProblem": settings::inspect(),
    }))
}

/// `checkJava()`: `{ ...health(), downloadUrl }`.
pub fn check_java() -> Value {
    let mut m = java::health().to_json();
    m.insert("downloadUrl".into(), json!(java::download_url_for()));
    Value::Object(m)
}

fn refused(error: String) -> Value {
    json!({ "ok": false, "error": error })
}

/// `saveSetup(body)`: `{ ok: true }` or `{ ok: false, error }`; the caller (the shell) restarts
/// the core on ok.
pub fn save_setup(body: &Value) -> Value {
    let get = |k: &str| body.as_object().and_then(|m| m.get(k));
    let data_root = get("dataRoot").and_then(Value::as_str).unwrap_or("");
    let separate = get("separate") == Some(&Value::Bool(true));
    let instances_dir = if separate {
        get("instancesDir").and_then(Value::as_str)
    } else {
        None
    };
    if data_root.is_empty() || !jspath::is_absolute(data_root) {
        return refused("Choose a folder for SpawnLoft's files.".into());
    }
    if separate && !instances_dir.is_some_and(|d| !d.is_empty() && jspath::is_absolute(d)) {
        return refused("Choose a folder for the servers.".into());
    }
    // write-test the folders: unplugged drives, read-only mounts and network shares look fine
    // until the first write
    for dir in [Some(data_root), instances_dir].into_iter().flatten() {
        if let Err(error) = settings::check_writable(dir) {
            return refused(format!("Cannot write to {dir}\n{error}"));
        }
    }
    let patch = [
        ("dataRoot", json!(data_root)),
        ("separateInstances", json!(separate)),
        ("instancesDir", json!(instances_dir)),
    ];
    // read back: a write that did not land (a read-only roaming profile, a sync client holding
    // the file) would silently restart on the default location. Read before another save in
    // this process can land, so it is this write that is checked.
    let mut written: Map<String, Value> = Map::new();
    if let Err(e) = settings::save_then(&patch, true, || written = settings::load().0) {
        return refused(e.message().to_string());
    }
    let got = written.get("dataRoot");
    let got_text = match got {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    };
    if jspath::resolve(&got_text) != jspath::resolve(data_root) {
        let read_back = if js::truthy(got) {
            format!("\"{}\"", js::string(got))
        } else {
            "nothing".to_string()
        };
        return refused(format!(
            "SpawnLoft could not remember that location.\n\nIt saved to {} but read back {read_back}. Check that file is writable, then try again.",
            settings::settings_file_text()
        ));
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_save_without_usable_folders_is_refused_before_anything_is_written() {
        for body in [
            json!({}),
            json!({ "dataRoot": "relative/path" }),
            json!({ "dataRoot": 5 }),
            json!(null),
            json!("x"),
        ] {
            assert_eq!(
                save_setup(&body),
                json!({ "ok": false, "error": "Choose a folder for SpawnLoft's files." }),
                "{body}"
            );
        }
        let root = if cfg!(windows) {
            "C:\\sl-test-root"
        } else {
            "/sl-test-root"
        };
        for servers in [json!(null), json!("relative"), json!(""), json!(7)] {
            let body = json!({ "dataRoot": root, "separate": true, "instancesDir": servers });
            assert_eq!(
                save_setup(&body),
                json!({ "ok": false, "error": "Choose a folder for the servers." }),
                "{body}"
            );
        }
    }
}
