//! `settings.mjs` and `paths.mjs` for the ported commands: where the data folder and its parts
//! are, read from the environment and settings.json once per process exactly as the Node core
//! reads them, the unreadable-settings warning included.
//!
//! One rule is left out on purpose: the Node core takes its own code folder as the data root
//! when `instances.json` sits in it (`settings.mjs:169-173`), a rule for running from a checkout.
//! test/fixtures/contracts/C0-CHECKS.md section 2 shows no installed build can be in that state.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::{js, jsjson, jspath, paths};

/// What reading settings.json found.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub settings: Map<String, Value>,
    pub exists: bool,
    /// Why it is unusable, in the Node core's words.
    pub error: Option<String>,
    /// The file was read but its content is unusable (kind `content`), as against not readable
    /// at all (kind `io`). Only content damage can be mended by setting the file aside.
    pub content_damage: bool,
}

/// `read(file)` in settings.mjs.
pub fn read(file: &Path) -> Read {
    let text = match std::fs::read(file) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if crate::jspath::is_enoent(&e) => {
            return Read {
                settings: Map::new(),
                exists: false,
                error: None,
                content_damage: false,
            };
        }
        Err(e) => {
            return Read {
                settings: Map::new(),
                exists: true,
                error: Some(jspath::read_error(&e, file)),
                content_damage: false,
            };
        }
    };
    // a byte-order mark from a Windows editor is dropped first, as settings.mjs does
    match jsjson::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Ok(Value::Object(map)) => Read {
            settings: map,
            exists: true,
            error: None,
            content_damage: false,
        },
        Ok(_) => Read {
            settings: Map::new(),
            exists: true,
            error: Some("it is not a JSON object".into()),
            content_damage: true,
        },
        Err(e) => Read {
            settings: Map::new(),
            exists: true,
            error: Some(e),
            content_damage: true,
        },
    }
}

/// `load()`: the settings, with the warning line the Node core writes to stderr when the file is
/// unusable (returned, so the caller prints it where the Node core would).
pub fn load() -> (Map<String, Value>, Option<String>) {
    let file = paths::settings_file();
    let found = read(&file);
    let warning = found.error.as_ref().map(|e| {
        format!(
            "spawnloft: settings file {} could not be read ({e}); using the defaults until you fix it or delete it\n",
            settings_file_text()
        )
    });
    (found.settings, warning)
}

/// `linkTarget(file)`: a dotfile manager's symlink is written through, not replaced.
fn link_target(file: &Path) -> PathBuf {
    match std::fs::symlink_metadata(file) {
        Ok(m) if m.file_type().is_symlink() => {
            crate::fsx::realpath(file).unwrap_or_else(|_| file.to_path_buf())
        }
        _ => file.to_path_buf(),
    }
}

/// `save(patch, { replaceUnreadable, onSetAside })`: merges `patch` into the settings through a
/// temp file and a rename, so a crash leaves the old file whole. Refuses when the existing file
/// is unreadable, since merging into nothing would erase the data folder; `replace_unreadable`
/// (choosing the data folder on purpose) copies a file with damaged content aside and replaces
/// it. Answers the merged settings and where a damaged file was kept.
pub fn save(
    patch: &[(&str, Value)],
    replace_unreadable: bool,
) -> Result<(Map<String, Value>, Option<String>), crate::failure::Failure> {
    use crate::failure::Failure;
    let file = link_target(Path::new(&settings_file_text()));
    let shown = file.display().to_string();
    let found = read(&file);
    let damaged = found.error.is_some();
    if damaged && !(replace_unreadable && found.content_damage) {
        return Err(Failure::user(format!(
            "settings file {shown} could not be read ({}), so it was not changed; fix it or delete it (a deleted file forgets your data folder: spawnloft config set-root <folder> sets it again), then try again",
            found.error.unwrap_or_default()
        )));
    }
    let mut merged = found.settings;
    for (k, v) in patch {
        merged.insert((*k).to_string(), v.clone());
    }
    let tmp = PathBuf::from(format!("{shown}.{}.tmp", std::process::id()));
    let mut aside: Option<PathBuf> = None;
    // a UserError (renameOver's "is holding it") passes through; anything else is wrapped
    let attempt = (|| -> Result<(), Result<String, Failure>> {
        if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
            crate::fsx::mkdir_all(dir).map_err(|f| Ok(f.message().to_string()))?;
        }
        let mut ordered = Value::Object(merged.clone());
        jsjson::js_order(&mut ordered);
        let text = format!("{}\n", jsjson::stringify_pretty(&ordered));
        write_synced(&tmp, text.as_bytes()).map_err(|e| Ok(jspath::node_error(&e, "open", Some(&tmp))))?;
        // Windows: the file gets its explicit ACL before it becomes the settings file. Not
        // fatal: the file names folders, not secrets.
        let _ = crate::private_files::protect(&tmp, 0o600);
        if damaged {
            let at = crate::time::iso_now().replace([':', '.'], "-");
            let to = PathBuf::from(format!("{shown}.unreadable-{at}"));
            // named before the copy, so a half-made copy is removed with the rest
            aside = Some(to.clone());
            copy_new(&file, &to).map_err(Ok)?;
        }
        crate::fsx::rename_over(&tmp, &file).map_err(|e| Err(crate::fsx::rename_failure(&e, &tmp, &file)))
    })();
    if let Err(failed) = attempt {
        // undo whatever was half done; the old file is untouched
        let _ = std::fs::remove_file(&tmp);
        if let Some(a) = &aside {
            let _ = std::fs::remove_file(a);
        }
        return Err(match failed {
            Err(user @ Failure::User { .. }) => user,
            Err(other) => Failure::user(format!(
                "could not write settings file {shown} ({}); it was left as it was",
                other.message()
            )),
            Ok(why) => Failure::user(format!(
                "could not write settings file {shown} ({why}); it was left as it was"
            )),
        });
    }
    Ok((merged, aside.map(|a| a.display().to_string())))
}

