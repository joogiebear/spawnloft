//! The rest of `plugins.mjs` (C5 part 3): searching Modrinth and Hangar, installing a plugin or
//! mod from either, the install plan with everything a build needs, the update check and the
//! update itself. The panel and the MCP server call these (C8, C9); no CLI command does.
//!
//! Answers are JSON values with Node's keys in Node's order, and a key whose value JavaScript
//! holds as `undefined` is left out, as `JSON.stringify` leaves it out.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::modrinth::{self, Request, includes, items, modrinth_request, pick_version, primary_file, prop};
use crate::plugins::{self, content_kind_for, list_plugins, loaders_for, plugins_dir, read_managed};
use crate::registry::Instance;
use crate::{js, jspath};

pub const HANGAR: &str = "https://hangar.papermc.io/api/v1";

// ---------------------------------------------------------------------------------------------
// JavaScript's reads

/// `base?.key`: `None` for undefined; a null or a value that is not an object reads as undefined.
fn opt<'a>(base: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match base {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// `a ?? b` on a read.
fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

fn or_nullish<'a>(v: Option<&'a Value>, other: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(v) { other } else { v }
}

/// Sets `key` unless the value is `undefined`.
fn put(m: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        m.insert(key.to_string(), v.clone());
    }
}

/// `String(x)`.
fn s(v: Option<&Value>) -> String {
    js::string(v)
}

/// What a project id or slug can be: `/^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/`. It goes into the path
/// of a request to Modrinth or Hangar.
pub fn is_project_id(id: &str) -> bool {
    let n = id.chars().count();
    (1..=64).contains(&n)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && !id.chars().all(|c| c == '.')
}

/// `nameKey(name)`: "Fabric API", "fabric-api" and "FabricAPI" are one thing.
pub fn name_key(name: Option<&Value>) -> String {
    let text = if nullish(name) { String::new() } else { s(name) };
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// `/^[^\\/]+\.jar$/`.
fn is_jar_name(name: &str) -> bool {
    name.strip_suffix(".jar")
        .is_some_and(|stem| !stem.is_empty() && !stem.contains(['\\', '/']))
}

/// `listedVersions(list)`: what a build says it is for, the last 60.
fn listed_versions(list: Option<&Value>) -> Value {
    match list {
        Some(Value::Array(a)) => {
            let all: Vec<Value> = a.iter().map(|v| json!(s(Some(v)))).collect();
            let from = all.len().saturating_sub(60);
            Value::Array(all[from..].to_vec())
        }
        _ => json!([]),
    }
}

/// `list.slice(-1)[0] ?? null` on `(x ?? [])`.
fn last_of(list: Option<&Value>) -> Result<Value, Failure> {
    match list {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::Array(a)) => Ok(a.last().filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null)),
        Some(Value::String(t)) => {
            let units: Vec<u16> = t.encode_utf16().collect();
            Ok(units
                .last()
                .map(|u| json!(String::from_utf16_lossy(&[*u])))
                .unwrap_or(Value::Null))
        }
        Some(_) => Err(Failure::type_error(
            "(intermediate value).slice is not a function",
        )),
    }
}

/// `hangarClaims(version)`: the newest Minecraft version a Hangar build says it supports.
fn hangar_claims(version: &Value) -> Result<Value, Failure> {
    last_of(opt(opt(Some(version), "platformDependencies"), "PAPER"))
}

