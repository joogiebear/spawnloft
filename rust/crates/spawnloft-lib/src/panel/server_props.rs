//! `handleProps`, `handleRawProps` and `handleIcon` of `ui.mjs`: a server's settings page (server.properties as a form and as text) and its icon.
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `/api/instances/<name>/props...` and `/api/instances/<name>/icon...`; `req.seg(3)` is `props` or `icon`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}
