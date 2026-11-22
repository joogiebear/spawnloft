//! What client.mjs does with a running game through its harness, for the MCP client tools:
//! `session` (one open channel per profile, kept while the same game runs), `join`,
//! `waitUntilLoaded`, `chat`, `messages`, `screenshot` and `stop`. The command line never
//! needed these, so they came with C9.
//!
//! Node keeps the channels in a module-level map and its calls interleave on one socket; here
//! [`Sessions`] holds them, and calls on one channel take turns.

use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::harness::{self, Channel};
use super::paths::Paths;
use super::{profiles, prop, state};
use crate::failure::Failure;
use crate::js;
use crate::settings::Layout;

/// How long `client_launch` waits for the game to load (`LAUNCH_WAIT_MS`).
pub const LAUNCH_WAIT_MS: u64 = 90_000;
/// A call's default wait (`call(op, args, { timeout = 10000 })`).
const CALL_MS: u64 = 10_000;

type Shared = Arc<Mutex<Channel>>;

/// The open channels, by profile, with the pid of the game each belongs to.
#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, (Value, Shared)>>,
}

impl std::fmt::Debug for Sessions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sessions").finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn not_running(name: &str) -> Failure {
    Failure::user(format!(
        "profile \"{name}\" is not running; launch it first: spawnloft client launch {name}"
    ))
}

fn user_message(e: &Failure) -> Option<&str> {
    match e {
        Failure::User { message, .. } | Failure::Usage(message) => Some(message),
        Failure::Internal { .. } => None,
    }
}

