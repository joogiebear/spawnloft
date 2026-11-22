//! `handleAccounts` of `ui.mjs`: the launcher's accounts: the list, offline accounts, the
//! default, sign-out, and the Microsoft sign-in (CLIENT.md, "Signing in from the launcher").
//!
//! No answer carries a token: an account is its name, uuid, type and two times. Every route here
//! is reached with a credential, except the callback: a top-level navigation Microsoft's page
//! makes, which has none. It does nothing without the `state` of the one live sign-in, which
//! exists only in this process's memory, and it says nothing of how the sign-in went.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::client::paths::Paths;
use crate::client::{accounts, launcher, login, profiles};
use crate::failure::Failure;
use crate::js;

use super::super::Panel;
use super::super::http::{Reply, Request, opt_field, write_head};
use super::super::routes::Routed;
use super::{public_accounts, writing};

pub fn route(panel: &Panel, paths: &Paths, req: &mut Request) -> Result<Routed, Failure> {
    handle(panel, paths, req).map(Routed::Reply)
}

fn default_account(paths: &Paths) -> Result<Value, Failure> {
    Ok(profiles::default_account(paths)?.map_or(Value::Null, Value::String))
}

fn handle(panel: &Panel, paths: &Paths, req: &mut Request) -> Result<Reply, Failure> {
    let n = req.seg.len();
    let s3 = req.seg(3).unwrap_or("").to_string();
    if n == 3 {
        if req.method != "GET" {
            return Ok(Reply::method_not_allowed());
        }
        return Ok(Reply::ok(json!({
            "accounts": public_accounts(paths),
            "defaultAccount": default_account(paths)?,
        })));
    }
    if s3 == "offline" && n == 4 {
        if req.method != "POST" {
            return Ok(Reply::method_not_allowed());
        }
        let body = req.json()?;
        let name = match opt_field(&body, "name") {
            None | Some(Value::Null) => String::new(),
            v => js::string(v),
        };
        let _w = writing();
        let account = launcher::add_offline_account(paths, &name)?;
        if profiles::default_account(paths)?.is_none() {
            launcher::set_default_account(paths, Some(&js::string(account.get("uuid"))))?;
        }
        return Ok(Reply::ok(json!({
            "account": accounts::public(&account)?,
            "defaultAccount": default_account(paths)?,
        })));
    }
    if s3 == "default" && n == 4 {
        if req.method != "POST" {
            return Ok(Reply::method_not_allowed());
        }
        let body = req.json()?;
        let uuid = match opt_field(&body, "uuid") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            v => Some(js::string(v)),
        };
        if let Some(u) = &uuid {
            let shaped = (32..=36).contains(&u.encode_utf16().count())
                && u.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
            if !shaped {
                return Ok(Reply::error(400, "uuid must be the account's uuid"));
            }
        }
        let _w = writing();
        return Ok(Reply::ok(json!({
            "defaultAccount": launcher::set_default_account(paths, uuid.as_deref())?,
        })));
    }
    if s3 == "login" {
        return sign_in(panel, paths, req);
    }
    if n == 4 && req.method == "DELETE" {
        let _w = writing();
        let Some(gone) = accounts::remove(paths, Some(&json!(s3)))? else {
            return Ok(Reply::error(404, "no such account"));
        };
        // the registry drops a default that no longer exists on its next save; done now so the
        // answer is right
        if profiles::load(paths)?.default_account().is_some() {
            let mut doc = profiles::load(paths)?;
            profiles::save(paths, &mut doc)?;
        }
        return Ok(Reply::ok(json!({ "removed": gone, "defaultAccount": default_account(paths)? })));
    }
    Ok(Reply::method_not_allowed())
}

/// `/api/client/accounts/login...`.
fn sign_in(panel: &Panel, paths: &Paths, req: &mut Request) -> Result<Reply, Failure> {
    let n = req.seg.len();
    if n == 4 {
        if req.method != "POST" {
            return Ok(Reply::method_not_allowed());
        }
        // The panel is the address the browser comes back to (in the window too: the Rust
        // panel is the port the window knows). Microsoft matches localhost on any port.
        let redirect = format!("http://localhost:{}/api/client/accounts/login/callback", panel.port);
        return Ok(match login::start_login(&redirect)? {
            login::Started::Started {
                login_id,
                authorize_url,
            } => Reply::ok(json!({ "loginId": login_id, "authorizeUrl": authorize_url })),
            login::Started::InProgress(message) => Reply::error(409, message),
        });
    }
    if req.seg(4) == Some("callback") && n == 5 {
        if req.method != "GET" {
            return Ok(Reply::method_not_allowed());
        }
        // Answered before the exchange starts: the desktop closes this window as soon as it has
        // loaded, and the outcome goes to the launcher through the stream. Nothing from the
        // query is echoed or logged.
        let ok = login::handle_callback(&req.query, &hooks(paths, panel))?;
        return Ok(callback_page(ok));
    }
    let login_id = req.seg(4).unwrap_or("").to_string();
    let shaped = login_id.len() == 32 && login_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !shaped {
        return Ok(Reply::error(404, "no such sign-in"));
    }
    if n == 5 && req.method == "DELETE" {
        return Ok(Reply::ok(json!({ "cancelled": login::cancel_login(&login_id) })));
    }
    if n == 6 && req.seg(5) == Some("stream") && req.method == "GET" {
        let Some(listening) = login::listen_login(&login_id) else {
            return Ok(Reply::error(404, "no such sign-in; start it again"));
        };
        return Ok(stream(login_id, listening));
    }
    Ok(Reply::method_not_allowed())
}

