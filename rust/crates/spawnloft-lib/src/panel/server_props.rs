//! `handleProps`, `handleRawProps` and `handleIcon` of `ui.mjs`: a server's settings page
//! (server.properties as a form and as text) and its icon.

use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use crate::failure::Failure;
use crate::paths::Roots;
use crate::players::{self, Console};
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{activity, backup, config_files, fsx, js, jspath, plugins, props, supervisor, upgrade};

use super::Panel;
use super::http::{Reply, Request, field};
use super::routes::Routed;

/// The version that turned pvp, allow-nether, spawn-monsters and enable-command-block into game
/// rules kept in the world: from then on a line in the file is ignored.
const GAME_RULES_FROM: &str = "1.21.9";

/// `EDITABLE_PROPS`: the server.properties keys the panel offers, in the page's order and with
/// each row's keys in the order the page receives them. An allowlist: the ports and the RCON
/// password belong to the registry and are rewritten at every launch. `since` is the first
/// version that has a key; `until` the one that made it a game rule.
static EDITABLE_PROPS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let rows = json!([
        {
            "key": "online-mode", "group": "access", "label": "Require a Minecraft account", "type": "bool", "fallback": "true",
            "note": "Off checks nobody's account, so anyone can join under any name. Good for testing by yourself; not safe for a public server. The game also counts everyone as a new player after a switch, so inventories and permissions do not carry over.",
        },
        { "key": "max-players", "group": "access", "label": "Max players", "type": "int", "fallback": "20", "min": 1, "max": 1000,
            "note": "How many can be on at once. More players need more memory and a faster processor." },
        { "key": "white-list", "group": "access", "label": "Whitelist", "type": "bool", "fallback": "false", "note": "Only listed players can join. The list is on the Players page, where people are added by name." },
        { "key": "enforce-whitelist", "group": "access", "label": "Remove players who are not listed", "type": "bool", "fallback": "false", "since": "1.13",
            "note": "With the whitelist on, someone online who is not on the list is removed, not just kept from joining next time. Without this, turning the whitelist on leaves whoever is already playing where they are." },
        { "key": "player-idle-timeout", "group": "access", "label": "Remove idle players after", "type": "int", "fallback": "0", "min": 0, "max": 10080, "unit": "minutes",
            "note": "Minutes a player can do nothing before being removed. 0 never removes anyone." },
        { "key": "hide-online-players", "group": "access", "label": "Hide who is online", "type": "bool", "fallback": "false", "since": "1.18",
            "note": "The server list does not show the names of who is playing." },
        { "key": "op-permission-level", "group": "access", "label": "What operators may do", "type": "int", "fallback": "4", "min": 0, "max": 4,
            "note": "The level a player gets when made an operator, from 0 to 4. 0 adds nothing to what any player can do. 1 can build inside spawn protection. 2 adds cheat commands and command blocks. 3 adds kicking, banning and making operators. 4 adds stopping the server." },

        { "key": "difficulty", "group": "gameplay", "label": "Difficulty", "type": "enum", "fallback": "easy", "options": ["peaceful", "easy", "normal", "hard"],
            "note": "How hard monsters hit, and whether hunger can kill. Peaceful has no monsters, and health comes back by itself." },
        { "key": "gamemode", "group": "gameplay", "label": "Default game mode", "type": "enum", "fallback": "survival", "options": ["survival", "creative", "adventure", "spectator"],
            "note": "The mode a player is in the first time they join. Someone who has played here before keeps the mode they had." },
        { "key": "force-gamemode", "group": "gameplay", "label": "Always join in the default mode", "type": "bool", "fallback": "false",
            "note": "Puts every player back into the default game mode each time they join." },
        { "key": "hardcore", "group": "gameplay", "label": "Hardcore", "type": "bool", "fallback": "false",
            "note": "A player who dies becomes a spectator." },
        { "key": "pvp", "group": "gameplay", "label": "PvP", "type": "bool", "fallback": "true", "until": GAME_RULES_FROM,
            "note": "Whether players can hurt each other." },
        { "key": "allow-flight", "group": "gameplay", "label": "Allow flying in survival", "type": "bool", "fallback": "false",
            "note": "Off removes a survival player the server thinks is flying. That check can catch honest players, so turn this on when a plugin or mod lets people fly." },
        { "key": "spawn-protection", "group": "gameplay", "label": "Spawn protection", "type": "int", "fallback": "16", "min": 0, "max": 256, "unit": "blocks",
            "note": "How many blocks out from the world spawn only operators can build or break. 0 turns it off. It does nothing until the server has at least one operator." },
        { "key": "spawn-monsters", "group": "gameplay", "label": "Monsters", "type": "bool", "fallback": "true", "until": GAME_RULES_FROM,
            "note": "Off stops monsters appearing by themselves." },
        { "key": "allow-nether", "group": "gameplay", "label": "The Nether", "type": "bool", "fallback": "true", "until": GAME_RULES_FROM,
            "note": "Off stops nether portals taking anyone anywhere." },
        { "key": "enable-command-block", "group": "gameplay", "label": "Command blocks", "type": "bool", "fallback": "false", "until": GAME_RULES_FROM,
            "note": "Lets command blocks run their commands." },

        { "key": "motd", "group": "world", "label": "Message of the day", "type": "text", "fallback": "A Minecraft Server" },
        { "key": "view-distance", "group": "world", "label": "View distance", "type": "int", "fallback": "10", "min": 2, "max": 32, "unit": "chunks",
            "note": "How far each player can see, in chunks of 16 blocks. Every step up sends and keeps more of the world per player, which costs memory and processor time." },
        { "key": "simulation-distance", "group": "world", "label": "Simulation distance", "type": "int", "fallback": "10", "min": 3, "max": 32, "unit": "chunks", "since": "1.18",
            "note": "How far from a player the world keeps going, in chunks: mobs move, crops grow and redstone runs inside it. Lower is lighter on the server, and farms further away than this stand still." },
        { "key": "level-seed", "group": "world", "label": "World seed", "type": "text", "fallback": "",
            "note": "Used when a world is made; empty picks one at random. Changing it does nothing to a world that already exists, only to one made after." },
        { "key": "max-world-size", "group": "world", "label": "World size limit", "type": "int", "fallback": "29999984", "min": 1, "max": 29999984, "unit": "blocks",
            "note": "How far from the centre the world may reach, in blocks." },
        { "key": "resource-pack", "group": "world", "label": "Resource pack", "type": "url", "fallback": "",
            "note": "A direct download link to a resource pack .zip, offered to players when they join. Empty for none." },
        { "key": "require-resource-pack", "group": "world", "label": "Require the resource pack", "type": "bool", "fallback": "false", "since": "1.17",
            "note": "A player who turns the pack down is disconnected." },
    ]);
    match rows {
        Value::Array(rows) => rows,
        _ => unreachable!("a list"),
    }
});

