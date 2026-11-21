//! `data-move.mjs`: moving the data folder and leaving a link at the old path.
//!
//! The link is a junction on Windows, which needs no elevation, and a symlink elsewhere. The
//! registry, database configs, task shims and systemd units all store absolute paths, so the link
//! keeps them valid without rewriting anything. It also escapes Windows' private AppData copies
//! (see private_copy.rs).
//!
//! Same drive: a single atomic rename. Another drive: copy, compare, then rename the original to
//! a parked name beside the link. The move never deletes the original; [`finish_move`] does that
//! later. Between the rename and [`make_link`] there is no folder at the old path (two adjacent
//! calls): nothing may touch the data root in that gap or it would be recreated empty where the
//! link goes.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::private_copy::PrivateCopy;
use crate::tree::{self, CopyError, Progress};
use crate::{jsdate, jsjson, jspath, text};

/// `journalPath(root)`: `<root>.move.json` beside the data folder.
pub fn journal_path(root: &str) -> String {
    format!("{}.move.json", jspath::resolve(root))
}

/// `stamp(when)`: the ISO time with `:` and `.` made `-`, for a file name.
fn stamp(ms: f64) -> String {
    jsdate::to_iso(ms).unwrap_or_default().replace([':', '.'], "-")
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

fn same(a: &str, b: &str) -> bool {
    let (a, b) = (jspath::normalize(a), jspath::normalize(b));
    if cfg!(windows) {
        // a junction Node made reads back with a trailing `\` (libuv adds one), one made here
        // without: both name the same folder
        let bare = |p: &str| {
            let t = p.trim_end_matches(['\\', '/']);
            if t.is_empty() || t.ends_with(':') {
                p.to_lowercase()
            } else {
                t.to_lowercase()
            }
        };
        bare(&a) == bare(&b)
    } else {
        a == b
    }
}

fn trimmed(p: &str) -> String {
    jspath::normalize(p).trim_end_matches(['\\', '/']).to_string()
}

fn inside(parent: &str, child: &str) -> bool {
    let rel = jspath::relative(parent, child);
    rel.is_empty() || (!rel.starts_with("..") && !jspath::is_absolute(&rel))
}

/// `path.parse(p).root`.
fn parse_root(p: &str) -> String {
    if cfg!(windows) {
        let b = p.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            let sep = b.get(2).is_some_and(|c| *c == b'\\' || *c == b'/');
            return p[..if sep { 3 } else { 2 }].to_string();
        }
        if b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/') {
            // \\server\share\
            let rest = &p[2..];
            let mut parts = rest.splitn(3, ['\\', '/']);
            let server = parts.next().unwrap_or("");
            let share = parts.next();
            return match share {
                Some(share) if !server.is_empty() && !share.is_empty() => {
                    let base = 2 + server.len() + 1 + share.len();
                    p[..(base + 1).min(p.len())].to_string()
                }
                _ => p[..2].to_string(),
            };
        }
        if matches!(b.first(), Some(b'\\' | b'/')) {
            return p[..1].to_string();
        }
        return String::new();
    }
    if p.starts_with('/') {
        "/".into()
    } else {
        String::new()
    }
}

/// What a path is, links not followed (`describeLink`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkInfo {
    pub exists: bool,
    pub is_link: bool,
    /// a folder (for something that is not a link)
    pub is_directory: bool,
    /// where a link leads, as stored; `None` when it cannot be read
    pub target: Option<String>,
    /// a link whose target is not there
    pub dangling: bool,
}

/// `fs.readlinkSync(p)` as Node gives it: a junction's target without the `\\?\` the system
/// keeps on it.
fn read_link_text(p: &Path) -> Option<String> {
    let t = std::fs::read_link(p).ok()?.to_string_lossy().into_owned();
    if cfg!(windows)
        && let Some(rest) = t.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return Some(rest.to_string());
    }
    Some(t)
}

pub fn describe_link(p: &str) -> LinkInfo {
    let Ok(m) = std::fs::symlink_metadata(p) else {
        return LinkInfo::default();
    };
    if !m.file_type().is_symlink() && !is_junction(&m) {
        return LinkInfo {
            exists: true,
            is_directory: m.is_dir(),
            ..LinkInfo::default()
        };
    }
    LinkInfo {
        exists: true,
        is_link: true,
        is_directory: false,
        target: read_link_text(Path::new(p)),
        dangling: std::fs::metadata(p).is_err(),
    }
}

/// A junction is a link to Node (`lstat` says so); Rust's file type calls it a folder.
#[cfg(windows)]
fn is_junction(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 && m.is_dir()
}

#[cfg(not(windows))]
fn is_junction(_m: &std::fs::Metadata) -> bool {
    false
}

/// `makeLink(target, at)`: a junction on Windows, a folder symlink elsewhere, to the absolute target.
pub fn make_link(target: &str, at: &str) -> Result<(), Failure> {
    let full = jspath::resolve(target);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&full, at);
    #[cfg(windows)]
    let made = crate::platform::make_junction(Path::new(&full), Path::new(at));
    made.map_err(|e| io2(&e, "symlink", &full, at))
}

