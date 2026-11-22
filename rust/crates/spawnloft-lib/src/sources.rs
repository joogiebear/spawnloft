//! Where each kind of server comes from (C4): `sources.mjs` and the clients behind it,
//! `paper.mjs` (Paper and Folia), `purpur.mjs`, `vanilla.mjs`, `asp.mjs`, `buildtools.mjs`
//! (Spigot and CraftBukkit, compiled here), `fabric.mjs` and `neoforge.mjs`. Each fetch puts a
//! jar in the jar store, keeps every check Node makes (sha256, sha1, md5, size floors) and its
//! words for every failure, and asks the hosts the same questions in the same form.
//!
//! The requests go through `download.rs`'s agent: no proxy (as Node's `fetch`), Node's redirect
//! limit, the test-only origin map of a `test-hooks` build. Where Node's client sets no time
//! limit (Paper's API and its jar, Fabric's jar), none is set here either.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use crate::cancel;
use crate::download::{self, Hash};
use crate::failure::Failure;
use crate::text::human_bytes;
use crate::{js, jspath};

/// What a fetch tells its caller as it goes: a line from a build or an installer. (Byte counts
/// are not reported: the command line never shows them.)
pub type OnMessage<'a> = &'a mut dyn FnMut(&str);

/// A jar fetched (or found already stored).
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    pub name: String,
    pub path: String,
    pub cached: bool,
    /// the build as the source names it (a number for Paper, text for Purpur and ASP); null
    /// where the source has none
    pub build: Value,
    /// Paper and Folia's STABLE or EXPERIMENTAL; null for the others
    pub channel: Value,
    /// `humanBytes` of the size, where the source reports one
    pub size_human: Option<String>,
}

impl Fetched {
    fn new(name: String, path: String, cached: bool) -> Fetched {
        Fetched {
            name,
            path,
            cached,
            build: Value::Null,
            channel: Value::Null,
            size_human: None,
        }
    }
}

/// Why a request got no answer.
enum Net {
    /// the parity rig's origin map refused it (a `test-hooks` build only); Node's `err.message`
    Refused(String),
    Failed(ureq::Error),
    /// undici's own limits on a request with no time limit of its own: 10 s to connect, 300 s
    /// for the headers; `fetch failed`, with the limit's name as the cause
    Quiet(&'static str),
}

struct Answer {
    status: u16,
    length: u64,
    body: ureq::Body,
}

impl Answer {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// `res.ok && res.body`: 204 and 205 carry none.
    fn ok_with_body(&self) -> bool {
        self.ok() && self.status != 204 && self.status != 205
    }
}

/// `fetch(url, { headers, signal: AbortSignal.timeout(limit) })`.
fn get(url: &str, accept: Option<&str>, limit: Option<Duration>) -> Result<Answer, Net> {
    let sent = download::target(url).map_err(Net::Refused)?;
    let agent = download::agent(|b| match limit {
        Some(_) => b.timeout_global(limit),
        None => b
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(300))),
    });
    let mut req = agent.get(&sent).header("User-Agent", download::UA);
    if let Some(a) = accept {
        req = req.header("Accept", a);
    }
    let res = req.call().map_err(|e| match e {
        ureq::Error::Timeout(ureq::Timeout::Connect) if limit.is_none() => {
            Net::Quiet("Connect Timeout Error")
        }
        ureq::Error::Timeout(_) if limit.is_none() => Net::Quiet("Headers Timeout Error"),
        e => Net::Failed(e),
    })?;
    let status = res.status().as_u16();
    let length = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(js::string_to_number)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0) as u64;
    Ok(Answer {
        status,
        length,
        body: res.into_body(),
    })
}

const TIMED_OUT: &str = "The operation was aborted due to timeout";

/// `err.cause?.message || err.message` for a request that got no answer.
fn why(e: &Net) -> String {
    match e {
        Net::Refused(m) => m.clone(),
        Net::Failed(e) if download::is_timeout(e) => TIMED_OUT.into(),
        Net::Failed(e) => download::cause(e),
        Net::Quiet(cause) => (*cause).into(),
    }
}

/// `err.message` alone: `fetch failed` for a request that got no answer.
fn message_only(e: &Net) -> String {
    match e {
        Net::Refused(m) => m.clone(),
        Net::Failed(e) if download::is_timeout(e) => TIMED_OUT.into(),
        Net::Failed(_) | Net::Quiet(_) => "fetch failed".into(),
    }
}

/// An error a client lets through untouched (`throw err`), as the CLI shows it.
fn raw(e: &Net) -> Failure {
    match e {
        Net::Refused(m) => Failure::Internal {
            head: "Error".into(),
            message: m.clone(),
            code: None,
        },
        Net::Failed(e) if download::is_timeout(e) => Failure::Internal {
            head: "TimeoutError".into(),
            message: TIMED_OUT.into(),
            code: None,
        },
        Net::Failed(_) | Net::Quiet(_) => Failure::type_error("fetch failed"),
    }
}

/// The body read whole (`res.text()`, `res.arrayBuffer()`): a read that breaks is undici's
/// `TypeError: terminated`, or the time-out's own error.
fn body_bytes(a: Answer) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::new();
    a.body.into_reader().read_to_end(&mut out).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            Failure::Internal {
                head: "TimeoutError".into(),
                message: TIMED_OUT.into(),
                code: None,
            }
        } else {
            Failure::type_error("terminated")
        }
    })?;
    Ok(out)
}

/// `res.json()`.
fn body_json(a: Answer) -> Result<Value, Failure> {
    let bytes = body_bytes(a)?;
    crate::jsjson::parse(&download::json_text(&bytes)).map_err(Failure::syntax)
}

/// `for (const v of value)` over what an API answered: an array's items, a string's characters;
/// anything else is not iterable.
fn iterate(value: Option<&Value>, what: &str) -> Result<Vec<Value>, Failure> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| json!(c.to_string())).collect()),
        other => Err(Failure::type_error(format!(
            "{} is not iterable",
            match other {
                None => "undefined".to_string(),
                Some(Value::Null) => "null".to_string(),
                Some(_) => what.to_string(),
            }
        ))),
    }
}

fn jar_dest(jars_dir: &str, name: &Value) -> Result<(String, String), Failure> {
    let name = crate::create::path_arg(Some(name), "path")?.to_string();
    Ok((jspath::join(&[jars_dir, &name]), name))
}

fn rename(from: &Path, to: &Path) -> Result<(), Failure> {
    std::fs::rename(from, to).map_err(|e| {
        let (code, text) = jspath::error_code(&e);
        Failure::Internal {
            head: "Error".into(),
            message: format!(
                "{code}: {text}, rename '{}' -> '{}'",
                from.display(),
                to.display()
            ),
            code: Some(code.into()),
        }
    })
}

/// A body streamed into `<dest>.<pid>-<hex>.part`, hashed as it arrives; the part file is
/// dropped when the body breaks. Answers the part file, its size and the digest.
fn stream_to_part(
    a: Answer,
    dest: &Path,
    hash: Option<Hash>,
    total: u64,
) -> Result<(PathBuf, u64, Option<String>), Failure> {
    use std::io::Write;
    let tmp = download::part_path(dest);
    let mut file = std::fs::File::create(&tmp).map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
    let mut digest = hash.map(download::Hasher::new);
    let mut reader = a.body.into_reader();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        if cancel::check_cancelled().is_err() {
            drop(file);
            download::drop_part(&tmp);
            return Err(cancel::cancelled());
        }
        let n = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                drop(file);
                download::drop_part(&tmp);
                return Err(Failure::type_error("terminated"));
            }
        };
        if let Some(d) = digest.as_mut() {
            d.update(&chunk[..n]);
        }
        if let Err(e) = file.write_all(&chunk[..n]) {
            drop(file);
            download::drop_part(&tmp);
            return Err(Failure::io(&e, "write", None));
        }
        size += n as u64;
        report_bytes(size, total);
    }
    drop(file);
    Ok((tmp, size, digest.map(download::Hasher::hex)))
}

