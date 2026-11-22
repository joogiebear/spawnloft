//! test/mrpack.test.mjs and the modpack cases of test/modpack-hardening.test.mjs, one to one
//! (the hardening file's tar, backup and dump cases are C3's, in backup.rs and services.rs).

use super::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const SHA1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CDN: &str = "https://cdn.modrinth.com/data/AANobbMI/versions/abc";

fn sha512_a() -> String {
    "b".repeat(128)
}

fn index() -> Value {
    json!({
        "formatVersion": 1, "game": "minecraft", "versionId": "1.2.0", "name": "Example Pack",
        "dependencies": { "minecraft": "26.2", "fabric-loader": "0.19.3" },
        "files": [
            { "path": "mods/lithium.jar", "hashes": { "sha1": SHA1, "sha512": sha512_a() }, "downloads": [format!("{CDN}/lith.jar")], "fileSize": 10 },
            // client-only, so never fetched: its host and hashes are not held to the policy
            { "path": "mods/clientshader.jar", "env": { "server": "unsupported" }, "hashes": {}, "downloads": ["http://example.invalid/x.jar"] },
            { "path": "config/lithium.properties", "hashes": { "sha1": SHA1 }, "downloads": [format!("{CDN}/c.prop")] },
        ],
    })
}

/// INDEX with its one server file replaced, so a test changes exactly one thing.
fn with_file(over: Value) -> Value {
    let mut f =
        json!({ "path": "mods/x.jar", "hashes": { "sha1": SHA1 }, "downloads": [format!("{CDN}/x.jar")] });
    for (k, v) in over.as_object().unwrap() {
        if v.is_null() {
            f.as_object_mut().unwrap().remove(k);
        } else {
            f[k] = v.clone();
        }
    }
    let mut i = index();
    i["files"] = json!([f]);
    i
}

fn with_deps(deps: Value) -> Value {
    let mut i = index();
    i["dependencies"] = deps;
    i
}

fn err(v: &Value) -> String {
    parse_index(v).unwrap_err().message().to_string()
}

#[test]
fn a_fabric_pack_index_reduces_to_what_the_install_needs() {
    let out = parse_index(&index()).unwrap();
    assert_eq!(out.name, "Example Pack");
    assert_eq!(out.mc, "26.2");
    assert_eq!(
        out.loader.to_json(),
        json!({"kind": "fabric", "version": "0.19.3"})
    );
    let paths: Vec<_> = out.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["mods/lithium.jar", "config/lithium.properties"]);
    assert_eq!(out.skipped, 1, "the client-only file is skipped and counted");
}

#[test]
fn a_neoforge_pack_is_a_first_class_citizen_now() {
    let neo = with_deps(json!({"minecraft": "26.2", "neoforge": "26.2.0.75"}));
    assert_eq!(
        parse_index(&neo).unwrap().loader.to_json(),
        json!({"kind": "neoforge", "version": "26.2.0.75"})
    );
}

#[test]
fn a_pack_for_a_loader_spawnloft_cannot_run_is_refused_by_name() {
    let forge = err(&with_deps(json!({"minecraft": "26.2", "forge": "52.0.1"})));
    assert!(
        forge.contains("forge") && forge.contains("Fabric and NeoForge packs only"),
        "{forge}"
    );
    assert!(
        err(&with_deps(json!({"minecraft": "26.2", "quilt-loader": "0.26.0"}))).contains("built for quilt,")
    );
}

#[test]
fn a_pack_with_no_loader_no_minecraft_version_or_the_wrong_shape_is_refused() {
    for v in [
        json!({"game": "minecraft", "files": [], "dependencies": {}}),
        json!({"game": "terraria", "files": []}),
        with_deps(json!({"minecraft": "26.2"})),
        json!(null),
        json!({"game": "minecraft", "files": {}}),
    ] {
        assert!(matches!(parse_index(&v), Err(Failure::User { .. })), "{v}");
    }
}

#[test]
fn a_pack_file_path_that_escapes_the_instance_folder_poisons_the_whole_pack() {
    for bad in [
        "../outside.jar",
        "/absolute.jar",
        "C:/windows/system32/evil.jar",
        "mods/../../up.jar",
    ] {
        assert!(
            err(&with_file(json!({"path": bad}))).contains("outside its own folder"),
            "{bad}"
        );
    }
}

