//! `instances.json`, read two ways.
//!
//! The daemon's view ([`get_instance`]) is lenient the way the R1 contract asks: every field is
//! optional and unknown fields are ignored, because daemons outlive updates and an old daemon
//! re-reads a newer registry on every crash restart.
//!
//! The command line's view ([`load`], [`list_all`], [`lookup`]) is `registry.mjs` exactly,
//! failures included: the same order, the same messages, and the same refusal of a file that is
//! not JSON.
//!
//! The writes ([`put_instance`], [`update_instance`], [`remove_instance`]) are `registry.mjs`'s,
//! under the same lock file (`instances.json.lock`, see `lock.rs`), so a Rust and a Node process
//! changing the registry at once never lose each other's write. The file holds RCON, database and
//! webhook secrets, so it is written owner-only (`private_files.rs`).

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::LazyLock;

use crate::js;

static NAME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$").expect("name pattern"));

/// The same rule as `util.mjs` `validateName`: a name is a folder, a pipe name and an argument.
pub fn validate_name(name: &str) -> Result<(), String> {
    if NAME_RE.is_match(name) {
        Ok(())
    } else {
        Err(format!(
            "invalid instance name \"{name}\" - use letters, digits, dash, underscore (max 32 chars)"
        ))
    }
}

/// One instance's record, with its name.
#[derive(Debug, Clone, PartialEq)]
pub struct Instance {
    pub name: String,
    pub fields: Map<String, Value>,
}

impl Instance {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }
    fn text(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }
    /// The instance's folder (`inst.dir`).
    pub fn dir(&self) -> Option<&str> {
        self.text("dir")
    }
    pub fn jar(&self) -> Option<&str> {
        self.text("jar")
    }
    /// `inst.java || 'java'`.
    pub fn java(&self) -> String {
        if js::truthy(self.get("java")) {
            js::string(self.get("java"))
        } else {
            "java".to_string()
        }
    }
    pub fn webhook(&self) -> Option<String> {
        if js::truthy(self.get("webhook")) {
            Some(js::string(self.get("webhook")))
        } else {
            None
        }
    }
    pub fn auto_restart(&self) -> bool {
        js::truthy(self.get("autoRestart"))
    }
    /// Absent kind means a server.
    pub fn is_database(&self) -> bool {
        self.text("kind") == Some("database")
    }
    pub fn kind(&self) -> &'static str {
        if self.is_database() { "database" } else { "server" }
    }
    pub fn engine(&self) -> Option<&str> {
        self.text("engine")
    }
    fn rcon(&self) -> Option<&Map<String, Value>> {
        self.get("rcon").and_then(Value::as_object)
    }
    /// `inst.rcon?.port`, as a TCP port when it is one.
    pub fn rcon_port(&self) -> Option<u16> {
        let n = js::number(self.rcon()?.get("port"));
        ((1.0..=65535.0).contains(&n) && n.fract() == 0.0).then_some(n as u16)
    }
    pub fn rcon_port_value(&self) -> Value {
        self.rcon()
            .and_then(|r| r.get("port"))
            .cloned()
            .unwrap_or(Value::Null)
    }
    pub fn rcon_password(&self) -> Option<String> {
        let v = self.rcon()?.get("password");
        js::truthy(v).then(|| js::string(v))
    }
    /// The server's own Java arguments when it has some (`inst.jvmFlags?.length`).
    pub fn jvm_flags(&self) -> Option<Vec<String>> {
        let items = self.get("jvmFlags")?.as_array()?;
        if items.is_empty() {
            return None;
        }
        Some(items.iter().map(|v| js::string(Some(v))).collect())
    }
}

/// `getInstance`: the record under `name`, read with no lock (the registry is replaced by rename,
/// so a read never sees half a file).
pub fn get_instance(registry_file: &Path, name: &str) -> Result<Instance, String> {
    validate_name(name)?;
    let instances = load_instances(registry_file)?;
    match instances.get(name) {
        Some(Value::Object(fields)) => Ok(Instance {
            name: name.to_string(),
            fields: fields.clone(),
        }),
        Some(_) => Err(format!(
            "the record of \"{name}\" in instances.json is not an object"
        )),
        None => {
            let known: Vec<&str> = instances.keys().map(String::as_str).collect();
            Err(if known.is_empty() {
                format!("no instance named \"{name}\". Create one with: spawnloft new <name>")
            } else {
                format!(
                    "no instance named \"{name}\". Known instances: {}",
                    known.join(", ")
                )
            })
        }
    }
}

