//! `relocate.mjs`: task shims and server launchers rewritten when the install moved.
//!
//! Scheduled-task shims and the per-server launchers embed the installation's absolute path and
//! are only read by the OS scheduler or a double-click, so nothing notices when that path goes
//! stale. `run/runtime.json` records what they were written for; if that differs (or there is no
//! record) every shim and launcher is rewritten. `format` is the version of the text those files
//! hold: bump it in any release that changes what a shim or launcher runs.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::schedule::Sched;
use crate::settings::Layout;
use crate::{create, entry, jspath, registry};

/// `RUNTIME_FORMAT`. 2: 2.0's files run spawnloft-core, the install's one entry point.
pub const RUNTIME_FORMAT: u32 = 2;

/// `{ format, exe, root }`: what the shims and launchers run, and the code folder, which is this
/// binary's folder now that no Node core ships. `root` is still written for a 1.x build after a
/// return, which compares it, but no longer compared here (plan section 3.4): an install that
/// ran the Node core wrote `<resources>/core`, and its shims are already right.
pub fn runtime_signature() -> Map<String, Value> {
    let exe = entry::cli_command(std::env::var(entry::ENTRY_ENV).ok().as_deref()).exe;
    let root = jspath::dirname(&exe);
    let mut m = Map::new();
    m.insert("format".into(), json!(RUNTIME_FORMAT));
    m.insert("exe".into(), Value::String(exe));
    m.insert("root".into(), Value::String(root));
    m
}

/// `markerFile()`: `<run>/runtime.json`.
pub fn marker_file(layout: &Layout) -> PathBuf {
    PathBuf::from(jspath::join(&[&layout.run_dir, "runtime.json"]))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Repaired {
    pub moved: bool,
    pub shims: usize,
    pub launchers: usize,
}

/// `repairAfterMove({ force })`. The record's other fields are kept for whoever wrote them; only
/// `format` and `exe` are compared.
pub fn repair_after_move(
    layout: &Layout,
    sched: &Sched,
    marker: &Path,
    signature: &Map<String, Value>,
    force: bool,
) -> Result<Repaired, Failure> {
    let recorded: Option<Value> = std::fs::read_to_string(marker)
        .ok()
        .and_then(|t| crate::jsjson::parse(&t).ok());
    let same = recorded.as_ref().is_some_and(|r| {
        ["format", "exe"]
            .iter()
            .all(|k| r.get(*k).is_some() && r.get(*k) == signature.get(*k))
    });
    if same && !force {
        return Ok(Repaired {
            moved: false,
            shims: 0,
            launchers: 0,
        });
    }

    let shims = sched.rewrite_shims()?;
    let mut launchers = 0;
    for inst in registry::list_instances(Path::new(&layout.registry_file))? {
        // a server whose folder is gone gets no launchers
        if create::write_launchers(&inst.name, inst.get("dir")).is_ok() {
            launchers += 1;
        }
    }

    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Failure::io(&e, "mkdir", Some(parent)))?;
    }
    let mut keep = match recorded {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    for (k, v) in signature {
        keep.insert(k.clone(), v.clone());
    }
    let text = crate::jsjson::stringify_pretty(&Value::Object(keep)) + "\n";
    std::fs::write(marker, text).map_err(|e| Failure::io(&e, "open", Some(marker)))?;
    Ok(Repaired {
        moved: true,
        shims,
        launchers,
    })
}