/// `removeLink(at)`: refuses a path that isn't a link, since that would delete data.
pub fn remove_link(at: &str) -> Result<(), Failure> {
    if !describe_link(at).is_link {
        return Err(Failure::user(format!(
            "{at} is not a link, so it was not removed"
        )));
    }
    crate::manage::rm_rf(Path::new(at))
}

fn io2(e: &std::io::Error, syscall: &str, a: &str, b: &str) -> Failure {
    Failure::Internal {
        head: "Error".into(),
        message: tree::node_message2(e, syscall, Path::new(a), Path::new(b)),
        code: Some(jspath::error_code(e).0.to_string()),
    }
}

fn io1(e: &std::io::Error, syscall: &str, p: &str) -> Failure {
    Failure::io(e, syscall, Some(Path::new(p)))
}

fn busy_code(e: &std::io::Error) -> Option<&'static str> {
    let c = jspath::error_code(e).0;
    matches!(c, "EBUSY" | "EPERM" | "EACCES").then_some(c)
}

/// `renameFolder`: Windows fails a folder rename while any file inside is open (the app's logs,
/// a scanner), so it is retried briefly and then reported as that.
fn rename_folder(from: &str, to: &str) -> Result<(), Failure> {
    const DELAYS: [u64; 3] = [100, 300, 900];
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if let Some(code) = busy_code(&e) {
                    if attempt < DELAYS.len() {
                        std::thread::sleep(Duration::from_millis(DELAYS[attempt]));
                        attempt += 1;
                        continue;
                    }
                    return Err(Failure::user(format!(
                        "{from} could not be renamed ({code}): something still has a file in it open. Close the SpawnLoft app and any program using the data folder, then try again"
                    )));
                }
                return Err(io2(&e, "rename", from, to));
            }
        }
    }
}

/// `isSkeleton(dir)`: a folder tree holding no files, only the empty folders a command can
/// leave behind.
fn is_skeleton(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    for e in rd {
        let Ok(e) = e else { return false };
        if !e.file_type().is_ok_and(|t| t.is_dir()) || !is_skeleton(&e.path()) {
            return false;
        }
    }
    true
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

fn nearest_existing(p: &str) -> String {
    let mut here = jspath::resolve(p);
    while !exists(&here) {
        let up = jspath::dirname(&here);
        if up == here {
            break;
        }
        here = up;
    }
    here
}

/// `writable(dir)`: `None`, or Node's message for why a file cannot be written there.
fn writable(dir: &str) -> Option<String> {
    let probe = jspath::join(&[dir, &format!(".spawnloft-write-test-{}", std::process::id())]);
    match std::fs::write(&probe, "ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            None
        }
        Err(e) => Some(jspath::node_error(&e, "open", Some(Path::new(&probe)))),
    }
}

/// A scheduled task as the move pauses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRef {
    pub id: String,
}

/// The environment around a move (running servers, tasks, locks), so tests can replace it.
pub trait Env {
    fn running(&self) -> Result<Vec<String>, Failure>;
    fn enabled_tasks(&self) -> Result<Vec<TaskRef>, Failure>;
    fn set_enabled(&self, id: &str, on: bool) -> Result<(), Failure>;
    fn held_locks(&self) -> Result<Vec<String>, Failure>;
    fn private_copies(&self) -> Vec<PrivateCopy>;
    /// milliseconds since the epoch
    fn now(&self) -> f64;
}

/// The real environment: this layout's registry, run folder, backups and scheduler.
#[allow(missing_debug_implementations)]
pub struct RealEnv<'a> {
    pub layout: &'a crate::settings::Layout,
    pub sched: &'a crate::schedule::Sched,
}

impl RealEnv<'_> {
    /// An unreadable registry is a failure, as in Node: "no servers" would let the folder move
    /// under a live one.
    fn servers(&self) -> Result<Vec<crate::registry::Instance>, Failure> {
        Ok(crate::registry::list_all(Path::new(&self.layout.registry_file))?
            .into_iter()
            .filter(|i| !crate::js::truthy(i.get("external")))
            .collect())
    }
}

