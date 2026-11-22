//! Fabric and Quilt for the game client: `client-fabric.mjs`, `client-quilt.mjs` and the loader
//! hosts of `client-loader-hosts.mjs`. Each meta hands out a finished version file that inherits
//! from vanilla, which `install::ensure_version` then lays out like Mojang's; Fabric API goes into
//! the profile's mods folder from Modrinth, recorded in `.spawnloft-mods.json`.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::install::OnProgress;
use super::paths::Paths;
use super::{prop, read_json};
use crate::failure::Failure;
use crate::{js, jsjson, jspath};

fn user(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

/// `(e) => e.x` where `e` is undefined or null: the TypeError Node throws.
fn no_props(v: Option<&Value>, key: &str) -> Failure {
    let what = if matches!(v, Some(Value::Null)) {
        "null"
    } else {
        "undefined"
    };
    Failure::type_error(format!("Cannot read properties of {what} (reading '{key}')"))
}

/// `e.key` the way JavaScript reads it: an error on undefined and null, nothing on other values.
fn get<'a>(v: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, Failure> {
    match v {
        None | Some(Value::Null) => Err(no_props(v, key)),
        Some(Value::Object(m)) => Ok(m.get(key)),
        Some(_) => Ok(None),
    }
}

/// How a JSON document is fetched (`fetchJson(url, { label })`).
pub type FetchJson<'a> = super::meta::FetchJson<'a>;

/// One loader build: `{ version, stable }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Build {
    pub version: Value,
    pub stable: bool,
}

impl Build {
    pub fn text(&self) -> String {
        js::string(Some(&self.version))
    }
}

/// `gameId(mc)`: a version id that may go into a URL.
fn game_id(mc: &str) -> Result<&str, Failure> {
    if !super::version::is_safe_version_id(mc) {
        let cut: String = String::from_utf16_lossy(&mc.encode_utf16().take(64).collect::<Vec<_>>());
        return Err(user(format!(
            "Minecraft version {} is not a valid version",
            jsjson::stringify(&json!(cut))
        )));
    }
    Ok(mc)
}

/// `encodeURIComponent`.
fn enc(s: &str) -> String {
    super::harness_index::encode_uri_component(s)
}

// ---------------------------------------------------------------------------------------------
// Loader hosts

/// Where a mod loader's files may come from (design Q5).
pub const LOADER_HOSTS: &[&str] = &[
    "libraries.minecraft.net",
    "piston-data.mojang.com",
    "piston-meta.mojang.com",
    "maven.fabricmc.net",
    "meta.fabricmc.net",
    "maven.quiltmc.org",
    "meta.quiltmc.org",
    "maven.neoforged.net",
    "maven.minecraftforge.net",
    "files.minecraftforge.net",
];

/// `loaderHostAllowed(url)`: https, no user, password or port, and a listed host.
pub fn loader_host_allowed(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && u.host_str().is_some_and(|h| LOADER_HOSTS.contains(&h))
}

/// `assertLoaderHost(url, what)`.
pub fn assert_loader_host(url: &str, what: &str) -> Result<(), Failure> {
    if loader_host_allowed(url) {
        return Ok(());
    }
    let cut: String = String::from_utf16_lossy(&url.encode_utf16().take(120).collect::<Vec<_>>());
    Err(coded(
        format!(
            "{what} names a download at {cut}, which is not one of the places SpawnLoft takes mod loader files from; update SpawnLoft, or pick another build"
        ),
        "loader-host-refused",
    ))
}

// ---------------------------------------------------------------------------------------------
// Builds