#[test]
fn a_parsed_file_carries_its_checksums_its_size_and_the_one_download_it_may_use() {
    let files = parse_index(&index()).unwrap().files;
    assert_eq!(
        files[0],
        PackFile {
            path: "mods/lithium.jar".into(),
            sha1: Some(SHA1.into()),
            sha512: Some(sha512_a()),
            url: format!("{CDN}/lith.jar"),
            size: 10.0
        }
    );
    assert_eq!(
        files[1],
        PackFile {
            path: "config/lithium.properties".into(),
            sha1: Some(SHA1.into()),
            sha512: None,
            url: format!("{CDN}/c.prop"),
            size: 0.0
        }
    );
}

#[test]
fn a_loader_or_game_version_that_is_not_version_shaped_refuses_the_whole_pack() {
    let long = "x".repeat(65);
    for bad in [
        "1/../x",
        "../../etc",
        "0.19.3/../x",
        "a b",
        "0.19.3?x=1",
        "..",
        "",
        long.as_str(),
    ] {
        for deps in [
            json!({"minecraft": "26.2", "fabric-loader": bad}),
            json!({"minecraft": "26.2", "neoforge": bad}),
            json!({"minecraft": bad, "fabric-loader": "0.19.3"}),
        ] {
            assert!(
                matches!(parse_index(&with_deps(deps.clone())), Err(Failure::User { .. })),
                "{deps}"
            );
        }
    }
}

#[test]
fn the_version_shapes_real_loaders_use_are_accepted() {
    for v in [
        "0.19.3",
        "0.16.10",
        "21.1.172",
        "26.2.0.75",
        "21.1.0-beta",
        "1.21.1+build.3",
    ] {
        let i = with_deps(json!({"minecraft": "26.2", "fabric-loader": v}));
        assert_eq!(parse_index(&i).unwrap().loader.version, v);
    }
    for mc in ["1.21.1", "26.2", "24w14a", "1.21-pre1"] {
        let i = with_deps(json!({"minecraft": mc, "fabric-loader": "0.19.3"}));
        assert_eq!(parse_index(&i).unwrap().mc, mc);
    }
}

#[test]
fn a_download_must_be_https_from_a_host_the_pack_format_allows() {
    for host in ALLOWED_PACK_HOSTS {
        assert!(
            allowed_pack_url(&json!(format!("https://{host}/some/file.jar"))).is_some(),
            "{host}"
        );
    }
    for bad in [
        "http://cdn.modrinth.com/x.jar",
        "https://example.com/x.jar",
        "https://cdn.modrinth.com.evil.test/x.jar",
        "https://evil.test/cdn.modrinth.com/x.jar",
        "https://cdn.modrinth.com@evil.test/x.jar",
        "https://user:pass@cdn.modrinth.com/x.jar",
        "https://cdn.modrinth.com:8443/x.jar",
        "https://localhost/x.jar",
        "https://127.0.0.1/x.jar",
        "https://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "ftp://cdn.modrinth.com/x.jar",
        "not a url",
        "",
    ] {
        assert_eq!(allowed_pack_url(&json!(bad)), None, "allowed {bad}");
    }
    // normalised as the WHATWG parser does
    assert_eq!(
        allowed_pack_url(&json!("https://CDN.Modrinth.com:443/a/../b c")).as_deref(),
        Some("https://cdn.modrinth.com/b%20c")
    );
}

#[test]
fn a_file_offered_only_from_a_host_a_pack_may_not_use_refuses_the_whole_pack() {
    for url in [
        "http://cdn.modrinth.com/x.jar",
        "https://example.com/x.jar",
        "https://127.0.0.1:25565/x.jar",
        "http://localhost/x",
    ] {
        assert!(
            err(&with_file(json!({"downloads": [url]}))).contains("host a pack may not use"),
            "{url}"
        );
    }
}

