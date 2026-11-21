//! What a version file asks a launcher to fetch and run, from client-meta.mjs: `mergeInherited`
//! (a loader profile over its game version), the library rows for this machine (`libraries`,
//! `classpathRows`, `libraryPath`), the natives and the arch the game runs as (`archDecision`),
//! Mojang's Log4Shell config (`loggingConfig`) and the asset index (`assetIndex`,
//! `assetLayout`, `assetObjects`).

use serde_json::{Map, Value, json};

use super::rules::{Os, rule_allows};
use super::{nullish, prop};
use crate::failure::Failure;
use crate::js;

pub const RESOURCES_URL: &str = "https://resources.download.minecraft.net";
const LIBRARIES_URL: &str = "https://libraries.minecraft.net/";

/// `String(x).slice(0, n)` in UTF-16 units.
pub(crate) fn cut(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            if used - n == 1 && c.len_utf16() == 2 {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
    }
    out
}

/// `name.split(':')` on a library's name, which throws for one that is not text.
fn name_text<'a>(name: Option<&'a Value>, var: &str) -> Result<&'a str, Failure> {
    match name {
        Some(Value::String(s)) => Ok(s),
        None => Err(Failure::type_error(
            "Cannot read properties of undefined (reading 'split')",
        )),
        Some(Value::Null) => Err(Failure::type_error(
            "Cannot read properties of null (reading 'split')",
        )),
        Some(_) => Err(Failure::type_error(format!("{var}.split is not a function"))),
    }
}

/// `[...(x ?? [])]` for a list in a version file.
fn items(v: Option<&Value>) -> Result<Vec<Value>, Failure> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(_) => Err(Failure::type_error(
            "object is not iterable (cannot read property Symbol(Symbol.iterator))",
        )),
    }
}