/// `loaderVersions(mc)`: Fabric's loader builds for one version, as Fabric lists them.
pub fn fabric_builds(mc: &str, fetch: FetchJson<'_>) -> Result<Vec<Build>, Failure> {
    let safe = game_id(mc)?;
    let list = fetch(
        &format!("{}/versions/loader/{}", super::loaders::FABRIC_META, enc(safe)),
        &format!("Fabric loaders for {safe}"),
    )?;
    let items = match &list {
        Value::Array(a) if !a.is_empty() => a,
        _ => return Err(user(format!("Fabric publishes no loader for Minecraft {mc}"))),
    };
    items
        .iter()
        .map(|e| {
            let loader = get(Some(e), "loader")?;
            Ok(Build {
                version: get(loader, "version")?.cloned().unwrap_or(Value::Null),
                stable: get(loader, "stable")? == Some(&json!(true)),
            })
        })
        .collect()
}

/// `quiltBuildStable(version)`: no pre-release part before any `+`.
pub fn quilt_build_stable(version: &str) -> bool {
    !version.split('+').next().unwrap_or("").contains('-')
}

/// `quiltBuilds(mc)`: Quilt Loader's builds for one version, newest first.
pub fn quilt_builds(mc: &str, fetch: FetchJson<'_>) -> Result<Vec<Build>, Failure> {
    let safe = game_id(mc)?;
    let list = fetch(
        &format!("{}/versions/loader/{}", super::loaders::QUILT_META, enc(safe)),
        &format!("Quilt loaders for {safe}"),
    )?;
    let items = match &list {
        Value::Array(a) if !a.is_empty() => a,
        _ => {
            return Err(coded(
                format!("Quilt publishes no loader for Minecraft {mc}"),
                "loader-not-available",
            ));
        }
    };
    let mut out: Vec<Build> = items
        .iter()
        .map(|e| {
            let v = prop(prop(Some(e), "loader"), "version");
            if super::nullish(v) {
                String::new()
            } else {
                js::string(v)
            }
        })
        .filter(|v| !v.is_empty())
        .map(|v| Build {
            stable: quilt_build_stable(&v),
            version: json!(v),
        })
        .collect();
    out.sort_by(|a, b| super::loaders::compare_loader_versions(&b.text(), &a.text()));
    Ok(out)
}

/// `pickLoader` / `pickQuilt`: the build asked for, else the newest stable one, else the newest.
pub fn pick(loader: &str, builds: &[Build], wanted: Option<&str>) -> Result<Build, Failure> {
    let quilt = loader == "quilt";
    if builds.is_empty() {
        return Err(if quilt {
            coded("no Quilt loader to pick from", "loader-not-available")
        } else {
            user("no Fabric loader to pick from")
        });
    }
    if let Some(w) = wanted.filter(|w| !w.is_empty()) {
        let Some(b) = builds.iter().find(|b| b.version.as_str() == Some(w)) else {
            let shown: Vec<String> = if quilt {
                builds.iter().take(10).map(Build::text).collect()
            } else {
                builds.iter().map(Build::text).collect()
            };
            let name = if quilt { "Quilt" } else { "Fabric" };
            return Err(user(format!(
                "{name} loader {w} is not published for this Minecraft version; known: {}",
                shown.join(", ")
            )));
        };
        return Ok(b.clone());
    }
    Ok(builds.iter().find(|b| b.stable).unwrap_or(&builds[0]).clone())
}

/// The id of a loader's version file.
/// The version id a loader's build is kept under (`mod.versionId`): Forge's and NeoForge's own
/// shape, `<loader>-loader-<build>-<mc>` for Fabric and Quilt.
pub fn version_id(loader: &str, mc: &str, build: &str) -> String {
    if super::forge::handles(loader) {
        return super::forge::version_id(loader, mc, build);
    }
    format!("{loader}-loader-{build}-{mc}")
}

// ---------------------------------------------------------------------------------------------
// Version files

/// A version file already there that reads as this id is done; one cut short is fetched again.
fn on_disk(paths: &Paths, id: &str) -> bool {
    std::fs::read(paths.version_json(id))
        .ok()
        .and_then(|b| crate::jsjson::parse(&String::from_utf8_lossy(&b)).ok())
        .is_some_and(|v| prop(Some(&v), "id") == Some(&json!(id)))
}