impl Env for RealEnv<'_> {
    fn running(&self) -> Result<Vec<String>, Failure> {
        let mut busy = Vec::new();
        for i in self.servers()? {
            // an unreadable state file fails, as in Node, rather than reading as stopped
            let (status, _) = crate::control::read_state(Path::new(&self.layout.state_file(&i.name)))?;
            if crate::control::is_active_status(status) {
                busy.push(i.name);
            }
        }
        Ok(busy)
    }
    fn enabled_tasks(&self) -> Result<Vec<TaskRef>, Failure> {
        Ok(self
            .sched
            .list()?
            .into_iter()
            .filter(|t| crate::js::truthy(t.get("enabled")))
            .map(|t| TaskRef {
                id: crate::js::string(t.get("id")),
            })
            .collect())
    }
    fn set_enabled(&self, id: &str, on: bool) -> Result<(), Failure> {
        self.sched.set_enabled(id, on).map(|_| ())
    }
    fn held_locks(&self) -> Result<Vec<String>, Failure> {
        // a starting server reads as stopped until its daemon publishes state, and a backup of a
        // stopped server never shows as running; only their locks reveal them
        let mut held = Vec::new();
        let held_at = |p: String| crate::lock::holder(Path::new(&p)).is_some();
        if held_at(format!("{}.lock", self.layout.registry_file)) {
            held.push("the server registry (being changed)".to_string());
        }
        for i in self.servers()? {
            if held_at(jspath::join(&[&self.layout.run_dir_of(&i.name), "start.lock"])) {
                held.push(format!("{} (being started)", i.name));
            }
            if held_at(jspath::join(&[
                &self.layout.backups_dir,
                &i.name,
                ".snapshot.lock",
            ])) {
                held.push(format!("{} (being backed up)", i.name));
            }
        }
        Ok(held)
    }
    fn private_copies(&self) -> Vec<PrivateCopy> {
        crate::private_copy::find(&crate::private_copy::Where::here(self.layout))
    }
    fn now(&self) -> f64 {
        crate::time::now_ms() as f64
    }
}

/// `sortPrivateCopies`: blockers (they hold data found nowhere else) and shadows (they only get
/// in the way).
fn sort_private_copies(copies: &[PrivateCopy]) -> (Vec<String>, Vec<String>) {
    let mut blockers = Vec::new();
    let mut shadows = Vec::new();
    for copy in copies {
        let Some(dir) = &copy.dir else { continue };
        let mut found = Vec::new();
        let a = copy.backups.archives as usize;
        if a > 0 {
            found.push(format!(
                "{a} {} ({}) that {} only there",
                plural(a, "backup", "backups"),
                text::human_bytes(Some(copy.backups.bytes as f64)),
                plural(a, "exists", "exist")
            ));
        }
        let only = &copy.registry.only_in_copy;
        if !only.is_empty() {
            found.push(format!(
                "{} {} ({}) that {} only there",
                only.len(),
                plural(only.len(), "server", "servers"),
                only.join(", "),
                plural(only.len(), "exists", "exist")
            ));
        }
        if copy.instance_files > 0 {
            found.push("files from servers' folders".to_string());
        }
        if found.is_empty() {
            shadows.push(dir.clone());
        } else {
            blockers.push(format!(
                "{} keeps a copy of the data folder at {dir} holding {}. Moving the folder would hide them; run `spawnloft doctor` for what to copy out first",
                copy.package,
                found.join(" and ")
            ));
        }
    }
    (blockers, shadows)
}

/// What a move would do, and what stops it.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub from: String,
    pub to: String,
    /// `rename` or `copy`
    pub mode: &'static str,
    pub dest_existed: bool,
    pub stats: Option<tree::Stats>,
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
    pub pause_tasks: Vec<String>,
    pub aside_private: Vec<String>,
    pub ok: bool,
}

/// `readJson(file, null)`: `None` when missing; a file that is not JSON fails as `JSON.parse`.
fn read_journal(file: &str) -> Result<Option<Value>, Failure> {
    match std::fs::read(file) {
        Ok(b) => jsjson::parse(&String::from_utf8_lossy(&b))
            .map(Some)
            .map_err(Failure::syntax),
        Err(e) if jspath::is_enoent(&e) => Ok(None),
        Err(e) => Err(Failure::read(&e, Path::new(file))),
    }
}

fn tree_io(e: &std::io::Error, root: &str) -> Failure {
    io1(e, "scandir", root)
}

