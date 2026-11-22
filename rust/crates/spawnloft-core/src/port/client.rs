//! `client` (C7): `cmdClient` in mcctl.mjs, over spawnloft-lib's `client`.

use serde_json::{Value, json};

use spawnloft_lib::client::paths::Paths;
use spawnloft_lib::client::{
    accounts, auth, http, install, launch, log, meta, profiles, prop, state, versions,
};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::js;

use super::args::Flag;
use super::output::json_line;
use super::{Ctx, check_flags};

pub const USAGE: &str = "Usage: spawnloft client list | client versions [--snapshots | --all] [-n 30] | client new <name> --mc <v> [--loader vanilla|fabric|quilt|forge|neoforge] [--memory 2G] [--java <path>] [--server <server>] [--harness] | client set <name> key=value ... | client remove <name> [--purge] | client install <name> [--verify] | client launch <name> [--as <playerName>] [--account <account>] [--server <server>] [--wait] | client status <name> | client stop <name> | client logs <name> [-n 100] [--latest] | client login | client logout <name> | client accounts";

fn usage() -> Failure {
    Failure::usage(USAGE)
}

/// A flag's value as the Node core holds it.
fn flag_value(f: Option<&Flag>) -> Option<Value> {
    f.map(|f| match f {
        Flag::Text(s) => json!(s),
        Flag::Bool(b) => json!(b),
    })
}

/// `-n`: absent is `default`; otherwise a positive whole number written as text.
fn count_flag(n: Option<&Flag>, default: f64) -> Result<f64, Failure> {
    let count = n.map_or(default, Flag::number);
    if !matches!(n, None | Some(Flag::Text(_))) || count.fract() != 0.0 || !count.is_finite() || count < 1.0 {
        return Err(Failure::usage("-n must be a positive whole number"));
    }
    Ok(count)
}

/// `arg.match(/^([a-zA-Z]+)=(.*)$/)`: a key of letters, `=`, and a value on one line.
fn set_arg(arg: &str) -> Option<(String, String)> {
    let (key, value) = arg.split_once('=')?;
    let ok_key = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphabetic());
    let one_line = !value.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (ok_key && one_line).then(|| (key.to_string(), value.to_string()))
}

const SET_KEYS: &[&str] = &[
    "mc",
    "loader",
    "loaderVersion",
    "memory",
    "java",
    "server",
    "harness",
    "account",
    "assistantAccount",
    "serverList",
];