fn write_version(paths: &Paths, id: &str, json: &Value) -> Result<(), Failure> {
    let dir = paths.version_dir(id);
    std::fs::create_dir_all(&dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&dir))))?;
    super::write_atomic(&paths.version_json(id), jsjson::stringify_pretty(json).as_bytes())
}

/// `ensureFabricProfile(mc, loader)`: Fabric's version file for one build, the id.
pub fn ensure_fabric_profile(
    paths: &Paths,
    mc: &str,
    loader: &str,
    fetch: FetchJson<'_>,
) -> Result<String, Failure> {
    let safe_mc = game_id(mc)?;
    let safe_loader = crate::sources::assert_safe_version(loader, "Fabric loader version")?;
    let id = version_id("fabric", safe_mc, &safe_loader);
    if on_disk(paths, &id) {
        return Ok(id);
    }
    let json = fetch(
        &format!(
            "{}/versions/loader/{}/{}/profile/json",
            super::loaders::FABRIC_META,
            enc(safe_mc),
            enc(&safe_loader)
        ),
        &format!("Fabric profile for {safe_mc} with loader {safe_loader}"),
    )?;
    let got = get(Some(&json), "id")?;
    if got != Some(&json!(id)) {
        return Err(user(format!(
            "the Fabric meta answered for a different profile (expected {id}, got {})",
            js::string(got)
        )));
    }
    let parent = prop(Some(&json), "inheritsFrom");
    if parent != Some(&json!(safe_mc)) {
        return Err(user(format!(
            "the Fabric meta profile inherits from {}, not {safe_mc}",
            js::string(parent)
        )));
    }
    write_version(paths, &id, &json)?;
    Ok(id)
}

/// How Quilt's maven checksum is read (`fetchSha1(url)`); a test's stand-in replaces it.
pub type FetchSha1<'a> = &'a (dyn Fn(&str) -> Result<String, Failure> + Sync);

/// `fetchSha1(url)`: the `.sha1` file the maven publishes beside a jar.
pub fn default_fetch_sha1(url: &str) -> Result<String, Failure> {
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
    Err(user(format!(
        "the checksum Quilt's maven publishes for {file} is not a sha1"
    )))
}

/// `libraryUrl(lib)`: the library's address, its base kept with a trailing slash.
fn quilt_library_url(lib: &mut Map<String, Value>) -> Result<String, Failure> {
    let name = match lib.get("name") {
        Some(Value::String(s)) if s.split(':').count() >= 3 => s.clone(),
        _ => return Err(user("Quilt's profile lists a library without a proper name")),
    };
    let given = match lib.get("url") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let base = given
        .clone()
        .unwrap_or_else(|| "https://libraries.minecraft.net/".into());
    let base = if base.ends_with('/') {
        base
    } else {
        format!("{base}/")
    };
    if given.is_some() {
        lib.insert("url".into(), json!(base));
    }
    let url = format!("{base}{}", super::library::library_path(&name)?);
    assert_loader_host(&url, "Quilt's profile")?;
    Ok(url)
}

/// One library of Quilt's profile: refused when its shape or host is wrong, else the address
/// whose `.sha1` names its checksum, or None when the profile names one already.
fn quilt_library_check(lib: &mut Value) -> Result<Option<String>, Failure> {
    // `lib.downloads` throws only on null; any other value that is not an object reads as
    // having none, and then has no proper name
    let m = match lib {
        Value::Null => return Err(no_props(Some(lib), "downloads")),
        Value::Object(m) => m,
        _ => return Err(user("Quilt's profile lists a library without a proper name")),
    };
    if js::truthy(m.get("downloads")) {
        let name = js::string(m.get("name"));
        let cut: String = String::from_utf16_lossy(&name.encode_utf16().take(80).collect::<Vec<_>>());
        return Err(user(format!(
            "Quilt's profile lists {cut} in a shape SpawnLoft does not know; update SpawnLoft"
        )));
    }
    let url = quilt_library_url(m)?;
    let sha = match m.get("sha1") {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    };
    Ok((!(sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()))).then_some(url))
}

