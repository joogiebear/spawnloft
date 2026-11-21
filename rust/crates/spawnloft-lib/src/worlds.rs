//! `worlds.mjs` (C3): the worlds a server folder holds, listed, imported, exported, switched and
//! deleted. The destructive cases (deleting a world, exporting the live one) are refused here in
//! the core, not only in the panel.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use crate::activity::Actor;
use crate::backup::{self, EXCLUDE_ARGS, dir_of};
use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::tar::{run_tar, tar_handles_zip, tar_member};
use crate::{collate, control, fsx, jspath, props, text, util};

/// Dimension folders a Bukkit-family server keeps beside a world.
const DIM_SUFFIXES: [&str; 2] = ["_nether", "_the_end"];

/// `MAX_WORLD_COPY_BYTES`: the size up to which a world is copied before it is deleted, the
/// size Files copies before a delete.
pub const MAX_WORLD_COPY_BYTES: u64 = crate::files::MAX_COPY_BYTES;

fn is_world_dir(dir: &Path) -> bool {
    std::fs::metadata(dir.join("level.dat")).is_ok_and(|m| m.is_file())
}

fn join(base: &str, names: &[&str]) -> PathBuf {
    jspath::join_path(base, names)
}

/// `safeWorldName(name)`: names arrive over HTTP, so separators and traversal are refused.
fn safe_world_name(name: &str) -> Result<(), Failure> {
    if name.is_empty() || name.contains(['\\', '/']) || name == "." || name == ".." {
        return Err(Failure::user(format!("\"{name}\" is not a world name")));
    }
    Ok(())
}

fn active_block(layout: &Layout, inst: &Instance, verb: &str) -> Result<(), Failure> {
    let state = PathBuf::from(layout.state_file(&inst.name));
    match control::active_block(&state, &inst.name, verb)? {
        Some(why) => Err(Failure::user(why)),
        None => Ok(()),
    }
}

fn human(n: u64) -> String {
    text::human_bytes(Some(n as f64))
}

/// `activeWorld(inst)`: `level-name` from server.properties, `world` when it is not set.
pub fn active_world(inst: &Instance) -> Result<String, Failure> {
    let dir = dir_of(inst)?;
    let p = props::read(&join(&dir, &["server.properties"]))?;
    Ok(match props::get(&p, "level-name") {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => "world".into(),
    })
}

/// One row of `listWorlds`.
#[derive(Debug, Clone, PartialEq)]
pub struct World {
    pub name: String,
    pub active: bool,
    pub dimensions: Vec<String>,
    pub size: u64,
}

impl World {
    pub fn size_human(&self) -> String {
        human(self.size)
    }
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "active": self.active,
            "dimensions": self.dimensions,
            "size": self.size,
            "sizeHuman": self.size_human(),
        })
    }
}

/// What `listWorlds` answers; `active` is `None` when the folder cannot be read.
#[derive(Debug, Clone, PartialEq)]
pub struct Worlds {
    pub active: Option<String>,
    pub worlds: Vec<World>,
}

