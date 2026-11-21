//! `files.mjs` (C3): the owner's view of a server folder in the Files tool, every file, unlike the
//! assistant's text-only view in config_files.rs. It keeps that module's confinement (nothing
//! outside the server folder, links included) and undo: every edit, overwrite and delete takes a
//! copy of what it replaces first.
//!
//! While the server runs, files it holds open (active worlds, its jar, folders it loads code
//! from) are not moved, replaced or deleted. Editing text is allowed everywhere.
//!
//! No command calls this yet: `manage` (C4) and the panel (C8) will. Its behaviour is held to the
//! Node module's by test/fixtures/contracts/c3-library.json.

use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::activity::{self, Actor};
use crate::backup::{self, RestoreOptions};
use crate::config_files::{self, MANAGED_PROPS, has_drive, real_dir};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::Instance;
use crate::settings::Layout;
use crate::tar::run_tar;
use crate::{collate, control, fsx, js, jspath, props, sha1, text, time, util};

/// Past this the editor is not offered and the file downloads instead.
pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
/// A delete bigger than this asks before it copies: gzipping a whole world can take minutes.
pub const MAX_COPY_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_VISITS: usize = 50000;
/// The end of a text file too big for the editor: a log's last lines are the ones wanted.
pub const TAIL_BYTES: usize = 256 * 1024;
/// A packed log is read through; one that unpacks to more than this is left for a download.
pub const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Changes whose snapshot holds exactly them, so the Activity tool can offer Undo.
pub const UNDOABLE: [&str; 5] = [
    "file-edit",
    "file-replace",
    "file-delete",
    "config-edit",
    "world-delete",
];

fn user(msg: impl Into<String>) -> Failure {
    Failure::user(msg)
}

fn coded(msg: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: msg.into(),
        code: Some(code.into()),
    }
}

fn roots(layout: &Layout) -> Roots {
    Roots::new(&layout.data_root)
}

fn to_slash(p: &str) -> String {
    if cfg!(windows) {
        p.replace('\\', "/")
    } else {
        p.to_string()
    }
}

/// `path.posix.dirname(p)` of a relative slash path.
fn posix_dirname(p: &str) -> String {
    match p.trim_end_matches('/').rfind('/') {
        Some(0) => "/".into(),
        Some(i) => p[..i].to_string(),
        None => ".".into(),
    }
}

fn realpath(p: &Path) -> Result<String, Failure> {
    fsx::realpath(p)
        .map(|r| r.to_string_lossy().into_owned())
        .map_err(|e| Failure::io(&e, "lstat", Some(p)))
}

/// `stat.mtime.toISOString()`.
fn modified(meta: &std::fs::Metadata) -> String {
    time::iso(backup::mtime_ms(meta) as i64)
}

fn assert_link_stays_inside(base: &str, full: &Path, rel: &str) -> Result<(), Failure> {
    let Ok(real) = fsx::realpath(full) else {
        return Ok(());
    };
    if !util::is_inside(Path::new(base), &real) {
        return Err(user(format!("{rel} leads outside the server folder")));
    }
    Ok(())
}

/// What `resolvePath` answers.
#[derive(Debug)]
pub struct Resolved {
    pub base: String,
    pub full: PathBuf,
    pub rel: String,
    /// `lstat` of the target: a link is not followed.
    pub stat: Option<std::fs::Metadata>,
}

/// `resolvePath(inst, relative, { mustExist, allowRoot })`: a panel path inside the server
/// folder; `''` is the folder itself. The target is not followed if it is a link (a delete or a
/// rename acts on the link), but its parent chain is, so a linked folder leading out of the
/// server cannot be walked into.
pub fn resolve_path(
    inst: &Instance,
    relative: Option<&str>,
    must_exist: bool,
    allow_root: bool,
) -> Result<Resolved, Failure> {
    let raw = relative.unwrap_or("");
    let mut clean = js::trim(raw).replace('\\', "/");
    if clean.starts_with("./") {
        clean = clean[1..].trim_start_matches('/').to_string();
    }
    let clean = clean.trim_end_matches('/').to_string();
    if clean.contains('\0') || jspath::is_absolute(&clean) || has_drive(&clean) || clean.starts_with('/') {
        return Err(user(format!("\"{raw}\" must be a path inside the server folder")));
    }
    let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.contains(&"..") {
        return Err(user(format!("\"{raw}\" must stay inside the server folder")));
    }
    if parts.is_empty() && !allow_root {
        return Err(user("choose a file or folder inside the server folder"));
    }
    let base = real_dir(inst)?;
    let full = jspath::join_path(&base, &parts);
    let rel = parts.join("/");
    let mut existing = if parts.is_empty() {
        base.clone()
    } else {
        jspath::dirname(&full.to_string_lossy())
    };
    while !Path::new(&existing).exists() {
        existing = jspath::dirname(&existing);
    }
    if !util::is_inside(Path::new(&base), Path::new(&realpath(Path::new(&existing))?)) {
        return Err(user(format!("{rel} leads outside the server folder")));
    }
    let stat = std::fs::symlink_metadata(&full).ok();
    if must_exist && stat.is_none() {
        return Err(user(format!(
            "{} does not exist",
            if rel.is_empty() { "the server folder" } else { &rel }
        )));
    }
    Ok(Resolved {
        base,
        full,
        rel,
        stat,
    })
}

/// `FILE_NAME_BAD`: `<>:"|?*` and control characters.
fn bad_name_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20
}

/// `checkName(name)`: one file or folder name, one a file can have on every system.
pub fn check_name(name: Option<&str>) -> Result<String, Failure> {
    let n = js::trim(name.unwrap_or("")).to_string();
    if n.is_empty() || n == "." || n == ".." || n.contains('/') || n.contains('\\') {
        return Err(user("a name is one file or folder name, with no slashes"));
    }
    if n.chars().any(bad_name_char) || n.ends_with('.') || n.ends_with(' ') {
        return Err(user(format!("\"{n}\" is not a name a file can have here")));
    }
    if text::js_len(&n) > 200 {
        return Err(user("that name is too long"));
    }
    Ok(n)
}

