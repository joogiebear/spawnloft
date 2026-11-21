//! The client launcher (`client*.mjs`), ported in phase C7 of rust/PLAN-CORE-PORT.md.
//!
//! The files are the Node core's and stay readable by both sides while they live: profiles.json,
//! accounts.json (owner-only), the run folder of each profile (state.json, last-exit.json,
//! played.json, server-list.json, client.log, launch.lock) and the game folders themselves.

pub mod accounts;
pub mod auth;
pub mod harness;
pub mod harness_index;
pub mod http;
pub mod install;
pub mod library;
pub mod loaders;
pub mod log;
pub mod meta;
pub mod paths;
pub mod profiles;
pub mod rules;
pub mod server_list;
pub mod state;
pub mod version;
pub mod versions;

use serde_json::{Map, Value};
use std::path::Path;

use crate::failure::Failure;

/// `readJson(file, null)`: the parsed file, `None` when it is not there; a file that does not
/// parse fails as `JSON.parse` does, and any other read failure as `readFileSync`.
pub fn read_json(file: &str) -> Result<Option<Value>, Failure> {
    let path = Path::new(file);
    match std::fs::read(path) {
        Ok(bytes) => crate::jsjson::parse(&String::from_utf8_lossy(&bytes))
            .map(Some)
            .map_err(Failure::syntax),
        Err(e) if crate::jspath::is_enoent(&e) => Ok(None),
        Err(e) => Err(Failure::read(&e, path)),
    }
}

/// `writeJson(file, data)` of util.mjs, with no mode.
pub fn write_json(file: &str, data: &Value) -> Result<(), Failure> {
    crate::fsx::write_json_node(Path::new(file), data, None, false).map(|_| ())
}

/// `writeJson(file, data, { mode: PRIVATE_FILE_MODE })`: owner-only, a failed protection is no
/// failure.
pub fn write_json_private(file: &str, data: &Value) -> Result<(), Failure> {
    crate::fsx::write_json_node(Path::new(file), data, Some(0o600), false).map(|_| ())
}

/// `writeAtomic(dest, data)` of util.mjs: a temporary file beside it, renamed over it.
pub fn write_atomic(dest: &str, data: &[u8]) -> Result<(), Failure> {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let tmp = format!("{dest}.{}.{hex}.tmp", std::process::id());
    let tmp_path = Path::new(&tmp);
    std::fs::write(tmp_path, data).map_err(|e| Failure::io(&e, "open", Some(tmp_path)))?;
    if let Err(e) = crate::fsx::rename_over(tmp_path, Path::new(dest)) {
        let _ = std::fs::remove_file(tmp_path);
        return Err(crate::fsx::rename_failure(&e, tmp_path, Path::new(dest)));
    }
    Ok(())
}

/// `fs.rmSync(file, { force: true })`: a missing file is no error.
pub fn rm_force(file: &str) -> Result<(), Failure> {
    let path = Path::new(file);
    match std::fs::symlink_metadata(path) {
        Err(e) if crate::jspath::is_enoent(&e) => Ok(()),
        Err(e) => Err(Failure::io(&e, "rm", Some(path))),
        Ok(m) if m.is_dir() => Err(Failure::Internal {
            head: "SystemError [ERR_FS_EISDIR]".into(),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {file}"),
            code: Some("ERR_FS_EISDIR".into()),
        }),
        Ok(_) => std::fs::remove_file(path).map_err(|e| Failure::io(&e, "rm", Some(path))),
    }
}

/// `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })`: Windows
/// lets go of a folder a moment after the game that had it open exits, so EBUSY, EPERM,
/// ENOTEMPTY and EMFILE are tried again, waiting 100 ms more each time.
pub fn rm_tree_retrying(dir: &str) -> Result<(), Failure> {
    let path = Path::new(dir);
    let mut attempt = 0u64;
    loop {
        let result = match std::fs::symlink_metadata(path) {
            Err(e) if crate::jspath::is_enoent(&e) => return Ok(()),
            Err(e) => Err(e),
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
            Ok(_) => std::fs::remove_file(path),
        };
        match result {
            Ok(()) => return Ok(()),
            Err(e) if crate::jspath::is_enoent(&e) => return Ok(()),
            Err(e) => {
                let code = crate::jspath::error_code(&e).0;
                if attempt < 10 && matches!(code, "EBUSY" | "EPERM" | "ENOTEMPTY" | "EMFILE") {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(attempt * 100));
                    continue;
                }
                return Err(Failure::io(&e, "rm", Some(path)));
            }
        }
    }
}

/// `x ?? null`: a missing value and `null` both read as `null`.
pub fn or_null(v: Option<&Value>) -> Value {
    v.cloned().unwrap_or(Value::Null)
}

/// Whether `v` is `null` or `undefined` (what `??` replaces).
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `a === b` for two values read from JSON: objects and arrays are never the same object.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// A property read on any value: an object's field, nothing on anything else.
pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// An object literal with JavaScript's `undefined` left out, as `JSON.stringify` writes it.
pub fn object(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    }
    Value::Object(m)
}

/// `{ ...a }` onto `into`: each key replaces in place or goes at the end (`Object.entries` of a
/// string or an array spread too, as for the registry).
pub fn spread_into(into: &mut Map<String, Value>, v: &Value) {
    for (k, v) in crate::registry::entries_of(v) {
        into.insert(k, v);
    }
}

/// `String(x).toLowerCase()`.
pub fn lower(v: Option<&Value>) -> String {
    crate::js::string(v).to_lowercase()
}