// ---------------------------------------------------------------------------------------------
// Paper and Folia: PaperMC's v3 "fill" API

fn paper_project_api(project: &str) -> String {
    format!("https://fill.papermc.io/v3/projects/{project}")
}

/// `api(url)` in paper.mjs: no time limit, and `err.message` alone in the refusal.
fn paper_api(url: &str) -> Result<Value, Failure> {
    let a = get(url, Some("application/json"), None)
        .map_err(|e| Failure::user(format!("could not reach the PaperMC API: {}", message_only(&e))))?;
    if !a.ok() {
        return Err(Failure::user(format!(
            "PaperMC API returned {} for {url}",
            a.status
        )));
    }
    body_json(a)
}

fn rc_or_pre(v: &str) -> bool {
    let l = v.to_ascii_lowercase();
    l.contains("-rc") || l.contains("-pre")
}

/// `paper.versions({ includeUnstable, project })`: newest first, release candidates and
/// pre-releases left out unless asked.
pub fn paper_versions(project: &str, include_unstable: bool) -> Result<Vec<String>, Failure> {
    let data = paper_api(&paper_project_api(project))?;
    let mut out = Vec::new();
    let groups: Vec<Value> = match data.get("versions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(m)) => m.values().cloned().collect(),
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| json!(c.to_string())).collect(),
        Some(_) => Vec::new(),
    };
    for group in groups {
        for v in iterate(Some(&group), "group")? {
            let v = js::string(Some(&v));
            if !include_unstable && rc_or_pre(&v) {
                continue;
            }
            out.push(v);
        }
    }
    Ok(out)
}

/// One build as `paper.builds` describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct PaperBuild {
    pub build: Value,
    pub channel: Value,
    pub time: Value,
    pub name: Value,
    pub url: Value,
    pub sha256: Value,
    pub size: Value,
}

/// `paper.builds(version, { project })`, newest first as the API lists them.
pub fn paper_builds(project: &str, version: &str) -> Result<Vec<PaperBuild>, Failure> {
    let url = format!(
        "{}/versions/{}/builds",
        paper_project_api(project),
        encode_uri_component(version)
    );
    let data = paper_api(&url)?;
    let Value::Array(items) = data else {
        return Err(Failure::type_error("data.map is not a function"));
    };
    let field = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
    items
        .iter()
        .map(|b| {
            if b.is_null() {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'downloads')",
                ));
            }
            let dl = b.get("downloads").and_then(|d| d.get("server:default"));
            let pick = |k: &str| dl.and_then(|d| d.get(k)).filter(|v| !v.is_null()).cloned();
            Ok(PaperBuild {
                build: field(b.get("id")),
                channel: field(b.get("channel")),
                time: field(b.get("time")),
                name: pick("name").unwrap_or(Value::Null),
                url: pick("url").unwrap_or(Value::Null),
                sha256: dl
                    .and_then(|d| d.get("checksums"))
                    .and_then(|c| c.get("sha256"))
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
                size: pick("size").unwrap_or(json!(0)),
            })
        })
        .collect()
}

