//! `spawnloft-core ui`: the panel's HTTP endpoint on 127.0.0.1 (Phase 0 spike, P0-F).
//!
//! The panel API is still Node (`src/ui.mjs`) until R6 ports it. Until then this is a small
//! reverse proxy: it starts the Node panel on a port of its own (`node spawnloft.mjs ui --port 0
//! --no-open`) and forwards every request to it, so a window (the Tauri shell, later the Electron
//! window of step 2) is pointed at the address and port that will stay the same when the routes
//! move to Rust. With no Node found it answers with a page that says so.
//!
//! One request per connection (`Connection: close` both ways), std threads and blocking I/O: the
//! panel opens a handful of connections, three of them long-lived event streams, which is a thread
//! each. Request and response bodies are copied byte for byte after the head, so event streams,
//! uploads and chunked bodies need nothing special.
//!
//! The same Host and Origin rule as `ui.mjs` is applied here before anything is forwarded,
//! because the proxy rewrites both headers for the upstream: without its own check a page on
//! another origin would reach the Node panel through it with a "same-origin" request.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What `ui` was asked to do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options {
    /// Port to bind on 127.0.0.1; 0 picks a free one (what the window shells pass).
    pub port: u16,
    /// Folder holding `spawnloft.mjs` and `src/` (the Node core) to start the upstream from.
    pub core_dir: Option<PathBuf>,
    /// Node executable; found on PATH (or `SPAWNLOFT_NODE`) when not given.
    pub node: Option<PathBuf>,
    /// An already running panel to forward to (`http://127.0.0.1:<port>/`), instead of starting one.
    pub upstream: Option<String>,
    /// End when stdin reaches end of file: a window shell holds the pipe, so this process (and
    /// the Node panel under it) never outlives the window, however the window ends.
    pub exit_with_stdin: bool,
}

/// The line every panel prints once it listens; the shells read the URL from it.
pub const READY_PREFIX: &str = "SpawnLoft panel: ";

const HEAD_LIMIT: usize = 64 * 1024;
const UPSTREAM_START_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a client may take to send a request head (P0-F review L5): a connection that never
/// finishes one would otherwise hold a thread for ever. Bodies and responses have no limit, since
/// uploads are slow and the panel's event streams stay open for hours.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Runs until killed (or stdin closes with `exit_with_stdin`). Returns an exit code only when it
/// could not start.
pub fn run(opts: Options) -> i32 {
    let listener = match TcpListener::bind(("127.0.0.1", opts.port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "spawnloft-core ui: could not listen on 127.0.0.1:{}: {e}",
                opts.port
            );
            return 1;
        }
    };
    let local = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("spawnloft-core ui: {e}");
            return 1;
        }
    };

    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let upstream = match &opts.upstream {
        Some(u) => match parse_upstream(u) {
            Some(addr) => Upstream::Node(addr),
            None => {
                eprintln!("spawnloft-core ui: --upstream must be http://127.0.0.1:<port>/");
                return 64;
            }
        },
        None => match start_node_panel(&opts, &child, local.port()) {
            Ok(addr) => Upstream::Node(addr),
            Err(why) => {
                eprintln!("spawnloft-core ui: no Node panel: {why}");
                Upstream::Missing(why)
            }
        },
    };

    if opts.exit_with_stdin {
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            stop_child(&child);
            std::process::exit(0);
        });
    }

    println!("{READY_PREFIX}http://127.0.0.1:{}/", local.port());
    let _ = std::io::stdout().flush();

    let upstream = Arc::new(upstream);
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let upstream = Arc::clone(&upstream);
        std::thread::spawn(move || {
            let _ = handle(conn, local, &upstream);
        });
    }
    stop_child(&child);
    0
}

#[derive(Debug)]
enum Upstream {
    Node(SocketAddr),
    Missing(String),
}

