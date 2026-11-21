//! The Modrinth client of `plugins.mjs` (C5): `modrinth(pathname, init)` (exported as
//! `modrinthRequest`), `pickVersion` and `primaryFile`, and the plain `fetch` the plugin and pack
//! downloads make. The modpack install (`mrpack.rs`) and the client's Fabric API (C7) use them.
//!
//! Requests go out as Node's `fetch` sends them: no proxy, the test-only origin map of a
//! `test-hooks` build, `accept: */*`, and the user agent the caller names (Modrinth's API asks for
//! one; a download names none, so it is undici's `node`).

use std::io::Read;
use std::time::Duration;

use serde_json::Value;

use crate::failure::Failure;
use crate::js;

pub const MODRINTH: &str = "https://api.modrinth.com/v2";

/// The user agent `plugins.mjs` sends Modrinth and Hangar (Modrinth requires one).
pub const PLUGINS_UA: &str = "joogiebear/spawnloft (github.com/joogiebear/spawnloft)";

/// What Node's `fetch` sends when a caller names no user agent.
pub const NODE_UA: &str = "node";

pub const TIMED_OUT: &str = "The operation was aborted due to timeout";

/// One request as `fetch(url, init)` makes it.
#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub user_agent: &'a str,
    /// a JSON body, sent with `content-type: application/json`
    pub json_body: Option<String>,
    /// `AbortSignal.timeout(ms)` on the whole exchange
    pub timeout: Duration,
    /// `redirect: 'manual'`: a 3xx is handed back instead of followed
    pub manual_redirects: bool,
}

/// An answer: its status, the headers a caller reads, and the body still to be read.
pub struct Reply {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<String>,
    pub body: Box<dyn Read + Send>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// `res.ok && res.body`: 204 and 205 carry none.
    pub fn ok_with_body(&self) -> bool {
        self.ok() && self.status != 204 && self.status != 205
    }
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reply")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// Why a request got no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lost {
    /// the parity rig's origin map refused it (a `test-hooks` build); Node's `err.message`
    Refused(String),
    /// the connection failed: `err.cause.message` in Node's place
    Failed(String),
    /// the signal's time limit
    Timeout,
}

impl Lost {
    /// `err.cause?.message || err.message`.
    pub fn why(&self) -> String {
        match self {
            Lost::Refused(m) | Lost::Failed(m) => m.clone(),
            Lost::Timeout => TIMED_OUT.into(),
        }
    }
}

fn is_timeout(e: &ureq::Error) -> bool {
    match e {
        ureq::Error::Timeout(_) => true,
        ureq::Error::Io(io) => io.kind() == std::io::ErrorKind::TimedOut,
        _ => false,
    }
}

/// The network.
pub fn send(req: &Request<'_>) -> Result<Reply, Lost> {
    // `fetch` refuses text that is not a URL before anything is sent
    if url::Url::parse(req.url).is_err() {
        return Err(Lost::Failed("Invalid URL".into()));
    }
    let target = crate::download::target(req.url).map_err(Lost::Refused)?;
    let cfg = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(if req.manual_redirects { 0 } else { 20 })
        .max_redirects_will_error(false)
        .user_agent(req.user_agent)
        .timeout_global(Some(req.timeout));
    let agent = ureq::Agent::new_with_config(cfg.build());
    let lost = |e: ureq::Error| {
        if is_timeout(&e) {
            Lost::Timeout
        } else {
            Lost::Failed(crate::download::cause(&e))
        }
    };
    let res = match &req.json_body {
        None => agent.get(&target).header("accept", "*/*").call().map_err(lost)?,
        Some(body) => agent
            .post(&target)
            .header("accept", "*/*")
            .header("content-type", "application/json")
            .send(body.as_bytes())
            .map_err(lost)?,
    };
    // header bytes are read as latin1, as undici reads them
    let header = |k: &str| {
        res.headers()
            .get(k)
            .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect::<String>())
    };
    let location = header("location");
    let content_length = header("content-length");
    // a followed request still pointing somewhere after the 20th hop: undici gives up
    if !req.manual_redirects && (300..400).contains(&res.status().as_u16()) && location.is_some() {
        return Err(Lost::Failed("redirect count exceeded".into()));
    }
    Ok(Reply {
        status: res.status().as_u16(),
        location,
        content_length,
        body: Box::new(res.into_body().into_reader()),
    })
}

