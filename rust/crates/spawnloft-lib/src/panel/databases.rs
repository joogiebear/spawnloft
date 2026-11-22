//! The database routes of `ui.mjs` (`/api/databases...`, `handleDatabaseBackups`) and a server's `databases/create`.
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `/api/databases...`, every method and length: the whole family, down to its `no such database`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}

/// `POST /api/instances/<name>/databases/create`: make, start and attach a database for a
/// server; progress goes out on the job stream (`panel.jobs`).
pub fn create_for_server(
    panel: &Panel,
    layout: &Layout,
    req: &mut Request,
    name: &str,
) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}