/// Set once this process is stopping the Node panel on purpose, so its end is not a crash.
static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn stop_child(child: &Mutex<Option<Child>>) {
    STOPPING.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut guard) = child.lock()
        && let Some(mut c) = guard.take()
    {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// `http://127.0.0.1:<port>/` (or `localhost`) only: the proxy never forwards off the machine.
pub fn parse_upstream(url: &str) -> Option<SocketAddr> {
    let rest = url.strip_prefix("http://")?;
    let hostport = rest.split('/').next()?;
    let (host, port) = hostport.rsplit_once(':')?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(SocketAddr::from(([127, 0, 0, 1], port)))
}

/// Node from `--node`, `SPAWNLOFT_NODE`, or the first `node` on PATH.
pub fn find_node(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os("SPAWNLOFT_NODE").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(gui_fallback_dirs())
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
}

/// An app started from Finder or launchd gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, without the
/// places Node is installed (found on the Mac mini in P0-F); Electron never needed this because it
/// carries Node. Checked after PATH, so a PATH entry still wins.
fn gui_fallback_dirs() -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".volta/bin"));
        // nvm keeps one folder per version; any of them will do for the spike (sorted by name)
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    dirs
}

/// `public_port` is this proxy's port: the Node panel puts it in the Microsoft sign-in's redirect
/// URI (`SPAWNLOFT_PANEL_PUBLIC_PORT`), so the browser comes back through the address the window
/// knows and can check, not the upstream's.
fn start_node_panel(
    opts: &Options,
    slot: &Mutex<Option<Child>>,
    public_port: u16,
) -> Result<SocketAddr, String> {
    let core_dir = opts
        .core_dir
        .clone()
        .ok_or("no --core-dir given, so there is no Node core to start")?;
    let entry = core_dir.join("spawnloft.mjs");
    if !entry.is_file() {
        return Err(format!("{} is missing", entry.display()));
    }
    let node =
        find_node(opts.node.as_deref()).ok_or("Node.js was not found (install it, or set SPAWNLOFT_NODE)")?;
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        // --exit-with-stdin: the panel ends when this process does, a kill included, because the
        // pipe closes with it (no Node panel left behind by a killed core)
        .args(["ui", "--port", "0", "--no-open", "--exit-with-stdin"])
        .current_dir(&core_dir)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env("SPAWNLOFT_PANEL_PUBLIC_PORT", public_port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", node.display()))?;
    // Windows: also a kill-on-close job, for a Node that is busy and not reading its stdin
    crate::platform::end_with_this_process(&child);
    // the write end stays open as long as this process lives; never written to
    if let Some(stdin) = child.stdin.take() {
        std::mem::forget(stdin);
    }
    let stdout = child.stdout.take().ok_or("no stdout from the Node panel")?;
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(child);
    }

    // The URL line, then keep draining so the panel never blocks on a full pipe.
    let (tx, rx) = std::sync::mpsc::channel::<Option<SocketAddr>>();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !sent && let Some(url) = line.trim().strip_prefix(READY_PREFIX) {
                let _ = tx.send(parse_upstream(url.trim()));
                sent = true;
            }
        }
        if !sent {
            let _ = tx.send(None);
        } else if !STOPPING.load(std::sync::atomic::Ordering::SeqCst) {
            // the Node panel died under a running proxy: end too, so the window (which starts the
            // core again when it ends by itself) brings both back instead of serving 502s for ever
            eprintln!("spawnloft-core ui: the Node panel exited; stopping so the window can start it again");
            std::process::exit(70);
        }
    });
    match rx.recv_timeout(UPSTREAM_START_TIMEOUT) {
        Ok(Some(addr)) => Ok(addr),
        Ok(None) => {
            stop_child(slot);
            Err("the Node panel exited before it printed its address".into())
        }
        Err(_) => {
            stop_child(slot);
            Err("the Node panel did not start within 60 s".into())
        }
    }
}

/// A parsed request head: the raw lines, so they can be forwarded as they came.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Head {
    pub request_line: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn path(&self) -> &str {
        self.request_line.split(' ').nth(1).unwrap_or("/")
    }

    pub fn method(&self) -> &str {
        self.request_line.split(' ').next().unwrap_or("GET")
    }

    /// `Content-Length`, when the request announces a body.
    pub fn content_length(&self) -> Option<usize> {
        self.header("content-length").and_then(|v| v.trim().parse().ok())
    }
}

