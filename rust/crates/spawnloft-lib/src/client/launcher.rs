//! What the launcher page asks of `client.mjs` and `client-auth.mjs` that the CLI never did:
//! offline accounts and the default account, a profile renamed or copied, how its last game
//! ended (and that the page showed it), the folder "open folder" means, one Java checked by its
//! path, and one loader's builds for a version.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::paths::Paths;
use super::{accounts, object, prop, profiles};
use crate::failure::Failure;
use crate::js;

fn coded(message: String, code: &str) -> Failure {
    Failure::User {
        message,
        code: Some(code.into()),
    }
}

// ---- accounts --------------------------------------------------------------------------------

/// `a.name.toLowerCase()` for `list.find`, which throws on an entry that is null or has no name.
fn lower_name(a: &Value) -> Result<String, Failure> {
    match accounts::field(a, "name")? {
        Some(Value::String(s)) => Ok(s.to_lowercase()),
        None => Err(Failure::type_error(
            "Cannot read properties of undefined (reading 'toLowerCase')",
        )),
        Some(Value::Null) => Err(Failure::type_error(
            "Cannot read properties of null (reading 'toLowerCase')",
        )),
        Some(_) => Err(Failure::type_error("a.name.toLowerCase is not a function")),
    }
}

/// `addOfflineAccount(name)`: a name, no tokens, the uuid an offline-mode server derives from
/// it. The same name in another case is the entry already there; a Microsoft account of that
/// name is refused. Answers the stored entry.
pub fn add_offline_account(paths: &Paths, name: &str) -> Result<Value, Failure> {
    super::launch::assert_player_name(name)?;
    let account = json!({ "type": "offline", "name": name, "uuid": crate::players::offline_uuid(name) });
    let mut stored = account.clone();
    let wanted = name.to_lowercase();
    accounts::update(paths, "list.find", |list| {
        let mut clash = None;
        for a in &list {
            if lower_name(a)? == wanted {
                clash = Some(a.clone());
                break;
            }
        }
        if let Some(c) = clash {
            if prop(Some(&c), "type") == Some(&json!("microsoft")) {
                return Err(Failure::user(format!(
                    "\"{}\" is a signed-in Microsoft account; play as it instead, or pick another offline name",
                    js::string(prop(Some(&c), "name"))
                )));
            }
            stored = c;
            return Ok(list);
        }
        accounts::upsert(list, account.clone(), None)
    })?;
    Ok(stored)
}

/// `setDefaultAccount(uuid)`: `None` clears it; a uuid must be one in the list, and the list's
/// own spelling of it is kept. Answers the default as saved.
pub fn set_default_account(paths: &Paths, uuid: Option<&str>) -> Result<Value, Failure> {
    let mut doc = profiles::load(paths)?;
    match uuid {
        None => doc.set_default_account(None),
        Some(u) => {
            let list = accounts::load(paths)?;
            let Some(i) = accounts::find(&list, u)? else {
                return Err(Failure::user(format!(
                    "no account with uuid \"{u}\" is in the list; sign in or add an offline account first"
                )));
            };
            let again = accounts::load(paths)?;
            doc.set_default_account(Some(super::or_null(again.get(i).and_then(|a| prop(Some(a), "uuid")))));
        }
    }
    profiles::save(paths, &mut doc)?;
    Ok(super::or_null(doc.default_account()))
}

// ---- how the last game ended -----------------------------------------------------------------

/// `lastExit(name)`: `{ code, signal, startedAt, endedAt, stopped, seen }`, or null when no exit
/// was seen.
pub fn last_exit(paths: &Paths, name: &str) -> Value {
    let Some(rec) = super::state::read_last_exit(paths, name) else {
        return Value::Null;
    };
    let get = |k: &str| prop(Some(&rec), k).cloned();
    object(vec![
        ("code", get("code")),
        ("signal", get("signal")),
        ("startedAt", get("startedAt")),
        ("endedAt", get("endedAt")),
        ("stopped", Some(json!(js::truthy(prop(Some(&rec), "stopped"))))),
        ("seen", Some(json!(js::truthy(prop(Some(&rec), "seen"))))),
    ])
}

