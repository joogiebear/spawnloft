//! The mod loaders' Minecraft version lists (`gameVersions`, `available`, `assertAvailable` of
//! client-fabric, -quilt, -forge and -neoforge.mjs, and `loaderLists` and `loadersFor` of
//! client-loaders.mjs): which versions each builds for, cached for an hour like Mojang's list.
//! The builds, profiles and installers of each loader come with install and launch.

use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::meta::{Cached, FetchJson, cached_json};
use super::paths::Paths;
use crate::failure::Failure;
use crate::js;

pub const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
pub const QUILT_META: &str = "https://meta.quiltmc.org/v3";
pub const FORGE_FILES: &str = "https://files.minecraftforge.net/net/minecraftforge/forge";
pub const NEOFORGE_LIST: &str =
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

/// The loaders with a module, in client-loaders.mjs's order (`Object.keys(MODULES)`).
pub const MODS: &[&str] = &["fabric", "quilt", "forge", "neoforge"];

/// `loaderFor(id).name`.
pub fn display_name(id: &str) -> &'static str {
    match id {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "",
    }
}

fn coded(message: String, code: &str) -> Failure {
    Failure::User {
        message,
        code: Some(code.into()),
    }
}

/// `str.slice(n)` in UTF-16 units, as JavaScript counts them.
fn slice_from(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().skip(n).collect();
    String::from_utf16_lossy(&units)
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ---- version shapes --------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Num(f64),
    Text(Vec<u16>),
}

fn parts_of(t: &str) -> Vec<Part> {
    t.split('.')
        .map(|p| {
            if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
                Part::Num(js::string_to_number(p))
            } else {
                Part::Text(p.encode_utf16().collect())
            }
        })
        .collect()
}

fn compare_parts(x: &[Part], y: &[Part]) -> Ordering {
    for i in 0..x.len().max(y.len()) {
        let (Some(a), Some(b)) = (x.get(i), y.get(i)) else {
            return if x.get(i).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        if a == b {
            continue;
        }
        return match (a, b) {
            (Part::Num(a), Part::Num(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
            (Part::Num(_), _) => Ordering::Less,
            (_, Part::Num(_)) => Ordering::Greater,
            (Part::Text(a), Part::Text(b)) => {
                if a < b {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
        };
    }
    Ordering::Equal
}

/// `compareLoaderVersions(a, b)` of client-quilt.mjs: semantic versions, build metadata after a
/// `+` not counted, a pre-release before its release.
pub fn compare_loader_versions(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| {
        let v = v.split('+').next().unwrap_or("");
        match v.split_once('-') {
            None => (parts_of(v), None),
            Some((core, pre)) => (parts_of(core), Some(parts_of(pre))),
        }
    };
    let (ac, ap) = parse(a);
    let (bc, bp) = parse(b);
    match compare_parts(&ac, &bc) {
        Ordering::Equal => {}
        o => return o,
    }
    match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => compare_parts(&x, &y),
    }
}

static MC_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)\.([0-9]+)(?:\.([0-9]+))?$").expect("valid"));
static FORGE_BUILD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]+(?:\.[0-9]+)*(?:-(?:[0-9]+\.[0-9]+(?:\.(?:[0-9]+|x))?|mc[0-9]+))?$").expect("valid")
});
static NEO_FOUR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+(?:-[A-Za-z0-9_.]+)?$").expect("valid")
});
static NEO_THREE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)\.([0-9]+)\.[0-9]+(?:-[A-Za-z0-9_.]+)?$").expect("valid"));

/// `forgeSupportedMc(mc)`: 1.6.4 and newer.
pub fn forge_supported_mc(mc: &str) -> bool {
    let Some(m) = MC_SHAPE.captures(mc) else {
        return false;
    };
    let n = |i: usize| m.get(i).map_or(0.0, |g| js::string_to_number(g.as_str()));
    let (major, minor, patch) = (n(1), n(2), n(3));
    major > 1.0 || minor > 6.0 || (minor == 6.0 && patch >= 4.0)
}

