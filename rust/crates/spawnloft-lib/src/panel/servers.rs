//! The routes about servers that start no job: the list, the overview, activity, a server's status reads (join, diagnose, metrics, attached databases, console, diagnostics bundle) and what is done to one (start, stop, kill, restart, rename, rebuild, delete, reveal, settings, command).
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `POST /api/scheduler/linger`.
pub fn linger(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let _ = (panel, layout);
    Ok(Routed::NotPorted)
}

/// `GET /api/instances`.
pub fn list(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let _ = (panel, layout);
    Ok(Routed::NotPorted)
}

/// `GET /api/activity`.
pub fn activity(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}

/// `GET /api/overview`.
pub fn overview(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let _ = (panel, layout);
    Ok(Routed::NotPorted)
}

/// `GET /api/instances/<name>/stream`: the console as an event stream.
pub fn console_stream(panel: &Panel, layout: &Layout, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, name);
    Ok(Routed::NotPorted)
}

/// `/api/instances/<name>/join`.
pub fn join(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}

/// `activity`, `console`, `diag`, `metrics`, and `GET` of `diagnose` and `databases`, of one server; `req.seg(3)` says which.
pub fn reads(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}

/// A `POST` to one server that no other family took: `start`, `stop`, `kill`, `restart`, `rename`, `rebuild`, `delete`, `reveal`, `settings`, `command`, and `not found` for anything else.
pub fn act(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}
