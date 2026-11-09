//! The panel's updater routes, answered by `spawnloft-core ui` itself (never proxied to Node):
//! what the Preferences page's Updates section calls (T5 builds the page on these).
//!
//! | Route | Does |
//! | --- | --- |
//! | `GET /api/update` | status: installed version, channel, last check, pending offer, hold, stale feed |
//! | `POST /api/update/check` | runs a check now; returns the report |
//! | `POST /api/update/install` | asks the window to install the pending offer (`update-request.json`) |
//! | `GET /api/update/rollbacks` | the releases below the installed one and whether each may be chosen |
//! | `POST /api/update/rollback` `{ "version": "2.0.1", "forceDataFormat": false }` | plans the rollback (hold written) and asks the window to run it |
//! | `DELETE /api/update/hold` (or `POST .../hold/clear`) | clears the hold |
//! | `POST /api/update/channel` `{ "beta": true }` | chooses the channel |
//! | `GET /api/update/log?n=50` | the last lines of `update.log` |
//!
//! The window (SpawnLoft.exe) watches `update-request.json` and does the install through
//! `tauri-plugin-updater`; a headless install uses `spawnloft-core update apply` instead. Every
//! answer is JSON; errors are `{ "error": "..." }` with a 4xx or 5xx status.

use semver::Version;
use serde_json::{Value, json};

use super::fetch::Https;
use super::store::{Request, Store};
use super::{Context, Outcome};

/// Answers one request. `path` is the request path with its query; `body` the request body.
pub fn handle(method: &str, path: &str, body: &[u8]) -> (u16, Value) {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let route = route.trim_end_matches('/');
    let store = Store::default_location();
    let fetch = Https::default();
    let ctx = match Context::current(&store, &fetch, None) {
        Ok(c) => c,
        Err(e) => return (500, json!({ "error": e })),
    };
    let parsed_body: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => {
                return (
                    400,
                    json!({ "error": format!("the request body is not JSON: {e}") }),
                );
            }
        }
    };
    match (method, route) {
        ("GET", "/api/update") => (200, ctx.status()),
        ("POST", "/api/update/check") => (200, ctx.check().to_json()),
        ("POST", "/api/update/install") => {
            let state = store.state();
            let Some(pending) = state.pending else {
                return (
                    409,
                    json!({ "error": "there is no verified update to install; check first" }),
                );
            };
            if let Err(e) = store.write_request(&Request {
                action: if pending.rollback {
                    "rollback".into()
                } else {
                    "install".into()
                },
                version: Some(pending.version.clone()),
                at: crate::time::iso_now(),
            }) {
                return (
                    500,
                    json!({ "error": format!("could not write the request: {e}") }),
                );
            }
            store.log("request", &[("action", "install"), ("version", &pending.version)]);
            (
                200,
                json!({ "ok": true, "version": pending.version, "rollback": pending.rollback }),
            )
        }
        ("GET", "/api/update/rollbacks") => match ctx.rollback_candidates() {
            Ok(list) => (
                200,
                json!({
                    "installed": ctx.installed.to_string(),
                    "dataFormat": Store::data_format(&ctx.data_root),
                    "releases": list.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
                }),
            ),
            Err(e) => (502, json!({ "error": e })),
        },
        ("POST", "/api/update/rollback") => {
            let Some(version) = parsed_body.get("version").and_then(Value::as_str) else {
                return (400, json!({ "error": "`version` is required" }));
            };
            let Ok(version) = Version::parse(version) else {
                return (400, json!({ "error": "`version` is not a semver version" }));
            };
            let force = parsed_body
                .get("forceDataFormat")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match ctx.plan_rollback(&version, force) {
                Ok(pinned) => {
                    if let Err(e) = store.write_request(&Request {
                        action: "rollback".into(),
                        version: Some(pinned.version.clone()),
                        at: crate::time::iso_now(),
                    }) {
                        return (
                            500,
                            json!({ "error": format!("could not write the request: {e}") }),
                        );
                    }
                    store.log("request", &[("action", "rollback"), ("version", &pinned.version)]);
                    (200, json!({ "ok": true, "update": pinned.to_json() }))
                }
                Err(e) => (409, json!({ "error": e })),
            }
        }
        ("DELETE", "/api/update/hold") | ("POST", "/api/update/hold/clear") => match store.clear_hold() {
            Ok(()) => {
                store.log("hold-cleared", &[("by", "panel")]);
                (200, json!({ "ok": true }))
            }
            Err(e) => (500, json!({ "error": format!("could not clear the hold: {e}") })),
        },
        ("POST", "/api/update/channel") => {
            let Some(beta) = parsed_body.get("beta").and_then(Value::as_bool) else {
                return (400, json!({ "error": "`beta` (true or false) is required" }));
            };
            match store.set_channel(beta) {
                Ok(()) => {
                    store.log("channel", &[("beta", if beta { "true" } else { "false" })]);
                    (
                        200,
                        json!({ "ok": true, "channel": if beta { "beta" } else { "stable" } }),
                    )
                }
                Err(e) => (
                    500,
                    json!({ "error": format!("could not save the channel: {e}") }),
                ),
            }
        }
        ("GET", "/api/update/log") => {
            let n = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("n="))
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(50)
                .min(500);
            (200, json!({ "lines": store.log_tail(n) }))
        }
        ("GET" | "POST" | "DELETE", _) => (404, json!({ "error": format!("no updater route {route}") })),
        _ => (405, json!({ "error": "method not allowed" })),
    }
}

/// A one-line summary of a check for the CLI's plain output.
pub fn describe(report: &super::Report) -> String {
    match &report.outcome {
        Outcome::Update(p) => format!(
            "{} is available (installed {}){}",
            p.version,
            report.installed,
            if report.stale {
                "; the update feed is older than expected"
            } else {
                ""
            }
        ),
        Outcome::UpToDate => format!(
            "{} is the newest {} release{}",
            report.installed,
            report.channel.as_str(),
            if report.stale {
                "; the update feed is older than expected"
            } else {
                ""
            }
        ),
        Outcome::Blocked(why) => format!("a newer release exists but cannot be installed: {why}"),
        Outcome::Unreachable(why) => format!("the update feed could not be read: {why}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_routes_and_methods() {
        // these need no network: the route is decided before anything is fetched
        let (status, body) = handle("GET", "/api/update/nothing", b"");
        assert_eq!(status, 404, "{body}");
        let (status, _) = handle("PUT", "/api/update", b"");
        assert_eq!(status, 405);
        let (status, body) = handle("POST", "/api/update/rollback", b"{not json");
        assert_eq!(status, 400, "{body}");
        let (status, body) = handle("POST", "/api/update/rollback", b"{}");
        assert_eq!(status, 400, "{body}");
        let (status, body) = handle("POST", "/api/update/channel", b"{}");
        assert_eq!(status, 400, "{body}");
    }
}
