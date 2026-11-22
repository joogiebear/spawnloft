//! The Node.js the few JavaScript parts left still run on (rust/PLAN-CORE-PORT.md sections 5.4
//! and 5.5). The core itself runs none and 2.0 carries none: the bot host (mineflayer, npm
//! packages `bot setup` installs) and the V8 check of a bot scenario's patterns run on the
//! machine's own Node, and in a `test-hooks` build so do the tests' `.mjs` stand-ins (the fake
//! JVM and engines).
//!
//! Which Node: the `bot.node` setting (`{"bot": {"node": "<path>"}}`) when it names one, else
//! `SPAWNLOFT_NODE`, else the first `node` on PATH (then the places a GUI-started app misses on
//! macOS). The bot host also needs it to be recent enough for mineflayer ([`checked_node`]).

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The oldest Node major mineflayer runs on (its `engines`, and minecraft-protocol's).
pub const MIN_NODE_MAJOR: u32 = 22;

/// The `bot.node` setting, when it is a non-empty string.
fn setting_node() -> Option<PathBuf> {
    let (settings, _) = crate::settings::load();
    settings
        .get("bot")
        .and_then(|b| b.get("node"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The machine's Node (see the module text for the order), or why there is none.
pub fn node() -> Result<PathBuf, String> {
    node_with(
        setting_node(),
        std::env::var_os("SPAWNLOFT_NODE")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
        path_node(),
    )
}

/// [`node`] with its inputs given, for tests.
pub fn node_with(
    setting: Option<PathBuf>,
    env: Option<PathBuf>,
    on_path: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(p) = setting {
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!(
                "the bot.node setting names {}, which is not there",
                p.display()
            ))
        };
    }
    env.or(on_path).ok_or_else(|| {
        format!(
            "Node.js was not found: install Node.js {MIN_NODE_MAJOR} or later from https://nodejs.org, \
             or name one in the bot.node setting"
        )
    })
}

/// The Node a test stand-in (a `.mjs` "java" or engine) runs on: only in a `test-hooks` build,
/// which release packages are built without (plan section 5.5).
pub fn script_node() -> Result<PathBuf, String> {
    if !cfg!(feature = "test-hooks") {
        return Err("a .mjs program stands in for one only in a test build of SpawnLoft".into());
    }
    node()
}

/// The major version in `node --version`'s answer (`v22.11.0`).
pub fn major_of(version: &str) -> Option<u32> {
    version.trim().strip_prefix('v')?.split('.').next()?.parse().ok()
}

/// [`node`], refused when it is older than [`MIN_NODE_MAJOR`] or does not answer `--version`.
/// Returns the path and the version it gave.
pub fn checked_node() -> Result<(PathBuf, String), String> {
    let node = node()?;
    let mut cmd = Command::new(&node);
    cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    prepare(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("{} could not be run: {e}", node.display()))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match major_of(&version) {
        Some(major) if major >= MIN_NODE_MAJOR => Ok((node, version)),
        Some(_) => Err(format!(
            "{} is Node.js {version}; mineflayer needs {MIN_NODE_MAJOR} or later",
            node.display()
        )),
        None => Err(format!("{} did not say which Node.js it is", node.display())),
    }
}

/// What every Node started by this binary gets: none of the machine's own Node settings
/// (`NODE_OPTIONS` could `--require` foreign code or open an inspector port; `NODE_PATH` changes
/// what resolves), no Electron switch left over from a 1.x environment, and no entry point
/// inherited from someone else.
pub fn prepare(cmd: &mut Command) {
    cmd.env_remove(crate::entry::ENTRY_ENV);
    for var in ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"] {
        cmd.env_remove(var);
    }
}

/// The first `node` on PATH, then the places a GUI-started app misses on macOS.
fn path_node() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(gui_fallback_dirs())
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
}

/// An app started from Finder or launchd gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, without the
/// places Node is installed (found on the Mac mini in P0-F). Checked after PATH, so a PATH entry
/// still wins.
fn gui_fallback_dirs() -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".volta/bin"));
        // nvm keeps one folder per version: the newest name first
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_wins_and_must_exist() {
        let here = std::env::current_exe().unwrap();
        assert_eq!(
            node_with(
                Some(here.clone()),
                Some("/x/env-node".into()),
                Some("/x/path-node".into())
            )
            .unwrap(),
            here
        );
        let e = node_with(Some("/no/such/node".into()), Some("/x/env-node".into()), None).unwrap_err();
        assert!(e.contains("bot.node setting"), "{e}");
    }

    #[test]
    fn the_variable_then_path() {
        assert_eq!(
            node_with(None, Some("/x/env-node".into()), Some("/x/path-node".into())).unwrap(),
            PathBuf::from("/x/env-node")
        );
        assert_eq!(
            node_with(None, None, Some("/x/path-node".into())).unwrap(),
            PathBuf::from("/x/path-node")
        );
        let e = node_with(None, None, None).unwrap_err();
        assert!(e.contains("Node.js 22 or later"), "{e}");
    }

    #[test]
    fn majors() {
        assert_eq!(major_of("v22.11.0\n"), Some(22));
        assert_eq!(major_of("v8.0.0"), Some(8));
        assert_eq!(major_of("22.1.0"), None);
        assert_eq!(major_of(""), None);
    }
}
