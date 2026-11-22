//! `spawnloft mcp` (C9): `cmdMcp` in mcctl.mjs and `serveStdio` in mcp.mjs. An AI client
//! launches it and speaks JSON-RPC over stdin and stdout, one object per line. Each request runs
//! on a thread of its own, so a slow start does not hold up a status check (see [`HEAD_START`]);
//! closing stdin is how a client says it is done, and work under way is allowed to finish first.

mod act;
mod bots;
mod client;
mod read;
pub mod server;
pub mod tools;

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use spawnloft_lib::failure::Failure;
use spawnloft_lib::{build, jsjson, private_copy, scrubber};

use super::args::Flag;
use super::{Ctx, check_flags};
use server::{Admit, Server};

const USAGE: &str = "Usage: spawnloft mcp [--allow-destructive] [--show-ips]";

pub fn mcp(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    check_flags(ctx.args, &["allowDestructive", "showIps"])?;
    if !ctx.args.positional.is_empty() {
        return Err(Failure::usage(USAGE));
    }
    let is_true = |k: &str| ctx.args.get(k) == Some(&Flag::Bool(true));
    let allow_destructive = is_true("allowDestructive");
    let show_ips = is_true("showIps");
    // a client started as a Windows package can be reading a private copy of SpawnLoft's data
    // without knowing it, so tell it once here (private-copy.mjs)
    let notice = private_copy::mcp_notice(&private_copy::find(&private_copy::Where::here(ctx.layout)));
    let instructions = if notice.is_empty() {
        tools::INSTRUCTIONS.to_string()
    } else {
        format!("{}\n{notice}", tools::INSTRUCTIONS)
    };
    let layout = ctx.layout.clone();
    let scrub_layout = layout.clone();
    let output: Arc<Mutex<std::io::Stdout>> = Arc::new(Mutex::new(std::io::stdout()));
    let send = {
        let output = Arc::clone(&output);
        move |message: &Value| write_line(&output, message)
    };
    let server = Arc::new(Server::new(
        json!({ "name": "spawnloft", "title": "SpawnLoft", "version": build::current().version }),
        instructions,
        tools::tools_for(allow_destructive),
        layout,
        Box::new(send.clone()),
        Box::new(move |text: &str| scrubber::scrubber(&scrub_layout, show_ips)(text)),
    ));
    // stdout is the protocol, so a panic says what it was on stderr, with secrets out (a
    // panic's text can hold a path or a value)
    let hook_layout = ctx.layout.clone();
    std::panic::set_hook(Box::new(move |info| {
        let what = info
            .payload()
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| info.payload().downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default();
        eprintln!("mcp: {}", scrubber::scrubber(&hook_layout, show_ips)(&what));
    }));
    serve(&server, std::io::stdin().lock(), &send);
    Ok(())
}

/// `output.write(`${JSON.stringify(message)}\n`)`, one whole line at a time.
fn write_line(output: &Mutex<std::io::Stdout>, message: &Value) {
    let mut message = message.clone();
    jsjson::js_order(&mut message);
    let line = format!("{}\n", jsjson::stringify(&message));
    let out = output.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut out = out.lock();
    // a client that has gone away is not answered
    let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
}

/// The lines of `input` as readline gives them (`crlfDelay: Infinity`): `\n`, `\r\n` and a lone
/// `\r` each end one, and a last line without an ending still counts.
fn for_each_line(mut input: impl Read, mut each: impl FnMut(&str)) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut after_cr = false;
    loop {
        let n = match input.read(&mut chunk) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &chunk[..n] {
            match b {
                b'\n' if after_cr => after_cr = false,
                b'\n' | b'\r' => {
                    each(&String::from_utf8_lossy(&buf));
                    buf.clear();
                    after_cr = b == b'\r';
                }
                _ => {
                    after_cr = false;
                    buf.push(b);
                }
            }
        }
    }
    if !buf.is_empty() {
        each(&String::from_utf8_lossy(&buf));
    }
}

/// How long a request may run before the next one starts beside it. The Node core runs one
/// request's synchronous work to its end before the next begins, so a config write is in the
/// activity log before a `get_activity` sent behind it; only a request that waits (a start, a
/// backup, RCON, a download) lets the later ones run meanwhile. Each request starts once the one
/// before it has finished, or has been running this long, which keeps that order without
/// holding up a status check behind a slow start.
const HEAD_START: Duration = Duration::from_millis(100);

