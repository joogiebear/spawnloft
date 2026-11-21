//! `backup.mjs` (C3): snapshots of a server folder as `.tar.gz` archives made by the system `tar`
//! with the argument lists Node builds (plan rule 9), each with a `.json` manifest beside it,
//! under `<backups>/<server>/`. The attached databases go in as SQL dumps; a running server is
//! flushed first; a second copy goes to the mirror folder when one is set. Restores check the
//! archive reads back whole before touching a file, keep a copy of what they overwrite, and
//! import the dumps again.
//!
//! The Node module is asynchronous so the panel's event loop keeps running; here every call
//! blocks, which is the same for the command line. The per-server snapshot lock is the same file
//! with the same records, so a Rust backup and a Node one queue behind each other.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::activity::{self, Actor};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::Instance;
use crate::settings::Layout;
use crate::tar::{run_tar, tar_binary, tar_member};
use crate::{control, fsx, js, jsjson, jspath, props, rcon, services, text, util};

/// `SCOPES`.
pub const SCOPES: [&str; 5] = ["plugins", "worlds", "config", "standard", "full"];

/// `EXCLUDE_ARGS`: session.lock is held open exclusively while the server runs, and bsdtar
/// gives up on the whole archive instead of skipping a file it cannot read. It is regenerated on
/// start, so it is never worth backing up.
pub const EXCLUDE_ARGS: [&str; 2] = ["--exclude", "session.lock"];

const ROOT_CONFIG_FILES: [&str; 13] = [
    "server.properties",
    "bukkit.yml",
    "spigot.yml",
    "paper.yml",
    "paper-global.yml",
    "permissions.yml",
    "commands.yml",
    "help.yml",
    "ops.json",
    "whitelist.json",
    "banned-players.json",
    "banned-ips.json",
    "eula.txt",
];

/// Large, regenerable folders the full scope skips.
const FULL_EXCLUDES: [&str; 4] = ["cache", "libraries", "versions", "logs"];

/// JavaScript's default `sort()`: by UTF-16 code units.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `inst.dir` where Node hands it to `path.join`, which refuses anything but a string.
pub fn dir_of(inst: &Instance) -> Result<String, Failure> {
    match inst.get("dir") {
        Some(Value::String(s)) => Ok(s.clone()),
        other => Err(Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"path\" argument must be of type string. {}",
                js::received(other)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

fn join(base: &str, names: &[&str]) -> String {
    let mut all = vec![base];
    all.extend_from_slice(names);
    jspath::join(&all)
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

/// `fs.rmSync(file, { force: true })`: a missing file is fine, anything else is thrown.
fn rm_force(file: &str) -> Result<(), Failure> {
    if std::fs::symlink_metadata(file).is_ok_and(|m| m.is_dir()) {
        return Err(Failure::Internal {
            head: "SystemError [ERR_FS_EISDIR]".into(),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {file}"),
            code: Some("ERR_FS_EISDIR".into()),
        });
    }
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if jspath::is_enoent(&e) => Ok(()),
        Err(e) => Err(Failure::io(&e, "rm", Some(Path::new(file)))),
    }
}

#[cfg(windows)]
fn dir_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_type().is_symlink() && meta.file_attributes() & 0x10 != 0
}

#[cfg(not(windows))]
fn dir_link(_: &std::fs::Metadata) -> bool {
    false
}

/// `fs.rmSync(dir, { recursive: true, force: true })`.
fn rm_tree(p: &Path) -> Result<(), Failure> {
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if jspath::is_enoent(&e) => return Ok(()),
        Err(e) => return Err(Failure::io(&e, "rm", Some(p))),
    };
    let r = if meta.is_dir() {
        std::fs::remove_dir_all(p)
    } else if dir_link(&meta) {
        // a directory symlink or junction on Windows: unlinked as libuv does, never followed
        std::fs::remove_dir(p)
    } else {
        std::fs::remove_file(p)
    };
    match r {
        Ok(()) => Ok(()),
        Err(e) if jspath::is_enoent(&e) => Ok(()),
        Err(e) => Err(Failure::io(&e, "rm", Some(p))),
    }
}

/// `fs.copyFileSync(from, to)`'s failure message.
fn copy_file(from: &str, to: &str) -> Result<(), String> {
    std::fs::copy(from, to).map(|_| ()).map_err(|e| {
        let (code, t) = jspath::error_code(&e);
        format!("{code}: {t}, copyfile '{from}' -> '{to}'")
    })
}

/// `s.replace(/\.tar\.gz$/, '.json')`.
fn manifest_name(archive: &str) -> String {
    match archive.strip_suffix(".tar.gz") {
        Some(stem) => format!("{stem}.json"),
        None => archive.to_string(),
    }
}

// ------------------------------------------------------------------------------------ mirror

/// `mirrorRoot()`: the second location every snapshot is copied to, read from the settings on
/// each call so turning it on needs no restart.
pub fn mirror_root() -> Result<Option<String>, Failure> {
    let (settings, _) = crate::settings::load();
    let v = settings.get("backupsMirrorDir");
    match v {
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(jspath::resolve(s))),
        _ if !js::truthy(v) => Ok(None),
        _ => Err(Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"paths[0]\" argument must be of type string. {}",
                js::received(v)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// `mirrorCopy(name, file)`: a failed copy is reported, never a failed backup.
fn mirror_copy(name: &str, file: &str) -> Result<(Option<String>, Option<String>), Failure> {
    let Some(root) = mirror_root()? else {
        return Ok((None, None));
    };
    let attempt = || -> Result<String, String> {
        let dir = join(&root, &[name]);
        fsx::mkdir_all(Path::new(&dir)).map_err(|f| f.message().to_string())?;
        let dest = join(&dir, &[&jspath::basename(file)]);
        copy_file(file, &dest)?;
        let manifest = manifest_name(file);
        if exists(&manifest) {
            copy_file(&manifest, &manifest_name(&dest))?;
        }
        Ok(dest)
    };
    Ok(match attempt() {
        Ok(dest) => (Some(dest), None),
        Err(why) => (
            None,
            Some(format!(
                "the backup is safe, but its second copy could not be made: {why}"
            )),
        ),
    })
}

/// `mirrorRemove(name, snapName)`: deletions are mirrored too, so retention applies to both.
fn mirror_remove(name: &str, snap: &str) {
    let Ok(Some(root)) = mirror_root() else {
        return;
    };
    let _ = rm_force(&join(&root, &[name, snap]));
    let _ = rm_force(&join(&root, &[name, &manifest_name(snap)]));
}

// ------------------------------------------------------------------------------- what goes in

/// `lockedFiles(cwd, members)`: files under `members` another program holds locked right now (a
/// plugin's embedded database), as archive paths. bsdtar stops writing at such a file with
/// exit 1, so they are left out and named in the manifest. Windows only: POSIX locks are
/// advisory.
fn locked_files(cwd: &str, members: &[String]) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    fn visit(cwd: &str, rel: &str, out: &mut Vec<String>) {
        use std::io::Read;
        let full = join(cwd, &[rel]);
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            return;
        };
        if meta.is_dir() {
            let Ok(names) = fsx::readdir_names(Path::new(&full)) else {
                return;
            };
            for n in names {
                visit(cwd, &jspath::join(&[rel, &n]), out);
            }
            return;
        }
        // open succeeds on a locked file, only the read fails
        if !meta.is_file() || meta.len() == 0 || jspath::basename(rel) == "session.lock" {
            return;
        }
        let res = std::fs::File::open(&full).and_then(|mut f| {
            let mut one = [0u8; 1];
            f.read(&mut one).map(|_| ())
        });
        if let Err(e) = res
            && matches!(jspath::error_code(&e).0, "EBUSY" | "EPERM" | "EACCES")
        {
            out.push(rel.split(jspath::SEP).collect::<Vec<_>>().join("/"));
        }
    }
    let mut locked = Vec::new();
    for m in members {
        visit(cwd, m, &mut locked);
    }
    locked.sort_by(|a, b| utf16_cmp(a, b));
    locked
}

/// `literalPattern(p)`: glob characters bracketed so a literal path works as a bsdtar pattern.
fn literal_pattern(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        if matches!(c, '[' | '*' | '?') {
            out.push('[');
            out.push(c);
            out.push(']');
        } else {
            out.push(c);
        }
    }
    out
}

