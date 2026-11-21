//! `private-copy.mjs`: Windows' private copies of SpawnLoft's data for packaged programs.
//!
//! Windows gives a program installed as a package (MSIX) a private copy of whatever it writes
//! under AppData, at `Packages\<family>\LocalCache\Local\...`, and the program (and anything it
//! starts, such as `spawnloft mcp`) reads that copy from then on. This finds those copies and
//! compares them with the real files. A process that is itself redirected can't tell which side
//! it is on, so a matching copy is only a note; a differing one, or one holding things the real
//! folder lacks, is a problem. Read-only and never fails: it runs inside doctor and at MCP start.

use serde_json::{Map, Value};

use crate::{js, jsjson, jspath, text};

/// Stop counting a server's files at this many; enough to say "some".
pub const FILE_LIMIT: u64 = 50;

/// How a private copy of the registry compares with the one read here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryCmp {
    /// `absent`, `same`, `differs`, `unreadable` (the copy) or `registry-unreadable` (the real one)
    pub state: &'static str,
    pub file: Option<String>,
    pub only_in_copy: Vec<String>,
    pub only_in_registry: Vec<String>,
    pub changed: Vec<String>,
    pub real_missing: bool,
}

impl RegistryCmp {
    fn absent(file: Option<String>) -> RegistryCmp {
        RegistryCmp {
            state: "absent",
            file,
            only_in_copy: Vec::new(),
            only_in_registry: Vec::new(),
            changed: Vec::new(),
            real_missing: false,
        }
    }
}

/// Archives in the copy's backups folder that the real one lacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupsCmp {
    pub dir: Option<String>,
    pub archives: u64,
    pub bytes: u64,
}

/// One packaged program's copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateCopy {
    pub package: String,
    pub dir: Option<String>,
    pub registry: RegistryCmp,
    pub backups: BackupsCmp,
    pub activity_entries: u64,
    pub instance_files: u64,
    pub settings_file: Option<String>,
    /// `absent`, `same` or `differs`
    pub settings: &'static str,
}

/// Where to look; [`Where::here`] is this process's.
#[derive(Debug, Clone)]
pub struct Where {
    pub windows: bool,
    pub local_app_data: String,
    pub roaming_app_data: String,
    pub data_root: String,
    pub backups_dir: String,
    pub settings_file: String,
}

impl Where {
    pub fn here(layout: &crate::settings::Layout) -> Where {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let home = crate::paths::home().to_string_lossy().into_owned();
        Where {
            windows: cfg!(windows),
            local_app_data: env("LOCALAPPDATA").unwrap_or_else(|| jspath::join(&[&home, "AppData", "Local"])),
            roaming_app_data: env("APPDATA").unwrap_or_else(|| jspath::join(&[&home, "AppData", "Roaming"])),
            data_root: layout.data_root.clone(),
            backups_dir: layout.backups_dir.clone(),
            settings_file: layout.settings_file.clone(),
        }
    }
}

/// `findPrivateCopies()`: none off Windows, and none when nothing SpawnLoft keeps is under AppData.
pub fn find(w: &Where) -> Vec<PrivateCopy> {
    if !w.windows {
        return Vec::new();
    }
    look(w)
}

/// `path.relative(base, target)` when `target` is strictly inside `base`.
fn within(base: &str, target: &str) -> Option<String> {
    if base.is_empty() {
        return None;
    }
    let rel = jspath::relative(base, target);
    (!rel.is_empty() && !rel.starts_with("..") && !jspath::is_absolute(&rel)).then_some(rel)
}

fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

