//! The network cases of test/plugins.test.mjs and test/plugin-install-many.test.mjs, one to one
//! (`answers(routes)` is the Node tests' `fetch` mock), and the update check and update.

use super::*;
use crate::modrinth::{FAKE, Lost, Reply};
use crate::plugins::tests::{build_zip, inst_at, scratch, write_jar};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// A route's answer: JSON, raw bytes, or a status with a text body.
#[derive(Clone)]
enum Body {
    Json(Value),
    Bytes(Vec<u8>),
    Status(u16),
}

fn reply(status: u16, body: Vec<u8>) -> Result<Reply, Lost> {
    Ok(Reply {
        status,
        location: None,
        content_length: Some(body.len().to_string()),
        body: Box::new(std::io::Cursor::new(body)),
    })
}

/// Answers the first route whose text is part of the URL, else 404 `not found`; every URL asked
/// (decoded) and every POST body is kept.
fn answers(routes: Vec<(&str, Body)>) -> Arc<Mutex<Vec<String>>> {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    let routes: Vec<(String, Body)> = routes.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    FAKE.with(|f| {
        *f.borrow_mut() = Some(Box::new(move |req: &Request<'_>| {
            let url = percent_decode(req.url);
            log.lock().unwrap().push(match &req.json_body {
                Some(b) => format!("{} {url} {b}", req.method),
                None => url.clone(),
            });
            match routes.iter().find(|(part, _)| url.contains(part.as_str())) {
                None => reply(404, b"not found".to_vec()),
                Some((_, Body::Json(v))) => reply(200, crate::jsjson::stringify(v).into_bytes()),
                Some((_, Body::Bytes(b))) => reply(200, b.clone()),
                Some((_, Body::Status(s))) => reply(*s, b"{}".to_vec()),
            }
        }));
    });
    asked
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(x);
            i += 3;
            continue;
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn obj(pairs: Vec<(String, Value)>) -> Value {
    Value::Object(pairs.into_iter().collect())
}

fn j(v: Value) -> Body {
    Body::Json(v)
}

