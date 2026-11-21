//! The local cases of test/plugins.test.mjs, one to one, and the manifest readers' edges.

use super::*;
use serde_json::json;

/// A zip built by hand, as the Node test builds it, so the reader is tested against the format.
pub(crate) fn build_zip(entries: &[(&str, &[u8])], deflate: bool) -> Vec<u8> {
    use std::io::Write;
    let mut locals = Vec::new();
    let mut centrals = Vec::new();
    let mut offset = 0u32;
    for (name, raw) in entries {
        let data = if deflate {
            let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(raw).unwrap();
            e.finish().unwrap()
        } else {
            raw.to_vec()
        };
        let method: u16 = if deflate { 8 } else { 0 };
        let mut crc = flate2::Crc::new();
        crc.update(raw);
        let crc = crc.sum();
        let nb = name.as_bytes();
        let mut local = vec![0u8; 30];
        local[0..4].copy_from_slice(&0x04034b50u32.to_le_bytes());
        local[4..6].copy_from_slice(&20u16.to_le_bytes());
        local[8..10].copy_from_slice(&method.to_le_bytes());
        local[14..18].copy_from_slice(&crc.to_le_bytes());
        local[18..22].copy_from_slice(&(data.len() as u32).to_le_bytes());
        local[22..26].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        local[26..28].copy_from_slice(&(nb.len() as u16).to_le_bytes());
        locals.extend_from_slice(&local);
        locals.extend_from_slice(nb);
        locals.extend_from_slice(&data);
        let mut central = vec![0u8; 46];
        central[0..4].copy_from_slice(&0x02014b50u32.to_le_bytes());
        central[4..6].copy_from_slice(&20u16.to_le_bytes());
        central[6..8].copy_from_slice(&20u16.to_le_bytes());
        central[10..12].copy_from_slice(&method.to_le_bytes());
        central[16..20].copy_from_slice(&crc.to_le_bytes());
        central[20..24].copy_from_slice(&(data.len() as u32).to_le_bytes());
        central[24..28].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        central[28..30].copy_from_slice(&(nb.len() as u16).to_le_bytes());
        central[42..46].copy_from_slice(&offset.to_le_bytes());
        centrals.extend_from_slice(&central);
        centrals.extend_from_slice(nb);
        offset += 30 + nb.len() as u32 + data.len() as u32;
    }
    let mut eocd = vec![0u8; 22];
    eocd[0..4].copy_from_slice(&0x06054b50u32.to_le_bytes());
    eocd[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[10..12].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[12..16].copy_from_slice(&(centrals.len() as u32).to_le_bytes());
    eocd[16..20].copy_from_slice(&offset.to_le_bytes());
    let mut out = locals;
    out.extend_from_slice(&centrals);
    out.extend_from_slice(&eocd);
    out
}

fn scratch(tag: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "sl-plugins-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("plugins")).unwrap();
    d
}

fn write_jar(dir: &Path, name: &str, yml: &str) {
    let zip = build_zip(
        &[
            ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
            ("plugin.yml", yml.as_bytes()),
        ],
        false,
    );
    std::fs::write(dir.join(name), zip).unwrap();
}

fn inst_at(dir: &Path, extra: Value) -> Instance {
    let mut fields = Map::new();
    fields.insert("dir".into(), json!(dir.to_string_lossy()));
    fields.insert("jar".into(), json!("paper-26.2-121.jar"));
    if let Value::Object(m) = extra {
        fields.extend(m);
    }
    Instance {
        name: "test".into(),
        fields,
    }
}

fn names(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|r| js::string(r.get("name"))).collect()
}

#[test]
fn the_common_manifest_fields_come_through_quotes_stripped() {
    let meta = parse_plugin_yml(
        "name: EcoExample\nversion: '2026.33'\nmain: com.example.Main\napi-version: \"1.21\"\nauthor: Auxilor\ndescription: Does example things\nwebsite: https://example.com",
    );
    assert_eq!(meta["name"], "EcoExample");
    assert_eq!(meta["version"], "2026.33");
    assert_eq!(meta["api-version"], "1.21");
    assert_eq!(meta["author"], "Auxilor");
}

#[test]
fn authors_as_a_flow_list_and_as_a_block_list_both_become_arrays() {
    assert_eq!(
        parse_plugin_yml("authors: [A, \"B\"]\n")["authors"],
        json!(["A", "B"])
    );
    assert_eq!(
        parse_plugin_yml("authors:\n  - A\n  - B\n")["authors"],
        json!(["A", "B"])
    );
}

