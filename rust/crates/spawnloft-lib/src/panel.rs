//! `spawnloft-core ui`: the panel's HTTP endpoint on 127.0.0.1.
//!
//! Every route of the Node panel (`src/ui.mjs`) is answered in this process
//! (rust/PLAN-CORE-PORT.md C8): `panel/routes.rs` is its `route()`, and the files beside it are
//! its handlers. Nothing is handed on to another process.
//!
//! One request per connection (`Connection: close`), std threads and blocking I/O: the panel
//! opens a handful of connections, three of them long-lived event streams, which is a thread
//! each. A route reads its body through `panel/http.rs`, which ends it where the head says.
//!
//! Who may call is decided here, before a route is looked at (`panel_auth`): the request must be
//! addressed to this panel from this panel, and carry a session cookie or a signed token.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::panel_auth::{self, PanelAuth, Verdict};
use crate::settings::{self, Layout};

mod backups;
mod basics;
mod client;
mod creates;
mod databases;
mod http;
mod jobs;
mod pages;
mod players;
mod plugins;
mod routes;
mod schedules;
mod server_files;
mod server_props;
mod servers;
mod shared;
mod sse;
mod worlds;

/// What the routes answered in this process know about the panel they run in.
struct Panel {
    /// Where the data is, resolved once when the panel starts (`LAYOUT` in `ui.mjs`): a change
    /// to the settings applies at the next start. `None` when it could not be resolved.
    layout: Option<Layout>,
    /// Why there is no layout, for the page and the answers that say so.
    trouble: String,
    /// Behind the desktop window (`behindWindow()`): it sets `SPAWNLOFT_SHELL` for the core.
    shell: bool,
    /// The long jobs this panel started, for the pages that watch them.
    jobs: Arc<jobs::Jobs>,
    /// The port this panel listens on: what a browser sent to it must come back to (the
    /// Microsoft sign-in's redirect address).
    port: u16,
}

impl Panel {
    /// Who the history says did what a route does (`asActor({ kind: 'panel' })`).
    fn actor() -> crate::activity::Actor {
        crate::activity::Actor::new("panel", None)
    }
}

fn behind_window() -> bool {
    std::env::var_os("SPAWNLOFT_SHELL").is_some_and(|s| s == "tauri")
}

/// What the window's `ui` was asked to do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options {
    /// Port to bind on 127.0.0.1; 0 picks a free one (what the window shells pass).
    pub port: u16,
    /// End when stdin reaches end of file: a window shell holds the pipe, so this process never
    /// outlives the window, however the window ends.
    pub exit_with_stdin: bool,
}

/// The line every panel prints once it listens; the shells read the URL from it.
pub const READY_PREFIX: &str = "SpawnLoft panel: ";

const HEAD_LIMIT: usize = 64 * 1024;
/// How long a client may take to send a request head (P0-F review L5): a connection that never
/// finishes one would otherwise hold a thread for ever. Bodies and responses have no limit, since
/// uploads are slow and the panel's event streams stay open for hours.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one write of an answer made here may wait on a client that is not reading.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// Why a panel did not start.
#[derive(Debug)]
pub enum StartError {
    /// Something else holds the port (`EADDRINUSE`).
    InUse,
    Other(String),
}

/// A panel that listens and has not answered anything yet (`serve()` of `ui.mjs`, resolved).
pub struct Listening {
    listener: TcpListener,
    auth: Arc<PanelAuth>,
    panel: Arc<Panel>,
}

impl std::fmt::Debug for Listening {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Listening").field("port", &self.port()).finish()
    }
}

impl Listening {
    /// The port bound: the one asked for, or the one the system picked for 0.
    pub fn port(&self) -> u16 {
        self.auth.port()
    }

    /// The install's key, for the caller that hands a browser its sign-in link.
    pub fn key(&self) -> &panel_auth::Key {
        self.auth.key()
    }

    /// Answers requests, a thread each, until the process ends.
    pub fn serve(self) {
        for conn in self.listener.incoming() {
            let Ok(conn) = conn else { continue };
            let auth = Arc::clone(&self.auth);
            let panel = Arc::clone(&self.panel);
            std::thread::spawn(move || {
                let _ = handle(conn, &auth, &panel);
            });
        }
    }
}

/// `panelLog(msg)`: a line in panel.log; losing one is fine.
pub(crate) fn panel_log(run_dir: &str, msg: &str) {
    let _ = crate::fsx::mkdir_all(Path::new(run_dir));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::jspath::join(&[run_dir, "panel.log"]))
    {
        let _ = f.write_all(format!("[{}] {msg}\n", crate::time::iso_now()).as_bytes());
    }
}

/// A release build ends on a panic (the window starts the core again). Node wrote what went wrong
/// in panel.log (`guardProcess`); so does this, before the process ends.
fn log_panics(run_dir: &str) {
    let run_dir = run_dir.to_string();
    let before = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        panel_log(&run_dir, &format!("panic: {info}"));
        before(info);
    }));
}

