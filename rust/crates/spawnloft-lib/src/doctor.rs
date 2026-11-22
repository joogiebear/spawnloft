//! `doctor.mjs`: the read-only environment checks behind `spawnloft doctor`, the MCP server's
//! `doctor` tool and the panel. Java, tar, the data folder and its settings, Windows' private
//! copies, each server (folder, jar, EULA, ports, state, RCON exposure, size), each client
//! profile, and the files that hold secrets.
//!
//! One declared difference (tools/parity/declared-differences.mjs, `doctor-node-line`): where the
//! Node core notes `node: <version>` and the code folder (`root: ...`), this notes the core's
//! own build (`core: spawnloft-core <version> (...)`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::client::paths::Paths as ClientPaths;
use crate::control::{self, Status};
use crate::failure::Failure;
use crate::private_copy::{self, PrivateCopy};
use crate::private_files::{self, Secret};
use crate::settings::{self, Layout};
use crate::{build, data_format, exposure, java, js, jspath, registry, text, uninstall, util};

/// What `runDoctor` answers. `private_copies` is for the MCP tool.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub notes: Vec<String>,
    pub problems: Vec<String>,
    pub private_copies: Vec<PrivateCopy>,
}

impl Report {
    pub fn healthy(&self) -> bool {
        self.problems.is_empty()
    }
}

/// `privateFiles()`: every file that holds a secret (a refresh token, an RCON or database
/// password, a harness or mclo.gs token). Files that do not exist are skipped by the check.
pub fn private_files(layout: &Layout) -> Result<Vec<Secret>, Failure> {
    let client = ClientPaths::new(layout);
    let secret = |file: PathBuf, what: String| Secret { file, what };
    let mut files = vec![
        secret(
            client.accounts_file().into(),
            "accounts file (Microsoft sign-in tokens)".into(),
        ),
        secret(
            layout.registry_file.clone().into(),
            "registry (RCON and database passwords)".into(),
        ),
        secret(
            jspath::join(&[&layout.run_dir, "mclogs.json"]).into(),
            "mclo.gs tokens".into(),
        ),
        secret(
            crate::panel_auth::key_file(),
            "panel key (signs the panel's sign-in tokens)".into(),
        ),
    ];
    for inst in registry::list_instances(Path::new(&layout.registry_file))? {
        files.push(secret(
            jspath::join(&[&dir_of(&inst), "server.properties"]).into(),
            format!("{}: server.properties (RCON password)", inst.name),
        ));
    }
    // no client registry: nothing to check
    let profiles = crate::client::profiles::list(&client).unwrap_or_default();
    for p in profiles {
        let name = p.name();
        files.push(secret(
            client.state_file(&name).into(),
            format!("client {name}: state file (harness token)"),
        ));
    }
    Ok(files)
}

/// `inst.dir` as Node's template literal and `path.join` see it.
fn dir_of(inst: &registry::Instance) -> String {
    js::string(inst.get("dir"))
}

/// `/^\s*eula\s*=\s*true\s*$/im`. Every JavaScript line terminator ends a line for `^` and `$`
/// and is a `\s`, so they are all read as `\n` here.
fn eula_accepted(text: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        let s = crate::diagnose::JS_SPACE;
        Regex::new(&format!(r"(?mi)^{s}*eula{s}*={s}*true{s}*$")).expect("eula pattern")
    });
    let lines: String = text
        .chars()
        .map(|c| {
            if matches!(c, '\r' | '\u{2028}' | '\u{2029}') {
                '\n'
            } else {
                c
            }
        })
        .collect();
    RE.is_match(&lines)
}

/// A key for the port map, as a `Map` keys JavaScript values: a number and the same digits as
/// text are different keys, and no two objects are the same.
fn port_key(v: &Value, unique: &str) -> String {
    match v {
        Value::Number(_) => format!("n{}", js::string(Some(v))),
        Value::String(s) => format!("s{s}"),
        Value::Bool(b) => format!("b{b}"),
        _ => format!("o{unique}"),
    }
}