/// `markExitSeen(name, endedAt)`: the Play page showed this exit and it was dismissed. `endedAt`
/// names the exit, so a mark that arrives late cannot land on a newer one.
pub fn mark_exit_seen(paths: &Paths, name: &str, ended_at: &str) -> Result<Value, Failure> {
    profiles::get(paths, name)?;
    let Some(mut rec) = super::state::read_last_exit(paths, name) else {
        return Ok(json!({ "seen": false }));
    };
    if prop(Some(&rec), "endedAt") != Some(&json!(ended_at)) {
        return Ok(json!({ "seen": false }));
    }
    if !js::truthy(prop(Some(&rec), "seen")) {
        if let Value::Object(m) = &mut rec {
            m.insert("seen".into(), json!(true));
        }
        super::write_json(&paths.last_exit(name), &rec)?;
    }
    Ok(json!({ "seen": true }))
}

// ---- folders ---------------------------------------------------------------------------------

/// `revealTarget(name, what)`: the profile's folder, or its `logs` or `crash-reports` folder
/// when the game has made it. `what` is matched against that list and never used as a path.
pub fn reveal_target(paths: &Paths, name: &str, what: Option<&Value>) -> Result<(String, bool), Failure> {
    profiles::get(paths, name)?;
    let folder = paths.profile_dir(name);
    crate::fsx::mkdir_all(Path::new(&folder))?;
    let sub = match what {
        Some(Value::String(w)) if w == "logs" || w == "crash-reports" => {
            Some(crate::jspath::join(&[&folder, w]))
        }
        _ => None,
    };
    let target = match &sub {
        Some(s) if Path::new(s).exists() => s.clone(),
        _ => folder.clone(),
    };
    let fell_back = sub.is_some() && target == folder;
    Ok((target, fell_back))
}

// ---- rename and copy -------------------------------------------------------------------------

/// `assertNameFree(reg, name, { except })`: names must differ in more than case.
pub fn assert_name_free(doc: &profiles::Doc, name: &str, except: Option<&str>) -> Result<(), Failure> {
    let lower = name.to_lowercase();
    for existing in doc.names() {
        if Some(existing.as_str()) != except && existing.to_lowercase() == lower {
            return Err(coded(
                format!("a profile named \"{existing}\" already exists (names must differ in more than case)"),
                "name-taken",
            ));
        }
    }
    Ok(())
}

fn left_folder(paths: &Paths, name: &str) -> Failure {
    coded(
        format!(
            "a folder named \"{name}\" is already in the profiles folder (left by a removed profile); pick another name or delete {}",
            paths.profile_dir(name)
        ),
        "name-taken",
    )
}

fn running_refusal(name: &str) -> Failure {
    coded(
        format!("profile \"{name}\" is running; stop it before renaming it"),
        "already-running",
    )
}

/// `moveRunDir(name, newName)`: the log, the last exit and the time played follow a renamed
/// profile; when the folder cannot be moved the records are dropped rather than left for a
/// later profile of the old name.
fn move_run_dir(paths: &Paths, name: &str, new_name: &str, case_only: bool) {
    let from = paths.run_dir(name);
    if !Path::new(&from).exists() {
        return;
    }
    for _ in 0..5 {
        if !case_only && super::rm_tree_retrying(&paths.run_dir(new_name)).is_err() {
            continue;
        }
        if std::fs::rename(&from, paths.run_dir(new_name)).is_ok() {
            return;
        }
    }
    for file in profiles::history_files(paths, name) {
        let _ = super::rm_force(&file);
    }
}

/// `renameProfile(name, newName)`: its entry, its game folder and its run folder move together,
/// not while it runs or is being launched. The folder moves first and back again when the list
/// cannot be saved.
pub fn rename_profile(paths: &Paths, name: &str, new_name: &str) -> Result<profiles::Profile, Failure> {
    profiles::validate_name(new_name)?;
    profiles::get(paths, name)?;
    if new_name == name {
        return profiles::get(paths, name);
    }
    if super::state::status(paths, name)?.running {
        return Err(running_refusal(name));
    }
    let lock_file = paths.launch_lock(name);
    let lock = crate::lock::acquire(Path::new(&lock_file), crate::lock::Options::fail())
        .map_err(|e| profiles::lock_failure(&e))?;
    let Some(lock) = lock else {
        return Err(coded(
            format!(
                "profile \"{name}\" is being launched (pid {}); wait for it",
                profiles::holder_text(paths, name)
            ),
            "launching",
        ));
    };
    let moved = (|| {
        // again under the lock: a launch elsewhere may have started the game and let go since
        if super::state::status(paths, name)?.running {
            return Err(running_refusal(name));
        }
        let mut doc = profiles::load(paths)?;
        assert_name_free(&doc, new_name, Some(name))?;
        let case_only = new_name.to_lowercase() == name.to_lowercase();
        if !case_only && Path::new(&paths.profile_dir(new_name)).exists() {
            return Err(left_folder(paths, new_name));
        }
        let had_dir = Path::new(&paths.profile_dir(name)).exists();
        if had_dir && let Err(e) = std::fs::rename(paths.profile_dir(name), paths.profile_dir(new_name)) {
            return Err(Failure::user(format!(
                "could not rename the folder of \"{name}\" ({}); close anything that has it open and try again",
                crate::jspath::error_code(&e).0
            )));
        }
        // key order is kept, so nothing that lists the file sees the profile jump
        let entries = doc
            .entries()
            .into_iter()
            .map(|(k, v)| (if k == name { new_name.to_string() } else { k }, v))
            .collect();
        doc.replace_profiles(entries);
        if let Err(e) = profiles::save(paths, &mut doc) {
            if had_dir {
                let _ = std::fs::rename(paths.profile_dir(new_name), paths.profile_dir(name));
            }
            return Err(e);
        }
        Ok(case_only)
    })();
    // the run folder holds the lock: let go, then move what is left of it
    let _ = lock.release();
    move_run_dir(paths, name, new_name, moved?);
    profiles::get(paths, new_name)
}

