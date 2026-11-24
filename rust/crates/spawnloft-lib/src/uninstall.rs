//! `uninstall.mjs`: what runs before the uninstaller removes the program.
//!
//! The program folder is removed and nothing else, so reinstalling doesn't lose worlds, but
//! scheduled tasks and running servers are always cleared: both would otherwise outlive the
//! program with nothing to stop them.
//!
//! Deleting data is the person's choice and never "delete the data folder", which may sit on a
//! drive with other things. Only what this program created is removed, never an adopted server,
//! and folders only if that leaves them empty.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::activity::Actor;
use crate::failure::Failure;
use crate::registry::Instance;
use crate::schedule::Sched;
use crate::settings::Layout;
use crate::{control, js, jspath, manage, paths, registry, supervisor};

/// `path.sep === '\\'`: Windows paths compare without case.
const CASELESS: bool = cfg!(windows);

/// `sameDir(a, b)`.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |d: &str| {
        let r = jspath::resolve(d);
        if CASELESS { r.to_lowercase() } else { r }
    };
    norm(a) == norm(b)
}

/// A chosen backups folder: only files SpawnLoft provably wrote are swept from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sweep {
    pub root: String,
    pub names: Vec<String>,
}

/// `backupTargets`: the default backups folder inside the data root goes whole; a folder the
/// person chose may hold anything, so it is swept instead (see [`sweep_backups`]).
pub fn backup_targets(instances: &[Instance], layout: &Layout) -> (Vec<String>, Option<Sweep>) {
    let root = &layout.backups_dir;
    if root.is_empty() {
        return (Vec::new(), None);
    }
    if same_dir(root, &jspath::join(&[&layout.data_root, "backups"])) {
        return (vec![root.clone()], None);
    }
    let mut names: Vec<String> = Vec::new();
    for i in instances {
        if !i.name.is_empty() && !names.contains(&i.name) {
            names.push(i.name.clone());
        }
    }
    (
        Vec::new(),
        Some(Sweep {
            root: root.clone(),
            names,
        }),
    )
}

// what backup.mjs, services.mjs and the exports write: a timestamp from util.stamp() in the name.
// JavaScript's `/i` folds ASCII letters only here, so the letters are spelt out in both cases
// rather than given to the regex crate's Unicode case folding (which would let `K`, the Kelvin
// sign, stand for `k`).
static STAMPED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}").unwrap());
static EXPORT_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}(_[0-9]+)?\.([zZ][iI][pP]|[lL][oO][gG])$").unwrap()
});
const TAR_GZ: &str = r"\.[tT][aA][rR]\.[gG][zZ]";
const SQL: &str = r"\.[sS][qQ][lL]";
// `.` in JavaScript stops at a line terminator
static SNAPSHOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^([^\n\r\u{{2028}}\u{{2029}}]+){TAR_GZ}$")).unwrap());
static DUMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^([A-Za-z0-9_.-]+){SQL}$")).unwrap());
static PENDING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"({TAR_GZ}|{SQL})\.[pP][eE][nN][dD][iI][nN][gG]$")).unwrap());

fn read_manifest(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    let m = crate::jsjson::parse(&text).ok()?;
    // `m && typeof m === 'object'`: an array counts
    matches!(m, Value::Object(_) | Value::Array(_)).then_some(m)
}

fn is_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file())
}

fn is_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// `fs.readdirSync(dir)` in its order, `None` when it cannot be read.
fn names_in(dir: &Path) -> Option<Vec<String>> {
    crate::fsx::readdir_names(dir).ok()
}