/// Routes `spawnloft-core ui` answers itself instead of forwarding (the updater, design 5.1).
pub fn is_local_route(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    route == "/api/update" || route.starts_with("/api/update/") || crate::handover::api::is_route(route)
}

/// The largest body a locally answered route reads.
const LOCAL_BODY_LIMIT: usize = 64 * 1024;

/// Splits `buf` (which holds at least the head) into the head and how many bytes it took.
pub fn parse_head(buf: &[u8]) -> Option<(Head, usize)> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let text = std::str::from_utf8(&buf[..end - 4]).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?.to_string();
    if request_line.split(' ').count() != 3 {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        let (k, v) = line.split_once(':')?;
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }
    Some((
        Head {
            request_line,
            headers,
        },
        end,
    ))
}

/// The same rule as `isLocalRequest` in `src/ui.mjs`: the Host header names a loopback address
/// (defeats DNS rebinding), and an Origin, when there is one, has exactly that host and port.
pub fn is_local_request(head: &Head) -> bool {
    let Some(host) = head.header("host") else {
        return false;
    };
    let hostname = match host.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    };
    let loopback = matches!(
        hostname.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    );
    if !loopback {
        return false;
    }
    match head.header("origin") {
        None => true,
        Some(origin) => origin
            .split_once("://")
            .map(|(_, rest)| rest.trim_end_matches('/'))
            .is_some_and(|o| o.eq_ignore_ascii_case(host)),
    }
}

/// The head as sent upstream: Host and Origin name the upstream (the Node panel applies its own
/// check to them), and the connection closes after one exchange.
pub fn rewrite_head(head: &Head, upstream: SocketAddr) -> Vec<u8> {
    let up = format!("127.0.0.1:{}", upstream.port());
    let mut out = format!("{}\r\n", head.request_line);
    for (k, v) in &head.headers {
        let lower = k.to_ascii_lowercase();
        match lower.as_str() {
            "host" => out.push_str(&format!("Host: {up}\r\n")),
            "origin" => out.push_str(&format!("Origin: http://{up}\r\n")),
            "connection" | "keep-alive" | "proxy-connection" => {}
            _ => out.push_str(&format!("{k}: {v}\r\n")),
        }
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

fn handle(mut conn: TcpStream, _local: SocketAddr, upstream: &Upstream) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    // one deadline for the whole head, not per read: a byte every 29 s would otherwise hold on
    let deadline = std::time::Instant::now() + HEAD_TIMEOUT;
    let (head, used) = loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Ok(());
        }
        conn.set_read_timeout(Some(left))?;
        let n = conn.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(parsed) = parse_head(&buf) {
            break parsed;
        }
        if buf.len() > HEAD_LIMIT || buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return respond(&mut conn, 400, "text/plain", b"bad request\n");
        }
    };
    if !is_local_request(&head) {
        return respond(
            &mut conn,
            403,
            "application/json",
            br#"{"error":"this panel only answers requests addressed to localhost"}"#,
        );
    }
    if is_local_route(head.path()) {
        let want = head.content_length().unwrap_or(0);
        if want > LOCAL_BODY_LIMIT {
            return respond(
                &mut conn,
                413,
                "application/json",
                br#"{"error":"request body too large"}"#,
            );
        }
        let mut body = buf[used..].to_vec();
        while body.len() < want {
            let n = conn.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(want);
        let route = head.path().split('?').next().unwrap_or("");
        let (status, json) = if crate::handover::api::is_route(route) {
            crate::handover::api::handle(head.method(), head.path())
        } else {
            crate::update::api::handle(head.method(), head.path(), &body)
        };
        return respond(&mut conn, status, "application/json", json.to_string().as_bytes());
    }
    conn.set_read_timeout(None)?;
    let addr = match upstream {
        Upstream::Node(addr) => *addr,
        Upstream::Missing(why) => return missing(&mut conn, &head, why),
    };
    let mut up = match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
        Ok(s) => s,
        Err(e) => {
            let body = format!("{{\"error\":\"the panel process is not answering: {e}\"}}");
            return respond(&mut conn, 502, "application/json", body.as_bytes());
        }
    };
    up.write_all(&rewrite_head(&head, addr))?;
    up.write_all(&buf[used..])?;

    // request body (if any) up, response down; each side closes its half when its source ends
    let mut up_reader = up.try_clone()?;
    let mut conn_writer = conn.try_clone()?;
    let pump = std::thread::spawn(move || {
        let _ = std::io::copy(&mut conn, &mut up);
        let _ = up.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut up_reader, &mut conn_writer);
    let _ = conn_writer.shutdown(Shutdown::Both);
    let _ = up_reader.shutdown(Shutdown::Both);
    let _ = pump.join();
    Ok(())
}

