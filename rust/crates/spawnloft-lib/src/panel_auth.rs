//! Who may use the panel's HTTP API (rust/PANEL-AUTH-DESIGN.md).
//!
//! The same rule is written a second time in `src/panel-auth.mjs` for the Node panel. The shared
//! fixture `test/fixtures/contracts/panel-auth.json` (run by the tests below and by
//! `test/panel-auth.test.mjs`) holds the two to one behaviour, so change both together.
//!
//! One key per install, `<config>/panel.key`, signs short tokens. The key itself is never put in
//! a request, a URL, a cookie, an environment variable or a log: port 8770 is well known, and
//! whatever a client sends there can be collected by another account that bound the port first.
//!
//! ```text
//! v1.<purpose>.<port>.<issued ms>.<nonce>.<mac>     mac = HMAC-SHA256(key, everything before it)
//! ```
//!
//! - `login`: one use, 5 minutes; `GET /auth?t=<token>` swaps it for a session cookie.
//! - `api`: 60 seconds, no nonce; sent as `Authorization: SpawnLoft <token>` by callers that are
//!   not a page (the shell, this proxy towards the Node panel, the CLI, tests).
//!
//! A token names the port of the listener it is for, and a listener refuses one issued before it
//! started, so nothing made for another panel, or for an earlier panel on the same port, works.
//!
//! Out of scope on purpose: a program running as the same user. It can read the key file, as it
//! can read the RCON passwords and the Microsoft tokens.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const LOGIN_TTL_MS: u64 = 5 * 60 * 1000;
pub const API_TTL_MS: u64 = 60 * 1000;
/// Two processes on one machine read one clock, but not always the same reading of it (V8 on
/// Windows keeps its own, a few milliseconds behind), so a token may be this far "in the future".
pub const FUTURE_LEEWAY_MS: u64 = 2000;
/// A session with no request and no open connection for this long is forgotten.
pub const SESSION_IDLE_MS: u64 = 15 * 60 * 1000;
pub const AUTH_SCHEME: &str = "SpawnLoft";
pub const OPEN_ROUTES: [&str; 2] = ["/auth", "/api/client/accounts/login/callback"];
const LOGIN_TARGETS: [&str; 2] = ["/launcher", "/setup"];
const TOKEN_LIMIT: usize = 256;
pub const UNAUTHORIZED_ERROR: &str =
    "this panel needs a sign-in: open SpawnLoft from the app, or run `spawnloft ui` to get a new link";

/// The install's key. Never printed: `Debug` shows nothing of it.
#[derive(Clone, PartialEq, Eq)]
pub struct Key([u8; 32]);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(..)")
    }
}

impl Key {
    pub fn from_bytes(bytes: [u8; 32]) -> Key {
        Key(bytes)
    }

    /// One line of unpadded base64url holding exactly 32 bytes; `None` for anything else.
    pub fn parse(text: &str) -> Option<Key> {
        let bytes = b64url_decode(text.trim())?;
        Some(Key(bytes.try_into().ok()?))
    }
}

// ---- base64url, unpadded ---------------------------------------------------------------------
// Only the text form of keys, MACs and ids; the comparing of secrets is the hmac crate's.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn is_b64url(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// Strict: the alphabet only, no padding, and no bits set that the length cannot hold (so one
/// byte string has exactly one spelling).
pub fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for chunk in text.as_bytes().chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = B64.iter().position(|&b| b == c)? as u32;
            n |= v << (18 - 6 * i);
        }
        let bytes = chunk.len() - 1;
        if n & ((1u32 << (24 - 8 * bytes)) - 1) != 0 {
            return None;
        }
        out.extend_from_slice(&n.to_be_bytes()[1..=bytes]);
    }
    Some(out)
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| format!("the system gave no random bytes: {e}"))?;
    Ok(buf)
}

// ---- the key file ----------------------------------------------------------------------------