/// `sweepFiles(dir, folder, { known })`: the files SpawnLoft wrote in one subfolder of a chosen
/// backups folder. A snapshot or database backup is SpawnLoft's when its `.json` manifest names
/// this folder; leftovers with no manifest are claimed only in a folder named after a server or
/// database SpawnLoft knows, and only by their exact shape.
pub fn sweep_files(dir: &str, folder: &str, known: bool, caseless: bool) -> Vec<String> {
    let same = |a: &str, b: &str| {
        if caseless {
            a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };
    let mut files: Vec<String> = Vec::new();
    let Some(entries) = names_in(Path::new(dir)) else {
        return files;
    };
    for f in entries {
        let full = jspath::join(&[dir, &f]);
        if !is_file(Path::new(&full)) {
            continue;
        }
        let snap = SNAPSHOT.captures(&f).map(|c| c[1].to_string());
        let dump = DUMP.captures(&f).map(|c| c[1].to_string());
        if let Some(base) = snap.clone().or(dump) {
            let manifest = jspath::join(&[dir, &format!("{base}.json")]);
            let m = read_manifest(Path::new(&manifest));
            let owner = m
                .as_ref()
                .and_then(|m| m.get(if snap.is_some() { "instance" } else { "database" }));
            // Node's `owner === folder` off Windows: only a string owner names the folder there;
            // caseless, any truthy owner is turned into text first, as `String(owner)` does
            let owned = match owner {
                Some(Value::String(o)) => !o.is_empty() && same(o, folder),
                o if caseless => js::truthy(o) && same(&js::string(o), folder),
                _ => false,
            };
            if owned || (known && STAMPED.is_match(&f)) {
                files.push(full);
                if m.is_some() {
                    files.push(manifest);
                }
            }
        } else if known && (f == ".snapshot.lock" || (PENDING.is_match(&f) && STAMPED.is_match(&f))) {
            files.push(full);
        }
    }
    let exports = jspath::join(&[dir, "exports"]);
    if known && is_dir(Path::new(&exports)) {
        for f in names_in(Path::new(&exports)).unwrap_or_default() {
            let full = jspath::join(&[&exports, &f]);
            if EXPORT_FILE.is_match(&f) && is_file(Path::new(&full)) {
                files.push(full);
            }
        }
    }
    let mut seen = HashSet::new();
    files.retain(|f| seen.insert(f.clone()));
    files
}

/// What a purge removed and what it could not.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub stopped: Vec<String>,
    pub tasks: bool,
    pub removed: Vec<String>,
    pub failed: Vec<String>,
}

fn rm_file(file: &str, log: &mut dyn FnMut(&str), result: &mut Outcome) {
    log(&format!("deleting {file}"));
    match manage::rm_rf(Path::new(file)) {
        Ok(()) => result.removed.push(file.to_string()),
        Err(e) => result.failed.push(format!("{file}: {}", e.message())),
    }
}

/// `sweepBackups({ root, names })`.
pub fn sweep_backups(sweep: &Sweep, log: &mut dyn FnMut(&str), result: &mut Outcome, caseless: bool) {
    let key = |n: &str| if caseless { n.to_lowercase() } else { n.to_string() };
    let known: HashSet<String> = sweep
        .names
        .iter()
        .map(String::as_str)
        .chain(["client"])
        .map(key)
        .collect();
    let Some(subs) = names_in(Path::new(&sweep.root)) else {
        return;
    };
    for sub in subs {
        let dir = jspath::join(&[&sweep.root, &sub]);
        if !is_dir(Path::new(&dir)) {
            continue;
        }
        for file in sweep_files(&dir, &sub, known.contains(&key(&sub)), caseless) {
            rm_file(&file, log, result);
        }
        rmdir_if_empty(&jspath::join(&[&dir, "exports"]));
        rmdir_if_empty(&dir);
    }
    rmdir_if_empty(&sweep.root);
}

/// What a purge deletes: `remove` whole, `remove_if_empty` deepest first, and a chosen backups
/// folder to sweep.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Targets {
    pub remove: Vec<String>,
    pub remove_if_empty: Vec<String>,
    pub sweep: Option<Sweep>,
}

