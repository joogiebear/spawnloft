//! The control channel: a Unix socket or a Windows named pipe carrying JSON lines, one request and
//! one reply each (`daemon.mjs`). Each connection gets a thread; requests go to the daemon's main
//! loop and the reply comes back on a channel, so all state lives on one thread.
//!
//! Binding retries for 15 s while the name is held: a crash restart can spawn a daemon just after
//! the previous one's server exited but before that daemon let go of the name. If it never binds,
//! the server would be unmanageable, so the main loop stops it.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

use super::{Event, Log};

pub const LISTEN_RETRY: Duration = Duration::from_millis(250);
pub const LISTEN_TIMEOUT: Duration = Duration::from_secs(15);
/// A request line longer than this is not one the daemon would ever be sent.
const MAX_LINE: usize = 1 << 20;

/// Starts the channel on its own thread.
pub fn serve(addr: String, events: Sender<Event>, log: Arc<Log>) {
    let report = events.clone();
    let spawned = std::thread::Builder::new()
        .name("control".into())
        .spawn(move || listen(addr, events, log));
    if let Err(e) = spawned {
        let _ = report.send(Event::BindFatal(format!(
            "no thread for the control channel: {e}"
        )));
    }
}

/// Serves one connection: every non-blank line is a request, answered in order.
pub fn handle_connection<S: Read + Write>(mut stream: S, events: &Sender<Event>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if text.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&text) {
                Err(_) => json!({ "ok": false, "error": "malformed request" }),
                Ok(req) => {
                    let (tx, rx) = mpsc::channel();
                    if events.send(Event::Control { req, reply: tx }).is_err() {
                        return;
                    }
                    rx.recv()
                        .unwrap_or_else(|_| json!({ "ok": false, "error": "the daemon is shutting down" }))
                }
            };
            if stream.write_all(format!("{reply}\n").as_bytes()).is_err() {
                return;
            }
            let _ = stream.flush();
        }
        if buf.len() > MAX_LINE {
            return;
        }
    }
}

#[cfg(unix)]
fn listen(addr: String, events: Sender<Event>, log: Arc<Log>) {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    // a stale socket from a daemon that died would otherwise refuse the bind forever
    let _ = std::fs::remove_file(&addr);
    let deadline = Instant::now() + LISTEN_TIMEOUT;
    let listener = loop {
        match UnixListener::bind(&addr) {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline => {
                log.line(&format!("control socket busy at {addr}, retrying"));
                std::thread::sleep(LISTEN_RETRY);
            }
            Err(e) => {
                let _ = events.send(Event::BindFatal(e.to_string()));
                return;
            }
        }
    };
    // owner-only, whatever the umask
    let _ = std::fs::set_permissions(&addr, std::fs::Permissions::from_mode(0o600));
    let _ = events.send(Event::Bound(addr.clone()));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let tx = events.clone();
        let _ = std::thread::Builder::new()
            .name("control-conn".into())
            .spawn(move || handle_connection(stream, &tx));
    }
}

#[cfg(windows)]
fn listen(addr: String, events: Sender<Event>, log: Arc<Log>) {
    use crate::platform::{PipeServer, wait_for_client};
    let server = match PipeServer::new(&addr) {
        Ok(s) => s,
        Err(e) => {
            let _ = events.send(Event::BindFatal(e));
            return;
        }
    };
    let deadline = Instant::now() + LISTEN_TIMEOUT;
    // ERROR_ACCESS_DENIED: another process holds the name (libuv's EADDRINUSE); ERROR_PIPE_BUSY:
    // its instances are all in use
    let busy = |e: &std::io::Error| matches!(e.raw_os_error(), Some(5) | Some(231));
    let mut pipe = loop {
        match server.instance(true) {
            Ok(h) => break h,
            Err(e) if busy(&e) && Instant::now() < deadline => {
                log.line(&format!("control socket busy at {addr}, retrying"));
                std::thread::sleep(LISTEN_RETRY);
            }
            Err(e) => {
                let _ = events.send(Event::BindFatal(e.to_string()));
                return;
            }
        }
    };
    let _ = events.send(Event::Bound(addr.clone()));
    loop {
        match wait_for_client(&pipe) {
            Ok(()) => {
                let file = std::fs::File::from(pipe);
                let tx = events.clone();
                let _ = std::thread::Builder::new()
                    .name("control-conn".into())
                    .spawn(move || handle_connection(file, &tx));
            }
            // the client left before it was served (ERROR_NO_DATA), or the instance broke
            Err(_) => drop(pipe),
        }
        // the next instance must be listening before a client gives up waiting (libuv waits 30 s)
        pipe = loop {
            match server.instance(false) {
                Ok(h) => break h,
                Err(e) => {
                    log.line(&format!("control pipe instance failed: {e}; retrying"));
                    std::thread::sleep(LISTEN_RETRY);
                }
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // an in-memory stream: what the client sent, and what the daemon wrote back
    struct Duplex {
        input: std::io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }
    impl Read for Duplex {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.output.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn lines_in_order_and_malformed_requests() {
        let (tx, rx) = mpsc::channel::<Event>();
        let answer = std::thread::spawn(move || {
            while let Ok(Event::Control { req, reply }) = rx.recv() {
                let _ = reply.send(json!({ "ok": true, "op": req["op"] }));
            }
        });
        let mut d = Duplex {
            input: std::io::Cursor::new(b"{\"op\":\"ping\"}\n\nnot json\n{\"op\":\"x\"}\r\n".to_vec()),
            output: Vec::new(),
        };
        handle_connection(&mut d, &tx);
        drop(tx);
        answer.join().unwrap();
        let out = String::from_utf8(d.output).unwrap();
        assert_eq!(
            out,
            "{\"ok\":true,\"op\":\"ping\"}\n{\"ok\":false,\"error\":\"malformed request\"}\n{\"ok\":true,\"op\":\"x\"}\n"
        );
    }
}
