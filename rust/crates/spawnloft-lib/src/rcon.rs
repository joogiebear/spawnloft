//! A blocking RCON client for the Source protocol Minecraft speaks (`rcon.mjs`), enough for the
//! daemon's tick sampler.
//!
//! Replies over 4096 bytes arrive split with no length hint, so after the first reply packet a
//! sentinel packet with its own id is sent and its echo marks the end. The sentinel is never sent
//! together with the command: Minecraft's RCON thread reads one packet at a time and hangs up on a
//! read holding two.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const TYPE_AUTH: i32 = 3;
const TYPE_AUTH_RESPONSE: i32 = 2;
const TYPE_COMMAND: i32 = 2;
const TYPE_RESPONSE: i32 = 0;
const MIN_PACKET_SIZE: i32 = 10;
const MAX_PACKET_SIZE: i32 = 4110;

/// Why a call failed. `refused` means nothing listens (server down), as opposed to not answering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RconError {
    pub message: String,
    pub refused: bool,
}

impl std::fmt::Display for RconError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn err(message: impl Into<String>) -> RconError {
    RconError {
        message: message.into(),
        refused: false,
    }
}

pub fn encode_packet(id: i32, kind: i32, body: &str) -> Vec<u8> {
    let payload = body.as_bytes();
    let mut buf = Vec::with_capacity(14 + payload.len());
    buf.extend_from_slice(&(10 + payload.len() as i32).to_le_bytes());
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(&kind.to_le_bytes());
    buf.extend_from_slice(payload);
    buf.extend_from_slice(&[0, 0]);
    buf
}

#[derive(Debug)]
pub struct Rcon {
    stream: TcpStream,
    buffer: Vec<u8>,
    next_id: i32,
    timeout: Duration,
    host: String,
    port: u16,
}

struct Packet {
    id: i32,
    kind: i32,
    body: Vec<u8>,
}

impl Rcon {
    /// Connects to `127.0.0.1:port` and authenticates.
    pub fn connect(port: u16, password: &str, timeout: Duration) -> Result<Rcon, RconError> {
        let host = "127.0.0.1".to_string();
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| {
            if e.kind() == std::io::ErrorKind::ConnectionRefused {
                RconError {
                    message: format!(
                        "RCON refused on {host}:{port} - is the server running with enable-rcon=true?"
                    ),
                    refused: true,
                }
            } else if e.kind() == std::io::ErrorKind::TimedOut {
                // the socket's own timeout, as net's `timeout` event reports it
                err("RCON connection failed: connection timed out")
            } else {
                let (code, _) = crate::jspath::error_code(&e);
                err(format!("RCON connection failed: connect {code} {host}:{port}"))
            }
        })?;
        let _ = stream.set_nodelay(true);
        let mut rcon = Rcon {
            stream,
            buffer: Vec::new(),
            next_id: 1,
            timeout,
            host,
            port,
        };
        rcon.write(&encode_packet(0, TYPE_AUTH, password))?;
        let deadline = Instant::now() + timeout;
        loop {
            let packet = rcon
                .read_packet(deadline)?
                .ok_or_else(|| err("RCON authentication timed out"))?;
            if packet.id == -1 {
                return Err(err("RCON authentication failed - wrong rcon.password"));
            }
            if packet.kind == TYPE_AUTH_RESPONSE {
                return Ok(rcon);
            }
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), RconError> {
        self.stream
            .write_all(bytes)
            .map_err(|e| err(format!("RCON error: write {}", crate::jspath::error_code(&e).0)))
    }

    // One packet, or None when the deadline passed first.
    fn read_packet(&mut self, deadline: Instant) -> Result<Option<Packet>, RconError> {
        loop {
            if self.buffer.len() >= 4 {
                let size =
                    i32::from_le_bytes([self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]]);
                if !(MIN_PACKET_SIZE..=MAX_PACKET_SIZE).contains(&size) {
                    self.buffer.clear();
                    let _ = self.stream.shutdown(std::net::Shutdown::Both);
                    return Err(err(format!(
                        "RCON error: invalid packet length {size} from {}:{}",
                        self.host, self.port
                    )));
                }
                let total = 4 + size as usize;
                if self.buffer.len() >= total {
                    let id =
                        i32::from_le_bytes([self.buffer[4], self.buffer[5], self.buffer[6], self.buffer[7]]);
                    let kind = i32::from_le_bytes([
                        self.buffer[8],
                        self.buffer[9],
                        self.buffer[10],
                        self.buffer[11],
                    ]);
                    let body = self.buffer[12..total - 2].to_vec();
                    self.buffer.drain(..total);
                    return Ok(Some(Packet { id, kind, body }));
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            let _ = self.stream.set_read_timeout(Some(deadline - now));
            let mut chunk = [0u8; 4096];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err(err("RCON error: RCON connection closed")),
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    return Err(err(format!(
                        "RCON error: read {}",
                        crate::jspath::error_code(&e).0
                    )));
                }
            }
        }
    }

    /// Runs one command and returns its whole reply; a reply cut short by the timeout is returned
    /// as far as it got, and no reply at all is an error.
    pub fn send(&mut self, command: &str) -> Result<String, RconError> {
        let id = self.next_id;
        let sentinel = self.next_id + 1;
        self.next_id += 2;
        self.write(&encode_packet(id, TYPE_COMMAND, command))?;
        let deadline = Instant::now() + self.timeout;
        let mut chunks: Vec<u8> = Vec::new();
        let mut got_any = false;
        loop {
            let Some(packet) = self.read_packet(deadline)? else {
                return if got_any {
                    Ok(String::from_utf8_lossy(&chunks).into_owned())
                } else {
                    // net's idle timeout, armed again by the command's write, fires just before
                    // the command's own timer, so a command with no reply fails as the socket
                    Err(err("RCON error: RCON timed out"))
                };
            };
            if packet.id == sentinel {
                return Ok(String::from_utf8_lossy(&chunks).into_owned());
            }
            if packet.id == id {
                chunks.extend_from_slice(&packet.body);
                if !got_any {
                    got_any = true;
                    self.write(&encode_packet(sentinel, TYPE_RESPONSE, ""))?;
                }
            }
        }
    }
}

