//! Node's `path.resolve`, `path.join` and `path.normalize` for the platform, and the text of a
//! Node file-system error. The ported commands print paths the Node core built this way (a
//! server's `dir` from the registry is joined, not taken as it is), so they must come out the
//! same, `..` and doubled separators included.

use std::path::{Path, PathBuf};

pub const SEP: char = if cfg!(windows) { '\\' } else { '/' };

fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// The root of a path as Node's win32 module sees it (`C:\`, `C:`, `\\server\share\`, `\`), or
/// `/` on POSIX, with whether the path is absolute.
fn split_root(p: &str) -> (String, bool, &str) {
    if !cfg!(windows) {
        return if let Some(rest) = p.strip_prefix('/') {
            ("/".into(), true, rest.trim_start_matches('/'))
        } else {
            (String::new(), false, p)
        };
    }
    let b = p.as_bytes();
    // UNC: \\server\share
    if b.len() >= 2 && is_sep(b[0] as char) && is_sep(b[1] as char) {
        let rest = &p[2..];
        let mut parts = rest.splitn(3, ['/', '\\']);
        if let (Some(server), Some(share)) = (parts.next(), parts.next())
            && !server.is_empty()
            && !share.is_empty()
        {
            let tail = parts.next().unwrap_or("");
            return (format!("\\\\{server}\\{share}\\"), true, tail);
        }
    }
    if b.len() >= 2 && b[1] == b':' && (b[0] as char).is_ascii_alphabetic() {
        let drive = &p[..2];
        let rest = &p[2..];
        if rest.starts_with(is_sep) {
            return (format!("{drive}\\"), true, rest.trim_start_matches(is_sep));
        }
        return (drive.to_string(), false, rest);
    }
    if p.starts_with(is_sep) {
        return ("\\".into(), true, p.trim_start_matches(is_sep));
    }
    (String::new(), false, p)
}

/// `path.normalize(p)`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let (root, absolute, rest) = split_root(p);
    let trailing = p.len() > root.len() && p.ends_with(is_sep);
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let mut body = parts.join(&SEP.to_string());
    if body.is_empty() && !absolute {
        body = ".".into();
    }
    if trailing && !body.is_empty() {
        body.push(SEP);
    }
    format!("{root}{body}")
}

/// `path.join(...parts)`.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|s| !s.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined.join(&SEP.to_string()))
}

/// `path.resolve(p)` against the current folder; no trailing separator except on a root.
pub fn resolve(p: &str) -> String {
    let (_, absolute, _) = split_root(p);
    let full = if absolute {
        p.to_string()
    } else if cfg!(windows) {
        // a drive-relative path (C:x) or a rooted one (\x) is completed by the system as Node does
        return std::path::absolute(Path::new(p))
            .map(|a| strip_trailing(&normalize(&a.to_string_lossy())))
            .unwrap_or_else(|_| p.to_string());
    } else {
        let cwd = std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("{cwd}/{p}")
    };
    strip_trailing(&normalize(&full))
}

fn strip_trailing(p: &str) -> String {
    let (root, _, _) = split_root(p);
    if p.len() > root.len() && p.ends_with(is_sep) {
        p[..p.len() - 1].to_string()
    } else {
        p.to_string()
    }
}

/// [`join`] over a path and plain names, as a `PathBuf`.
pub fn join_path(base: &str, names: &[&str]) -> PathBuf {
    let mut all = vec![base];
    all.extend_from_slice(names);
    PathBuf::from(join(&all))
}

/// The message Node puts on a failed file-system call: `ENOENT: no such file or directory, open
/// '/x'`. `syscall` is Node's name for the call (`open`, `read`, `scandir`, `mkdir`, `stat`).
pub fn node_error(e: &std::io::Error, syscall: &str, path: Option<&Path>) -> String {
    let (code, text) = error_code(e);
    match path {
        Some(p) => format!("{code}: {text}, {syscall} '{}'", p.display()),
        None => format!("{code}: {text}, {syscall}"),
    }
}