/// `worldFolders(dir)`: the folders at the top of a server folder that hold a world (a
/// `level.dat`), not hidden ones (a world being imported is unpacked into one).
pub fn world_folders(dir: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && exists(&join(dir, &[n, "level.dat"])))
        .collect();
    out.sort_by(|a, b| utf16_cmp(a, b));
    out
}

/// `worldDirs(props)`: the active world and its two dimension folders.
fn world_dirs(p: &props::Props) -> Vec<String> {
    let level = match props::get(p, "level-name") {
        Some(l) if !l.is_empty() => l.to_string(),
        _ => "world".to_string(),
    };
    vec![
        level.clone(),
        format!("{level}_nether"),
        format!("{level}_the_end"),
    ]
}

/// `membersFor(inst, scope)`: what a scope holds, as paths at the top of the server folder.
fn members_for(inst: &Instance, scope: &str) -> Result<Vec<String>, Failure> {
    let dir = dir_of(inst)?;
    let p = props::read(&jspath::join_path(&dir, &["server.properties"]))?;
    let here = |name: &str| exists(&join(&dir, &[name]));
    // the plugins scope covers mods too (Fabric servers)
    let plugins: Vec<String> = ["plugins", "mods"]
        .into_iter()
        .filter(|n| here(n))
        .map(String::from)
        .collect();
    // every world in the folder, the active world's own folders first (kept even without a
    // level.dat: a world that has never been saved)
    let mut worlds: Vec<String> = Vec::new();
    for w in world_dirs(&p)
        .into_iter()
        .filter(|w| here(w))
        .chain(world_folders(&dir))
    {
        if !worlds.contains(&w) {
            worlds.push(w);
        }
    }
    let mut config: Vec<String> = ROOT_CONFIG_FILES
        .into_iter()
        .filter(|n| here(n))
        .map(String::from)
        .collect();
    if here("config") {
        config.push("config".into());
    }
    Ok(match scope {
        "plugins" => plugins,
        "worlds" => worlds,
        "config" => config,
        "standard" => [plugins, worlds, config].concat(),
        "full" => fsx::readdir_names(Path::new(&dir))
            .map_err(|e| Failure::io(&e, "scandir", Some(Path::new(&dir))))?
            .into_iter()
            .filter(|e| !FULL_EXCLUDES.contains(&e.as_str()))
            .collect(),
        other => {
            return Err(Failure::user(format!(
                "unknown backup scope \"{other}\" - one of: {}",
                SCOPES.join(", ")
            )));
        }
    })
}

/// `excludePatterns(inst)`: the owner's leave-out list.
pub fn exclude_patterns(inst: &Instance) -> Vec<Value> {
    match inst.get("backupExclude") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// `cleanExcludePatterns(input)`: paths inside the server folder, one per line, optional `*`
/// wildcards. No absolute paths, no `..`, not the whole folder.
pub fn clean_exclude_patterns(lines: &[String]) -> Result<Vec<String>, Failure> {
    let mut clean: Vec<String> = Vec::new();
    for l in lines {
        let t = js::trim(l).replace('\\', "/");
        let t = match t.strip_prefix("./") {
            Some(rest) => rest.trim_start_matches('/'),
            None => &t,
        };
        let t = t.trim_end_matches('/').to_string();
        if !t.is_empty() && !t.starts_with('#') {
            clean.push(t);
        }
    }
    if clean.len() > 40 {
        return Err(Failure::user("keep the list to 40 lines"));
    }
    for l in &clean {
        let units: Vec<u16> = l.encode_utf16().collect();
        if units.len() > 200 {
            return Err(Failure::user(format!(
                "\"{}...\" is too long",
                String::from_utf16_lossy(&units[..40])
            )));
        }
        let b = l.as_bytes();
        let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        if l.starts_with('/') || drive || l.split('/').any(|s| s == "..") {
            return Err(Failure::user(format!(
                "\"{l}\" must be a path inside the server folder"
            )));
        }
        if matches!(l.as_str(), "*" | "**" | ".") {
            return Err(Failure::user(format!("\"{l}\" would leave out everything")));
        }
    }
    let mut out: Vec<String> = Vec::new();
    for l in clean {
        if !out.contains(&l) {
            out.push(l);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------- reserving

struct Reservation {
    file: String,
    pending: String,
    manifest_file: String,
}

/// `reserveSnapshot(dir, base)`: the `.pending` file is also tar's output; it never ends in
/// `.tar.gz`, so history cannot offer a partial archive. Exclusive creation keeps the command
/// line, the panel and scheduled tasks from colliding.
fn reserve_snapshot(dir: &str, base: &str) -> Result<Reservation, Failure> {
    let mut index = 0u64;
    loop {
        let suffix = if index > 0 {
            format!("_{}", index + 1)
        } else {
            String::new()
        };
        index += 1;
        let file = join(dir, &[&format!("{base}{suffix}.tar.gz")]);
        let pending = format!("{file}.pending");
        let manifest_file = manifest_name(&file);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
        {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Failure::io(&e, "open", Some(Path::new(&pending)))),
        }
        if exists(&file) || exists(&manifest_file) {
            rm_force(&pending)?;
            continue;
        }
        return Ok(Reservation {
            file,
            pending,
            manifest_file,
        });
    }
}

// ------------------------------------------------------------------------------- the snapshot

/// `FLUSH_TIMEOUT_MS`: two minutes, well past an ordinary command's eight seconds but short
/// enough that a hung server does not hold a backup for long. The variable is for tests.
pub fn flush_timeout_ms() -> f64 {
    js::positive_env(&["SPAWNLOFT_FLUSH_TIMEOUT_MS", "MCCTL_FLUSH_TIMEOUT_MS"]).unwrap_or(120_000.0)
}

/// `turnSavingBackOn(inst)`: a warning when save-on could not be confirmed. A refused
/// connection means the server stopped mid-backup and has nothing to turn on.
fn turn_saving_back_on(inst: &Instance) -> Option<String> {
    match rcon::exec(inst, &["save-on"], rcon::ExecOptions::default()) {
        Ok(_) => None,
        Err(e) if e.refused => None,
        Err(e) => Some(format!(
            "autosave may still be off: save-on was not confirmed ({}). Type save-on in the server's console if it is",
            e.message
        )),
    }
}

/// `appendToError(err, line)`: the line goes into the error the person is about to read.
fn append_to_error(f: Failure, line: &str) -> Failure {
    match f {
        Failure::User { message, code } => Failure::User {
            message: format!("{message}\n  {line}"),
            code,
        },
        Failure::Internal { head, message, code } => Failure::Internal {
            head,
            message: format!("{message}\n  {line}"),
            code,
        },
        // a usage error is never thrown from here
        other => other,
    }
}

/// The options of `createSnapshot`.
#[derive(Debug, Clone)]
pub struct Options {
    pub scope: String,
    /// `label`: a string, or `null` (and `false` for `--no-label`, which the Node core keeps).
    pub label: Value,
    pub running: bool,
    pub task_id: Value,
    pub flush: bool,
    /// `members`: named paths instead of a scope (a copy of a few files before a change).
    pub members: Option<Vec<String>>,
    pub quiet: bool,
    pub during_restore: bool,
    pub change_copy: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            scope: "standard".into(),
            label: Value::Null,
            running: false,
            task_id: Value::Null,
            flush: true,
            members: None,
            quiet: false,
            during_restore: false,
            change_copy: false,
        }
    }
}

/// What `createSnapshot` answers.
#[derive(Debug, Clone)]
pub struct Made {
    pub file: String,
    pub size: u64,
    pub members: Vec<String>,
    pub databases: Vec<Value>,
    pub databases_skipped: Vec<Value>,
    pub skipped: Vec<String>,
    pub manifest: Value,
    pub warnings: Vec<String>,
    pub mirrored: Option<String>,
    pub mirror_error: Option<String>,
    pub flushed: bool,
    pub flush_warning: Option<String>,
    pub save_on_warning: Option<String>,
}

/// `label.replace(/[^a-z0-9_-]/gi, '-')`, by UTF-16 unit as JavaScript replaces.
fn slug_of(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push_str(&"-".repeat(c.len_utf16()));
        }
    }
    out
}

