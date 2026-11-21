//! players.mjs: the players a server knows about (ops, bans, the whitelist, the name cache and the
//! world's player files, joined by UUID) and the changes the panel and MCP make to them. A
//! running server is told through its console, since it keeps these lists in memory and writes
//! them over the files; a stopped one has only the files. No command calls these; the panel (C8)
//! and MCP (C9) will. test/fixtures/contracts/c6-library.json holds Node's answers.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::js;

/// `<uuid>.dat` or `.json`; group 3 is the version digit (4 online, 3 offline). Case spelled out
/// rather than `(?i)`, which folds non-ASCII letters (`ſ` to `s`) that JavaScript's does not.
static UUID_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F])([0-9a-fA-F]{3})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})\.([dD][aA][tT]|[jJ][sS][oO][nN])$",
    )
    .unwrap()
});

static PLAYER_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_]{1,16}$").unwrap());

/// What a console command cannot take as a name: `@` first (a selector), JavaScript's `\s`, or a
/// control character.
static NOT_FOR_CONSOLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^@|[{}\x00-\x1f\x7f]", crate::mclogs::JS_SPACE)).unwrap());

static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{}]+", crate::mclogs::JS_SPACE)).unwrap());

const NIL_UUID: &str = "00000000-0000-0000-0000-000000000000";
pub const OPS: &str = "ops.json";
pub const BANNED: &str = "banned-players.json";
pub const WHITELIST: &str = "whitelist.json";
pub const USERCACHE: &str = "usercache.json";
const BAN_SOURCE: &str = "mcctl";

/// A server's console, or a test's stand-in: whether it runs, and one command's reply.
pub struct Console<'a> {
    pub running: bool,
    pub exec: &'a dyn Fn(&str) -> Result<String, Failure>,
}

impl std::fmt::Debug for Console<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Console")
            .field("running", &self.running)
            .finish_non_exhaustive()
    }
}

/// `rconExec(inst, [command])`: the first reply, or the error as Node throws it.
pub fn rcon_command(inst: &crate::registry::Instance, command: &str) -> Result<String, Failure> {
    crate::rcon::exec(inst, &[command], crate::rcon::ExecOptions::default())
        .map(|r| r.into_iter().next().unwrap_or_default())
        .map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: e.message,
            code: None,
        })
}

/// `supervisor.isRunning(name)`, for the callers that build a [`Console`].
pub fn is_running(layout: &crate::settings::Layout, name: &str) -> Result<bool, Failure> {
    crate::supervisor::is_running(layout, name)
}

fn props_of(dir: &Path) -> Result<crate::props::Props, Failure> {
    crate::props::read(&dir.join("server.properties"))
}

fn level_of(dir: &Path) -> Result<String, Failure> {
    let props = props_of(dir)?;
    Ok(crate::props::get(&props, "level-name")
        .filter(|l| !l.is_empty())
        .unwrap_or("world")
        .to_string())
}

/// `playerDirs(instDir, level)`, joined as `path.join` joins: an absolute or `..` level name stays
/// inside the server folder's text, as in Node, rather than replacing it.
fn player_dirs(dir: &Path, level: &str) -> Vec<PathBuf> {
    let d = dir.to_string_lossy();
    let at = |parts: &[&str]| {
        let mut all = vec![d.as_ref(), level];
        all.extend_from_slice(parts);
        PathBuf::from(crate::jspath::join(&all))
    };
    vec![
        at(&["players", "data"]),
        at(&["players", "stats"]),
        at(&["players", "advancements"]),
        at(&["playerdata"]),
        at(&["stats"]),
        at(&["advancements"]),
    ]
}

/// `readList(dir, file)`: the rows, or none when the file is absent or not a JSON list.
fn read_list(dir: &Path, file: &str) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(dir.join(file)) else {
        return Vec::new();
    };
    match crate::jsjson::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

/// `row.<key>`: a row that is `null` throws as JavaScript does.
fn get<'a>(row: &'a Value, key: &str) -> Result<Option<&'a Value>, Failure> {
    match row {
        Value::Null => Err(Failure::Internal {
            head: "TypeError".into(),
            message: format!("Cannot read properties of null (reading '{key}')"),
            code: None,
        }),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `String(v)`, with `undefined` for a missing field.
fn string_of(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        v => js::string(v),
    }
}