/// `planMove`: changes nothing. `problems` stop the move, `warnings` are for information.
/// Everything checkable is checked up front because a move that fails halfway is expensive.
pub fn plan_move(
    root: &str,
    dest: &str,
    force_copy: bool,
    set_aside_private: bool,
    env: &dyn Env,
) -> Result<Plan, Failure> {
    let mut problems = Vec::new();
    let mut warnings = Vec::new();
    let from = jspath::resolve(root);
    let to = jspath::resolve(dest);

    let here = describe_link(&from);
    if !here.exists {
        problems.push(format!("there is no data folder at {from}"));
    } else if here.is_link {
        problems.push(format!(
            "{from} is already a link{}, so the data has been moved; `spawnloft data status` says where it is",
            here.target.as_ref().map(|t| format!(" to {t}")).unwrap_or_default()
        ));
    } else if !here.is_directory {
        problems.push(format!("{from} is not a folder"));
    }
    let jp = journal_path(&from);
    if exists(&jp)
        && let Some(earlier) = read_journal(&jp)?
        && crate::js::truthy(Some(&earlier))
        && earlier.get("step").and_then(Value::as_str) != Some("done")
    {
        problems.push(format!(
            "an earlier move was interrupted at \"{}\"; `spawnloft data rollback` puts everything back, and then this can be run again",
            crate::js::string(earlier.get("step"))
        ));
    }
    if same(&from, &to) {
        problems.push("that is the data folder already".into());
    } else if inside(&from, &to) {
        problems.push(format!("{to} is inside the folder being moved"));
    } else if inside(&to, &from) {
        problems.push(format!(
            "the data folder is inside {to}, which would have to be emptied first"
        ));
    }
    let root_of = parse_root(&to);
    if root_of == to || trimmed(&root_of) == trimmed(&to) {
        problems.push(format!("{to} is a whole drive; choose a folder on it"));
    }
    let unc = to.len() >= 2 && to.as_bytes()[..2].iter().all(|c| matches!(c, b'\\' | b'/'));
    if cfg!(windows) && unc {
        problems.push(format!(
            "{to} is a network location; a link cannot lead to one, so the data cannot live there"
        ));
    }

    // the destination must be absent or an empty folder; never merged into
    let existed = exists(&to);
    if existed {
        let kind = describe_link(&to);
        if kind.is_link || !kind.is_directory {
            problems.push(format!("{to} exists and is not a folder"));
        } else if std::fs::read_dir(&to)
            .map_err(|e| io1(&e, "scandir", &to))?
            .next()
            .is_some()
        {
            problems.push(format!(
                "{to} is not empty; choose a folder that is new, or empty"
            ));
        }
    }
    let probe_in = if existed {
        to.clone()
    } else {
        nearest_existing(&to)
    };
    let cannot_write = if exists(&probe_in) && describe_link(&probe_in).is_directory {
        writable(&probe_in)
    } else {
        Some(format!("{probe_in} is not a folder"))
    };
    if let Some(why) = cannot_write {
        problems.push(format!("cannot write to {probe_in} ({why})"));
    }

    let same_drive = matches!(
        (
            crate::platform::device_of(Path::new(&from)),
            crate::platform::device_of(Path::new(&nearest_existing(&to)))
        ),
        (Some(a), Some(b)) if a == b
    );
    let mode = if !same_drive || force_copy {
        "copy"
    } else {
        "rename"
    };

    let mut stats = None;
    if here.exists && !here.is_link && here.is_directory {
        let s = tree::tree_stats(Path::new(&from)).map_err(|e| tree_io(&e, &from))?;
        if s.other > 0 {
            let n = s.other as usize;
            warnings.push(format!(
                "{n} {} in the data folder {} neither {} and will not be copied",
                plural(n, "item", "items"),
                plural(n, "is", "are"),
                plural(n, "a file, folder nor link", "files, folders or links")
            ));
        }
        if mode == "copy" {
            match crate::platform::free_bytes(Path::new(&nearest_existing(&to))) {
                Some(available) => {
                    let needed = (s.bytes as f64 * 1.05).ceil() + 256.0 * 1024.0 * 1024.0;
                    if (available as f64) < needed {
                        problems.push(format!(
                            "{to} needs about {} free for the copy and has {}",
                            text::human_bytes(Some(needed)),
                            text::human_bytes(Some(available as f64))
                        ));
                    }
                }
                None => warnings.push("could not tell how much room there is at the new place".into()),
            }
        }
        stats = Some(s);
    }

    // nothing may be running: a database or world can't be copied or renamed while being written
    let busy = env.running()?;
    if !busy.is_empty() {
        problems.push(format!(
            "{} {} running; stop {} first (`spawnloft stop <name>`)",
            busy.join(", "),
            plural(busy.len(), "is", "are"),
            plural(busy.len(), "it", "them")
        ));
    }
    // a start or backup in progress doesn't show as running, but holds a lock
    let locked = env.held_locks()?;
    if !locked.is_empty() {
        problems.push(format!(
            "{} {} in use right now; wait for {} to finish and try again",
            locked.join(", "),
            plural(locked.len(), "is", "are"),
            plural(locked.len(), "it", "them")
        ));
    }

    // tasks are paused so none starts a server or backup mid-move
    let mut pause_tasks = Vec::new();
    match env.enabled_tasks() {
        Ok(t) => pause_tasks = t.into_iter().map(|t| t.id).collect(),
        Err(e) => warnings.push(format!(
            "could not read the scheduled tasks ({}); any that fire during the move are not paused",
            e.message()
        )),
    }
    if !pause_tasks.is_empty() {
        let n = pause_tasks.len();
        warnings.push(format!(
            "{n} scheduled {} will be paused for the move and switched back on after",
            plural(n, "task", "tasks")
        ));
    }

    // a private copy would hide the link from the program that has it
    let mut aside_private = Vec::new();
    let copies = env.private_copies();
    if !copies.is_empty() {
        let (blockers, shadows) = sort_private_copies(&copies);
        problems.extend(blockers);
        if !shadows.is_empty() {
            if set_aside_private {
                warnings.push(format!(
                    "{} of the data folder will be renamed so the link is what that program sees: {}",
                    if shadows.len() == 1 {
                        "a private copy".to_string()
                    } else {
                        format!("{} private copies", shadows.len())
                    },
                    shadows.join(", ")
                ));
                aside_private = shadows;
            } else {
                problems.push(format!(
                    "a program installed as a package keeps a private copy of the data folder, {}, which would hide the link from that program; rerun with --set-aside-private-copies to rename it (nothing in it is deleted)",
                    shadows.join(", ")
                ));
            }
        }
        warnings.push("run this from a terminal or the app, not from a program installed as a package: it would be reading the private copy as if it were the data".into());
    }
    warnings.push("close the SpawnLoft app first; it keeps log files in the data folder, and a folder with a file open cannot be moved".into());

    let ok = problems.is_empty();
    Ok(Plan {
        from,
        to,
        mode,
        dest_existed: existed,
        stats,
        problems,
        warnings,
        pause_tasks,
        aside_private,
        ok,
    })
}

