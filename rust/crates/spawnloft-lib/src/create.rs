//! `create.mjs`: the jar store, the server launchers, templates, and making a server: from
//! scratch, from a template, as a clone of another, or by adopting a folder that already holds
//! one. C2 brought `placeJar` and `strayJars` forward for `set jar=`; C4 ports the rest.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::activity::{self, Actor};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::settings::Layout;
use crate::{entry, java, js, jsjson, jspath, props, registry, util};

pub const DEFAULT_PORT: f64 = 25565.0;
pub const DEFAULT_RCON_PORT: f64 = 25575.0;

/// `listJars()`'s names: the store's `.jar` files in `localeCompare` order; nothing when the
/// store does not exist.
pub fn list_jar_names(jars_dir: &str) -> Result<Vec<String>, Failure> {
    let dir = Path::new(jars_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for name in crate::fsx::readdir_names(dir).map_err(|e| Failure::io(&e, "scandir", Some(dir)))? {
        if name.ends_with(".jar") {
            // listJars stats each one; a jar that cannot be read fails the listing there
            let p = dir.join(&name);
            std::fs::metadata(&p).map_err(|e| Failure::io(&e, "stat", Some(&p)))?;
            names.push(name);
        }
    }
    names.sort_by(|a, b| crate::collate::compare(a, b));
    Ok(names)
}

/// `placeJar(dir, chosenJar)`: the jar already in the folder, else copied from the store, else
/// from an absolute path; returns where it is and whether it was copied.
pub fn place_jar(jars_dir: &str, dir: &str, chosen: &str) -> Result<(PathBuf, bool), Failure> {
    let base = jspath::basename(chosen);
    let in_instance = PathBuf::from(jspath::join(&[dir, &base]));
    if in_instance.exists() {
        return Ok((in_instance, false));
    }
    let from_store = PathBuf::from(jspath::join(&[jars_dir, &base]));
    let src = if from_store.exists() {
        Some(from_store)
    } else if jspath::is_absolute(chosen) && Path::new(chosen).exists() {
        Some(PathBuf::from(chosen))
    } else {
        None
    };
    let Some(src) = src else {
        let have = list_jar_names(jars_dir)?.join(", ");
        let stored = if have.is_empty() {
            "  The jar store is empty.".to_string()
        } else {
            format!("  Stored jars: {have}")
        };
        return Err(Failure::user(format!(
            "server jar \"{chosen}\" is not in {jars_dir}.\n{stored}\n  Download one with \"spawnloft paper fetch <version>\" or add one with \"spawnloft jars import <path>\"."
        )));
    };
    copyfile(&src, &in_instance)?;
    Ok((in_instance, true))
}

/// `strayJars(dir, currentJar)`: the other `.jar` files in a server's folder with their sizes,
/// in `readdirSync` order; nothing when the folder cannot be read.
pub fn stray_jars(dir: &str, current: &str) -> Vec<(String, u64)> {
    let keep = jspath::basename(current);
    let Ok(names) = crate::fsx::readdir_names(Path::new(dir)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in names {
        if name.to_lowercase().ends_with(".jar") && name != keep {
            // a stat that fails drops the whole list, as the Node try/catch does
            match std::fs::metadata(Path::new(dir).join(&name)) {
                Ok(m) => out.push((name, m.len())),
                Err(_) => return Vec::new(),
            }
        }
    }
    out
}

/// Whether two names are one file: libuv's copyfile returns early then, on every system.
#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!(
        (std::fs::metadata(a), std::fs::metadata(b)),
        (Ok(x), Ok(y)) if x.is_file() && x.dev() == y.dev() && x.ino() == y.ino()
    )
}

#[cfg(windows)]
use crate::platform::same_file;