/// `listWorlds(inst)`: the active world first, then by name; dimension folders are folded into
/// their world's row.
pub fn list_worlds(inst: &Instance) -> Result<Worlds, Failure> {
    // readdirSync(undefined) throws inside the try, so a record with no folder lists nothing too
    let dir = dir_of(inst).unwrap_or_default();
    let Ok(entries) = fsx::readdir_typed(Path::new(&dir))
        .map_err(|_| ())
        .and_then(|e| if dir.is_empty() { Err(()) } else { Ok(e) })
    else {
        return Ok(Worlds {
            active: None,
            worlds: Vec::new(),
        });
    };
    // a Set in readdir order
    let here: Vec<String> = entries
        .into_iter()
        .filter(|(n, t)| t.is_dir() && is_world_dir(&join(&dir, &[n])))
        .map(|(n, _)| n)
        .collect();
    let has = |n: &str| here.iter().any(|h| h == n);
    let active = active_world(inst)?;
    let mut rows = Vec::new();
    for name in &here {
        if let Some(suffix) = DIM_SUFFIXES.iter().find(|s| name.ends_with(*s))
            && has(&name[..name.len() - suffix.len()])
        {
            continue;
        }
        let dims: Vec<&str> = DIM_SUFFIXES
            .iter()
            .copied()
            .filter(|s| has(&format!("{name}{s}")))
            .collect();
        let mut size = util::dir_size(&join(&dir, &[name]));
        for s in &dims {
            size += util::dir_size(&join(&dir, &[&format!("{name}{s}")]));
        }
        rows.push(World {
            name: name.clone(),
            active: *name == active,
            dimensions: dims.iter().map(|s| s[1..].to_string()).collect(),
            size,
        });
    }
    rows.sort_by(|a, b| {
        if a.active != b.active {
            if a.active {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            collate::compare(&a.name, &b.name)
        }
    });
    Ok(Worlds {
        active: Some(active),
        worlds: rows,
    })
}

/// `activateWorld(inst, name)`: only while stopped, since a running server saving into a world
/// server.properties no longer names can interleave two worlds.
pub fn activate_world(layout: &Layout, inst: &Instance, name: &str) -> Result<String, Failure> {
    safe_world_name(name)?;
    active_block(layout, inst, "switching worlds")?;
    let dir = dir_of(inst)?;
    if !is_world_dir(&join(&dir, &[name])) {
        return Err(Failure::user(format!(
            "\"{name}\" is not a world in {dir} (no level.dat)"
        )));
    }
    props::write(
        &join(&dir, &["server.properties"]),
        &[("level-name".to_string(), name.to_string())],
    )?;
    Ok(name.to_string())
}

/// `findWorldRoot(dir, { maxDepth: 4 })`: the shallowest folder with a level.dat, breadth first
/// so a nested backup cannot win.
pub fn find_world_root(dir: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut layer = vec![dir.to_path_buf()];
    let mut depth = 0;
    while depth <= max_depth && !layer.is_empty() {
        let mut next = Vec::new();
        for candidate in &layer {
            if is_world_dir(candidate) {
                return Some(candidate.clone());
            }
            if let Ok(entries) = fsx::readdir_typed(candidate) {
                for (n, t) in entries {
                    if t.is_dir() {
                        next.push(candidate.join(n));
                    }
                }
            }
        }
        layer = next;
        depth += 1;
    }
    None
}

/// The `finally` that clears an import's unpack folder: best effort.
fn rm_rf(p: &Path) {
    let _ = crate::backup::rm_tree(p);
}

/// What `importWorld` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub name: String,
    pub dimensions: Vec<String>,
    pub size: u64,
}

impl Imported {
    pub fn size_human(&self) -> String {
        human(self.size)
    }
}

/// `importWorld(inst, source, { name })`: a zip, tar.gz or folder as a new world. A taken name is
/// refused, so it never overwrites and is safe on a running server. Dimension folders beside the
/// world come along.
pub fn import_world(inst: &Instance, source: &str, name: &str) -> Result<Imported, Failure> {
    registry::validate_name(name).map_err(Failure::user)?;
    let dir = dir_of(inst)?;
    let dest = join(&dir, &[name]);
    if dest.exists() {
        return Err(Failure::user(format!(
            "\"{name}\" already exists in {dir} - pick another name"
        )));
    }
    let src = jspath::resolve(source);
    let src_path = PathBuf::from(&src);
    if !src_path.exists() {
        return Err(Failure::user(format!("there is nothing at {src}")));
    }
    let mut tmp: Option<PathBuf> = None;
    let res = import_into(&dir, &src, &src_path, &dest, name, &mut tmp);
    if let Some(t) = tmp {
        rm_rf(&t);
    }
    res
}

fn import_into(
    dir: &str,
    src: &str,
    src_path: &Path,
    dest: &Path,
    name: &str,
    tmp: &mut Option<PathBuf>,
) -> Result<Imported, Failure> {
    let root = if src_path.is_dir() {
        find_world_root(src_path, 4).ok_or_else(|| {
            Failure::user(format!(
                "no level.dat found under {src} - that folder does not hold a world"
            ))
        })?
    } else {
        // inside the server folder, so the final move is a rename on one volume, not a copy
        let t = join(dir, &[&format!(".mcctl-import-{}", util::now() as u64)]);
        fsx::mkdir_all(&t)?;
        *tmp = Some(t.clone());
        // bsdtar reads zip and tar.gz and refuses absolute and ".." members; GNU tar cannot read
        // a zip, which the zip reader extracts with its own guard
        if !tar_handles_zip() && crate::zip::is_zip(src_path)? {
            crate::zip::extract(src_path, &t)?;
        } else {
            run_tar(&["-xf".to_string(), src.to_string()], &t)?;
        }
        find_world_root(&t, 4).ok_or_else(|| {
            Failure::user(format!(
                "no level.dat found inside {} - that archive does not hold a world",
                jspath::basename(src)
            ))
        })?
    };
    let moving = tmp.is_some();
    let move_or_copy = |from: &Path, to: &Path| -> Result<(), Failure> {
        if moving {
            std::fs::rename(from, to).map_err(|e| fsx::rename_failure(&e, from, to))
        } else {
            fsx::copy_tree(from, to)?;
            // downloaded worlds often ship the lock of the server that last ran them
            let _ = std::fs::remove_file(to.join("session.lock"));
            Ok(())
        }
    };
    move_or_copy(&root, dest)?;
    let _ = std::fs::remove_file(dest.join("session.lock"));

    let base = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = root.parent().unwrap_or(Path::new("")).to_path_buf();
    let mut dims = Vec::new();
    for suffix in DIM_SUFFIXES {
        let companion = parent.join(format!("{base}{suffix}"));
        if companion.exists() && is_world_dir(&companion) {
            let to = join(dir, &[&format!("{name}{suffix}")]);
            move_or_copy(&companion, &to)?;
            let _ = std::fs::remove_file(to.join("session.lock"));
            dims.push(suffix[1..].to_string());
        }
    }
    let mut size = util::dir_size(&join(dir, &[name]));
    for d in &dims {
        size += util::dir_size(&join(dir, &[&format!("{name}_{d}")]));
    }
    Ok(Imported {
        name: name.to_string(),
        dimensions: dims,
        size,
    })
}

