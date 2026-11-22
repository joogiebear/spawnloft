//! The MCP protocol of `mcp.mjs`'s `createServer`: one JSON-RPC 2.0 object per line, dual-era.
//! A modern (2026-07-28) request carries its protocol version in `_meta` and is served without
//! a session, while `initialize` selects one of the older handshake revisions. There is no
//! per-client state either way; only the result shape differs.
//!
//! [`Server::handle`] takes one parsed message and gives the reply (or none). Requests run side
//! by side, each on its own thread ([`super::serve`]), so a slow `start` does not hold up a
//! status check; the cancel bookkeeping is shared under one lock.

use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::Mutex;

use spawnloft_lib::activity::Actor;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::js;

use super::tools::{Call, Tool};

pub const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META: &str = "io.modelcontextprotocol/";
const LIST_TTL_MS: u64 = 300_000;

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
pub const PARSE_ERROR: i64 = -32700;
const UNSUPPORTED_VERSION: i64 = -32022;

/// `RpcError`: answered as a JSON-RPC error rather than a tool result.
struct RpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> RpcError {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// A request id as a `Set` holds it: `1` and `"1"` are different, `1` and `1.0` the same.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    Text(String),
    Number(String),
}

fn key_of(id: &Value) -> Option<Key> {
    match id {
        Value::String(s) => Some(Key::Text(s.clone())),
        Value::Number(n) => Some(Key::Number(js::number_to_string(n.as_f64().unwrap_or(f64::NAN)))),
        _ => None,
    }
}

#[derive(Default)]
struct State {
    /// Only a request still in flight can be cancelled; ids are reused once answered.
    inflight: HashSet<Key>,
    cancelled: HashSet<Key>,
    /// The client's self-reported name, so the activity log can say which assistant changed
    /// what; modern requests carry it every time, handshake clients once in initialize.
    client_name: Option<String>,
}

/// A request admitted on the reading thread, to be answered by [`Server::run`].
#[derive(Debug)]
pub struct Request {
    id: Value,
    key: Key,
    method: String,
    params: Option<Value>,
    /// The client's name as it stood when the request came in.
    by: Option<String>,
}

/// What [`Server::admit`] made of a message: answered already (or needing no answer), or a
/// request to run.
#[derive(Debug)]
pub enum Admit {
    Done(Option<Value>),
    Run(Request),
}

pub type Notify = dyn Fn(&Value) + Send + Sync;
pub type Scrub = dyn Fn(&str) -> String + Send + Sync;

pub struct Server {
    pub info: Value,
    pub instructions: String,
    pub tools: Vec<&'static Tool>,
    listing: Vec<Value>,
    pub layout: spawnloft_lib::settings::Layout,
    notify: Box<Notify>,
    scrub: Box<Scrub>,
    state: Mutex<State>,
}

fn capabilities() -> Value {
    json!({ "tools": { "listChanged": false } })
}

/// `error(id, code, message, data)`.
pub fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = Map::new();
    e.insert("code".into(), json!(code));
    e.insert("message".into(), json!(message));
    if let Some(d) = data {
        e.insert("data".into(), d);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": Value::Object(e) })
}

/// `toolError(text)`.
fn tool_error(text: String) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("content".into(), json!([{ "type": "text", "text": text }]));
    m.insert("isError".into(), json!(true));
    m
}

/// `params?.[key]`: undefined unless `params` is an object holding it.
fn member<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

fn non_empty_string(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `scrubDeep(value, scrub)`.
pub fn scrub_deep(value: &Value, scrub: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::String(s) => Value::String(scrub(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| scrub_deep(v, scrub)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), scrub_deep(v, scrub))).collect()),
        other => other.clone(),
    }
}

/// `Object.prototype`'s own property names. `validate` looks a key up in a plain object, so an
/// argument named after one of these finds the inherited property, a truthy value with no
/// `type`, and passes unchecked even with `additionalProperties: false`. Kept, since the
/// argument is never read.
const PROTOTYPE_KEYS: &[&str] = &[
    "__proto__",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
];

