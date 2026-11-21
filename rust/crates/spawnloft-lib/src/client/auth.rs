//! The Microsoft sign-in of `client-auth.mjs`: the device code (`client login`), the Xbox Live,
//! XSTS and Minecraft chain after it, and the refresh a launch makes when a token is about to
//! run out. Every answer is read as Node reads it (`bodyOf`, JavaScript's truthiness and `??`),
//! so the sentences and codes are the Node core's.
//!
//! Nothing of a request (a token, a device code) ends up in a message.

use std::time::Duration;

use serde_json::{Map, Value, json};

#[cfg(test)]
use super::http::Lost;
use super::http::{Answer, Request, Send, form};
use super::{nullish, prop};
use crate::failure::Failure;
use crate::js;

pub const DEFAULT_MSA_CLIENT_ID: &str = "946097b5-241d-4f83-9981-c6d0778e5507";
pub const SCOPES: &str = "XboxLive.signin offline_access";
pub const DEVICECODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
pub const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
pub const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
pub const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
pub const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
pub const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

/// Unreadable token-endpoint answers in a row before the poll gives up.
const TOKEN_POLL_HICCUPS: u32 = 5;
/// Each request of a refresh is bounded: a hung connection must not hold a launch.
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// OAuth's ways of saying a refresh token is finished or needs the person again.
const EXPIRED_ERRORS: [&str; 4] = [
    "invalid_grant",
    "interaction_required",
    "consent_required",
    "login_required",
];

/// `MSA_CLIENT_ID`: `process.env.SPAWNLOFT_MSA_CLIENT_ID ?? '946097b5-...'` (an empty value is
/// kept, as `??` keeps it).
pub fn msa_client_id() -> String {
    std::env::var("SPAWNLOFT_MSA_CLIENT_ID").unwrap_or_else(|_| DEFAULT_MSA_CLIENT_ID.to_string())
}

fn fail(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

/// `failStatus(message, status)`: a server having a bad moment (5xx, 429, 408) is not a refusal.
fn fail_status(message: String, status: u16) -> Failure {
    if status >= 500 || status == 429 || status == 408 {
        coded(message, "sign-in-unreachable")
    } else {
        fail(message)
    }
}

/// `v?.[0]`: an array's first item, or an object's `"0"`.
fn first(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(Value::Array(items)) => items.first(),
        Some(Value::Object(m)) => m.get("0"),
        _ => None,
    }
}

/// `x.DisplayClaims?.xui?.[0]?.<key>`.
fn claim<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    prop(first(prop(prop(Some(body), "DisplayClaims"), "xui")), key)
}

fn is_str(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::String(x)) if x == s)
}

/// `String(x).slice(0, n)` in UTF-16 units (a character that would be cut in half is left out).
fn slice_units(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        out.push(c);
    }
    out
}

/// `new Date(t).toISOString()`, which throws `RangeError: Invalid time value` outside the
/// dates JavaScript holds.
fn iso(t: f64) -> Result<String, Failure> {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return Err(Failure::Internal {
            head: "RangeError".into(),
            message: "Invalid time value".into(),
            code: None,
        });
    }
    Ok(crate::time::iso(t.trunc() as i64))
}

fn dash_uuid(hex: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn is_hex32(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn json_post(url: &str, body: &Value, timeout: Option<Duration>) -> Request {
    Request {
        method: "POST",
        url: url.into(),
        headers: vec![
            ("content-type", "application/json".into()),
            ("accept", "application/json".into()),
        ],
        body: Some(crate::jsjson::stringify(body)),
        timeout,
    }
}

fn form_post(url: &str, body: String, timeout: Option<Duration>) -> Request {
    Request {
        method: "POST",
        url: url.into(),
        headers: vec![("content-type", "application/x-www-form-urlencoded".into())],
        body: Some(body),
        timeout,
    }
}

/// How the chain is run: the transport, the clock, and each request's bound.
#[derive(Clone, Copy)]
pub struct Chain<'a> {
    pub send: Send<'a>,
    pub now: &'a dyn Fn() -> f64,
    pub timeout: Option<Duration>,
}

impl std::fmt::Debug for Chain<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Chain").field("timeout", &self.timeout).finish()
    }
}

impl Chain<'_> {
    fn ask(&self, req: Request) -> Result<Answer, Failure> {
        (self.send)(&req).map_err(|l| l.failure())
    }
}