pub fn client(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let paths = Paths::new(ctx.layout);
    let pos = ctx.args.positional.clone();
    let sub = pos.first().map(String::as_str);
    let rest = pos.get(1..).unwrap_or(&[]).to_vec();
    let quiet = ctx.args.get("json") == Some(&Flag::Bool(true));
    let emit = |ctx: &mut Ctx<'_>, data: Value| ctx.out.print(&json_line("client", Some(&data), None));
    match sub {
        Some("list") => {
            check_flags(ctx.args, &["json"])?;
            if !rest.is_empty() {
                return Err(usage());
            }
            let mut rows = Vec::new();
            for p in profiles::list(&paths)? {
                let account = p.get("account").cloned();
                let (account_name, account_type) = if js::truthy(account.as_ref()) {
                    profiles::account_info(&paths, account.as_ref())?
                } else {
                    (Value::Null, Value::Null)
                };
                let running = state::status(&paths, &p.name())?.running;
                let mut row = p.fields.clone();
                row.insert("accountName".into(), account_name.clone());
                row.insert("accountType".into(), account_type);
                row.insert("running".into(), json!(running));
                rows.push((p, account_name, running, Value::Object(row)));
            }
            if quiet {
                let list: Vec<Value> = rows.into_iter().map(|r| r.3).collect();
                emit(ctx, json!({ "profiles": list }));
            } else if rows.is_empty() {
                ctx.out
                    .line("No client profiles yet. Make one: spawnloft client new <name> --mc 1.21.11");
            } else {
                for (p, name, running, _) in rows {
                    let s = |k: &str| js::string(p.get(k));
                    let account = if js::truthy(p.get("account")) {
                        format!("account {}", js::string(Some(&name)))
                    } else {
                        "offline".into()
                    };
                    ctx.out.line(&format!(
                        "{}  {}  {}  {}  {account}  {}",
                        p.name(),
                        s("mc"),
                        s("loader"),
                        s("memory"),
                        if running { "running" } else { "stopped" }
                    ));
                }
            }
            Ok(())
        }
        Some("remove") => {
            check_flags(ctx.args, &["purge", "json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let purge = ctx.args.get("purge") == Some(&Flag::Bool(true));
            profiles::remove(&paths, name, purge)?;
            if quiet {
                emit(ctx, json!({ "removed": name, "purged": purge }));
            } else {
                ctx.out.line(&format!("Removed \"{name}\""));
            }
            Ok(())
        }
        Some("status") => {
            check_flags(ctx.args, &["json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let st = state::status(&paths, name)?;
            if quiet {
                emit(ctx, st.json);
            } else {
                ctx.out.line(&state::status_text(name, &st));
            }
            Ok(())
        }
        Some("stop") => {
            check_flags(ctx.args, &["json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let res = state::stop(&paths, name)?;
            if quiet {
                emit(ctx, res);
            } else if res["stopped"] == json!(true) {
                ctx.out.line(&format!("Stopped \"{name}\""));
            } else {
                ctx.out.line(&format!("\"{name}\" was not running"));
            }
            Ok(())
        }
        Some("logs") => {
            check_flags(ctx.args, &["n", "latest", "json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            profiles::get(&paths, name)?;
            let n = ctx.args.get("n");
            let count = n.map_or(100.0, Flag::number);
            if !matches!(n, None | Some(Flag::Text(_)))
                || count.fract() != 0.0
                || !count.is_finite()
                || count < 1.0
            {
                return Err(Failure::usage("-n must be a positive whole number"));
            }
            let (lines, file) = if ctx.args.get("latest") == Some(&Flag::Bool(true)) {
                let file = log::latest_path(&paths, name);
                let mut lines = match std::fs::read(&file) {
                    Ok(b) => log::split_lines(&String::from_utf8_lossy(&b)),
                    Err(e) if spawnloft_lib::jspath::is_enoent(&e) => Vec::new(),
                    Err(e) => return Err(Failure::read(&e, std::path::Path::new(&file))),
                };
                if lines.last().is_some_and(String::is_empty) {
                    lines.pop();
                }
                (log::last(lines, count), file)
            } else {
                (log::tail(&paths, name, count)?, paths.log(name))
            };
            if quiet {
                emit(ctx, json!({ "lines": lines, "file": file }));
            } else {
                for l in lines {
                    ctx.out.line(&l);
                }
            }
            Ok(())
        }
        Some("login") => {
            check_flags(ctx.args, &["json"])?;
            if !rest.is_empty() {
                return Err(usage());
            }
            // As Node's `process.once('SIGINT')`: the first Ctrl-C cancels the sign-in at the
            // next wait (a request under way finishes first), a second one ends the process, and
            // SIGTERM ends it whenever it comes. A watcher thread sees them even while a request
            // is waiting on the network.
            static CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            spawnloft_lib::platform::watch_interrupts();
            std::thread::spawn(|| {
                loop {
                    if let Some(code) = spawnloft_lib::platform::take_interrupt()
                        && (code != 130 || CANCELLED.swap(true, std::sync::atomic::Ordering::SeqCst))
                    {
                        std::process::exit(i32::from(code));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            let cancelled = || CANCELLED.load(std::sync::atomic::Ordering::SeqCst);
            let mut sleep = |d: std::time::Duration| {
                let end = std::time::Instant::now() + d;
                loop {
                    if cancelled() {
                        return true;
                    }
                    let left = end.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        return false;
                    }
                    std::thread::sleep(left.min(std::time::Duration::from_millis(50)));
                }
            };
            let now = || spawnloft_lib::time::now_ms() as f64;
            let chain = auth::Chain {
                send: &http::send,
                now: &now,
                timeout: None,
            };
            let account = {
                let out = &mut ctx.out;
                auth::device_code_login(
                    chain,
                    // on stderr, so --json keeps stdout for the one envelope
                    &mut |code| out.err(&code.prompt()),
                    &mut sleep,
                )?
            };
            // re-read and upsert by uuid: a sign-in from the launcher meanwhile survives this one
            accounts::update_iterating(&paths, |list| accounts::upsert(list, account.clone(), None))?;
            let name = js::string(account.get("name"));
            if quiet {
                emit(
                    ctx,
                    json!({ "account": {
                        "type": account.get("type").cloned(),
                        "name": account.get("name").cloned(),
                        "uuid": account.get("uuid").cloned(),
                    } }),
                );
            } else {
                ctx.out.line(&format!(
                    "Signed in as {name}. Use it: spawnloft client launch <profile> --account {name}, or spawnloft client set <profile> account={name}"
                ));
            }
            Ok(())
        }
        Some("logout") => {
            check_flags(ctx.args, &["json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let list = accounts::load(&paths)?;
            let Some(at) = accounts::find(&list, name)? else {
                return Err(Failure::user(format!(
                    "no signed-in account named \"{name}\"; spawnloft client accounts lists them"
                )));
            };
            let gone = match accounts::remove(&paths, prop(Some(&list[at]), "uuid"))? {
                Some(g) => g,
                None => accounts::public(&list[at])?,
            };
            let gone_name = js::string(gone.get("name"));
            if quiet {
                emit(
                    ctx,
                    spawnloft_lib::client::object(vec![
                        ("removed", gone.get("name").cloned()),
                        ("uuid", gone.get("uuid").cloned()),
                    ]),
                );
            } else if gone.get("type") == Some(&json!("offline")) {
                ctx.out.line(&format!("Removed the offline account {gone_name}."));
            } else {
                ctx.out.line(&format!(
                    "Signed out {gone_name}. Microsoft keeps its own session; sign out of your browser too if the machine is shared."
                ));
            }
            Ok(())
        }
        Some("accounts") => {
            check_flags(ctx.args, &["json"])?;
            if !rest.is_empty() {
                return Err(usage());
            }
            // names and expiry only: the tokens never leave the file
            let list = accounts::load_with(&paths, "clientAuth.loadAccounts(...).map")?
                .iter()
                .map(accounts::public)
                .collect::<Result<Vec<Value>, Failure>>()?;
            let default = profiles::default_account(&paths)?;
            if quiet {
                emit(ctx, json!({ "accounts": list, "defaultAccount": default }));
            } else if list.is_empty() {
                ctx.out
                    .line("No Microsoft account is signed in. Sign in: spawnloft client login");
            } else {
                for a in &list {
                    // `defaultAccount && sameUuid(...)`: an empty default marks nothing
                    let is_default = default.as_ref().is_some_and(|d| {
                        !d.is_empty() && accounts::same_uuid(a.get("uuid"), Some(&json!(d)))
                    });
                    ctx.out.line(&format!(
                        "{}  {}  {}{}",
                        js::string(a.get("name")),
                        js::string(a.get("uuid")),
                        accounts::state_text(a),
                        if is_default { "  (default)" } else { "" }
                    ));
                }
            }
            Ok(())
        }
        Some("install") => {
            check_flags(ctx.args, &["json", "verify"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            profiles::get(&paths, name)?;
            let verify = ctx.args.get("verify") == Some(&Flag::Bool(true));
            let out = std::sync::Mutex::new(&mut *ctx.out);
            let say = |text: &str| out.lock().unwrap_or_else(|p| p.into_inner()).err(text);
            let id = spawnloft_lib::client::fabric::prepare_version(
                &paths,
                name,
                &mut |message| {
                    if !quiet {
                        say(&format!("{message}\n"));
                    }
                },
                &spawnloft_lib::client::fabric::Fetchers::real(),
            )?;
            // only a phase that fetched something is worth a line
            let on_progress = |p: &install::Progress| {
                if !quiet && p.bytes > 0.0 {
                    say(&format!(
                        "{} {}/{} ({})\n",
                        p.phase,
                        p.done,
                        p.total,
                        spawnloft_lib::text::human_bytes(Some(p.bytes))
                    ));
                }
            };
            // Forge and NeoForge: the game's Java found and the installer's build steps run on it
            launch::install_loader(
                &paths,
                name,
                &id,
                verify,
                &|message| {
                    if !quiet {
                        say(&format!("{message}\n"));
                    }
                },
                &on_progress,
                &mut |w| say(&format!("warning: {w}\n")),
            )?;
            let result = install::ensure_version(
                &paths,
                &id,
                &install::Ensure {
                    os: spawnloft_lib::client::rules::current_os(),
                    on_progress: &on_progress,
                    fetch: &install::default_fetch,
                    keep_natives: &[],
                    verify,
                },
            )?;
            if quiet {
                let mut data = serde_json::Map::new();
                data.insert("name".into(), json!(name));
                if let Value::Object(m) = &result {
                    data.extend(m.clone());
                }
                emit(ctx, Value::Object(data));
            } else {
                ctx.out.line(&format!(
                    "Installed {}: {} files ({} bytes)",
                    js::string(prop(Some(&result), "id")),
                    js::string(prop(Some(&result), "downloaded")),
                    js::string(prop(Some(&result), "bytes"))
                ));
            }
            Ok(())
        }
        Some("launch") => {
            check_flags(ctx.args, &["as", "account", "server", "wait", "json"])?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let text = |key: &str, why: &str| -> Result<Option<String>, Failure> {
                match ctx.args.get(key) {
                    None => Ok(None),
                    Some(Flag::Text(s)) => Ok(Some(s.clone())),
                    Some(_) => Err(Failure::usage(why)),
                }
            };
            let player_name = text("as", "--as needs a player name")?;
            let account = text(
                "account",
                "--account needs \"offline:<player name>\" or a signed-in account name",
            )?;
            let server = text("server", "--server needs a server name")?;
            let wait = ctx.args.get("wait") == Some(&Flag::Bool(true));
            let out = std::sync::Mutex::new(&mut *ctx.out);
            let say = |text: &str| out.lock().unwrap_or_else(|p| p.into_inner()).err(text);
            let on_progress = |p: &install::Progress| {
                if !quiet && p.bytes > 0.0 {
                    say(&format!(
                        "{} {}/{} ({})\n",
                        p.phase,
                        p.done,
                        p.total,
                        spawnloft_lib::text::human_bytes(Some(p.bytes))
                    ));
                }
            };
            // a warning (the target server is stopped) comes out before the launch line
            let on_warning = |w: &str| {
                if !quiet {
                    say(&format!("warning: {w}\n"));
                }
            };
            let mut res = launch::launch(
                &paths,
                ctx.layout,
                name,
                &launch::LaunchOpts {
                    player_name,
                    account,
                    server,
                    on_progress: &on_progress,
                    on_warning: &on_warning,
                    fake_java: launch::fake_client_java(),
                },
            )?;
            if wait {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while std::time::Instant::now() < deadline {
                    // the game this process started is heard as it exits, as Node's exit handler
                    if let Ok(Some(status)) = res.started.child.try_wait() {
                        launch::note_exit(&paths, name, &res.started, status);
                    }
                    if !state::status(&paths, name)?.running {
                        return Err(Failure::user(format!(
                            "the client exited within 5 s; see spawnloft client logs {name}"
                        )));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
            if quiet {
                emit(
                    ctx,
                    json!({
                        "pid": res.started.pid,
                        "version": res.version,
                        "account": res.account,
                        "profile": res.profile.to_json(),
                        "warnings": res.warnings,
                    }),
                );
            } else {
                ctx.out.line(&format!(
                    "Launched \"{name}\" as {} (pid {})",
                    js::string(prop(Some(&res.account), "name")),
                    res.started.pid
                ));
            }
            Ok(())
        }
        Some("versions") => {
            check_flags(ctx.args, &["snapshots", "all", "n", "json"])?;
            if !rest.is_empty() {
                return Err(usage());
            }
            let count = count_flag(ctx.args.get("n"), 30.0)?;
            let list = versions::list_versions(&paths, false, &meta::default_fetch)?;
            let show = if ctx.args.get("all") == Some(&Flag::Bool(true)) {
                "all"
            } else if ctx.args.get("snapshots") == Some(&Flag::Bool(true)) {
                "snapshot"
            } else {
                "release"
            };
            let limit = if count > usize::MAX as f64 {
                usize::MAX
            } else {
                count as usize
            };
            if quiet {
                let rows: Vec<Value> = versions::shown(&list.versions, show, limit)
                    .into_iter()
                    .map(|v| {
                        spawnloft_lib::client::object(vec![
                            ("id", Some(json!(v.id))),
                            ("type", v.kind_raw.clone()),
                            ("downloaded", Some(json!(v.downloaded))),
                            ("loaders", Some(Value::Object(v.loaders))),
                        ])
                    })
                    .collect();
                emit(ctx, json!({ "offline": list.offline, "versions": rows }));
                return Ok(());
            }
            if let Some(offline) = &list.offline {
                ctx.out.err(&format!("Note: {offline}.\n"));
            }
            ctx.out.line(&spawnloft_lib::text::table(&versions::table_rows(
                &list.versions,
                show,
                limit,
            )));
            ctx.out.line("? means that loader's list could not be read. Make a profile: spawnloft client new <name> --mc <version> --loader <loader>");
            Ok(())
        }
        Some("new") => {
            check_flags(
                ctx.args,
                &[
                    "mc", "loader", "memory", "java", "server", "harness", "account", "json",
                ],
            )?;
            let [name] = rest.as_slice() else {
                return Err(usage());
            };
            let mc = flag_value(ctx.args.get("mc"));
            if !js::truthy(mc.as_ref()) {
                return Err(usage());
            }
            let loader = flag_value(ctx.args.get("loader")).unwrap_or(json!("vanilla"));
            // the version Mojang lists (and its loader builds for) before anything is saved
            let mc = versions::check_profile_version(
                &paths,
                &mc.unwrap_or(Value::Null),
                Some(&loader),
                &meta::default_fetch,
            )?;
            let or_null = |k: &str| flag_value(ctx.args.get(k)).unwrap_or(Value::Null);
            let profile = profiles::create(
                &paths,
                name,
                profiles::NewProfile {
                    mc: json!(mc),
                    loader,
                    loader_version: Value::Null,
                    java: or_null("java"),
                    memory: flag_value(ctx.args.get("memory")).unwrap_or(json!(profiles::DEFAULT_MEMORY)),
                    harness: json!(ctx.args.get("harness") == Some(&Flag::Bool(true))),
                    server: or_null("server"),
                    account: or_null("account"),
                    server_list: true,
                },
            )?;
            if quiet {
                emit(ctx, json!({ "profile": profile.to_json() }));
            } else {
                ctx.out.line(&format!(
                    "Created profile \"{name}\" (Minecraft {}, {}). Launch it: spawnloft client launch {name}",
                    js::string(profile.get("mc")),
                    js::string(profile.get("loader"))
                ));
            }
            Ok(())
        }
        Some("set") => {
            check_flags(ctx.args, &["json"])?;
            if rest.len() < 2 {
                return Err(usage());
            }
            let name = &rest[0];
            let mut patch = serde_json::Map::new();
            for arg in &rest[1..] {
                let Some((key, raw)) = set_arg(arg) else {
                    return Err(usage());
                };
                if !SET_KEYS.contains(&key.as_str()) {
                    return Err(Failure::user(format!(
                        "unknown profile field \"{key}\"; one of {}",
                        SET_KEYS.join(", ")
                    )));
                }
                let value = if matches!(key.as_str(), "harness" | "assistantAccount" | "serverList") {
                    match raw.as_str() {
                        "true" => json!(true),
                        "false" => json!(false),
                        _ => return Err(usage()),
                    }
                } else if matches!(key.as_str(), "loaderVersion" | "java" | "server" | "account")
                    && raw.is_empty()
                {
                    Value::Null
                } else {
                    json!(raw)
                };
                patch.insert(key, value);
            }
            if patch.contains_key("mc") || patch.contains_key("loader") {
                let before = profiles::get(&paths, name)?;
                let mc = patch.get("mc").cloned().or_else(|| before.get("mc").cloned());
                let loader = match patch.get("loader") {
                    Some(l) => Some(l.clone()),
                    None => before.get("loader").cloned(),
                };
                let trimmed = match &mc {
                    Some(Value::String(s)) => js::trim(s).to_string(),
                    None | Some(Value::Null) => {
                        return Err(Failure::type_error(format!(
                            "Cannot read properties of {} (reading 'trim')",
                            if mc.is_none() { "undefined" } else { "null" }
                        )));
                    }
                    Some(_) => return Err(Failure::type_error("mc.trim is not a function")),
                };
                let mc_changed = before.get("mc") != Some(&json!(trimmed));
                if mc_changed || !spawnloft_lib::client::strict_eq(loader.as_ref(), before.get("loader")) {
                    let loader = loader.filter(|l| !l.is_null());
                    versions::check_profile_version(
                        &paths,
                        mc.as_ref().unwrap_or(&Value::Null),
                        loader.as_ref(),
                        &meta::default_fetch,
                    )?;
                }
            }
            let entries: Vec<(String, Value)> = patch.clone().into_iter().collect();
            let profile = profiles::update(&paths, name, entries)?;
            if quiet {
                emit(ctx, json!({ "profile": profile.to_json() }));
            } else {
                let said: Vec<String> = patch
                    .iter()
                    .map(|(k, v)| {
                        if v.is_null() {
                            format!("{k} cleared")
                        } else {
                            format!("{k}={}", js::string(Some(v)))
                        }
                    })
                    .collect();
                ctx.out.line(&format!("Updated \"{name}\": {}", said.join(" ")));
            }
            Ok(())
        }
        // the ownership table sends only the ported subcommands here
        _ => Err(usage()),
    }
}