/// `copyNameFor(name)`: `<name>-copy`, `<name>-copy-2`, ...: a name no profile has and no folder
/// is left under, cut to fit the 32 characters a name may have.
fn copy_name_for(paths: &Paths, name: &str, doc: &profiles::Doc) -> String {
    let used: Vec<String> = doc.names().iter().map(|n| n.to_lowercase()).collect();
    let mut i = 1;
    loop {
        let tail = if i == 1 { "-copy".to_string() } else { format!("-copy-{i}") };
        let units: Vec<u16> = name.encode_utf16().take(32 - tail.len()).collect();
        let made = format!("{}{tail}", String::from_utf16_lossy(&units));
        if !used.contains(&made.to_lowercase()) && !Path::new(&paths.profile_dir(&made)).exists() {
            return made;
        }
        i += 1;
    }
}

/// What a copy takes from the game folder: how the game is set up, not what was played in it.
const DUPLICATE_TAKES: &[&str] = &[
    "options.txt",
    "optionsof.txt",
    "servers.dat",
    "mods",
    "config",
    "resourcepacks",
    "shaderpacks",
];

/// `duplicateProfile(name, wanted)`: a second profile with this one's settings, mods and
/// options; assistantAccount starts off, as for every new profile.
pub fn duplicate_profile(paths: &Paths, name: &str, wanted: Option<&str>) -> Result<profiles::Profile, Failure> {
    let from = profiles::get(paths, name)?;
    let new_name = match wanted {
        Some(w) => w.to_string(),
        None => copy_name_for(paths, name, &profiles::load(paths)?),
    };
    profiles::validate_name(&new_name)?;
    // a folder a removed profile left holds its worlds and mods
    if Path::new(&paths.profile_dir(&new_name)).exists() {
        return Err(left_folder(paths, &new_name));
    }
    let f = |k: &str| super::or_null(from.get(k));
    let made = profiles::create(
        paths,
        &new_name,
        profiles::NewProfile {
            mc: f("mc"),
            loader: from.get("loader").cloned().unwrap_or(json!("vanilla")),
            loader_version: f("loaderVersion"),
            java: f("java"),
            memory: from.get("memory").cloned().unwrap_or(json!(profiles::DEFAULT_MEMORY)),
            harness: from.get("harness").cloned().unwrap_or(json!(false)),
            server: f("server"),
            account: f("account"),
            server_list: from.get("serverList") != Some(&json!(false)),
        },
    )?;
    let copied = (|| {
        for item in DUPLICATE_TAKES {
            let src = crate::jspath::join(&[&paths.profile_dir(name), item]);
            if Path::new(&src).exists() {
                let dest = crate::jspath::join(&[&paths.profile_dir(&new_name), item]);
                if Path::new(&dest).is_file() {
                    std::fs::copy(&src, &dest).map_err(|e| Failure::io(&e, "cp", Some(Path::new(&src))))?;
                } else {
                    crate::fsx::copy_tree(Path::new(&src), Path::new(&dest))?;
                }
            }
        }
        // servers.dat came along, so which of its entries SpawnLoft wrote comes along too
        if Path::new(&paths.server_list(name)).exists() {
            crate::fsx::mkdir_all(Path::new(&paths.run_dir(&new_name)))?;
            std::fs::copy(paths.server_list(name), paths.server_list(&new_name))
                .map_err(|e| Failure::io(&e, "copyfile", Some(Path::new(&paths.server_list(name)))))?;
        }
        Ok::<(), Failure>(())
    })();
    if let Err(e) = copied {
        let _ = profiles::remove(paths, &new_name, true);
        return Err(Failure::user(format!(
            "could not copy the files of \"{name}\": {}",
            e.message()
        )));
    }
    profiles::get(paths, &made.name())
}

