//! `client-java.mjs`: Mojang's Java runtimes, laid out under `client/runtime/<component>/<platform>`
//! from Mojang's index and each component's manifest, with `runtime/index.json` recording what is
//! there. The files are the Node core's too: either core finishes or repairs what the other began.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde_json::{Map, Value, json};

use super::install::{Fetch, OnProgress, Progress};
use super::paths::Paths;
use super::{nullish, prop, read_json};
use crate::cancel;
use crate::failure::Failure;
use crate::{js, jsjson, jspath};

/// Mojang's index of its Java runtimes, as the official launcher reads it.
pub const RUNTIME_INDEX_URL: &str = "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const PARALLEL: usize = 8;

fn user(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

/// `platformKey(osName, arch)`: the index's name for a machine, `None` where Mojang builds nothing.
pub fn platform_key(os_name: &str, arch: &str) -> Option<&'static str> {
    Some(match (os_name, arch) {
        ("windows", "x64") => "windows-x64",
        ("windows", "arm64") => "windows-arm64",
        ("windows", "x86") => "windows-x86",
        ("osx", "x64") => "mac-os",
        ("osx", "arm64") => "mac-os-arm64",
        ("linux", "x64") => "linux",
        ("linux", "x86") => "linux-i386",
        _ => return None,
    })
}

fn platform_text(platform: &str) -> &str {
    match platform {
        "windows-x64" => "Windows x64",
        "windows-arm64" => "Windows arm64",
        "windows-x86" => "Windows x86",
        "mac-os" => "macOS x64",
        "mac-os-arm64" => "macOS arm64",
        "linux" => "Linux x64",
        "linux-i386" => "Linux x86",
        other => other,
    }
}

pub fn runtime_dir(paths: &Paths, component: &str, platform: &str) -> String {
    jspath::join(&[&paths.runtime_dir(), component, platform])
}

fn manifest_file(paths: &Paths, component: &str, platform: &str) -> String {
    jspath::join(&[&paths.runtime_dir(), component, &format!("{platform}.manifest.json")])
}

fn index_file(paths: &Paths) -> String {
    jspath::join(&[&paths.runtime_dir(), "index.json"])
}

/// `/^[a-z0-9][a-z0-9-]{0,63}$/`.
fn plain(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `/^[0-9a-f]{40}$/.test(String(v))`.
fn sha1_like(v: Option<&Value>) -> bool {
    let s = js::string(v);
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn https_like(v: Option<&Value>) -> bool {
    js::string(v).starts_with("https://")
}

/// `fetchRuntimeIndex({ force })`: kept a day in the cache folder.
pub fn fetch_runtime_index(paths: &Paths, force: bool, fetch: super::meta::FetchJson<'_>) -> Result<Value, Failure> {
    let mut o = super::meta::Cached::new("Mojang's Java runtime list", force);
    o.max_age_ms = 24.0 * 3_600_000.0;
    o.fetch = fetch;
    super::meta::cached_json(&paths.cache_dir(), "java-runtime-all.json", RUNTIME_INDEX_URL, o)
}

/// One component on one platform in Mojang's index.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub sha1: String,
    pub size: Value,
    pub url: String,
    pub version: String,
}

/// `runtimeEntry(all, component, platform)`: `None` when Mojang publishes none there.
pub fn runtime_entry(all: &Value, component: &str, platform: &str) -> Result<Option<Entry>, Failure> {
    let row = prop(prop(prop(Some(all), platform), component), "0");
    let row = match prop(Some(all), platform).and_then(|p| prop(Some(p), component)) {
        Some(Value::Array(a)) => a.first(),
        Some(Value::String(s)) => {
            // a text's [0] is its first character, which has no manifest
            return if s.is_empty() {
                Ok(None)
            } else {
                Err(user(format!(
                    "Mojang's Java runtime list has a malformed entry for {component} on {platform}"
                )))
            };
        }
        _ => row,
    };
    if !js::truthy(row) {
        return Ok(None);
    }
    let m = prop(row, "manifest");
    if !js::truthy(m) || !sha1_like(prop(m, "sha1")) || !https_like(prop(m, "url")) {
        return Err(user(format!(
            "Mojang's Java runtime list has a malformed entry for {component} on {platform}"
        )));
    }
    let name = prop(prop(row, "version"), "name");
    Ok(Some(Entry {
        sha1: js::string(prop(m, "sha1")),
        size: match prop(m, "size") {
            v if nullish(v) => Value::Null,
            v => v.cloned().unwrap_or(Value::Null),
        },
        url: js::string(prop(m, "url")),
        version: if nullish(name) { String::new() } else { js::string(name) },
    }))
}

/// One file of a runtime.
#[derive(Debug, Clone, PartialEq)]
pub struct Download {
    pub rel: String,
    pub url: String,
    pub sha1: String,
    pub size: Option<f64>,
    pub executable: bool,
}

/// `runtimePlan(manifest, { platform })`.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub dirs: Vec<String>,
    pub downloads: Vec<Download>,
    pub links: Vec<(String, String)>,
    pub java: String,
    pub count: usize,
}

