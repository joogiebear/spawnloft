//! `client-version.mjs`: the id rules, and one reading of a version file (merged with its loader
//! profile first) into everything install and launch need. Anything in the file SpawnLoft does
//! not understand becomes a problem, and a version with a problem is refused before Java is
//! looked for or anything but the file is downloaded.

use regex::Regex;
use serde_json::{Map, Value, json};

use super::library::{self, LoggingConfig, Row};
use super::rules::{self, Os};
use super::{nullish, prop};
use crate::failure::Failure;
use crate::js;
use std::sync::LazyLock;

static SAFE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$").expect("valid"));
static PRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-pre-?\d| Pre-Release \d").expect("valid"));
static RC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-rc-?\d").expect("valid"));

/// `isSafeVersionId(id)`: a version id as it may reach a folder name, a URL and the game's
/// command line; a trailing dot or space is refused (Windows drops them from folder names).
pub fn is_safe_version_id(id: &str) -> bool {
    SAFE_ID.is_match(id) && !id.contains("..") && !id.ends_with('.') && !id.ends_with(' ')
}

/// `versionKind({ id, type })`.
pub fn version_kind(id: &str, kind: Option<&str>) -> &'static str {
    match kind {
        Some("release") => "release",
        Some("old_beta") => "beta",
        Some("old_alpha") => "alpha",
        _ if PRE.is_match(id) => "pre-release",
        _ if RC.is_match(id) => "release-candidate",
        _ => "snapshot",
    }
}

/// Mojang's launcher format; 21 since 1.13.
pub const LAUNCHER_FORMAT: f64 = 21.0;

/// Every `${name}` SpawnLoft fills in.
pub const LAUNCH_VARIABLES: &[&str] = &[
    "classpath",
    "classpath_separator",
    "library_directory",
    "natives_directory",
    "game_directory",
    "assets_root",
    "assets_index_name",
    "version_name",
    "version_type",
    "launcher_name",
    "launcher_version",
    "auth_player_name",
    "auth_uuid",
    "auth_access_token",
    "clientid",
    "auth_xuid",
    "user_type",
    "quickPlayMultiplayer",
    "quickPlayPath",
    "auth_session",
    "game_assets",
    "user_properties",
    "resolution_width",
    "resolution_height",
    "quickPlaySingleplayer",
    "quickPlayRealms",
    "path",
];

/// `launchFeatures({ hasServer })`.
pub fn launch_features(has_server: bool) -> Map<String, Value> {
    let mut m = Map::new();
    for (k, v) in [
        ("is_demo_user", false),
        ("has_custom_resolution", false),
        ("has_quick_plays_support", has_server),
        ("is_quick_play_singleplayer", false),
        ("is_quick_play_multiplayer", has_server),
        ("is_quick_play_realms", false),
    ] {
        m.insert(k.into(), Value::Bool(v));
    }
    m
}

/// `javaRequirement(version)`: the Java a version runs on.
#[derive(Debug, Clone, PartialEq)]
pub struct JavaRequirement {
    pub major: f64,
    pub component: String,
    pub min: f64,
    pub max: Option<f64>,
    pub prefer: f64,
}

pub fn java_requirement(version: &Value) -> JavaRequirement {
    let jv = prop(Some(version), "javaVersion");
    let major = match prop(jv, "majorVersion") {
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.is_finite() && *f >= 1.0)
            .unwrap_or(8.0),
        _ => 8.0,
    };
    let component = match prop(jv, "component") {
        Some(Value::String(s)) => s.clone(),
        _ => "jre-legacy".into(),
    };
    if component == "jre-legacy" {
        let max = if js::truthy(prop(Some(version), "arguments")) {
            17.0
        } else {
            8.0
        };
        return JavaRequirement {
            major,
            component,
            min: 8.0,
            max: Some(max),
            prefer: 8.0,
        };
    }
    // Temurin publishes no 16, and Mojang's runtime is the only place one comes from
    JavaRequirement {
        major,
        component,
        min: major,
        max: None,
        prefer: if major == 16.0 { 17.0 } else { major },
    }
}