/// The journal, written before each step so an interrupted move can be put back.
struct Journal {
    file: String,
    doc: Map<String, Value>,
}

impl Journal {
    fn save(&mut self, patch: &[(&str, Value)]) -> Result<(), Failure> {
        for (k, v) in patch {
            self.doc.insert((*k).to_string(), v.clone());
        }
        // a journal holds no secret, so the protection's answer does not matter
        let _ = crate::fsx::write_json_node(
            Path::new(&self.file),
            &Value::Object(self.doc.clone()),
            None,
            false,
        )?;
        Ok(())
    }
    fn text(&self, k: &str) -> Option<String> {
        self.doc.get(k).and_then(Value::as_str).map(str::to_string)
    }
}

fn text_of(j: &Map<String, Value>, k: &str) -> Option<String> {
    j.get(k).and_then(Value::as_str).map(str::to_string)
}

/// `undoMove(journal)`: never deletes the original; deletes the copy only once the original is
/// back. Returns the notes for what could not be put back.
pub fn undo_move(journal: &Map<String, Value>, env: &dyn Env) -> Result<Vec<String>, Failure> {
    let mut notes = Vec::new();
    let from = text_of(journal, "from").unwrap_or_default();
    let to = text_of(journal, "to").unwrap_or_default();
    let parked = text_of(journal, "parked");
    let mode = text_of(journal, "mode").unwrap_or_default();
    let dest_existed = crate::js::truthy(journal.get("destExisted"));
    let mut at = describe_link(&from);
    if at.is_link {
        if at.target.as_ref().is_some_and(|t| same(t, &to)) {
            remove_link(&from)?;
        } else {
            notes.push(format!(
                "{from} is a link to {}, not to {to}, so it was left",
                at.target.as_deref().unwrap_or("null")
            ));
        }
        at = describe_link(&from);
    }
    // A command run meanwhile may have recreated empty folders where the link was to go. Clear
    // them only when the data is known to be elsewhere; an empty original (fresh install) stays.
    let parked_there = parked.as_ref().is_some_and(|p| exists(p));
    let data_elsewhere = parked_there || (mode == "rename" && exists(&to) && !is_skeleton(Path::new(&to)));
    if at.exists && !at.is_link && at.is_directory && data_elsewhere && is_skeleton(Path::new(&from)) {
        tree::remove_tree(Path::new(&from))?;
        at = describe_link(&from);
    }
    if !at.exists {
        if let Some(p) = parked.as_ref().filter(|p| exists(p)) {
            rename_folder(p, &from)?;
        } else if mode == "rename" && exists(&to) {
            rename_folder(&to, &from)?;
        }
    }
    // a destination that was an empty folder stays one
    if mode == "rename" && dest_existed && !exists(&to) {
        crate::fsx::mkdir_all(Path::new(&to))?;
    }
    let home = describe_link(&from);
    let step = text_of(journal, "step");
    if mode == "copy" && home.exists && !home.is_link && exists(&to) && step.as_deref() != Some("done") {
        // the original is home, so remove what the move made
        if dest_existed {
            for name in crate::fsx::readdir_names(Path::new(&to)).map_err(|e| io1(&e, "scandir", &to))? {
                tree::remove_tree(Path::new(&jspath::join(&[&to, &name])))?;
            }
        } else {
            tree::remove_tree(Path::new(&to))?;
        }
    } else if mode == "copy" && !(home.exists && !home.is_link) {
        notes.push(format!(
            "the original could not be put back at {from}; the copy at {to} was left"
        ));
    }
    if let Some(Value::Array(ids)) = journal.get("pausedTasks") {
        for id in ids {
            let id = crate::js::string(Some(id));
            if let Err(e) = env.set_enabled(&id, true) {
                notes.push(format!(
                    "scheduled task {id} could not be switched back on ({})",
                    e.message()
                ));
            }
        }
    }
    Ok(notes)
}

