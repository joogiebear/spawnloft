//! Where a daemon's files are, as `paths.mjs` and `settings.mjs` lay them out.
//!
//! The Node supervisor passes the data root it resolved (`--data-root`), so the two never disagree.
//! [`resolve_data_root`] is the fallback for a daemon started by hand: the environment, then
//! settings.json, then the per-user default. The legacy "code root holds instances.json" case is
//! the Node core's alone, since this binary does not know where the code is.

use std::path::{Path, PathBuf};

/// The per-user data folder and everything a daemon touches inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    pub data_root: PathBuf,
}

impl Roots {
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Roots {
            data_root: data_root.into(),
        }
    }
    pub fn registry_file(&self) -> PathBuf {
        self.data_root.join("instances.json")
    }
    pub fn run_root(&self) -> PathBuf {
        self.data_root.join("run")
    }
    pub fn run_dir(&self, name: &str) -> PathBuf {
        self.run_root().join(name)
    }
    pub fn state_file(&self, name: &str) -> PathBuf {
        self.run_dir(name).join("state.json")
    }
    pub fn console_log(&self, name: &str) -> PathBuf {
        self.run_dir(name).join("console.log")
    }
    pub fn daemon_log(&self, name: &str) -> PathBuf {
        self.run_dir(name).join("daemon.log")
    }
    pub fn metrics_file(&self, name: &str) -> PathBuf {
        self.run_dir(name).join("metrics.log")
    }
    pub fn activity_file(&self) -> PathBuf {
        self.data_root.join("activity.jsonl")
    }
    pub fn activity_previous(&self) -> PathBuf {
        self.data_root.join("activity.1.jsonl")
    }
}

/// An environment value under its current name or the pre-rename one (`env.mjs`'s `envVar`).
pub fn env_var(name: &str) -> Option<String> {
    for prefix in ["SPAWNLOFT_", "MCCTL_"] {
        if let Ok(v) = std::env::var(format!("{prefix}{name}"))
            && !v.is_empty()
        {
            return Some(v);
        }
    }
    None
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn config_base() -> PathBuf {
    if cfg!(windows) {
        env_dir("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else {
        env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"))
    }
}

fn data_base() -> PathBuf {
    if cfg!(windows) {
        env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"))
    } else {
        env_dir("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share"))
    }
}

/// The per-user config folder, `%APPDATA%\spawnloft` or `~/.config/spawnloft`. On Windows it
/// is the same NTFS folder as Electron's `%APPDATA%\SpawnLoft` (installer design section 7).
pub fn config_dir() -> PathBuf {
    config_base().join("spawnloft")
}

/// The per-user local data base, `%LOCALAPPDATA%` or `~/.local/share`.
pub fn local_base() -> PathBuf {
    data_base()
}

/// `spawnloft/settings.json`, or the older `mcctl/settings.json` when only that one exists.
pub fn settings_file() -> PathBuf {
    let base = config_base();
    let current = base.join("spawnloft").join("settings.json");
    let legacy = base.join("mcctl").join("settings.json");
    if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    }
}

/// settings.json as an object; empty when it is missing or unreadable (the Node core warns).
pub fn load_settings() -> serde_json::Map<String, serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(settings_file()) else {
        return Default::default();
    };
    match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => Default::default(),
    }
}

fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The data root by the Node order, minus the legacy code-root case (see the module comment).
pub fn resolve_data_root() -> PathBuf {
    if let Some(forced) = env_var("DATA_ROOT") {
        return absolute(Path::new(&forced));
    }
    if let Some(serde_json::Value::String(s)) = load_settings().get("dataRoot")
        && !s.is_empty()
    {
        return absolute(Path::new(s));
    }
    let base = data_base();
    let current = base.join("spawnloft");
    let legacy = base.join("mcctl");
    if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    }
}

/// `sun_path` holds 108 bytes on Linux and 104 on macOS, both including the NUL.
pub const SOCKET_PATH_MAX: usize = if cfg!(target_os = "macos") { 103 } else { 107 };

/// The control channel's address: a named pipe on Windows, a Unix socket elsewhere. The pipe name
/// is shared with the Node daemon, so the Node control client reaches either one unchanged.
pub fn control_path(roots: &Roots, name: &str) -> Result<String, String> {
    if cfg!(windows) {
        return Ok(format!(r"\\.\pipe\mcctl-{name}"));
    }
    let natural = roots.run_dir(name).join("control.sock");
    let text = natural.to_string_lossy().into_owned();
    if text.len() <= SOCKET_PATH_MAX {
        return Ok(text);
    }
    #[cfg(unix)]
    {
        short_socket_path(&text, Path::new("/tmp"), crate::platform::uid())
    }
    #[cfg(not(unix))]
    {
        Ok(text)
    }
}

/// The stand-in for a socket path that is too long: `/tmp/spawnloft-<uid>/<hash>.sock`, in a
/// folder that must be this user's alone (the same rule and the same name as `paths.mjs`).
#[cfg(unix)]
pub fn short_socket_path(natural: &str, base: &Path, uid: u32) -> Result<String, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let dir = base.join(format!("spawnloft-{uid}"));
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder
        .create(&dir)
        .map_err(|e| format!("Cannot create the socket directory {}: {e}", dir.display()))?;
    let meta = std::fs::symlink_metadata(&dir)
        .map_err(|e| format!("Cannot use the socket directory {}: {e}", dir.display()))?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != uid {
        return Err(format!(
            "Cannot use the socket directory {}: it is not a private folder of this user",
            dir.display()
        ));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Cannot use the socket directory {}: {e}", dir.display()))?;
    let hash = crate::sha256::hex(natural.as_bytes());
    Ok(dir
        .join(format!("{}.sock", &hash[..20]))
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_paths_mjs() {
        let r = Roots::new("/data");
        assert_eq!(r.state_file("a"), Path::new("/data/run/a/state.json"));
        assert_eq!(r.console_log("a"), Path::new("/data/run/a/console.log"));
        assert_eq!(r.metrics_file("a"), Path::new("/data/run/a/metrics.log"));
        assert_eq!(r.activity_file(), Path::new("/data/activity.jsonl"));
    }

    #[cfg(unix)]
    #[test]
    fn short_control_path_for_a_deep_root() {
        let base = std::env::temp_dir().join(format!("sl-sock-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let natural = format!("/{}/run/x/control.sock", "d".repeat(120));
        let got = short_socket_path(&natural, &base, crate::platform::uid()).unwrap();
        // the same name paths.mjs computes for this path
        let want = format!("{}.sock", &crate::sha256::hex(natural.as_bytes())[..20]);
        assert!(got.ends_with(&want), "{got}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn pipe_name_is_shared_with_the_node_daemon() {
        assert_eq!(
            control_path(&Roots::new("C:\\d"), "srv").unwrap(),
            r"\\.\pipe\mcctl-srv"
        );
    }
}
