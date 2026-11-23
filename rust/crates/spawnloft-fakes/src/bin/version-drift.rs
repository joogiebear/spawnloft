//! The weekly check that Mojang's formats still fit this SpawnLoft (version-drift.yml), ported
//! from the Node core's tools/check-version-drift.mjs. Fetches the version list, the newest
//! release and snapshot, Fabric's profile for that release, their asset indexes and Mojang's Java
//! runtime list, runs the launcher's own resolver on them for every OS and arch it knows, and
//! fails on anything a launch would refuse or a SpawnLoft release would be needed for. The facts
//! that change only with Mojang (log config ids, natives classifiers, runtime platforms) are
//! compared with tools/version-drift-baseline.json. It also checks the signed harness list as the
//! mod repo publishes it: the list verifies with the keys this SpawnLoft trusts, and every jar it
//! and HARNESS_RELEASES name still downloads with its sha256. And it sets Quilt, Forge and
//! NeoForge up for the newest release as a first Play does up to the build steps (the newest
//! build and the one a setup gets by default): an installer spec, a download host or a launch
//! variable this SpawnLoft does not know is drift. That writes the loaders' version files and
//! libraries, so it runs only with SPAWNLOFT_DATA_ROOT naming a data folder of its own.
//! Test-only; never shipped.
//!
//!   version-drift [--report <file.md>] [--update-baseline] [--baseline <file>]
//!
//! Exits 1 when it found a problem, 2 on a usage error or an unreadable baseline.

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{Map, Value, json};
use spawnloft_lib::client::harness::HARNESS_RELEASES;
use spawnloft_lib::client::harness_index::{
    self, HARNESS_INDEX_KEYS, HARNESS_INDEX_MIN_SERIAL, HARNESS_INDEX_SIG_URL, HARNESS_INDEX_URL, Key,
    MAX_INDEX_BYTES, MAX_SIG_BYTES, Row as HarnessRow,
};
use spawnloft_lib::client::library::{asset_layout, merge_inherited};
use spawnloft_lib::client::loaders::FABRIC_META;
use spawnloft_lib::client::meta::{MANIFEST_URL, default_fetch};
use spawnloft_lib::client::paths::Paths;
use spawnloft_lib::client::rules::Os;
use spawnloft_lib::client::runtime::{RUNTIME_INDEX_URL, platform_key};
use spawnloft_lib::client::version::{LAUNCHER_FORMAT, launch_features, resolve_version, version_kind};
use spawnloft_lib::client::{fabric, forge};
use spawnloft_lib::failure::Failure;

/// `get(url, label)`: one JSON document.
type Get<'a> = &'a dyn Fn(&str, &str) -> Result<Value, Failure>;
/// `getBytes(url, label, maxBytes)`: one file, capped.
type GetBytes<'a> = &'a dyn Fn(&str, &str, u64) -> Result<Vec<u8>, Failure>;

/// Every machine the resolver is asked about, os.version as the OS reports it there.
const OS_PAIRS: [(&str, &str, &str); 7] = [
    ("windows", "x64", "10.0.22631"),
    ("windows", "arm64", "10.0.22631"),
    ("windows", "x86", "10.0.19045"),
    ("osx", "arm64", "24.1.0"),
    ("osx", "x64", "24.1.0"),
    ("linux", "x64", "6.8.0-45-generic"),
    ("linux", "arm64", "6.8.0-45-generic"),
];

/// Where a newest version that cannot launch is drift. Mojang ships nothing for Linux arm64, has
/// dropped Windows x86, and Intel Macs are not a target, so a refusal there is only noted.
const MUST_LAUNCH: [&str; 4] = ["windows-x64", "windows-arm64", "osx-arm64", "linux-x64"];

/// The picker's kinds come from these manifest types (version_kind).
const KNOWN_TYPES: [&str; 4] = ["release", "snapshot", "old_beta", "old_alpha"];

/// natives-<os>[suffix] the launcher can place (library.rs's arch matching).
const OS_PARTS: [&str; 4] = ["windows", "macos", "osx", "linux"];
const SUFFIXES: [&str; 4] = ["", "-arm64", "-x86", "-patch"];

/// The loaders set up here, past Fabric (whose profile is read in check_drift).
const DRIFT_LOADERS: [&str; 3] = ["quilt", "forge", "neoforge"];

/// The harness jars are fetched with this cap.
const MAX_JAR_BYTES: u64 = 32 * 1024 * 1024;

/// The extra feature flags, so a variable gated behind one still shows.
fn all_features() -> Map<String, Value> {
    let mut m = launch_features(false);
    for k in [
        "has_custom_resolution",
        "is_quick_play_singleplayer",
        "is_quick_play_multiplayer",
        "is_quick_play_realms",
    ] {
        m.insert(k.into(), Value::Bool(true));
    }
    m
}

fn code_of(e: &Failure) -> Option<&str> {
    match e {
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.as_deref(),
        Failure::Usage(_) => None,
    }
}

fn texts(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        _ => Vec::new(),
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Every natives classifier a version names: in a library's coordinates, its classifier
/// downloads and its old-style `natives` map.
fn natives_classifiers(version: &Value) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |c: String| {
        if !found.contains(&c) {
            found.push(c);
        }
    };
    for lib in texts(version.get("libraries")) {
        let name = text(lib.get("name"));
        if let Some(part) = name.split(':').nth(3)
            && part.starts_with("natives-")
        {
            add(part.split('@').next().unwrap_or(part).to_string());
        }
        if let Some(Value::Object(m)) = lib.get("downloads").and_then(|d| d.get("classifiers")) {
            for key in m.keys().filter(|k| k.starts_with("natives-")) {
                add(key.clone());
            }
        }
        if let Some(Value::Object(m)) = lib.get("natives") {
            for value in m.values() {
                add(text(Some(value)).replace("${arch}", "64"));
            }
        }
    }
    found.sort();
    found
}

/// `/^natives-([a-z]+)(.*)$/` with a known OS and suffix.
fn placeable(classifier: &str) -> bool {
    let Some(rest) = classifier.strip_prefix("natives-") else {
        return false;
    };
    let cut = rest.bytes().take_while(u8::is_ascii_lowercase).count();
    cut > 0 && OS_PARTS.contains(&&rest[..cut]) && SUFFIXES.contains(&&rest[cut..])
}

/// `/answered 4\d\d\b/`: an address that answers 4xx.
fn answered_4xx(message: &str) -> bool {
    let b = message.as_bytes();
    message.match_indices("answered 4").any(|(at, m)| {
        let d = at + m.len();
        b.len() >= d + 2
            && b[d].is_ascii_digit()
            && b[d + 1].is_ascii_digit()
            && b.get(d + 2)
                .is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
    })
}