/// The body read whole (`res.json()`, `res.arrayBuffer()`): a read that breaks is undici's
/// `TypeError: terminated`, or the time limit's own error.
pub fn read_all(reply: Reply) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::new();
    let mut body = reply.body;
    body.read_to_end(&mut out).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            Failure::Internal {
                head: "TimeoutError".into(),
                message: TIMED_OUT.into(),
                code: None,
            }
        } else {
            Failure::type_error("terminated")
        }
    })?;
    Ok(out)
}

/// `res.json()`.
pub fn read_json(reply: Reply) -> Result<Value, Failure> {
    let bytes = read_all(reply)?;
    crate::jsjson::parse(&crate::download::json_text(&bytes)).map_err(Failure::syntax)
}

/// `modrinth(pathname, init)` / `modrinthRequest`: a GET, or a POST of `body` as JSON, with a 15 s
/// limit; the answer parsed as JSON.
pub fn modrinth_request(pathname: &str, body: Option<&Value>) -> Result<Value, Failure> {
    let url = format!("{MODRINTH}{pathname}");
    let reply = send(&Request {
        method: if body.is_some() { "POST" } else { "GET" },
        url: &url,
        user_agent: PLUGINS_UA,
        json_body: body.map(crate::jsjson::stringify),
        timeout: Duration::from_secs(15),
        manual_redirects: false,
    })
    .map_err(|e| Failure::user(format!("could not reach Modrinth: {}", e.why())))?;
    if !reply.ok() {
        return Err(Failure::user(format!(
            "Modrinth answered {} for {pathname}",
            reply.status
        )));
    }
    read_json(reply)
}

// ---------------------------------------------------------------------------------------------
// JavaScript's reads of an answer whose shape is not trusted

/// `TypeError: Cannot read properties of <null|undefined> (reading '<key>')`.
fn no_props(base: Option<&Value>, key: &str) -> Failure {
    Failure::type_error(format!(
        "Cannot read properties of {} (reading '{key}')",
        if base.is_none() { "undefined" } else { "null" }
    ))
}

/// `base.key`: only objects carry fields here (an array's or a string's own are never asked for).
pub fn prop<'a>(base: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, Failure> {
    match base {
        None | Some(Value::Null) => Err(no_props(base, key)),
        Some(Value::Object(m)) => Ok(m.get(key)),
        Some(_) => Ok(None),
    }
}

/// `list.includes(x)` for a string `x`: an array's strict equality, a string's substring search,
/// anything else not a function.
fn includes(list: Option<&Value>, x: &str, expr: &str) -> Result<bool, Failure> {
    match list {
        Some(Value::Array(items)) => Ok(items.iter().any(|v| v.as_str() == Some(x))),
        Some(Value::String(s)) => Ok(s.contains(x)),
        None | Some(Value::Null) => Err(no_props(list, "includes")),
        Some(_) => Err(Failure::type_error(format!("{expr}.includes is not a function"))),
    }
}

/// The items of `list` for an array method `method`.
fn items<'a>(list: Option<&'a Value>, method: &str, expr: &str) -> Result<&'a [Value], Failure> {
    match list {
        Some(Value::Array(items)) => Ok(items),
        None | Some(Value::Null) => Err(no_props(list, method)),
        Some(_) => Err(Failure::type_error(format!("{expr}.{method} is not a function"))),
    }
}

/// `pickVersion(versions, { gameVersion, loaders })`: Modrinth lists newest first; the first
/// release matching the loaders and the game version, else the newest that matches at all.
pub fn pick_version(
    versions: &Value,
    game_version: Option<&str>,
    loaders: &[&str],
) -> Result<Option<Value>, Failure> {
    let list = items(Some(versions), "find", "versions")?;
    let fits = |v: &Value| -> Result<bool, Failure> {
        let ls = items(prop(Some(v), "loaders")?, "some", "v.loaders")?;
        if !ls
            .iter()
            .any(|l| l.as_str().is_some_and(|l| loaders.contains(&l)))
        {
            return Ok(false);
        }
        match game_version.filter(|g| !g.is_empty()) {
            None => Ok(true),
            Some(g) => includes(prop(Some(v), "game_versions")?, g, "v.game_versions"),
        }
    };
    for v in list {
        if prop(Some(v), "version_type")?.and_then(Value::as_str) == Some("release") && fits(v)? {
            return Ok(Some(v.clone()));
        }
    }
    for v in list {
        if fits(v)? {
            return Ok(Some(v.clone()));
        }
    }
    Ok(None)
}

