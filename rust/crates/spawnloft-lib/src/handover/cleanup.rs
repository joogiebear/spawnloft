//! First-launch cleanup of Electron's leftovers on Windows (installer design section 7, Q-E).
//!
//! `<config>` (`%APPDATA%\spawnloft`) is the same NTFS folder as Electron's userData, so 1.x's
//! Chromium profile sits beside the core's `settings.json`. Once, after the handover, the shell
//! deletes the profile entries on this allowlist and electron-updater's cache. Nothing else, and
//! never the JSON files 2.0 keeps reading in place.

use std::path::{Path, PathBuf};

use serde_json::json;

/// Folders of Chromium's profile, deleted with their contents.
pub const DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "blob_storage",
    "Crashpad",
    "Network",
    "Session Storage",
    "Local Storage",
    "IndexedDB",
    "Service Worker",
    "Shared Dictionary",
    "databases",
    "Dictionaries",
    "Trust Tokens",
    "SharedStorage",
    "WebStorage",
    "logs",
];

/// Files of Chromium's profile.
pub const FILES: &[&str] = &[
    "Preferences",
    "Local State",
    "Cookies",
    "Cookies-journal",
    "TransportSecurity",
    "DIPS",
    "DIPS-journal",
    "LOCK",
    "LOG",
    "LOG.old",
];

/// The marker that says the cleanup ran, in `<config>`.
pub const MARKER: &str = "electron-cleanup.json";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub removed: Vec<String>,
    /// Entries that exist but could not be removed (held by a running 1.x panel, say).
    pub failed: Vec<String>,
    pub skipped: bool,
}

/// Runs the cleanup once: with the marker present it does nothing. `updater_cache` is
/// `%LOCALAPPDATA%\spawnloft-desktop-updater`. The marker is written only when every entry is
/// gone, so a held file is tried again at the next launch.
pub fn run(config: &Path, updater_cache: &Path, now_ms: i64) -> Report {
    let marker = config.join(MARKER);
    if marker.exists() {
        return Report {
            skipped: true,
            ..Report::default()
        };
    }
    let mut report = Report::default();
    let mut targets: Vec<(PathBuf, bool)> = Vec::new();
    for d in DIRS {
        targets.push((config.join(d), true));
    }
    for f in FILES {
        targets.push((config.join(f), false));
    }
    targets.push((updater_cache.to_path_buf(), true));
    for (path, dir) in targets {
        // symlink_metadata: a junction or link is removed itself, never followed
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let res = if dir && meta.is_dir() && !meta.file_type().is_symlink() {
            std::fs::remove_dir_all(&path)
        } else if !dir && !meta.is_file() {
            // an allowlisted file name that is a folder here is not Chromium's: leave it
            continue;
        } else if meta.is_dir() {
            std::fs::remove_dir(&path)
        } else {
            std::fs::remove_file(&path)
        };
        let name = path.display().to_string();
        match res {
            Ok(()) => report.removed.push(name),
            Err(_) => report.failed.push(name),
        }
    }
    if report.failed.is_empty() {
        let _ = std::fs::create_dir_all(config);
        let _ = crate::fsx::write_json(
            &marker,
            &json!({ "format": 1, "at": now_ms as u64, "removed": report.removed.len() }),
        );
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-cleanup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn removes_the_allowlist_and_keeps_the_rest() {
        let root = tmp("allow");
        let config = root.join("spawnloft");
        let cache = root.join("spawnloft-desktop-updater");
        std::fs::create_dir_all(config.join("Cache").join("Cache_Data")).unwrap();
        std::fs::write(config.join("Cache").join("Cache_Data").join("f_0001"), "x").unwrap();
        std::fs::create_dir_all(config.join("Local Storage").join("leveldb")).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("installer.exe"), "x").unwrap();
        for keep in [
            "settings.json",
            "window-state.json",
            "launcher-window-state.json",
            "ui-zoom.json",
            "update-channel.json",
        ] {
            std::fs::write(config.join(keep), "{}").unwrap();
        }
        std::fs::write(config.join("Preferences"), "{}").unwrap();
        std::fs::write(config.join("Local State"), "{}").unwrap();
        std::fs::create_dir_all(config.join("servers-notes")).unwrap();

        let r = run(&config, &cache, 1);
        assert!(r.failed.is_empty(), "{r:?}");
        assert_eq!(r.removed.len(), 5);
        assert!(!config.join("Cache").exists());
        assert!(!config.join("Local Storage").exists());
        assert!(!config.join("Preferences").exists());
        assert!(!cache.exists());
        for keep in [
            "settings.json",
            "window-state.json",
            "launcher-window-state.json",
            "ui-zoom.json",
            "update-channel.json",
            "servers-notes",
        ] {
            assert!(config.join(keep).exists(), "{keep}");
        }
        assert!(config.join(MARKER).exists());
        // once only
        std::fs::create_dir_all(config.join("GPUCache")).unwrap();
        assert!(run(&config, &cache, 2).skipped);
        assert!(config.join("GPUCache").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_name_that_is_a_folder_is_left() {
        let root = tmp("shape");
        std::fs::create_dir_all(root.join("Preferences")).unwrap();
        let r = run(&root, &root.join("none"), 1);
        assert!(r.removed.is_empty());
        assert!(root.join("Preferences").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