/// `tar --version`'s first line, or `None` when there is no tar on PATH.
fn tar_version() -> Option<String> {
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::platform::hide_window(&mut cmd);
    // spawnSync's `error` is set only when the program could not be started at all
    let out = cmd.output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    Some(js::trim(stdout.split('\n').next().unwrap_or("")).to_string())
}

/// `runDoctor({ repair })`: read-only unless `repair` is set, which only clears stale state
/// files and makes secrets files owner-only. Automation (`--json`, the MCP server) never repairs.
pub fn run(layout: &Layout, repair: bool) -> Result<Report, Failure> {
    let mut problems = Vec::new();
    let mut notes = Vec::new();

    // same probe as the panel and first-run wizard, so they agree on what a usable Java is
    let java_check = java::health();
    let path_text = java_check.path.clone().unwrap_or_else(|| "null".into());
    if !java_check.ok {
        problems.push(format!("java: {} {}", java_check.message, java::DOWNLOAD_URL));
    } else {
        let at = if java_check.on_path {
            String::new()
        } else {
            format!(" at {path_text} (not on PATH)")
        };
        notes.push(format!(
            "java: {}{at}",
            java_check.version.as_deref().unwrap_or("null")
        ));
    }
    for other in &java_check.others {
        if java_check.path.as_deref() != Some(other.path.as_str()) {
            notes.push(format!(
                "java (also): {} at {}",
                other.probe.version.as_deref().unwrap_or("undefined"),
                other.path
            ));
        }
    }

    match tar_version() {
        None => problems.push("tar is not on PATH (needed for snapshots)".into()),
        Some(v) => notes.push(format!("tar: {v}")),
    }

    notes.push(format!("core: {}", build::current().line()));
    notes.push(format!("data root: {}", layout.data_root));
    // a note, not a problem: it stays true for as long as the marker exists, and nothing is broken
    let marker_file = data_format::data_format_file(&layout.data_root);
    let marker = data_format::read(Path::new(&marker_file));
    if let Some(w) = data_format::warning(
        &marker_file,
        marker.as_ref(),
        Some(data_format::release_version()),
    ) {
        notes.push(format!("data format: {w}"));
    }
    if let Some(shadowed) = uninstall::shadowed_settings_file() {
        notes.push(format!(
            "settings: also found {shadowed}, which is ignored because the spawnloft folder takes precedence"
        ));
    }
    // an unreadable settings file falls back to defaults (see settings.load)
    let stored = settings::read(Path::new(&layout.settings_file));
    if let Some(error) = stored.error {
        problems.push(format!(
            "settings file {} could not be read ({error}), so SpawnLoft is using the defaults and the data root in use may not be the data folder you chose. Fix the file or delete it.",
            layout.settings_file
        ));
    }
    let registry_file = Path::new(&layout.registry_file);
    let instances = registry::list_instances(registry_file)?;
    if instances.is_empty() {
        problems.extend(settings::describe_servers_elsewhere(&layout.data_root));
    }

    // always checked: a redirected process can't tell it is reading a copy (see private_copy.rs)
    let private_copies = private_copy::find(&private_copy::Where::here(layout));
    let (p, n) = private_copy::describe(&private_copies, Some(&layout.backups_dir));
    problems.extend(p);
    notes.extend(n);

    let mut seen_ports: HashMap<String, String> = HashMap::new();
    for (i, inst) in instances.iter().enumerate() {
        let name = &inst.name;
        let dir = dir_of(inst);
        if !inst.dir().is_some_and(|d| Path::new(d).exists()) {
            problems.push(format!("{name}: directory missing ({dir})"));
            continue;
        }
        let jar = registry::server_jar_path(inst);
        if !Path::new(&jar).exists() {
            problems.push(format!("{name}: jar missing ({jar})"));
        }
        let eula = jspath::join(&[&dir, "eula.txt"]);
        let eula_text = std::fs::read(&eula)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        if !eula_accepted(&eula_text) {
            problems.push(format!("{name}: EULA not accepted ({eula})"));
        }
        let rcon_port = match inst.get("rcon") {
            Some(Value::Object(r)) => r.get("port"),
            _ => None,
        };
        for (label, port) in [("port", inst.get("port")), ("rcon", rcon_port)] {
            let Some(port) = port.filter(|p| js::truthy(Some(p))) else {
                continue;
            };
            let key = port_key(port, &format!("{i} {label}"));
            match seen_ports.get(&key) {
                Some(owner) => problems.push(format!(
                    "{name}: {label} {} collides with {owner}",
                    js::string(Some(port))
                )),
                None => {
                    seen_ports.insert(key, format!("{name} {label}"));
                }
            }
        }
        let state_file = layout.state_file(name);
        let (status, _) = control::read_state(Path::new(&state_file))?;
        if status == Status::Orphaned {
            problems.push(format!(
                "{name}: orphaned java process - run \"spawnloft kill {name}\""
            ));
        }
        // checked even when stopped: the port opens as soon as it starts
        if let Some(exposed) = exposure::rcon_exposure(inst, exposure::Seen::default()) {
            let title = js::string(exposed.get("title")).to_lowercase();
            let advice = js::string(exposed.get("advice"));
            problems.push(format!("{name}: {title}. {advice}"));
        }
        if status == Status::Stale {
            if !repair {
                problems.push(format!(
                    "{name}: stale state file; run doctor without --json to clear it"
                ));
            } else {
                control::clear_state(Path::new(&state_file));
                notes.push(format!("{name}: cleared stale state file"));
            }
        }
        if status == Status::Stopped && !port_free(inst.get("port")) {
            problems.push(format!(
                "{name}: port {} is in use by something else while the instance is stopped",
                js::string(inst.get("port"))
            ));
        }
        notes.push(format!(
            "{name}: {} on disk at {dir}",
            text::human_bytes(Some(util::dir_size(Path::new(&dir)) as f64))
        ));
    }

    let majors: Vec<Option<u32>> = java_check.others.iter().map(|j| j.probe.major).collect();
    let client = crate::client::doctor::check_client_profiles(&ClientPaths::new(layout), repair, &majors)?;
    problems.extend(client.problems);
    notes.extend(client.notes);

    let (p, n) = private_files::check(&private_files(layout)?, repair);
    problems.extend(p);
    notes.extend(n);

    Ok(Report {
        notes,
        problems,
        private_copies,
    })
}

