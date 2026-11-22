//! The installer engine for NeoForge and modern Forge (`client-forge-install.mjs`), and Forge's
//! older installer read into the same shape (`client-forge-legacy.mjs`).
//!
//! The jar holds version.json (the loader's version file, inheriting from vanilla) and
//! install_profile.json (extra libraries, a data table and the build steps, "processors"). A
//! first Play:
//!   1. downloads the installer to client/cache/installers/ and checks it against the maven's
//!      .sha1 ([`fetch_installer`]), reads both files out of it and refuses one this SpawnLoft
//!      does not know ([`read_installer`]), and writes version.json under versions/<id>/
//!      ([`write_version_file`]);
//!   2. then, with the game's Java picked and the vanilla game downloaded ([`run_installer`]):
//!      downloads the profile's libraries, checked by SHA-1, and takes the ones that ship inside
//!      the installer (maven/...) out of it;
//!   3. resolves the data table: [group:name:version] is a path in the libraries folder, 'text'
//!      a literal, /data/... a file taken out of the installer;
//!   4. runs each client-side build step as a child of that Java, with an argument list and no
//!      shell, skipping a step whose outputs are already there;
//!   5. writes a stamp last. A loader counts as set up only with its stamp, and only while the
//!      files the stamp lists still match it.
//!
//! A step that fails or is cancelled leaves the finished steps in place: the next Play carries
//! on. One lock per Minecraft version keeps two setups from building the same files at once.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::fabric::assert_loader_host;
use super::install::{self, Ledger};
use super::paths::Paths;
use super::prop;
use crate::failure::Failure;
use crate::util::{is_inside, safe_relative_path};
use crate::{cancel, js, jsjson, jspath};

/// The install_profile.json formats this engine knows: 0 (Forge 1.13 to 1.17) and 1 (since).
pub const KNOWN_SPECS: [f64; 2] = [0.0, 1.0];
const STAMP_FORMAT: f64 = 1.0;
const STAMP: &str = ".loader-installed.json";
/// A second setup waits for the first one's build steps, for up to this long.
const LOCK_WAIT: Duration = Duration::from_secs(30 * 60);
const TAIL_LINES: usize = 8;

fn user(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

pub(crate) fn code_of(e: &Failure) -> Option<&str> {
    match e {
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.as_deref(),
        Failure::Usage(_) => None,
    }
}

/// `String(v).slice(0, n)`, counted in UTF-16 units as JavaScript does.
pub(crate) fn cut(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn is_sha1(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn sha1_hex(data: &[u8]) -> String {
    use sha1::Digest;
    sha1::Sha1::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn sha1_of_file(file: &str) -> Result<String, Failure> {
    install::sha1_of_file(Path::new(file)).map_err(|e| Failure::read(&e, Path::new(file)))
}

pub fn installers_dir(paths: &Paths) -> String {
    jspath::join(&[&paths.cache_dir(), "installers"])
}

fn steps_dir(paths: &Paths) -> String {
    jspath::join(&[&paths.cache_dir(), "loader-steps"])
}

pub fn stamp_file(paths: &Paths, id: &str) -> String {
    jspath::join(&[&paths.version_dir(id), STAMP])
}

fn steps_file(paths: &Paths, mc: &str) -> String {
    jspath::join(&[&steps_dir(paths), &format!("{mc}.json")])
}

/// Through a temp file, as `writeJsonAtomic` does.
fn write_json_atomic(file: &str, data: &Value) -> Result<(), Failure> {
    let dir = jspath::dirname(file);
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&dir))))?;
    super::write_atomic(file, jsjson::stringify_pretty(data).as_bytes())
}

/// `readJson(file)` of this module: anything wrong reads as null.
fn read_json(file: &str) -> Option<Value> {
    let bytes = std::fs::read(file).ok()?;
    jsjson::parse(&String::from_utf8_lossy(&bytes)).ok()
}

fn file_row(v: &Value) -> bool {
    match v {
        Value::Array(a) if a.len() == 2 => {
            let size_ok = match &a[0] {
                Value::Null => true,
                Value::Number(n) => n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite()),
                _ => false,
            };
            size_ok && is_sha1(Some(&a[1]))
        }
        _ => false,
    }
}

fn ledger_key(paths: &Paths, file: &str) -> String {
    install::ledger_key(paths, file)
}

/// `artifactPath(name)`: a library's place in the libraries folder, from its maven name; None
/// for a name that would leave the folder or is no maven name at all.
pub fn artifact_path(name: Option<&Value>) -> Option<String> {
    let Some(Value::String(name)) = name else {
        return None;
    };
    if name.split(':').count() < 3 || js_len(name) > 300 {
        return None;
    }
    let p = super::library::library_path(name).ok()?;
    let rel = safe_relative_path(&p)?;
    (rel == p).then_some(rel)
}

fn artifact_file(paths: &Paths, name: &str, what: &str) -> Result<String, Failure> {
    match artifact_path(Some(&json!(name))) {
        Some(rel) => Ok(jspath::join(&[&paths.libraries_dir(), &rel])),
        None => Err(coded(
            format!(
                "{what} names a library \"{}\" SpawnLoft cannot place in its libraries folder; update SpawnLoft, or pick another build",
                cut(name, 80)
            ),
            "loader-installer-unknown",
        )),
    }
}

/// `readZipEntry(jar, entry)`.
fn zip_entry(jar: &str, entry: &str) -> Result<Option<Vec<u8>>, Failure> {
    crate::zip::jar::read_entry(Path::new(jar), entry)
}

// ---- 1. the installer --------------------------------------------------------------------

/// How a library or installer is fetched: `downloadFile(url, dest, { hash: 'sha1', expected,
/// label })`.
pub type Fetch<'a> = install::Fetch<'a>;
/// How a maven's checksum is read: `publishedSha1(url)`.
pub type FetchSha1<'a> = super::fabric::FetchSha1<'a>;

/// `publishedSha1(url)`: the checksum the maven publishes beside a file.
pub fn published_sha1(url: &str) -> Result<String, Failure> {
    let file = url.rsplit('/').next().unwrap_or("");
    let body = crate::download::fetch_capped(
        &format!("{url}.sha1"),
        1024,
        Duration::from_secs(10),
        2,
        Duration::from_millis(1500),
        &format!("the checksum of {file}"),
    )?;
    let text = String::from_utf8_lossy(&body);
    let t = js::trim(&text);
    let hex: String = t.chars().take(40).collect();
    let ends = t
        .chars()
        .nth(40)
        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
    if hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && ends {
        return Ok(hex.to_ascii_lowercase());
    }
    Err(user(format!("the checksum published for {file} is not a sha1")))
}

/// An installer in the cache.
#[derive(Debug, Clone)]
pub struct Installer {
    pub path: String,
    pub sha1: String,
    pub cached: bool,
}