/// `<config>/panel.key`: in the config folder, not the data root, which can sit on a shared
/// drive and is what backups copy.
pub fn key_file() -> PathBuf {
    crate::paths::config_dir().join("panel.key")
}

/// The install's key, made on first need.
pub fn load_key() -> Result<Key, String> {
    load_key_at(&key_file())
}

/// Always read back from the file, never taken from what this process just wrote, so every
/// starter (this core, the Node panel, the shell) ends with the same key.
pub fn load_key_at(file: &Path) -> Result<Key, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let found = match std::fs::read_to_string(file) {
            Ok(text) => Key::parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                create_key(file)
                    .map_err(|e| format!("could not create the panel key {}: {e}", file.display()))?;
                std::fs::read_to_string(file)
                    .ok()
                    .and_then(|text| Key::parse(&text))
            }
            Err(e) => return Err(format!("could not read the panel key {}: {e}", file.display())),
        };
        if let Some(key) = found {
            return Ok(key);
        }
        // another starter on a file system without hard links may still be writing its line
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "the panel key {} is damaged; delete the file and start the panel again",
                file.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Makes the key file if nobody has yet. The key is written to a private temporary file and
/// hard-linked to its name, which fails when the name exists: of two first starters one wins and
/// both then read the winner's key. A file system without hard links gets an exclusive create
/// instead; a reader that meets the file before its line is in waits for it ([`load_key_at`]).
fn create_key(file: &Path) -> std::io::Result<()> {
    let dir = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let text = format!(
        "{}\n",
        b64url_encode(&random::<32>().map_err(std::io::Error::other)?)
    );
    let tag = random::<6>().map_err(std::io::Error::other)?;
    let tmp = dir.join(format!(
        "panel.key.{}.{}.tmp",
        std::process::id(),
        tag.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let made = (|| {
        write_new(&tmp, &text)?;
        match std::fs::hard_link(&tmp, file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => match write_new(file, &text) {
                Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
                _ => Ok(()),
            },
        }
    })();
    let _ = std::fs::remove_file(&tmp);
    made
}

/// Created owner-only (on Windows: with its own one-user ACL) before the secret goes in, and
/// never over a file that is already there.
fn write_new(file: &Path, text: &str) -> std::io::Result<()> {
    let mut f = crate::platform::create_private_new(file)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()
}

// ---- tokens ----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Login,
    Api,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Login => "login",
            Purpose::Api => "api",
        }
    }

    fn ttl(self) -> u64 {
        match self {
            Purpose::Login => LOGIN_TTL_MS,
            Purpose::Api => API_TTL_MS,
        }
    }
}

/// Milliseconds since the epoch, as `Date.now()` counts them.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn signer(key: &Key, body: &str) -> Hmac<Sha256> {
    // HMAC takes a key of any length, so this cannot fail
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key.0).expect("HMAC accepts any key length");
    mac.update(body.as_bytes());
    mac
}

/// The token for these exact parts. `nonce` is 22 base64url characters for `login`, empty for `api`.
pub fn make_token(key: &Key, purpose: Purpose, port: u16, issued: u64, nonce: &str) -> String {
    let body = format!("v1.{}.{port}.{issued}.{nonce}", purpose.as_str());
    let mac = b64url_encode(&signer(key, &body).finalize().into_bytes());
    format!("{body}.{mac}")
}

/// A fresh `api` token for the panel on `port`.
pub fn api_token(key: &Key, port: u16) -> String {
    make_token(key, Purpose::Api, port, now_ms(), "")
}

/// A fresh one-use `login` token for the panel on `port`.
pub fn login_token(key: &Key, port: u16) -> Result<String, String> {
    let nonce = b64url_encode(&random::<16>()?);
    Ok(make_token(key, Purpose::Login, port, now_ms(), &nonce))
}

/// The `Authorization` value a caller that can read the key sends to the panel on `port`.
pub fn authorization(key: &Key, port: u16) -> String {
    format!("{AUTH_SCHEME} {}", api_token(key, port))
}

