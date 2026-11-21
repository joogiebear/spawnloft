//! `manage.mjs`: what changes a server as a whole. C4 ports `rebuild` and `reveal` (with its
//! `openFolder`); `rename` and `destroy` call the scheduler and move in C6.

use std::path::Path;

use serde_json::json;

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
fn rm_rf(target: &Path) -> Result<(), Failure> {
    let res = match std::fs::symlink_metadata(target) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(target),
        Ok(_) => std::fs::remove_file(target),
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
    let dir = crate::create::path_arg(inst.get("dir"), "path")?.to_string();
    let mut target = match sub {
        Some(s) if SUBS.contains(&s) => jspath::join(&[&dir, s]),
        _ => dir,
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
