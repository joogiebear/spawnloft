//! `tree.mjs`: copying a folder tree and checking the copy, for moving the data folder.
//!
//! Not a plain recursive copy because the move needs: modification times kept (backup history
//! and retention are ordered by them), links recreated rather than followed, locked files retried
//! then named, nothing overwritten, and every failure collected before reporting.
//!
//! Names are carried as the system gives them (`OsString`), so a name that is not UTF-8 is
//! copied like any other; the Node core reads such a name lossily and then cannot find it.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::fs::{self, FileTimes, Metadata};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::failure::Failure;
use crate::jspath;

/// A copy or check that went wrong, with every problem found (`TreeError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeError {
    pub message: String,
    pub problems: Vec<String>,
}

impl TreeError {
    /// The message with the first three problems, as `new TreeError(message, problems)` words it.
    pub fn new(message: &str, problems: Vec<String>) -> TreeError {
        let message = if problems.is_empty() {
            message.to_string()
        } else {
            let more = if problems.len() > 3 {
                format!("; and {} more", problems.len() - 3)
            } else {
                String::new()
            };
            format!(
                "{message}: {}{more}",
                problems[..problems.len().min(3)].join("; ")
            )
        };
        TreeError { message, problems }
    }
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    Other,
}

impl Kind {
    fn of(m: &Metadata) -> Kind {
        let t = m.file_type();
        if t.is_symlink() {
            Kind::Link
        } else if t.is_dir() {
            Kind::Dir
        } else if t.is_file() {
            Kind::File
        } else {
            Kind::Other
        }
    }
    fn word(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Dir => "dir",
            Kind::Link => "link",
            Kind::Other => "other",
        }
    }
}

/// One entry of a walk: its path below the root, its full path, and what `lstat` says.
#[derive(Debug)]
pub struct Entry {
    pub rel: PathBuf,
    pub abs: PathBuf,
    pub kind: Kind,
    pub meta: Metadata,
}

/// JavaScript's `<` on two names: UTF-16 code units in order.
fn js_order(a: &OsString, b: &OsString) -> Ordering {
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `walk(root)`: every entry in name order, a folder's contents after it; links are entries,
/// never followed. An unreadable folder or entry fails the walk, as the Node core's throws.
pub fn walk(root: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    walk_into(root, Path::new(""), &mut out)?;
    Ok(out)
}

fn walk_into(root: &Path, rel: &Path, out: &mut Vec<Entry>) -> io::Result<()> {
    let mut names: Vec<OsString> = fs::read_dir(root.join(rel))?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<io::Result<_>>()?;
    names.sort_by(js_order);
    for name in names {
        let here = rel.join(&name);
        let abs = root.join(&here);
        let meta = fs::symlink_metadata(&abs)?;
        let kind = Kind::of(&meta);
        out.push(Entry {
            rel: here.clone(),
            abs,
            kind,
            meta,
        });
        if kind == Kind::Dir {
            walk_into(root, &here, out)?;
        }
    }
    Ok(())
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub files: u64,
    pub dirs: u64,
    pub links: u64,
    pub other: u64,
    pub bytes: u64,
}

/// `treeStats(root)`.
pub fn tree_stats(root: &Path) -> io::Result<Stats> {
    let mut s = Stats::default();
    for e in walk(root)? {
        match e.kind {
            Kind::File => {
                s.files += 1;
                s.bytes += e.meta.len();
            }
            Kind::Dir => s.dirs += 1,
            Kind::Link => s.links += 1,
            Kind::Other => s.other += 1,
        }
    }
    Ok(s)
}

/// Node's `err.message` for a call on one path: `ENOENT: no such file or directory, lstat 'p'`.
pub fn node_message(e: &io::Error, syscall: &str, path: &Path) -> String {
    jspath::node_error(e, syscall, Some(path))
}

/// The same for a call on two paths (`copyfile 'a' -> 'b'`, `symlink 'a' -> 'b'`).
pub fn node_message2(e: &io::Error, syscall: &str, from: &Path, to: &Path) -> String {
    let (code, text) = jspath::error_code(e);
    format!(
        "{code}: {text}, {syscall} '{}' -> '{}'",
        from.display(),
        to.display()
    )
}

/// The error codes a file held open by something else gives on Windows.
fn locked(e: &io::Error) -> bool {
    matches!(jspath::error_code(e).0, "EBUSY" | "EPERM" | "EACCES")
}

/// `fs.copyFile(from, to, COPYFILE_EXCL)`: never overwrites, since an existing destination is
/// somebody's data; the mode is copied as libuv copies it. Returns the new file, still open, so
/// its times can be set.
fn copy_excl(from: &Path, to: &Path) -> io::Result<fs::File> {
    let mut src = fs::File::open(from)?;
    let meta = src.metadata()?;
    let mut dst = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    let copied = (|| -> io::Result<()> {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
        }
        dst.set_permissions(meta.permissions())
    })();
    if let Err(e) = copied {
        drop(dst);
        let _ = fs::remove_file(to);
        return Err(e);
    }
    Ok(dst)
}

