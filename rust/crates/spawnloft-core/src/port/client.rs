//! `client` (C7): `cmdClient` in mcctl.mjs, over spawnloft-lib's `client`. The ownership table
//! sends a subcommand here once it is ported (`cli::CLIENT_PORTED`); the rest stay with the
//! Node core until the whole command flips.

use serde_json::{Value, json};

use spawnloft_lib::client::paths::Paths;
use spawnloft_lib::client::{accounts, log, profiles, prop, state};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::js;

use super::args::Flag;
use super::output::json_line;
use super::{Ctx, check_flags};

pub const USAGE: &str = "Usage: spawnloft client list | client versions [--snapshots | --all] [-n 30] | client new <name> --mc <v> [--loader vanilla|fabric|quilt|forge|neoforge] [--memory 2G] [--java <path>] [--server <server>] [--harness] | client set <name> key=value ... | client remove <name> [--purge] | client install <name> [--verify] | client launch <name> [--as <playerName>] [--account <account>] [--server <server>] [--wait] | client status <name> | client stop <name> | client logs <name> [-n 100] [--latest] | client login | client logout <name> | client accounts";

fn usage() -> Failure {
    Failure::usage(USAGE)
}

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
                None => accounts::public(&list[at]),
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
            let list: Vec<Value> = accounts::load(&paths)?.iter().map(accounts::public).collect();
            let default = profiles::default_account(&paths)?;
            if quiet {
                emit(ctx, json!({ "accounts": list, "defaultAccount": default }));
            } else if list.is_empty() {
                ctx.out
                    .line("No Microsoft account is signed in. Sign in: spawnloft client login");
            } else {
                for a in &list {
                    let is_default = default
                        .as_ref()
                        .is_some_and(|d| accounts::same_uuid(a.get("uuid"), Some(&json!(d))));
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
        // the ownership table sends only the ported subcommands here
        _ => Err(usage()),
    }
}
