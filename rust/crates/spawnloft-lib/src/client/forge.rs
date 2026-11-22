//! Forge and NeoForge for the game launcher (`client-forge.mjs`, `client-neoforge.mjs`): their
//! builds, their version ids, and the two halves of a setup, both run by the installer engine
//! ([`super::forge_install`]): the version file first, the build steps once the game's Java is
//! picked.
//!
//! A Forge build's full name carries the Minecraft version: 1.20.1-47.4.28 is build 47.4.28 for
//! 1.20.1, and its version file is 1.20.1-forge-47.4.28. A NeoForge build names its Minecraft
//! version in its own number (21.1.266 is 1.21.1; from 26.1 on, 26.3.0.103 is 26.3).

use std::path::Path;

use serde_json::{Map, Value};

use super::forge_install::{self as engine, Installer, code_of};
use super::loaders::{
    FORGE_FILES, NEOFORGE_LIST, compare_loader_versions, forge_supported_mc, is_forge_build, neoforge_mc,
    neoforge_stable,
};
use super::meta::{Cached, FetchJson, cached_json};
use super::paths::Paths;
use super::prop;
use crate::failure::Failure;
use crate::js;

pub const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";
pub const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

fn enc(s: &str) -> String {
    super::harness_index::encode_uri_component(s)
}

/// `/^\d+\.\d+(\.\d+)?$/`
fn mc_shaped(mc: &str) -> bool {
    let parts: Vec<&str> = mc.split('.').collect();
    (parts.len() == 2 || parts.len() == 3)
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// One build: `{ version, stable, recommended }` (NeoForge's have no `recommended`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
    pub version: String,
    pub stable: bool,
    pub recommended: bool,
}

fn too_old(mc: &str) -> String {
    format!("Forge for Minecraft {mc} is older than SpawnLoft offers (1.6.4 and newer). Use None for it.")
}

fn cached<'a>(label: &'a str, fetch: FetchJson<'a>) -> Cached<'a> {
    let mut o = Cached::new(label, false);
    o.fetch = fetch;
    o
}

// ---- Forge -----------------------------------------------------------------------------------

/// `forgeLists()`: every build per Minecraft version, and the ones Forge recommends.
fn forge_lists(paths: &Paths, fetch: FetchJson<'_>) -> Result<(Value, Map<String, Value>), Failure> {
    let dir = paths.cache_dir();
    let (meta, promos) = std::thread::scope(|s| {
        let m = s.spawn(|| {
            cached_json(
                &dir,
                "forge-maven-metadata.json",
                &format!("{FORGE_FILES}/maven-metadata.json"),
                cached("Forge's version list", fetch),
            )
        });
        let p = s.spawn(|| {
            cached_json(
                &dir,
                "forge-promotions.json",
                &format!("{FORGE_FILES}/promotions_slim.json"),
                cached("Forge's recommended builds", fetch),
            )
        });
        let meta = m
            .join()
            .unwrap_or_else(|_| Err(Failure::user("Forge's version list could not be read")));
        // without the recommended builds, the newest is picked: no reason to lose the version list
        let promos = p.join().ok().and_then(Result::ok);
        (meta, promos)
    });
    let meta = meta?;
    if !matches!(meta, Value::Object(_)) {
        return Err(Failure::user("Forge's version list is not a list"));
    }
    let promos = match prop(promos.as_ref(), "promos") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    Ok((meta, promos))
}

