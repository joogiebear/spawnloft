//! `POST /api/client/profiles/<name>/launch`.

use crate::client::paths::Paths;
use crate::failure::Failure;
use crate::settings::Layout;

use super::super::Panel;
use super::super::http::{Reply, Request};

pub fn launch(panel: &Panel, layout: &Layout, paths: &Paths, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let _ = (panel, layout, paths, req, name);
    Err(Failure::user("not yet"))
}