/// `inUse(inst, running)`: the lower-cased top-level names the running server holds; nothing
/// while stopped. `libraries` and `versions` are Paper's own code.
pub fn in_use(inst: &Instance, running: bool) -> Result<Vec<String>, Failure> {
    if !running {
        return Ok(Vec::new());
    }
    let dir = backup::dir_of(inst)?;
    let pr = props::read(&jspath::join_path(&dir, &["server.properties"]))?;
    let level = match props::get(&pr, "level-name") {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => "world".into(),
    };
    let mut names = vec![
        level.clone(),
        format!("{level}_nether"),
        format!("{level}_the_end"),
        "libraries".into(),
        "versions".into(),
        "cache".into(),
    ];
    if let Some(Value::String(jar)) = inst.get("jar")
        && !jar.is_empty()
    {
        names.push(jar.split(['\\', '/']).next().unwrap_or("").to_string());
    }
    Ok(names.into_iter().map(|n| n.to_lowercase()).collect())
}

/// `/^(plugins|mods)\/[^/]+\.jar$/i`.
fn loaded_jar(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("plugins/")
        .or_else(|| lower.strip_prefix("mods/"));
    rest.is_some_and(|r| !r.contains('/') && r.len() > 4 && r.ends_with(".jar"))
}

fn top(rel: &str) -> String {
    rel.split('/').next().unwrap_or("").to_lowercase()
}

/// `assertFree(inst, rel, running, doing, { removing })`. `removing`: the path goes away, so the
/// plugins or mods folder itself counts too (it takes every jar the server loaded with it).
fn assert_free(
    layout: &Layout,
    inst: &Instance,
    rel: &str,
    running: bool,
    doing: &str,
    removing: bool,
) -> Result<(), Failure> {
    // a restore is extracting over these files; nothing else writes to them until it finishes
    let state = PathBuf::from(layout.state_file(&inst.name));
    if let Some(why) = control::restore_block(&state, &inst.name, "changing its files") {
        return Err(user(why));
    }
    if !running {
        return Ok(());
    }
    let busy = in_use(inst, true)?;
    let jar_folder = removing && matches!(rel.to_ascii_lowercase().as_str(), "plugins" | "mods");
    if busy.contains(&top(rel)) || loaded_jar(rel) || jar_folder || rel.is_empty() {
        return Err(user(format!(
            "{} is in use by the running server. Stop it first to {doing} it.",
            if rel.is_empty() { "the server folder" } else { rel }
        )));
    }
    Ok(())
}

/// One row of `listDir` and `searchNames`.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// `dir`, `file`, `link` or `other`.
    pub kind: &'static str,
    pub size: Option<u64>,
    pub modified: String,
    pub in_use: bool,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "path": self.path,
            "type": self.kind,
            "size": self.size,
            "modified": self.modified,
            "inUse": self.in_use,
        })
    }
}

fn kind_of(m: &std::fs::Metadata) -> &'static str {
    let t = m.file_type();
    if t.is_dir() {
        "dir"
    } else if t.is_file() {
        "file"
    } else if t.is_symlink() {
        "link"
    } else {
        "other"
    }
}

/// `listDir(inst, relative, { running })`: folders first, then by name as the file browser
/// sorts (numbers by value, case ignored).
pub fn list_dir(
    inst: &Instance,
    relative: Option<&str>,
    running: bool,
) -> Result<(String, Vec<Entry>), Failure> {
    let r = resolve_path(inst, relative, true, true)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let stat = r.stat.as_ref().expect("it must exist");
    let is_dir = stat.is_dir()
        || (stat.file_type().is_symlink() && std::fs::metadata(&r.full).is_ok_and(|m| m.is_dir()));
    if !is_dir {
        return Err(user(format!("{} is not a folder", r.rel)));
    }
    let busy = in_use(inst, running)?;
    let inst_real = real_dir(inst)?;
    let names = fsx::readdir_names(&r.full).map_err(|e| Failure::io(&e, "scandir", Some(&r.full)))?;
    let mut entries = Vec::new();
    for name in names {
        let p = if r.rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", r.rel)
        };
        let Ok(s) = std::fs::symlink_metadata(r.full.join(&name)) else {
            continue;
        };
        let mut kind = kind_of(&s);
        if kind == "link" {
            // a link that stays inside reads as its target; one that leaves is shown but inert
            if let Ok(target) = fsx::realpath(&r.full.join(&name))
                && util::is_inside(Path::new(&inst_real), &target)
                && let Ok(tm) = std::fs::metadata(&target)
            {
                kind = if tm.is_dir() { "dir" } else { "file" };
            }
        }
        entries.push(Entry {
            in_use: running && (busy.contains(&top(&p)) || loaded_jar(&p)),
            size: (kind == "file").then_some(s.len()),
            modified: modified(&s),
            name,
            path: p,
            kind,
        });
    }
    entries.sort_by(|a, b| {
        let (ad, bd) = (a.kind == "dir", b.kind == "dir");
        if ad != bd {
            if ad {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            collate::compare_numeric_base(&a.name, &b.name)
        }
    });
    Ok((r.rel, entries))
}

/// `versionOf(buf)`: what the editor sends back to say which text it changed.
pub fn version_of(buf: &[u8]) -> String {
    sha1::hex(buf)
}

/// What `readFile` answers: the text, or why not (`large`, `binary`) for a download instead.
#[derive(Debug, Clone, PartialEq)]
pub struct FileText {
    pub path: String,
    pub size: u64,
    pub modified: String,
    pub text: Option<String>,
    pub reason: Option<&'static str>,
    pub version: Option<String>,
}