/// `forgeBuilds(mc)`: Forge's builds for one Minecraft version, newest first; the one Forge
/// recommends is marked.
pub fn forge_builds(paths: &Paths, mc: &str, fetch: FetchJson<'_>) -> Result<Vec<Build>, Failure> {
    if mc_shaped(mc) && !forge_supported_mc(mc) {
        return Err(coded(too_old(mc), "loader-not-available"));
    }
    let (meta, promos) = forge_lists(paths, fetch).map_err(|err| {
        coded(
            format!(
                "Could not reach Forge to set it up. This computer needs to be online for the first Play of a Forge setup. ({})",
                err.message()
            ),
            code_of(&err).unwrap_or("loader-unreachable"),
        )
    })?;
    let full: Vec<Value> = match prop(Some(&meta), mc) {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let recommended = match promos.get(&format!("{mc}-recommended")) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let prefix = format!("{mc}-");
    let builds: Vec<String> = full
        .iter()
        .map(|f| js::string(Some(f)))
        .filter(|f| f.starts_with(&prefix))
        .map(|f| f[prefix.len()..].to_string())
        .filter(|b| is_forge_build(b))
        .collect();
    if builds.is_empty() || !forge_supported_mc(mc) {
        return Err(coded(
            format!("Forge has no build for Minecraft {mc}. Use None, or a version Forge supports."),
            "loader-not-available",
        ));
    }
    let mut out: Vec<Build> = builds
        .into_iter()
        .map(|version| {
            // Forge's recommended name leaves the version tail off (10.13.4.1614 for
            // 10.13.4.1614-1.7.10)
            let rec = recommended
                .as_deref()
                .is_some_and(|r| !r.is_empty() && (version == r || version.starts_with(&format!("{r}-"))));
            Build {
                version,
                stable: true,
                recommended: rec,
            }
        })
        .collect();
    out.sort_by(|a, b| compare_loader_versions(&b.version, &a.version));
    Ok(out)
}

fn known(list: &[Build]) -> String {
    list.iter()
        .take(10)
        .map(|e| e.version.clone())
        .collect::<Vec<_>>()
        .join(", ")
}

/// `pickForge(list, wanted)`: the build Forge recommends for the version; its newest when none
/// is.
pub fn pick_forge(list: &[Build], wanted: Option<&str>) -> Result<Build, Failure> {
    if list.is_empty() {
        return Err(coded("no Forge build to pick from", "loader-not-available"));
    }
    if let Some(w) = wanted.filter(|w| !w.is_empty()) {
        let entry = list
            .iter()
            .find(|e| e.version == w)
            .or_else(|| list.iter().find(|e| e.version.starts_with(&format!("{w}-"))));
        return entry.cloned().ok_or_else(|| {
            Failure::user(format!(
                "Forge {w} is not published for this Minecraft version; known: {}",
                known(list)
            ))
        });
    }
    Ok(list.iter().find(|e| e.recommended).unwrap_or(&list[0]).clone())
}

pub fn forge_version_id(mc: &str, build: &str) -> String {
    format!("{mc}-forge-{build}")
}

struct Checked {
    build: String,
    id: String,
    full: String,
}

fn forge_checked(mc: &str, build: &str) -> Result<Checked, Failure> {
    let safe = crate::sources::assert_safe_version(build, "Forge build")?;
    if !is_forge_build(&safe) {
        return Err(coded(
            format!("Forge {safe} is not a Forge build; pick another in Advanced"),
            "loader-not-available",
        ));
    }
    if !forge_supported_mc(mc) {
        return Err(coded(too_old(mc), "loader-not-available"));
    }
    let id = forge_version_id(mc, &safe);
    if !super::version::is_safe_version_id(&id) {
        return Err(Failure::user(format!(
            "Forge {safe} makes a version id SpawnLoft cannot use"
        )));
    }
    Ok(Checked {
        full: format!("{mc}-{safe}"),
        build: safe,
        id,
    })
}

fn forge_installer(
    paths: &Paths,
    c: &Checked,
    f: &super::fabric::Fetchers<'_>,
    on_stage: &mut dyn FnMut(&str),
) -> Result<Installer, Failure> {
    let url = format!(
        "{FORGE_MAVEN}/{}/forge-{}-installer.jar",
        enc(&c.full),
        enc(&c.full)
    );
    engine::fetch_installer(
        paths,
        &url,
        &format!("forge-{}-installer.jar", c.full),
        &format!("Forge {} installer", c.build),
        f.file,
        f.maven_sha1,
        on_stage,
    )
}

fn version_on_disk(paths: &Paths, id: &str) -> bool {
    Path::new(&paths.version_json(id)).exists()
}

pub fn forge_installed(paths: &Paths, mc: &str, build: &str) -> bool {
    let id = forge_version_id(mc, build);
    version_on_disk(paths, &id) && engine::is_stamped(paths, &id)
}

/// `ensureForgeVersion(mc, build)`: the installer, checked, and its version file. An older
/// installer's libraries get their checksums from their mavens here.
pub fn ensure_forge_version(
    paths: &Paths,
    mc: &str,
    build: &str,
    on_stage: &mut dyn FnMut(&str),
    f: &super::fabric::Fetchers<'_>,
) -> Result<String, Failure> {
    let c = forge_checked(mc, build)?;
    if version_on_disk(paths, &c.id) && engine::is_stamped(paths, &c.id) {
        return Ok(c.id);
    }
    let inst = forge_installer(paths, &c, f, on_stage)?;
    let mut read = engine::read_installer(&inst.path, mc, &c.id, "Forge", true)?;
    if !read.pending.is_empty() {
        on_stage(&format!("Reading the checksums of Forge {}'s libraries", c.build));
        let file = f.file;
        let file_sha1 = |url: &str, rel: &str| engine::downloaded_sha1(paths, url, rel, file);
        engine::fill_legacy_checksums(
            paths,
            &mut read.version,
            &read.pending,
            "Forge",
            f.maven_sha1,
            &file_sha1,
        )?;
    }
    engine::write_version_file(paths, &c.id, &read.version)?;
    Ok(c.id)
}

// ---- NeoForge --------------------------------------------------------------------------------

fn neoforge_list(paths: &Paths, fetch: FetchJson<'_>) -> Result<Vec<String>, Failure> {
    let list = cached_json(
        &paths.cache_dir(),
        "neoforge-versions.json",
        NEOFORGE_LIST,
        cached("NeoForge's version list", fetch),
    )?;
    match prop(Some(&list), "versions") {
        Some(Value::Array(v)) => Ok(v.iter().map(|b| js::string(Some(b))).collect()),
        _ => Err(Failure::user("NeoForge's version list is not a list")),
    }
}

/// `neoforgeBuilds(mc)`: NeoForge's builds for one Minecraft version, newest first.
pub fn neoforge_builds(paths: &Paths, mc: &str, fetch: FetchJson<'_>) -> Result<Vec<Build>, Failure> {
    let all = neoforge_list(paths, fetch).map_err(|err| {
        coded(
            format!(
                "Could not reach NeoForge to set it up. This computer needs to be online for the first Play of a NeoForge setup. ({})",
                err.message()
            ),
            code_of(&err).unwrap_or("loader-unreachable"),
        )
    })?;
    let mut builds: Vec<Build> = all
        .into_iter()
        .filter(|b| neoforge_mc(b).as_deref() == Some(mc))
        .map(|version| Build {
            stable: neoforge_stable(&version),
            version,
            recommended: false,
        })
        .collect();
    if builds.is_empty() {
        return Err(coded(
            format!("NeoForge has no build for Minecraft {mc}. Use None, or a version NeoForge supports."),
            "loader-not-available",
        ));
    }
    builds.sort_by(|a, b| compare_loader_versions(&b.version, &a.version));
    Ok(builds)
}

/// `pickNeoforge(list, wanted)`: the newest stable build; the newest beta only when the version
/// has no stable one.
pub fn pick_neoforge(list: &[Build], wanted: Option<&str>) -> Result<Build, Failure> {
    if list.is_empty() {
        return Err(coded("no NeoForge build to pick from", "loader-not-available"));
    }
    if let Some(w) = wanted.filter(|w| !w.is_empty()) {
        return list.iter().find(|e| e.version == w).cloned().ok_or_else(|| {
            Failure::user(format!(
                "NeoForge {w} is not published for this Minecraft version; known: {}",
                known(list)
            ))
        });
    }
    Ok(list.iter().find(|e| e.stable).unwrap_or(&list[0]).clone())
}

pub fn neoforge_version_id(build: &str) -> String {
    format!("neoforge-{build}")
}

fn neoforge_checked(mc: &str, build: &str) -> Result<(String, String), Failure> {
    let safe = crate::sources::assert_safe_version(build, "NeoForge build")?;
    if neoforge_mc(&safe).as_deref() != Some(mc) {
        return Err(coded(
            format!("NeoForge {safe} is not a build for Minecraft {mc}; pick another in Advanced"),
            "loader-not-available",
        ));
    }
    let id = neoforge_version_id(&safe);
    if !super::version::is_safe_version_id(&id) {
        return Err(Failure::user(format!(
            "NeoForge {safe} makes a version id SpawnLoft cannot use"
        )));
    }
    Ok((safe, id))
}

fn neoforge_installer(
    paths: &Paths,
    build: &str,
    f: &super::fabric::Fetchers<'_>,
    on_stage: &mut dyn FnMut(&str),
) -> Result<Installer, Failure> {
    let url = format!(
        "{NEOFORGE_MAVEN}/{}/neoforge-{}-installer.jar",
        enc(build),
        enc(build)
    );
    engine::fetch_installer(
        paths,
        &url,
        &format!("neoforge-{build}-installer.jar"),
        &format!("NeoForge {build} installer"),
        f.file,
        f.maven_sha1,
        on_stage,
    )
}

pub fn neoforge_installed(paths: &Paths, build: &str) -> bool {
    let id = neoforge_version_id(build);
    version_on_disk(paths, &id) && engine::is_stamped(paths, &id)
}

/// `ensureNeoforgeVersion(mc, build)`: the installer, checked, and its version file.
pub fn ensure_neoforge_version(
    paths: &Paths,
    mc: &str,
    build: &str,
    on_stage: &mut dyn FnMut(&str),
    f: &super::fabric::Fetchers<'_>,
) -> Result<String, Failure> {
    let (build, id) = neoforge_checked(mc, build)?;
    if version_on_disk(paths, &id) && engine::is_stamped(paths, &id) {
        return Ok(id);
    }
    let inst = neoforge_installer(paths, &build, f, on_stage)?;
    let read = engine::read_installer(&inst.path, mc, &id, "NeoForge", false)?;
    engine::write_version_file(paths, &id, &read.version)?;
    Ok(id)
}

// ---- both ------------------------------------------------------------------------------------

/// The loaders this module sets up.
pub fn handles(loader: &str) -> bool {
    loader == "forge" || loader == "neoforge"
}

pub fn version_id(loader: &str, mc: &str, build: &str) -> String {
    if loader == "forge" {
        forge_version_id(mc, build)
    } else {
        neoforge_version_id(build)
    }
}

pub fn is_installed(paths: &Paths, loader: &str, mc: &str, build: &str) -> bool {
    if loader == "forge" {
        forge_installed(paths, mc, build)
    } else {
        neoforge_installed(paths, build)
    }
}

pub fn builds(paths: &Paths, loader: &str, mc: &str, fetch: FetchJson<'_>) -> Result<Vec<Build>, Failure> {
    if loader == "forge" {
        forge_builds(paths, mc, fetch)
    } else {
        neoforge_builds(paths, mc, fetch)
    }
}

pub fn pick(loader: &str, list: &[Build], wanted: Option<&str>) -> Result<Build, Failure> {
    if loader == "forge" {
        pick_forge(list, wanted)
    } else {
        pick_neoforge(list, wanted)
    }
}

pub fn ensure_installed(
    paths: &Paths,
    loader: &str,
    mc: &str,
    build: &str,
    on_stage: &mut dyn FnMut(&str),
    f: &super::fabric::Fetchers<'_>,
) -> Result<String, Failure> {
    if loader == "forge" {
        ensure_forge_version(paths, mc, build, on_stage, f)
    } else {
        ensure_neoforge_version(paths, mc, build, on_stage, f)
    }
}

/// What a finish needs beside the build.
#[allow(missing_debug_implementations)]
pub struct Finish<'a> {
    pub name: &'a str,
    pub java: &'a str,
    pub verify: bool,
    pub f: &'a super::fabric::Fetchers<'a>,
    pub spawn: engine::Spawn<'a>,
    pub on_stage: &'a mut dyn FnMut(&str),
    pub on_progress: super::install::OnProgress<'a>,
    pub on_note: &'a mut dyn FnMut(&str),
}