/// `modrinthClaims(version)`: `version.game_versions?.[version.game_versions.length - 1] ?? null`.
fn modrinth_claims(version: &Value) -> Value {
    match version.get("game_versions") {
        Some(Value::Array(a)) => a.last().filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        Some(Value::String(t)) => {
            let units: Vec<u16> = t.encode_utf16().collect();
            units
                .last()
                .map(|u| json!(String::from_utf16_lossy(&[*u])))
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

fn form(pairs: &[(&str, &str)]) -> String {
    crate::client::http::form(pairs)
}

fn encode(s: &str) -> String {
    crate::sources::encode_uri_component(s)
}

fn loaders_json(loaders: &[&str]) -> String {
    crate::jsjson::stringify(&json!(loaders))
}

// ---------------------------------------------------------------------------------------------
// Searching

fn hits_of(data: &Value) -> Result<&[Value], Failure> {
    items(prop(Some(data), "hits")?, "map", "data.hits")
}

/// `searchPlugins(query, { limit, loaders, projectType })`. Not filtered by game version: sparse
/// metadata would hide much of the ecosystem.
pub fn search_plugins(
    query: &str,
    limit: u32,
    loaders: &[&str],
    project_type: &str,
) -> Result<Vec<Value>, Failure> {
    let facets = json!([
        [format!("project_type:{project_type}")],
        loaders
            .iter()
            .map(|l| format!("categories:{l}"))
            .collect::<Vec<_>>(),
    ]);
    let params = form(&[
        ("query", query),
        ("facets", &crate::jsjson::stringify(&facets)),
        ("limit", &limit.to_string()),
        ("index", "relevance"),
    ]);
    let data = modrinth_request(&format!("/search?{params}"), None)?;
    let mut out = Vec::new();
    for h in hits_of(&data)? {
        let mut m = Map::new();
        m.insert("source".into(), json!("modrinth"));
        put(&mut m, "id", prop(Some(h), "project_id")?);
        put(&mut m, "slug", prop(Some(h), "slug")?);
        put(&mut m, "title", prop(Some(h), "title")?);
        put(&mut m, "description", prop(Some(h), "description")?);
        put(&mut m, "downloads", prop(Some(h), "downloads")?);
        let icon = prop(Some(h), "icon_url")?;
        m.insert(
            "icon".into(),
            if js::truthy(icon) {
                icon.cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        );
        out.push(Value::Object(m));
    }
    Ok(out)
}

/// `searchModpacks(query, { limit })`: packs a server can be built from (server side not
/// unsupported, on Fabric or NeoForge).
pub fn search_modpacks(query: &str, limit: u32) -> Result<Vec<Value>, Failure> {
    let facets = json!([
        ["project_type:modpack"],
        ["server_side:required", "server_side:optional"],
        ["categories:fabric", "categories:neoforge"],
    ]);
    let params = form(&[
        ("query", query),
        ("facets", &crate::jsjson::stringify(&facets)),
        ("limit", &limit.to_string()),
        ("index", "relevance"),
    ]);
    let data = modrinth_request(&format!("/search?{params}"), None)?;
    let mut out = Vec::new();
    for h in hits_of(&data)? {
        let mut m = Map::new();
        m.insert("source".into(), json!("modrinth"));
        put(&mut m, "id", prop(Some(h), "project_id")?);
        put(&mut m, "slug", prop(Some(h), "slug")?);
        put(&mut m, "title", prop(Some(h), "title")?);
        put(&mut m, "description", prop(Some(h), "description")?);
        put(&mut m, "downloads", prop(Some(h), "downloads")?);
        out.push(Value::Object(m));
    }
    Ok(out)
}

/// `hangar(pathname)`: a GET with a 15 s limit, parsed as JSON.
pub fn hangar_request(pathname: &str) -> Result<Value, Failure> {
    let url = format!("{HANGAR}{pathname}");
    let reply = modrinth::send(&Request {
        method: "GET",
        url: &url,
        user_agent: modrinth::PLUGINS_UA,
        json_body: None,
        timeout: Duration::from_secs(15),
        manual_redirects: false,
    })
    .map_err(|e| Failure::user(format!("could not reach Hangar: {}", e.why())))?;
    if !reply.ok() {
        return Err(Failure::user(format!(
            "Hangar answered {} for {pathname}",
            reply.status
        )));
    }
    modrinth::read_json(reply)
}

/// `data.result ?? []`, read as an array.
fn result_of<'a>(data: &'a Value, method: &str) -> Result<&'a [Value], Failure> {
    let r = prop(Some(data), "result")?;
    if nullish(r) {
        return Ok(&[]);
    }
    items(r, method, "(data.result ?? [])")
}

/// `searchHangar(query, { limit })`.
pub fn search_hangar(query: &str, limit: u32) -> Result<Vec<Value>, Failure> {
    let params = form(&[("q", query), ("limit", &limit.to_string()), ("platform", "PAPER")]);
    let data = hangar_request(&format!("/projects?{params}"))?;
    let mut out = Vec::new();
    for p in result_of(&data, "map")? {
        let ns = prop(Some(p), "namespace")?;
        let name = prop(Some(p), "name")?;
        let slug = or_nullish(opt(ns, "slug"), name);
        let mut m = Map::new();
        m.insert("source".into(), json!("hangar"));
        put(&mut m, "id", slug);
        put(&mut m, "slug", slug);
        put(&mut m, "title", name);
        let d = prop(Some(p), "description")?;
        m.insert(
            "description".into(),
            if js::truthy(d) {
                d.cloned().unwrap_or(Value::Null)
            } else {
                json!("")
            },
        );
        let downloads = opt(prop(Some(p), "stats")?, "downloads");
        m.insert(
            "downloads".into(),
            if nullish(downloads) {
                json!(0)
            } else {
                downloads.cloned().unwrap_or(Value::Null)
            },
        );
        let owner = opt(ns, "owner");
        m.insert(
            "author".into(),
            if nullish(owner) {
                Value::Null
            } else {
                owner.cloned().unwrap_or(Value::Null)
            },
        );
        out.push(Value::Object(m));
    }
    Ok(out)
}

/// What [`pick_hangar_version`] picked.
#[derive(Debug, Clone, PartialEq)]
pub struct HangarPick {
    pub version: Value,
    pub exact_match: bool,
}

/// `pickHangarVersion(versions, { gameVersion })`: a Release with a Paper file and an exact
/// game-version match, then any channel, then the newest downloadable (not an exact match).
pub fn pick_hangar_version(
    versions: &Value,
    game_version: Option<&str>,
) -> Result<Option<HangarPick>, Failure> {
    let list = items(Some(versions), "find", "versions")?;
    let game_version = game_version.filter(|g| !g.is_empty());
    let downloadable = |v: &Value| -> Result<bool, Failure> {
        let paper = opt(prop(Some(v), "downloads")?, "PAPER");
        let url = opt(paper, "downloadUrl");
        Ok(js::truthy(url) && js::truthy(opt(paper, "fileInfo")))
    };
    let exact = |v: &Value| -> Result<bool, Failure> {
        let Some(g) = game_version else { return Ok(true) };
        let paper = opt(prop(Some(v), "platformDependencies")?, "PAPER");
        if nullish(paper) {
            return Ok(false);
        }
        includes(paper, g, "(v.platformDependencies?.PAPER ?? [])")
    };
    let release = |v: &Value| -> Result<bool, Failure> {
        Ok(opt(prop(Some(v), "channel")?, "name").and_then(Value::as_str) == Some("Release"))
    };
    let mut pick = None;
    for v in list {
        if release(v)? && downloadable(v)? && exact(v)? {
            pick = Some(v);
            break;
        }
    }
    if pick.is_none() {
        for v in list {
            if downloadable(v)? && exact(v)? {
                pick = Some(v);
                break;
            }
        }
    }
    if pick.is_none() {
        for v in list {
            if downloadable(v)? {
                pick = Some(v);
                break;
            }
        }
    }
    let Some(v) = pick else { return Ok(None) };
    Ok(Some(HangarPick {
        version: v.clone(),
        exact_match: exact(v)?,
    }))
}

/// `hangarVersions(slug)`.
fn hangar_versions(slug: &str) -> Result<Value, Failure> {
    let data = hangar_request(&format!(
        "/projects/{}/versions?limit=25&platform=PAPER",
        encode(slug)
    ))?;
    // `data.result ?? []` as it came: what is not an array fails in pickHangarVersion's `find`
    let r = prop(Some(&data), "result")?;
    Ok(if nullish(r) {
        json!([])
    } else {
        r.cloned().unwrap_or(Value::Null)
    })
}

// ---------------------------------------------------------------------------------------------
// Installing

/// `fetch(url, { signal: AbortSignal.timeout(120000) })` and `res.arrayBuffer()`.
fn fetch_jar(url: &str) -> Result<Vec<u8>, Failure> {
    let reply = modrinth::send(&Request {
        method: "GET",
        url,
        user_agent: modrinth::NODE_UA,
        json_body: None,
        timeout: Duration::from_secs(120),
        manual_redirects: false,
    })
    .map_err(|e| Failure::user(format!("download failed: {}", e.why())))?;
    if !reply.ok() {
        return Err(Failure::user(format!("download failed: {}", reply.status)));
    }
    modrinth::read_all(reply)
}

/// `fs.mkdirSync(pluginsDir(inst), { recursive: true })`, made before the file name is judged.
fn make_plugins_dir(inst: &Instance) -> Result<String, Failure> {
    let dir = plugins_dir(inst)?;
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(std::path::Path::new(&dir))))?;
    Ok(dir)
}

