//! `upgrade.mjs`: a newer build of the server software, or a newer Minecraft version. A build
//! update keeps the old jar as the way back; crossing Minecraft versions migrates the worlds on
//! the next start, one way, so it takes a standard snapshot first.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::activity::{self, Actor};
use crate::backup;
use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{create, js, jspath, sources};

/// The software `upgrade` can update, by the jar name prefix SpawnLoft gives it.
pub const UPDATABLE: [&str; 4] = ["paper", "folia", "purpur", "asp"];

fn label_of(software: &str) -> &'static str {
    match software {
        "paper" => "Paper",
        "folia" => "Folia",
        "purpur" => "Purpur",
        _ => "Advanced Slime Paper",
    }
}

static JARS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    const MC: &str = r"([0-9]+\.[0-9]+(?:\.[0-9]+)?)";
    let re = |s: &str| Regex::new(&format!("(?i-u)^{s}$")).expect("jar pattern");
    vec![
        ("paper", re(&format!(r"paper-{MC}-([0-9]+)\.jar"))),
        ("folia", re(&format!(r"folia-{MC}-([0-9]+)\.jar"))),
        ("purpur", re(&format!(r"purpur-{MC}-([0-9]+)\.jar"))),
        // builds have no number; the jar carries the first eight characters of the build id
        ("asp", re(&format!(r"asp-{MC}-([0-9a-f]{{8}})\.jar"))),
    ]
});

/// A jar SpawnLoft named: the software, its Minecraft version and its build (a number for
/// Paper, Folia and Purpur, text for ASP).
#[derive(Debug, Clone, PartialEq)]
pub struct ServerJar {
    pub software: &'static str,
    pub label: &'static str,
    pub version: String,
    pub build: Value,
}

/// `String(jar ?? '')`.
fn jar_text(jar: Option<&Value>) -> String {
    match jar {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    }
}

/// `parseServerJar(jar)`: paper-26.2-121.jar is Paper 26.2 build 121, asp-26.3-b77d5e97.jar is
/// ASP 26.3 build b77d5e97; `None` for a jar SpawnLoft did not name.
pub fn parse_server_jar(jar: Option<&Value>) -> Option<ServerJar> {
    let text = jar_text(jar);
    for (software, re) in JARS.iter() {
        if let Some(m) = re.captures(&text) {
            let build = if *software == "asp" {
                json!(m[2].to_string())
            } else {
                number_value(js::string_to_number(&m[2]))
            };
            return Some(ServerJar {
                software,
                label: label_of(software),
                version: m[1].to_string(),
                build,
            });
        }
    }
    None
}

/// A JavaScript number as a value (NaN and the infinities have no JSON form and print as text).
fn number_value(n: f64) -> Value {
    serde_json::Number::from_f64(n).map_or_else(
        || json!(js::number_to_string(n)),
        |x| {
            if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
                json!(n as i64)
            } else {
                Value::Number(x)
            }
        },
    )
}

/// `jarChangeWords(from, to)`: "Paper 1.21.4, build 100 to 130" for the Activity list when both
/// names follow the software's pattern, the two names otherwise.
pub fn jar_change_words(from: Option<&Value>, to: &str) -> String {
    static PARTS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i-u)^([a-z]+)-([0-9][A-Za-z0-9_.]*?)-([0-9]+)\.jar$").expect("parts pattern")
    });
    let from_text = jar_text(from);
    let a = PARTS.captures(&from_text);
    let b = PARTS.captures(to);
    let (Some(a), Some(b)) = (a, b) else {
        return format!("{} to {to}", js::string(from));
    };
    if a[1].to_lowercase() != b[1].to_lowercase() {
        return format!("{} to {to}", js::string(from));
    }
    let name = &b[1];
    let software = format!("{}{}", name[..1].to_uppercase(), name[1..].to_lowercase());
    if a[2] == b[2] {
        format!("{software} {}, build {} to {}", &b[2], &a[3], &b[3])
    } else {
        format!(
            "{software} {} (build {}) to {} (build {})",
            &a[2], &a[3], &b[2], &b[3]
        )
    }
}

/// `compareMcVersions(a, b)`: by number, part by part; 26.3 after 26.2.1, 1.21.10 after 1.21.9.
/// A part that is not a number compares equal to anything, as NaN does there.
pub fn compare_mc_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<f64> = a.split('.').map(js::string_to_number).collect();
    let pb: Vec<f64> = b.split('.').map(js::string_to_number).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0.0) - pb.get(i).copied().unwrap_or(0.0);
        if d != 0.0 && !d.is_nan() {
            return if d > 0.0 { 1 } else { -1 };
        }
    }
    0
}

/// `newerVersionsOf(all, current)`: newest first, by number (ASP orders by last build).
pub fn newer_versions_of(all: &[String], current: &str) -> Vec<String> {
    if !all.iter().any(|v| v == current) {
        return Vec::new();
    }
    let mut out: Vec<String> = all
        .iter()
        .filter(|v| compare_mc_versions(v, current) > 0)
        .cloned()
        .collect();
    out.sort_by(|a, b| compare_mc_versions(b, a).cmp(&0));
    out
}

