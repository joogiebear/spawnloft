//! `handlePlayers` of `ui.mjs`: a server's players (online, known, ops, whitelist, bans).
//!
//! Writes go through `players`: whether a change belongs in a file or down the console depends
//! on whether the server is running, and getting it wrong only shows after the next restart.

use std::path::Path;

use serde_json::{Value, json};

use crate::failure::Failure;
use crate::paths::Roots;
use crate::settings::Layout;
use crate::{activity, control, js, players, registry, supervisor};

use super::Panel;
use super::http::{Reply, Request, field};
use super::routes::Routed;
use super::shared::{safe_instance, status_row};

/// `/api/instances/<name>/players...`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    reply(layout, req, name).map(Routed::Reply)
}

/// `out.took !== false`: a change the server did not say it refused.
fn took(out: &Value) -> bool {
    out.get("took") != Some(&Value::Bool(false))
}

fn reply(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let dir_text = registry::dir_text(&inst)?;
    let dir = Path::new(&dir_text);
    let verb = req.seg(4).map(str::to_string);
    let running = supervisor::is_running(layout, name)?;
    let exec = |command: &str| players::rcon_command(&inst, command);
    let console = players::Console { running, exec: &exec };

    if req.method == "GET" {
        let here: Vec<String> = players::online_now(&console)
            .iter()
            .map(|n| n.to_lowercase())
            .collect();
        let rows: Vec<Value> = players::list_players(dir)?
            .into_iter()
            .map(|p| {
                let online = p
                    .name
                    .as_str()
                    .is_some_and(|n| !n.is_empty() && here.contains(&n.to_lowercase()));
                let mut row = p.to_json();
                // the player .dat isn't written until logout or a world save
                row["joined"] = json!(p.joined || online);
                row["online"] = json!(online);
                row
            })
            .collect();
        let shown = safe_instance(&status_row(layout, name)?)?;
        return Ok(Reply::ok(json!({
            "players": rows,
            "running": supervisor::is_running(layout, name)?,
            // names can only be recovered in online mode
            "onlineMode": shown.get("onlineMode").cloned().unwrap_or(Value::Null),
            "whitelistOn": players::whitelist_on(dir)?,
            "whitelistEnforced": players::whitelist_enforced(dir)?,
        })));
    }
    if req.method != "POST" {
        return Ok(Reply::error(405, "method not allowed"));
    }

    let body = req.json()?;
    let verb = verb.as_deref();
    // Starting, stopping or out of reach: the server owns its files and cannot be asked. A change
    // written now would be ignored, and then written over when the server saves its own lists.
    if verb != Some("forget")
        && control::is_active_status(supervisor::read_state(layout, name)?.0)
        && !running
    {
        return Ok(Reply::error(
            409,
            "This server is starting, stopping or out of reach, so its player lists cannot be changed right now. Try again once it is running or stopped.",
        ));
    }
    let roots = Roots::new(&layout.data_root);
    let record = |action: &str, detail: Option<&str>| {
        activity::record_by(&roots, &Panel::actor(), name, action, detail, None, true);
    };
    // `String(reason || '')`, and the reason as history words it
    let reason_of = |body: &Value| -> Result<Option<String>, Failure> {
        Ok(field(body, "reason")?
            .filter(|v| js::truthy(Some(v)))
            .map(|v| js::string(Some(v))))
    };

    // the switch: whether only listed players can join
    if verb == Some("whitelist-mode") {
        // said outright: a request that left it out would otherwise lock everyone out
        let Some(Value::Bool(on)) = field(&body, "on")? else {
            return Ok(Reply::error(400, "on or off?"));
        };
        let out = players::set_whitelist_on(dir, *on, &console)?;
        if took(&out) {
            record(if *on { "whitelist-on" } else { "whitelist-off" }, None);
        }
        return Ok(Reply::ok(out));
    }
    // someone by name, who may never have joined
    if verb == Some("add") {
        let text = |key: &str| -> Result<String, Failure> {
            Ok(match field(&body, key)? {
                None | Some(Value::Null) => String::new(),
                Some(v) => js::string(Some(v)),
            })
        };
        let (raw_name, add_as) = (text("name")?, text("as")?);
        let reason = reason_of(&body)?;
        let lookup = |n: &str| players::mojang_lookup(n, &players::get_url);
        let out = players::add_by_name(
            dir,
            &raw_name,
            &add_as,
            reason.as_deref().unwrap_or(""),
            &console,
            &lookup,
        )?;
        let added_as = out.get("as").and_then(Value::as_str).unwrap_or("");
        let action = match added_as {
            "whitelist" => "player-whitelist",
            "op" => "player-op",
            _ => "player-ban",
        };
        if took(&out) {
            let mut detail = js::string(out.get("name"));
            if let Some(why) = reason.as_deref().filter(|_| added_as == "ban") {
                detail.push_str(&format!(": {why}"));
            }
            record(action, Some(&detail));
        }
        return Ok(Reply::ok(out));
    }
    let Some(uuid) = field(&body, "uuid")?.filter(|v| js::truthy(Some(v))) else {
        return Ok(Reply::error(400, "which player?"));
    };
    let uuid = js::string(Some(uuid));
    // `body.on !== false`
    let on = field(&body, "on")? != Some(&Value::Bool(false));

    // the name history gives a player: as the lists have it now, else the id
    let who = || -> Result<String, Failure> {
        Ok(players::list_players(dir)?
            .into_iter()
            .find(|p| p.uuid == uuid)
            .and_then(|p| match p.name {
                Value::Null => None,
                v => Some(js::string(Some(&v))),
            })
            .unwrap_or_else(|| uuid.clone()))
    };
    match verb {
        Some("op") => {
            let out = players::set_op(name, dir, &uuid, on, &console)?;
            if took(&out) {
                record(if on { "player-op" } else { "player-deop" }, Some(&who()?));
            }
            Ok(Reply::ok(out))
        }
        Some("ban") => {
            let reason = reason_of(&body)?;
            let out = players::set_ban(name, dir, &uuid, on, reason.as_deref().unwrap_or(""), &console)?;
            if took(&out) {
                let mut detail = who()?;
                if let Some(why) = reason.as_deref().filter(|_| on) {
                    detail.push_str(&format!(": {why}"));
                }
                record(if on { "player-ban" } else { "player-unban" }, Some(&detail));
            }
            Ok(Reply::ok(out))
        }
        Some("whitelist") => {
            let out = players::set_whitelisted(name, dir, &uuid, on, &console)?;
            if took(&out) {
                record(
                    if on {
                        "player-whitelist"
                    } else {
                        "player-unwhitelist"
                    },
                    Some(&who()?),
                );
            }
            Ok(Reply::ok(out))
        }
        Some("forget") => {
            let out = players::forget_player(name, dir, &uuid, supervisor::is_running(layout, name)?)?;
            let detail = match out.get("name") {
                None | Some(Value::Null) => uuid.clone(),
                Some(v) => js::string(Some(v)),
            };
            record("player-forget", Some(&detail));
            Ok(Reply::ok(out))
        }
        _ => Ok(Reply::not_found()),
    }
}