/// The path and query that sign a window in at the panel on `port`; `to` is `/launcher` or
/// `/setup`, anything else lands on the panel itself.
pub fn login_path(key: &Key, port: u16, to: Option<&str>) -> Result<String, String> {
    let token = login_token(key, port)?;
    Ok(match to.filter(|t| LOGIN_TARGETS.contains(t)) {
        Some(to) => format!("/auth?t={token}&to={to}"),
        None => format!("/auth?t={token}"),
    })
}

/// A decimal number as these tokens write one: digits only, no leading zero, at most `digits`.
fn canonical(text: &str, digits: usize) -> Option<u64> {
    let b = text.as_bytes();
    if b.is_empty() || b.len() > digits || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    text.parse().ok()
}

/// What a good token carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub issued: u64,
    pub nonce: String,
}

/// `Some` when `token` is a well-formed, correctly signed `purpose` token for `port`, issued no
/// earlier than `started` (when the listener began) and not expired at `now`.
pub fn check_token(
    key: &Key,
    token: &str,
    purpose: Purpose,
    port: u16,
    now: u64,
    started: u64,
) -> Option<Checked> {
    if token.len() > TOKEN_LIMIT {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 6 || parts[0] != "v1" || parts[1] != purpose.as_str() {
        return None;
    }
    if canonical(parts[2], 5)? != u64::from(port) {
        return None;
    }
    let issued = canonical(parts[3], 15)?;
    let nonce = parts[4];
    let nonce_ok = match purpose {
        Purpose::Login => nonce.len() == 22 && is_b64url(nonce),
        Purpose::Api => nonce.is_empty(),
    };
    if !nonce_ok || parts[5].len() != 43 {
        return None;
    }
    let given = b64url_decode(parts[5])?;
    // everything before the last dot; all of it is ASCII once the checks above have passed
    let body = token.get(..token.len() - 44)?;
    // constant time: the hmac crate's comparison
    signer(key, body).verify_slice(&given).ok()?;
    if issued < started || issued > now.saturating_add(FUTURE_LEEWAY_MS) {
        return None;
    }
    if now.saturating_sub(issued) > purpose.ttl() {
        return None;
    }
    Some(Checked {
        issued,
        nonce: nonce.to_string(),
    })
}

pub fn cookie_name(port: u16) -> String {
    format!("spawnloft_{port}")
}

/// Sessions are kept under a hash of their id, so looking one up compares nothing secret.
fn session_key(id: &str) -> String {
    use sha2::Digest;
    Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---- the request rule ------------------------------------------------------------------------

/// What [`PanelAuth::decide`] says about a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Not addressed to this panel from this panel (403).
    Forbidden,
    /// A route that carries its own proof; route it.
    Open,
    /// `/auth` with a good token: set the cookie to `session`, go to `to`.
    Login { session: String, to: &'static str },
    /// `/auth` with a bad, used or expired token (the 401 page).
    LoginRefused,
    /// Route it. `session` goes to [`PanelAuth::release`] when the request ends.
    Allow { session: Option<String> },
    /// 401: JSON for `/api/...`, the page otherwise.
    Unauthorized { api: bool },
}

#[derive(Debug)]
struct Session {
    /// Idle-clock time of the last request's start or end.
    seen: u64,
    /// Requests on this session whose connection is still open.
    active: u32,
}

#[derive(Debug)]
struct State {
    started: u64,
    sessions: HashMap<String, Session>,
    /// Login nonces already spent, with when their token was issued.
    used: HashMap<String, u64>,
}

/// The request rule of one listener: its key, its port, when it started, its sessions and the
/// login tokens already used.
#[derive(Debug)]
pub struct PanelAuth {
    key: Key,
    port: u16,
    state: Mutex<State>,
}

impl PanelAuth {
    pub fn new(key: Key, port: u16, started: u64) -> PanelAuth {
        PanelAuth {
            key,
            port,
            state: Mutex::new(State {
                started,
                sessions: HashMap::new(),
                used: HashMap::new(),
            }),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `Authorization` for the panel this listener forwards to, on `port`.
    pub fn authorization_for(&self, port: u16) -> String {
        authorization(&self.key, port)
    }

    /// The whole rule. `headers` are the request's, as they came. `now` is the wall clock
    /// (tokens); `idle_now` is a clock that only runs while this process does (session idle
    /// time), so a machine that slept for an hour has not idled a session out.
    pub fn decide(
        &self,
        method: &str,
        target: &str,
        headers: &[(String, String)],
        now: u64,
        idle_now: u64,
    ) -> Verdict {
        let Ok(mut state) = self.state.lock() else {
            return Verdict::Forbidden;
        };
        // a clock set back since the start must not lock everyone out until it catches up
        if now < state.started {
            state.started = now;
        }
        let all = |name: &str| -> Vec<&str> {
            headers
                .iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.trim())
                .collect()
        };
        let hosts = all("host");
        let origins = all("origin");
        let sites = all("sec-fetch-site");
        let auths = all("authorization");
        if hosts.len() != 1 || origins.len() > 1 || sites.len() > 1 || auths.len() > 1 {
            return Verdict::Forbidden;
        }
        let host = hosts[0].to_ascii_lowercase();
        if !is_loopback_host(&host) {
            return Verdict::Forbidden;
        }
        if let Some(origin) = origins.first()
            && origin.to_ascii_lowercase() != format!("http://{host}")
        {
            return Verdict::Forbidden;
        }

        let (route, query) = target.split_once('?').unwrap_or((target, ""));
        if method == "GET" && route == "/auth" {
            return self.login(&mut state, query, now, idle_now);
        }
        if method == "GET" && OPEN_ROUTES.contains(&route) {
            return Verdict::Open;
        }

        if let Some(site) = sites.first()
            && !matches!(site.to_ascii_lowercase().as_str(), "same-origin" | "none")
        {
            return Verdict::Forbidden;
        }

        if let Some(value) = auths.first()
            && let Some(token) = scheme_token(value)
            && check_token(&self.key, token, Purpose::Api, self.port, now, state.started).is_some()
        {
            return Verdict::Allow { session: None };
        }
        let name = cookie_name(self.port);
        for line in all("cookie") {
            for pair in line.split(';') {
                let Some((k, v)) = pair.split_once('=') else {
                    continue;
                };
                if k.trim() != name {
                    continue;
                }
                if let Some(session) = live(&mut state, v.trim(), idle_now) {
                    return Verdict::Allow {
                        session: Some(session),
                    };
                }
            }
        }
        Verdict::Unauthorized {
            api: route.starts_with("/api/"),
        }
    }

    fn login(&self, state: &mut State, query: &str, now: u64, idle_now: u64) -> Verdict {
        let mut token = None;
        let mut to = None;
        for pair in query.split('&') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            if k == "t" && token.is_none() {
                token = Some(v);
            }
            if k == "to" && to.is_none() {
                to = Some(v);
            }
        }
        let Some(checked) =
            token.and_then(|t| check_token(&self.key, t, Purpose::Login, self.port, now, state.started))
        else {
            return Verdict::LoginRefused;
        };
        state
            .used
            .retain(|_, issued| now.saturating_sub(*issued) <= LOGIN_TTL_MS + FUTURE_LEEWAY_MS);
        if state.used.contains_key(&checked.nonce) {
            return Verdict::LoginRefused;
        }
        let Ok(id) = random::<32>() else {
            return Verdict::LoginRefused;
        };
        state.used.insert(checked.nonce, checked.issued);
        let session = b64url_encode(&id);
        state.sessions.insert(
            session_key(&session),
            Session {
                seen: idle_now,
                active: 0,
            },
        );
        let to = LOGIN_TARGETS
            .iter()
            .find(|t| Some(**t) == to)
            .copied()
            .unwrap_or("/");
        Verdict::Login { session, to }
    }

    /// The request `decide` allowed on `session` has ended (its connection closed).
    pub fn release(&self, session: &str, idle_now: u64) {
        if let Ok(mut state) = self.state.lock()
            && let Some(s) = state.sessions.get_mut(session)
        {
            s.active = s.active.saturating_sub(1);
            s.seen = idle_now;
        }
    }
}

/// The session's key when `id` names a live one, which is then in use until `release`.
fn live(state: &mut State, id: &str, idle_now: u64) -> Option<String> {
    state
        .sessions
        .retain(|_, s| s.active > 0 || idle_now.saturating_sub(s.seen) <= SESSION_IDLE_MS);
    if id.len() != 43 || !is_b64url(id) {
        return None;
    }
    let key = session_key(id);
    let s = state.sessions.get_mut(&key)?;
    s.seen = idle_now;
    s.active += 1;
    Some(key)
}

/// `127.0.0.1`, `localhost` or `[::1]`, with or without a port; `host` is already lower case.
fn is_loopback_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((h, port)) if (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    };
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// The token of `SpawnLoft <token>` (the scheme in any case, one space, nothing after).
fn scheme_token(value: &str) -> Option<&str> {
    let (scheme, rest) = (value.get(..9)?, value.get(9..)?);
    if !scheme.eq_ignore_ascii_case(AUTH_SCHEME) {
        return None;
    }
    let token = rest.strip_prefix(' ')?;
    (!token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
}

/// A `Cookie` header value without this product's session cookies (any port's), for a request
/// that is forwarded; `None` when nothing is left.
pub fn strip_session_cookies(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            let name = pair.split_once('=').map_or(*pair, |(k, _)| k).trim();
            !name.to_ascii_lowercase().starts_with("spawnloft_")
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

// ---- the idle clock --------------------------------------------------------------------------

const IDLE_TICK_MS: u64 = 10_000;
static IDLE_TICKS: AtomicU64 = AtomicU64::new(0);

/// Starts the clock sessions idle by: it counts the ticks this process lived through, so time
/// the machine spent asleep is not time a session sat unused.
pub fn start_idle_clock() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_millis(IDLE_TICK_MS));
                IDLE_TICKS.fetch_add(1, Ordering::Relaxed);
            }
        });
    });
}