/// `finishForge` / `finishNeoforge`: the build steps, on the game's Java. The installer is read
/// again only when there is something to build.
pub fn finish_install(
    paths: &Paths,
    loader: &str,
    mc: &str,
    build: &str,
    x: Finish<'_>,
) -> Result<bool, Failure> {
    let (who, build, id, legacy, full) = if loader == "forge" {
        let c = forge_checked(mc, build)?;
        ("Forge", c.build, c.id, true, Some(c.full))
    } else {
        let (b, id) = neoforge_checked(mc, build)?;
        ("NeoForge", b, id, false, None)
    };
    let f = x.f;
    let on_stage = x.on_stage;
    // the installer's own stage line goes out through the same callback as the steps' lines
    let stage_cell = std::cell::RefCell::new(on_stage);
    let mut get_installer = || -> Result<Installer, Failure> {
        let mut say = |m: &str| (stage_cell.borrow_mut())(m);
        match &full {
            Some(full) => forge_installer(
                paths,
                &Checked {
                    build: build.clone(),
                    id: id.clone(),
                    full: full.clone(),
                },
                f,
                &mut say,
            ),
            None => neoforge_installer(paths, &build, f, &mut say),
        }
    };
    let mut stage = |m: &str| (stage_cell.borrow_mut())(m);
    engine::run_installer(
        paths,
        engine::Run {
            id: &id,
            mc,
            who,
            build: &build,
            name: x.name,
            installer: &mut get_installer,
            java: x.java,
            java_args: &[],
            legacy,
            verify: x.verify,
            fetch: f.file,
            spawn: x.spawn,
            on_stage: &mut stage,
            on_progress: x.on_progress,
            on_note: x.on_note,
        },
    )
}