fn versions_of(software: &str) -> Result<Vec<String>, Failure> {
    match software {
        "paper" | "folia" => sources::paper_versions(software, false),
        "purpur" => sources::purpur_versions(),
        _ => Ok(sources::asp_versions_of(&sources::asp_builds()?)),
    }
}

/// The newest build of a version: its build, channel, time, and whether it is newer than
/// `current`.
#[derive(Debug, Clone, PartialEq)]
pub struct Latest {
    pub build: Value,
    pub channel: Value,
    pub time: Value,
    pub newer: bool,
}

fn latest_of(software: &str, version: &str, current: &Value) -> Result<Latest, Failure> {
    let cur = js::number(Some(current));
    match software {
        "paper" | "folia" => {
            let b = sources::paper_resolve_build(software, version, None)?;
            let n = js::number(Some(&b.build));
            Ok(Latest {
                build: number_value(n),
                channel: b.channel,
                time: match b.time {
                    Value::Null => Value::Null,
                    t => t,
                },
                newer: n > cur,
            })
        }
        "purpur" => {
            let (latest, _) = sources::purpur_builds(version)?;
            let n = js::string_to_number(&latest);
            Ok(Latest {
                build: number_value(n),
                channel: Value::Null,
                time: Value::Null,
                newer: n > cur,
            })
        }
        _ => {
            let builds = sources::asp_builds()?;
            match sources::asp_compare(&builds, version, &js::string(Some(current)))? {
                None => Err(Failure::user(format!(
                    "Advanced Slime Paper has no build for Minecraft {version}."
                ))),
                Some((build, time, newer)) => Ok(Latest {
                    build: json!(build),
                    channel: Value::Null,
                    time: json!(time),
                    newer,
                }),
            }
        }
    }
}

/// What `checkUpgrade` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub current: Option<ServerJar>,
    pub latest_build: Option<Latest>,
    pub newer_versions: Vec<String>,
    pub latest_version: Option<String>,
}

/// `checkUpgrade(inst)`: a jar SpawnLoft did not name gets no current version and only Paper's
/// newest version (whose list is still asked for).
pub fn check_upgrade(inst: &Instance) -> Result<Check, Failure> {
    let current = parse_server_jar(inst.get("jar"));
    let software = current.as_ref().map_or("paper", |c| c.software);
    let all = versions_of(software)?;
    let newer_versions = match &current {
        Some(c) => newer_versions_of(&all, &c.version),
        None => Vec::new(),
    };
    let latest_version = match (newer_versions.first(), &current) {
        (Some(v), _) => Some(v.clone()),
        (None, Some(c)) => Some(c.version.clone()),
        (None, None) => {
            let mut sorted = all.clone();
            sorted.sort_by(|a, b| compare_mc_versions(b, a).cmp(&0));
            sorted.into_iter().next()
        }
    };
    let latest_build = match &current {
        Some(c) => Some(latest_of(c.software, &c.version, &c.build)?),
        None => None,
    };
    Ok(Check {
        current,
        latest_build,
        newer_versions,
        latest_version,
    })
}

/// What `applyUpgrade` did.
#[derive(Debug, Clone, PartialEq)]
pub enum Applied {
    /// the fetched jar is the one the server already runs
    AlreadyCurrent { jar: String },
    Done {
        from: Value,
        to: String,
        channel: Value,
        snapshot: Option<String>,
        old_jars: Vec<String>,
    },
}

/// `applyUpgrade(name, { version, build, running })`: the jar fetched, a snapshot first when
/// crossing versions (after the fetch, so a failed download costs none), the jar placed and the
/// record moved to it. The old jar stays in the folder as the way back.
pub fn apply_upgrade(
    layout: &Layout,
    by: &Actor,
    name: &str,
    version: Option<&str>,
    build: &Value,
    running: bool,
) -> Result<Applied, Failure> {
    apply_upgrade_detail(layout, by, name, version, build, running).map(|u| u.applied)
}

/// [`apply_upgrade`] with the rest of what `applyUpgrade` answers, which the panel sends on.
#[derive(Debug, Clone, PartialEq)]
pub struct Upgraded {
    pub applied: Applied,
    /// `source.label`: the software's name
    pub label: &'static str,
    /// the Minecraft version aimed at
    pub version: String,
    /// `fetched.build`
    pub build: Value,
    pub cross_version: bool,
}