/// `path.posix.normalize(p)` for a relative path, as far as the link check needs it.
fn posix_normalize(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." if out.last().is_some_and(|l| *l != "..") => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    if out.is_empty() { ".".into() } else { out.join("/") }
}

fn posix_dirname(p: &str) -> &str {
    match p.rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => ".",
    }
}

/// `runtimePlan(manifest, { platform })`: what a manifest asks for, checked before anything is
/// written.
pub fn runtime_plan(manifest: &Value, platform: &str) -> Result<Plan, Failure> {
    let entries: Vec<(String, Value)> = match prop(Some(manifest), "files") {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(Value::Array(a)) => {
            a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()
        }
        _ => return Err(user(format!("the Java runtime manifest for {platform} lists no files"))),
    };
    let windows = platform.starts_with("windows");
    let (mut dirs, mut downloads, mut links) = (Vec::new(), Vec::new(), Vec::new());
    for (name, entry) in &entries {
        let Some(rel) = crate::util::safe_relative_path(name) else {
            return Err(user(format!(
                "the Java runtime manifest names \"{}\", which would land outside its folder",
                super::library::cut(name, 80)
            )));
        };
        let kind = prop(Some(entry), "type");
        if kind == Some(&json!("directory")) {
            dirs.push(rel);
        } else if kind == Some(&json!("file")) {
            let raw = prop(prop(Some(entry), "downloads"), "raw");
            if !js::truthy(raw) {
                return Err(coded(
                    format!("the Java runtime manifest offers \"{rel}\" only compressed, which SpawnLoft cannot unpack. Update SpawnLoft."),
                    "runtime-format",
                ));
            }
            if !sha1_like(prop(raw, "sha1")) || !https_like(prop(raw, "url")) {
                return Err(user(format!(
                    "the Java runtime manifest has no usable download for \"{rel}\""
                )));
            }
            let size = prop(raw, "size")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && n.fract() == 0.0);
            downloads.push(Download {
                rel,
                url: js::string(prop(raw, "url")),
                sha1: js::string(prop(raw, "sha1")),
                size,
                executable: prop(Some(entry), "executable") == Some(&Value::Bool(true)),
            });
        } else if kind == Some(&json!("link")) {
            if windows {
                return Err(coded(
                    format!("the Java runtime manifest for {platform} has a link (\"{rel}\"), which SpawnLoft does not make on Windows. Update SpawnLoft."),
                    "runtime-format",
                ));
            }
            let t = prop(Some(entry), "target");
            let target = if nullish(t) { String::new() } else { js::string(t) };
            let resolved = posix_normalize(&format!("{}/{target}", posix_dirname(&rel)));
            if target.is_empty()
                || target.starts_with('/')
                || target.contains('\0')
                || resolved == ".."
                || resolved.starts_with("../")
            {
                return Err(user(format!(
                    "the Java runtime manifest links \"{rel}\" to \"{}\", outside its folder",
                    super::library::cut(&target, 80)
                )));
            }
            links.push((rel, target));
        } else {
            return Err(coded(
                format!("the Java runtime manifest has an entry of a kind SpawnLoft does not know (\"{rel}\"). Update SpawnLoft."),
                "runtime-format",
            ));
        }
    }
    // nothing is written through a link
    let linked: std::collections::HashSet<&str> = links.iter().map(|(r, _)| r.as_str()).collect();
    let all = dirs
        .iter()
        .chain(downloads.iter().map(|d| &d.rel))
        .chain(links.iter().map(|(r, _)| r));
    for rel in all {
        let parts: Vec<&str> = rel.split('/').collect();
        for i in 1..parts.len() {
            let under = parts[..i].join("/");
            if linked.contains(under.as_str()) {
                return Err(user(format!(
                    "the Java runtime manifest puts \"{rel}\" under the link \"{under}\""
                )));
            }
        }
    }
    let exe = if windows { "bin/java.exe" } else { "bin/java" };
    let mut candidates: Vec<&Download> = downloads
        .iter()
        .filter(|d| d.rel == exe || d.rel.ends_with(&format!("/{exe}")))
        .collect();
    // shortest first, ties in manifest order (a stable sort by UTF-16 length)
    candidates.sort_by_key(|d| d.rel.encode_utf16().count());
    let Some(java) = candidates.first() else {
        return Err(user(format!("the Java runtime manifest for {platform} has no {exe}")));
    };
    if !windows && !java.executable {
        return Err(coded(
            format!("the Java runtime manifest for {platform} does not mark {} executable", java.rel),
            "runtime-format",
        ));
    }
    Ok(Plan {
        java: java.rel.clone(),
        dirs,
        downloads,
        links,
        count: entries.len(),
    })
}