/// `fetchInstaller(url, { name, label, stage })`: the installer jar in the cache, downloaded
/// once and checked against the checksum its maven publishes. A cached jar is checked again
/// against the sum it passed then.
pub fn fetch_installer(
    paths: &Paths,
    url: &str,
    name: &str,
    label: &str,
    fetch: Fetch<'_>,
    sha1: FetchSha1<'_>,
    on_stage: &mut dyn FnMut(&str),
) -> Result<Installer, Failure> {
    assert_loader_host(url, label)?;
    let name_ok = name.len() > 4
        && name.ends_with(".jar")
        && name[..name.len() - 4]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        && !name.contains("..");
    if !name_ok {
        return Err(user(format!(
            "the installer name \"{}\" is not one SpawnLoft can use",
            cut(name, 80)
        )));
    }
    let dir = installers_dir(paths);
    let dest = jspath::join(&[&dir, name]);
    let sum_file = format!("{dest}.sha1");
    if let Ok(text) = std::fs::read(&sum_file) {
        let want = js::trim(&String::from_utf8_lossy(&text)).to_string();
        if is_sha1(Some(&json!(want)))
            && install::sha1_of_file(Path::new(&dest)).ok().as_deref() == Some(want.as_str())
        {
            return Ok(Installer {
                path: dest,
                sha1: want,
                cached: true,
            });
        }
    }
    cancel::check_cancelled()?;
    on_stage(&format!("Downloading the {label}"));
    let want = sha1(url)?;
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&dir))))?;
    super::rm_force(&sum_file)?;
    if let Err(err) = fetch(url, Path::new(&dest), Some(&want), &format!("the {label}")) {
        if cancel::is_cancelled(&err) {
            return Err(err);
        }
        return Err(coded(
            format!("could not download the {label} from {url}: {}", err.message()),
            code_of(&err).unwrap_or("download-failed"),
        ));
    }
    std::fs::write(&sum_file, &want).map_err(|e| Failure::io(&e, "open", Some(Path::new(&sum_file))))?;
    Ok(Installer {
        path: dest,
        sha1: want,
        cached: false,
    })
}

/// What [`read_installer`] reads: the profile and version file, and (for Forge's older
/// installer) the library rows still to get a checksum.
#[derive(Debug, Clone)]
pub struct Contents {
    pub profile: Value,
    pub version: Value,
    pub pending: Vec<Pending>,
}

/// A library row of an older installer still without a checksum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub index: usize,
    pub url: String,
    pub sums: Vec<String>,
}

fn unknown(who: &str, why: &str, older: bool) -> Failure {
    let pick = if older { "an older" } else { "another" };
    coded(
        format!(
            "This {who} build needs a newer SpawnLoft ({why}). Update SpawnLoft, or pick {pick} {who} build in Advanced."
        ),
        "loader-installer-unknown",
    )
}

/// `readInstaller(jar, { mc, id, who, legacy })`: install_profile.json and version.json out of
/// the jar, refused unless this engine knows them and they are for this game version and id.
pub fn read_installer(jar: &str, mc: &str, id: &str, who: &str, legacy: bool) -> Result<Contents, Failure> {
    let read = || -> Result<(Value, Value), Failure> {
        let parse = |b: Option<Vec<u8>>| -> Result<Value, Failure> {
            match b {
                Some(b) => jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax),
                None => Ok(Value::Null),
            }
        };
        let profile = parse(zip_entry(jar, "install_profile.json")?)?;
        let name = match prop(Some(&profile), "json") {
            Some(Value::String(s)) => s.strip_prefix('/').unwrap_or(s).to_string(),
            _ => "version.json".into(),
        };
        let version = parse(zip_entry(jar, &name)?)?;
        Ok((profile, version))
    };
    let Ok((profile, version)) = read() else {
        return Err(unknown(who, "its installer could not be read", true));
    };
    if !matches!(profile, Value::Object(_) | Value::Array(_)) {
        return Err(unknown(who, "no install_profile.json", true));
    }
    if is_legacy_profile(&profile) {
        if !legacy {
            return Err(unknown(who, "the old installer format", true));
        }
        return convert_legacy(&profile, mc, id, jar, who);
    }
    let spec = match prop(Some(&profile), "spec") {
        None | Some(Value::Null) => json!(0),
        Some(v) => v.clone(),
    };
    if !spec.as_f64().is_some_and(|s| KNOWN_SPECS.contains(&s)) {
        return Err(unknown(
            who,
            &format!(
                "installer format {}",
                cut(&js::string(prop(Some(&profile), "spec")), 10)
            ),
            true,
        ));
    }
    let data = prop(Some(&profile), "data");
    let data_bad = match data {
        None | Some(Value::Null) => false,
        Some(Value::Object(_) | Value::Array(_)) => false,
        Some(_) => true,
    };
    if !matches!(prop(Some(&profile), "processors"), Some(Value::Array(_)))
        || !matches!(prop(Some(&profile), "libraries"), Some(Value::Array(_)))
        || data_bad
    {
        return Err(unknown(who, "an installer profile SpawnLoft does not know", true));
    }
    if !matches!(version, Value::Object(_) | Value::Array(_)) {
        return Err(unknown(who, "no version file", true));
    }
    let minecraft = prop(Some(&profile), "minecraft");
    if minecraft != Some(&json!(mc)) {
        return Err(coded(
            format!(
                "The {who} installer is for Minecraft {}, not {mc}; pick another {who} build in Advanced.",
                cut(&js::string(minecraft), 40)
            ),
            "loader-installer-unknown",
        ));
    }
    let vid = prop(Some(&version), "id");
    let vid_ok = matches!(vid, Some(Value::String(v)) if v == id && super::version::is_safe_version_id(v));
    if !vid_ok {
        return Err(coded(
            format!(
                "The {who} installer names its version \"{}\", not {id}; pick another {who} build in Advanced.",
                cut(&js::string(vid), 60)
            ),
            "loader-installer-unknown",
        ));
    }
    let parent = prop(Some(&version), "inheritsFrom");
    if parent != Some(&json!(mc)) {
        return Err(coded(
            format!(
                "The {who} installer's version inherits from {}, not Minecraft {mc}; pick another {who} build in Advanced.",
                cut(&js::string(parent), 40)
            ),
            "loader-installer-unknown",
        ));
    }
    Ok(Contents {
        profile,
        version,
        pending: Vec::new(),
    })
}

/// `writeVersionFile(id, version)`: versions/<id>/<id>.json, as the installer has it, unless the
/// same file is there already.
pub fn write_version_file(paths: &Paths, id: &str, version: &Value) -> Result<bool, Failure> {
    let dest = paths.version_json(id);
    let text = jsjson::stringify_pretty(version);
    if std::fs::read(&dest).is_ok_and(|b| b == text.as_bytes()) {
        return Ok(false);
    }
    let dir = paths.version_dir(id);
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&dir))))?;
    super::write_atomic(&dest, text.as_bytes())?;
    Ok(true)
}

// ---- the stamp ---------------------------------------------------------------------------

pub fn is_stamped(paths: &Paths, id: &str) -> bool {
    read_json(&stamp_file(paths, id))
        .is_some_and(|s| prop(Some(&s), "format").and_then(Value::as_f64) == Some(STAMP_FORMAT))
}

/// `stampHolds(id, ledger)`: whether every file the stamp lists still matches it.
fn stamp_holds(paths: &Paths, id: &str, ledger: &Mutex<Ledger>) -> bool {
    let Some(stamp) = read_json(&stamp_file(paths, id)) else {
        return false;
    };
    if prop(Some(&stamp), "format").and_then(Value::as_f64) != Some(STAMP_FORMAT) {
        return false;
    }
    files_still_match(paths, prop(Some(&stamp), "files"), ledger)
}