// ---- Java and loader builds -----------------------------------------------------------------

/// `checkJava(given)`: whether a path is a Java, and which: `{ path, found, major, version,
/// arch, message }`, `message` saying why not.
pub fn check_java(given: Option<&Value>) -> Result<Value, Failure> {
    let p = match given {
        Some(Value::String(s)) if !js::trim(s).is_empty() && s.encode_utf16().count() <= 1024 => {
            js::trim(s).to_string()
        }
        _ => return Err(Failure::user("send the Java's \"path\"")),
    };
    let no = |message: &str| {
        json!({ "path": p, "found": false, "major": null, "version": null, "arch": null, "message": message })
    };
    if p != "java" && !crate::jspath::is_absolute(&p) {
        return Ok(no("Give the whole path to java, starting from the drive or from /."));
    }
    if p != "java" {
        let Ok(meta) = std::fs::metadata(&p) else {
            return Ok(no("There is no file at that path."));
        };
        if meta.is_dir() {
            return Ok(no(if cfg!(windows) {
                "That is a folder. Pick the javaw.exe or java.exe file inside its bin folder."
            } else {
                "That is a folder. Pick the java file inside its bin folder."
            }));
        }
    }
    let state = crate::java::probe(&p);
    // a program that ends well without saying a version is not a Java either
    let said = state.major.is_some() || state.version.as_deref().unwrap_or("").contains("version \"");
    if !state.found || !said {
        return Ok(no(if p == "java" && !state.found {
            "No program called java was found on this computer."
        } else {
            "That file is not a Java: it did not answer the way Java does."
        }));
    }
    Ok(json!({
        "path": p,
        "found": true,
        "major": state.major,
        "version": state.version,
        "arch": state.arch,
        "message": null,
    }))
}