/// `PROP_GROUPS`: the page's sections. A field with no group here still renders, at the end.
fn prop_groups() -> Value {
    json!([
        { "key": "access", "icon": "user", "title": "Who can join",
            "blurb": "Identity, the whitelist, and how many people at once." },
        { "key": "gameplay", "icon": "play", "title": "Gameplay",
            "blurb": "The rules the world is played by." },
        { "key": "world", "icon": "server", "title": "World and load",
            "blurb": "What players see before they join, and how much the server draws for them." },
    ])
}

/// `INSTANCE_SETTING_LABELS`: a server's own settings under the names the Settings page gives
/// them.
const INSTANCE_SETTING_LABELS: [(&str, &str); 7] = [
    ("memory", "Memory"),
    ("port", "Port"),
    ("java", "Java"),
    ("jar", "Server file"),
    ("label", "Display name"),
    ("autoRestart", "Restart it automatically"),
    ("autoStart", "Start with this computer"),
];

fn text_of<'a>(spec: &'a Value, key: &str) -> &'a str {
    spec.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `settingWords(key, value)`: a changed setting for the Activity list, under the name the
/// Settings page gives it ("Difficulty: hard", not the file's "difficulty = hard"). `value` is
/// `None` for `undefined`. Also used by a server's settings route.
pub fn setting_words(key: &str, value: Option<&Value>) -> String {
    let label = EDITABLE_PROPS
        .iter()
        .find(|p| text_of(p, "key") == key)
        .map(|p| text_of(p, "label"))
        .or_else(|| {
            INSTANCE_SETTING_LABELS
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, l)| *l)
        })
        .unwrap_or(key);
    let said = match value {
        Some(Value::Bool(true)) => "on".to_string(),
        Some(Value::String(s)) if s == "true" => "on".to_string(),
        Some(Value::Bool(false)) => "off".to_string(),
        Some(Value::String(s)) if s == "false" => "off".to_string(),
        None | Some(Value::Null) => "cleared".to_string(),
        Some(Value::String(s)) if s.is_empty() => "cleared".to_string(),
        v => js::string(v),
    };
    format!("{label}: {said}")
}

