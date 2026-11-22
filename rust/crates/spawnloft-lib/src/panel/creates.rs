//! Making a server: `POST /api/instances` (a create that downloads or builds, as a job that can be cancelled) and `POST /api/instances/adopt`.
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `POST /api/instances/adopt`.
pub fn adopt(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}

/// `POST /api/instances`.
pub fn create(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}