fn copy_file(from: &Path, to: &Path, delays: &[u64]) -> io::Result<fs::File> {
    let mut attempt = 0;
    loop {
        match copy_excl(from, to) {
            Ok(f) => return Ok(f),
            Err(e) if attempt < delays.len() && locked(&e) => {
                std::thread::sleep(Duration::from_millis(delays[attempt]));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn times_of(m: &Metadata) -> FileTimes {
    let mut t = FileTimes::new();
    if let Ok(a) = m.accessed() {
        t = t.set_accessed(a);
    }
    if let Ok(w) = m.modified() {
        t = t.set_modified(w);
    }
    t
}

/// A link copied as a link: the same target text. On Windows a link to a folder becomes a
/// junction, which needs no elevation, and anything else (a dangling one too) a file link.
fn copy_link(entry: &Entry, to: &Path) -> io::Result<()> {
    let target = fs::read_link(&entry.abs)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, to)
    }
    #[cfg(windows)]
    {
        let is_dir = fs::metadata(&entry.abs).is_ok_and(|m| m.is_dir());
        if is_dir {
            // a junction needs an absolute target, as libuv makes one
            let abs = if target.is_absolute() {
                target
            } else {
                entry.abs.parent().unwrap_or(Path::new("")).join(target)
            };
            crate::platform::make_junction(&abs, to)
        } else {
            std::os::windows::fs::symlink_file(&target, to)
        }
    }
}

/// What a copy did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Copied {
    pub files: u64,
    pub dirs: u64,
    pub links: u64,
    pub bytes: u64,
    /// things like pipes and devices, by path below the root
    pub skipped: Vec<String>,
}

/// Progress of a copy: files and bytes done, of the totals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub files: u64,
    pub bytes: u64,
    pub total_files: u64,
    pub total_bytes: u64,
}

pub const RETRY_DELAYS: [u64; 3] = [100, 300, 900];

/// `copyTree(src, dest)`: `dest` must not hold any of the same files. Every file that fails is
/// named after the rest are tried; whatever was copied before is left in place (the caller knows
/// whether it made the folder).
pub fn copy_tree(
    src: &Path,
    dest: &Path,
    mut on_progress: Option<&mut dyn FnMut(Progress)>,
    delays: &[u64],
) -> Result<Copied, CopyError> {
    let totals = tree_stats(src).map_err(CopyError::Io)?;
    fs::create_dir_all(dest).map_err(CopyError::Io)?;
    let mut done = Copied::default();
    let mut problems = Vec::new();
    let mut folders: Vec<(PathBuf, FileTimes)> = Vec::new();
    for entry in walk(src).map_err(CopyError::Io)? {
        let to = dest.join(&entry.rel);
        let rel = entry.rel.display().to_string();
        match entry.kind {
            Kind::Dir => {
                fs::create_dir_all(&to).map_err(CopyError::Io)?;
                folders.push((to, times_of(&entry.meta)));
                done.dirs += 1;
            }
            Kind::File => {
                let copied =
                    copy_file(&entry.abs, &to, delays).and_then(|f| f.set_times(times_of(&entry.meta)));
                match copied {
                    Ok(()) => {
                        done.files += 1;
                        done.bytes += entry.meta.len();
                        if let Some(p) = on_progress.as_deref_mut() {
                            p(Progress {
                                files: done.files,
                                bytes: done.bytes,
                                total_files: totals.files,
                                total_bytes: totals.bytes,
                            });
                        }
                    }
                    Err(e) => problems.push(format!(
                        "{rel} ({})",
                        node_message2(&e, "copyfile", &entry.abs, &to)
                    )),
                }
            }
            Kind::Link => match copy_link(&entry, &to) {
                Ok(()) => done.links += 1,
                Err(e) => problems.push(format!(
                    "{rel} (link: {})",
                    node_message2(&e, "symlink", &entry.abs, &to)
                )),
            },
            Kind::Other => done.skipped.push(rel),
        }
    }
    // a folder's time changes when anything is put in it, so set them last, deepest first
    for (dir, times) in folders.into_iter().rev() {
        let _ = crate::platform::set_dir_times(&dir, times);
    }
    if !problems.is_empty() {
        let n = problems.len();
        return Err(CopyError::Tree(TreeError::new(
            &format!("{n} {} could not be copied", plural(n, "file", "files")),
            problems,
        )));
    }
    Ok(done)
}