fn paper_label(project: &str) -> String {
    if project == "paper" {
        return "Paper".into();
    }
    let mut c = project.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// `paper.resolveBuild(version, wanted, { project })`: the build asked for, else the newest
/// STABLE one, else the newest of any channel.
pub fn paper_resolve_build(
    project: &str,
    version: &str,
    wanted: Option<&str>,
) -> Result<PaperBuild, Failure> {
    let all = paper_builds(project, version)?;
    let label = paper_label(project);
    let Some(first) = all.first() else {
        return Err(Failure::user(format!(
            "{label} has no builds for version {version}."
        )));
    };
    if let Some(w) = wanted {
        return match all.iter().find(|b| js::string(Some(&b.build)) == w) {
            Some(hit) => Ok(hit.clone()),
            None => Err(Failure::user(format!(
                "{label} {version} has no build {w}. Newest is {}.",
                js::string(Some(&first.build))
            ))),
        };
    }
    Ok(all
        .iter()
        .find(|b| b.channel.as_str() == Some("STABLE"))
        .unwrap_or(first)
        .clone())
}

/// `paper.fetchBuild(version, wanted, { force, project })`: the jar verified against the
/// published sha256 before it gets its name, so a truncated download leaves a `.part` file
/// rather than a jar that looks stored.
pub fn paper_fetch(
    jars_dir: &str,
    project: &str,
    version: &str,
    wanted: Option<&str>,
    force: bool,
) -> Result<Fetched, Failure> {
    let build = paper_resolve_build(project, version, wanted)?;
    if !js::truthy(Some(&build.url)) {
        return Err(Failure::user(format!(
            "{project} {version} build {} publishes no server jar.",
            js::string(Some(&build.build))
        )));
    }
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let (dest, name) = jar_dest(jars_dir, &build.name)?;
    let mut out = Fetched::new(name.clone(), dest.clone(), true);
    out.build = build.build.clone();
    out.channel = build.channel.clone();
    if Path::new(&dest).exists() && !force {
        return Ok(out);
    }
    let url = js::string(Some(&build.url));
    cancel::check_cancelled()?;
    let a = get(&url, None, None).map_err(|e| raw(&e))?;
    if !a.ok_with_body() {
        return Err(Failure::user(format!("download failed ({}) for {url}", a.status)));
    }
    // `Number(content-length) || build.size || 0`
    let total = match a.length {
        n if n > 0 => n,
        _ => Some(js::number(Some(&build.size)))
            .filter(|n| n.is_finite() && *n > 0.0)
            .map_or(0, |n| n as u64),
    };
    let (tmp, _, got) = stream_to_part(a, Path::new(&dest), Some(Hash::Sha256), total)?;
    let got = got.unwrap_or_default();
    if js::truthy(Some(&build.sha256)) {
        let want = js::string(Some(&build.sha256));
        if got != want {
            let _ = std::fs::remove_file(&tmp);
            return Err(Failure::user(format!(
                "checksum mismatch for {name}\n  expected {want}\n  got      {got}"
            )));
        }
    }
    // renamed only after the hash matches
    rename(&tmp, Path::new(&dest))?;
    out.cached = false;
    out.size_human = Some(human_bytes(Some(js::number(Some(&build.size)))));
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Purpur

const PURPUR_API: &str = "https://api.purpurmc.org/v2/purpur";
const PURPUR_LABEL: &str = "the Purpur API";

/// `purpur.versions()`: newest first (the API lists oldest first).
pub fn purpur_versions() -> Result<Vec<String>, Failure> {
    let data = download::fetch_json(PURPUR_API, PURPUR_LABEL)?;
    let list = match data.get("versions") {
        None | Some(Value::Null) => Vec::new(),
        v => iterate(v, "data.versions")?,
    };
    Ok(list.iter().rev().map(|v| js::string(Some(v))).collect())
}

/// `purpur.builds(version)`: newest first, and the build the project calls latest.
pub fn purpur_builds(version: &str) -> Result<(String, Vec<Value>), Failure> {
    let data = download::fetch_json(
        &format!("{PURPUR_API}/{}", encode_uri_component(version)),
        PURPUR_LABEL,
    )?;
    let builds = data.get("builds");
    let all = match builds.and_then(|b| b.get("all")) {
        None | Some(Value::Null) => Vec::new(),
        v => iterate(v, "data.builds.all")?,
    };
    let all: Vec<Value> = all.into_iter().rev().collect();
    if all.is_empty() {
        return Err(Failure::user(format!(
            "Purpur has no builds for version {version}."
        )));
    }
    let latest = match builds.and_then(|b| b.get("latest")) {
        None | Some(Value::Null) => js::string(all.first()),
        v => js::string(v),
    };
    Ok((latest, all))
}

/// `purpur.fetchBuild(version, wanted, { force })`: checked against the md5 Purpur publishes for
/// the build.
pub fn purpur_fetch(
    jars_dir: &str,
    version: &str,
    wanted: Option<&str>,
    force: bool,
) -> Result<Fetched, Failure> {
    let (latest, all) = purpur_builds(version)?;
    let build = wanted.map(str::to_string).unwrap_or_else(|| latest.clone());
    if !all.iter().any(|b| b.as_str() == Some(build.as_str())) {
        return Err(Failure::user(format!(
            "Purpur {version} has no build {build}. Newest is {latest}."
        )));
    }
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let name = format!("purpur-{version}-{build}.jar");
    let dest = jspath::join(&[jars_dir, &name]);
    let mut out = Fetched::new(name.clone(), dest.clone(), true);
    out.build = json!(build);
    if Path::new(&dest).exists() && !force {
        return Ok(out);
    }
    let base = format!("{PURPUR_API}/{}/{build}", encode_uri_component(version));
    let detail = download::fetch_json(&base, PURPUR_LABEL)?;
    let done = download::download_file(
        &format!("{base}/download"),
        Path::new(&dest),
        download::Options {
            hash: Some(Hash::Md5),
            expected: expected_of(detail.get("md5")),
            min_bytes: 1024 * 1024,
            label: Some(name),
            on_progress: Some(&mut report_bytes),
            ..download::Options::default()
        },
    )?;
    out.cached = false;
    out.size_human = Some(done.size_human);
    Ok(out)
}

/// `expected` as `downloadFile` reads it: `String(expected)` when it is truthy.
fn expected_of(v: Option<&Value>) -> Option<String> {
    js::truthy(v).then(|| js::string(v))
}

// ---------------------------------------------------------------------------------------------
// Vanilla: Mojang's version manifest

const MOJANG_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MOJANG_LABEL: &str = "Mojang’s version manifest";

fn mojang_versions_list(data: &Value) -> Result<Vec<Value>, Failure> {
    match data.get("versions") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(Failure::type_error(
            "(data.versions ?? []).filter is not a function",
        )),
    }
}

/// `vanilla.versions({ includeSnapshots })`.
pub fn vanilla_versions(include_snapshots: bool) -> Result<Vec<String>, Failure> {
    let data = download::fetch_json(MOJANG_MANIFEST, MOJANG_LABEL)?;
    Ok(mojang_versions_list(&data)?
        .iter()
        .filter(|v| include_snapshots || v.get("type").and_then(Value::as_str) == Some("release"))
        .map(|v| js::string(v.get("id")))
        .collect())
}

/// `vanilla.fetchServer(id, { force })`: the server jar checked against Mojang's sha1. Answers
/// the Java major the version's metadata names, too.
pub fn vanilla_fetch(jars_dir: &str, id: &str, force: bool) -> Result<(Fetched, Option<f64>), Failure> {
    let manifest = download::fetch_json(MOJANG_MANIFEST, MOJANG_LABEL)?;
    let versions = match manifest.get("versions") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let Some(entry) = versions
        .iter()
        .find(|v| v.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Err(Failure::user(format!("Mojang lists no Minecraft version {id}.")));
    };
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let name = format!("vanilla-{id}.jar");
    let dest = jspath::join(&[jars_dir, &name]);
    let meta_url = js::string(entry.get("url"));
    let meta = download::fetch_json(&meta_url, &format!("the metadata for {id}"))?;
    let java_major = meta
        .get("javaVersion")
        .and_then(|j| j.get("majorVersion"))
        .and_then(Value::as_f64);
    let mut out = Fetched::new(name.clone(), dest.clone(), true);
    if Path::new(&dest).exists() && !force {
        return Ok((out, java_major));
    }
    let dl = meta.get("downloads").and_then(|d| d.get("server"));
    let url = dl.and_then(|d| d.get("url"));
    if !js::truthy(url) {
        return Err(Failure::user(format!("Minecraft {id} publishes no server jar.")));
    }
    let done = download::download_file(
        &js::string(url),
        Path::new(&dest),
        download::Options {
            hash: Some(Hash::Sha1),
            expected: expected_of(dl.and_then(|d| d.get("sha1"))),
            min_bytes: 1024 * 1024,
            label: Some(name),
            on_progress: Some(&mut report_bytes),
            ..download::Options::default()
        },
    )?;
    out.cached = false;
    out.size_human = Some(done.size_human);
    Ok((out, java_major))
}

// ---------------------------------------------------------------------------------------------
// Advanced Slime Paper: InfernalSuite's build API

const ASP_API: &str = "https://api.infernalsuite.com/v1/projects/asp";
const ASP_LABEL: &str = "the InfernalSuite API";
const ASP_SERVER_JAR: &str = "asp-server.jar";

/// `allBuilds()`: the one list of every build, fetched once per process.
pub fn asp_builds() -> Result<Value, Failure> {
    static KEPT: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
    let mut kept = KEPT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(v) = kept.as_ref() {
        return Ok(v.clone());
    }
    let v = download::fetch_json(ASP_API, ASP_LABEL)?;
    *kept = Some(v.clone());
    Ok(v)
}

fn asp_has_server_jar(b: &Value) -> bool {
    matches!(b.get("files"), Some(Value::Array(f)) if f.iter().any(|f| f.get("fileName").and_then(Value::as_str) == Some(ASP_SERVER_JAR)))
}

fn asp_mc_versions(b: &Value) -> Vec<String> {
    match b.get("mcVersion") {
        Some(Value::Array(a)) => a.iter().map(|v| js::string(Some(v))).collect(),
        _ => Vec::new(),
    }
}

fn asp_list(builds: &Value) -> Vec<Value> {
    match builds {
        Value::Array(a) => a.clone(),
        _ => Vec::new(),
    }
}

fn asp_date(b: &Value) -> f64 {
    js::number(b.get("date"))
}

/// `versionsOf(builds)`: Minecraft versions with an ASP server jar, newest first by the date of
/// each one's newest build; pre-releases left out.
pub fn asp_versions_of(builds: &Value) -> Vec<String> {
    let mut newest: Vec<(String, f64)> = Vec::new();
    for b in asp_list(builds) {
        if !asp_has_server_jar(&b) {
            continue;
        }
        for mc in asp_mc_versions(&b) {
            let l = mc.to_ascii_lowercase();
            if l.contains("-pre") || l.contains("-rc") || l.contains("-snapshot") {
                continue;
            }
            let date = asp_date(&b);
            match newest.iter_mut().find(|(m, _)| *m == mc) {
                Some(slot) => {
                    if slot.1 < date {
                        slot.1 = date;
                    }
                }
                None => {
                    if 0.0 < date {
                        newest.push((mc, date));
                    }
                }
            }
        }
    }
    newest.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    newest.into_iter().map(|(m, _)| m).collect()
}

/// `pickBuild(builds, mc)`: the newest build with a server jar for that Minecraft version.
pub fn asp_pick_build(builds: &Value, mc: &str) -> Option<Value> {
    let mut fit: Vec<Value> = asp_list(builds)
        .into_iter()
        .filter(|b| asp_has_server_jar(b) && asp_mc_versions(b).iter().any(|m| m == mc))
        .collect();
    fit.sort_by(|a, b| {
        asp_date(b)
            .partial_cmp(&asp_date(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    fit.into_iter().next()
}

fn first8(v: Option<&Value>) -> String {
    let s = js::string(v);
    String::from_utf16_lossy(&s.encode_utf16().take(8).collect::<Vec<_>>())
}

/// `compareBuilds(builds, mc, currentPrefix)`: the newest build for the version, and whether it
/// is newer than the one whose id starts with the prefix (by date; a prefix the API no longer
/// lists counts as older).
pub fn asp_compare(
    builds: &Value,
    mc: &str,
    current_prefix: &str,
) -> Result<Option<(String, String, bool)>, Failure> {
    let Some(latest) = asp_pick_build(builds, mc) else {
        return Ok(None);
    };
    let prefix = first8(latest.get("id"));
    let current = asp_list(builds)
        .into_iter()
        .find(|b| js::string(b.get("id")).starts_with(current_prefix));
    let time = crate::jsdate::to_iso(asp_date(&latest)).ok_or_else(|| Failure::Internal {
        head: "RangeError".into(),
        message: "Invalid time value".into(),
        code: None,
    })?;
    let newer = prefix != current_prefix && current.is_none_or(|c| asp_date(&latest) > asp_date(&c));
    Ok(Some((prefix, time, newer)))
}

/// `asp.fetchBuild(mc, { force })`: the newest build's server jar, checked against its sha256 and
/// renamed on the way in to carry the Minecraft version and the build.
pub fn asp_fetch(jars_dir: &str, mc: &str, force: bool) -> Result<Fetched, Failure> {
    let builds = asp_builds()?;
    let Some(build) = asp_pick_build(&builds, mc) else {
        return Err(Failure::user(format!(
            "Advanced Slime Paper has no build for Minecraft {mc}."
        )));
    };
    let file = match build.get("files") {
        Some(Value::Array(f)) => f
            .iter()
            .find(|f| f.get("fileName").and_then(Value::as_str) == Some(ASP_SERVER_JAR))
            .cloned(),
        _ => None,
    }
    .unwrap_or(Value::Null);
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let name = format!("asp-{mc}-{}.jar", first8(build.get("id")));
    let dest = jspath::join(&[jars_dir, &name]);
    let mut out = Fetched::new(name.clone(), dest.clone(), true);
    out.build = build.get("id").cloned().unwrap_or(Value::Null);
    if Path::new(&dest).exists() && !force {
        return Ok(out);
    }
    let url = format!(
        "{ASP_API}/{}/download/{}",
        js::string(build.get("id")),
        js::string(file.get("id"))
    );
    let done = download::download_file(
        &url,
        Path::new(&dest),
        download::Options {
            hash: Some(Hash::Sha256),
            expected: expected_of(file.get("sha256Hash")),
            min_bytes: 1024 * 1024,
            label: Some(name),
            on_progress: Some(&mut report_bytes),
            ..download::Options::default()
        },
    )?;
    out.cached = false;
    out.size_human = Some(done.size_human);
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Spigot and CraftBukkit: compiled here by SpigotMC's BuildTools

const BUILDTOOLS_URL: &str =
    "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar";
const SPIGOT_VERSIONS_URL: &str = "https://hub.spigotmc.org/versions/";

/// `parseVersionIndex(html)`: the Minecraft-shaped `<v>.json` names in the index (not the
/// Jenkins build numbers beside them), newest first.
pub fn parse_version_index(html: &str) -> Vec<String> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"href="([0-9]+\.[0-9]+(?:\.[0-9]+)?)\.json""#).expect("valid")
    });
    let mut seen: Vec<String> = Vec::new();
    for m in RE.captures_iter(html) {
        let v = m[1].to_string();
        if !seen.contains(&v) {
            seen.push(v);
        }
    }
    let parts = |v: &str| -> Vec<f64> {
        v.split('.')
            .map(|p| p.parse::<f64>().unwrap_or(f64::NAN))
            .collect()
    };
    seen.sort_by(|a, b| {
        let (x, y) = (parts(a), parts(b));
        for i in 0..3 {
            let d = y.get(i).copied().unwrap_or(0.0) - x.get(i).copied().unwrap_or(0.0);
            if d != 0.0 && !d.is_nan() {
                return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
            }
        }
        std::cmp::Ordering::Equal
    });
    seen
}

/// `buildtools.versions()`.
pub fn spigot_versions() -> Result<Vec<String>, Failure> {
    let a = get(SPIGOT_VERSIONS_URL, None, Some(Duration::from_secs(20)))
        .map_err(|e| Failure::user(format!("could not reach hub.spigotmc.org: {}", why(&e))))?;
    if !a.ok() {
        return Err(Failure::user(format!("hub.spigotmc.org answered {}", a.status)));
    }
    let text = body_bytes(a)?;
    Ok(parse_version_index(&String::from_utf8_lossy(&text)))
}

/// The child's two streams as they arrive, in one channel, so lines are taken in arrival order
/// across both (Node keeps one `carry` for the two).
fn spawn_readers(child: &mut std::process::Child) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let mut pipes: Vec<Box<dyn Read + Send>> = Vec::new();
    if let Some(o) = child.stdout.take() {
        pipes.push(Box::new(o));
    }
    if let Some(e) = child.stderr.take() {
        pipes.push(Box::new(e));
    }
    for mut p in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match p.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            return;
                        }
                    }
                }
            }
        });
    }
    rx
}

