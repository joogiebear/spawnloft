//! What the updater keeps in the config folder (INSTALLER-UPDATER-DESIGN.md 5.5 to 5.6):
//!
//! | File | Holds |
//! | --- | --- |
//! | `update.log` | one line per check, download and install; rotated to `update.1.log` at 1 MiB |
//! | `update-state.json` | last check, the newest accepted `generatedAt` (the replay floor), the pending offer |
//! | `update-hold.json` | `{ "below": "2.1.0" }` after a rollback |
//! | `update-channel.json` | `{ "beta": true }` (1.x's file, same rule) |
//! | `update-request.json` | what the panel asked the window to do (install, rollback, check) |
//! | `updates/<version>/<file>` | verified downloads, the last two versions |
//!
//! The data root's `data-format.json` is read here too. Everything is written atomically
//! through `fsx::write_json`, and every read tolerates a missing or broken file.

use std::path::{Path, PathBuf};

use semver::Version;
use serde_json::{Map, Value, json};

use super::Pinned;

#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
}

/// `update-state.json`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct State {
    pub last_check_at: Option<String>,
    pub last_result: Option<String>,
    /// `generatedAt` of the newest envelope accepted so far; the replay floor.
    pub last_accepted_generated_at: Option<String>,
    /// The verified offer the last check produced, if any.
    pub pending: Option<Pinned>,
    /// Whether the pending offer's artifact is in the cache, verified.
    pub downloaded: bool,
    /// The last envelope seen had passed its `expiresAt`.
    pub stale_feed: bool,
}

/// `update-request.json`: the panel's ask to the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// `install`, `rollback` or `check`.
    pub action: String,
    pub version: Option<String>,
    pub at: String,
}

/// What `update-channel.json` and the build say about the channel (1.x `describe`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelChoice {
    pub beta: bool,
    pub chosen: bool,
    pub on_beta_build: bool,
}

const LOG_ROTATE_BYTES: u64 = 1024 * 1024;