/// `isForgeBuild(b)`.
pub fn is_forge_build(b: &str) -> bool {
    FORGE_BUILD.is_match(b)
}

/// `neoforgeMc(build)`: the Minecraft version a NeoForge build is for.
pub fn neoforge_mc(build: &str) -> Option<String> {
    if let Some(m) = NEO_FOUR.captures(build) {
        return Some(if &m[3] == "0" {
            format!("{}.{}", &m[1], &m[2])
        } else {
            format!("{}.{}.{}", &m[1], &m[2], &m[3])
        });
    }
    let m = NEO_THREE.captures(build)?;
    let major = js::string_to_number(&m[1]);
    (20.0..26.0).contains(&major).then(|| {
        if &m[2] == "0" {
            format!("1.{}", &m[1])
        } else {
            format!("1.{}.{}", &m[1], &m[2])
        }
    })
}

pub fn neoforge_stable(build: &str) -> bool {
    !build.contains('-')
}

// ---- the lists -------------------------------------------------------------------------------

fn cached<'a>(label: &'a str, force: bool, fetch: FetchJson<'a>) -> Cached<'a> {
    let mut o = Cached::new(label, force);
    o.fetch = fetch;
    o
}

/// `<loader>GameVersions({ force })`: the versions a loader builds for, as its list has them
/// (`{ version, stable }` rows, newest first).
pub fn game_versions(
    paths: &Paths,
    loader: &str,
    force: bool,
    fetch: FetchJson<'_>,
) -> Result<Vec<Value>, Failure> {
    let dir = paths.cache_dir();
    match loader {
        "fabric" | "quilt" => {
            let (file, url, label, what) = if loader == "fabric" {
                (
                    "fabric-game-versions.json",
                    format!("{FABRIC_META}/versions/game"),
                    "Fabric's version list",
                    "Fabric",
                )
            } else {
                (
                    "quilt-game-versions.json",
                    format!("{QUILT_META}/versions/game"),
                    "Quilt's version list",
                    "Quilt",
                )
            };
            match cached_json(&dir, file, &url, cached(label, force, fetch))? {
                Value::Array(list) => Ok(list),
                _ => Err(Failure::user(format!("{what}'s version list is not a list"))),
            }
        }
        "forge" => {
            let meta = cached_json(
                &dir,
                "forge-maven-metadata.json",
                &format!("{FORGE_FILES}/maven-metadata.json"),
                cached("Forge's version list", force, fetch),
            );
            // read side by side in Node: the recommended builds are fetched (and cached) whatever
            // came of the version list
            let _promos = cached_json(
                &dir,
                "forge-promotions.json",
                &format!("{FORGE_FILES}/promotions_slim.json"),
                cached("Forge's recommended builds", force, fetch),
            );
            let meta = meta?;
            if !matches!(meta, Value::Object(_)) {
                return Err(Failure::user("Forge's version list is not a list"));
            }
            let mut rows: Vec<String> = crate::registry::entries_of(&meta)
                .into_iter()
                .filter(|(mc, files)| {
                    forge_supported_mc(mc)
                        && files.as_array().is_some_and(|files| {
                            files
                                .iter()
                                .any(|f| is_forge_build(&slice_from(&js::string(Some(f)), js_len(mc) + 1)))
                        })
                })
                .map(|(mc, _)| mc)
                .collect();
            rows.sort_by(|a, b| compare_loader_versions(b, a));
            Ok(rows
                .into_iter()
                .map(|version| json!({ "version": version, "stable": true }))
                .collect())
        }
        "neoforge" => {
            let list = cached_json(
                &dir,
                "neoforge-versions.json",
                NEOFORGE_LIST,
                cached("NeoForge's version list", force, fetch),
            )?;
            let Some(Value::Array(builds)) = super::prop(Some(&list), "versions") else {
                return Err(Failure::user("NeoForge's version list is not a list"));
            };
            let mut by_mc: Vec<(String, bool)> = Vec::new();
            for b in builds {
                let b = js::string(Some(b));
                let Some(mc) = neoforge_mc(&b) else { continue };
                let stable = neoforge_stable(&b);
                match by_mc.iter_mut().find(|(k, _)| *k == mc) {
                    Some((_, s)) => *s = *s || stable,
                    None => by_mc.push((mc, stable)),
                }
            }
            Ok(by_mc
                .into_iter()
                .rev()
                .map(|(version, stable)| json!({ "version": version, "stable": stable }))
                .collect())
        }
        _ => Err(Failure::Internal {
            head: "Error".into(),
            message: format!("unknown loader \"{loader}\""),
            code: None,
        }),
    }
}

