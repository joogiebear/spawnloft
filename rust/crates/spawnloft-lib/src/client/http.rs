//! The sign-in chain's requests: `fetch(url, { method, headers, body })` as client-auth.mjs makes
//! them, and `bodyOf(res)`. Blocking `ureq` with the proxy off and Node's redirect limit, as in
//! download.rs.
//!
//! The User-Agent is the one Node's `fetch` sends when a caller names none (`node`, undici's
//! default), and `Accept` is `*/*` unless the request names one, so both cores ask Microsoft,
//! Xbox and Mojang the same thing (the parity rig compares both headers). Once the Node core is
//! gone (C10) this can become the download agent's `SpawnLoft (...)`.

use std::io::Read;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::failure::Failure;

/// What Node's `fetch` sends as the User-Agent when a caller names none.
pub const NODE_FETCH_UA: &str = "node";

/// One request of the chain.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    /// Header names in lower case, as client-auth.mjs writes them.
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
    /// `AbortSignal.timeout(ms)` on the whole request, body included.
    pub timeout: Option<Duration>,
}

/// An answer: the status and `bodyOf(res)` (`res.json() ?? {}`, `{}` when the body is not JSON
/// or could not be read).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a request got no answer: `TypeError: fetch failed` (the connection), or the timeout's
/// `TimeoutError`. The text is Node's `err.message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lost {
    Failed,
    Timeout,
}

impl Lost {
    pub fn message(&self) -> &'static str {
        match self {
            Lost::Failed => "fetch failed",
            Lost::Timeout => "The operation was aborted due to timeout",
        }
    }
    /// The error as it surfaces when nothing catches it.
    pub fn failure(&self) -> Failure {
        Failure::Internal {
            head: match self {
                Lost::Failed => "TypeError",
                Lost::Timeout => "TimeoutError",
            }
            .into(),
            message: self.message().into(),
            code: None,
        }
    }
}

/// The transport the chain runs over: the network, or a test's answers.
pub type Send<'a> = &'a (dyn Fn(&Request) -> Result<Answer, Lost> + Sync);

/// `bodyOf(res)` over the bytes of a body.
pub fn body_of(bytes: &[u8]) -> Value {
    // `res.json()` decodes as UTF-8 does, a byte-order mark dropped
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match crate::jsjson::parse(&String::from_utf8_lossy(bytes)) {
        Ok(Value::Null) | Err(_) => Value::Object(Map::new()),
        Ok(v) => v,
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
pub fn send(req: &Request) -> Result<Answer, Lost> {
    let mut cfg = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(20)
        .user_agent(NODE_FETCH_UA);
    if let Some(t) = req.timeout {
        cfg = cfg.timeout_global(Some(t));
    }
    let agent = ureq::Agent::new_with_config(cfg.build());
    let url = crate::test_origins::rewrite(&req.url).map_err(|_| Lost::Failed)?;
    let accept = req
        .headers
        .iter()
        .find(|(k, _)| *k == "accept")
        .map_or("*/*", |(_, v)| v.as_str())
        .to_string();
    let lost = |e: ureq::Error| {
        if is_timeout(&e) {
            Lost::Timeout
        } else {
            Lost::Failed
        }
    };
    let res = match req.method {
        "GET" => {
            let mut r = agent.get(&url).header("accept", &accept);
            for (k, v) in req.headers.iter().filter(|(k, _)| *k != "accept") {
                r = r.header(*k, v);
            }
            r.call().map_err(lost)?
        }
        _ => {
            let mut r = agent.post(&url).header("accept", &accept);
            for (k, v) in req.headers.iter().filter(|(k, _)| *k != "accept") {
                r = r.header(*k, v);
            }
            r.send(req.body.clone().unwrap_or_default().as_bytes())
                .map_err(lost)?
        }
    };
    let status = res.status().as_u16();
    let mut bytes = Vec::new();
    // a body cut short or too slow is `{}`, as bodyOf's catch makes it; a timeout reading it is
    // the request timing out (the signal covers the body)
    if let Err(e) = res.into_body().into_reader().read_to_end(&mut bytes) {
        if is_timeout(&ureq::Error::from(e)) {
            return Err(Lost::Timeout);
        }
        bytes.clear();
    }
    Ok(Answer {
        status,
        body: body_of(&bytes),
    })
}

/// `new URLSearchParams(pairs).toString()`: application/x-www-form-urlencoded, a space as `+`
/// and only `*-._` and ASCII letters and digits left as they are.
pub fn form(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b' ' => out.push('+'),
                b'*' | b'-' | b'.' | b'_' => out.push(b as char),
                b if b.is_ascii_alphanumeric() => out.push(b as char),
                b => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encodes_as_url_search_params() {
        assert_eq!(
            form(&[("scope", "XboxLive.signin offline_access"), ("x", "a/b:c~é*")]),
            "scope=XboxLive.signin+offline_access&x=a%2Fb%3Ac%7E%C3%A9*"
        );
    }

    #[test]
    fn body_of_is_an_object_unless_json_says_otherwise() {
        assert_eq!(body_of(b"<html>"), serde_json::json!({}));
        assert_eq!(body_of(b"null"), serde_json::json!({}));
        assert_eq!(body_of(b"5"), serde_json::json!(5));
        assert_eq!(body_of(b"\xEF\xBB\xBF{}"), serde_json::json!({}));
        assert_eq!(body_of(b"{\"a\":1}"), serde_json::json!({ "a": 1 }));
    }
}
