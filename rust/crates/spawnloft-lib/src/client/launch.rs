//! `client launch`: `launch` and `launchLocked` in client.mjs, `client-launch.mjs`'s command line
//! and game start, and `pickClientJava` from java.mjs. The game runs detached with its output in
//! the profile's log and its record in state.json, which the Node core reads as its own.
//!
//! A Forge or NeoForge profile is still launched by the Node core until their installers move
//! (part 4b): the command line hands those over before anything is printed, and `launch` refuses
//! them as a guard.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::install::{self, Fetch, OnProgress};
use super::paths::Paths;
use super::profiles::{self, Profile};
use super::rules::{self, Os};
use super::version::{self, JavaRequirement, Resolved};
use super::{accounts, auth, http, library, meta, prop, read_json, runtime, server_list, state};
use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{cancel, java, js, jsjson, jspath};

fn user(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

fn code_of(e: &Failure) -> Option<&str> {
    match e {
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.as_deref(),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

fn iso_now() -> String {
    crate::jsdate::to_iso(crate::util::now()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Addresses

static HOSTNAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
        .expect("a valid pattern")
});
static IPV6: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Fa-f:.]+$").expect("a valid pattern"));

/// `validHost(host)`: a name, an IPv4 address or an unbracketed IPv6 one.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.encode_utf16().count() > 253 {
        return false;
    }
    if host.contains(':') {
        IPV6.is_match(host)
    } else {
        HOSTNAME.is_match(host)
    }
}

/// Where the game joins: `{ host, port }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub host: String,
    pub port: u16,
}

impl Address {
    /// `formatAddress`: `[v6]:port` or `host:port`.
    pub fn format(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// `parseServerAddress(text)`: host or host:port, a name, IPv4, or a bracketed IPv6.
pub fn parse_server_address(text: &str) -> Result<Address, Failure> {
    let bad = || {
        user(format!(
            "\"{text}\" is not a server address; use host or host:port, like play.example.net or 192.168.1.20:25566"
        ))
    };
    let raw = js::trim(text);
    if raw.is_empty() || raw.encode_utf16().count() > 260 {
        return Err(bad());
    }
    static V6: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\[([^\]]+)\](?::([^:]*))?$").expect("a valid pattern"));
    let (host, port_text) = if let Some(m) = V6.captures(raw) {
        let host = m.get(1).map_or("", |g| g.as_str()).to_string();
        if !IPV6.is_match(&host) || !host.contains(':') {
            return Err(bad());
        }
        (host, m.get(2).map(|g| g.as_str().to_string()))
    } else {
        let parts: Vec<&str> = raw.split(':').collect();
        if parts.len() > 2 {
            return Err(bad());
        }
        let host = parts[0].to_string();
        if host.encode_utf16().count() > 253 || !HOSTNAME.is_match(&host) {
            return Err(bad());
        }
        (host, parts.get(1).map(|p| p.to_string()))
    };
    let mut port = 25565u16;
    if let Some(p) = port_text {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        let n: u32 = p.parse().map_err(|_| bad())?;
        if !(1..=65535).contains(&n) {
            return Err(bad());
        }
        port = n as u16;
    }
    Ok(Address { host, port })
}

/// `localJoinAddress(inst)`: where the game finds a SpawnLoft server on this machine.
pub fn local_join_address(inst: &Instance) -> Result<Address, Failure> {
    let port = js::number(inst.get("port"));
    if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
        let shown = match inst.get("port") {
            None | Some(Value::Null) => "null".to_string(),
            Some(v) => jsjson::stringify(v),
        };
        return Err(user(format!(
            "server \"{}\" has no usable port ({shown}), so the game would have no address to join; give it a port in the server's settings",
            inst.name
        )));
    }
    let bound = crate::exposure::bound_address(&js::string(inst.get("dir")));
    let ip = match bound.strip_prefix('[').and_then(|b| b.strip_suffix(']')) {
        Some(inner) => inner.to_string(),
        None => bound.clone(),
    };
    let host = if ip.is_empty() || ip == "0.0.0.0" || ip == "::" {
        "127.0.0.1".to_string()
    } else {
        ip.clone()
    };
    if !valid_host(&host) {
        return Err(user(format!(
            "server \"{}\" has server-ip={ip} in its server.properties, which is not an address the game can join; clear it (server-ip=) so the server listens on every interface",
            inst.name
        )));
    }
    Ok(Address {
        host,
        port: port as u16,
    })
}

const LOOKUP_WAIT_MS: u64 = 5000;

/// How a name is looked up: the system's resolver, or the fake game's network (RFC 6761's
/// `.invalid` names never resolve; every other name does).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lookup {
    System,
    Fake,
}