fn look(w: &Where) -> Vec<PrivateCopy> {
    // only paths under AppData are redirected; checked separately since the data root may be on another drive
    let data_rel = within(&w.local_app_data, &w.data_root);
    let backups_rel = within(&w.local_app_data, &w.backups_dir);
    let settings_rel = within(&w.roaming_app_data, &w.settings_file);
    if data_rel.is_none() && backups_rel.is_none() && settings_rel.is_none() {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(jspath::join(&[&w.local_app_data, "Packages"])) else {
        return Vec::new();
    };
    let mut families: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    js_sort(&mut families);

    let mut found = Vec::new();
    for family in families {
        let store = jspath::join(&[&w.local_app_data, "Packages", &family, "LocalCache"]);
        let dir = data_rel.as_ref().map(|r| jspath::join(&[&store, "Local", r]));
        let has_dir = dir.as_ref().is_some_and(|d| is_directory(d));
        let backups = match &backups_rel {
            Some(r) if is_directory(&jspath::join(&[&store, "Local", r])) => {
                backups_only_here(&w.backups_dir, &jspath::join(&[&store, "Local", r]))
            }
            _ => BackupsCmp {
                dir: None,
                archives: 0,
                bytes: 0,
            },
        };
        let settings_copy = settings_rel
            .as_ref()
            .map(|r| jspath::join(&[&store, "Roaming", r]));
        let settings = match &settings_copy {
            Some(c) => compare_files(&w.settings_file, c),
            None => "absent",
        };
        if !has_dir && backups.dir.is_none() && settings == "absent" {
            continue;
        }
        let d = dir.filter(|_| has_dir);
        found.push(PrivateCopy {
            package: family,
            registry: match &d {
                Some(d) => compare_registries(
                    &jspath::join(&[&w.data_root, "instances.json"]),
                    &jspath::join(&[d, "instances.json"]),
                ),
                None => RegistryCmp::absent(None),
            },
            backups,
            activity_entries: d
                .as_ref()
                .map_or(0, |d| count_lines(&jspath::join(&[d, "activity.jsonl"]))),
            instance_files: d
                .as_ref()
                .map_or(0, |d| count_files(&jspath::join(&[d, "instances"]), FILE_LIMIT)),
            dir: d,
            settings_file: settings_copy,
            settings,
        });
    }
    found
}

fn is_directory(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

fn read_text(file: &str) -> Option<String> {
    std::fs::read(file)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn count_lines(file: &str) -> u64 {
    read_text(file).map_or(0, |t| {
        t.split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !js::trim(l).is_empty())
            .count() as u64
    })
}

/// Files under a folder, counted up to `limit`, since a server folder can hold a whole world.
fn count_files(dir: &str, limit: u64) -> u64 {
    let mut count = 0;
    let mut pending = vec![dir.to_string()];
    while count < limit {
        let Some(current) = pending.pop() else { break };
        let Ok(rd) = std::fs::read_dir(&current) else {
            continue;
        };
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                pending.push(jspath::join(&[&current, &e.file_name().to_string_lossy()]));
            } else {
                count += 1;
                if count >= limit {
                    break;
                }
            }
        }
    }
    count
}

/// `sorted(value)`: keys in sorted order, as `Object.fromEntries` then lays them out.
fn sorted(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        Value::Object(m) => {
            let mut keys: Vec<String> = m.keys().cloned().collect();
            js_sort(&mut keys);
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), sorted(&m[&k]));
            }
            let mut out = Value::Object(out);
            jsjson::js_order(&mut out);
            out
        }
        other => other.clone(),
    }
}

/// JSON compared by value (key order and spacing ignored), anything else as raw text.
fn canonical(text: Option<&str>) -> Option<String> {
    let text = text?;
    Some(match jsjson::parse(text) {
        Ok(v) => jsjson::stringify(&sorted(&v)),
        Err(_) => text.to_string(),
    })
}

fn compare_files(real: &str, copy: &str) -> &'static str {
    let Some(there) = read_text(copy) else {
        return "absent";
    };
    if canonical(Some(&there)) == canonical(read_text(real).as_deref()) {
        "same"
    } else {
        "differs"
    }
}