fn mr_version(extra: Value) -> Value {
    let mut base = json!({
        "project_id": "main1", "version_number": "2.0", "version_type": "release", "loaders": ["paper"],
        "game_versions": ["1.21.4"],
        "files": [{ "primary": true, "filename": "Main.jar", "url": "https://cdn.modrinth.com/Main.jar", "hashes": {} }],
        "dependencies": [],
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn needs(ids: &[&str]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| json!({ "project_id": id, "dependency_type": "required" }))
            .collect(),
    )
}

fn paper(tag: &str) -> (std::path::PathBuf, Instance) {
    let dir = scratch(tag);
    let inst = inst_at(&dir, json!({ "jar": "paper-1.21.4-100.jar" }));
    (dir, inst)
}

fn brief(plan: &Value) -> Vec<(String, bool, bool)> {
    plan["requires"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (s(d.get("title")), d["installed"] == true, d["off"] == true))
        .collect()
}

fn b(t: &str, i: bool, o: bool) -> (String, bool, bool) {
    (t.to_string(), i, o)
}

fn hv(over: Value) -> Value {
    let mut base = json!({
        "name": "2.0", "channel": { "name": "Release" },
        "platformDependencies": { "PAPER": ["26.2"] },
        "downloads": { "PAPER": { "downloadUrl": "https://x/file.jar", "fileInfo": { "name": "x.jar", "sha256Hash": "h" }, "externalUrl": null } },
    });
    for (k, v) in over.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

#[test]
fn a_hangar_release_with_a_real_file_and_an_exact_version_match_wins() {
    let versions = json!([
        hv(json!({ "name": "3.0-beta", "channel": { "name": "Beta" } })),
        hv(json!({ "name": "2.0" }))
    ]);
    let picked = pick_hangar_version(&versions, Some("26.2")).unwrap().unwrap();
    assert_eq!(picked.version["name"], "2.0");
    assert!(picked.exact_match);
}

#[test]
fn an_external_only_project_yields_null_it_cannot_be_installed_only_linked_to() {
    let versions = json!([hv(
        json!({ "downloads": { "PAPER": { "downloadUrl": null, "fileInfo": null, "externalUrl": "https://elsewhere" } } })
    )]);
    assert_eq!(pick_hangar_version(&versions, None).unwrap(), None);
}

#[test]
fn with_no_exact_match_the_newest_downloadable_is_offered_flagged_as_a_mismatch() {
    let versions = json!([hv(json!({ "platformDependencies": { "PAPER": ["26.1.2"] } }))]);
    let picked = pick_hangar_version(&versions, Some("26.2")).unwrap().unwrap();
    assert_eq!(picked.version["name"], "2.0");
    assert!(!picked.exact_match);
}

#[test]
fn hangar_search_reports_how_often_each_project_was_downloaded() {
    let asked = answers(vec![(
        "/projects?",
        j(json!({ "result": [{
            "name": "Chunky", "namespace": { "owner": "pop4959", "slug": "Chunky" }, "description": "Pre-generates chunks",
            "stats": { "views": 252983, "downloads": 76528, "recentViews": 7015, "recentDownloads": 2392, "stars": 303, "watchers": 157 },
        }] })),
    )]);
    let hits = search_hangar("chunky", 10).unwrap();
    assert_eq!(hits[0]["downloads"], 76528);
    assert_eq!(hits[0]["id"], "Chunky");
    assert_eq!(hits[0]["source"], "hangar");
    assert_eq!(
        crate::jsjson::stringify(&hits[0]),
        r#"{"source":"hangar","id":"Chunky","slug":"Chunky","title":"Chunky","description":"Pre-generates chunks","downloads":76528,"author":"pop4959"}"#
    );
    assert_eq!(
        asked.lock().unwrap()[0],
        "https://hangar.papermc.io/api/v1/projects?q=chunky&limit=10&platform=PAPER"
    );
}

#[test]
fn a_modrinth_search_asks_with_the_facets_node_sends_and_leaves_out_what_is_undefined() {
    let asked = answers(vec![(
        "/search?",
        j(
            json!({ "hits": [{ "project_id": "p1", "slug": "lp", "title": "LuckPerms", "downloads": 5, "icon_url": "" }] }),
        ),
    )]);
    let hits = search_plugins("perms x", 20, &crate::plugins::LOADERS, "plugin").unwrap();
    assert_eq!(
        crate::jsjson::stringify(&hits[0]),
        r#"{"source":"modrinth","id":"p1","slug":"lp","title":"LuckPerms","downloads":5,"icon":null}"#
    );
    assert_eq!(
        asked.lock().unwrap()[0],
        r#"https://api.modrinth.com/v2/search?query=perms x&facets=[["project_type:plugin"],["categories:paper","categories:spigot","categories:bukkit","categories:folia"]]&limit=20&index=relevance"#
    );
    answers(vec![("/search?", j(json!({})))]);
    let err = search_modpacks("x", 20).unwrap_err();
    assert_eq!(
        err.message(),
        "Cannot read properties of undefined (reading 'map')"
    );
}

#[test]
fn a_plan_lists_what_a_build_needs_and_which_of_it_is_already_here() {
    let (dir, inst) = paper("plan-here");
    // Vault dropped in by hand is still Vault; ProtocolLib was installed by SpawnLoft under another file name
    write_jar(&dir.join("plugins"), "Vault-1.7.jar", "name: Vault\n");
    write_jar(&dir.join("plugins"), "plib.jar", "name: Something Else\n");
    plugins::record_managed(
        &inst,
        "plib.jar",
        json!({ "source": "modrinth", "project": "plib1", "version": "5.0" }),
    )
    .unwrap();
    let mut deps = needs(&["vault1", "plib1", "lp1"]);
    deps.as_array_mut().unwrap().extend([
        json!({ "project_id": "opt1", "dependency_type": "optional" }),
        json!({ "project_id": "bad1", "dependency_type": "incompatible" }),
    ]);
    let asked = answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(json!({ "dependencies": deps }))])),
        ),
        (
            "/project/lp1/version",
            j(json!([mr_version(json!({ "project_id": "lp1" }))])),
        ),
        (
            "/projects?ids=",
            j(
                json!([{ "id": "vault1", "slug": "vault", "title": "Vault" }, { "id": "plib1", "slug": "protocollib", "title": "ProtocolLib" }, { "id": "lp1", "slug": "luckperms", "title": "LuckPerms" }]),
            ),
        ),
    ]);
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(
        (&plan["version"], &plan["exactMatch"], &plan["builtFor"]),
        (&json!("2.0"), &json!(true), &Value::Null)
    );
    assert_eq!(
        brief(&plan),
        vec![
            b("Vault", true, false),
            b("ProtocolLib", true, false),
            b("LuckPerms", false, false)
        ]
    );
    // nothing was downloaded to find this out, and what is already here was not asked about again
    let asked = asked.lock().unwrap();
    assert!(
        asked.iter().all(|u| u.starts_with("https://api.modrinth.com/")),
        "{asked:?}"
    );
    assert!(
        !asked
            .iter()
            .any(|u| u.contains("/project/vault1/") || u.contains("/project/plib1/"))
    );
    assert_eq!(
        asked[0],
        r#"https://api.modrinth.com/v2/project/main1/version?loaders=["paper","spigot","bukkit","folia"]"#
    );
    let mut jars: Vec<String> = std::fs::read_dir(dir.join("plugins"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(".jar"))
        .collect();
    jars.sort();
    assert_eq!(jars, ["Vault-1.7.jar", "plib.jar"]);
    // the whole answer, keys in Node's order
    assert_eq!(
        crate::jsjson::stringify(&plan["requires"][2]),
        r#"{"source":"modrinth","id":"lp1","title":"LuckPerms","installed":false,"off":false,"external":null,"builtFor":null,"mismatch":false}"#
    );
}