/// `<loader>Available(mc, list)`: `list.some((e) => e?.version === mc)`.
pub fn available(mc: &str, list: &[Value]) -> bool {
    list.iter()
        .any(|e| super::prop(Some(e), "version") == Some(&Value::String(mc.to_string())))
}

fn is_old_kind(kind: &str) -> bool {
    matches!(kind, "release" | "beta" | "alpha")
}

/// `<loader>.assertAvailable(mc, { kind })`: refuses a version the loader does not build for,
/// before anything downloads. An id the cached list lacks asks once more; a list that cannot be
/// read decides nothing.
pub fn assert_available(
    paths: &Paths,
    loader: &str,
    mc: &str,
    kind: &str,
    fetch: FetchJson<'_>,
) -> Result<(), Failure> {
    if loader == "forge" && MC_SHAPE.is_match(mc) && !forge_supported_mc(mc) {
        return Err(coded(
            format!(
                "Forge for Minecraft {mc} is older than SpawnLoft offers (1.6.4 and newer). Use None for it."
            ),
            "loader-not-available",
        ));
    }
    let read = || -> Result<Vec<Value>, Failure> {
        let list = game_versions(paths, loader, false, fetch)?;
        if available(mc, &list) {
            return Ok(list);
        }
        game_versions(paths, loader, true, fetch)
    };
    let Ok(list) = read() else {
        return Ok(());
    };
    if available(mc, &list) {
        return Ok(());
    }
    let old = is_old_kind(kind);
    let (message, code) = match loader {
        "fabric" if old => (
            format!(
                "Fabric has no build for Minecraft {mc}; use Vanilla for it, or a version Fabric supports"
            ),
            "fabric-not-available",
        ),
        "fabric" => (
            format!(
                "Fabric has no loader for Minecraft {mc} yet; Fabric usually follows a new {kind} within a day, or use Vanilla for it"
            ),
            "fabric-not-available",
        ),
        "quilt" if !old => (
            format!(
                "Quilt has no loader for Minecraft {mc} yet. Use None for it, or wait for Quilt to catch up."
            ),
            "loader-not-available",
        ),
        _ if old => (
            format!(
                "{} has no build for Minecraft {mc}. Use None, or a version {} supports.",
                display_name(loader),
                display_name(loader)
            ),
            "loader-not-available",
        ),
        _ => (
            format!(
                "{} has no build for Minecraft {mc} yet. Use None for it, or wait for {} to catch up.",
                display_name(loader),
                display_name(loader)
            ),
            "loader-not-available",
        ),
    };
    Err(coded(message, code))
}