fn stat_file(full: &Path, rel: &str) -> Result<std::fs::Metadata, Failure> {
    let s = std::fs::metadata(full).map_err(|e| Failure::io(&e, "stat", Some(full)))?;
    if !s.is_file() {
        return Err(user(format!("{rel} is not a file")));
    }
    Ok(s)
}

/// `readFile(inst, relative)`.
pub fn read_file(inst: &Instance, relative: Option<&str>) -> Result<FileText, Failure> {
    let r = resolve_path(inst, relative, true, false)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let s = stat_file(&r.full, &r.rel)?;
    let mut out = FileText {
        path: r.rel.clone(),
        size: s.len(),
        modified: modified(&s),
        text: None,
        reason: None,
        version: None,
    };
    if s.len() > MAX_EDIT_BYTES {
        out.reason = Some("large");
        return Ok(out);
    }
    let buf = std::fs::read(&r.full).map_err(|e| Failure::read(&e, &r.full))?;
    // a NUL early on means binary
    if buf[..buf.len().min(8192)].contains(&0) {
        out.reason = Some("binary");
        return Ok(out);
    }
    out.text = Some(String::from_utf8_lossy(&buf).into_owned());
    out.version = Some(version_of(&buf));
    Ok(out)
}

/// `fromWholeLine(buf)`: the text starts at a whole line (the cut lands mid-line, maybe mid-character).
fn from_whole_line(buf: &[u8]) -> &[u8] {
    match buf.iter().position(|&b| b == b'\n') {
        Some(nl) if nl < buf.len() - 1 => &buf[nl + 1..],
        _ => buf,
    }
}

enum TailError {
    TooLarge,
    Bad,
}

/// `gunzipTail(full, bytes, max)`: the last `bytes` of what a .gz unpacks to, and how much that is.
fn gunzip_tail(full: &Path, bytes: usize, max: u64) -> Result<(Vec<u8>, u64), TailError> {
    use std::io::BufRead;
    let f = std::fs::File::open(full).map_err(|_| TailError::Bad)?;
    let mut input = std::io::BufReader::new(f);
    let mut ring: std::collections::VecDeque<u8> = std::collections::VecDeque::with_capacity(bytes);
    let mut total: u64 = 0;
    let mut chunk = vec![0u8; 64 * 1024];
    // one member after another, as Node's gunzip goes on
    loop {
        let mut gz = flate2::bufread::GzDecoder::new(&mut input);
        loop {
            let n = match gz.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(TailError::Bad),
            };
            total += n as u64;
            if total > max {
                return Err(TailError::TooLarge);
            }
            ring.extend(&chunk[..n]);
            while ring.len() > bytes {
                ring.pop_front();
            }
        }
        drop(gz);
        let rest = input.fill_buf().map_err(|_| TailError::Bad)?;
        if rest.is_empty() {
            break;
        }
        if rest[0] == 0 {
            // Node's rule: a zero byte where the next member would start ends the stream, and
            // whatever follows it is not read
            break;
        }
    }
    Ok((ring.into_iter().collect(), total))
}

/// What `readTail` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Tail {
    pub path: String,
    pub size: u64,
    pub modified: String,
    pub text: Option<String>,
    pub reason: Option<&'static str>,
    /// The rest only with the text: whether this is all of it, how much is shown, of how much
    /// (the unpacked size for a packed file), and whether it was packed.
    pub whole: Option<bool>,
    pub shown: Option<usize>,
    pub of: Option<u64>,
    pub packed: Option<bool>,
}

/// `readTail(inst, relative, { bytes, maxUnpacked })`: the end of a text file too big for the
/// editor; a `.gz` (not `.tar.gz`) is read through. Read-only, so there is no version.
pub fn read_tail(
    inst: &Instance,
    relative: Option<&str>,
    bytes: usize,
    max_unpacked: u64,
) -> Result<Tail, Failure> {
    let r = resolve_path(inst, relative, true, false)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let s = stat_file(&r.full, &r.rel)?;
    let lower = r.rel.to_ascii_lowercase();
    let packed = lower.ends_with(".gz") && !lower.ends_with(".tar.gz");
    let mut out = Tail {
        path: r.rel.clone(),
        size: s.len(),
        modified: modified(&s),
        text: None,
        reason: None,
        whole: None,
        shown: None,
        of: None,
        packed: None,
    };
    let (buf, total) = if packed {
        match gunzip_tail(&r.full, bytes, max_unpacked) {
            Ok(v) => v,
            // not a gzip after all, cut short, or too big once unpacked: a download either way
            Err(TailError::TooLarge) => {
                out.reason = Some("large");
                return Ok(out);
            }
            Err(TailError::Bad) => {
                out.reason = Some("binary");
                return Ok(out);
            }
        }
    } else {
        use std::io::{Seek, SeekFrom};
        let want = s.len().min(bytes as u64);
        let mut f = std::fs::File::open(&r.full).map_err(|e| Failure::io(&e, "open", Some(&r.full)))?;
        f.seek(SeekFrom::Start(s.len() - want))
            .map_err(|e| Failure::io(&e, "read", Some(&r.full)))?;
        let mut buf = Vec::with_capacity(want as usize);
        f.take(want)
            .read_to_end(&mut buf)
            .map_err(|e| Failure::io(&e, "read", Some(&r.full)))?;
        (buf, s.len())
    };
    if buf.contains(&0) {
        out.reason = Some("binary");
        return Ok(out);
    }
    let whole = total <= buf.len() as u64;
    let shown_buf = if whole { &buf[..] } else { from_whole_line(&buf) };
    out.text = Some(String::from_utf8_lossy(shown_buf).into_owned());
    out.whole = Some(whole);
    out.shown = Some(shown_buf.len());
    out.of = Some(total);
    out.packed = Some(packed);
    Ok(out)
}