#[test]
fn nested_blocks_like_commands_are_skipped_without_eating_later_keys() {
    let meta = parse_plugin_yml("name: X\ncommands:\n  fly:\n    usage: /fly\nversion: 1.2\n");
    assert_eq!(meta["name"], "X");
    assert_eq!(meta["version"], "1.2");
    assert!(!meta.contains_key("commands"));
}

#[test]
fn yml_edges_as_javascript_reads_them() {
    // an empty block is an empty list; a folded scalar is joined; a lone quote is empty
    let meta = parse_plugin_yml("name:\nDescription: >\n  one\n  two\nversion: \"\nwebsite: []\n");
    assert_eq!(meta["name"], json!([]));
    assert_eq!(meta["description"], "one two");
    assert_eq!(meta["version"], "");
    assert_eq!(meta["website"], json!([]));
    // a lone carriage return inside a value: `.` does not match it, so the line is skipped
    assert!(!parse_plugin_yml("name: a\rb\n").contains_key("name"));
    // but whitespace before the value may hold one
    assert_eq!(parse_plugin_yml("name:\r\n")["name"], json!([]));
    assert_eq!(parse_plugin_yml("name: \u{2028}x")["name"], "x");
}

#[test]
fn mods_toml_reads_the_first_mods_block() {
    let text = "modLoader=\"javafml\"\n[[mods]]\nmodId=\"cool\" # the id\ndisplayName='Cool Mod'\nversion=\"${file.jarVersion}\"\ndescription='''\nDoes\n  things'''\nauthors=\"Me\"\n[[dependencies.cool]]\nmodId=\"neoforge\"";
    let meta = parse_mods_toml(text, Some("1.4.2")).unwrap();
    assert_eq!(
        Value::Object(meta),
        json!({"name": "Cool Mod", "modId": "cool", "version": "1.4.2", "description": "Does\n  things", "authors": ["Me"]})
    );
    assert!(parse_mods_toml("modId=\"x\"", None).is_none());
    // an unclosed multi-line string loses its last character, as `slice(0, -1)` does
    let meta = parse_mods_toml("[[mods]]\ndescription=\"\"\"abc\nmore", None).unwrap();
    assert_eq!(meta["description"], "abc\nmor");
    assert_eq!(meta["name"], Value::Null);
}

#[test]
fn the_implementation_version_follows_the_multiline_pattern() {
    assert_eq!(
        implementation_version("A: b\nImplementation-Version: 2.0 \n").as_deref(),
        Some("2.0")
    );
    assert_eq!(
        implementation_version("Implementation-Version:\n  3.1\n").as_deref(),
        Some("3.1")
    );
    assert_eq!(implementation_version("XImplementation-Version: 1\n"), None);
    assert_eq!(implementation_version("Implementation-Version:"), None);
    assert_eq!(
        implementation_version("Implementation-Version:\nImplementation-Version: 4").as_deref(),
        Some("Implementation-Version: 4")
    );
}

#[test]
fn the_game_version_is_read_from_the_server_jar_name() {
    let i = |jar: &str| inst_at(Path::new("/x"), json!({ "jar": jar }));
    assert_eq!(mc_version_of(&i("paper-26.2-121.jar")).as_deref(), Some("26.2"));
    assert_eq!(
        mc_version_of(&i("purpur-1.21.4-2140.jar")).as_deref(),
        Some("1.21.4")
    );
    assert_eq!(mc_version_of(&i("custom-build.jar")), None);
}

#[test]
fn enabled_and_disabled_jars_are_listed_other_files_are_not() {
    let d = scratch("list");
    write_jar(&d.join("plugins"), "Alpha.jar", "name: Alpha\nversion: 1.0\n");
    write_jar(
        &d.join("plugins"),
        "Beta.jar.disabled",
        "name: Beta\nversion: 2.0\n",
    );
    std::fs::write(d.join("plugins/notes.txt"), "not a plugin").unwrap();
    let rows = list_plugins(&inst_at(&d, json!({}))).unwrap();
    let brief: Vec<_> = rows
        .iter()
        .map(|r| (r["name"].clone(), r["enabled"].clone(), r["version"].clone()))
        .collect();
    assert_eq!(
        brief,
        vec![
            (json!("Alpha"), json!(true), json!("1.0")),
            (json!("Beta"), json!(false), json!("2.0"))
        ]
    );
}