/// `assertResolvable({ host, port }, { what, lookup })`: a name this machine cannot find stops
/// the launch with the reason, before the game shows "Unknown host". A lookup slower than five
/// seconds is let through. The SRV lookup Node falls back to for the default port has no
/// resolver here, so a name with only a `_minecraft._tcp` record is refused (only `--address`,
/// which the command line does not take, can name one).
pub fn assert_resolvable(addr: &Address, what: &str, lookup: Lookup) -> Result<(), Failure> {
    if addr.host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    let code = match lookup {
        Lookup::Fake => {
            let lower = addr.host.to_ascii_lowercase();
            if lower == "invalid" || lower.ends_with(".invalid") {
                Some("ENOTFOUND".to_string())
            } else {
                None
            }
        }
        Lookup::System => {
            let host = addr.host.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                use std::net::ToSocketAddrs;
                let _ = tx.send(
                    (host.as_str(), 0u16)
                        .to_socket_addrs()
                        .map(|mut a| a.next().is_some()),
                );
            });
            match rx.recv_timeout(Duration::from_millis(LOOKUP_WAIT_MS)) {
                Ok(Ok(true)) | Err(_) => None,
                Ok(Ok(false)) | Ok(Err(_)) => Some("ENOTFOUND".to_string()),
            }
        }
    };
    match code {
        None => Ok(()),
        Some(code) => Err(coded(
            format!(
                "{what} cannot be reached: this machine cannot find {} ({code}), so the game would stop at \"Unknown host\"; check the spelling, or that this machine is online",
                addr.host
            ),
            "unknown-host",
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// Accounts

/// `assertPlayerName(name)`.
pub fn assert_player_name(name: &str) -> Result<String, Failure> {
    let ok = (3..=16).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if !ok {
        return Err(user(format!(
            "player name \"{name}\" must be 3 to 16 letters, digits or underscores"
        )));
    }
    Ok(name.to_string())
}

/// `defaultPlayerName(profileName)`: the profile's name made into one a server takes.
pub fn default_player_name(profile_name: &str) -> String {
    let base: String = profile_name
        .encode_utf16()
        .map(|u| {
            let c = char::from_u32(u32::from(u)).unwrap_or('_');
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(16)
        .collect();
    if base.len() >= 3 {
        base
    } else {
        format!("{base}___").chars().take(3).collect()
    }
}

/// `offlineAccount(name)`.
pub fn offline_account(name: &str) -> Result<Value, Failure> {
    assert_player_name(name)?;
    Ok(json!({
        "type": "offline",
        "name": name,
        "uuid": crate::players::offline_uuid(name),
        "accessToken": "0",
        "userType": "legacy",
        "xuid": "",
        "clientId": "",
    }))
}

/// `peekAccount(selector)`: the stored entry a selector names, without the network.
pub fn peek_account(paths: &Paths, selector: &Value) -> Result<Value, Failure> {
    let Some(sel) = selector.as_str().filter(|s| !s.is_empty()) else {
        return Err(user(
            "an account is \"offline:<player name>\" or the name of a signed-in Microsoft account",
        ));
    };
    if let Some(name) = sel.strip_prefix("offline:") {
        return offline_account(name);
    }
    let list = accounts::load(paths)?;
    let Some(idx) = accounts::find(&list, sel)? else {
        let looks_uuid =
            (32..=36).contains(&sel.len()) && sel.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        if looks_uuid {
            return Err(user(format!(
                "the account this profile names (uuid {sel}) is no longer in the list; sign in again, or set account= on the profile"
            )));
        }
        return Err(user(format!(
            "no Microsoft account named \"{sel}\" is signed in; spawnloft client login, or use offline:<player name>"
        )));
    };
    let mut entry = match &list[idx] {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    };
    let kind = match entry.get("type") {
        None | Some(Value::Null) => json!("microsoft"),
        Some(v) => v.clone(),
    };
    entry.insert("type".into(), kind);
    Ok(Value::Object(entry))
}

/// `accountFor(selector)`: the account a launch plays as, its sign-in renewed when it is about
/// to run out.
pub fn account_for(
    paths: &Paths,
    selector: &Value,
    send: http::Send<'_>,
    now: &dyn Fn() -> f64,
) -> Result<Value, Failure> {
    let account = peek_account(paths, selector)?;
    if prop(Some(&account), "type") == Some(&json!("offline")) {
        return offline_account(&js::string(prop(Some(&account), "name")));
    }
    let expires = crate::jsdate::parse(&js::string(prop(Some(&account), "expiresAt")));
    if expires - now() < 5.0 * 60.0 * 1000.0 {
        let uuid = prop(Some(&account), "uuid").cloned();
        let refreshed = match auth::refresh_account(send, now, &account) {
            Ok(r) => r,
            Err(err) => {
                if code_of(&err) != Some("sign-in-expired") {
                    return Err(err);
                }
                let at = crate::jsdate::to_iso(now()).unwrap_or_default();
                let _ = accounts::update(paths, "list.map", |latest| {
                    Ok(latest
                        .into_iter()
                        .map(|a| {
                            if accounts::same_uuid(prop(Some(&a), "uuid"), uuid.as_ref())
                                && let Value::Object(mut m) = a.clone()
                            {
                                m.insert("refreshFailedAt".into(), json!(at));
                                return Value::Object(m);
                            }
                            a
                        })
                        .collect())
                });
                return Err(err);
            }
        };
        let fresh = refreshed.clone();
        accounts::update(paths, "list.some", |latest| {
            if latest
                .iter()
                .any(|a| accounts::same_uuid(prop(Some(a), "uuid"), uuid.as_ref()))
            {
                accounts::upsert(latest, fresh, uuid.as_ref())
            } else {
                Ok(latest)
            }
        })?;
        return Ok(refreshed);
    }
    Ok(account)
}

// ---------------------------------------------------------------------------------------------
// Java

/// `boundsText({ min, max })`.
fn bounds_text(req: &JavaRequirement) -> String {
    let min = js::number_to_string(req.min);
    match req.max {
        None => format!("Java {min} or newer"),
        Some(max) if max == req.min => format!("Java {min}"),
        Some(max) => format!("Java {min} to {}", js::number_to_string(max)),
    }
}

fn temurin_url(major: f64) -> String {
    format!(
        "https://adoptium.net/temurin/releases/?version={}",
        js::number_to_string(major)
    )
}

/// One Java found on this machine, as `chooseClientJava` reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub path: String,
    pub major: Option<f64>,
    pub arch: Option<String>,
}

impl Candidate {
    fn of(found: &java::Found) -> Candidate {
        Candidate {
            path: found.path.clone(),
            major: found.probe.major.map(f64::from),
            arch: found.probe.arch.clone(),
        }
    }
}

/// `chooseClientJava(candidates, requirement, arch)`: inside the bounds, of the arch the game
/// runs as (an unknown arch fits), the preferred major first, else the newest.
pub fn choose_client_java<'a>(
    all: &'a [Candidate],
    req: &JavaRequirement,
    arch: Option<&str>,
) -> Option<&'a Candidate> {
    let fits: Vec<&Candidate> = all
        .iter()
        .filter(|j| {
            j.major
                .is_some_and(|m| m >= req.min && req.max.is_none_or(|max| m <= max))
                && (arch.is_none() || j.arch.is_none() || j.arch.as_deref() == arch)
        })
        .collect();
    if let Some(p) = fits.iter().find(|j| j.major == Some(req.prefer)) {
        return Some(p);
    }
    // a stable sort, newest first: the first of equals stays first, as in Node
    let mut sorted = fits.clone();
    sorted.sort_by(|a, b| b.major.partial_cmp(&a.major).unwrap_or(std::cmp::Ordering::Equal));
    sorted.first().copied()
}

/// The Java a game gets: `{ path, warning, source }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Picked {
    pub path: String,
    pub warning: Option<String>,
    pub source: &'static str,
}

const FALLBACK_CODES: [&str; 3] = [
    "no-runtime-for-this-machine",
    "runtime-offline",
    "download-failed",
];

fn client_java_error(code: &str, message: String) -> Failure {
    coded(message, code)
}

/// `pickClientJava({ explicit, requirement, arch, what, found, runtime })`.
pub fn pick_client_java(
    explicit: Option<&str>,
    req: &JavaRequirement,
    arch: Option<&str>,
    what: &str,
    found: Option<Vec<Candidate>>,
    runtime: Option<&dyn Fn() -> Result<String, Failure>>,
) -> Result<Picked, Failure> {
    let need = bounds_text(req);
    let install = req.prefer;
    let get = format!(
        "Install Java {} from {}, or point the profile at one.",
        js::number_to_string(install),
        temurin_url(install)
    );
    if explicit == Some("mojang") {
        let Some(runtime) = runtime else {
            return Err(user(format!(
                "{what} is set to Mojang's Java, which this launch cannot download"
            )));
        };
        return Ok(Picked {
            path: runtime()?,
            warning: None,
            source: "mojang-runtime",
        });
    }
    if let Some(explicit) = explicit {
        let state = java::probe(explicit);
        if !state.found {
            return Err(user(format!("{explicit} could not be run: {}", state.message)));
        }
        if let (Some(arch), Some(have)) = (arch, state.arch.as_deref())
            && have != arch
        {
            return Err(client_java_error(
                "java-wrong-arch",
                format!(
                    "{what} runs as {arch} on this machine, and {explicit} is an {have} Java. Pick an {arch} Java for the profile, or clear it to let SpawnLoft choose."
                ),
            ));
        }
        if let Some(major) = state.major.map(f64::from)
            && major < req.min
        {
            return Err(client_java_error(
                "java-too-old",
                format!(
                    "{what} needs {need}, and {explicit} is Java {}. Pick another Java for the profile, or clear it to let SpawnLoft choose.",
                    js::number_to_string(major)
                ),
            ));
        }
        let over = state
            .major
            .map(f64::from)
            .filter(|m| req.max.is_some_and(|max| *m > max));
        let warning = over.map(|m| {
            format!(
                "{what} wants {need}; using Java {} at {explicit}, which is newer, so the game may not start.",
                js::number_to_string(m)
            )
        });
        return Ok(Picked {
            path: explicit.to_string(),
            warning,
            source: "explicit",
        });
    }
    let given = found.is_some();
    let discover = || java::discover().all.iter().map(Candidate::of).collect::<Vec<_>>();
    let mut all = found.unwrap_or_else(discover);
    let mut choice = choose_client_java(&all, req, arch).cloned();
    // a Java found earlier that has since been removed: look again before settling for less
    // (a command line run remembers nothing, so only a vanished choice looks again here)
    if !given
        && let Some(c) = &choice
        && c.path != "java"
        && !Path::new(&c.path).exists()
    {
        all = discover();
        choice = choose_client_java(&all, req, arch).cloned();
    }
    if let Some(c) = choice {
        return Ok(Picked {
            path: c.path,
            warning: None,
            source: "installed",
        });
    }

    let mut why: Option<Failure> = None;
    if let Some(runtime) = runtime {
        match runtime() {
            Ok(path) => {
                return Ok(Picked {
                    path,
                    warning: None,
                    source: "mojang-runtime",
                });
            }
            Err(err) => {
                // only "there is none to be had" falls back; a runtime that came down wrong refuses
                if !code_of(&err).is_some_and(|c| FALLBACK_CODES.contains(&c)) {
                    return Err(err);
                }
                why = Some(err);
            }
        }
    }
    let right: Vec<&Candidate> = all
        .iter()
        .filter(|j| j.major.is_some() && (arch.is_none() || j.arch.is_none() || j.arch.as_deref() == arch))
        .collect();
    let mut newer: Vec<&Candidate> = right
        .iter()
        .copied()
        .filter(|j| j.major.unwrap_or(0.0) > req.max.unwrap_or(f64::INFINITY))
        .collect();
    newer.sort_by(|a, b| a.major.partial_cmp(&b.major).unwrap_or(std::cmp::Ordering::Equal));
    if let Some(j) = newer.first() {
        let missed = why.as_ref().map_or(String::new(), |w| {
            let m = w.message();
            format!(
                " Mojang's Java could not be had: {}.",
                m.strip_suffix('.').unwrap_or(m)
            )
        });
        let at = if j.path == "java" {
            String::new()
        } else {
            format!(" at {}", j.path)
        };
        return Ok(Picked {
            path: j.path.clone(),
            warning: Some(format!(
                "{what} wants {need}; using Java {}{at}, which is newer, so the game may not start.{missed} {get}",
                js::number_to_string(j.major.unwrap_or(0.0))
            )),
            source: "fallback",
        });
    }
    if let Some(w) = &why
        && code_of(w) == Some("no-runtime-for-this-machine")
    {
        return Err(client_java_error(
            "no-runtime-for-this-machine",
            format!("{}. {what} needs {need}. {get}", w.message()),
        ));
    }
    let after = why.as_ref().map_or(String::new(), |w| {
        format!(" Mojang's Java could not be had either: {}", w.message())
    });
    if all.is_empty() {
        return Err(client_java_error(
            "java-missing",
            format!("{what} needs {need}, and no Java was found on this machine.{after} {get}"),
        ));
    }
    if right.is_empty() {
        let mut arches: Vec<String> = Vec::new();
        for j in &all {
            let a = j.arch.clone().unwrap_or_else(|| "?".into());
            if !arches.contains(&a) {
                arches.push(a);
            }
        }
        let arch = arch.unwrap_or("undefined");
        return Err(client_java_error(
            "java-wrong-arch",
            format!(
                "{what} runs as {arch} on this machine and needs an {arch} {need}; the Javas found are {}.{after} {get}",
                arches.join(", ")
            ),
        ));
    }
    let mut by_newest = right.clone();
    by_newest.sort_by(|a, b| b.major.partial_cmp(&a.major).unwrap_or(std::cmp::Ordering::Equal));
    let newest = by_newest[0];
    let at = if newest.path == "java" {
        String::new()
    } else {
        format!(" ({})", newest.path)
    };
    Err(client_java_error(
        "java-too-old",
        format!(
            "{what} needs {need}. The newest Java on this machine is {}{at}.{after} {get}",
            js::number_to_string(newest.major.unwrap_or(0.0))
        ),
    ))
}

/// `hostCapabilities(os)`: whether this machine runs x64 code, for the versions with no arm64
/// natives (Rosetta on Apple Silicon, Windows 11 on arm64).
pub fn host_x64(os: &Os) -> bool {
    if os.arch != "arm64" {
        return os.arch == "x64";
    }
    if os.name == "windows" {
        let build = os
            .version
            .split('.')
            .nth(2)
            .map_or(f64::NAN, js::string_to_number);
        return build >= 22000.0;
    }
    if os.name != "osx" {
        return false;
    }
    let mut cmd = std::process::Command::new("/usr/bin/arch");
    cmd.args(["-x86_64", "/usr/bin/true"]);
    crate::procx::output_within(cmd, Duration::from_secs(10)).is_ok_and(|f| f.ok)
}

// ---------------------------------------------------------------------------------------------
// The command line

/// `substitute(template, vars)`: `${name}`s filled from `vars`, unknown ones left as they are.
pub fn substitute(template: &str, vars: &Map<String, Value>) -> String {
    static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{(\w+)\}").expect("a valid pattern"));
    VAR.replace_all(template, |c: &regex::Captures<'_>| match vars.get(&c[1]) {
        Some(v) => js::string(Some(v)),
        None => c[0].to_string(),
    })
    .into_owned()
}

