//! The launcher's Microsoft sign-in (`client-login.mjs`, and `startBrowserLogin` /
//! `finishBrowserLogin` of client-auth.mjs): Microsoft's own page in a window, an authorization
//! code with PKCE on a loopback redirect to the panel.
//!
//! One record at a time, held in this process's memory only: the PKCE verifier, the `state` the
//! callback is looked up by, and who is listening. No token is kept here; the outcome goes to
//! accounts.json and to the listening stream as a name and a uuid.
//!
//! Lifetimes: a record nobody listens to is dropped after [`ORPHAN_MS`] (the launcher opens its
//! stream before it opens Microsoft's page), except once the callback has consumed it: from then
//! on the chain is finishing a sign-in the person completed, and a launcher window closed
//! meanwhile must not throw it away. Every record is dropped [`EXPIRY_MS`] after it was made. A
//! new sign-in replaces an orphaned one and is refused while the old one's stream is open. The
//! callback consumes the state at the first request and is answered at once; the exchange and the
//! Xbox chain run afterwards on a thread of their own, and only the stream hears how they ended.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::auth::{self, Chain};
use super::http::{self, Send};
use super::prop;
use crate::failure::Failure;
use crate::js;

pub const ORPHAN_MS: u64 = 10_000;
pub const EXPIRY_MS: u64 = 10 * 60 * 1000;
pub const AUTHORIZE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
/// Each request of the chain is bounded: a hung connection must not hold the sign-in slot.
const STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// What finishing a sign-in needs from the process it runs in.
#[derive(Clone)]
#[allow(missing_debug_implementations)]
pub struct Hooks {
    pub send: Send<'static>,
    pub now: fn() -> f64,
    /// A line for panel.log.
    pub log: Arc<dyn Fn(&str) + std::marker::Send + Sync>,
    /// Keeps the account: re-read the list, upsert this one entry by uuid, and make it the
    /// default when there is none.
    pub save: Arc<dyn Fn(&Value) -> Result<(), Failure> + std::marker::Send + Sync>,
}

struct Record {
    id: String,
    state: String,
    verifier: String,
    redirect_uri: String,
    consumed: bool,
    finished: bool,
    listeners: Vec<(u64, Sender<Value>)>,
    last: Value,
    /// Bumped to call off the orphan timer armed before (`clearTimer`).
    orphan_timer: u64,
}

#[derive(Default)]
struct Records {
    list: Vec<Record>,
    next: u64,
}

static RECORDS: Mutex<Records> = Mutex::new(Records {
    list: Vec::new(),
    next: 0,
});

fn records() -> MutexGuard<'static, Records> {
    RECORDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn random(n: usize) -> Result<Vec<u8>, Failure> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|e| Failure::Internal {
        head: "Error".into(),
        message: format!("the system gave no random bytes: {e}"),
        code: None,
    })?;
    Ok(b)
}

fn emit(record: &mut Record, event: &Value) {
    record.last = event.clone();
    // a stream that went away fails quietly
    for (_, send) in &record.listeners {
        let _ = send.send(event.clone());
    }
}

/// `drop(record, event)`: forgotten, its listeners told `event` and let go.
fn drop_record(recs: &mut Records, id: &str, event: Option<Value>) {
    let Some(at) = recs.list.iter().position(|r| r.id == id) else {
        return;
    };
    let mut record = recs.list.remove(at);
    if let Some(e) = event {
        emit(&mut record, &e);
    }
    record.listeners.clear();
}

fn arm_orphan_timer(record: &mut Record) {
    record.orphan_timer += 1;
    let (id, armed) = (record.id.clone(), record.orphan_timer);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ORPHAN_MS));
        let mut recs = records();
        let orphaned = recs
            .list
            .iter()
            .any(|r| r.id == id && r.orphan_timer == armed && r.listeners.is_empty());
        if orphaned {
            drop_record(&mut recs, &id, None);
        }
    });
}

