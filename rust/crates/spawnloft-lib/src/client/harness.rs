//! The harness mod's side of `client-harness.mjs`: the file the mod writes in the game folder
//! (`spawnloft-harness.json`, its port and pid) and the line-delimited JSON channel to it on
//! 127.0.0.1, opened with the launch's token.

use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use super::paths::Paths;
use super::prop;
use crate::failure::Failure;
use crate::jspath;

pub const HARNESS_FILE: &str = "spawnloft-harness.json";

pub fn harness_file(paths: &Paths, profile: &str) -> String {
    jspath::join(&[&paths.profile_dir(profile), HARNESS_FILE])
}

/// `readHarnessFile(name, { pid })`. With `pid`, a file left by an earlier run (a crash skips
/// the mod's cleanup) reads as absent. A file being deleted or written on Windows (EPERM, EBUSY,
/// EACCES) is no harness right now; one that is not JSON fails.
pub fn read_file(paths: &Paths, profile: &str, pid: Option<&Value>) -> Result<Option<Value>, Failure> {
    let file = harness_file(paths, profile);
    let data = match std::fs::read(&file) {
        Ok(b) => crate::jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax)?,
        Err(e) if jspath::is_enoent(&e) => return Ok(None),
        Err(e) => {
            if matches!(jspath::error_code(&e).0, "EPERM" | "EBUSY" | "EACCES") {
                return Ok(None);
            }
            return Err(Failure::read(&e, std::path::Path::new(&file)));
        }
    };
    if !matches!(prop(Some(&data), "port"), Some(Value::Number(_))) {
        return Ok(None);
    }
    if let Some(pid) = pid
        && !super::strict_eq(prop(Some(&data), "pid"), Some(pid))
    {
        return Ok(None);
    }
    Ok(Some(data))
}

/// `removeHarnessFile(name)`.
pub fn remove_file(paths: &Paths, profile: &str) -> Result<(), Failure> {
    super::rm_force(&harness_file(paths, profile))
}

const GONE: &str = "the client's harness went away";

/// An open channel to the harness (`connectHarness`'s `{ call, close }`).
#[derive(Debug)]
pub struct Channel {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    next_id: u64,
    closed: bool,
    /// A line read in part when a wait ran out.
    pending: Vec<u8>,
    pub hello: Value,
}

impl Channel {
    fn send(&mut self, id: u64, op: &str, args: &Map<String, Value>) -> Result<(), ()> {
        let mut msg = Map::new();
        msg.insert("id".into(), json!(id));
        msg.insert("op".into(), json!(op));
        for (k, v) in args {
            msg.insert(k.clone(), v.clone());
        }
        let line = format!("{}\n", crate::jsjson::stringify(&Value::Object(msg)));
        self.stream.write_all(line.as_bytes()).map_err(|_| ())
    }