/// `loaderLists({ force })`: each loader's list read side by side, `None` for one that could
/// not be read.
pub type Lists = Vec<(&'static str, Option<Vec<Value>>)>;

pub fn loader_lists(paths: &Paths, force: bool, fetch: FetchJson<'_>) -> Lists {
    std::thread::scope(|s| {
        let handles: Vec<_> = MODS
            .iter()
            .map(|id| s.spawn(move || game_versions(paths, id, force, fetch).ok()))
            .collect();
        MODS.iter()
            .zip(handles)
            .map(|(id, h)| (*id, h.join().ok().flatten()))
            .collect()
    })
}

/// `loadersFor(mc, lists)`: `{ fabric: true, quilt: false, ... }`, null for a list not read.
pub fn loaders_for(mc: &str, lists: &Lists) -> Map<String, Value> {
    lists
        .iter()
        .map(|(id, list)| {
            let has = list.as_ref().map_or(Value::Null, |l| json!(available(mc, l)));
            (id.to_string(), has)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_versions_order() {
        let lt = |a: &str, b: &str| compare_loader_versions(a, b) == Ordering::Less;
        assert!(lt("0.30.2-beta.1", "0.30.2"));
        assert!(lt("0.30.2", "0.31.0-beta.6"));
        assert!(lt("1.9", "1.10"));
        assert!(lt("1.2", "1.2.1"));
        assert!(lt("1.2.1", "1.2.a"));
        assert_eq!(compare_loader_versions("1.0+a", "1.0+b"), Ordering::Equal);
    }

    #[test]
    fn neoforge_builds_name_their_version() {
        assert_eq!(neoforge_mc("20.4.253").as_deref(), Some("1.20.4"));
        assert_eq!(neoforge_mc("21.0.5-beta").as_deref(), Some("1.21"));
        assert_eq!(neoforge_mc("26.3.0.103").as_deref(), Some("26.3"));
        assert_eq!(neoforge_mc("26.1.2.14").as_deref(), Some("26.1.2"));
        assert_eq!(neoforge_mc("19.1.2"), None);
        assert_eq!(neoforge_mc("0.25w14craftmine.3-beta"), None);
    }

    #[test]
    fn forge_shapes() {
        assert!(forge_supported_mc("1.6.4"));
        assert!(!forge_supported_mc("1.6.3"));
        assert!(forge_supported_mc("1.20.1"));
        assert!(!forge_supported_mc("1.5.2"));
        assert!(is_forge_build("47.4.28"));
        assert!(is_forge_build("10.13.4.1614-1.7.10"));
        assert!(is_forge_build("1.2-mc172"));
        assert!(!is_forge_build("47.1-new"));
    }

    #[test]
    fn lists_and_refusals() {
        let dir = std::env::temp_dir().join(format!("sl-loaders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths::under(dir.to_str().unwrap());
        let fetch = |url: &str, _: &str| -> Result<Value, Failure> {
            Ok(if url.ends_with("maven-metadata.json") {
                json!({ "1.5.2": ["1.5.2-7.8.1"], "1.20.1": ["1.20.1-47.4.28"], "1.7.10": ["1.7.10-x-new"], "1.21": [] })
            } else if url.ends_with("promotions_slim.json") {
                json!({ "promos": {} })
            } else if url.contains("neoforge") {
                json!({ "versions": ["20.4.1-beta", "20.4.2", "21.0.1-beta"] })
            } else {
                json!([{ "version": "1.21.11", "stable": true }])
            })
        };
        assert_eq!(
            game_versions(&paths, "forge", false, &fetch).unwrap(),
            vec![json!({ "version": "1.20.1", "stable": true })]
        );
        assert_eq!(
            game_versions(&paths, "neoforge", false, &fetch).unwrap(),
            vec![
                json!({ "version": "1.21", "stable": false }),
                json!({ "version": "1.20.4", "stable": true })
            ]
        );
        assert!(assert_available(&paths, "fabric", "1.21.11", "release", &fetch).is_ok());
        let e = assert_available(&paths, "fabric", "1.12.2", "release", &fetch).unwrap_err();
        assert!(
            e.message()
                .starts_with("Fabric has no build for Minecraft 1.12.2;")
        );
        let e = assert_available(&paths, "forge", "1.5.2", "release", &fetch).unwrap_err();
        assert!(e.message().contains("older than SpawnLoft offers"));
        let lists = loader_lists(&paths, false, &fetch);
        let m = loaders_for("1.20.1", &lists);
        assert_eq!(
            Value::Object(m),
            json!({ "fabric": false, "quilt": false, "forge": true, "neoforge": false })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