/// What `serve()` does before it listens: task shims and launchers name this install by absolute
/// path, so they are rewritten if it moved, before anything can run one; and data written by a
/// newer release is said once in the log.
fn before_listening(layout: &Layout) {
    let sched = crate::schedule::Sched::new(&layout.data_root, &layout.run_dir, Panel::actor());
    let repaired = crate::relocate::repair_after_move(
        layout,
        &sched,
        &crate::relocate::marker_file(layout),
        &crate::relocate::runtime_signature(),
        false,
    );
    match repaired {
        Ok(r) if r.moved => panel_log(
            &layout.run_dir,
            &format!(
                "installation moved: rewrote {} task shim(s) and launchers for {} server(s)",
                r.shims, r.launchers
            ),
        ),
        Ok(_) => {}
        Err(e) => panel_log(
            &layout.run_dir,
            &format!("could not check whether the installation moved: {}", e.message()),
        ),
    }
    let file = crate::data_format::data_format_file(&layout.data_root);
    let marker = crate::data_format::read(Path::new(&file));
    if let Some(newer) = crate::data_format::warning(
        &file,
        marker.as_ref(),
        Some(crate::data_format::release_version()),
    ) {
        panel_log(&layout.run_dir, &format!("warning: {newer}"));
    }
}

/// Starts a panel on 127.0.0.1 (`serve({ port })`). `layout` is where the data is, or why that
/// could not be worked out: such a panel still listens, and says so on every route but the
/// updater's.
pub fn listen(port: u16, layout: Result<Layout, String>) -> Result<Listening, StartError> {
    if let Ok(layout) = &layout {
        log_panics(&layout.run_dir);
        before_listening(layout);
    }
    // the install's key, before anything listens: without it nobody could be let in
    let key = panel_auth::load_key().map_err(StartError::Other)?;
    // the sign-in pages `spawnloft ui` left behind whose links have died since
    crate::panel_open::sweep_open_files();
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            StartError::InUse
        } else {
            StartError::Other(format!("could not listen on 127.0.0.1:{port}: {e}"))
        }
    })?;
    let bound = listener
        .local_addr()
        .map_err(|e| StartError::Other(e.to_string()))?
        .port();
    let auth = Arc::new(PanelAuth::new(key, bound, panel_auth::now_ms()));
    panel_auth::start_idle_clock();
    let (layout, trouble) = match layout {
        Ok(l) => (Some(l), String::new()),
        Err(why) => (None, why),
    };
    let panel = Arc::new(Panel {
        layout,
        trouble,
        shell: behind_window(),
        jobs: Arc::default(),
        port: bound,
    });
    Ok(Listening {
        listener,
        auth,
        panel,
    })
}

/// The window's panel: runs until killed (or stdin closes with `exit_with_stdin`). Returns an
/// exit code only when it could not start.
pub fn run(opts: Options) -> i32 {
    // `main()` of the command line makes the data folders before any command runs
    let layout = Layout::resolve(&settings::load().0)
        .and_then(|l| l.ensure_dirs().map(|()| l))
        .map_err(|crash| crash.message().to_string());
    if let Err(why) = &layout {
        eprintln!("spawnloft-core ui: {why}");
    }
    let listening = match listen(opts.port, layout) {
        Ok(l) => l,
        Err(StartError::InUse) => {
            eprintln!(
                "spawnloft-core ui: could not listen on 127.0.0.1:{}: the port is in use",
                opts.port
            );
            return 1;
        }
        Err(StartError::Other(e)) => {
            eprintln!("spawnloft-core ui: {e}");
            return 1;
        }
    };
    if opts.exit_with_stdin {
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            std::process::exit(0);
        });
    }
    println!("{READY_PREFIX}http://127.0.0.1:{}/", listening.port());
    let _ = std::io::stdout().flush();
    listening.serve();
    0
}

/// Whether this user's SpawnLoft panel is what holds `port` (`isPanelAt`). Anything can answer
/// 200 there, so the panel has to prove it holds this install's key: the request carries a fresh
/// nonce and the answer must carry its signature. The request is signed as well, so there is no
/// route that tells a stranger a panel is here.
pub fn is_panel_at(port: u16) -> bool {
    probe_panel(port).unwrap_or(false)
}