#[test]
fn a_jar_with_no_readable_manifest_is_still_listed_by_filename() {
    let d = scratch("mystery");
    std::fs::write(d.join("plugins/Mystery.jar"), "not a zip").unwrap();
    let rows = list_plugins(&inst_at(&d, json!({}))).unwrap();
    assert_eq!(rows[0]["name"], "Mystery");
    assert_eq!(rows[0]["version"], Value::Null);
}

#[test]
fn disable_renames_in_place_and_enable_renames_it_back() {
    let d = scratch("toggle");
    write_jar(&d.join("plugins"), "Alpha.jar", "name: Alpha\n");
    let inst = inst_at(&d, json!({}));
    let root = d.to_string_lossy().to_string();
    let by = Actor::new("cli", None);
    let off = set_plugin_enabled(&root, &by, &inst, "Alpha.jar", false).unwrap();
    assert_eq!(off.file, "Alpha.jar.disabled");
    assert!(d.join("plugins/Alpha.jar.disabled").exists());
    let on = set_plugin_enabled(&root, &by, &inst, "Alpha.jar.disabled", true).unwrap();
    assert_eq!(on.file, "Alpha.jar");
    assert!(d.join("plugins/Alpha.jar").exists());
}

#[test]
fn a_hand_dropped_jar_is_not_managed_one_spawnloft_recorded_is() {
    let d = scratch("managed");
    write_jar(&d.join("plugins"), "Premium.jar", "name: Premium\n");
    write_jar(&d.join("plugins"), "FromModrinth.jar", "name: FromModrinth\n");
    let inst = inst_at(&d, json!({}));
    record_managed(
        &inst,
        "FromModrinth.jar",
        json!({"source": "modrinth", "project": "abc", "version": "1.0"}),
    )
    .unwrap();
    let rows = list_plugins(&inst).unwrap();
    assert_eq!(names(&rows), ["FromModrinth", "Premium"]);
    assert_eq!(rows[0]["managed"], true);
    assert_eq!(rows[1]["managed"], false);
    assert_eq!(rows[0]["source"], "modrinth");
}