#[test]
fn a_plan_goes_down_through_what_the_requirements_need_once_each_and_says_which_have_no_build_for_this_version()
 {
    let (_dir, inst) = paper("plan-deep");
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(
                json!({ "dependencies": needs(&["a1", "b1"]) })
            )])),
        ),
        // a needs b (already listed) and c; c needs main (a loop); b has only an old build
        (
            "/project/a1/version",
            j(json!([mr_version(
                json!({ "project_id": "a1", "dependencies": needs(&["b1", "c1"]) })
            )])),
        ),
        (
            "/project/b1/version",
            j(json!([mr_version(
                json!({ "project_id": "b1", "game_versions": ["1.20.4"] })
            )])),
        ),
        (
            "/project/c1/version",
            j(json!([mr_version(
                json!({ "project_id": "c1", "dependencies": needs(&["main1"]) })
            )])),
        ),
        (
            "/projects?ids=",
            j(
                json!([{ "id": "a1", "slug": "a", "title": "A" }, { "id": "b1", "slug": "b", "title": "B" }, { "id": "c1", "slug": "c", "title": "C" }]),
            ),
        ),
    ]);
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    let got: Vec<(String, Value, Value)> = plan["requires"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (s(d.get("title")), d["mismatch"].clone(), d["builtFor"].clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("A".into(), json!(false), Value::Null),
            ("C".into(), json!(false), Value::Null),
            ("B".into(), json!(true), json!("1.20.4")),
        ]
    );
}

#[test]
fn a_turned_off_jar_is_not_installed_and_a_name_in_another_alphabet_does_not_stand_in_for_everything() {
    let (dir, inst) = paper("plan-off");
    write_jar(&dir.join("plugins"), "Vault.jar.disabled", "name: Vault\n");
    write_jar(&dir.join("plugins"), "jingji.jar", "name: 经济\n");
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(
                json!({ "dependencies": needs(&["vault1", "lp1"]) })
            )])),
        ),
        (
            "/project/lp1/version",
            j(json!([mr_version(json!({ "project_id": "lp1" }))])),
        ),
        // the name lookup fails: both are listed by id, and neither counts as here
        ("/projects?ids=", j(Value::Null)),
    ]);
    let lost = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(
        brief(&lost),
        vec![b("vault1", false, false), b("lp1", false, false)]
    );
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(json!({ "dependencies": needs(&["vault1"]) }))])),
        ),
        (
            "/projects?ids=",
            j(json!([{ "id": "vault1", "slug": "vault", "title": "Vault" }])),
        ),
    ]);
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(brief(&plan), vec![b("Vault", false, true)]);
}

#[test]
fn a_requirement_named_only_by_build_is_looked_up_and_listed_even_when_it_cannot_be() {
    let (_dir, inst) = paper("plan-build");
    let by_build = json!([{ "project_id": null, "version_id": "v9", "dependency_type": "required" }]);
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(json!({ "dependencies": by_build }))])),
        ),
        ("/versions?ids=", j(json!([{ "id": "v9", "project_id": "lp1" }]))),
        (
            "/project/lp1/version",
            j(json!([mr_version(json!({ "project_id": "lp1" }))])),
        ),
        (
            "/projects?ids=",
            j(json!([{ "id": "lp1", "slug": "luckperms", "title": "LuckPerms" }])),
        ),
    ]);
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(brief(&plan), vec![b("LuckPerms", false, false)]);
    answers(vec![(
        "/project/main1/version",
        j(json!([mr_version(json!({ "dependencies": by_build }))])),
    )]);
    let blind = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    let r = blind["requires"].as_array().unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(
        (&r[0]["unnamed"], &r[0]["id"], &r[0]["installed"]),
        (&json!(true), &Value::Null, &json!(false))
    );
    assert_eq!(
        crate::jsjson::stringify(&r[0]),
        r#"{"source":"modrinth","id":null,"title":"something Modrinth does not name","installed":false,"off":false,"external":null,"unnamed":true,"builtFor":null,"mismatch":false}"#
    );
}

#[test]
fn a_mod_is_known_by_its_id_as_well_as_its_name_and_a_modpacks_record_is_not_a_project_match() {
    let dir = scratch("plan-mods");
    let inst = inst_at(
        &dir,
        json!({ "jar": "fabric-server-mc.1.21.4-loader.0.16.0-launcher.1.0.0.jar", "loader": "fabric" }),
    );
    std::fs::create_dir_all(dir.join("mods")).unwrap();
    let mod_jar = |id: &str, name: &str, v: &str| {
        build_zip(
            &[(
                "fabric.mod.json",
                json!({ "id": id, "name": name, "version": v })
                    .to_string()
                    .as_bytes(),
            )],
            false,
        )
    };
    std::fs::write(
        dir.join("mods/cloth.jar"),
        mod_jar("cloth-config", "Cloth Config v15", "15.0"),
    )
    .unwrap();
    std::fs::write(dir.join("mods/other.jar"), mod_jar("other", "Other", "1")).unwrap();
    // the pack's own id is on every jar it brought; it says nothing about which project a jar is
    plugins::record_managed(
        &inst,
        "other.jar",
        json!({ "source": "modpack", "project": "arch1", "version": "1" }),
    )
    .unwrap();
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(
                json!({ "loaders": ["fabric"], "dependencies": needs(&["cloth1", "arch1"]) })
            )])),
        ),
        (
            "/project/arch1/version",
            j(json!([mr_version(
                json!({ "project_id": "arch1", "loaders": ["fabric"] })
            )])),
        ),
        (
            "/projects?ids=",
            j(
                json!([{ "id": "cloth1", "slug": "cloth-config", "title": "Cloth Config API" }, { "id": "arch1", "slug": "architectury-api", "title": "Architectury API" }]),
            ),
        ),
    ]);
    let rows = list_plugins(&inst).unwrap();
    assert_eq!(
        rows.iter().find(|p| p["file"] == "cloth.jar").unwrap()["modId"],
        "cloth-config"
    );
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(
        brief(&plan),
        vec![
            b("Cloth Config API", true, false),
            b("Architectury API", false, false)
        ]
    );
}

