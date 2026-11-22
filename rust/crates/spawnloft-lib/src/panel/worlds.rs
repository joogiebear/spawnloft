//! `handleWorlds` of `ui.mjs`: a server's worlds. A thin layer: the running-server gates are in
//! the library's `worlds`.

use std::path::Path;

use serde_json::{Value, json};

use crate::failure::Failure;
use crate::paths::Roots;
use crate::settings::Layout;
use crate::{activity, js, registry, supervisor, worlds};

use super::Panel;
use super::http::{Reply, Request, field};
use super::routes::Routed;

/// `/api/instances/<name>/worlds...`.
pub fn route(_panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let reply = |r: Reply| Ok(Routed::Reply(r));
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let verb = req.seg(4).map(str::to_string);

    if req.method == "GET" && verb.is_none() {
        let list = worlds::list_worlds(&inst)?;
        let rows: Vec<Value> = list.worlds.iter().map(worlds::World::to_json).collect();
        return reply(Reply::ok(json!({
            "active": list.active,
            "worlds": rows,
            "running": supervisor::is_running(layout, name)?,
        })));
    }
    if req.method != "POST" {
        return reply(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let by = Panel::actor();
    let record = |action: &str, detail: &str, snapshot: Option<&str>| {
        activity::record_by(
            &Roots::new(&layout.data_root),
            &by,
            name,
            action,
            Some(detail),
            snapshot,
            true,
        );
    };
    // String(body.x)
    let text = |k: &str| field(&body, k).map(|v| js::string(v));

    match verb.as_deref() {
        Some("activate") => {
            let world = text("name")?;
            let active = worlds::activate_world(layout, &inst, &world)?;
            record("world-activate", &world, None);
            reply(Reply::ok(json!({ "active": active })))
        }
        Some("import") => {
            if !js::truthy(field(&body, "source")?) || !js::truthy(field(&body, "name")?) {
                return reply(Reply::error(400, "a source path and a name are required"));
            }
            let world = text("name")?;
            let out = worlds::import_world(&inst, &text("source")?, &world)?;
            record("world-import", &world, None);
            reply(Reply::ok(json!({
                "name": out.name,
                "dimensions": out.dimensions,
                "size": out.size,
                "sizeHuman": out.size_human(),
            })))
        }
        Some("export") => {
            let out = worlds::export_world(layout, &inst, &text("name")?)?;
            reply(Reply::ok(json!({
                "file": out.file,
                "size": out.size,
                "sizeHuman": out.size_human(),
                "members": out.members,
            })))
        }
        Some("delete") => {
            let world = text("name")?;
            let without_copy = field(&body, "withoutCopy")? == Some(&Value::Bool(true));
            let out = worlds::delete_world_keeping_copy(layout, &by, &inst, &world, without_copy)?;
            let detail = match out.snapshot {
                Some(_) => world.clone(),
                None => format!("{world} (no copy kept)"),
            };
            record("world-delete", &detail, out.snapshot.as_deref());
            reply(Reply::ok(
                json!({ "removed": out.removed, "snapshot": out.snapshot }),
            ))
        }
        _ => reply(Reply::not_found()),
    }
}