#[test]
fn the_provenance_record_follows_a_rename_and_dies_with_a_delete() {
    let d = scratch("provenance");
    write_jar(&d.join("plugins"), "Tracked.jar", "name: Tracked\n");
    let inst = inst_at(&d, json!({}));
    let root = d.to_string_lossy().to_string();
    let by = Actor::new("cli", None);
    record_managed(
        &inst,
        "Tracked.jar",
        json!({"source": "modrinth", "project": "abc"}),
    )
    .unwrap();
    let keys = |inst: &Instance| -> Vec<String> {
        read_managed(inst).unwrap()["managed"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    set_plugin_enabled(&root, &by, &inst, "Tracked.jar", false).unwrap();
    assert_eq!(keys(&inst), ["Tracked.jar.disabled"]);
    set_plugin_enabled(&root, &by, &inst, "Tracked.jar.disabled", true).unwrap();
    assert_eq!(keys(&inst), ["Tracked.jar"]);
    remove_plugin(&root, &by, &inst, "Tracked.jar").unwrap();
    assert_eq!(read_managed(&inst).unwrap()["managed"], json!({}));
}

#[test]
fn the_provenance_file_itself_never_shows_up_as_a_plugin() {
    let d = scratch("store");
    write_jar(&d.join("plugins"), "Alpha.jar", "name: Alpha\n");
    let inst = inst_at(&d, json!({}));
    record_managed(&inst, "Alpha.jar", json!({"source": "modrinth"})).unwrap();
    assert_eq!(names(&list_plugins(&inst).unwrap()), ["Alpha"]);
}

#[test]
fn a_path_that_walks_out_of_the_plugins_folder_is_refused() {
    let d = scratch("refuse");
    let inst = inst_at(&d, json!({}));
    let root = d.to_string_lossy().to_string();
    for bad in [
        "../server.jar",
        "a/b.jar",
        "x.jar.disabled.disabled",
        "plain.txt",
        ".jar",
        "a\\b.jar",
    ] {
        let e = remove_plugin(&root, &Actor::new("cli", None), &inst, bad).unwrap_err();
        assert!(matches!(e, Failure::User { .. }), "accepted {bad}");
    }
}

#[test]
fn mods_are_read_from_fabric_and_neoforge_manifests() {
    let d = scratch("mods");
    std::fs::create_dir_all(d.join("mods")).unwrap();
    let fabric = json!({"id": "cloth-config", "name": "Cloth Config v15", "version": "15.0",
        "authors": ["shedaniel", {"name": "Other"}, {"name": ""}, 5], "contact": {"homepage": "https://x"}});
    std::fs::write(
        d.join("mods/cloth.jar"),
        build_zip(&[("fabric.mod.json", fabric.to_string().as_bytes())], true),
    )
    .unwrap();
    std::fs::write(
        d.join("mods/neo.jar"),
        build_zip(
            &[
                ("META-INF/MANIFEST.MF", b"Implementation-Version: 9.9\n"),
                (
                    "META-INF/neoforge.mods.toml",
                    b"[[mods]]\nmodId=\"neo\"\nversion=\"${file.jarVersion}\"\n",
                ),
            ],
            false,
        ),
    )
    .unwrap();
    // `null` as the whole manifest throws in Node, so the jar is listed by file name
    std::fs::write(
        d.join("mods/nul.jar"),
        build_zip(&[("fabric.mod.json", b"null")], false),
    )
    .unwrap();
    let inst = inst_at(&d, json!({ "loader": "fabric" }));
    let rows = list_plugins(&inst).unwrap();
    assert_eq!(names(&rows), ["Cloth Config v15", "neo", "nul"]);
    assert_eq!(rows[0]["modId"], "cloth-config");
    assert_eq!(rows[0]["authors"], json!(["shedaniel", "Other"]));
    assert_eq!(rows[0]["website"], "https://x");
    assert_eq!(rows[1]["version"], "9.9");
    assert_eq!(rows[2]["modId"], Value::Null);
}

#[test]
fn a_name_that_is_not_text_fails_the_sort_as_javascript_does() {
    let d = scratch("sort");
    std::fs::create_dir_all(d.join("mods")).unwrap();
    std::fs::write(
        d.join("mods/a.jar"),
        build_zip(&[("fabric.mod.json", b"{\"name\": 5}")], false),
    )
    .unwrap();
    let inst = inst_at(&d, json!({ "loader": "fabric" }));
    // alone it is never compared
    assert_eq!(list_plugins(&inst).unwrap()[0]["name"], 5);
    // second in the folder it is the comparator's `a` (V8 asks compare(items[1], items[0]))
    std::fs::write(
        d.join("mods/0.jar"),
        build_zip(&[("fabric.mod.json", b"{\"name\": \"Z\"}")], false),
    )
    .unwrap();
    let e = list_plugins(&inst).unwrap_err();
    assert_eq!(e.message(), "a.name.localeCompare is not a function");
}

#[test]
fn the_sort_is_stable_and_case_blind() {
    let mut v = vec!["b", "A", "a", "B", "c", "a"];
    js_sort(&mut v, |a, b| Ok(collate::compare_base(a, b))).unwrap();
    assert_eq!(v, ["A", "a", "a", "b", "B", "c"]);
    let mut desc: Vec<u32> = (0..100).rev().collect();
    js_sort(&mut desc, |a, b| Ok(a.cmp(b))).unwrap();
    assert_eq!(desc, (0..100).collect::<Vec<_>>());
}

#[test]
fn a_managed_list_that_is_an_array_is_kept_and_holds_nothing() {
    let d = scratch("array");
    write_jar(&d.join("plugins"), "A.jar", "name: A\n");
    std::fs::write(d.join("plugins").join(STORE), "{\"managed\": [1], \"x\": 2}").unwrap();
    let inst = inst_at(&d, json!({}));
    assert_eq!(list_plugins(&inst).unwrap()[0]["managed"], false);
    record_managed(&inst, "A.jar", json!({})).unwrap();
    let text = std::fs::read_to_string(d.join("plugins").join(STORE)).unwrap();
    assert_eq!(text, "{\n  \"managed\": [\n    1\n  ],\n  \"x\": 2\n}\n");
}

#[test]
fn the_content_kind_follows_the_software() {
    let k = |loader: Value| content_kind_for(&inst_at(Path::new("/x"), json!({ "loader": loader })));
    assert_eq!(k(json!("fabric")).dir, "mods");
    assert_eq!(k(json!("vanilla")).kind, "none");
    assert!(k(json!("purpur")).hangar);
    assert!(!k(json!("folia")).hangar);
    // a loader that is not text is Paper, as Map.get never matches it
    assert_eq!(k(json!(["fabric"])).dir, "plugins");
    assert_eq!(
        loaders_for(&inst_at(Path::new("/x"), json!({ "loader": "vanilla" }))),
        LOADERS
    );
}