#[test]
fn a_plan_says_when_the_only_build_is_for_another_minecraft_version_and_the_record_keeps_what_the_build_lists()
 {
    let (dir, inst) = paper("plan-old");
    answers(vec![
        (
            "/project/main1/version",
            j(json!([mr_version(
                json!({ "game_versions": ["1.20.1", "1.20.4"] })
            )])),
        ),
        ("cdn.modrinth.com/Main.jar", Body::Bytes(b"jar".to_vec())),
    ]);
    let plan = plan_install(&inst, "main1", "modrinth", Some("1.21.4")).unwrap();
    assert_eq!(
        (&plan["exactMatch"], &plan["builtFor"]),
        (&json!(false), &json!("1.20.4"))
    );
    // a server whose version is not known is not told its plugins are for the wrong one
    assert_eq!(
        plan_install(&inst, "main1", "modrinth", None).unwrap()["exactMatch"],
        true
    );
    let out = install_plugin(&inst, "main1", Some("1.21.4")).unwrap();
    assert!(
        s(out.get("versionNote")).contains("lists 1.20.4, not 1.21.4"),
        "{out}"
    );
    let store = read_managed(&inst).unwrap();
    assert_eq!(
        store["managed"]["Main.jar"]["gameVersions"],
        json!(["1.20.1", "1.20.4"])
    );
    let rows = list_plugins(&inst).unwrap();
    assert_eq!(
        rows.iter().find(|p| p["file"] == "Main.jar").unwrap()["gameVersions"],
        json!(["1.20.1", "1.20.4"])
    );
    // a jar added by hand says nothing about versions
    write_jar(&dir.join("plugins"), "Hand.jar", "name: Hand\n");
    let rows = list_plugins(&inst).unwrap();
    assert_eq!(
        rows.iter().find(|p| p["file"] == "Hand.jar").unwrap()["gameVersions"],
        Value::Null
    );
}

#[test]
fn a_project_id_that_is_not_one_never_reaches_a_request() {
    let (_dir, inst) = paper("plan-bad");
    let asked = answers(vec![]);
    for bad in ["..", ".", "", "a/b", "a?b", &"x".repeat(65), "a b"] {
        assert_eq!(
            plan_install(&inst, bad, "modrinth", None).unwrap_err().message(),
            "that is not a project id",
            "{bad}"
        );
        assert_eq!(
            install_plugin(&inst, bad, None).unwrap_err().message(),
            "that is not a project id",
            "{bad}"
        );
        assert_eq!(
            install_from_hangar(&inst, bad, None).unwrap_err().message(),
            "that is not a project id",
            "{bad}"
        );
    }
    assert!(asked.lock().unwrap().is_empty());
    assert!(is_project_id("a.b-c_9") && is_project_id(&"x".repeat(64)) && !is_project_id("é"));
}

#[test]
fn a_hangar_plan_lists_required_plugins_and_where_one_that_is_hosted_elsewhere_lives() {
    let (dir, inst) = paper("plan-hangar");
    write_jar(&dir.join("plugins"), "Vault.jar", "name: Vault\n");
    let build = |extra: Value| {
        let mut base = json!({ "name": "3.1", "channel": { "name": "Release" }, "platformDependencies": { "PAPER": ["1.21.4"] }, "downloads": { "PAPER": { "downloadUrl": "https://hangar/x.jar", "fileInfo": { "name": "x.jar" } } } });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    };
    answers(vec![
        (
            "/projects/Shop/versions",
            j(json!({ "result": [build(json!({
                "platformDependencies": { "PAPER": ["1.20.4"] },
                "pluginDependencies": { "PAPER": [
                    { "name": "Vault", "required": true, "externalUrl": null },
                    { "name": "Citizens", "required": true, "externalUrl": "https://ci.citizensnpcs.co" },
                    { "name": "PlaceholderAPI", "required": false, "externalUrl": null },
                    { "name": "ProtocolLib", "required": true, "externalUrl": null },
                ] },
            }))] })),
        ),
        (
            "/projects/ProtocolLib/versions",
            j(json!({ "result": [build(json!({}))] })),
        ),
    ]);
    let plan = plan_install(&inst, "Shop", "hangar", Some("1.21.4")).unwrap();
    assert_eq!(
        (&plan["version"], &plan["exactMatch"], &plan["builtFor"]),
        (&json!("3.1"), &json!(false), &json!("1.20.4"))
    );
    let got: Vec<(String, bool, Value, bool)> = plan["requires"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                s(d.get("title")),
                d["installed"] == true,
                d["external"].clone(),
                d["mismatch"] == true,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("Vault".into(), true, Value::Null, false),
            (
                "Citizens".into(),
                false,
                json!("https://ci.citizensnpcs.co"),
                false
            ),
            ("ProtocolLib".into(), false, Value::Null, false),
        ]
    );
}