fn load_instances(registry_file: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(registry_file) {
        Ok(t) => t,
        Err(e) if crate::jspath::is_enoent(&e) => return Ok(Map::new()),
        Err(e) => return Err(format!("could not read {}: {e}", registry_file.display())),
    };
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{} is not valid JSON: {e}", registry_file.display()))?;
    Ok(match data.get("instances") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    })
}

/// `Object.entries(x)` for whatever `instances` holds: an object's keys, a string's characters or
/// an array's items by index; nothing for anything else.
pub fn entries_of(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, u)| (i.to_string(), Value::String(String::from_utf16_lossy(&[u]))))
            .collect(),
        _ => Vec::new(),
    }
}

/// `{ name, ...cfg }`: the name first, then the record's own fields, so a record carrying its
/// own `name` shows that one (in its first place).
pub fn spread(name: &str, cfg: &Value) -> Instance {
    let mut fields = Map::new();
    fields.insert("name".into(), Value::String(name.into()));
    for (k, v) in entries_of(cfg) {
        fields.insert(k, v);
    }
    Instance {
        name: js::string(fields.get("name")),
        fields,
    }
}

/// The registry's `instances`, as `loadRegistry()` leaves it: read strictly (`readJson`), with
/// JavaScript's errors for a file that is not a JSON object.
pub fn load(registry_file: &Path) -> Result<Value, crate::failure::Failure> {
    use crate::failure::Failure;
    let text = match std::fs::read(registry_file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if crate::jspath::is_enoent(&e) => return Ok(Value::Object(Map::new())),
        Err(e) => return Err(Failure::read(&e, registry_file)),
    };
    let data = crate::jsjson::parse(&text).map_err(Failure::syntax)?;
    let instances = match &data {
        Value::Null => {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'instances')",
            ));
        }
        Value::Object(m) => m.get("instances").cloned().unwrap_or(Value::Null),
        Value::Array(_) => Value::Null,
        other => {
            // `data.instances = {}` on a primitive, in strict mode
            let (kind, shown) = match other {
                Value::Bool(b) => ("boolean", b.to_string()),
                Value::Number(_) => ("number", js::string(Some(other))),
                _ => ("string", js::string(Some(other))),
            };
            return Err(Failure::type_error(format!(
                "Cannot create property 'instances' on {kind} '{shown}'"
            )));
        }
    };
    Ok(if js::truthy(Some(&instances)) {
        instances
    } else {
        Value::Object(Map::new())
    })
}

/// `listAll()`: every record, servers and databases, sorted by name with `localeCompare`.
pub fn list_all(registry_file: &Path) -> Result<Vec<Instance>, crate::failure::Failure> {
    let reg = load(registry_file)?;
    let mut all: Vec<Instance> = entries_of(&reg).iter().map(|(k, v)| spread(k, v)).collect();
    // `a.name.localeCompare(b.name)` throws when `a.name` is not a string. V8 sorts a short
    // array by binary insertion, where every record but the first is `a` at least once.
    if let Some(bad) = all
        .get(1..)
        .unwrap_or_default()
        .iter()
        .find_map(|i| i.fields.get("name").filter(|v| !v.is_string()))
    {
        return Err(crate::failure::Failure::type_error(if bad.is_null() {
            "Cannot read properties of null (reading 'localeCompare')".to_string()
        } else {
            "a.name.localeCompare is not a function".to_string()
        }));
    }
    all.sort_by(|a, b| crate::collate::compare(&a.name, &b.name));
    Ok(all)
}

impl Instance {
    /// The name as a path segment: `path.join` takes strings only, so a record whose own `name`
    /// is not one fails where its run folder is built.
    pub fn path_name(&self) -> Result<&str, crate::failure::Failure> {
        match self.fields.get("name") {
            Some(Value::String(_)) | None => Ok(&self.name),
            other => Err(crate::failure::Failure::Internal {
                head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
                message: format!(
                    "The \"path\" argument must be of type string. {}",
                    js::received(other)
                ),
                code: Some("ERR_INVALID_ARG_TYPE".into()),
            }),
        }
    }
}

