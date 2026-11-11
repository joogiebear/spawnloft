//! The panel's handover routes, answered by `spawnloft-core ui` itself (design section 8, items 3
//! and 4): what the banners at the top of the panel read.
//!
//! | Route | Does |
//! | --- | --- |
//! | `GET /api/handover` | `{ record, legacy }`: the unshown handover record (None after a week or once dismissed) and the servers a 1.x daemon still runs |
//! | `POST /api/handover/dismiss` | marks the record shown |
//!
//! Starting a server again and restarting a 1.x server go through the panel's ordinary
//! `/api/instances/<name>/start|stop` routes; nothing here starts or stops anything.

use std::path::Path;

use serde_json::{Value, json};

use super::legacy::read_state_files;
use super::{Files, Record};

/// A record older than this is not shown any more (design 8, item 3).
const SHOW_FOR_MS: i64 = 7 * 24 * 3600 * 1000;

pub fn is_route(route: &str) -> bool {
    route == "/api/handover" || route.starts_with("/api/handover/")
}

pub fn handle(method: &str, path: &str) -> (u16, Value) {
    let route = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    let root = crate::paths::resolve_data_root();
    match (method, route) {
        ("GET", "/api/handover") => (200, status(&root, crate::time::now_ms())),
        ("POST", "/api/handover/dismiss") => match dismiss(&root) {
            Ok(()) => (200, json!({ "ok": true })),
            Err(e) => (500, json!({ "error": e })),
        },
        ("GET" | "POST", _) => (404, json!({ "error": format!("no handover route {route}") })),
        _ => (405, json!({ "error": "method not allowed" })),
    }
}

/// The banner data for a data root at `now_ms`.
pub fn status(root: &Path, now_ms: i64) -> Value {
    json!({ "record": shown_record(root, now_ms), "legacy": legacy_servers(root) })
}

fn shown_record(root: &Path, now_ms: i64) -> Value {
    let Some(rec) = Record::read(&Files::new(root).record()) else {
        return Value::Null;
    };
    if rec.shown || now_ms.saturating_sub(rec.started_ms) > SHOW_FOR_MS {
        return Value::Null;
    }
    rec.to_json()
}

/// Servers whose recorded daemon is a 1.x program (`SpawnLoft`, `spawnloft-desktop`) and still
/// serves them. Nothing happens to them on its own: players may be on them.
fn legacy_servers(root: &Path) -> Vec<Value> {
    let Ok(list) = read_state_files(root) else {
        return Vec::new();
    };
    list.iter()
        .filter(|l| l.stoppable())
        .filter(|l| {
            let exe = std::fs::read_to_string(root.join("run").join(&l.name).join("state.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
                .and_then(|s| s.get("daemonExe").and_then(Value::as_str).map(str::to_string));
            exe.as_deref().is_some_and(is_legacy_exe)
        })
        .map(|l| json!({ "name": l.name, "kind": l.kind.as_str(), "status": l.status }))
        .collect()
}

/// `daemonExe` of a 1.x daemon: the Electron app, running the core as Node.
fn is_legacy_exe(path: &str) -> bool {
    let file = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    matches!(stem, "spawnloft" | "spawnloft-desktop")
}

fn dismiss(root: &Path) -> Result<(), String> {
    let file = Files::new(root).record();
    let Some(mut rec) = Record::read(&file) else {
        return Ok(());
    };
    rec.shown = true;
    rec.write(&file)
        .map_err(|e| format!("could not save the record: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("spawnloft-hoapi-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("run")).unwrap();
        d
    }

    #[test]
    fn routes_and_exe_names() {
        assert!(is_route("/api/handover") && is_route("/api/handover/dismiss"));
        assert!(!is_route("/api/handovers"));
        assert!(is_legacy_exe(r"C:\Program Files\SpawnLoft\SpawnLoft.exe"));
        assert!(is_legacy_exe(
            "/Applications/SpawnLoft.app/Contents/MacOS/spawnloft-desktop"
        ));
        assert!(!is_legacy_exe(r"C:\x\resources\bin\spawnloft-core.exe"));
    }

    #[test]
    fn record_shown_once_and_for_a_week() {
        let d = tmp("rec");
        assert!(status(&d, 1_000)["record"].is_null());
        let mut rec = Record::new("1.5.0", "2.0.0", "restart", d.to_str().unwrap());
        rec.started_ms = 1_000;
        rec.write(&Files::new(&d).record()).unwrap();
        assert!(status(&d, 2_000)["record"].is_object());
        assert!(status(&d, 1_000 + SHOW_FOR_MS + 1)["record"].is_null());
        dismiss(&d).unwrap();
        assert!(status(&d, 2_000)["record"].is_null());
        assert!(Record::read(&Files::new(&d).record()).unwrap().shown);
        let _ = std::fs::remove_dir_all(&d);
    }
}
