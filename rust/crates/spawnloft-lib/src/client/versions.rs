//! The version checks and lists of client.mjs: `assertVersionId` (a version this machine can
//! get), `checkProfileVersion` (and its loader builds for it), and `listVersions` as `spawnloft
//! client versions` reads it.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::loaders::{self, Lists};
use super::meta::{FetchJson, fetch_manifest};
use super::paths::Paths;
use super::version::{is_safe_version_id, version_kind};
use super::{prop, read_json};
use crate::failure::Failure;
use crate::js;

fn coded(message: String, code: &str) -> Failure {
    Failure::User {
        message,
        code: Some(code.into()),
    }
}

/// `trimMc(mc)`: typed ids are trimmed.
pub fn trim_mc(mc: &Value) -> Value {
    match mc {
        Value::String(s) => json!(js::trim(s)),
        other => other.clone(),
    }
}

/// `validateMc(mc)`: the shape of a version id.
pub fn validate_mc(mc: &Value) -> Result<String, Failure> {
    let Value::String(s) = mc else {
        return Err(Failure::user("the Minecraft version must be text, like 26.3"));
    };
    if !is_safe_version_id(s) {
        let units: Vec<u16> = s.encode_utf16().take(64).collect();
        return Err(Failure::user(format!(
            "invalid Minecraft version {} - versions look like 26.3, 26.4-snapshot-6 or b1.7.3",
            crate::jsjson::quote(&String::from_utf16_lossy(&units))
        )));
    }
    Ok(s.clone())
}

fn read_props_error(of: &Value, key: &str) -> Failure {
    Failure::type_error(format!(
        "Cannot read properties of {} (reading '{key}')",
        if of.is_null() { "null" } else { "undefined" }
    ))
}

/// `m.versions ?? []` as an array of rows, failing as `.some` / `.map` would on anything else.
fn manifest_rows<'a>(m: &'a Value, method: &str) -> Result<Vec<&'a Value>, Failure> {
    if m.is_null() {
        return Err(read_props_error(m, "versions"));
    }
    match prop(Some(m), "versions") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(rows)) => Ok(rows.iter().collect()),
        Some(_) => Err(Failure::type_error(format!(
            "(m.versions ?? []).{method} is not a function"
        ))),
    }
}

fn row_id(v: &Value) -> Result<Option<&Value>, Failure> {
    if v.is_null() {
        return Err(read_props_error(v, "id"));
    }
    Ok(prop(Some(v), "id"))
}

fn listed(m: &Value, mc: &str) -> Result<bool, Failure> {
    for v in manifest_rows(m, "some")? {
        if row_id(v)? == Some(&json!(mc)) {
            return Ok(true);
        }
    }
    Ok(false)
}

static STEM_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^.\- ]*[.\- ]?$").expect("valid"));

/// `nearIds(mc, manifest)`: up to five listed ids that start like the typed one.
fn near_ids(mc: &str, manifest: &Value) -> String {
    let ids: Vec<String> = manifest_rows(manifest, "map")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| prop(Some(v), "id").and_then(Value::as_str).map(String::from))
        .collect();
    let mut stem = mc.to_lowercase();
    let mut near: Vec<&String> = Vec::new();
    while !stem.is_empty() && near.is_empty() {
        near = ids
            .iter()
            .filter(|id| id.to_lowercase().starts_with(&stem))
            .collect();
        stem = STEM_TAIL.replace(&stem, "").into_owned();
    }
    if near.is_empty() {
        String::new()
    } else {
        let five: Vec<&str> = near.iter().take(5).map(|s| s.as_str()).collect();
        format!(". Did you mean {}?", five.join(", "))
    }
}

/// What `assertVersionId` found: the trimmed id, the manifest when it was read, the type.
#[derive(Debug, Clone)]
pub struct Known {
    pub mc: String,
    pub manifest: Option<Value>,
    pub kind: Option<String>,
}

/// `assertVersionId(typed)`: downloaded already, or in Mojang's list. An id the cached list
/// lacks asks Mojang again once, then is refused with the nearest ids.
pub fn assert_version_id(paths: &Paths, typed: &Value, fetch: FetchJson<'_>) -> Result<Known, Failure> {
    let mc = validate_mc(&trim_mc(typed))?;
    // a vanilla version on disk, not a loader profile's id
    let on_disk = read_json(&paths.version_json(&mc))?;
    if let Some(d) = &on_disk
        && js::truthy(Some(d))
        && !js::truthy(prop(Some(d), "inheritsFrom"))
        && prop(Some(d), "id") == Some(&json!(mc))
    {
        let kind = match prop(Some(d), "type") {
            v if super::nullish(v) => Some("release".to_string()),
            v => Some(js::string(v)),
        };
        return Ok(Known {
            mc,
            manifest: None,
            kind,
        });
    }
    let Ok(mut manifest) = fetch_manifest(paths, false, fetch) else {
        return Err(Failure::user(format!(
            "the Minecraft version list is not available offline and \"{mc}\" is not downloaded"
        )));
    };
    if !listed(&manifest, &mc)? {
        manifest = fetch_manifest(paths, true, fetch)?;
    }
    if !listed(&manifest, &mc)? {
        return Err(coded(
            format!(
                "Mojang's version list has no \"{mc}\"; check the id (releases look like 26.3, snapshots like 26.4-snapshot-6, old versions like b1.7.3){}",
                near_ids(&mc, &manifest)
            ),
            "unknown-version",
        ));
    }
    let kind = manifest_rows(&manifest, "find")?
        .into_iter()
        .find(|v| prop(Some(v), "id") == Some(&json!(mc)))
        .and_then(|v| prop(Some(v), "type"))
        .map(|t| js::string(Some(t)));
    Ok(Known {
        mc,
        manifest: Some(manifest),
        kind,
    })
}

