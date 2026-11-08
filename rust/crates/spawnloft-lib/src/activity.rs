//! The daemon's side of the activity history (`activity.mjs` `record`): one JSON line per event in
//! the shared `activity.jsonl`, rotated to `activity.1.jsonl` past 2 MiB. The daemon has no person
//! behind it, so every entry is by `{ kind: "spawnloft" }`. Never fails: logging is best-effort.

use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom, Write};

use crate::paths::Roots;

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The entry as written, for tests.
pub fn entry(server: &str, action: &str, detail: Option<&str>, ok: bool, at: &str) -> Value {
    let mut e = Map::new();
    e.insert("at".into(), json!(at));
    e.insert("server".into(), json!(server));
    e.insert("action".into(), json!(action));
    e.insert("by".into(), json!({ "kind": "spawnloft" }));
    if let Some(d) = detail.filter(|d| !d.is_empty()) {
        let flat: String = d
            .split(['\r', '\n'])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        e.insert("detail".into(), json!(flat.chars().take(500).collect::<String>()));
    }
    if !ok {
        e.insert("ok".into(), json!(false));
    }
    Value::Object(e)
}

pub fn record(roots: &Roots, server: &str, action: &str, detail: Option<&str>, ok: bool) {
    let line = entry(server, action, detail, ok, &crate::time::iso_now()).to_string();
    let _ = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&roots.data_root)?;
        let file = roots.activity_file();
        if std::fs::metadata(&file)
            .map(|m| m.len() >= MAX_BYTES)
            .unwrap_or(false)
        {
            // another process may have rotated it first
            let _ = std::fs::rename(&file, roots.activity_previous());
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&file)?;
        // a writer that died mid-line left no newline; without one this line would be glued on
        let len = f.metadata()?.len();
        let mut prefix = "";
        if len > 0 {
            let mut last = [0u8; 1];
            f.seek(SeekFrom::Start(len - 1))?;
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                prefix = "\n";
            }
        }
        f.write_all(format!("{prefix}{line}\n").as_bytes())
    })();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_matches_activity_mjs() {
        let e = entry(
            "srv",
            "crash",
            Some("crashed (exit 3).\nRestarting"),
            false,
            "2026-01-01T00:00:00.000Z",
        );
        assert_eq!(
            e.to_string(),
            r#"{"at":"2026-01-01T00:00:00.000Z","server":"srv","action":"crash","by":{"kind":"spawnloft"},"detail":"crashed (exit 3). Restarting","ok":false}"#
        );
    }

    #[test]
    fn appends_after_a_torn_line() {
        let dir = std::env::temp_dir().join(format!("sl-act-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let roots = Roots::new(&dir);
        std::fs::write(roots.activity_file(), "{\"torn\":").unwrap();
        record(&roots, "srv", "crash", Some("x"), false);
        let text = std::fs::read_to_string(roots.activity_file()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("\"action\":\"crash\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