/// `validate(schema, args)`: just enough JSON Schema for this server, an object of primitive
/// properties with required, enum, integer bounds and no extras.
pub fn validate(schema: &Value, args: &Value) -> Option<String> {
    let Value::Object(args) = args else {
        return Some("arguments must be an object".into());
    };
    let empty = Map::new();
    let props = match schema.get("properties") {
        Some(Value::Object(p)) => p,
        _ => &empty,
    };
    if let Some(Value::Array(required)) = schema.get("required") {
        for key in required {
            let key = js::string(Some(key));
            if !args.contains_key(&key) && !PROTOTYPE_KEYS.contains(&key.as_str()) {
                return Some(format!("\"{key}\" is required"));
            }
        }
    }
    for (key, value) in args {
        let Some(spec) = props.get(key) else {
            if PROTOTYPE_KEYS.contains(&key.as_str()) {
                continue;
            }
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Some(format!("unknown argument \"{key}\""));
            }
            continue;
        };
        let kind = spec.get("type").and_then(Value::as_str);
        let integer = value.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0);
        if kind == Some("integer") && !integer {
            return Some(format!("\"{key}\" must be a whole number"));
        }
        if kind == Some("string") && !value.is_string() {
            return Some(format!("\"{key}\" must be a string"));
        }
        if kind == Some("boolean") && !value.is_boolean() {
            return Some(format!("\"{key}\" must be true or false"));
        }
        if let Some(Value::Array(choices)) = spec.get("enum")
            && !choices.iter().any(|c| js::strict_equals(Some(c), Some(value)))
        {
            let list: Vec<String> = choices.iter().map(|c| js::string(Some(c))).collect();
            return Some(format!("\"{key}\" must be one of: {}", list.join(", ")));
        }
        // the bounds sit only on integers here, already checked to be numbers
        if let (Some(min), Some(v)) = (spec.get("minimum").and_then(Value::as_f64), value.as_f64())
            && v < min
        {
            return Some(format!(
                "\"{key}\" must be at least {}",
                js::string(spec.get("minimum"))
            ));
        }
        if let (Some(max), Some(v)) = (spec.get("maximum").and_then(Value::as_f64), value.as_f64())
            && v > max
        {
            return Some(format!(
                "\"{key}\" must be at most {}",
                js::string(spec.get("maximum"))
            ));
        }
        if let (Some(min), Value::String(s)) = (spec.get("minLength").and_then(Value::as_f64), value)
            && (s.encode_utf16().count() as f64) < min
        {
            return Some(format!("\"{key}\" must not be empty"));
        }
    }
    None
}

