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
            };
        }
        Err(e) => {
            return Read {
                settings: Map::new(),
                exists: true,
                error: Some(jspath::read_error(&e, file)),
            };
        }
    };
    // a byte-order mark from a Windows editor is dropped first, as settings.mjs does
    match jsjson::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Ok(Value::Object(map)) => Read {
            settings: map,
            exists: true,
            error: None,
        },
        Ok(_) => Read {
            settings: Map::new(),
            exists: true,
            error: Some("it is not a JSON object".into()),
        },
        Err(e) => Read {
            settings: Map::new(),
            exists: true,
            error: Some(e),
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
            std::fs::create_dir_all(d)
                .map_err(|e| crate::failure::Failure::io(&e, "mkdir", Some(Path::new(d))))?;
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