#[test]
fn a_hangar_install_checks_the_sha256_and_refuses_an_odd_file_name() {
    let (dir, inst) = paper("hangar-install");
    let jar = b"a hangar jar".to_vec();
    let sum = crate::sha256::hex(&jar);
    let build = |name: &str, sha: &str| {
        json!({ "result": [{ "name": "1.2", "channel": { "name": "Release" }, "platformDependencies": { "PAPER": ["1.20.4"] },
            "downloads": { "PAPER": { "downloadUrl": "https://hangarcdn.papermc.io/x.jar", "fileInfo": { "name": name, "sha256Hash": sha } } } }] })
    };
    answers(vec![
        ("/projects/Chunky/versions", j(build("Chunky-1.2.jar", &sum))),
        ("hangarcdn", Body::Bytes(jar.clone())),
    ]);
    let out = install_from_hangar(&inst, "Chunky", Some("1.21.4")).unwrap();
    assert_eq!(
        crate::jsjson::stringify(&out),
        r#"{"installed":"Chunky-1.2.jar","version":"1.2","size":12,"versionNote":"Hangar lists support for 1.20.4, not 1.21.4 - it will probably run, but that is its author's claim, not SpawnLoft's."}"#
    );
    assert_eq!(std::fs::read(dir.join("plugins/Chunky-1.2.jar")).unwrap(), jar);
    let rec = &read_managed(&inst).unwrap()["managed"]["Chunky-1.2.jar"];
    assert_eq!(
        (
            &rec["source"],
            &rec["project"],
            &rec["version"],
            &rec["gameVersions"]
        ),
        (
            &json!("hangar"),
            &json!("Chunky"),
            &json!("1.2"),
            &json!(["1.20.4"])
        )
    );

    answers(vec![
        ("/projects/Chunky/versions", j(build("C.jar", "00"))),
        ("hangarcdn", Body::Bytes(jar.clone())),
    ]);
    assert_eq!(
        install_from_hangar(&inst, "Chunky", None).unwrap_err().message(),
        "the download did not match the checksum Hangar published; nothing was installed"
    );
    answers(vec![
        ("/projects/Chunky/versions", j(build("..\\x.jar", &sum))),
        ("hangarcdn", Body::Bytes(jar.clone())),
    ]);
    // `path.basename` splits on a backslash only on Windows, where the name comes out as x.jar
    let got = install_from_hangar(&inst, "Chunky", None);
    if cfg!(windows) {
        assert_eq!(got.unwrap()["installed"], "x.jar");
    } else {
        assert_eq!(
            got.unwrap_err().message(),
            "Hangar offered a file named \"..\\x.jar\", which is not a plugin jar"
        );
    }
    answers(vec![(
        "/projects/Ext/versions",
        j(
            json!({ "result": [{ "name": "1", "downloads": { "PAPER": { "externalUrl": "https://example.org/dl" } } }] }),
        ),
    )]);
    assert_eq!(
        install_from_hangar(&inst, "Ext", None).unwrap_err().message(),
        "that project hosts its downloads elsewhere: https://example.org/dl\n  Download it by hand and drop it into the plugins folder - SpawnLoft will leave it alone."
    );
    answers(vec![("/projects/Gone/versions", Body::Status(500))]);
    assert_eq!(
        install_from_hangar(&inst, "Gone", None).unwrap_err().message(),
        "Hangar answered 500 for /projects/Gone/versions?limit=25&platform=PAPER"
    );
}

#[test]
fn a_modrinth_install_checks_the_sha1_and_says_what_went_wrong() {
    let (_dir, inst) = paper("mr-install");
    let file = |sha: &str, name: &str| {
        json!([mr_version(
            json!({ "files": [{ "primary": true, "filename": name, "url": "https://cdn.modrinth.com/M.jar", "hashes": { "sha1": sha } }] })
        )])
    };
    let jar = b"jar".to_vec();
    answers(vec![
        ("/project/main1/version", j(file("0", "M.jar"))),
        ("cdn.modrinth.com/M.jar", Body::Bytes(jar.clone())),
    ]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        "the download did not match the checksum Modrinth published; nothing was installed"
    );
    answers(vec![
        (
            "/project/main1/version",
            j(file(&crate::sha1::hex(&jar), "M.txt")),
        ),
        ("cdn.modrinth.com/M.jar", Body::Bytes(jar.clone())),
    ]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        "Modrinth offered a file named \"M.txt\", which is not a plugin jar"
    );
    answers(vec![(
        "/project/main1/version",
        j(file(&crate::sha1::hex(&jar), "M.jar")),
    )]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        "download failed: 404"
    );
    answers(vec![(
        "/project/main1/version",
        j(json!([mr_version(json!({ "loaders": ["fabric"] }))])),
    )]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        "no build of that plugin supports a paper server"
    );
    answers(vec![(
        "/project/main1/version",
        j(json!([mr_version(json!({ "files": [] }))])),
    )]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        "that version has no downloadable file"
    );
    answers(vec![]);
    assert_eq!(
        install_plugin(&inst, "main1", None).unwrap_err().message(),
        r#"Modrinth answered 404 for /project/main1/version?loaders=%5B%22paper%22%2C%22spigot%22%2C%22bukkit%22%2C%22folia%22%5D"#
    );
}