/// A loader that cannot be reached or has no build yet: a note. An address that answers 4xx (a
/// moved installer, a list that is gone) and anything else (an installer spec, a host, a file
/// the installer does not list) is drift.
fn passes(err: &Failure) -> bool {
    let code = code_of(err);
    if code == Some("loader-not-available") {
        return true;
    }
    if answered_4xx(err.message()) {
        return false;
    }
    matches!(code, None | Some("loader-unreachable" | "download-failed"))
}

/// One version the resolver is run on.
#[derive(Debug, Clone)]
struct Version {
    label: String,
    json: Value,
    modded: bool,
}

/// One line of the report's table.
#[derive(Debug, Clone, PartialEq)]
struct ResultRow {
    version: String,
    pair: String,
    features: &'static str,
    result: String,
}

/// What the loaders past Fabric gave.
#[derive(Debug, Default)]
struct LoaderOutcome {
    versions: Vec<Version>,
    failures: Vec<String>,
    notes: Vec<String>,
}

/// One loader as check_loaders uses it: its newest build and the one a setup gets by default
/// (`None` when it has none for this release yet), and a set-up that writes a version file and
/// hands back its id.
#[allow(clippy::type_complexity)]
struct Loader<'a> {
    name: &'static str,
    picks: Box<dyn Fn(&str) -> Result<Option<(String, String)>, Failure> + 'a>,
    ensure: Box<dyn Fn(&str, &str) -> Result<String, Failure> + 'a>,
}

impl std::fmt::Debug for Loader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Loader").field("name", &self.name).finish()
    }
}

/// Quilt, Forge and NeoForge as a first Play sets them up, into `paths`.
fn real_loaders(paths: &Paths) -> Vec<Loader<'_>> {
    DRIFT_LOADERS
        .iter()
        .map(|&id| -> Loader<'_> {
            if id == "quilt" {
                Loader {
                    name: "Quilt",
                    picks: Box::new(|mc| {
                        let builds = fabric::quilt_builds(mc, &default_fetch)?;
                        if builds.is_empty() {
                            return Ok(None);
                        }
                        Ok(Some((
                            builds[0].text(),
                            fabric::pick("quilt", &builds, None)?.text(),
                        )))
                    }),
                    ensure: Box::new(move |mc, build| {
                        fabric::ensure_quilt_profile(
                            paths,
                            mc,
                            build,
                            &default_fetch,
                            &fabric::default_fetch_sha1,
                        )
                    }),
                }
            } else {
                Loader {
                    name: if id == "forge" { "Forge" } else { "NeoForge" },
                    picks: Box::new(move |mc| {
                        let builds = forge::builds(paths, id, mc, &default_fetch)?;
                        if builds.is_empty() {
                            return Ok(None);
                        }
                        Ok(Some((
                            builds[0].version.clone(),
                            forge::pick(id, &builds, None)?.version,
                        )))
                    }),
                    ensure: Box::new(move |mc, build| {
                        forge::ensure_installed(paths, id, mc, build, &mut |_| {}, &fabric::Fetchers::real())
                    }),
                }
            }
        })
        .collect()
}

