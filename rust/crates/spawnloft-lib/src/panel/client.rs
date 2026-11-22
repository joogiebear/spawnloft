//! `handleClient` and `handleAccounts` of `ui.mjs`: the game launcher's routes (`/api/client...`):
//! profiles, the version picker, launches and their logs, and the accounts with the Microsoft
//! sign-in. Everything here is behind the same loopback checks as the rest of the panel, which
//! matters because a profile's `java` is a path a launch runs; the one route answered without a
//! credential is the sign-in's callback (see `accounts.rs`).

mod accounts;
mod launch;

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::client::paths::Paths;
use crate::client::{self, launcher, meta, profiles, rules, state, versions};
use crate::failure::Failure;
use crate::settings::Layout;
use crate::{java, js, jspath};

use super::Panel;
use super::http::{Reply, Request, field, opt_field};
use super::routes::Routed;

const LOG_LINES_MAX: f64 = 500.0;

/// Every change to profiles.json and accounts.json made from here: a route reads, changes and
/// writes the whole file, and the routes run side by side (Node ran them one at a time).
static WRITES: Mutex<()> = Mutex::new(());

fn writing() -> std::sync::MutexGuard<'static, ()> {
    WRITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `/api/client...`, accounts included.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let paths = Paths::new(layout);
    if req.seg(2) == Some("accounts") {
        return accounts::route(panel, &paths, req);
    }
    if req.seg.len() == 5 && req.seg(2) == Some("profiles") && req.seg(4) == Some("launch") && req.method == "POST" {
        return Ok(Routed::NotPorted);
    }
    handle_client(panel, layout, &paths, req).map(Routed::Reply)
}

/// `panelLog(msg)`: a line in panel.log; losing one is fine.
fn panel_log(run_dir: &str, msg: &str) {
    let _ = crate::fsx::mkdir_all(Path::new(run_dir));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(jspath::join(&[run_dir, "panel.log"]))
    {
        let _ = std::io::Write::write_all(&mut f, format!("[{}] {msg}\n", crate::time::iso_now()).as_bytes());
    }
}

/// `['1', 'true'].includes(url.searchParams.get(key) ?? '')`.
fn asked(req: &Request, key: &str) -> bool {
    matches!(req.q(key), Some("1" | "true"))
}

/// `decodeURIComponent(s)`: `None` is the URIError (a stray `%`, bytes that are not UTF-8).
fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|c| c.is_ascii_hexdigit()))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `(await readBody(req)) ?? {}`.
fn body_or_empty(req: &mut Request) -> Result<Value, Failure> {
    let body = req.json()?;
    Ok(if body.is_null() { json!({}) } else { body })
}

/// `recentJavas({ fresh })`: the Javas found, kept ten minutes.
fn recent_javas(fresh: bool) -> Vec<java::Found> {
    static KEPT: Mutex<Option<(Instant, Vec<java::Found>)>> = Mutex::new(None);
    let mut kept = KEPT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !fresh
        && let Some((at, all)) = kept.as_ref()
        && at.elapsed() < Duration::from_secs(600)
    {
        return all.clone();
    }
    let all = java::discover().all;
    *kept = Some((Instant::now(), all.clone()));
    all
}