fn roots(layout: &Layout) -> Roots {
    Roots::new(&layout.data_root)
}

fn state_file(layout: &Layout, name: &str) -> PathBuf {
    PathBuf::from(layout.state_file(name))
}

/// `refuseWhileRestoring(name, verb)`.
pub fn refuse_while_restoring(layout: &Layout, name: &str, verb: &str) -> Result<(), Failure> {
    match control::restore_block(&state_file(layout, name), name, verb) {
        Some(why) => Err(Failure::user(why)),
        None => Ok(()),
    }
}

/// `isRestoring(name)`.
pub fn is_restoring(layout: &Layout, name: &str) -> bool {
    control::is_restoring(&state_file(layout, name))
}

/// `createSnapshot(inst, opts)`: a running server is flushed first (save-off, save-all flush,
/// then save-on afterwards) so the copy is not torn mid-write; a flush that cannot be done is
/// reported in the result and the manifest instead of failing the snapshot.
pub fn create_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    opts: &Options,
) -> Result<Made, Failure> {
    // a copy of a folder halfway through being put back is a backup of nothing; the exception is
    // the copy the restore itself takes before it starts
    if !opts.during_restore {
        refuse_while_restoring(layout, &inst.name, "taking a new one")?;
    }
    // the owner's leave-out list applies to every normal backup but not to a copy of named files
    let leave_out = if opts.members.is_some() {
        Vec::new()
    } else {
        exclude_patterns(inst)
    };
    let chosen = match &opts.members {
        Some(m) => m.clone(),
        None => members_for(inst, &opts.scope)?,
    };
    let members: Vec<String> = chosen
        .into_iter()
        .filter(|m| !leave_out.iter().any(|p| p.as_str() == Some(m.as_str())))
        .map(|m| tar_member(&m))
        .collect();
    let dir_text = dir_of(inst)?;
    if members.is_empty() {
        return Err(Failure::user(format!(
            "nothing to back up for scope \"{}\" in {dir_text}",
            opts.scope
        )));
    }
    let slug = match &opts.label {
        Value::String(s) if !s.is_empty() => format!("{}_", slug_of(s)),
        v if js::truthy(Some(v)) => {
            return Err(Failure::type_error("label.replace is not a function"));
        }
        _ => String::new(),
    };
    let base = format!("{slug}{}_{}", opts.scope, util::stamp());
    let dir = join(&layout.backups_dir, &[&inst.name]);
    fsx::mkdir_all(Path::new(&dir))?;
    // said now: a folder that cannot be written to looks, to the lock below, exactly like a lock
    // somebody else is holding, and it would wait out its whole timeout
    if !crate::platform::writable(Path::new(&dir)) {
        return Err(Failure::user(format!(
            "The backups folder cannot be written to, so no backup can be made. It is {dir}"
        )));
    }
    // one snapshot per server at a time: if two overlapped, whichever finished first would turn
    // saving back on while the other's tar was still reading; the second one queues
    let lock_file = PathBuf::from(join(&dir, &[".snapshot.lock"]));
    let lock = crate::lock::acquire(&lock_file, crate::lock::Options::wait(30 * 60 * 1000))
        .map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: e.to_string(),
            code: None,
        })?
        .expect("wait mode answers a lock or an error");
    let made = create_snapshot_locked(layout, by, inst, opts, &members, &base, &dir, &leave_out);
    if made.is_ok() && inst.get("backupCleanCopies") == Some(&Value::Bool(true)) && !opts.during_restore {
        // the next snapshot tries again
        let _ = clean_copies(layout, by, &inst.name, None);
    }
    let _ = lock.release();
    made
}