/// What `exportWorld` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Exported {
    pub file: String,
    pub size: u64,
    pub members: Vec<String>,
}

impl Exported {
    pub fn size_human(&self) -> String {
        human(self.size)
    }
}

/// `exportWorld(inst, name)`: a zip in the server's own `exports` folder, so the backup history
/// does not list it. The active world of a running server is refused (a torn copy); a backup
/// flushes first instead.
pub fn export_world(layout: &Layout, inst: &Instance, name: &str) -> Result<Exported, Failure> {
    safe_world_name(name)?;
    let dir = dir_of(inst)?;
    if !is_world_dir(&join(&dir, &[name])) {
        return Err(Failure::user(format!("\"{name}\" is not a world in {dir}")));
    }
    let active = active_world(inst)?;
    let (status, _) = control::read_state(Path::new(&layout.state_file(&inst.name)))?;
    if name == active && control::is_active_status(status) {
        return Err(Failure::user(format!(
            "\"{name}\" is the world the running server is saving into - stop the server first, or take a backup instead"
        )));
    }
    let out_dir = join(&layout.backups_dir, &[&inst.name, "exports"]);
    fsx::mkdir_all(&out_dir)?;
    let file = out_dir.join(format!("{name}_{}.zip", util::stamp()));
    let mut members = vec![name.to_string()];
    for s in DIM_SUFFIXES {
        let d = format!("{name}{s}");
        if is_world_dir(&join(&dir, &[&d])) {
            members.push(d);
        }
    }
    if tar_handles_zip() {
        // -a: bsdtar picks the format from the extension. GNU tar takes the flags but writes a
        // tar under the .zip name, so it is never used here
        let mut args: Vec<String> = vec!["-a".into(), "-cf".into(), file.to_string_lossy().into()];
        args.extend(EXCLUDE_ARGS.iter().map(|s| s.to_string()));
        args.extend(members.iter().map(|m| tar_member(m)));
        run_tar(&args, Path::new(&dir))?;
    } else {
        let refs: Vec<&str> = members.iter().map(String::as_str).collect();
        let exclude: Vec<&str> = EXCLUDE_ARGS
            .iter()
            .copied()
            .filter(|a| *a != "--exclude")
            .collect();
        crate::zip::create(&file, &dir, &refs, &exclude, false)?;
    }
    let size = std::fs::metadata(&file)
        .map_err(|e| Failure::io(&e, "stat", Some(&file)))?
        .len();
    if size == 0 {
        let _ = std::fs::remove_file(&file);
        return Err(Failure::user(format!(
            "the export of \"{name}\" came out empty and has been discarded"
        )));
    }
    Ok(Exported {
        file: file.to_string_lossy().into_owned(),
        size,
        members,
    })
}

/// What `deleteWorld` and `deleteWorldKeepingCopy` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Deleted {
    pub removed: Vec<String>,
    /// The copy kept first, by file name.
    pub snapshot: Option<String>,
}