/// `imageKind(head)`: a picture a browser draws without running anything, told from the first
/// bytes (a name ending .png proves nothing about what is in it).
pub fn image_kind(head: &[u8]) -> Option<&'static str> {
    if head.len() < 12 {
        return None;
    }
    if head[0] == 0x89 && &head[1..4] == b"PNG" {
        return Some("image/png");
    }
    if head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
        return Some("image/jpeg");
    }
    if &head[..4] == b"GIF8" && (head[4] == b'7' || head[4] == b'9') && head[5] == b'a' {
        return Some("image/gif");
    }
    if &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// `imageFile(inst, relative)`: the file to stream, its size and its type.
pub fn image_file(inst: &Instance, relative: Option<&str>) -> Result<(PathBuf, u64, &'static str), Failure> {
    let r = resolve_path(inst, relative, true, false)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let s = stat_file(&r.full, &r.rel)?;
    if s.len() > MAX_IMAGE_BYTES {
        return Err(user(format!(
            "{} is {}, too big to show here. Download it to look at it.",
            r.rel,
            text::human_bytes(Some(s.len() as f64))
        )));
    }
    let mut head = Vec::with_capacity(12);
    std::fs::File::open(&r.full)
        .and_then(|f| f.take(12).read_to_end(&mut head))
        .map_err(|e| Failure::io(&e, "read", Some(&r.full)))?;
    match image_kind(&head) {
        Some(t) => Ok((r.full, s.len(), t)),
        None => Err(user(format!("{} is not a picture that can be shown here", r.rel))),
    }
}

fn inst_path(inst: &Instance, rel: &str) -> Result<PathBuf, Failure> {
    let dir = backup::dir_of(inst)?;
    let parts: Vec<&str> = rel.split('/').collect();
    Ok(jspath::join_path(&dir, &parts))
}

/// `snapshotFirst(inst, rels, label)`: a copy of what is about to change, on its own, so Backups
/// can put exactly it back. Paths that do not exist yet are skipped.
fn snapshot_first(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    rels: &[String],
    label: &str,
) -> Result<Option<String>, Failure> {
    let mut members = Vec::new();
    for r in rels {
        if inst_path(inst, r)?.exists() {
            members.push(r.clone());
        }
    }
    if members.is_empty() {
        return Ok(None);
    }
    let made = backup::create_snapshot(
        layout,
        by,
        inst,
        &backup::Options {
            scope: "files".into(),
            label: json!(label),
            members: Some(members),
            flush: false,
            change_copy: true,
            ..Default::default()
        },
    )?;
    Ok(Some(jspath::basename(&made.file)))
}

/// `fs.renameSync`'s own error.
fn rename_error(e: &std::io::Error, from: &Path, to: &Path) -> Failure {
    Failure::Internal {
        head: "Error".into(),
        message: format!(
            "{}, rename '{}' -> '{}'",
            jspath::node_error(e, "rename", None),
            from.display(),
            to.display()
        ),
        code: Some(jspath::error_code(e).0.to_string()),
    }
}

fn atomic_write(full: &Path, data: &[u8]) -> Result<(), Failure> {
    if let Some(parent) = full.parent() {
        fsx::mkdir_all(parent)?;
    }
    let tmp = PathBuf::from(format!("{}.spawnloft-{}.tmp", full.display(), std::process::id()));
    std::fs::write(&tmp, data).map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
    if let Err(e) = std::fs::rename(&tmp, full) {
        let _ = std::fs::remove_file(&tmp);
        return Err(rename_error(&e, &tmp, full));
    }
    Ok(())
}

/// What `writeFile` asks for.
#[derive(Debug, Clone, Default)]
pub struct WriteAsk {
    /// The new text; anything but a string is refused.
    pub text: Option<Value>,
    /// What `readFile` reported; a save over a file that changed since is refused.
    pub version: Option<String>,
    pub create: bool,
    /// Save even with a tab in YAML or broken JSON.
    pub force: bool,
}

/// What `writeFile` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    pub path: String,
    pub version: String,
    pub snapshot: Option<String>,
}