fn files_still_match(paths: &Paths, files: Option<&Value>, ledger: &Mutex<Ledger>) -> bool {
    let Some(Value::Object(files)) = files else {
        return false;
    };
    for (key, row) in js::object_entries(files.iter().map(|(k, v)| (k.clone(), v)).collect()) {
        let Some(rel) = safe_relative_path(&key) else {
            return false;
        };
        if !file_row(row) {
            return false;
        }
        let file = jspath::join(&[&paths.root, &rel]);
        if install::needs_fetch(paths, &file, &row[1], &row[0], ledger) {
            return false;
        }
    }
    true
}

// ---- 3. the data table and the arguments -------------------------------------------------

/// The data table resolved, and the library files its [maven name] rows name.
#[derive(Debug, Default, Clone)]
pub struct Data {
    pub values: Vec<(String, String)>,
    pub artifacts: HashSet<String>,
}

impl Data {
    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn set(&mut self, key: &str, value: String) {
        match self.values.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.values.push((key.to_string(), value)),
        }
    }
}

/// `resolveData(profile, { installerPath, mc, dataDir, who })`: the client side of the data
/// table, plus the names every installer knows.
pub fn resolve_data(
    paths: &Paths,
    profile: &Value,
    installer: &str,
    mc: &str,
    data_dir: &str,
    who: &str,
) -> Result<Data, Failure> {
    let mut out = Data::default();
    let table: Vec<(String, Value)> = match prop(Some(profile), "data") {
        Some(Value::Object(m)) => js::object_entries(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    for (key, sides) in table {
        let key_ok = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !key_ok {
            return Err(coded(
                format!(
                    "The {who} installer names a value \"{}\" SpawnLoft does not know",
                    cut(&key, 40)
                ),
                "loader-installer-unknown",
            ));
        }
        let value = match &sides {
            Value::Null => None,
            other => prop(Some(other), "client"),
        };
        let Some(Value::String(value)) = value else {
            continue;
        };
        if value.starts_with('[') && value.ends_with(']') && js_len(value) >= 2 {
            let f = artifact_file(paths, &value[1..value.len() - 1], &format!("The {who} installer"))?;
            out.artifacts.insert(f.clone());
            out.set(&key, f);
        } else if value.starts_with('\'') && value.ends_with('\'') && js_len(value) >= 2 {
            out.set(&key, value[1..value.len() - 1].to_string());
        } else {
            let entry = safe_relative_path(value.strip_prefix('/').unwrap_or(value)).ok_or_else(|| {
                coded(
                    format!(
                        "The {who} installer names a file \"{}\" SpawnLoft cannot take out of it",
                        cut(value, 80)
                    ),
                    "loader-installer-unknown",
                )
            })?;
            let Some(data) = zip_entry(installer, &entry)? else {
                return Err(coded(
                    format!("The {who} installer has no {entry}, which it says it needs"),
                    "loader-installer-unknown",
                ));
            };
            let dest = jspath::join(&[data_dir, &entry]);
            if !is_inside(Path::new(data_dir), Path::new(&dest)) {
                return Err(coded(
                    format!("The {who} installer names a file outside its folder"),
                    "loader-installer-unknown",
                ));
            }
            let parent = jspath::dirname(&dest);
            std::fs::create_dir_all(&parent)
                .map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&parent))))?;
            std::fs::write(&dest, &data).map_err(|e| Failure::io(&e, "open", Some(Path::new(&dest))))?;
            out.set(&key, dest);
        }
    }
    // the names every installer knows, set last as the installers do
    out.set("SIDE", "client".into());
    out.set("MINECRAFT_JAR", paths.version_jar(mc));
    out.set("MINECRAFT_VERSION", mc.into());
    out.set("ROOT", paths.root.clone());
    out.set("INSTALLER", installer.into());
    out.set("LIBRARY_DIR", paths.libraries_dir());
    Ok(out)
}

/// `fillArgument(arg, data, who)`: a whole [maven name] is its path; otherwise each {NAME} is
/// replaced, with \ escaping the next character. A name the table lacks stops the install.
pub fn fill_argument(paths: &Paths, arg: &str, data: &Data, who: &str) -> Result<String, Failure> {
    if arg.starts_with('[') && arg.ends_with(']') && js_len(arg) >= 2 {
        return artifact_file(paths, &arg[1..arg.len() - 1], &format!("The {who} installer"));
    }
    let chars: Vec<char> = arg.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '{' {
            let Some(end) = chars[i..].iter().position(|&x| x == '}').map(|p| p + i) else {
                out.extend(&chars[i..]);
                break;
            };
            let key: String = chars[i + 1..end].iter().collect();
            let Some(v) = data.get(&key) else {
                return Err(coded(
                    format!(
                        "The {who} installer's build steps use a value {{{}}} it does not give. Update SpawnLoft, or pick an older {who} build in Advanced.",
                        cut(&key, 40)
                    ),
                    "loader-installer-unknown",
                ));
            };
            out.push_str(v);
            i = end + 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    Ok(out)
}

/// `clientProcessors(profile)`: the steps with no sides, and those that name the client.
pub fn client_processors(profile: &Value) -> Vec<Value> {
    let Some(Value::Array(list)) = prop(Some(profile), "processors") else {
        return Vec::new();
    };
    list.iter()
        .filter(|p| match prop(Some(p), "sides") {
            Some(Value::Array(s)) => s.contains(&json!("client")),
            _ => true,
        })
        .cloned()
        .collect()
}

/// A step's command and checks, with every path filled in.
#[derive(Debug, Clone)]
pub struct Step {
    pub jar: String,
    pub classpath: Vec<String>,
    pub args: Vec<String>,
    pub outputs: Vec<(String, String)>,
    pub key: String,
    pub named: Vec<String>,
}

fn strings(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// `planStep(proc, data, who)`.
pub fn plan_step(paths: &Paths, proc: &Value, data: &Data, who: &str) -> Result<Step, Failure> {
    let bad = || {
        coded(
            format!("The {who} installer lists a build step SpawnLoft does not know"),
            "loader-installer-unknown",
        )
    };
    let Some(Value::String(jar_name)) = prop(Some(proc), "jar") else {
        return Err(bad());
    };
    match prop(Some(proc), "args") {
        None | Some(Value::Null | Value::Array(_)) => {}
        Some(_) => return Err(bad()),
    }
    let what = format!("The {who} installer");
    let jar = artifact_file(paths, jar_name, &what)?;
    let cp_names = strings(prop(Some(proc), "classpath"));
    let mut classpath = vec![jar.clone()];
    for n in &cp_names {
        classpath.push(artifact_file(paths, &js::string(Some(n)), &what)?);
    }
    let raw: Vec<String> = strings(prop(Some(proc), "args"))
        .iter()
        .map(|a| js::string(Some(a)))
        .collect();
    let mut args = Vec::new();
    for a in &raw {
        args.push(fill_argument(paths, a, data, who)?);
    }
    // the libraries-folder files the step names by maven name: each must be there once it ran
    let named: Vec<String> = raw
        .iter()
        .zip(&args)
        .filter(|(a, filled)| (a.starts_with('[') && a.ends_with(']')) || data.artifacts.contains(*filled))
        .map(|(_, f)| f.clone())
        .filter(|f| !f.is_empty())
        .collect();
    let mut outputs = Vec::new();
    if let Some(Value::Object(o)) = prop(Some(proc), "outputs") {
        for (file, sum) in js::object_entries(o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()) {
            let f = fill_argument(paths, &file, data, who)?;
            let s = fill_argument(paths, &js::string(Some(&sum)), data, who)?.to_lowercase();
            if !is_inside(Path::new(&paths.libraries_dir()), Path::new(&f)) || !is_sha1(Some(&json!(s))) {
                return Err(coded(
                    format!("The {who} installer names a build output SpawnLoft cannot check"),
                    "loader-installer-unknown",
                ));
            }
            outputs.push((f, s));
        }
    }
    let key = sha1_hex(
        jsjson::stringify(&json!([
            jar_name,
            match prop(Some(proc), "classpath") {
                None | Some(Value::Null) => json!([]),
                Some(v) => v.clone(),
            },
            args
        ]))
        .as_bytes(),
    );
    Ok(Step {
        jar,
        classpath,
        args,
        outputs,
        key,
        named,
    })
}

/// `mainClassOf(jar)`: the Main-Class of a step's jar, from its manifest.
pub fn main_class_of(jar: &str) -> Result<Option<String>, Failure> {
    let Some(mf) = zip_entry(jar, "META-INF/MANIFEST.MF")? else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&mf)
        .replace("\r\n ", "")
        .replace("\n ", "");
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("Main-Class:") else {
            continue;
        };
        let value = rest.trim_matches(|c: char| c.is_whitespace());
        // /^Main-Class:\s*(\S+)\s*$/m: a line with a space inside its value is no match, and the
        // search goes on to the next line
        if value.is_empty() || value.contains(char::is_whitespace) {
            continue;
        }
        let mut cs = value.chars();
        let first = cs.next().unwrap_or('0');
        let ok = (first.is_ascii_alphabetic() || first == '_' || first == '$')
            && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.');
        return Ok(ok.then(|| value.to_string()));
    }
    Ok(None)
}