#[allow(clippy::too_many_arguments)]
fn create_snapshot_locked(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    opts: &Options,
    members: &[String],
    base: &str,
    dir: &str,
    leave_out: &[Value],
) -> Result<Made, Failure> {
    let inst_dir = dir_of(inst)?;
    // attached databases go in as a `databases/` member with one SQL dump each, dumped into a
    // scratch folder and added with -C so the server folder never holds them
    let mut dumps = services::Dumps::default();
    let mut dump_dir: Option<PathBuf> = None;
    if opts.scope == "standard" || opts.scope == "full" {
        let tmp = crate::engines::mkdtemp(&jspath::join(&[&util::os_tmpdir(), "spawnloft-dump-"]))?;
        match services::dump_attachments(layout, &inst.name, &tmp) {
            Ok(d) => dumps = d,
            Err(e) => {
                let _ = rm_tree(&tmp);
                return Err(e);
            }
        }
        dump_dir = Some(tmp);
    }
    let mut dump_args: Vec<String> = Vec::new();
    let mut archived: Vec<String> = members.to_vec();
    if !dumps.dumped.is_empty()
        && let Some(d) = &dump_dir
    {
        dump_args = vec!["-C".into(), d.to_string_lossy().into_owned(), "databases".into()];
        archived.push("databases".into());
    }

    // save-off may take effect even if its reply never arrives, so saving is owed back from the
    // moment it is sent
    let mut saving_may_be_off = false;
    let mut flushed = false;
    let mut flush_warning: Option<String> = None;
    if opts.running && opts.flush {
        let flush = (|| -> Result<(), rcon::ExecError> {
            saving_may_be_off = true;
            if let Err(e) = rcon::exec(inst, &["save-off"], rcon::ExecOptions::default()) {
                // failed before anything was sent, so saving cannot be off
                if e.unsent {
                    saving_may_be_off = false;
                }
                return Err(e);
            }
            // a longer timeout than ordinary commands, and no retry: a flush that timed out
            // would only make the backup wait as long again
            rcon::exec(
                inst,
                &["save-all flush"],
                rcon::ExecOptions {
                    timeout_ms: flush_timeout_ms(),
                    retry_timeouts: false,
                    ..rcon::ExecOptions::default()
                },
            )
            .map(|_| ())
        })();
        match flush {
            Ok(()) => flushed = true,
            Err(e) => {
                flush_warning = Some(format!(
                    "could not flush the world before the snapshot ({}); the copy may be torn",
                    e.message
                ));
            }
        }
    }

    let mut reservation: Option<Reservation> = None;
    let mut save_on_warning: Option<String> = None;
    let result = (|| -> Result<Made, Failure> {
        let ran = (|| -> Result<(crate::tar::TarRun, Vec<String>), Failure> {
            let r = reserve_snapshot(dir, base)?;
            let pending = r.pending.clone();
            reservation = Some(r);
            // after the flush, so files are checked in the state tar will find them
            let skipped = locked_files(&inst_dir, members);
            let mut args: Vec<String> = vec!["-czf".into(), pending];
            args.extend(EXCLUDE_ARGS.iter().map(|s| s.to_string()));
            for f in &skipped {
                args.push("--exclude".into());
                args.push(literal_pattern(f));
            }
            for p in leave_out {
                args.push("--exclude".into());
                args.push(js::string(Some(p)));
            }
            args.extend(members.iter().cloned());
            args.extend(dump_args.iter().cloned());
            let run = run_tar(&args, Path::new(&inst_dir))?;
            Ok((run, skipped))
        })();
        // save-on even if tar or the flush failed: a live server left with saving off is worse
        // than a failed backup
        if saving_may_be_off {
            save_on_warning = turn_saving_back_on(inst);
        }
        if let Some(d) = &dump_dir {
            let _ = rm_tree(d);
        }
        let (run, skipped) = ran?;
        let r = reservation.as_ref().expect("reserved before tar ran");
        let size = std::fs::metadata(&r.pending)
            .map_err(|e| Failure::io(&e, "stat", Some(Path::new(&r.pending))))?
            .len();
        let trimmed = js::trim(&run.stderr);
        let said = split_lines(trimmed).into_iter().next().unwrap_or_default();
        let tar_said = if said.is_empty() {
            String::new()
        } else {
            format!("\n  tar said: {said}")
        };
        // load-bearing: rebuild and delete take a snapshot first and are only safe if it exists
        if size == 0 {
            return Err(Failure::user(format!(
                "snapshot of \"{}\" came out empty and has been discarded.{tar_said}",
                inst.name
            )));
        }
        // exit 1 is also how bsdtar reports giving up partway, so an archive written with
        // warnings is read back before it is published
        if run.code != 0 {
            let files: Vec<String> = dumps.dumped.iter().map(|d| js::string(d.get("file"))).collect();
            let expected: Vec<Value> = archived.iter().map(|m| json!(m)).collect();
            let check = verify_archive(&r.pending, &expected, &files);
            if !check.ok {
                return Err(Failure::user(format!(
                    "snapshot of \"{}\" came out incomplete and has been discarded: {}{tar_said}",
                    inst.name, check.problems[0]
                )));
            }
        }
        let mut warnings: Vec<String> = Vec::new();
        warnings.extend(flush_warning.clone());
        warnings.extend(save_on_warning.clone());
        for d in &dumps.skipped {
            warnings.push(format!(
                "database {} on {} not included: {}",
                js::string(d.get("database")),
                js::string(d.get("service")),
                js::string(d.get("reason"))
            ));
        }
        for f in &skipped {
            warnings.push(format!(
                "{f} not included: another program has it locked, usually the running server"
            ));
        }
        for l in split_lines(trimmed) {
            let t = js::trim(&l);
            if !t.is_empty() && !is_null_line(t) {
                warnings.push(l);
            }
        }
        warnings.truncate(10);
        let mut m = Map::new();
        m.insert("instance".into(), json!(inst.name));
        m.insert("scope".into(), json!(opts.scope));
        m.insert("label".into(), opts.label.clone());
        m.insert("changeCopy".into(), json!(opts.change_copy));
        m.insert("taskId".into(), opts.task_id.clone());
        m.insert("members".into(), json!(archived));
        m.insert("databases".into(), Value::Array(dumps.dumped.clone()));
        if !leave_out.is_empty() {
            m.insert("excluded".into(), Value::Array(leave_out.to_vec()));
        }
        m.insert(
            "sourceDir".into(),
            inst.get("dir").cloned().unwrap_or(Value::Null),
        );
        m.insert("createdAt".into(), json!(crate::time::iso_now()));
        m.insert("size".into(), json!(size));
        m.insert("serverWasRunning".into(), json!(opts.running));
        m.insert("flushed".into(), json!(flushed));
        m.insert("skipped".into(), json!(skipped));
        m.insert("warnings".into(), json!(warnings));
        let manifest = Value::Object(m);
        let _ = fsx::write_json_node(Path::new(&r.manifest_file), &manifest, None, false)?;
        // history only sees the final name once tar is done and the manifest exists
        // a plain renameSync in Node, so its own error, not renameOver's
        std::fs::rename(&r.pending, &r.file).map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: format!(
                "{}, rename '{}' -> '{}'",
                jspath::node_error(&e, "rename", None),
                r.pending,
                r.file
            ),
            code: Some(jspath::error_code(&e).0.to_string()),
        })?;
        let file = r.file.clone();
        reservation = None;
        let (mirrored, mirror_error) = mirror_copy(&inst.name, &file)?;
        // narrowed or quiet snapshots are taken before a change, and that change records itself
        if opts.members.is_none() && !opts.quiet {
            let label = match &opts.label {
                v if js::truthy(Some(v)) => format!(" ({})", js::string(Some(v))),
                _ => String::new(),
            };
            activity::record_by(
                &roots(layout),
                by,
                &inst.name,
                "backup",
                Some(&format!(
                    "{}{label}, {}",
                    opts.scope,
                    text::human_bytes(Some(size as f64))
                )),
                Some(&jspath::basename(&file)),
                true,
            );
        }
        Ok(Made {
            file,
            size,
            members: archived.clone(),
            databases: dumps.dumped.clone(),
            databases_skipped: dumps.skipped.clone(),
            skipped,
            warnings,
            manifest,
            mirrored,
            mirror_error,
            flushed,
            flush_warning: flush_warning.clone(),
            save_on_warning: save_on_warning.clone(),
        })
    })();
    // keep the name reserved until its metadata is gone, so a concurrent backup cannot claim it
    if let Some(r) = &reservation {
        let _ = rm_force(&r.manifest_file);
        let _ = rm_force(&format!("{}.tmp", r.manifest_file));
        let _ = rm_force(&r.pending);
    }
    result.map_err(|e| match &save_on_warning {
        Some(w) => append_to_error(e, w),
        None => e,
    })
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<String> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i < last {
                p.strip_suffix('\r').unwrap_or(p).to_string()
            } else {
                p.to_string()
            }
        })
        .collect()
}

/// `/^tar(\.exe)?:\s*\(null\)$/i`: bsdtar's bare line for a locked file, already listed.
fn is_null_line(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("tar.exe:")
        .or_else(|| lower.strip_prefix("tar:"));
    rest.is_some_and(|r| js::trim(r) == "(null)" && r.trim_start_matches(js::is_js_space) == "(null)")
}

// --------------------------------------------------------------------------------- the history

/// `snapshotProblems(warnings)`: what is wrong with a snapshot that someone restoring it needs to
/// know, read from its manifest's warnings: a world copied while the server was writing, and a
/// database that is not in it.
pub fn snapshot_problems(warnings: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(list)) = warnings else {
        return Vec::new();
    };
    let db_re = regex::Regex::new(
        r"^database ([^\n\r\u{2028}\u{2029}]+?) on ([^\n\r\u{2028}\u{2029}]+?) not included: ((?s:.*))$",
    )
    .expect("a fixed pattern");
    let mut out = Vec::new();
    for w in list {
        let t = js::string(Some(w));
        if t.starts_with("could not flush the world before the snapshot") {
            out.push("Taken while the server was running and it could not be asked to save first, so the world in it may be incomplete.".to_string());
            continue;
        }
        let Some(c) = db_re.captures(&t) else {
            continue;
        };
        // an engine that is never dumped (it keeps its own checkpoints) did not go wrong
        if c[3].contains("keeps its own checkpoints") {
            continue;
        }
        let reason = js::trim(&c[3]);
        let reason = reason.strip_suffix('.').unwrap_or(reason);
        out.push(format!(
            "Does not include the database {} ({}): {reason}.",
            &c[1], &c[2]
        ));
    }
    out
}

const CHANGE_COPY_LABELS: [&str; 6] = [
    "pre-install",
    "pre-update",
    "before-edit",
    "file-edit",
    "file-replace",
    "file-delete",
];
const PARTIAL_SCOPES: [&str; 3] = ["plugins", "config", "files"];