fn handle_client(panel: &Panel, layout: &Layout, paths: &Paths, req: &mut Request) -> Result<Reply, Failure> {
    let n = req.seg.len();
    let get = req.method == "GET";
    let post = req.method == "POST";
    let s2 = req.seg(2).unwrap_or("").to_string();
    let s3 = req.seg(3).map(String::from);
    let fetch: meta::FetchJson<'_> = &meta::default_fetch;

    if s2 == "versions" && n == 3 && get {
        // loaders=1 reads every mod loader's list; fabric=1 is what pages from before it send
        let fabric = asked(req, "loaders") || asked(req, "fabric");
        return Ok(Reply::ok(versions::list_for_picker(paths, &rules::current_os(), fabric, false, fetch)?));
    }
    // Mojang's and the loaders' lists read again now, for a release out within the hour
    if s2 == "versions" && s3.as_deref() == Some("refresh") && n == 4 && post {
        return Ok(Reply::ok(versions::list_for_picker(paths, &rules::current_os(), false, true, fetch)?));
    }
    if s2 == "versions" && n == 4 && get {
        let Some(id) = decode_component(s3.as_deref().unwrap_or("")) else {
            return Err(Failure::user("the version id in the address is not valid"));
        };
        return Ok(Reply::ok(versions::describe_version(paths, &rules::current_os(), &json!(id), fetch)?));
    }
    // one mod loader's builds for one version: /api/client/loaders/<loader>/<mc>/builds
    if s2 == "loaders" && req.seg(5) == Some("builds") && n == 6 && get {
        let (Some(loader), Some(mc)) = (
            decode_component(req.seg(3).unwrap_or("")),
            decode_component(req.seg(4).unwrap_or("")),
        ) else {
            return Err(Failure::user("the address is not valid"));
        };
        return Ok(Reply::ok(launcher::loader_builds(paths, &loader, &mc, fetch)?));
    }
    if s2 == "launcher" && n == 3 && get {
        return Ok(Reply::ok(launcher_summary(layout, paths)?));
    }
    // the Javas launch chooses among, for the setup sheet; fresh=1 looks again now
    if s2 == "javas" && n == 3 && get {
        let rows: Vec<Value> = recent_javas(req.q("fresh") == Some("1"))
            .into_iter()
            .map(|j| {
                json!({
                    "path": j.path,
                    "major": j.probe.major,
                    "version": j.probe.version,
                    "arch": j.probe.arch,
                    "onPath": j.source == "PATH",
                })
            })
            .collect();
        return Ok(Reply::ok(json!({ "javas": rows })));
    }
    // One Java by its path, started once to see that it is one. It runs what the path names, as
    // a launch of a setup saved with it would.
    if s2 == "javas" && s3.as_deref() == Some("check") && n == 4 && post {
        let body = body_or_empty(req)?;
        return Ok(Reply::ok(launcher::check_java(opt_field(&body, "path"))?));
    }
    if s2 != "profiles" {
        return Ok(Reply::not_found());
    }

    if n == 3 {
        if get {
            let rows = profiles::list(paths)?
                .iter()
                .map(|p| profile_row(paths, p))
                .collect::<Result<Vec<Value>, Failure>>()?;
            return Ok(Reply::ok(Value::Array(rows)));
        }
        if !post {
            return Ok(Reply::method_not_allowed());
        }
        let body = body_or_empty(req)?;
        return create_profile(paths, &body);
    }

    let profile_name = s3.unwrap_or_default();
    if n == 4 {
        return match req.method.as_str() {
            "PATCH" => patch_profile(paths, &profile_name, &req.json()?),
            "DELETE" => {
                let purge = asked(req, "purge");
                let _w = writing();
                profiles::remove(paths, &profile_name, purge)?;
                Ok(Reply::ok(json!({ "removed": profile_name, "purged": purge })))
            }
            _ => Ok(Reply::method_not_allowed()),
        };
    }
    if n != 5 {
        return Ok(Reply::not_found());
    }

    let verb = req.seg(4).unwrap_or("").to_string();
    match (verb.as_str(), get, post) {
        ("status", true, _) => Ok(Reply::ok(state::status(paths, &profile_name)?.json)),
        ("log", true, _) => {
            profiles::get(paths, &profile_name)?;
            let wanted = match req.q("lines") {
                None => 20.0,
                Some(t) => js::string_to_number(t),
            };
            let count = if wanted.fract() == 0.0 && wanted.is_finite() && wanted > 0.0 {
                wanted.min(LOG_LINES_MAX)
            } else {
                20.0
            };
            let scrub = crate::scrubber::scrubber(layout, false);
            let lines: Vec<Value> = client::log::tail(paths, &profile_name, count)?
                .iter()
                .map(|l| json!(scrub(&client::log::redact_line(l))))
                .collect();
            Ok(Reply::ok(json!({ "lines": lines })))
        }
        ("diag", _, true) => {
            profiles::get(paths, &profile_name)?;
            let scrub = crate::scrubber::scrubber(layout, false);
            let bundle = crate::diag_bundle::build_bundle(
                layout,
                None,
                Some(&profile_name),
                crate::diag_bundle::TAIL_LINES,
                &scrub,
            )?;
            let out_dir = jspath::join(&[&layout.backups_dir, "client", "exports"]);
            let written = crate::diag_bundle::write_bundle(&bundle, &out_dir)?;
            Ok(Reply::ok(json!({
                "file": written.file,
                "size": written.size,
                "sizeHuman": crate::text::human_bytes(Some(written.size as f64)),
                "findings": { "server": bundle.findings_server, "client": bundle.findings_client },
            })))
        }
        ("launch", _, true) => launch::launch(panel, layout, paths, req, &profile_name),
        ("stop", _, true) => Ok(Reply::ok(state::stop(paths, &profile_name)?)),
        // The profile's folder in the file manager, or one of the two the game writes its logs
        // and crash reports to; `what` is matched against that list, never used as a path.
        ("reveal", _, true) => {
            let body = body_or_empty(req)?;
            let (target, fell_back) = launcher::reveal_target(paths, &profile_name, opt_field(&body, "what"))?;
            let dir = crate::manage::open_folder(&target)?;
            Ok(Reply::ok(json!({ "dir": dir, "fellBack": fell_back })))
        }
        // the Play page showed this exit's crash notice and it was dismissed
        ("exit-seen", _, true) => {
            let body = body_or_empty(req)?;
            let ended_at = match opt_field(&body, "endedAt") {
                Some(Value::String(s)) if s.encode_utf16().count() <= 40 => s.clone(),
                _ => return Err(Failure::user("send the exit's \"endedAt\"")),
            };
            let _w = writing();
            Ok(Reply::ok(launcher::mark_exit_seen(paths, &profile_name, &ended_at)?))
        }
        // a new name for the setup, or a second setup with this one's settings, mods and options
        ("rename" | "duplicate", _, true) => {
            let body = body_or_empty(req)?;
            let named = match opt_field(&body, "name") {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
            let _w = writing();
            let made = if verb == "rename" {
                let Some(new_name) = named else {
                    return Err(Failure::user("send the new name as \"name\""));
                };
                launcher::rename_profile(paths, &profile_name, &new_name)?
            } else {
                // a copy with no name asked for gets one: "<name>-copy", or the next free one
                launcher::duplicate_profile(paths, &profile_name, named.as_deref())?
            };
            Ok(Reply::ok(profile_row(paths, &made)?))
        }
        _ => Ok(Reply::method_not_allowed()),
    }
}

/// `POST /api/client/profiles`: a new profile, its version checked against Mojang's list (and
/// its loader's) first. assistantAccount is not taken here: a new profile starts with it off.
fn create_profile(paths: &Paths, body: &Value) -> Result<Reply, Failure> {
    let Some(Value::String(name)) = field(body, "name")? else {
        return Err(Failure::user("a profile needs a name"));
    };
    if !matches!(field(body, "mc")?, Some(Value::String(_))) {
        return Err(Failure::user("a profile needs a Minecraft version"));
    }
    let mut fields = Map::new();
    for key in [
        "mc",
        "loader",
        "loaderVersion",
        "java",
        "memory",
        "harness",
        "server",
        "account",
        "serverList",
    ] {
        if let Some(v) = opt_field(body, key) {
            fields.insert(key.into(), v.clone());
        }
    }
    let mc = versions::check_profile_version(
        paths,
        fields.get("mc").unwrap_or(&Value::Null),
        fields.get("loader"),
        &meta::default_fetch,
    )?;
    fields.insert("mc".into(), json!(mc));
    let or = |k: &str, d: Value| fields.get(k).cloned().unwrap_or(d);
    let server_list = or("serverList", json!(true));
    let _w = writing();
    if !server_list.is_boolean() {
        // createProfile's own checks, in its order, for a serverList that is not true or false
        profiles::validate_name(name)?;
        launcher::assert_name_free(&profiles::load(paths)?, name, None)?;
        let mut all = Map::new();
        for (k, d) in [
            ("mc", json!(mc)),
            ("loader", json!("vanilla")),
            ("loaderVersion", Value::Null),
            ("java", Value::Null),
            ("memory", json!(profiles::DEFAULT_MEMORY)),
            ("harness", json!(false)),
            ("server", Value::Null),
            ("account", Value::Null),
        ] {
            all.insert(k.into(), or(k, d));
        }
        all.insert("assistantAccount".into(), json!(false));
        all.insert("serverList".into(), server_list.clone());
        profiles::validate_fields(&all)?;
    }
    let made = profiles::create(
        paths,
        name,
        profiles::NewProfile {
            mc: json!(mc),
            loader: or("loader", json!("vanilla")),
            loader_version: or("loaderVersion", Value::Null),
            java: or("java", Value::Null),
            memory: or("memory", json!(profiles::DEFAULT_MEMORY)),
            harness: or("harness", json!(false)),
            server: or("server", Value::Null),
            account: or("account", Value::Null),
            server_list: server_list != json!(false),
        },
    )?;
    Ok(Reply::ok(profile_row(paths, &profiles::get(paths, &made.name())?)?))
}

/// `PATCH /api/client/profiles/<name>`: a new version, or a new loader, is checked against
/// Mojang's and the loader's lists before anything is saved.
fn patch_profile(paths: &Paths, name: &str, body: &Value) -> Result<Reply, Failure> {
    let Value::Object(patch) = body else {
        return Err(Failure::user("send the keys to change as a JSON object"));
    };
    let before = profiles::get(paths, name)?;
    let mc = match patch.get("mc") {
        Some(Value::String(s)) => Some(json!(js::trim(s))),
        _ => before.get("mc").cloned(),
    };
    let loader = match patch.get("loader") {
        Some(v @ Value::String(_)) => Some(v.clone()),
        _ => before.get("loader").cloned(),
    };
    if !client::strict_eq(mc.as_ref(), before.get("mc")) || !client::strict_eq(loader.as_ref(), before.get("loader")) {
        versions::check_profile_version(
            paths,
            mc.as_ref().unwrap_or(&Value::Null),
            loader.as_ref(),
            &meta::default_fetch,
        )?;
    }
    let _w = writing();
    profiles::update(paths, name, patch.clone().into_iter().collect())?;
    let mut warnings: Vec<String> = Vec::new();
    if let Some(Value::String(new_mc)) = patch.get("mc")
        && Some(&json!(new_mc)) != before.get("mc")
        && has_mod_jars(paths, name)
    {
        warnings.push(format!(
            "Mods in this profile's folder were installed for {} and may not load",
            js::string(before.get("mc"))
        ));
    }
    let profile = profile_row(paths, &profiles::get(paths, name)?)?;
    Ok(Reply::ok(json!({ "profile": profile, "warnings": warnings })))
}

/// `profileFolder(name)`.
fn profile_folder(paths: &Paths, name: &str) -> Result<String, Failure> {
    profiles::get(paths, name)?;
    Ok(paths.profile_dir(name))
}

fn has_mod_jars(paths: &Paths, name: &str) -> bool {
    if profiles::get(paths, name).is_err() {
        return false;
    }
    let mods = jspath::join(&[&paths.profile_dir(name), "mods"]);
    crate::fsx::readdir_names(Path::new(&mods))
        .is_ok_and(|names| names.iter().any(|f| f.to_ascii_lowercase().ends_with(".jar")))
}

/// `clientProfileRow(p)`: a profile with its account's name and type (the key may be a uuid),
/// its running state, how its last game ended, the time played and its folder.
fn profile_row(paths: &Paths, p: &profiles::Profile) -> Result<Value, Failure> {
    let name = p.name();
    let st = state::status(paths, &name)?.json;
    let g = |k: &str| p.get(k).cloned();
    let s = |k: &str| st.get(k).cloned();
    let account = p.get("account");
    let (account_name, account_type) = profiles::account_info(paths, account)?;
    let target = match st.get("address") {
        None | Some(Value::Null) => s("server"),
        v => v.cloned(),
    };
    Ok(client::object(vec![
        ("name", g("name")),
        ("mc", g("mc")),
        ("loader", g("loader")),
        ("loaderVersion", g("loaderVersion")),
        ("memory", g("memory")),
        ("java", g("java")),
        ("harness", g("harness")),
        ("server", g("server")),
        ("account", g("account")),
        // `{ name: value }` with value undefined is no key
        ("accountName", account.map(|_| account_name)),
        ("accountType", Some(account_type)),
        ("accountUuid", Some(profiles::account_uuid(paths, account)?.unwrap_or(Value::Null))),
        ("assistantAccount", g("assistantAccount")),
        ("serverList", g("serverList")),
        ("running", s("running")),
        ("pid", s("pid")),
        ("startedAt", s("startedAt")),
        ("runningAccount", s("account")),
        ("launchedBy", s("launchedBy")),
        ("launchTarget", target),
        ("lastExit", Some(launcher::last_exit(paths, &name))),
        ("played", Some(state::read_played(paths, &name))),
        ("folder", Some(json!(profile_folder(paths, &name)?))),
    ]))
}

/// `publicAccounts()`: names, uuids and the two dates only. An unreadable file lists nothing.
fn public_accounts(paths: &Paths) -> Vec<Value> {
    let list = client::accounts::load_with(paths, "list.filter").unwrap_or_default();
    list.iter()
        .filter(|a| matches!(a.get("name"), Some(Value::String(_))))
        .filter_map(|a| client::accounts::public(a).ok())
        .collect()
}

/// `launcherSummary()`: one read for the launcher's poll: profiles with their running state,
/// accounts, and the servers a profile can join.
fn launcher_summary(layout: &Layout, paths: &Paths) -> Result<Value, Failure> {
    let accounts = public_accounts(paths);
    let wanted = client::or_null(profiles::load(paths)?.default_account());
    let mut servers = Vec::new();
    for inst in crate::registry::list_instances(Path::new(&layout.registry_file))? {
        let row = match super::shared::status_row(layout, &inst.name).and_then(|r| super::shared::safe_instance(&r)) {
            Ok(r) => r,
            Err(_) => {
                let mut m = Map::new();
                m.insert("name".into(), json!(inst.name));
                for (k, v) in &inst.fields {
                    m.insert(k.clone(), v.clone());
                }
                m.insert("status".into(), json!("unknown"));
                m.insert("onlineMode".into(), Value::Null);
                Value::Object(m)
            }
        };
        // the mod loader a player needs to join: a Fabric or NeoForge server's own
        let family = crate::software::software_of(Some(&json!(crate::registry::loader_of(&inst)))).family();
        let loader = if family == "fabric" || family == "neoforge" {
            json!(family)
        } else {
            Value::Null
        };
        let label = match row.get("label") {
            None | Some(Value::Null) => Value::Null,
            v => v.cloned().unwrap_or(Value::Null),
        };
        let mut as_instance = inst.clone();
        if let Value::Object(m) = &row {
            as_instance.fields = m.clone();
        }
        servers.push(client::object(vec![
            ("name", row.get("name").cloned().or(Some(json!(inst.name)))),
            ("label", Some(label)),
            ("mc", Some(json!(crate::plugins::mc_version_of(&as_instance)))),
            ("status", row.get("status").cloned()),
            ("onlineMode", row.get("onlineMode").cloned()),
            ("loader", Some(loader)),
        ]));
    }
    let rows = profiles::list(paths)?
        .iter()
        .map(|p| profile_row(paths, p))
        .collect::<Result<Vec<Value>, Failure>>()?;
    // a uuid no longer signed in is no default at all
    let default = if accounts.iter().any(|a| client::strict_eq(a.get("uuid"), Some(&wanted))) {
        wanted
    } else {
        Value::Null
    };
    Ok(json!({
        "profiles": rows,
        "accounts": accounts,
        "defaultAccount": default,
        "servers": servers,
        "machineRefusal": client::library::platform_refusal(None, &rules::current_os(), None)?,
        "machine": {
            "totalMemory": crate::platform::total_memory(),
            "freeMemory": crate::platform::free_memory(),
        },
    }))
}
