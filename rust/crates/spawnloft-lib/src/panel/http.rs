//! What a route sees of a request and how it answers: the port of the few things `ui.mjs` takes
//! from Node's `http` (`req.url` read as `new URL(req.url, 'http://localhost')`, the body read
//! whole and parsed as JSON, `json(res, code, body)`).
//!
//! One request per connection, as the listener in `panel.rs` already works. A body is read only
//! when a route asks for it, with a limit, so a request that is turned away never has its body
//! held in memory.

use std::io::{self, Read, Write};
use std::net::TcpStream;

use serde_json::Value;

use crate::failure::Failure;
use crate::jsjson;

/// The largest body a route reads whole (`readBody`). Node's panel had no limit at all; the
/// largest thing a page sends as JSON is a file being saved from the editor (2 MiB of text,
/// `files::MAX_EDIT_BYTES`), which escaping can grow a few times over.
pub const BODY_LIMIT: u64 = 32 * 1024 * 1024;

/// How the request says its body ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    None,
    Length(u64),
    Chunked,
}

/// Reads a request's framing from its headers. `Err` is a head no route should see: a length that
/// is not a number, two lengths that disagree, a transfer coding that is not `chunked`, or both
/// a length and a coding (Node's parser refuses the same).
pub fn framing(headers: &[(String, String)]) -> Result<Framing, &'static str> {
    let mut length: Option<u64> = None;
    let mut chunked = false;
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("content-length") {
            let v = v.trim();
            if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                return Err("bad content-length");
            }
            let n: u64 = v.parse().map_err(|_| "bad content-length")?;
            if length.is_some_and(|had| had != n) {
                return Err("bad content-length");
            }
            length = Some(n);
        } else if k.eq_ignore_ascii_case("transfer-encoding") {
            if !v.trim().eq_ignore_ascii_case("chunked") || chunked {
                return Err("unsupported transfer-encoding");
            }
            chunked = true;
        }
    }
    match (length, chunked) {
        (Some(_), true) => Err("both content-length and transfer-encoding"),
        (None, true) => Ok(Framing::Chunked),
        (Some(n), false) => Ok(Framing::Length(n)),
        (None, false) => Ok(Framing::None),
    }
}

/// The request body as a reader: what came with the head first, then the connection, decoded and
/// ended where the framing says.
pub struct Body<'c> {
    left: Vec<u8>,
    at: usize,
    conn: &'c mut TcpStream,
    state: State,
    /// Sent before the first read when the client waits for it (`Expect: 100-continue`).
    proceed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Length(u64),
    /// Before a chunk's size line.
    ChunkSize,
    ChunkData(u64),
    /// After a chunk's data, before its CRLF.
    ChunkEnd,
    Trailers,
    Done,
}

impl<'c> Body<'c> {
    pub fn new(conn: &'c mut TcpStream, left: Vec<u8>, framing: Framing, expects_continue: bool) -> Body<'c> {
        let state = match framing {
            Framing::None | Framing::Length(0) => State::Done,
            Framing::Length(n) => State::Length(n),
            Framing::Chunked => State::ChunkSize,
        };
        Body {
            left,
            at: 0,
            conn,
            proceed: expects_continue && state != State::Done,
            state,
        }
    }

    /// The connection, to answer on once the body has been read (or will not be).
    pub fn into_conn(self) -> &'c mut TcpStream {
        self.conn
    }

    /// The announced length, when the request gave one.
    pub fn announced(&self) -> Option<u64> {
        match self.state {
            State::Length(n) => Some(n),
            State::Done => Some(0),
            _ => None,
        }
    }

    fn raw(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at < self.left.len() {
            let n = buf.len().min(self.left.len() - self.at);
            buf[..n].copy_from_slice(&self.left[self.at..self.at + n]);
            self.at += n;
            return Ok(n);
        }
        if self.proceed {
            self.proceed = false;
            self.conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            self.conn.flush()?;
        }
        self.conn.read(buf)
    }

    fn byte(&mut self) -> io::Result<u8> {
        let mut b = [0u8; 1];
        match self.raw(&mut b)? {
            0 => Err(io::ErrorKind::UnexpectedEof.into()),
            _ => Ok(b[0]),
        }
    }

    /// One CRLF-ended line of the chunked framing, without the line end.
    fn line(&mut self) -> io::Result<String> {
        let mut out = Vec::new();
        loop {
            let b = self.byte()?;
            if b == b'\n' {
                if out.last() == Some(&b'\r') {
                    out.pop();
                }
                return String::from_utf8(out).map_err(|_| io::ErrorKind::InvalidData.into());
            }
            if out.len() > 4096 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            out.push(b);
        }
    }