fn read_json(file: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn str_field(m: &Map<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(|v| v.as_str()).map(str::to_string)
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Store {
        Store { dir: dir.into() }
    }

    /// The per-user config folder (`paths::config_dir`).
    pub fn default_location() -> Store {
        Store::new(crate::paths::config_dir())
    }

    pub fn log_file(&self) -> PathBuf {
        self.dir.join("update.log")
    }
    pub fn state_file(&self) -> PathBuf {
        self.dir.join("update-state.json")
    }
    pub fn hold_file(&self) -> PathBuf {
        self.dir.join("update-hold.json")
    }
    pub fn channel_file(&self) -> PathBuf {
        self.dir.join("update-channel.json")
    }
    pub fn request_file(&self) -> PathBuf {
        self.dir.join("update-request.json")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.dir.join("updates")
    }

    fn write(&self, file: &Path, value: &Value) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        crate::fsx::write_json(file, value)
    }

    // ---- update.log ---------------------------------------------------------------------------

    /// Appends `<time> <event> key=value ...`; a value with spaces or quotes is a JSON string.
    pub fn log(&self, event: &str, fields: &[(&str, &str)]) {
        let mut line = format!("{} {event}", crate::time::iso_now());
        for (k, v) in fields {
            let plain = !v.is_empty()
                && v.chars()
                    .all(|c| !c.is_whitespace() && c != '"' && c != '\\' && !c.is_control());
            if plain {
                line.push_str(&format!(" {k}={v}"));
            } else {
                line.push_str(&format!(" {k}={}", crate::json::string(v)));
            }
        }
        line.push('\n');
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let file = self.log_file();
        if let Ok(meta) = std::fs::metadata(&file)
            && meta.len() > LOG_ROTATE_BYTES
        {
            let _ = crate::fsx::rename_over(&file, &self.dir.join("update.1.log"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }

    /// The last `n` lines of the log.
    pub fn log_tail(&self, n: usize) -> Vec<String> {
        let text = std::fs::read_to_string(self.log_file()).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(n)..]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    // ---- update-state.json --------------------------------------------------------------------

    pub fn state(&self) -> State {
        let Some(m) = read_json(&self.state_file()) else {
            return State::default();
        };
        State {
            last_check_at: str_field(&m, "lastCheckAt"),
            last_result: str_field(&m, "lastResult"),
            last_accepted_generated_at: str_field(&m, "lastAcceptedGeneratedAt"),
            pending: m.get("pending").and_then(Pinned::from_json),
            downloaded: m.get("downloaded").and_then(Value::as_bool).unwrap_or(false),
            stale_feed: m.get("staleFeed").and_then(Value::as_bool).unwrap_or(false),
        }
    }

    pub fn save_state(&self, state: &State) -> std::io::Result<()> {
        let value = json!({
            "lastCheckAt": state.last_check_at,
            "lastResult": state.last_result,
            "lastAcceptedGeneratedAt": state.last_accepted_generated_at,
            "pending": state.pending.as_ref().map(Pinned::to_json),
            "downloaded": state.downloaded,
            "staleFeed": state.stale_feed,
        });
        self.write(&self.state_file(), &value)
    }

    /// Seconds since the epoch of the replay floor saved so far.
    pub fn last_accepted_secs(&self) -> Option<i64> {
        self.state()
            .last_accepted_generated_at
            .and_then(|s| crate::time::parse_iso_utc(&s))
    }

    // ---- update-hold.json ---------------------------------------------------------------------

    pub fn hold(&self) -> Option<Version> {
        read_json(&self.hold_file())
            .and_then(|m| str_field(&m, "below"))
            .and_then(|s| Version::parse(&s).ok())
    }

    pub fn set_hold(&self, below: &Version) -> std::io::Result<()> {
        self.write(&self.hold_file(), &json!({ "below": below.to_string() }))
    }

    pub fn clear_hold(&self) -> std::io::Result<()> {
        match std::fs::remove_file(self.hold_file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    // ---- update-channel.json ------------------------------------------------------------------

    pub fn channel(&self, installed: &Version) -> ChannelChoice {
        let on_beta_build = !installed.pre.is_empty();
        let chosen = read_json(&self.channel_file()).and_then(|m| m.get("beta").and_then(Value::as_bool));
        ChannelChoice {
            beta: chosen.unwrap_or(on_beta_build),
            chosen: chosen.is_some(),
            on_beta_build,
        }
    }

    pub fn set_channel(&self, beta: bool) -> std::io::Result<()> {
        self.write(&self.channel_file(), &json!({ "beta": beta }))
    }

    // ---- update-request.json ------------------------------------------------------------------

    pub fn write_request(&self, req: &Request) -> std::io::Result<()> {
        self.write(
            &self.request_file(),
            &json!({ "action": req.action, "version": req.version, "at": req.at }),
        )
    }

    /// Reads and removes the request, if one is waiting.
    pub fn take_request(&self) -> Option<Request> {
        let file = self.request_file();
        let m = read_json(&file)?;
        let _ = std::fs::remove_file(&file);
        Some(Request {
            action: str_field(&m, "action")?,
            version: str_field(&m, "version"),
            at: str_field(&m, "at").unwrap_or_default(),
        })
    }

    // ---- updates/<version>/<file> -------------------------------------------------------------

    pub fn cache_file(&self, version: &str, file: &str) -> PathBuf {
        self.cache_dir().join(version).join(file)
    }

    /// Writes a verified download and keeps only the `keep` newest versions in the cache.
    pub fn store_artifact(
        &self,
        version: &str,
        file: &str,
        bytes: &[u8],
        keep: usize,
    ) -> std::io::Result<PathBuf> {
        let dest = self.cache_file(version, file);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension("part");
        std::fs::write(&tmp, bytes)?;
        crate::fsx::rename_over(&tmp, &dest)?;
        self.prune_cache(keep);
        Ok(dest)
    }

    pub fn remove_cached(&self, version: &str) {
        let _ = std::fs::remove_dir_all(self.cache_dir().join(version));
    }

    /// Keeps the `keep` highest versions; folders that are not versions go too.
    pub fn prune_cache(&self, keep: usize) {
        let Ok(entries) = std::fs::read_dir(self.cache_dir()) else {
            return;
        };
        let mut versions: Vec<(Version, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match Version::parse(&entry.file_name().to_string_lossy()) {
                Ok(v) => versions.push((v, path)),
                Err(_) => {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in versions.into_iter().skip(keep) {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    // ---- data-format.json (data root) ----------------------------------------------------------

    /// The data folder's format, or this build's when the file is missing or unreadable.
    pub fn data_format(data_root: &Path) -> Result<u32, String> {
        let file = data_root.join("data-format.json");
        if !file.exists() {
            return Ok(super::policy::DATA_FORMAT);
        }
        read_json(&file)
            .and_then(|m| m.get("format").and_then(Value::as_u64))
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n >= 1)
            .ok_or_else(|| {
                format!(
                    "{} is unreadable; no update is offered until it is fixed",
                    file.display()
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sl-update-store-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn hold_channel_and_request_round_trip() {
        let s = Store::new(temp("files"));
        assert_eq!(s.hold(), None);
        s.set_hold(&Version::parse("2.1.0").unwrap()).unwrap();
        assert_eq!(s.hold().unwrap().to_string(), "2.1.0");
        s.clear_hold().unwrap();
        s.clear_hold().unwrap();
        assert_eq!(s.hold(), None);

        let beta_build = Version::parse("2.0.0-beta.1").unwrap();
        let stable_build = Version::parse("2.0.0").unwrap();
        assert_eq!(
            s.channel(&beta_build),
            ChannelChoice {
                beta: true,
                chosen: false,
                on_beta_build: true
            }
        );
        assert_eq!(
            s.channel(&stable_build),
            ChannelChoice {
                beta: false,
                chosen: false,
                on_beta_build: false
            }
        );
        s.set_channel(true).unwrap();
        assert_eq!(
            s.channel(&stable_build),
            ChannelChoice {
                beta: true,
                chosen: true,
                on_beta_build: false
            }
        );

        assert_eq!(s.take_request(), None);
        let req = Request {
            action: "install".into(),
            version: Some("2.0.1".into()),
            at: "t".into(),
        };
        s.write_request(&req).unwrap();
        assert_eq!(s.take_request(), Some(req));
        assert_eq!(s.take_request(), None, "taken once");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn log_lines_quote_what_needs_it() {
        let s = Store::new(temp("log"));
        s.log(
            "check",
            &[
                ("source", "github"),
                ("why", "the feed said \"no\""),
                ("empty", ""),
            ],
        );
        let lines = s.log_tail(5);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].ends_with(" check source=github why=\"the feed said \\\"no\\\"\" empty=\"\""),
            "{}",
            lines[0]
        );
        assert!(lines[0].starts_with("20"));
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn cache_keeps_the_newest_two() {
        let s = Store::new(temp("cache"));
        for v in ["2.0.0", "2.0.2", "2.0.1"] {
            s.store_artifact(v, "SpawnLoft-Setup.exe", b"x", 2).unwrap();
        }
        std::fs::create_dir_all(s.cache_dir().join("junk")).unwrap();
        s.prune_cache(2);
        let mut left: Vec<String> = std::fs::read_dir(s.cache_dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["2.0.1", "2.0.2"]);
        assert!(s.cache_file("2.0.2", "SpawnLoft-Setup.exe").is_file());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn data_format_defaults_to_the_build() {
        let root = temp("df");
        assert_eq!(Store::data_format(&root), Ok(super::super::policy::DATA_FORMAT));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("data-format.json"),
            br#"{"writtenBy":"2.3.0","format":2}"#,
        )
        .unwrap();
        assert_eq!(Store::data_format(&root), Ok(2));
        std::fs::write(root.join("data-format.json"), b"garbage").unwrap();
        assert!(Store::data_format(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