/// `.slice(-n)` of a string, by UTF-16 unit.
fn last_units(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let start = u.len().saturating_sub(n);
    String::from_utf16_lossy(&u[start..])
}

/// `tail.trim().split(/\r?\n/).slice(-n).join('\n')`.
fn last_lines(tail: &str, n: usize) -> String {
    let t = js::trim(tail);
    let lines: Vec<&str> = t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// How a run of a Java child ended.
struct Ran {
    /// the exit code; `None` when a signal ended it (`code` null)
    code: Option<i32>,
    cancelled: bool,
    tail: String,
}

/// Runs `java args` in `cwd` in its own group, each line of its output (trimmed, at most 160
/// UTF-16 units) handed to `on_line`, the last `keep` units of the output kept.
fn run_java(
    java: &str,
    args: &[String],
    cwd: &Path,
    keep: usize,
    mut on_line: Option<OnMessage>,
) -> Result<Result<Ran, std::io::Error>, Failure> {
    cancel::check_cancelled()?;
    let mut cmd = std::process::Command::new(java);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cancel::own_group(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: windowsHide
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Ok(Err(e)),
    };
    let stopper = cancel::stop_on_cancel(&child, true);
    let rx = spawn_readers(&mut child);
    let mut tail = String::new();
    let mut carry = String::new();
    for chunk in rx {
        let text = String::from_utf8_lossy(&chunk).into_owned();
        tail = last_units(&(tail + &text), keep);
        if let Some(f) = on_line.as_mut() {
            carry.push_str(&text);
            let mut lines: Vec<String> = carry.split('\n').map(str::to_string).collect();
            carry = lines.pop().unwrap_or_default();
            for line in lines {
                let line = line.strip_suffix('\r').unwrap_or(&line);
                let said = js::trim(line);
                if !said.is_empty() {
                    let cut: Vec<u16> = said.encode_utf16().take(160).collect();
                    f(&String::from_utf16_lossy(&cut));
                }
            }
        }
    }
    let (status, cancelled) = stopper
        .wait(&mut child)
        .map_err(|e| Failure::io(&e, "wait", None))?;
    Ok(Ok(Ran {
        code: status.code(),
        cancelled,
        tail,
    }))
}

fn code_text(code: Option<i32>) -> String {
    code.map_or_else(|| "null".into(), |c| c.to_string())
}

/// `assertJdk(java)`: `javac` beside the `java` that will run, or on PATH. A JRE cannot compile.
fn assert_jdk(java: &str) -> Result<(), Failure> {
    let javac = if java.contains('/') || java.contains('\\') {
        let exe = if cfg!(windows) { "javac.exe" } else { "javac" };
        jspath::join(&[&jspath::dirname(java), exe])
    } else {
        "javac".into()
    };
    let mut cmd = std::process::Command::new(&javac);
    cmd.arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let fine = match cmd.spawn() {
        Err(_) => false,
        Ok(mut child) => {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                match child.try_wait() {
                    Ok(Some(s)) => break s.success(),
                    Ok(None) if std::time::Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                    Err(_) => break false,
                }
            }
        }
    };
    if fine {
        Ok(())
    } else {
        Err(Failure::user(
            "BuildTools needs a JDK - javac was not found beside java. A JRE runs servers but cannot compile one; install a JDK (https://adoptium.net/temurin/releases/) and try again.",
        ))
    }
}