fn write_jar(dir: &str, name: &str, bytes: &[u8]) -> Result<(), Failure> {
    let file = jspath::join(&[dir, name]);
    std::fs::write(&file, bytes).map_err(|e| Failure::io(&e, "open", Some(std::path::Path::new(&file))))
}

/// `installFromHangar(inst, slug, { gameVersion })`.
pub fn install_from_hangar(
    inst: &Instance,
    slug: &str,
    game_version: Option<&str>,
) -> Result<Value, Failure> {
    if !is_project_id(slug) {
        return Err(Failure::user("that is not a project id"));
    }
    let versions = hangar_versions(slug)?;
    let Some(picked) = pick_hangar_version(&versions, game_version)? else {
        let external = versions
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| opt(opt(opt(Some(v), "downloads"), "PAPER"), "externalUrl"))
            .find(|u| js::truthy(*u))
            .flatten();
        return Err(Failure::user(match external {
            Some(u) => format!(
                "that project hosts its downloads elsewhere: {}\n  Download it by hand and drop it into the plugins folder - SpawnLoft will leave it alone.",
                s(Some(u))
            ),
            None => "that project has no downloadable Paper build on Hangar".into(),
        }));
    };
    let version = &picked.version;
    let dl = opt(opt(Some(version), "downloads"), "PAPER");
    let bytes = fetch_jar(&s(opt(dl, "downloadUrl")))?;
    let info = opt(dl, "fileInfo");
    let want = prop(info, "sha256Hash")?;
    if js::truthy(want) {
        let got = crate::sha256::hex(&bytes);
        if want.and_then(Value::as_str) != Some(got.as_str()) {
            return Err(Failure::user(
                "the download did not match the checksum Hangar published; nothing was installed",
            ));
        }
    }
    let dir = make_plugins_dir(inst)?;
    let named = prop(info, "name")?;
    let name = jspath::basename(&if js::truthy(named) {
        s(named)
    } else {
        format!("{slug}.jar")
    });
    if !is_jar_name(&name) {
        return Err(Failure::user(format!(
            "Hangar offered a file named \"{name}\", which is not a plugin jar"
        )));
    }
    write_jar(&dir, &name, &bytes)?;
    let paper = opt(opt(Some(version), "platformDependencies"), "PAPER");
    let mut meta = Map::new();
    meta.insert("source".into(), json!("hangar"));
    meta.insert("project".into(), json!(slug));
    put(&mut meta, "version", version.get("name"));
    meta.insert("installedAt".into(), json!(crate::time::iso_now()));
    meta.insert("gameVersions".into(), listed_versions(paper));
    plugins::record_managed(inst, &name, Value::Object(meta))?;
    let note = match game_version.filter(|g| !g.is_empty()) {
        Some(g) if !picked.exact_match => {
            let claim = last_of(if nullish(paper) { None } else { paper })?;
            json!(format!(
                "Hangar lists support for {}, not {g} - it will probably run, but that is its author's claim, not SpawnLoft's.",
                if claim.is_null() {
                    "other versions".to_string()
                } else {
                    s(Some(&claim))
                }
            ))
        }
        _ => Value::Null,
    };
    let mut out = Map::new();
    out.insert("installed".into(), json!(name));
    put(&mut out, "version", version.get("name"));
    out.insert("size".into(), json!(bytes.len()));
    out.insert("versionNote".into(), note);
    Ok(Value::Object(out))
}