pub fn idle_now() -> u64 {
    IDLE_TICKS.load(Ordering::Relaxed) * IDLE_TICK_MS
}

// ---- what the listener sends -----------------------------------------------------------------

pub const PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_STYLE: &str = "body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#bbb}a{color:#9cf}code{color:#eee}";

fn page(title: &str, body: &str, extra_head: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">{extra_head}<title>{title}</title><style>{PAGE_STYLE}</style></head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )
}

/// The page behind a good login link. A page with a refresh, not a 303: the link is often opened
/// from outside this origin, a redirect would stay that cross-site navigation, and a
/// `SameSite=Strict` cookie is not sent on one. The refresh starts a new navigation from this page.
pub fn login_page(to: &str) -> String {
    page(
        "Opening SpawnLoft",
        &format!("<a href=\"{to}\">Continue to SpawnLoft</a>"),
        &format!("<meta http-equiv=\"refresh\" content=\"0; url={to}\">"),
    )
}

/// The page a browser without a session gets.
pub fn unauthorized_page() -> String {
    page(
        "Sign in to this panel",
        "Open SpawnLoft from the app, or run <code>spawnloft ui</code> to get a new link.",
        "",
    )
}

pub fn session_cookie(port: u16, session: &str) -> String {
    format!(
        "{}={session}; HttpOnly; SameSite=Strict; Path=/",
        cookie_name(port)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../../../../test/fixtures/contracts/panel-auth.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn fixture_key(f: &Value) -> Key {
        Key::parse(f["key"].as_str().unwrap()).unwrap()
    }

    fn purpose(name: &str) -> Option<Purpose> {
        match name {
            "login" => Some(Purpose::Login),
            "api" => Some(Purpose::Api),
            _ => None,
        }
    }

    #[test]
    fn base64url_round_trips_and_is_strict() {
        for len in 0..40usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let text = b64url_encode(&data);
            assert!(!text.contains('='));
            assert_eq!(b64url_decode(&text).unwrap(), data, "{len}");
        }
        assert_eq!(b64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(b64url_decode("-_8").unwrap(), [0xfb, 0xff]);
        // bits the length cannot hold, padding, the other alphabet, an impossible length
        for bad in ["-_9", "-_8=", "+/8", "A", "AAAAA", "AA A"] {
            assert!(b64url_decode(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_constants_are_the_fixtures() {
        let f = fixture();
        assert_eq!(f["loginTtlMs"], LOGIN_TTL_MS);
        assert_eq!(f["apiTtlMs"], API_TTL_MS);
        assert_eq!(f["futureLeewayMs"], FUTURE_LEEWAY_MS);
        assert_eq!(f["sessionIdleMs"], SESSION_IDLE_MS);
        let routes: Vec<&str> = f["openRoutes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap())
            .collect();
        assert_eq!(routes, OPEN_ROUTES);
        assert_eq!(f["cookie"], cookie_name(f["port"].as_u64().unwrap() as u16));
    }

    #[test]
    fn tokens_are_made_exactly_as_the_fixture_spells_them() {
        let f = fixture();
        let key = fixture_key(&f);
        for t in f["mint"].as_array().unwrap() {
            let made = make_token(
                &key,
                purpose(t["purpose"].as_str().unwrap()).unwrap(),
                t["port"].as_u64().unwrap() as u16,
                t["issued"].as_u64().unwrap(),
                t["nonce"].as_str().unwrap(),
            );
            assert_eq!(made, t["token"].as_str().unwrap(), "{}", t["name"]);
        }
        let a = login_token(&key, 1).unwrap();
        assert_ne!(a, login_token(&key, 1).unwrap());
        let parts: Vec<&str> = a.split('.').collect();
        assert_eq!((parts.len(), parts[4].len(), parts[5].len()), (6, 22, 43));
        assert!(api_token(&key, 1).starts_with("v1.api.1."));
        assert!(format!("{key:?}") == "Key(..)");
    }

    #[test]
    fn single_tokens_are_accepted_and_refused_as_the_fixture_says() {
        let f = fixture();
        let key = fixture_key(&f);
        for c in f["checks"].as_array().unwrap() {
            let want = c["ok"].as_bool().unwrap();
            let Some(p) = purpose(c["purpose"].as_str().unwrap()) else {
                assert!(!want, "{}", c["name"]);
                continue;
            };
            let got = check_token(
                &key,
                c["token"].as_str().unwrap(),
                p,
                c["port"].as_u64().unwrap() as u16,
                c["now"].as_u64().unwrap(),
                c["started"].as_u64().unwrap(),
            );
            assert_eq!(got.is_some(), want, "{}", c["name"]);
        }
    }

    fn fill(text: &str, f: &Value, sessions: &HashMap<String, String>) -> String {
        let mut out = text.to_string();
        for (kind, table) in [("token", None), ("session", Some(sessions))] {
            let open = format!("{{{kind}:");
            while let Some(at) = out.find(&open) {
                let end = at + out[at..].find('}').unwrap();
                let name = &out[at + open.len()..end];
                let value = match table {
                    None => f["tokens"][name]
                        .as_str()
                        .unwrap_or_else(|| panic!("no token {name}"))
                        .to_string(),
                    Some(t) => t.get(name).unwrap_or_else(|| panic!("no session {name}")).clone(),
                };
                out.replace_range(at..=end, &value);
            }
        }
        out
    }

    #[test]
    fn whole_requests_are_answered_as_the_fixture_says() {
        let f = fixture();
        let port = f["port"].as_u64().unwrap() as u16;
        let mut steps = 0;
        for scenario in f["scenarios"].as_array().unwrap() {
            let rule = PanelAuth::new(fixture_key(&f), port, f["started"].as_u64().unwrap());
            let mut sessions = HashMap::new();
            for step in scenario["steps"].as_array().unwrap() {
                let what = format!("{}: {}", scenario["name"], step["name"]);
                let now = step["now"].as_u64().unwrap();
                let headers: Vec<(String, String)> = step["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| {
                        (
                            h[0].as_str().unwrap().to_string(),
                            fill(h[1].as_str().unwrap(), &f, &sessions),
                        )
                    })
                    .collect();
                let got = rule.decide(
                    step["method"].as_str().unwrap(),
                    &fill(step["target"].as_str().unwrap(), &f, &sessions),
                    &headers,
                    now,
                    now,
                );
                let said = match &got {
                    Verdict::Forbidden => "forbidden",
                    Verdict::Open => "open",
                    Verdict::Login { .. } => "login",
                    Verdict::LoginRefused => "login-refused",
                    Verdict::Allow { .. } => "allow",
                    Verdict::Unauthorized { api: true } => "unauthorized-api",
                    Verdict::Unauthorized { api: false } => "unauthorized-page",
                };
                assert_eq!(said, step["expect"].as_str().unwrap(), "{what}");
                match got {
                    Verdict::Login { session, to } => {
                        assert_eq!(to, step["to"].as_str().unwrap(), "{what}");
                        assert_eq!(session.len(), 43, "{what}");
                        sessions.insert(step["save"].as_str().unwrap().to_string(), session);
                    }
                    Verdict::Allow { session: Some(s) } => rule.release(&s, now),
                    _ => {}
                }
                steps += 1;
            }
        }
        assert!(steps > 100, "the fixture's scenarios were read ({steps} steps)");
    }

    fn request(rule: &PanelAuth, target: &str, cookie: Option<&str>, now: u64, idle: u64) -> Verdict {
        let mut headers = vec![("Host".to_string(), "localhost:9".to_string())];
        if let Some(c) = cookie {
            headers.push(("Cookie".to_string(), c.to_string()));
        }
        rule.decide("GET", target, &headers, now, idle)
    }

    #[test]
    fn a_session_with_an_open_request_does_not_idle_out() {
        let key = Key::from_bytes([3; 32]);
        let rule = PanelAuth::new(key.clone(), 9, 0);
        let link = format!(
            "/auth?t={}",
            make_token(&key, Purpose::Login, 9, 1, &"A".repeat(22))
        );
        let Verdict::Login { session, to } = request(&rule, &link, None, 1, 0) else {
            panic!("no login");
        };
        assert_eq!(to, "/");
        let cookie = format!("spawnloft_9={session}");
        // an event stream held open for a day: no new request, but the page is plainly there
        let Verdict::Allow {
            session: Some(stream),
        } = request(&rule, "/api/x", Some(&cookie), 1, 0)
        else {
            panic!("the stream");
        };
        let day = 24 * 3600 * 1000;
        let Verdict::Allow { session: Some(poll) } = request(&rule, "/api/x", Some(&cookie), 1, day) else {
            panic!("a request a day later, the stream still open");
        };
        rule.release(&poll, day);
        rule.release(&stream, day + 1000);
        let Verdict::Allow { session: Some(last) } =
            request(&rule, "/api/x", Some(&cookie), 1, day + 1000 + SESSION_IDLE_MS)
        else {
            panic!("fifteen idle minutes exactly");
        };
        rule.release(&last, day + 1000 + SESSION_IDLE_MS);
        assert_eq!(
            request(
                &rule,
                "/api/x",
                Some(&cookie),
                1,
                day + 1001 + 2 * SESSION_IDLE_MS
            ),
            Verdict::Unauthorized { api: true }
        );
        // the map holds hashes, never ids
        let other = format!(
            "/auth?t={}",
            make_token(&key, Purpose::Login, 9, 1, &"B".repeat(22))
        );
        let Verdict::Login { session, .. } = request(&rule, &other, None, 1, 0) else {
            panic!("no login");
        };
        let state = rule.state.lock().unwrap();
        assert!(!state.sessions.contains_key(&session));
        assert!(state.sessions.keys().all(|k| k.len() == 64));
    }

    #[test]
    fn used_nonces_are_forgotten_once_their_token_has_expired_anyway() {
        let key = Key::from_bytes([4; 32]);
        let rule = PanelAuth::new(key.clone(), 9, 0);
        let go = |now: u64, nonce: &str| {
            let link = format!("/auth?t={}", make_token(&key, Purpose::Login, 9, now, nonce));
            request(&rule, &link, None, now, 0)
        };
        assert!(matches!(go(1000, &"A".repeat(22)), Verdict::Login { .. }));
        let later = 1000 + LOGIN_TTL_MS + FUTURE_LEEWAY_MS + 1;
        assert!(matches!(go(later, &"B".repeat(22)), Verdict::Login { .. }));
        let state = rule.state.lock().unwrap();
        assert_eq!(state.used.keys().collect::<Vec<_>>(), [&"B".repeat(22)]);
    }

    #[test]
    fn forwarded_requests_lose_the_session_cookies() {
        assert_eq!(strip_session_cookies("spawnloft_8770=abc"), None);
        assert_eq!(
            strip_session_cookies("theme=dark; spawnloft_8770=abc;x=y ; SpawnLoft_1=z"),
            Some("theme=dark; x=y".to_string())
        );
        assert_eq!(strip_session_cookies("a=b"), Some("a=b".to_string()));
        assert_eq!(strip_session_cookies(" ; "), None);
    }

    fn scratch(name: &str) -> PathBuf {
        let tag: String = random::<6>()
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let dir = std::env::temp_dir().join(format!("spawnloft-panel-auth-{name}-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_key_file_is_made_once_owner_only_and_read_back() {
        let dir = scratch("key");
        let file = dir.join("config").join("panel.key");
        let first = load_key_at(&file).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.len(), 44);
        assert!(text.ends_with('\n') && is_b64url(text.trim()));
        assert_eq!(Key::parse(&text).unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(load_key_at(&file).unwrap(), first);
        let left: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["panel.key"], "no temporary file is left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn several_first_starters_end_with_one_key() {
        let dir = scratch("race");
        let file = dir.join("panel.key");
        let keys: Vec<Key> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8).map(|_| s.spawn(|| load_key_at(&file).unwrap())).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(keys.iter().all(|k| *k == keys[0]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_made_by_the_node_panel_is_read_and_a_damaged_one_is_reported() {
        let dir = scratch("kept");
        let file = dir.join("panel.key");
        let theirs = b64url_encode(&[7u8; 32]);
        std::fs::write(&file, format!("{theirs}\n")).unwrap();
        assert_eq!(load_key_at(&file).unwrap(), Key::from_bytes([7; 32]));
        std::fs::write(&file, "not a key\n").unwrap();
        let err = load_key_at(&file).unwrap_err();
        assert!(err.contains("is damaged; delete the file"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "not a key\n",
            "left as it was"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pages_have_no_script() {
        for html in [login_page("/launcher"), unauthorized_page()] {
            assert!(!html.to_ascii_lowercase().contains("<script"));
        }
        assert!(login_page("/setup").contains("<meta http-equiv=\"refresh\" content=\"0; url=/setup\">"));
        assert_eq!(
            session_cookie(5, "abc"),
            "spawnloft_5=abc; HttpOnly; SameSite=Strict; Path=/"
        );
    }
}