fn probe_panel(port: u16) -> Option<bool> {
    let key = panel_auth::load_key().ok()?;
    let nonce = panel_auth::probe_nonce().ok()?;
    // two seconds for the whole exchange, as `AbortSignal.timeout(2000)`
    let until = std::time::Instant::now() + Duration::from_secs(2);
    let left = || {
        let d = until.saturating_duration_since(std::time::Instant::now());
        (!d.is_zero()).then_some(d)
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut conn = TcpStream::connect_timeout(&addr, left()?).ok()?;
    conn.set_write_timeout(left()).ok()?;
    let request = format!(
        "GET /api/client/launcher HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {}\r\n{}: {nonce}\r\nConnection: close\r\n\r\n",
        panel_auth::authorization(&key, port),
        panel_auth::PROBE_HEADER,
    );
    conn.write_all(request.as_bytes()).ok()?;
    // an answer larger than this is not a launcher's list
    const LIMIT: usize = 4 * 1024 * 1024;
    let mut answer = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let (head, used) = loop {
        conn.set_read_timeout(Some(left()?)).ok()?;
        let n = conn.read(&mut chunk).ok()?;
        if n == 0 || answer.len() > HEAD_LIMIT {
            return Some(false);
        }
        answer.extend_from_slice(&chunk[..n]);
        if let Some(end) = answer.windows(4).position(|w| w == b"\r\n\r\n") {
            break (String::from_utf8_lossy(&answer[..end]).into_owned(), end + 4);
        }
    };
    let mut lines = head.split("\r\n");
    if lines.next()?.split(' ').nth(1) != Some("200") {
        return Some(false);
    }
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    if !header(panel_auth::PROOF_HEADER).is_some_and(|p| panel_auth::proof_matches(&key, &nonce, p)) {
        return Some(false);
    }
    let length: Option<usize> = header("content-length").and_then(|v| v.parse().ok());
    let mut body = answer.split_off(used);
    while length.is_none_or(|want| body.len() < want) && body.len() <= LIMIT {
        conn.set_read_timeout(Some(left()?)).ok()?;
        match conn.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => return Some(false),
        }
    }
    if let Some(want) = length {
        body.truncate(want);
    } else if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        // a panel of the Node core answers in chunks
        body = unchunked(&body)?;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&body).ok()?;
    Some(parsed.get("profiles").is_some_and(serde_json::Value::is_array))
}

/// A parsed request head.
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

/// A chunked body put together; `None` when it is cut short or is not one.
fn unchunked(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        let chunk = rest.get(..size)?;
        out.extend_from_slice(chunk);
        rest = rest.get(size + 2..)?;
    }
}

/// The updater's and the handover's routes (design 5.1), answered before the panel's own: they
/// work when the data cannot be found, which is when an update is most wanted.
pub fn is_local_route(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    route == "/api/update" || route.starts_with("/api/update/") || crate::handover::api::is_route(route)
}

/// The largest body a locally answered route reads.
const LOCAL_BODY_LIMIT: usize = 64 * 1024;

/// Splits `buf` (which holds at least the head) into the head and how many bytes it took.
///
/// Strict on purpose, so that the rule and the route read one and the same request: no line
/// break but CRLF, no control characters, no folded lines, header names that are plain tokens.
/// Anything else is not a head (the caller answers 400).
pub fn parse_head(buf: &[u8]) -> Option<(Head, usize)> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let text = std::str::from_utf8(&buf[..end - 4]).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?.to_string();
    let parts: Vec<&str> = request_line.split(' ').collect();
    if parts.len() != 3
        || parts[0].is_empty()
        || !parts[0].bytes().all(|b| b.is_ascii_uppercase())
        || parts[1].is_empty()
        || !parts[1].bytes().all(|b| b.is_ascii_graphic())
        || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0")
    {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        let (k, v) = line.split_once(':')?;
        let name_ok = !k.is_empty()
            && k.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
        // a bare CR or LF, a NUL or any other control character never belongs in a value
        if !name_ok || v.chars().any(|c| c.is_control() && c != '\t') {
            return None;
        }
        headers.push((k.to_string(), v.trim().to_string()));
    }
    Some((
        Head {
            request_line,
            headers,
        },
        end,
    ))
}

/// Tells the listener a session's request has ended, however `handle` returns.
struct InUse<'a> {
    auth: &'a PanelAuth,
    session: Option<String>,
}

impl Drop for InUse<'_> {
    fn drop(&mut self) {
        if let Some(session) = &self.session {
            self.auth.release(session, panel_auth::idle_now());
        }
    }
}