/// `startBrowserLogin({ redirectUri })`: the state, the PKCE verifier and Microsoft's page. A
/// public client has no secret; the verifier, never given to a page, ties the code to this
/// process. `redirectUri` carries the panel's port; Microsoft matches localhost on any port.
pub fn start_browser_login(redirect_uri: &str) -> Result<(String, String, String), Failure> {
    static SHAPE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^http://localhost:[0-9]+/api/client/accounts/login/callback$").expect("valid")
    });
    if !SHAPE.is_match(redirect_uri) {
        return Err(Failure::Internal {
            head: "Error".into(),
            message: "redirectUri must be the panel's own callback address".into(),
            code: None,
        });
    }
    let state = crate::panel_auth::b64url_encode(&random(16)?);
    let verifier = crate::panel_auth::b64url_encode(&random(32)?);
    let challenge = crate::panel_auth::b64url_encode(&Sha256::digest(verifier.as_bytes()));
    let client_id = auth::msa_client_id();
    let params = http::form(&[
        ("client_id", &client_id),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", auth::SCOPES),
        ("response_mode", "query"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        // adding a second account must show the picker, not silently reuse the first
        ("prompt", "select_account"),
    ]);
    Ok((state, verifier, format!("{AUTHORIZE_URL}?{params}")))
}

/// What [`start_login`] answers.
#[derive(Debug)]
pub enum Started {
    Started { login_id: String, authorize_url: String },
    /// `LoginInProgress`: another sign-in's stream is still open.
    InProgress(String),
}

/// `startLogin({ redirectUri })`.
pub fn start_login(redirect_uri: &str) -> Result<Started, Failure> {
    let mut recs = records();
    if let Some(old) = recs.list.first() {
        if !old.listeners.is_empty() && !old.finished {
            return Ok(Started::InProgress(
                "a sign-in is already open in another window; finish or cancel it first".into(),
            ));
        }
        let id = old.id.clone();
        drop_record(
            &mut recs,
            &id,
            Some(json!({ "status": "failed", "message": "another sign-in was started" })),
        );
    }
    let (state, verifier, authorize_url) = start_browser_login(redirect_uri)?;
    let id: String = random(16)?.iter().map(|b| format!("{b:02x}")).collect();
    let mut record = Record {
        id: id.clone(),
        state,
        verifier,
        redirect_uri: redirect_uri.to_string(),
        consumed: false,
        finished: false,
        listeners: Vec::new(),
        last: json!({ "status": "pending" }),
        orphan_timer: 0,
    };
    arm_orphan_timer(&mut record);
    recs.list.push(record);
    let expiring = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(EXPIRY_MS));
        drop_record(
            &mut records(),
            &expiring,
            Some(json!({ "status": "failed", "message": "the sign-in took longer than 10 minutes; start it again" })),
        );
    });
    Ok(Started::Started {
        login_id: id,
        authorize_url,
    })
}

/// A listener of one sign-in: its events, and the key [`detach`] takes.
#[derive(Debug)]
pub struct Listening {
    pub events: Receiver<Value>,
    pub listener: u64,
}

/// `listenLogin(loginId, send)`: hears the current status at once, then every change. `None`
/// when no such sign-in exists.
pub fn listen_login(login_id: &str) -> Option<Listening> {
    let mut recs = records();
    recs.next += 1;
    let listener = recs.next;
    let record = recs.list.iter_mut().find(|r| r.id == login_id)?;
    let (send, events) = channel();
    let _ = send.send(record.last.clone());
    record.listeners.push((listener, send));
    record.orphan_timer += 1;
    Some(Listening { events, listener })
}

/// The detach `listenLogin` answers: a consumed record outlives its listeners, since the account
/// is saved whether or not anyone hears it.
pub fn detach(login_id: &str, listener: u64) {
    let mut recs = records();
    if let Some(record) = recs.list.iter_mut().find(|r| r.id == login_id) {
        record.listeners.retain(|(n, _)| *n != listener);
        if record.listeners.is_empty() && !record.consumed {
            arm_orphan_timer(record);
        }
    }
}