/// `fs.copyFileSync(src, dest)`, with Node's error: `ENOENT: ..., copyfile 'a' -> 'b'`.
pub fn copyfile(src: &Path, dest: &Path) -> Result<(), Failure> {
    // `std::fs::copy` would truncate the destination first and empty it (the same path, a hard
    // link, a link into the store)
    if same_file(src, dest) {
        return Ok(());
    }
    std::fs::copy(src, dest).map(|_| ()).map_err(|e| {
        // the standard library refuses a folder before asking the system; libuv opens it and
        // the system answers EISDIR (Linux) or ENOTSUP (macOS, from fcopyfile)
        let folder = e.kind() == std::io::ErrorKind::InvalidInput && src.is_dir();
        let (code, text) = if folder && cfg!(target_os = "macos") {
            ("ENOTSUP", "operation not supported on socket")
        } else if folder && cfg!(unix) {
            ("EISDIR", "illegal operation on a directory")
        } else {
            jspath::error_code(&e)
        };
        // Node's message names the paths as Windows spells them
        let shown = |p: &Path| {
            let t = p.to_string_lossy();
            if cfg!(windows) {
                t.replace('/', "\\")
            } else {
                t.into_owned()
            }
        };
        Failure::Internal {
            head: "Error".into(),
            message: format!("{code}: {text}, copyfile '{}' -> '{}'", shown(src), shown(dest)),
            code: Some(code.to_string()),
        }
    })
}

/// A value handed to `path.join`/`path.basename`, which take strings only: the text, or Node's
/// `TypeError` for anything else.
pub fn path_arg<'a>(v: Option<&'a Value>, arg: &str) -> Result<&'a str, Failure> {
    match v {
        Some(Value::String(s)) => Ok(s),
        other => Err(Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"{arg}\" argument must be of type string. {}",
                js::received(other)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// One stored jar, as `listJars()` describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredJar {
    pub name: String,
    pub size: u64,
    /// modification time, epoch milliseconds
    pub mtime_ms: f64,
}

impl StoredJar {
    pub fn size_human(&self) -> String {
        crate::text::human_bytes(Some(self.size as f64))
    }
}

/// `listJars()`: the store's `.jar` files with size and time, in `localeCompare` order; nothing
/// when the store does not exist (a listing makes nothing).
pub fn list_jars(jars_dir: &str) -> Result<Vec<StoredJar>, Failure> {
    let dir = Path::new(jars_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for name in crate::fsx::readdir_names(dir).map_err(|e| Failure::io(&e, "scandir", Some(dir)))? {
        if name.ends_with(".jar") {
            let p = dir.join(&name);
            let m = std::fs::metadata(&p).map_err(|e| Failure::io(&e, "stat", Some(&p)))?;
            let mtime_ms = m
                .modified()
                .ok()
                .map(|t| match t.duration_since(std::time::UNIX_EPOCH) {
                    Ok(d) => (d.as_micros() / 1000) as f64,
                    // before 1970: Node's mtimeMs is negative, except on Windows, where libuv
                    // hands the whole seconds over as an unsigned 32-bit number (a jar from
                    // 1969-12-31 lists as 2106-02-07)
                    Err(e) => {
                        let ms = -((e.duration().as_micros() as f64 / 1000.0).ceil());
                        if cfg!(windows) {
                            let secs = (ms / 1000.0).floor();
                            secs.rem_euclid(4_294_967_296.0) * 1000.0 + (ms - secs * 1000.0)
                        } else {
                            ms
                        }
                    }
                })
                .unwrap_or(0.0);
            out.push(StoredJar {
                name,
                size: m.len(),
                mtime_ms,
            });
        }
    }
    out.sort_by(|a, b| crate::collate::compare(&a.name, &b.name));
    Ok(out)
}

/// `importJar(src, { as })`: a jar copied into the store, under its own name or `as`.
pub fn import_jar(jars_dir: &str, src: &str, as_name: &Value) -> Result<String, Failure> {
    if !Path::new(src).exists() {
        return Err(Failure::user(format!("jar not found: {src}")));
    }
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let base = if js::truthy(Some(as_name)) {
        path_arg(Some(as_name), "path")?.to_string()
    } else {
        jspath::basename(src)
    };
    let dest = jspath::join(&[jars_dir, &base]);
    copyfile(Path::new(src), Path::new(&dest))?;
    Ok(dest)
}

/// How a launcher runs the command line: `cliCommand()` in this process.
fn cli() -> entry::Cli {
    entry::cli_command(std::env::var(entry::ENTRY_ENV).ok().as_deref())
}

/// `writeShellLaunchers`: the three launchers as shell scripts, single-quoted throughout.
fn shell_launchers(name: &str, cli: &entry::Cli) -> Vec<(&'static str, String)> {
    let quote = |v: &str| format!("'{}'", v.replace('\'', "'\\''"));
    let mut run_parts = vec![quote(&cli.exe)];
    run_parts.extend(cli.args.iter().map(|a| quote(a)));
    let run = run_parts.join(" ");
    let mut head = vec!["#!/bin/sh".to_string()];
    head.extend(cli.env.iter().map(|(k, v)| format!("export {k}={}", quote(v))));
    let n = quote(name);
    let script = |lines: &[String]| {
        let mut all = head.clone();
        all.extend(lines.iter().cloned());
        all.push(String::new());
        all.join("\n")
    };
    vec![
        (
            "start.sh",
            script(&[
                format!("{run} start {n} || {{ echo; echo 'Failed to start.'; exit 1; }}"),
                format!("exec {run} console {n}"),
            ]),
        ),
        ("console.sh", script(&[format!("exec {run} console {n}")])),
        ("stop.sh", script(&[format!("exec {run} stop {n}")])),
    ]
}

/// The three `.bat` launchers (Windows, and macOS as the Node core writes them there too).
fn batch_launchers(name: &str, cli: &entry::Cli) -> Vec<(&'static str, String)> {
    let lines = entry::windows_run(cli, "");
    let (last, rest) = lines.split_last().expect("windows_run gives the command line");
    let prelude: String = rest.iter().map(|l| format!("{l}\r\n")).collect();
    let run = js::trim_end(last);
    vec![
        (
            "start.bat",
            format!(
                "@echo off\n{prelude}title {name} - SpawnLoft\n{run} start {name}\nif errorlevel 1 (echo.& echo Failed to start. & pause & exit /b 1)\n{run} console {name}\n"
            ),
        ),
        (
            "console.bat",
            format!("@echo off\n{prelude}title {name} console - SpawnLoft\n{run} console {name}\npause\n"),
        ),
        (
            "stop.bat",
            format!("@echo off\n{prelude}title {name} - SpawnLoft\n{run} stop {name}\npause\n"),
        ),
    ]
}

/// `writeLaunchers({ name, dir })`: start, console and stop launchers in the server's folder, each
/// calling the command line by absolute path. Answers the file names.
pub fn write_launchers(name: &str, dir: Option<&Value>) -> Result<Vec<String>, Failure> {
    let cli = cli();
    let linux = cfg!(target_os = "linux");
    let files = if linux {
        shell_launchers(name, &cli)
    } else {
        batch_launchers(name, &cli)
    };
    let dir = path_arg(dir, "path")?;
    for (file, body) in &files {
        let p = PathBuf::from(jspath::join(&[dir, file]));
        write_launcher(&p, body.as_bytes(), linux)?;
    }
    Ok(files.iter().map(|(f, _)| f.to_string()).collect())
}

fn write_launcher(p: &Path, body: &[u8], executable: bool) -> Result<(), Failure> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o755);
    }
    let mut f = o.open(p).map_err(|e| Failure::io(&e, "open", Some(p)))?;
    f.write_all(body).map_err(|e| Failure::io(&e, "write", None))?;
    drop(f);
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        // mode only applies when the file is created; chmod covers a rewrite
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| Failure::io(&e, "chmod", Some(p)))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