/// `waitForHarness(profileName, token, { timeout, alive, pid })`: the harness file can be
/// written a moment before its socket accepts, so a refusal is tried again until `timeout_ms`.
pub fn wait_for_harness(
    paths: &Paths,
    name: &str,
    token: Option<&Value>,
    timeout_ms: u64,
    alive: &dyn Fn() -> bool,
    pid: Option<&Value>,
) -> Result<Channel, Failure> {
    let start = Instant::now();
    loop {
        if !alive() {
            return Err(Failure::user("the client exited before its harness answered"));
        }
        if harness::read_file(paths, name, pid)?.is_some() {
            match harness::connect(paths, name, token, 2000, pid) {
                Ok(ch) => return Ok(ch),
                Err(e) => match user_message(&e) {
                    Some(m) if m.contains("refused the token") => return Err(e),
                    Some(m) if m.contains("refused") || m.contains("went away") => {}
                    _ => return Err(e),
                },
            }
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            return Err(Failure::user(format!(
                "the harness did not answer within {} s; see spawnloft client logs {name}",
                js::number_to_string((timeout_ms as f64 / 1000.0 + 0.5).floor())
            )));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

impl Sessions {
    /// `session(name)`.
    fn session(&self, paths: &Paths, name: &str) -> Result<Shared, Failure> {
        // the name becomes part of the state and harness file paths
        profiles::get(paths, name)?;
        let Some(st) = state::read(paths, name)? else {
            return Err(not_running(name));
        };
        if !js::truthy(prop(Some(&st), "harness")) {
            return Err(Failure::user(format!(
                "profile \"{name}\" was launched without the harness; set harness=true on a fabric profile (spawnloft client set {name} harness=true) and launch it again"
            )));
        }
        let pid = prop(Some(&st), "pid").cloned().unwrap_or(Value::Null);
        if let Some((cached_pid, ch)) = lock(&self.map).get(name)
            && js::strict_equals(Some(cached_pid), Some(&pid))
        {
            return Ok(ch.clone());
        }
        let token = prop(prop(Some(&st), "harness"), "token");
        let alive = || state::status(paths, name).is_ok_and(|s| s.running);
        let channel = wait_for_harness(paths, name, token, 90_000, &alive, Some(&pid))?;
        let shared = Arc::new(Mutex::new(channel));
        lock(&self.map).insert(name.to_string(), (pid, shared.clone()));
        Ok(shared)
    }

    /// `viaSession(name, fn)`: a channel the harness dropped is forgotten, so the next call opens
    /// a new one.
    fn call(
        &self,
        paths: &Paths,
        name: &str,
        op: &str,
        args: Map<String, Value>,
        timeout_ms: u64,
    ) -> Result<Value, Failure> {
        let ch = self.session(paths, name)?;
        let res = lock(&ch).call(op, args, timeout_ms);
        if let Err(e) = &res
            && user_message(e).is_some_and(|m| m.contains("went away"))
        {
            lock(&self.map).remove(name);
        }
        res
    }

    fn status_call(&self, paths: &Paths, name: &str) -> Result<Value, Failure> {
        self.call(paths, name, "status", Map::new(), CALL_MS)
    }

    /// `status` through the harness, for `client_status`: `client.session(p)` and the call on
    /// it, not through `viaSession`, so a channel that went away stays cached, as in Node.
    pub fn harness_status(&self, paths: &Paths, name: &str) -> Result<Value, Failure> {
        let ch = self.session(paths, name)?;
        lock(&ch).call("status", Map::new(), CALL_MS)
    }

    /// `waitInWorld(name, server, waitMs)`: the mod answers once the player entity exists, while
    /// the screen still says "Loading terrain"; wait for "ingame".
    fn wait_in_world(&self, paths: &Paths, name: &str, server: &str, wait_ms: u64) -> Result<Value, Failure> {
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        let mut st = self.status_call(paths, name)?;
        while screen(&st) != "ingame" && !left_server(&screen(&st)) && Instant::now() < deadline {
            // never past the wait that was asked for
            let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
            std::thread::sleep(Duration::from_millis(left.clamp(1, 500)));
            st = self.status_call(paths, name)?;
        }
        if left_server(&screen(&st)) {
            return Err(Failure::user(format!(
                "\"{name}\" was disconnected from {server} while the world loaded; read the reason with client_status or spawnloft client logs {name}"
            )));
        }
        Ok(st)
    }

    /// `join(name, server, { loadWaitMs })`.
    pub fn join(
        &self,
        paths: &Paths,
        layout: &Layout,
        name: &str,
        server: &str,
        load_wait_ms: u64,
    ) -> Result<Value, Failure> {
        // the account decides the online-mode rule below, and a stopped client has none to go by
        let st = state::status(paths, name)?;
        if !st.running {
            return Err(not_running(name));
        }
        let account = prop(Some(&st.json), "account").cloned();
        let check = crate::bots::check_instance(layout, server)?;
        // The offline-mode rule is for players without an account; a signed-in one may join an
        // online server. checkInstance words it for bots, so an offline client gets the launch
        // warning's wording.
        let mut problems = Vec::new();
        for p in &check.problems {
            if !p.contains("runs in online mode") {
                problems.push(p.clone());
            } else if js::string(prop(account.as_ref(), "type")) != "microsoft" {
                problems.push(format!(
                    "{}.",
                    super::launch::online_mode_refusal(server, &js::string(prop(account.as_ref(), "name")))
                ));
            }
        }
        if !problems.is_empty() {
            return Err(Failure::user(problems.join(" ")));
        }
        let host = check.host.clone();
        let inst = crate::registry::lookup(std::path::Path::new(&layout.registry_file), server)?;
        let port = inst.get("port").cloned().unwrap_or(Value::Null);
        let is_here = |st: &Value| {
            let c = prop(Some(st), "connected");
            js::truthy(c)
                && js::strict_equals(prop(c, "host"), Some(&json!(host)))
                && js::strict_equals(prop(c, "port"), Some(&port))
        };
        // A profile with a server joins it by itself on launch. Asked to join while that is under
        // way, a second connect would race the first, so wait for the first one instead.
        let before = self.status_call(paths, name)?;
        let launch_target = state::read(paths, name)?
            .and_then(|s| prop(Some(&s), "server").cloned())
            .filter(|v| !v.is_null());
        let connected = js::truthy(prop(Some(&before), "connected"));
        let scr = screen(&before);
        let result = if is_here(&before) {
            json!({ "joined": true, "already": true })
        } else if !connected
            && launch_target.as_ref() == Some(&json!(server))
            && (scr == "connecting" || scr == "other")
        {
            // still loading, or on the connect screen: the launch's own join is coming or under way
            json!({ "joined": true, "already": true })
        } else if scr == "connecting" && !connected {
            return Err(Failure::user(format!(
                "\"{name}\" is still connecting to a server; wait until client_status shows it in the world, then disconnect before joining {server}"
            )));
        } else {
            let mut a = Map::new();
            a.insert("host".into(), json!(host));
            a.insert("port".into(), port.clone());
            self.call(paths, name, "join", a, 65_000)?
        };
        let st = self.wait_in_world(paths, name, server, load_wait_ms)?;
        // a connect waited on may have been to another server (one picked in the game's list)
        if js::truthy(prop(Some(&st), "connected")) && !is_here(&st) {
            let c = prop(Some(&st), "connected");
            return Err(Failure::user(format!(
                "\"{name}\" is on {}:{}, not {server}; disconnect first",
                js::string(prop(c, "host")),
                js::string(prop(c, "port"))
            )));
        }
        // `{ ...result, server, host, port, loaded, screen }`: a reply that is not an object
        // spreads as nothing (or, a string, as its characters), and an undefined screen is left
        // out when it is written
        let mut m = match result {
            Value::Object(m) => m,
            Value::String(t) => t
                .encode_utf16()
                .enumerate()
                .map(|(i, u)| (i.to_string(), json!(String::from_utf16_lossy(&[u]))))
                .collect(),
            _ => Map::new(),
        };
        m.insert("server".into(), json!(server));
        m.insert("host".into(), json!(host));
        m.insert("port".into(), port);
        m.insert("loaded".into(), json!(screen(&st) == "ingame"));
        match prop(Some(&st), "screen") {
            Some(v) => {
                m.insert("screen".into(), v.clone());
            }
            None => {
                m.shift_remove("screen");
            }
        }
        Ok(Value::Object(m))
    }

    /// `waitUntilLoaded(name, { server, timeoutMs, fadeMs })`: the title screen, or the world
    /// (or a disconnect) when the launch joins a server, then the loading overlay's fade-out.
    pub fn wait_until_loaded(
        &self,
        paths: &Paths,
        name: &str,
        server: Option<&str>,
        timeout_ms: u64,
        fade_ms: u64,
    ) -> Result<Value, Failure> {
        let booting = |st: &Value| {
            let title = js::string(prop(Some(st), "screenTitle"));
            let titled = js::truthy(prop(Some(st), "screenTitle"));
            (screen(st) == "other" && !titled) || (titled && title.to_lowercase().contains("loading"))
        };
        let mut connecting = false;
        let mut loaded = |st: &Value| {
            let s = screen(st);
            if s == "connecting" {
                connecting = true;
            }
            match server {
                None => !booting(st) && s != "connecting",
                // a refused or kicked join can land back on the title screen, but so can the
                // moment before the launch's join starts, so the title counts only once the join
                // was seen
                Some(_) => {
                    s == "ingame" || s == "disconnected" || s == "multiplayer" || (connecting && s == "title")
                }
            }
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut st = self.status_call(paths, name)?;
        let mut done = loaded(&st);
        while !done && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
            st = self.status_call(paths, name)?;
            done = loaded(&st);
        }
        if !done {
            return Ok(with_loaded(st, false));
        }
        std::thread::sleep(Duration::from_millis(fade_ms));
        Ok(with_loaded(self.status_call(paths, name)?, true))
    }

    /// `chat(name, text)`.
    pub fn chat(&self, paths: &Paths, name: &str, text: &str) -> Result<Value, Failure> {
        if js::trim(text).is_empty() {
            return Err(Failure::user("chat needs text"));
        }
        if text.starts_with('/') {
            let verb = crate::bots::command_verb(text);
            if crate::bots::REFUSED_CONSOLE.contains(&verb.as_str()) {
                return Err(Failure::user(format!(
                    "\"{verb}\" would take the server down or half-reload it; a client cannot run it, send it from the console if you mean it"
                )));
            }
        }
        let mut a = Map::new();
        a.insert("text".into(), json!(text));
        self.call(paths, name, "chat", a, CALL_MS)
    }

    /// `messages(name, since)`; an undefined `since` is left out of the request.
    pub fn messages(&self, paths: &Paths, name: &str, since: Option<&Value>) -> Result<Value, Failure> {
        let mut a = Map::new();
        if let Some(s) = since {
            a.insert("since".into(), s.clone());
        }
        self.call(paths, name, "messages", a, CALL_MS)
    }

    /// `screenshot(name)`.
    pub fn screenshot(&self, paths: &Paths, name: &str) -> Result<Value, Failure> {
        self.call(paths, name, "screenshot", Map::new(), CALL_MS)
    }

    /// `stop(name)`: through the open channel when there is one for this game, else as
    /// `client stop` does it.
    pub fn stop(&self, paths: &Paths, name: &str) -> Result<Value, Failure> {
        profiles::get(paths, name)?;
        let st = state::read(paths, name)?;
        let pid = st.as_ref().and_then(|s| prop(Some(s), "pid").cloned());
        let cached = lock(&self.map)
            .get(name)
            .filter(|(p, _)| {
                pid.as_ref()
                    .is_some_and(|pid| js::strict_equals(Some(p), Some(pid)))
            })
            .map(|(_, ch)| ch.clone());
        let res = match (&st, cached) {
            (Some(s), Some(ch)) if js::truthy(prop(Some(s), "harness")) => {
                let quit = || lock(&ch).call("quit", Map::new(), 5000).map(|_| ());
                state::stop_client(paths, name, Some(&quit))
            }
            _ => state::stop(paths, name),
        };
        lock(&self.map).remove(name);
        res
    }
}

fn screen(st: &Value) -> String {
    match prop(Some(st), "screen") {
        Some(Value::String(s)) => s.clone(),
        v => js::string(v),
    }
}

/// A kick can land on the disconnect screen or straight back on the title or server list.
fn left_server(screen: &str) -> bool {
    matches!(screen, "disconnected" | "title" | "multiplayer")
}

fn with_loaded(st: Value, loaded: bool) -> Value {
    let mut m = match st {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("loaded".into(), json!(loaded));
    Value::Object(m)
}