/// The temp file of [`save`]: owner-only from the moment it is made, flushed to the disk.
fn write_synced(tmp: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(tmp)?;
    #[cfg(unix)]
    {
        // fchmod: also tightens a leftover temp file made with wider permissions
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(data)?;
    f.sync_all()
}

/// `fs.copyFileSync(from, to, COPYFILE_EXCL)`, with Node's message on failure.
fn copy_new(from: &Path, to: &Path) -> Result<(), String> {
    let fail = |e: std::io::Error| {
        let (code, text) = jspath::error_code(&e);
        format!(
            "{code}: {text}, copyfile '{}' -> '{}'",
            from.display(),
            to.display()
        )
    };
    let mut src = std::fs::File::open(from).map_err(fail)?;
    let mut dst = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(fail)?;
    std::io::copy(&mut src, &mut dst).map_err(fail)?;
    // copyfile gives the copy the source's permissions
    let perms = src.metadata().map_err(fail)?.permissions();
    dst.set_permissions(perms).map_err(fail)
}

/// `checkWritable(dir)`: write-tested rather than inspected, since permission bits and free
/// space both lie on network shares, read-only mounts and unplugged drives. The error is Node's.
pub fn check_writable(dir: &str) -> Result<(), String> {
    let probe = jspath::join_path(dir, &[".spawnloft-write-test"]);
    crate::fsx::mkdir_all(Path::new(dir)).map_err(|f| f.message().to_string())?;
    std::fs::write(&probe, "ok").map_err(|e| jspath::node_error(&e, "open", Some(&probe)))?;
    match std::fs::remove_file(&probe) {
        Err(e) if !jspath::is_enoent(&e) => Err(jspath::node_error(&e, "rm", Some(&probe))),
        _ => Ok(()),
    }
}

/// The resolved layout (`resolveRoots`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub data_root: String,
    pub instances_dir: String,
    pub separate_instances: bool,
    pub registry_file: String,
    pub templates_dir: String,
    pub jars_dir: String,
    pub backups_dir: String,
    pub run_dir: String,
    pub engines_dir: String,
    pub services_dir: String,
    pub settings_file: String,
}