/// What `buildCommand` makes: the program, its arguments and where it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: String,
}

/// `buildCommand({ version, profile, profileName, account, java, os, harnessToken, address,
/// assetsDir })`. `join` is the address the game joins, already decided.
#[allow(clippy::too_many_arguments)]
pub fn build_command(
    paths: &Paths,
    version: &Value,
    profile: &Profile,
    profile_name: &str,
    account: &Value,
    java: &str,
    os: &Os,
    harness_token: Option<&str>,
    join: Option<&Address>,
    assets_dir: Option<&str>,
) -> Result<Command, Failure> {
    let has_server = join.is_some();
    let features = version::launch_features(has_server);
    let id = js::string(prop(Some(version), "id"));
    let client_jar = paths.version_jar(&id);
    let natives = paths.natives_dir(&id);
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let libraries_dir = paths.libraries_dir();
    let mut classpath: Vec<String> = library::classpath_rows(&library::libraries(version, os)?)
        .iter()
        .map(|row| jspath::join(&[&libraries_dir, &row.path]))
        .collect();
    classpath.push(client_jar);
    let assets_root = paths.assets_dir();
    let asset_index = library::asset_index(version)?;
    let acc = |k: &str| prop(Some(account), k).cloned().unwrap_or(Value::Null);
    let access_token = js::string(prop(Some(account), "accessToken"));
    let uuid = js::string(prop(Some(account), "uuid"));
    let mut vars = Map::new();
    let mut set = |k: &str, v: Value| {
        vars.insert(k.to_string(), v);
    };
    set("classpath", json!(classpath.join(delimiter)));
    set("library_directory", json!(libraries_dir));
    set("classpath_separator", json!(delimiter));
    set("natives_directory", json!(natives));
    set("game_directory", json!(paths.profile_dir(profile_name)));
    set("assets_root", json!(assets_root));
    set(
        "assets_index_name",
        prop(Some(&asset_index), "id").cloned().unwrap_or(Value::Null),
    );
    set("version_name", json!(id));
    set(
        "version_type",
        match prop(Some(version), "type") {
            None | Some(Value::Null) => json!("release"),
            Some(v) => v.clone(),
        },
    );
    set("launcher_name", json!("SpawnLoft"));
    set("launcher_version", json!(crate::build::current().version));
    set("auth_player_name", acc("name"));
    set("auth_uuid", acc("uuid"));
    set("auth_access_token", acc("accessToken"));
    set("clientid", acc("clientId"));
    set("auth_xuid", acc("xuid"));
    set("user_type", acc("userType"));
    set("auth_session", json!(format!("token:{access_token}:{uuid}")));
    set(
        "game_assets",
        json!(assets_dir.map_or(assets_root.clone(), str::to_string)),
    );
    set("user_properties", json!("{}"));
    // `undefined` values print as "undefined", as String(undefined) does
    for k in [
        "auth_player_name",
        "auth_uuid",
        "auth_access_token",
        "clientid",
        "auth_xuid",
        "user_type",
    ] {
        let key = match k {
            "auth_player_name" => "name",
            "auth_uuid" => "uuid",
            "auth_access_token" => "accessToken",
            "clientid" => "clientId",
            "auth_xuid" => "xuid",
            _ => "userType",
        };
        if prop(Some(account), key).is_none() {
            vars.insert(k.into(), json!("undefined"));
        }
    }
    if let Some(at) = join {
        vars.insert("quickPlayMultiplayer".into(), json!(at.format()));
        vars.insert(
            "quickPlayPath".into(),
            json!(jspath::join(&[&paths.run_dir(profile_name), "quickPlay.json"])),
        );
    }

    let mut jvm: Vec<String> = rules::jvm_arguments(version, os, &features)?
        .iter()
        .map(|a| substitute(&js::string(Some(a)), &vars))
        .collect();
    if let Some(cfg) = library::logging_config(version)? {
        let mut v = Map::new();
        v.insert("path".into(), json!(paths.log_config_path(&cfg.id)));
        jvm.push(substitute(&cfg.argument, &v));
    }
    if library::log4j_no_lookups_needed(version)? {
        jvm.push("-Dlog4j2.formatMsgNoLookups=true".into());
    }
    let mut game: Vec<String> = rules::game_arguments(version, os, &features)?
        .iter()
        .map(|a| substitute(&js::string(Some(a)), &vars))
        .collect();
    // pre-1.20 versions have no ${quickPlayMultiplayer} rule, so the join goes the old way
    let raw_game = match prop(prop(Some(version), "arguments"), "game") {
        Some(v) if !v.is_null() => v.clone(),
        _ => match prop(Some(version), "minecraftArguments") {
            Some(v) if !v.is_null() => v.clone(),
            _ => json!(""),
        },
    };
    if let Some(at) = join
        && !serde_json::to_string(&raw_game)
            .unwrap_or_default()
            .contains("${quickPlayMultiplayer}")
    {
        game.extend([
            "--server".into(),
            at.host.clone(),
            "--port".into(),
            at.port.to_string(),
        ]);
    }
    let mut args = jvm;
    args.push(format!("-Xmx{}", js::string(profile.get("memory"))));
    if let Some(t) = harness_token.filter(|t| !t.is_empty()) {
        args.push(format!("-Dspawnloft.harness.token={t}"));
    }
    args.push(js::string(prop(Some(version), "mainClass")));
    args.extend(game);
    Ok(Command {
        bin: java.to_string(),
        args,
        cwd: paths.profile_dir(profile_name),
    })
}

// ---------------------------------------------------------------------------------------------
// Starting the game

/// What the state file records beside the pid.
#[derive(Debug)]
pub struct StateFacts {
    pub mode: Value,
    pub account: Value,
    pub server: Option<String>,
    pub address: Option<String>,
    pub launched_by: &'static str,
    /// `{ token, port: null }` for a game started with the harness
    pub harness: Option<Value>,
    pub launch: Value,
}