    /// Everything that is left, up to `limit` bytes; `Ok(None)` when there is more than that.
    pub fn read_all(&mut self, limit: u64) -> io::Result<Option<Vec<u8>>> {
        if self.announced().is_some_and(|n| n > limit) {
            return Ok(None);
        }
        let mut out = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let n = self.read(&mut chunk)?;
            if n == 0 {
                return Ok(Some(out));
            }
            if out.len() as u64 + n as u64 > limit {
                return Ok(None);
            }
            out.extend_from_slice(&chunk[..n]);
        }
    }
}

impl Read for Body<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            match self.state {
                State::Done => return Ok(0),
                State::Length(left) | State::ChunkData(left) => {
                    let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
                    let n = self.raw(&mut buf[..want])?;
                    if n == 0 {
                        // the client hung up part way: what a route gets is short, never padded
                        return Err(io::ErrorKind::UnexpectedEof.into());
                    }
                    let rest = left - n as u64;
                    self.state = match (self.state, rest) {
                        (State::Length(_), 0) => State::Done,
                        (State::Length(_), r) => State::Length(r),
                        (_, 0) => State::ChunkEnd,
                        (_, r) => State::ChunkData(r),
                    };
                    return Ok(n);
                }
                State::ChunkSize => {
                    let line = self.line()?;
                    let size = line.split(';').next().unwrap_or("").trim();
                    if size.is_empty() || size.len() > 16 || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    let n = u64::from_str_radix(size, 16).map_err(|_| io::ErrorKind::InvalidData)?;
                    self.state = if n == 0 {
                        State::Trailers
                    } else {
                        State::ChunkData(n)
                    };
                }
                State::ChunkEnd => {
                    if !self.line()?.is_empty() {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    self.state = State::ChunkSize;
                }
                State::Trailers => {
                    if self.line()?.is_empty() {
                        self.state = State::Done;
                    }
                }
            }
        }
    }
}

/// A request as a route reads it.
pub struct Request<'c> {
    pub method: String,
    /// `url.pathname`.
    pub path: String,
    /// `url.pathname.split('/').filter(Boolean)`: not percent-decoded, as in `ui.mjs`.
    pub seg: Vec<String>,
    /// `url.searchParams`, in order.
    pub query: Vec<(String, String)>,
    // read by the routes that move next (C8 groups b and c)
    #[allow(dead_code)]
    pub headers: Vec<(String, String)>,
    pub body: Body<'c>,
}

/// `new URL(target, 'http://localhost')`: the path and the query a route sees. `None` is the
/// `TypeError: Invalid URL` Node throws.
pub fn parse_target(target: &str) -> Option<(String, Vec<(String, String)>)> {
    let base = url::Url::parse("http://localhost").ok()?;
    let url = base.join(target).ok()?;
    let query = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    Some((url.path().to_string(), query))
}

impl Request<'_> {
    /// `seg[i]`, or `None` past the end.
    pub fn seg(&self, i: usize) -> Option<&str> {
        self.seg.get(i).map(String::as_str)
    }

    /// `url.searchParams.get(key)`.
    pub fn q(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    // read by the routes that move next (C8 groups b and c)
    #[allow(dead_code)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// `readBody(req)`: the body parsed as JSON. No body, or one that is not JSON, is `{}`.
    pub fn json(&mut self) -> Result<Value, Failure> {
        let bytes = match self.body.read_all(BODY_LIMIT) {
            Ok(Some(b)) => b,
            Ok(None) => return Err(too_large()),
            // a body cut short: Node's `for await` throws "aborted"
            Err(_) => {
                return Err(Failure::Internal {
                    head: "Error".into(),
                    message: "aborted".into(),
                    code: Some("ECONNRESET".into()),
                });
            }
        };
        if bytes.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        // Buffer.toString('utf8') replaces what is not UTF-8, it does not refuse it
        let text = String::from_utf8_lossy(&bytes);
        Ok(jsjson::parse(&text).unwrap_or_else(|_| Value::Object(serde_json::Map::new())))
    }
}

/// The failure a too-large body is answered with (413).
pub fn too_large() -> Failure {
    Failure::User {
        message: "request body too large".into(),
        code: Some(TOO_LARGE.into()),
    }
}