/// `x || null`.
fn or_null(v: Option<&Value>) -> Value {
    if js::truthy(v) {
        v.cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

/// One player, as `listPlayers` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Player {
    pub uuid: String,
    /// The name the files give, as they give it (a string in every file Minecraft writes).
    pub name: Value,
    pub op: bool,
    pub op_level: Value,
    pub banned: bool,
    pub ban_reason: Value,
    pub ban_source: Value,
    pub ban_expires: Value,
    pub whitelisted: bool,
    pub joined: bool,
    pub last_seen: Option<String>,
}

impl Player {
    fn new(uuid: String) -> Player {
        Player {
            uuid,
            name: Value::Null,
            op: false,
            op_level: Value::Null,
            banned: false,
            ban_reason: Value::Null,
            ban_source: Value::Null,
            ban_expires: Value::Null,
            whitelisted: false,
            joined: false,
            last_seen: None,
        }
    }

    fn has_name(&self) -> bool {
        js::truthy(Some(&self.name))
    }

    /// The name as text, empty when there is none (`who.name || ''`).
    pub fn name_text(&self) -> String {
        if self.has_name() {
            js::string(Some(&self.name))
        } else {
            String::new()
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "uuid": self.uuid,
            "name": self.name,
            "op": self.op,
            "opLevel": self.op_level,
            "banned": self.banned,
            "banReason": self.ban_reason,
            "banSource": self.ban_source,
            "banExpires": self.ban_expires,
            "whitelisted": self.whitelisted,
            "joined": self.joined,
            "lastSeen": self.last_seen,
        })
    }
}

/// `listPlayers(inst)`: everyone the lists and the world's files name, by UUID; named first, then
/// in `localeCompare` order of the name (or the UUID).
pub fn list_players(dir: &Path) -> Result<Vec<Player>, Failure> {
    let level = level_of(dir)?;
    let mut people: Vec<Player> = Vec::new();
    // `at(uuid)`: the player's entry, made on first sight; none for no id or the nil UUID
    fn at<'a>(people: &'a mut Vec<Player>, uuid: Option<&Value>) -> Option<&'a mut Player> {
        let key = if js::truthy(uuid) {
            js::string(uuid).to_lowercase()
        } else {
            String::new()
        };
        if key.is_empty() || key == NIL_UUID {
            return None;
        }
        let i = match people.iter().position(|p| p.uuid == key) {
            Some(i) => i,
            None => {
                people.push(Player::new(key));
                people.len() - 1
            }
        };
        Some(&mut people[i])
    }

    for row in read_list(dir, OPS) {
        let uuid = get(&row, "uuid")?;
        let Some(p) = at(&mut people, uuid) else {
            continue;
        };
        p.op = true;
        let level = get(&row, "level")?;
        p.op_level = match level {
            Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
                Value::Number(n.clone())
            }
            _ => Value::Null,
        };
        if let Some(name) = get(&row, "name")?.filter(|v| js::truthy(Some(v))) {
            p.name = name.clone();
        }
    }
    for row in read_list(dir, BANNED) {
        let uuid = get(&row, "uuid")?;
        let Some(p) = at(&mut people, uuid) else {
            continue;
        };
        p.banned = true;
        p.ban_reason = or_null(get(&row, "reason")?);
        p.ban_source = or_null(get(&row, "source")?);
        let expires = get(&row, "expires")?;
        p.ban_expires = if js::truthy(expires) && expires != Some(&json!("forever")) {
            expires.cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        if let Some(name) = get(&row, "name")?.filter(|v| js::truthy(Some(v))) {
            p.name = name.clone();
        }
    }
    // the cache last: it has the most recently resolved name, which matters after a rename
    for file in [WHITELIST, USERCACHE] {
        for row in read_list(dir, file) {
            let uuid = get(&row, "uuid")?;
            let Some(p) = at(&mut people, uuid) else {
                continue;
            };
            if file == WHITELIST {
                p.whitelisted = true;
            }
            if let Some(name) = get(&row, "name")?.filter(|v| js::truthy(Some(v))) {
                p.name = name.clone();
            }
        }
    }

    for d in player_dirs(dir, &level) {
        let Ok(entries) = crate::fsx::readdir_typed(&d) else {
            continue;
        };
        for (name, kind) in entries {
            if !kind.is_file() || !UUID_FILE.is_match(&name) {
                continue;
            }
            let id = Value::String(name[..36].to_string());
            let Some(p) = at(&mut people, Some(&id)) else {
                continue;
            };
            p.joined = true;
            // a file gone between the listing and the stat still counts as joined
            if let Ok(m) = std::fs::metadata(d.join(&name))
                && let Ok(t) = m.modified()
            {
                let ms = match t.duration_since(std::time::UNIX_EPOCH) {
                    Ok(d) => d.as_millis() as f64,
                    Err(e) => -(e.duration().as_millis() as f64),
                };
                if let Some(seen) = crate::jsdate::to_iso(ms)
                    && p.last_seen.as_ref().is_none_or(|l| seen > *l)
                {
                    p.last_seen = Some(seen);
                }
            }
        }
    }

    people.sort_by(|a, b| match (a.has_name(), b.has_name()) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => {
            let key = |p: &Player| {
                if p.has_name() {
                    p.name_text()
                } else {
                    p.uuid.clone()
                }
            };
            crate::collate::compare(&key(a), &key(b))
        }
    });
    Ok(people)
}

