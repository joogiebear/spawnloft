//! A minimal Redis-protocol client (`resp.mjs`), enough to ask Garnet for a checkpoint before it
//! is stopped. Garnet ships no admin tool.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub fn encode(args: &[String]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", args.len()).into_bytes();
    for a in args {
        out.extend_from_slice(format!("${}\r\n", a.len()).as_bytes());
        out.extend_from_slice(a.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// One parsed reply: `Ok(text)` for a value, `Err(text)` for an error reply.
type Reply = Result<String, String>;

// Returns the reply and how many bytes it used, or None while it is incomplete.
fn parse(buf: &[u8]) -> Option<(Reply, usize)> {
    let nl = buf.windows(2).position(|w| w == b"\r\n")?;
    let head = String::from_utf8_lossy(&buf[..nl]).into_owned();
    let body = head.get(1..).unwrap_or("").to_string();
    match head.as_bytes().first() {
        Some(b'+') | Some(b':') => Some((Ok(body), nl + 2)),
        Some(b'-') => Some((Err(body), nl + 2)),
        Some(b'$') => {
            let len: i64 = body.parse().unwrap_or(-1);
            if len < 0 {
                return Some((Ok(String::new()), nl + 2));
            }
            let end = nl + 2 + len as usize;
            if buf.len() < end + 2 {
                return None;
            }
            Some((
                Ok(String::from_utf8_lossy(&buf[nl + 2..end]).into_owned()),
                end + 2,
            ))
        }
        Some(b'*') => {
            let n: i64 = body.parse().unwrap_or(0);
            let mut used = nl + 2;
            let mut first = String::new();
            for i in 0..n.max(0) {
                let (item, len) = parse(&buf[used..])?;
                if i == 0 {
                    first = item.unwrap_or_default();
                }
                used += len;
            }
            Some((Ok(first), used))
        }
        _ => Some((Ok(head), nl + 2)),
    }
}

/// Sends the commands in order (AUTH first when a password is given) and returns the last reply.
pub fn send(
    host: &str,
    port: u16,
    commands: &[Vec<String>],
    password: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut queue: Vec<Vec<String>> = Vec::new();
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        queue.push(vec!["AUTH".into(), pw.to_string()]);
    }
    queue.extend(commands.iter().cloned());
    let addr: SocketAddr = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .ok_or_else(|| format!("could not reach {host}:{port}: no address"))?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    let mut last = String::new();
    for (i, cmd) in queue.iter().enumerate() {
        stream
            .write_all(&encode(cmd))
            .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
        loop {
            if let Some((reply, used)) = parse(&buf) {
                buf.drain(..used);
                match reply {
                    Ok(v) => last = v,
                    Err(e) => return Err(format!("{host}:{port} refused: {e}")),
                }
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "no reply from {host}:{port} within {}ms",
                    timeout.as_millis()
                ));
            }
            let _ = stream.set_read_timeout(Some(deadline - now));
            let mut chunk = [0u8; 4096];
            match stream.read(&mut chunk) {
                Ok(0) => {
                    // SHUTDOWN closes the socket instead of replying, so the close is the answer
                    let is_last = i + 1 == queue.len();
                    if is_last && cmd.first().is_some_and(|c| c.eq_ignore_ascii_case("SHUTDOWN")) {
                        return Ok(if last.is_empty() { "OK".into() } else { last });
                    }
                    return Err(format!("{host}:{port} closed the connection"));
                }
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Err(format!(
                        "no reply from {host}:{port} within {}ms",
                        timeout.as_millis()
                    ));
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("could not reach {host}:{port}: {e}")),
            }
        }
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn encodes_and_parses() {
        assert_eq!(encode(&["SAVE".into()]), b"*1\r\n$4\r\nSAVE\r\n");
        assert_eq!(parse(b"+OK\r\n"), Some((Ok("OK".into()), 5)));
        assert_eq!(parse(b"-ERR no\r\n"), Some((Err("ERR no".into()), 9)));
        assert_eq!(parse(b"$4\r\nPONG\r\n"), Some((Ok("PONG".into()), 10)));
        assert_eq!(parse(b"$4\r\nPO"), None);
        assert_eq!(parse(b"*1\r\n+PONG\r\n"), Some((Ok("PONG".into()), 11)));
    }

    #[test]
    fn auth_then_save() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0u8; 256];
            while !String::from_utf8_lossy(&seen).contains("SAVE") {
                let n = s.read(&mut chunk).unwrap();
                seen.extend_from_slice(&chunk[..n]);
                if String::from_utf8_lossy(&seen).contains("pw\r\n")
                    && !String::from_utf8_lossy(&seen).contains("+")
                {
                    s.write_all(b"+OK\r\n").unwrap();
                    seen.extend_from_slice(b"+");
                }
            }
            s.write_all(b"+OK\r\n").unwrap();
        });
        let got = send(
            "127.0.0.1",
            port,
            &[vec!["SAVE".into()]],
            Some("pw"),
            Duration::from_secs(3),
        );
        assert_eq!(got, Ok("OK".into()));
        server.join().unwrap();
    }
}