/// `forgeJava(requirement)`: Forge on a version Mojang ships with Java 8 runs on Java 8 only,
/// Mojang's own first (`mojangFirst`).
pub fn forge_java(req: &super::version::JavaRequirement) -> (super::version::JavaRequirement, bool) {
    if req.component == "jre-legacy" {
        let mut r = req.clone();
        r.max = Some(8.0);
        r.prefer = 8.0;
        (r, true)
    } else {
        (req.clone(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(v: &str, rec: bool) -> Build {
        Build {
            version: v.into(),
            stable: true,
            recommended: rec,
        }
    }

    #[test]
    fn forge_picks_the_recommended_build_and_short_names() {
        let list = vec![b("47.4.28", false), b("47.4.10", true), b("47.3.0", false)];
        assert_eq!(pick_forge(&list, None).unwrap().version, "47.4.10");
        assert_eq!(pick_forge(&list[..1], None).unwrap().version, "47.4.28");
        let tailed = vec![b("10.13.4.1614-1.7.10", false)];
        assert_eq!(
            pick_forge(&tailed, Some("10.13.4.1614")).unwrap().version,
            "10.13.4.1614-1.7.10"
        );
        assert!(
            pick_forge(&list, Some("1.0"))
                .unwrap_err()
                .message()
                .contains("known: 47.4.28, 47.4.10, 47.3.0")
        );
        assert_eq!(forge_version_id("1.20.1", "47.4.28"), "1.20.1-forge-47.4.28");
        assert_eq!(neoforge_version_id("21.1.266"), "neoforge-21.1.266");
        assert!(mc_shaped("1.20") && mc_shaped("1.20.1") && !mc_shaped("24w01a") && !mc_shaped("1"));
    }

    #[test]
    fn forge_on_java_8_versions_takes_8_and_mojangs_first() {
        let req = super::super::version::JavaRequirement {
            major: 8.0,
            component: "jre-legacy".into(),
            min: 8.0,
            max: Some(17.0),
            prefer: 8.0,
        };
        let (r, first) = forge_java(&req);
        assert_eq!((r.max, r.prefer, first), (Some(8.0), 8.0, true));
        let modern = super::super::version::JavaRequirement {
            component: "java-runtime-gamma".into(),
            ..req
        };
        assert!(!forge_java(&modern).1);
    }
}