#[test]
fn the_update_check_asks_by_hash_for_jars_spawnloft_installed_and_counts_the_rest() {
    let (dir, inst) = paper("updates");
    let p = dir.join("plugins");
    write_jar(&p, "Mine.jar", "name: Mine\nversion: 1.0\n");
    write_jar(&p, "Hand.jar", "name: Hand\n");
    write_jar(&p, "Off.jar.disabled", "name: Off\n");
    write_jar(&p, "Same.jar", "name: Same\n");
    write_jar(&p, "Hang.jar", "name: Hang\n");
    write_jar(&p, "Down.jar", "name: Down\n");
    let rec = |src: &str, project: &str, v: &str| json!({ "source": src, "project": project, "version": v });
    plugins::record_managed(&inst, "Mine.jar", rec("modrinth", "mine1", "1.0")).unwrap();
    plugins::record_managed(&inst, "Off.jar.disabled", rec("modrinth", "off1", "1.0")).unwrap();
    plugins::record_managed(&inst, "Same.jar", rec("modrinth", "same1", "1.0")).unwrap();
    plugins::record_managed(&inst, "Hang.jar", rec("hangar", "Hang", "1.0")).unwrap();
    plugins::record_managed(&inst, "Down.jar", rec("hangar", "Down", "1.0")).unwrap();
    let sha = |f: &str| crate::sha1::hex(&std::fs::read(p.join(f)).unwrap());
    let (mine, same) = (sha("Mine.jar"), sha("Same.jar"));
    let newer = mr_version(
        json!({ "project_id": "mine1", "version_number": "1.1", "files": [{ "primary": true, "hashes": { "sha1": "ff" } }] }),
    );
    let current = mr_version(
        json!({ "project_id": "same1", "files": [{ "primary": true, "hashes": { "sha1": same } }] }),
    );
    let asked = answers(vec![
        (
            "/version_files/update",
            j(obj(vec![(mine.clone(), newer), (same.clone(), current)])),
        ),
        (
            "/projects/Hang/versions",
            j(json!({ "result": [hv(json!({ "name": "2.0" }))] })),
        ),
        ("/projects/Down/versions", Body::Status(503)),
    ]);
    let report = check_updates_report(&inst, Some("1.21.4")).unwrap();
    assert_eq!(
        crate::jsjson::stringify(&report),
        format!(
            r#"{{"updates":[{{"file":"Mine.jar","name":"Mine","installedVersion":"1.0","latestVersion":"1.1","projectId":"mine1","source":"modrinth"}},{{"file":"Hang.jar","name":"Hang","installedVersion":"1.0","latestVersion":"2.0","projectId":"Hang","source":"hangar"}}],"checked":3,"byHand":1,"off":1,"pack":0,"unknown":0,"unreachable":["Down"]}}"#
        )
    );
    let posted = asked.lock().unwrap()[0].clone();
    assert!(
        posted.starts_with("POST https://api.modrinth.com/v2/version_files/update {\"hashes\":["),
        "{posted}"
    );
    assert!(
        posted.ends_with(
            r#""algorithm":"sha1","loaders":["paper","spigot","bukkit","folia"],"game_versions":["1.21.4"]}"#
        ),
        "{posted}"
    );
    assert_eq!(
        check_updates(&inst, Some("1.21.4"))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn an_update_replaces_the_jar_only_once_the_new_one_is_in_and_refuses_what_spawnloft_does_not_own() {
    let (dir, inst) = paper("update-one");
    let p = dir.join("plugins");
    write_jar(&p, "Mine-1.0.jar", "name: Mine\n");
    write_jar(&p, "Hand.jar", "name: Hand\n");
    write_jar(&p, "Packed.jar", "name: Packed\n");
    plugins::record_managed(
        &inst,
        "Mine-1.0.jar",
        json!({ "source": "modrinth", "project": "mine1", "version": "1.0" }),
    )
    .unwrap();
    plugins::record_managed(
        &inst,
        "Packed.jar",
        json!({ "source": "modpack", "project": "pack1", "version": "1" }),
    )
    .unwrap();
    assert!(
        update_plugin(&inst, "Hand.jar", None)
            .unwrap_err()
            .message()
            .starts_with("SpawnLoft did not install this jar")
    );
    assert!(
        update_plugin(&inst, "Packed.jar", None)
            .unwrap_err()
            .message()
            .starts_with("this mod belongs to the modpack")
    );
    assert_eq!(
        update_plugin(&inst, "../x.jar", None).unwrap_err().message(),
        "\"../x.jar\" is not a plugin file name"
    );

    let sha = crate::sha1::hex(&std::fs::read(p.join("Mine-1.0.jar")).unwrap());
    let jar = b"new jar".to_vec();
    let v11 = mr_version(json!({ "project_id": "mine1", "version_number": "1.1",
        "files": [{ "primary": true, "filename": "Mine-1.1.jar", "url": "https://cdn.modrinth.com/Mine-1.1.jar", "hashes": { "sha1": crate::sha1::hex(&jar) } }] }));
    answers(vec![
        ("/version_files/update", j(obj(vec![(sha.clone(), v11.clone())]))),
        ("/project/mine1/version", j(json!([v11]))),
        ("cdn.modrinth.com/Mine-1.1.jar", Body::Bytes(jar.clone())),
    ]);
    let out = update_plugin(&inst, "Mine-1.0.jar", Some("1.21.4")).unwrap();
    assert_eq!(
        crate::jsjson::stringify(&out),
        r#"{"updated":"Mine-1.1.jar","from":"Mine-1.0.jar","version":"1.1"}"#
    );
    assert!(!p.join("Mine-1.0.jar").exists() && p.join("Mine-1.1.jar").exists());
    let store = read_managed(&inst).unwrap();
    assert!(store["managed"].get("Mine-1.0.jar").is_none() && store["managed"].get("Mine-1.1.jar").is_some());

    let sha = crate::sha1::hex(&jar);
    let same = mr_version(
        json!({ "version_number": "1.1", "files": [{ "primary": true, "hashes": { "sha1": sha } }] }),
    );
    answers(vec![("/version_files/update", j(obj(vec![(sha.clone(), same)])))]);
    assert_eq!(
        crate::jsjson::stringify(&update_plugin(&inst, "Mine-1.1.jar", None).unwrap()),
        r#"{"alreadyLatest":true,"version":"1.1"}"#
    );
    answers(vec![("/version_files/update", j(json!({})))]);
    assert_eq!(
        update_plugin(&inst, "Mine-1.1.jar", None).unwrap_err().message(),
        "Modrinth does not recognise this jar, so it cannot update it"
    );
}

fn layout_at(root: &Path) -> crate::settings::Layout {
    let r = root.to_string_lossy().into_owned();
    let at = |p: &str| jspath::join(&[&r, p]);
    crate::settings::Layout {
        instances_dir: at("instances"),
        separate_instances: false,
        registry_file: at("instances.json"),
        templates_dir: at("templates"),
        jars_dir: at("jars"),
        backups_dir: at("backups"),
        run_dir: at("run"),
        engines_dir: at("engines"),
        services_dir: at("services"),
        settings_file: at("settings.json"),
        data_root: r,
    }
}

#[test]
fn what_it_needs_comes_with_it_under_one_backup_and_one_that_fails_is_reported_not_fatal() {
    use crate::plugin_actions::{Also, install_with_snapshot};
    let root = scratch("install-many");
    let layout = layout_at(&root);
    let dir = root.join("instances/with-friends");
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    std::fs::write(dir.join("paper-1.21.4-100.jar"), "").unwrap();
    std::fs::write(dir.join("plugins/Old.jar"), "not a zip, still a jar").unwrap();
    let mut inst = inst_at(
        &dir,
        json!({ "jar": "paper-1.21.4-100.jar", "memory": "1G", "port": 41640, "rcon": { "port": 41641, "password": "p" } }),
    );
    inst.name = "with-friends".into();
    let version = |id: &str| {
        json!([{ "project_id": id, "version_number": "1.0", "version_type": "release", "loaders": ["paper"], "game_versions": ["1.21.4"],
            "files": [{ "primary": true, "filename": format!("{id}.jar"), "url": format!("https://cdn.modrinth.com/{id}.jar"), "hashes": {} }], "dependencies": [] }])
    };
    answers(vec![
        ("/project/gone1/version", Body::Status(404)),
        ("/project/main1/version", j(version("main1"))),
        ("/project/vault1/version", j(version("vault1"))),
        ("https://cdn.modrinth.com/", Body::Bytes(b"jar".to_vec())),
    ]);
    let also = [
        Also {
            project_id: "vault1".into(),
            source: "modrinth".into(),
        },
        Also {
            project_id: "gone1".into(),
            source: "modrinth".into(),
        },
    ];
    let by = crate::activity::Actor::spawnloft();
    let out = install_with_snapshot(&layout, &by, &inst, "main1", "modrinth", &also).unwrap();
    assert_eq!(out["installed"], "main1.jar");
    assert_eq!(
        out["extras"],
        json!([{ "projectId": "vault1", "installed": "vault1.jar", "version": "1.0" }])
    );
    assert_eq!(out["failed"].as_array().unwrap().len(), 1);
    assert_eq!(out["failed"][0]["projectId"], "gone1");
    let mut jars: Vec<String> = std::fs::read_dir(dir.join("plugins"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(".jar"))
        .collect();
    jars.sort();
    assert_eq!(jars, ["Old.jar", "main1.jar", "vault1.jar"]);

    // one backup, named on both entries
    let snap = s(out.get("snapshot"));
    assert!(Path::new(&snap).exists(), "{snap}");
    let log = std::fs::read_to_string(root.join("activity.jsonl")).unwrap();
    let entries: Vec<Value> = log
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|e| e["action"] == "plugin-install")
        .collect();
    let mut details: Vec<String> = entries.iter().map(|e| s(e.get("detail"))).collect();
    details.sort();
    assert_eq!(details, ["main1.jar 1.0", "vault1.jar 1.0"]);
    assert!(entries.iter().all(|e| e["snapshot"] == jspath::basename(&snap)));
    let tars = std::fs::read_dir(Path::new(&snap).parent().unwrap())
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tar.gz")
        })
        .count();
    assert_eq!(tars, 1);
}