/// One request's progress, for the request after it to wait on.
#[derive(Default)]
struct Gate {
    state: Mutex<(Option<Instant>, bool)>,
    changed: Condvar,
}

impl Gate {
    fn set(&self, f: impl FnOnce(&mut (Option<Instant>, bool))) {
        f(&mut self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner));
        self.changed.notify_all();
    }

    fn started(&self) {
        self.set(|s| s.0 = Some(Instant::now()));
    }

    fn finished(&self) {
        self.set(|s| s.1 = true);
    }

    /// Until the request has finished, or has been running for [`HEAD_START`].
    fn wait(&self) {
        let mut s = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            let (started, done) = *s;
            if done {
                return;
            }
            let left = started.map(|t| HEAD_START.saturating_sub(t.elapsed()));
            if left == Some(Duration::ZERO) {
                return;
            }
            s = match left {
                Some(left) => {
                    self.changed
                        .wait_timeout(s, left)
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .0
                }
                None => self
                    .changed
                    .wait(s)
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            };
        }
    }
}

/// Finishes a gate even when the request's thread panics, so the requests behind it go on.
struct Finish(Arc<Gate>);

impl Drop for Finish {
    fn drop(&mut self) {
        self.0.finished();
    }
}

/// `!line.trim()` in JavaScript: its whitespace, which takes U+FEFF and not U+0085.
fn js_blank(line: &str) -> bool {
    line.chars().all(|c| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

/// `serveStdio`: each line admitted as it is read ([`Server::admit`]), each request then run on
/// its own thread, started in the order they came; all finished before it returns.
fn serve(server: &Arc<Server>, input: impl Read, send: &(dyn Fn(&Value) + Sync)) {
    std::thread::scope(|scope| {
        let mut before: Option<Arc<Gate>> = None;
        for_each_line(input, |line| {
            if js_blank(line) {
                return;
            }
            let Ok(message) = jsjson::parse(line) else {
                send(&server::error(
                    Value::Null,
                    server::PARSE_ERROR,
                    "Parse error",
                    None,
                ));
                return;
            };
            let req = match server.admit(&message) {
                Admit::Done(reply) => {
                    if let Some(reply) = reply {
                        send(&reply);
                    }
                    return;
                }
                Admit::Run(req) => req,
            };
            let server = Arc::clone(server);
            let gate = Arc::new(Gate::default());
            let after = before.replace(Arc::clone(&gate));
            scope.spawn(move || {
                let finish = Finish(gate);
                if let Some(after) = after {
                    after.wait();
                }
                finish.0.started();
                if let Some(reply) = server.run(&req) {
                    send(&reply);
                }
            });
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(input: &str) -> Vec<String> {
        let mut out = Vec::new();
        for_each_line(input.as_bytes(), |l| out.push(l.to_string()));
        out
    }

    /// Pipelined requests that finish quickly are answered in the order they came, as the Node
    /// core answers them (test/mcp.test.mjs's activity case sends a write and a read at once).
    #[test]
    fn quick_requests_are_answered_in_order() {
        let root = std::env::temp_dir().join(format!("sl-mcp-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut s = serde_json::Map::new();
        s.insert("dataRoot".into(), json!(root.to_string_lossy()));
        let layout = spawnloft_lib::settings::Layout::resolve(&s).unwrap();
        let server = Arc::new(Server::new(
            json!({}),
            String::new(),
            tools::tools_for(false),
            layout,
            Box::new(|_: &Value| {}),
            Box::new(|t: &str| t.to_string()),
        ));
        let mut input = String::new();
        for id in 1..=20 {
            input.push_str(&format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"list_servers\",\"arguments\":{{}}}}}}\n"));
        }
        input.push_str("not json\n");
        let got = Mutex::new(Vec::new());
        serve(&server, input.as_bytes(), &|m: &Value| {
            got.lock().unwrap().push(m["id"].clone())
        });
        let got = got.into_inner().unwrap();
        // the parse error is answered on the reading thread, as soon as its line is read
        let ids: Vec<Value> = got.into_iter().filter(|v| !v.is_null()).collect();
        assert_eq!(ids, (1..=20).map(|i| json!(i)).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lines_end_as_readline_ends_them() {
        assert_eq!(split("a\nb\r\nc\rd"), ["a", "b", "c", "d"]);
        assert_eq!(split("a\r\n\r\nb\n"), ["a", "", "b"]);
        assert_eq!(split(""), Vec::<String>::new());
    }
}