/// `collectVariables(args)`: the `${name}`s, in order of first use.
pub fn collect_variables(args: &[Value]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for arg in args {
        let text = js::string(Some(arg));
        let mut rest = text.as_str();
        while let Some(at) = rest.find("${") {
            let after = &rest[at + 2..];
            let len = after
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                .count();
            if len > 0 && after.as_bytes().get(len) == Some(&b'}') {
                let name = after[..len].to_string();
                if !names.contains(&name) {
                    names.push(name);
                }
                rest = &after[len + 1..];
            } else {
                rest = &rest[at + 1..];
            }
        }
    }
    names
}

/// One reason a version cannot be run here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub code: &'static str,
    pub message: String,
}

/// `resolveVersion(version, ...)`.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub id: Value,
    pub kind: Value,
    pub release_time: Value,
    pub java: JavaRequirement,
    /// The machine as the game runs on it (the emulated arch when it is emulated).
    pub os: Os,
    pub emulated: bool,
    pub main_class: Option<Value>,
    pub jvm: Vec<Value>,
    pub game: Vec<Value>,
    pub libraries: Vec<Row>,
    pub natives: Vec<Row>,
    pub natives_dir: String,
    pub natives_extra_dirs: Vec<String>,
    pub natives_stamp: String,
    pub logging: Option<LoggingConfig>,
    pub asset_index: Value,
    pub client_jar: Value,
    pub minimum_launcher_version: Option<f64>,
    pub format_ok: bool,
    pub variables: Vec<String>,
    pub problems: Vec<Problem>,
}