/// Someone to change: one the server has a record of, or one just looked up by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub uuid: String,
    /// empty when the name is not known
    pub name: String,
}

fn find_player(name: &str, dir: &Path, uuid: &str) -> Result<Who, Failure> {
    let want = uuid.to_lowercase();
    list_players(dir)?
        .into_iter()
        .find(|p| p.uuid == want)
        .map(|p| Who {
            name: p.name_text(),
            uuid: p.uuid,
        })
        .ok_or_else(|| Failure::user(format!("\"{name}\" has no record of a player with that id")))
}

/// `requireName(who, verb)`: the name a console command can take.
fn require_name<'a>(who: &'a Who, verb: &str) -> Result<&'a str, Failure> {
    if !who.name.is_empty() {
        if NOT_FOR_CONSOLE.is_match(&who.name) {
            return Err(Failure::user(format!(
                "\"{}\" is not a name the server's console can take, so {verb} has to be done with the server stopped.",
                who.name
            )));
        }
        return Ok(&who.name);
    }
    Err(Failure::user(format!(
        "SpawnLoft does not know the name behind {}, and {verb} needs one. Offline-mode ids are made by hashing a name, so they cannot be turned back into one - have the player join once while the server is running, or add them by name with \"Add a player\".",
        who.uuid
    )))
}

