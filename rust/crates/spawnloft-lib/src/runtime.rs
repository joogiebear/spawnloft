//! The Node.js the few JavaScript parts left still run on (rust/PLAN-CORE-PORT.md sections 5.4
//! and 5.5). The core itself runs none and 2.0 carries none: the bot host (mineflayer, npm
//! packages `bot setup` installs) and the V8 check of a bot scenario's patterns run on the
//! machine's own Node, and in a `test-hooks` build so do the tests' `.mjs` stand-ins (the fake
//! JVM and engines).
//!
//! Which Node: the `bot.node` setting (`{"bot": {"node": "<path>"}}`, or the flat
//! `{"bot.node": "<path>"}`; a full path) when it names one, else
//! `SPAWNLOFT_NODE`, else the first `node` on PATH (then the places a GUI-started app misses on
//! macOS). The bot host also needs it to be recent enough for mineflayer ([`checked_node`]).

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The oldest Node major mineflayer runs on (its `engines`, and minecraft-protocol's).
pub const MIN_NODE_MAJOR: u32 = 22;

/// The `bot.node` setting, when it is a non-empty string: nested under `bot`, or the flat key.
fn setting_node() -> Option<PathBuf> {
    let (settings, _) = crate::settings::load();
    settings
        .get("bot")
        .and_then(|b| b.get("node"))
        .or_else(|| settings.get("bot.node"))
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
        // a bare name would resolve against whatever folder this process started in (a
        // terminal's, a task's, the MCP client's)
        if !p.is_absolute() {
            return Err(format!(
                "the bot.node setting names {}; give the full path to the node program",
                p.display()
            ));
        }
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
    let version = version_of(&node)?;
    match major_of(&version) {
        Some(major) if major >= MIN_NODE_MAJOR => Ok((node, version)),
        Some(_) => Err(format!(
            "{} is Node.js {version}; mineflayer needs {MIN_NODE_MAJOR} or later",
            node.display()
        )),
        None => Err(format!("{} did not say which Node.js it is", node.display())),
    }
}

/// How long `node --version` may take before the program is taken not to be Node.
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// What `<node> --version` prints, read with a time limit (doctor and `bot check` run this on
/// whatever the setting names) and at most 4 KB of it.
fn version_of(node: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut cmd = Command::new(node);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    prepare(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} could not be run: {e}", node.display()))?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout {
            let _ = out.take(4096).read_to_string(&mut text);
        }
        text
    });
    let until = std::time::Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} did not answer --version within {} seconds",
                    node.display(),
                    VERSION_TIMEOUT.as_secs()
                ));
            }
        }
    }
    Ok(reader.join().unwrap_or_default().trim().to_string())
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
        // nvm keeps one folder per version (`v22.11.0`): the newest version first, by number
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
                .flatten()
                .map(|e| (version_key(&e.file_name().to_string_lossy()), e.path().join("bin")))
                .collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev().map(|(_, dir)| dir));
        }
    }
    dirs
}

/// `v22.11.0` as `[22, 11, 0]`, for sorting nvm's folders by version rather than by name.
fn version_key(name: &str) -> Vec<u32> {
    name.trim_start_matches('v')
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
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
    fn a_relative_setting_is_refused() {
        let e = node_with(Some("node".into()), None, Some("/x/path-node".into())).unwrap_err();
        assert!(e.contains("full path"), "{e}");
    }

    #[test]
    fn nvm_versions_sort_by_number() {
        let mut v = [version_key("v9.11.2"), version_key("v22.1.0"), version_key("v18.20.4")];
        v.sort();
        assert_eq!(v.last().unwrap(), &vec![22, 1, 0]);
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_never_answers_times_out() {
        let dir = std::env::temp_dir().join(format!("sl-node-hang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("node");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let e = version_of(&script).unwrap_err();
        assert!(e.contains("did not answer"), "{e}");
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn majors() {
        assert_eq!(major_of("v22.11.0\n"), Some(22));
        assert_eq!(major_of("v8.0.0"), Some(8));
        assert_eq!(major_of("22.1.0"), None);
        assert_eq!(major_of(""), None);
    }
}
