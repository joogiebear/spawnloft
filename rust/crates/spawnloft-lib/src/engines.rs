//! What the MySQL and Garnet engine fetches share (C2): an install lock beside the engine's
//! folder, a private staging folder in the store, and a pinned download checked before anything
//! is unpacked.

use std::path::{Path, PathBuf};

use crate::download::{self, Hash};
use crate::failure::Failure;

/// One step of an engine's setup, as `onProgress` gets it: a message, and the bytes so far of
/// a download (`total` 0 when the server named no length).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub message: String,
    pub received: Option<u64>,
    pub total: u64,
}

impl Progress {
    pub fn say(message: impl Into<String>) -> Progress {
        Progress {
            message: message.into(),
            received: None,
            total: 0,
        }
    }
}

pub type OnProgress<'a> = &'a mut dyn FnMut(&Progress);

/// `fs.openSync(lock, 'wx', 0o600)`, closed and removed when dropped. `None` when another
/// install holds it.
#[derive(Debug)]
pub struct InstallLock(PathBuf);

impl InstallLock {
    pub fn take(path: &Path) -> Result<Option<InstallLock>, Failure> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(path) {
            Ok(_) => Ok(Some(InstallLock(path.to_path_buf()))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
            Err(e) => Err(Failure::io(&e, "open", Some(path))),
        }
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `fs.mkdtempSync(prefix)`: six random letters and digits after the prefix.
pub fn mkdtemp(prefix: &str) -> Result<PathBuf, Failure> {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    loop {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b)
            .map_err(|e| Failure::user(format!("the system gave no random bytes: {e}")))?;
        let tail: String = b
            .iter()
            .map(|x| CHARS[*x as usize % CHARS.len()] as char)
            .collect();
        let p = PathBuf::from(format!("{prefix}{tail}"));
        match std::fs::create_dir(&p) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
                }
                return Ok(p);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(Failure::io(
                    &e,
                    "mkdtemp",
                    Some(Path::new(&format!("{prefix}XXXXXX"))),
                ));
            }
        }
    }
}

/// A staging folder removed (with all in it) when dropped.
#[derive(Debug)]
pub struct Staging(pub PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Downloads `url` to `file`, hashed as it arrives, reporting `message` with the bytes. A wrong
/// digest fails with `mismatch`; a refusal with `refused` given the status.
#[allow(clippy::too_many_arguments)]
pub fn fetch_pinned(
    url: &str,
    file: &Path,
    hash: Hash,
    expected: &str,
    message: &str,
    progress: OnProgress,
    mismatch: &str,
    refused: impl Fn(&str) -> String,
) -> Result<(), Failure> {
    let mut report = |received: u64, total: u64| {
        progress(&Progress {
            message: message.to_string(),
            received: Some(received),
            total,
        });
    };
    let options = download::Options {
        hash: Some(hash),
        expected: Some(expected.to_string()),
        on_progress: Some(&mut report),
        stall: std::time::Duration::from_secs(600),
        ..download::Options::default()
    };
    match download::download_file(url, file, options) {
        Ok(_) => Ok(()),
        Err(f) if f.json_code() == "checksum-mismatch" => Err(Failure::user(mismatch)),
        Err(f) => {
            // "download of <file> failed (404) from <url>": the engine's own words for a refusal
            let m = f.message();
            if let Some(rest) = m.split(" failed (").nth(1)
                && let Some((status, _)) = rest.split_once(") from ")
                && status.chars().all(|c| c.is_ascii_digit())
            {
                return Err(Failure::user(refused(status)));
            }
            Err(f)
        }
    }
}

/// `runTar(['-xf', file, ...extra, '-C', into], cwd)` that must finish with exit 0.
pub fn unpack(file: &Path, into: &Path, strip: bool, cwd: &Path) -> Result<bool, Failure> {
    let mut args = vec!["-xf".to_string(), file.to_string_lossy().into_owned()];
    if strip {
        args.push("--strip-components=1".into());
    }
    args.extend(["-C".into(), into.to_string_lossy().into_owned()]);
    Ok(crate::tar::run_tar(&args, cwd)?.code == 0)
}