/// `probeLink(from, to)`: the link leads to `to`, and a write through it arrives there.
fn probe_link(from: &str, to: &str) -> Result<(), Failure> {
    if !describe_link(from).is_link {
        return Err(Failure::user(format!("{from} is not a link")));
    }
    let real = |p: &str| {
        crate::fsx::realpath(Path::new(p))
            .map(|r| r.to_string_lossy().into_owned())
            .map_err(|e| io1(&e, "realpath", p))
    };
    if !same(&real(from)?, &real(to)?) {
        return Err(Failure::user(format!("the link at {from} does not lead to {to}")));
    }
    let name = format!(".spawnloft-move-probe-{}", std::process::id());
    let through = jspath::join(&[from, &name]);
    std::fs::write(&through, "probe").map_err(|e| io1(&e, "open", &through))?;
    let checked = (|| {
        let arrived = jspath::join(&[to, &name]);
        if !exists(&arrived) {
            return Err(Failure::user(format!(
                "a file written through the link at {from} did not arrive in {to}"
            )));
        }
        let text = std::fs::read(&arrived).map_err(|e| Failure::read(&e, Path::new(&arrived)))?;
        if String::from_utf8_lossy(&text) != "probe" {
            return Err(Failure::user(
                "a file written through the link was changed on the way",
            ));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&through);
    checked?;
    let registry = |dir: &str| std::fs::read(jspath::join(&[dir, "instances.json"])).ok();
    if registry(from) != registry(to) {
        return Err(Failure::user(
            "the registry reads differently through the link than in the new folder",
        ));
    }
    Ok(())
}

/// What a finished move did.
#[derive(Debug, Clone, PartialEq)]
pub struct Moved {
    pub from: String,
    pub to: String,
    pub mode: &'static str,
    pub parked: Option<String>,
    /// `{ from, to }` of each private copy set aside
    pub private_aside: Vec<(String, String)>,
    pub notes: Vec<String>,
    pub seconds: f64,
}

/// A step that failed inside the move, with the problems of a copy or a check.
struct StepError {
    message: String,
    problems: Vec<String>,
}

impl From<Failure> for StepError {
    fn from(f: Failure) -> StepError {
        StepError {
            message: f.message().to_string(),
            problems: Vec::new(),
        }
    }
}

/// `moveData`: the plan, and with `dry_run` false and a clean plan, the move. Any failure undoes
/// it (original put back, copy removed, tasks switched back on).
#[allow(clippy::too_many_arguments)]
pub fn move_data(
    root: &str,
    dest: &str,
    dry_run: bool,
    thorough: bool,
    force_copy: bool,
    set_aside_private: bool,
    on_step: &mut dyn FnMut(&str),
    on_progress: Option<&mut dyn FnMut(Progress)>,
    env: &dyn Env,
) -> Result<(Plan, Option<Moved>), Failure> {
    let plan = plan_move(root, dest, force_copy, set_aside_private, env)?;
    if dry_run || !plan.ok {
        return Ok((plan, None));
    }
    let started = env.now();
    let mut j = Journal {
        file: journal_path(&plan.from),
        doc: match json!({
            "version": 1,
            "from": plan.from,
            "to": plan.to,
            "mode": plan.mode,
            "step": "started",
            "destExisted": plan.dest_existed,
            "parked": null,
            "pausedTasks": [],
            "privateAside": [],
            "startedAt": jsdate::to_iso(started),
        }) {
            Value::Object(m) => m,
            _ => Map::new(),
        },
    };
    j.save(&[])?;
    let mut notes = Vec::new();
    let result = run_move(
        &plan,
        &mut j,
        thorough,
        started,
        on_step,
        on_progress,
        &mut notes,
        env,
    );
    if let Err(err) = result {
        let undone = match undo_move(&j.doc, env) {
            Ok(n) => n,
            Err(undo) => vec![format!(
                "putting things back failed ({}); `spawnloft data rollback` tries again",
                undo.message()
            )],
        };
        let stuck = undone
            .iter()
            .any(|n| n.contains("failed") || n.contains("could not be put back"));
        if !stuck {
            let _ = crate::manage::rm_rf(Path::new(&j.file));
        }
        let detail: Vec<String> = std::iter::once(err.message)
            .chain(err.problems.iter().take(5).map(|p| format!("  {p}")))
            .chain(undone)
            .collect();
        return Err(Failure::user(format!(
            "the move did not complete and {}:\n{}",
            if stuck {
                "could not be fully undone"
            } else {
                "was undone"
            },
            detail.join("\n")
        )));
    }
    let seconds = ((env.now() - started) / 100.0).round() / 10.0;
    let private_aside = match j.doc.get("privateAside") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| (crate::js::string(v.get("from")), crate::js::string(v.get("to"))))
            .collect(),
        _ => Vec::new(),
    };
    Ok((
        plan.clone(),
        Some(Moved {
            from: plan.from,
            to: plan.to,
            mode: plan.mode,
            parked: j.text("parked"),
            private_aside,
            notes,
            seconds,
        }),
    ))
}