/// `[...(x ?? [])]` for the lists a version file holds.
fn list(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

fn argument_rules(version: &Value) -> Vec<Value> {
    let args = prop(Some(version), "arguments");
    let mut rows = list(prop(args, "jvm"));
    rows.extend(list(prop(args, "game")));
    rows.iter()
        .filter(|a| matches!(a, Value::Object(_) | Value::Array(_)))
        .flat_map(|a| list(prop(Some(a), "rules")))
        .collect()
}

/// `nativesStamp(version, os)`: whose natives a folder holds and from what.
pub fn natives_stamp(version: &Value, os: &Os) -> Result<String, Failure> {
    let jvm = rules::jvm_arguments(version, os, &Map::new())?;
    let natives: Vec<Value> = library::libraries(version, os)?
        .into_iter()
        .filter_map(|r| r.native.map(|ex| json!([r.name, r.path, r.sha1, ex])))
        .collect();
    let text = crate::jsjson::stringify(&json!({ "jvm": jvm, "natives": natives }));
    let hash = crate::sha1::hex(text.as_bytes());
    Ok(format!(
        "{} {} {} {hash}",
        js::string(prop(Some(version), "id")),
        os.name,
        os.arch
    ))
}

/// `resolveVersion(version, { os, features, hostCaps, launcherFormat })`.
pub fn resolve_version(
    version: &Value,
    os: &Os,
    features: &Map<String, Value>,
    host_x64: Option<bool>,
    launcher_format: f64,
) -> Result<Resolved, Failure> {
    let id = match prop(Some(version), "id") {
        v if nullish(v) => "this version".to_string(),
        v => js::string(v),
    };
    let what = format!("Minecraft {id}");
    let mut problems = Vec::new();

    let decision = library::arch_decision(Some(version), os, host_x64)?;
    if let Some(r) = &decision.refusal {
        problems.push(Problem {
            code: "no-natives-for-this-machine",
            message: r.clone(),
        });
    }
    let run_os = os.as_arch(&decision.arch);

    let mut all_rules: Vec<Value> = list(prop(Some(version), "libraries"))
        .iter()
        .flat_map(|l| list(prop(Some(l), "rules")))
        .collect();
    all_rules.extend(argument_rules(version));
    let unknown = rules::rule_problems(Some(&Value::Array(all_rules)), &run_os)?;
    if !unknown.is_empty() {
        problems.push(Problem {
            code: "unknown-rule-key",
            message: format!(
                "{what} uses a platform rule SpawnLoft does not know ({}). Update SpawnLoft.",
                unknown.join(", ")
            ),
        });
    }

    let jvm = rules::jvm_arguments(version, &run_os, features)?;
    let game = rules::game_arguments(version, &run_os, features)?;
    let mut both = jvm.clone();
    both.extend(game.iter().cloned());
    let variables = collect_variables(&both);
    let unknown_vars: Vec<String> = variables
        .iter()
        .filter(|v| !LAUNCH_VARIABLES.contains(&v.as_str()))
        .map(|v| format!("${{{v}}}"))
        .collect();
    if !unknown_vars.is_empty() {
        problems.push(Problem {
            code: "unknown-variable",
            message: format!(
                "{what} uses a launcher setting SpawnLoft does not know ({}). Update SpawnLoft.",
                unknown_vars.join(", ")
            ),
        });
    }

    let minimum = match prop(Some(version), "minimumLauncherVersion") {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()),
        _ => None,
    };
    let format_ok = minimum.is_none_or(|m| m <= launcher_format);
    if let Some(m) = minimum.filter(|_| !format_ok) {
        problems.push(Problem {
            code: "newer-launcher-format",
            message: format!(
                "{what} needs launcher format {}; this SpawnLoft knows {}. Update SpawnLoft.",
                js::number_to_string(m),
                js::number_to_string(launcher_format)
            ),
        });
    }

    let libraries = library::libraries(version, &run_os)?;
    let natives: Vec<Row> = libraries.iter().filter(|r| r.native.is_some()).cloned().collect();
    let natives_dir = rules::natives_library_subdir(version, &run_os)?;
    let natives_extra_dirs = rules::natives_extra_dirs(version, &run_os)?;
    let natives_stamp = natives_stamp(version, &run_os)?;
    let logging = library::logging_config(version)?;
    let asset_index = library::asset_index(version)?;
    Ok(Resolved {
        id: super::or_null(prop(Some(version), "id")),
        kind: match prop(Some(version), "type") {
            v if nullish(v) => json!("release"),
            v => v.cloned().unwrap_or(Value::Null),
        },
        release_time: super::or_null(prop(Some(version), "releaseTime")),
        java: java_requirement(version),
        os: run_os,
        emulated: decision.emulated,
        main_class: prop(Some(version), "mainClass").cloned(),
        jvm,
        game,
        libraries,
        natives,
        natives_dir,
        natives_extra_dirs,
        natives_stamp,
        logging,
        asset_index,
        client_jar: super::or_null(prop(prop(Some(version), "downloads"), "client")),
        minimum_launcher_version: minimum,
        format_ok,
        variables,
        problems,
    })
}

/// `resolvedRefusal(resolved)`: the one-line refusal and the first problem's code, or `None`.
pub fn resolved_refusal(resolved: &Resolved) -> Option<Failure> {
    let first = resolved.problems.first()?;
    Some(Failure::User {
        message: resolved
            .problems
            .iter()
            .map(|p| p.message.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        code: Some(first.code.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        for ok in [
            "1.21.11",
            "26.4-snapshot-6",
            "b1.7.3",
            "1.14.2 Pre-Release 4",
            "rd-132211",
        ] {
            assert!(is_safe_version_id(ok), "{ok}");
        }
        for bad in ["", ".1", "1..2", "1.2.", "1.2 ", "a/b", &"x".repeat(65)] {
            assert!(!is_safe_version_id(bad), "{bad}");
        }
    }

    #[test]
    fn kinds() {
        assert_eq!(version_kind("1.21", Some("release")), "release");
        assert_eq!(version_kind("b1.7.3", Some("old_beta")), "beta");
        assert_eq!(version_kind("1.21-pre1", Some("snapshot")), "pre-release");
        assert_eq!(
            version_kind("1.14.2 Pre-Release 4", Some("snapshot")),
            "pre-release"
        );
        assert_eq!(version_kind("1.21-rc1", Some("snapshot")), "release-candidate");
        assert_eq!(version_kind("24w14a", Some("snapshot")), "snapshot");
        assert_eq!(version_kind("x", None), "snapshot");
    }
}