// ---- 2. libraries --------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct LibRow {
    name: String,
    file: String,
    rel: String,
    /// None: no download given at all; Some(""): ships inside the installer
    url: Option<String>,
    sha1: Option<String>,
    size: Option<f64>,
}

fn library_rows(paths: &Paths, list: Option<&Value>, who: &str) -> Result<Vec<LibRow>, Failure> {
    let mut rows = Vec::new();
    for lib in strings(list) {
        let a = prop(prop(Some(&lib), "downloads"), "artifact");
        let name = prop(Some(&lib), "name");
        if !js::truthy(name) {
            continue;
        }
        let a_path = prop(a, "path");
        let rel = if js::truthy(a_path) {
            // safeRelativePath takes only a string: anything else is refused
            a_path.and_then(Value::as_str).and_then(safe_relative_path)
        } else {
            artifact_path(name)
        };
        let Some(rel) = rel else {
            let shown = match a_path {
                Some(v) if !v.is_null() => js::string(Some(v)),
                _ => js::string(name),
            };
            return Err(coded(
                format!(
                    "The {who} installer names a library at \"{}\", outside the libraries folder",
                    cut(&shown, 80)
                ),
                "loader-installer-unknown",
            ));
        };
        let url = match a {
            None | Some(Value::Null) => None,
            Some(a) => Some(match prop(Some(a), "url") {
                None | Some(Value::Null) => String::new(),
                Some(u) => js::string(Some(u)),
            }),
        };
        let sha1 = prop(a, "sha1");
        let size = prop(a, "size")
            .and_then(Value::as_f64)
            .filter(|f| f.fract() == 0.0);
        rows.push(LibRow {
            name: js::string(name),
            file: jspath::join(&[&paths.libraries_dir(), &rel]),
            rel,
            url,
            sha1: is_sha1(sha1).then(|| js::string(sha1).to_lowercase()),
            size,
        });
    }
    Ok(rows)
}

fn opt_sha(s: &Option<String>) -> Value {
    s.as_ref().map_or(Value::Null, |s| json!(s))
}

fn opt_size(s: Option<f64>) -> Value {
    s.map_or(Value::Null, jsjson::num)
}

/// `ensureLibraries`: the profile's libraries, and the version file's that ship inside the
/// installer. A version-file row with no url that is not in the installer is a build output.
#[allow(clippy::too_many_arguments)]
fn ensure_libraries(
    paths: &Paths,
    profile: &Value,
    version: &Value,
    installer: &str,
    who: &str,
    fetch: Fetch<'_>,
    ledger: &Mutex<Ledger>,
    on_progress: install::OnProgress<'_>,
) -> Result<(), Failure> {
    let mut seen = HashSet::new();
    let mut rows: Vec<LibRow> = library_rows(paths, prop(Some(profile), "libraries"), who)?;
    rows.extend(
        library_rows(paths, prop(Some(version), "libraries"), who)?
            .into_iter()
            .filter(|r| r.url.as_deref() == Some("")),
    );
    rows.retain(|r| seen.insert(r.rel.clone()));
    let total = rows.len();
    let mut bytes = 0.0;
    for (n, row) in rows.iter().enumerate() {
        cancel::check_cancelled()?;
        if row.url.as_deref().is_some_and(|u| !u.is_empty()) && row.sha1.is_none() {
            return Err(coded(
                format!(
                    "The {who} installer lists {} without a checksum; SpawnLoft does not run or load an unchecked file. Pick another {who} build in Advanced.",
                    row.name
                ),
                "loader-installer-unknown",
            ));
        }
        if install::needs_fetch(paths, &row.file, &opt_sha(&row.sha1), &opt_size(row.size), ledger) {
            match row.url.as_deref() {
                Some("") => {
                    let entry = match prop(prop(Some(profile), "installerFiles"), &row.rel) {
                        Some(v) if !v.is_null() => js::string(Some(v)),
                        _ => format!("maven/{}", row.rel),
                    };
                    if let Some(data) = zip_entry(installer, &entry)? {
                        if let Some(want) = &row.sha1
                            && &sha1_hex(&data) != want
                        {
                            return Err(coded(
                                format!(
                                    "The {who} installer's copy of {} does not match its checksum",
                                    row.name
                                ),
                                "loader-installer-unknown",
                            ));
                        }
                        let parent = jspath::dirname(&row.file);
                        std::fs::create_dir_all(&parent)
                            .map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&parent))))?;
                        std::fs::write(&row.file, &data)
                            .map_err(|e| Failure::io(&e, "open", Some(Path::new(&row.file))))?;
                        install::note_checked(paths, ledger, &row.file, &opt_sha(&row.sha1));
                    }
                    // else made by a build step
                }
                Some(url) => {
                    assert_loader_host(url, &format!("The {who} installer"))?;
                    let parent = jspath::dirname(&row.file);
                    std::fs::create_dir_all(&parent)
                        .map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&parent))))?;
                    if let Err(err) = fetch(
                        url,
                        Path::new(&row.file),
                        row.sha1.as_deref(),
                        &format!("library {}", row.name),
                    ) {
                        if cancel::is_cancelled(&err) {
                            return Err(err);
                        }
                        return Err(coded(
                            format!(
                                "could not download library {} from {url}: {}",
                                row.name,
                                err.message()
                            ),
                            code_of(&err).unwrap_or("download-failed"),
                        ));
                    }
                    install::note_checked(paths, ledger, &row.file, &opt_sha(&row.sha1));
                    bytes += row.size.unwrap_or(0.0);
                }
                None => {
                    return Err(coded(
                        format!(
                            "The {who} installer lists {} with no download SpawnLoft knows. Update SpawnLoft, or pick another {who} build in Advanced.",
                            row.name
                        ),
                        "loader-installer-unknown",
                    ));
                }
            }
        }
        on_progress(&install::Progress {
            phase: "libraries",
            done: n + 1,
            total,
            bytes,
        });
    }
    Ok(())
}