/// `ensureQuiltProfile(mc, loader)`: Quilt's profile with each library's sha1 filled in.
pub fn ensure_quilt_profile(
    paths: &Paths,
    mc: &str,
    loader: &str,
    fetch: FetchJson<'_>,
    fetch_sha1: FetchSha1<'_>,
) -> Result<String, Failure> {
    let safe_mc = game_id(mc)?;
    let safe_loader = crate::sources::assert_safe_version(loader, "Quilt loader version")?;
    let id = version_id("quilt", safe_mc, &safe_loader);
    if !super::version::is_safe_version_id(&id) {
        return Err(user(format!(
            "Quilt loader {safe_loader} for {safe_mc} makes a version id SpawnLoft cannot use"
        )));
    }
    if on_disk(paths, &id) {
        return Ok(id);
    }
    let mut json = fetch(
        &format!(
            "{}/versions/loader/{}/{}/profile/json",
            super::loaders::QUILT_META,
            enc(safe_mc),
            enc(&safe_loader)
        ),
        &format!("Quilt profile for {safe_mc} with loader {safe_loader}"),
    )?;
    let got = prop(Some(&json), "id");
    if got != Some(&json!(id)) {
        return Err(user(format!(
            "Quilt's meta answered for a different profile (expected {id}, got {})",
            js::string(got)
        )));
    }
    let parent = prop(Some(&json), "inheritsFrom");
    if parent != Some(&json!(safe_mc)) {
        return Err(user(format!(
            "Quilt's meta profile inherits from {}, not {safe_mc}",
            js::string(parent)
        )));
    }
    let Some(Value::Array(libs)) = json.get_mut("libraries") else {
        return Err(user("Quilt's profile lists no libraries"));
    };
    // `Promise.all` over the libraries: every one is checked, and the checksum of each that
    // passes is asked for, even when another was refused; the first refused (in list order, as
    // a check fails before any fetch answers) is the one told
    let mut urls: Vec<Option<String>> = Vec::new();
    let mut refused: Option<Failure> = None;
    for lib in libs.iter_mut() {
        match quilt_library_check(lib) {
            Ok(url) => urls.push(url),
            Err(e) => {
                urls.push(None);
                refused.get_or_insert(e);
            }
        }
    }
    // a few at a time, each on the job's cancel token (it is per thread)
    let job = crate::cancel::current();
    let mut sums: Vec<Option<Result<String, Failure>>> = Vec::with_capacity(urls.len());
    for batch in urls.chunks(8) {
        let got: Vec<Option<Result<String, Failure>>> = std::thread::scope(|s| {
            let handles: Vec<_> = batch
                .iter()
                .map(|u| {
                    u.as_ref().map(|u| {
                        let job = job.clone();
                        s.spawn(move || crate::cancel::with_cancel(job, || fetch_sha1(u)))
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.map(|h| h.join().unwrap_or_else(|_| Err(user("a checksum fetch failed")))))
                .collect()
        });
        sums.extend(got);
    }
    if let Some(e) = refused {
        return Err(e);
    }
    for (lib, sum) in libs.iter_mut().zip(sums) {
        if let (Value::Object(m), Some(sum)) = (lib, sum) {
            m.insert("sha1".into(), json!(sum?));
        }
    }
    write_version(paths, &id, &json)?;
    Ok(id)
}

// ---------------------------------------------------------------------------------------------
// A profile's version

/// The loaders this module sets up.
pub fn handles(loader: &str) -> bool {
    loader == "fabric" || loader == "quilt"
}

/// What `prepareVersion` reaches: the meta and Mojang's hosts.
#[allow(missing_debug_implementations)]
pub struct Fetchers<'a> {
    pub json: FetchJson<'a>,
    pub file: super::install::Fetch<'a>,
    /// the .sha1 beside a Quilt library
    pub sha1: FetchSha1<'a>,
    /// the .sha1 beside a Forge or NeoForge installer, or an older Forge installer's library
    pub maven_sha1: FetchSha1<'a>,
}

impl Fetchers<'static> {
    pub fn real() -> Fetchers<'static> {
        Fetchers {
            json: &super::meta::default_fetch,
            file: &super::install::default_fetch,
            sha1: &default_fetch_sha1,
            maven_sha1: &super::forge_install::published_sha1,
        }
    }
}