/// 1.21.9-rc1 and 26.1-snapshot-2 are read as the release they lead to; an old weekly name
/// (24w14a) says nothing about where it sits.
static RELEASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+(?:\.[0-9]+)+)(?:[-_ +][^\n\r\u{2028}\u{2029}]*)?$").expect("a valid pattern")
});

/// `propsFor(mcVersion)`: the rows a server of this version is shown. Rows it does not have yet
/// are left out and rows that became game rules are marked; with no version known, every row is
/// offered as the file's.
pub fn props_for(mc_version: Option<&str>) -> Vec<Value> {
    let version = mc_version
        .and_then(|v| RELEASE.captures(js::trim(v)))
        .map(|c| c[1].to_string());
    let mut out = Vec::new();
    for spec in EDITABLE_PROPS.iter() {
        let since = spec.get("since").and_then(Value::as_str);
        let until = spec.get("until").and_then(Value::as_str);
        if let (Some(v), Some(s)) = (&version, since)
            && upgrade::compare_mc_versions(v, s) < 0
        {
            continue;
        }
        let mut row = spec.clone();
        if let (Some(v), Some(u)) = (&version, until)
            && upgrade::compare_mc_versions(v, u) >= 0
            && let Value::Object(m) = &mut row
        {
            m.insert("gameRule".into(), json!(true));
        }
        out.push(row);
    }
    out
}

/// `unescapedProp(value)`: a value as the person wrote it, from the way Minecraft saved it
/// (`https\://x/p.zip?v\=2`).
pub fn unescaped_prop(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && matches!(next, ':' | '=' | '#' | '!' | ' ')
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

/// Links and the seed are shown as the person wrote them.
fn plain_shown(spec: &Value) -> bool {
    text_of(spec, "type") == "url" || text_of(spec, "key") == "level-seed"
}

/// `assertNoBrokenEscape(key, value)`: Minecraft reads the file with Java's Properties, where a
/// backslash at the end of a value joins the next line onto it, and `\u` wants four hex digits
/// or the file fails to load.
fn assert_no_broken_escape(key: &str, value: &str) -> Result<(), Failure> {
    let trailing = value.chars().rev().take_while(|c| *c == '\\').count();
    if trailing % 2 == 1 {
        return Err(Failure::user(format!(
            "{key} cannot end with a backslash: Minecraft would read the next line of the file as part of it"
        )));
    }
    let chars: Vec<char> = value.chars().collect();
    for i in 0..chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'u') {
            let hex = chars
                .get(i + 2..i + 6)
                .is_some_and(|h| h.iter().all(char::is_ascii_hexdigit));
            if !hex {
                return Err(Failure::user(format!(
                    "{key} has \\u without four hex digits after it, which Minecraft cannot read"
                )));
            }
        }
    }
    Ok(())
}

/// `/^https?:\/\/[^\s/]+(\/\S*)?$/i` for a value with no whitespace in it.
fn is_link(value: &str) -> bool {
    let rest = ["http://", "https://"].iter().find_map(|scheme| {
        value
            .get(..scheme.len())
            .filter(|head| head.eq_ignore_ascii_case(scheme))
            .map(|_| &value[scheme.len()..])
    });
    rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/'))
}

