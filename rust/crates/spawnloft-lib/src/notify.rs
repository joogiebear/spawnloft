//! The Discord webhook per instance (`notify.mjs`): crash, recovery and give-up messages. A dead
//! webhook is logged and otherwise ignored.
//!
//! Plain `http://` is posted natively. `https://` needs TLS, which std does not have; rather than
//! carry a TLS stack for a few messages a month, it is posted by the system's curl
//! (`%SystemRoot%\System32\curl.exe` on Windows 10 1803 and later, `/usr/bin/curl` on macOS and
//! desktop Linux), with the URL and body passed on stdin so the webhook token never appears in a
//! process listing. A machine with no curl logs that the webhook could not be sent.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const TIMEOUT: Duration = Duration::from_secs(5);

/// The payload, exactly as `formatDiscord` builds it.
pub fn format_discord(instance: &str, message: &str) -> String {
    serde_json::json!({ "content": format!("**{instance}** \u{2014} {message}") }).to_string()
}

/// Posts the body; `Ok(status)` for any answer, `Err` when nothing answered.
pub fn post(url: &str, body: &str) -> Result<u16, String> {
    if let Some(rest) = url.strip_prefix("http://") {
        return post_plain(rest, body);
    }
    if url.starts_with("https://") {
        return post_with_curl(url, body);
    }
    Err(format!("{url} is not an http(s) URL"))
}

fn post_plain(rest: &str, body: &str) -> Result<u16, String> {
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // a fragment is never sent
    let path = path.split('#').next().unwrap_or("/");
    let path = if path.is_empty() || path.starts_with('?') {
        format!("/{path}")
    } else {
        path.to_string()
    };
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = split_host_port(host_port)?;
    let deadline = Instant::now() + TIMEOUT;
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("fetch failed: {e}"))?
        .next()
        .ok_or_else(|| "fetch failed: no address".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT).map_err(|e| format!("fetch failed: {e}"))?;
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host_port}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("fetch failed: {e}"))?;
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(2).any(|w| w == b"\r\n") {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("The operation was aborted due to timeout".into());
        }
        let _ = stream.set_read_timeout(Some(left));
        match stream.read(&mut chunk) {
            Ok(0) => return Err("fetch failed: the server closed the connection".into()),
            Ok(n) => head.extend_from_slice(&chunk[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err("The operation was aborted due to timeout".into());
            }
            Err(e) => return Err(format!("fetch failed: {e}")),
        }
    }
    let line = String::from_utf8_lossy(&head);
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "fetch failed: not an HTTP answer".to_string())
}

fn split_host_port(host_port: &str) -> Result<(&str, u16), String> {
    let bad = || format!("bad port in {host_port}");
    if let Some(inner) = host_port.strip_prefix('[') {
        let (host, rest) = inner.split_once(']').ok_or_else(bad)?;
        return match rest.strip_prefix(':') {
            Some(p) => Ok((host, p.parse().map_err(|_| bad())?)),
            None if rest.is_empty() => Ok((host, 80)),
            None => Err(bad()),
        };
    }
    match host_port.rsplit_once(':') {
        Some((h, p)) => Ok((h, p.parse().map_err(|_| bad())?)),
        None => Ok((host_port, 80)),
    }
}

fn curl_path() -> Option<PathBuf> {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let p = root.join("System32").join("curl.exe");
        return p.exists().then_some(p);
    }
    [
        "/usr/bin/curl",
        "/bin/curl",
        "/usr/local/bin/curl",
        "/opt/homebrew/bin/curl",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

/// A string as curl's config syntax wants it: double-quoted, with `\` and `"` escaped.
pub fn curl_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn post_with_curl(url: &str, body: &str) -> Result<u16, String> {
    let curl = curl_path()
        .ok_or_else(|| "an https webhook needs curl, which this machine does not have".to_string())?;
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = \"content-type: application/json\"\ndata-binary = {}\nwrite-out = \"%{{http_code}}\"\noutput = {}\nsilent\nshow-error\nmax-time = {}\n",
        curl_quote(url),
        curl_quote(body),
        curl_quote(if cfg!(windows) { "NUL" } else { "/dev/null" }),
        TIMEOUT.as_secs()
    );
    let mut cmd = Command::new(curl);
    cmd.args(["--disable", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not run curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("curl failed: {e}"))?;
    let code = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u16>()
        .unwrap_or(0);
    if !out.status.success() || code == 0 {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() {
            format!("curl exited with {}", out.status)
        } else {
            why
        });
    }
    Ok(code)
}

/// Sends `message` for the instance on its own thread; `log` gets one line when it fails.
pub fn notify(
    instance: &str,
    webhook: Option<String>,
    message: &str,
    log: impl Fn(String) + Send + 'static,
) -> Option<std::thread::JoinHandle<()>> {
    let url = webhook?;
    let body = format_discord(instance, message);
    std::thread::Builder::new()
        .name("webhook".into())
        .spawn(move || match post(&url, &body) {
            Ok(status) if (200..300).contains(&status) => {}
            Ok(status) => log(format!("webhook answered {status}")),
            Err(e) => log(format!("webhook failed: {e}")),
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn payload_matches_format_discord() {
        assert_eq!(
            format_discord("stock", "crashed (exit 1). Restarting in 10s."),
            r#"{"content":"**stock** — crashed (exit 1). Restarting in 10s."}"#
        );
    }

    #[test]
    fn posts_plain_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut chunk = [0u8; 1024];
            while !String::from_utf8_lossy(&got).contains("}") {
                let n = s.read(&mut chunk).unwrap();
                got.extend_from_slice(&chunk[..n]);
            }
            s.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
            String::from_utf8(got).unwrap()
        });
        assert_eq!(
            post(
                &format!("http://127.0.0.1:{port}/hook?wait=true"),
                r#"{"content":"x"}"#
            ),
            Ok(204)
        );
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /hook?wait=true HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains("content-type: application/json"));
    }

    #[test]
    fn unreachable_is_an_error() {
        assert!(post("http://127.0.0.1:1/nothing-listens-here", "{}").is_err());
        assert!(post("ftp://x", "{}").is_err());
    }

    #[test]
    fn curl_config_quoting() {
        assert_eq!(curl_quote(r#"{"a":"b\n"}"#), r#""{\"a\":\"b\\n\"}""#);
    }
}