fn versions_path(id: &str, loaders: &[&str]) -> String {
    format!(
        "/project/{}/version?{}",
        encode(id),
        form(&[("loaders", &loaders_json(loaders))])
    )
}

/// `installPlugin(inst, projectId, { gameVersion })`: the sha1 Modrinth published is checked
/// before the jar is written.
pub fn install_plugin(
    inst: &Instance,
    project_id: &str,
    game_version: Option<&str>,
) -> Result<Value, Failure> {
    if !is_project_id(project_id) {
        return Err(Failure::user("that is not a project id"));
    }
    let loaders = loaders_for(inst);
    let word = content_kind_for(inst).word;
    let versions = modrinth_request(&versions_path(project_id, &loaders), None)?;
    let game_version = game_version.filter(|g| !g.is_empty());
    let mut version = pick_version(&versions, game_version, &loaders)?;
    let mut note = Value::Null;
    if version.is_none()
        && let Some(g) = game_version
    {
        version = pick_version(&versions, None, &loaders)?;
        if let Some(v) = &version {
            let claim = modrinth_claims(v);
            note = json!(format!(
                "Its newest build lists {}, not {g} - it may run anyway, but that is its author's claim, not SpawnLoft's.",
                if claim.is_null() {
                    "other versions".to_string()
                } else {
                    s(Some(&claim))
                }
            ));
        }
    }
    let Some(version) = version else {
        return Err(Failure::user(format!(
            "no build of that {word} supports a {} server",
            loaders.first().copied().unwrap_or("undefined")
        )));
    };
    let Some(file) = primary_file(&version)? else {
        return Err(Failure::user("that version has no downloadable file"));
    };
    let bytes = fetch_jar(&s(prop(Some(&file), "url")?))?;
    let want = opt(prop(Some(&file), "hashes")?, "sha1");
    if js::truthy(want) {
        let got = crate::sha1::hex(&bytes);
        if want.and_then(Value::as_str) != Some(got.as_str()) {
            return Err(Failure::user(
                "the download did not match the checksum Modrinth published; nothing was installed",
            ));
        }
    }
    let dir = make_plugins_dir(inst)?;
    let named = prop(Some(&file), "filename")?;
    let name = jspath::basename(&if js::truthy(named) {
        s(named)
    } else {
        format!("{project_id}.jar")
    });
    if !is_jar_name(&name) {
        return Err(Failure::user(format!(
            "Modrinth offered a file named \"{name}\", which is not a plugin jar"
        )));
    }
    write_jar(&dir, &name, &bytes)?;
    let project = or_nullish(version.get("project_id"), None);
    let mut meta = Map::new();
    meta.insert("source".into(), json!("modrinth"));
    meta.insert(
        "project".into(),
        json!(if nullish(project) {
            project_id.to_string()
        } else {
            s(project)
        }),
    );
    put(&mut meta, "version", version.get("version_number"));
    meta.insert("installedAt".into(), json!(crate::time::iso_now()));
    meta.insert(
        "gameVersions".into(),
        listed_versions(version.get("game_versions")),
    );
    plugins::record_managed(inst, &name, Value::Object(meta))?;
    let mut out = Map::new();
    out.insert("installed".into(), json!(name));
    put(&mut out, "version", version.get("version_number"));
    out.insert("size".into(), json!(bytes.len()));
    out.insert("versionNote".into(), note);
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------------------------
// The install plan

struct Known {
    keys: HashSet<String>,
    ids: HashSet<String>,
}

impl Known {
    fn of(rows: &[&Value]) -> Known {
        let mut keys = HashSet::new();
        let mut ids = HashSet::new();
        for p in rows {
            for k in [name_key(p.get("name")), name_key(p.get("modId"))] {
                if !k.is_empty() {
                    keys.insert(k);
                }
            }
            if p.get("source").and_then(Value::as_str) != Some("modpack") && js::truthy(p.get("project")) {
                ids.insert(s(p.get("project")));
            }
        }
        Known { keys, ids }
    }

    fn here(&self, id: &str, names: &[Option<&Value>]) -> bool {
        self.ids.contains(id)
            || names
                .iter()
                .map(|n| name_key(*n))
                .filter(|k| !k.is_empty())
                .any(|k| self.keys.contains(&k))
    }
}

struct Plan<'a> {
    on: Known,
    off: Known,
    game_version: Option<&'a str>,
    loaders: Vec<&'static str>,
    requires: Vec<Map<String, Value>>,
}