impl Server {
    pub fn new(
        info: Value,
        instructions: String,
        tools: Vec<&'static Tool>,
        layout: spawnloft_lib::settings::Layout,
        notify: Box<Notify>,
        scrub: Box<Scrub>,
    ) -> Server {
        let listing = tools.iter().map(|t| t.listing().clone()).collect();
        Server {
            info,
            instructions,
            tools,
            listing,
            layout,
            notify,
            scrub,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn scrub(&self, text: &str) -> String {
        (self.scrub)(text)
    }

    /// `reply(id, result, modern)`: none when the request was cancelled meanwhile.
    fn reply(&self, id: &Value, key: &Key, result: Map<String, Value>, modern: bool) -> Option<Value> {
        if self.lock().cancelled.remove(key) {
            return None;
        }
        let body = if modern {
            let mut b = Map::new();
            b.insert("resultType".into(), json!("complete"));
            for (k, v) in result {
                b.insert(k, v);
            }
            b.insert("_meta".into(), json!({ format!("{META}serverInfo"): self.info }));
            b
        } else {
            result
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": Value::Object(body) }))
    }

    /// `callTool(params, meta)`, as the client named by `by` when it was admitted.
    fn call_tool(&self, params: Option<&Value>, by: Option<&str>) -> Result<Map<String, Value>, RpcError> {
        let meta = member(params, "_meta");
        let asked = member(params, "name");
        let tool = match asked {
            Some(Value::String(n)) => self.tools.iter().find(|t| t.name == n),
            _ => None,
        };
        let Some(tool) = tool else {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("Unknown tool: {}", js::string(asked)),
            ));
        };
        let empty = json!({});
        let args = match member(params, "arguments") {
            None | Some(Value::Null) => &empty,
            Some(v) => v,
        };
        if let Some(problem) = validate(&tool.listing()["inputSchema"], args) {
            return Ok(tool_error(format!(
                "Invalid arguments for {}: {problem}",
                tool.name
            )));
        }
        let args = args.as_object().cloned().unwrap_or_default();

        let token = member(meta, "progressToken").cloned();
        let step = std::sync::atomic::AtomicU64::new(0);
        let progress = |message: &str| {
            if let Some(token) = &token {
                let n = step.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                (self.notify)(&json!({
                    "jsonrpc": "2.0", "method": "notifications/progress",
                    "params": { "progressToken": token, "progress": n, "message": self.scrub(message) },
                }));
            }
        };
        let call = Call {
            layout: &self.layout,
            by: Actor::new("assistant", Some(by.unwrap_or("AI assistant"))),
            progress: &progress,
        };
        // a crash is a tool error the model can read, as any throw from a tool is in Node. A
        // release build aborts on a panic instead (`panic = "abort"`), so this holds in tests and
        // debug builds only; a panic is a bug either way.
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (tool.run)(&call, &args)))
            .unwrap_or_else(|panic| {
                let message = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_else(|| "internal error".into());
                Err(Failure::type_error(message))
            });
        match ran {
            Ok(out) => {
                let safe = scrub_deep(&out.data, &|s| self.scrub(s));
                let text = match &out.text {
                    Some(t) => self.scrub(t),
                    None => self.scrub(&spawnloft_lib::jsjson::stringify(&safe)),
                };
                let mut body = Map::new();
                body.insert("content".into(), json!([{ "type": "text", "text": text }]));
                body.insert("structuredContent".into(), safe);
                if tool.failed.is_some_and(|f| f(&out.data)) {
                    body.insert("isError".into(), json!(true));
                }
                Ok(body)
            }
            // a user mistake and a crash both go back as tool errors the model can read;
            // neither carries a stack trace out
            Err(Failure::User {
                message,
                code: Some(code),
            }) => {
                // a refusal with a code names it, so an assistant can tell a version's limits
                // from a passing failure (review N-9)
                let message = self.scrub(&message);
                let mut body = tool_error(format!("{message} (code: {code})"));
                body.insert(
                    "structuredContent".into(),
                    json!({ "error": message, "code": code }),
                );
                Ok(body)
            }
            Err(Failure::User { message, .. } | Failure::Usage(message)) => {
                Ok(tool_error(self.scrub(&message)))
            }
            Err(Failure::Internal { message, .. }) => Ok(tool_error(
                self.scrub(&format!("{} failed: {message}", tool.name)),
            )),
        }
    }

    fn dispatch(
        &self,
        method: &str,
        params: Option<&Value>,
        modern: bool,
        by: Option<&str>,
    ) -> Result<Map<String, Value>, RpcError> {
        let obj = |v: Value| match v {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        match method {
            "ping" => Ok(Map::new()),
            "server/discover" => Ok(obj(json!({
                "supportedVersions": MODERN_VERSIONS,
                "capabilities": capabilities(),
                "instructions": self.instructions,
            }))),
            // 2026-07-28 clients reject a list that doesn't say how long it may be cached. The
            // listing depends on how the person launched it (--allow-destructive), so it is
            // private to this client.
            "tools/list" if modern => Ok(obj(
                json!({ "tools": self.listing, "ttlMs": LIST_TTL_MS, "cacheScope": "private" }),
            )),
            "tools/list" => Ok(obj(json!({ "tools": self.listing }))),
            "tools/call" => self.call_tool(params, by),
            other => Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("Method not found: {other}"),
            )),
        }
    }

    /// `handle(message)`, all at once: [`Server::admit`], then [`Server::run`].
    #[cfg(test)]
    pub fn handle(&self, message: &Value) -> Option<Value> {
        match self.admit(message) {
            Admit::Done(reply) => reply,
            Admit::Run(req) => self.run(&req),
        }
    }

    /// The part of `handle` the Node core does as each line is read, before its first `await`:
    /// the checks, the cancel bookkeeping, the request marked in flight and the client's name
    /// taken. Done on the reading thread, in line order, so a cancel that follows a request is
    /// never seen before it, and a call after an `initialize` acts under the name it gave.
    pub fn admit(&self, message: &Value) -> Admit {
        let Value::Object(msg) = message else {
            return Admit::Done(Some(invalid_request()));
        };
        if msg.get("jsonrpc") != Some(&json!("2.0")) {
            return Admit::Done(Some(invalid_request()));
        }
        // a response to a request this server never sends
        let Some(Value::String(method)) = msg.get("method") else {
            return Admit::Done(None);
        };
        let params = msg.get("params");
        let Some(id) = msg.get("id") else {
            if method == "notifications/cancelled"
                && let Some(key) = member(params, "requestId").and_then(key_of)
            {
                let mut st = self.lock();
                if st.inflight.contains(&key) {
                    st.cancelled.insert(key);
                }
            }
            return Admit::Done(None);
        };
        let Some(key) = key_of(id) else {
            return Admit::Done(Some(error(
                Value::Null,
                INVALID_REQUEST,
                "Invalid request id",
                None,
            )));
        };
        let mut st = self.lock();
        st.inflight.insert(key.clone());
        if method == "initialize" {
            if let Some(n) = non_empty_string(member(member(params, "clientInfo"), "name")) {
                st.client_name = Some(n);
            }
        } else if method == "tools/call"
            && Self::era(params).is_ok()
            && let Some(n) = non_empty_string(member(
                member(member(params, "_meta"), &format!("{META}clientInfo")),
                "name",
            ))
        {
            st.client_name = Some(n);
        }
        let by = st.client_name.clone();
        drop(st);
        Admit::Run(Request {
            id: id.clone(),
            key,
            method: method.clone(),
            params: params.cloned(),
            by,
        })
    }

    /// The rest of `handle`: the answer, then the request no longer in flight.
    pub fn run(&self, req: &Request) -> Option<Value> {
        let answer = self.answer(req);
        let mut st = self.lock();
        st.inflight.remove(&req.key);
        st.cancelled.remove(&req.key);
        answer
    }

    /// Which era a request is served in (true for modern), or why it is refused.
    fn era(params: Option<&Value>) -> Result<bool, RpcError> {
        let empty = json!({});
        let meta = match member(params, "_meta") {
            None | Some(Value::Null) => &empty,
            Some(m) => m,
        };
        let version = member(Some(meta), &format!("{META}protocolVersion"));
        // no version in _meta means a handshake-era client; served the same way even without
        // an initialize, since there is no session for it to be missing from
        let legacy = match version {
            None => true,
            Some(Value::String(v)) => LEGACY_VERSIONS.contains(&v.as_str()),
            Some(_) => false,
        };
        if legacy {
            return Ok(false);
        }
        let modern = matches!(version, Some(Value::String(v)) if MODERN_VERSIONS.contains(&v.as_str()));
        if !modern {
            let supported: Vec<&str> = MODERN_VERSIONS.iter().chain(LEGACY_VERSIONS).copied().collect();
            return Err(RpcError {
                code: UNSUPPORTED_VERSION,
                message: "Unsupported protocol version".into(),
                data: Some(json!({ "supported": supported, "requested": version })),
            });
        }
        let caps = member(Some(meta), &format!("{META}clientCapabilities"));
        if !matches!(caps, Some(Value::Object(_) | Value::Array(_))) {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("Missing _meta[\"{META}clientCapabilities\"]"),
            ));
        }
        Ok(true)
    }

    fn answer(&self, req: &Request) -> Option<Value> {
        let (id, key, method, params) = (&req.id, &req.key, req.method.as_str(), req.params.as_ref());
        let result = if method == "initialize" {
            let asked = member(params, "protocolVersion");
            let version = match asked {
                Some(Value::String(v)) if LEGACY_VERSIONS.contains(&v.as_str()) => v.clone(),
                _ => LEGACY_VERSIONS[0].to_string(),
            };
            let mut r = Map::new();
            r.insert("protocolVersion".into(), json!(version));
            r.insert("capabilities".into(), capabilities());
            r.insert("serverInfo".into(), self.info.clone());
            r.insert("instructions".into(), json!(self.instructions));
            Ok((r, false))
        } else {
            Self::era(params).and_then(|modern| {
                self.dispatch(method, params, modern, req.by.as_deref())
                    .map(|r| (r, modern))
            })
        };
        match result {
            Ok((r, modern)) => self.reply(id, key, r, modern),
            Err(e) => {
                if self.lock().cancelled.remove(key) {
                    return None;
                }
                Some(error(id.clone(), e.code, &e.message, e.data))
            }
        }
    }
}