/// A game this process started, kept so a `--wait` can hear it exit.
#[derive(Debug)]
pub struct Started {
    pub pid: u32,
    pub child: std::process::Child,
    pub started_at: String,
}

fn note_played(paths: &Paths, name: &str, change: impl FnOnce(&mut Map<String, Value>)) {
    let mut rec = match state::read_played(paths, name) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    change(&mut rec);
    let _ = super::write_json(&paths.played(name), &Value::Object(rec));
}

/// `spawnClient(command, { name, state })`: the game in its own session, its output in the
/// profile's log (one run's), its record owner-only in state.json once it has started.
pub fn spawn_client(
    paths: &Paths,
    command: &Command,
    name: &str,
    facts: StateFacts,
) -> Result<Started, Failure> {
    let mkdir =
        |dir: &str| std::fs::create_dir_all(dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(dir))));
    mkdir(&command.cwd)?;
    mkdir(&paths.run_dir(name))?;
    let script = {
        let lower = command.bin.to_ascii_lowercase();
        lower.ends_with(".js") || lower.ends_with(".mjs")
    };
    let (cmd, args): (String, Vec<String>) = if script {
        let node =
            crate::runtime::node().map_err(|e| user(format!("could not start {}: {e}", command.bin)))?;
        let mut a = vec![command.bin.clone()];
        a.extend(command.args.iter().cloned());
        (node.to_string_lossy().into_owned(), a)
    } else {
        (command.bin.clone(), command.args.clone())
    };
    let log_file = paths.log(name);
    let log =
        std::fs::File::create(&log_file).map_err(|e| Failure::io(&e, "open", Some(Path::new(&log_file))))?;
    let err = log
        .try_clone()
        .map_err(|e| Failure::io(&e, "open", Some(Path::new(&log_file))))?;
    let mut c = std::process::Command::new(&cmd);
    c.args(&args)
        .current_dir(&command.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err);
    if script {
        c.env("ELECTRON_RUN_AS_NODE", "1");
    }
    crate::platform::detach(&mut c);
    // as libuv does for every child: signals this process ignores are not the game's to ignore
    crate::platform::default_signals(&mut c);
    let child = c.spawn().map_err(|e| {
        user(format!(
            "could not start {}: spawn {cmd} {}",
            command.bin,
            jspath::error_code(&e).0
        ))
    })?;
    drop(c);
    let pid = child.id();
    // a Stop mark left by a game this process never heard exit must not be read as this one's
    let _ = super::rm_force(&paths.stop_mark(name));
    let started_at = iso_now();
    let java_exe = jspath::basename(&cmd);
    let record = json!({
        "pid": pid,
        "javaExe": java_exe,
        "startedAt": started_at,
        "mode": facts.mode,
        "account": facts.account,
        "javaPid": pid,
        "procStart": state::proc_start_ticks(Some(&json!(pid))),
        "harness": facts.harness.clone().unwrap_or(Value::Null),
        "server": facts.server,
        "address": facts.address,
        "launchedBy": facts.launched_by,
        "launch": facts.launch,
    });
    super::write_json_private(&paths.state_file(name), &record)?;
    note_played(paths, name, |rec| {
        rec.insert("lastPlayedAt".into(), json!(started_at));
        let n = rec.get("launches").and_then(Value::as_f64).unwrap_or(0.0);
        rec.insert("launches".into(), jsjson::num(n + 1.0));
    });
    Ok(Started {
        pid,
        child,
        started_at,
    })
}

/// What the Node core's exit handler writes when the game it started ends: last-exit.json, the
/// time played, and state.json gone when it still names this game.
pub fn note_exit(paths: &Paths, name: &str, started: &Started, status: std::process::ExitStatus) {
    let pid = json!(started.pid);
    let mine = read_json(&paths.state_file(name))
        .ok()
        .flatten()
        .is_some_and(|s| prop(Some(&s), "pid") == Some(&pid));
    let began = crate::jsdate::parse(&started.started_at);
    note_played(paths, name, |rec| {
        let total = rec.get("totalMs").and_then(Value::as_f64).unwrap_or(0.0);
        rec.insert(
            "totalMs".into(),
            jsjson::num(total + (crate::util::now() - began).max(0.0)),
        );
    });
    let signal = exit_signal(&status);
    let stopped = read_json(&paths.stop_mark(name))
        .ok()
        .flatten()
        .is_some_and(|m| prop(Some(&m), "pid") == Some(&pid));
    let _ = super::write_json(
        &paths.last_exit(name),
        &json!({
            "pid": started.pid,
            "code": exit_code(&status),
            "signal": signal,
            "startedAt": started.started_at,
            "endedAt": iso_now(),
            "stopped": stopped,
        }),
    );
    let _ = super::rm_force(&paths.stop_mark(name));
    if mine {
        let _ = super::rm_force(&paths.state_file(name));
    }
}

/// The exit code as Node reports it: Windows' is a DWORD, so a crash is 3221225477, not negative.
fn exit_code(status: &std::process::ExitStatus) -> Option<i64> {
    status.code().map(|c| {
        if cfg!(windows) {
            i64::from(c as u32)
        } else {
            i64::from(c)
        }
    })
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(crate::platform::signal_name)
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------------------------
// The launch

/// `fakeClientJava()`: the test suite's fake game, honoured only with NODE_ENV=test.
pub fn fake_client_java() -> Option<String> {
    if std::env::var("NODE_ENV").ok().as_deref() != Some("test") {
        return None;
    }
    crate::paths::env_var("FAKE_CLIENT")
}

/// The profile's loader, `None` for vanilla.
fn loader_of(profile: &Profile) -> Option<String> {
    match profile.get("loader") {
        None | Some(Value::Null) => None,
        Some(v) => Some(js::string(Some(v))).filter(|l| l != "vanilla"),
    }
}

/// How a launch was asked for (`client launch`'s flags).
#[allow(missing_debug_implementations)]
pub struct LaunchOpts<'a> {
    pub player_name: Option<String>,
    pub account: Option<String>,
    pub server: Option<String>,
    pub on_progress: OnProgress<'a>,
    pub on_warning: &'a (dyn Fn(&str) + Sync),
    pub fake_java: Option<String>,
}

/// What a launch from the panel adds to [`LaunchOpts`]: `server: false` (the title screen even
/// when the profile names a server), an address SpawnLoft does not run, who asked, each step as
/// it starts, and a stopped target server started (and waited for) just before the game.
#[allow(missing_debug_implementations)]
pub struct PanelOpts<'a> {
    pub server_off: bool,
    pub address: Option<String>,
    pub launched_by: &'static str,
    /// `onStage({ stage, message })`.
    pub on_stage: &'a (dyn Fn(&str, &str) + Sync),
    pub ensure_server: Option<EnsureServer<'a>>,
}

/// Starts a stopped server and waits for it (`ensureServer(target)`).
pub type EnsureServer<'a> = &'a (dyn Fn(&str) -> Result<(), Failure> + Sync);

impl PanelOpts<'_> {
    /// A launch from the command line: none of it.
    pub fn cli() -> PanelOpts<'static> {
        PanelOpts {
            server_off: false,
            address: None,
            launched_by: "cli",
            on_stage: &|_, _| {},
            ensure_server: None,
        }
    }
}

/// The step a message of the install belongs to, as `onStage` names it.
fn stage_of(message: &str, loader: Option<&str>) -> String {
    if message == "Reading the Minecraft version list" {
        "manifest".into()
    } else if message.starts_with("Downloading the version file for Minecraft") {
        "version".into()
    } else if message == "Finding Java" || message.starts_with("Getting Mojang's Java") {
        "java".into()
    } else {
        loader.unwrap_or("loader").to_string()
    }
}

/// What `launch` answers: `{ pid, profile, version, account, warnings }`, and the game itself.
#[derive(Debug)]
pub struct Launched {
    pub started: Started,
    pub profile: Profile,
    pub version: String,
    pub account: Value,
    pub warnings: Vec<String>,
}

fn instance(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    registry::get_instance(Path::new(&layout.registry_file), name).map_err(user)
}

/// `serverCheck(server, account)`: a refusal (an offline player against an online-mode server),
/// the warnings, and whether the server is stopped. Advisory: what cannot be read is no check.
fn server_check(
    layout: &Layout,
    server: &str,
    account_type: &str,
    player: &str,
) -> (Option<String>, Vec<String>, bool) {
    let Some((online, running)) = check_instance(layout, server) else {
        return (None, Vec::new(), false);
    };
    let mut warnings = Vec::new();
    if !running {
        warnings.push(format!(
            "server \"{server}\" is not running, so the game will show \"Connection refused\"; start it first: spawnloft start {server}"
        ));
    }
    let refusal = (account_type != "microsoft" && online).then(|| online_mode_refusal(server, player));
    (refusal, warnings, !running)
}