/// `spawn`'s error event, as a client words it: `could not run <java> to <what>` for a Java that
/// is not there, else `<prefix>: spawn <java> <CODE>`.
fn spawn_failure(e: &std::io::Error, java: &str, what: &str, prefix: &str) -> Failure {
    if jspath::is_enoent(e) {
        Failure::user(format!("could not run {java} to {what}"))
    } else {
        Failure::user(format!("{prefix}: spawn {java} {}", jspath::error_code(e).0))
    }
}

/// `buildtools.build(mc, { flavour, java, force })`: Spigot or CraftBukkit compiled by a fresh
/// BuildTools.jar, its output a line at a time.
pub fn buildtools_build(
    jars_dir: &str,
    mc: &str,
    flavour: &str,
    java: &str,
    force: bool,
    mut on_message: Option<OnMessage>,
) -> Result<Fetched, Failure> {
    if flavour != "spigot" && flavour != "craftbukkit" {
        return Err(Failure::user(format!("BuildTools does not build \"{flavour}\"")));
    }
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let name = format!("{flavour}-{mc}.jar");
    let dest = jspath::join(&[jars_dir, &name]);
    let mut say = |m: &str| {
        if let Some(f) = on_message.as_mut() {
            f(m)
        }
    };
    if Path::new(&dest).exists() && !force {
        say(&format!("Using the {name} already built"));
        return Ok(Fetched::new(name, dest, true));
    }
    assert_jdk(java)?;
    let work = jspath::join(&[jars_dir, "buildtools"]);
    let out_dir = jspath::join(&[&work, "out"]);
    crate::fsx::mkdir_all(Path::new(&out_dir))?;
    // always re-downloaded: an old BuildTools fails on a newer Minecraft with a vague error
    say("Downloading BuildTools from SpigotMC");
    download::download_file(
        BUILDTOOLS_URL,
        Path::new(&jspath::join(&[&work, "BuildTools.jar"])),
        download::Options {
            min_bytes: 100 * 1024,
            label: Some("BuildTools.jar".into()),
            ..download::Options::default()
        },
    )?;
    let mut args: Vec<String> = [
        "-jar",
        "BuildTools.jar",
        "--rev",
        mc,
        "--output-dir",
        &out_dir,
        "--final-name",
        &name,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if flavour == "craftbukkit" {
        args.push("--compile".into());
        args.push("craftbukkit".into());
    }
    say(&format!(
        "Building {flavour} {mc} - this takes several minutes the first time"
    ));
    let ran = run_java(java, &args, Path::new(&work), 4000, Some(&mut say))?.map_err(|e| {
        spawn_failure(
            &e,
            java,
            &format!("build {flavour}"),
            "BuildTools failed to start",
        )
    })?;
    let built = jspath::join(&[&out_dir, &name]);
    // a build stopped on purpose has no last words worth showing
    if ran.cancelled {
        return Err(cancel::cancelled());
    }
    if ran.code != Some(0) || !Path::new(&built).exists() {
        return Err(Failure::user(format!(
            "BuildTools exited {} without producing {name}. Its last words:\n{}",
            code_text(ran.code),
            last_lines(&ran.tail, 6)
        )));
    }
    rename(Path::new(&built), Path::new(&dest))?;
    let size = std::fs::metadata(&dest)
        .map_err(|e| Failure::io(&e, "stat", Some(Path::new(&dest))))?
        .len();
    let mut out = Fetched::new(name, dest, false);
    out.size_human = Some(human_bytes(Some(size as f64)));
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Fabric: the meta API's bundled server launcher

const FABRIC_API: &str = "https://meta.fabricmc.net/v2";

fn fabric_api(url: &str) -> Result<Value, Failure> {
    let a = get(url, Some("application/json"), Some(Duration::from_secs(15)))
        .map_err(|e| Failure::user(format!("could not reach the Fabric meta API: {}", why(&e))))?;
    if !a.ok() {
        return Err(Failure::user(format!(
            "Fabric meta API returned {} for {url}",
            a.status
        )));
    }
    body_json(a)
}

fn filter_list(v: &Value, what: &str) -> Result<Vec<Value>, Failure> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        _ => Err(Failure::type_error(format!("{what} is not a function"))),
    }
}

/// `fabric.versions()`: the stable game versions, newest first as the API lists them.
pub fn fabric_versions() -> Result<Vec<String>, Failure> {
    let all = filter_list(&fabric_api(&format!("{FABRIC_API}/versions/game"))?, "all.filter")?;
    Ok(all
        .iter()
        .filter(|v| js::truthy(v.get("stable")))
        .map(|v| js::string(v.get("version")))
        .collect())
}

fn fabric_latest_stable(pathname: &str, label: &str) -> Result<String, Failure> {
    let all = filter_list(&fabric_api(&format!("{FABRIC_API}{pathname}"))?, "all.find")?;
    let hit = all.iter().find(|v| js::truthy(v.get("stable"))).or(all.first());
    match hit {
        Some(h) => Ok(js::string(h.get("version"))),
        None => Err(Failure::user(format!("Fabric publishes no {label} versions"))),
    }
}

