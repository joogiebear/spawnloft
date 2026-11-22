//! `doctor-client.mjs`: the client's part of `spawnloft doctor`. Each profile's Java, harness mod
//! and install state, the Mojang runtimes on disk, and where the harness builds come from.
//! Nothing here probes Java or touches the network; `repair` only removes a stale harness file.

use std::path::Path;

use serde_json::Value;

use super::paths::Paths;
use super::{harness, harness_index, profiles, prop, runtime, state};
use crate::failure::Failure;
use crate::{java, js, jspath};

/// What `checkClientProfiles` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Checked {
    pub problems: Vec<String>,
    pub notes: Vec<String>,
}

/// `checkClientProfiles({ repair, javas })`. `javas` is the major version of each Java the
/// doctor's probe found (`None` for one whose version did not read).
pub fn check_client_profiles(paths: &Paths, repair: bool, javas: &[Option<u32>]) -> Result<Checked, Failure> {
    let mut problems = Vec::new();
    let mut notes = Vec::new();
    let os = super::rules::current_os();

    for p in profiles::list(paths)? {
        let name = p.name();
        let prefix = format!("client {name}: ");
        let mc = js::string(p.get("mc"));
        let loader = js::string(p.get("loader"));

        // A pinned Java is used as given, so only its presence is checked; the probe's list
        // decides otherwise.
        let needs = java::required_major(Some(&mc_text(p.get("mc"))));
        let pinned = p.get("java");
        let found = |needs: u32| javas.iter().any(|j| j.is_some_and(|m| m >= needs));
        if pinned.is_some_and(|j| j == "mojang") {
            // Mojang's runtime, downloaded at launch
        } else if js::truthy(pinned) && !pinned.is_some_and(|j| j == "java") {
            let at = js::string(pinned);
            if !matches!(pinned, Some(Value::String(_))) || !Path::new(&at).exists() {
                problems.push(format!(
                    "{prefix}pinned Java {at} does not exist; spawnloft client set {name} java=<path>, or java= to let SpawnLoft pick"
                ));
            }
        } else if let Some(needs) = needs
            && !found(needs)
        {
            if runtime::platform_key(&os.name, &os.arch).is_none() {
                problems.push(format!(
                    "{prefix}Minecraft {mc} needs Java {needs} or newer and none was found. {}",
                    java::DOWNLOAD_URL
                ));
            } else {
                // the launch downloads Mojang's own runtime when nothing installed fits
                notes.push(format!(
                    "{prefix}Minecraft {mc} needs Java {needs} or newer and none is installed; the first launch downloads Mojang's (or install one: {})",
                    java::DOWNLOAD_URL
                ));
            }
        }

        let installed =
            Path::new(&paths.version_json(&mc)).exists() && Path::new(&paths.version_jar(&mc)).exists();

        if js::truthy(p.get("harness")) {
            match harness::harness_for(paths, &mc) {
                None => problems.push(format!(
                    "{prefix}no harness mod is published for Minecraft {mc}; spawnloft client set {name} harness=false"
                )),
                Some(row) => {
                    let mods_dir = jspath::join(&[&paths.profile_dir(&name), "mods"]);
                    let harness_file = format!("spawnloft-harness-{}+{}.jar", row.version, row.minecraft);
                    let jar = jspath::join(&[&mods_dir, &harness_file]);
                    if Path::new(&jar).exists() {
                        let buf = std::fs::read(&jar).map_err(|e| Failure::read(&e, Path::new(&jar)))?;
                        if crate::sha256::hex(&buf) != row.sha256 {
                            problems.push(format!(
                                "{prefix}mods/{harness_file} is not the published harness mod {}; delete it and launch again",
                                row.version
                            ));
                        }
                        // launch uses a Fabric API someone put in mods/ by hand, so the doctor
                        // counts one too
                        let mods_json = super::read_json(&jspath::join(&[&mods_dir, ".spawnloft-mods.json"]))?;
                        let has_fabric_api = managed_fabric_api(mods_json.as_ref(), &mods_dir)?
                            || !super::fabric::fabric_api_jars(&mods_dir)?.is_empty();
                        if !has_fabric_api {
                            problems.push(format!(
                                "{prefix}the harness mod is installed but Fabric API is not; launch again to install it"
                            ));
                        }
                    }
                }
            }
        }

        let st = state::status(paths, &name)?;
        let info = harness::read_file(paths, &name, None)?;
        if let Some(info) = info
            && (!st.running || !super::strict_eq(prop(Some(&info), "pid"), prop(Some(&st.json), "pid")))
        {
            if !repair {
                problems.push(format!(
                    "{prefix}stale {} from an earlier run; run doctor without --json to clear it",
                    harness::HARNESS_FILE
                ));
            } else {
                harness::remove_file(paths, &name)?;
                notes.push(format!("{prefix}cleared stale {}", harness::HARNESS_FILE));
            }
        }

        let install_str = if installed {
            "installed".to_string()
        } else {
            format!("not installed yet: spawnloft client install {name}")
        };
        let run_str = if st.running { "running" } else { "stopped" };
        notes.push(format!(
            "{prefix}Minecraft {mc} {loader}, {install_str}, {run_str}"
        ));
    }

    for r in runtime::installed(paths)? {
        let component = js::string(prop(Some(&r), "component"));
        let platform = js::string(prop(Some(&r), "platform"));
        let damaged = match runtime::runtime_damage(paths, &component, &platform) {
            Ok(d) => d,
            Err(e) => vec![e.message().to_string()],
        };
        if let Some(first) = damaged.first() {
            problems.push(format!(
                "client Java runtime {component} ({platform}): {} file(s) missing or the wrong size, such as {first}; the next launch that needs it downloads them again",
                damaged.len()
            ));
        } else {
            notes.push(format!(
                "client Java runtime {component} {} ({platform}): whole",
                js::string(prop(Some(&r), "version"))
            ));
        }
    }

    // the signed harness list, once per machine, when a profile uses the harness
    if profiles::list(paths)?
        .iter()
        .any(|p| js::truthy(p.get("harness")))
    {
        let (problem, text) = harness_list_line(paths, &harness_index::status(paths), crate::util::now());
        if problem {
            problems.push(text);
        } else {
            notes.push(text);
        }
    }

    Ok(Checked { problems, notes })
}