fn handle(mut conn: TcpStream, auth: &PanelAuth, panel: &Panel) -> std::io::Result<()> {
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
    // One reading of where the body ends: a request whose length can be read two ways is refused.
    let Ok(framing) = http::framing(&head.headers) else {
        return respond(&mut conn, 400, "text/plain", b"bad request\n");
    };
    // Node's parser lets through a path, `*`, and a whole address (`http://host/path`), and
    // refuses any other target before anything sees it.
    if !target_is_http(head.path()) {
        return respond(&mut conn, 400, "text/plain", b"bad request\n");
    }
    // `new URL(req.url, 'http://localhost')`: the path a route sees, dot segments resolved
    let target = http::parse_target(head.path());
    let verdict = auth.decide(
        head.method(),
        head.path(),
        &head.headers,
        panel_auth::now_ms(),
        panel_auth::idle_now(),
    );
    // a caller with the key asks whether this is its own panel (see panel_auth)
    let proof = match &verdict {
        Verdict::Allow { .. } => auth.proof_for(&head.headers),
        _ => None,
    };
    let _in_use = match verdict {
        Verdict::Forbidden => {
            return respond(
                &mut conn,
                403,
                "application/json",
                br#"{"error":"this panel only answers requests addressed to localhost"}"#,
            );
        }
        Verdict::Login { session, to, nonce } => {
            // the page that carried this link (`spawnloft ui`) has done its job
            crate::panel_open::remove_open_file(&nonce);
            let cookie = panel_auth::session_cookie(auth.port(), &session);
            return respond_with(
                &mut conn,
                200,
                "text/html; charset=utf-8",
                &[
                    ("Set-Cookie", &cookie),
                    PAGE_HEADERS[0],
                    PAGE_HEADERS[1],
                    PAGE_HEADERS[2],
                ],
                panel_auth::login_page(to).as_bytes(),
            );
        }
        v @ (Verdict::LoginRefused | Verdict::Unauthorized { api: false }) => {
            // under the desktop window, the page asks the window to sign it in again
            let shell = behind_window();
            let refused = matches!(v, Verdict::LoginRefused);
            return respond_with(
                &mut conn,
                401,
                "text/html; charset=utf-8",
                &[
                    WWW_AUTHENTICATE,
                    PAGE_HEADERS[0],
                    PAGE_HEADERS[1],
                    PAGE_HEADERS[2],
                ],
                panel_auth::unauthorized_page(shell, head.path(), refused).as_bytes(),
            );
        }
        Verdict::Unauthorized { api: true } => {
            let body = serde_json::json!({ "error": panel_auth::UNAUTHORIZED_ERROR, "code": "auth" });
            return respond_with(
                &mut conn,
                401,
                "application/json",
                &[WWW_AUTHENTICATE],
                body.to_string().as_bytes(),
            );
        }
        Verdict::Open => InUse { auth, session: None },
        Verdict::Allow { session } => InUse { auth, session },
    };
    // the updater's routes are found by the path a route would see (`/api/update/../settings` is
    // a setting's route), and given it with the query as it came
    let local = target
        .as_ref()
        .filter(|(path, _)| is_local_route(path))
        .map(|(path, _)| match head.path().split_once('?') {
            Some((_, query)) => format!("{path}?{query}"),
            None => path.clone(),
        });
    if let Some(local) = local {
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
        let route = local.split('?').next().unwrap_or("");
        let (status, json) = if crate::handover::api::is_route(route) {
            crate::handover::api::handle(head.method(), &local)
        } else {
            crate::update::api::handle(head.method(), &local, &body)
        };
        let proved: Vec<(&str, &str)> = proof
            .iter()
            .map(|p| (panel_auth::PROOF_HEADER, p.as_str()))
            .collect();
        return respond_with(
            &mut conn,
            status,
            "application/json",
            &proved,
            json.to_string().as_bytes(),
        );
    }
    conn.set_read_timeout(None)?;
    let expects_continue = head
        .header("expect")
        .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"));
    let (path, query, invalid) = match target {
        Some((path, query)) => (path, query, false),
        // `new URL(req.url, 'http://localhost')` threw: answered as any throw of a route is
        None => (String::new(), Vec::new(), true),
    };
    let mut req = http::Request {
        method: head.method().to_string(),
        seg: path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        path,
        query,
        body: http::Body::new(&mut conn, buf[used..].to_vec(), framing, expects_continue),
    };
    let reply = if invalid {
        http::failure_reply(&crate::failure::Failure::Internal {
            head: "TypeError".into(),
            message: "Invalid URL".into(),
            code: Some("ERR_INVALID_URL".into()),
        })
    } else {
        match routes::route(panel, &mut req) {
            Some(reply) => reply,
            None => {
                let conn = req.body.into_conn();
                return missing(conn, &head, &panel.trouble);
            }
        }
    };
    let head_only = req.method == "HEAD";
    let conn = req.body.into_conn();
    // a client that stops reading does not hold the thread: each write has this long
    conn.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let sent = http::send(conn, reply, proof.as_deref(), head_only);
    linger(conn);
    sent
}

/// Whether Node's HTTP parser takes `target` as a request target: a path, one that starts with
/// `*`, or an address with a scheme (letters, then `://`). `x:api/settings` and CONNECT's `host:port` are not.
fn target_is_http(target: &str) -> bool {
    if target.starts_with('/') || target.starts_with('*') {
        return true;
    }
    target
        .split_once("://")
        .is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|b| b.is_ascii_alphabetic()))
}

/// Ends a connection whose request may not have been read to its end (a refused upload): the
/// answer is on its way, and closing with bytes unread would have the system reset the
/// connection and the client lose the answer. So: no more from this side, then what is still
/// coming is read and dropped, for a short while and up to a size.
fn linger(conn: &mut TcpStream) {
    let _ = conn.shutdown(Shutdown::Write);
    // two seconds in all, not per read
    let until = std::time::Instant::now() + Duration::from_secs(2);
    let mut sink = [0u8; 16 * 1024];
    let mut dropped = 0usize;
    while dropped < 4 * 1024 * 1024 {
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || conn.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match conn.read(&mut sink) {
            Ok(n) if n > 0 => dropped += n,
            _ => break,
        }
    }
}