/// `readRuntimeIndex()`.
fn read_index(paths: &Paths) -> Result<Map<String, Value>, Failure> {
    let index = read_json(&index_file(paths))?;
    match index {
        Some(Value::Object(m)) if matches!(m.get("runtimes"), Some(Value::Object(_) | Value::Array(_))) => Ok(m),
        _ => {
            let mut m = Map::new();
            m.insert("runtimes".into(), json!({}));
            Ok(m)
        }
    }
}

fn runtimes(index: &mut Map<String, Value>) -> &mut Map<String, Value> {
    // an array as runtimes takes keys as an object would; it is written back as an object
    if let Some(Value::Array(a)) = index.get("runtimes") {
        let m: Map<String, Value> = a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect();
        index.insert("runtimes".into(), Value::Object(m));
    }
    match index.get_mut("runtimes") {
        Some(Value::Object(m)) => m,
        _ => unreachable!("read_index makes runtimes an object"),
    }
}

/// `updateRuntimeIndex(change)`: a read-modify-write under the index's own lock.
fn update_index(paths: &Paths, change: impl FnOnce(&mut Map<String, Value>) -> bool) -> Result<(), Failure> {
    let dir = paths.runtime_dir();
    crate::fsx::mkdir_all(Path::new(&dir))?;
    let lock_file = jspath::join(&[&dir, "index.lock"]);
    let held = crate::lock::acquire(Path::new(&lock_file), crate::lock::Options::default())
        .map_err(|e| super::profiles::lock_failure(&e))?;
    let res = (|| {
        let mut index = read_index(paths)?;
        if change(runtimes(&mut index)) {
            let file = index_file(paths);
            let mut b = [0u8; 4];
            let _ = getrandom::fill(&mut b);
            let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
            let tmp = format!("{file}.{}.{hex}.tmp", std::process::id());
            let t = Path::new(&tmp);
            std::fs::write(t, jsjson::stringify_pretty(&Value::Object(index)))
                .map_err(|e| Failure::io(&e, "open", Some(t)))?;
            crate::fsx::rename_over(t, Path::new(&file))
                .map_err(|e| crate::fsx::rename_failure(&e, t, Path::new(&file)))?;
        }
        Ok(())
    })();
    drop(held);
    res
}

