//! Test helpers. Dev-dependency only: nothing here is linked into a shipped binary.
//!
//! Today: a self-deleting temp directory and a way to run a binary and collect what it printed.
//! The daemon tests (P0-D) add fake java, mariadb and garnet here, ported from `test/fixtures`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

/// A directory under the system temp dir, removed on drop.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// A fresh empty directory whose name starts with `spawnloft-<label>-`.
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("spawnloft-{label}-{}-{n}", std::process::id()));
        // a leftover from a killed run with the same pid is stale, never shared
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        TempDir { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True when nothing has been written into the directory.
    pub fn is_empty(&self) -> bool {
        std::fs::read_dir(&self.path)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// What a finished process printed and how it exited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub stdout: String,
    pub stderr: String,
    /// `None` when it was ended by a signal.
    pub code: Option<i32>,
}

/// Runs `bin args...` in the current directory.
pub fn run(bin: &str, args: &[&str]) -> Ran {
    collect(Command::new(bin).args(args))
}

/// Runs `bin args...` in `dir`, with the SpawnLoft data root pointed there too, so a test can check
/// that nothing escaped into the real one.
pub fn run_in(bin: &str, args: &[&str], dir: &Path) -> Ran {
    collect(
        Command::new(bin)
            .args(args)
            .current_dir(dir)
            .env("SPAWNLOFT_DATA_ROOT", dir)
            .env("MCCTL_DATA_ROOT", dir),
    )
}

fn collect(cmd: &mut Command) -> Ran {
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("could not run {cmd:?}: {e}"));
    Ran {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code(),
    }
}

#[cfg(test)]
mod tests {
    use super::TempDir;

    #[test]
    fn temp_dir_is_empty_then_removed() {
        let path;
        {
            let dir = TempDir::new("selftest");
            path = dir.path().to_path_buf();
            assert!(dir.is_empty());
            std::fs::write(dir.path().join("x"), b"1").unwrap();
            assert!(!dir.is_empty());
        }
        assert!(!path.exists());
    }

    #[test]
    fn two_temp_dirs_differ() {
        let a = TempDir::new("selftest");
        let b = TempDir::new("selftest");
        assert_ne!(a.path(), b.path());
    }
}
