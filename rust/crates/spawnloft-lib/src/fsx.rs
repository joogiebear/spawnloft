//! File writes the Node core's readers rely on: JSON replaced atomically by temp file and rename
//! (`writeJson`), with the Windows retry for a file a virus scanner or indexer is holding.

use std::path::Path;
use std::time::Duration;

/// How many times a held file is retried, with growing waits (about 1.5 s in total).
pub const RENAME_RETRIES: u32 = 5;

/// Renames over `to`, retrying while another program holds it.
pub fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_retrying(from, to, |a, b| std::fs::rename(a, b))
}

fn rename_retrying(
    from: &Path,
    to: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || is_busy(&e) => {
                if attempt >= RENAME_RETRIES {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(50 * 2u64.pow(attempt)));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_busy(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33) on Windows, EBUSY (16) elsewhere
    match e.raw_os_error() {
        Some(32) | Some(33) if cfg!(windows) => true,
        Some(16) if cfg!(unix) => true,
        _ => false,
    }
}

/// `JSON.stringify(data, null, 2)` plus a newline, written through `<file>.tmp` and a rename so a
/// reader never sees half a file.
pub fn write_json(file: &Path, data: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
    text.push('\n');
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    rename_over(&tmp, file)
}

/// [`write_json`] for a file that must survive a power cut right after the call: the temp file
/// is flushed to the disk before it replaces `file`, so the name holds either the old content or
/// the new, never an empty or half-written file, and the replacement itself is written through.
pub fn write_json_durable(file: &Path, data: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
    text.push('\n');
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    drop(f);
    rename_retrying(&tmp, file, crate::platform::rename_durable)
}

/// `util.mjs` `writeJson` for the command line's files: `JSON.stringify(data, null, 2)` (numbers
/// and key order as JavaScript writes them) through `<file>.tmp` and [`rename_over`], with Node's
/// failures. With `mode` (owner-only for secrets) the temp file is private before it holds the
/// data; `strict` refuses to write a file that could not be made private. The answer is the
/// protection's (a failed one is a reason, not a failure, unless `strict`).
pub fn write_json_node(
    file: &Path,
    data: &serde_json::Value,
    mode: Option<u32>,
    strict: bool,
) -> Result<Result<(), String>, crate::failure::Failure> {
    use crate::failure::Failure;
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        mkdir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let mut ordered = data.clone();
    crate::jsjson::js_order(&mut ordered);
    let text = format!("{}\n", crate::jsjson::stringify_pretty(&ordered));
    let protection = match mode {
        None => std::fs::write(&tmp, &text).map(|()| Ok(())),
        Some(mode) => crate::private_files::write(&tmp, text.as_bytes(), mode),
    }
    .map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
    if strict && let Err(reason) = &protection {
        let _ = std::fs::remove_file(&tmp);
        return Err(Failure::user(format!(
            "could not make {} readable by you alone ({reason}), so it was not written; it needs a drive with file permissions (NTFS on Windows), see spawnloft config set-root",
            file.display()
        )));
    }
    rename_over(&tmp, file).map_err(|e| rename_failure(&e, &tmp, file))?;
    Ok(protection)
}

/// `fs.mkdirSync(dir, { recursive: true })` with Node's failure: ENOTDIR when a folder on the way
/// is a file (Windows says "already exists" for that), else the system's error for `dir`.
pub fn mkdir_all(dir: &Path) -> Result<(), crate::failure::Failure> {
    std::fs::create_dir_all(dir).map_err(|e| {
        let blocked = dir
            .ancestors()
            .skip(1)
            .any(|a| a.metadata().is_ok_and(|m| !m.is_dir()));
        if blocked {
            crate::failure::Failure::Internal {
                head: "Error".into(),
                message: format!("ENOTDIR: not a directory, mkdir '{}'", dir.display()),
                code: Some("ENOTDIR".into()),
            }
        } else {
            crate::failure::Failure::io(&e, "mkdir", Some(dir))
        }
    })
}

/// How `renameOver` reports a rename that failed: a file still held after the retries is a
/// person's problem with one line, anything else is Node's `rename 'a' -> 'b'` error.
pub fn rename_failure(e: &std::io::Error, from: &Path, to: &Path) -> crate::failure::Failure {
    use crate::failure::Failure;
    let (code, text) = crate::jspath::error_code(e);
    if matches!(code, "EPERM" | "EBUSY" | "EACCES") {
        return Failure::User {
            message: format!(
                "could not replace {}: another program (a virus scanner, indexer or sync client) is holding it ({code}); try again in a moment",
                to.display()
            ),
            code: Some(code.into()),
        };
    }
    Failure::Internal {
        head: "Error".into(),
        message: format!(
            "{code}: {text}, rename '{}' -> '{}'",
            from.display(),
            to.display()
        ),
        code: Some(code.into()),
    }
}

/// `fs.realpathSync(p)`: the path with every link resolved. On Windows the system's answer
/// carries the `\\?\` prefix, which Node's does not.
pub fn realpath(p: &Path) -> std::io::Result<std::path::PathBuf> {
    let real = std::fs::canonicalize(p)?;
    if cfg!(windows) {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(std::path::PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(std::path::PathBuf::from(rest));
        }
    }
    Ok(real)
}

/// `fs.readdirSync(dir)`'s names in its order: libuv's scandir sorts them byte by byte on Unix
/// (`alphasort` over the raw names); Windows gives them as the file system lists them, which is
/// what `read_dir` gives too.
pub fn readdir_names(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    if cfg!(unix) {
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    }
    Ok(names)
}

/// `fs.readdirSync(dir, { withFileTypes: true })` in its order (see [`readdir_names`]): each name
/// with its type, links not followed.
pub fn readdir_typed(dir: &Path) -> std::io::Result<Vec<(String, std::fs::FileType)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        out.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.file_type()?,
        ));
    }
    if cfg!(unix) {
        out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    }
    Ok(out)
}