/// `installedRuntimes()`.
pub fn installed(paths: &Paths) -> Result<Vec<Value>, Failure> {
    let mut index = read_index(paths)?;
    Ok(runtimes(&mut index).values().cloned().collect())
}

/// `runtimeDamage(component, platform)`: the entries missing or the wrong size, `["the
/// manifest"]` with no local manifest.
pub fn runtime_damage(paths: &Paths, component: &str, platform: &str) -> Result<Vec<String>, Failure> {
    let Some(manifest) = read_json(&manifest_file(paths, component, platform))? else {
        return Ok(vec!["the manifest".into()]);
    };
    if !js::truthy(Some(&manifest)) {
        return Ok(vec!["the manifest".into()]);
    }
    let plan = runtime_plan(&manifest, platform)?;
    let dir = runtime_dir(paths, component, platform);
    let mut bad = Vec::new();
    for d in &plan.downloads {
        let ok = std::fs::metadata(jspath::join(&[&dir, &d.rel]))
            .is_ok_and(|m| d.size.is_none_or(|s| m.len() as f64 == s));
        if !ok {
            bad.push(d.rel.clone());
        }
    }
    for (rel, _) in &plan.links {
        if std::fs::symlink_metadata(jspath::join(&[&dir, rel])).is_err() {
            bad.push(rel.clone());
        }
    }
    Ok(bad)
}

fn sha1_of(file: &str) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    Some(crate::sha1::hex(&bytes))
}

fn rm_file(p: &str) -> Result<(), Failure> {
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            // a folder in the way goes too, as rmSync({ force, recursive }) would take it
            if std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
                return std::fs::remove_dir_all(p).map_err(|e| Failure::io(&e, "rm", Some(Path::new(p))));
            }
            Err(Failure::io(&e, "rm", Some(Path::new(p))))
        }
        _ => Ok(()),
    }
}

/// What `ensureRuntime` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Ensured {
    pub java_path: String,
    pub version: String,
    pub downloaded: usize,
}

/// `ensureRuntime(component, platform, { entry, onProgress })`: the runtime laid out or brought
/// back to whole; with no entry (offline) one laid out earlier serves after its size check.
pub fn ensure_runtime(
    paths: &Paths,
    component: &str,
    platform: &str,
    entry: Option<&Entry>,
    fetch: Fetch<'_>,
    on_progress: OnProgress<'_>,
) -> Result<Ensured, Failure> {
    if !plain(component) || !plain(platform) {
        return Err(user(format!(
            "\"{component}\" on \"{platform}\" is not a Java runtime SpawnLoft can lay out"
        )));
    }
    let key = format!("{component}/{platform}");
    let dir = runtime_dir(paths, component, platform);
    crate::fsx::mkdir_all(Path::new(&jspath::dirname(&dir)))?;
    let lock_file = jspath::join(&[&paths.runtime_dir(), component, &format!("{platform}.lock")]);
    let held = crate::lock::acquire(Path::new(&lock_file), crate::lock::Options::wait(15 * 60_000))
        .map_err(|e| super::profiles::lock_failure(&e))?;
    let res = ensure_locked(paths, component, platform, &key, &dir, entry, fetch, on_progress);
    drop(held);
    res
}