/// A truthy setting handed to `path.resolve`, which takes strings only. The Node core resolves
/// the layout when paths.mjs is imported, so a wrong type there is an uncaught crash before any
/// command (declared difference `settings-type-crash`: Node adds its source excerpt, stack and
/// version line).
fn text_of(v: Option<&Value>) -> Result<Option<String>, crate::failure::Failure> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
        _ if !js::truthy(v) => Ok(None),
        _ => Err(crate::failure::Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"paths[0]\" argument must be of type string. {}",
                js::received(v)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// The settings file as `path.join` spells it (no doubled or trailing separators).
pub fn settings_file_text() -> String {
    jspath::normalize(&paths::settings_file().to_string_lossy())
}

impl Layout {
    /// From settings already loaded, the environment and the per-user defaults.
    pub fn resolve(s: &Map<String, Value>) -> Result<Layout, crate::failure::Failure> {
        let data_root = match paths::env_var("DATA_ROOT") {
            Some(forced) => jspath::resolve(&forced),
            None => match text_of(s.get("dataRoot"))? {
                Some(d) => jspath::resolve(&d),
                None => default_data_root(),
            },
        };
        let separate = js::truthy(s.get("separateInstances")) && js::truthy(s.get("instancesDir"));
        let instances_dir = match separate
            .then(|| text_of(s.get("instancesDir")))
            .transpose()?
            .flatten()
        {
            Some(d) => jspath::resolve(&d),
            None => jspath::join(&[&data_root, "instances"]),
        };
        let backups_dir = match text_of(s.get("backupsDir"))? {
            Some(b) => jspath::resolve(&b),
            None => jspath::join(&[&data_root, "backups"]),
        };
        Ok(Layout {
            instances_dir,
            separate_instances: separate,
            registry_file: jspath::join(&[&data_root, "instances.json"]),
            templates_dir: jspath::join(&[&data_root, "templates"]),
            jars_dir: jspath::join(&[&data_root, "jars"]),
            backups_dir,
            run_dir: jspath::join(&[&data_root, "run"]),
            engines_dir: jspath::join(&[&data_root, "engines"]),
            services_dir: jspath::join(&[&data_root, "services"]),
            settings_file: settings_file_text(),
            data_root,
        })
    }

    pub fn run_dir_of(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir, name])
    }
    pub fn state_file(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir, name, "state.json"])
    }
    pub fn console_log(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir, name, "console.log"])
    }
    pub fn metrics_file(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir, name, "metrics.log"])
    }

    /// `ensureDirs()`: the folders every command but `data` makes before it runs.
    pub fn ensure_dirs(&self) -> Result<(), crate::failure::Failure> {
        for d in [
            &self.instances_dir,
            &self.templates_dir,
            &self.jars_dir,
            &self.backups_dir,
            &self.run_dir,
            &self.engines_dir,
            &self.services_dir,
        ] {
            std::fs::create_dir_all(d).map_err(|e| {
                // Node's recursive mkdir says ENOTDIR when a folder on the way is a file; Windows
                // reports that as "already exists"
                let blocked = Path::new(d)
                    .ancestors()
                    .skip(1)
                    .any(|a| a.metadata().is_ok_and(|m| !m.is_dir()));
                if blocked {
                    crate::failure::Failure::Internal {
                        head: "Error".into(),
                        message: format!("ENOTDIR: not a directory, mkdir '{d}'"),
                        code: Some("ENOTDIR".into()),
                    }
                } else {
                    crate::failure::Failure::io(&e, "mkdir", Some(Path::new(d)))
                }
            })?;
        }
        Ok(())
    }
}

fn data_base() -> PathBuf {
    paths::local_base()
}

/// `legacyDataRoot()`.
pub fn legacy_data_root() -> String {
    jspath::join(&[&data_base().to_string_lossy(), "mcctl"])
}

/// `defaultDataRoot()`: spawnloft/, or mcctl/ on a machine that only has that.
pub fn default_data_root() -> String {
    let current = jspath::join(&[&data_base().to_string_lossy(), "spawnloft"]);
    let legacy = legacy_data_root();
    if !Path::new(&current).exists() && Path::new(&legacy).exists() {
        legacy
    } else {
        current
    }
}

/// `serversElsewhere(dataRoot)`: other registries with servers in them, for an empty list.
pub fn servers_elsewhere(data_root: &str) -> Vec<(String, Vec<String>)> {
    let here = jspath::resolve(data_root);
    let mut seen: Vec<String> = Vec::new();
    let mut found = Vec::new();
    let candidates = [
        default_data_root(),
        legacy_data_root(),
        jspath::join(&[&data_base().to_string_lossy(), "spawnloft"]),
    ];
    for root in candidates.iter().map(|r| jspath::resolve(r)) {
        if seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        if root == here {
            continue;
        }
        let Ok(bytes) = std::fs::read(jspath::join(&[&root, "instances.json"])) else {
            continue;
        };
        let Ok(data) = jsjson::parse(&String::from_utf8_lossy(&bytes)) else {
            continue;
        };
        // `Object.keys(data.instances ?? {})`, which throws (and skips the root) for a null file
        if data.is_null() {
            continue;
        }
        let names: Vec<String> = data
            .get("instances")
            .map(|v| {
                crate::registry::entries_of(v)
                    .into_iter()
                    .map(|(k, _)| k)
                    .collect()
            })
            .unwrap_or_default();
        if !names.is_empty() {
            found.push((root, names));
        }
    }
    found
}

/// `describeServersElsewhere(dataRoot)`.
pub fn describe_servers_elsewhere(data_root: &str) -> Vec<String> {
    servers_elsewhere(data_root)
        .into_iter()
        .map(|(root, names)| {
            format!(
                "{} server(s) ({}) are registered in {root}, which is not the data root in use. If they are yours: spawnloft config set-root \"{root}\"",
                names.len(),
                names.join(", ")
            )
        })
        .collect()
}