/// `primaryFile(version)`: the file marked primary, else the first, else none.
pub fn primary_file(version: &Value) -> Result<Option<Value>, Failure> {
    let files = items(prop(Some(version), "files")?, "find", "version.files")?;
    for f in files {
        if js::truthy(prop(Some(f), "primary")?) {
            return Ok(Some(f.clone()));
        }
    }
    Ok(files.first().filter(|f| !f.is_null()).cloned())
}

/// `new URLSearchParams({ key: value }).toString()` for one pair.
pub fn search_param(key: &str, value: &str) -> String {
    crate::client::http::form(&[(key, value)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(over: Value) -> Value {
        let mut base = json!({
            "version_type": "release", "loaders": ["paper"], "game_versions": ["26.2"],
            "files": [{ "primary": true, "filename": "x.jar", "url": "u", "hashes": { "sha1": "abc" } }],
        });
        for (k, x) in over.as_object().unwrap() {
            base[k] = x.clone();
        }
        base
    }

    #[test]
    fn the_newest_compatible_release_wins_pre_releases_only_when_nothing_else_fits() {
        let versions = json!([
            v(json!({"version_type": "beta", "version_number": "2.0-beta"})),
            v(json!({"version_number": "1.9"}))
        ]);
        let got = pick_version(&versions, Some("26.2"), &crate::plugins::LOADERS)
            .unwrap()
            .unwrap();
        assert_eq!(got["version_number"], "1.9");
        let beta = json!([v(json!({"version_type": "beta", "version_number": "b"}))]);
        assert_eq!(
            pick_version(&beta, None, &crate::plugins::LOADERS)
                .unwrap()
                .unwrap()["version_number"],
            "b"
        );
    }

    #[test]
    fn a_version_for_the_wrong_loader_or_game_version_does_not_fit() {
        let l = &crate::plugins::LOADERS;
        assert_eq!(
            pick_version(&json!([v(json!({"loaders": ["fabric"]}))]), None, l).unwrap(),
            None
        );
        assert_eq!(
            pick_version(&json!([v(json!({"game_versions": ["25.1"]}))]), Some("26.2"), l).unwrap(),
            None
        );
        assert!(l.contains(&"spigot"), "paper servers load spigot builds");
    }

    #[test]
    fn the_primary_file_wins_the_first_stands_in_when_nothing_is_marked() {
        let files = json!({"files": [{"filename": "a.jar"}, {"filename": "b.jar", "primary": true}]});
        assert_eq!(primary_file(&files).unwrap().unwrap()["filename"], "b.jar");
        assert_eq!(
            primary_file(&json!({"files": [{"filename": "a.jar"}]}))
                .unwrap()
                .unwrap()["filename"],
            "a.jar"
        );
        assert_eq!(primary_file(&json!({"files": []})).unwrap(), None);
    }

    #[test]
    fn odd_answers_throw_as_javascript_does() {
        let l = &crate::plugins::LOADERS;
        assert_eq!(
            pick_version(&json!({}), None, l).unwrap_err().message(),
            "versions.find is not a function"
        );
        assert_eq!(
            pick_version(&json!([null]), None, l).unwrap_err().message(),
            "Cannot read properties of null (reading 'version_type')"
        );
        assert_eq!(
            pick_version(&json!([{"version_type": "release"}]), None, l)
                .unwrap_err()
                .message(),
            "Cannot read properties of undefined (reading 'some')"
        );
        // a game version list that is a string is searched as text
        let s = json!([v(json!({"game_versions": "1.21.4-ish"}))]);
        assert!(pick_version(&s, Some("1.21.4"), &["paper"]).unwrap().is_some());
        assert_eq!(
            primary_file(&json!({})).unwrap_err().message(),
            "Cannot read properties of undefined (reading 'find')"
        );
    }

    #[test]
    fn a_search_parameter_is_form_encoded() {
        assert_eq!(
            search_param("loaders", "[\"fabric\",\"neoforge\"]"),
            "loaders=%5B%22fabric%22%2C%22neoforge%22%5D"
        );
    }
}