/// libuv's name and text for an I/O error.
pub fn error_code(e: &std::io::Error) -> (&'static str, &'static str) {
    #[cfg(unix)]
    if let Some(n) = e.raw_os_error() {
        let known = match n {
            1 => Some(("EPERM", "operation not permitted")),
            2 => Some(("ENOENT", "no such file or directory")),
            5 => Some(("EIO", "i/o error")),
            9 => Some(("EBADF", "bad file descriptor")),
            12 => Some(("ENOMEM", "not enough memory")),
            13 => Some(("EACCES", "permission denied")),
            16 => Some(("EBUSY", "resource busy or locked")),
            17 => Some(("EEXIST", "file already exists")),
            18 => Some(("EXDEV", "cross-device link not permitted")),
            20 => Some(("ENOTDIR", "not a directory")),
            21 => Some(("EISDIR", "illegal operation on a directory")),
            22 => Some(("EINVAL", "invalid argument")),
            24 => Some(("EMFILE", "too many open files")),
            28 => Some(("ENOSPC", "no space left on device")),
            30 => Some(("EROFS", "read-only file system")),
            36 | 63 => Some(("ENAMETOOLONG", "name too long")),
            40 | 62 => Some(("ELOOP", "too many symbolic links encountered")),
            39 | 66 => Some(("ENOTEMPTY", "directory not empty")),
            _ => None,
        };
        if let Some(k) = known {
            return k;
        }
    }
    use std::io::ErrorKind as K;
    match e.kind() {
        K::NotFound => ("ENOENT", "no such file or directory"),
        K::PermissionDenied => ("EPERM", "operation not permitted"),
        K::AlreadyExists => ("EEXIST", "file already exists"),
        K::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        K::NotADirectory => ("ENOTDIR", "not a directory"),
        K::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        K::ResourceBusy => ("EBUSY", "resource busy or locked"),
        K::StorageFull => ("ENOSPC", "no space left on device"),
        K::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        K::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        _ => ("EIO", "i/o error"),
    }
}

/// Node's error for reading a whole file: a folder in its place fails at `read`, with no path.
pub fn read_error(e: &std::io::Error, file: &Path) -> String {
    // Windows refuses to open a folder at all (access denied); Node opens it and fails the read
    if error_code(e).0 == "EISDIR" || file.is_dir() {
        if cfg!(windows) {
            return "EISDIR: illegal operation on a directory, read".to_string();
        }
        node_error(e, "read", None)
    } else {
        node_error(e, "open", Some(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn posix_paths_as_node_builds_them() {
        assert_eq!(normalize("/a//b/../c/./d/"), "/a/c/d/");
        assert_eq!(normalize("a/../../b"), "../b");
        assert_eq!(normalize("/../x"), "/x");
        assert_eq!(normalize(""), ".");
        assert_eq!(join(&["/srv/x/", "crash-reports"]), "/srv/x/crash-reports");
        assert_eq!(join(&["/srv/x/..", "y"]), "/srv/y");
        assert_eq!(resolve("/a/b/"), "/a/b");
        assert_eq!(resolve("/"), "/");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(resolve("q/.."), cwd.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_as_node_builds_them() {
        assert_eq!(normalize("C:/a//b/../c"), "C:\\a\\c");
        assert_eq!(normalize("\\\\srv\\share\\x\\..\\y"), "\\\\srv\\share\\y");
        assert_eq!(join(&["C:\\x\\", "crash-reports"]), "C:\\x\\crash-reports");
        assert_eq!(resolve("C:\\a\\b\\"), "C:\\a\\b");
    }

    #[test]
    fn error_text() {
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            node_error(&e, "open", Some(Path::new("x"))),
            "ENOENT: no such file or directory, open 'x'"
        );
    }
}