/// `prepareVersion(name, { onStage })`: the version file on disk, a first Play's loader build
/// picked and pinned. The version id to install.
pub fn prepare_version(
    paths: &Paths,
    name: &str,
    on_stage: &mut dyn FnMut(&str),
    f: &Fetchers<'_>,
) -> Result<String, Failure> {
    let profile = super::profiles::get(paths, name)?;
    let mc = js::string(profile.get("mc"));
    super::install::prepare_vanilla(paths, &mc, on_stage, f.json, f.file)?;
    let loader = match profile.get("loader") {
        None | Some(Value::Null) => "vanilla".to_string(),
        Some(v) => js::string(Some(v)),
    };
    if loader == "vanilla" {
        return Ok(mc);
    }
    let forge = super::forge::handles(&loader);
    if !handles(&loader) && !forge {
        return Err(Failure::Internal {
            head: "Error".into(),
            message: format!("unknown loader \"{loader}\""),
            code: None,
        });
    }
    let mut build = match profile.get("loaderVersion") {
        None | Some(Value::Null) => None,
        Some(v) => Some(js::string(Some(v))),
    };
    // a loader profile already on disk was made for this version, so the loader has it
    let installed = build.as_ref().is_some_and(|b| {
        if forge {
            super::forge::is_installed(paths, &loader, &mc, b)
        } else {
            Path::new(&paths.version_json(&version_id(&loader, &mc, b))).exists()
        }
    });
    if !installed {
        // `readJson(versionJson(mc), null)?.type ?? 'release'`: a damaged file throws
        let vanilla = read_json(&paths.version_json(&mc))?;
        let kind = match prop(vanilla.as_ref(), "type") {
            None | Some(Value::Null) => Some("release".to_string()),
            Some(Value::String(t)) => Some(t.clone()),
            Some(_) => None,
        };
        let kind = super::version::version_kind(&mc, kind.as_deref());
        super::loaders::assert_available(paths, &loader, &mc, kind, f.json)?;
    }
    if build.is_none() {
        let label = super::loaders::display_name(&loader);
        on_stage(&format!("Finding a {label} loader for Minecraft {mc}"));
        let version = if forge {
            json!(
                super::forge::pick(&loader, &super::forge::builds(paths, &loader, &mc, f.json)?, None)?
                    .version
            )
        } else {
            let builds = if loader == "fabric" {
                fabric_builds(&mc, f.json)?
            } else {
                quilt_builds(&mc, f.json)?
            };
            pick(&loader, &builds, None)?.version
        };
        super::profiles::update_with(paths, name, vec![("loaderVersion".into(), version.clone())], true)?;
        build = Some(js::string(Some(&version)));
    }
    let build = build.unwrap_or_default();
    if forge {
        return super::forge::ensure_installed(paths, &loader, &mc, &build, on_stage, f);
    }
    if loader == "fabric" {
        ensure_fabric_profile(paths, &mc, &build, f.json)
    } else {
        ensure_quilt_profile(paths, &mc, &build, f.json, f.sha1)
    }
}

// ---------------------------------------------------------------------------------------------
// Fabric API