/// `listInstances()`: servers only.
pub fn list_instances(registry_file: &Path) -> Result<Vec<Instance>, crate::failure::Failure> {
    Ok(list_all(registry_file)?
        .into_iter()
        .filter(|i| !i.is_database())
        .collect())
}

/// `listServices()`: databases only.
pub fn list_services(registry_file: &Path) -> Result<Vec<Instance>, crate::failure::Failure> {
    Ok(list_all(registry_file)?
        .into_iter()
        .filter(Instance::is_database)
        .collect())
}

/// `getInstance(name)` for the command line: the name checked, then the record or the
/// "no instance named" refusal with the names that do exist.
pub fn lookup(registry_file: &Path, name: &str) -> Result<Instance, crate::failure::Failure> {
    use crate::failure::Failure;
    validate_name(name).map_err(Failure::user)?;
    let reg = load(registry_file)?;
    let entries = entries_of(&reg);
    match entries.iter().find(|(k, _)| k == name) {
        Some((_, cfg)) if js::truthy(Some(cfg)) => Ok(spread(name, cfg)),
        _ => {
            let known: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
            Err(Failure::user(if known.is_empty() {
                format!("no instance named \"{name}\". Create one with: spawnloft new <name>")
            } else {
                format!(
                    "no instance named \"{name}\". Known instances: {}",
                    known.join(", ")
                )
            }))
        }
    }
}

/// The one lock for the whole registry: the daemon recording a pid while the panel changes a
/// setting would otherwise lose one of the writes.
pub fn lock_file(registry_file: &Path) -> std::path::PathBuf {
    let mut f = registry_file.as_os_str().to_owned();
    f.push(".lock");
    f.into()
}

/// `loadRegistry()` for a write: the whole document, with `instances` made `{}` when it is
/// missing or falsy, as Node leaves it before changing it. Failures are [`load`]'s.
fn load_document(registry_file: &Path) -> Result<Value, crate::failure::Failure> {
    use crate::failure::Failure;
    let text = match std::fs::read(registry_file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        // readJson's fallback, { version: 1, instances: {} }
        Err(e) if crate::jspath::is_enoent(&e) => {
            return Ok(serde_json::json!({ "version": 1, "instances": {} }));
        }
        Err(e) => return Err(Failure::read(&e, registry_file)),
    };
    let mut data = crate::jsjson::parse(&text).map_err(Failure::syntax)?;
    // the same refusals as a read
    load(registry_file)?;
    if let Value::Object(m) = &mut data
        && !js::truthy(m.get("instances"))
    {
        m.insert("instances".into(), Value::Object(Map::new()));
    }
    Ok(data)
}

/// `saveRegistry`: the whole document, owner-only, through a temp file and a rename. A drive
/// that cannot be made private is still written, as in Node (`strict` is off).
pub fn save(registry_file: &Path, data: &Value) -> Result<(), crate::failure::Failure> {
    crate::fsx::write_json_node(
        registry_file,
        data,
        Some(crate::private_files::PRIVATE_MODE),
        false,
    )
    .map(|_| ())
}

fn lock_failure(e: crate::lock::LockError, lock: &Path) -> crate::failure::Failure {
    use crate::failure::Failure;
    use crate::lock::LockError;
    match e {
        // fail(): a person's error
        LockError::NotGot { .. } => Failure::user(e.to_string()),
        LockError::TimedOut { .. } => Failure::Internal {
            head: "Error".into(),
            message: e.to_string(),
            code: None,
        },
        // the folder was made beforehand, so what is left is opening the lock file
        LockError::Io(io) => Failure::io(&io, "open", Some(lock)),
    }
}

/// Runs `f` over the registry document under the registry lock, then saves what it left.
fn change<T>(
    registry_file: &Path,
    f: impl FnOnce(&mut Value) -> Result<T, crate::failure::Failure>,
) -> Result<T, crate::failure::Failure> {
    let lock = lock_file(registry_file);
    // tryLock makes the folder first; done here so its failure names it as Node's does
    if let Some(dir) = lock.parent().filter(|d| !d.as_os_str().is_empty()) {
        crate::fsx::mkdir_all(dir)?;
    }
    crate::lock::with_lock(&lock, crate::lock::Options::default(), || {
        let mut data = load_document(registry_file)?;
        let out = f(&mut data)?;
        save(registry_file, &data)?;
        Ok(out)
    })
    .map_err(|e| lock_failure(e, &lock))?
}