/// `String(mc ?? '')`, as `requiredMajor` reads it.
fn mc_text(mc: Option<&Value>) -> String {
    match mc {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    }
}

/// `modsJson && modsJson.managed && Object.entries(modsJson.managed).some(...)`: a managed
/// Fabric API whose jar is still in mods/.
fn managed_fabric_api(mods_json: Option<&Value>, mods_dir: &str) -> Result<bool, Failure> {
    if !js::truthy(mods_json) {
        return Ok(false);
    }
    let managed = prop(mods_json, "managed");
    if !js::truthy(managed) {
        return Ok(false);
    }
    let entries: Vec<(String, &Value)> = match managed {
        Some(Value::Object(m)) => js::object_entries(m.iter().map(|(k, v)| (k.clone(), v)).collect()),
        Some(Value::Array(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    };
    for (file, entry) in entries {
        // `entry.project` on a null entry throws, as Node's does
        if entry.is_null() {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'project')",
            ));
        }
        if prop(Some(entry), "project").is_some_and(|p| p == "fabric-api")
            && Path::new(&jspath::join(&[mods_dir, &file])).exists()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

const REJECTED: &[&str] = &[
    "harness-index-signature",
    "harness-index-format",
    "harness-index-serial",
];

/// `Math.round`: halves go up.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `ago(ms)`: how long ago, in minutes, hours or days.
fn ago(ms: f64, now: f64) -> String {
    let m = round((now - ms) / 60000.0).max(0.0);
    if m < 60.0 {
        return format!("{} min ago", js::number_to_string(m));
    }
    let h = round(m / 60.0);
    if h < 48.0 {
        format!("{} h ago", js::number_to_string(h))
    } else {
        format!("{} days ago", js::number_to_string(round(h / 24.0)))
    }
}

/// `harnessListLine(st)`: one line on where the harness builds come from, and whether it is a
/// problem (a list that was fetched and refused: someone published something wrong).
pub fn harness_list_line(paths: &Paths, st: &Value, now: f64) -> (bool, String) {
    let ids = harness::published_ids(paths).join(", ");
    let field = |k: &str| prop(Some(st), k);
    let head = if field("source").is_some_and(|s| s == "index") {
        let mut h = format!("harness list: serial {}", js::string(field("serial")));
        if js::truthy(field("generated")) {
            let g = js::string(field("generated"));
            h.push_str(&format!(" from {}", g.chars().take(10).collect::<String>()));
        }
        if js::truthy(field("key")) && !field("key").is_some_and(|k| k == "primary") {
            h.push_str(&format!(", signed with the {} key", js::string(field("key"))));
        }
        if js::truthy(field("fetchedAt")) {
            h.push_str(&format!(", fetched {}", ago(js::number(field("fetchedAt")), now)));
        }
        format!("{h} ({ids})")
    } else {
        format!("harness list: built-in only ({ids})")
    };
    let outcome = field("outcome");
    if !js::truthy(outcome) || outcome.is_some_and(|o| o == "accepted" || o == "unchanged") {
        let text = if js::truthy(field("lastCheck")) {
            head
        } else {
            format!("{head}; the published list has not been checked yet")
        };
        return (false, text);
    }
    let when = if js::truthy(field("lastCheck")) {
        format!(" {}", ago(js::number(field("lastCheck")), now))
    } else {
        String::new()
    };
    let reason = js::string(field("reason"));
    if outcome
        .and_then(Value::as_str)
        .is_some_and(|o| REJECTED.contains(&o))
    {
        return (
            true,
            format!("{head}; the published list was rejected{when}: {reason}"),
        );
    }
    (
        false,
        format!("{head}; the published list was last tried{when} and could not be read ({reason})"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(tag: &str) -> (std::path::PathBuf, Paths) {
        let d = std::env::temp_dir().join(format!("sl-doctor-client-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("client")).unwrap();
        let p = Paths::under(&d.to_string_lossy());
        (d, p)
    }

    #[test]
    fn ago_rounds_as_math_round_does() {
        let now = 10_000_000_000.0;
        assert_eq!(ago(now - 29_999.0, now), "0 min ago");
        assert_eq!(ago(now - 30_000.0, now), "1 min ago");
        assert_eq!(ago(now + 120_000.0, now), "0 min ago");
        assert_eq!(ago(now - 59.0 * 60_000.0, now), "59 min ago");
        assert_eq!(ago(now - 90.0 * 60_000.0, now), "2 h ago");
        assert_eq!(ago(now - 47.0 * 3_600_000.0, now), "47 h ago");
        assert_eq!(ago(now - 60.0 * 3_600_000.0, now), "3 days ago");
    }

    #[test]
    fn the_harness_list_line_says_where_the_builds_come_from() {
        let (d, p) = scratch("line");
        let ids = harness::published_ids(&p).join(", ");
        let now = 1_000_000_000_000.0;
        let built_in = json!({ "source": "built-in", "lastCheck": null, "outcome": null, "reason": null });
        assert_eq!(
            harness_list_line(&p, &built_in, now),
            (
                false,
                format!("harness list: built-in only ({ids}); the published list has not been checked yet")
            )
        );
        let index = json!({
            "source": "index", "serial": 7, "generated": "2026-11-01T10:00:00Z", "key": "backup",
            "fetchedAt": now - 3.0 * 60_000.0, "lastCheck": now - 120.0 * 60_000.0,
            "outcome": "harness-index-signature", "reason": "bad signature"
        });
        assert_eq!(
            harness_list_line(&p, &index, now),
            (
                true,
                format!(
                    "harness list: serial 7 from 2026-11-01, signed with the backup key, fetched 3 min ago ({ids}); the published list was rejected 2 h ago: bad signature"
                )
            )
        );
        let offline = json!({ "source": "index", "serial": 2, "key": "primary", "lastCheck": now, "outcome": "fetch-failed", "reason": "offline" });
        assert_eq!(
            harness_list_line(&p, &offline, now),
            (
                false,
                format!(
                    "harness list: serial 2 ({ids}); the published list was last tried 0 min ago and could not be read (offline)"
                )
            )
        );
        let ok = json!({ "source": "built-in", "lastCheck": now, "outcome": "unchanged" });
        assert_eq!(
            harness_list_line(&p, &ok, now),
            (false, format!("harness list: built-in only ({ids})"))
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_managed_fabric_api_counts_only_while_its_jar_is_there() {
        let (d, _) = scratch("managed");
        let mods = d.join("mods");
        std::fs::create_dir_all(&mods).unwrap();
        let dir = mods.to_string_lossy().into_owned();
        let doc = json!({ "managed": { "fabric-api.jar": { "project": "fabric-api" } } });
        assert!(!managed_fabric_api(Some(&doc), &dir).unwrap());
        std::fs::write(mods.join("fabric-api.jar"), "x").unwrap();
        assert!(managed_fabric_api(Some(&doc), &dir).unwrap());
        assert!(!managed_fabric_api(Some(&json!({ "managed": "fabric-api.jar" })), &dir).unwrap());
        assert!(!managed_fabric_api(Some(&json!(null)), &dir).unwrap());
        assert!(!managed_fabric_api(None, &dir).unwrap());
        // a null entry throws in Node's `entry.project`
        assert!(managed_fabric_api(Some(&json!({ "managed": { "a.jar": null } })), &dir).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn profiles_are_checked_and_a_stale_harness_file_is_cleared_on_repair() {
        let (d, p) = scratch("profiles");
        std::fs::write(
            d.join("client/profiles.json"),
            json!({ "version": 1, "profiles": {
                "a": { "mc": "1.21.11", "java": "/no/such/java" },
                "b": { "mc": "1.21.11", "java": "mojang", "harness": true },
                "c": { "mc": "25w14a", "loader": "vanilla" }
            } })
            .to_string(),
        )
        .unwrap();
        let bdir = d.join("client/profiles/b");
        std::fs::create_dir_all(&bdir).unwrap();
        std::fs::write(bdir.join(harness::HARNESS_FILE), r#"{"port":1,"pid":1}"#).unwrap();
        let first = check_client_profiles(&p, false, &[Some(21)]).unwrap();
        assert!(
            first
                .problems
                .iter()
                .any(|l| l.starts_with("client a: pinned Java /no/such/java does not exist"))
        );
        assert!(first.problems.iter().any(|l| l == "client b: stale spawnloft-harness.json from an earlier run; run doctor without --json to clear it"));
        assert!(first.notes.iter().any(|l| l
            == "client c: Minecraft 25w14a vanilla, not installed yet: spawnloft client install c, stopped"));
        assert!(first.notes.iter().any(|l| l.starts_with("harness list: ")));
        let fixed = check_client_profiles(&p, true, &[]).unwrap();
        assert!(
            fixed
                .notes
                .iter()
                .any(|l| l == "client b: cleared stale spawnloft-harness.json")
        );
        assert!(!bdir.join(harness::HARNESS_FILE).exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