// ---- 4. a build step -------------------------------------------------------------------------

/// How a step's Java is started (`spawnImpl`): the tests' stand-in replaces it.
pub type Spawn<'a> = &'a (dyn Fn(&str, &[String], &str) -> std::io::Result<std::process::Child> + Sync);

pub fn default_spawn(java: &str, argv: &[String], cwd: &str) -> std::io::Result<std::process::Child> {
    let mut c = std::process::Command::new(java);
    c.args(argv)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    cancel::own_group(&mut c);
    crate::platform::default_signals(&mut c);
    c.spawn()
}

struct Tail {
    lines: Vec<String>,
    partial: String,
}

impl Tail {
    fn push(&mut self, line: String) {
        self.lines.push(line);
        if self.lines.len() > TAIL_LINES {
            self.lines.remove(0);
        }
    }
    fn take(&mut self, text: &str) {
        let joined = format!("{}{text}", self.partial);
        let mut parts: Vec<&str> = joined.split('\n').collect();
        let last = parts.pop().unwrap_or("").to_string();
        for p in parts {
            let l = p.strip_suffix('\r').unwrap_or(p);
            if !js::trim(l).is_empty() {
                self.push(l.to_string());
            }
        }
        self.partial = last;
    }
}

struct StepRun {
    code: i64,
    tail: Vec<String>,
}

/// `runStep`: the step on the Java, its output in the log and the last lines kept.
fn run_step(
    java: &str,
    java_args: &[String],
    main: &str,
    step: &Step,
    cwd: &str,
    log: &Mutex<Log>,
    spawn: Spawn<'_>,
) -> Result<StepRun, Failure> {
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let mut argv: Vec<String> = java_args.to_vec();
    argv.push("-cp".into());
    argv.push(step.classpath.join(delimiter));
    argv.push(main.into());
    argv.extend(step.args.iter().cloned());
    let shown: Vec<String> = argv
        .iter()
        .map(|a| {
            if a.chars().any(js::is_js_space) {
                jsjson::stringify(&json!(a))
            } else {
                a.clone()
            }
        })
        .collect();
    log.lock()
        .unwrap_or_else(|p| p.into_inner())
        .write(&format!("\n$ java {}\n", shown.join(" ")));
    let mut child = spawn(java, &argv, cwd).map_err(|e| Failure::Internal {
        head: "Error".into(),
        message: format!("spawn {java} {}", jspath::error_code(&e).0),
        code: Some(jspath::error_code(&e).0.to_string()),
    })?;
    let stopper = cancel::stop_on_cancel(&child, true);
    let tail = Mutex::new(Tail {
        lines: Vec::new(),
        partial: String::new(),
    });
    let out = child.stdout.take();
    let err = child.stderr.take();
    let pump = |mut r: Box<dyn Read + Send>| {
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    log.lock().unwrap_or_else(|p| p.into_inner()).write(&text);
                    tail.lock().unwrap_or_else(|p| p.into_inner()).take(&text);
                }
            }
        }
    };
    let status = std::thread::scope(|s| {
        if let Some(o) = out {
            s.spawn(|| pump(Box::new(o)));
        }
        if let Some(e) = err {
            s.spawn(|| pump(Box::new(e)));
        }
        stopper.wait(&mut child)
    });
    let (status, stopped) = status.map_err(|e| Failure::io(&e, "wait", None))?;
    let mut tail = tail.into_inner().unwrap_or_else(|p| p.into_inner());
    if !js::trim(&tail.partial).is_empty() {
        let p = std::mem::take(&mut tail.partial);
        tail.push(p);
    }
    if stopped || cancel::current().is_some_and(|t| t.is_cancelled()) {
        return Err(cancel::cancelled());
    }
    let code = match status.code() {
        Some(c) => i64::from(c),
        None => 1,
    };
    Ok(StepRun {
        code,
        tail: tail.lines,
    })
}

/// The files a step that names no outputs leaves in the libraries folder: every argument that
/// is one.
fn files_named_by(paths: &Paths, step: &Step) -> Result<Map<String, Value>, Failure> {
    let lib = paths.libraries_dir();
    let mut out = Map::new();
    for a in &step.args {
        if !is_inside(Path::new(&lib), Path::new(a)) || *a == lib {
            continue;
        }
        let Ok(meta) = std::fs::metadata(a) else { continue };
        if !meta.is_file() {
            continue;
        }
        out.insert(ledger_key(paths, a), json!([meta.len(), sha1_of_file(a)?]));
    }
    Ok(out)
}

fn outputs_as_files(paths: &Paths, step: &Step) -> Map<String, Value> {
    let mut out = Map::new();
    for (file, sha1) in &step.outputs {
        let size = std::fs::metadata(file).map_or(Value::Null, |m| json!(m.len()));
        out.insert(ledger_key(paths, file), json!([size, sha1]));
    }
    out
}

/// The build log: `loader-install.log` in the profile's run folder. A help, not a step: a write
/// that fails is let go.
struct Log {
    file: Option<std::fs::File>,
}

impl Log {
    fn write(&mut self, text: &str) {
        if let Some(f) = &mut self.file
            && f.write_all(text.as_bytes()).is_err()
        {
            self.file = None;
        }
    }
}

// ---- 2 to 5 ----------------------------------------------------------------------------------

/// The lock for one Minecraft version's loader builds, waited for in short turns so a cancel
/// ends the wait.
fn lock_for(paths: &Paths, mc: &str) -> Result<crate::lock::Lock, Failure> {
    let dir = steps_dir(paths);
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&dir))))?;
    let file = jspath::join(&[&dir, &format!("{mc}.lock")]);
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        cancel::check_cancelled()?;
        match crate::lock::acquire(Path::new(&file), crate::lock::Options::wait(500)) {
            Ok(Some(lock)) => return Ok(lock),
            Ok(None) => {}
            Err(crate::lock::LockError::TimedOut { .. }) if Instant::now() <= deadline => {}
            Err(crate::lock::LockError::Io(e)) => {
                return Err(Failure::io(&e, "open", Some(Path::new(&file))));
            }
            Err(e) => {
                return Err(Failure::Internal {
                    head: "Error".into(),
                    message: e.to_string(),
                    code: None,
                });
            }
        }
    }
}

/// `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`, its
/// failure ignored: a temporary folder left to the system.
fn remove_folder(dir: &str) {
    let _ = super::rm_tree_retrying(dir);
}