fn missing(conn: &mut TcpStream, head: &Head, why: &str) -> std::io::Result<()> {
    if head.path().starts_with("/api/") {
        let body = serde_json::json!({
            "error": format!("the panel could not work out where its data is: {why}"),
        });
        return respond(conn, 503, "application/json", body.to_string().as_bytes());
    }
    let page = panel_auth::styled_page(
        "SpawnLoft could not start",
        &format!(
            "<p>SpawnLoft could not work out where its data is: {}</p>\
             <p class=\"small\">Your servers and worlds are not affected.</p>",
            html_escape(why)
        ),
        "",
    );
    respond_with(
        conn,
        503,
        "text/html; charset=utf-8",
        &PAGE_HEADERS,
        page.as_bytes(),
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const WWW_AUTHENTICATE: (&str, &str) = ("WWW-Authenticate", panel_auth::AUTH_SCHEME);
/// What the two pages this listener writes itself are sent with.
const PAGE_HEADERS: [(&str, &str); 3] = [
    ("Content-Security-Policy", panel_auth::PAGE_CSP),
    ("Referrer-Policy", "no-referrer"),
    ("X-Content-Type-Options", "nosniff"),
];

fn respond(conn: &mut TcpStream, status: u16, kind: &str, body: &[u8]) -> std::io::Result<()> {
    respond_with(conn, status, kind, &[], body)
}

fn respond_with(
    conn: &mut TcpStream,
    status: u16,
    kind: &str,
    extra: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
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
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\n",
        body.len()
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    conn.write_all(head.as_bytes())?;
    conn.write_all(body)?;
    conn.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunked_answer_is_put_together() {
        assert_eq!(
            unchunked(b"3\r\nabc\r\n2;x=y\r\nde\r\n0\r\n\r\n"),
            Some(b"abcde".to_vec())
        );
        assert_eq!(unchunked(b"3\r\nab"), None);
        assert_eq!(unchunked(b"zz\r\n"), None);
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
    fn a_head_that_could_be_read_two_ways_is_not_a_head() {
        let ok = "GET /a?b=c HTTP/1.1\r\nHost: x\r\nX-Tab: a\tb\r\n\r\n";
        assert!(parse_head(ok.as_bytes()).is_some());
        for bad in [
            // a bare line feed could end the head early for a parser that takes it as a line end
            "GET / HTTP/1.1\r\nHost: x\r\nX: a\n\nGET /api/x HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: x\nX: y\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: x\rX: y\r\n\r\n",
            // a folded line, a name with a space, an empty name
            "GET / HTTP/1.1\r\nHost: x\r\n Authorization: SpawnLoft y\r\n\r\n",
            "GET / HTTP/1.1\r\nHost : x\r\n\r\n",
            "GET / HTTP/1.1\r\n: x\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: x\0y\r\n\r\n",
            // the request line
            "GET  / HTTP/1.1\r\nHost: x\r\n\r\n",
            "get / HTTP/1.1\r\nHost: x\r\n\r\n",
            "GET /a\tb HTTP/1.1\r\nHost: x\r\n\r\n",
            "GET / HTTP/2\r\nHost: x\r\n\r\n",
        ] {
            assert!(parse_head(bad.as_bytes()).is_none(), "{bad:?}");
        }
    }

    const TEST_KEY: [u8; 32] = [9; 32];

    fn api_header(port: u16) -> String {
        format!(
            "Authorization: {}\r\n",
            panel_auth::authorization(&panel_auth::Key::from_bytes(TEST_KEY), port)
        )
    }

    /// A listener that answers `requests` connections through `handle`, and its address.
    fn front(requests: usize) -> SocketAddr {
        // a panel that could not work out where its data is
        let panel = Panel {
            layout: None,
            trouble: "no data".into(),
            shell: false,
            jobs: Arc::default(),
            port: 0,
        };
        front_of(panel, requests)
    }

    fn front_of(panel: Panel, requests: usize) -> SocketAddr {
        let front = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = front.local_addr().unwrap();
        let auth = PanelAuth::new(panel_auth::Key::from_bytes(TEST_KEY), addr.port(), 0);
        std::thread::spawn(move || {
            for _ in 0..requests {
                let (c, _) = front.accept().unwrap();
                // a client that hangs up early is not this listener's failure
                let _ = handle(c, &auth, &panel);
            }
        });
        addr
    }

    /// A panel whose data would be in a folder nothing is in; `shell` as behind the window.
    fn panel_in(name: &str, shell: bool) -> Panel {
        let root = std::env::temp_dir()
            .join(format!("sl-panel-{name}-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let at = |leaf: &str| crate::jspath::join(&[&root, leaf]);
        Panel {
            layout: Some(Layout {
                instances_dir: at("instances"),
                separate_instances: false,
                registry_file: at("instances.json"),
                templates_dir: at("templates"),
                jars_dir: at("jars"),
                backups_dir: at("backups"),
                run_dir: at("run"),
                engines_dir: at("engines"),
                services_dir: at("services"),
                settings_file: at("settings.json"),
                data_root: root,
            }),
            trouble: String::new(),
            shell,
            jobs: Arc::default(),
            port: 0,
        }
    }

    fn body_of(response: &str) -> &str {
        response.split_once("\r\n\r\n").map_or("", |(_, b)| b)
    }

    #[test]
    fn a_route_is_answered_only_to_a_caller_with_a_credential() {
        let addr = front_of(panel_in("moved", false), 4);
        let p = addr.port();
        let out = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n",
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 200 OK\r\n"), "{out}");
        assert!(out.contains("Content-Type: application/json\r\n"), "{out}");
        assert!(out.contains("Cache-Control: no-store\r\n"), "{out}");
        assert!(body_of(&out).starts_with("[{\"id\":\"paper\""), "{out}");
        // decided before the route is looked at
        let out = exchange(
            addr,
            &format!("GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"),
        );
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        assert!(!out.contains("paper"), "{out}");
        let out = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: evil.example\r\n{}\r\n",
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
        let out = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nOrigin: http://evil.example\r\n{}\r\n",
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    }

    #[test]
    fn a_probe_is_answered_only_for_an_allowed_request() {
        let key = panel_auth::Key::from_bytes(TEST_KEY);
        let nonce = "abcdefghijklmnopqrstuv";
        let addr = front_of(panel_in("probe", false), 4);
        let p = addr.port();
        let proof_in = |out: &str| {
            out.lines()
                .find_map(|l| l.strip_prefix("x-spawnloft-proof: "))
                .map(str::to_string)
        };
        // a route of the panel and one of the updater's
        for path in ["/api/software", "/api/update"] {
            let out = exchange(
                addr,
                &format!(
                    "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nX-SpawnLoft-Probe: {nonce}\r\n{}\r\n",
                    api_header(p)
                ),
            );
            assert!(out.starts_with("HTTP/1.1 200"), "{out}");
            let proof = proof_in(&out).unwrap_or_else(|| panic!("no proof: {out}"));
            assert!(panel_auth::proof_matches(&key, nonce, &proof), "{out}");
        }
        // no credential: nothing signed with the key goes out
        let out = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nX-SpawnLoft-Probe: {nonce}\r\n\r\n"
            ),
        );
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        assert_eq!(proof_in(&out), None, "{out}");
        // two probes are not one question
        let out = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nX-SpawnLoft-Probe: {nonce}\r\nx-spawnloft-probe: {nonce}\r\n{}\r\n",
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert_eq!(proof_in(&out), None, "{out}");
    }

    #[test]
    fn a_request_whose_length_reads_two_ways_is_refused_before_anything() {
        let addr = front_of(panel_in("framing", false), 5);
        let p = addr.port();
        for lines in [
            "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n",
            "Content-Length: 2\r\nContent-Length: 3\r\n",
            "Content-Length: 2\r\ncontent-length: 2\r\n",
            "Content-Length: two\r\n",
            "Transfer-Encoding: gzip\r\n",
        ] {
            let out = exchange(
                addr,
                &format!(
                    "POST /api/appearance HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{lines}{}\r\n{{}}",
                    api_header(p)
                ),
            );
            assert!(out.starts_with("HTTP/1.1 400"), "{lines}: {out}");
        }
    }

    #[test]
    fn a_target_nodes_parser_refuses_is_never_routed() {
        // WHATWG reads `x:api/software` against a base as the path `api/software`; Node's parser
        // never let such a request line reach a route
        let addr = front_of(panel_in("target", false), 6);
        let p = addr.port();
        let ask = |line: &str| {
            exchange(
                addr,
                &format!("{line} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n", api_header(p)),
            )
        };
        for line in ["GET x:api/software", "CONNECT 127.0.0.1:443"] {
            let out = ask(line);
            assert!(out.starts_with("HTTP/1.1 400"), "{line}: {out}");
        }
        // a whole address is a target Node takes, and routes by its path
        let out = ask(&format!("GET http://127.0.0.1:{p}/api/software"));
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        let out = ask("OPTIONS *");
        assert!(out.starts_with("HTTP/1.1 404"), "{out}");
        // dot segments are resolved before the updater's routes are looked for
        let out = ask("GET /api/update/../software");
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(body_of(&out).starts_with("[{\"id\":\"paper\""), "{out}");
        // a target `new URL` throws on is a route's throw
        let out = ask("GET http://[/api/software");
        assert!(out.starts_with("HTTP/1.1 500"), "{out}");
        assert_eq!(
            body_of(&out),
            r#"{"error":"Invalid URL","code":"ERR_INVALID_URL"}"#,
            "{out}"
        );
    }

    #[test]
    fn a_body_larger_than_a_route_reads_is_refused_without_being_read() {
        let addr = front_of(panel_in("large", false), 1);
        let p = addr.port();
        let out = exchange(
            addr,
            &format!(
                "POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nContent-Length: {}\r\n{}\r\n",
                http::BODY_LIMIT + 1,
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 413"), "{out}");
        assert_eq!(body_of(&out), r#"{"error":"request body too large"}"#, "{out}");
    }

    #[test]
    fn head_gets_the_head_alone_and_the_setup_page_is_only_behind_the_window() {
        let addr = front_of(panel_in("pages", false), 3);
        let p = addr.port();
        let ask = |addr: SocketAddr, line: &str| {
            let p = addr.port();
            exchange(
                addr,
                &format!("{line} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n", api_header(p)),
            )
        };
        let got = ask(addr, "GET /launcher");
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        assert!(got.contains("X-Frame-Options: SAMEORIGIN\r\n"), "{got}");
        assert!(
            got.contains("Content-Security-Policy: frame-ancestors 'self'\r\n"),
            "{got}"
        );
        assert!(body_of(&got).contains("<html"), "{got}");
        let head = ask(addr, "HEAD /launcher");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body_of(&head), "", "{head}");
        let _ = p;
        assert!(ask(addr, "GET /setup").starts_with("HTTP/1.1 404"));

        let addr = front_of(panel_in("pages-window", true), 2);
        let got = ask(addr, "GET /setup");
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        assert!(got.contains("X-Frame-Options: DENY\r\n"), "{got}");
        // the window alone may move the data, and only with a credential like any other call
        let p = addr.port();
        let out = exchange(
            addr,
            &format!("POST /api/setup HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nContent-Length: 2\r\n\r\n{{}}"),
        );
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
    }

    #[test]
    fn the_pages_files_are_served_by_exact_name_behind_the_sign_in() {
        let addr = front_of(panel_in("assets", false), 15);
        let p = addr.port();
        let ask = |line: &str| {
            exchange(
                addr,
                &format!("{line} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n", api_header(p)),
            )
        };
        let css = ask("GET /assets/css/tokens.css");
        assert!(css.starts_with("HTTP/1.1 200"), "{css}");
        assert!(css.contains("Content-Type: text/css; charset=utf-8\r\n"), "{css}");
        assert!(css.contains("X-Content-Type-Options: nosniff\r\n"), "{css}");
        assert!(css.contains("Cache-Control: no-store\r\n"), "{css}");
        assert_eq!(css.matches("Cache-Control").count(), 1, "{css}");
        assert!(
            css.contains("Cross-Origin-Resource-Policy: same-origin\r\n"),
            "{css}"
        );
        assert!(body_of(&css).contains(":root {"), "{css}");
        let js = ask("GET /assets/js/shared/session.js");
        assert!(js.starts_with("HTTP/1.1 200"), "{js}");
        assert!(
            js.contains("Content-Type: text/javascript; charset=utf-8\r\n"),
            "{js}"
        );
        let head = ask("HEAD /assets/js/shared/session.js");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body_of(&head), "", "{head}");
        // a name that is not compiled in, however it is spelled, is not found
        for line in [
            "GET /assets/",
            "GET /assets/css",
            "GET /assets/ui.html",
            "GET /assets/css/nope.css",
            "GET /assets/css%2Ftokens.css",
            "GET /assets/css/tokens.css%00",
            "GET /assets//css/tokens.css",
            "GET /assets/..%2F..%2FCargo.toml",
        ] {
            let out = ask(line);
            assert!(out.starts_with("HTTP/1.1 404"), "{line}: {out}");
        }
        // dot segments resolve first, as for every route: this one is the same file
        assert!(ask("GET /assets/js/../css/tokens.css").starts_with("HTTP/1.1 200"));
        // and out of /assets/ is not /assets/
        assert!(ask("GET /assets/../Cargo.toml").starts_with("HTTP/1.1 404"));
        assert!(ask("POST /assets/css/tokens.css").starts_with("HTTP/1.1 405"));
        // no exception to the sign-in for a file
        let bare = exchange(
            addr,
            &format!("GET /assets/css/tokens.css HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"),
        );
        assert!(bare.starts_with("HTTP/1.1 401"), "{bare}");
        assert!(!bare.contains(":root {"), "{bare}");
    }

    fn exchange(addr: SocketAddr, request: &str) -> String {
        let mut c = TcpStream::connect(addr).unwrap();
        c.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn nobody_gets_through_without_a_credential() {
        let addr = front_of(panel_in("nobody", false), 5);
        let p = addr.port();
        let api = exchange(
            addr,
            &format!("GET /api/servers HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"),
        );
        assert!(api.starts_with("HTTP/1.1 401 Unauthorized\r\n"), "{api}");
        assert!(api.contains("WWW-Authenticate: SpawnLoft\r\n"), "{api}");
        assert!(api.contains(r#""code":"auth""#), "{api}");
        // the routes this process answers itself are behind the same check
        let update = exchange(
            addr,
            &format!(
                "POST /api/update/check HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nContent-Length: 2\r\n\r\n{{}}"
            ),
        );
        assert!(update.starts_with("HTTP/1.1 401"), "{update}");
        let page = exchange(addr, &format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"));
        assert!(page.starts_with("HTTP/1.1 401"), "{page}");
        assert!(page.contains("Content-Type: text/html"), "{page}");
        assert!(
            page.contains("Content-Security-Policy: default-src 'none'"),
            "{page}"
        );
        assert!(page.contains("run <code>spawnloft ui</code>"), "{page}");
        // a token for another port, and one signed with another key
        let elsewhere = if p == u16::MAX { 1 } else { p + 1 };
        let other = exchange(
            addr,
            &format!(
                "GET /api/servers HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n",
                api_header(elsewhere)
            ),
        );
        assert!(other.starts_with("HTTP/1.1 401"), "{other}");
        let forged = panel_auth::authorization(&panel_auth::Key::from_bytes([1; 32]), p);
        let wrong = exchange(
            addr,
            &format!("GET /api/servers HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nAuthorization: {forged}\r\n\r\n"),
        );
        assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");
    }

    #[test]
    fn a_login_link_gives_a_session() {
        let addr = front_of(panel_in("login", false), 4);
        let p = addr.port();
        let key = panel_auth::Key::from_bytes(TEST_KEY);
        let link = panel_auth::login_path(&key, p, Some("/setup")).unwrap();
        let signed = exchange(
            addr,
            &format!("GET {link} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"),
        );
        assert!(signed.starts_with("HTTP/1.1 200 OK\r\n"), "{signed}");
        assert!(signed.contains("Referrer-Policy: no-referrer\r\n"), "{signed}");
        assert!(signed.contains("Cache-Control: no-store\r\n"), "{signed}");
        assert!(
            signed.contains(r#"<meta http-equiv="refresh" content="0; url=/setup">"#),
            "{signed}"
        );
        let cookie = signed
            .lines()
            .find_map(|l| l.strip_prefix("Set-Cookie: "))
            .expect("a session cookie");
        assert!(cookie.starts_with(&format!("spawnloft_{p}=")), "{cookie}");
        assert!(
            cookie.ends_with("; HttpOnly; SameSite=Strict; Path=/"),
            "{cookie}"
        );
        let pair = cookie.split(';').next().unwrap();

        // the link a second time
        let again = exchange(
            addr,
            &format!("GET {link} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n"),
        );
        assert!(
            again.starts_with("HTTP/1.1 401") && !again.contains("Set-Cookie"),
            "{again}"
        );

        // with the cookie a route answers, and so it does for a program's token
        let seen = exchange(
            addr,
            &format!("GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nCookie: {pair}\r\n\r\n"),
        );
        assert!(seen.starts_with("HTTP/1.1 200 OK"), "{seen}");
        assert!(!seen.contains(pair), "{seen}");
        let seen = exchange(
            addr,
            &format!(
                "GET /api/software HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}\r\n",
                api_header(p)
            ),
        );
        assert!(seen.starts_with("HTTP/1.1 200 OK"), "{seen}");
    }

    #[test]
    fn the_sign_in_callback_is_the_one_route_open_without_a_credential() {
        let addr = front_of(panel_in("callback", false), 2);
        let p = addr.port();
        let seen = exchange(
            addr,
            &format!(
                "GET /api/client/accounts/login/callback?code=x&state=y HTTP/1.1\r\nHost: localhost:{p}\r\n\
                 Sec-Fetch-Site: cross-site\r\n\r\n"
            ),
        );
        // it reaches its route, which has no sign-in under way to finish
        assert!(
            !seen.starts_with("HTTP/1.1 401") && !seen.starts_with("HTTP/1.1 403"),
            "{seen}"
        );
        assert!(seen.contains("Content-Type: text/html"), "{seen}");
        // nothing else is open: the same request one path over
        let other = exchange(
            addr,
            &format!("GET /api/client/accounts/login/callbacks HTTP/1.1\r\nHost: localhost:{p}\r\n\r\n"),
        );
        assert!(other.starts_with("HTTP/1.1 401"), "{other}");
    }

    #[test]
    fn refuses_a_foreign_origin_before_a_route() {
        let addr = front_of(panel_in("origin", false), 2);
        let p = addr.port();
        // a good token does not help a request from another origin, or one from another site
        for line in ["Origin: http://evil.example", "Sec-Fetch-Site: same-site"] {
            let out = exchange(
                addr,
                &format!(
                    "POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{line}\r\n{}\r\n",
                    api_header(p)
                ),
            );
            assert!(out.starts_with("HTTP/1.1 403"), "{line}: {out}");
        }
    }

    #[test]
    fn without_its_data_the_page_says_so_and_the_api_is_503() {
        for (path, kind) in [("/", "text/html"), ("/api/servers", "application/json")] {
            let addr = front(1);
            let p = addr.port();
            let out = exchange(
                addr,
                &format!(
                    "GET {path} HTTP/1.1\r\nHost: localhost:{p}\r\n{}\r\n",
                    api_header(p)
                ),
            );
            assert!(out.starts_with("HTTP/1.1 503"), "{out}");
            assert!(out.contains(kind));
            assert!(out.contains("no data"));
        }
    }

    #[test]
    fn updater_routes_are_answered_even_without_the_data() {
        // an unknown updater route is a 404, not the 503 of a panel with no data
        let addr = front(1);
        let p = addr.port();
        let out = exchange(
            addr,
            &format!(
                "POST /api/update/nothing HTTP/1.1\r\nHost: localhost:{p}\r\nOrigin: http://localhost:{p}\r\n\
                 {}Content-Length: 2\r\n\r\n{{}}",
                api_header(p)
            ),
        );
        assert!(out.starts_with("HTTP/1.1 404"), "{out}");
        assert!(out.contains("no updater route"), "{out}");
        assert!(is_local_route("/api/update?x=1") && is_local_route("/api/update/log?n=3"));
        assert!(!is_local_route("/api/updates") && !is_local_route("/api/servers"));
    }
}