#[allow(clippy::too_many_arguments)]
fn run_move(
    plan: &Plan,
    j: &mut Journal,
    thorough: bool,
    started: f64,
    on_step: &mut dyn FnMut(&str),
    on_progress: Option<&mut dyn FnMut(Progress)>,
    notes: &mut Vec<String>,
    env: &dyn Env,
) -> Result<(), StepError> {
    let mut paused = Vec::new();
    for id in &plan.pause_tasks {
        env.set_enabled(id, false)?;
        paused.push(Value::String(id.clone()));
        j.doc.insert("pausedTasks".into(), Value::Array(paused.clone()));
    }
    j.save(&[])?;

    if plan.mode == "rename" {
        on_step("moving");
        j.save(&[("step", json!("moving"))])?;
        if plan.dest_existed {
            std::fs::remove_dir(&plan.to).map_err(|e| io1(&e, "rmdir", &plan.to))?;
        }
        crate::fsx::mkdir_all(Path::new(&jspath::dirname(&plan.to)))?;
        rename_folder(&plan.from, &plan.to)?;
        // no folder at the old path now; keep the link call directly after the rename
        make_link(&plan.to, &plan.from)?;
    } else {
        on_step("copying");
        j.save(&[("step", json!("copying"))])?;
        match tree::copy_tree(
            Path::new(&plan.from),
            Path::new(&plan.to),
            on_progress,
            &tree::RETRY_DELAYS,
        ) {
            Ok(_) => {}
            Err(CopyError::Io(e)) => return Err(io1(&e, "scandir", &plan.from).into()),
            Err(CopyError::Tree(t)) => {
                return Err(StepError {
                    message: t.message,
                    problems: t.problems,
                });
            }
        }
        on_step("verifying");
        j.save(&[("step", json!("verifying"))])?;
        let verdict = tree::compare_trees(Path::new(&plan.from), Path::new(&plan.to), thorough)
            .map_err(|e| io1(&e, "scandir", &plan.from))?;
        if !verdict.ok {
            let t = tree::TreeError::new("the copy does not match the original", verdict.problems);
            return Err(StepError {
                message: t.message,
                problems: t.problems,
            });
        }
        on_step("parking the original");
        let parked = format!("{}.moved-{}", plan.from, stamp(started));
        j.save(&[("step", json!("parking")), ("parked", json!(parked))])?;
        rename_folder(&plan.from, &parked)?;
        make_link(&plan.to, &plan.from)?;
    }
    j.save(&[("step", json!("linked"))])?;

    on_step("checking the link");
    probe_link(&plan.from, &plan.to)?;

    for dir in &plan.aside_private {
        let aside = format!("{dir}.set-aside-{}", stamp(started));
        match std::fs::rename(dir, &aside) {
            Ok(()) => {
                if let Some(Value::Array(a)) = j.doc.get_mut("privateAside") {
                    a.push(json!({ "from": dir, "to": aside }));
                }
            }
            Err(e) => notes.push(format!(
                "the private copy {dir} could not be renamed ({}); that program may still read it",
                tree::node_message2(&e, "rename", Path::new(dir), Path::new(&aside))
            )),
        }
    }
    for id in &paused {
        let id = crate::js::string(Some(id));
        if let Err(e) = env.set_enabled(&id, true) {
            notes.push(format!(
                "scheduled task {id} could not be switched back on ({}); switch it on in the Scheduler tab",
                e.message()
            ));
        }
    }
    j.doc.insert("pausedTasks".into(), json!([]));
    j.save(&[
        ("step", json!("done")),
        ("finishedAt", json!(jsdate::to_iso(env.now()))),
    ])?;
    Ok(())
}

/// `rollbackMove(root)`: only for interrupted moves; a finished one has been written to since.
pub fn rollback_move(root: &str, env: &dyn Env) -> Result<Vec<String>, Failure> {
    let file = journal_path(root);
    let Some(Value::Object(journal)) = read_journal(&file)? else {
        return Err(Failure::user(format!(
            "no move is recorded for {}, so there is nothing to put back",
            jspath::resolve(root)
        )));
    };
    if text_of(&journal, "step").as_deref() == Some("done") {
        return Err(Failure::user(
            "that move finished, and the data has been used since: putting the old folder back would lose what was written. Move the data again with `spawnloft data move`, or run `spawnloft data finish` to delete the old copy",
        ));
    }
    let notes = undo_move(&journal, env)?;
    if !notes
        .iter()
        .any(|n| n.contains("failed") || n.contains("could not be put back"))
    {
        let _ = crate::manage::rm_rf(Path::new(&file));
    }
    Ok(notes)
}