/// What [`run_installer`] needs.
#[allow(missing_debug_implementations)]
pub struct Run<'a> {
    pub id: &'a str,
    pub mc: &'a str,
    pub who: &'a str,
    pub build: &'a str,
    /// the setup, for the log
    pub name: &'a str,
    /// gives the installer, only called when there is something to build
    pub installer: &'a mut dyn FnMut() -> Result<Installer, Failure>,
    pub java: &'a str,
    /// before -cp: the tests' fake Java
    pub java_args: &'a [String],
    pub legacy: bool,
    pub verify: bool,
    pub fetch: Fetch<'a>,
    pub spawn: Spawn<'a>,
    pub on_stage: &'a mut dyn FnMut(&str),
    pub on_progress: install::OnProgress<'a>,
    pub on_note: &'a mut dyn FnMut(&str),
}

/// `runInstaller(...)`: everything after the version file, for one build. `Ok(false)` when the
/// stamp already holds.
pub fn run_installer(paths: &Paths, mut r: Run<'_>) -> Result<bool, Failure> {
    let ledger = Mutex::new(Ledger::open(paths, r.verify));
    let result = run_locked(paths, &mut r, &ledger);
    ledger.lock().unwrap_or_else(|p| p.into_inner()).save(paths);
    result
}

fn run_locked(paths: &Paths, r: &mut Run<'_>, ledger: &Mutex<Ledger>) -> Result<bool, Failure> {
    if is_stamped(paths, r.id) && stamp_holds(paths, r.id, ledger) {
        return Ok(false);
    }
    let lock = lock_for(paths, r.mc)?;
    let inner = (|| -> Result<bool, Failure> {
        // another setup may have finished it while this one waited
        if is_stamped(paths, r.id) && stamp_holds(paths, r.id, ledger) {
            return Ok(false);
        }
        if is_stamped(paths, r.id) {
            (r.on_note)(&format!(
                "{} {}'s files were changed or removed since it was set up, so it is set up again",
                r.who, r.build
            ));
            super::rm_force(&stamp_file(paths, r.id))?;
        }
        let inst = (r.installer)()?;
        build_all(paths, r, &inst, ledger)
    })();
    let _ = lock.release();
    inner
}

fn build_all(
    paths: &Paths,
    r: &mut Run<'_>,
    installer: &Installer,
    ledger: &Mutex<Ledger>,
) -> Result<bool, Failure> {
    let who = r.who;
    let read = read_installer(&installer.path, r.mc, r.id, who, r.legacy)?;
    let (profile, version) = (&read.profile, &read.version);
    (r.on_stage)(&format!("Downloading {who} {}'s libraries", r.build));
    ensure_libraries(
        paths,
        profile,
        version,
        &installer.path,
        who,
        r.fetch,
        ledger,
        r.on_progress,
    )?;

    let data_dir = jspath::join(&[&installers_dir(paths), &format!("{}-data", r.id)]);
    remove_folder(&data_dir);
    let data = resolve_data(paths, profile, &installer.path, r.mc, &data_dir, who)?;
    let mut steps = Vec::new();
    for p in client_processors(profile) {
        steps.push(plan_step(paths, &p, &data, who)?);
    }
    let total = steps.len();

    let mut record = read_json(&steps_file(paths, r.mc)).unwrap_or(Value::Null);
    let record_ok = prop(Some(&record), "format").and_then(Value::as_f64) == Some(1.0)
        && matches!(prop(Some(&record), "steps"), Some(Value::Object(_)));
    if !record_ok {
        record = json!({ "format": 1, "steps": {} });
    }
    let mut stamp_files = Map::new();

    let log_file = jspath::join(&[&paths.run_dir(r.name), "loader-install.log"]);
    let log_dir = jspath::dirname(&log_file);
    std::fs::create_dir_all(&log_dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&log_dir))))?;
    let log = Mutex::new(Log {
        file: std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .ok(),
    });
    let write_log = |t: &str| log.lock().unwrap_or_else(|p| p.into_inner()).write(t);
    write_log(&format!(
        "\n==== {} setting up {who} {} ({}), {total} steps ====\n",
        crate::jsdate::to_iso(crate::util::now()).unwrap_or_default(),
        r.build,
        r.id
    ));
    for (i, step) in steps.iter().enumerate() {
        cancel::check_cancelled()?;
        let n = i + 1;
        (r.on_stage)(&format!("Setting up {who} {} (step {n} of {total})", r.build));
        let recorded = prop(prop(Some(&record), "steps"), &step.key).cloned();
        let done = if step.outputs.is_empty() {
            files_still_match(paths, recorded.as_ref(), ledger)
        } else {
            step.outputs
                .iter()
                .all(|(f, s)| !install::needs_fetch(paths, f, &json!(s), &Value::Null, ledger))
        };
        if done {
            write_log(&format!("-- step {n} of {total}: already done\n"));
            let files = if step.outputs.is_empty() {
                match recorded {
                    Some(Value::Object(m)) => m,
                    _ => Map::new(),
                }
            } else {
                outputs_as_files(paths, step)
            };
            stamp_files.extend(files);
            continue;
        }
        if recorded.is_some() {
            if let Some(Value::Object(s)) = record.get_mut("steps") {
                s.shift_remove(&step.key);
            }
            write_json_atomic(&steps_file(paths, r.mc), &record)?;
        }
        let jar_base = jspath::basename(&step.jar);
        let Some(main) = main_class_of(&step.jar)? else {
            return Err(coded(
                format!(
                    "Setting up {who} stopped at step {n} of {total}: its tool {jar_base} names no main class. Pick another {who} build in Advanced."
                ),
                "loader-install-failed",
            ));
        };
        let cwd = make_temp_dir()?;
        let ran = run_step(r.java, r.java_args, &main, step, &cwd, &log, r.spawn);
        remove_folder(&cwd);
        let result = match ran {
            Ok(res) => res,
            Err(err) => {
                for (f, _) in &step.outputs {
                    let _ = super::rm_force(f);
                }
                if cancel::is_cancelled(&err) {
                    return Err(err);
                }
                return Err(coded(
                    format!(
                        "Setting up {who} stopped at step {n} of {total}: Java could not be started ({}).",
                        err.message()
                    ),
                    "loader-install-failed",
                ));
            }
        };
        let stopped = |why: String| -> Failure {
            for (f, _) in &step.outputs {
                let _ = super::rm_force(f);
            }
            let tail = if result.tail.is_empty() {
                String::new()
            } else {
                format!("\n{}", result.tail.join("\n"))
            };
            coded(
                format!(
                    "Setting up {who} stopped at step {n} of {total}{why}.{tail}\nThe whole output is in {log_file}"
                ),
                "loader-install-failed",
            )
        };
        if result.code != 0 {
            return Err(stopped(format!(" (its tool ended with code {})", result.code)));
        }
        for (f, s) in &step.outputs {
            let actual = install::sha1_of_file(Path::new(f)).ok();
            if actual.as_deref() != Some(s.as_str()) {
                let how = if actual.is_some() {
                    "did not come out as the installer says it should"
                } else {
                    "was not made"
                };
                return Err(stopped(format!(": {} {how}", jspath::basename(f))));
            }
            install::note_checked(paths, ledger, f, &json!(s));
        }
        for f in &step.named {
            if !Path::new(f).exists() {
                return Err(stopped(format!(": {} was not made", jspath::basename(f))));
            }
        }
        let files = if step.outputs.is_empty() {
            files_named_by(paths, step)?
        } else {
            outputs_as_files(paths, step)
        };
        if step.outputs.is_empty() {
            if let Some(Value::Object(s)) = record.get_mut("steps") {
                s.insert(step.key.clone(), Value::Object(files.clone()));
            }
            write_json_atomic(&steps_file(paths, r.mc), &record)?;
        }
        stamp_files.extend(files);
        write_log(&format!("-- step {n} of {total}: done\n"));
    }
    // the version file's rows the steps were to make
    for row in library_rows(paths, prop(Some(version), "libraries"), who)?
        .into_iter()
        .filter(|r| r.url.as_deref() == Some(""))
    {
        if install::needs_fetch(paths, &row.file, &opt_sha(&row.sha1), &opt_size(row.size), ledger) {
            return Err(coded(
                format!(
                    "Setting up {who} {} finished without making {}. Pick another {who} build in Advanced.\nThe whole output is in {log_file}",
                    r.build, row.name
                ),
                "loader-install-failed",
            ));
        }
        if let Some(s) = &row.sha1 {
            let size = std::fs::metadata(&row.file)
                .map_err(|e| Failure::io(&e, "stat", Some(Path::new(&row.file))))?
                .len();
            stamp_files.insert(ledger_key(paths, &row.file), json!([size, s]));
        }
    }
    cancel::check_cancelled()?;
    write_json_atomic(
        &stamp_file(paths, r.id),
        &json!({
            "format": 1,
            "id": r.id,
            "installer": installer.sha1,
            "at": crate::jsdate::to_iso(crate::util::now()).unwrap_or_default(),
            "files": Value::Object(stamp_files),
        }),
    )?;
    remove_folder(&data_dir);
    write_log(&format!("==== {who} {} is set up ====\n", r.build));
    Ok(true)
}