/// `deletableWorld(inst, name)`: the folders a world is made of, once it may be deleted at all.
fn deletable_world(layout: &Layout, inst: &Instance, name: &str) -> Result<Vec<String>, Failure> {
    safe_world_name(name)?;
    active_block(layout, inst, "deleting worlds")?;
    if name == active_world(inst)? {
        return Err(Failure::user(format!(
            "\"{name}\" is the active world - switch to another world first, or use rebuild to reset it"
        )));
    }
    let dir = dir_of(inst)?;
    if !is_world_dir(&join(&dir, &[name])) {
        return Err(Failure::user(format!("\"{name}\" is not a world in {dir}")));
    }
    let mut members = vec![name.to_string()];
    for s in DIM_SUFFIXES {
        let d = format!("{name}{s}");
        if join(&dir, &[&d]).exists() {
            members.push(d);
        }
    }
    Ok(members)
}

/// `deleteWorldKeepingCopy(inst, name, { withoutCopy })`: the world is copied into the backups
/// first, the way Files copies what it deletes. Past [`MAX_WORLD_COPY_BYTES`] it fails with code
/// `large`, and the caller may ask again without a copy.
pub fn delete_world_keeping_copy(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    name: &str,
    without_copy: bool,
) -> Result<Deleted, Failure> {
    let members = deletable_world(layout, inst, name)?;
    let mut snapshot = None;
    if !without_copy {
        let dir = dir_of(inst)?;
        let bytes: u64 = members.iter().map(|m| util::dir_size(&join(&dir, &[m]))).sum();
        if bytes > MAX_WORLD_COPY_BYTES {
            return Err(Failure::User {
                message: format!(
                    "\"{name}\" is {}; keeping a copy first would take a while and as much space again",
                    human(bytes)
                ),
                code: Some("large".into()),
            });
        }
        let made = backup::create_snapshot(
            layout,
            by,
            inst,
            &backup::Options {
                scope: "files".into(),
                label: json!("world-delete"),
                members: Some(members),
                flush: false,
                quiet: true,
                ..Default::default()
            },
        )?;
        snapshot = Some(jspath::basename(&made.file));
    }
    let mut res = delete_world(layout, inst, name)?;
    res.snapshot = snapshot;
    Ok(res)
}

/// `deleteWorld(inst, name)`: deletes with no copy. Callers confirm with the person first.
pub fn delete_world(layout: &Layout, inst: &Instance, name: &str) -> Result<Deleted, Failure> {
    safe_world_name(name)?;
    active_block(layout, inst, "deleting worlds")?;
    if name == active_world(inst)? {
        return Err(Failure::user(format!(
            "\"{name}\" is the active world - switch to another world first, or use rebuild to reset it"
        )));
    }
    let dir = dir_of(inst)?;
    if !is_world_dir(&join(&dir, &[name])) {
        return Err(Failure::user(format!("\"{name}\" is not a world in {dir}")));
    }
    let mut removed = vec![name.to_string()];
    crate::backup::rm_tree(&join(&dir, &[name]))?;
    for s in DIM_SUFFIXES {
        let companion = join(&dir, &[&format!("{name}{s}")]);
        if companion.exists() {
            crate::backup::rm_tree(&companion)?;
            removed.push(format!("{name}{s}"));
        }
    }
    Ok(Deleted {
        removed,
        snapshot: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-worlds-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn world(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("level.dat"), "x").unwrap();
    }

    #[test]
    fn the_root_is_the_shallowest_world() {
        let d = scratch("root");
        world(&d.join("wrap/deep/deeper/backup"));
        world(&d.join("wrap/map"));
        assert_eq!(find_world_root(&d, 4), Some(d.join("wrap/map")));
        std::fs::remove_dir_all(d.join("wrap/map")).unwrap();
        assert_eq!(find_world_root(&d, 4), Some(d.join("wrap/deep/deeper/backup")));
        assert_eq!(find_world_root(&d, 2), None);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn world_names_refuse_separators() {
        for bad in ["", ".", "..", "a/b", "a\\b"] {
            assert!(safe_world_name(bad).is_err(), "{bad}");
        }
        assert!(safe_world_name("world_nether").is_ok());
    }

    #[test]
    fn a_tree_is_copied_with_its_links() {
        let d = scratch("copy");
        world(&d.join("src/region"));
        std::fs::write(d.join("src/a.txt"), "a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a.txt", d.join("src/link")).unwrap();
        fsx::copy_tree(&d.join("src"), &d.join("dest")).unwrap();
        assert_eq!(std::fs::read(d.join("dest/region/level.dat")).unwrap(), b"x");
        assert_eq!(std::fs::read(d.join("dest/a.txt")).unwrap(), b"a");
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(d.join("dest/link")).unwrap(),
            d.join("src/a.txt")
        );
        assert!(fsx::copy_tree(&d.join("src"), &d.join("dest")).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