/// `loaderFor(id)`: an id with no module is a mistake in the caller, thrown as an Error.
fn loader_module(loader: &Value) -> Result<Option<String>, Failure> {
    match loader {
        Value::Null => Ok(None),
        Value::String(s) if s == "vanilla" => Ok(None),
        Value::String(s) if loaders::MODS.contains(&s.as_str()) => Ok(Some(s.clone())),
        other => Err(Failure::Internal {
            head: "Error".into(),
            message: format!("unknown loader \"{}\"", js::string(Some(other))),
            code: None,
        }),
    }
}

/// `checkProfileVersion({ mc, loader })`: the version exists, and its loader builds for it.
pub fn check_profile_version(
    paths: &Paths,
    mc: &Value,
    loader: Option<&Value>,
    fetch: FetchJson<'_>,
) -> Result<String, Failure> {
    let known = assert_version_id(paths, mc, fetch)?;
    let loader = loader.cloned().unwrap_or(json!("vanilla"));
    if let Some(id) = loader_module(&loader)? {
        let kind = version_kind(&known.mc, known.kind.as_deref());
        loaders::assert_available(paths, &id, &known.mc, kind, fetch)?;
    }
    Ok(known.mc)
}

// ---- the list --------------------------------------------------------------------------------

/// One row of `listVersions` as `client versions` uses it.
#[derive(Debug, Clone, PartialEq)]
pub struct VersionRow {
    pub id: String,
    pub kind_raw: Option<Value>,
    pub kind: &'static str,
    pub release_time: Option<Value>,
    pub downloaded: bool,
    pub loaders: Map<String, Value>,
}

/// `listVersions(...)`'s `offline` and `versions`.
#[derive(Debug, Clone)]
pub struct Listing {
    pub offline: Option<String>,
    pub versions: Vec<VersionRow>,
}

struct Installed {
    id: String,
    json: Value,
    downloaded: bool,
}

/// `installedVersions()`: each vanilla version on disk, and whether its jar has the size its
/// JSON names.
fn installed_versions(paths: &Paths) -> Result<Vec<Installed>, Failure> {
    let Ok(ids) = crate::fsx::readdir_names(std::path::Path::new(&paths.versions_dir())) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for id in ids.into_iter().filter(|id| is_safe_version_id(id)) {
        let Ok(bytes) = std::fs::read(paths.version_json(&id)) else {
            continue;
        };
        let Ok(json) = crate::jsjson::parse(&String::from_utf8_lossy(&bytes)) else {
            continue;
        };
        if json.is_null() {
            return Err(read_props_error(&json, "inheritsFrom"));
        }
        if js::truthy(prop(Some(&json), "inheritsFrom")) {
            continue;
        }
        let jar = std::fs::metadata(paths.version_jar(&id))
            .ok()
            .map(|m| m.len() as f64);
        let downloads = prop(Some(&json), "downloads");
        let client = if super::nullish(downloads) {
            None
        } else {
            prop(downloads, "client")
        };
        let want = if super::nullish(client) {
            None
        } else {
            prop(client, "size")
        };
        let downloaded = match (jar, want) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(size), Some(w)) => w.as_f64() == Some(size),
        };
        out.push(Installed { id, json, downloaded });
    }
    Ok(out)
}

fn parse_time(v: Option<&Value>) -> f64 {
    let t = match v {
        None | Some(Value::Null) => f64::NAN,
        other => crate::jsdate::parse(&js::string(other)),
    };
    if t.is_nan() { 0.0 } else { t }
}