/// `onlineNow(inst)`: who the server says is connected; none when it is stopped or does not answer.
pub fn online_now(console: &Console<'_>) -> Vec<String> {
    if !console.running {
        return Vec::new();
    }
    let Ok(reply) = (console.exec)("list") else {
        return Vec::new();
    };
    // "There are 1 of a max of 10 players online: Wunga_"
    let plain = crate::rcon::strip_colors(&reply);
    let after = plain.split(':').skip(1).collect::<Vec<_>>().join(":");
    after
        .split(',')
        .map(|n| js::trim(n).to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// `listed(dir, file, who)`: whether the list names the player now, by id or by name.
fn listed(dir: &Path, file: &str, who: &Who) -> Result<bool, Failure> {
    let name = who.name.to_lowercase();
    for r in read_list(dir, file) {
        if string_of(get(&r, "uuid")?).to_lowercase() == who.uuid {
            return Ok(true);
        }
        if !name.is_empty() {
            let n = get(&r, "name")?;
            let n = if js::truthy(n) {
                js::string(n)
            } else {
                String::new()
            };
            if n.to_lowercase() == name {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `updateList(dir, file, mutate)`: read, change and write the list under `<file>.lock`.
fn update_list(
    dir: &Path,
    file: &str,
    mutate: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, Failure>,
) -> Result<(), Failure> {
    let lock = dir.join(format!("{file}.lock"));
    crate::lock::with_lock(&lock, crate::lock::Options::default(), || {
        let rows = mutate(read_list(dir, file))?;
        let _ = crate::fsx::write_json_node(&dir.join(file), &Value::Array(rows), None, false)?;
        Ok(())
    })
    .map_err(|e| crate::client::profiles::lock_failure(&e))?
}

/// The rows without the player's.
fn without(rows: Vec<Value>, uuid: &str) -> Result<Vec<Value>, Failure> {
    let mut kept = Vec::new();
    for r in rows {
        if string_of(get(&r, "uuid")?).to_lowercase() != uuid {
            kept.push(r);
        }
    }
    Ok(kept)
}

fn console_result(who: &Who, key: &str, on: bool, reply: &str, took: bool) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("uuid".into(), json!(who.uuid));
    m.insert(key.into(), json!(on));
    m.insert("via".into(), json!("console"));
    m.insert("reply".into(), json!(js::trim(&crate::rcon::strip_colors(reply))));
    m.insert("took".into(), json!(took));
    m
}

fn file_result(who: &Who, key: &str, on: bool) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("uuid".into(), json!(who.uuid));
    m.insert(key.into(), json!(on));
    m.insert("via".into(), json!("file"));
    m
}

fn apply_op(dir: &Path, who: &Who, on: bool, console: &Console<'_>) -> Result<Map<String, Value>, Failure> {
    if console.running {
        let name = require_name(who, if on { "opping" } else { "deopping" })?;
        let reply = (console.exec)(&format!("{} {name}", if on { "op" } else { "deop" }))?;
        let took = listed(dir, OPS, who)? == on;
        return Ok(console_result(who, "op", on, &reply, took));
    }
    update_list(dir, OPS, |rows| {
        let mut rows = without(rows, &who.uuid)?;
        if on {
            // level 4 is what the op command grants
            rows.push(
                json!({ "uuid": who.uuid, "name": who.name, "level": 4, "bypassesPlayerLimit": false }),
            );
        }
        Ok(rows)
    })?;
    Ok(file_result(who, "op", on))
}

/// `setOp(inst, uuid, on)`.
pub fn set_op(name: &str, dir: &Path, uuid: &str, on: bool, console: &Console<'_>) -> Result<Value, Failure> {
    apply_op(dir, &find_player(name, dir, uuid)?, on, console).map(Value::Object)
}

/// `banStamp(d)`: Minecraft's `2026-08-30 18:41:07 -0500`, in local time.
pub fn ban_stamp(ms: f64) -> String {
    let f = crate::jsdate::local_fields(ms).unwrap_or(crate::jsdate::Fields {
        year: 1970,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        ms: 0,
    });
    let off = (crate::jsdate::offset_at(ms) / 60_000.0).round() as i64;
    let sign = if off < 0 { '-' } else { '+' };
    let abs = off.abs();
    format!(
        "{}-{:02}-{:02} {:02}:{:02}:{:02} {sign}{:02}{:02}",
        f.year,
        f.month,
        f.day,
        f.hour,
        f.minute,
        f.second,
        abs / 60,
        abs % 60
    )
}

/// The reason as Node keeps it: runs of space made one, trimmed, at most 200 UTF-16 units (cut
/// back to a whole character where Node would split a surrogate pair).
fn ban_reason(reason: &str) -> String {
    let one = SPACES.replace_all(reason, " ");
    let t = js::trim(&one);
    let mut units = 0;
    let mut end = t.len();
    for (i, c) in t.char_indices() {
        if units + c.len_utf16() > 200 {
            end = i;
            break;
        }
        units += c.len_utf16();
    }
    t[..end].to_string()
}

fn apply_ban(
    dir: &Path,
    who: &Who,
    on: bool,
    reason: &str,
    console: &Console<'_>,
) -> Result<Map<String, Value>, Failure> {
    let why = ban_reason(reason);
    if console.running {
        let name = require_name(who, if on { "banning" } else { "pardoning" })?;
        // banning a connected player also kicks them
        let cmd = if on {
            if why.is_empty() {
                format!("ban {name}")
            } else {
                format!("ban {name} {why}")
            }
        } else {
            format!("pardon {name}")
        };
        let reply = (console.exec)(&cmd)?;
        let took = listed(dir, BANNED, who)? == on;
        return Ok(console_result(who, "banned", on, &reply, took));
    }
    update_list(dir, BANNED, |rows| {
        let mut rows = without(rows, &who.uuid)?;
        if on {
            rows.push(json!({
                "uuid": who.uuid,
                "name": who.name,
                "created": ban_stamp(crate::util::now()),
                "source": BAN_SOURCE,
                "expires": "forever",
                "reason": if why.is_empty() { "Banned by an operator." } else { why.as_str() },
            }));
        }
        Ok(rows)
    })?;
    Ok(file_result(who, "banned", on))
}

/// `setBan(inst, uuid, on, reason)`.
pub fn set_ban(
    name: &str,
    dir: &Path,
    uuid: &str,
    on: bool,
    reason: &str,
    console: &Console<'_>,
) -> Result<Value, Failure> {
    apply_ban(dir, &find_player(name, dir, uuid)?, on, reason, console).map(Value::Object)
}

fn apply_whitelist(
    dir: &Path,
    who: &Who,
    on: bool,
    console: &Console<'_>,
) -> Result<Map<String, Value>, Failure> {
    if console.running {
        let name = require_name(
            who,
            if on {
                "whitelisting"
            } else {
                "taking someone off the whitelist"
            },
        )?;
        let reply = (console.exec)(&format!("whitelist {} {name}", if on { "add" } else { "remove" }))?;
        let took = listed(dir, WHITELIST, who)? == on;
        return Ok(console_result(who, "whitelisted", on, &reply, took));
    }
    update_list(dir, WHITELIST, |rows| {
        let mut rows = without(rows, &who.uuid)?;
        if on {
            rows.push(json!({ "uuid": who.uuid, "name": who.name }));
        }
        Ok(rows)
    })?;
    Ok(file_result(who, "whitelisted", on))
}

/// `setWhitelisted(inst, uuid, on)`.
pub fn set_whitelisted(
    name: &str,
    dir: &Path,
    uuid: &str,
    on: bool,
    console: &Console<'_>,
) -> Result<Value, Failure> {
    apply_whitelist(dir, &find_player(name, dir, uuid)?, on, console).map(Value::Object)
}

/// `whitelistOn(inst)`: whether only listed players can join.
pub fn whitelist_on(dir: &Path) -> Result<bool, Failure> {
    Ok(crate::props::get(&props_of(dir)?, "white-list") == Some("true"))
}

/// `whitelistEnforced(inst)`: whether turning it on removes connected players not on it.
pub fn whitelist_enforced(dir: &Path) -> Result<bool, Failure> {
    Ok(crate::props::get(&props_of(dir)?, "enforce-whitelist") == Some("true"))
}

/// `setWhitelistOn(inst, on)`: a running server is told, and the file written once it says it
/// did (Paper changes only its memory); a stopped one has only the file.
pub fn set_whitelist_on(dir: &Path, on: bool, console: &Console<'_>) -> Result<Value, Failure> {
    let word = if on { "on" } else { "off" };
    let write = || {
        crate::props::write(
            &dir.join("server.properties"),
            &[("white-list".to_string(), on.to_string())],
        )
    };
    if console.running {
        let raw = (console.exec)(&format!("whitelist {word}"))?;
        let reply = js::trim(&crate::rcon::strip_colors(&raw)).to_string();
        let took = Regex::new(&format!("(?i)(now|already) turned {word}"))
            .unwrap()
            .is_match(&reply);
        if took {
            write()?;
        }
        return Ok(json!({ "on": on, "via": "console", "reply": reply, "took": took }));
    }
    write()?;
    Ok(json!({ "on": on, "via": "file" }))
}

/// Mojang's answer to a name lookup: the status and the body (`None` when it could not be read).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Option<Value>,
}

/// The lookup's GET: `Err` carries the message of what `fetch` throws.
pub type Get<'a> = &'a dyn Fn(&str) -> Result<Answer, String>;

/// The network: no redirects followed (one would be a second place contacted), 8 s in all.
pub fn get_url(url: &str) -> Result<Answer, String> {
    let cfg = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(crate::client::http::NODE_FETCH_UA)
        .timeout_global(Some(Duration::from_secs(8)))
        .build();
    let agent = ureq::Agent::new_with_config(cfg);
    let url = crate::test_origins::rewrite(url).map_err(|_| "fetch failed".to_string())?;
    let res = agent.get(&url).call().map_err(|e| match e {
        ureq::Error::Timeout(_) => "The operation was aborted due to timeout".to_string(),
        _ => "fetch failed".to_string(),
    })?;
    let status = res.status().as_u16();
    // `redirect: 'error'`: a redirect is a failed fetch (undici's redirect statuses only)
    if matches!(status, 301 | 302 | 303 | 307 | 308) && res.headers().contains_key("location") {
        return Err("fetch failed".into());
    }
    let body = res
        .into_body()
        .read_to_string()
        .ok()
        .and_then(|t| crate::jsjson::parse(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok());
    Ok(Answer { status, body })
}

/// `encodeURIComponent(name)`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `mojangLookup(name)`: `{ uuid, name }` with the name as the account spells it, or `None` when
/// no account has it. `Err` is the message of what Node throws.
pub fn mojang_lookup(name: &str, get: Get<'_>) -> Result<Option<Who>, String> {
    let res = get(&format!(
        "https://api.mojang.com/users/profiles/minecraft/{}",
        encode_component(name)
    ))?;
    if res.status == 204 || res.status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&res.status) {
        return Err(format!("Mojang answered {}", res.status));
    }
    let unreadable = || "Mojang sent an answer SpawnLoft could not read".to_string();
    let body = match res.body {
        Some(b @ (Value::Object(_) | Value::Array(_))) => b,
        _ => return Err(unreadable()),
    };
    let field = |k: &str| body.as_object().and_then(|o| o.get(k));
    let id = field("id");
    let hex = if js::truthy(id) {
        js::string(id).to_lowercase()
    } else {
        String::new()
    };
    if hex.len() != 32 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(unreadable());
    }
    let spelled = match field("name") {
        None => name.to_string(),
        v => js::string(v),
    };
    if !PLAYER_NAME.is_match(&spelled) || spelled.to_lowercase() != name.to_lowercase() {
        return Err(unreadable());
    }
    Ok(Some(Who {
        uuid: dashed(&hex),
        name: spelled,
    }))
}

fn dashed(hex: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `offlineUuid(name)`: the id an offline-mode server gives a name (a version 3 UUID of
/// `OfflinePlayer:<name>`).
pub fn offline_uuid(name: &str) -> String {
    use md5::Digest;
    let mut b: [u8; 16] = md5::Md5::digest(format!("OfflinePlayer:{name}").as_bytes()).into();
    b[6] = (b[6] & 0x0f) | 0x30;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    dashed(&hex)
}

/// How [`add_by_name`] adds someone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddAs {
    Whitelist,
    Op,
    Ban,
}

impl AddAs {
    pub fn parse(s: &str) -> Result<AddAs, Failure> {
        match s {
            "whitelist" => Ok(AddAs::Whitelist),
            "op" => Ok(AddAs::Op),
            "ban" => Ok(AddAs::Ban),
            other => Err(Failure::user(format!("unknown way to add a player: {other}"))),
        }
    }
    fn word(self) -> &'static str {
        match self {
            AddAs::Whitelist => "whitelist",
            AddAs::Op => "op",
            AddAs::Ban => "ban",
        }
    }
}

/// `addByName(inst, name, as, { reason })`: whitelist, op or ban someone by name, whether or not
/// they have joined. A running server finds the player itself; for a stopped one the name is
/// looked up with Mojang, or turned into the offline id when the server does not check accounts.
/// `add_as` is the text the caller was given, checked after the name as in Node.
pub fn add_by_name(
    dir: &Path,
    raw_name: &str,
    add_as: &str,
    reason: &str,
    console: &Console<'_>,
    lookup: &dyn Fn(&str) -> Result<Option<Who>, String>,
) -> Result<Value, Failure> {
    let name = js::trim(raw_name).to_string();
    if !PLAYER_NAME.is_match(&name) {
        return Err(Failure::user(
            "A player name is up to 16 letters, digits or underscores, with no spaces.",
        ));
    }
    let how = AddAs::parse(add_as)?;
    // someone already known keeps the id they are known by, if it is the kind this server gives
    // out now: after a switch of online-mode, the old id is one nobody joins with again
    let checks_accounts = crate::props::get(&props_of(dir)?, "online-mode") != Some("false");
    let kind = if checks_accounts { '4' } else { '3' };
    let fits = |p: &Player| console.running || p.uuid.chars().nth(14) == Some(kind);
    let lower = name.to_lowercase();
    let known = list_players(dir)?
        .into_iter()
        .find(|p| p.name_text().to_lowercase() == lower && fits(p));
    let who = match known {
        Some(p) => Who {
            name: p.name_text(),
            uuid: p.uuid,
        },
        None if console.running => Who {
            uuid: String::new(),
            name: name.clone(),
        },
        None if !checks_accounts => Who {
            uuid: offline_uuid(&name),
            name: name.clone(),
        },
        None => match lookup(&name) {
            Err(m) => {
                return Err(Failure::user(format!(
                    "Could not look up \"{name}\" with Mojang ({m}). Check the connection, or start the server and add them again: a running server finds players itself."
                )));
            }
            Ok(None) => {
                return Err(Failure::user(format!(
                    "No Minecraft account is called \"{name}\". Check the spelling."
                )));
            }
            Ok(Some(found)) => found,
        },
    };
    let mut out = match how {
        AddAs::Whitelist => apply_whitelist(dir, &who, true, console)?,
        AddAs::Op => apply_op(dir, &who, true, console)?,
        AddAs::Ban => apply_ban(dir, &who, true, reason, console)?,
    };
    out.insert("name".into(), json!(who.name));
    out.insert("as".into(), json!(how.word()));
    Ok(Value::Object(out))
}

/// `forgetPlayer(inst, uuid)`: the player's inventory, position, stats and advancements deleted
/// (`.dat_old` too); ops, bans and the whitelist kept. Refused while the server runs.
pub fn forget_player(name: &str, dir: &Path, uuid: &str, running: bool) -> Result<Value, Failure> {
    if running {
        return Err(Failure::user(format!(
            "\"{name}\" is running. Stop it before deleting player data - a running server holds that player's state in memory and writes it back over whatever is deleted."
        )));
    }
    let who = find_player(name, dir, uuid)?;
    let level = level_of(dir)?;
    let mut removed = Vec::new();
    for d in player_dirs(dir, &level) {
        let Ok(entries) = crate::fsx::readdir_names(&d) else {
            continue;
        };
        for entry in entries {
            if !entry.to_lowercase().starts_with(&who.uuid) {
                continue;
            }
            let full = d.join(&entry);
            // rmSync with force: a missing file is fine, a folder is Node's ERR_FS_EISDIR,
            // anything else fails as the system says
            if std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
                return Err(Failure::Internal {
                    head: "SystemError [ERR_FS_EISDIR]".into(),
                    message: format!(
                        "Path is a directory: rm returned EISDIR (is a directory) {}",
                        full.display()
                    ),
                    code: Some("ERR_FS_EISDIR".into()),
                });
            }
            if let Err(e) = std::fs::remove_file(&full)
                && !crate::jspath::is_enoent(&e)
            {
                return Err(Failure::io(&e, "rm", Some(&full)));
            }
            let d_text = d.to_string_lossy();
            removed.push(crate::jspath::join(&[
                &crate::jspath::basename(&crate::jspath::dirname(&d_text)),
                &crate::jspath::basename(&d_text),
                &entry,
            ]));
        }
    }
    Ok(
        json!({ "uuid": who.uuid, "name": if who.name.is_empty() { Value::Null } else { json!(who.name) }, "removed": removed.len(), "files": removed }),
    )
}

/// `storedPlayers(instDir)`: how many players the world has files for, by kind of id.
pub fn stored_players(dir: &Path) -> Result<Value, Failure> {
    let level = level_of(dir)?;
    let mut seen: Vec<(String, String)> = Vec::new();
    for d in player_dirs(dir, &level) {
        let Ok(entries) = crate::fsx::readdir_names(&d) else {
            continue;
        };
        for entry in entries {
            let Some(m) = UUID_FILE.captures(&entry) else {
                continue;
            };
            let key = entry[..36].to_lowercase();
            let version = m[3].to_lowercase();
            match seen.iter_mut().find(|(k, _)| *k == key) {
                Some(s) => s.1 = version,
                None => seen.push((key, version)),
            }
        }
    }
    let count = |v: &str| seen.iter().filter(|(_, x)| x == v).count();
    let (offline, online) = (count("3"), count("4"));
    Ok(json!({
        "count": seen.len(),
        "offline": offline,
        "online": online,
        "unknown": seen.len() - offline - online,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_ids_are_version_3() {
        // the id an offline-mode server gives "Notch"
        assert_eq!(offline_uuid("Notch"), "b50ad385-829d-3141-a216-7e7d7539ba7f");
    }

    #[test]
    fn reasons_are_one_line_and_short() {
        assert_eq!(ban_reason("  too \n\t many  "), "too many");
        assert_eq!(crate::text::js_len(&ban_reason(&"😀".repeat(150))), 200);
    }
}

#[cfg(test)]
#[path = "players_contract.rs"]
mod contract;