#[test]
fn the_first_allowed_download_is_the_one_used_whichever_position_it_is_in() {
    let out = parse_index(&with_file(json!({"downloads": ["https://example.com/x.jar", "http://cdn.modrinth.com/x.jar", format!("{CDN}/ok.jar")]}))).unwrap();
    assert_eq!(out.files[0].url, format!("{CDN}/ok.jar"));
}

#[test]
fn a_file_with_no_checksum_or_a_malformed_one_refuses_the_whole_pack() {
    assert!(err(&with_file(json!({"hashes": {}}))).contains("no checksum"));
    assert!(err(&with_file(json!({"hashes": null}))).contains("no checksum"));
    for h in [
        json!({"sha1": ""}),
        json!({"sha1": "zz".repeat(20)}),
        json!({"sha1": SHA1, "sha512": "short"}),
        json!({"sha512": 123}),
    ] {
        assert!(
            err(&with_file(json!({"hashes": h}))).contains("not a checksum"),
            "{h}"
        );
    }
}

#[test]
fn either_checksum_on_its_own_is_enough_and_uppercase_hex_is_normalised() {
    assert_eq!(
        parse_index(&with_file(json!({"hashes": {"sha512": sha512_a()}})))
            .unwrap()
            .files[0]
            .sha1,
        None
    );
    assert_eq!(
        parse_index(&with_file(json!({"hashes": {"sha1": SHA1.to_uppercase()}})))
            .unwrap()
            .files[0]
            .sha1
            .as_deref(),
        Some(SHA1)
    );
}

#[test]
fn a_file_with_no_download_or_an_impossible_size_refuses_the_whole_pack() {
    assert!(err(&with_file(json!({"downloads": []}))).contains("no download"));
    assert!(err(&with_file(json!({"downloads": null}))).contains("no download"));
    for size in [json!(-1), json!(1.5), json!("10"), json!(9007199254740993.0_f64)] {
        assert!(
            err(&with_file(json!({"fileSize": size}))).contains("impossible size"),
            "{size}"
        );
    }
}

#[test]
fn a_pack_path_is_normalised_and_an_empty_or_nul_one_is_refused() {
    assert_eq!(
        parse_index(&with_file(json!({"path": "mods//a.jar"})))
            .unwrap()
            .files[0]
            .path,
        "mods/a.jar"
    );
    assert_eq!(
        parse_index(&with_file(json!({"path": "./mods/a.jar"})))
            .unwrap()
            .files[0]
            .path,
        "mods/a.jar"
    );
    for bad in ["", ".", "./", "mods/\0a.jar"] {
        assert!(
            err(&with_file(json!({"path": bad}))).contains("outside its own folder"),
            "{bad:?}"
        );
    }
}

fn strs(v: &[&str]) -> Vec<Value> {
    v.iter().map(|s| json!(s)).collect()
}

#[test]
fn an_update_deletes_only_what_the_old_pack_owned_and_the_new_one_dropped() {
    let old = strs(&["mods/a-1.0.jar", "mods/b-1.0.jar", "config/a.toml"]);
    let now = strs(&["mods/a-2.0.jar", "mods/b-1.0.jar", "config/a.toml"]);
    assert_eq!(plan_removals(&old, &now, &[]), ["mods/a-1.0.jar"]);
}

#[test]
fn what_the_person_added_is_never_a_removal_candidate_because_it_was_never_owned() {
    assert_eq!(
        plan_removals(&strs(&["mods/pack-mod.jar"]), &[], &[]),
        ["mods/pack-mod.jar"]
    );
}

#[test]
fn protected_paths_survive_even_a_confused_record() {
    let old = strs(&[
        "world/level.dat",
        "world_nether/level.dat",
        "server.properties",
        "mods/old.jar",
        "eula.txt",
    ]);
    let protect: Vec<String> = ["world", "world_nether", "server.properties", "eula.txt"]
        .map(String::from)
        .to_vec();
    assert_eq!(plan_removals(&old, &[], &protect), ["mods/old.jar"]);
}

#[test]
fn a_protected_prefix_guards_the_directory_not_every_name_that_starts_with_it() {
    let r = plan_removals(
        &strs(&["worldedit/config.yml", "world/level.dat"]),
        &[],
        &["world".into()],
    );
    assert_eq!(r, ["worldedit/config.yml"]);
}