/// Strips section-sign colour codes, legacy and Paper's hex form alike.
pub fn strip_colors(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{a7}'
            && let Some(&n) = chars.peek()
            && (n.is_ascii_digit() || matches!(n.to_ascii_lowercase(), 'a'..='f' | 'k'..='o' | 'r' | 'x'))
        {
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

/// `RCON_TIMEOUT_MS`: how long a command may take to answer; the environment override is for
/// tests.
pub fn timeout_ms() -> f64 {
    let n = crate::paths::env_var("RCON_TIMEOUT_MS")
        .map(|v| crate::js::number(Some(&serde_json::Value::String(v))))
        .unwrap_or(f64::NAN);
    if n > 0.0 { n } else { 8000.0 }
}

/// A failed `rconExec`; `unsent` when nothing could have been written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecError {
    pub message: String,
    pub unsent: bool,
}

/// `rconExec` options.
#[derive(Debug, Clone, Copy)]
pub struct ExecOptions {
    pub attempts: u32,
    pub timeout_ms: f64,
    pub retry_timeouts: bool,
    pub retry_sent: bool,
}

impl Default for ExecOptions {
    fn default() -> Self {
        ExecOptions {
            attempts: 3,
            timeout_ms: timeout_ms(),
            retry_timeouts: true,
            retry_sent: true,
        }
    }
}

fn transient(message: &str, timeouts: bool) -> bool {
    let m = message.to_ascii_lowercase();
    ["connection closed", "econnreset", "epipe", "econnaborted"]
        .iter()
        .any(|w| m.contains(w))
        || (timeouts && m.contains("timed out"))
}

/// `rconExec(inst, commands, opts)`: connect, run the commands, disconnect. Transient socket
/// failures are retried on a fresh connection, after `120 * attempt` ms.
pub fn exec(
    inst: &crate::registry::Instance,
    commands: &[&str],
    opts: ExecOptions,
) -> Result<Vec<String>, ExecError> {
    let Some(port) = inst.rcon_port() else {
        return Err(ExecError {
            message: format!("instance \"{}\" has no RCON port configured", inst.name),
            unsent: true,
        });
    };
    let password = inst.rcon_password().unwrap_or_default();
    let timeout = crate::util::timer(opts.timeout_ms);
    let mut connected = false;
    let mut attempt = 1;
    loop {
        let result = Rcon::connect(port, &password, timeout).and_then(|mut rcon| {
            connected = true;
            let mut out = Vec::new();
            for c in commands {
                out.push(rcon.send(c)?);
            }
            Ok(out)
        });
        match result {
            Ok(out) => return Ok(out),
            Err(e) => {
                if attempt >= opts.attempts
                    || (connected && !opts.retry_sent)
                    || !transient(&e.message, opts.retry_timeouts)
                {
                    return Err(ExecError {
                        message: e.message,
                        unsent: !connected,
                    });
                }
                crate::util::sleep(f64::from(120 * attempt));
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn packet_from(stream: &mut TcpStream) -> (i32, i32, String) {
        let mut len = [0u8; 4];
        stream.read_exact(&mut len).unwrap();
        let size = i32::from_le_bytes(len) as usize;
        let mut rest = vec![0u8; size];
        stream.read_exact(&mut rest).unwrap();
        let id = i32::from_le_bytes(rest[0..4].try_into().unwrap());
        let kind = i32::from_le_bytes(rest[4..8].try_into().unwrap());
        (id, kind, String::from_utf8_lossy(&rest[8..size - 2]).into_owned())
    }

    #[test]
    fn auth_command_and_split_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let (id, kind, body) = packet_from(&mut s);
            assert_eq!((id, kind, body.as_str()), (0, 3, "pw"));
            s.write_all(&encode_packet(0, 2, "")).unwrap();
            let (id, _, body) = packet_from(&mut s);
            assert_eq!(body, "list");
            s.write_all(&encode_packet(id, 0, "There are 1 of a max of 20 "))
                .unwrap();
            let (sentinel, _, _) = packet_from(&mut s);
            s.write_all(&encode_packet(id, 0, "players online: A")).unwrap();
            s.write_all(&encode_packet(sentinel, 0, "Unknown request 0"))
                .unwrap();
        });
        let mut rcon = Rcon::connect(port, "pw", Duration::from_secs(3)).unwrap();
        assert_eq!(
            rcon.send("list").unwrap(),
            "There are 1 of a max of 20 players online: A"
        );
        server.join().unwrap();
    }

    #[test]
    fn wrong_password_and_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = packet_from(&mut s);
            s.write_all(&encode_packet(-1, 2, "")).unwrap();
        });
        let e = Rcon::connect(port, "bad", Duration::from_secs(3)).unwrap_err();
        assert!(e.message.contains("wrong rcon.password"));
        server.join().unwrap();
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(
            Rcon::connect(free, "x", Duration::from_secs(3))
                .unwrap_err()
                .refused
        );
    }

    #[test]
    fn strips_colours() {
        assert_eq!(
            strip_colors("\u{a7}6TPS \u{a7}a*20.0\u{a7}r \u{a7}x\u{a7}F"),
            "TPS *20.0 "
        );
        assert_eq!(strip_colors("a\u{a7}"), "a\u{a7}");
    }
}