/// Each loader for one release. The version file each writes is merged with the release, so the
/// resolver sees what a launch would. `read_version(id)` reads a version file it wrote.
fn check_loaders(
    release: &Value,
    loaders: &[Loader<'_>],
    read_version: &dyn Fn(&str) -> Result<Value, Failure>,
) -> LoaderOutcome {
    let mut out = LoaderOutcome::default();
    let mc = text(release.get("id"));
    for l in loaders {
        let (newest, default) = match (l.picks)(&mc) {
            Ok(Some(p)) => p,
            Ok(None) => {
                out.notes.push(format!("{} has no build for {mc} yet", l.name));
                continue;
            }
            Err(err) => {
                let line = format!(
                    "{}'s builds for {mc} could not be read: {}",
                    l.name,
                    err.message()
                );
                if passes(&err) {
                    &mut out.notes
                } else {
                    &mut out.failures
                }
                .push(line);
                continue;
            }
        };
        let mut picks = vec![newest];
        if !picks.contains(&default) {
            picks.push(default);
        }
        for build in picks {
            let set_up = (l.ensure)(&mc, &build)
                .and_then(|vid| read_version(&vid))
                .and_then(|json| merge_inherited(&json, release));
            match set_up {
                Ok(json) => out.versions.push(Version {
                    label: format!("{mc} + {} {build}", l.name),
                    json,
                    modded: true,
                }),
                Err(err) => {
                    let line = format!("{} {build} for {mc}: {}", l.name, err.message());
                    if passes(&err) {
                        &mut out.notes
                    } else {
                        &mut out.failures
                    }
                    .push(line);
                }
            }
        }
    }
    out
}

/// The facts compared with the baseline.
#[derive(Debug, Clone, PartialEq)]
struct Facts {
    logging_ids: Vec<String>,
    natives_classifiers: Vec<String>,
    runtime_platforms: Option<Vec<String>>,
}

impl Facts {
    fn to_json(&self) -> Value {
        json!({
            "loggingIds": self.logging_ids,
            "nativesClassifiers": self.natives_classifiers,
            "runtimePlatforms": self.runtime_platforms,
        })
    }
}

/// Everything the check found.
#[derive(Debug, Default)]
struct Drift {
    rows: Vec<ResultRow>,
    failures: Vec<String>,
    notes: Vec<String>,
    facts: Option<Facts>,
}

fn sorted(v: &[String]) -> Vec<String> {
    let mut v = v.to_vec();
    v.sort();
    v
}

fn joined_or_none(v: &[String]) -> String {
    if v.is_empty() { "none".into() } else { v.join(", ") }
}

/// Mojang's newest versions, Fabric's profile and `loaders` for the newest release, their asset
/// indexes and the Java runtime list. A baseline of `None` skips the comparisons (it is being
/// written).
fn check_drift(get: Get<'_>, baseline: Option<&Value>, loaders: &dyn Fn(&Value) -> LoaderOutcome) -> Drift {
    let mut d = Drift::default();
    let fact = |failures: &mut Vec<String>, label: &str, url: &str, what: &str| -> Option<Value> {
        get(url, what)
            .map_err(|err| failures.push(format!("{label}: {}", err.message())))
            .ok()
    };

    let Some(manifest) = fact(
        &mut d.failures,
        "the version list",
        MANIFEST_URL,
        "the version list",
    ) else {
        return d;
    };
    let entries = texts(manifest.get("versions"));
    let mut unknown: Vec<String> = Vec::new();
    for e in &entries {
        let t = text(e.get("type"));
        if !KNOWN_TYPES.contains(&t.as_str()) && !unknown.contains(&t) {
            unknown.push(t);
        }
    }
    if !unknown.is_empty() {
        d.failures.push(format!(
            "the version list has types the picker does not know: {}",
            unknown.join(", ")
        ));
    }

    let latest = manifest.get("latest");
    let latest_release = text(latest.and_then(|l| l.get("release")));
    let mut newest: Vec<String> = Vec::new();
    for id in [
        latest_release.clone(),
        text(latest.and_then(|l| l.get("snapshot"))),
    ] {
        if !id.is_empty() && !newest.contains(&id) {
            newest.push(id);
        }
    }
    let mut versions: Vec<Version> = Vec::new();
    for id in &newest {
        let Some(entry) = entries.iter().find(|v| text(v.get("id")) == *id) else {
            d.failures.push(format!(
                "the version list names {id} as latest but does not list it"
            ));
            continue;
        };
        let url = text(entry.get("url"));
        if let Some(json) = fact(&mut d.failures, id, &url, &format!("the {id} JSON")) {
            let kind = entry.get("type").and_then(Value::as_str);
            versions.push(Version {
                label: format!("{id} ({})", version_kind(id, kind)),
                json,
                modded: false,
            });
        }
    }

    // Fabric for the newest release: a release Fabric has not caught up with yet is only a note
    if let Some(release) = versions
        .iter()
        .find(|v| text(v.json.get("id")) == latest_release)
        .map(|v| v.json.clone())
    {
        let rid = text(release.get("id"));
        let enc = harness_index::encode_uri_component;
        let fabric = (|| -> Result<Option<Version>, Failure> {
            let list = get(
                &format!("{FABRIC_META}/versions/loader/{}", enc(&rid)),
                "Fabric loaders",
            )?;
            let items = texts(Some(&list));
            if items.is_empty() {
                return Ok(None);
            }
            let builds: Vec<fabric::Build> = items
                .iter()
                .map(|e| fabric::Build {
                    version: e
                        .get("loader")
                        .and_then(|l| l.get("version"))
                        .cloned()
                        .unwrap_or(Value::Null),
                    stable: e.get("loader").and_then(|l| l.get("stable")) == Some(&Value::Bool(true)),
                })
                .collect();
            let loader = fabric::pick("fabric", &builds, None)?.text();
            let profile = get(
                &format!(
                    "{FABRIC_META}/versions/loader/{}/{}/profile/json",
                    enc(&rid),
                    enc(&loader)
                ),
                "the Fabric profile",
            )?;
            Ok(Some(Version {
                label: format!("{rid} + Fabric {loader}"),
                json: merge_inherited(&profile, &release)?,
                modded: true,
            }))
        })();
        match fabric {
            Ok(Some(v)) => versions.push(v),
            Ok(None) => d.notes.push(format!("Fabric has no loader for {rid} yet")),
            Err(err) => d
                .notes
                .push(format!("Fabric for {rid} could not be read: {}", err.message())),
        }
        let more = loaders(&release);
        versions.extend(more.versions);
        d.failures.extend(more.failures);
        d.notes.extend(more.notes);
    }

    let default_flags = launch_features(false);
    let all_flags = all_features();
    for v in &versions {
        // one line per problem, naming the machines it shows on
        let mut seen: Vec<(String, Vec<String>)> = Vec::new();
        for (name, arch, os_version) in OS_PAIRS {
            let os = Os::new(name, arch, os_version);
            let pair = format!("{name}-{arch}");
            for (features, flags) in [("default", &default_flags), ("all flags", &all_flags)] {
                let problems: Vec<(&str, String)> =
                    match resolve_version(&v.json, &os, flags, Some(true), LAUNCHER_FORMAT) {
                        Ok(r) => r.problems.into_iter().map(|p| (p.code, p.message)).collect(),
                        Err(err) => vec![("resolver-error", err.message().to_string())],
                    };
                let codes: Vec<&str> = problems.iter().map(|p| p.0).collect();
                d.rows.push(ResultRow {
                    version: v.label.clone(),
                    pair: pair.clone(),
                    features,
                    result: if codes.is_empty() {
                        "ok".into()
                    } else {
                        codes.join(", ")
                    },
                });
                for (code, message) in problems {
                    if code == "no-natives-for-this-machine" && !MUST_LAUNCH.contains(&pair.as_str()) {
                        continue;
                    }
                    let at = if features == "default" {
                        pair.clone()
                    } else {
                        format!("{pair} (all flags)")
                    };
                    match seen.iter_mut().find(|(m, _)| *m == message) {
                        Some((_, where_)) if !where_.contains(&at) => where_.push(at),
                        Some(_) => {}
                        None => seen.push((message, vec![at])),
                    }
                }
            }
        }
        for (message, where_) in seen {
            d.failures
                .push(format!("{}: {message} (on {})", v.label, where_.join(", ")));
        }
        let unplaced: Vec<String> = natives_classifiers(&v.json)
            .into_iter()
            .filter(|c| !placeable(c))
            .collect();
        if !unplaced.is_empty() {
            d.failures.push(format!(
                "{} has natives classifiers SpawnLoft cannot place: {}",
                v.label,
                unplaced.join(", ")
            ));
        }
    }

    // asset indexes: a new layout needs a release
    for v in versions.iter().filter(|v| !v.modded) {
        let ai = v.json.get("assetIndex");
        let url = text(ai.and_then(|a| a.get("url")));
        if url.is_empty() {
            d.failures.push(format!("{} names no asset index", v.label));
            continue;
        }
        let id = text(ai.and_then(|a| a.get("id")));
        let label = format!("{}'s asset index", v.label);
        if let Some(index) = fact(&mut d.failures, &label, &url, &format!("asset index {id}"))
            && asset_layout(&index).is_none()
        {
            let keys: Vec<String> = index
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            d.failures.push(format!(
                "{}'s asset index {id} is laid out in a way SpawnLoft does not know (keys: {})",
                v.label,
                keys.join(", ")
            ));
        }
    }

    // Mojang's Java runtimes: the URL still answers, and every newest component is there for the
    // machines SpawnLoft supports
    let all = fact(
        &mut d.failures,
        "Mojang's Java runtime list",
        RUNTIME_INDEX_URL,
        "Mojang's Java runtime list",
    );
    if let Some(all) = &all {
        for v in versions.iter().filter(|v| !v.modded) {
            let component = text(v.json.get("javaVersion").and_then(|j| j.get("component")));
            if component.is_empty() {
                continue;
            }
            for pair in MUST_LAUNCH {
                let (name, arch) = pair.split_once('-').unwrap_or((pair, ""));
                let Some(platform) = platform_key(name, arch) else {
                    continue;
                };
                let there = all
                    .get(platform)
                    .and_then(|p| p.get(&component))
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty());
                if !there {
                    d.failures.push(format!(
                        "Mojang's Java runtime list has no {component} (for {}) on {platform}",
                        v.label
                    ));
                }
            }
        }
    }

    let mut logging_ids: Vec<String> = Vec::new();
    for v in &versions {
        let id = text(
            v.json
                .get("logging")
                .and_then(|l| l.get("client"))
                .and_then(|c| c.get("file"))
                .and_then(|f| f.get("id")),
        );
        if !id.is_empty() && !logging_ids.contains(&id) {
            logging_ids.push(id);
        }
    }
    logging_ids.sort();
    let mut classifiers: Vec<String> = Vec::new();
    for v in &versions {
        for c in natives_classifiers(&v.json) {
            if !classifiers.contains(&c) {
                classifiers.push(c);
            }
        }
    }
    classifiers.sort();
    let facts = Facts {
        logging_ids,
        natives_classifiers: classifiers,
        runtime_platforms: all.as_ref().map(|a| {
            sorted(
                &a.as_object()
                    .map(|m| m.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default(),
            )
        }),
    };
    if let Some(baseline) = baseline {
        for (key, what, now) in [
            ("loggingIds", "log4j config ids", Some(&facts.logging_ids)),
            (
                "nativesClassifiers",
                "natives classifiers",
                Some(&facts.natives_classifiers),
            ),
            (
                "runtimePlatforms",
                "Java runtime platforms",
                facts.runtime_platforms.as_ref(),
            ),
        ] {
            let Some(now) = now else { continue };
            let was: Vec<String> = texts(baseline.get(key))
                .into_iter()
                .map(|v| text(Some(v)))
                .collect();
            if sorted(now) != sorted(&was) {
                d.failures.push(format!(
                    "the {what} changed: was {}, now {} (check the launcher handles them, then run with --update-baseline)",
                    joined_or_none(&was),
                    joined_or_none(now)
                ));
            }
        }
    }
    d.facts = Some(facts);
    d
}

/// The rows built into this SpawnLoft, in the signed list's shape.
fn built_in_rows() -> Vec<HarnessRow> {
    HARNESS_RELEASES
        .iter()
        .map(|r| HarnessRow {
            minecraft: r.minecraft.iter().map(|s| s.to_string()).collect(),
            version: r.version.into(),
            tag: r.tag.into(),
            file: r.file.into(),
            sha256: r.sha256.into(),
        })
        .collect()
}

/// The published harness list and every jar it or the built-in rows name: (failures, notes).
fn check_harness_list(
    get_bytes: GetBytes<'_>,
    keys: &[Key],
    min_serial: f64,
    built_in: &[HarnessRow],
) -> (Vec<String>, Vec<String>) {
    let mut failures = Vec::new();
    let mut notes = Vec::new();
    let mut listed: Vec<HarnessRow> = Vec::new();
    let read = (|| -> Result<harness_index::Index, String> {
        let bytes = get_bytes(HARNESS_INDEX_URL, "the harness list", MAX_INDEX_BYTES)
            .map_err(|e| e.message().to_string())?;
        let sig = get_bytes(
            HARNESS_INDEX_SIG_URL,
            "the harness list's signature",
            MAX_SIG_BYTES,
        )
        .map_err(|e| e.message().to_string())?;
        harness_index::parse(&bytes, &String::from_utf8_lossy(&sig), keys, min_serial, &[])
            .map_err(|e| e.message)
    })();
    match read {
        Ok(index) => {
            notes.push(format!(
                "harness list: serial {}, signed with the {} key, {} row(s)",
                spawnloft_lib::js::number_to_string(index.serial),
                index.key,
                index.rows.len()
            ));
            if !index.revoke.is_empty() {
                notes.push(format!("the harness list revokes {} key(s)", index.revoke.len()));
            }
            listed = index.rows;
        }
        Err(message) => failures.push(format!("the signed harness list: {message}")),
    }

    // harness_for takes a built-in row over a listed one, so a listed row that disagrees is never used
    for row in &listed {
        for id in &row.minecraft {
            if let Some(own) = built_in.iter().find(|r| r.minecraft.contains(id))
                && (own.version != row.version
                    || own.tag != row.tag
                    || own.file != row.file
                    || own.sha256 != row.sha256)
            {
                failures.push(format!(
                    "the harness list's row for Minecraft {id} ({}) differs from the one built into SpawnLoft ({}); the built-in one wins",
                    row.tag, own.tag
                ));
            }
        }
    }

    let mut jars: Vec<&HarnessRow> = Vec::new();
    for row in built_in.iter().chain(listed.iter()) {
        let url = harness_index::jar_url(row);
        if !jars
            .iter()
            .any(|o| harness_index::jar_url(o) == url && o.sha256 == row.sha256)
        {
            jars.push(row);
        }
    }
    for row in jars {
        let label = format!("harness {} (for {})", row.file, row.minecraft.join(", "));
        match get_bytes(&harness_index::jar_url(row), &label, MAX_JAR_BYTES) {
            Ok(jar) => {
                let hash = spawnloft_lib::sha256::hex(&jar);
                if hash != row.sha256 {
                    failures.push(format!(
                        "{label} has sha256 {hash}, not the {} it is listed with",
                        row.sha256
                    ));
                }
            }
            Err(err) => failures.push(err.message().to_string()),
        }
    }
    (failures, notes)
}

fn report(d: &Drift) -> String {
    let mut lines = vec![
        if d.failures.is_empty() {
            "**No drift.**".to_string()
        } else {
            format!("**{} problem(s)**", d.failures.len())
        },
        String::new(),
    ];
    lines.extend(d.failures.iter().map(|f| format!("- {f}")));
    lines.extend(d.notes.iter().map(|n| format!("- note: {n}")));
    lines.extend([
        String::new(),
        "| version | machine | features | result |".into(),
        "|---|---|---|---|".into(),
    ]);
    lines.extend(
        d.rows
            .iter()
            .map(|r| format!("| {} | {} | {} | {} |", r.version, r.pair, r.features, r.result)),
    );
    lines.join("\n") + "\n"
}

struct Args {
    report: Option<String>,
    update_baseline: bool,
    baseline: String,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args {
        report: None,
        update_baseline: false,
        baseline: concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tools/version-drift-baseline.json"
        )
        .into(),
    };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--report" => a.report = Some(it.next().ok_or("--report needs a file")?.clone()),
            "--baseline" => a.baseline = it.next().ok_or("--baseline needs a file")?.clone(),
            "--update-baseline" => a.update_baseline = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

fn real_get_bytes(url: &str, label: &str, max_bytes: u64) -> Result<Vec<u8>, Failure> {
    spawnloft_lib::download::fetch_capped(
        url,
        max_bytes,
        Duration::from_secs(60),
        2,
        Duration::from_millis(1500),
        label,
    )
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!(
                "{e}\nusage: version-drift [--report <file.md>] [--update-baseline] [--baseline <file>]"
            );
            return ExitCode::from(2);
        }
    };
    let baseline = if args.update_baseline {
        None
    } else {
        match std::fs::read_to_string(&args.baseline)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
        {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("could not read the baseline {}: {e}", args.baseline);
                return ExitCode::from(2);
            }
        }
    };

    // the loaders write version files and libraries: only into a data folder named for the run
    let own = std::env::var("SPAWNLOFT_DATA_ROOT")
        .ok()
        .filter(|s| !s.is_empty());
    let paths = own.as_deref().map(Paths::under);
    let loaders: Vec<Loader<'_>> = paths.as_ref().map(real_loaders).unwrap_or_default();
    let read_version = |id: &str| -> Result<Value, Failure> {
        let file = paths.as_ref().map(|p| p.version_json(id)).unwrap_or_default();
        spawnloft_lib::client::read_json(&file)?
            .ok_or_else(|| Failure::user(format!("the version file {file} was not written")))
    };
    let run_loaders = |release: &Value| -> LoaderOutcome {
        match &paths {
            None => LoaderOutcome {
                notes: vec![
                    "Quilt, Forge and NeoForge were not set up: set SPAWNLOFT_DATA_ROOT to a folder of their own to check them"
                        .into(),
                ],
                ..LoaderOutcome::default()
            },
            Some(p) => {
                if let Err(e) = p.ensure_dirs() {
                    return LoaderOutcome {
                        failures: vec![format!("the data folder could not be made: {}", e.message())],
                        ..LoaderOutcome::default()
                    };
                }
                check_loaders(release, &loaders, &read_version)
            }
        }
    };

    let mut result = check_drift(&default_fetch, baseline.as_ref(), &run_loaders);
    let (failures, notes) = check_harness_list(
        &real_get_bytes,
        HARNESS_INDEX_KEYS,
        HARNESS_INDEX_MIN_SERIAL,
        &built_in_rows(),
    );
    result.failures.extend(failures);
    result.notes.extend(notes);
    let text = report(&result);
    print!("{text}");
    if let Some(file) = &args.report
        && let Err(e) = std::fs::write(file, &text)
    {
        eprintln!("could not write {file}: {e}");
        return ExitCode::from(2);
    }
    if args.update_baseline
        && let Some(facts) = &result.facts
    {
        let body = serde_json::to_string_pretty(&facts.to_json()).unwrap_or_default() + "\n";
        if let Err(e) = std::fs::write(&args.baseline, body) {
            eprintln!("could not write {}: {e}", args.baseline);
            return ExitCode::from(2);
        }
        println!("wrote {}", args.baseline);
    }
    if result.failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const CLIENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures/client/");
    const OWN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/version-drift/");

    fn read(path: String) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
            .unwrap()
    }
    fn client(p: &str) -> Value {
        read(format!("{CLIENT}{p}"))
    }
    fn own(p: &str) -> Value {
        read(format!("{OWN}{p}"))
    }

    /// What the fixtures show: the baseline the Node check kept for them.
    fn baseline() -> Value {
        json!({
            "loggingIds": ["client-1.21.2.xml"],
            "nativesClassifiers": ["natives-linux", "natives-macos", "natives-macos-arm64", "natives-windows", "natives-windows-arm64"],
            "runtimePlatforms": ["gamecore", "linux", "linux-i386", "mac-os", "mac-os-arm64", "windows-arm64", "windows-x64", "windows-x86"],
        })
    }

    fn no_loaders(_: &Value) -> LoaderOutcome {
        LoaderOutcome::default()
    }

    fn fail(message: &str, code: Option<&str>) -> Failure {
        Failure::User {
            message: message.into(),
            code: code.map(String::from),
        }
    }

    /// Mojang and Fabric as the fixtures have them, with 26.3 the newest release and `snapshot`
    /// the newest snapshot.
    fn world(snapshot: Value) -> impl Fn(&str, &str) -> Result<Value, Failure> {
        let release = client("versions/26.3.json");
        let mut manifest = own("version_manifest_v2.json");
        let url = |id: &str| format!("https://piston-meta.mojang.com/v1/packages/test/{id}.json");
        let sid = text(snapshot.get("id"));
        manifest["latest"] = json!({ "release": "26.3", "snapshot": sid });
        let mut list = vec![
            json!({ "id": sid, "type": "snapshot", "url": url(&sid) }),
            json!({ "id": "26.3", "type": "release", "url": url("26.3") }),
        ];
        list.extend(
            texts(manifest.get("versions"))
                .into_iter()
                .filter(|v| v["id"] != "26.3")
                .cloned(),
        );
        manifest["versions"] = Value::Array(list);
        let mut answers: HashMap<String, Value> = HashMap::new();
        answers.insert(MANIFEST_URL.into(), manifest);
        answers.insert(url("26.3"), release.clone());
        answers.insert(url(&sid), snapshot.clone());
        answers.insert(
            format!("{FABRIC_META}/versions/loader/26.3"),
            own("fabric-loader-list.json"),
        );
        answers.insert(text(release["assetIndex"].get("url")), own("assets-objects.json"));
        answers.insert(
            text(snapshot["assetIndex"].get("url")),
            own(if sid == "27.1" {
                "assets-future-pack.json"
            } else {
                "assets-objects.json"
            }),
        );
        answers.insert(RUNTIME_INDEX_URL.into(), own("java-runtime-all.json"));
        let profile = own("fabric-profile-26.3.json");
        move |u: &str, _label: &str| {
            if let Some(v) = answers.get(u) {
                return Ok(v.clone());
            }
            let prefix = format!("{FABRIC_META}/versions/loader/26.3/");
            if u.starts_with(&prefix) && u.ends_with("/profile/json") {
                return Ok(profile.clone());
            }
            Err(Failure::user(format!("no answer for {u}")))
        }
    }

    fn today() -> Value {
        client("versions/26.4-snapshot-6.json")
    }

    #[test]
    fn the_formats_of_today_pass_and_the_baseline_is_what_they_show() {
        let get = world(today());
        let b = baseline();
        let result = check_drift(&get, Some(&b), &no_loaders);
        assert_eq!(result.failures, Vec::<String>::new());
        assert_eq!(result.facts.as_ref().unwrap().to_json(), b);
        // three versions (release, snapshot, release + Fabric), seven machines, two feature sets
        assert_eq!(result.rows.len(), 3 * 7 * 2);
        assert!(
            result
                .rows
                .iter()
                .any(|r| r.pair == "linux-arm64" && r.result == "no-natives-for-this-machine"),
            "Linux arm64 is only noted"
        );
        assert!(report(&result).starts_with("**No drift.**"));
    }

    #[test]
    fn a_snapshot_in_a_format_spawnloft_does_not_know_fails_naming_each_thing() {
        let get = world(client("future.json"));
        let b = baseline();
        let result = check_drift(&get, Some(&b), &no_loaders);
        let text = result.failures.join("\n");
        assert!(
            text.lines().any(|l| l.starts_with(
                "27.1 (snapshot): Minecraft 27.1 needs launcher format 22; this SpawnLoft knows 21. Update SpawnLoft. (on windows-x64, windows-x64 (all flags), "
            )),
            "{text}"
        );
        assert!(
            text.contains("launcher setting SpawnLoft does not know (${render_backend})"),
            "{text}"
        );
        assert!(
            text.contains("platform rule SpawnLoft does not know (\"os.kernel\")"),
            "{text}"
        );
        assert!(
            text.contains(
                "platform rule SpawnLoft does not know (\"os.versionRange\" on macOS, \"os.kernel\"). Update SpawnLoft. (on osx-arm64"
            ),
            "{text}"
        );
        assert!(
            text.contains("asset index 37 is laid out in a way SpawnLoft does not know"),
            "{text}"
        );
        // the release still passes: every failure is the snapshot's
        assert!(result.failures.iter().all(|f| f.starts_with("27.1")), "{text}");
        let r = report(&result);
        assert!(r.starts_with(&format!("**{} problem(s)**", result.failures.len())));
    }

    #[test]
    fn an_unreadable_list_an_unknown_type_and_a_missing_runtime_each_fail() {
        let b = baseline();
        let down = check_drift(
            &|_: &str, _: &str| Err(Failure::user("offline")),
            Some(&b),
            &no_loaders,
        );
        assert_eq!(down.failures, vec!["the version list: offline".to_string()]);

        let base = world(today());
        let odd = |u: &str, l: &str| {
            let mut body = base(u, l)?;
            if u == MANIFEST_URL {
                body["versions"].as_array_mut().unwrap().push(
                    json!({ "id": "x", "type": "april_fools", "url": "https://example.invalid/x.json" }),
                );
            }
            if u == RUNTIME_INDEX_URL {
                body["linux"]["java-runtime-epsilon"] = json!([]);
            }
            Ok(body)
        };
        let result = check_drift(&odd, Some(&b), &no_loaders);
        assert!(
            result
                .failures
                .contains(&"the version list has types the picker does not know: april_fools".to_string()),
            "{:?}",
            result.failures
        );
        assert!(
            result
                .failures
                .iter()
                .any(|f| f.contains("has no java-runtime-epsilon (for 26.3 (release)) on linux")),
            "{:?}",
            result.failures
        );
    }

    #[test]
    fn a_changed_fact_fails_against_the_baseline() {
        let get = world(today());
        let mut b = baseline();
        b["loggingIds"] = json!(["client-1.12.xml"]);
        let result = check_drift(&get, Some(&b), &no_loaders);
        assert_eq!(
            result.failures,
            vec![
                "the log4j config ids changed: was client-1.12.xml, now client-1.21.2.xml (check the launcher handles them, then run with --update-baseline)"
                    .to_string()
            ]
        );
        // no baseline (it is being written): no comparison
        assert!(check_drift(&get, None, &no_loaders).failures.is_empty());
    }

    #[test]
    fn natives_classifiers_are_found_and_judged() {
        let v = json!({ "libraries": [
            { "name": "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64" },
            { "name": "a:b:1:natives-linux@jar" },
            { "name": "c:d:1", "downloads": { "classifiers": { "natives-osx": {}, "sources": {} } } },
            { "name": "e:f:1", "natives": { "windows": "natives-windows-${arch}" } },
        ] });
        assert_eq!(
            natives_classifiers(&v),
            [
                "natives-linux",
                "natives-osx",
                "natives-windows-64",
                "natives-windows-arm64"
            ]
        );
        for ok in [
            "natives-windows",
            "natives-macos-arm64",
            "natives-linux-x86",
            "natives-osx-patch",
        ] {
            assert!(placeable(ok), "{ok}");
        }
        for bad in [
            "natives-windows-64",
            "natives-freebsd",
            "natives-",
            "natives-linux-riscv64",
            "windows",
        ] {
            assert!(!placeable(bad), "{bad}");
        }
    }

    // ---- Quilt, Forge and NeoForge for the newest release -------------------------------------

    fn fake_loader<'a>(
        name: &'static str,
        picks: Result<Option<(&'a str, &'a str)>, Failure>,
        ensure: impl Fn(&str, &str) -> Result<String, Failure> + 'a,
    ) -> Loader<'a> {
        Loader {
            name,
            picks: Box::new(move |_| match &picks {
                Ok(p) => Ok(p.map(|(a, b)| (a.to_string(), b.to_string()))),
                Err(e) => Err(e.clone()),
            }),
            ensure: Box::new(ensure),
        }
    }

    fn writes(name: &'static str) -> impl Fn(&str, &str) -> Result<String, Failure> {
        move |mc, build| Ok(format!("{mc}-{name}-{build}"))
    }

    #[test]
    fn loaders_are_set_up_for_the_newest_release_newest_and_default_build() {
        let release = client("versions/26.3.json");
        let forge263 = client("loaders/forge/26.3-66.1.8/version.json");
        let asked = RefCell::new(Vec::<String>::new());
        let ask = |name: &'static str| {
            let asked = &asked;
            move |mc: &str, build: &str| {
                asked.borrow_mut().push(format!("{name} {build}"));
                writes(name)(mc, build)
            }
        };
        let mods = || {
            vec![
                fake_loader("Quilt", Ok(Some(("2.0", "1.0"))), ask("Quilt")),
                fake_loader("Forge", Ok(Some(("2.0", "1.0"))), ask("Forge")),
                fake_loader(
                    "NeoForge",
                    Ok(Some(("26.3.0.103", "26.3.0.103"))),
                    ask("NeoForge"),
                ),
            ]
        };
        let read = |_: &str| Ok(forge263.clone());
        let out = check_loaders(&release, &mods(), &read);
        assert_eq!(
            *asked.borrow(),
            [
                "Quilt 2.0",
                "Quilt 1.0",
                "Forge 2.0",
                "Forge 1.0",
                "NeoForge 26.3.0.103"
            ]
        );
        assert_eq!(out.failures, Vec::<String>::new());
        assert_eq!(
            out.versions.iter().map(|v| v.label.as_str()).collect::<Vec<_>>(),
            [
                "26.3 + Quilt 2.0",
                "26.3 + Quilt 1.0",
                "26.3 + Forge 2.0",
                "26.3 + Forge 1.0",
                "26.3 + NeoForge 26.3.0.103"
            ]
        );
        assert!(out.versions.iter().all(|v| v.modded
            && v.json["mainClass"] == forge263["mainClass"]
            && v.json.get("assetIndex").is_some()));

        // and the resolver runs on each, so the rows grow and today's Forge passes
        let get = world(today());
        let b = baseline();
        let loaders = mods();
        let result = check_drift(&get, Some(&b), &|r| check_loaders(r, &loaders, &read));
        assert_eq!(result.failures, Vec::<String>::new());
        assert_eq!(result.rows.len(), (3 + 5) * 7 * 2);
        assert_eq!(result.facts.unwrap().to_json(), b);
    }

    #[test]
    fn an_unknown_installer_a_refused_host_or_a_new_variable_is_drift_an_outage_a_note() {
        let release = client("versions/26.3.json");
        let mods = vec![
            fake_loader(
                "Quilt",
                Err(fail("Could not reach Quilt", Some("loader-unreachable"))),
                writes("Quilt"),
            ),
            fake_loader("Forge", Ok(Some(("67.0.1", "67.0.1"))), |_: &str, _: &str| {
                Err(fail(
                    "This Forge build needs a newer SpawnLoft (installer spec 2)",
                    Some("loader-installer-unknown"),
                ))
            }),
            fake_loader(
                "NeoForge",
                Ok(Some(("26.3.0.200", "26.3.0.200"))),
                |_: &str, _: &str| {
                    Err(fail(
                        "NeoForge's installer names a download at https://example.net/x.jar, which is not one of the places",
                        Some("loader-host-refused"),
                    ))
                },
            ),
        ];
        let unread = |id: &str| Err(Failure::user(format!("{id} was not written")));
        let out = check_loaders(&release, &mods, &unread);
        assert_eq!(
            out.notes,
            ["Quilt's builds for 26.3 could not be read: Could not reach Quilt"]
        );
        assert_eq!(
            out.failures,
            [
                "Forge 67.0.1 for 26.3: This Forge build needs a newer SpawnLoft (installer spec 2)",
                "NeoForge 26.3.0.200 for 26.3: NeoForge's installer names a download at https://example.net/x.jar, which is not one of the places",
            ]
        );
        let none = vec![fake_loader("Quilt", Ok(None), writes("Quilt"))];
        assert_eq!(
            check_loaders(&release, &none, &unread).notes,
            ["Quilt has no build for 26.3 yet"]
        );

        // a version file with a launch variable this SpawnLoft does not know fails as Mojang's would
        let mut future = client("loaders/forge/26.3-66.1.8/version.json");
        let game = future["arguments"]["game"].as_array_mut().unwrap();
        game.push(json!("--loaderThing"));
        game.push(json!("${loader_thing}"));
        let only = vec![fake_loader(
            "Forge",
            Ok(Some(("67.0.1", "67.0.1"))),
            writes("Forge"),
        )];
        let read = |_: &str| Ok(future.clone());
        let get = world(today());
        let b = baseline();
        let result = check_drift(&get, Some(&b), &|r| check_loaders(r, &only, &read));
        assert!(!result.failures.is_empty());
        assert!(
            result
                .failures
                .iter()
                .all(|f| f.starts_with("26.3 + Forge 67.0.1: ") && f.contains("${loader_thing}")),
            "{:?}",
            result.failures
        );
    }

    #[test]
    fn an_outage_is_a_note_a_moved_address_is_drift() {
        assert!(
            passes(&fail("could not reach Quilt: ENOTFOUND meta.quiltmc.org", None)),
            "no code"
        );
        assert!(passes(&fail("could not reach x", Some("download-failed"))));
        assert!(passes(&fail("Forge has no build", Some("loader-not-available"))));
        assert!(!passes(&fail(
            "the Forge installer answered 404",
            Some("download-failed")
        )));
        assert!(!passes(&fail("Quilt loaders answered 410", None)));
        assert!(passes(&fail(
            "the installer answered 503",
            Some("download-failed")
        )));
        assert!(passes(&fail(
            "the installer answered 4040",
            Some("download-failed")
        )));
        assert!(!passes(&fail("names a download at", Some("loader-host-refused"))));
        assert!(!passes(&fail("spec 2", Some("loader-installer-unknown"))));
    }

    // ---- the signed harness list ---------------------------------------------------------------

    struct Signer {
        pair: ring::signature::Ed25519KeyPair,
        spki: &'static str,
    }

    fn signer() -> Signer {
        use ring::signature::KeyPair;
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        // the SPKI DER of an Ed25519 key: this prefix, then its 32 bytes
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(pair.public_key().as_ref());
        Signer {
            pair,
            spki: Box::leak(spawnloft_lib::update::base64::encode(&der).into_boxed_str()),
        }
    }

    fn row(mc: &str, version: &str, jar: &[u8]) -> HarnessRow {
        HarnessRow {
            minecraft: vec![mc.into()],
            version: version.into(),
            tag: format!("v{version}-mc{mc}"),
            file: format!("spawnloft-harness-{version}+{mc}.jar"),
            sha256: spawnloft_lib::sha256::hex(jar),
        }
    }

    const JAR_A: &[u8] = b"jar for 1.21.11";
    const JAR_B: &[u8] = b"jar for 26.3";

    fn built_in() -> Vec<HarnessRow> {
        vec![row("1.21.11", "0.1.0", JAR_A)]
    }
    fn listed_b() -> HarnessRow {
        row("26.3", "0.2.0", JAR_B)
    }

    /// The mod repo's release assets: a list of `rows` signed by `by`, and the jars.
    #[allow(clippy::type_complexity)]
    fn published(
        rows: &[HarnessRow],
        by: &Signer,
        jars: Vec<(String, Vec<u8>)>,
    ) -> (
        impl Fn(&str, &str, u64) -> Result<Vec<u8>, Failure> + use<>,
        std::rc::Rc<RefCell<Vec<String>>>,
    ) {
        let doc = json!({ "format": 1, "serial": 2, "generated": "2026-10-30T00:00:00Z", "rows": rows.iter().map(|r| json!({
            "minecraft": r.minecraft, "version": r.version, "tag": r.tag, "file": r.file, "sha256": r.sha256,
        })).collect::<Vec<_>>() });
        let bytes = (serde_json::to_string_pretty(&doc).unwrap() + "\n").into_bytes();
        let mut msg = harness_index::SIGNATURE_DOMAIN.as_bytes().to_vec();
        msg.extend_from_slice(&bytes);
        let sig = spawnloft_lib::update::base64::encode(by.pair.sign(&msg).as_ref()) + "\n";
        let mut answers: HashMap<String, Vec<u8>> = jars.into_iter().collect();
        answers.insert(HARNESS_INDEX_URL.into(), bytes);
        answers.insert(HARNESS_INDEX_SIG_URL.into(), sig.into_bytes());
        let asked = std::rc::Rc::new(RefCell::new(Vec::new()));
        let log = asked.clone();
        let get = move |url: &str, label: &str, _max: u64| {
            log.borrow_mut().push(url.to_string());
            answers
                .get(url)
                .cloned()
                .ok_or_else(|| Failure::user(format!("{label} answered 404")))
        };
        (get, asked)
    }

    fn keys(s: &Signer) -> Vec<Key> {
        vec![Key {
            name: "primary",
            spki: s.spki,
        }]
    }

    fn both_jars() -> Vec<(String, Vec<u8>)> {
        vec![
            (harness_index::jar_url(&built_in()[0]), JAR_A.to_vec()),
            (harness_index::jar_url(&listed_b()), JAR_B.to_vec()),
        ]
    }

    #[test]
    fn the_published_list_verifies_and_every_jar_has_its_sha256_each_fetched_once() {
        let s = signer();
        let (get, asked) = published(&[built_in()[0].clone(), listed_b()], &s, both_jars());
        let (failures, notes) = check_harness_list(&get, &keys(&s), 1.0, &built_in());
        assert_eq!(failures, Vec::<String>::new());
        assert_eq!(
            notes,
            ["harness list: serial 2, signed with the primary key, 2 row(s)"]
        );
        assert_eq!(
            asked.borrow().iter().filter(|u| u.ends_with(".jar")).count(),
            2,
            "the 1.21.11 jar in both lists is fetched once"
        );
    }

    #[test]
    fn a_list_signed_by_an_untrusted_key_fails_and_the_built_in_jars_are_still_checked() {
        let trusted = signer();
        let other = signer();
        let (get, asked) = published(&[built_in()[0].clone(), listed_b()], &other, both_jars());
        let (failures, _) = check_harness_list(&get, &keys(&trusted), 1.0, &built_in());
        assert_eq!(
            failures,
            ["the signed harness list: the signature does not verify with any key this SpawnLoft trusts"]
        );
        assert!(asked.borrow().contains(&harness_index::jar_url(&built_in()[0])));
    }

    #[test]
    fn a_replaced_jar_a_deleted_release_and_a_disagreeing_row_each_fail() {
        let s = signer();
        let mut other = built_in()[0].clone();
        other.tag = "v0.1.1-mc1.21.11".into();
        other.file = "spawnloft-harness-0.1.1+1.21.11.jar".into();
        other.sha256 = spawnloft_lib::sha256::hex(b"x");
        let (get, _) = published(
            &[other, listed_b()],
            &s,
            vec![(harness_index::jar_url(&built_in()[0]), b"tampered".to_vec())],
        );
        let (failures, _) = check_harness_list(&get, &keys(&s), 1.0, &built_in());
        let text = failures.join("\n");
        assert!(
            failures.iter().any(|f| f
                .starts_with("harness spawnloft-harness-0.1.0+1.21.11.jar (for 1.21.11) has sha256 ")
                && f.contains(", not the ")),
            "{text}"
        );
        assert!(
            failures
                .contains(&"harness spawnloft-harness-0.2.0+26.3.jar (for 26.3) answered 404".to_string()),
            "{text}"
        );
        assert!(
            failures.contains(
                &"harness spawnloft-harness-0.1.1+1.21.11.jar (for 1.21.11) answered 404".to_string()
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "row for Minecraft 1.21.11 (v0.1.1-mc1.21.11) differs from the one built into SpawnLoft (v0.1.0-mc1.21.11)"
            ),
            "{text}"
        );
    }

    #[test]
    fn the_built_in_rows_are_harness_releases() {
        let rows = built_in_rows();
        assert_eq!(rows.len(), HARNESS_RELEASES.len());
        assert_eq!(rows[0].file, HARNESS_RELEASES[0].file);
    }

    #[test]
    fn the_report_lists_problems_notes_and_rows() {
        let d = Drift {
            rows: vec![ResultRow {
                version: "26.3 (release)".into(),
                pair: "linux-x64".into(),
                features: "default",
                result: "ok".into(),
            }],
            failures: vec!["a".into()],
            notes: vec!["b".into()],
            facts: None,
        };
        assert_eq!(
            report(&d),
            "**1 problem(s)**\n\n- a\n- note: b\n\n| version | machine | features | result |\n|---|---|---|---|\n| 26.3 (release) | linux-x64 | default | ok |\n"
        );
    }

    #[test]
    fn arguments() {
        let a = parse_args(&["--report".into(), "r.md".into(), "--update-baseline".into()]).unwrap();
        assert_eq!(a.report.as_deref(), Some("r.md"));
        assert!(a.update_baseline);
        assert!(a.baseline.ends_with("tools/version-drift-baseline.json"));
        let b = parse_args(&["--baseline".into(), "x.json".into()]).unwrap();
        assert_eq!(b.baseline, "x.json");
        assert!(parse_args(&["--report".into()]).is_err());
        assert!(parse_args(&["--nope".into()]).is_err());
    }
}