/// `reg.instances[name] = cfg` with JavaScript's rules for what `instances` may hold: an object
/// takes the key (in place if it had it), an array takes an index-like name as an element (any
/// other name is a property `JSON.stringify` drops), and a primitive refuses in strict mode.
fn assign(instances: &mut Value, name: &str, cfg: Value) -> Result<(), crate::failure::Failure> {
    match instances {
        Value::Object(m) => {
            m.insert(name.into(), cfg);
            Ok(())
        }
        Value::Array(items) => {
            if crate::jsjson::is_index_key(name)
                && let Ok(i) = name.parse::<usize>()
            {
                if i >= items.len() {
                    items.resize(i + 1, Value::Null);
                }
                items[i] = cfg;
            }
            Ok(())
        }
        other => Err(primitive_refusal(
            other,
            &format!("Cannot create property '{name}' on"),
        )),
    }
}

fn primitive_refusal(v: &Value, what: &str) -> crate::failure::Failure {
    let (kind, shown) = match v {
        Value::Bool(b) => ("boolean", b.to_string()),
        Value::Number(_) => ("number", js::string(Some(v))),
        _ => ("string", js::string(Some(v))),
    };
    crate::failure::Failure::type_error(format!("{what} {kind} '{shown}'"))
}

/// The document's `instances`, which [`load_document`] made present for an object document.
/// An array document has none Node can keep: its writes go nowhere, as in Node.
fn instances_of(data: &mut Value) -> Option<&mut Value> {
    data.as_object_mut().and_then(|m| m.get_mut("instances"))
}

/// `putInstance`: adds or replaces a record.
pub fn put_instance(registry_file: &Path, name: &str, cfg: Value) -> Result<(), crate::failure::Failure> {
    validate_name(name).map_err(crate::failure::Failure::user)?;
    change(registry_file, |data| match instances_of(data) {
        Some(instances) => assign(instances, name, cfg),
        None => Ok(()),
    })
}

/// `updateInstance`: the record's fields with `patch` over them, in the record's own order and
/// then the new keys; answers `{ name, ...record }` as saved.
pub fn update_instance(
    registry_file: &Path,
    name: &str,
    patch: &Map<String, Value>,
) -> Result<Instance, crate::failure::Failure> {
    use crate::failure::Failure;
    change(registry_file, |data| {
        let missing = || Failure::user(format!("no instance named \"{name}\""));
        let Some(instances) = instances_of(data) else {
            return Err(missing());
        };
        let Some(current) = entries_of(instances)
            .into_iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
        else {
            return Err(missing());
        };
        let mut merged = Map::new();
        for (k, v) in entries_of(&current) {
            merged.insert(k, v);
        }
        for (k, v) in patch {
            merged.insert(k.clone(), v.clone());
        }
        let merged = Value::Object(merged);
        assign(instances, name, merged.clone())?;
        Ok(spread(name, &merged))
    })
}

/// `removeInstance`: deletes the record, keeping the others' order.
pub fn remove_instance(registry_file: &Path, name: &str) -> Result<(), crate::failure::Failure> {
    change(registry_file, |data| {
        match instances_of(data) {
            Some(Value::Object(m)) => {
                m.shift_remove(name);
            }
            // `delete arr[i]` leaves a hole, which JSON.stringify writes as null
            Some(Value::Array(items)) => {
                if crate::jsjson::is_index_key(name)
                    && let Ok(i) = name.parse::<usize>()
                    && i < items.len()
                {
                    items[i] = Value::Null;
                }
            }
            // a string's characters cannot be deleted in strict mode
            Some(Value::String(s))
                if crate::jsjson::is_index_key(name)
                    && name.parse::<usize>().is_ok_and(|i| i < s.encode_utf16().count()) =>
            {
                return Err(crate::failure::Failure::type_error(format!(
                    "Cannot delete property '{name}' of [object String]"
                )));
            }
            _ => {}
        }
        Ok(())
    })
}