fn field<'a>(manifest: &'a Value, key: &str) -> Option<&'a Value> {
    manifest.as_object().and_then(|m| m.get(key))
}

/// `isChangeCopy(manifest)`: a small copy SpawnLoft took by itself before a change.
pub fn is_change_copy(manifest: &Value) -> bool {
    if !js::truthy(Some(manifest)) {
        return false;
    }
    let scope = field(manifest, "scope").and_then(Value::as_str);
    if !scope.is_some_and(|s| PARTIAL_SCOPES.contains(&s)) || js::truthy(field(manifest, "taskId")) {
        return false;
    }
    if let Some(Value::Bool(b)) = field(manifest, "changeCopy") {
        return *b;
    }
    field(manifest, "label")
        .and_then(Value::as_str)
        .is_some_and(|l| CHANGE_COPY_LABELS.contains(&l))
}

/// One row of `listSnapshots(name)`.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// `st.mtime`, in whole milliseconds as a `Date` holds it.
    pub mtime_ms: f64,
    pub scope: Value,
    pub label: Value,
    pub task_id: Value,
    pub members: Value,
    pub locked: bool,
    pub note: Value,
    pub copy: bool,
    pub excluded: Value,
    pub databases: Value,
    pub problems: Vec<String>,
}

fn or(v: Option<&Value>, fallback: Value) -> Value {
    match v {
        None | Some(Value::Null) => fallback,
        Some(v) => v.clone(),
    }
}

impl Snapshot {
    /// The row as `JSON.stringify` writes it (the date as its ISO text).
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "path": self.path,
            "size": self.size,
            "sizeHuman": text::human_bytes(Some(self.size as f64)),
            "mtime": crate::time::iso(self.mtime_ms as i64),
            "scope": self.scope,
            "label": self.label,
            "taskId": self.task_id,
            "members": self.members,
            "locked": self.locked,
            "note": self.note,
            "copy": self.copy,
            "excluded": self.excluded,
            "databases": self.databases,
            "problems": self.problems,
        })
    }
    pub fn size_human(&self) -> String {
        text::human_bytes(Some(self.size as f64))
    }
    /// The manifest's members as a list; anything else is what Node would choke on.
    pub fn member_list(&self, what: &str) -> Result<Vec<Value>, Failure> {
        list_of(&self.members, what)
    }
    /// The files of the dumps the manifest records (`databases.map((d) => d.file)`).
    pub fn dump_files(&self) -> Result<Vec<String>, Failure> {
        Ok(list_of(&self.databases, "databases.map")?
            .iter()
            .map(|d| js::string(field(d, "file")))
            .collect())
    }
}

fn list_of(v: &Value, what: &str) -> Result<Vec<Value>, Failure> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        _ => Err(Failure::type_error(format!("{what} is not a function"))),
    }
}

/// `readJson(file, {})`: the parsed file, `{}` when it is not there; a file that does not parse
/// is thrown.
fn read_manifest(file: &str) -> Result<Value, Failure> {
    match std::fs::read(file) {
        Ok(b) => jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax),
        Err(e) if jspath::is_enoent(&e) => Ok(json!({})),
        Err(e) => Err(Failure::read(&e, Path::new(file))),
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let t = meta.modified().ok().and_then(|m| {
        m.duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .or_else(|e| Ok::<f64, ()>(-(e.duration().as_secs_f64() * 1000.0)))
            .ok()
    });
    // a Date of mtimeMs: Node rounds to the nearest millisecond
    (t.unwrap_or(0.0) + 0.5).floor()
}

/// `listSnapshots(name)`: newest first. A listing makes nothing (the panel answers it on a GET).
pub fn list_snapshots(layout: &Layout, name: &str) -> Result<Vec<Snapshot>, Failure> {
    let dir = join(&layout.backups_dir, &[name]);
    if !exists(&dir) {
        return Ok(Vec::new());
    }
    let names =
        fsx::readdir_names(Path::new(&dir)).map_err(|e| Failure::io(&e, "scandir", Some(Path::new(&dir))))?;
    let mut out = Vec::new();
    for f in names.into_iter().filter(|f| f.ends_with(".tar.gz")) {
        let full = join(&dir, &[&f]);
        let manifest = read_manifest(&manifest_name(&full))?;
        let meta = std::fs::metadata(&full).map_err(|e| Failure::io(&e, "stat", Some(Path::new(&full))))?;
        if manifest.is_null() {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'scope')",
            ));
        }
        let get = |k: &str| field(&manifest, k);
        out.push(Snapshot {
            name: f.clone(),
            path: full,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
            scope: or(get("scope"), json!("?")),
            label: or(get("label"), json!("")),
            task_id: or(get("taskId"), Value::Null),
            members: or(get("members"), json!([])),
            locked: get("locked") == Some(&Value::Bool(true)),
            note: or(get("note"), Value::Null),
            copy: is_change_copy(&manifest),
            excluded: or(get("excluded"), json!([])),
            databases: or(get("databases"), json!([])),
            problems: snapshot_problems(get("warnings")),
        });
    }
    // newest first; equal times keep the folder's order (a stable sort)
    out.sort_by(|a, b| {
        b.mtime_ms
            .partial_cmp(&a.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// `isPartialSnapshotName(file)`: a file name that says it holds part of a server.
pub fn is_partial_snapshot_name(file: &str) -> bool {
    let re = regex::Regex::new(r"(?:^|_)(?:plugins|config|files)_[0-9]{4}-[0-9]{2}-[0-9]{2}[_.]")
        .expect("a fixed pattern");
    re.is_match(file)
}

/// `resolveSnapshot(name, ref)`: `latest` (or nothing), an exact name with or without
/// `.tar.gz`, or a part of one name.
pub fn resolve_snapshot(layout: &Layout, name: &str, reference: &str) -> Result<Snapshot, Failure> {
    let all = list_snapshots(layout, name)?;
    if all.is_empty() {
        return Err(Failure::user(format!("no snapshots exist for \"{name}\"")));
    }
    // "latest" is the newest backup someone would mean: not the copy a restore kept of what it
    // replaced, or restoring "latest" twice would undo the first restore
    if reference.is_empty() || reference == "latest" {
        let pick = all
            .iter()
            .find(|s| s.label != json!("pre-restore"))
            .unwrap_or(&all[0]);
        return Ok(pick.clone());
    }
    let with_ext = format!("{reference}.tar.gz");
    if let Some(s) = all.iter().find(|s| s.name == reference || s.name == with_ext) {
        return Ok(s.clone());
    }
    let partial: Vec<&Snapshot> = all.iter().filter(|s| s.name.contains(reference)).collect();
    match partial.len() {
        1 => Ok(partial[0].clone()),
        0 => Err(Failure::user(format!(
            "no snapshot matching \"{reference}\" for \"{name}\""
        ))),
        _ => Err(Failure::user(format!(
            "snapshot \"{reference}\" is ambiguous:\n  {}",
            partial
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        ))),
    }
}

// ----------------------------------------------------------------------------------- checking

/// What `verifyArchive` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub ok: bool,
    pub size: u64,
    pub entries: u64,
    pub missing: Vec<String>,
    pub problems: Vec<String>,
}

/// `tar -tzf file`: the listing, or why it could not be read back.
fn list_archive(file: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new(tar_binary());
    cmd.args(["-tzf", file])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::platform::hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if jspath::is_enoent(&e) {
            "tar was not found on PATH (Windows 10/11 ships tar.exe in System32)".to_string()
        } else {
            format!("spawn {} {}", tar_binary().display(), jspath::error_code(&e).0)
        }
    })?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = split_lines(js::trim(&stderr))
        .into_iter()
        .next()
        .unwrap_or_default();
    if !first.is_empty() {
        return Err(first);
    }
    Err(match out.status.code() {
        Some(c) => format!("tar exited {c}"),
        None => "tar exited null".to_string(),
    })
}