/// `listTemplates()`: each folder of the templates folder as `{ name, dir, ...template.json }`
/// (a template without readable metadata is still usable), in `readdirSync` order.
pub fn list_templates(templates_dir: &str) -> Result<Vec<Map<String, Value>>, Failure> {
    let dir = Path::new(templates_dir);
    crate::fsx::mkdir_all(dir)?;
    let mut out = Vec::new();
    for (name, kind) in crate::fsx::readdir_typed(dir).map_err(|e| Failure::io(&e, "scandir", Some(dir)))? {
        if !kind.is_dir() {
            continue;
        }
        let tdir = jspath::join(&[templates_dir, &name]);
        let mut t = Map::new();
        t.insert("name".into(), json!(name));
        t.insert("dir".into(), json!(tdir));
        let meta = std::fs::read(jspath::join(&[&tdir, "template.json"]))
            .ok()
            .and_then(|b| jsjson::parse(&String::from_utf8_lossy(&b)).ok());
        // only an object's own keys can name a field; an array or a string spreads indexes
        if let Some(Value::Object(m)) = meta {
            for (k, v) in m {
                t.insert(k, v);
            }
        }
        out.push(t);
    }
    Ok(out)
}

/// `copyTree(src, dest, { skip })`: folders and plain files, any entry whose name is in `skip`
/// left out at every depth; links, FIFOs and the rest are not copied.
pub fn copy_tree(src: &Path, dest: &Path, skip: &[String]) -> Result<(), Failure> {
    crate::fsx::mkdir_all(dest)?;
    for (name, kind) in crate::fsx::readdir_typed(src).map_err(|e| Failure::io(&e, "scandir", Some(src)))? {
        if skip.contains(&name) {
            continue;
        }
        let s = PathBuf::from(jspath::join(&[&src.to_string_lossy(), &name]));
        let d = PathBuf::from(jspath::join(&[&dest.to_string_lossy(), &name]));
        if kind.is_dir() {
            copy_tree(&s, &d, skip)?;
        } else if kind.is_file() {
            copyfile(&s, &d)?;
        }
    }
    Ok(())
}