/// `fabricApiJars(modsDir)`: jars whose fabric.mod.json says id "fabric-api".
pub fn fabric_api_jars(mods_dir: &str) -> Result<Vec<String>, Failure> {
    let names = match std::fs::read_dir(mods_dir) {
        Ok(rd) => {
            let mut n: Vec<String> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            n.sort();
            n
        }
        Err(e) if jspath::is_enoent(&e) => Vec::new(),
        Err(e) => return Err(Failure::io(&e, "scandir", Some(Path::new(mods_dir)))),
    };
    Ok(names
        .into_iter()
        .filter(|n| n.to_ascii_lowercase().ends_with(".jar"))
        .filter(|n| {
            let Ok(Some(raw)) = crate::zip::jar::read_entry(&Path::new(mods_dir).join(n), "fabric.mod.json")
            else {
                return false;
            };
            crate::jsjson::parse(&String::from_utf8_lossy(&raw))
                .is_ok_and(|v| prop(Some(&v), "id") == Some(&json!("fabric-api")))
        })
        .collect())
}

/// How Modrinth is asked (`modrinthRequest(pathname)`).
pub type Modrinth<'a> = &'a (dyn Fn(&str) -> Result<Value, Failure> + Sync);

/// How a mod jar is downloaded: `downloadFile(url, dest, { hash: 'sha1', expected, label })`.
pub type Download<'a> = super::install::Fetch<'a>;

pub fn default_modrinth(pathname: &str) -> Result<Value, Failure> {
    crate::modrinth::modrinth_request(pathname, None)
}