/// `verifyArchive(file, expectedMembers, expectedFiles)`: reads the archive back with `-t`,
/// which decompresses every block and so checks the gzip checksums, then compares the listing
/// with the manifest's top-level members and the dumps it names. Any failed exit is a failure.
pub fn verify_archive(file: &str, expected_members: &[Value], expected_files: &[String]) -> Verified {
    let size = match std::fs::metadata(file) {
        Ok(m) => m.len(),
        Err(_) => {
            return Verified {
                ok: false,
                size: 0,
                entries: 0,
                missing: Vec::new(),
                problems: vec!["the archive file is missing".into()],
            };
        }
    };
    if size == 0 {
        return Verified {
            ok: false,
            size,
            entries: 0,
            missing: Vec::new(),
            problems: vec!["the archive is zero bytes".into()],
        };
    }
    let mut problems = Vec::new();
    let mut entries = 0u64;
    let mut roots: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut files: std::collections::HashSet<String> = std::collections::HashSet::new();
    match list_archive(file) {
        Ok(listing) => {
            for line in listing.split('\n') {
                let entry = js::trim(line).replace('\\', "/");
                if entry.is_empty() {
                    continue;
                }
                entries += 1;
                roots.insert(entry.split('/').next().unwrap_or("").to_string());
                if !expected_files.is_empty() {
                    files.insert(entry.strip_suffix('/').unwrap_or(&entry).to_string());
                }
            }
        }
        Err(why) => problems.push(format!("the archive does not read back: {why}")),
    }
    let mut missing = Vec::new();
    if problems.is_empty() {
        if entries == 0 {
            problems.push("the archive reads back but holds no entries".to_string());
        }
        // skipped when the read failed: a truncated listing would report every later member
        for m in expected_members {
            let text = js::string(Some(m));
            let root = text.replace('\\', "/");
            let root = root.split('/').next().unwrap_or("");
            if !roots.contains(root) {
                missing.push(text);
            }
        }
        for m in &missing {
            problems.push(format!(
                "the manifest lists \"{m}\" but the archive does not contain it"
            ));
        }
        for f in expected_files {
            let want = f.replace('\\', "/");
            if !files.contains(&want) {
                problems.push(format!(
                    "the manifest lists the database dump \"{want}\" but the archive does not contain it"
                ));
                missing.push(want);
            }
        }
    }
    Verified {
        ok: problems.is_empty(),
        size,
        entries,
        missing,
        problems,
    }
}

/// `checkRestorable(snapshot)`: separate from the restore so a preview can check first.
pub fn check_restorable(snap: &Snapshot) -> Result<Verified, Failure> {
    Ok(verify_archive(
        &snap.path,
        &snap.member_list("expectedMembers.filter")?,
        &snap.dump_files()?,
    ))
}

/// `verifySnapshot(name, ref)`: the check, and whether a manifest is there at all (without one
/// the member check proves nothing).
pub fn verify_snapshot(
    layout: &Layout,
    name: &str,
    reference: &str,
) -> Result<(Snapshot, bool, Verified), Failure> {
    let snap = resolve_snapshot(layout, name, reference)?;
    let result = check_restorable(&snap)?;
    let has_manifest = exists(&manifest_name(&snap.path));
    Ok((snap, has_manifest, result))
}

// ---------------------------------------------------------------------------------- restoring

/// The restore marker (`beginRestore`); dropping it clears the mark.
struct Restoring(PathBuf);

impl Drop for Restoring {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `beginRestore(name)`: marks the server for as long as the restore runs, so a second restore,
/// a delete, a new backup or a start refuses until it has finished, from any process.
fn begin_restore(layout: &Layout, name: &str) -> Result<Restoring, Failure> {
    let state = state_file(layout, name);
    if let Some(why) = control::restore_block(&state, name, "restoring another") {
        return Err(Failure::user(why));
    }
    let file = control::restore_marker(&state);
    if let Some(dir) = file.parent() {
        fsx::mkdir_all(dir)?;
    }
    let mark = json!({ "pid": std::process::id(), "at": crate::time::iso_now() });
    std::fs::write(&file, jsjson::stringify(&mark)).map_err(|e| Failure::io(&e, "open", Some(&file)))?;
    Ok(Restoring(file))
}

/// The options of `restoreSnapshot`.
#[derive(Debug, Clone, Copy)]
pub struct RestoreOptions {
    pub quiet: bool,
    /// Clear what the snapshot holds first (an ordinary restore only adds and overwrites).
    pub clean: bool,
    /// Keep a copy of what is about to be overwritten (`safety`).
    pub keep_copy: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        RestoreOptions {
            quiet: false,
            clean: false,
            keep_copy: true,
        }
    }
}

/// What `restoreSnapshot` answers.
#[derive(Debug, Clone)]
pub struct Restored {
    pub restored: String,
    pub into: String,
    pub databases: services::Imported,
    pub safety: Option<String>,
}

/// `restoreSnapshot(inst, snapshot, opts)`.
pub fn restore_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    snap: &Snapshot,
    opts: RestoreOptions,
) -> Result<Restored, Failure> {
    let _mark = begin_restore(layout, &inst.name)?;
    restore_snapshot_locked(layout, by, inst, snap, opts)
}