/// The two facts of bots.mjs `checkInstance` a launch reads: online mode, and running. `None`
/// when it would throw.
fn check_instance(layout: &Layout, server: &str) -> Option<(bool, bool)> {
    let inst = instance(layout, server).ok()?;
    if inst.is_database() {
        return None;
    }
    let props =
        crate::props::read(&Path::new(&js::string(inst.get("dir"))).join("server.properties")).ok()?;
    let online = crate::props::get(&props, "online-mode") != Some("false");
    let running = crate::supervisor::is_running(layout, server).ok()?;
    Some((online, running))
}

fn online_mode_refusal(server: &str, player: &str) -> String {
    format!(
        "server \"{server}\" runs in online mode and {player} is an offline player, so the server would refuse the join; sign in (spawnloft client login) and play as that account (--account <name>, or account=<name> on the profile), or set online-mode=false on a test server"
    )
}

/// `serverChecksAccounts(server)`: unknown counts as yes.
fn server_checks_accounts(layout: &Layout, server: &str) -> bool {
    check_instance(layout, server).is_none_or(|(online, _)| online)
}

/// `versionsInUse(except)`: the version ids whose natives another profile's running game has
/// loaded, its own and every parent.
fn versions_in_use(paths: &Paths, except: &str) -> Result<Vec<String>, Failure> {
    let mut ids: Vec<String> = Vec::new();
    for p in profiles::list(paths)? {
        if p.name() == except {
            continue;
        }
        let Some(st) = state::read(paths, &p.name())? else {
            continue;
        };
        let mut id = match prop(prop(Some(&st), "launch"), "id") {
            None | Some(Value::Null) => p.get("mc").cloned(),
            Some(v) => Some(v.clone()),
        };
        while let Some(Value::String(s)) = &id {
            if ids.contains(s) {
                break;
            }
            ids.push(s.clone());
            id = read_json(&paths.version_json(s))
                .ok()
                .flatten()
                .and_then(|v| prop(Some(&v), "inheritsFrom").cloned());
        }
    }
    Ok(ids)
}

/// `materialiseAssets({ file, sha1 }, dest, { copy })`: an older asset layout as links into the
/// object store (copies in the profile's own folder), stamped with the index's sha1.
pub fn materialise_assets(paths: &Paths, index: &Value, dest: &str, copy: bool) -> Result<(), Failure> {
    let stamp_file = jspath::join(&[dest, ".complete"]);
    let stamp = std::fs::read_to_string(&stamp_file).ok();
    let sha1 = js::string(prop(Some(index), "sha1"));
    if !(sha1.len() == 40 && sha1.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(user("the asset index has no sha1 to check it by"));
    }
    if stamp.as_deref() == Some(sha1.as_str()) {
        return Ok(());
    }
    let file = js::string(prop(Some(index), "file"));
    let text = std::fs::read(&file).map_err(|e| Failure::read(&e, Path::new(&file)))?;
    let parsed: Value = crate::jsjson::parse(&String::from_utf8_lossy(&text)).map_err(Failure::syntax)?;
    let rows = install::asset_tree_rows(&parsed)?;
    std::fs::create_dir_all(dest).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(dest))))?;
    super::rm_force(&stamp_file)?;
    let assets = paths.assets_dir();
    for (rel, object) in rows {
        let to = jspath::join(&[dest, &rel]);
        if !crate::util::is_inside(Path::new(dest), Path::new(&to)) {
            return Err(user(format!(
                "the asset index names the file \"{rel}\", which would land outside its folder"
            )));
        }
        let parent = jspath::dirname(&to);
        std::fs::create_dir_all(&parent).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&parent))))?;
        let from = jspath::join(&[&assets, &object]);
        if copy {
            super::rm_force(&to)?;
            crate::create::copyfile(Path::new(&from), Path::new(&to))?;
        } else if !crate::create::same_file(Path::new(&from), Path::new(&to)) {
            install::link_or_copy(&from, &to)?;
        }
    }
    std::fs::write(&stamp_file, &sha1).map_err(|e| Failure::io(&e, "open", Some(Path::new(&stamp_file))))?;
    Ok(())
}

/// `launchFacts(resolved, picked, profile, installed, assetsDir)`.
/// `javaFor(profile, resolved)`: the profile's own Java, one found on this machine, or Mojang's
/// runtime for the version's component. A loader may narrow the version's Java (Forge on a Java
/// 8 version runs on 8 only, Mojang's first). With the bounds it was picked for.
pub fn java_for(
    paths: &Paths,
    profile: &Profile,
    resolved: &Resolved,
    on_stage: &dyn Fn(&str),
    on_progress: install::OnProgress<'_>,
) -> Result<(Picked, JavaRequirement), Failure> {
    let req = resolved.java.clone();
    let runtime = || -> Result<String, Failure> {
        on_stage(&format!(
            "Getting Mojang's Java {}",
            js::number_to_string(req.major)
        ));
        runtime::mojang_java(
            paths,
            &req.component,
            req.major,
            &resolved.os.name,
            &resolved.os.arch,
            &install::default_fetch,
            &meta::default_fetch,
            on_progress,
        )
        .map(|(path, _)| path)
    };
    let loader = loader_of(profile);
    let (requirement, mojang_first) = match loader.as_deref() {
        Some("forge") => super::forge::forge_java(&req),
        _ => (req.clone(), false),
    };
    let explicit = match profile.get("java") {
        v if js::truthy(v) => Some(js::string(v)),
        _ => None,
    };
    // Mojang's Java first where the loader asks it, before any installed one; when it cannot be
    // had (offline, none for this machine), the usual choice
    if mojang_first && explicit.is_none() {
        match runtime() {
            Ok(path) => {
                return Ok((
                    Picked {
                        path,
                        warning: None,
                        source: "mojang-runtime",
                    },
                    requirement,
                ));
            }
            Err(err) => {
                if !matches!(
                    code_of(&err),
                    Some("no-runtime-for-this-machine" | "runtime-offline" | "download-failed")
                ) {
                    return Err(err);
                }
            }
        }
    }
    let mc = js::string(profile.get("mc"));
    let mut picked = pick_client_java(
        explicit.as_deref(),
        &requirement,
        Some(&resolved.os.arch),
        &format!("Minecraft {mc}"),
        None,
        Some(&runtime),
    )?;
    if loader.is_some()
        && let Some(w) = &picked.warning
    {
        picked.warning = Some(format!("{w} Mods often fail on a newer Java."));
    }
    Ok((picked, requirement))
}

/// The part of `installProfile(name)` after the version file, for a loader with an installer:
/// the game's Java found and the loader's build steps run on it. Nothing for other profiles.
pub fn install_loader(
    paths: &Paths,
    name: &str,
    version_id: &str,
    verify: bool,
    on_stage: &dyn Fn(&str),
    on_progress: install::OnProgress<'_>,
    on_note: &mut dyn FnMut(&str),
) -> Result<(), Failure> {
    let profile = profiles::get(paths, name)?;
    if !loader_of(&profile).is_some_and(|l| super::forge::handles(&l)) {
        return Ok(());
    }
    let os = rules::current_os();
    let read_version = |id: &str| -> Result<Value, Failure> {
        let file = paths.version_json(id);
        let text = std::fs::read(&file).map_err(|e| Failure::read(&e, Path::new(&file)))?;
        crate::jsjson::parse(&String::from_utf8_lossy(&text)).map_err(Failure::syntax)
    };
    let mut version = read_version(version_id)?;
    if let Some(Value::String(parent)) = prop(Some(&version), "inheritsFrom").cloned()
        && !parent.is_empty()
    {
        version = library::merge_inherited(&version, &read_version(&parent)?)?;
    }
    let caps = (!library::native_arches(&version, &os)?.contains(&os.arch)).then(|| host_x64(&os));
    let resolved = version::resolve_version(
        &version,
        &os,
        &version::launch_features(false),
        caps,
        version::LAUNCHER_FORMAT,
    )?;
    if let Some(refused) = version::resolved_refusal(&resolved) {
        return Err(refused);
    }
    on_stage("Finding Java");
    let (picked, _) = java_for(paths, &profile, &resolved, on_stage, on_progress)?;
    if let Some(w) = &picked.warning {
        on_note(w);
    }
    finish_loader(
        paths,
        name,
        &picked.path,
        &resolved.os,
        verify,
        &[],
        &mut |m| on_stage(m),
        on_progress,
        on_note,
    )
}