/// `finishMove(root)`: deletes the parked original; the point of no return, hence its own command.
pub fn finish_move(root: &str) -> Result<(Option<String>, u64), Failure> {
    let file = journal_path(root);
    // Node's `if (!journal)`: any other value is a journal without fields
    let journal = match read_journal(&file)? {
        Some(Value::Object(j)) => j,
        Some(v) if crate::js::truthy(Some(&v)) => serde_json::Map::new(),
        _ => {
            return Err(Failure::user(format!(
                "no move is recorded for {}",
                jspath::resolve(root)
            )));
        }
    };
    let step = text_of(&journal, "step");
    if step.as_deref() != Some("done") {
        return Err(Failure::user(format!(
            "the move stopped at \"{}\"; `spawnloft data rollback` puts it back",
            crate::js::string(journal.get("step"))
        )));
    }
    let parked = text_of(&journal, "parked");
    let mut removed = 0;
    if let Some(p) = parked.as_ref().filter(|p| exists(p)) {
        // the journal names what gets deleted, so only a parked original beside the data folder
        // is: never the folder the data now lives in, or anything else a damaged journal names.
        // Node has no such check.
        let from = jspath::resolve(root);
        let beside = same(&jspath::dirname(p), &jspath::dirname(&from))
            && jspath::basename(p).starts_with(&format!("{}.moved-", jspath::basename(&from)));
        let live = text_of(&journal, "to").is_some_and(|to| same(&to, p)) || same(p, &from);
        if !beside || live {
            return Err(Failure::user(format!(
                "{p} is not a parked copy of {from}, so it was not removed"
            )));
        }
        if describe_link(p).is_link {
            return Err(Failure::user(format!(
                "{p} is a link, not the parked copy, so it was not removed"
            )));
        }
        removed = tree::tree_stats(Path::new(p)).map_err(|e| tree_io(&e, p))?.bytes;
        tree::remove_tree(Path::new(p))?;
    }
    crate::manage::rm_rf(Path::new(&file))?;
    Ok((parked, removed))
}

/// `moveStatus(root)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub root: String,
    pub link: LinkInfo,
    pub journal: Option<Value>,
    /// parked originals beside the data folder, with their size when it could be read
    pub leftovers: Vec<(String, Option<u64>)>,
}

pub fn move_status(root: &str) -> Result<Status, Failure> {
    let from = jspath::resolve(root);
    let here = describe_link(&from);
    let journal = read_journal(&journal_path(&from))?;
    let base = jspath::basename(&from);
    let parent = jspath::dirname(&from);
    let mut leftovers = Vec::new();
    // a parent that cannot be listed reports no leftovers
    for name in crate::fsx::readdir_names(Path::new(&parent)).unwrap_or_default() {
        if name.starts_with(&format!("{base}.moved-")) {
            let p = jspath::join(&[&parent, &name]);
            let bytes = tree::tree_stats(Path::new(&p)).ok().map(|s| s.bytes);
            leftovers.push((p, bytes));
        }
    }
    Ok(Status {
        root: from,
        link: here,
        journal,
        leftovers,
    })
}

/// The path a status names for the move's original, for messages.
pub fn parked_of(s: &Status) -> Option<String> {
    s.journal
        .as_ref()
        .and_then(|j| j.get("parked"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, bool)>>,
    }

    impl Env for Fake {
        fn running(&self) -> Result<Vec<String>, Failure> {
            Ok(Vec::new())
        }
        fn enabled_tasks(&self) -> Result<Vec<TaskRef>, Failure> {
            Ok(vec![TaskRef {
                id: "a-backup".into(),
            }])
        }
        fn set_enabled(&self, id: &str, on: bool) -> Result<(), Failure> {
            self.calls.borrow_mut().push((id.to_string(), on));
            Ok(())
        }
        fn held_locks(&self) -> Result<Vec<String>, Failure> {
            Ok(Vec::new())
        }
        fn private_copies(&self) -> Vec<PrivateCopy> {
            Vec::new()
        }
        fn now(&self) -> f64 {
            1_700_000_000_000.0
        }
    }

    #[test]
    fn a_copy_move_parks_the_original_and_finish_deletes_it() {
        let d = std::env::temp_dir().join(format!("sl-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let root = d.join("data");
        std::fs::create_dir_all(root.join("instances/a")).unwrap();
        std::fs::write(root.join("instances.json"), "{}").unwrap();
        std::fs::write(root.join("instances/a/server.jar"), vec![1u8; 2048]).unwrap();
        let (root, to) = (
            root.to_string_lossy().into_owned(),
            d.join("moved").to_string_lossy().into_owned(),
        );
        let env = Fake::default();
        let mut steps = Vec::new();
        let (plan, moved) = move_data(
            &root,
            &to,
            false,
            true,
            true,
            false,
            &mut |s| steps.push(s.to_string()),
            None,
            &env,
        )
        .unwrap();
        assert_eq!(plan.mode, "copy");
        let moved = moved.unwrap();
        assert_eq!(
            steps,
            [
                "copying",
                "verifying",
                "parking the original",
                "checking the link"
            ]
        );
        let parked = moved.parked.clone().unwrap();
        assert_eq!(parked, format!("{root}.moved-2023-11-14T22-13-20-000Z"));
        assert!(describe_link(&root).is_link);
        assert_eq!(
            std::fs::read(format!("{root}/instances/a/server.jar"))
                .unwrap()
                .len(),
            2048
        );
        assert_eq!(
            *env.calls.borrow(),
            [("a-backup".to_string(), false), ("a-backup".to_string(), true)]
        );
        let s = move_status(&root).unwrap();
        assert_eq!(s.leftovers, [(parked.clone(), Some(2050))]);
        assert!(
            rollback_move(&root, &env)
                .unwrap_err()
                .message()
                .starts_with("that move finished")
        );
        assert_eq!(finish_move(&root).unwrap(), (Some(parked.clone()), 2050));
        assert!(!Path::new(&parked).exists());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