/// `coerceProp(spec, raw)`: the value as the file gets it, or why not.
fn coerce_prop(spec: &Value, raw: &Value) -> Result<String, Failure> {
    let value = js::trim(&js::string(Some(raw))).to_string();
    let key = text_of(spec, "key");
    match text_of(spec, "type") {
        "url" => {
            // one line of the file, and a link the game will fetch: http or https, or empty
            if value.is_empty() {
                return Ok(value);
            }
            if value.chars().any(|c| js::is_js_space(c) || c == '\\') || !is_link(&value) {
                return Err(Failure::user(format!(
                    "{key} must be a link starting with http:// or https://, or empty"
                )));
            }
            Ok(value)
        }
        "bool" => {
            if value != "true" && value != "false" {
                return Err(Failure::user(format!("{key} must be true or false")));
            }
            Ok(value)
        }
        "enum" => {
            let options: Vec<&str> = spec
                .get("options")
                .and_then(Value::as_array)
                .map(|o| o.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if !options.contains(&value.as_str()) {
                return Err(Failure::user(format!(
                    "{key} must be one of: {}",
                    options.join(", ")
                )));
            }
            Ok(value)
        }
        "int" => {
            let n = js::string_to_number(&value);
            let min = js::number(spec.get("min"));
            let max = js::number(spec.get("max"));
            if !n.is_finite() || n.fract() != 0.0 || n < min || n > max {
                return Err(Failure::user(format!(
                    "{key} must be a whole number from {} to {}",
                    js::string(spec.get("min")),
                    js::string(spec.get("max"))
                )));
            }
            Ok(js::number_to_string(n))
        }
        _ => {
            // a newline would split the line and make a second key
            if value.contains(['\r', '\n']) {
                return Err(Failure::user(format!("{key} cannot contain a line break")));
            }
            assert_no_broken_escape(key, &value)?;
            Ok(value)
        }
    }
}

/// Settings forms and the raw editor read the file, change it and write it back; two of them at
/// once must not lose one of the changes.
static PROPS_LOCK: Mutex<()> = Mutex::new(());

fn instance(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    registry::lookup(Path::new(&layout.registry_file), name)
}

fn record(layout: &Layout, name: &str, action: &str, detail: &str, snapshot: Option<&str>) {
    activity::record_by(
        &Roots::new(&layout.data_root),
        &Panel::actor(),
        name,
        action,
        Some(detail),
        snapshot,
        true,
    );
}

/// `/api/instances/<name>/props...` and `/api/instances/<name>/icon...`; `req.seg(3)` is `props` or `icon`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    let reply = match (req.seg(3), req.seg(4)) {
        (Some("props"), Some("raw")) => raw_props(layout, req, name)?,
        (Some("props"), _) => settings_page(layout, req, name)?,
        _ => icon(layout, req, name)?,
    };
    Ok(Routed::Reply(reply))
}

/// The rows offered, each with the file's value (or the default, flagged as not set: a server
/// that has never booted lacks most keys).
fn shape(offered: &[Value], current: &props::Props) -> Value {
    let rows = offered
        .iter()
        .map(|spec| {
            let key = text_of(spec, "key");
            let mut row: Map<String, Value> = spec.as_object().cloned().unwrap_or_default();
            let value = match props::get(current, key) {
                Some(v) if plain_shown(spec) => json!(unescaped_prop(v)),
                Some(v) => json!(v),
                None => spec.get("fallback").cloned().unwrap_or(Value::Null),
            };
            row.insert("value".into(), value);
            row.insert("set".into(), json!(current.contains_key(key)));
            Value::Object(row)
        })
        .collect();
    Value::Array(rows)
}