    /// Reads replies until the one for `id`, or the wait runs out (`Ok(None)`).
    fn reply(&mut self, id: u64, wait: Duration) -> Result<Option<Map<String, Value>>, Failure> {
        let deadline = Instant::now() + wait;
        loop {
            if self.closed {
                return Err(Failure::user(GONE));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            let _ = self.stream.set_read_timeout(Some(left));
            match self.reader.read_until(b'\n', &mut self.pending) {
                Ok(0) => {
                    self.closed = true;
                    return Err(Failure::user(GONE));
                }
                Ok(_) if self.pending.last() == Some(&b'\n') => {}
                Ok(_) => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(_) => {
                    self.closed = true;
                    return Err(Failure::user(GONE));
                }
            }
            let line = std::mem::take(&mut self.pending);
            let text = String::from_utf8_lossy(&line);
            let Ok(Value::Object(reply)) = crate::jsjson::parse(text.trim_end_matches(['\n', '\r'])) else {
                continue;
            };
            let Some(got) = reply.get("id").and_then(Value::as_f64) else {
                continue;
            };
            if got.fract() != 0.0 || got != id as f64 {
                continue;
            }
            if reply.get("ok") == Some(&Value::Bool(false)) {
                return Err(Failure::user(crate::js::string(reply.get("error"))));
            }
            let mut result = reply;
            result.shift_remove("id");
            result.shift_remove("ok");
            return Ok(Some(result));
        }
    }

    /// `call(op, args, { timeout })`.
    pub fn call(&mut self, op: &str, args: Map<String, Value>, timeout_ms: u64) -> Result<Value, Failure> {
        if self.closed {
            return Err(Failure::user(GONE));
        }
        let id = self.next_id;
        self.next_id += 1;
        if self.send(id, op, &args).is_err() {
            self.closed = true;
            return Err(Failure::user(GONE));
        }
        match self.reply(id, Duration::from_millis(timeout_ms))? {
            Some(r) => Ok(Value::Object(r)),
            None => Err(Failure::user(format!(
                "the harness did not answer {op} within {timeout_ms} ms"
            ))),
        }
    }

    pub fn close(self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// `connectHarness(name, token, { timeout, pid })`.
pub fn connect(
    paths: &Paths,
    profile: &str,
    token: Option<&Value>,
    timeout_ms: u64,
    pid: Option<&Value>,
) -> Result<Channel, Failure> {
    let Some(info) = read_file(paths, profile, pid)? else {
        return Err(Failure::user(format!(
            "profile \"{profile}\" has no running harness"
        )));
    };
    let port = crate::js::number(prop(Some(&info), "port"));
    let addr = format!("127.0.0.1:{}", crate::js::number_to_string(port));
    let stream = match port_of(port).map(|p| TcpStream::connect(("127.0.0.1", p))) {
        Some(Ok(s)) => s,
        Some(Err(e)) => {
            let (code, _) = jspath::error_code(&e);
            if code == "ECONNREFUSED" {
                return Err(Failure::user(format!(
                    "connection to the harness was refused: connect ECONNREFUSED {addr}"
                )));
            }
            return Err(Failure::Internal {
                head: "Error".into(),
                message: format!("connect {code} {addr}"),
                code: Some(code.to_string()),
            });
        }
        None => {
            return Err(Failure::Internal {
                head: "RangeError [ERR_SOCKET_BAD_PORT]".into(),
                message: format!(
                    "Port should be >= 0 and < 65536. Received type number ({}).",
                    crate::js::number_to_string(port)
                ),
                code: Some("ERR_SOCKET_BAD_PORT".into()),
            });
        }
    };
    let reader = BufReader::new(stream.try_clone().map_err(|e| Failure::io(&e, "dup", None))?);
    let mut channel = Channel {
        stream,
        reader,
        next_id: 1,
        closed: false,
        pending: Vec::new(),
        hello: Value::Null,
    };
    let mut args = Map::new();
    if let Some(t) = token {
        args.insert("token".into(), t.clone());
    }
    let id = channel.next_id;
    channel.next_id += 1;
    if channel.send(id, "hello", &args).is_err() {
        return Err(Failure::user("the harness refused the token"));
    }
    match channel.reply(id, Duration::from_millis(timeout_ms)) {
        Ok(Some(r)) => {
            channel.hello = Value::Object(r);
            Ok(channel)
        }
        Ok(None) => {
            channel.close();
            Err(Failure::user(format!(
                "the harness did not answer hello within {timeout_ms} ms"
            )))
        }
        Err(Failure::User { message, .. }) if message.contains("went away") => {
            Err(Failure::user("the harness refused the token"))
        }
        Err(e) => {
            channel.close();
            Err(e)
        }
    }
}

/// A TCP port Node's `net.connect` takes: a whole number from 0 to 65535 (0 never connects).
fn port_of(port: f64) -> Option<u16> {
    (port.fract() == 0.0 && (0.0..65536.0).contains(&port)).then_some(port as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_call_waits_for_its_own_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let d = std::env::temp_dir().join(format!("sl-harness-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d.to_string_lossy());
        std::fs::create_dir_all(paths.profile_dir("p")).unwrap();
        std::fs::write(
            harness_file(&paths, "p"),
            format!("{{\"port\":{port},\"pid\":7}}"),
        )
        .unwrap();
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut w = s;
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, "{\"id\":1,\"op\":\"hello\",\"token\":\"t\"}\n");
            w.write_all(b"{\"id\":1,\"ok\":true,\"mod\":\"0.1.0\"}\n")
                .unwrap();
            line.clear();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, "{\"id\":2,\"op\":\"quit\"}\n");
            w.write_all(b"not json\n{\"id\":9}\n{\"id\":2,\"ok\":false,\"error\":\"no\"}\n")
                .unwrap();
        });
        assert!(read_file(&paths, "p", Some(&json!(8))).unwrap().is_none());
        let mut ch = connect(&paths, "p", Some(&json!("t")), 2000, Some(&json!(7))).unwrap();
        assert_eq!(ch.hello, json!({ "mod": "0.1.0" }));
        assert_eq!(ch.call("quit", Map::new(), 2000).unwrap_err().message(), "no");
        server.join().unwrap();
        assert_eq!(ch.call("x", Map::new(), 200).unwrap_err().message(), GONE);
        std::fs::remove_dir_all(d).unwrap();
    }
}
