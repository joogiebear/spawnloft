//! `tar.mjs`: the system `tar`, which backups and restores call with the argument lists Node
//! builds (plan rule 9), and the question whether it can write a zip.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::failure::Failure;

/// `tarBinary()`: `System32\tar.exe` on Windows rather than whatever `tar` is first on PATH. Git
/// for Windows and MSYS put GNU tar first, which reads `C:\backups\x.tar.gz` as host `C:` and
/// fails every snapshot.
pub fn tar_binary() -> PathBuf {
    if !cfg!(windows) {
        return PathBuf::from("tar");
    }
    let root = std::env::var("SystemRoot")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "C:\\Windows".into());
    let system32 = PathBuf::from(crate::jspath::join(&[&root, "System32", "tar.exe"]));
    if system32.exists() {
        system32
    } else {
        PathBuf::from("tar")
    }
}

/// What `--version` printed within `limit`, or `None` when the program could not be started.
fn version_text(program: &Path, limit: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::platform::hide_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                // spawnSync's timeout: the child is killed and what it printed is kept
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    // something the program started may still hold its output open: what came is enough
    let out = rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Whether a `--version` text names bsdtar or libarchive (either case).
fn names_libarchive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("bsdtar") || lower.contains("libarchive")
}

/// `tarHandlesZip()`: asks the tar what it is instead of assuming from the platform. GNU tar
/// cannot do zip, and `-a -cf world.zip` exits 0 having written a plain tar under that name.
/// Asked once per process.
pub fn tar_handles_zip() -> bool {
    static CAPABLE: OnceLock<bool> = OnceLock::new();
    *CAPABLE.get_or_init(|| {
        version_text(&tar_binary(), Duration::from_secs(5)).is_some_and(|t| names_libarchive(&t))
    })
}

/// `tarMember(name)`: a leading `-` is read as an option (GNU tar's
/// `--checkpoint-action=exec=...` runs a command) and a leading `@` makes bsdtar copy entries from
/// that archive. `./` makes either a plain path.
pub fn tar_member(name: &str) -> String {
    if name.starts_with(['-', '@']) {
        format!("./{name}")
    } else {
        name.to_string()
    }
}

/// How a tar run ended when it counts as done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TarRun {
    pub code: i32,
    pub stderr: String,
}

/// `runTar(args, cwd)`: runs the tar in `cwd`. Exit 1 counts as done too: bsdtar exits 1 on
/// warnings such as "file changed as we read it", which is expected when snapshotting a running
/// server. Its output is not read (Node never reads it either).
pub fn run_tar(args: &[String], cwd: &Path) -> Result<TarRun, Failure> {
    run_program(&tar_binary(), args, cwd)
}

fn run_program(program: &Path, args: &[String], cwd: &Path) -> Result<TarRun, Failure> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::platform::hide_window(&mut cmd);
    let output = cmd.output().map_err(|e| {
        let code = crate::jspath::error_code(&e).0;
        // Node spawns in `cwd` too, and libuv reports a missing `cwd` as ENOENT as well
        Failure::user(if code == "ENOENT" {
            if cfg!(windows) {
                "tar was not found on PATH (Windows 10/11 ships tar.exe in System32)".to_string()
            } else {
                "tar was not found on PATH - install it with your package manager".to_string()
            }
        } else {
            format!("tar failed: spawn {} {code}", program.display())
        })
    })?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    match output.status.code() {
        Some(code @ (0 | 1)) => Ok(TarRun { code, stderr }),
        code => {
            let code = code.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
            let trimmed = crate::js::trim(&stderr);
            let why = if trimmed.is_empty() {
                "unknown error"
            } else {
                trimmed
            };
            Err(Failure::user(format!("tar exited {code}: {why}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_that_look_like_options_become_paths() {
        assert_eq!(tar_member("-x"), "./-x");
        assert_eq!(tar_member("@list"), "./@list");
        assert_eq!(tar_member("world"), "world");
        assert_eq!(tar_member("a-b"), "a-b");
        assert_eq!(tar_member(""), "");
    }

    #[test]
    fn libarchive_is_told_from_gnu() {
        assert!(names_libarchive("bsdtar 3.7.4 - libarchive 3.7.4 zlib/1.3"));
        assert!(names_libarchive("BSDTAR 3.5"));
        assert!(!names_libarchive("tar (GNU tar) 1.35\nCopyright"));
        assert!(!names_libarchive(""));
    }

    #[test]
    fn the_binary_is_system32s_on_windows() {
        let bin = tar_binary();
        if cfg!(windows) {
            assert!(
                bin.to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with("system32\\tar.exe"),
                "{bin:?}"
            );
        } else {
            assert_eq!(bin, PathBuf::from("tar"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn exit_codes_and_missing_programs_read_as_node_words_them() {
        let dir = std::env::temp_dir();
        let sh = Path::new("sh");
        let run = |script: &str| run_program(sh, &["-c".into(), script.into()], &dir);
        assert_eq!(
            run("exit 0").unwrap(),
            TarRun {
                code: 0,
                stderr: String::new()
            }
        );
        assert_eq!(run("echo changed >&2; exit 1").unwrap().code, 1);
        assert_eq!(
            run("echo '  broken  ' >&2; exit 2").unwrap_err().stderr_text(),
            "error: tar exited 2: broken\n"
        );
        assert_eq!(
            run("exit 3").unwrap_err().message(),
            "tar exited 3: unknown error"
        );
        assert_eq!(
            run("kill -9 $$").unwrap_err().message(),
            "tar exited null: unknown error"
        );
        let missing = run_program(Path::new("/nonexistent/tar"), &[], &dir).unwrap_err();
        assert_eq!(
            missing.message(),
            "tar was not found on PATH - install it with your package manager"
        );
        assert!(version_text(Path::new("/nonexistent/tar"), Duration::from_secs(1)).is_none());
        // a program that hangs is given up at the limit
        let started = Instant::now();
        let slow = std::env::temp_dir().join(format!("spawnloft-slow-tar-{}", std::process::id()));
        std::fs::write(&slow, "#!/bin/sh\necho bsdtar\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&slow, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let text = version_text(&slow, Duration::from_millis(300));
        let _ = std::fs::remove_file(&slow);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(text.as_deref().map(str::trim), Some("bsdtar"));
    }
}
