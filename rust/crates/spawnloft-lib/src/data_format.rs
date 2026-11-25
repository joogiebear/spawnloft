//! `data-format.mjs`: `<data root>/data-format.json`, `{ "writtenBy": "2.0.0", "format": 1 }`,
//! names the newest release that wrote the data folder. Someone who went to a newer SpawnLoft and
//! came back is told so, and what to check. A warning, never a refusal: the formats are the same,
//! and refusing would lock people out of their own servers.

use serde_json::{Map, Value};
use std::path::Path;

/// The data format this release reads and writes.
pub const DATA_FORMAT: i64 = 1;

/// `dataFormatFile(root)`.
pub fn data_format_file(data_root: &str) -> String {
    crate::jspath::join(&[data_root, "data-format.json"])
}

/// `readDataFormat`: the marker's fields, or `None` when there is none or it is not a JSON
/// object. Unknown fields are kept.
pub fn read(file: &Path) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    match crate::jsjson::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// This release's version.
pub fn release_version() -> &'static str {
    crate::build::current().version
}

fn major(version: Option<&Value>) -> Option<u64> {
    let text = match version {
        None | Some(Value::Null) => String::new(),
        v => crate::js::string(v),
    };
    let t = text.strip_prefix('v').unwrap_or(&text);
    let n = t.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 || t.as_bytes().get(n) != Some(&b'.') {
        return None;
    }
    // a run of digits too long for u64 is still a number in JavaScript, and larger than ours
    Some(t[..n].parse().unwrap_or(u64::MAX))
}

/// `dataFormatWarning`: one sentence, or `None` when the marker is absent or from this major or
/// an older one, with a format this release knows.
pub fn warning(file: &str, marker: Option<&Map<String, Value>>, version: Option<&str>) -> Option<String> {
    let marker = marker?;
    let written_by = marker.get("writtenBy");
    let theirs = major(written_by);
    let ours = major(version.map(|v| Value::String(v.into())).as_ref());
    let newer_release = matches!((theirs, ours), (Some(t), Some(o)) if t > o);
    let newer_format = marker
        .get("format")
        .and_then(Value::as_f64)
        .is_some_and(|f| f.fract() == 0.0 && f > DATA_FORMAT as f64);
    if !newer_release && !newer_format {
        return None;
    }
    let who = match written_by {
        Some(Value::String(s)) => format!("SpawnLoft {s}"),
        _ => "a newer SpawnLoft".into(),
    };
    Some(format!(
        "this data folder was last used by {who} ({file}). This version can still run it, but \
         servers, tasks or settings made there may not show up or may behave differently here. \
         SpawnLoft points scheduled tasks and launchers back at this version when it starts; if a task \
         still does not run, run \"spawnloft repair\"."
    ))
}

/// `<config>/installed-version.json`: the version that last started against this config folder.
pub fn installed_version_file(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join("installed-version.json")
}

/// What [`mark_version`] did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Marked {
    /// The version `installed-version.json` named before, when it named another one (or there
    /// was none: `Some("")`). `None` when this version was already recorded.
    pub changed_from: Option<String>,
    /// `data-format.json` was written.
    pub wrote_format: bool,
}

