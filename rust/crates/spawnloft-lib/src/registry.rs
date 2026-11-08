//! A read-only view of `instances.json`, lenient the way the R1 contract asks: every field is
//! optional and unknown fields are ignored, because daemons outlive updates and an old daemon
//! re-reads a newer registry on every crash restart. Nothing here writes the registry.

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::LazyLock;

use crate::js;

static NAME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z0-9][a-z0-9_-]{0,31}$").expect("name pattern"));

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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("could not read {}: {e}", registry_file.display())),
    };
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{} is not valid JSON: {e}", registry_file.display()))?;
    Ok(match data.get("instances") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    })
}

static MEMORY_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([0-9]+(?:\.[0-9]+)?)\s*([GgMm])$").expect("memory pattern"));

/// `parseMemoryGb`: `4G` is 4, `6144M` is 6.
pub fn parse_memory_gb(memory: &str) -> Result<f64, String> {
    let caps = MEMORY_RE
        .captures(memory.trim())
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