#[test]
fn a_search_everywhere_keeps_one_sources_hits_when_the_other_is_down() {
    use crate::plugin_actions::search_everywhere;
    let (_dir, inst) = paper("everywhere");
    answers(vec![
        ("api.modrinth.com", Body::Status(503)),
        (
            "/projects?",
            j(json!({ "result": [{ "name": "Chunky", "namespace": { "slug": "Chunky" } }] })),
        ),
    ]);
    let got = search_everywhere(&inst, "c");
    assert_eq!(
        got["errors"],
        json!([
            "Modrinth answered 503 for /search?query=c&facets=%5B%5B%22project_type%3Aplugin%22%5D%2C%5B%22categories%3Apaper%22%2C%22categories%3Aspigot%22%2C%22categories%3Abukkit%22%2C%22categories%3Afolia%22%5D%5D&limit=20&index=relevance"
        ])
    );
    assert_eq!(got["results"][0]["id"], "Chunky");
    let vanilla = inst_at(
        &scratch("everywhere-v"),
        json!({ "jar": "vanilla-1.21.4.jar", "loader": "vanilla" }),
    );
    assert_eq!(
        search_everywhere(&vanilla, "c"),
        json!({ "results": [], "errors": ["Vanilla runs no plugins or mods"] })
    );
}