/// `fs.mkdtempSync(path.join(os.tmpdir(), 'sl-loader-step-'))`.
fn make_temp_dir() -> Result<String, Failure> {
    let base = crate::util::os_tmpdir();
    for _ in 0..16 {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).map_err(|e| user(format!("could not make a temporary folder: {e}")))?;
        // 64 characters, so each byte's low six bits pick one evenly
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let tag: String = b.iter().map(|x| ABC[(*x & 63) as usize] as char).collect();
        let dir = jspath::join(&[&base, &format!("sl-loader-step-{tag}")]);
        // mkdtemp's folder is the owner's only
        #[cfg(unix)]
        let made =
            std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir);
        #[cfg(not(unix))]
        let made = std::fs::create_dir(&dir);
        match made {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Failure::io(&e, "mkdtemp", Some(Path::new(&dir)))),
        }
    }
    Err(user("could not make a temporary folder"))
}

// ---- Forge's older installer (client-forge-legacy.mjs) ---------------------------------------

/// `isLegacyProfile(profile)`.
pub fn is_legacy_profile(profile: &Value) -> bool {
    matches!(profile, Value::Object(_))
        && (js::truthy(prop(Some(profile), "install")) || js::truthy(prop(Some(profile), "versionInfo")))
}

/// `legacyBaseUrl(url)`: an old maven base made today's: https, and Forge's maven where it now
/// lives.
pub fn legacy_base_url(url: Option<&Value>) -> String {
    let raw = match url {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::string(Some(v)),
    };
    let mut u = js::trim(&raw).to_string();
    if u.is_empty() {
        return "https://libraries.minecraft.net/".into();
    }
    if u.get(..7).is_some_and(|h| h.eq_ignore_ascii_case("http://")) {
        u = format!("https://{}", &u[7..]);
    }
    let old = "https://files.minecraftforge.net/maven";
    if u.len() >= old.len() && u.is_char_boundary(old.len()) && u[..old.len()].eq_ignore_ascii_case(old) {
        let rest = &u[old.len()..];
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        u = format!("https://maven.minecraftforge.net/{rest}");
    }
    if u.ends_with('/') { u } else { format!("{u}/") }
}

/// `convertLegacy(profile, { mc, id, installerPath, who })`: the newer installer's shape out of
/// the old one.
pub fn convert_legacy(
    profile: &Value,
    mc: &str,
    id: &str,
    installer: &str,
    who: &str,
) -> Result<Contents, Failure> {
    let unknown = |why: &str| unknown(who, why, false);
    let inst = prop(Some(profile), "install");
    let info = prop(Some(profile), "versionInfo");
    let inst_ok = matches!(inst, Some(Value::Object(_) | Value::Array(_)));
    let info_ok = matches!(info, Some(Value::Object(_) | Value::Array(_)))
        && matches!(prop(info, "libraries"), Some(Value::Array(_)));
    if !inst_ok || !info_ok {
        return Err(unknown("an old installer profile SpawnLoft does not know"));
    }
    let minecraft = prop(inst, "minecraft");
    if minecraft != Some(&json!(mc)) {
        return Err(coded(
            format!(
                "The {who} installer is for Minecraft {}, not {mc}; pick another {who} build in Advanced.",
                cut(&js::string(minecraft), 40)
            ),
            "loader-installer-unknown",
        ));
    }
    let parent = prop(info, "inheritsFrom");
    let has_parent = !matches!(parent, None | Some(Value::Null));
    if has_parent && parent != Some(&json!(mc)) {
        return Err(coded(
            format!(
                "The {who} installer's version inherits from {}, not Minecraft {mc}; pick another {who} build in Advanced.",
                cut(&js::string(parent), 40)
            ),
            "loader-installer-unknown",
        ));
    }
    if !matches!(prop(info, "mainClass"), Some(Value::String(_)))
        || !matches!(prop(info, "minecraftArguments"), Some(Value::String(_)))
    {
        return Err(unknown("a version file with no main class or arguments"));
    }
    if !super::version::is_safe_version_id(id) {
        return Err(user(format!("{who} makes a version id SpawnLoft cannot use")));
    }
    let forge_rel = artifact_path(prop(inst, "path"));
    let entry = match prop(inst, "filePath") {
        Some(Value::String(f)) => safe_relative_path(f.strip_prefix('/').unwrap_or(f)),
        _ => None,
    };
    let (Some(forge_rel), Some(entry)) = (forge_rel, entry) else {
        return Err(unknown("a Forge jar SpawnLoft cannot place"));
    };
    let Some(jar) = zip_entry(installer, &entry)? else {
        return Err(unknown(&format!("no {entry} in the installer")));
    };
    let inst_path = prop(inst, "path").cloned().unwrap_or(Value::Null);
    let forge_row = |name: &Value| json!({ "name": name, "downloads": { "artifact": { "path": forge_rel, "url": "", "sha1": sha1_hex(&jar), "size": jar.len() } } });

    let mut libraries: Vec<Value> = Vec::new();
    let mut pending: Vec<Pending> = Vec::new();
    let mut has_forge = false;
    for lib in strings(prop(info, "libraries")) {
        let Some(Value::String(name)) = prop(Some(&lib), "name").filter(|_| !lib.is_null()) else {
            continue;
        };
        // a row only the server needs
        if prop(Some(&lib), "clientreq") == Some(&json!(false)) {
            continue;
        }
        let Some(rel) = artifact_path(Some(&json!(name))) else {
            return Err(coded(
                format!(
                    "The {who} installer names a library \"{}\" SpawnLoft cannot place in its libraries folder",
                    cut(name, 80)
                ),
                "loader-installer-unknown",
            ));
        };
        if Some(&json!(name)) == Some(&inst_path) {
            has_forge = true;
            libraries.push(forge_row(&json!(name)));
            continue;
        }
        // a file that lists the game's own libraries (1.6.4): their native and per-OS rows are
        // vanilla's, which it now inherits
        if js::truthy(prop(Some(&lib), "natives")) || js::truthy(prop(Some(&lib), "rules")) {
            if !has_parent {
                continue;
            }
            return Err(unknown(&format!(
                "a library row for {} SpawnLoft does not know",
                cut(name, 60)
            )));
        }
        let nullish = |k: &str| matches!(prop(Some(&lib), k), None | Some(Value::Null));
        if !has_parent && !js::truthy(prop(Some(&lib), "url")) && nullish("clientreq") && nullish("serverreq")
        {
            continue;
        }
        let url = format!("{}{rel}", legacy_base_url(prop(Some(&lib), "url")));
        assert_loader_host(&url, &format!("The {who} installer"))?;
        let sums: Vec<String> = match prop(Some(&lib), "checksums") {
            Some(Value::Array(a)) => a
                .iter()
                .filter(|s| is_sha1(Some(s)))
                .map(|s| js::string(Some(s)).to_lowercase())
                .collect(),
            _ => Vec::new(),
        };
        pending.push(Pending {
            index: libraries.len(),
            url: url.clone(),
            sums,
        });
        libraries.push(json!({ "name": name, "downloads": { "artifact": { "path": rel, "url": url } } }));
    }
    if !has_forge {
        libraries.insert(0, forge_row(&inst_path));
        for p in &mut pending {
            p.index += 1;
        }
    }
    let mut version = Map::new();
    if let Some(Value::Object(m)) = info {
        for (k, v) in m {
            if matches!(k.as_str(), "libraries" | "jar" | "inheritsFrom") {
                continue;
            }
            version.insert(k.clone(), v.clone());
        }
    }
    version.insert("id".into(), json!(id));
    version.insert("inheritsFrom".into(), json!(mc));
    version.insert("libraries".into(), Value::Array(libraries));
    // `{ ...rest, id, inheritsFrom, libraries }`: a key the spread already set keeps its place
    let version = respread(info, version);
    let mut files = Map::new();
    files.insert(forge_rel, json!(entry));
    Ok(Contents {
        profile: json!({ "spec": 0, "minecraft": mc, "libraries": [], "processors": [], "data": {}, "installerFiles": Value::Object(files) }),
        version,
        pending,
    })
}