/// `minecraftFromMicrosoft(accessToken, refreshToken)`: Xbox Live, XSTS, the Minecraft token
/// and the profile; the account entry accounts.json keeps. `refresh_token` is `None` where
/// JavaScript holds `undefined` (the key is then not written).
pub fn minecraft_from_microsoft(
    chain: Chain<'_>,
    access_token: &Value,
    refresh_token: Option<Value>,
) -> Result<Value, Failure> {
    let client_id = msa_client_id();
    let xbl_body = json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={}", js::string(Some(access_token))) },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT",
    });
    let xbl_res = chain.ask(json_post(XBL_URL, &xbl_body, chain.timeout))?;
    if !xbl_res.ok() {
        return Err(fail_status(
            format!("Xbox Live sign-in failed (HTTP {})", xbl_res.status),
            xbl_res.status,
        ));
    }
    let xbl = xbl_res.body;
    let uhs = claim(&xbl, "uhs").cloned();
    if !js::truthy(prop(Some(&xbl), "Token")) || !js::truthy(uhs.as_ref()) {
        return Err(fail("Xbox Live answered without a token; try again in a minute"));
    }

    let xsts_body = json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [prop(Some(&xbl), "Token").cloned().unwrap_or(Value::Null)] },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT",
    });
    let xsts_res = chain.ask(json_post(XSTS_URL, &xsts_body, chain.timeout))?;
    if !xsts_res.ok() {
        let xerr = prop(Some(&xsts_res.body), "XErr");
        if xsts_res.status == 401 && js::truthy(xerr) {
            let n = match xerr {
                Some(Value::Number(n)) => n.as_f64(),
                _ => None,
            };
            return Err(fail(match n {
                Some(2148916233.0) => "this Microsoft account has no Xbox profile; create one at https://www.xbox.com and sign in again".to_string(),
                Some(2148916238.0) => "this is a child account; an adult in the Microsoft family must allow it to play before it can sign in".to_string(),
                Some(2148916235.0) => "Xbox Live is not available in this account's country".to_string(),
                Some(2148916236.0) | Some(2148916237.0) => "this account has to finish the age verification Xbox asks for in South Korea; do it at https://account.xbox.com and sign in again".to_string(),
                _ => format!("Xbox Live refused the sign-in (XErr {})", js::string(xerr)),
            }));
        }
        return Err(fail_status(
            format!("Xbox Live sign-in failed (HTTP {})", xsts_res.status),
            xsts_res.status,
        ));
    }
    let xsts = xsts_res.body;
    if !js::truthy(prop(Some(&xsts), "Token")) {
        return Err(fail("Xbox Live answered without a token; try again in a minute"));
    }
    let xid = match claim(&xsts, "xid") {
        v if nullish(v) => json!(""),
        v => v.cloned().unwrap_or(Value::Null),
    };

    let mc_body = json!({
        "identityToken": format!("XBL3.0 x={};{}", js::string(uhs.as_ref()), js::string(prop(Some(&xsts), "Token"))),
    });
    let mc_res = chain.ask(json_post(MC_LOGIN_URL, &mc_body, chain.timeout))?;
    if !mc_res.ok() {
        // A 403 has two causes, and only the app registration's owner can fix either; Mojang's
        // own errorMessage, when it sends one, says which.
        if mc_res.status == 403 {
            let said = match prop(Some(&mc_res.body), "errorMessage") {
                v if nullish(v) => String::new(),
                v => slice_units(&js::string(v), 200),
            };
            let quoted = if said.is_empty() {
                String::new()
            } else {
                format!(" (\"{said}\")")
            };
            return Err(fail(format!(
                "Minecraft refused the sign-in (HTTP 403) for client id {client_id}{quoted}. Either Mojang has not approved that id for Minecraft sign-in, or its Azure app registration does not allow public client flows (Authentication > Allow public client flows). Offline profiles still work"
            )));
        }
        return Err(fail_status(
            format!("Minecraft sign-in failed (HTTP {})", mc_res.status),
            mc_res.status,
        ));
    }
    let mc = mc_res.body;
    let mc_token = prop(Some(&mc), "access_token").cloned();
    if !js::truthy(mc_token.as_ref()) {
        return Err(fail("Minecraft answered without a token; try again in a minute"));
    }

    let prof_res = chain.ask(Request {
        method: "GET",
        url: MC_PROFILE_URL.into(),
        headers: vec![(
            "authorization",
            format!("Bearer {}", js::string(mc_token.as_ref())),
        )],
        body: None,
        timeout: chain.timeout,
    })?;
    if !prof_res.ok() {
        if prof_res.status == 404 {
            return Err(fail(
                "this Microsoft account owns no Minecraft: Java Edition; buy it at https://www.minecraft.net or sign in with another account",
            ));
        }
        return Err(fail_status(
            format!("could not read the Minecraft profile (HTTP {})", prof_res.status),
            prof_res.status,
        ));
    }
    let prof = prof_res.body;
    let id = prop(Some(&prof), "id");
    if !is_hex32(id) || !js::truthy(prop(Some(&prof), "name")) {
        return Err(fail(
            "Minecraft answered without a profile; try again in a minute",
        ));
    }
    let Some(Value::String(id)) = id else {
        unreachable!()
    };

    let expires_at = iso((chain.now)() + js::number(prop(Some(&mc), "expires_in")) * 1000.0)?;
    let mut out = Map::new();
    out.insert("type".into(), json!("microsoft"));
    out.insert(
        "name".into(),
        prop(Some(&prof), "name").cloned().unwrap_or(Value::Null),
    );
    out.insert("uuid".into(), json!(dash_uuid(id)));
    out.insert("accessToken".into(), mc_token.unwrap_or(Value::Null));
    out.insert("expiresAt".into(), json!(expires_at));
    if let Some(r) = refresh_token {
        out.insert("refreshToken".into(), r);
    }
    out.insert("xuid".into(), xid);
    out.insert("userType".into(), json!("msa"));
    out.insert("clientId".into(), json!(client_id));
    Ok(Value::Object(out))
}