/// `applyUpgrade(name, { version, build, running })`, all of its answer.
pub fn apply_upgrade_detail(
    layout: &Layout,
    by: &Actor,
    name: &str,
    version: Option<&str>,
    build: &Value,
    running: bool,
) -> Result<Upgraded, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let current = parse_server_jar(inst.get("jar"));
    let Some(target) = version
        .map(str::to_string)
        .or_else(|| current.as_ref().map(|c| c.version.clone()))
    else {
        return Err(Failure::user(format!(
            "\"{}\" is not a jar SpawnLoft can reason about - name a version: upgrade {name} --version <v>",
            js::string(inst.get("jar"))
        )));
    };
    // an unnamed jar is treated as Paper
    let software = current.as_ref().map_or("paper", |c| c.software);
    let cross_version = current.as_ref().is_some_and(|c| target != c.version);

    let wanted = match build {
        Value::Null => None,
        v => Some(js::string(Some(v))),
    };
    let jars = layout.jars_dir.as_str();
    let fetched = match software {
        "paper" | "folia" => sources::paper_fetch(jars, software, &target, wanted.as_deref(), false)?,
        "purpur" => sources::purpur_fetch(jars, &target, wanted.as_deref(), false)?,
        _ => {
            // the API only offers the newest build per version
            if wanted.is_some() {
                return Err(Failure::user(
                    "Advanced Slime Paper builds cannot be chosen by id; SpawnLoft fetches the newest one.",
                ));
            }
            sources::asp_fetch(jars, &target, false)?
        }
    };
    let upgraded = |applied: Applied, build: Value| Upgraded {
        applied,
        label: label_of(software),
        version: target.clone(),
        build,
        cross_version,
    };
    if inst.get("jar").and_then(Value::as_str) == Some(fetched.name.as_str()) {
        return Ok(upgraded(
            Applied::AlreadyCurrent { jar: fetched.name },
            fetched.build,
        ));
    }

    let mut snapshot = None;
    if cross_version {
        let opts = backup::Options {
            scope: "standard".into(),
            label: json!("pre-upgrade"),
            running,
            quiet: true,
            ..backup::Options::default()
        };
        snapshot = Some(backup::create_snapshot(layout, by, &inst, &opts)?.file);
    }

    let dir = create::path_arg(inst.get("dir"), "path")?.to_string();
    create::place_jar(jars, &dir, &fetched.name)?;
    // mcVersion moves with the jar: it picks the Java and the plugin builds offered. A server
    // that never recorded one reads it from the jar name instead.
    let mut patch = Map::new();
    patch.insert("jar".into(), json!(fetched.name));
    if js::truthy(inst.get("mcVersion")) {
        patch.insert("mcVersion".into(), json!(target));
    }
    registry::update_instance(Path::new(&layout.registry_file), name, &patch)?;
    let detail = jar_change_words(inst.get("jar"), &fetched.name);
    let snap_base = snapshot.as_deref().map(jspath::basename);
    activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        name,
        "upgrade",
        Some(&detail),
        snap_base.as_deref(),
        true,
    );
    let old_jars = create::stray_jars(&dir, &fetched.name)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    Ok(upgraded(
        Applied::Done {
            from: inst.get("jar").cloned().unwrap_or(Value::Null),
            to: fetched.name,
            channel: fetched.channel,
            snapshot,
            old_jars,
        },
        fetched.build,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jars_are_parsed_and_changes_worded() {
        let p = parse_server_jar(Some(&json!("Paper-1.21.4-130.jar"))).unwrap();
        assert_eq!(
            (p.software, p.version.as_str(), p.build.clone()),
            ("paper", "1.21.4", json!(130))
        );
        let a = parse_server_jar(Some(&json!("asp-26.3-b77d5e97.jar"))).unwrap();
        assert_eq!(a.build, json!("b77d5e97"));
        assert!(parse_server_jar(Some(&json!("custom.jar"))).is_none());
        assert!(parse_server_jar(None).is_none());
        assert_eq!(
            jar_change_words(Some(&json!("paper-1.21.4-100.jar")), "paper-1.21.4-130.jar"),
            "Paper 1.21.4, build 100 to 130"
        );
        assert_eq!(
            jar_change_words(Some(&json!("paper-1.21.3-9.jar")), "PAPER-1.21.4-1.jar"),
            "Paper 1.21.3 (build 9) to 1.21.4 (build 1)"
        );
        assert_eq!(jar_change_words(None, "x.jar"), "undefined to x.jar");
    }

    #[test]
    fn versions_compare_by_number() {
        assert_eq!(compare_mc_versions("26.3", "26.2.1"), 1);
        assert_eq!(compare_mc_versions("1.21.10", "1.21.9"), 1);
        assert_eq!(compare_mc_versions("1.21", "1.21.0"), 0);
        assert_eq!(compare_mc_versions("1.x", "1.2"), 0);
        let all: Vec<String> = ["1.21.4", "1.21.10", "1.20", "1.21.5"].map(String::from).to_vec();
        assert_eq!(newer_versions_of(&all, "1.21.4"), vec!["1.21.10", "1.21.5"]);
        assert!(newer_versions_of(&all, "1.19").is_empty());
    }
}