fn restore_snapshot_locked(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    snap: &Snapshot,
    opts: RestoreOptions,
) -> Result<Restored, Failure> {
    let dir = dir_of(inst)?;
    if !exists(&dir) {
        return Err(Failure::user(format!("instance directory is missing: {dir}")));
    }
    let members = snap.member_list("members.some")?;
    let is_db = |m: &Value| m.as_str() == Some("databases");
    let safe = |m: &Value| m.as_str().and_then(util::safe_relative_path);
    if opts.clean && !members.iter().any(|m| !is_db(m)) {
        return Err(Failure::user(format!(
            "{} does not record what it holds, so there is nothing it can safely clear first",
            snap.name
        )));
    }
    // a clean restore deletes what the manifest names, so a manifest listing "../x" is refused
    if opts.clean
        && let Some(outside) = members.iter().find(|m| !is_db(m) && safe(m).is_none())
    {
        return Err(Failure::user(format!(
            "{} lists \"{}\", which is not inside the server folder, so it cannot clear anything first; nothing was changed",
            snap.name,
            js::string(Some(outside))
        )));
    }
    // checked before any file is touched: extraction overwrites in place, so an archive that
    // stops partway would leave a server that is neither the backup nor what it replaced
    let check = check_restorable(snap)?;
    if !check.ok {
        return Err(Failure::user(format!(
            "{} would not restore cleanly, so nothing was changed.\n  {}\n  Choose an older snapshot; \"spawnloft verify {} --all\" checks every one.",
            snap.name,
            check.problems.join("\n  "),
            inst.name
        )));
    }
    // what the snapshot is about to overwrite is snapshotted first, so a restore of the wrong
    // backup can itself be undone; a clean restore then clears those members
    let mut safety: Option<String> = None;
    if opts.clean || opts.keep_copy {
        let present: Vec<String> = members
            .iter()
            .filter(|m| !is_db(m))
            .filter_map(|m| {
                let raw = m.as_str()?;
                safe(m)?;
                let parts: Vec<&str> = raw.split(['/', '\\']).collect();
                jspath::join_path(&dir, &parts).exists().then(|| raw.to_string())
            })
            .collect();
        if !present.is_empty() {
            let copy = create_snapshot(
                layout,
                by,
                inst,
                &Options {
                    scope: "files".into(),
                    label: json!("pre-restore"),
                    members: Some(present.clone()),
                    flush: false,
                    during_restore: true,
                    ..Options::default()
                },
            );
            let made = match copy {
                Ok(m) => m,
                Err(e) => {
                    let message = format!(
                        "Could not keep a copy of how things are now, so nothing was changed ({}).{}",
                        e.message(),
                        if opts.clean {
                            ""
                        } else {
                            " It can be restored without that copy, which cannot be undone."
                        }
                    );
                    return Err(Failure::User {
                        message,
                        code: (!opts.clean).then(|| "no-copy".to_string()),
                    });
                }
            };
            safety = Some(jspath::basename(&made.file));
            if opts.clean {
                for m in &present {
                    let parts: Vec<&str> = m.split(['/', '\\']).collect();
                    rm_tree(&jspath::join_path(&dir, &parts))?;
                }
            }
        }
    }

    // exit 1 counts as done when writing an archive; when reading one it means a bad archive
    let run = run_tar(&["-xzf".to_string(), snap.path.clone()], Path::new(&dir))?;
    if run.code != 0 {
        let trimmed = js::trim(&run.stderr);
        let said = if trimmed.is_empty() {
            String::new()
        } else {
            format!(
                ": {}",
                split_lines(trimmed).into_iter().next().unwrap_or_default()
            )
        };
        return Err(Failure::user(format!(
            "restoring {} stopped partway (tar exited {}{said}). Some files in {dir} may already have been replaced; restore another snapshot before starting it.",
            snap.name, run.code
        )));
    }

    // the dumps came out under databases/ in the server folder: imported and removed, and a dump
    // that cannot be imported stays where it is so it can be imported by hand
    let dumps = list_of(&snap.databases, "dumps.length")?;
    let mut databases = services::Imported::default();
    if !dumps.is_empty() {
        databases = services::import_dumps(layout, &dumps, &dir)?;
        for d in &databases.imported {
            if let Some(Value::String(f)) = field(d, "file")
                && let Some(rel) = util::safe_relative_path(f)
            {
                let parts: Vec<&str> = rel.split('/').collect();
                let p = jspath::join_path(&dir, &parts);
                rm_force(&p.to_string_lossy())?;
            }
        }
        let folder = jspath::join_path(&dir, &["databases"]);
        if folder.exists() && std::fs::read_dir(&folder).is_ok_and(|mut r| r.next().is_none()) {
            let _ = std::fs::remove_dir(&folder);
        }
    }
    if !opts.quiet {
        let detail = match &safety {
            Some(s) => format!(
                "{}{}; how it was is kept as {s}",
                snap.name,
                if opts.clean { ", cleared first" } else { "" }
            ),
            None => snap.name.clone(),
        };
        activity::record_by(
            &roots(layout),
            by,
            &inst.name,
            "restore",
            Some(&detail),
            safety.as_deref(),
            true,
        );
    }
    Ok(Restored {
        restored: snap.name.clone(),
        into: dir,
        databases,
        safety,
    })
}

// ------------------------------------------------------------------------------------- removing

/// `updateManifest(snap, patch)`: older snapshots have no manifest, so one is made for the lock
/// or note.
fn update_manifest(snap: &Snapshot, patch: &[(&str, Value)]) -> Result<(), Failure> {
    let file = manifest_name(&snap.path);
    let mut m = match read_manifest(&file)? {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (k, v) in patch {
        m.insert((*k).to_string(), v.clone());
    }
    let _ = fsx::write_json_node(Path::new(&file), &Value::Object(m), None, false)?;
    Ok(())
}

/// `setSnapshotLocked(name, ref, locked)`: a locked snapshot is never deleted by retention or
/// the Delete button until it is unlocked.
pub fn set_snapshot_locked(
    layout: &Layout,
    by: &Actor,
    name: &str,
    reference: &str,
    locked: bool,
) -> Result<String, Failure> {
    let snap = resolve_snapshot(layout, name, reference)?;
    update_manifest(&snap, &[("locked", json!(locked))])?;
    let action = if locked { "backup-lock" } else { "backup-unlock" };
    activity::record_by(&roots(layout), by, name, action, Some(&snap.name), None, true);
    Ok(snap.name)
}

/// `setSnapshotNote(name, ref, note)`: a short note shown beside the snapshot's name.
pub fn set_snapshot_note(
    layout: &Layout,
    by: &Actor,
    name: &str,
    reference: &str,
    note: &str,
) -> Result<(String, Option<String>), Failure> {
    let snap = resolve_snapshot(layout, name, reference)?;
    let mut squashed = String::new();
    let mut in_run = false;
    for c in note.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            if !in_run {
                squashed.push(' ');
            }
            in_run = true;
        } else {
            squashed.push(c);
            in_run = false;
        }
    }
    let units: Vec<u16> = js::trim(&squashed).encode_utf16().take(80).collect();
    let clean = String::from_utf16_lossy(&units);
    let clean = (!clean.is_empty()).then_some(clean);
    update_manifest(&snap, &[("note", json!(clean))])?;
    let detail = match &clean {
        Some(c) => format!("{}: {c}", snap.name),
        None => format!("{} (note removed)", snap.name),
    };
    activity::record_by(&roots(layout), by, name, "backup-note", Some(&detail), None, true);
    Ok((snap.name, clean))
}

/// `removeSnapshot(name, ref)`: the archive and its manifest together.
pub fn remove_snapshot(
    layout: &Layout,
    by: &Actor,
    name: &str,
    reference: &str,
) -> Result<Snapshot, Failure> {
    refuse_while_restoring(layout, name, "deleting a backup")?;
    let snap = resolve_snapshot(layout, name, reference)?;
    if js::truthy(field(&read_manifest(&manifest_name(&snap.path))?, "locked")) {
        return Err(Failure::user(format!(
            "{} is locked. Unlock it first if it really should go.",
            snap.name
        )));
    }
    rm_force(&snap.path)?;
    rm_force(&manifest_name(&snap.path))?;
    mirror_remove(name, &snap.name);
    activity::record_by(
        &roots(layout),
        by,
        name,
        "backup-delete",
        Some(&snap.name),
        None,
        true,
    );
    Ok(snap)
}

/// `pruneSnapshots(name, keep, { only, taskId })`: all but the newest `keep`. `only` limits it
/// to one label and `task_id` to one task's own backups; locked snapshots neither count toward
/// the limit nor go.
pub fn prune_snapshots(
    layout: &Layout,
    by: &Actor,
    name: &str,
    keep: f64,
    only: Option<&str>,
    task_id: Option<&str>,
) -> Result<Vec<Snapshot>, Failure> {
    if !(keep.is_finite() && keep.fract() == 0.0 && keep >= 1.0) {
        return Err(Failure::user("keep must be a whole number of at least 1"));
    }
    let remove: Vec<Snapshot> = list_snapshots(layout, name)?
        .into_iter()
        .filter(|s| only.is_none_or(|o| s.label.as_str() == Some(o)))
        .filter(|s| task_id.is_none_or(|t| s.task_id.as_str() == Some(t)))
        .filter(|s| !s.locked)
        .skip(keep as usize)
        .collect();
    for snap in &remove {
        rm_force(&snap.path)?;
        rm_force(&manifest_name(&snap.path))?;
        mirror_remove(name, &snap.name);
    }
    if !remove.is_empty() {
        activity::record_by(
            &roots(layout),
            by,
            name,
            "backup-prune",
            Some(&format!(
                "{} removed, the newest {} kept",
                remove.len(),
                js::number_to_string(keep)
            )),
            None,
            true,
        );
    }
    Ok(remove)
}

/// `removeFiles(name, snap)`: false when the archive would not go (on Windows, a file someone is
/// downloading stays), and then its manifest stays too.
fn remove_files(name: &str, snap: &Snapshot) -> Result<bool, Failure> {
    if rm_force(&snap.path).is_err() {
        return Ok(false);
    }
    rm_force(&manifest_name(&snap.path))?;
    mirror_remove(name, &snap.name);
    Ok(true)
}

