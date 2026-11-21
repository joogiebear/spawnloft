//! `manage.mjs`: what changes a server as a whole. C4 ports `rebuild` and `reveal` (with its
//! `openFolder`); C6 `rename` and `destroy`, which call the scheduler.

use std::path::Path;

use serde_json::{Value, json};

use crate::activity::{self, Actor};
use crate::backup;
use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{control, files, jspath, props};

/// `assertStopped(name, verb)`: refuses while the server runs, stops, is out of reach, or is
/// being restored.
fn assert_stopped(layout: &Layout, name: &str, verb: &str) -> Result<(), Failure> {
    match control::active_block(Path::new(&layout.state_file(name)), name, verb)? {
        Some(why) => Err(Failure::user(why)),
        None => Ok(()),
    }
}

/// What `rebuild` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rebuilt {
    pub removed: Vec<String>,
    pub kept_plugins: bool,
    pub snapshot: Option<String>,
}

/// `fs.rmSync(target, { recursive: true, force: true })`: a link is removed, not followed.
pub fn rm_rf(target: &Path) -> Result<(), Failure> {
    let res = match std::fs::symlink_metadata(target) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(target),
        // a junction or folder link on Windows is removed with rmdir, as rmSync falls back to
        Ok(_) => std::fs::remove_file(target).or_else(|e| {
            if cfg!(windows) && e.kind() != std::io::ErrorKind::NotFound {
                std::fs::remove_dir(target).map_err(|_| e)
            } else {
                Err(e)
            }
        }),
        Err(_) => return Ok(()),
    };
    match res {
        Err(e) if !jspath::is_enoent(&e) => Err(Failure::io(&e, "rm", Some(target))),
        _ => Ok(()),
    }
}

/// `rebuild(name, { keepPlugins, snapshot })`: the worlds and generated state deleted, the jar,
/// ports, memory and name kept. The wipe list is explicit so a wrong guess cannot delete
/// something valuable; a snapshot is taken first unless asked not to.
pub fn rebuild(
    layout: &Layout,
    by: &Actor,
    name: &str,
    keep_plugins: bool,
    snapshot: bool,
) -> Result<Rebuilt, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    assert_stopped(layout, name, "rebuilding it")?;

    let mut snapshot_file = None;
    if snapshot {
        let opts = backup::Options {
            label: json!("pre-rebuild"),
            quiet: true,
            ..backup::Options::default()
        };
        let made = backup::create_snapshot(layout, by, &inst, &opts)?;
        snapshot_file = Some(made.file);
    }

    // worlds are whatever level-name says, not necessarily "world"
    let dir = crate::create::path_arg(inst.get("dir"), "path")?.to_string();
    let p = props::read(Path::new(&jspath::join(&[&dir, "server.properties"])))?;
    let level = props::get(&p, "level-name")
        .filter(|l| !l.is_empty())
        .unwrap_or("world")
        .to_string();
    let mut wipe = vec![
        level.clone(),
        format!("{level}_nether"),
        format!("{level}_the_end"),
    ];
    wipe.extend(
        [
            "logs",
            "cache",
            "crash-reports",
            "usercache.json",
            "usernamecache.json",
            "banned-ips.json",
            "banned-players.json",
            "ops.json",
            "whitelist.json",
            "session.lock",
        ]
        .map(String::from),
    );
    if !keep_plugins {
        wipe.push("plugins".into());
    }
    let mut removed = Vec::new();
    for entry in wipe {
        let target = jspath::join(&[&dir, &entry]);
        if Path::new(&target).exists() {
            rm_rf(Path::new(&target))?;
            removed.push(entry);
        }
    }
    // the first line after a rebuild belongs to the new server
    let log = layout.console_log(name);
    if Path::new(&log).exists() {
        rm_rf(Path::new(&log))?;
    }
    let detail = if keep_plugins {
        "fresh worlds, plugins kept"
    } else {
        "fresh worlds and plugins"
    };
    let snap_base = snapshot_file.as_deref().map(jspath::basename);
    activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        name,
        "rebuild",
        Some(detail),
        snap_base.as_deref(),
        true,
    );
    Ok(Rebuilt {
        removed,
        kept_plugins: keep_plugins,
        snapshot: snapshot_file,
    })
}

/// The folders `reveal` may open below a server's own, by name: `sub` arrives over HTTP and is
/// matched against this list, never used as a path.
const SUBS: [&str; 4] = ["crash-reports", "plugins", "mods", "logs"];