/// `listVersions({ fabric: true, refresh })`, the parts `client versions` prints. The machine's
/// own refusal, the Java hints and the harness column are the launcher's and come with it.
pub fn list_versions(paths: &Paths, refresh: bool, fetch: FetchJson<'_>) -> Result<Listing, Failure> {
    let installed = installed_versions(paths)?;
    // the lists side by side: each fetch may take its full timeout on a slow network
    let (mojang, lists): (Result<Value, Failure>, Lists) = std::thread::scope(|s| {
        let m = s.spawn(|| fetch_manifest(paths, refresh, fetch));
        let l = s.spawn(|| loaders::loader_lists(paths, refresh, fetch));
        let h = s.spawn(|| super::harness_index::refresh_default(paths, refresh));
        let lists = l.join().unwrap_or_default();
        let _ = h.join();
        (
            m.join()
                .unwrap_or_else(|_| Err(Failure::user("the version list could not be read"))),
            lists,
        )
    });
    let (manifest, offline) = match mojang {
        Ok(m) => (Some(m), None),
        Err(e) => (
            None,
            Some(format!(
                "the Minecraft version list could not be read ({}), so only downloaded versions are listed",
                e.message()
            )),
        ),
    };
    // (id, type, releaseTime) of each row the list starts from
    let source: Vec<(String, Option<Value>, Option<Value>)> = match &manifest {
        Some(m) => {
            if m.is_null() {
                return Err(read_props_error(m, "versions"));
            }
            let Some(Value::Array(rows)) = prop(Some(m), "versions") else {
                return Err(Failure::type_error(match prop(Some(m), "versions") {
                    None => "Cannot read properties of undefined (reading 'filter')".to_string(),
                    Some(_) => "manifest.versions.filter is not a function".to_string(),
                }));
            };
            let mut out = Vec::new();
            for v in rows {
                if let Some(Value::String(id)) = row_id(v)?
                    && is_safe_version_id(id)
                {
                    out.push((
                        id.clone(),
                        prop(Some(v), "type").cloned(),
                        prop(Some(v), "releaseTime").cloned(),
                    ));
                }
            }
            out
        }
        None => installed
            .iter()
            .map(|i| {
                let t = match prop(Some(&i.json), "type") {
                    v if super::nullish(v) => json!("release"),
                    v => super::or_null(v),
                };
                let r = match prop(Some(&i.json), "releaseTime") {
                    v if super::nullish(v) => Value::Null,
                    v => super::or_null(v),
                };
                (i.id.clone(), Some(t), Some(r))
            })
            .collect(),
    };
    let mut versions: Vec<VersionRow> = source
        .into_iter()
        .map(|(id, kind_raw, release_time)| {
            let downloaded = installed.iter().any(|i| i.id == id && i.downloaded);
            let kind = version_kind(&id, kind_raw.as_ref().and_then(Value::as_str));
            let loaders = loaders::loaders_for(&id, &lists);
            let release_time = match release_time {
                None | Some(Value::Null) => None,
                v => v,
            };
            VersionRow {
                id,
                kind_raw,
                kind,
                release_time,
                downloaded,
                loaders,
            }
        })
        .collect();
    // newest first, by release time; a row without one keeps its place at the end
    versions.sort_by(|a, b| {
        let d = parse_time(b.release_time.as_ref()) - parse_time(a.release_time.as_ref());
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(Listing { offline, versions })
}

/// Which rows a `show` of `release`, `snapshot` or `all` keeps.
pub fn shown(rows: &[VersionRow], show: &str, limit: usize) -> Vec<VersionRow> {
    rows.iter()
        .filter(|v| {
            let t = v.kind_raw.as_ref().and_then(Value::as_str);
            match show {
                "all" => true,
                "snapshot" => matches!(t, Some("release" | "snapshot")),
                _ => t == Some("release"),
            }
        })
        .take(limit)
        .cloned()
        .collect()
}

/// `versionTableRows(versions, { show, limit })`.
pub fn table_rows(rows: &[VersionRow], show: &str, limit: usize) -> Vec<Vec<String>> {
    let mark = |v: Option<&Value>| match v {
        Some(Value::Bool(true)) => "yes".to_string(),
        Some(Value::Bool(false)) => String::new(),
        _ => "?".to_string(),
    };
    let mut out = vec![{
        let mut h = vec!["Version".to_string(), "Type".to_string()];
        h.extend(loaders::MODS.iter().map(|l| loaders::display_name(l).to_string()));
        h.push("Downloaded".into());
        h
    }];
    for v in shown(rows, show, limit) {
        let mut r = vec![v.id.clone(), v.kind.to_string()];
        r.extend(loaders::MODS.iter().map(|l| mark(v.loaders.get(*l))));
        r.push(if v.downloaded { "yes".into() } else { String::new() });
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_ids_walk_back_the_stem() {
        let m = json!({ "versions": [{ "id": "1.21.11" }, { "id": "1.21.10" }, { "id": "1.20.1" }] });
        assert_eq!(near_ids("1.21.99", &m), ". Did you mean 1.21.11, 1.21.10?");
        assert_eq!(near_ids("1.19", &m), ". Did you mean 1.21.11, 1.21.10, 1.20.1?");
        assert_eq!(near_ids("x", &m), "");
    }

    #[test]
    fn mc_shapes() {
        assert_eq!(
            validate_mc(&json!(" 1.21 ")).unwrap_err().message(),
            "invalid Minecraft version \" 1.21 \" - versions look like 26.3, 26.4-snapshot-6 or b1.7.3"
        );
        assert_eq!(validate_mc(&trim_mc(&json!(" 1.21 "))).unwrap(), "1.21");
        assert!(validate_mc(&json!(true)).is_err());
    }
}