#[allow(clippy::too_many_arguments)]
fn ensure_locked(
    paths: &Paths,
    component: &str,
    platform: &str,
    key: &str,
    dir: &str,
    entry: Option<&Entry>,
    fetch: Fetch<'_>,
    on_progress: OnProgress<'_>,
) -> Result<Ensured, Failure> {
    let mut index = read_index(paths)?;
    let recorded = runtimes(&mut index).get(key).cloned().filter(|v| !v.is_null());
    let m_file = manifest_file(paths, component, platform);
    let where_ = platform_text(platform);
    let Some(want) = entry.map(|e| json!(e.sha1)).or_else(|| {
        recorded.as_ref().map(|r| prop(Some(r), "manifestSha1").cloned().unwrap_or(Value::Null))
    }) else {
        return Err(coded(
            format!("Mojang's Java runtime list could not be read, and {component} for {where_} is not downloaded yet"),
            "runtime-offline",
        ));
    };
    let mut text = std::fs::read(&m_file)
        .ok()
        .filter(|t| Value::String(crate::sha1::hex(t)) == want);
    if text.is_none() {
        let Some(e) = entry else {
            return Err(coded(
                format!("the Java runtime {component} for {where_} is damaged, and Mojang's runtime list could not be read to repair it"),
                "runtime-offline",
            ));
        };
        fetch(&e.url, Path::new(&m_file), Some(&e.sha1), &format!("the {component} manifest"))?;
        text = Some(std::fs::read(&m_file).map_err(|err| Failure::read(&err, Path::new(&m_file)))?);
    }
    let manifest = jsjson::parse(&String::from_utf8_lossy(&text.unwrap_or_default())).map_err(Failure::syntax)?;
    let plan = runtime_plan(&manifest, platform)?;

    let recorded_sha1 = recorded.as_ref().and_then(|r| prop(Some(r), "manifestSha1").cloned());
    // a new manifest replaces the record before any file changes
    if recorded.is_some() && recorded_sha1.as_ref() != Some(&want) {
        update_index(paths, |r| {
            r.shift_remove(key);
            true
        })?;
    }
    crate::fsx::mkdir_all(Path::new(dir))?;
    for rel in &plan.dirs {
        crate::fsx::mkdir_all(Path::new(&jspath::join(&[dir, rel])))?;
    }

    // a launch checks sizes; a new or first manifest checks every file's sha1
    let thorough = recorded_sha1.as_ref() != Some(&want);
    let mut todo = Vec::new();
    for d in &plan.downloads {
        let dest = jspath::join(&[dir, &d.rel]);
        if !crate::util::is_inside(Path::new(dir), Path::new(&dest)) {
            return Err(user(format!(
                "the Java runtime manifest names \"{}\", which would land outside its folder",
                d.rel
            )));
        }
        let fits = std::fs::symlink_metadata(&dest).is_ok_and(|m| {
            m.is_file() && d.size.is_none_or(|s| m.len() as f64 == s)
        }) && (!thorough || sha1_of(&dest).as_deref() == Some(d.sha1.as_str()));
        if !fits {
            todo.push(d.clone());
        }
    }

    let total = todo.len();
    let progress = Mutex::new((0usize, 0f64));
    if total > 0 {
        on_progress(&Progress { phase: "java", done: 0, total, bytes: 0.0 });
    }
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let first: Mutex<Option<Failure>> = Mutex::new(None);
    let job = cancel::current();
    std::thread::scope(|s| {
        for _ in 0..PARALLEL.min(total) {
            let job = job.clone();
            s.spawn(|| {
                cancel::with_cancel(job, || {
                    while !failed.load(Ordering::SeqCst) {
                        let Some(d) = todo.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                        let dest = jspath::join(&[dir, &d.rel]);
                        let one = (|| {
                            crate::fsx::mkdir_all(Path::new(&jspath::dirname(&dest)))?;
                            rm_file(&dest)?;
                            fetch(&d.url, Path::new(&dest), Some(&d.sha1), &format!("{component} {}", d.rel))?;
                            if let Some(size) = d.size
                                && std::fs::metadata(&dest).map_or(true, |m| m.len() as f64 != size)
                            {
                                rm_file(&dest)?;
                                return Err(user(format!("{component} {} came back the wrong size", d.rel)));
                            }
                            Ok(())
                        })();
                        if let Err(e) = one {
                            failed.store(true, Ordering::SeqCst);
                            first.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert(e);
                            break;
                        }
                        let mut p = progress.lock().unwrap_or_else(|p| p.into_inner());
                        p.0 += 1;
                        p.1 += d.size.unwrap_or(0.0);
                        on_progress(&Progress { phase: "java", done: p.0, total, bytes: p.1 });
                    }
                });
            });
        }
    });
    if let Some(e) = first.into_inner().unwrap_or_else(|p| p.into_inner()) {
        return Err(e);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in &plan.downloads {
            let p = jspath::join(&[dir, &d.rel]);
            let mode = if d.executable { 0o755 } else { 0o644 };
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode))
                .map_err(|e| Failure::io(&e, "chmod", Some(Path::new(&p))))?;
        }
        for (rel, target) in &plan.links {
            let at = jspath::join(&[dir, rel]);
            if std::fs::read_link(&at).is_ok_and(|t| t.to_string_lossy() == target.as_str()) {
                continue;
            }
            crate::fsx::mkdir_all(Path::new(&jspath::dirname(&at)))?;
            match std::fs::symlink_metadata(&at) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&at),
                Ok(_) => std::fs::remove_file(&at),
                Err(_) => Ok(()),
            }
            .map_err(|e| Failure::io(&e, "rm", Some(Path::new(&at))))?;
            std::os::unix::fs::symlink(target, &at)
                .map_err(|e| Failure::io(&e, "symlink", Some(Path::new(target))))?;
        }
    }

    let missing = runtime_damage(paths, component, platform)?;
    if !missing.is_empty() {
        let three: Vec<&str> = missing.iter().take(3).map(String::as_str).collect();
        return Err(user(format!(
            "the Java runtime {component} is incomplete after download ({})",
            three.join(", ")
        )));
    }
    let lexists = |rel: &str| std::fs::symlink_metadata(jspath::join(&[dir, rel])).is_ok();
    let present = plan.dirs.iter().filter(|r| lexists(r)).count()
        + plan.downloads.iter().filter(|d| lexists(&d.rel)).count()
        + plan.links.iter().filter(|(r, _)| lexists(r)).count();
    if present != plan.count {
        return Err(user(format!(
            "the Java runtime {component} has {present} of the {} entries its manifest lists",
            plan.count
        )));
    }

    let version = match (entry, &recorded) {
        (Some(e), _) => e.version.clone(),
        (None, Some(r)) => match prop(Some(r), "version") {
            v if nullish(v) => String::new(),
            v => js::string(v),
        },
        (None, None) => String::new(),
    };
    let record = super::object(vec![
        ("component", Some(json!(component))),
        ("platform", Some(json!(platform))),
        ("version", Some(json!(version))),
        ("javaPath", Some(json!(plan.java))),
        ("manifestSha1", Some(want)),
    ]);
    update_index(paths, |r| {
        if r.get(key).map(jsjson::stringify) == Some(jsjson::stringify(&record)) {
            return false;
        }
        r.insert(key.to_string(), record.clone());
        true
    })?;
    Ok(Ensured {
        java_path: jspath::join(&[dir, &plan.java]),
        version,
        downloaded: total,
    })
}