/// What finishing a sign-in needs: the network, panel.log, and the account kept under the same
/// lock as every other write to the lists.
fn hooks(paths: &Paths, panel: &Panel) -> login::Hooks {
    let save_paths = paths.clone();
    let log_dir = panel.layout.as_ref().map(|l| l.run_dir.clone());
    login::Hooks {
        send: &crate::client::http::send,
        now: crate::util::now,
        log: Arc::new(move |line: &str| {
            if let Some(dir) = &log_dir {
                super::panel_log(dir, line);
            }
        }),
        save: Arc::new(move |account: &Value| {
            let _w = writing();
            accounts::update_iterating(&save_paths, |list| accounts::upsert(list, account.clone(), None))?;
            if profiles::default_account(&save_paths)?.is_none() {
                launcher::set_default_account(&save_paths, Some(&js::string(account.get("uuid"))))?;
            }
            Ok(())
        }),
    }
}

/// What Microsoft's window shows after the redirect: a few words and no script. The outcome is
/// never shown here (the stream carries it), so a replayed or forged callback learns nothing but
/// "not valid".
fn callback_page(ok: bool) -> Reply {
    let title = if ok {
        "Microsoft is done"
    } else {
        "This sign-in link is not valid any more"
    };
    let body = if ok {
        "Go back to SpawnLoft: it is finishing the sign-in, and says there how it went. You can close this tab."
    } else {
        "Start the sign-in again from the SpawnLoft launcher."
    };
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{title}</title><style>body{{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}}h1{{font-size:20px;margin:0 0 8px}}p{{margin:0;color:#bbb}}</style></head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    );
    Reply::html(
        if ok { 200 } else { 400 },
        &[
            (
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
            ),
            ("Referrer-Policy", "no-referrer"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        html,
    )
}

const BEAT: Duration = Duration::from_secs(20);
const LOOK: Duration = Duration::from_millis(500);

/// Whether the page has hung up: a read that would return nothing more.
fn gone(conn: &TcpStream) -> bool {
    if conn.set_nonblocking(true).is_err() {
        return true;
    }
    let mut sink = [0u8; 256];
    let mut reader: &TcpStream = conn;
    let closed = loop {
        match reader.read(&mut sink) {
            Ok(0) => break true,
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break false,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break true,
        }
    };
    closed || conn.set_nonblocking(false).is_err()
}

/// The sign-in's stream: its status now, then each change, ending after the one that is neither
/// `pending` nor `finishing`. A page that goes away detaches.
fn stream(login_id: String, listening: login::Listening) -> Reply {
    Reply::Stream(Box::new(move |conn, proof| {
        struct Detach(String, u64);
        impl Drop for Detach {
            fn drop(&mut self) {
                login::detach(&self.0, self.1);
            }
        }
        let _detach = Detach(login_id, listening.listener);
        let mut headers = vec![
            ("Content-Type".to_string(), "text/event-stream".to_string()),
            ("Cache-Control".to_string(), "no-cache".to_string()),
        ];
        if let Some(p) = proof {
            headers.push((crate::panel_auth::PROOF_HEADER.to_string(), p.to_string()));
        }
        write_head(conn, 200, &headers, None)?;
        let mut beat = Instant::now() + BEAT;
        loop {
            match listening.events.recv_timeout(LOOK) {
                Ok(event) => {
                    conn.write_all(super::super::sse::event(&event).as_bytes())?;
                    conn.flush()?;
                    let status = event.get("status").and_then(Value::as_str);
                    if !matches!(status, Some("pending" | "finishing")) {
                        return Ok(());
                    }
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
                // dropped without an event (an orphan): nothing more will come
                Err(RecvTimeoutError::Disconnected) => {
                    while !gone(conn) {
                        std::thread::sleep(LOOK);
                    }
                    return Ok(());
                }
            }
        }
    }))
}