/// `mergeInherited(child, parent)`: the loader's profile over its game version. The child's
/// libraries go first (a newer copy a loader ships wins on the classpath), the argument lists
/// are joined parent first, and the child's legacy argument line wins whole.
pub fn merge_inherited(child: &Value, parent: &Value) -> Result<Value, Failure> {
    let mut result = Map::new();
    let empty = Map::new();
    let parent_map = parent.as_object().unwrap_or(&empty);
    let child_map = child.as_object().unwrap_or(&empty);
    for (k, v) in parent_map {
        if !matches!(
            k.as_str(),
            "libraries" | "arguments" | "minecraftArguments" | "mainClass"
        ) {
            result.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in child_map {
        if !matches!(
            k.as_str(),
            "libraries" | "arguments" | "mainClass" | "inheritsFrom"
        ) {
            result.insert(k.clone(), v.clone());
        }
    }
    result.shift_remove("inheritsFrom");
    // an empty logging block in a loader profile must not drop the parent's Log4Shell config
    let ours = prop(result.get("logging"), "client");
    let theirs = prop(prop(Some(parent), "logging"), "client");
    if !js::truthy(ours) && js::truthy(theirs) {
        result.insert(
            "logging".into(),
            prop(Some(parent), "logging").cloned().unwrap_or(Value::Null),
        );
    }
    if let Some(main) = prop(Some(child), "mainClass") {
        result.insert("mainClass".into(), main.clone());
    } else {
        result.shift_remove("mainClass");
    }
    let mut libs = items(prop(Some(child), "libraries"))?;
    libs.extend(items(prop(Some(parent), "libraries"))?);
    result.insert("libraries".into(), Value::Array(libs));

    let p_args = prop(Some(parent), "arguments");
    let c_args = prop(Some(child), "arguments");
    if js::truthy(p_args) || js::truthy(c_args) {
        let parent_game = match prop(p_args, "game") {
            v if !nullish(v) => items(v)?,
            _ => {
                let legacy = prop(Some(parent), "minecraftArguments");
                if js::truthy(legacy) {
                    match legacy {
                        Some(Value::String(s)) => s.split(' ').map(|p| json!(p)).collect(),
                        _ => {
                            return Err(Failure::type_error(
                                "parent.minecraftArguments.split is not a function",
                            ));
                        }
                    }
                } else {
                    Vec::new()
                }
            }
        };
        let mut game = parent_game;
        game.extend(items(prop(c_args, "game"))?);
        let mut jvm = items(prop(p_args, "jvm"))?;
        jvm.extend(items(prop(c_args, "jvm"))?);
        result.insert("arguments".into(), json!({ "game": game, "jvm": jvm }));
    }
    if let Some(m) = prop(Some(child), "minecraftArguments") {
        result.insert("minecraftArguments".into(), m.clone());
    } else if let Some(m) = prop(Some(parent), "minecraftArguments") {
        result.insert("minecraftArguments".into(), m.clone());
    }
    Ok(Value::Object(result))
}

/// `libraryKey(name)`: group:artifact, plus the classifier and a non-jar extension.
pub fn library_key(name: &Value) -> String {
    let text = js::string(Some(name));
    let (head, ext) = match text.find('@') {
        None => (text.as_str(), ""),
        Some(at) => (&text[..at], if &text[at..] == "@jar" { "" } else { &text[at..] }),
    };
    let parts: Vec<&str> = head.split(':').collect();
    let mut key: Vec<&str> = vec![parts[0], parts.get(1).copied().unwrap_or("undefined")];
    key.extend(parts.iter().skip(3));
    // [parts[0], parts[1]] with parts[1] missing joins as an empty cell
    let joined = if parts.len() < 2 {
        format!("{}:", parts[0])
    } else {
        key.join(":")
    };
    joined + ext
}

/// `libraryPath(name)`: the Maven path of `group:artifact:version[:classifier][@ext]`.
pub fn library_path(name: &str) -> Result<String, Failure> {
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts[0].replace('.', "/");
    let artifact = parts.get(1).copied().unwrap_or("undefined");
    let Some(mut version) = parts.get(2).copied() else {
        return Err(Failure::type_error(
            "Cannot read properties of undefined (reading 'indexOf')",
        ));
    };
    let mut classifier = parts.get(3).copied().unwrap_or("");
    let mut ext = "jar";
    if let Some(at) = version.find('@') {
        ext = &version[at + 1..];
        version = &version[..at];
    }
    if !classifier.is_empty()
        && let Some(at) = classifier.find('@')
    {
        ext = &classifier[at + 1..];
        classifier = &classifier[..at];
    }
    let cls = if classifier.is_empty() {
        String::new()
    } else {
        format!("-{classifier}")
    };
    Ok(format!(
        "{group}/{artifact}/{version}/{artifact}-{version}{cls}.{ext}"
    ))
}

/// `nativesClassifier(os)`: `natives-<os>` for x64, a suffix for the other arches, `None` when
/// Mojang names none for this arch.
pub fn natives_classifier(os: &Os) -> Option<String> {
    let base = format!("natives-{}", if os.name == "osx" { "macos" } else { &os.name });
    match os.arch.as_str() {
        "x64" => Some(base),
        "arm64" => Some(format!("{base}-arm64")),
        "x86" if os.name == "windows" => Some(format!("{base}-x86")),
        _ => None,
    }
}

fn classifier_of(name: &str) -> String {
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() >= 4 {
        parts[3].split('@').next().unwrap_or("").to_string()
    } else {
        String::new()
    }
}

/// `archMatch(classifier, os)`: for a natives classifier of this OS, whether it is this arch's;
/// `None` when it is not an arch build of this OS's natives.
fn arch_match(classifier: &str, os: &Os) -> Option<bool> {
    let base = format!("natives-{}", if os.name == "osx" { "macos" } else { &os.name });
    let suffix = classifier.strip_prefix(&base)?;
    let arch = match suffix {
        "" => "x64",
        "-arm64" => "arm64",
        "-x86" => "x86",
        // lwjgl-freetype's natives-macos-patch holds only the Intel Mac's files
        "-patch" if os.name == "osx" => "x64",
        _ => return None,
    };
    Some(arch == os.arch && natives_classifier(os).is_some())
}

fn os_label(name: &str) -> &str {
    match name {
        "windows" => "Windows",
        "osx" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

fn machine_refusal(os: &Os) -> Option<String> {
    if natives_classifier(os).is_none() || (os.name == "linux" && os.arch == "arm64") {
        return Some(format!(
            "the Minecraft client has no {} {} build; use bots on this machine",
            os_label(&os.name),
            os.arch
        ));
    }
    None
}

/// `nativeArches(version, os)`: the arches a version ships natives for on this OS.
pub fn native_arches(version: &Value, os: &Os) -> Result<Vec<String>, Failure> {
    let mut arches: Vec<String> = Vec::new();
    for arch in ["x64", "arm64", "x86"] {
        let as_arch = os.as_arch(arch);
        for lib in items(prop(Some(version), "libraries"))? {
            if !rule_allows(prop(Some(&lib), "rules"), &as_arch, &Map::new())? {
                continue;
            }
            let name = name_text(prop(Some(&lib), "name"), "name")?;
            let add = arch_match(&classifier_of(name), &as_arch) == Some(true)
                || (js::truthy(prop(prop(Some(&lib), "natives"), &os.name)) && arch != "arm64");
            if add && !arches.iter().any(|a| a == arch) {
                arches.push(arch.into());
            }
        }
    }
    Ok(arches)
}

/// `archDecision(version, os, hostCaps)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchDecision {
    pub refusal: Option<String>,
    pub arch: String,
    pub emulated: bool,
}

/// The arch this version runs as here: its own, or x64 under emulation when it has no arm64
/// natives and the machine runs x64 code (`host_x64`: `None` when that is not known).
pub fn arch_decision(
    version: Option<&Value>,
    os: &Os,
    host_x64: Option<bool>,
) -> Result<ArchDecision, Failure> {
    let native = ArchDecision {
        refusal: None,
        arch: os.arch.clone(),
        emulated: false,
    };
    if let Some(r) = machine_refusal(os) {
        return Ok(ArchDecision {
            refusal: Some(r),
            ..native
        });
    }
    let Some(version) = version.filter(|v| js::truthy(Some(v))) else {
        return Ok(native);
    };
    let arches = native_arches(version, os)?;
    if arches.is_empty() || arches.contains(&os.arch) {
        return Ok(native);
    }
    let id = match prop(Some(version), "id") {
        v if nullish(v) => "this version".to_string(),
        v => js::string(v),
    };
    if os.arch == "arm64"
        && arches.iter().any(|a| a == "x64")
        && let Some(x64) = host_x64
    {
        if x64 {
            return Ok(ArchDecision {
                refusal: None,
                arch: "x64".into(),
                emulated: true,
            });
        }
        if os.name == "osx" {
            return Ok(ArchDecision {
                refusal: Some(format!(
                    "Minecraft {id} has no Apple Silicon build; install Rosetta to run it: softwareupdate --install-rosetta --agree-to-license"
                )),
                ..native
            });
        }
        if os.name == "windows" {
            let build = os.version.split('.').nth(2).unwrap_or("?");
            return Ok(ArchDecision {
                refusal: Some(format!(
                    "Minecraft {id} has no Windows arm64 build, and Windows 10 arm64 (build {build}) cannot run the x64 one; Windows 11 can"
                )),
                ..native
            });
        }
    }
    Ok(ArchDecision {
        refusal: Some(format!(
            "{id} ships no {} {} natives; use a newer Minecraft version on this machine",
            os_label(&os.name),
            os.arch
        )),
        ..native
    })
}

/// `platformRefusal(version, os, hostCaps)`.
pub fn platform_refusal(
    version: Option<&Value>,
    os: &Os,
    host_x64: Option<bool>,
) -> Result<Option<String>, Failure> {
    Ok(arch_decision(version, os, host_x64)?.refusal)
}

/// One library row for this machine.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub name: String,
    pub path: String,
    /// `None` for a file the loader's installer makes (an empty URL).
    pub url: Option<Value>,
    pub sha1: Value,
    pub size: Value,
    /// The extract excludes of a natives row; `None` for a classpath row.
    pub native: Option<Value>,
}

/// `libraryRelPath(name, p)`: a library's path must stay inside the libraries folder.
fn library_rel_path(name: &Value, p: &Value) -> Result<String, Failure> {
    let safe = match p {
        Value::String(s) => crate::util::safe_relative_path(s),
        _ => None,
    };
    safe.ok_or_else(|| {
        Failure::user(format!(
            "library {} names the path \"{}\", which leaves the libraries folder",
            cut(&js::string(Some(name)), 80),
            cut(&js::string(Some(p)), 80)
        ))
    })
}

/// `(lib.url ?? base) + p`.
fn base_plus(lib_url: Option<&Value>, p: &str) -> Value {
    let base = match lib_url {
        v if nullish(v) => LIBRARIES_URL.to_string(),
        v => js::string(v),
    };
    Value::String(base + p)
}

/// `libraries(version, { os })`: the rows to fetch, put on the classpath and extract here. Only
/// the natives of this arch are taken; the rows of the other arches are left out altogether.
pub fn libraries(version: &Value, os: &Os) -> Result<Vec<Row>, Failure> {
    let mut rows = Vec::new();
    for lib in items(prop(Some(version), "libraries"))? {
        let lib = &lib;
        if !rule_allows(prop(Some(lib), "rules"), os, &Map::new())? {
            continue;
        }
        let name_v = prop(Some(lib), "name").cloned().unwrap_or(Value::Null);
        let dl = prop(Some(lib), "downloads");
        let artifact = prop(dl, "artifact");
        let p = match prop(artifact, "path") {
            v if !nullish(v) => library_rel_path(&name_v, v.unwrap_or(&Value::Null))?,
            _ => {
                let made = library_path(name_text(Some(&name_v), "name")?)?;
                library_rel_path(&name_v, &Value::String(made))?
            }
        };
        let lib_url = prop(Some(lib), "url");
        let given = match prop(artifact, "url") {
            v if !nullish(v) => v.cloned().unwrap_or(Value::Null),
            _ if matches!(lib_url, Some(Value::String(s)) if s.is_empty()) => json!(""),
            _ => base_plus(lib_url, &p),
        };
        let url = if matches!(&given, Value::String(s) if s.is_empty()) {
            None
        } else {
            Some(given)
        };
        let pick = |a: &str| match prop(artifact, a) {
            v if !nullish(v) => v.cloned().unwrap_or(Value::Null),
            _ => super::or_null(prop(Some(lib), a)),
        };
        let (sha1, size) = (pick("sha1"), pick("size"));
        let name = name_text(Some(&name_v), "name")?.to_string();

        let classifier = classifier_of(&name);
        let arch = arch_match(&classifier, os);
        if arch == Some(false) {
            continue;
        }
        // Mojang names the macOS natives "natives-macos", not "natives-osx" as the rules do
        let native_os = if os.name == "osx" { "macos" } else { &os.name };
        if arch == Some(true) || classifier.starts_with(&format!("natives-{native_os}")) {
            rows.push(Row {
                name,
                path: p,
                url,
                sha1,
                size,
                native: Some(json!([])),
            });
            continue;
        }

        // before 1.13 the natives rows carry classifiers only: no plain jar to put on the path
        if !js::truthy(dl) || js::truthy(artifact) {
            rows.push(Row {
                name: name.clone(),
                path: p.clone(),
                url,
                sha1,
                size,
                native: None,
            });
        }

        let natives_key = prop(prop(Some(lib), "natives"), &os.name);
        if js::truthy(natives_key) {
            let Some(Value::String(key)) = natives_key else {
                return Err(Failure::type_error("nativesKey.replace is not a function"));
            };
            let arch_num = if os.arch == "x86" { "32" } else { "64" };
            let resolved = key.replacen("${arch}", arch_num, 1);
            let cls = prop(prop(dl, "classifiers"), &resolved);
            if js::truthy(cls) {
                let cls_path = match prop(cls, "path") {
                    v if !nullish(v) => library_rel_path(&name_v, v.unwrap_or(&Value::Null))?,
                    _ => library_rel_path(
                        &name_v,
                        &Value::String(library_path(&format!("{name}:{resolved}"))?),
                    )?,
                };
                let cls_url = prop(cls, "url");
                let lib_url_empty = matches!(lib_url, Some(Value::String(s)) if s.is_empty());
                let url = if matches!(cls_url, Some(Value::String(s)) if s.is_empty())
                    || (cls_url.is_none() && lib_url_empty)
                {
                    None
                } else {
                    Some(match cls_url {
                        v if !nullish(v) => v.cloned().unwrap_or(Value::Null),
                        _ => base_plus(lib_url, &cls_path),
                    })
                };
                let exclude = match prop(prop(Some(lib), "extract"), "exclude") {
                    v if !nullish(v) => v.cloned().unwrap_or(Value::Null),
                    _ => json!([]),
                };
                rows.push(Row {
                    name: format!("{name}:{resolved}"),
                    path: cls_path,
                    url,
                    sha1: super::or_null(prop(cls, "sha1")),
                    size: super::or_null(prop(cls, "size")),
                    native: Some(exclude),
                });
            }
        }
    }
    Ok(rows)
}

/// `classpathRows(rows)`: the classpath rows, one per library key and per path, the first kept.
pub fn classpath_rows(rows: &[Row]) -> Vec<Row> {
    let mut keys = Vec::new();
    let mut paths = Vec::new();
    let mut out = Vec::new();
    for row in rows.iter().filter(|r| r.native.is_none()) {
        let key = library_key(&Value::String(row.name.clone()));
        if keys.contains(&key) || paths.contains(&row.path) {
            continue;
        }
        keys.push(key);
        paths.push(row.path.clone());
        out.push(row.clone());
    }
    out
}

/// `loggingConfig(version)`: Mojang's log4j config without lookups.
#[derive(Debug, Clone, PartialEq)]
pub struct LoggingConfig {
    pub id: String,
    pub url: String,
    pub sha1: String,
    pub size: Option<f64>,
    pub argument: String,
}

fn is_hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `loggingConfig(version)`: `None` when the version names none; a config SpawnLoft cannot
/// trust stops the launch.
pub fn logging_config(version: &Value) -> Result<Option<LoggingConfig>, Failure> {
    let client = prop(prop(Some(version), "logging"), "client");
    if !js::truthy(client) {
        return Ok(None);
    }
    let id = match prop(Some(version), "id") {
        v if nullish(v) => "this version".to_string(),
        v => js::string(v),
    };
    let bad = |what: String| {
        Failure::user(format!(
            "the logging config of {id} {what}; SpawnLoft cannot launch it safely"
        ))
    };
    if !matches!(prop(client, "type"), Some(Value::String(t)) if t == "log4j2-xml") {
        return Err(bad(format!(
            "has the unknown type \"{}\"",
            js::string(prop(client, "type"))
        )));
    }
    const ARG: &str = "-Dlog4j.configurationFile=${path}";
    if !matches!(prop(client, "argument"), Some(Value::String(a)) if a == ARG) {
        return Err(bad(format!(
            "has the unknown argument \"{}\"",
            js::string(prop(client, "argument"))
        )));
    }
    let file = prop(client, "file");
    let file_id = match prop(file, "id") {
        Some(Value::String(s))
            if js::truthy(file)
                && !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
                && !s.bytes().all(|b| b == b'.') =>
        {
            s.clone()
        }
        _ => return Err(bad("names a file outside log_configs".into())),
    };
    let Some(Value::String(sha1)) =
        prop(file, "sha1").filter(|v| matches!(v, Value::String(s) if is_hex40(s)))
    else {
        return Err(bad("has no sha1 to check the file against".into()));
    };
    let Some(Value::String(url)) =
        prop(file, "url").filter(|v| matches!(v, Value::String(s) if s.starts_with("https://")))
    else {
        return Err(bad("has no https URL".into()));
    };
    let size = match prop(file, "size") {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()),
        _ => None,
    };
    Ok(Some(LoggingConfig {
        id: file_id,
        url: url.clone(),
        sha1: sha1.to_lowercase(),
        size,
        argument: ARG.into(),
    }))
}

/// `log4jNoLookupsNeeded(version)`: log4j-core 2.0 to 2.15 is listed.
pub fn log4j_no_lookups_needed(version: &Value) -> Result<bool, Failure> {
    for lib in items(prop(Some(version), "libraries"))? {
        let name = match prop(Some(&lib), "name") {
            v if nullish(v) => String::new(),
            v => js::string(v),
        };
        let parts: Vec<&str> = name.split(':').collect();
        if parts[0] != "org.apache.logging.log4j" || parts.get(1) != Some(&"log4j-core") {
            continue;
        }
        let v = parts.get(2).copied().unwrap_or("");
        let mut it = v.split('.');
        let major = it
            .next()
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        let minor = it
            .next()
            .map(|s| s.bytes().take_while(u8::is_ascii_digit).collect::<Vec<_>>());
        if let (Some(major), Some(minor)) = (major, minor)
            && !minor.is_empty()
        {
            let major = js::string_to_number(major);
            let minor = js::string_to_number(std::str::from_utf8(&minor).unwrap_or(""));
            if major == 2.0 && minor < 16.0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `assetIndex(version)`: the index's id must be one plain path segment.
pub fn asset_index(version: &Value) -> Result<Value, Failure> {
    let ai = prop(Some(version), "assetIndex");
    let id = prop(ai, "id");
    let text = js::string(id);
    let plain = {
        let b = text.as_bytes();
        !b.is_empty()
            && b[0].is_ascii_alphanumeric()
            && text.chars().count() <= 64
            && b.iter()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    };
    if plain {
        match (ai, id) {
            (None, _) => {
                return Err(Failure::type_error(
                    "Cannot read properties of undefined (reading 'id')",
                ));
            }
            (Some(Value::Null), _) => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'id')",
                ));
            }
            (_, Some(Value::String(s))) if !s.contains("..") => {
                return Ok(super::object(vec![
                    ("id", Some(json!(s))),
                    ("url", prop(ai, "url").cloned()),
                    ("sha1", prop(ai, "sha1").cloned()),
                    ("size", prop(ai, "size").cloned()),
                    ("totalSize", prop(ai, "totalSize").cloned()),
                ]));
            }
            (_, Some(Value::String(_))) => {}
            _ => return Err(Failure::type_error("ai.id.includes is not a function")),
        }
    }
    let of = match prop(Some(version), "id") {
        v if nullish(v) => "this version".to_string(),
        v => js::string(v),
    };
    Err(Failure::user(format!(
        "the asset index of {of} has the id \"{}\", which is not a plain name",
        cut(&text, 64)
    )))
}