/// What the person is asked to do (`onCode`), as Microsoft sent it.
#[derive(Debug, Clone)]
pub struct Code {
    pub verification_uri: Option<Value>,
    pub user_code: Option<Value>,
    pub expires_in: Option<Value>,
}

impl Code {
    /// The line `client login` prints on stderr.
    pub fn prompt(&self) -> String {
        let minutes = (js::number(self.expires_in.as_ref()) / 60.0).floor();
        format!(
            "Open {} and enter the code {} (valid {} minutes). Waiting...\n",
            js::string(self.verification_uri.as_ref()),
            js::string(self.user_code.as_ref()),
            js::number_to_string(minutes)
        )
    }
}

/// `setTimeout`'s delay: NaN, below 1 or above 2^31-1 is 1 ms.
fn timer_ms(x: f64) -> u64 {
    if x.is_nan() || !(1.0..=2_147_483_647.0).contains(&x) {
        1
    } else {
        x.trunc() as u64
    }
}

/// `interval += 5` on whatever the answer held.
fn add_five(v: &Value) -> Value {
    match v {
        Value::String(_) | Value::Array(_) | Value::Object(_) => json!(format!("{}5", js::string(Some(v)))),
        other => crate::jsjson::num(js::number(Some(other)) + 5.0),
    }
}