#[test]
fn path_tricks_in_a_record_never_become_deletions() {
    let old = strs(&[
        "../outside.jar",
        "/absolute.jar",
        "mods/../../up.jar",
        "mods\\windows-style.jar",
    ]);
    assert_eq!(plan_removals(&old, &[], &[]), ["mods/windows-style.jar"]);
}

fn scratch(tag: &str) -> std::path::PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!(
        "sl-mrpack-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn overrides_extract_with_their_prefix_stripped_and_everything_else_left_behind() {
    let dir = scratch("over");
    let file = dir.join("pack.mrpack");
    let zip = crate::plugins::tests::build_zip(
        &[
            ("modrinth.index.json", b"{}"),
            ("overrides/config/mod.toml", b"setting = true"),
            ("overrides/mods/", b""),
            ("server-overrides/server-only.txt", b"server"),
        ],
        false,
    );
    std::fs::write(&file, zip).unwrap();
    let dest = dir.join("out");
    let laid = lay_overrides(&file.to_string_lossy(), &dest.to_string_lossy()).unwrap();
    assert_eq!(laid, ["config/mod.toml", "server-only.txt"]);
    assert_eq!(
        std::fs::read_to_string(dest.join("config/mod.toml")).unwrap(),
        "setting = true"
    );
    assert!(
        !dest.join("modrinth.index.json").exists(),
        "the index is not an override"
    );
}

#[test]
fn a_zip_entry_that_tries_to_climb_out_of_the_destination_stops_the_extraction() {
    let dir = scratch("climb");
    let file = dir.join("evil.zip");
    std::fs::write(
        &file,
        crate::plugins::tests::build_zip(&[("../escape.txt", b"gotcha")], false),
    )
    .unwrap();
    let dest = dir.join("out");
    std::fs::create_dir_all(&dest).unwrap();
    let e = crate::zip::jar::extract(&file, &dest, |n| Some(n.to_string())).unwrap_err();
    assert!(e.message().contains("outside its folder"), "{}", e.message());
    assert!(
        !dir.join("escape.txt").exists(),
        "nothing was written outside dest"
    );
}

// ---------------------------------------------------------------------------------------------
// modpack-hardening.test.mjs: what a modpack may make this program do

const URL_OK: &str = "https://cdn.modrinth.com/data/x/versions/y/file.jar";

fn sha(kind: crate::download::Hash, data: &[u8]) -> String {
    let mut h = crate::download::Hasher::new(kind);
    h.update(data);
    h.hex()
}
fn sha1(d: &[u8]) -> String {
    sha(crate::download::Hash::Sha1, d)
}
fn sha512(d: &[u8]) -> String {
    sha(crate::download::Hash::Sha512, d)
}

enum Answer {
    Reply {
        status: u16,
        location: Option<String>,
        length: Option<String>,
        body: Box<dyn Read + Send>,
    },
    Fail(Lost),
}

fn reply(body: &[u8]) -> Answer {
    Answer::Reply {
        status: 200,
        location: None,
        length: None,
        body: Box::new(std::io::Cursor::new(body.to_vec())),
    }
}
fn status(code: u16) -> Answer {
    Answer::Reply {
        status: code,
        location: None,
        length: None,
        body: Box::new(std::io::empty()),
    }
}
fn redirect(to: &str) -> Answer {
    Answer::Reply {
        status: 302,
        location: Some(to.into()),
        length: None,
        body: Box::new(std::io::empty()),
    }
}

/// A body that never ends, counting how often it was read.
struct Endless(Arc<AtomicUsize>);
impl Read for Endless {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let n = buf.len().min(64 * 1024);
        buf[..n].fill(0);
        Ok(n)
    }
}

/// `scripted(...answers)`: each request takes the next answer; the URLs and whether they were
/// asked for by hand-followed redirects are recorded.
struct Scripted {
    answers: std::collections::VecDeque<Answer>,
    calls: Vec<(String, bool, String)>,
}