/// `ensureFabricApi(name, mc)`: one Fabric API in the profile's mods folder, for this version.
pub fn ensure_fabric_api(
    paths: &Paths,
    profile: &str,
    mc: &str,
    on_progress: OnProgress<'_>,
    modrinth: Modrinth<'_>,
    download: Download<'_>,
) -> Result<(), Failure> {
    let _ = on_progress;
    let mods_dir = jspath::join(&[&paths.profile_dir(profile), "mods"]);
    let record_file = jspath::join(&[&mods_dir, ".spawnloft-mods.json"]);
    let mut record = match read_json(&record_file)? {
        Some(v) if !v.is_null() => v,
        _ => json!({ "version": 1, "managed": {} }),
    };
    // the folder is read before the record's `managed` is
    let present = fabric_api_jars(&mods_dir)?;
    let managed: Map<String, Value> = match get(Some(&record), "managed")? {
        Some(Value::Object(m)) => m.clone(),
        None | Some(Value::Null) => {
            return Err(Failure::type_error("Cannot convert undefined or null to object"));
        }
        Some(_) => Map::new(),
    };
    let hand: Vec<&String> = present.iter().filter(|n| !managed.contains_key(*n)).collect();
    if !hand.is_empty() && present.len() > 1 {
        return Err(user(format!(
            "mods/ in profile \"{profile}\" holds {} copies of Fabric API ({}), and the game will not start with more than one; remove all but one from {mods_dir}",
            present.len(),
            present.join(", ")
        )));
    }
    if hand.len() == 1 {
        return Ok(());
    }
    for (filename, meta) in &managed {
        // `meta.project` throws on a null entry
        if get(Some(meta), "project")? == Some(&json!("fabric-api"))
            && prop(Some(meta), "mc") == Some(&json!(mc))
            && present.len() <= 1
            && Path::new(&jspath::join(&[&mods_dir, filename])).exists()
        {
            return Ok(());
        }
    }
    let query = super::http::form(&[
        ("loaders", &jsjson::stringify(&json!(["fabric"]))),
        ("game_versions", &jsjson::stringify(&json!([mc]))),
    ]);
    let versions = modrinth(&format!("/project/fabric-api/version?{query}"))?;
    let version = crate::modrinth::pick_version(&versions, Some(mc), &["fabric"])?;
    let file = match &version {
        Some(v) => crate::modrinth::primary_file(v)?,
        None => None,
    };
    let (Some(version), Some(file)) = (version, file) else {
        return Err(user(format!(
            "no Fabric API build is published for Minecraft {mc}"
        )));
    };
    let filename = js::string(prop(Some(&file), "filename"));
    // /^[^\\/]+\.jar$/
    let jar = filename.ends_with(".jar") && filename.len() > 4 && !filename.contains(['/', '\\']);
    if !jar {
        return Err(user(format!(
            "Modrinth offered a file named \"{filename}\", which is not a mod jar"
        )));
    }
    let dest = jspath::join(&[&mods_dir, &filename]);
    std::fs::create_dir_all(&mods_dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&mods_dir))))?;
    let number = js::string(prop(Some(&version), "version_number"));
    // `file.hashes.sha1`: a file with no hashes throws
    let sha1 = get(prop(Some(&file), "hashes"), "sha1")?.map(|v| js::string(Some(v)));
    download(
        &js::string(prop(Some(&file), "url")),
        Path::new(&dest),
        sha1.as_deref(),
        &format!("Fabric API {number}"),
    )?;
    // recorded before the old copy goes, so a crash between leaves two managed jars
    let mut old: Vec<String> = Vec::new();
    for (f, m) in &managed {
        if get(Some(m), "project")? == Some(&json!("fabric-api")) && *f != filename {
            old.push(f.clone());
        }
    }
    let mut next = managed.clone();
    // an undefined version_number leaves the key out, as JSON.stringify does
    let mut entry = Map::new();
    entry.insert("source".into(), json!("modrinth"));
    entry.insert("project".into(), json!("fabric-api"));
    if let Some(v) = prop(Some(&version), "version_number") {
        entry.insert("version".into(), v.clone());
    }
    entry.insert("mc".into(), json!(mc));
    entry.insert(
        "installedAt".into(),
        json!(crate::jsdate::to_iso(crate::util::now()).unwrap_or_default()),
    );
    next.insert(filename.clone(), Value::Object(entry));
    if let Value::Object(r) = &mut record {
        r.insert("managed".into(), Value::Object(next.clone()));
    }
    super::write_json(&record_file, &record)?;
    for f in &old {
        super::rm_force(&jspath::join(&[&mods_dir, f]))?;
        next.shift_remove(f);
    }
    if !old.is_empty() {
        if let Value::Object(r) = &mut record {
            r.insert("managed".into(), Value::Object(next));
        }
        super::write_json(&record_file, &record)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_checked_as_node_checks_them() {
        assert!(loader_host_allowed("https://maven.fabricmc.net/a.jar"));
        assert!(!loader_host_allowed("http://maven.fabricmc.net/a.jar"));
        assert!(!loader_host_allowed("https://maven.fabricmc.net:444/a.jar"));
        assert!(!loader_host_allowed("https://u@maven.fabricmc.net/a.jar"));
        assert!(!loader_host_allowed("https://evil.example/a.jar"));
        assert_eq!(
            code_of(&assert_loader_host("x", "Quilt's profile").unwrap_err()),
            Some("loader-host-refused")
        );
    }

    fn code_of(e: &Failure) -> Option<&str> {
        match e {
            Failure::User { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    #[test]
    fn builds_are_picked_stable_first() {
        let b = |v: &str, s: bool| Build {
            version: json!(v),
            stable: s,
        };
        let list = [b("0.2-beta", false), b("0.1", true)];
        assert_eq!(pick("fabric", &list, None).unwrap().text(), "0.1");
        assert_eq!(pick("quilt", &list[..1], None).unwrap().text(), "0.2-beta");
        assert_eq!(
            pick("fabric", &list, Some("9")).unwrap_err().message(),
            "Fabric loader 9 is not published for this Minecraft version; known: 0.2-beta, 0.1"
        );
        assert!(quilt_build_stable("0.30.2+mc"));
        assert!(!quilt_build_stable("0.31.0-beta.6"));
        assert_eq!(version_id("quilt", "1.21", "0.30.2"), "quilt-loader-0.30.2-1.21");
    }

    fn api_jar(id: &str) -> Vec<u8> {
        crate::zip::tests::raw_zip(&[crate::zip::tests::raw_entry(
            "fabric.mod.json",
            format!("{{\"id\":\"{id}\"}}").as_bytes(),
        )])
    }

    #[test]
    fn fabric_api_is_kept_to_one_copy() {
        let d = std::env::temp_dir().join(format!("sl-fabric-api-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d.to_string_lossy());
        let mods = Path::new(&paths.profile_dir("p")).join("mods");
        let asked = std::sync::Mutex::new(Vec::<String>::new());
        let modrinth = |p: &str| -> Result<Value, Failure> {
            asked.lock().unwrap().push(p.to_string());
            Ok(
                json!([{ "version_number": "0.90.0", "game_versions": ["1.20.1"], "loaders": ["fabric"],
                "files": [{ "primary": true, "filename": "fabric-api-0.90.0.jar", "url": "https://cdn.modrinth.com/f.jar", "hashes": { "sha1": "ab" } }] }]),
            )
        };
        let download = |_: &str, dest: &Path, sum: Option<&str>, label: &str| -> Result<(), Failure> {
            assert_eq!((sum, label), (Some("ab"), "Fabric API 0.90.0"));
            std::fs::write(dest, api_jar("fabric-api")).unwrap();
            Ok(())
        };
        let ensure = || ensure_fabric_api(&paths, "p", "1.20.1", &|_| {}, &modrinth, &download);

        // fetched once, then the managed copy is used
        ensure().unwrap();
        ensure().unwrap();
        assert_eq!(asked.lock().unwrap().len(), 1);
        assert!(asked.lock().unwrap()[0].starts_with("/project/fabric-api/version?loaders="));
        let record = std::fs::read_to_string(mods.join(".spawnloft-mods.json")).unwrap();
        assert!(record.contains("\"project\": \"fabric-api\""), "{record}");

        // a second copy dropped in by hand stops the launch
        std::fs::write(mods.join("mine.jar"), api_jar("fabric-api")).unwrap();
        std::fs::write(mods.join("other.jar"), api_jar("sodium")).unwrap();
        let e = ensure().unwrap_err();
        assert!(e.message().contains("holds 2 copies of Fabric API"), "{e:?}");

        // one hand-dropped copy alone is used as it is
        std::fs::remove_file(mods.join("fabric-api-0.90.0.jar")).unwrap();
        std::fs::remove_file(mods.join(".spawnloft-mods.json")).unwrap();
        ensure().unwrap();
        assert_eq!(asked.lock().unwrap().len(), 1);

        // a file name that is not a jar is refused
        std::fs::remove_file(mods.join("mine.jar")).unwrap();
        let bad = |_: &str| -> Result<Value, Failure> {
            Ok(
                json!([{ "version_number": "1", "game_versions": ["1.20.1"], "loaders": ["fabric"],
                "files": [{ "primary": true, "filename": "../x.jar", "url": "u", "hashes": {} }] }]),
            )
        };
        let e = ensure_fabric_api(&paths, "p", "1.20.1", &|_| {}, &bad, &download).unwrap_err();
        assert!(e.message().contains("which is not a mod jar"), "{e:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn quilt_checks_every_library_and_tells_the_first_refused() {
        let d = std::env::temp_dir().join(format!("sl-quilt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d.to_string_lossy());
        let fetch = |_: &str, _: &str| -> Result<Value, Failure> {
            Ok(
                json!({ "id": "quilt-loader-0.26.0-1.20.1", "inheritsFrom": "1.20.1", "libraries": [
                { "name": "org.evil:a:1.0", "url": "https://evil.example/" },
                7,
                { "name": "org.quiltmc:b:1.0", "url": "https://maven.quiltmc.org/repository/release" },
            ] }),
            )
        };
        let asked = std::sync::Mutex::new(Vec::<String>::new());
        let sha1 = |u: &str| -> Result<String, Failure> {
            asked.lock().unwrap().push(u.to_string());
            Ok("a".repeat(40))
        };
        let e = ensure_quilt_profile(&paths, "1.20.1", "0.26.0", &fetch, &sha1).unwrap_err();
        assert_eq!(code_of(&e), Some("loader-host-refused"));
        assert_eq!(
            *asked.lock().unwrap(),
            ["https://maven.quiltmc.org/repository/release/org/quiltmc/b/1.0/b-1.0.jar"]
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