/// `writeFile(inst, relative, ask)`: a save over a file that changed since it was opened fails
/// with code `changed`; a tab in YAML and broken JSON fail with code `format` unless `force`.
pub fn write_file(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    relative: Option<&str>,
    ask: &WriteAsk,
) -> Result<Written, Failure> {
    let Some(Value::String(text_in)) = &ask.text else {
        return Err(user("text is required"));
    };
    let r = resolve_path(inst, relative, !ask.create, false)?;
    if ask.create && r.stat.is_some() {
        return Err(user(format!("{} already exists", r.rel)));
    }
    if ask.create {
        check_name(Some(&jspath::basename(&r.rel)))?;
    }
    if let Some(s) = &r.stat
        && !s.is_file()
    {
        return Err(user(format!("{} is not a file", r.rel)));
    }
    if text_in.len() as u64 > MAX_EDIT_BYTES {
        return Err(user(format!(
            "that would make {} over {}",
            r.rel,
            text::human_bytes(Some(MAX_EDIT_BYTES as f64))
        )));
    }
    let before_buf = match &r.stat {
        Some(_) => Some(std::fs::read(&r.full).map_err(|e| Failure::read(&e, &r.full))?),
        None => None,
    };
    if let Some(b) = &before_buf
        && ask.version.as_deref() != Some(version_of(b).as_str())
    {
        return Err(coded(
            format!(
                "{} has changed on disk since it was opened. Reload it to see the change, then make yours again.",
                r.rel
            ),
            "changed",
        ));
    }
    let before = before_buf
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned());
    // the file's own line endings and byte-order mark, which a textarea drops
    let mut after = text_in.clone();
    if let Some(b) = &before {
        if b.contains("\r\n") && !after.contains("\r\n") {
            after = after.replace('\n', "\r\n");
        }
        if b.starts_with('\u{feff}') && !after.starts_with('\u{feff}') {
            after = format!("\u{feff}{after}");
        }
    }
    if r.rel.to_lowercase() == "server.properties" {
        let was = props::parse(before.as_deref().unwrap_or(""));
        let now = props::parse(&after);
        let touched: Vec<&str> = MANAGED_PROPS
            .iter()
            .copied()
            .filter(|k| {
                js::trim(props::get(&was, k).unwrap_or("")) != js::trim(props::get(&now, k).unwrap_or(""))
            })
            .collect();
        if !touched.is_empty() {
            return Err(user(format!(
                "{} {} set by SpawnLoft at every start and would be put back. Change the port and RCON in the server's Settings instead.",
                touched.join(", "),
                if touched.len() > 1 { "are" } else { "is" }
            )));
        }
    }
    if !ask.force
        && let Err(f) = config_files::check_format(&r.rel, &after)
    {
        return Err(coded(f.message().to_string(), "format"));
    }
    let rels = if r.stat.is_some() {
        vec![r.rel.clone()]
    } else {
        Vec::new()
    };
    let snapshot = snapshot_first(layout, by, inst, &rels, "file-edit")?;
    // the copy takes a moment: a write the server made meanwhile is not clobbered
    if let Some(b) = &before_buf {
        let now = std::fs::read(&r.full).map_err(|e| Failure::read(&e, &r.full))?;
        if version_of(&now) != version_of(b) {
            return Err(user(format!(
                "{} changed while it was being copied; reload it and try again",
                r.rel
            )));
        }
    }
    atomic_write(&r.full, after.as_bytes())?;
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        if r.stat.is_some() {
            "file-edit"
        } else {
            "file-create"
        },
        Some(&r.rel),
        snapshot.as_deref(),
        true,
    );
    Ok(Written {
        path: r.rel,
        version: version_of(after.as_bytes()),
        snapshot,
    })
}

/// `makeFolder(inst, parent, name)`.
pub fn make_folder(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    parent: Option<&str>,
    name: Option<&str>,
) -> Result<String, Failure> {
    let dir = resolve_path(inst, parent, true, true)?.rel;
    let n = check_name(name)?;
    let target = if dir.is_empty() { n } else { format!("{dir}/{n}") };
    let r = resolve_path(inst, Some(&target), false, false)?;
    if r.stat.is_some() {
        return Err(user(format!("{} already exists", r.rel)));
    }
    std::fs::create_dir(&r.full).map_err(|e| Failure::io(&e, "mkdir", Some(&r.full)))?;
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "folder-create",
        Some(&r.rel),
        None,
        true,
    );
    Ok(r.rel)
}

/// What `uploadFile` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Uploaded {
    pub path: String,
    pub size: u64,
    pub snapshot: Option<String>,
}

/// `uploadFile(inst, parent, name, stream, { overwrite, running })`: written to a temporary name
/// beside the target, then renamed, so a server reading the folder never sees half a jar.
/// Replacing a file takes a copy of the old one first. A dropped folder arrives file by file
/// with its relative path ("Pack/sub/a.yml"); each segment gets the checks of a typed name.
#[allow(clippy::too_many_arguments)]
pub fn upload_file(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    parent: Option<&str>,
    name: Option<&str>,
    stream: &mut dyn Read,
    overwrite: bool,
    running: bool,
) -> Result<Uploaded, Failure> {
    let d = resolve_path(inst, parent, true, true)?;
    if !d.stat.as_ref().is_some_and(|s| s.is_dir()) {
        return Err(user(format!("{} is not a folder", d.rel)));
    }
    let raw = name.unwrap_or("").replace('\\', "/");
    let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(user("a file needs a name"));
    }
    let mut checked = Vec::new();
    for s in &segments {
        checked.push(check_name(Some(s))?);
    }
    let n = checked.join("/");
    let target = if d.rel.is_empty() {
        n
    } else {
        format!("{}/{n}", d.rel)
    };
    let r = resolve_path(inst, Some(&target), false, false)?;
    if r.stat.is_some() && !overwrite {
        return Err(coded(format!("{} already exists", r.rel), "exists"));
    }
    if let Some(s) = &r.stat
        && !s.is_file()
    {
        return Err(user(format!("{} is a folder; a file cannot replace it", r.rel)));
    }
    // adding a file is harmless to a running server; replacing one it holds open is not
    if r.stat.is_some() {
        assert_free(layout, inst, &r.rel, running, "replace", false)?;
    }
    if segments.len() > 1
        && let Some(parent) = r.full.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        let code = jspath::error_code(&e).0;
        return Err(user(format!(
            "could not make the folders for {}: {}",
            r.rel,
            if code == "ENOTDIR" || code == "EEXIST" {
                "a file is in the way".to_string()
            } else {
                jspath::node_error(&e, "mkdir", Some(parent))
            }
        )));
    }
    let tmp = PathBuf::from(format!(
        "{}.spawnloft-{}-{}.part",
        r.full.display(),
        std::process::id(),
        util::now() as u64
    ));
    let size = (|| -> Result<u64, Failure> {
        let mut out = std::fs::File::create(&tmp).map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
        std::io::copy(stream, &mut out).map_err(|e| Failure::io(&e, "write", Some(&tmp)))
    })();
    let size = match size {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    let placed = (|| -> Result<Option<String>, Failure> {
        let snapshot = if r.stat.is_some() {
            snapshot_first(layout, by, inst, std::slice::from_ref(&r.rel), "file-replace")?
        } else {
            None
        };
        std::fs::rename(&tmp, &r.full).map_err(|e| rename_error(&e, &tmp, &r.full))?;
        Ok(snapshot)
    })();
    let snapshot = match placed {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        if r.stat.is_some() {
            "file-replace"
        } else {
            "file-upload"
        },
        Some(&format!("{} ({})", r.rel, text::human_bytes(Some(size as f64)))),
        snapshot.as_deref(),
        true,
    );
    Ok(Uploaded {
        path: r.rel,
        size,
        snapshot,
    })
}