/// `reveal(name, sub, folder)`: opens the server's folder (or one of [`SUBS`], or a folder inside
/// it) in the file manager; answers the folder.
pub fn reveal(
    layout: &Layout,
    name: &str,
    sub: Option<&str>,
    folder: Option<&str>,
) -> Result<String, Failure> {
    let inst: Instance = registry::lookup(Path::new(&layout.registry_file), name)?;
    // without a sub the record's dir is used as it is, `undefined` and all
    let mut target = match sub {
        Some(s) if SUBS.contains(&s) => jspath::join(&[crate::create::path_arg(inst.get("dir"), "path")?, s]),
        _ => crate::js::string(inst.get("dir")),
    };
    if let Some(f) = folder.filter(|f| !f.is_empty()) {
        let r = files::resolve_path(&inst, Some(f), true, true)?;
        match &r.stat {
            None => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'isDirectory')",
                ));
            }
            Some(m) if !m.is_dir() => {
                return Err(Failure::user(format!("{} is not a folder", r.rel)));
            }
            Some(_) => {}
        }
        target = r.full.to_string_lossy().into_owned();
    }
    open_folder(&target)
}

/// Why the opener could not start, as `openFolder` words it.
fn refused(target: &str, e: &std::io::Error, cmd: &str) -> Failure {
    if jspath::is_enoent(e) {
        Failure::user(format!(
            "This computer has no file manager to open folders with. The folder is {target}"
        ))
    } else {
        Failure::user(format!(
            "Could not open the folder (spawn {cmd} {}). It is {target}",
            jspath::error_code(e).0
        ))
    }
}

/// `openFolder(target)`: the system's file manager on `target` (Explorer, Finder, `xdg-open`),
/// once the opener has started; its exit code is not waited for (Explorer exits non-zero even
/// when it worked). A Linux machine with no display is refused: reached over SSH it would have
/// `xdg-open` start, find no desktop and exit, and the page would say the folder opened.
pub fn open_folder(target: &str) -> Result<String, Failure> {
    let cmd = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if !cfg!(windows) && !cfg!(target_os = "macos") && !set("DISPLAY") && !set("WAYLAND_DISPLAY") {
        return Err(Failure::user(format!(
            "This computer has no desktop to open folders on. The folder is {target}"
        )));
    }
    let mut c = std::process::Command::new(cmd);
    c.arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::cancel::own_group(&mut c);
    match c.spawn() {
        // detached and unreferenced: nothing waits for it
        Ok(_child) => Ok(target.to_string()),
        Err(e) => Err(refused(target, &e, cmd)),
    }
}

/// `sameEntry(a, b)`: on a disk that ignores case (Windows, macOS by default) `backups/gamma`
/// exists as soon as `backups/Gamma` does, because it is the same folder; a rename that only
/// changes capitals must not read that as someone else's folder in the way.
pub fn same_entry(a: &str, b: &str) -> bool {
    crate::platform::same_entry(Path::new(a), Path::new(b))
}

/// `err.message` of a failed `renameSync(a, b)`.
fn rename_message(e: &std::io::Error, a: &str, b: &str) -> String {
    let (code, text) = jspath::error_code(e);
    format!("{code}: {text}, rename '{a}' -> '{b}'")
}

/// What `rename` did.
#[derive(Debug, Clone, PartialEq)]
pub struct Renamed {
    pub dir: String,
    pub moved_dir: bool,
    pub tasks_moved: usize,
}