/// `mojangJava({ component, major, osName, arch })`: the java of Mojang's runtime for this
/// machine, laid out as needed: (path, version).
#[allow(clippy::too_many_arguments)]
pub fn mojang_java(
    paths: &Paths,
    component: &str,
    major: f64,
    os_name: &str,
    arch: &str,
    fetch: Fetch<'_>,
    list_fetch: super::meta::FetchJson<'_>,
    on_progress: OnProgress<'_>,
) -> Result<(String, String), Failure> {
    let Some(platform) = platform_key(os_name, arch) else {
        return Err(coded(
            format!("Mojang publishes no Java for {os_name} {arch}"),
            "no-runtime-for-this-machine",
        ));
    };
    let all = fetch_runtime_index(paths, false, list_fetch).ok();
    let entry = match &all {
        Some(all) => match runtime_entry(all, component, platform)? {
            Some(e) => Some(e),
            None => {
                return Err(coded(
                    format!(
                        "Mojang publishes no Java {} ({component}) for {}",
                        js::number_to_string(major),
                        platform_text(platform)
                    ),
                    "no-runtime-for-this-machine",
                ));
            }
        },
        None => None,
    };
    let r = ensure_runtime(paths, component, platform, entry.as_ref(), fetch, on_progress)?;
    Ok((r.java_path, r.version))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel: &str, exe: bool) -> (String, Value) {
        (
            rel.into(),
            json!({ "type": "file", "executable": exe, "downloads": { "raw": { "sha1": "a".repeat(40), "size": 3, "url": "https://x/y" } } }),
        )
    }

    fn manifest(entries: Vec<(String, Value)>) -> Value {
        json!({ "files": Value::Object(entries.into_iter().collect()) })
    }

    #[test]
    fn plan_finds_the_shortest_java_and_refuses_escapes() {
        let m = manifest(vec![
            ("jre.bundle".into(), json!({ "type": "directory" })),
            file("jre.bundle/Contents/Home/bin/java", true),
            file("x/bin/java", true),
            ("lib/link".into(), json!({ "type": "link", "target": "../x" })),
        ]);
        let p = runtime_plan(&m, "mac-os").unwrap();
        assert_eq!(p.java, "x/bin/java");
        assert_eq!(p.count, 4);
        let bad = manifest(vec![file("bin/java", true), ("l".into(), json!({ "type": "link", "target": "../../etc" }))]);
        assert!(runtime_plan(&bad, "linux").unwrap_err().message().contains("outside its folder"));
        let under = manifest(vec![
            file("bin/java", true),
            ("l".into(), json!({ "type": "link", "target": "bin" })),
            file("l/x", false),
        ]);
        assert!(runtime_plan(&under, "linux").unwrap_err().message().contains("under the link"));
        let win = manifest(vec![file("bin/java.exe", false), ("l".into(), json!({ "type": "link", "target": "bin" }))]);
        assert_eq!(runtime_plan(&win, "windows-x64").unwrap_err().json_code(), "runtime-format");
        let not_exe = manifest(vec![file("bin/java", false)]);
        assert_eq!(runtime_plan(&not_exe, "linux").unwrap_err().json_code(), "runtime-format");
        assert!(runtime_plan(&json!({}), "linux").is_err());
        assert!(runtime_plan(&manifest(vec![file("../java", true)]), "linux").is_err());
    }

    #[test]
    fn entries_and_platforms() {
        assert_eq!(platform_key("linux", "arm64"), None);
        assert_eq!(platform_key("osx", "arm64"), Some("mac-os-arm64"));
        let all = json!({ "linux": { "java-runtime-gamma": [{ "manifest": { "sha1": "b".repeat(40), "url": "https://m/x.json", "size": 9 }, "version": { "name": "17.0.8" } }], "jre-legacy": [] } });
        let e = runtime_entry(&all, "java-runtime-gamma", "linux").unwrap().unwrap();
        assert_eq!((e.version.as_str(), e.size.clone()), ("17.0.8", json!(9)));
        assert_eq!(runtime_entry(&all, "jre-legacy", "linux").unwrap(), None);
        assert_eq!(runtime_entry(&all, "nope", "mac-os").unwrap(), None);
        let bad = json!({ "linux": { "c": [{ "manifest": { "sha1": "x", "url": "https://m" } }] } });
        assert!(runtime_entry(&bad, "c", "linux").is_err());
    }

    #[test]
    fn posix_normalize_matches_node() {
        assert_eq!(posix_normalize("./../x"), "../x");
        assert_eq!(posix_normalize("a/b/../../.."), "..");
        assert_eq!(posix_normalize("a/./b//c"), "a/b/c");
        assert_eq!(posix_normalize("a/.."), ".");
    }
}