/// `sameButForCase(fromRel, toRel, names)`: a new name that differs from the old one only in
/// capitals, in a folder that does not list the new spelling itself. On a disk that ignores case
/// the "existing" file found under the new name is the one being renamed.
pub fn same_but_for_case(from_rel: &str, to_rel: &str, names: &[String]) -> bool {
    if from_rel == to_rel || from_rel.to_lowercase() != to_rel.to_lowercase() {
        return false;
    }
    let last = to_rel.rsplit('/').next().unwrap_or("");
    !names.iter().any(|n| n == last)
}

/// `movePath(inst, from, to, { running })`: rename or move; `to` is the new path from the server
/// folder. No copy is taken: the old name is the undo.
pub fn move_path(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    from: Option<&str>,
    to: Option<&str>,
    running: bool,
) -> Result<(String, String), Failure> {
    let src = resolve_path(inst, from, true, false)?;
    let dst_raw = js::trim(to.unwrap_or("")).replace('\\', "/");
    check_name(Some(dst_raw.split('/').rfind(|s| !s.is_empty()).unwrap_or("")))?;
    let dst = resolve_path(inst, Some(&dst_raw), false, false)?;
    if dst.rel == src.rel {
        return Err(user("that is its name already"));
    }
    // Windows and macOS find config.yml when asked for Config.yml: that is the file itself,
    // being given other capitals, not something in its way
    if dst.stat.is_some() {
        let dir = jspath::dirname(&dst.full.to_string_lossy());
        let names = fsx::readdir_names(Path::new(&dir))
            .map_err(|e| Failure::io(&e, "scandir", Some(Path::new(&dir))))?;
        if !same_but_for_case(&src.rel, &dst.rel, &names) {
            return Err(user(format!("{} already exists", dst.rel)));
        }
    }
    if dst
        .rel
        .to_lowercase()
        .starts_with(&format!("{}/", src.rel.to_lowercase()))
    {
        return Err(user("a folder cannot be moved inside itself"));
    }
    assert_free(layout, inst, &src.rel, running, "move", true)?;
    assert_free(layout, inst, &dst.rel, running, "move into", false)?;
    let parent = PathBuf::from(jspath::dirname(&dst.full.to_string_lossy()));
    let parent_rel = to_slash(&jspath::relative(&src.base, &parent.to_string_lossy()));
    if !parent.exists() {
        return Err(user(format!("there is no folder {parent_rel}")));
    }
    if !parent.is_dir() {
        return Err(user(format!("{parent_rel} is not a folder")));
    }
    std::fs::rename(&src.full, &dst.full).map_err(|e| rename_error(&e, &src.full, &dst.full))?;
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "file-move",
        Some(&format!("{} to {}", src.rel, dst.rel)),
        None,
        true,
    );
    Ok((src.rel, dst.rel))
}

/// `sizeOf(full)`: links not followed; an unreadable folder fails.
fn size_of(full: &Path) -> Result<u64, Failure> {
    let s = std::fs::symlink_metadata(full).map_err(|e| Failure::io(&e, "lstat", Some(full)))?;
    if !s.is_dir() {
        return Ok(s.len());
    }
    let mut total = 0;
    for name in fsx::readdir_names(full).map_err(|e| Failure::io(&e, "scandir", Some(full)))? {
        total += size_of(&full.join(name))?;
    }
    Ok(total)
}

/// What `deletePaths` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct DeletedPaths {
    pub deleted: Vec<String>,
    pub snapshot: Option<String>,
}

/// `deletePaths(inst, paths, { withoutCopy, running })`: deletes after taking a copy. Past
/// [`MAX_COPY_BYTES`] it fails with code `large` and the panel asks whether to delete without one.
pub fn delete_paths(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    paths: &[Option<&str>],
    without_copy: bool,
    running: bool,
) -> Result<DeletedPaths, Failure> {
    if paths.is_empty() {
        return Err(user("choose something to delete"));
    }
    let mut targets = Vec::new();
    for p in paths {
        targets.push(resolve_path(inst, *p, true, false)?);
    }
    for t in &targets {
        assert_free(layout, inst, &t.rel, running, "delete", true)?;
    }
    // paths a chosen parent folder already covers are dropped
    let mut unique: Vec<String> = Vec::new();
    for t in &targets {
        if !unique.contains(&t.rel) {
            unique.push(t.rel.clone());
        }
    }
    let rels: Vec<String> = unique
        .iter()
        .filter(|r| !unique.iter().any(|o| o != *r && r.starts_with(&format!("{o}/"))))
        .cloned()
        .collect();
    let mut snapshot = None;
    if !without_copy {
        let mut bytes = 0;
        for r in &rels {
            bytes += size_of(&inst_path(inst, r)?)?;
        }
        if bytes > MAX_COPY_BYTES {
            return Err(coded(
                format!(
                    "that is {}; keeping a copy first would take a while and as much space again",
                    text::human_bytes(Some(bytes as f64))
                ),
                "large",
            ));
        }
        snapshot = snapshot_first(layout, by, inst, &rels, "file-delete")?;
    }
    for r in &rels {
        backup::rm_tree(&inst_path(inst, r)?)?;
    }
    let detail = format!(
        "{}{}",
        rels.join(", "),
        if without_copy { " (no copy kept)" } else { "" }
    );
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "file-delete",
        Some(&detail),
        snapshot.as_deref(),
        true,
    );
    Ok(DeletedPaths {
        deleted: rels,
        snapshot,
    })
}