/// `freeName`: the first of `base`, `base-2`, `base-3`... not taken, each within the 32-character
/// limit with the dashes and underscores the cut leaves at the end dropped.
pub fn free_name(registry_file: &Path, base: &str) -> Result<String, crate::failure::Failure> {
    let taken: Vec<String> = entries_of(&load(registry_file)?)
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    let mut name = base.to_string();
    let mut i = 2u64;
    while taken.contains(&name) {
        let suffix = format!("-{i}");
        let keep = 32usize.saturating_sub(suffix.len());
        let cut: String = String::from_utf16_lossy(&base.encode_utf16().take(keep).collect::<Vec<_>>());
        name = format!("{}{suffix}", cut.trim_end_matches(['-', '_']));
        i += 1;
    }
    Ok(name)
}

/// A port as a record holds it: a JSON number (any other value is no port).
fn port_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// `usedPorts`: every game and RCON port a record names, truthy ones only.
pub fn used_ports(registry_file: &Path) -> Result<Vec<f64>, crate::failure::Failure> {
    let mut taken: Vec<f64> = Vec::new();
    for inst in list_all(registry_file)? {
        let rcon_port = inst.get("rcon").and_then(|r| r.get("port"));
        for v in [inst.get("port"), rcon_port] {
            if js::truthy(v) {
                // a Set of whatever the record holds; only numbers matter to a caller
                if let Some(p) = port_of(v)
                    && !taken.contains(&p)
                {
                    taken.push(p);
                }
            }
        }
    }
    Ok(taken)
}

/// `assertPortUsable`: a whole number from 1 to 65535 that no other record uses as its game or
/// RCON port. `port` is what the caller was given, shown in the refusal as JavaScript prints it.
pub fn assert_port_usable(
    registry_file: &Path,
    name: &str,
    port: &Value,
    label: &str,
) -> Result<u16, crate::failure::Failure> {
    use crate::failure::Failure;
    let n = port
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (1.0..=65535.0).contains(n));
    let Some(n) = n else {
        let shown = js::string(Some(port));
        return Err(Failure::user(format!(
            "{shown} is not a {label} number - use 1 to 65535"
        )));
    };
    let clash = list_all(registry_file)?.into_iter().find(|i| {
        i.name != name
            && (port_of(i.get("port")) == Some(n)
                || port_of(i.get("rcon").and_then(|r| r.get("port"))) == Some(n))
    });
    if let Some(c) = clash {
        return Err(Failure::user(format!(
            "port {n} is already used by \"{}\"",
            c.name
        )));
    }
    Ok(n as u16)
}

/// `defaultDir`: a new server's folder under the instances folder.
pub fn default_dir(instances_dir: &str, name: &str) -> String {
    crate::jspath::join(&[instances_dir, name])
}