/// The code [`too_large`] carries, so the listener answers 413 and not 400.
pub const TOO_LARGE: &str = "body-too-large";

/// `body.key` of a parsed body, as JavaScript reads it: a property of an object, nothing on a
/// string, a number or a list, and a `TypeError` on `null`.
pub fn field<'a>(body: &'a Value, key: &str) -> Result<Option<&'a Value>, Failure> {
    match body {
        Value::Null => Err(Failure::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `body?.key`: as [`field`], with `null` reading as nothing.
pub fn opt_field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    match body {
        Value::Object(m) => m.get(key),
        _ => None,
    }
}

/// `Object.hasOwn(body, key)` for a parsed body.
pub fn has_own(body: &Value, key: &str) -> Result<bool, Failure> {
    match body {
        Value::Null => Err(Failure::type_error("Cannot convert undefined or null to object")),
        Value::Object(m) => Ok(m.contains_key(key)),
        _ => Ok(false),
    }
}

/// A route that writes its own response.
pub type Writer = Box<dyn FnOnce(&mut TcpStream) -> io::Result<()> + Send>;

/// What a route answers.
pub enum Reply {
    /// `json(res, code, body)`.
    Json(u16, Value),
    /// A whole body with its own headers (a page, a text report). `Cache-Control: no-store` and
    /// the length are added by the listener.
    Bytes {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// A file sent as it is read: `len` bytes of it and no more, as the headers promised.
    // read by the routes that move next (C8 groups b and c)
    #[allow(dead_code)]
    File {
        headers: Vec<(String, String)>,
        file: std::path::PathBuf,
        len: u64,
        /// Run when the file has been sent or the client went away (`stream.on('close')`).
        done: Option<Box<dyn FnOnce() + Send>>,
    },
    /// The route writes the response itself (an event stream), headers included.
    // read by the routes that move next (C8 groups b and c)
    #[allow(dead_code)]
    Stream(Writer),
}

impl Reply {
    // read by the routes that move next (C8 groups b and c)
    #[allow(dead_code)]
    pub fn json(status: u16, body: Value) -> Reply {
        Reply::Json(status, body)
    }

    pub fn ok(body: Value) -> Reply {
        Reply::Json(200, body)
    }

    /// `json(res, code, { error })`.
    pub fn error(status: u16, message: impl Into<String>) -> Reply {
        Reply::Json(status, serde_json::json!({ "error": message.into() }))
    }

    pub fn not_found() -> Reply {
        Reply::error(404, "not found")
    }

    pub fn method_not_allowed() -> Reply {
        Reply::error(405, "method not allowed")
    }

    pub fn html(status: u16, extra: &[(&str, &str)], body: String) -> Reply {
        let mut headers = vec![("Content-Type".to_string(), "text/html; charset=utf-8".to_string())];
        headers.extend(extra.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())));
        Reply::Bytes {
            status,
            headers,
            body: body.into_bytes(),
        }
    }
}

/// The catch of `serve()`: a person's mistake is 400, anything else is ours (500); the code goes
/// along when the error has one.
pub fn failure_reply(f: &Failure) -> Reply {
    let (status, code) = match f {
        Failure::User { code, .. } if code.as_deref() == Some(TOO_LARGE) => (413, None),
        Failure::Usage(_) => (400, None),
        Failure::User { code, .. } => (400, code.clone()),
        Failure::Internal { code, .. } => (500, code.clone()),
    };
    let mut body = serde_json::Map::new();
    body.insert("error".into(), Value::String(f.message().to_string()));
    if let Some(code) = code {
        body.insert("code".into(), Value::String(code));
    }
    Reply::Json(status, Value::Object(body))
}

/// The reason phrase Node sends for a status.
pub fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

