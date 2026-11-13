//! The command line on the user's PATH (Windows). The installer runs `spawnloft-core user-path add`
//! on a new install and on the 1.x handover, which puts the install's `resources\bin` (where
//! `spawnloft.cmd` and `mcctl.cmd` sit, 1.x's paths) on the user's PATH; the uninstaller runs
//! `user-path remove` on a real uninstall. So `spawnloft` works in a new terminal after installing
//! 2.0 without anyone editing environment variables by hand. A 2.x update and a rollback to 1.x
//! leave the PATH as it is: the folder is the same, and an entry the user removed stays removed.
//!
//! This module is the string logic, testable everywhere; the registry read and write and the
//! "environment changed" broadcast live in `platform::windows`.

/// Windows paths compare without case and without a trailing separator.
fn same(a: &str, b: &str) -> bool {
    // an entry may be quoted ("C:\\Program Files\\x"); Windows ignores the quotes
    let trim = |s: &str| {
        s.trim()
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    !a.trim().is_empty() && trim(a) == trim(b)
}

/// `path` (the user's `Path` value as stored) with `dir` appended, or `None` when an entry
/// already names `dir`, either as written or after `expand` (so `%LOCALAPPDATA%\...` counts).
pub fn with_entry(path: &str, dir: &str, expand: impl Fn(&str) -> String) -> Option<String> {
    if path.split(';').any(|e| same(e, dir) || same(&expand(e), dir)) {
        return None;
    }
    let base = path.trim_end_matches(';');
    Some(if base.is_empty() {
        dir.to_string()
    } else {
        format!("{base};{dir}")
    })
}

/// `path` without every entry that names `dir`, or `None` when there is none. Everything else
/// is kept exactly as written, empty entries included.
pub fn without_entry(path: &str, dir: &str, expand: impl Fn(&str) -> String) -> Option<String> {
    let entries: Vec<&str> = path.split(';').collect();
    let kept: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|e| !(same(e, dir) || same(&expand(e), dir)))
        .collect();
    (kept.len() != entries.len()).then(|| kept.join(";"))
}

/// The longest value Windows lets a single environment variable hold. A `Path` that would grow
/// past it is left as it is.
pub const MAX_LEN: usize = 32_767;

/// The folder of the `spawnloft` / `mcctl` forwarders of this install: the folder of the running
/// `spawnloft-core.exe`, when `spawnloft.cmd` is beside it (an installed copy, not a cargo build).
pub fn install_bin_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    dir.join("spawnloft.cmd").is_file().then(|| dir.to_path_buf())
}

/// What a change to the user's PATH did, for the installer log.
#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Added,
    Removed,
    Unchanged,
    /// Not an installed copy, or not Windows.
    Skipped,
}

/// Puts this install's forwarder folder on the user's PATH (the installer's `user-path add`).
#[cfg(windows)]
pub fn add() -> std::io::Result<Change> {
    use crate::platform::{expand_env, read_user_path, write_user_path};
    let Some(dir) = install_bin_dir() else {
        return Ok(Change::Skipped);
    };
    let dir = dir.to_string_lossy().into_owned();
    // a new value is REG_EXPAND_SZ, as Windows makes it
    let (current, expand) = read_user_path()?.unwrap_or((String::new(), true));
    match with_entry(&current, &dir, expand_env) {
        Some(next) if next.len() <= MAX_LEN => {
            write_user_path(&next, expand)?;
            Ok(Change::Added)
        }
        Some(_) => Err(std::io::Error::other("the user PATH would be too long")),
        None => Ok(Change::Unchanged),
    }
}

/// Takes this install's forwarder folder off the user's PATH (the uninstaller's `user-path remove`).
#[cfg(windows)]
pub fn remove() -> std::io::Result<Change> {
    use crate::platform::{expand_env, read_user_path, write_user_path};
    let Some(dir) = install_bin_dir() else {
        return Ok(Change::Skipped);
    };
    let dir = dir.to_string_lossy().into_owned();
    let Some((current, expand)) = read_user_path()? else {
        return Ok(Change::Unchanged);
    };
    match without_entry(&current, &dir, expand_env) {
        Some(next) => {
            write_user_path(&next, expand)?;
            Ok(Change::Removed)
        }
        None => Ok(Change::Unchanged),
    }
}

#[cfg(not(windows))]
pub fn add() -> std::io::Result<Change> {
    Ok(Change::Skipped)
}

#[cfg(not(windows))]
pub fn remove() -> std::io::Result<Change> {
    Ok(Change::Skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r"C:\Users\v\AppData\Local\Programs\SpawnLoft\resources\bin";
    fn none(s: &str) -> String {
        s.to_string()
    }
    fn local(s: &str) -> String {
        s.replace("%LOCALAPPDATA%", r"C:\Users\v\AppData\Local")
    }

    #[test]
    fn appends_once() {
        assert_eq!(with_entry("", DIR, none).as_deref(), Some(DIR));
        assert_eq!(
            with_entry(r"C:\a;C:\b", DIR, none),
            Some(format!(r"C:\a;C:\b;{DIR}"))
        );
        // a trailing separator is not doubled
        assert_eq!(with_entry(r"C:\a;", DIR, none), Some(format!(r"C:\a;{DIR}")));
        let added = with_entry(r"C:\a", DIR, none).unwrap();
        assert_eq!(with_entry(&added, DIR, none), None);
    }

    #[test]
    fn an_entry_written_differently_is_the_same_entry() {
        let upper = DIR.to_uppercase();
        assert_eq!(with_entry(&format!(r"C:\a;{upper}\"), DIR, none), None);
        assert_eq!(with_entry(&format!(r#"C:\a;"{DIR}""#), DIR, none), None);
        assert_eq!(
            with_entry(
                r"%LOCALAPPDATA%\Programs\SpawnLoft\resources\bin;C:\a",
                DIR,
                local
            ),
            None
        );
    }

    #[test]
    fn removes_only_its_own_entry() {
        assert_eq!(without_entry(r"C:\a;C:\b", DIR, none), None);
        assert_eq!(
            without_entry(&format!(r"C:\a;{DIR};C:\b"), DIR, none).as_deref(),
            Some(r"C:\a;C:\b")
        );
        assert_eq!(without_entry(DIR, DIR, none).as_deref(), Some(""));
        // twice, once expanded and with a trailing backslash: both go
        assert_eq!(
            without_entry(
                &format!(r"{DIR}\;C:\a;%LOCALAPPDATA%\Programs\SpawnLoft\resources\bin"),
                DIR,
                local
            )
            .as_deref(),
            Some(r"C:\a")
        );
        // empty entries elsewhere are someone else's and stay
        assert_eq!(
            without_entry(&format!(r"C:\a;;{DIR}"), DIR, none).as_deref(),
            Some(r"C:\a;")
        );
    }

    #[test]
    fn an_empty_entry_never_matches() {
        assert_eq!(without_entry(";;", DIR, none), None);
        assert!(!same("", ""));
    }
}