/// `isPortFree(inst.port)` on 127.0.0.1. No port at all lets the system pick one, which is
/// always free; a value no listener could take is not counted against the server.
fn port_free(port: Option<&Value>) -> bool {
    let n = match port {
        None | Some(Value::Null) => return true,
        Some(v) => js::number(Some(v)),
    };
    if !(0.0..=65535.0).contains(&n) || n.fract() != 0.0 {
        return true;
    }
    util::is_port_free(n as u16, "127.0.0.1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eula_reads_as_the_multiline_pattern_does() {
        assert!(eula_accepted("eula=true\n"));
        assert!(eula_accepted("#By changing...\r\n EULA = TRUE \r\n"));
        assert!(eula_accepted("x=1\reula=true"));
        // \s crosses lines in JavaScript, so this one is accepted there too
        assert!(eula_accepted("eula\n=\ntrue"));
        assert!(!eula_accepted("eula=false\n"));
        assert!(!eula_accepted("# eula=true\n"));
        assert!(!eula_accepted(""));
    }

    #[test]
    fn ports_are_keyed_by_type_and_value() {
        assert_eq!(
            port_key(&serde_json::json!(25565), "0"),
            port_key(&serde_json::json!(25565.0), "1")
        );
        assert_ne!(
            port_key(&serde_json::json!(25565), "0"),
            port_key(&serde_json::json!("25565"), "0")
        );
        assert_ne!(
            port_key(&serde_json::json!({}), "0 port"),
            port_key(&serde_json::json!({}), "0 rcon")
        );
    }
}