/// `deviceCodeLogin({ onCode, sleepImpl, signal })`. `sleep` waits that many milliseconds and
/// says whether the sign-in was cancelled meanwhile (Ctrl-C); it is asked before each poll, so a
/// cancel during a request is seen at the next wait, as in Node.
pub fn device_code_login(
    chain: Chain<'_>,
    on_code: &mut dyn FnMut(&Code),
    sleep: &mut dyn FnMut(Duration) -> bool,
) -> Result<Value, Failure> {
    let cancelled = || fail("the sign-in was cancelled before it finished");
    let client_id = msa_client_id();
    let dc_res = chain.ask(form_post(
        DEVICECODE_URL,
        form(&[("client_id", &client_id), ("scope", SCOPES)]),
        None,
    ))?;
    if !dc_res.ok() {
        return Err(fail(format!(
            "Microsoft did not start the sign-in (HTTP {}); try again in a minute",
            dc_res.status
        )));
    }
    let dc = dc_res.body;
    let get = |k: &str| prop(Some(&dc), k).cloned();
    if !js::truthy(get("device_code").as_ref()) || !js::truthy(get("user_code").as_ref()) {
        return Err(fail("Microsoft did not start the sign-in; try again in a minute"));
    }
    on_code(&Code {
        verification_uri: get("verification_uri"),
        user_code: get("user_code"),
        expires_in: get("expires_in"),
    });

    // The code's own lifetime bounds the wait; a few unreadable answers in a row are a hiccup.
    let life = match get("expires_in") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => n.as_f64().unwrap_or(900.0),
        _ => 900.0,
    };
    let deadline = (chain.now)() + life * 1000.0;
    let mut interval = match get("interval") {
        v if nullish(v.as_ref()) => json!(5),
        v => v.unwrap_or(Value::Null),
    };
    let device_code = js::string(get("device_code").as_ref());
    let mut hiccups = 0;
    loop {
        let ms = timer_ms(js::number(Some(&interval)) * 1000.0);
        if sleep(Duration::from_millis(ms)) {
            return Err(cancelled());
        }
        if (chain.now)() >= deadline {
            return Err(fail(
                "the code expired before it was entered; run spawnloft client login again",
            ));
        }
        let body = form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", &client_id),
            ("device_code", &device_code),
        ]);
        let (status, t, lost) = match (chain.send)(&form_post(TOKEN_URL, body, None)) {
            Ok(a) => (Some(a.status), a.body, None),
            Err(l) => (None, json!({}), Some(l)),
        };
        if js::truthy(prop(Some(&t), "access_token")) {
            let refresh = prop(Some(&t), "refresh_token").cloned();
            return minecraft_from_microsoft(
                chain,
                prop(Some(&t), "access_token").unwrap_or(&Value::Null),
                refresh,
            );
        }
        let error = prop(Some(&t), "error");
        if !js::truthy(error) || is_str(error, "temporarily_unavailable") {
            hiccups += 1;
            if hiccups < TOKEN_POLL_HICCUPS {
                continue;
            }
            let why = match (&lost, status) {
                (Some(l), _) => format!("the connection failed: {}", l.message()),
                _ if !nullish(error) => js::string(error),
                (None, Some(s)) => format!("HTTP {s}"),
                (None, None) => String::new(),
            };
            return Err(fail(format!(
                "Microsoft's sign-in server stopped answering ({why}); run spawnloft client login again in a few minutes"
            )));
        }
        hiccups = 0;
        if is_str(error, "authorization_pending") {
            continue;
        }
        if is_str(error, "slow_down") {
            interval = add_five(&interval);
            continue;
        }
        if is_str(error, "expired_token") {
            return Err(fail(
                "the code expired before it was entered; run spawnloft client login again",
            ));
        }
        if is_str(error, "authorization_declined") {
            return Err(fail("the sign-in was declined on Microsoft's page"));
        }
        let said = match prop(Some(&t), "error_description") {
            v if nullish(v) => js::string(error),
            v => js::string(v),
        };
        return Err(fail(format!("Microsoft refused the sign-in: {said}")));
    }
}