/// `inst.dir` where Node passes it to `path.join`, which refuses anything but a string.
pub fn dir_text(inst: &Instance) -> Result<String, crate::failure::Failure> {
    match inst.get("dir") {
        Some(Value::String(s)) => Ok(s.clone()),
        other => Err(crate::failure::Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"path\" argument must be of type string. {}",
                crate::js::received(other)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// `serverJarPath`.
pub fn server_jar_path(inst: &Instance) -> String {
    crate::jspath::join(&[inst.dir().unwrap_or(""), inst.jar().unwrap_or("")])
}

/// `assertInstanceDir`: the folder exists, and a server's jar is in it (a database's engine
/// checks what it needs at launch).
pub fn assert_instance_dir(inst: &Instance) -> Result<(), crate::failure::Failure> {
    use crate::failure::Failure;
    let dir = inst.dir().unwrap_or("");
    if !Path::new(dir).exists() {
        return Err(Failure::user(format!(
            "instance \"{}\" directory is missing: {dir}",
            inst.name
        )));
    }
    if inst.is_database() {
        return Ok(());
    }
    let jar = server_jar_path(inst);
    if !Path::new(&jar).exists() {
        return Err(Failure::user(format!(
            "server jar not found for \"{}\": {jar}",
            inst.name
        )));
    }
    Ok(())
}

/// Java arguments every server gets before its own flags (`SERVER_SYSTEM_PROPERTIES`): the server
/// runs with no TTY, so JLine is not tried.
pub const SERVER_SYSTEM_PROPERTIES: [&str; 1] = ["-Dterminal.jline=false"];

/// `serverJvmArgs`.
pub fn server_jvm_args(memory: &str, flags: &[String], jar_name: &str) -> Vec<String> {
    let mut out = vec![format!("-Xms{memory}"), format!("-Xmx{memory}")];
    out.extend(SERVER_SYSTEM_PROPERTIES.iter().map(|s| s.to_string()));
    out.extend(flags.iter().cloned());
    out.extend(["-jar".into(), jar_name.into(), "--nogui".into()]);
    out
}

/// `cleanJvmFlags`: a server's own Java arguments, from space- or line-separated text or a list.
/// `None` for nothing (the recommended flags). Memory and the jar are refused: the Memory setting
/// and the server's own jar decide those.
pub fn clean_jvm_flags(input: &Value) -> Result<Option<Vec<String>>, crate::failure::Failure> {
    use crate::failure::Failure;
    let tokens: Vec<String> = match input {
        Value::Null => return Ok(None),
        Value::Array(items) => items
            .iter()
            .map(|v| js::trim(&js::string(Some(v))).to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        other => js::string(Some(other))
            .split(js::is_js_space)
            .map(|t| t.to_string())
            .filter(|t| !t.is_empty())
            .collect(),
    };
    if tokens.is_empty() {
        return Ok(None);
    }
    if tokens.len() > 60 {
        return Err(Failure::user("that is more than 60 Java arguments"));
    }
    for t in &tokens {
        let units: Vec<u16> = t.encode_utf16().collect();
        if units.len() > 300 {
            let head = String::from_utf16_lossy(&units[..40]);
            return Err(Failure::user(format!(
                "\"{head}...\" is too long for one argument"
            )));
        }
        if !t.starts_with('-') {
            return Err(Failure::user(format!(
                "\"{t}\" is not a Java option - each starts with a dash, like -XX:+UseG1GC"
            )));
        }
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("-xms") || lower.starts_with("-xmx") {
            return Err(Failure::user(format!(
                "{t}: memory is set by the Memory setting, so both stay in step"
            )));
        }
        if matches!(lower.as_str(), "-jar" | "-cp" | "-classpath" | "--class-path") {
            return Err(Failure::user(format!(
                "{t}: which jar runs is the server's own jar"
            )));
        }
    }
    Ok(Some(tokens))
}

/// `loaderOf`: absent means paper, for servers made before the field existed.
pub fn loader_of(inst: &Instance) -> String {
    match inst.get("loader") {
        None | Some(Value::Null) => "paper".into(),
        v => js::string(v),
    }
}

static MEMORY_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        // JavaScript's `\s`, which is not Rust's: it has U+FEFF and lacks U+0085
        r"^([0-9]+(?:\.[0-9]+)?)[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*([GgMm])$",
    ).expect("memory pattern")
});

/// `parseMemoryGb`: `4G` is 4, `6144M` is 6.
pub fn parse_memory_gb(memory: &str) -> Result<f64, String> {
    let caps = MEMORY_RE
        .captures(js::trim(memory))
        .ok_or_else(|| format!("invalid memory value \"{memory}\" - use e.g. 4G or 6144M"))?;
    let n: f64 = caps[1]
        .parse()
        .map_err(|_| format!("invalid memory value \"{memory}\""))?;
    Ok(if caps[2].eq_ignore_ascii_case("G") {
        n
    } else {
        n / 1024.0
    })
}

/// Aikar's G1 flags (`jvmFlagsFor`), with the large-heap variant from 12G.
pub fn jvm_flags_for(memory: &str) -> Result<Vec<String>, String> {
    let large = parse_memory_gb(memory)? >= 12.0;
    let pick = |big: u32, small: u32| if large { big } else { small };
    Ok(vec![
        "-XX:+UseG1GC".into(),
        "-XX:+ParallelRefProcEnabled".into(),
        "-XX:MaxGCPauseMillis=200".into(),
        "-XX:+UnlockExperimentalVMOptions".into(),
        "-XX:+DisableExplicitGC".into(),
        "-XX:+AlwaysPreTouch".into(),
        format!("-XX:G1NewSizePercent={}", pick(40, 30)),
        format!("-XX:G1MaxNewSizePercent={}", pick(50, 40)),
        format!("-XX:G1HeapRegionSize={}M", pick(16, 8)),
        format!("-XX:G1ReservePercent={}", pick(15, 20)),
        "-XX:G1HeapWastePercent=5".into(),
        "-XX:G1MixedGCCountTarget=4".into(),
        format!("-XX:InitiatingHeapOccupancyPercent={}", pick(20, 15)),
        "-XX:G1MixedGCLiveThresholdPercent=90".into(),
        "-XX:G1RSetUpdatingPauseTimePercent=5".into(),
        "-XX:SurvivorRatio=32".into(),
        "-XX:+PerfDisableSharedMem".into(),
        "-XX:MaxTenuringThreshold=1".into(),
        "-Dusing.aikars.flags=https://mcflags.emc.gs".into(),
        "-Daikars.new.flags=true".into(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn library() -> serde_json::Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/c1-library.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    // what the Rust registry leaves after a write: this user alone, nothing from the folder
    #[cfg(windows)]
    #[test]
    fn a_saved_registry_is_owner_only_on_windows() {
        let dir = std::env::temp_dir().join(format!("sl-reg-acl-{}", std::process::id()));
        let file = dir.join("instances.json");
        put_instance(&file, "smp", json!({ "rcon": { "password": "x" } })).unwrap();
        let sddl = crate::platform::dacl_sddl(&file)
            .unwrap()
            .replace("AI", "")
            .replace("AR", "");
        assert!(
            sddl.starts_with("D:P(A;;FA;;;") && sddl.matches('(').count() == 1,
            "{sddl}"
        );
        assert_eq!(
            crate::private_files::inspect(&file),
            crate::private_files::State::Private
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_registry_under_a_file_names_the_folder() {
        let dir = std::env::temp_dir().join(format!("sl-reg-blocked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("afile"), "").unwrap();
        let e = put_instance(&dir.join("afile").join("instances.json"), "smp", json!({})).unwrap_err();
        assert_eq!(
            e.message(),
            format!(
                "EEXIST: file already exists, mkdir '{}'",
                dir.join("afile").display()
            )
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn jvm_flags_agree_with_node() {
        let fx = library();
        for c in fx["jvm"]["clean"].as_array().unwrap() {
            match clean_jvm_flags(&c["input"]) {
                Ok(tokens) => assert_eq!(json!(tokens), c["value"], "{c}"),
                Err(e) => assert_eq!(e.message(), c["error"].as_str().unwrap_or("(no error)"), "{c}"),
            }
        }
        assert_eq!(
            json!(server_jvm_args("4G", &["-XX:+UseG1GC".to_string()], "paper.jar")),
            fx["jvm"]["args"]
        );
    }

    fn write(dir: &Path, value: Value) -> std::path::PathBuf {
        let file = dir.join("instances.json");
        std::fs::write(&file, value.to_string()).unwrap();
        file
    }

    #[test]
    fn names() {
        assert!(validate_name("Survival_1-a").is_ok());
        assert!(validate_name("-x").is_err());
        assert!(validate_name(&"a".repeat(33)).is_err());
        assert!(validate_name("../x").is_err());
    }

    #[test]
    fn reads_leniently() {
        let dir = std::env::temp_dir().join(format!("sl-reg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = write(
            &dir,
            json!({ "version": 1, "future": true, "instances": {
                "a": { "dir": "/srv/a", "jar": "server.jar", "memory": "2G", "port": 25565,
                       "rcon": { "port": 25575, "password": "pw" }, "autoRestart": true, "newField": [1] },
                "db": { "kind": "database", "engine": "garnet" }
            }}),
        );
        let a = get_instance(&file, "a").unwrap();
        assert_eq!(a.dir(), Some("/srv/a"));
        assert_eq!(a.java(), "java");
        assert_eq!(a.rcon_port(), Some(25575));
        assert_eq!(a.rcon_password().as_deref(), Some("pw"));
        assert!(a.auto_restart());
        assert!(!a.is_database());
        assert!(get_instance(&file, "db").unwrap().is_database());
        let missing = get_instance(&file, "zz").unwrap_err();
        assert!(missing.contains("Known instances: a, db"), "{missing}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn memory_and_flags() {
        assert_eq!(parse_memory_gb("4G").unwrap(), 4.0);
        assert_eq!(parse_memory_gb("6144M").unwrap(), 6.0);
        assert!(parse_memory_gb("lots").is_err());
        assert!(
            jvm_flags_for("4G")
                .unwrap()
                .contains(&"-XX:G1NewSizePercent=30".to_string())
        );
        assert!(
            jvm_flags_for("16G")
                .unwrap()
                .contains(&"-XX:G1HeapRegionSize=16M".to_string())
        );
    }
}