/// Why a copy stopped: one file system call that the whole copy depends on, or the files that
/// could not be copied.
#[derive(Debug)]
pub enum CopyError {
    Io(io::Error),
    Tree(TreeError),
}

/// Files up to this size are compared byte for byte; larger ones by size and time unless
/// `thorough`.
const SMALL: u64 = 1024 * 1024;

fn hash_of(file: &Path) -> io::Result<Vec<u8>> {
    use sha2::Digest;
    let mut f = fs::File::open(file)?;
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().to_vec())
}

fn same_contents(a: &Path, b: &Path, size: u64) -> io::Result<bool> {
    if size <= SMALL {
        return Ok(fs::read(a)? == fs::read(b)?);
    }
    Ok(hash_of(a)? == hash_of(b)?)
}

struct Item {
    kind: Kind,
    abs: PathBuf,
    size: u64,
    mtime_ms: f64,
    link: Option<Option<String>>,
}

fn mtime_ms(m: &Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn index(root: &Path) -> io::Result<Vec<(String, Item)>> {
    let mut out = Vec::new();
    for e in walk(root)? {
        let link = (e.kind == Kind::Link).then(|| {
            fs::read_link(&e.abs)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        });
        out.push((
            e.rel.display().to_string(),
            Item {
                kind: e.kind,
                abs: e.abs,
                size: e.meta.len(),
                mtime_ms: mtime_ms(&e.meta),
                link,
            },
        ));
    }
    Ok(out)
}

fn same_link(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            let norm = |p: &str| {
                let n = jspath::normalize(p);
                n.trim_end_matches(['\\', '/']).to_string()
            };
            if cfg!(windows) {
                norm(a).to_lowercase() == norm(b).to_lowercase()
            } else {
                norm(a) == norm(b)
            }
        }
        _ => a == b,
    }
}

/// What [`compare_trees`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub ok: bool,
    pub problems: Vec<String>,
    pub files: u64,
}

pub const MTIME_TOLERANCE_MS: f64 = 2000.0;
pub const MAX_PROBLEMS: usize = 50;