/// `archivePaths(inst, paths, name)`: a zip of things in one folder, beside them.
pub fn archive_paths(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    paths: &[Option<&str>],
    name: Option<&str>,
) -> Result<(String, u64), Failure> {
    if paths.is_empty() {
        return Err(user("choose something to archive"));
    }
    let mut targets = Vec::new();
    for p in paths {
        targets.push(resolve_path(inst, *p, true, false)?);
    }
    let dir = posix_dirname(&targets[0].rel);
    if targets.iter().any(|t| posix_dirname(&t.rel) != dir) {
        return Err(user("archive things from one folder at a time"));
    }
    let last = |rel: &str| rel.rsplit('/').next().unwrap_or("").to_string();
    let wanted = match name {
        Some(n) if !n.is_empty() => n.to_string(),
        _ if targets.len() == 1 => last(&targets[0].rel),
        _ => "archive".into(),
    };
    let mut n = check_name(Some(&wanted))?;
    if !n.to_ascii_lowercase().ends_with(".zip") {
        n.push_str(".zip");
    }
    let out_rel = if dir == "." { n } else { format!("{dir}/{n}") };
    let out = resolve_path(inst, Some(&out_rel), false, false)?;
    if out.stat.is_some() {
        return Err(user(format!("{} already exists", out.rel)));
    }
    let cwd = if dir == "." {
        out.base.clone()
    } else {
        let parts: Vec<&str> = dir.split('/').collect();
        jspath::join_path(&out.base, &parts)
            .to_string_lossy()
            .into_owned()
    };
    let tmp = PathBuf::from(format!(
        "{}.spawnloft-{}.part",
        out.full.display(),
        std::process::id()
    ));
    let names: Vec<String> = targets.iter().map(|t| last(&t.rel)).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let made = crate::zip::create(&tmp, &cwd, &refs, &[], false)
        .map(|_| ())
        .and_then(|_| std::fs::rename(&tmp, &out.full).map_err(|e| rename_error(&e, &tmp, &out.full)));
    if let Err(e) = made {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "file-zip",
        Some(&out.rel),
        None,
        true,
    );
    let size = std::fs::metadata(&out.full)
        .map_err(|e| Failure::io(&e, "stat", Some(&out.full)))?
        .len();
    Ok((out.rel, size))
}

/// `extractArchive(inst, relative, { running })`: unpacks into a new folder beside the archive,
/// never over existing files; merging is left to the person afterwards.
pub fn extract_archive(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    relative: Option<&str>,
    running: bool,
) -> Result<String, Failure> {
    let src = resolve_path(inst, relative, true, false)?;
    if !src.stat.as_ref().is_some_and(|s| s.is_file()) {
        return Err(user(format!("{} is not a file", src.rel)));
    }
    let lower = src.rel.to_lowercase();
    let kind = if lower.ends_with(".zip") || lower.ends_with(".mrpack") {
        "zip"
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        "tgz"
    } else {
        return Err(user(format!("{} is not a .zip or .tar.gz", src.rel)));
    };
    let file_name = src.rel.rsplit('/').next().unwrap_or("").to_string();
    let fl = file_name.to_ascii_lowercase();
    let stem_len = [".zip", ".mrpack", ".tar.gz", ".tgz"]
        .iter()
        .find(|e| fl.ends_with(*e))
        .map_or(file_name.len(), |e| file_name.len() - e.len());
    let stem = match &file_name[..stem_len] {
        "" => "archive".to_string(),
        s => s.to_string(),
    };
    let dir = posix_dirname(&src.rel);
    let mut target = None;
    for i in 0..100 {
        let candidate = format!(
            "{}{}",
            if dir == "." {
                String::new()
            } else {
                format!("{dir}/")
            },
            if i > 0 {
                format!("{stem} ({})", i + 1)
            } else {
                stem.clone()
            }
        );
        let parts: Vec<&str> = candidate.split('/').collect();
        if !jspath::join_path(&src.base, &parts).exists() {
            target = Some(candidate);
            break;
        }
    }
    let Some(target) = target else {
        return Err(user(format!("there are already too many folders named {stem}")));
    };
    assert_free(layout, inst, &target, running, "extract into", false)?;
    let parts: Vec<&str> = target.split('/').collect();
    let full = jspath::join_path(&src.base, &parts);
    let staging = crate::engines::mkdtemp(&jspath::join(&[
        &jspath::dirname(&full.to_string_lossy()),
        ".spawnloft-extract-",
    ]))?;
    let res = (|| -> Result<(), Failure> {
        if kind == "zip" {
            if !crate::zip::is_zip(&src.full)? {
                return Err(user(format!("{} is not a zip archive", src.rel)));
            }
            crate::zip::extract(&src.full, &staging)?;
        } else {
            let args: Vec<String> = vec![
                "-xzf".into(),
                src.full.to_string_lossy().into(),
                "-C".into(),
                staging.to_string_lossy().into(),
            ];
            let run = run_tar(&args, &staging)?;
            if run.code != 0 {
                let first = js::trim(&run.stderr)
                    .split('\n')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('\r')
                    .to_string();
                return Err(user(format!(
                    "could not unpack {}: {}",
                    src.rel,
                    if first.is_empty() {
                        format!("tar exited {}", run.code)
                    } else {
                        first
                    }
                )));
            }
        }
        std::fs::rename(&staging, &full).map_err(|e| rename_error(&e, &staging, &full))
    })();
    if let Err(e) = res {
        let _ = backup::rm_tree(&staging);
        return Err(e);
    }
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "file-unzip",
        Some(&format!("{} into {target}", src.rel)),
        None,
        true,
    );
    Ok(target)
}