/// Design section 8, item 1 (first launch after an install or update): when the installed version
/// differs from `<config>/installed-version.json`, or the data root has no `data-format.json`,
/// write `{ "writtenBy": <version>, "format": DATA_FORMAT }` there, record the version, and note
/// the change in `update.log`. A marker that names a newer major or a newer format is left as
/// it is, so the "this data folder was last used by" warning keeps being said after a rollback.
/// Losing any of these writes is fine: the next start tries again.
pub fn mark_version(config_dir: &Path, data_root: &Path, version: &str) -> Marked {
    let version_file = installed_version_file(config_dir);
    let previous =
        read(&version_file).and_then(|m| m.get("version").and_then(Value::as_str).map(str::to_string));
    let changed = previous.as_deref() != Some(version);
    let format_file = data_root.join("data-format.json");
    let marker = read(&format_file);
    let mut out = Marked::default();
    let newer = warning("", marker.as_ref(), Some(version)).is_some();
    if (changed || marker.is_none()) && !newer && data_root.is_dir() {
        let value = serde_json::json!({ "writtenBy": version, "format": DATA_FORMAT });
        out.wrote_format = crate::fsx::write_json(&format_file, &value).is_ok();
    }
    if changed {
        let value = serde_json::json!({ "version": version, "at": crate::time::iso_now() });
        if crate::fsx::write_json(&version_file, &value).is_ok() {
            let from = previous.clone().unwrap_or_else(|| "none".into());
            crate::update::store::Store::new(config_dir)
                .log("installed", &[("from", &from), ("to", version)]);
        }
        out.changed_from = Some(previous.unwrap_or_default());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn library() -> serde_json::Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/c1-library.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    #[test]
    fn agrees_with_node() {
        for c in library()["dataFormat"].as_array().unwrap() {
            let got = warning(
                "/d/data-format.json",
                c["marker"].as_object(),
                c["version"].as_str(),
            );
            assert_eq!(json!(got), c["warning"], "{c}");
        }
    }

    fn marker(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn warns_only_for_a_newer_folder() {
        let m = marker(json!({ "writtenBy": "3.1.0", "format": 1 }));
        let w = warning("/d/data-format.json", Some(&m), Some("2.0.0")).unwrap();
        assert!(w.starts_with(
            "this data folder was last used by SpawnLoft 3.1.0 (/d/data-format.json). This version"
        ));
        assert!(w.ends_with("run \"spawnloft repair\"."));
        assert!(!w.contains("  "));
        assert_eq!(
            warning(
                "f",
                Some(&marker(json!({ "writtenBy": "2.4.0", "format": 1 }))),
                Some("2.0.0")
            ),
            None
        );
        assert_eq!(warning("f", None, Some("2.0.0")), None);
        let format_only = warning("f", Some(&marker(json!({ "format": 2 }))), Some("2.0.0")).unwrap();
        assert!(format_only.contains("by a newer SpawnLoft (f)"));
        assert_eq!(
            warning("f", Some(&marker(json!({ "format": 1.5 }))), Some("2.0.0")),
            None
        );
        assert!(warning("f", Some(&marker(json!({ "writtenBy": "v3.0" }))), Some("2.0.0")).is_some());
        assert_eq!(
            warning("f", Some(&marker(json!({ "writtenBy": "3" }))), Some("2.0.0")),
            None
        );
        assert_eq!(
            warning("f", Some(&marker(json!({ "writtenBy": "3.0" }))), None),
            None
        );
    }

    #[test]
    fn reads_only_an_object() {
        let dir = std::env::temp_dir().join(format!("sl-df-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("data-format.json");
        std::fs::write(&f, "\u{feff}{\"writtenBy\":\"2.0.0\",\"format\":1,\"x\":true}").unwrap();
        assert_eq!(read(&f).unwrap().get("x"), Some(&json!(true)));
        std::fs::write(&f, "[1]").unwrap();
        assert_eq!(read(&f), None);
        std::fs::write(&f, "{").unwrap();
        assert_eq!(read(&f), None);
        assert_eq!(read(&dir.join("none")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn marks_the_version_and_the_data_folder_once() {
        let base = std::env::temp_dir().join(format!("sl-mark-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (config, data) = (base.join("config"), base.join("data"));
        std::fs::create_dir_all(&data).unwrap();
        let m = mark_version(&config, &data, "2.0.0");
        assert_eq!(
            m,
            Marked {
                changed_from: Some(String::new()),
                wrote_format: true
            }
        );
        assert_eq!(
            read(&data.join("data-format.json")).map(Value::Object),
            Some(json!({ "writtenBy": "2.0.0", "format": 1 }))
        );
        assert_eq!(
            read(&installed_version_file(&config)).unwrap()["version"],
            json!("2.0.0")
        );
        let log = std::fs::read_to_string(config.join("update.log")).unwrap();
        assert!(log.contains(" installed from=none to=2.0.0"), "{log}");
        // same version again: nothing to do
        assert_eq!(mark_version(&config, &data, "2.0.0"), Marked::default());
        // the marker went missing (a new data root): written again, version unchanged
        std::fs::remove_file(data.join("data-format.json")).unwrap();
        assert!(mark_version(&config, &data, "2.0.0").wrote_format);
        // an update
        let m = mark_version(&config, &data, "2.1.0");
        assert_eq!(m.changed_from.as_deref(), Some("2.0.0"));
        assert!(m.wrote_format);
        // back to 2.x from a 3.x that wrote the folder: the marker keeps saying so
        std::fs::write(
            data.join("data-format.json"),
            r#"{"writtenBy":"3.0.0","format":1}"#,
        )
        .unwrap();
        let m = mark_version(&config, &data, "2.0.0");
        assert!(!m.wrote_format && m.changed_from.is_some());
        assert_eq!(
            read(&data.join("data-format.json")).unwrap()["writtenBy"],
            json!("3.0.0")
        );
        // no data folder (an unplugged drive): nothing is made there
        let gone = base.join("gone");
        assert!(!mark_version(&config, &gone, "2.2.0").wrote_format);
        assert!(!gone.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