/// `compareTrees(original, copy, { thorough })`: files, sizes, links, modified times (within
/// two seconds, since some drives round times coarsely) and contents. Large files are read only
/// when `thorough`, because that reads gigabytes twice. Folders are checked for presence only.
pub fn compare_trees(original: &Path, copy: &Path, thorough: bool) -> io::Result<Verdict> {
    let left = index(original)?;
    let right = index(copy)?;
    let right_map: std::collections::HashMap<&str, &Item> =
        right.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let left_keys: std::collections::HashSet<&str> = left.iter().map(|(k, _)| k.as_str()).collect();
    let mut problems = Vec::new();
    let mut total = 0usize;
    let mut files = 0;
    let mut add = |text: String| {
        total += 1;
        if problems.len() < MAX_PROBLEMS {
            problems.push(text);
        }
    };
    for (rel, a) in &left {
        let Some(b) = right_map.get(rel.as_str()) else {
            add(format!("{rel}: missing from the copy"));
            continue;
        };
        if a.kind != b.kind {
            add(format!(
                "{rel}: is a {} in the original and a {} in the copy",
                a.kind.word(),
                b.kind.word()
            ));
            continue;
        }
        if a.kind == Kind::Link {
            let (la, lb) = (a.link.clone().flatten(), b.link.clone().flatten());
            if !same_link(&la, &lb) {
                add(format!(
                    "{rel}: link points somewhere else ({}, not {})",
                    lb.as_deref().unwrap_or("null"),
                    la.as_deref().unwrap_or("null")
                ));
            }
        }
        if a.kind != Kind::File {
            continue;
        }
        files += 1;
        if a.size != b.size {
            add(format!("{rel}: size differs ({} bytes, copy {})", a.size, b.size));
            continue;
        }
        if (a.mtime_ms - b.mtime_ms).abs() > MTIME_TOLERANCE_MS {
            add(format!("{rel}: modified time differs"));
        }
        if (a.size <= SMALL || thorough) && !same_contents(&a.abs, &b.abs, a.size)? {
            add(format!("{rel}: contents differ"));
        }
    }
    for (rel, _) in &right {
        if !left_keys.contains(rel.as_str()) {
            add(format!("{rel}: not in the original"));
        }
    }
    if total > problems.len() {
        let more = total - problems.len();
        problems.push(format!("and {more} more"));
    }
    Ok(Verdict {
        ok: total == 0,
        problems,
        files,
    })
}

/// `removeTree(dir)`: links inside are removed as links, their targets left alone; a busy
/// entry is retried three times, 100 ms apart, as `fs.rm`'s `maxRetries` does.
pub fn remove_tree(dir: &Path) -> Result<(), Failure> {
    let mut attempt = 0u64;
    loop {
        match crate::manage::rm_rf(dir) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 3 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(100 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-tree-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_copy_keeps_times_and_links_and_checks_out() {
        let d = scratch("copy");
        let src = d.join("src");
        fs::create_dir_all(src.join("b/c")).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("b/c/d.bin"), vec![7u8; 3000]).unwrap();
        std::os::unix::fs::symlink("b/c", src.join("link")).unwrap();
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(src.join("a.txt"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(old))
            .unwrap();
        let mut seen = 0;
        let mut progress = |_: Progress| seen += 1;
        let done = copy_tree(&src, &d.join("dst"), Some(&mut progress), &RETRY_DELAYS).unwrap();
        assert_eq!((done.files, done.dirs, done.links, done.bytes), (2, 2, 1, 3001));
        assert_eq!(seen, 2);
        assert_eq!(
            fs::metadata(d.join("dst/a.txt")).unwrap().modified().unwrap(),
            old
        );
        assert_eq!(fs::read_link(d.join("dst/link")).unwrap(), Path::new("b/c"));
        let v = compare_trees(&src, &d.join("dst"), true).unwrap();
        assert!(v.ok, "{:?}", v.problems);
        assert_eq!(v.files, 2);

        fs::write(d.join("dst/b/c/d.bin"), vec![8u8; 3000]).unwrap();
        fs::write(d.join("dst/extra"), "").unwrap();
        let v = compare_trees(&src, &d.join("dst"), false).unwrap();
        assert!(!v.ok);
        assert!(v.problems.iter().any(|p| p == "b/c/d.bin: contents differ"));
        assert!(v.problems.iter().any(|p| p == "extra: not in the original"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn nothing_is_overwritten() {
        let d = scratch("excl");
        fs::create_dir_all(d.join("src")).unwrap();
        fs::create_dir_all(d.join("dst")).unwrap();
        fs::write(d.join("src/x"), "new").unwrap();
        fs::write(d.join("dst/x"), "theirs").unwrap();
        let Err(CopyError::Tree(e)) = copy_tree(&d.join("src"), &d.join("dst"), None, &[]) else {
            panic!("the copy should fail");
        };
        assert!(
            e.message
                .starts_with("1 file could not be copied: x (EEXIST: file already exists, copyfile '"),
            "{}",
            e.message
        );
        assert_eq!(fs::read_to_string(d.join("dst/x")).unwrap(), "theirs");
        fs::remove_dir_all(&d).unwrap();
    }
}
