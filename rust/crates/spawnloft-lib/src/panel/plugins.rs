//! `handlePlugins`, `handlePack` and `handleUpgrade` of `ui.mjs`, and the modpack search: a server's plugins or mods, its modpack and its software upgrade.
//!
//! Not moved yet (rust/PLAN-CORE-PORT.md C8): every request is still handed to the Node panel.

use crate::failure::Failure;
use crate::settings::Layout;

use super::Panel;
use super::http::Request;
use super::routes::Routed;

/// `/api/instances/<name>/plugins...`, `.../pack...` and `.../upgrade...`; `req.seg(3)` says which.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = (panel, layout, req, name);
    Ok(Routed::NotPorted)
}

/// `GET /api/modpacks/search`.
pub fn modpack_search(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout, req);
    Ok(Routed::NotPorted)
}