impl Plan<'_> {
    /// `{ installed, off }` for a project id and the names it goes by.
    fn state(&self, id: &str, names: &[Option<&Value>]) -> (bool, bool) {
        let installed = self.on.here(id, names);
        (installed, !installed && self.off.here(id, names))
    }

    fn entry(
        &self,
        source: &str,
        id: &str,
        title: &str,
        names: &[Option<&Value>],
        external: Value,
    ) -> Map<String, Value> {
        let (installed, off) = self.state(id, names);
        let mut m = Map::new();
        m.insert("source".into(), json!(source));
        m.insert("id".into(), json!(id));
        m.insert("title".into(), json!(title));
        m.insert("installed".into(), json!(installed));
        m.insert("off".into(), json!(off));
        m.insert("external".into(), external);
        m.insert("builtFor".into(), Value::Null);
        m.insert("mismatch".into(), json!(false));
        m
    }

    /// The hangar `walk(slug, depth)`: `None` when the project has no downloadable build.
    fn hangar_walk(
        &mut self,
        slug: &str,
        depth: u32,
        seen: &mut HashSet<String>,
    ) -> Result<Option<(Value, bool)>, Failure> {
        let Some(picked) = pick_hangar_version(&hangar_versions(slug)?, self.game_version)? else {
            return Ok(None);
        };
        let deps = opt(opt(Some(&picked.version), "pluginDependencies"), "PAPER");
        let deps: Vec<Value> = match deps {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.clone(),
            Some(Value::String(t)) => t.chars().map(|c| json!(c.to_string())).collect(),
            Some(_) => {
                return Err(Failure::type_error(
                    "picked.version.pluginDependencies?.PAPER ?? [] is not iterable",
                ));
            }
        };
        for d in &deps {
            let name = opt(Some(d), "name");
            if !js::truthy(Some(d)) || !js::truthy(opt(Some(d), "required")) || !js::truthy(name) {
                continue;
            }
            let key = name_key(name);
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            let id = s(name);
            let ext = opt(Some(d), "externalUrl");
            let external = if js::truthy(ext) {
                json!(s(ext))
            } else {
                Value::Null
            };
            let entry = self.entry("hangar", &id, &id, &[name], external);
            let skip = js::truthy(entry.get("installed"))
                || js::truthy(entry.get("off"))
                || !entry["external"].is_null()
                || depth >= 3
                || !is_project_id(&id);
            self.requires.push(entry);
            let at = self.requires.len() - 1;
            if skip {
                continue;
            }
            if let Ok(sub) = self.hangar_walk(&id, depth + 1, seen) {
                let e = &mut self.requires[at];
                match sub {
                    Some((version, exact)) => {
                        e.insert("mismatch".into(), json!(!exact));
                        let built = if exact {
                            Value::Null
                        } else {
                            hangar_claims(&version).unwrap_or(Value::Null)
                        };
                        e.insert("builtFor".into(), built);
                    }
                    None => {
                        e.insert(
                            "external".into(),
                            json!(format!("https://hangar.papermc.io/?q={}", encode(&id))),
                        );
                    }
                }
            }
        }
        let exact = picked.exact_match || self.game_version.is_none();
        Ok(Some((picked.version, exact)))
    }

    /// The modrinth `pick(id)`: the build that would be fetched and whether it lists this
    /// server's version.
    fn pick(&self, id: &str) -> Result<Option<(Value, bool)>, Failure> {
        let versions = modrinth_request(&versions_path(id, &self.loaders), None)?;
        let exact = pick_version(&versions, self.game_version, &self.loaders)?;
        if let Some(v) = exact {
            return Ok(Some((v, true)));
        }
        if self.game_version.is_some() {
            return Ok(pick_version(&versions, None, &self.loaders)?.map(|v| (v, false)));
        }
        Ok(None)
    }

    /// The modrinth `walk(version, depth)`.
    fn modrinth_walk(
        &mut self,
        version: &Value,
        depth: u32,
        seen: &mut HashSet<String>,
        unnamed: &mut usize,
    ) -> Result<(), Failure> {
        let deps = prop(Some(version), "dependencies")?;
        let deps: &[Value] = if nullish(deps) {
            &[]
        } else {
            items(deps, "filter", "(version.dependencies ?? [])")?
        };
        let needed: Vec<&Value> = deps
            .iter()
            .filter(|d| {
                js::truthy(Some(d))
                    && opt(Some(d), "dependency_type").and_then(Value::as_str) == Some("required")
            })
            .collect();
        let mut ids: Vec<String> = needed
            .iter()
            .filter(|d| js::truthy(opt(Some(d), "project_id")))
            .map(|d| s(opt(Some(d), "project_id")))
            .collect();
        let by_build: Vec<String> = needed
            .iter()
            .filter(|d| !js::truthy(opt(Some(d), "project_id")) && js::truthy(opt(Some(d), "version_id")))
            .map(|d| s(opt(Some(d), "version_id")))
            .collect();
        if !by_build.is_empty() {
            let asked = (|| -> Result<Vec<String>, Failure> {
                let found = modrinth_request(
                    &format!(
                        "/versions?ids={}",
                        encode(&crate::jsjson::stringify(&json!(by_build)))
                    ),
                    None,
                )?;
                let list = found.as_array().cloned().unwrap_or_default();
                let mut got = Vec::new();
                for v in &list {
                    let id = s(prop(Some(v), "project_id")?);
                    if is_project_id(&id) {
                        got.push(id);
                    }
                }
                Ok(got)
            })();
            match asked {
                Ok(got) => {
                    *unnamed += by_build.len().saturating_sub(got.len());
                    ids.extend(got);
                }
                Err(_) => *unnamed += by_build.len(),
            }
        }
        let mut fresh: Vec<String> = Vec::new();
        for id in ids {
            if !fresh.contains(&id) && is_project_id(&id) && !seen.contains(&id) {
                fresh.push(id);
            }
        }
        for id in &fresh {
            seen.insert(id.clone());
        }
        if fresh.is_empty() {
            return Ok(());
        }
        // one question for all of them; without an answer they are still listed, by id
        let titles = (|| -> Result<HashMap<String, (String, String)>, Failure> {
            let found = modrinth_request(
                &format!(
                    "/projects?ids={}",
                    encode(&crate::jsjson::stringify(&json!(fresh)))
                ),
                None,
            )?;
            let mut map = HashMap::new();
            for p in found.as_array().into_iter().flatten() {
                let pid = prop(Some(p), "id")?;
                let title = or_nullish(prop(Some(p), "title")?, or_nullish(prop(Some(p), "slug")?, pid));
                let slug = prop(Some(p), "slug")?;
                map.insert(
                    s(pid),
                    (s(title), if nullish(slug) { String::new() } else { s(slug) }),
                );
            }
            Ok(map)
        })()
        .unwrap_or_default();
        for id in &fresh {
            let named = titles.get(id);
            let title = named.map_or(id.clone(), |n| n.0.clone());
            let (t, sl) = (named.map(|n| json!(n.0)), named.map(|n| json!(n.1)));
            let entry = self.entry("modrinth", id, &title, &[t.as_ref(), sl.as_ref()], Value::Null);
            let skip = js::truthy(entry.get("installed")) || js::truthy(entry.get("off")) || depth >= 3;
            self.requires.push(entry);
            let at = self.requires.len() - 1;
            if skip {
                continue;
            }
            let _ = (|| -> Result<(), Failure> {
                let Some((sub, exact)) = self.pick(id)? else {
                    self.requires[at].insert(
                        "external".into(),
                        json!(format!("https://modrinth.com/project/{id}")),
                    );
                    return Ok(());
                };
                let e = &mut self.requires[at];
                e.insert("mismatch".into(), json!(!exact));
                e.insert(
                    "builtFor".into(),
                    if exact { Value::Null } else { modrinth_claims(&sub) },
                );
                self.modrinth_walk(&sub, depth + 1, seen, unnamed)
            })();
        }
        Ok(())
    }
}