/// `cancelLogin(loginId)`: the person closed Microsoft's window, or pressed Cancel.
pub fn cancel_login(login_id: &str) -> bool {
    let mut recs = records();
    if !recs.list.iter().any(|r| r.id == login_id) {
        return false;
    }
    drop_record(
        &mut recs,
        login_id,
        Some(json!({ "status": "cancelled", "message": "the sign-in was cancelled" })),
    );
    true
}

/// `query.get(key)`.
fn get<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn units(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

fn callback_error(query: &[(String, String)]) -> String {
    let error = get(query, "error").unwrap_or("");
    if error == "access_denied" {
        return "the sign-in was cancelled on Microsoft's page".into();
    }
    let said = units(get(query, "error_description").unwrap_or("").split('\n').next().unwrap_or(""), 200);
    format!(
        "Microsoft refused the sign-in: {}",
        if said.is_empty() { error } else { &said }
    )
}

/// `crypto.timingSafeEqual`, which throws on buffers of different lengths.
fn same_secret(a: &str, b: &str) -> Result<bool, Failure> {
    if a.len() != b.len() {
        return Err(Failure::Internal {
            head: "RangeError [ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH]".into(),
            message: "Input buffers must have the same byte length".into(),
            code: Some("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH".into()),
        });
    }
    Ok(a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0)
}

/// `handleCallback(query)`: Microsoft's redirect. True when the state named the live sign-in
/// (consumed right here, whatever happens next); false for anything else (unknown, reused or
/// missing state), which leaves every record as it was. The exchange runs after the answer.
pub fn handle_callback(query: &[(String, String)], hooks: &Hooks) -> Result<bool, Failure> {
    let Some(state) = get(query, "state").filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    let mut recs = records();
    let mut found = None;
    for r in &recs.list {
        // `.length` is counted in UTF-16 units, the comparison in bytes
        if !r.consumed
            && r.state.encode_utf16().count() == state.encode_utf16().count()
            && same_secret(&r.state, state)?
        {
            found = Some(r.id.clone());
        }
    }
    let Some(id) = found else {
        return Ok(false);
    };
    let record = recs.list.iter_mut().find(|r| r.id == id).expect("found above");
    record.consumed = true;
    if query.iter().any(|(k, _)| k == "error") {
        let message = callback_error(query);
        drop_record(&mut recs, &id, Some(json!({ "status": "failed", "message": message })));
        return Ok(true);
    }
    // Microsoft's part is over: a window closed from here on is no cancel
    emit(record, &json!({ "status": "finishing" }));
    let code = get(query, "code").map(String::from);
    let (verifier, redirect_uri) = (record.verifier.clone(), record.redirect_uri.clone());
    let hooks = hooks.clone();
    drop(recs);
    std::thread::spawn(move || finish(&id, code, &verifier, &redirect_uri, &hooks));
    Ok(true)
}

fn finish_failed(id: &str, message: &str) {
    let mut recs = records();
    if let Some(r) = recs.list.iter_mut().find(|r| r.id == id) {
        r.finished = true;
    }
    drop_record(&mut recs, id, Some(json!({ "status": "failed", "message": message })));
}

fn finish(id: &str, code: Option<String>, verifier: &str, redirect_uri: &str, hooks: &Hooks) {
    let account = match finish_browser_login(code.as_deref(), verifier, redirect_uri, hooks.send, hooks.now) {
        Ok(a) => a,
        Err(err) => {
            let message = match &err {
                Failure::User { message, .. } => message.clone(),
                other => {
                    (hooks.log)(&format!("sign-in failed: {}", other.message()));
                    "the sign-in failed inside SpawnLoft; see panel.log".into()
                }
            };
            finish_failed(id, &message);
            return;
        }
    };
    // Cancelled, expired or replaced while Microsoft was slow: the stream has said so already,
    // so the account is not kept.
    if !records().list.iter().any(|r| r.id == id) {
        (hooks.log)("sign-in finished after it was cancelled; the account was not saved");
        return;
    }
    if let Err(err) = (hooks.save)(&account) {
        let message = match &err {
            Failure::User { message, .. } => message.clone(),
            other => {
                (hooks.log)(&format!("sign-in: could not save the account: {}", other.message()));
                "the account could not be saved; see panel.log".into()
            }
        };
        finish_failed(id, &message);
        return;
    }
    (hooks.log)(&format!("signed in {}", js::string(prop(Some(&account), "name"))));
    let public = super::accounts::public(&account).unwrap_or(Value::Null);
    let mut recs = records();
    if let Some(r) = recs.list.iter_mut().find(|r| r.id == id) {
        r.finished = true;
    }
    drop_record(&mut recs, id, Some(json!({ "status": "done", "account": public })));
}

/// `finishBrowserLogin({ code, verifier, redirectUri })`: the code exchanged with the verifier
/// and the identical redirect address, then the Xbox and Minecraft chain of the device code.
/// Nothing of the request (code, verifier) ends up in a message.
pub fn finish_browser_login(
    code: Option<&str>,
    verifier: &str,
    redirect_uri: &str,
    send: Send<'_>,
    now: fn() -> f64,
) -> Result<Value, Failure> {
    let Some(code) = code.filter(|c| !c.is_empty()) else {
        return Err(Failure::user("Microsoft sent no sign-in code; try again"));
    };
    let client_id = auth::msa_client_id();
    let body = http::form(&[
        ("grant_type", "authorization_code"),
        ("client_id", &client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
        ("scope", auth::SCOPES),
    ]);
    let lost = || Failure::user("lost the connection to Microsoft; start the sign-in again");
    let res = send(&http::Request {
        method: "POST",
        url: auth::TOKEN_URL.into(),
        headers: vec![("content-type", "application/x-www-form-urlencoded".into())],
        body: Some(body),
        timeout: Some(STEP_TIMEOUT),
    })
    .map_err(|_| lost())?;
    let t = &res.body;
    if !res.ok() || !js::truthy(prop(Some(t), "access_token")) {
        let error = prop(Some(t), "error");
        if error == Some(&json!("invalid_grant")) {
            return Err(Failure::user("the sign-in expired; try again"));
        }
        if js::truthy(error) {
            let said = match prop(Some(t), "error_description") {
                v if super::nullish(v) => js::string(error),
                v => js::string(v),
            };
            return Err(Failure::user(format!(
                "Microsoft refused the sign-in: {}",
                units(said.split('\n').next().unwrap_or(""), 200)
            )));
        }
        return Err(Failure::user(format!(
            "Microsoft did not finish the sign-in (HTTP {}); try again in a minute",
            res.status
        )));
    }
    let now_fn = move || now();
    let chain = Chain {
        send,
        now: &now_fn,
        timeout: Some(STEP_TIMEOUT),
    };
    match auth::minecraft_from_microsoft(
        chain,
        prop(Some(t), "access_token").unwrap_or(&Value::Null),
        prop(Some(t), "refresh_token").cloned(),
    ) {
        Err(Failure::Internal { head, .. }) if head == "TimeoutError" || head == "AbortError" => Err(lost()),
        other => other,
    }
}

/// For the tests: forget every record.
#[cfg(test)]
fn reset() {
    records().list.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // the records are the process's own, so the tests that touch them run one at a time
    static SERIAL: StdMutex<()> = StdMutex::new(());

    const URI: &str = "http://localhost:4100/api/client/accounts/login/callback";

    fn hooks(saved: Arc<StdMutex<Vec<Value>>>) -> Hooks {
        Hooks {
            send: &|req: &http::Request| {
                let body = match req.url.as_str() {
                    auth::TOKEN_URL => json!({ "access_token": "ms", "refresh_token": "r" }),
                    auth::XBL_URL => json!({ "Token": "x", "DisplayClaims": { "xui": [{ "uhs": "u" }] } }),
                    auth::XSTS_URL => json!({ "Token": "xs", "DisplayClaims": { "xui": [{ "uhs": "u", "xid": "1" }] } }),
                    auth::MC_LOGIN_URL => json!({ "access_token": "mc", "expires_in": 86400 }),
                    _ => json!({ "id": "0123456789abcdef0123456789abcdef", "name": "Mia" }),
                };
                Ok(http::Answer { status: 200, body })
            },
            now: || 1_700_000_000_000.0,
            log: Arc::new(|_| {}),
            save: Arc::new(move |a| {
                saved.lock().unwrap().push(a.clone());
                Ok(())
            }),
        }
    }

    fn state_of(url: &str) -> String {
        let q = url.split_once('?').unwrap().1;
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned()
    }

    #[test]
    fn the_authorize_address_carries_the_challenge_of_the_verifier() {
        let (state, verifier, url) = start_browser_login(URI).unwrap();
        assert_eq!(state.len(), 22);
        assert_eq!(verifier.len(), 43);
        assert!(url.starts_with(&format!("{AUTHORIZE_URL}?client_id=")));
        let challenge = crate::panel_auth::b64url_encode(&Sha256::digest(verifier.as_bytes()));
        assert!(url.contains(&format!("&code_challenge={challenge}&code_challenge_method=S256&state={state}&prompt=select_account")));
        assert!(start_browser_login("http://evil.example/api/client/accounts/login/callback").is_err());
    }

    #[test]
    fn a_sign_in_is_consumed_once_and_its_stream_hears_the_account() {
        let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        reset();
        let saved = Arc::new(StdMutex::new(Vec::new()));
        let h = hooks(saved.clone());
        let Started::Started { login_id, authorize_url } = start_login(URI).unwrap() else {
            panic!("refused");
        };
        let listening = listen_login(&login_id).unwrap();
        assert_eq!(listening.events.recv().unwrap(), json!({ "status": "pending" }));
        assert!(matches!(start_login(URI).unwrap(), Started::InProgress(_)));
        let state = state_of(&authorize_url);
        let q = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert!(!handle_callback(&q(&[("state", "nope")]), &h).unwrap());
        assert!(!handle_callback(&q(&[("code", "c")]), &h).unwrap());
        assert!(handle_callback(&q(&[("state", &state), ("code", "c")]), &h).unwrap());
        assert!(!handle_callback(&q(&[("state", &state), ("code", "c")]), &h).unwrap(), "used once");
        assert_eq!(listening.events.recv().unwrap(), json!({ "status": "finishing" }));
        let done = listening.events.recv().unwrap();
        assert_eq!(done["status"], json!("done"));
        assert_eq!(done["account"]["name"], json!("Mia"));
        assert!(done["account"].get("accessToken").is_none());
        assert_eq!(saved.lock().unwrap().len(), 1);
        assert!(listen_login(&login_id).is_none(), "dropped once done");
        reset();
    }

    #[test]
    fn a_refusal_on_microsofts_page_and_a_cancel_end_the_sign_in() {
        let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        reset();
        let h = hooks(Arc::new(StdMutex::new(Vec::new())));
        let Started::Started { login_id, authorize_url } = start_login(URI).unwrap() else {
            panic!("refused");
        };
        let listening = listen_login(&login_id).unwrap();
        let _ = listening.events.recv();
        let q = vec![
            ("state".to_string(), state_of(&authorize_url)),
            ("error".to_string(), "x".to_string()),
            ("error_description".to_string(), "said\nmore".to_string()),
        ];
        assert!(handle_callback(&q, &h).unwrap());
        assert_eq!(
            listening.events.recv().unwrap(),
            json!({ "status": "failed", "message": "Microsoft refused the sign-in: said" })
        );
        let Started::Started { login_id, .. } = start_login(URI).unwrap() else {
            panic!("refused");
        };
        assert!(cancel_login(&login_id));
        assert!(!cancel_login(&login_id));
        // a state as long in UTF-16 units but not in bytes is the RangeError Node throws
        let Started::Started { .. } = start_login(URI).unwrap() else {
            panic!("refused");
        };
        let odd = vec![("state".to_string(), format!("é{}", "a".repeat(21)))];
        assert!(handle_callback(&odd, &h).is_err());
        reset();
    }
}