/// What `searchNames` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub path: String,
    pub query: String,
    pub results: Vec<Entry>,
    pub truncated: bool,
}

/// `searchNames(inst, relative, query, { running })`: breadth first and capped, so searching a
/// large world answers quickly with what is nearest.
pub fn search_names(
    inst: &Instance,
    relative: Option<&str>,
    query: Option<&str>,
    running: bool,
) -> Result<Found, Failure> {
    let q = js::trim(query.unwrap_or("")).to_lowercase();
    if text::js_len(&q) < 2 {
        return Err(user("search for at least two characters"));
    }
    let r = resolve_path(inst, relative, true, true)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let busy = in_use(inst, running)?;
    let mut results = Vec::new();
    let mut visits = 0;
    let mut level = vec![r.full.clone()];
    while !level.is_empty() && results.len() < MAX_SEARCH_RESULTS && visits < MAX_SEARCH_VISITS {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = fsx::readdir_typed(dir) else {
                continue;
            };
            for (name, t) in entries {
                visits += 1;
                if visits > MAX_SEARCH_VISITS || results.len() >= MAX_SEARCH_RESULTS {
                    break;
                }
                let abs = dir.join(&name);
                let p = to_slash(&jspath::relative(&r.base, &abs.to_string_lossy()));
                if name.to_lowercase().contains(&q) {
                    let Ok(s) = std::fs::symlink_metadata(&abs) else {
                        continue;
                    };
                    results.push(Entry {
                        in_use: running && busy.contains(&top(&p)),
                        kind: if s.is_dir() { "dir" } else { "file" },
                        size: s.is_file().then_some(s.len()),
                        modified: modified(&s),
                        name: name.clone(),
                        path: p,
                    });
                }
                if t.is_dir() {
                    next.push(abs);
                }
            }
        }
        level = next;
    }
    Ok(Found {
        path: r.rel,
        query: q,
        truncated: results.len() >= MAX_SEARCH_RESULTS || visits >= MAX_SEARCH_VISITS,
        results,
    })
}

/// `undoSnapshot(inst, snapshotName, { running })`: the Activity tool's Undo. Only a copy of named
/// files or folders qualifies; a whole-server backup is a restore. Unlike a restore it works
/// while the server runs, provided nothing it puts back is held open.
pub fn undo_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    snapshot_name: &str,
    running: bool,
) -> Result<(String, Vec<String>), Failure> {
    let snap = backup::resolve_snapshot(layout, &inst.name, snapshot_name)?;
    let members: Vec<String> = match &snap.members {
        Value::Array(a) => a.iter().map(|m| js::string(Some(m)).replace('\\', "/")).collect(),
        Value::Null => Vec::new(),
        _ => {
            return Err(Failure::type_error("(snap.members ?? []).map is not a function"));
        }
    };
    // a config edit is copied as scope config labelled before-edit; a config backup the owner
    // made of a single file is still a backup, not an undo
    let narrowed = snap.scope == json!("files")
        || (snap.scope == json!("config") && snap.label == json!("before-edit") && members.len() == 1);
    let has_dbs = match &snap.databases {
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => !s.is_empty(),
        _ => false,
    };
    if !narrowed || members.is_empty() || has_dbs {
        return Err(user(format!(
            "{} is a backup of the server, not a copy of one change. Restore it from Backups, with the server stopped.",
            snap.name
        )));
    }
    for m in &members {
        assert_free(layout, inst, m, running, "put back", false)?;
    }
    backup::restore_snapshot(
        layout,
        by,
        inst,
        &snap,
        RestoreOptions {
            quiet: true,
            keep_copy: false,
            ..Default::default()
        },
    )?;
    activity::record_by(
        &roots(layout),
        by,
        &inst.name,
        "undo",
        Some(&members.join(", ")),
        Some(&snap.name),
        true,
    );
    Ok((snap.name, members))
}

/// What `downloadable` answers: a file as itself, a folder zipped to a temporary file first.
/// Call [`Download::done`] once it has been sent.
#[derive(Debug)]
pub struct Download {
    pub file: PathBuf,
    pub name: String,
    pub size: u64,
    temp_dir: Option<PathBuf>,
}

impl Download {
    pub fn done(&self) {
        if let Some(d) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// `downloadable(inst, relative)`.
pub fn downloadable(inst: &Instance, relative: Option<&str>) -> Result<Download, Failure> {
    let r = resolve_path(inst, relative, true, false)?;
    assert_link_stays_inside(&r.base, &r.full, &r.rel)?;
    let stat = r.stat.expect("it must exist");
    let real = if stat.file_type().is_symlink() {
        std::fs::metadata(&r.full).map_err(|e| Failure::io(&e, "stat", Some(&r.full)))?
    } else {
        stat
    };
    let last = r.rel.rsplit('/').next().unwrap_or("").to_string();
    if real.is_file() {
        return Ok(Download {
            file: r.full,
            name: last,
            size: real.len(),
            temp_dir: None,
        });
    }
    if !real.is_dir() {
        return Err(user(format!("{} cannot be downloaded", r.rel)));
    }
    let tmp_dir = crate::engines::mkdtemp(&jspath::join(&[&util::os_tmpdir(), "spawnloft-dl-"]))?;
    let name = format!("{last}.zip");
    let file = tmp_dir.join(&name);
    let full_text = r.full.to_string_lossy().into_owned();
    let member = jspath::basename(&full_text);
    if let Err(e) = crate::zip::create(&file, &jspath::dirname(&full_text), &[&member], &[], false) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }
    let size = std::fs::metadata(&file)
        .map_err(|e| Failure::io(&e, "stat", Some(&file)))?
        .len();
    Ok(Download {
        file,
        name,
        size,
        temp_dir: Some(tmp_dir),
    })
}

#[cfg(test)]
#[path = "files_contract.rs"]
mod contract;