impl Scripted {
    fn new(answers: Vec<Answer>) -> Scripted {
        Scripted {
            answers: answers.into(),
            calls: Vec::new(),
        }
    }
    fn fetch(&mut self) -> impl FnMut(&Request<'_>) -> Result<Reply, Lost> + '_ {
        move |req| {
            self.calls.push((
                req.url.to_string(),
                req.manual_redirects,
                req.user_agent.to_string(),
            ));
            match self.answers.pop_front() {
                None => panic!("unexpected request for {}", req.url),
                Some(Answer::Fail(l)) => Err(l),
                Some(Answer::Reply {
                    status,
                    location,
                    length,
                    body,
                }) => Ok(Reply {
                    status,
                    location,
                    content_length: length,
                    body,
                }),
            }
        }
    }
}

fn get(url: &str, dest: &Path, o: Verify<'_>, s: &mut Scripted) -> Result<u64, Failure> {
    download_verified(url, dest, &o, &mut s.fetch())
}

fn listing(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn a_download_that_matches_its_size_and_checksums_lands_under_its_name_with_no_part_left() {
    let data = b"a mod, more or less";
    let dest = scratch("ok").join("file");
    let mut s = Scripted::new(vec![reply(data)]);
    let (s1, s5) = (sha1(data), sha512(data));
    let got = get(
        URL_OK,
        &dest,
        Verify {
            size: data.len() as f64,
            sha1: Some(&s1),
            sha512: Some(&s5),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap();
    assert_eq!(got, data.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert!(!dest.with_file_name("file.part").exists());
    assert!(s.calls[0].1, "redirects are followed by hand, not by fetch");
    assert_eq!(s.calls[0].2, "node", "a download names no user agent of its own");
}

#[test]
fn a_checksum_that_does_not_match_leaves_nothing_under_the_name_or_beside_it() {
    let data = b"tampered";
    let dir = scratch("badsum");
    let dest = dir.join("file");
    let (good1, bad1, bad5) = (sha1(data), sha1(b"other"), sha512(b"other"));
    for (a, b) in [
        (Some(bad1.as_str()), None),
        (None, Some(bad5.as_str())),
        (Some(good1.as_str()), Some(bad5.as_str())),
    ] {
        let mut s = Scripted::new(vec![reply(data)]);
        let e = get(
            URL_OK,
            &dest,
            Verify {
                size: data.len() as f64,
                label: "mods/x.jar",
                sha1: a,
                sha512: b,
                ..Verify::default()
            },
            &mut s,
        )
        .unwrap_err();
        assert!(
            e.message().contains("mods/x.jar\" did not match the checksum"),
            "{}",
            e.message()
        );
    }
    assert!(listing(&dir).is_empty());
}

#[test]
fn every_checksum_the_pack_published_is_checked_not_just_the_first() {
    let data = b"x";
    let (s1, zeros) = (sha1(data), "0".repeat(128));
    let mut s = Scripted::new(vec![reply(data)]);
    let e = get(
        URL_OK,
        &scratch("both").join("f"),
        Verify {
            sha1: Some(&s1),
            sha512: Some(&zeros),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(e.message().contains("did not match"));
}

#[test]
fn a_file_that_is_not_the_size_the_pack_declared_is_refused_short_or_long() {
    let dir = scratch("size");
    for (declared, body) in [(10.0, &b"short"[..]), (3.0, &b"longer than that"[..])] {
        let s1 = sha1(body);
        let mut s = Scripted::new(vec![reply(body)]);
        let e = get(
            URL_OK,
            &dir.join("f"),
            Verify {
                size: declared,
                sha1: Some(&s1),
                ..Verify::default()
            },
            &mut s,
        )
        .unwrap_err();
        assert!(
            e.message().contains("larger than") || e.message().contains("not the size"),
            "{}",
            e.message()
        );
    }
    assert!(listing(&dir).is_empty());
}

#[test]
fn a_download_that_never_ends_is_cut_off_at_the_declared_size_and_its_body_is_let_go() {
    let dir = scratch("endless");
    let pulled = Arc::new(AtomicUsize::new(0));
    let body = Endless(pulled.clone());
    let mut s = Scripted::new(vec![Answer::Reply {
        status: 200,
        location: None,
        length: None,
        body: Box::new(body),
    }]);
    let a40 = "a".repeat(40);
    let e = get(
        URL_OK,
        &dir.join("f"),
        Verify {
            size: 100.0 * 1024.0,
            sha1: Some(&a40),
            label: "mods/loop.jar",
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(
        e.message()
            .contains("mods/loop.jar\" is larger than the 100.0 KB"),
        "{}",
        e.message()
    );
    assert!(pulled.load(Ordering::SeqCst) < 20, "kept reading");
    assert!(listing(&dir).is_empty(), "no partial file kept");
}

#[test]
fn with_no_declared_size_the_default_cap_still_applies() {
    let pulled = Arc::new(AtomicUsize::new(0));
    let mut s = Scripted::new(vec![Answer::Reply {
        status: 200,
        location: None,
        length: None,
        body: Box::new(Endless(pulled.clone())),
    }]);
    let a40 = "a".repeat(40);
    let e = get(
        URL_OK,
        &scratch("nosize").join("f"),
        Verify {
            sha1: Some(&a40),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(
        e.message().contains("is larger than the 256.0 MB"),
        "{}",
        e.message()
    );
    assert!(pulled.load(Ordering::SeqCst) as u64 >= DEFAULT_PACK_FILE_BYTES / (64 * 1024));
}

#[test]
fn a_length_announced_up_front_over_the_cap_is_refused_and_the_body_is_let_go_unread() {
    let dir = scratch("announced");
    let pulled = Arc::new(AtomicUsize::new(0));
    let mut s = Scripted::new(vec![Answer::Reply {
        status: 200,
        location: None,
        length: Some("999999".into()),
        body: Box::new(Endless(pulled.clone())),
    }]);
    let a40 = "a".repeat(40);
    let e = get(
        URL_OK,
        &dir.join("f"),
        Verify {
            size: 1000.0,
            sha1: Some(&a40),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(e.message().contains("is larger than"));
    assert_eq!(pulled.load(Ordering::SeqCst), 0);
    assert!(listing(&dir).is_empty(), "nothing was written");
}

#[test]
fn a_declared_size_past_the_hard_limit_is_refused_before_any_request() {
    let mut s = Scripted::new(vec![]);
    let a40 = "a".repeat(40);
    let e = get(
        URL_OK,
        &scratch("huge").join("f"),
        Verify {
            size: MAX_PACK_FILE_BYTES as f64 + 1.0,
            sha1: Some(&a40),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(e.message().contains("more than the 1.0 GB"), "{}", e.message());
    assert!(s.calls.is_empty());
}

#[test]
fn redirects_are_followed_to_another_https_host_as_a_cdn_needs() {
    let data = b"from the asset host";
    let mut s = Scripted::new(vec![
        redirect("https://release-assets.githubusercontent.com/abc"),
        redirect("/relative/path"),
        reply(data),
    ]);
    let dest = scratch("hop").join("f");
    let s1 = sha1(data);
    get(
        "https://github.com/o/r/releases/download/v/f.jar",
        &dest,
        Verify {
            sha1: Some(&s1),
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap();
    let urls: Vec<_> = s.calls.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(
        urls,
        [
            "https://github.com/o/r/releases/download/v/f.jar",
            "https://release-assets.githubusercontent.com/abc",
            "https://release-assets.githubusercontent.com/relative/path"
        ]
    );
    assert_eq!(std::fs::read(&dest).unwrap(), data);
}

#[test]
fn a_redirect_to_anything_but_https_on_the_internet_is_refused_and_never_requested() {
    for to in [
        "http://cdn.modrinth.com/x.jar",
        "https://localhost/x",
        "https://127.0.0.1:8080/admin",
        "https://10.0.0.5/x",
        "https://192.168.1.1/x",
        "https://172.16.0.1/x",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/x",
        "https://[::ffff:127.0.0.1]/x",
        "https://user:pass@cdn.modrinth.com/x",
        "file:///etc/passwd",
    ] {
        let mut s = Scripted::new(vec![redirect(to), reply(b"never asked for")]);
        let a40 = "a".repeat(40);
        let e = get(
            URL_OK,
            &scratch("redir").join("f"),
            Verify {
                sha1: Some(&a40),
                ..Verify::default()
            },
            &mut s,
        )
        .unwrap_err();
        assert!(
            e.message().contains("refused") || e.message().contains("is not a URL"),
            "{to}: {}",
            e.message()
        );
        assert_eq!(s.calls.len(), 1, "{to} was requested");
    }
}

#[test]
fn a_redirect_loop_is_given_up_on() {
    let mut s = Scripted::new((0..10).map(|_| redirect(URL_OK)).collect());
    let a40 = "a".repeat(40);
    let e = get(
        URL_OK,
        &scratch("loop").join("f"),
        Verify {
            sha1: Some(&a40),
            max_redirects: 3,
            ..Verify::default()
        },
        &mut s,
    )
    .unwrap_err();
    assert!(e.message().contains("too many redirects"));
    assert_eq!(s.calls.len(), 4);
}

#[test]
fn the_first_address_is_held_to_https_on_the_internet_too() {
    let mut s = Scripted::new(vec![]);
    for bad in [
        "http://cdn.modrinth.com/x.jar",
        "https://localhost/x",
        "ftp://x/y",
    ] {
        let a40 = "a".repeat(40);
        let e = get(
            bad,
            &scratch("first").join("f"),
            Verify {
                sha1: Some(&a40),
                ..Verify::default()
            },
            &mut s,
        )
        .unwrap_err();
        assert!(matches!(e, Failure::User { .. }));
    }
    assert!(s.calls.is_empty());
}

#[test]
fn an_error_status_and_a_transport_failure_are_readable_refusals_that_leave_nothing_behind() {
    let dir = scratch("errs");
    let mut s = Scripted::new(vec![status(404)]);
    let e = get(URL_OK, &dir.join("f"), Verify::default(), &mut s).unwrap_err();
    assert!(e.message().starts_with("download failed: 404"), "{}", e.message());
    let mut s = Scripted::new(vec![Answer::Fail(Lost::Failed("socket hang up".into()))]);
    let e = get(URL_OK, &dir.join("f"), Verify::default(), &mut s).unwrap_err();
    assert!(
        e.message().starts_with("download failed: socket hang up"),
        "{}",
        e.message()
    );
    assert!(listing(&dir).is_empty());
}

fn pack_of_files(files: &[(&str, &[u8])]) -> Index {
    let files: Vec<Value> = files
        .iter()
        .map(|(p, data)| {
            json!({
                "path": p, "hashes": { "sha1": sha1(data), "sha512": sha512(data) },
                "downloads": [format!("https://cdn.modrinth.com/data/{}", crate::sources::encode_uri_component(p))],
                "fileSize": data.len(),
            })
        })
        .collect();
    parse_index(&json!({ "game": "minecraft", "name": "Staged", "dependencies": { "minecraft": "1.21.1", "fabric-loader": "0.16.9" }, "files": files })).unwrap()
}

#[test]
fn a_pack_is_staged_to_files_on_disk_each_verified_ready_to_be_copied_into_place() {
    let tmp = scratch("stage");
    let index = pack_of_files(&[("mods/a.jar", b"alpha"), ("config/b.toml", b"bravo = 1")]);
    let mut s = Scripted::new(vec![reply(b"alpha"), reply(b"bravo = 1")]);
    let mut progress = Vec::new();
    let staged = stage_pack_files(
        &index,
        &tmp.to_string_lossy(),
        &mut |m| progress.push(m.to_string()),
        &mut s.fetch(),
    )
    .unwrap();
    let paths: Vec<_> = staged.iter().map(|f| f.file.path.as_str()).collect();
    assert_eq!(paths, ["mods/a.jar", "config/b.toml"]);
    let bodies: Vec<_> = staged
        .iter()
        .map(|f| std::fs::read_to_string(&f.at).unwrap())
        .collect();
    assert_eq!(bodies, ["alpha", "bravo = 1"]);
    for f in &staged {
        assert!(
            f.at.starts_with(&*tmp.to_string_lossy()),
            "inside the scratch folder the caller removes"
        );
    }
    assert_eq!(listing(&tmp.join("staged")), ["0", "1"], "no .part files left");
    assert_eq!(
        progress,
        ["Downloading a.jar (1 of 2)", "Downloading b.toml (2 of 2)"]
    );
}

#[test]
fn one_bad_file_in_a_pack_stops_the_staging_and_names_the_file() {
    let tmp = scratch("stage-bad");
    let index = pack_of_files(&[("mods/a.jar", b"alpha"), ("mods/b.jar", b"bravo")]);
    // the right length, so only the checksum can catch it
    let mut s = Scripted::new(vec![reply(b"alpha"), reply(b"bravX")]);
    let e = stage_pack_files(&index, &tmp.to_string_lossy(), &mut |_| {}, &mut s.fetch()).unwrap_err();
    assert!(
        e.message().contains("\"mods/b.jar\" did not match the checksum"),
        "{}",
        e.message()
    );
    assert_eq!(s.calls.len(), 2);
}

#[test]
fn a_loader_or_game_version_that_is_not_a_version_is_refused_before_any_request_or_write() {
    // sources.rs refuses these before it asks anything (fabric_fetch, neo_fetch_installer)
    let jars = scratch("jars");
    let j = jars.to_string_lossy().to_string();
    for bad in ["1/../x", "../../escape", "a/b", "..", "x y", "1.0?x=1"] {
        for e in [
            sources::fabric_fetch(&j, "1.21.1", Some(bad), false).unwrap_err(),
            sources::fabric_fetch(&j, bad, Some("0.16.9"), false).unwrap_err(),
            sources::neo_fetch_installer(&j, bad, &mut |_| {}).unwrap_err(),
        ] {
            assert!(
                e.message().contains("not a valid version"),
                "{bad}: {}",
                e.message()
            );
        }
    }
    assert!(listing(&jars).is_empty(), "nothing was written");
}

#[test]
fn local_addresses_are_known_as_javascript_matched_them() {
    for h in [
        "localhost",
        "a.localhost",
        "[::1]",
        "::",
        "::ffff:1.2.3.4",
        "fe80::1",
        "fd12::1",
        "0.1.2.3",
        "10.1.1.1",
        "127.0.0.1",
        "224.0.0.1",
        "169.254.1.1",
        "172.31.0.1",
        "192.168.0.1",
    ] {
        assert!(is_local_host(h), "{h}");
    }
    for h in [
        "cdn.modrinth.com",
        "8.8.8.8",
        "172.32.0.1",
        "fe7f::1",
        "1.2.3",
        "fc0::1",
    ] {
        assert!(!is_local_host(h), "{h}");
    }
}

#[test]
fn a_protected_file_is_guarded_however_the_pack_spells_it() {
    let old = strs(&[
        "./ops.json",
        "overrides/../x",
        "world//level.dat",
        "OPS.JSON",
        "World/region/r.mca",
        "./config/a.toml",
    ]);
    let protect = vec!["world".to_string(), "ops.json".to_string()];
    assert!(plan_removals(&old, &strs(&["config/a.toml"]), &protect).is_empty());
    assert_eq!(
        plan_removals(&strs(&["./mods/x.jar", "mods/x.jar"]), &[], &[]),
        ["mods/x.jar"]
    );
}

#[test]
fn a_record_that_is_null_zero_false_or_empty_is_no_record() {
    let dir = std::env::temp_dir().join(format!("sl-mrpack-falsy-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let inst = crate::registry::spread("r", &json!({ "dir": dir.to_string_lossy() }));
    for text in ["null", "0", "false", "\"\"", "{}"] {
        std::fs::write(dir.join(PACK_FILE), text).unwrap();
        assert_eq!(pack_of(&inst).is_some(), text == "{}", "{text}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_percent_a_progress_message_carries() {
    assert_eq!(percent_of("Downloading sodium.jar (1 of 40)"), Some(0.0));
    assert_eq!(percent_of("Downloading sodium.jar (3 of 40)"), Some(5.0));
    assert_eq!(percent_of("Downloading a (b).jar (40 of 40)"), Some(98.0));
    assert_eq!(percent_of("Downloading pack-1.2.mrpack"), None);
    assert_eq!(percent_of("Downloading x (a of 3)"), None);
    assert_eq!(percent_of("Creating the server"), None);
}
