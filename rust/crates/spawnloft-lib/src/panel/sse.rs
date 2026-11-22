//! An event stream as the panel's pages read one (`text/event-stream`): events as `data:` lines
//! of JSON, a `: ping` every twenty seconds so an idle timeout does not drop a quiet stream, and
//! an end when the page goes away.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::http::{Reply, write_head};
use crate::jsjson;

const BEAT: Duration = Duration::from_secs(20);
/// How often a quiet stream looks whether its page is still there. Node hears the socket close
/// at once; a thread that only waits for events would hold on until the next beat failed.
const LOOK: Duration = Duration::from_millis(500);

/// `data: <json>\n\n`.
pub fn event(value: &Value) -> String {
    format!("data: {}\n\n", jsjson::stringify(value))
}

/// Whether the other end has hung up: a read that would return nothing more.
fn gone(conn: &TcpStream) -> bool {
    if conn.set_nonblocking(true).is_err() {
        return true;
    }
    let mut sink = [0u8; 256];
    let mut reader: &TcpStream = conn;
    let closed = loop {
        match reader.read(&mut sink) {
            Ok(0) => break true,
            // a page sends nothing on a stream; whatever came is dropped
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break false,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break true,
        }
    };
    closed || conn.set_nonblocking(false).is_err()
}

/// The reply that streams: `first` at once (what is known now, because the page opens the stream
/// right after it started the work and the two race), then every event from `events` until the
/// page goes away or the sender does. `closed` runs when it ends, however it ends.
pub fn stream(first: Vec<String>, events: Receiver<String>, closed: impl FnOnce() + Send + 'static) -> Reply {
    Reply::Stream(Box::new(move |conn, proof| {
        struct Closed<F: FnOnce()>(Option<F>);
        impl<F: FnOnce()> Drop for Closed<F> {
            fn drop(&mut self) {
                if let Some(f) = self.0.take() {
                    f();
                }
            }
        }
        let _closed = Closed(Some(closed));
        let mut headers = vec![
            ("Content-Type".to_string(), "text/event-stream".to_string()),
            ("Cache-Control".to_string(), "no-cache".to_string()),
        ];
        if let Some(p) = proof {
            headers.push((crate::panel_auth::PROOF_HEADER.to_string(), p.to_string()));
        }
        write_head(conn, 200, &headers, None)?;
        for e in &first {
            conn.write_all(e.as_bytes())?;
        }
        conn.flush()?;
        let mut beat = Instant::now() + BEAT;
        loop {
            match events.recv_timeout(LOOK) {
                Ok(e) => {
                    conn.write_all(e.as_bytes())?;
                    conn.flush()?;
                }
                Err(RecvTimeoutError::Timeout) => {
                    if gone(conn) {
                        return Ok(());
                    }
                    if Instant::now() >= beat {
                        conn.write_all(b": ping\n\n")?;
                        conn.flush()?;
                        beat = Instant::now() + BEAT;
                    }
                }
                // nothing can send any more: the stream stays open, as Node's does, until the
                // page closes it
                Err(RecvTimeoutError::Disconnected) => {
                    while !gone(conn) {
                        std::thread::sleep(LOOK);
                        if Instant::now() >= beat {
                            conn.write_all(b": ping\n\n")?;
                            conn.flush()?;
                            beat = Instant::now() + BEAT;
                        }
                    }
                    return Ok(());
                }
            }
        }
    }))
}
