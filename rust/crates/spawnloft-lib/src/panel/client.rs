//! `handleClient` and `handleAccounts` of `ui.mjs`: the game launcher's routes (`/api/client...`).
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `/api/client...`, accounts included.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}