/// `SAFE_VERSION` and its checks (`assertSafeVersion`): a version that becomes a file name and a
/// URL path is letters, digits and `.+-_`, no `..`, at most 64 characters.
pub fn assert_safe_version(value: &str, label: &str) -> Result<String, Failure> {
    let mut chars = value.chars();
    let safe = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'));
    if !safe || value.contains("..") || value.encode_utf16().count() > 64 {
        let cut = String::from_utf16_lossy(&value.encode_utf16().take(40).collect::<Vec<_>>());
        return Err(Failure::user(format!("{label} \"{cut}\" is not a valid version")));
    }
    Ok(value.to_string())
}

/// `isInside(JARS_DIR, dest) && path.dirname(dest) === path.resolve(JARS_DIR)`.
fn lands_in(jars_dir: &str, dest: &str) -> bool {
    crate::util::is_inside(Path::new(jars_dir), Path::new(dest))
        && jspath::dirname(dest) == jspath::resolve(jars_dir)
}

/// `fabric.fetchLauncher(game, { loader, force })`: the loader is the newest stable unless one is
/// pinned (a modpack), the installer always the newest stable. Fabric publishes no checksum, so
/// a size floor stands in for one.
pub fn fabric_fetch(
    jars_dir: &str,
    game: &str,
    pinned: Option<&str>,
    force: bool,
) -> Result<Fetched, Failure> {
    assert_safe_version(game, "the Minecraft version")?;
    if let Some(p) = pinned {
        assert_safe_version(p, "the Fabric loader version")?;
    }
    // asked together, as Promise.all does; the loader's failure is the one reported
    let (loader, installer) = std::thread::scope(|s| {
        let job = cancel::current();
        let job2 = job.clone();
        let l = pinned.map(str::to_string);
        let lh = s.spawn(move || {
            cancel::with_cancel(job, || match l {
                Some(p) => Ok(p),
                None => fabric_latest_stable("/versions/loader", "loader"),
            })
        });
        let ih = s.spawn(move || {
            cancel::with_cancel(job2, || fabric_latest_stable("/versions/installer", "installer"))
        });
        let l = lh
            .join()
            .unwrap_or_else(|_| Err(Failure::type_error("the loader request failed")));
        let i = ih
            .join()
            .unwrap_or_else(|_| Err(Failure::type_error("the installer request failed")));
        (l, i)
    });
    let loader = loader?;
    let installer = installer?;
    assert_safe_version(&loader, "the Fabric loader version")?;
    assert_safe_version(&installer, "the Fabric installer version")?;
    let name = format!("fabric-server-mc.{game}-loader.{loader}-launcher.{installer}.jar");
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let dest = jspath::join(&[jars_dir, &name]);
    if !lands_in(jars_dir, &dest) {
        return Err(Failure::user(format!(
            "the Fabric launcher name \"{name}\" would land outside the jars folder"
        )));
    }
    if Path::new(&dest).exists() && !force {
        return Ok(Fetched::new(name, dest, true));
    }
    let url = format!(
        "{FABRIC_API}/versions/loader/{}/{}/{}/server/jar",
        encode_uri_component(game),
        encode_uri_component(&loader),
        encode_uri_component(&installer)
    );
    cancel::check_cancelled()?;
    let a = get(&url, None, None)
        .map_err(|e| Failure::user(format!("could not reach the Fabric meta API: {}", why(&e))))?;
    if !a.ok_with_body() {
        return Err(Failure::user(if a.status == 400 || a.status == 404 {
            format!("Fabric has no server launcher for {game} - it may not support that version.")
        } else {
            format!("download failed ({}) for {url}", a.status)
        }));
    }
    let total = a.length;
    let (tmp, size, _) = stream_to_part(a, Path::new(&dest), None, total)?;
    // no published checksum: an HTML error page saved as a jar would be tiny
    if size < 100 * 1024 {
        let _ = std::fs::remove_file(&tmp);
        return Err(Failure::user(format!(
            "the Fabric launcher download came back {}, which is not a server jar",
            human_bytes(Some(size as f64))
        )));
    }
    rename(&tmp, Path::new(&dest))?;
    let mut out = Fetched::new(name, dest, false);
    out.size_human = Some(human_bytes(Some(size as f64)));
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// NeoForge: the official installer

const NEO_MAVEN: &str = "https://maven.neoforged.net";

fn neo_api() -> String {
    format!("{NEO_MAVEN}/api/maven/versions/releases/net/neoforged/neoforge")
}

/// `mcOf(neoVersion)`: 26.2.0.75 is Minecraft 26.2 (a zero patch is dropped), 21.1.2.x is 21.1.2.
pub fn neo_mc_of(neo: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+(?:-[A-Za-z0-9_]+)?$").expect("valid")
    });
    let m = RE.captures(neo)?;
    Some(if &m[3] == "0" {
        format!("{}.{}", &m[1], &m[2])
    } else {
        format!("{}.{}.{}", &m[1], &m[2], &m[3])
    })
}

/// `pickBuild(all, mc)`: the newest build for a Minecraft version, a beta only when there is no
/// stable one (the maven lists oldest first).
pub fn neo_pick_build(all: &[String], mc: &str) -> Option<String> {
    let matches: Vec<&String> = all
        .iter()
        .filter(|v| neo_mc_of(v).as_deref() == Some(mc))
        .collect();
    let stable: Vec<&String> = matches.iter().copied().filter(|v| !v.contains('-')).collect();
    let pool = if stable.is_empty() { matches } else { stable };
    pool.last().map(|s| s.to_string())
}

fn neo_versions_raw() -> Result<Vec<Value>, Failure> {
    let a = get(&neo_api(), None, Some(Duration::from_secs(15)))
        .map_err(|e| Failure::user(format!("could not reach the NeoForge maven: {}", why(&e))))?;
    if !a.ok() {
        return Err(Failure::user(format!("the NeoForge maven answered {}", a.status)));
    }
    let data = body_json(a)?;
    match data.get("versions") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(Failure::type_error("all.filter is not a function")),
    }
}

/// `neoforge.versions()`: the Minecraft versions with a stable build, newest first.
pub fn neo_versions() -> Result<Vec<String>, Failure> {
    let mut out: Vec<String> = Vec::new();
    for v in neo_versions_raw()? {
        let v = js::string(Some(&v));
        if v.contains('-') {
            continue;
        }
        if let Some(mc) = neo_mc_of(&v)
            && !out.contains(&mc)
        {
            out.push(mc);
        }
    }
    out.reverse();
    Ok(out)
}

/// `neoforge.resolveBuild(mc, wanted)`.
pub fn neo_resolve_build(mc: &str, wanted: Option<&str>) -> Result<String, Failure> {
    let all = neo_versions_raw()?;
    if let Some(w) = wanted {
        if !all.iter().any(|v| v.as_str() == Some(w)) {
            return Err(Failure::user(format!("NeoForge has no build {w}")));
        }
        return Ok(w.to_string());
    }
    let names: Vec<String> = all.iter().filter_map(|v| v.as_str().map(String::from)).collect();
    neo_pick_build(&names, mc)
        .ok_or_else(|| Failure::user(format!("NeoForge has no build for Minecraft {mc}")))
}