/// `finishLoader(name, { java, os })`: what a loader sets up once the game's Java is picked: an
/// installer's build steps, which read the vanilla game's jar, so the vanilla game is downloaded
/// first when the loader is not set up yet.
#[allow(clippy::too_many_arguments)]
pub fn finish_loader(
    paths: &Paths,
    name: &str,
    java: &str,
    os: &Os,
    verify: bool,
    keep_natives: &[String],
    on_stage: &mut dyn FnMut(&str),
    on_progress: install::OnProgress<'_>,
    on_note: &mut dyn FnMut(&str),
) -> Result<(), Failure> {
    let profile = profiles::get(paths, name)?;
    let Some(loader) = loader_of(&profile).filter(|l| super::forge::handles(l)) else {
        return Ok(());
    };
    let mc = js::string(profile.get("mc"));
    let build = js::string(profile.get("loaderVersion"));
    if !super::forge::is_installed(paths, &loader, &mc, &build)
        || !Path::new(&paths.version_jar(&mc)).exists()
    {
        let fetch: Fetch<'_> = &install::default_fetch;
        install::ensure_version(
            paths,
            &mc,
            &install::Ensure {
                os: os.clone(),
                on_progress,
                fetch,
                keep_natives,
                verify: false,
            },
        )?;
    }
    let f = super::fabric::Fetchers::real();
    super::forge::finish_install(
        paths,
        &loader,
        &mc,
        &build,
        super::forge::Finish {
            name,
            java,
            verify,
            f: &f,
            spawn: &super::forge_install::default_spawn,
            on_stage,
            on_progress,
            on_note,
        },
    )?;
    Ok(())
}

fn launch_facts(
    resolved: &Resolved,
    picked: &Picked,
    bounds: Option<&JavaRequirement>,
    installed: Option<&Value>,
    assets_dir: Option<&str>,
) -> Value {
    let req = &resolved.java;
    let b = bounds.unwrap_or(req);
    json!({
        "id": resolved.id,
        "java": {
            "major": jsjson::num(req.major),
            "component": req.component,
            "min": jsjson::num(b.min),
            "max": b.max.map(jsjson::num),
            "chosenPath": picked.path,
            "source": picked.source,
            "warning": picked.warning,
        },
        "arch": resolved.os.arch,
        "emulated": resolved.emulated,
        "nativesDir": resolved.natives_dir,
        "assetsLayout": installed.and_then(|i| prop(Some(i), "assetsLayout").cloned()).unwrap_or(Value::Null),
        "assetsDir": assets_dir,
        "loggingConfig": resolved.logging.as_ref().map(|l| l.id.clone()),
        "minimumLauncherVersion": resolved.minimum_launcher_version.map(jsjson::num),
    })
}

/// `fillServerList(name, profile)`: the profile's servers.dat in step with the SpawnLoft servers
/// on its version. Never stops a launch: what cannot be done is `skipped`.
fn fill_server_list(paths: &Paths, layout: &Layout, name: &str, profile: &Profile) -> Option<String> {
    let mc = js::string(profile.get("mc"));
    let parent = read_json(&paths.version_json(&mc));
    let parent = match parent {
        Ok(p) => p,
        Err(e) => return Some(e.message().to_string()),
    };
    if !server_list::version_keeps_server_list(parent.as_ref()) {
        return None;
    }
    let wanted = if profile.get("serverList") == Some(&json!(false)) {
        Vec::new()
    } else {
        match servers_for(layout, &mc) {
            Ok(w) => w,
            Err(e) => return Some(e.message().to_string()),
        }
    };
    let file = jspath::join(&[&paths.profile_dir(name), "servers.dat"]);
    server_list::sync(&file, &paths.server_list(name), &wanted).skipped
}

/// `serversFor(profile)`: the SpawnLoft servers on the profile's version, at the address the game
/// reaches them on this machine.
pub fn servers_for(layout: &Layout, mc: &str) -> Result<Vec<server_list::Wanted>, Failure> {
    let mut out = Vec::new();
    for inst in registry::list_instances(Path::new(&layout.registry_file))? {
        if inst.is_database() || crate::plugins::mc_version_of(&inst).as_deref() != Some(mc) {
            continue;
        }
        let Ok(at) = local_join_address(&inst) else {
            continue;
        };
        let label = inst.get("label");
        out.push(server_list::Wanted {
            key: inst.name.clone(),
            name: if js::truthy(label) {
                js::string(label)
            } else {
                inst.name.clone()
            },
            ip: at.format(),
        });
    }
    Ok(out)
}

/// `launchOs(fakeJava)`: the fake game runs where Mojang's client cannot, as Linux x64.
fn launch_os(fake: bool) -> Result<Os, Failure> {
    let os = rules::current_os();
    if fake && library::platform_refusal(None, &os, None)?.is_some() {
        return Ok(Os::new("linux", "x64", &os.version));
    }
    Ok(os)
}

/// `launch(name, opts)`: under the profile's launch lock, so a second launch during the
/// downloads is refused instead of overwriting the first one's state.
pub fn launch(
    paths: &Paths,
    layout: &Layout,
    name: &str,
    opts: &LaunchOpts<'_>,
) -> Result<Launched, Failure> {
    launch_with(paths, layout, name, opts, &PanelOpts::cli())
}

/// [`launch`] with what the panel adds.
pub fn launch_with(
    paths: &Paths,
    layout: &Layout,
    name: &str,
    opts: &LaunchOpts<'_>,
    extra: &PanelOpts<'_>,
) -> Result<Launched, Failure> {
    profiles::get(paths, name)?;
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
    let result = launch_locked(paths, layout, name, opts, extra);
    let _ = lock.release();
    result
}