/// `refreshAccount(account)`: a new Minecraft token from the saved refresh token. Ends with code
/// `sign-in-expired` when Microsoft says the sign-in is over, `sign-in-unreachable` when it could
/// not be asked or is having a bad moment.
pub fn refresh_account(send: Send<'_>, now: &dyn Fn() -> f64, account: &Value) -> Result<Value, Failure> {
    let name = js::string(prop(Some(account), "name"));
    let unreachable = || {
        coded(
            format!(
                "could not reach Microsoft to renew the sign-in for {name}; check the internet connection and try again"
            ),
            "sign-in-unreachable",
        )
    };
    let chain = Chain {
        send,
        now,
        timeout: Some(STEP_TIMEOUT),
    };
    let client_id = msa_client_id();
    let saved = prop(Some(account), "refreshToken");
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("client_id", &client_id),
        ("refresh_token", &js::string(saved)),
        ("scope", SCOPES),
    ]);
    let res = match send(&form_post(TOKEN_URL, body, Some(STEP_TIMEOUT))) {
        Ok(r) => r,
        Err(_) => return Err(unreachable()),
    };
    let json = &res.body;
    if !res.ok() || !js::truthy(prop(Some(json), "access_token")) {
        // only Microsoft's own refusal of the token ends a sign-in
        if EXPIRED_ERRORS
            .iter()
            .any(|e| is_str(prop(Some(json), "error"), e))
        {
            return Err(coded(
                format!("the saved sign-in for {name} no longer works; run spawnloft client login again"),
                "sign-in-expired",
            ));
        }
        if res.status >= 500 || res.status == 429 || res.status == 408 {
            return Err(coded(
                format!(
                    "Microsoft's sign-in server could not renew the sign-in for {name} just now (HTTP {}); try again in a few minutes",
                    res.status
                ),
                "sign-in-unreachable",
            ));
        }
        return Err(coded(
            format!(
                "Microsoft's sign-in server did not answer as expected when renewing the sign-in for {name} (HTTP {}); check the internet connection and try again",
                res.status
            ),
            "sign-in-unreachable",
        ));
    }
    let refresh = match prop(Some(json), "refresh_token") {
        v if nullish(v) => saved.cloned(),
        v => v.cloned(),
    };
    match minecraft_from_microsoft(
        chain,
        prop(Some(json), "access_token").unwrap_or(&Value::Null),
        refresh,
    ) {
        // Xbox's and Minecraft's own refusals are already sentences; anything else is the
        // connection again
        Err(Failure::User { message, code }) => Err(Failure::User { message, code }),
        Err(_) => Err(unreachable()),
        ok => ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type Routes = Vec<(&'static str, u16, Value)>;
    type Seen = std::sync::Arc<Mutex<Vec<Request>>>;

    fn fake(routes: Routes) -> (impl Fn(&Request) -> Result<Answer, Lost> + Sync, Seen) {
        let seen = std::sync::Arc::new(Mutex::new(Vec::<Request>::new()));
        let log = seen.clone();
        let queue = Mutex::new(routes);
        let f = move |req: &Request| {
            log.lock().unwrap().push(req.clone());
            let mut q = queue.lock().unwrap();
            let at = q
                .iter()
                .position(|(u, _, _)| *u == req.url)
                .expect("unexpected request");
            let (_, status, body) = q.remove(at);
            if status == 0 {
                return Err(Lost::Failed);
            }
            Ok(Answer { status, body })
        };
        (f, seen)
    }

    fn happy_chain() -> Routes {
        vec![
            (
                XBL_URL,
                200,
                json!({ "Token": "xbl", "DisplayClaims": { "xui": [{ "uhs": "U" }] } }),
            ),
            (
                XSTS_URL,
                200,
                json!({ "Token": "xsts", "DisplayClaims": { "xui": [{ "xid": "X" }] } }),
            ),
            (
                MC_LOGIN_URL,
                200,
                json!({ "access_token": "mc", "expires_in": 86400 }),
            ),
            (
                MC_PROFILE_URL,
                200,
                json!({ "id": "AAAAAAAA111122223333444444444444", "name": "Steve" }),
            ),
        ]
    }

    const NOW: f64 = 1_763_700_000_000.0;

    #[test]
    fn device_code_polls_through_pending_and_hiccups() {
        let mut routes = vec![(
            DEVICECODE_URL,
            200,
            json!({ "device_code": "D", "user_code": "ABC", "verification_uri": "https://microsoft.com/link", "expires_in": 900, "interval": 0 }),
        )];
        routes.push((TOKEN_URL, 400, json!({ "error": "authorization_pending" })));
        routes.push((TOKEN_URL, 0, Value::Null));
        routes.push((TOKEN_URL, 502, json!({})));
        routes.push((
            TOKEN_URL,
            200,
            json!({ "access_token": "ms", "refresh_token": "r" }),
        ));
        routes.extend(happy_chain());
        let (send, seen) = fake(routes);
        let now = || NOW;
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        let mut prompt = String::new();
        let mut waits = 0;
        let account = device_code_login(chain, &mut |c| prompt = c.prompt(), &mut |_| {
            waits += 1;
            false
        })
        .unwrap();
        assert_eq!(
            prompt,
            "Open https://microsoft.com/link and enter the code ABC (valid 15 minutes). Waiting...\n"
        );
        assert_eq!(waits, 4);
        assert_eq!(
            crate::jsjson::stringify(&account),
            r#"{"type":"microsoft","name":"Steve","uuid":"AAAAAAAA-1111-2222-3333-444444444444","accessToken":"mc","expiresAt":"2025-11-22T04:40:00.000Z","refreshToken":"r","xuid":"X","userType":"msa","clientId":"946097b5-241d-4f83-9981-c6d0778e5507"}"#
        );
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen[1].body.as_deref(),
            Some(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=946097b5-241d-4f83-9981-c6d0778e5507&device_code=D"
            )
        );
        assert_eq!(
            seen[5].body.as_deref(),
            Some(
                r#"{"Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":"d=ms"},"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT"}"#
            )
        );
        assert_eq!(
            seen[7].body.as_deref(),
            Some(r#"{"identityToken":"XBL3.0 x=U;xsts"}"#)
        );
    }

    #[test]
    fn device_code_gives_up_after_five_hiccups_and_on_cancel() {
        let mut routes = vec![(
            DEVICECODE_URL,
            200,
            json!({ "device_code": "D", "user_code": "ABC", "interval": 0 }),
        )];
        for _ in 0..4 {
            routes.push((TOKEN_URL, 503, json!({})));
        }
        routes.push((TOKEN_URL, 0, Value::Null));
        let (send, _) = fake(routes);
        let now = || NOW;
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        let err = device_code_login(chain, &mut |_| {}, &mut |_| false).unwrap_err();
        assert_eq!(
            err,
            fail(
                "Microsoft's sign-in server stopped answering (the connection failed: fetch failed); run spawnloft client login again in a few minutes"
            )
        );

        let (send, _) = fake(vec![(
            DEVICECODE_URL,
            200,
            json!({ "device_code": "D", "user_code": "ABC" }),
        )]);
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        let err = device_code_login(chain, &mut |_| {}, &mut |_| true).unwrap_err();
        assert_eq!(err, fail("the sign-in was cancelled before it finished"));
    }

    #[test]
    fn xsts_refusals_and_mojang_403() {
        let (send, _) = fake(vec![
            (
                XBL_URL,
                200,
                json!({ "Token": "xbl", "DisplayClaims": { "xui": { "0": { "uhs": "U" } } } }),
            ),
            (XSTS_URL, 401, json!({ "XErr": 2148916238u64 })),
        ]);
        let now = || NOW;
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        assert_eq!(
            minecraft_from_microsoft(chain, &json!("a"), None).unwrap_err(),
            fail(
                "this is a child account; an adult in the Microsoft family must allow it to play before it can sign in"
            )
        );
        let mut routes = happy_chain();
        routes[2] = (
            MC_LOGIN_URL,
            403,
            json!({ "errorMessage": "Invalid app registration" }),
        );
        let (send, _) = fake(routes);
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        let Failure::User { message, .. } = minecraft_from_microsoft(chain, &json!("a"), None).unwrap_err()
        else {
            panic!()
        };
        assert!(
            message.contains("(\"Invalid app registration\"). Either"),
            "{message}"
        );
        let mut routes = happy_chain();
        routes[0] = (XBL_URL, 503, json!({}));
        let (send, _) = fake(routes);
        let chain = Chain {
            send: &send,
            now: &now,
            timeout: None,
        };
        assert_eq!(
            minecraft_from_microsoft(chain, &json!("a"), None).unwrap_err(),
            coded("Xbox Live sign-in failed (HTTP 503)", "sign-in-unreachable")
        );
    }

    #[test]
    fn refresh_keeps_the_old_refresh_token_and_maps_failures() {
        let account = json!({ "name": "Steve", "refreshToken": "old" });
        let mut routes = vec![(TOKEN_URL, 200, json!({ "access_token": "ms" }))];
        routes.extend(happy_chain());
        let (send, seen) = fake(routes);
        let now = || NOW;
        let fresh = refresh_account(&send, &now, &account).unwrap();
        assert_eq!(fresh["refreshToken"], json!("old"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .all(|r| r.timeout == Some(STEP_TIMEOUT))
        );

        let (send, _) = fake(vec![(TOKEN_URL, 400, json!({ "error": "invalid_grant" }))]);
        assert_eq!(
            refresh_account(&send, &now, &account).unwrap_err(),
            coded(
                "the saved sign-in for Steve no longer works; run spawnloft client login again",
                "sign-in-expired"
            )
        );
        let (send, _) = fake(vec![(TOKEN_URL, 0, Value::Null)]);
        assert_eq!(
            refresh_account(&send, &now, &account).unwrap_err(),
            coded(
                "could not reach Microsoft to renew the sign-in for Steve; check the internet connection and try again",
                "sign-in-unreachable"
            )
        );
        let mut routes = vec![(TOKEN_URL, 200, json!({ "access_token": "ms" }))];
        routes.extend(happy_chain());
        routes[1] = (XBL_URL, 0, Value::Null);
        let (send, _) = fake(routes);
        assert_eq!(
            refresh_account(&send, &now, &account).unwrap_err(),
            coded(
                "could not reach Microsoft to renew the sign-in for Steve; check the internet connection and try again",
                "sign-in-unreachable"
            )
        );
    }

    #[test]
    fn small_js_rules() {
        assert_eq!(timer_ms(f64::NAN), 1);
        assert_eq!(timer_ms(0.0), 1);
        assert_eq!(timer_ms(5000.0), 5000);
        assert_eq!(js::number(Some(&add_five(&json!(5)))), 10.0);
        assert_eq!(add_five(&json!("5")), json!("55"));
        assert_eq!(slice_units("a😀b", 2), "a");
        assert!(iso(f64::NAN).is_err());
    }
}