/// `neoforge.fetchInstaller(neoVersion)`: the installer, checked against the `.sha256` the maven
/// publishes beside it.
pub fn neo_fetch_installer(
    jars_dir: &str,
    neo: &str,
    on_message: &mut dyn FnMut(&str),
) -> Result<Fetched, Failure> {
    assert_safe_version(neo, "the NeoForge version")?;
    crate::fsx::mkdir_all(Path::new(jars_dir))?;
    let name = format!("neoforge-{neo}-installer.jar");
    let dest = jspath::join(&[jars_dir, &name]);
    if !lands_in(jars_dir, &dest) {
        return Err(Failure::user(format!(
            "the NeoForge installer name \"{name}\" would land outside the jars folder"
        )));
    }
    if Path::new(&dest).exists() {
        return Ok(Fetched::new(name, dest, true));
    }
    let url = format!(
        "{NEO_MAVEN}/releases/net/neoforged/neoforge/{}/{}",
        encode_uri_component(neo),
        encode_uri_component(&name)
    );
    on_message(&format!("Downloading the NeoForge {neo} installer"));
    cancel::check_cancelled()?;
    let a = get(&url, None, Some(Duration::from_secs(120)))
        .map_err(|e| Failure::user(format!("could not reach the NeoForge maven: {}", why(&e))))?;
    if !a.ok() {
        return Err(Failure::user(format!(
            "installer download failed ({}) for {url}",
            a.status
        )));
    }
    let bytes = body_bytes(a).map_err(|f| match f {
        Failure::Internal { head, .. } if head == "TimeoutError" => {
            Failure::user(format!("could not reach the NeoForge maven: {TIMED_OUT}"))
        }
        _ => Failure::user("could not reach the NeoForge maven: terminated"),
    })?;
    cancel::check_cancelled()?;
    if let Ok(sha) = get(&format!("{url}.sha256"), None, Some(Duration::from_secs(30)))
        && sha.ok()
    {
        let text = body_bytes(sha)?;
        let text = String::from_utf8_lossy(&text);
        let want = js::trim(&text)
            .split(|c: char| js::is_js_space(c) || c == '\n' || c == '\r' || c == '\t')
            .next()
            .unwrap_or("")
            .to_string();
        let got = crate::sha256::hex(&bytes);
        if !want.is_empty() && got != want {
            return Err(Failure::user(
                "the installer did not match the checksum the maven publishes; nothing was installed",
            ));
        }
    }
    std::fs::write(&dest, &bytes).map_err(|e| Failure::io(&e, "open", Some(Path::new(&dest))))?;
    let mut out = Fetched::new(name, dest, false);
    out.size_human = Some(human_bytes(Some(bytes.len() as f64)));
    Ok(out)
}

/// `neoforge.installServer(dir, installerPath, { java })`: the installer lays the server down
/// (it downloads a couple of hundred MB of libraries); its log is removed on success and kept
/// on failure.
pub fn neo_install_server(
    dir: &str,
    installer: &str,
    java: &str,
    on_message: &mut dyn FnMut(&str),
) -> Result<(), Failure> {
    on_message("Installing NeoForge (this downloads its libraries and takes a few minutes)");
    let args: Vec<String> = ["-jar", installer, "--install-server", dir, "--server-jar"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let ran = run_java(java, &args, Path::new(dir), 2000, None)?
        .map_err(|e| spawn_failure(&e, java, "install NeoForge", "NeoForge install failed"))?;
    if ran.cancelled {
        return Err(cancel::cancelled());
    }
    if ran.code == Some(0) && Path::new(&jspath::join(&[dir, "server.jar"])).exists() {
        let log = jspath::join(&[dir, &format!("{}.log", jspath::basename(installer))]);
        let _ = std::fs::remove_file(log);
        return Ok(());
    }
    Err(Failure::user(format!(
        "the NeoForge installer exited {}. Its last words:\n{}",
        code_text(ran.code),
        last_lines(&ran.tail, 4)
    )))
}

// ---------------------------------------------------------------------------------------------
// sources.mjs

/// What `neoforge.createServer` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct NeoMade {
    pub neo_version: String,
    pub mc: Option<String>,
    pub port: f64,
}

/// The `new --neoforge` options `cmdNew` passes along.
#[derive(Debug, Clone, Default)]
pub struct NeoOptions {
    pub java: String,
    pub memory: Value,
    pub port: Option<f64>,
    pub online_mode: bool,
}

/// `neoforge.createServer(name, mc, opts)`: the build resolved, the installer fetched, the server
/// made (EULA accepted) and the installer run in its folder; a failed install removes the
/// server again and reports the install's error.
pub fn neo_create_server(
    layout: &crate::settings::Layout,
    by: &crate::activity::Actor,
    name: &str,
    mc: &str,
    o: NeoOptions,
    on_message: &mut dyn FnMut(&str),
) -> Result<NeoMade, Failure> {
    let neo = neo_resolve_build(mc, None)?;
    let installer = neo_fetch_installer(&layout.jars_dir, &neo, on_message)?;
    // nothing of the server exists yet; from here a cancel is a failed install, which removes it
    cancel::check_cancelled()?;
    let made = crate::create::new_instance(
        layout,
        by,
        name,
        crate::create::NewOptions {
            java: json!(o.java),
            loader: "neoforge".into(),
            jar: Value::Null,
            mc_version: neo_mc_of(&neo),
            memory: Some(o.memory),
            port: o.port,
            online_mode: o.online_mode,
            accept_eula: true,
            ..crate::create::NewOptions::default()
        },
    )?;
    let dir = made.text("dir");
    let installed =
        neo_install_server(&dir, &installer.path, &made.text("java"), on_message).and_then(|()| {
            let mut patch = serde_json::Map::new();
            patch.insert("jar".into(), json!("server.jar"));
            crate::registry::update_instance(Path::new(&layout.registry_file), name, &patch).map(|_| ())
        });
    if let Err(e) = installed {
        // the original error is the one worth reporting
        if crate::registry::remove_instance(Path::new(&layout.registry_file), name).is_ok() {
            remove_tree_patiently(Path::new(&dir));
        }
        return Err(e);
    }
    Ok(NeoMade {
        mc: neo_mc_of(&neo),
        neo_version: neo,
        port: made.port,
    })
}

/// `fs.rmSync(dir, { recursive, force, maxRetries: 10, retryDelay: 100 })`: the installer was
/// writing here a moment ago, and Windows lets go of a folder slowly.
fn remove_tree_patiently(dir: &Path) {
    for attempt in 0..=10 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 10 => std::thread::sleep(Duration::from_millis(100 * (attempt + 1))),
            Err(_) => return,
        }
    }
}

/// The software whose server is one jar fetched into the store (`JAR_IDS`); NeoForge is
/// installed instead.
pub const JAR_IDS: [&str; 8] = [
    "paper",
    "purpur",
    "folia",
    "asp",
    "spigot",
    "craftbukkit",
    "vanilla",
    "fabric",
];

/// `isJarSource(id)`.
pub fn is_jar_source(id: &str) -> bool {
    JAR_IDS.contains(&id)
}

/// `sources.versionsFor(id)`: the versions a kind of server can be made for, newest first.
pub fn versions_for(id: &str) -> Result<Vec<String>, Failure> {
    match id {
        "neoforge" => neo_versions(),
        "paper" | "folia" => paper_versions(id, false),
        "purpur" => purpur_versions(),
        "asp" => Ok(asp_versions_of(&asp_builds()?)),
        "vanilla" => vanilla_versions(false),
        "spigot" | "craftbukkit" => spigot_versions(),
        "fabric" => fabric_versions(),
        other => Err(Failure::Internal {
            head: "Error".into(),
            message: format!("no version list for \"{other}\""),
            code: None,
        }),
    }
}