/// `rename(oldName, newName)`: the server's record, snapshots, run folder, mirror copies,
/// launchers and scheduled tasks move to the new name. The folder moves only when it sits where
/// SpawnLoft put it; an adopted server keeps its path.
pub fn rename(layout: &Layout, by: &Actor, old: &str, new: &str) -> Result<Renamed, Failure> {
    let reg = Path::new(&layout.registry_file);
    // the registry's own rule, checked first: refusing the name once the folder had moved would
    // lose the server
    if registry::validate_name(new).is_err() {
        return Err(Failure::user(format!(
            "\"{new}\" is not a usable name - start with a letter or digit, then letters, digits, dash or underscore, up to 32 characters."
        )));
    }
    let inst = registry::lookup(reg, old)?;
    if registry::entries_of(&registry::load(reg)?)
        .iter()
        .any(|(k, _)| k == new)
    {
        return Err(Failure::user(format!("\"{new}\" already exists")));
    }
    // Windows and macOS see "gamma" and "Gamma" as one folder and one task name
    if let Some(clash) = registry::list_all(reg)?
        .into_iter()
        .find(|i| i.name != old && i.name.to_lowercase() == new.to_lowercase())
    {
        return Err(Failure::user(format!(
            "\"{}\" already exists, and \"{new}\" differs from it only in capitals",
            clash.name
        )));
    }
    assert_stopped(layout, old, "renaming it")?;
    let mut cfg = inst.fields.clone();
    cfg.shift_remove("name");

    // Snapshots move first, while backing out is free: they are keyed by the name, and this is
    // the one step worth refusing the rename over.
    let old_backups = jspath::join(&[&layout.backups_dir, old]);
    let new_backups = jspath::join(&[&layout.backups_dir, new]);
    let mut moved_backups = false;
    if Path::new(&old_backups).exists() {
        if Path::new(&new_backups).exists() && !same_entry(&old_backups, &new_backups) {
            return Err(Failure::user(format!(
                "{new_backups} already holds snapshots - from an earlier server called \"{new}\".\n  \"{old}\" has not been renamed. Move or delete that folder first, or pick another name."
            )));
        }
        if let Err(e) = std::fs::rename(&old_backups, &new_backups) {
            return Err(Failure::user(format!(
                "could not move the snapshots from {old_backups} to {new_backups}: {}\n  \"{old}\" has not been renamed. Close anything reading that folder and try again.",
                rename_message(&e, &old_backups, &new_backups)
            )));
        }
        moved_backups = true;
    }

    let dir = crate::create::path_arg(inst.get("dir"), "paths[0]")?.to_string();
    let was_default = jspath::resolve(&dir) == jspath::resolve(&jspath::join(&[&layout.instances_dir, old]));
    let mut new_dir = dir.clone();
    if was_default {
        let dest = jspath::join(&[&layout.instances_dir, new]);
        if let Err(e) = std::fs::rename(&dir, &dest) {
            if moved_backups {
                let _ = std::fs::rename(&new_backups, &old_backups);
            }
            return Err(Failure::user(format!(
                "could not move {dir} to {dest}: {}",
                rename_message(&e, &dir, &dest)
            )));
        }
        cfg.insert("dir".into(), json!(dest));
        new_dir = dest;
    }

    // the run folder (console log, state file) is keyed by name; a locked console log is not
    // worth failing over
    let old_run = layout.run_dir_of(old);
    if Path::new(&old_run).exists() {
        let _ = std::fs::rename(&old_run, layout.run_dir_of(new));
    }

    registry::remove_instance(reg, old)?;
    registry::put_instance(reg, new, Value::Object(cfg.clone()))?;

    // the mirror is keyed by name too, or retention would never find the old copies
    if let Ok(Some(mirror)) = backup::mirror_root() {
        let from = jspath::join(&[&mirror, old]);
        let to = jspath::join(&[&mirror, new]);
        if Path::new(&from).exists() && (!Path::new(&to).exists() || same_entry(&from, &to)) {
            let _ = std::fs::rename(&from, &to);
        }
    }

    // the launchers carry the name; a convenience, never a reason to fail
    let _ = crate::create::write_launchers(new, cfg.get("dir"));

    // tasks name the server: done last, and never a failure, since the server has already moved
    let sched = crate::schedule::Sched::new(&layout.data_root, &layout.run_dir, by.clone());
    let tasks_moved = sched.rename_instance(old, new).map_or(0, |(n, _)| n);
    let roots = Roots::new(&layout.data_root);
    activity::rename_server(&roots, old, new);
    activity::record_by(
        &roots,
        by,
        new,
        "rename",
        Some(&format!("from {old}")),
        None,
        true,
    );
    Ok(Renamed {
        dir: new_dir,
        moved_dir: was_default,
        tasks_moved,
    })
}

/// What `destroy` did.
#[derive(Debug, Clone, PartialEq)]
pub struct Destroyed {
    pub purged: bool,
    pub snapshot: Option<String>,
    pub tasks_removed: usize,
}

/// `destroy(name, { purge, snapshot })` (the panel's and MCP's delete): a snapshot first when
/// the files are going, the files before the record (a failed delete leaves the server
/// registered), then its scheduled tasks.
pub fn destroy(
    layout: &Layout,
    by: &Actor,
    name: &str,
    purge: bool,
    snapshot: bool,
) -> Result<Destroyed, Failure> {
    let reg = Path::new(&layout.registry_file);
    let inst = registry::lookup(reg, name)?;
    assert_stopped(layout, name, "deleting it")?;
    let mut snapshot_file = None;
    if purge && snapshot {
        let opts = backup::Options {
            label: json!("pre-delete"),
            quiet: true,
            ..backup::Options::default()
        };
        snapshot_file = Some(backup::create_snapshot(layout, by, &inst, &opts)?.file);
    }
    if purge {
        let dir = crate::create::path_arg(inst.get("dir"), "path")?.to_string();
        if let Err(f) = rm_rf(Path::new(&dir)) {
            return Err(Failure::user(format!(
                "could not delete {dir}: {}\n  \"{name}\" is still registered. Close anything using that folder and try again.",
                f.message()
            )));
        }
    }
    registry::remove_instance(reg, name)?;
    let sched = crate::schedule::Sched::new(&layout.data_root, &layout.run_dir, by.clone());
    let tasks_removed = sched.remove_for_instance(name).unwrap_or(0);
    let snap = snapshot_file.as_deref().map(jspath::basename);
    activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        name,
        "delete",
        Some(if purge { "files deleted" } else { "files kept" }),
        snap.as_deref(),
        true,
    );
    Ok(Destroyed {
        purged: purge,
        snapshot: snapshot_file,
        tasks_removed,
    })
}