fn empty_plan(source: &str, project: &str) -> Value {
    json!({ "source": source, "project": project, "version": null, "exactMatch": true, "builtFor": null, "requires": [] })
}

/// `planInstall(inst, projectId, { source, gameVersion })`: what installing a project would do,
/// without doing it: the build that would be fetched, whether it lists this server's version,
/// and everything it cannot load without (down through what those need, once each).
pub fn plan_install(
    inst: &Instance,
    project_id: &str,
    source: &str,
    game_version: Option<&str>,
) -> Result<Value, Failure> {
    if !is_project_id(project_id) {
        return Err(Failure::user("that is not a project id"));
    }
    let have = list_plugins(inst)?;
    let on: Vec<&Value> = have.iter().filter(|p| js::truthy(p.get("enabled"))).collect();
    let off: Vec<&Value> = have.iter().filter(|p| !js::truthy(p.get("enabled"))).collect();
    let mut plan = Plan {
        on: Known::of(&on),
        off: Known::of(&off),
        game_version: game_version.filter(|g| !g.is_empty()),
        loaders: loaders_for(inst),
        requires: Vec::new(),
    };

    if source == "hangar" {
        let mut seen = HashSet::from([name_key(Some(&json!(project_id)))]);
        let Some((version, exact)) = plan.hangar_walk(project_id, 0, &mut seen)? else {
            return Ok(empty_plan(source, project_id));
        };
        let mut out = Map::new();
        out.insert("source".into(), json!(source));
        out.insert("project".into(), json!(project_id));
        put(&mut out, "version", version.get("name"));
        out.insert("exactMatch".into(), json!(exact));
        out.insert(
            "builtFor".into(),
            if exact {
                Value::Null
            } else {
                hangar_claims(&version)?
            },
        );
        out.insert(
            "requires".into(),
            Value::Array(plan.requires.into_iter().map(Value::Object).collect()),
        );
        return Ok(Value::Object(out));
    }

    let Some((top, top_exact)) = plan.pick(project_id)? else {
        return Ok(empty_plan("modrinth", project_id));
    };
    let pid = top.get("project_id");
    let project = if nullish(pid) {
        project_id.to_string()
    } else {
        s(pid)
    };
    let mut seen = HashSet::from([project.clone()]);
    let mut unnamed = 0usize;
    plan.modrinth_walk(&top, 0, &mut seen, &mut unnamed)?;
    let mut requires: Vec<Value> = plan.requires.into_iter().map(Value::Object).collect();
    for _ in 0..unnamed {
        requires.push(json!({
            "source": "modrinth", "id": null, "title": "something Modrinth does not name", "installed": false,
            "off": false, "external": null, "unnamed": true, "builtFor": null, "mismatch": false,
        }));
    }
    let exact = top_exact || plan.game_version.is_none();
    let mut out = Map::new();
    out.insert("source".into(), json!("modrinth"));
    out.insert("project".into(), json!(project));
    put(&mut out, "version", top.get("version_number"));
    out.insert("exactMatch".into(), json!(exact));
    out.insert(
        "builtFor".into(),
        if exact { Value::Null } else { modrinth_claims(&top) },
    );
    out.insert("requires".into(), Value::Array(requires));
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------------------------
// Updates

fn sha1_file(file: &str) -> Result<String, Failure> {
    let bytes = std::fs::read(file).map_err(|e| Failure::read(&e, std::path::Path::new(file)))?;
    Ok(crate::sha1::hex(&bytes))
}

fn update_body(hashes: Vec<String>, loaders: &[&str], game_version: Option<&str>) -> Value {
    let mut body = Map::new();
    body.insert("hashes".into(), json!(hashes));
    body.insert("algorithm".into(), json!("sha1"));
    body.insert("loaders".into(), json!(loaders));
    if let Some(g) = game_version.filter(|g| !g.is_empty()) {
        body.insert("game_versions".into(), json!([g]));
    }
    Value::Object(body)
}

/// `checkUpdates(inst, { gameVersion })`.
pub fn check_updates(inst: &Instance, game_version: Option<&str>) -> Result<Value, Failure> {
    Ok(check_updates_report(inst, game_version)?["updates"].clone())
}

/// `checkUpdatesReport(inst, { gameVersion })`: newer builds of the jars SpawnLoft installed
/// (Modrinth by sha1, Hangar by version name), with what the check covered.
pub fn check_updates_report(inst: &Instance, game_version: Option<&str>) -> Result<Value, Failure> {
    let all = list_plugins(inst)?;
    let managed = |p: &Value| js::truthy(p.get("managed"));
    let enabled = |p: &Value| js::truthy(p.get("enabled"));
    let src = |p: &Value| p.get("source").and_then(Value::as_str).map(str::to_string);
    let rows: Vec<&Value> = all.iter().filter(|p| enabled(p) && managed(p)).collect();
    let mut updates: Vec<Value> = Vec::new();
    let mut checked = 0u64;
    let mut unknown = 0u64;
    let mut unreachable: Vec<Value> = Vec::new();
    let by_hand = all.iter().filter(|p| !managed(p)).count();
    let off = all.iter().filter(|p| managed(p) && !enabled(p)).count();
    let pack = rows
        .iter()
        .filter(|p| src(p).as_deref() == Some("modpack"))
        .count();
    let report = |updates: Vec<Value>, checked, unknown, unreachable: Vec<Value>| {
        json!({
            "updates": updates, "checked": checked, "byHand": by_hand, "off": off, "pack": pack,
            "unknown": unknown, "unreachable": unreachable,
        })
    };
    if rows.is_empty() {
        return Ok(report(updates, checked, unknown, unreachable));
    }
    let dir = plugins_dir(inst)?;

    // pack-owned jars are skipped: offering one mod an update out from under its pack breaks it
    let modrinth_rows: Vec<&Value> = rows
        .iter()
        .copied()
        .filter(|p| !matches!(src(p).as_deref(), Some("hangar" | "modpack")))
        .collect();
    if !modrinth_rows.is_empty() {
        let mut by_hash: Vec<(String, &Value)> = Vec::new();
        for p in &modrinth_rows {
            let sha = sha1_file(&jspath::join(&[&dir, &s(p.get("file"))]))?;
            match by_hash.iter_mut().find(|(h, _)| *h == sha) {
                Some(slot) => slot.1 = p,
                None => by_hash.push((sha, p)),
            }
        }
        let body = update_body(
            by_hash.iter().map(|(h, _)| h.clone()).collect(),
            &loaders_for(inst),
            game_version,
        );
        let latest = modrinth_request("/version_files/update", Some(&body))?;
        for (sha, p) in &by_hash {
            let v = prop(Some(&latest), sha)?;
            let Some(v) = v.filter(|v| js::truthy(Some(v))) else {
                unknown += 1;
                continue;
            };
            checked += 1;
            let file = primary_file(v)?;
            let same = file.as_ref().is_some_and(|f| {
                opt(opt(Some(f), "hashes"), "sha1").and_then(Value::as_str) == Some(sha.as_str())
            });
            if file.is_none() || same {
                continue;
            }
            let mut u = Map::new();
            put(&mut u, "file", p.get("file"));
            put(&mut u, "name", p.get("name"));
            put(&mut u, "installedVersion", p.get("version"));
            put(&mut u, "latestVersion", v.get("version_number"));
            put(&mut u, "projectId", v.get("project_id"));
            u.insert("source".into(), json!("modrinth"));
            updates.push(Value::Object(u));
        }
    }

    // Hangar has no hash lookup: the recorded version name against the newest pick; one project
    // that does not answer does not sink the check
    for p in rows.iter().filter(|p| src(p).as_deref() == Some("hangar")) {
        let picked =
            hangar_versions(&s(p.get("project"))).and_then(|vs| pick_hangar_version(&vs, game_version));
        match picked {
            Err(_) => {
                let n = p.get("name");
                unreachable.push(if js::truthy(n) {
                    n.cloned().unwrap_or(Value::Null)
                } else {
                    p.get("file").cloned().unwrap_or(Value::Null)
                });
            }
            Ok(None) => unknown += 1,
            Ok(Some(picked)) => {
                checked += 1;
                if js::strict_equals(picked.version.get("name"), p.get("installedVersion")) {
                    continue;
                }
                let mut u = Map::new();
                put(&mut u, "file", p.get("file"));
                put(&mut u, "name", p.get("name"));
                put(&mut u, "installedVersion", p.get("installedVersion"));
                put(&mut u, "latestVersion", picked.version.get("name"));
                put(&mut u, "projectId", p.get("project"));
                u.insert("source".into(), json!("hangar"));
                updates.push(Value::Object(u));
            }
        }
    }
    Ok(report(updates, checked, unknown, unreachable))
}

fn retire(inst: &Instance, current: &str, file: &str, installed: &Value) -> Result<(), Failure> {
    if installed.as_str() != Some(file) {
        crate::backup::rm_force(current)?;
        plugins::forget_managed(inst, file)?;
    }
    Ok(())
}

/// `updatePlugin(inst, file, { gameVersion })`: the old jar goes only after the new one is on
/// disk and checksummed, so a failure leaves two jars rather than none.
pub fn update_plugin(inst: &Instance, file: &str, game_version: Option<&str>) -> Result<Value, Failure> {
    let dir = plugins_dir(inst)?;
    let current = plugins::safe_plugin_path(&dir, file)?;
    let entry = plugins::managed_entry(&read_managed(inst)?, file);
    let Some(entry) = entry.filter(|e| js::truthy(Some(e))) else {
        return Err(Failure::user(
            "SpawnLoft did not install this jar, so it will not touch it - custom and premium plugins are yours to update",
        ));
    };
    let source = opt(Some(&entry), "source").and_then(Value::as_str);
    if source == Some("modpack") {
        return Err(Failure::user(
            "this mod belongs to the modpack, which governs its version - update the pack, not the mod",
        ));
    }

    if source == Some("hangar") {
        let project = s(opt(Some(&entry), "project"));
        let Some(picked) = pick_hangar_version(&hangar_versions(&project)?, game_version)? else {
            return Err(Failure::user(
                "that project no longer offers a downloadable Paper build on Hangar",
            ));
        };
        if js::strict_equals(picked.version.get("name"), opt(Some(&entry), "version")) {
            let mut out = Map::new();
            out.insert("alreadyLatest".into(), json!(true));
            put(&mut out, "version", opt(Some(&entry), "version"));
            return Ok(Value::Object(out));
        }
        let res = install_from_hangar(inst, &project, game_version)?;
        retire(inst, &current, file, &res["installed"])?;
        let mut out = Map::new();
        out.insert("updated".into(), res["installed"].clone());
        out.insert("from".into(), json!(file));
        put(&mut out, "version", res.get("version"));
        out.insert("versionNote".into(), res["versionNote"].clone());
        return Ok(Value::Object(out));
    }

    let sha = sha1_file(&current)?;
    let body = update_body(vec![sha.clone()], &loaders_for(inst), game_version);
    let latest = modrinth_request("/version_files/update", Some(&body))?;
    let version = prop(Some(&latest), &sha)?;
    let Some(version) = version.filter(|v| js::truthy(Some(v))).cloned() else {
        return Err(Failure::user(
            "Modrinth does not recognise this jar, so it cannot update it",
        ));
    };
    let Some(new_file) = primary_file(&version)? else {
        return Err(Failure::user("the latest version has no downloadable file"));
    };
    if opt(opt(Some(&new_file), "hashes"), "sha1").and_then(Value::as_str) == Some(sha.as_str()) {
        let mut out = Map::new();
        out.insert("alreadyLatest".into(), json!(true));
        put(&mut out, "version", version.get("version_number"));
        return Ok(Value::Object(out));
    }
    let res = install_plugin(inst, &s(version.get("project_id")), game_version)?;
    retire(inst, &current, file, &res["installed"])?;
    let mut out = Map::new();
    out.insert("updated".into(), res["installed"].clone());
    out.insert("from".into(), json!(file));
    put(&mut out, "version", res.get("version"));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests;