fn invalid_request() -> Value {
    error(
        Value::Null,
        INVALID_REQUEST,
        "Invalid request: one JSON-RPC 2.0 object per line",
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn server(root: &std::path::Path, scrub: Box<Scrub>) -> (Server, Arc<Mutex<Vec<Value>>>) {
        let _ = std::fs::remove_dir_all(root);
        std::fs::create_dir_all(root).unwrap();
        let reg = json!({ "version": 1, "instances": {
            "alpha": { "dir": root.join("alpha").to_string_lossy(), "jar": "server.jar", "memory": "1G", "port": 45691,
                "rcon": { "port": 45692, "password": "fixture-secret-never-leaves" } },
        } });
        std::fs::write(root.join("instances.json"), reg.to_string()).unwrap();
        let mut s = Map::new();
        s.insert("dataRoot".into(), json!(root.to_string_lossy()));
        let layout = spawnloft_lib::settings::Layout::resolve(&s).unwrap();
        let notes = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&notes);
        let srv = Server::new(
            json!({ "name": "spawnloft", "title": "SpawnLoft", "version": "0" }),
            "instructions".into(),
            super::super::tools::tools_for(false),
            layout,
            Box::new(move |m: &Value| sink.lock().unwrap().push(m.clone())),
            scrub,
        );
        (srv, notes)
    }

    fn temp(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("sl-mcp-server-{label}-{}", std::process::id()))
    }

    /// From test/mcp.test.mjs, 'validate enforces what the tool schemas declare'.
    #[test]
    fn validate_enforces_what_the_tool_schemas_declare() {
        let schema = json!({ "type": "object", "additionalProperties": false, "required": ["a"],
            "properties": { "a": { "type": "string", "minLength": 1 },
                "n": { "type": "integer", "minimum": 1, "maximum": 5 }, "e": { "type": "string", "enum": ["x"] } } });
        assert_eq!(validate(&schema, &json!({ "a": "ok", "n": 3, "e": "x" })), None);
        let says = |args: Value| validate(&schema, &args).unwrap_or_default();
        assert!(says(json!({})).contains("required"));
        assert!(says(json!({ "a": "" })).contains("empty"));
        assert!(says(json!({ "a": "ok", "n": 1.5 })).contains("whole number"));
        assert!(says(json!({ "a": "ok", "n": 9 })).contains("at most"));
        assert!(says(json!({ "a": "ok", "n": 0 })).contains("at least"));
        assert!(says(json!({ "a": "ok", "e": "y" })).contains("one of"));
        assert!(says(json!({ "a": 5 })).contains("must be a string"));
        assert!(says(json!({ "a": "ok", "z": 1 })).contains("unknown argument \"z\""));
        assert!(says(json!([])).contains("object"));
        // Object.prototype's names pass unchecked, as in the Node core
        assert_eq!(
            validate(&schema, &json!({ "a": "ok", "constructor": 5, "__proto__": 1 })),
            None
        );
    }

    #[test]
    fn scrub_deep_cleans_every_string_and_keeps_the_keys() {
        let v = json!({ "secret": "a secret b", "list": ["secret", 1, null, { "x": "secret" }], "n": 2 });
        let out = scrub_deep(&v, &|s: &str| s.replace("secret", "[redacted]"));
        assert_eq!(
            out,
            json!({ "secret": "a [redacted] b", "list": ["[redacted]", 1, null, { "x": "[redacted]" }], "n": 2 })
        );
    }

    /// From test/mcp.test.mjs: the handshake, ping, unknown methods and requests that are not.
    #[test]
    fn requests_are_answered_as_the_node_core_answers_them() {
        let root = temp("handle");
        let (srv, _) = server(&root, Box::new(|s: &str| s.to_string()));
        let init = srv
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "1999-01-01", "clientInfo": { "name": "Fixture" } } }))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], json!(LEGACY_VERSIONS[0]));
        assert_eq!(init["result"]["serverInfo"]["name"], json!("spawnloft"));
        assert_eq!(
            srv.handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }))
                .unwrap()["result"],
            json!({})
        );
        let unknown = srv
            .handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "no/such" }))
            .unwrap();
        assert_eq!(unknown["error"]["code"], json!(METHOD_NOT_FOUND));
        // a notification and a response get no answer
        assert_eq!(
            srv.handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            None
        );
        assert_eq!(
            srv.handle(&json!({ "jsonrpc": "2.0", "id": 4, "result": {} })),
            None
        );
        for bad in [
            json!([1]),
            json!(null),
            json!(5),
            json!({ "jsonrpc": "1.0", "id": 5, "method": "ping" }),
        ] {
            let r = srv.handle(&bad).unwrap();
            assert_eq!(r["error"]["code"], json!(INVALID_REQUEST), "{bad}");
            assert_eq!(r["id"], Value::Null);
        }
        let bad_id = srv
            .handle(&json!({ "jsonrpc": "2.0", "id": {}, "method": "ping" }))
            .unwrap();
        assert_eq!(bad_id["error"]["message"], json!("Invalid request id"));
        // an unsupported modern version names the ones there are
        let modern = srv
            .handle(&json!({ "jsonrpc": "2.0", "id": 6, "method": "ping",
                "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } }))
            .unwrap();
        assert_eq!(modern["error"]["code"], json!(UNSUPPORTED_VERSION));
        assert_eq!(modern["error"]["data"]["requested"], json!("2030-01-01"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// From test/mcp.test.mjs, 'mistakes come back as tool errors; unknown tools as protocol
    /// errors' and 'no credential or webhook leaves'.
    #[test]
    fn tool_mistakes_are_tool_errors_and_secrets_never_leave() {
        let root = temp("tools");
        let secret = "fixture-secret-never-leaves";
        let (srv, _) = server(&root, Box::new(move |s: &str| s.replace(secret, "[redacted]")));
        let call = |id: i64, name: &str, args: Value| {
            srv.handle(&json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": { "name": name, "arguments": args } }))
                .unwrap()
        };
        let unknown = call(1, "no_such_tool", json!({}));
        assert_eq!(unknown["error"]["code"], json!(INVALID_PARAMS));
        assert_eq!(unknown["error"]["message"], json!("Unknown tool: no_such_tool"));
        let missing = call(2, "server_status", json!({}));
        assert_eq!(missing["result"]["isError"], json!(true));
        assert_eq!(
            missing["result"]["content"][0]["text"],
            json!("Invalid arguments for server_status: \"name\" is required")
        );
        let nope = call(3, "server_status", json!({ "name": "nope" }));
        assert_eq!(nope["result"]["isError"], json!(true));
        // the destructive tools are not offered without --allow-destructive
        assert_eq!(
            call(4, "kill", json!({ "name": "alpha" }))["error"]["code"],
            json!(INVALID_PARAMS)
        );
        let status = call(5, "server_status", json!({ "name": "alpha" }));
        assert_eq!(status["result"].get("isError"), None, "{status}");
        let listed = call(6, "list_servers", json!({}));
        assert!(!listed.to_string().contains(secret));
        let _ = std::fs::remove_dir_all(&root);
    }
}