/// `fs.cpSync(src, dest, { recursive: true })` into a `dest` that is not there yet: folders made,
/// files copied with their mode, links made again pointing where they pointed (a relative target
/// made absolute against the link's folder, as `verbatimSymlinks: false` does).
pub fn copy_tree(src: &Path, dest: &Path) -> Result<(), crate::failure::Failure> {
    use crate::failure::Failure;
    let meta = std::fs::symlink_metadata(src).map_err(|e| Failure::io(&e, "lstat", Some(src)))?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src).map_err(|e| Failure::io(&e, "readlink", Some(src)))?;
        let target = if target.is_absolute() {
            target
        } else {
            src.parent().unwrap_or(Path::new(".")).join(target)
        };
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, dest);
        #[cfg(windows)]
        let made = if std::fs::metadata(&target).is_ok_and(|m| m.is_dir()) {
            std::os::windows::fs::symlink_dir(&target, dest)
        } else {
            std::os::windows::fs::symlink_file(&target, dest)
        };
        return made.map_err(|e| Failure::io(&e, "symlink", Some(dest)));
    }
    if meta.is_dir() {
        std::fs::create_dir(dest).map_err(|e| Failure::io(&e, "mkdir", Some(dest)))?;
        for (name, _) in readdir_typed(src).map_err(|e| Failure::io(&e, "opendir", Some(src)))? {
            copy_tree(&src.join(&name), &dest.join(&name))?;
        }
        return Ok(());
    }
    std::fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| Failure::io(&e, "copyfile", Some(src)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_pretty_json_like_node() {
        let dir = std::env::temp_dir().join(format!("sl-fsx-{}", std::process::id()));
        let file = dir.join("state.json");
        write_json(
            &file,
            &serde_json::json!({ "name": "a", "running": true, "list": [] }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\n  \"name\": \"a\",\n  \"running\": true,\n  \"list\": []\n}\n"
        );
        assert!(!dir.join("state.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