/// Writes a response head. `extra` comes before the fixed lines; every response closes its
/// connection.
pub fn write_head(
    conn: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
    length: Option<u64>,
) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in headers {
        // a value a route built from a file name or a query must never start a second header
        let clean: String = v.chars().filter(|c| !c.is_control() || *c == '\t').collect();
        head.push_str(&format!("{k}: {clean}\r\n"));
    }
    if let Some(n) = length {
        head.push_str(&format!("Content-Length: {n}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    conn.write_all(head.as_bytes())
}

/// Sends `reply` on `conn`. `proof` is the answer to a caller's probe (`panel_auth`), sent on
/// every response of an allowed request. A `HEAD` request gets the head alone.
pub fn send(conn: &mut TcpStream, reply: Reply, proof: Option<&str>, head_only: bool) -> io::Result<()> {
    let with_proof = |mut headers: Vec<(String, String)>| {
        if let Some(p) = proof {
            headers.push((crate::panel_auth::PROOF_HEADER.to_string(), p.to_string()));
        }
        headers
    };
    match reply {
        Reply::Json(status, body) => {
            let payload = jsjson::stringify(&body);
            let headers = with_proof(vec![
                ("Content-Type".into(), "application/json".into()),
                ("Cache-Control".into(), "no-store".into()),
            ]);
            write_head(conn, status, &headers, Some(payload.len() as u64))?;
            if !head_only {
                conn.write_all(payload.as_bytes())?;
            }
            conn.flush()
        }
        Reply::Bytes {
            status,
            mut headers,
            body,
        } => {
            if !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("cache-control"))
            {
                headers.push(("Cache-Control".into(), "no-store".into()));
            }
            write_head(conn, status, &with_proof(headers), Some(body.len() as u64))?;
            if !head_only {
                conn.write_all(&body)?;
            }
            conn.flush()
        }
        Reply::File {
            mut headers,
            file,
            len,
            done,
        } => {
            // runs however this ends, as the stream's 'close' does
            struct Done(Option<Box<dyn FnOnce() + Send>>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if let Some(f) = self.0.take() {
                        f();
                    }
                }
            }
            let _done = Done(done);
            if !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("cache-control"))
            {
                headers.push(("Cache-Control".into(), "no-store".into()));
            }
            // opened before the head goes out: a file that went away is an error answer, not a
            // 200 with nothing behind it
            let source = std::fs::File::open(&file)?;
            write_head(conn, 200, &with_proof(headers), Some(len))?;
            if head_only {
                return conn.flush();
            }
            let sent = io::copy(&mut source.take(len), conn)?;
            if sent < len {
                // shorter than promised: end the connection without pretending it was whole
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            conn.flush()
        }
        Reply::Stream(run) => run(conn),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (b, _) = l.accept().unwrap();
        (a, b)
    }

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn framing_rules() {
        assert_eq!(framing(&h(&[])), Ok(Framing::None));
        assert_eq!(framing(&h(&[("Content-Length", "12")])), Ok(Framing::Length(12)));
        assert_eq!(
            framing(&h(&[("content-length", "3"), ("Content-Length", "3")])),
            Ok(Framing::Length(3))
        );
        assert_eq!(
            framing(&h(&[("Transfer-Encoding", "Chunked")])),
            Ok(Framing::Chunked)
        );
        for bad in [
            h(&[("Content-Length", "-1")]),
            h(&[("Content-Length", "+1")]),
            h(&[("Content-Length", "1, 1")]),
            h(&[("Content-Length", "")]),
            h(&[("Content-Length", "1"), ("Content-Length", "2")]),
            h(&[("Content-Length", "1"), ("Transfer-Encoding", "chunked")]),
            h(&[("Transfer-Encoding", "gzip, chunked")]),
            h(&[("Transfer-Encoding", "chunked"), ("Transfer-Encoding", "chunked")]),
            h(&[("Content-Length", "99999999999999999999999")]),
        ] {
            assert!(framing(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_body_with_a_length_ends_there() {
        let (mut client, mut server) = pair();
        client.write_all(b"lo wor").unwrap();
        client.write_all(b"ld and more").unwrap();
        let mut body = Body::new(&mut server, b"hel".to_vec(), Framing::Length(11), false);
        assert_eq!(body.read_all(100).unwrap().unwrap(), b"hello world");
        // the limit: by the announced length, before anything is read
        let (_c, mut server) = pair();
        let mut body = Body::new(&mut server, Vec::new(), Framing::Length(11), false);
        assert!(body.read_all(10).unwrap().is_none());
    }

    #[test]
    fn a_chunked_body_is_decoded_and_limited() {
        let (mut client, mut server) = pair();
        client
            .write_all(b"5\r\nhello\r\n6;x=y\r\n world\r\n0\r\nTrailer: x\r\n\r\nNEXT")
            .unwrap();
        let mut body = Body::new(&mut server, Vec::new(), Framing::Chunked, false);
        assert_eq!(body.read_all(100).unwrap().unwrap(), b"hello world");
        let (mut client, mut server) = pair();
        client
            .write_all(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")
            .unwrap();
        let mut body = Body::new(&mut server, Vec::new(), Framing::Chunked, false);
        assert!(body.read_all(8).unwrap().is_none());
        for bad in [
            &b"zz\r\nhello\r\n"[..],
            b"5\r\nhelloXX\r\n0\r\n\r\n",
            b"-5\r\nhello\r\n",
        ] {
            let (mut client, mut server) = pair();
            client.write_all(bad).unwrap();
            drop(client);
            let mut body = Body::new(&mut server, Vec::new(), Framing::Chunked, false);
            assert!(body.read_all(100).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_body_cut_short_is_an_error_not_a_short_body() {
        let (mut client, mut server) = pair();
        client.write_all(b"abc").unwrap();
        drop(client);
        let mut body = Body::new(&mut server, Vec::new(), Framing::Length(10), false);
        assert!(body.read_all(100).is_err());
    }

    #[test]
    fn continue_is_sent_once_and_only_when_a_body_is_read() {
        let (mut client, mut server) = pair();
        let t = std::thread::spawn(move || {
            let mut got = [0u8; 25];
            client.read_exact(&mut got).unwrap();
            assert_eq!(&got, b"HTTP/1.1 100 Continue\r\n\r\n");
            client.write_all(b"abc").unwrap();
        });
        let mut body = Body::new(&mut server, Vec::new(), Framing::Length(3), true);
        assert_eq!(body.read_all(10).unwrap().unwrap(), b"abc");
        t.join().unwrap();
    }

    #[test]
    fn targets_are_read_as_whatwg_urls() {
        let (path, query) = parse_target("/api/a/../b/%2e%2e/c?x=1&x=2&y=a+b%20c&z").unwrap();
        assert_eq!(path, "/api/c");
        assert_eq!(
            query,
            vec![
                ("x".into(), "1".into()),
                ("x".into(), "2".into()),
                ("y".into(), "a b c".into()),
                ("z".into(), String::new())
            ]
        );
        // segments stay encoded
        assert_eq!(
            parse_target("/api/client/versions/1.21%2F4").unwrap().0,
            "/api/client/versions/1.21%2F4"
        );
        assert_eq!(parse_target("//evil.example/api/x").unwrap().0, "/api/x");
        assert_eq!(parse_target("http://evil.example/p?q=1").unwrap().0, "/p");
        assert!(parse_target("http://[").is_none());
    }

    #[test]
    fn body_fields_read_as_javascript_does() {
        let obj = serde_json::json!({ "a": 1 });
        assert_eq!(field(&obj, "a").unwrap(), Some(&serde_json::json!(1)));
        assert_eq!(field(&obj, "b").unwrap(), None);
        assert_eq!(field(&serde_json::json!("text"), "a").unwrap(), None);
        assert_eq!(field(&serde_json::json!([1]), "a").unwrap(), None);
        let e = field(&Value::Null, "theme").unwrap_err();
        assert_eq!(e.message(), "Cannot read properties of null (reading 'theme')");
        assert_eq!(opt_field(&Value::Null, "theme"), None);
        assert!(has_own(&Value::Null, "x").is_err());
    }

    #[test]
    fn failures_become_statuses() {
        let as_json = |f: Failure| match failure_reply(&f) {
            Reply::Json(s, v) => (s, v.to_string()),
            _ => unreachable!(),
        };
        assert_eq!(as_json(Failure::user("no")), (400, r#"{"error":"no"}"#.into()));
        assert_eq!(
            as_json(Failure::User {
                message: "no".into(),
                code: Some("cancelled".into())
            }),
            (400, r#"{"error":"no","code":"cancelled"}"#.into())
        );
        assert_eq!(
            as_json(Failure::Internal {
                head: "Error".into(),
                message: "ENOENT: x".into(),
                code: Some("ENOENT".into())
            }),
            (500, r#"{"error":"ENOENT: x","code":"ENOENT"}"#.into())
        );
        assert_eq!(
            as_json(too_large()),
            (413, r#"{"error":"request body too large"}"#.into())
        );
    }

    #[test]
    fn a_header_value_cannot_start_a_second_header() {
        let (mut client, mut server) = pair();
        write_head(
            &mut server,
            200,
            &h(&[(
                "Content-Disposition",
                "attachment; filename=\"a\r\nSet-Cookie: x=1\"",
            )]),
            Some(0),
        )
        .unwrap();
        drop(server);
        let mut out = String::new();
        client.read_to_string(&mut out).unwrap();
        assert!(!out.contains("\r\nSet-Cookie"), "{out}");
        assert!(
            out.ends_with("Content-Length: 0\r\nConnection: close\r\n\r\n"),
            "{out}"
        );
    }
}