#[test]
fn a_null_hangar_build_and_a_result_that_is_not_a_list_fail_as_node_does() {
    let err = pick_hangar_version(&json!([null]), None).unwrap_err();
    assert_eq!(
        err.message(),
        "Cannot read properties of null (reading 'channel')"
    );
    // the first pass reads every build's channel, so a null after a fine one fails too
    let err = pick_hangar_version(&json!([hv(json!({ "channel": null })), null]), None).unwrap_err();
    assert_eq!(
        err.message(),
        "Cannot read properties of null (reading 'channel')"
    );

    let (_dir, inst) = paper("hangar-odd");
    answers(vec![("/projects/Odd/versions", j(json!({ "result": "x" })))]);
    assert_eq!(
        install_from_hangar(&inst, "Odd", None).unwrap_err().message(),
        "versions.find is not a function"
    );
    answers(vec![("/projects/None/versions", j(json!({ "result": null })))]);
    assert_eq!(
        install_from_hangar(&inst, "None", None).unwrap_err().message(),
        "that project has no downloadable Paper build on Hangar"
    );
}

#[test]
fn the_plugins_folder_is_made_even_when_the_offered_name_is_refused() {
    let (dir, inst) = paper("odd-name-dir");
    let jar = b"j".to_vec();
    answers(vec![
        (
            "/projects/Chunky/versions",
            j(
                json!({ "result": [hv(json!({ "downloads": { "PAPER": { "downloadUrl": "https://hangarcdn.papermc.io/x", "fileInfo": { "name": "x.zip" } } } }))] }),
            ),
        ),
        ("hangarcdn", Body::Bytes(jar)),
    ]);
    let _ = std::fs::remove_dir_all(dir.join("plugins"));
    assert_eq!(
        install_from_hangar(&inst, "Chunky", None).unwrap_err().message(),
        "Hangar offered a file named \"x.zip\", which is not a plugin jar"
    );
    assert!(dir.join("plugins").is_dir());
}

#[test]
fn an_old_jar_that_turned_into_a_folder_stops_the_update_before_its_record_is_dropped() {
    let (dir, inst) = paper("retire-dir");
    let p = dir.join("plugins");
    std::fs::create_dir_all(p.join("Old.jar")).unwrap();
    plugins::record_managed(
        &inst,
        "Old.jar",
        json!({ "source": "hangar", "project": "Chunky", "version": "1" }),
    )
    .unwrap();
    let jar = b"new".to_vec();
    answers(vec![
        (
            "/projects/Chunky/versions",
            j(
                json!({ "result": [hv(json!({ "downloads": { "PAPER": { "downloadUrl": "https://hangarcdn.papermc.io/x", "fileInfo": { "name": "New.jar" } } } }))] }),
            ),
        ),
        ("hangarcdn", Body::Bytes(jar)),
    ]);
    let err = update_plugin(&inst, "Old.jar", None).unwrap_err();
    let old = jspath::join(&[&p.to_string_lossy(), "Old.jar"]);
    assert_eq!(
        err.message(),
        format!("Path is a directory: rm returned EISDIR (is a directory) {old}")
    );
    assert!(p.join("New.jar").exists());
    assert!(read_managed(&inst).unwrap()["managed"].get("Old.jar").is_some());
}