fn missing(conn: &mut TcpStream, head: &Head, why: &str) -> std::io::Result<()> {
    if head.path().starts_with("/api/") {
        let body = format!(
            "{{\"error\":\"the panel API is not running: {}\"}}",
            why.replace('\\', "\\\\").replace('"', "\\\"")
        );
        return respond(conn, 503, "application/json", body.as_bytes());
    }
    let page = format!(
        "<!doctype html><meta charset=utf-8><title>SpawnLoft</title>\
         <body style=\"font:15px system-ui;margin:3em;color:#ddd;background:#1b1d22\">\
         <h1 style=\"font-size:20px\">SpawnLoft (internal spike)</h1>\
         <p>The window works, but the panel behind it could not start: {}</p>\
         <p>This build still runs the panel on Node.js; install Node 20 or later and reopen SpawnLoft.</p>",
        html_escape(why)
    );
    respond(conn, 503, "text/html; charset=utf-8", page.as_bytes())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn respond(conn: &mut TcpStream, status: u16, kind: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    conn.write_all(head.as_bytes())?;
    conn.write_all(body)?;
    conn.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> Head {
        parse_head(raw.as_bytes()).unwrap().0
    }

    #[test]
    fn upstream_must_be_loopback() {
        assert_eq!(
            parse_upstream("http://127.0.0.1:8770/"),
            Some(SocketAddr::from(([127, 0, 0, 1], 8770)))
        );
        assert!(parse_upstream("http://localhost:1/").is_some());
        assert_eq!(parse_upstream("http://192.168.1.2:8770/"), None);
        assert_eq!(parse_upstream("https://127.0.0.1:8770/"), None);
        assert_eq!(parse_upstream("http://127.0.0.1:0/"), None);
    }

    #[test]
    fn head_parsing() {
        let raw = "GET /api/servers HTTP/1.1\r\nHost: 127.0.0.1:5\r\nX-A: b\r\n\r\nbody";
        let (h, used) = parse_head(raw.as_bytes()).unwrap();
        assert_eq!(&raw[used..], "body");
        assert_eq!(h.path(), "/api/servers");
        assert_eq!(h.header("x-a"), Some("b"));
        assert!(parse_head(b"GET / HTTP/1.1\r\nHost: x\r\n").is_none());
        assert!(parse_head(b"nonsense\r\n\r\n").is_none());
    }

    #[test]
    fn local_rule_matches_ui_mjs() {
        assert!(is_local_request(&head(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:9000\r\n\r\n"
        )));
        assert!(is_local_request(&head(
            "GET / HTTP/1.1\r\nHost: localhost:9000\r\nOrigin: http://localhost:9000\r\n\r\n"
        )));
        // DNS rebinding: a loopback address under someone else's name
        assert!(!is_local_request(&head(
            "GET / HTTP/1.1\r\nHost: evil.example:9000\r\n\r\n"
        )));
        // another local origin (a plugin web UI on another port) is not this panel
        assert!(!is_local_request(&head(
            "POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:9000\r\nOrigin: http://127.0.0.1:9001\r\n\r\n"
        )));
        assert!(!is_local_request(&head("GET / HTTP/1.1\r\nX: y\r\n\r\n")));
    }

    #[test]
    fn rewrite_names_the_upstream_and_closes() {
        let h = head(
            "POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:9000\r\nOrigin: http://127.0.0.1:9000\r\n\
             Connection: keep-alive\r\nContent-Length: 2\r\n\r\n",
        );
        let out = String::from_utf8(rewrite_head(&h, SocketAddr::from(([127, 0, 0, 1], 7)))).unwrap();
        assert!(out.starts_with("POST /api/x HTTP/1.1\r\n"));
        assert!(out.contains("Host: 127.0.0.1:7\r\n"));
        assert!(out.contains("Origin: http://127.0.0.1:7\r\n"));
        assert!(out.contains("Content-Length: 2\r\n"));
        assert!(!out.contains("keep-alive"));
        assert!(out.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn proxies_a_request_end_to_end() {
        // a fake upstream that echoes the Host it was sent
        let up = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_addr = up.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = up.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let (h, _) = parse_head(&buf[..n]).unwrap();
            let body = h.header("host").unwrap().to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(resp.as_bytes()).unwrap();
        });
        let front = TcpListener::bind("127.0.0.1:0").unwrap();
        let front_addr = front.local_addr().unwrap();
        std::thread::spawn(move || {
            let (c, _) = front.accept().unwrap();
            handle(c, front_addr, &Upstream::Node(up_addr)).unwrap();
        });
        let mut c = TcpStream::connect(front_addr).unwrap();
        write!(
            c,
            "GET /api/a HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            front_addr.port()
        )
        .unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200 OK"));
        assert!(out.ends_with(&format!("127.0.0.1:{}", up_addr.port())));
    }

    #[test]
    fn refuses_a_foreign_origin_before_forwarding() {
        let front = TcpListener::bind("127.0.0.1:0").unwrap();
        let front_addr = front.local_addr().unwrap();
        std::thread::spawn(move || {
            let (c, _) = front.accept().unwrap();
            // an upstream that does not exist: a forwarded request would be a 502, not a 403
            let nowhere = SocketAddr::from(([127, 0, 0, 1], 9));
            handle(c, front_addr, &Upstream::Node(nowhere)).unwrap();
        });
        let mut c = TcpStream::connect(front_addr).unwrap();
        write!(
            c,
            "POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nOrigin: http://evil.example\r\n\r\n",
            p = front_addr.port()
        )
        .unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 403"));
    }

    #[test]
    fn without_node_the_page_says_so_and_the_api_is_503() {
        for (path, kind) in [("/", "text/html"), ("/api/servers", "application/json")] {
            let front = TcpListener::bind("127.0.0.1:0").unwrap();
            let front_addr = front.local_addr().unwrap();
            std::thread::spawn(move || {
                let (c, _) = front.accept().unwrap();
                handle(c, front_addr, &Upstream::Missing("no node".into())).unwrap();
            });
            let mut c = TcpStream::connect(front_addr).unwrap();
            write!(
                c,
                "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
                front_addr.port()
            )
            .unwrap();
            let mut out = String::new();
            c.read_to_string(&mut out).unwrap();
            assert!(out.starts_with("HTTP/1.1 503"), "{out}");
            assert!(out.contains(kind));
            assert!(out.contains("no node"));
        }
    }

    #[test]
    fn updater_routes_are_answered_here_even_without_node() {
        // an unknown updater route is a 404 from this process, not a 503 from the missing upstream
        let front = TcpListener::bind("127.0.0.1:0").unwrap();
        let front_addr = front.local_addr().unwrap();
        std::thread::spawn(move || {
            let (c, _) = front.accept().unwrap();
            handle(c, front_addr, &Upstream::Missing("no node".into())).unwrap();
        });
        let mut c = TcpStream::connect(front_addr).unwrap();
        write!(
            c,
            "POST /api/update/nothing HTTP/1.1\r\nHost: localhost:{p}\r\nOrigin: http://localhost:{p}\r\nContent-Length: 2\r\n\r\n{{}}",
            p = front_addr.port()
        )
        .unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 404"), "{out}");
        assert!(out.contains("no updater route"), "{out}");
        assert!(is_local_route("/api/update?x=1") && is_local_route("/api/update/log?n=3"));
        assert!(!is_local_route("/api/updates") && !is_local_route("/api/servers"));
    }
}