/// `loaderBuilds(loader, mc)`: one loader's builds for one version, newest first, with the one
/// a first Play would take.
pub fn loader_builds(
    paths: &Paths,
    loader: &str,
    mc: &str,
    fetch: super::meta::FetchJson<'_>,
) -> Result<Value, Failure> {
    if !profiles::LOADERS.contains(&loader) || loader == "vanilla" {
        return Err(Failure::user(format!("\"{loader}\" is not a mod loader")));
    }
    if !super::version::is_safe_version_id(mc) {
        return Err(Failure::user("the Minecraft version is not valid"));
    }
    let rows: Vec<(Value, bool, bool)>;
    let picked: Value;
    if super::fabric::handles(loader) {
        let builds = if loader == "fabric" {
            super::fabric::fabric_builds(mc, fetch)?
        } else {
            super::fabric::quilt_builds(mc, fetch)?
        };
        picked = if builds.is_empty() {
            Value::Null
        } else {
            super::fabric::pick(loader, &builds, None)?.version
        };
        rows = builds.into_iter().map(|b| (b.version, b.stable, false)).collect();
    } else {
        let builds = super::forge::builds(paths, loader, mc, fetch)?;
        picked = if builds.is_empty() {
            Value::Null
        } else {
            json!(super::forge::pick(loader, &builds, None)?.version)
        };
        rows = builds
            .into_iter()
            .map(|b| (json!(b.version), b.stable, b.recommended))
            .collect();
    }
    let builds: Vec<Value> = rows
        .into_iter()
        .take(300)
        .map(|(version, stable, recommended)| {
            let mut m = Map::new();
            m.insert("version".into(), version);
            m.insert("stable".into(), json!(stable));
            m.insert("recommended".into(), json!(recommended));
            Value::Object(m)
        })
        .collect();
    Ok(json!({ "loader": loader, "mc": mc, "picked": picked, "builds": builds }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> (std::path::PathBuf, Paths) {
        let d = std::env::temp_dir().join(format!("sl-client-launcher-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = Paths::under(&d.to_string_lossy());
        std::fs::create_dir_all(&p.root).unwrap();
        (d, p)
    }

    #[test]
    fn offline_accounts_keep_the_first_spelling_and_refuse_a_microsoft_name() {
        let (d, p) = scratch("offline");
        let a = add_offline_account(&p, "Alex").unwrap();
        assert_eq!(a["uuid"], json!(crate::players::offline_uuid("Alex")));
        let again = add_offline_account(&p, "alex").unwrap();
        assert_eq!(again["name"], json!("Alex"));
        assert_eq!(accounts::load(&p).unwrap().len(), 1);
        assert!(add_offline_account(&p, "x").is_err());
        std::fs::write(
            p.accounts_file(),
            r#"{"version":1,"accounts":[{"type":"microsoft","name":"Mia","uuid":"aa"}]}"#,
        )
        .unwrap();
        assert_eq!(
            add_offline_account(&p, "mia").unwrap_err().message(),
            "\"Mia\" is a signed-in Microsoft account; play as it instead, or pick another offline name"
        );
        assert_eq!(set_default_account(&p, Some("mia")).unwrap(), json!("aa"));
        assert!(set_default_account(&p, Some("bb")).is_err());
        assert_eq!(set_default_account(&p, None).unwrap(), Value::Null);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_exit_is_marked_seen_only_by_its_own_end_time() {
        let (d, p) = scratch("exit");
        std::fs::write(p.profiles_file(), r#"{"version":1,"profiles":{"a":{"mc":"1.21.4"}}}"#).unwrap();
        assert_eq!(last_exit(&p, "a"), Value::Null);
        assert_eq!(mark_exit_seen(&p, "a", "x").unwrap(), json!({ "seen": false }));
        std::fs::create_dir_all(p.run_dir("a")).unwrap();
        std::fs::write(p.last_exit("a"), r#"{"pid":1,"code":0,"signal":null,"startedAt":"s","endedAt":"e"}"#).unwrap();
        assert_eq!(mark_exit_seen(&p, "a", "x").unwrap(), json!({ "seen": false }));
        assert_eq!(mark_exit_seen(&p, "a", "e").unwrap(), json!({ "seen": true }));
        assert_eq!(
            crate::jsjson::stringify(&last_exit(&p, "a")),
            r#"{"code":0,"signal":null,"startedAt":"s","endedAt":"e","stopped":false,"seen":true}"#
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_copy_takes_the_next_free_name_and_the_setup_files() {
        let (d, p) = scratch("copy");
        std::fs::write(p.profiles_file(), r#"{"version":1,"profiles":{"a":{"mc":"1.21.4","loader":"vanilla","loaderVersion":null,"java":null,"memory":"2G","harness":false,"server":null,"account":null}}}"#).unwrap();
        std::fs::create_dir_all(crate::jspath::join(&[&p.profile_dir("a"), "mods"])).unwrap();
        std::fs::write(crate::jspath::join(&[&p.profile_dir("a"), "mods", "x.jar"]), "j").unwrap();
        std::fs::write(crate::jspath::join(&[&p.profile_dir("a"), "options.txt"]), "fov:1\n").unwrap();
        let made = duplicate_profile(&p, "a", None).unwrap();
        assert_eq!(made.name(), "a-copy");
        assert!(Path::new(&crate::jspath::join(&[&p.profile_dir("a-copy"), "mods", "x.jar"])).exists());
        assert_eq!(
            std::fs::read_to_string(crate::jspath::join(&[&p.profile_dir("a-copy"), "options.txt"])).unwrap(),
            "fov:1\n"
        );
        assert_eq!(duplicate_profile(&p, "a", None).unwrap().name(), "a-copy-2");
        let renamed = rename_profile(&p, "a-copy", "b").unwrap();
        assert_eq!(renamed.name(), "b");
        assert!(Path::new(&p.profile_dir("b")).exists());
        assert_eq!(profiles::load(&p).unwrap().names(), vec!["a", "b", "a-copy-2"]);
        assert_eq!(rename_profile(&p, "b", "A").unwrap_err().message(), "a profile named \"a\" already exists (names must differ in more than case)");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_java_path_must_be_whole_and_a_file() {
        assert_eq!(check_java(None).unwrap_err().message(), "send the Java's \"path\"");
        assert_eq!(check_java(Some(&json!("bin/java"))).unwrap()["message"], json!("Give the whole path to java, starting from the drive or from /."));
        let dir = std::env::temp_dir();
        assert!(check_java(Some(&json!(dir.to_string_lossy()))).unwrap()["message"].as_str().unwrap().starts_with("That is a folder."));
    }
}