/// The key order of `{ ...rest, id, inheritsFrom, libraries }`: rest's keys in their order (id
/// where rest had it), then the new ones.
fn respread(info: Option<&Value>, mut built: Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(Value::Object(m)) = info {
        for (k, _) in js::object_entries(m.iter().map(|(k, v)| (k.clone(), v)).collect()) {
            if matches!(k.as_str(), "libraries" | "jar" | "inheritsFrom") {
                continue;
            }
            if let Some(v) = built.shift_remove(&k) {
                out.insert(k, v);
            }
        }
    }
    for k in ["id", "inheritsFrom", "libraries"] {
        if let Some(v) = built.shift_remove(k) {
            out.insert(k.into(), v);
        }
    }
    Value::Object(out)
}

/// How an older installer's library is fetched to hash it when its maven publishes no checksum:
/// `downloadedSha1(url, rel)`.
pub type FileSha1<'a> = &'a (dyn Fn(&str, &str) -> Result<String, Failure> + Sync);

/// `downloadedSha1(url, rel)`: the file itself, downloaded into the libraries folder and hashed.
pub fn downloaded_sha1(paths: &Paths, url: &str, rel: &str, fetch: Fetch<'_>) -> Result<String, Failure> {
    let file = jspath::join(&[&paths.libraries_dir(), rel]);
    let parent = jspath::dirname(&file);
    std::fs::create_dir_all(&parent).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&parent))))?;
    let base = rel.rsplit('/').next().unwrap_or(rel);
    fetch(url, Path::new(&file), None, &format!("library {base}"))?;
    sha1_of_file(&file)
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| {
            let h = u.host_str().unwrap_or("").to_string();
            match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h,
            }
        })
        .unwrap_or_default()
}

/// `fillLegacyChecksums(version, pending, { who })`: each pending row's checksum, from its maven.
pub fn fill_legacy_checksums(
    paths: &Paths,
    version: &mut Value,
    pending: &[Pending],
    who: &str,
    sha1: FetchSha1<'_>,
    file_sha1: FileSha1<'_>,
) -> Result<(), Failure> {
    for p in pending {
        cancel::check_cancelled()?;
        let (name, rel) = {
            let row = &version["libraries"][p.index];
            (
                js::string(prop(Some(row), "name")),
                js::string(prop(prop(prop(Some(row), "downloads"), "artifact"), "path")),
            )
        };
        let not_listed = || {
            coded(
                format!(
                    "{name} on {} is not the file the {who} installer lists. Pick another {who} build in Advanced.",
                    host_of(&p.url)
                ),
                "loader-installer-unknown",
            )
        };
        let sum = match sha1(&p.url) {
            Ok(s) => s,
            Err(err) => {
                if cancel::is_cancelled(&err) {
                    return Err(err);
                }
                if p.sums.is_empty() {
                    return Err(coded(
                        format!(
                            "Could not read the checksum of {name} from {}, and the {who} installer lists none: {}",
                            p.url,
                            err.message()
                        ),
                        code_of(&err).unwrap_or("loader-unreachable"),
                    ));
                }
                let s = match file_sha1(&p.url, &rel) {
                    Ok(s) => s,
                    Err(err2) => {
                        if cancel::is_cancelled(&err2) {
                            return Err(err2);
                        }
                        return Err(coded(
                            format!(
                                "Could not download library {name} from {}: {}",
                                p.url,
                                err2.message()
                            ),
                            code_of(&err2).unwrap_or("download-failed"),
                        ));
                    }
                };
                if !p.sums.contains(&s) {
                    let _ = super::rm_force(&jspath::join(&[&paths.libraries_dir(), &rel]));
                    return Err(not_listed());
                }
                s
            }
        };
        if !p.sums.is_empty() && !p.sums.contains(&sum) {
            return Err(not_listed());
        }
        if let Some(a) = version["libraries"][p.index]["downloads"]["artifact"].as_object_mut() {
            a.insert("sha1".into(), json!(sum));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_legacy_base_url_is_moved_to_https_and_the_new_maven() {
        assert_eq!(legacy_base_url(None), "https://libraries.minecraft.net/");
        assert_eq!(
            legacy_base_url(Some(&json!(" "))),
            "https://libraries.minecraft.net/"
        );
        assert_eq!(
            legacy_base_url(Some(&json!("HTTP://files.minecraftforge.net/maven/"))),
            "https://maven.minecraftforge.net/"
        );
        assert_eq!(
            legacy_base_url(Some(&json!("https://x.example/m"))),
            "https://x.example/m/"
        );
        // a character of several bytes across the seventh byte is no scheme, and no panic
        assert_eq!(legacy_base_url(Some(&json!("abcdefé/"))), "abcdefé/");
    }
}