/// `handleProps`: server.properties as the settings form.
fn settings_page(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = instance(layout, name)?;
    let dir = backup::dir_of(&inst)?;
    let file = jspath::join(&[&dir, "server.properties"]);
    let offered = props_for(plugins::mc_version_of(&inst).as_deref());

    if req.method == "GET" {
        // stored players let the page warn before online-mode changes: switching gives everyone
        // a different identity
        return Ok(Reply::ok(json!({
            "fields": shape(&offered, &props::read(Path::new(&file))?),
            "groups": prop_groups(),
            "file": file,
            "players": players::stored_players(Path::new(&dir))?,
        })));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    // Object.entries(body): a string or a list has entries named 0, 1, ...; other values none
    let entries: Vec<(String, Value)> = match &body {
        Value::Null => return Err(Failure::type_error("Cannot convert undefined or null to object")),
        Value::Object(m) => {
            let (mut index, named): (Vec<_>, Vec<_>) = m
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .partition(|(k, _)| crate::jsjson::is_index_key(k));
            index.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
            index.extend(named);
            index
        }
        Value::String(s) if !s.is_empty() => vec![("0".into(), Value::Null)],
        Value::Array(a) if !a.is_empty() => vec![("0".into(), Value::Null)],
        _ => Vec::new(),
    };
    let mut updates: Vec<(String, String)> = Vec::new();
    // A game rule, sent by a form drawn before the server moved to a version that made it one:
    // written, it would sit in the file and change nothing. It is left out and said to be, and
    // the settings sent with it are still saved.
    let mut ignored: Vec<Value> = Vec::new();
    for (key, raw) in &entries {
        let Some(spec) = offered.iter().find(|p| text_of(p, "key") == key) else {
            return Ok(Reply::error(400, format!("{key} is not editable from here")));
        };
        if spec.get("gameRule") == Some(&Value::Bool(true)) {
            ignored.push(json!({ "key": key, "label": spec.get("label") }));
            continue;
        }
        updates.push((key.clone(), coerce_prop(spec, raw)?));
    }
    let _held = PROPS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if updates.is_empty() {
        if !ignored.is_empty() {
            return Ok(Reply::ok(json!({
                "changed": [],
                "ignored": ignored,
                "appliesOnRestart": false,
                "fields": shape(&offered, &props::read(Path::new(&file))?),
            })));
        }
        return Ok(Reply::error(400, "nothing to change"));
    }

    // The whitelist is the one setting here a running server can be told about, and the Players
    // page shows this file as the state: written alone, the page said On while anyone could join.
    if let Some((_, on)) = updates.iter().find(|(k, _)| k == "white-list")
        && supervisor::is_running(layout, name)?
    {
        let exec = |command: &str| players::rcon_command(&inst, command);
        let console = Console {
            running: true,
            exec: &exec,
        };
        // the file is still written below, for the next start
        let _ = players::set_whitelist_on(Path::new(&dir), on == "true", &console);
    }
    props::write(Path::new(&file), &updates)?;
    let detail: Vec<String> = updates
        .iter()
        .map(|(k, v)| setting_words(k, Some(&json!(v))))
        .collect();
    record(layout, name, "settings", &detail.join(", "), None);
    Ok(Reply::ok(json!({
        "changed": updates.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        "ignored": ignored,
        "appliesOnRestart": supervisor::is_running(layout, name)?,
        "fields": shape(&offered, &props::read(Path::new(&file))?),
    })))
}

/// `handleRawProps`: the raw server.properties editor, the same path as the assistant's
/// write_config_file. Hidden values (the RCON password) are put back from disk on save, port and
/// RCON changes are refused, and the file is copied first.
fn raw_props(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = instance(layout, name)?;
    if req.method == "GET" {
        let out = config_files::read_config_file(&inst, Some("server.properties"))?;
        return Ok(Reply::ok(json!({ "text": out.text, "redacted": out.redacted })));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let Some(Value::String(text)) = field(&body, "text")? else {
        return Ok(Reply::error(400, "text is required"));
    };
    let _held = PROPS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let resolved = config_files::resolve_config_path(&inst, Some("server.properties"), true)?;
    let before_bytes = std::fs::read(&resolved.full).map_err(|e| Failure::read(&e, &resolved.full))?;
    let before = String::from_utf8_lossy(&before_bytes);
    let plan = config_files::plan_config_write(
        &inst,
        Some(&resolved.shown),
        &config_files::WriteAsk {
            content: Some(json!(config_files::restore_hidden(&before, text)?)),
            hidden_restored: true,
            ..Default::default()
        },
    )?;
    let snap = backup::create_snapshot(
        layout,
        &Panel::actor(),
        &inst,
        &backup::Options {
            scope: "config".into(),
            label: json!("before-edit"),
            members: Some(vec![plan.shown.clone()]),
            flush: false,
            change_copy: true,
            ..Default::default()
        },
    )?;
    // the server may have rewritten its properties while the copy was taken
    if !config_files::unchanged_since(&plan)? {
        return Err(Failure::user(
            "server.properties changed while it was being snapshotted; reload it and try again",
        ));
    }
    config_files::apply_config_write(&plan)?;
    let snapshot = jspath::basename(&snap.file);
    record(layout, name, "config-edit", "server.properties", Some(&snapshot));
    Ok(Reply::ok(json!({
        "snapshot": snapshot,
        "appliesOnRestart": supervisor::is_running(layout, name)?,
        "diff": config_files::summarize_change(plan.before.as_deref(), &plan.after, 40),
    })))
}

/// `Buffer.from(text, 'base64')`: each UTF-16 unit read as its low byte, both alphabets, what is
/// not base64 skipped, the first `=` ending it, and bits past the last whole byte dropped.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for unit in text.encode_utf16() {
        let c = (unit & 0xff) as u8;
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// `handleIcon`: server-icon.png. Minecraft ignores it unless it is a 64x64 PNG; the page scales
/// a picture before sending it.
fn icon(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = instance(layout, name)?;
    let file = jspath::join(&[&backup::dir_of(&inst)?, "server-icon.png"]);
    if req.method == "GET" {
        let Ok(bytes) = std::fs::read(&file) else {
            return Ok(Reply::error(404, "no icon"));
        };
        return Ok(Reply::Bytes {
            status: 200,
            headers: vec![
                ("Content-Type".into(), "image/png".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            body: bytes,
        });
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    if req.seg(4) == Some("remove") {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if jspath::is_enoent(&e) => {}
            Err(e) => return Err(Failure::io(&e, "rm", Some(Path::new(&file)))),
        }
        record(layout, name, "settings", "server icon removed", None);
        return Ok(Reply::ok(json!({ "icon": false })));
    }
    let body = req.json()?;
    let sent = match field(&body, "png")? {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    };
    let png = node_base64(sent.strip_prefix("data:image/png;base64,").unwrap_or(&sent));
    if png.len() <= 24 || png[..8] != PNG_SIGNATURE {
        return Ok(Reply::error(400, "the icon must be a PNG image"));
    }
    let be = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
    if be(16) != 64 || be(20) != 64 {
        return Ok(Reply::error(400, "the icon must be 64 by 64 pixels"));
    }
    if png.len() > 256 * 1024 {
        return Ok(Reply::error(400, "that icon is too large"));
    }
    let tmp = format!("{file}.{}.tmp", std::process::id());
    std::fs::write(&tmp, &png).map_err(|e| Failure::io(&e, "open", Some(Path::new(&tmp))))?;
    fsx::rename_over(Path::new(&tmp), Path::new(&file))
        .map_err(|e| fsx::rename_failure(&e, Path::new(&tmp), Path::new(&file)))?;
    record(layout, name, "settings", "server icon changed", None);
    Ok(Reply::ok(json!({
        "icon": true,
        "appliesOnRestart": supervisor::is_running(layout, name)?,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_follow_the_version() {
        let keys = |v: Option<&str>| -> Vec<String> {
            props_for(v)
                .iter()
                .map(|r| text_of(r, "key").to_string())
                .collect()
        };
        assert_eq!(keys(None).len(), EDITABLE_PROPS.len());
        assert_eq!(keys(Some("24w14a")).len(), EDITABLE_PROPS.len());
        let old = keys(Some("1.12.2"));
        assert!(!old.contains(&"enforce-whitelist".to_string()));
        assert!(!old.contains(&"simulation-distance".to_string()));
        assert!(keys(Some(" 1.18-pre1 ")).contains(&"simulation-distance".to_string()));
        let rules = |v: &str| -> Vec<String> {
            props_for(Some(v))
                .iter()
                .filter(|r| r.get("gameRule").is_some())
                .map(|r| text_of(r, "key").to_string())
                .collect()
        };
        assert_eq!(
            rules("1.21.9-rc1"),
            ["pvp", "spawn-monsters", "allow-nether", "enable-command-block"]
        );
        assert!(rules("1.21.8").is_empty());
        assert!(rules("1.21.9\nx").is_empty());
        // the mark comes after the row's own keys
        let pvp = props_for(Some("26.1"))
            .into_iter()
            .find(|r| text_of(r, "key") == "pvp")
            .unwrap();
        let order: Vec<&String> = pvp.as_object().unwrap().keys().collect();
        assert_eq!(order.last().unwrap().as_str(), "gameRule");
    }

    #[test]
    fn values_are_coerced_as_the_page_expects() {
        let spec = |k: &str| EDITABLE_PROPS.iter().find(|p| text_of(p, "key") == k).unwrap();
        let ok = |k: &str, v: Value| coerce_prop(spec(k), &v).unwrap();
        let no = |k: &str, v: Value| coerce_prop(spec(k), &v).unwrap_err().message().to_string();
        assert_eq!(ok("max-players", json!(" 1e1 ")), "10");
        assert_eq!(ok("max-players", json!(20)), "20");
        assert_eq!(ok("player-idle-timeout", json!("")), "0");
        assert_eq!(ok("player-idle-timeout", json!("-0")), "0");
        assert_eq!(ok("spawn-protection", json!("0x10")), "16");
        assert_eq!(
            no("max-players", json!("1.5")),
            "max-players must be a whole number from 1 to 1000"
        );
        assert_eq!(ok("white-list", json!(true)), "true");
        assert_eq!(no("white-list", json!("yes")), "white-list must be true or false");
        assert_eq!(
            no("difficulty", json!("HARD")),
            "difficulty must be one of: peaceful, easy, normal, hard"
        );
        assert_eq!(ok("resource-pack", json!(" ")), "");
        assert_eq!(
            ok("resource-pack", json!("HTTPS://x/p.zip?v=2")),
            "HTTPS://x/p.zip?v=2"
        );
        for bad in [
            "ftp://x",
            "http:///x",
            "http://",
            "https://a b",
            "https://a\\b",
            "https://a\u{a0}b",
        ] {
            assert_eq!(
                no("resource-pack", json!(bad)),
                "resource-pack must be a link starting with http:// or https://, or empty",
                "{bad}"
            );
        }
        assert_eq!(ok("motd", json!({ "a": 1 })), "[object Object]");
        assert_eq!(no("motd", json!("a\nb")), "motd cannot contain a line break");
        assert_eq!(
            no("motd", json!("a\\")),
            "motd cannot end with a backslash: Minecraft would read the next line of the file as part of it"
        );
        assert_eq!(ok("motd", json!("a\\\\")), "a\\\\");
        assert_eq!(
            no("motd", json!("\\u12g4")),
            "motd has \\u without four hex digits after it, which Minecraft cannot read"
        );
        assert_eq!(ok("motd", json!("\\u00A7a")), "\\u00A7a");
    }

    #[test]
    fn saved_escapes_are_shown_as_written() {
        assert_eq!(unescaped_prop("https\\://x/p.zip?v\\=2"), "https://x/p.zip?v=2");
        assert_eq!(unescaped_prop("a\\\\:b\\n\\"), "a\\:b\\n\\");
    }

    #[test]
    fn setting_words_name_the_setting() {
        assert_eq!(
            setting_words("difficulty", Some(&json!("hard"))),
            "Difficulty: hard"
        );
        assert_eq!(setting_words("white-list", Some(&json!("true"))), "Whitelist: on");
        assert_eq!(
            setting_words("autoStart", Some(&json!(false))),
            "Start with this computer: off"
        );
        assert_eq!(setting_words("label", Some(&json!(""))), "Display name: cleared");
        assert_eq!(setting_words("java", None), "Java: cleared");
        assert_eq!(setting_words("java", Some(&Value::Null)), "Java: cleared");
        assert_eq!(setting_words("other", Some(&json!(3))), "other: 3");
    }

    #[test]
    fn base64_is_read_as_buffer_from_reads_it() {
        let hex = |s: &str| -> String { node_base64(s).iter().map(|b| format!("{b:02x}")).collect() };
        for (text, want) in [
            ("QUJD", "414243"),
            ("QU JD", "414243"),
            ("QU*JD", "414243"),
            ("QUI=QUJD", "4142"),
            ("QUJ", "4142"),
            ("Q", ""),
            ("-_-_", "fbffbf"),
            ("QU=JD", "41"),
            ("QU\u{e9}JD", "414243"),
            ("QU\u{141}JD", "414009"),
            ("QU\u{4e00}JD", "414243"),
        ] {
            assert_eq!(hex(text), want, "{text}");
        }
    }
}