/// `REMOVE_MANY_LIMIT`.
pub const REMOVE_MANY_LIMIT: usize = 500;

/// What [`remove_snapshots`] did: the names removed, their bytes, and the names left with why
/// (`missing`, `locked` or `busy`).
#[derive(Debug, Clone)]
pub struct RemovedMany {
    pub removed: Vec<String>,
    pub size: u64,
    pub skipped: Vec<(String, &'static str)>,
}

/// `removeSnapshots(name, refs)`: several at once, by their exact names. A locked one, one that
/// is gone or one that is open somewhere is left and said; the rest still go.
pub fn remove_snapshots(
    layout: &Layout,
    by: &Actor,
    name: &str,
    refs: &[String],
) -> Result<RemovedMany, Failure> {
    refuse_while_restoring(layout, name, "deleting backups")?;
    if refs.is_empty() {
        return Err(Failure::user("which backups?"));
    }
    if refs.len() > REMOVE_MANY_LIMIT {
        return Err(Failure::user(format!(
            "at most {REMOVE_MANY_LIMIT} backups at a time"
        )));
    }
    let all = list_snapshots(layout, name)?;
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    let mut size = 0u64;
    let mut seen: Vec<&String> = Vec::new();
    for r in refs {
        if seen.contains(&r) {
            continue;
        }
        seen.push(r);
        // the last of a repeated name wins, as in a Map
        let Some(snap) = all.iter().rev().find(|s| &s.name == r) else {
            skipped.push((r.clone(), "missing"));
            continue;
        };
        if snap.locked {
            skipped.push((r.clone(), "locked"));
            continue;
        }
        if !remove_files(name, snap)? {
            skipped.push((r.clone(), "busy"));
            continue;
        }
        removed.push(snap.name.clone());
        size += snap.size;
    }
    if removed.len() == 1 {
        activity::record_by(
            &roots(layout),
            by,
            name,
            "backup-delete",
            Some(&removed[0]),
            None,
            true,
        );
    } else if !removed.is_empty() {
        activity::record_by(
            &roots(layout),
            by,
            name,
            "backup-delete",
            Some(&format!(
                "{} backups, {}",
                removed.len(),
                text::human_bytes(Some(size as f64))
            )),
            None,
            true,
        );
    }
    Ok(RemovedMany {
        removed,
        size,
        skipped,
    })
}

/// `COPY_DAYS`: how old a small copy must be before the clean-up a server turned on removes it.
pub const COPY_DAYS: f64 = 30.0;

/// `oldCopies(name, { now, days })`: small copies past the age, never one somebody locked or put
/// a note on, nor the copy of something deleted in Files.
pub fn old_copies(layout: &Layout, name: &str, now: f64, days: f64) -> Result<Vec<Snapshot>, Failure> {
    let before = now - days * 24.0 * 3600.0 * 1000.0;
    Ok(list_snapshots(layout, name)?
        .into_iter()
        .filter(|s| {
            s.copy
                && s.label != json!("file-delete")
                && !s.locked
                && !js::truthy(Some(&s.note))
                && s.mtime_ms < before
        })
        .collect())
}

/// `cleanCopies(name, { only })`: removes [`old_copies`]; one that will not go now is tried again
/// by the next clean-up. Answers the names removed and their bytes.
pub fn clean_copies(
    layout: &Layout,
    by: &Actor,
    name: &str,
    only: Option<&[String]>,
) -> Result<(Vec<String>, u64), Failure> {
    if is_restoring(layout, name) {
        return Ok((Vec::new(), 0));
    }
    let days = COPY_DAYS;
    let mut gone = Vec::new();
    let mut size = 0u64;
    for snap in old_copies(layout, name, crate::time::now_ms() as f64, days)? {
        if only.is_some_and(|o| !o.contains(&snap.name)) {
            continue;
        }
        if !remove_files(name, &snap)? {
            continue;
        }
        gone.push(snap.name.clone());
        size += snap.size;
    }
    if !gone.is_empty() {
        let n = gone.len();
        activity::record_by(
            &roots(layout),
            by,
            name,
            "backup-prune",
            Some(&format!(
                "{n} small {} older than {} days, {}",
                if n == 1 { "copy" } else { "copies" },
                js::number_to_string(days),
                text::human_bytes(Some(size as f64))
            )),
            None,
            true,
        );
    }
    Ok((gone, size))
}

/// `snapshotNames(name)`: the archives a server has, by name.
pub fn snapshot_names(layout: &Layout, name: &str) -> Vec<String> {
    fsx::readdir_names(Path::new(&join(&layout.backups_dir, &[name])))
        .map(|n| n.into_iter().filter(|f| f.ends_with(".tar.gz")).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_patterns_and_names() {
        assert_eq!(slug_of("before 1.21!"), "before-1-21-");
        assert_eq!(slug_of("é😀"), "---");
        assert_eq!(literal_pattern("a[b]*?.txt"), "a[[]b][*][?].txt");
        assert_eq!(manifest_name("/b/x.tar.gz"), "/b/x.json");
        assert!(is_partial_snapshot_name(
            "pre-install_plugins_2026-11-01_101010.tar.gz"
        ));
        assert!(!is_partial_snapshot_name("standard_2026-11-01_101010.tar.gz"));
        assert!(is_null_line("tar: (null)"));
        assert!(is_null_line("TAR.EXE:   (null)"));
        assert!(!is_null_line("tar: x (null)"));
        assert_eq!(split_lines("a\r\nb\nc\r"), vec!["a", "b", "c\r"]);
    }

    #[test]
    fn problems_from_warnings() {
        let w = json!([
            "could not flush the world before the snapshot (x); the copy may be torn",
            "database shop on db1 not included: the database is not running",
            "database cache on g1 not included: Redis (Garnet) keeps its own checkpoints; it is not dumped",
            "plugins/x.db not included: another program has it locked, usually the running server",
        ]);
        assert_eq!(
            snapshot_problems(Some(&w)),
            vec![
                "Taken while the server was running and it could not be asked to save first, so the world in it may be incomplete.".to_string(),
                "Does not include the database shop (db1): the database is not running.".to_string(),
            ]
        );
        assert!(snapshot_problems(Some(&json!("x"))).is_empty());
    }

    #[test]
    fn change_copies_by_manifest_and_label() {
        assert!(is_change_copy(
            &json!({"scope": "plugins", "label": "pre-install"})
        ));
        assert!(!is_change_copy(
            &json!({"scope": "plugins", "label": "pre-install", "changeCopy": false})
        ));
        assert!(is_change_copy(
            &json!({"scope": "files", "label": "mine", "changeCopy": true})
        ));
        assert!(!is_change_copy(
            &json!({"scope": "files", "label": "file-edit", "taskId": "t"})
        ));
        assert!(!is_change_copy(
            &json!({"scope": "standard", "label": "file-edit"})
        ));
        assert!(!is_change_copy(
            &json!({"scope": "files", "label": "world-delete"})
        ));
    }

    #[test]
    fn leave_out_lists() {
        let ok = clean_exclude_patterns(&[
            " ./plugins/dynmap/web/ ".into(),
            "# comment".into(),
            "*.log".into(),
            "*.log".into(),
            "a\\b".into(),
        ])
        .unwrap();
        assert_eq!(ok, vec!["plugins/dynmap/web", "*.log", "a/b"]);
        assert!(clean_exclude_patterns(&["../x".into()]).is_err());
        assert!(clean_exclude_patterns(&["C:/x".into()]).is_err());
        assert!(clean_exclude_patterns(&["**".into()]).is_err());
    }
}