/// `serversOf(doc)`: the `instances` object, or none.
fn servers_of(doc: Option<&Value>) -> Map<String, Value> {
    match doc.and_then(|d| d.get("instances")) {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

fn compare_registries(real: &str, copy: &str) -> RegistryCmp {
    let Some(there) = read_text(copy) else {
        return RegistryCmp::absent(Some(copy.to_string()));
    };
    let here = read_text(real);
    let base = |state| RegistryCmp {
        state,
        file: Some(copy.to_string()),
        only_in_copy: Vec::new(),
        only_in_registry: Vec::new(),
        changed: Vec::new(),
        real_missing: here.is_none(),
    };
    if canonical(Some(&there)) == canonical(here.as_deref()) {
        return base("same");
    }
    let Ok(copy_doc) = jsjson::parse(&there) else {
        return base("unreadable");
    };
    let real_doc = match &here {
        Some(h) => match jsjson::parse(h) {
            Ok(v) => Some(v),
            Err(_) => return base("registry-unreadable"),
        },
        None => None,
    };
    let in_copy = servers_of(Some(&copy_doc));
    let in_registry = servers_of(real_doc.as_ref());
    let names = |m: &Map<String, Value>| {
        let mut v: Vec<String> = m.keys().cloned().collect();
        js_sort(&mut v);
        v
    };
    let mut r = base("differs");
    r.only_in_copy = names(&in_copy)
        .into_iter()
        .filter(|n| !in_registry.contains_key(n))
        .collect();
    r.only_in_registry = names(&in_registry)
        .into_iter()
        .filter(|n| !in_copy.contains_key(n))
        .collect();
    r.changed = names(&in_copy)
        .into_iter()
        .filter(|n| {
            in_registry
                .get(n)
                .is_some_and(|b| jsjson::stringify(&sorted(&in_copy[n])) != jsjson::stringify(&sorted(b)))
        })
        .collect();
    r
}

/// Archives in the copy's backups folder that the real one lacks; files that can't be checked
/// aren't counted.
fn backups_only_here(real_dir: &str, copy_dir: &str) -> BackupsCmp {
    let mut out = BackupsCmp {
        dir: Some(copy_dir.to_string()),
        archives: 0,
        bytes: 0,
    };
    let Ok(rd) = std::fs::read_dir(copy_dir) else {
        return out;
    };
    let instances: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    for inst in instances {
        let Ok(rd) = std::fs::read_dir(jspath::join(&[copy_dir, &inst])) else {
            continue;
        };
        for f in rd.flatten() {
            let file = f.file_name().to_string_lossy().into_owned();
            if !file.ends_with(".tar.gz") {
                continue;
            }
            match std::fs::symlink_metadata(jspath::join(&[real_dir, &inst, &file])) {
                Err(e) if jspath::is_enoent(&e) => {
                    if let Ok(m) = std::fs::metadata(jspath::join(&[copy_dir, &inst, &file])) {
                        out.bytes += m.len();
                        out.archives += 1;
                    }
                }
                _ => {}
            }
        }
    }
    out
}

fn list(names: &[String]) -> String {
    names
        .iter()
        .map(|n| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn plural<'a>(n: u64, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// `describePrivateCopies(copies, { backupsDir })`: doctor's two kinds of line, problems for
/// what is out of step and notes for a copy that matches today. Renaming the copy's file is a
/// stopgap (Windows recreates it on the next write); `spawnloft data move <folder>` is the fix.
pub fn describe(copies: &[PrivateCopy], backups_dir: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut problems = Vec::new();
    let mut notes = Vec::new();
    for copy in copies {
        let mine = problems.len();
        let r = &copy.registry;
        let file = r.file.as_deref().unwrap_or("null");
        match r.state {
            "differs" => {
                let sides: Vec<String> = [
                    (!r.only_in_registry.is_empty())
                        .then(|| format!("only in the registry read here: {}", list(&r.only_in_registry))),
                    (!r.only_in_copy.is_empty()).then(|| format!("only in the copy: {}", list(&r.only_in_copy))),
                    (!r.changed.is_empty()).then(|| format!("set up differently in the two: {}", list(&r.changed))),
                ]
                .into_iter()
                .flatten()
                .collect();
                let sides = if sides.is_empty() {
                    "they differ outside the list of servers".to_string()
                } else {
                    sides.join("; ")
                };
                let loses = if !r.only_in_copy.is_empty() || r.real_missing {
                    format!(
                        "Renaming the copy's registry would drop {}, which the registry read here does not have: copy {} across first. ",
                        if r.real_missing { "every server in it".to_string() } else { list(&r.only_in_copy) },
                        if r.real_missing { "its entries" } else { "their entries" }
                    )
                } else {
                    String::new()
                };
                problems.push(format!(
                    "{} has its own copy of SpawnLoft's registry, {file}, and it disagrees with the one read here ({sides}). \
                     Windows gives a program installed as a package a private copy of what it writes under AppData, and every program that one starts - \"spawnloft mcp\" among them - reads that copy from then on, \
                     so what they report about servers and their settings can differ from the SpawnLoft app's. \
                     {loses}To stop them reading different registries, rename {file}: those programs then read the real one. It can come back the next time one of them writes to it; to stop it for good, `spawnloft data move <folder>` moves the data out of AppData and leaves a link, so nothing else needs changing.",
                    copy.package
                ));
            }
            "unreadable" => problems.push(format!(
                "{} has its own copy of SpawnLoft's registry, {file}, and it could not be read, so what the programs it starts report about servers cannot be trusted. Rename it so they read the real registry.",
                copy.package
            )),
            "registry-unreadable" => problems.push(format!(
                "{} has its own copy of SpawnLoft's registry, {file}, which could not be compared with the one read here because that one could not be read. Mend that one first.",
                copy.package
            )),
            _ => {}
        }
        if copy.instance_files > 0 {
            let n = copy.instance_files;
            problems.push(format!(
                "{n}{} {} from servers' folders {} in {}'s copy, under {}, \
                 so the programs it starts can also read and write different server files from the app's - plugin settings, for one. Renaming the registry does not undo that.",
                if n >= FILE_LIMIT { " or more" } else { "" },
                plural(n, "file", "files"),
                plural(n, "is", "are"),
                copy.package,
                jspath::join(&[copy.dir.as_deref().unwrap_or(""), "instances"])
            ));
        }
        if copy.backups.archives > 0 {
            let n = copy.backups.archives;
            problems.push(format!(
                "{n} {} ({}) {} only in {}'s copy, {}, \
                 so the panel's Backups tab does not list {}, and {} may go if that program is reset or uninstalled. \
                 To keep {}, copy the .tar.gz and .json files of each server's folder there into the same folder under {}.",
                plural(n, "backup", "backups"),
                text::human_bytes(Some(copy.backups.bytes as f64)),
                plural(n, "is", "are"),
                copy.package,
                copy.backups.dir.as_deref().unwrap_or("null"),
                plural(n, "it", "them"),
                plural(n, "it", "they"),
                plural(n, "it", "them"),
                backups_dir.unwrap_or("the backups folder")
            ));
        }
        if copy.settings == "differs" {
            let f = copy.settings_file.as_deref().unwrap_or("null");
            problems.push(format!(
                "{}'s copy of SpawnLoft's settings, {f}, differs from the ones read here, so a program it starts may use a different data folder from the app's. \
                 Rename {f} if the ones read here are right: those programs then read them.",
                copy.package
            ));
        }
        if problems.len() == mine {
            let at = copy
                .dir
                .as_deref()
                .or(copy.backups.dir.as_deref())
                .or(copy.settings_file.as_deref())
                .unwrap_or("null");
            let about = if r.state == "same" {
                "; its registry matches the one read here today, but it does not follow changes the app makes later"
            } else {
                "; it holds no copy of the registry now, and Windows makes one the next time a program it started writes the registry"
            };
            let extra = if copy.activity_entries > 0 {
                format!(
                    "; its own activity log, which the panel does not read, holds {} {}",
                    copy.activity_entries,
                    plural(copy.activity_entries, "entry", "entries")
                )
            } else {
                String::new()
            };
            notes.push(format!(
                "{} keeps a copy of SpawnLoft's data at {at}{about}{extra}",
                copy.package
            ));
        }
    }
    (problems, notes)
}

/// A copy worth telling an AI client about: it holds a registry or something the real folder
/// lacks. Once the registry is renamed away the notice goes quiet.
fn concerns(c: &PrivateCopy) -> bool {
    c.registry.state != "absent" || c.backups.archives > 0 || c.instance_files > 0 || c.settings == "differs"
}

/// `mcpNotice(copies)`: the paragraph for the MCP server's start-up instructions and its doctor
/// tool, empty when no copy concerns it.
pub fn mcp_notice(copies: &[PrivateCopy]) -> String {
    let relevant: Vec<&PrivateCopy> = copies.iter().filter(|c| concerns(c)).collect();
    if relevant.is_empty() {
        return String::new();
    }
    let places: Vec<&str> = relevant
        .iter()
        .map(|c| {
            c.dir
                .as_deref()
                .or(c.backups.dir.as_deref())
                .or(c.settings_file.as_deref())
                .unwrap_or("null")
        })
        .collect();
    format!(
        "NOTE: Windows keeps a second copy of SpawnLoft's data for programs installed as a package ({}), and this process may be reading it. \
         What the tools report - which servers exist, their settings, which backups there are - can be out of date compared with the SpawnLoft app, and this process cannot tell. \
         Ask the person to run \"spawnloft doctor\" from a terminal outside this assistant, and say so if a server they mention is missing.",
        places.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sl-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_packaged_programs_copy_is_found_and_compared() {
        let d = scratch();
        let s = |p: &str| d.join(p).to_string_lossy().into_owned();
        let local = s("Local");
        let data = jspath::join(&[&local, "spawnloft"]);
        let copy = jspath::join(&[
            &local,
            "Packages",
            "Fam.App_1",
            "LocalCache",
            "Local",
            "spawnloft",
        ]);
        std::fs::create_dir_all(jspath::join(&[&copy, "instances", "a"])).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            jspath::join(&[&data, "instances.json"]),
            r#"{"version":1,"instances":{"a":{"port":1},"b":{"port":2}}}"#,
        )
        .unwrap();
        std::fs::write(
            jspath::join(&[&copy, "instances.json"]),
            r#"{"instances":{"c":{"port":3},"a":{"port":9}},"version":1}"#,
        )
        .unwrap();
        std::fs::write(jspath::join(&[&copy, "instances", "a", "x"]), "").unwrap();
        std::fs::write(jspath::join(&[&copy, "activity.jsonl"]), "{}\n\n {} \r\n").unwrap();
        let w = Where {
            windows: true,
            local_app_data: local.clone(),
            roaming_app_data: s("Roaming"),
            data_root: data.clone(),
            backups_dir: s("elsewhere"),
            settings_file: s("elsewhere/settings.json"),
        };
        assert!(
            find(&Where {
                windows: false,
                ..w.clone()
            })
            .is_empty()
        );
        let found = find(&w);
        assert_eq!(found.len(), 1);
        let c = &found[0];
        assert_eq!(c.package, "Fam.App_1");
        assert_eq!(c.registry.state, "differs");
        assert_eq!(c.registry.only_in_copy, ["c"]);
        assert_eq!(c.registry.only_in_registry, ["b"]);
        assert_eq!(c.registry.changed, ["a"]);
        assert_eq!((c.activity_entries, c.instance_files), (2, 1));
        let (problems, notes) = describe(&found, None);
        assert_eq!(problems.len(), 2);
        assert!(notes.is_empty());
        assert!(mcp_notice(&found).starts_with("NOTE: Windows keeps a second copy"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