/// `sources.labelFor(id)`: what a kind of server is called.
pub fn label_for(id: &str) -> &'static str {
    match id {
        "paper" => "Paper",
        "purpur" => "Purpur",
        "folia" => "Folia",
        "asp" => "Advanced Slime Paper",
        "spigot" => "Spigot",
        "craftbukkit" => "CraftBukkit",
        "vanilla" => "Vanilla",
        "fabric" => "Fabric",
        _ => "NeoForge",
    }
}

/// What a jar fetch says while it runs: `onProgress` of `sources.fetchJar`, which is byte counts
/// for a download, a line of text for a build, and `cached` when the jar was already stored.
#[derive(Debug, Clone, PartialEq)]
pub enum JarProgress {
    /// `{ cached: true }`, with the message a build gives it
    Cached(Option<String>),
    /// `{ message }`
    Message(String),
    /// `{ received, total }`; a total of 0 is unknown
    Bytes { received: u64, total: u64 },
}

/// Who hears a download's progress.
type Hears = std::rc::Rc<dyn Fn(JarProgress)>;

thread_local! {
    /// Who hears the bytes of the download this thread is in ([`fetch_jar_reporting`]).
    static BYTES: std::cell::RefCell<Option<Hears>> = const { std::cell::RefCell::new(None) };
}

fn report_bytes(received: u64, total: u64) {
    let hears = BYTES.with(|b| b.borrow().clone());
    if let Some(f) = hears {
        f(JarProgress::Bytes { received, total });
    }
}

/// [`fetch_jar`] with everything `onProgress` is told, for a caller that shows a progress bar.
pub fn fetch_jar_reporting(
    jars_dir: &str,
    id: &str,
    version: &str,
    build: Option<&str>,
    java: &str,
    report: std::rc::Rc<dyn Fn(JarProgress)>,
) -> Result<Fetched, Failure> {
    // put back however the fetch ends
    struct Heard(Option<std::rc::Rc<dyn Fn(JarProgress)>>);
    impl Drop for Heard {
        fn drop(&mut self) {
            BYTES.with(|b| *b.borrow_mut() = self.0.take());
        }
    }
    let _heard = Heard(BYTES.with(|b| b.borrow_mut().replace(report.clone())));
    let built = id == "spigot" || id == "craftbukkit";
    let mut said = |m: &str| {
        // BuildTools says so itself when the jar is already built
        if m.starts_with("Using the ") && m.ends_with(" already built") {
            report(JarProgress::Cached(Some(m.to_string())));
        } else {
            report(JarProgress::Message(m.to_string()));
        }
    };
    let out = fetch_jar(jars_dir, id, version, build, java, Some(&mut said))?;
    if out.cached && !built {
        report(JarProgress::Cached(None));
    }
    Ok(out)
}

/// `sources.fetchJar(id, version, { build, java, onProgress })`.
pub fn fetch_jar(
    jars_dir: &str,
    id: &str,
    version: &str,
    build: Option<&str>,
    java: &str,
    on_message: Option<OnMessage>,
) -> Result<Fetched, Failure> {
    match id {
        "paper" | "folia" => paper_fetch(jars_dir, id, version, build, false),
        "purpur" => purpur_fetch(jars_dir, version, build, false),
        "asp" => asp_fetch(jars_dir, version, false),
        "vanilla" => vanilla_fetch(jars_dir, version, false).map(|(f, _)| f),
        "spigot" | "craftbukkit" => buildtools_build(jars_dir, version, id, java, false, on_message),
        "fabric" => fabric_fetch(jars_dir, version, None, false),
        other => Err(Failure::type_error(format!(
            "\"{other}\" is not fetched as a jar"
        ))),
    }
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` percent-encoded as UTF-8.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_components_are_encoded_as_javascript_does() {
        assert_eq!(encode_uri_component("1.21.4"), "1.21.4");
        assert_eq!(encode_uri_component("a b/c?é"), "a%20b%2Fc%3F%C3%A9");
        assert_eq!(encode_uri_component("x!~*'()"), "x!~*'()");
    }

    #[test]
    fn the_spigot_index_lists_minecraft_versions_newest_first() {
        let html = r#"<a href="1.21.4.json">x</a><a href="4647.json"></a><a href="1.21.json"></a><a href="1.9.json"></a><a href="1.21.10.json"></a><a href="latest.json"></a><a href="1.21.4.json"></a>"#;
        assert_eq!(
            parse_version_index(html),
            vec!["1.21.10", "1.21.4", "1.21", "1.9"]
        );
    }

    #[test]
    fn neoforge_versions_name_their_minecraft() {
        assert_eq!(neo_mc_of("26.2.0.75").as_deref(), Some("26.2"));
        assert_eq!(neo_mc_of("21.1.2.15-beta").as_deref(), Some("21.1.2"));
        assert_eq!(neo_mc_of("21.1"), None);
        let all: Vec<String> = ["21.1.0.1", "21.1.0.2-beta", "21.1.0.3", "21.2.0.1-beta"]
            .map(String::from)
            .to_vec();
        assert_eq!(neo_pick_build(&all, "21.1").as_deref(), Some("21.1.0.3"));
        assert_eq!(neo_pick_build(&all, "21.2").as_deref(), Some("21.2.0.1-beta"));
        assert_eq!(neo_pick_build(&all, "1.20"), None);
    }

    #[test]
    fn safe_versions() {
        assert!(assert_safe_version("1.21.4", "v").is_ok());
        assert!(assert_safe_version("0.16.10+build.1", "v").is_ok());
        assert!(assert_safe_version("_x", "v").is_ok());
        assert!(assert_safe_version("-x", "v").is_err());
        assert!(assert_safe_version("1..2", "v").is_err());
        assert!(assert_safe_version("1/2", "v").is_err());
        assert!(assert_safe_version("é", "v").is_err());
        assert!(assert_safe_version(&"1".repeat(65), "v").is_err());
        assert_eq!(
            assert_safe_version(&format!("{}/", "a".repeat(50)), "the x")
                .unwrap_err()
                .message(),
            format!("the x \"{}\" is not a valid version", "a".repeat(40))
        );
    }

    #[test]
    fn asp_versions_and_builds() {
        let builds = json!([
            { "id": "aaaaaaaa1111", "date": 10, "mcVersion": ["1.21.4", "1.21.5-pre1"], "files": [{ "fileName": "asp-server.jar", "id": "f1" }] },
            { "id": "bbbbbbbb2222", "date": 30, "mcVersion": ["1.21.3"], "files": [{ "fileName": "asp-server.jar", "id": "f2" }] },
            { "id": "cccccccc3333", "date": 20, "mcVersion": ["1.21.4"], "files": [{ "fileName": "plugin.jar", "id": "f3" }] },
            { "id": "dddddddd4444", "date": 15, "mcVersion": ["1.21.4"], "files": [{ "fileName": "asp-server.jar", "id": "f4" }] }
        ]);
        assert_eq!(asp_versions_of(&builds), vec!["1.21.3", "1.21.4"]);
        assert_eq!(asp_pick_build(&builds, "1.21.4").unwrap()["id"], "dddddddd4444");
        let (b, _, newer) = asp_compare(&builds, "1.21.4", "aaaaaaaa").unwrap().unwrap();
        assert_eq!(b, "dddddddd");
        assert!(newer);
        assert!(!asp_compare(&builds, "1.21.4", "dddddddd").unwrap().unwrap().2);
        assert!(asp_compare(&builds, "1.21.4", "zzzzzzzz").unwrap().unwrap().2);
    }
}