fn launch_locked(
    paths: &Paths,
    layout: &Layout,
    name: &str,
    opts: &LaunchOpts<'_>,
    extra: &PanelOpts<'_>,
) -> Result<Launched, Failure> {
    let fake = opts.fake_java.clone();
    let os = launch_os(fake.is_some())?;
    let profile = profiles::get(paths, name)?;
    let st = state::status(paths, name)?;
    if st.running {
        return Err(coded(
            format!(
                "profile \"{name}\" is already running (pid {}); stop it first",
                js::string(prop(Some(&st.json), "pid"))
            ),
            "already-running",
        ));
    }
    if let Some(refusal) = library::platform_refusal(None, &os, None)? {
        return Err(user(refusal));
    }
    // before any download: a database is a registered instance but nothing a game can join
    if extra.address.is_some() && opts.server.is_some() {
        return Err(user("join either a SpawnLoft server or an address, not both"));
    }
    let address = match &extra.address {
        Some(text) => Some(parse_server_address(text)?),
        None => None,
    };
    let target: Option<String> = if address.is_some() || extra.server_off {
        None
    } else {
        match &opts.server {
            Some(s) => Some(s.clone()),
            None => match profile.get("server") {
                None | Some(Value::Null) => None,
                Some(v) => Some(js::string(Some(v))),
            },
        }
    }
    .filter(|t| !t.is_empty());
    if let Some(t) = &target
        && instance(layout, t)?.is_database()
    {
        return Err(user(format!(
            "\"{t}\" is a database, not a Minecraft server; point the profile at a server"
        )));
    }
    let mc_id = js::string(profile.get("mc"));
    if js::truthy(profile.get("harness")) && super::harness::harness_for(paths, &mc_id).is_none() {
        // a build published since the signed list was last read is found before refusing (no
        // wait when it was read within the day)
        super::harness_index::refresh_default(paths, false)?;
        if super::harness::harness_for(paths, &mc_id).is_none() {
            return Err(coded(
                super::harness::not_published(paths, &mc_id),
                "harness-not-published",
            ));
        }
    }

    // --as names an offline player; a signed-in account brings its own name
    let named: Option<Value> = match &opts.account {
        Some(a) => Some(json!(a)),
        None => match profile.get("account") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.clone()),
        },
    };
    if opts.player_name.as_deref().is_some_and(|p| !p.is_empty()) && js::truthy(named.as_ref()) {
        return Err(user(
            "use either --as <player name> or --account <account>, not both",
        ));
    }
    let selector: Option<Value> = match named {
        Some(v) => Some(v),
        None if opts.player_name.as_deref().is_some_and(|p| !p.is_empty()) => None,
        None => profiles::default_account(paths)?.map(Value::String),
    };
    let selector = selector.filter(|s| js::truthy(Some(s)));
    let provisional = match &selector {
        Some(s) => {
            let stored = peek_account(paths, s)?;
            (
                js::string(prop(Some(&stored), "type")),
                js::string(prop(Some(&stored), "name")),
            )
        }
        None => (
            "offline".to_string(),
            match opts.player_name.as_deref().filter(|p| !p.is_empty()) {
                Some(p) => assert_player_name(p)?,
                None => default_player_name(name),
            },
        ),
    };
    let mut warnings: Vec<String> = Vec::new();
    let mut stopped = false;
    let warn = |warnings: &mut Vec<String>, w: String| {
        (opts.on_warning)(&w);
        warnings.push(w);
    };
    if let Some(t) = &target {
        let (refusal, found, was_stopped) = server_check(layout, t, &provisional.0, &provisional.1);
        stopped = was_stopped;
        if let Some(r) = refusal {
            // the launcher has no --account flag to point at; it has an account picker
            return Err(user(if extra.launched_by == "launcher" {
                format!("{t} requires a Microsoft account (online-mode=true); sign in or pick another server")
            } else {
                r
            }));
        }
        // a server this launch will start is not worth a warning
        let starts = was_stopped && extra.ensure_server.is_some();
        warnings.extend(
            found
                .into_iter()
                .filter(|w| !(starts && w.contains("is not running"))),
        );
        let server_mc = crate::plugins::mc_version_of(&instance(layout, t)?);
        let mc = js::string(profile.get("mc"));
        if let Some(smc) = server_mc.filter(|s| !s.is_empty() && *s != mc) {
            warnings.push(format!(
                "server \"{t}\" runs Minecraft {smc} and this profile is {mc}, so the server will refuse the join unless it accepts other versions"
            ));
        }
    }
    // SpawnLoft cannot read another machine's server.properties: a warning, not a refusal
    if let (Some(text), true) = (&extra.address, provisional.0 == "offline") {
        warnings.push(format!(
            "{} is an offline player, so {text} will refuse the join unless it runs with online-mode=false; sign in to play on public servers",
            provisional.1
        ));
    }
    for w in &warnings {
        (opts.on_warning)(w);
    }

    let lookup = || {
        if fake.is_some() {
            Lookup::Fake
        } else {
            Lookup::System
        }
    };
    let join = match (&address, &target) {
        (Some(at), _) => {
            let text = extra.address.as_deref().unwrap_or("");
            assert_resolvable(at, js::trim(text), lookup())?;
            Some(at.clone())
        }
        (None, Some(t)) => {
            let at = local_join_address(&instance(layout, t)?)?;
            assert_resolvable(
                &at,
                &format!("server \"{t}\""),
                if fake.is_some() {
                    Lookup::Fake
                } else {
                    Lookup::System
                },
            )?;
            Some(at)
        }
        (None, None) => None,
    };

    // the version file first: what the game needs is read from it before anything else downloads
    let mc = js::string(profile.get("mc"));
    let loader = loader_of(&profile);
    let stage = |m: &str| (extra.on_stage)(&stage_of(m, loader.as_deref()), m);
    let prepare =
        || super::fabric::prepare_version(paths, name, &mut |m| stage(m), &super::fabric::Fetchers::real());
    let mut fake_installed = false;
    let version_id = if fake.is_some() {
        let id = match &loader {
            Some(l) => match profile.get("loaderVersion") {
                None | Some(Value::Null) => {
                    return Err(user(format!(
                        "profile \"{name}\" uses the {l} loader but has no loaderVersion; set one with spawnloft client set"
                    )));
                }
                Some(v) => super::fabric::version_id(l, &mc, &js::string(Some(v))),
            },
            None => mc.clone(),
        };
        let on_disk = Path::new(&paths.version_json(&id)).exists();
        fake_installed = on_disk;
        if on_disk { id } else { prepare()? }
    } else {
        prepare()?
    };
    let read_version = |id: &str| -> Result<Value, Failure> {
        let file = paths.version_json(id);
        let text = std::fs::read(&file).map_err(|e| Failure::read(&e, Path::new(&file)))?;
        crate::jsjson::parse(&String::from_utf8_lossy(&text)).map_err(Failure::syntax)
    };
    let mut version_json = read_version(&version_id)?;
    if let Some(Value::String(parent)) = prop(Some(&version_json), "inheritsFrom").cloned()
        && !parent.is_empty()
    {
        version_json = library::merge_inherited(&version_json, &read_version(&parent)?)?;
    }
    let features = version::launch_features(join.is_some());
    let needs_caps = !library::native_arches(&version_json, &os)?.contains(&os.arch);
    let caps = (needs_caps && fake.is_none()).then(|| host_x64(&os));
    let resolved = version::resolve_version(&version_json, &os, &features, caps, version::LAUNCHER_FORMAT)?;
    if let Some(refused) = version::resolved_refusal(&resolved) {
        return Err(refused);
    }
    let run_os = resolved.os.clone();

    // a launch that was cancelled stops between its steps; what it fetched is kept
    cancel::check_cancelled()?;
    (extra.on_stage)("java", "Finding Java");
    let (picked, bounds) = match &fake {
        Some(f) => (
            Picked {
                path: f.clone(),
                warning: None,
                source: "installed",
            },
            None,
        ),
        None => {
            let (p, r) = java_for(paths, &profile, &resolved, &stage, opts.on_progress)?;
            (p, Some(r))
        }
    };
    if let Some(w) = &picked.warning {
        warn(&mut warnings, w.clone());
    }

    cancel::check_cancelled()?;
    // a loader's own build steps, on the Java just picked (the fake game has none to run)
    if fake.is_none() {
        let keep = versions_in_use(paths, name)?;
        // each note is told as it is raised, as Node's onWarning is: before the steps' progress, and
        // also when a step then fails
        finish_loader(
            paths,
            name,
            &picked.path,
            &run_os,
            false,
            &keep,
            &mut |_| {},
            opts.on_progress,
            &mut |w| warn(&mut warnings, w.to_string()),
        )?;
    }

    cancel::check_cancelled()?;
    let installed = if fake_installed {
        None
    } else {
        let keep = versions_in_use(paths, name)?;
        let fetch: Fetch<'_> = &install::default_fetch;
        Some(install::ensure_version(
            paths,
            &version_id,
            &install::Ensure {
                os: run_os.clone(),
                on_progress: opts.on_progress,
                fetch,
                keep_natives: &keep,
                verify: false,
            },
        )?)
    };
    // the older asset layouts: a tree under real names, shared (virtual) or in the profile
    let assets_dir = installed.as_ref().and_then(|i| {
        let layout = js::string(prop(Some(i), "assetsLayout"));
        let id = js::string(prop(prop(Some(i), "assetIndex"), "id"));
        match layout.as_str() {
            "virtual" => Some(jspath::join(&[&paths.assets_dir(), "virtual", &id])),
            "resources" => Some(jspath::join(&[&paths.profile_dir(name), "resources"])),
            _ => None,
        }
    });
    if let (Some(dir), Some(i)) = (&assets_dir, &installed) {
        let copy = prop(Some(i), "assetsLayout") == Some(&json!("resources"));
        (extra.on_stage)(
            "assets",
            if copy {
                "Laying out the sounds in this profile's folder"
            } else {
                "Laying out the shared sounds and language files"
            },
        );
        materialise_assets(
            paths,
            prop(Some(i), "assetIndex").unwrap_or(&Value::Null),
            dir,
            copy,
        )?;
    }
    if resolved.emulated && run_os.name == "windows" {
        warn(
            &mut warnings,
            "running under Windows x64 emulation (experimental)".into(),
        );
    }
    // Fabric and Quilt both load Fabric API (the fake game has none)
    if fake.is_none()
        && let Some(l @ ("fabric" | "quilt")) = loader.as_deref()
    {
        (extra.on_stage)(l, "Checking Fabric API");
    }
    if fake.is_none() && loader.is_some() {
        super::fabric::ensure_fabric_api(
            paths,
            name,
            &mc,
            opts.on_progress,
            &super::fabric::default_modrinth,
            &install::default_fetch,
        )?;
    }
    if fake.is_none() && js::truthy(profile.get("harness")) {
        (extra.on_stage)("harness", "Checking the harness mod");
        super::harness::ensure_harness_jar(
            paths,
            name,
            &mc,
            opts.on_progress,
            &super::harness::default_download,
        )?;
    }

    cancel::check_cancelled()?;
    let account = match &selector {
        None => offline_account(&match opts.player_name.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => default_player_name(name),
        })?,
        Some(sel) => match account_for(paths, sel, &http::send, &crate::util::now) {
            Ok(a) => a,
            Err(err) => {
                // no word from Microsoft is no reason to keep someone out of a world that checks
                // no accounts: the game starts with the sign-in as it was saved
                let checked = target
                    .as_deref()
                    .is_some_and(|t| server_checks_accounts(layout, t));
                if code_of(&err) != Some("sign-in-unreachable") || address.is_some() || checked {
                    return Err(err);
                }
                let saved = peek_account(paths, sel)?;
                warn(
                    &mut warnings,
                    format!(
                        "could not reach Microsoft to renew the sign-in for {}, so the game starts with the saved one; servers that check accounts will refuse it until this computer is online again",
                        js::string(prop(Some(&saved), "name"))
                    ),
                );
                saved
            }
        },
    };
    cancel::check_cancelled()?;
    // last before the game, so a failed download or sign-in does not leave a server started
    if let (true, Some(ensure), Some(t)) = (stopped, extra.ensure_server, &target) {
        (extra.on_stage)("server", &format!("Starting {t}"));
        ensure(t)?;
    }
    // the game reads its Multiplayer list as it starts, so this is the last moment to set it
    if let Some(skipped) = fill_server_list(paths, layout, name, &profile) {
        warn(
            &mut warnings,
            format!("the game's Multiplayer list was not brought up to date: {skipped}"),
        );
    }
    let harness_token = if js::truthy(profile.get("harness")) {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: format!("the system gave no random bytes: {e}"),
            code: None,
        })?;
        // a file from a crashed run would otherwise be read as this run's, before the mod
        // replaces it
        super::harness::remove_file(paths, name)?;
        Some(b.iter().map(|x| format!("{x:02x}")).collect::<String>())
    } else {
        None
    };
    let command = build_command(
        paths,
        &version_json,
        &profile,
        name,
        &account,
        &picked.path,
        &run_os,
        harness_token.as_deref(),
        join.as_ref(),
        assets_dir.as_deref(),
    )?;
    let account_short = json!({
        "type": prop(Some(&account), "type").cloned().unwrap_or(Value::Null),
        "name": prop(Some(&account), "name").cloned().unwrap_or(Value::Null),
    });
    (extra.on_stage)("spawn", "Starting the game");
    // the last moment: once the game is started, stopping it is Stop's job, not Cancel's
    cancel::check_cancelled()?;
    let started = spawn_client(
        paths,
        &command,
        name,
        StateFacts {
            mode: prop(Some(&account), "type").cloned().unwrap_or(json!("offline")),
            account: account_short.clone(),
            server: target.clone(),
            address: address.as_ref().map(Address::format),
            launched_by: extra.launched_by,
            harness: harness_token
                .as_ref()
                .map(|t| json!({ "token": t, "port": null })),
            launch: launch_facts(
                &resolved,
                &picked,
                bounds.as_ref(),
                installed.as_ref(),
                assets_dir.as_deref(),
            ),
        },
    )?;
    Ok(Launched {
        started,
        profile,
        version: version_id,
        account: account_short,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(min: f64, max: Option<f64>, prefer: f64) -> JavaRequirement {
        JavaRequirement {
            major: prefer,
            component: "java-runtime-delta".into(),
            min,
            max,
            prefer,
        }
    }

    fn cand(path: &str, major: f64, arch: Option<&str>) -> Candidate {
        Candidate {
            path: path.into(),
            major: Some(major),
            arch: arch.map(Into::into),
        }
    }

    #[test]
    fn addresses_are_parsed_as_node_parses_them() {
        assert_eq!(
            parse_server_address(" play.example.net ").unwrap(),
            Address {
                host: "play.example.net".into(),
                port: 25565
            }
        );
        assert_eq!(
            parse_server_address("[::1]:25570").unwrap().format(),
            "[::1]:25570"
        );
        assert_eq!(parse_server_address("10.0.0.2:1").unwrap().port, 1);
        for bad in [
            "",
            "a:b:c",
            "-x.net",
            "host:0",
            "host:65536",
            "host:",
            "[1.2.3.4]",
            "host:123456",
            "a b",
        ] {
            assert!(parse_server_address(bad).is_err(), "{bad}");
        }
        assert!(valid_host("127.0.0.1"));
        assert!(valid_host("::1"));
        assert!(!valid_host("bad_host"));
    }

    #[test]
    fn substitute_leaves_unknown_names() {
        let mut v = Map::new();
        v.insert("a".into(), json!(1));
        assert_eq!(substitute("${a}-${b}-$a", &v), "1-${b}-$a");
    }

    #[test]
    fn player_names_follow_the_profile() {
        assert_eq!(default_player_name("my-profile"), "my_profile");
        assert_eq!(default_player_name("ab"), "ab_");
        assert_eq!(
            default_player_name("a-very-long-profile-name"),
            "a_very_long_prof"
        );
        assert!(assert_player_name("no").is_err());
        let acc = offline_account("Steve").unwrap();
        assert_eq!(acc["uuid"], json!(crate::players::offline_uuid("Steve")));
    }

    #[test]
    fn the_client_java_is_chosen_as_node_chooses_it() {
        let all = vec![
            cand("/a", 21.0, Some("x64")),
            cand("/b", 17.0, None),
            cand("/c", 25.0, Some("x64")),
        ];
        assert_eq!(
            choose_client_java(&all, &req(17.0, None, 17.0), Some("x64"))
                .unwrap()
                .path,
            "/b"
        );
        assert_eq!(
            choose_client_java(&all, &req(8.0, None, 8.0), Some("x64"))
                .unwrap()
                .path,
            "/c"
        );
        assert_eq!(
            choose_client_java(&all, &req(8.0, Some(17.0), 8.0), Some("arm64"))
                .unwrap()
                .path,
            "/b"
        );
        assert!(choose_client_java(&all, &req(26.0, None, 26.0), None).is_none());
    }

    #[test]
    fn a_missing_runtime_falls_back_to_a_newer_java_with_a_warning() {
        let none = || -> Result<String, Failure> {
            Err(coded(
                "Mojang publishes no Java for linux ia32.",
                "no-runtime-for-this-machine",
            ))
        };
        let p = pick_client_java(
            None,
            &req(8.0, Some(8.0), 8.0),
            Some("x64"),
            "Minecraft 1.12.2",
            Some(vec![cand("/j21", 21.0, Some("x64"))]),
            Some(&none),
        )
        .unwrap();
        assert_eq!(p.source, "fallback");
        assert_eq!(
            p.warning.unwrap(),
            "Minecraft 1.12.2 wants Java 8; using Java 21 at /j21, which is newer, so the game may not start. Mojang's Java could not be had: Mojang publishes no Java for linux ia32. Install Java 8 from https://adoptium.net/temurin/releases/?version=8, or point the profile at one."
        );
        let e = pick_client_java(
            None,
            &req(21.0, None, 21.0),
            Some("x64"),
            "Minecraft 1.21",
            Some(vec![cand("/j17", 17.0, Some("x64"))]),
            Some(&none),
        )
        .unwrap_err();
        assert_eq!(code_of(&e), Some("no-runtime-for-this-machine"));
        let e = pick_client_java(
            None,
            &req(21.0, None, 21.0),
            Some("x64"),
            "Minecraft 1.21",
            Some(vec![]),
            None,
        )
        .unwrap_err();
        assert_eq!(code_of(&e), Some("java-missing"));
        let e = pick_client_java(
            None,
            &req(21.0, None, 21.0),
            Some("arm64"),
            "Minecraft 1.21",
            Some(vec![cand("/j", 21.0, Some("x64"))]),
            None,
        )
        .unwrap_err();
        assert_eq!(code_of(&e), Some("java-wrong-arch"));
        assert!(e.message().contains("the Javas found are x64."));
        let e = pick_client_java(
            None,
            &req(21.0, None, 21.0),
            None,
            "Minecraft 1.21",
            Some(vec![cand("java", 17.0, None)]),
            None,
        )
        .unwrap_err();
        assert_eq!(
            e.message(),
            "Minecraft 1.21 needs Java 21 or newer. The newest Java on this machine is 17. Install Java 21 from https://adoptium.net/temurin/releases/?version=21, or point the profile at one."
        );
        // a runtime that came down wrong refuses
        let broken = || -> Result<String, Failure> { Err(coded("checksum", "runtime-damaged")) };
        let e = pick_client_java(
            None,
            &req(21.0, None, 21.0),
            None,
            "M",
            Some(vec![]),
            Some(&broken),
        )
        .unwrap_err();
        assert_eq!(code_of(&e), Some("runtime-damaged"));
    }

    #[test]
    fn the_fake_network_refuses_only_invalid_names() {
        let at = |h: &str| Address {
            host: h.into(),
            port: 25565,
        };
        assert!(assert_resolvable(&at("anything.example"), "x", Lookup::Fake).is_ok());
        let e = assert_resolvable(&at("nowhere.invalid"), "server \"s\"", Lookup::Fake).unwrap_err();
        assert_eq!(
            e.message(),
            "server \"s\" cannot be reached: this machine cannot find nowhere.invalid (ENOTFOUND), so the game would stop at \"Unknown host\"; check the spelling, or that this machine is online"
        );
        assert!(assert_resolvable(&at("10.1.2.3"), "x", Lookup::System).is_ok());
    }
}