fn dedupe(list: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

/// `purgeTargets`, pure so it can be tested.
pub fn purge_targets(
    instances: &[Instance],
    layout: &Layout,
    settings: &str,
    other_settings: Option<&str>,
    desktop_dirs: &[String],
) -> Targets {
    let mut remove = Vec::new();
    for inst in instances {
        // adopted servers were the person's before this program saw them
        if js::truthy(inst.get("origin").and_then(|o| o.get("adopted"))) {
            continue;
        }
        if let Some(Value::String(d)) = inst.get("dir") {
            remove.push(d.clone());
        }
    }
    let (backups, sweep) = backup_targets(instances, layout);
    remove.push(layout.jars_dir.clone());
    remove.extend(backups);
    remove.extend([
        layout.templates_dir.clone(),
        layout.run_dir.clone(),
        layout.engines_dir.clone(),
        jspath::join(&[&layout.data_root, "tasks"]),
        layout.registry_file.clone(),
        settings.to_string(),
    ]);
    remove.extend(other_settings.map(str::to_string));
    remove.extend(desktop_dirs.iter().cloned());
    // inner folders first, so a backups folder inside the data root can empty it
    let mut if_empty = vec![
        layout.instances_dir.clone(),
        layout.services_dir.clone(),
        layout.data_root.clone(),
        jspath::dirname(settings),
    ];
    if_empty.extend(other_settings.map(jspath::dirname));
    // deepest first, so a folder emptied by its children's removal goes too
    let depth = |d: &str| {
        jspath::resolve(d)
            .split(['\\', '/'])
            .filter(|s| !s.is_empty())
            .count()
    };
    let mut ordered = dedupe(if_empty);
    ordered.sort_by_key(|d| std::cmp::Reverse(depth(d)));
    Targets {
        remove: dedupe(remove),
        remove_if_empty: ordered,
        sweep,
    }
}

/// `desktopDataDirs()`: Electron's folders for the 1.x desktop app (window position, updater
/// cache), claimed only if they hold window-state.json, in case another app shares the name.
pub fn desktop_data_dirs() -> Vec<String> {
    let base = paths::config_base();
    ["SpawnLoft", "mcctl-desktop"]
        .iter()
        .map(|n| jspath::join(&[&base.to_string_lossy(), n]))
        .filter(|d| Path::new(&jspath::join(&[d, "window-state.json"])).exists())
        .collect()
}

/// `rmdirIfEmpty`: in use or not empty, it stays.
fn rmdir_if_empty(dir: &str) {
    let p = Path::new(dir);
    if p.exists() && names_in(p).is_some_and(|n| n.is_empty()) {
        let _ = std::fs::remove_dir(p);
    }
}

/// `applyTargets`: deletes what [`purge_targets`] planned.
pub fn apply_targets(targets: &Targets, log: &mut dyn FnMut(&str), result: &mut Outcome) {
    for target in &targets.remove {
        rm_file(target, log, result);
    }
    // before the empty-folder pass, so a chosen backups folder inside the data root can empty it
    if let Some(sweep) = &targets.sweep {
        sweep_backups(sweep, log, result, CASELESS);
    }
    for dir in &targets.remove_if_empty {
        rmdir_if_empty(dir);
    }
}

/// The settings file that is shadowed: `mcctl/settings.json` when both it and
/// `spawnloft/settings.json` exist (`shadowedSettingsFile`).
pub fn shadowed_settings_file() -> Option<String> {
    let base = paths::config_base();
    let current = base.join("spawnloft").join("settings.json");
    let legacy = base.join("mcctl").join("settings.json");
    (current.exists() && legacy.exists()).then(|| jspath::normalize(&legacy.to_string_lossy()))
}

/// `run({ data, log })`: every running server stopped (killed if it will not stop), every
/// scheduled task removed, and with `data` what this program created deleted.
pub fn run(
    layout: &Layout,
    by: &Actor,
    sched: &Sched,
    data: bool,
    log: &mut dyn FnMut(&str),
) -> Result<Outcome, Failure> {
    let mut result = Outcome::default();
    let registry_file = Path::new(&layout.registry_file);

    // servers first: a daemon that outlives the program is a Java process nobody can stop
    for inst in registry::list_all(registry_file)? {
        // a state file that cannot be read may belong to a live server: stopped all the same
        let active = control::read_state(Path::new(&layout.state_file(&inst.name)))
            .map_or(true, |(s, _)| control::is_active_status(s));
        if !active {
            continue;
        }
        log(&format!("stopping {}", inst.name));
        if supervisor::stop(layout, by, &inst.name, 60_000.0).is_err() {
            // may already be gone
            let _ = supervisor::kill(layout, by, &inst.name);
        }
        result.stopped.push(inst.name.clone());
    }

    log("removing scheduled tasks");
    match sched.remove_all() {
        Ok((true, _)) => result.tasks = true,
        // a task Task Scheduler would not delete (one made from an administrator prompt, which
        // an ordinary account may only read) keeps its definition and its shim: say which, and
        // how, with a command that still exists once the uninstaller has removed this program
        Ok((false, left)) => result.failed.push(if cfg!(windows) {
            format!(
                "scheduled tasks still there: {}. From an administrator prompt, run for each: \
                 schtasks /Delete /TN \"\\{}\\<id>\" /F",
                left.join(", "),
                crate::schedule::TASK_FOLDER
            )
        } else {
            format!(
                "scheduled tasks still there: {}. Remove them with `spawnloft task rm <id>`",
                left.join(", ")
            )
        }),
        Err(e) => result.failed.push(format!("scheduled tasks: {}", e.message())),
    }

    if !data {
        return Ok(result);
    }
    let instances = registry::list_all(registry_file)?;
    let targets = purge_targets(
        &instances,
        layout,
        &layout.settings_file,
        shadowed_settings_file().as_deref(),
        &desktop_data_dirs(),
    );
    apply_targets(&targets, log, &mut result);
    Ok(result)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout(root: &str, backups: &str) -> Layout {
        let j = |n: &str| format!("{root}/{n}");
        Layout {
            data_root: root.into(),
            instances_dir: j("instances"),
            separate_instances: false,
            registry_file: j("instances.json"),
            templates_dir: j("templates"),
            jars_dir: j("jars"),
            backups_dir: backups.into(),
            run_dir: j("run"),
            engines_dir: j("engines"),
            services_dir: j("services"),
            settings_file: "/cfg/spawnloft/settings.json".into(),
        }
    }

    fn inst(name: &str, cfg: Value) -> Instance {
        registry::spread(name, &cfg)
    }

    #[test]
    fn an_adopted_server_and_a_chosen_backups_folder_are_never_removed_whole() {
        let l = layout("/d", "/mine/backups");
        let list = [
            inst("own", json!({ "dir": "/d/instances/own" })),
            inst(
                "theirs",
                json!({ "dir": "/srv/theirs", "origin": { "adopted": true } }),
            ),
        ];
        let t = purge_targets(&list, &l, &l.settings_file, None, &[]);
        assert!(t.remove.contains(&"/d/instances/own".to_string()));
        assert!(
            !t.remove
                .iter()
                .any(|r| r.contains("theirs") || r.contains("/mine"))
        );
        assert_eq!(
            t.sweep,
            Some(Sweep {
                root: "/mine/backups".into(),
                names: vec!["own".into(), "theirs".into()]
            })
        );
        // deepest first
        assert_eq!(
            t.remove_if_empty,
            ["/d/instances", "/d/services", "/cfg/spawnloft", "/d"]
        );
        let default = purge_targets(&list, &layout("/d", "/d/backups"), "/s.json", None, &[]);
        assert!(default.remove.contains(&"/d/backups".to_string()) && default.sweep.is_none());
    }

    #[test]
    fn only_what_spawnloft_wrote_is_swept() {
        let dir = std::env::temp_dir().join(format!("sl-sweep-{}", std::process::id()));
        let d = dir.join("Alpha");
        std::fs::create_dir_all(d.join("exports")).unwrap();
        for f in [
            "a.tar.gz",
            "standard_2026-01-01_000000.tar.gz",
            "x_2026-01-01_000000.sql.pending",
            ".snapshot.lock",
            "notes.txt",
            "exports/alpha_2026-01-01_000000.ZIP",
            "exports/keep.zip",
            "\u{212a}_2026-01-01_000000.sql",
        ] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        std::fs::write(d.join("a.json"), r#"{"instance":"alpha"}"#).unwrap();
        let s = d.to_string_lossy().into_owned();
        let names =
            |v: Vec<String>| -> Vec<String> { v.iter().map(|f| f[s.len() + 1..].to_string()).collect() };
        // unknown folder: only the manifest-owned snapshot, and only when the case matches
        assert!(sweep_files(&s, "Alpha", false, false).is_empty());
        assert_eq!(
            names(sweep_files(&s, "Alpha", false, true)),
            ["a.tar.gz", "a.json"]
        );
        // a known folder: the stamped leftovers too, never notes.txt or keep.zip, and not a dump
        // whose name starts with the Kelvin sign (JavaScript's \w is ASCII)
        let known = names(sweep_files(&s, "Alpha", true, false));
        assert_eq!(
            known,
            [
                ".snapshot.lock",
                "standard_2026-01-01_000000.tar.gz",
                "x_2026-01-01_000000.sql.pending",
                "exports/alpha_2026-01-01_000000.ZIP",
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