/// Never cloned between instances, nor saved in a template.
pub const CLONE_SKIP: [&str; 8] = [
    "cache",
    "libraries",
    "versions",
    "logs",
    "server-console.log",
    "usercache.json",
    "version_history.json",
    "session.lock",
];

/// The world folders of `dir` (`level-name`, or `world`, and every folder starting
/// `<level>_`), which a clone or a template leaves out unless asked.
fn world_folders_of(dir: &str) -> Result<Vec<String>, Failure> {
    let p = props::read(Path::new(&jspath::join(&[dir, "server.properties"])))?;
    let level = props::get(&p, "level-name")
        .filter(|l| !l.is_empty())
        .unwrap_or("world")
        .to_string();
    let prefix = format!("{level}_");
    let d = Path::new(dir);
    Ok(crate::fsx::readdir_typed(d)
        .map_err(|e| Failure::io(&e, "scandir", Some(d)))?
        .into_iter()
        .filter(|(n, k)| k.is_dir() && (*n == level || n.starts_with(&prefix)))
        .map(|(n, _)| n)
        .collect())
}

/// `readdirSync(src)` refusing a template `dir` that `template.json` made something other than
/// a string.
fn readdir_arg(v: Option<&Value>) -> Result<&str, Failure> {
    match v {
        Some(Value::String(s)) => Ok(s),
        other => Err(Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"path\" argument must be of type string or an instance of Buffer or URL. {}",
                js::received(other)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// The options of `newInstance`, as JavaScript values where the command line can hand over a
/// flag of the wrong kind (`--jar` with no value is `true`).
#[derive(Debug, Clone)]
pub struct NewOptions {
    pub template: Value,
    pub from: Value,
    pub with_worlds: bool,
    pub jar: Value,
    /// `None` is `undefined`, which the default `4G` stands in for
    pub memory: Option<Value>,
    pub port: Option<f64>,
    pub rcon_port: Option<f64>,
    pub accept_eula: bool,
    pub motd: Value,
    pub java: Value,
    pub online_mode: bool,
    pub loader: String,
    pub mc_version: Option<String>,
}

impl Default for NewOptions {
    fn default() -> Self {
        NewOptions {
            template: Value::Null,
            from: Value::Null,
            with_worlds: false,
            jar: Value::Null,
            memory: None,
            port: None,
            rcon_port: None,
            accept_eula: false,
            motd: Value::Null,
            java: Value::Null,
            online_mode: true,
            loader: "paper".into(),
            mc_version: None,
        }
    }
}

/// A server just made: `{ name, ...cfg, eulaAccepted }`.
#[derive(Debug, Clone)]
pub struct Made {
    pub name: String,
    pub cfg: Map<String, Value>,
    pub eula_accepted: bool,
    /// the ports as numbers (`NaN` from a `--port` that is not one, which the record keeps as null)
    pub port: f64,
    pub rcon_port: f64,
}

impl Made {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.cfg.get(key)
    }
    /// `String(cfg[key])`.
    pub fn text(&self, key: &str) -> String {
        js::string(self.cfg.get(key))
    }
    pub fn port_text(&self) -> String {
        js::number_to_string(self.port)
    }
    pub fn rcon_port_text(&self) -> String {
        js::number_to_string(self.rcon_port)
    }
}

fn has_instance(registry_file: &Path, name: &str) -> Result<bool, Failure> {
    Ok(registry::entries_of(&registry::load(registry_file)?)
        .iter()
        .any(|(k, _)| k == name))
}

fn check_memory(memory: &Value) -> Result<(), Failure> {
    registry::parse_memory_gb(&js::string(Some(memory)))
        .map(|_| ())
        .map_err(|_| {
            Failure::user(format!(
                "invalid memory value \"{}\" - use e.g. 4G or 6144M",
                js::string(Some(memory))
            ))
        })
}

/// `java ?? (await defaultJava()) ?? 'java'`.
fn java_or_default(java: &Value) -> Value {
    match java {
        Value::Null => json!(java::default_java().unwrap_or_else(|| "java".into())),
        other => other.clone(),
    }
}

/// `allocatePorts`: the ports given, else the first free from 25565 and 25575 that no record
/// takes (the game port counted as taken for the RCON one).
fn allocate_ports(registry_file: &Path, port: Option<f64>, rcon: Option<f64>) -> Result<(f64, f64), Failure> {
    let mut taken = registry::used_ports(registry_file)?;
    let p = match port {
        Some(p) => p,
        None => f64::from(util::find_free_port(DEFAULT_PORT, &taken)?),
    };
    taken.push(p);
    let r = match rcon {
        Some(r) => r,
        None => f64::from(util::find_free_port(DEFAULT_RCON_PORT, &taken)?),
    };
    Ok((p, r))
}

/// `newInstance(name, options)`: a new server folder under the instances folder, from scratch,
/// a template (`template`) or another server (`from`), with its jar placed, free ports, a fresh
/// RCON password, the launchers, and its record in the registry.
pub fn new_instance(layout: &Layout, by: &Actor, name: &str, o: NewOptions) -> Result<Made, Failure> {
    let registry_file = Path::new(&layout.registry_file);
    registry::validate_name(name).map_err(Failure::user)?;
    if has_instance(registry_file, name)? {
        return Err(Failure::user(format!("instance \"{name}\" already exists")));
    }
    // validated before anything is created: a bad memory value would otherwise only fail later
    // when the daemon builds -Xmx
    let memory = o.memory.clone().unwrap_or_else(|| json!("4G"));
    check_memory(&memory)?;

    let dir = registry::default_dir(&layout.instances_dir, name);
    let dir_path = Path::new(&dir);
    if dir_path.exists() {
        let names =
            crate::fsx::readdir_names(dir_path).map_err(|e| Failure::io(&e, "scandir", Some(dir_path)))?;
        if !names.is_empty() {
            return Err(Failure::user(format!(
                "directory already exists and is not empty: {dir}"
            )));
        }
    }
    crate::fsx::mkdir_all(dir_path)?;

    let mut source_jar = Value::Null;
    if js::truthy(Some(&o.from)) {
        let src = registry::lookup(registry_file, &js::string(Some(&o.from)))?;
        let src_dir = src.get("dir");
        let present = matches!(src_dir, Some(Value::String(d)) if Path::new(d).exists());
        if !present {
            return Err(Failure::user(format!(
                "source instance directory is missing: {}",
                js::string(src_dir)
            )));
        }
        let src_dir = src_dir.and_then(Value::as_str).unwrap_or_default().to_string();
        let mut skip: Vec<String> = CLONE_SKIP.iter().map(|s| s.to_string()).collect();
        if !o.with_worlds {
            skip.extend(world_folders_of(&src_dir)?);
        }
        copy_tree(Path::new(&src_dir), dir_path, &skip)?;
        source_jar = src.get("jar").cloned().unwrap_or(Value::Null);
    } else if js::truthy(Some(&o.template)) {
        let tpl = list_templates(&layout.templates_dir)?
            .into_iter()
            .find(|t| js::strict_equals(t.get("name"), Some(&o.template)));
        let Some(tpl) = tpl else {
            return Err(Failure::user(format!(
                "no template named \"{}\" - see: spawnloft templates",
                js::string(Some(&o.template))
            )));
        };
        crate::fsx::mkdir_all(dir_path)?;
        let tdir = readdir_arg(tpl.get("dir"))?;
        copy_tree(Path::new(tdir), dir_path, &["template.json".to_string()])?;
        source_jar = tpl.get("jar").cloned().unwrap_or(Value::Null);
    }

    // NeoForge has no jar to place: its installer runs after the instance exists and the caller
    // records the starter jar it produces
    let chosen = if o.jar.is_null() {
        source_jar
    } else {
        o.jar.clone()
    };
    let chosen_jar = js::truthy(Some(&chosen));
    if !chosen_jar && o.loader != "neoforge" {
        let have = list_jars(&layout.jars_dir)?
            .into_iter()
            .map(|j| j.name)
            .collect::<Vec<_>>()
            .join(", ");
        let have = if have.is_empty() {
            "(none - use \"spawnloft jars import <path>\")".to_string()
        } else {
            have
        };
        return Err(Failure::user(format!(
            "no server jar specified.\n  Pick one with --jar <file>. Available: {have}"
        )));
    }
    let mut jar_name = "server.jar".to_string();
    if chosen_jar {
        let chosen = path_arg(Some(&chosen), "path")?;
        place_jar(&layout.jars_dir, &dir, chosen)?;
        jar_name = jspath::basename(chosen);
    }

    let (port, rcon_port) = allocate_ports(registry_file, o.port, o.rcon_port)?;
    let password = util::random_password(20)?;
    let motd = if o.motd.is_null() {
        format!("{name} (SpawnLoft)")
    } else {
        js::string(Some(&o.motd))
    };
    let updates: Vec<(String, String)> = [
        ("server-port", js::number_to_string(port)),
        ("enable-rcon", "true".into()),
        ("rcon.port", js::number_to_string(rcon_port)),
        ("rcon.password", password.clone()),
        ("server-ip", String::new()),
        // online by default: offline mode issues name-derived UUIDs
        ("online-mode", if o.online_mode { "true" } else { "false" }.into()),
        ("motd", motd),
        ("max-players", "10".into()),
        ("spawn-protection", "0".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    props::write(Path::new(&jspath::join(&[&dir, "server.properties"])), &updates)?;

    if o.accept_eula {
        let eula = jspath::join(&[&dir, "eula.txt"]);
        std::fs::write(
            &eula,
            format!(
                "# Accepted via SpawnLoft on {}\n# https://aka.ms/MinecraftEULA\neula=true\n",
                crate::time::iso_now()
            ),
        )
        .map_err(|e| Failure::io(&e, "open", Some(Path::new(&eula))))?;
    }

    let mut cfg = Map::new();
    cfg.insert("dir".into(), json!(dir));
    cfg.insert("jar".into(), json!(jar_name));
    cfg.insert("java".into(), java_or_default(&o.java));
    cfg.insert("memory".into(), memory);
    cfg.insert("loader".into(), json!(o.loader));
    if let Some(mc) = o.mc_version.as_ref().filter(|m| !m.is_empty()) {
        cfg.insert("mcVersion".into(), json!(mc));
    }
    cfg.insert("port".into(), jsjson::num(port));
    cfg.insert(
        "rcon".into(),
        json!({ "port": jsjson::num(rcon_port), "password": password }),
    );
    cfg.insert("createdAt".into(), json!(crate::time::iso_now()));
    let origin = if js::truthy(Some(&o.from)) {
        json!({ "clonedFrom": o.from, "withWorlds": o.with_worlds })
    } else if js::truthy(Some(&o.template)) {
        json!({ "template": o.template })
    } else {
        json!({ "scratch": true })
    };
    cfg.insert("origin".into(), origin);
    registry::put_instance(registry_file, name, Value::Object(cfg.clone()))?;
    write_launchers(name, cfg.get("dir"))?;
    activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        name,
        "create",
        Some(&jar_name),
        None,
        true,
    );
    Ok(Made {
        name: name.to_string(),
        cfg,
        eula_accepted: o.accept_eula,
        port,
        rcon_port,
    })
}

/// `guessLoader` from software.mjs, here beside its one caller.
pub use crate::software::guess_loader;

/// `adoptInstance(name, dir, { jar, memory, java })`: an existing server folder registered in
/// place, keeping the ports and RCON credentials of its own `server.properties`.
pub fn adopt_instance(
    layout: &Layout,
    by: &Actor,
    name: &str,
    dir: &str,
    jar: &Value,
    memory: &Value,
    java: &Value,
) -> Result<Made, Failure> {
    let registry_file = Path::new(&layout.registry_file);
    registry::validate_name(name).map_err(Failure::user)?;
    if has_instance(registry_file, name)? {
        return Err(Failure::user(format!("instance \"{name}\" already exists")));
    }
    check_memory(memory)?;
    let abs = jspath::resolve(dir);
    let abs_path = Path::new(&abs);
    if !abs_path.exists() {
        return Err(Failure::user(format!("directory not found: {abs}")));
    }
    let mut jars: Vec<String> = crate::fsx::readdir_names(abs_path)
        .map_err(|e| Failure::io(&e, "scandir", Some(abs_path)))?
        .into_iter()
        .filter(|f| f.ends_with(".jar"))
        .collect();
    // Array.prototype.sort: by UTF-16 code units
    jars.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let chosen: Value = if js::truthy(Some(jar)) {
        jar.clone()
    } else {
        let preferred: Vec<&String> = jars
            .iter()
            .filter(|f| {
                let l = f.to_ascii_lowercase();
                ["paper", "purpur", "spigot", "folia", "fabric", "server"]
                    .iter()
                    .any(|w| l.contains(w))
            })
            .collect();
        let pool: Vec<&String> = if preferred.is_empty() {
            jars.iter().collect()
        } else {
            preferred
        };
        match pool.as_slice() {
            [] => {
                return Err(Failure::user(format!(
                    "no .jar found in {abs} - pass --jar <file>"
                )));
            }
            [one] => json!(one),
            many => {
                let list: Vec<&str> = many.iter().map(|s| s.as_str()).collect();
                return Err(Failure::user(format!(
                    "multiple jars in {abs} - pass --jar <one of: {}>",
                    list.join(", ")
                )));
            }
        }
    };
    let chosen = path_arg(Some(&chosen), "paths[1]")?.to_string();
    // the jar is a file of the adopted folder: a name that climbs out of it would start some
    // other program under this server's name
    let full = if jspath::is_absolute(&chosen) {
        jspath::resolve(&chosen)
    } else {
        jspath::resolve(&jspath::join(&[&abs, &chosen]))
    };
    let rel = jspath::relative(&abs, &full);
    if rel.is_empty() || rel.starts_with("..") || jspath::is_absolute(&rel) {
        return Err(Failure::user(format!(
            "the jar must be a file inside {abs}: {chosen}"
        )));
    }
    let jar_path = jspath::join(&[&abs, &chosen]);
    if !Path::new(&jar_path).exists() {
        return Err(Failure::user(format!("jar not found: {jar_path}")));
    }

    let p = props::read(Path::new(&jspath::join(&[&abs, "server.properties"])))?;
    let number = |k: &str| {
        let n = props::get(&p, k).map_or(f64::NAN, js::string_to_number);
        (n != 0.0 && !n.is_nan()).then_some(n)
    };
    let mut taken = registry::used_ports(registry_file)?;
    let port = match number("server-port") {
        Some(n) => n,
        None => f64::from(util::find_free_port(DEFAULT_PORT, &taken)?),
    };
    taken.push(port);
    let rcon_port = match number("rcon.port") {
        Some(n) => n,
        None => f64::from(util::find_free_port(DEFAULT_RCON_PORT, &taken)?),
    };
    let password = match props::get(&p, "rcon.password").filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => util::random_password(20)?,
    };
    let neoforge_libs = Path::new(&jspath::join(&[&abs, "libraries", "net", "neoforged"])).exists();

    let mut cfg = Map::new();
    cfg.insert("dir".into(), json!(abs));
    cfg.insert("jar".into(), json!(chosen));
    cfg.insert("java".into(), java_or_default(java));
    cfg.insert("memory".into(), memory.clone());
    cfg.insert("loader".into(), json!(guess_loader(&chosen, neoforge_libs)));
    cfg.insert("port".into(), jsjson::num(port));
    cfg.insert(
        "rcon".into(),
        json!({ "port": jsjson::num(rcon_port), "password": password }),
    );
    cfg.insert("createdAt".into(), json!(crate::time::iso_now()));
    cfg.insert("origin".into(), json!({ "adopted": abs }));
    registry::put_instance(registry_file, name, Value::Object(cfg.clone()))?;
    write_launchers(name, cfg.get("dir"))?;
    activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        name,
        "adopt",
        Some(&abs),
        None,
        true,
    );
    Ok(Made {
        name: name.to_string(),
        cfg,
        eula_accepted: false,
        port,
        rcon_port,
    })
}

/// `saveTemplate(inst, templateName, { includeWorlds })`: the server's folder copied into the
/// templates folder without its jar (that lives in the jar store), its generated files, and
/// unless asked its worlds, with a `template.json` describing it.
pub fn save_template(
    layout: &Layout,
    inst: &registry::Instance,
    template: &str,
    include_worlds: bool,
) -> Result<String, Failure> {
    registry::validate_name(template).map_err(Failure::user)?;
    let dest = jspath::join(&[&layout.templates_dir, template]);
    if Path::new(&dest).exists() {
        return Err(Failure::user(format!("template \"{template}\" already exists")));
    }
    let mut skip: Vec<String> = CLONE_SKIP.iter().map(|s| s.to_string()).collect();
    if !include_worlds {
        skip.extend(world_folders_of(path_arg(inst.get("dir"), "path")?)?);
    }
    // the jar lives in the jar store, not in every template
    if let Some(Value::String(j)) = inst.get("jar") {
        skip.push(j.clone());
    }
    crate::fsx::mkdir_all(Path::new(&dest))?;
    let dir = readdir_arg(inst.get("dir"))?;
    copy_tree(Path::new(dir), Path::new(&dest), &skip)?;
    let mut meta = Map::new();
    meta.insert("name".into(), json!(template));
    // JSON.stringify leaves out an undefined jar or memory
    for key in ["jar", "memory"] {
        if let Some(v) = inst.get(key) {
            meta.insert(key.into(), v.clone());
        }
    }
    meta.insert("includesWorlds".into(), json!(include_worlds));
    // `inst.name`: the record's own name when it carries one, whatever its type
    let source = match inst.get("name") {
        Some(v) => v.clone(),
        None => json!(inst.name),
    };
    meta.insert("sourceInstance".into(), source);
    meta.insert("createdAt".into(), json!(crate::time::iso_now()));
    let file = jspath::join(&[&dest, "template.json"]);
    std::fs::write(
        &file,
        format!("{}\n", jsjson::stringify_pretty(&Value::Object(meta))),
    )
    .map_err(|e| Failure::io(&e, "open", Some(Path::new(&file))))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jar_comes_from_the_store_once() {
        let root = std::env::temp_dir().join(format!("sl-create-{}", std::process::id()));
        let store = root.join("jars");
        let inst = root.join("i");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&inst).unwrap();
        std::fs::write(store.join("b.jar"), b"x").unwrap();
        std::fs::write(store.join("a.jar"), b"y").unwrap();
        let (s, i) = (store.to_string_lossy(), inst.to_string_lossy());
        let (p, copied) = place_jar(&s, &i, "b.jar").unwrap();
        assert!(copied && p.exists());
        assert!(!place_jar(&s, &i, "b.jar").unwrap().1);
        let f = place_jar(&s, &i, "c.jar").unwrap_err();
        assert!(
            f.message().contains("  Stored jars: a.jar, b.jar\n"),
            "{}",
            f.message()
        );
        std::fs::write(inst.join("old.JAR"), b"zz").unwrap();
        assert_eq!(stray_jars(&i, "b.jar"), vec![("old.JAR".to_string(), 2)]);
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn launchers_quote_and_carry_the_environment() {
        let cli = entry::Cli {
            exe: "/opt/Spawn Loft/it's/spawnloft-core".into(),
            args: vec![],
            env: vec![("A".into(), "b c".into())],
            via_entry: true,
        };
        let sh = shell_launchers("alpha", &cli);
        assert_eq!(
            sh[0].1,
            "#!/bin/sh\nexport A='b c'\n'/opt/Spawn Loft/it'\\''s/spawnloft-core' start 'alpha' || { echo; echo 'Failed to start.'; exit 1; }\nexec '/opt/Spawn Loft/it'\\''s/spawnloft-core' console 'alpha'\n"
        );
        assert_eq!(sh[2].0, "stop.sh");
        let bat = batch_launchers("alpha", &cli);
        assert_eq!(
            bat[2].1,
            "@echo off\nset A=b c\r\ntitle alpha - SpawnLoft\n\"/opt/Spawn Loft/it's/spawnloft-core\" stop alpha\npause\n"
        );
    }

    #[test]
    fn a_tree_is_copied_without_the_skipped_names_at_any_depth() {
        let root = std::env::temp_dir().join(format!("sl-create-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(src.join("plugins/P/logs")).unwrap();
        std::fs::create_dir_all(src.join("logs")).unwrap();
        std::fs::write(src.join("plugins/P/logs/x.log"), b"l").unwrap();
        std::fs::write(src.join("plugins/P/c.yml"), b"c").unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(src.join("a.txt"), src.join("link.txt")).unwrap();
        let dest = root.join("dest");
        copy_tree(&src, &dest, &["logs".to_string()]).unwrap();
        assert!(dest.join("plugins/P/c.yml").exists());
        assert!(dest.join("a.txt").exists());
        assert!(!dest.join("plugins/P/logs").exists());
        assert!(!dest.join("logs").exists());
        assert!(std::fs::symlink_metadata(dest.join("link.txt")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