/// How an asset index lays out its files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetLayout {
    /// 1.7.3 on: the game reads the hashed store itself.
    Objects,
    /// 1.6.1 to 1.7.2: a tree under real names in assets/virtual/<index>.
    Virtual,
    /// Before 1.6: a tree in the profile's resources/.
    Resources,
}

/// `assetLayout(index)`: `None` for an index with a key SpawnLoft does not know.
pub fn asset_layout(index: &Value) -> Option<AssetLayout> {
    let Value::Object(m) = index else { return None };
    let objects = m.get("objects");
    if !js::truthy(objects) || !matches!(objects, Some(Value::Object(_) | Value::Array(_))) {
        return None;
    }
    if m.keys()
        .any(|k| !matches!(k.as_str(), "objects" | "virtual" | "map_to_resources"))
    {
        return None;
    }
    if m.get("map_to_resources") == Some(&Value::Bool(true)) {
        return Some(AssetLayout::Resources);
    }
    if m.get("virtual") == Some(&Value::Bool(true)) {
        return Some(AssetLayout::Virtual);
    }
    Some(AssetLayout::Objects)
}

/// One asset to fetch.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub name: String,
    pub hash: String,
    pub size: Value,
    pub path: String,
    pub url: String,
}

/// `assetObjects(index)`: the files of the index, each under its hash.
pub fn asset_objects(index: &Value) -> Result<Vec<Asset>, Failure> {
    let mut rows = Vec::new();
    let entries: Vec<(String, Value)> = match prop(Some(index), "objects") {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    for (name, entry) in entries {
        let hash = js::string(prop(Some(&entry), "hash"));
        if !(hash.len() == 40
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        {
            return Err(Failure::user(format!(
                "the asset index names \"{}\" with a malformed hash",
                cut(&name, 60)
            )));
        }
        rows.push(Asset {
            name,
            size: super::or_null(prop(Some(&entry), "size")),
            path: format!("objects/{}/{hash}", &hash[..2]),
            url: format!("{RESOURCES_URL}/{}/{hash}", &hash[..2]),
            hash,
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version() -> Value {
        crate::jsjson::parse(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../test/fixtures/client/1.21.11.json"
            ))
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn library_paths_and_keys() {
        assert_eq!(
            library_path("org.lwjgl:lwjgl:3.3.3:natives-linux").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar"
        );
        assert_eq!(library_path("a.b:c:1@zip").unwrap(), "a/b/c/1/c-1.zip");
        assert!(library_path("a:b").is_err());
        assert_eq!(
            library_key(&json!("a:b:1:natives-linux@jar")),
            "a:b:natives-linux"
        );
        assert_eq!(library_key(&json!("a:b:1@zip")), "a:b@zip");
    }

    #[test]
    fn the_fixture_has_one_natives_build_per_arch() {
        let v = version();
        for (os, arch) in [
            ("linux", "x64"),
            ("windows", "arm64"),
            ("osx", "arm64"),
            ("osx", "x64"),
        ] {
            let os = Os::new(os, arch, "1");
            let rows = libraries(&v, &os).unwrap();
            assert!(!rows.is_empty());
            assert!(classpath_rows(&rows).iter().all(|r| r.native.is_none()));
        }
        let d = arch_decision(Some(&v), &Os::new("linux", "arm64", "6"), None).unwrap();
        assert!(d.refusal.unwrap().contains("no Linux arm64 build"));
    }

    #[test]
    fn merge_keeps_the_parents_logging_and_the_childs_legacy_line() {
        let parent = json!({ "id": "1.12.2", "logging": { "client": { "x": 1 } }, "minecraftArguments": "--a b", "mainClass": "P", "libraries": [1] });
        let child = json!({ "id": "forge", "inheritsFrom": "1.12.2", "logging": {}, "minecraftArguments": "--a b --tweakClass t", "mainClass": "C", "libraries": [2] });
        let m = merge_inherited(&child, &parent).unwrap();
        assert_eq!(
            crate::jsjson::stringify(&m),
            r#"{"id":"forge","logging":{"client":{"x":1}},"minecraftArguments":"--a b --tweakClass t","mainClass":"C","libraries":[2,1]}"#
        );
    }

    #[test]
    fn asset_checks() {
        assert!(asset_index(&json!({ "assetIndex": { "id": "../x" } })).is_err());
        assert_eq!(
            asset_index(&json!({ "assetIndex": { "id": "29" } })).unwrap(),
            json!({ "id": "29" })
        );
        assert_eq!(
            asset_layout(&json!({ "objects": {}, "virtual": true })),
            Some(AssetLayout::Virtual)
        );
        assert_eq!(asset_layout(&json!({ "objects": {}, "x": 1 })), None);
        let a = asset_objects(&json!({ "objects": { "a/b.png": { "hash": "0123456789abcdef0123456789abcdef01234567", "size": 3 } } })).unwrap();
        assert_eq!(a[0].path, "objects/01/0123456789abcdef0123456789abcdef01234567");
        assert!(asset_objects(&json!({ "objects": { "x": { "hash": "AB" } } })).is_err());
    }
}

/// The same dump as a Node script makes of client-meta.mjs over every fixture, for comparing
/// the two by hand (tools/parity/client-meta-dump.mjs is the Node side):
/// `META_DUMP=<file> cargo test -p spawnloft-lib meta_dump -- --ignored`.
#[cfg(test)]
mod dump {
    use super::super::rules::{self, Os};
    use super::*;

    fn tryit(f: impl FnOnce() -> Result<Value, Failure>) -> Value {
        match f() {
            Ok(v) => v,
            Err(Failure::User { message, .. })
            | Err(Failure::Internal { message, .. })
            | Err(Failure::Usage(message)) => json!({ "error": message }),
        }
    }

    fn row(r: &Row) -> Value {
        json!([
            r.name,
            r.path,
            r.url.clone().unwrap_or(Value::Null),
            r.sha1,
            r.size,
            r.native.clone().unwrap_or(Value::Null)
        ])
    }

    #[test]
    #[ignore]
    fn meta_dump() {
        let Ok(dest) = std::env::var("META_DUMP") else {
            return;
        };
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures/client/");
        let mut files: Vec<String> = std::fs::read_dir(format!("{dir}versions"))
            .unwrap()
            .map(|e| format!("versions/{}", e.unwrap().file_name().to_string_lossy()))
            .collect();
        files.sort();
        files.extend([
            "1.21.11.json".to_string(),
            "future.json".into(),
            "fabric-profile.json".into(),
        ]);
        let read =
            |f: &str| crate::jsjson::parse(&std::fs::read_to_string(format!("{dir}{f}")).unwrap()).unwrap();
        let oses = [
            ("linux", "x64", "6.8.0-45-generic"),
            ("linux", "arm64", "6.8.0"),
            ("windows", "x64", "10.0.22631"),
            ("windows", "x64", "10.0.17000"),
            ("windows", "arm64", "10.0.22631"),
            ("windows", "x86", "10.0.19045"),
            ("osx", "arm64", "24.1.0"),
            ("osx", "x64", "23.0.0"),
        ];
        let mut out = Vec::new();
        let mut feat = Map::new();
        feat.insert("has_custom_resolution".into(), json!(true));
        for f in &files {
            let mut v = read(f);
            if f == "fabric-profile.json" {
                v = merge_inherited(&v, &read("versions/1.21.11.json")).unwrap();
            }
            for (name, arch, version) in oses {
                let os = Os::new(name, arch, version);
                let dec = |x: Option<bool>| {
                    tryit(|| {
                        let d = arch_decision(Some(&v), &os, x)?;
                        Ok(json!([d.refusal, d.arch, d.emulated]))
                    })
                };
                out.push(json!({ "f": f, "os": { "name": name, "arch": arch, "version": version },
                    "libs": tryit(|| Ok(Value::Array(libraries(&v, &os)?.iter().map(row).collect()))),
                    "cp": tryit(|| Ok(Value::Array(classpath_rows(&libraries(&v, &os)?).iter().map(|r| json!(r.path)).collect()))),
                    "arch": dec(None), "archE": dec(Some(true)), "archN": dec(Some(false)),
                    "game": tryit(|| Ok(Value::Array(rules::game_arguments(&v, &os, &feat)?))),
                    "jvm": tryit(|| Ok(Value::Array(rules::jvm_arguments(&v, &os, &Map::new())?))),
                    "sub": tryit(|| Ok(json!(rules::natives_library_subdir(&v, &os)?))),
                    "extra": tryit(|| Ok(json!(rules::natives_extra_dirs(&v, &os)?))),
                    "res": tryit(|| {
                        let r = super::super::version::resolve_version(&v, &os, &super::super::version::launch_features(true), Some(true), super::super::version::LAUNCHER_FORMAT)?;
                        let probs: Vec<Value> = r.problems.iter().map(|p| json!({ "code": p.code, "message": p.message })).collect();
                        let j = &r.java;
                        let refusal = match super::super::version::resolved_refusal(&r) { Some(Failure::User { message, code }) => json!({ "code": code, "message": message }), _ => Value::Null };
                        Ok(json!([probs, { "major": crate::jsjson::num(j.major), "component": j.component, "min": crate::jsjson::num(j.min), "max": j.max.map_or(Value::Null, crate::jsjson::num), "prefer": crate::jsjson::num(j.prefer) },
                            { "name": r.os.name, "arch": r.os.arch, "version": r.os.version }, r.emulated, r.variables, r.natives_stamp, r.natives_dir,
                            { "minimumLauncherVersion": r.minimum_launcher_version.map_or(Value::Null, crate::jsjson::num), "ok": r.format_ok }, r.kind, r.client_jar, refusal]))
                    }),
                    "problems": tryit(|| { let mut p = Vec::new(); for l in items(prop(Some(&v), "libraries"))? { p.extend(rules::rule_problems(prop(Some(&l), "rules"), &os)?); } Ok(json!(p)) }),
                }));
            }
            out.push(json!({ "f": f,
                "log": tryit(|| Ok(match logging_config(&v)? { None => Value::Null, Some(c) => super::super::object(vec![("id", Some(json!(c.id))), ("url", Some(json!(c.url))), ("sha1", Some(json!(c.sha1))), ("size", Some(c.size.map_or(Value::Null, crate::jsjson::num))), ("argument", Some(json!(c.argument)))]) })),
                "nolookups": tryit(|| Ok(json!(log4j_no_lookups_needed(&v)?))),
                "ai": tryit(|| asset_index(&v)) }));
        }
        let mut assets: Vec<String> = std::fs::read_dir(format!("{dir}assets"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assets.sort();
        for a in assets {
            let idx = read(&format!("assets/{a}"));
            let layout = match asset_layout(&idx) {
                None => Value::Null,
                Some(AssetLayout::Objects) => json!("objects"),
                Some(AssetLayout::Virtual) => json!("virtual"),
                Some(AssetLayout::Resources) => json!("resources"),
            };
            out.push(json!({ "a": a, "layout": layout, "objs": tryit(|| Ok(Value::Array(asset_objects(&idx)?.iter().map(|r| json!([r.hash, r.size, r.path, r.url])).collect()))) }));
        }
        std::fs::write(dest, crate::jsjson::stringify(&Value::Array(out))).unwrap();
    }
}
