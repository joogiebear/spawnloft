//! `plugins` (C5): `cmdPlugins` in mcctl.mjs, over spawnloft-lib's `plugins`. `plugins --json`
//! is a query (`output::query`).

use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry;
use spawnloft_lib::{js, jspath, plugins, text};

use super::lifecycle::cli;
use super::{Ctx, require_name};

pub fn plugins(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "plugins")?.to_string();
    let inst = registry::lookup(Path::new(&ctx.layout.registry_file), &name)?;
    let sub = ctx.args.positional.get(1).cloned();

    if let Some(sub) = sub.as_deref().filter(|s| *s == "enable" || *s == "disable") {
        let Some(wanted) = ctx.args.positional.get(2).filter(|r| !r.is_empty()).cloned() else {
            return Err(Failure::user(format!(
                "usage: spawnloft plugins <name> {sub} <plugin>"
            )));
        };
        let rows = plugins::list_plugins(&inst)?;
        let mut hit = None;
        for p in &rows {
            if p.get("file").and_then(|f| f.as_str()) == Some(wanted.as_str()) {
                hit = Some(p);
                break;
            }
            // `p.name.toLowerCase()`: a name that is not text throws
            let Some(n) = p.get("name").and_then(|n| n.as_str()) else {
                return Err(Failure::type_error("p.name.toLowerCase is not a function"));
            };
            if n.to_lowercase() == wanted.to_lowercase() {
                hit = Some(p);
                break;
            }
        }
        let Some(hit) = hit else {
            return Err(Failure::user(format!(
                "no plugin \"{wanted}\" on \"{name}\". See: spawnloft plugins {name}"
            )));
        };
        let file = js::string(hit.get("file"));
        let res = plugins::set_plugin_enabled(&ctx.layout.data_root, &cli(), &inst, &file, sub == "enable")?;
        ctx.out.line(&format!(
            "{} is now {}. Takes effect on the next start.",
            js::string(hit.get("name")),
            if res.enabled { "enabled" } else { "disabled" }
        ));
        return Ok(());
    }
    if sub.is_some() {
        return Err(Failure::user(
            "usage: spawnloft plugins <name> [enable|disable <plugin>]",
        ));
    }

    let rows = plugins::list_plugins(&inst)?;
    if rows.is_empty() {
        let dir = spawnloft_lib::create::path_arg(inst.get("dir"), "path")?;
        ctx.out.line(&format!(
            "No plugins in {}. The panel's Plugins tab installs from Modrinth.",
            jspath::join(&[dir, "plugins"])
        ));
        return Ok(());
    }
    // everything is listed; SOURCE tells the jars SpawnLoft updates from the person's own
    let mut t = vec![
        ["NAME", "VERSION", "STATE", "SOURCE", "FILE", "SIZE"]
            .map(String::from)
            .to_vec(),
    ];
    // `String(c ?? '')` per cell
    let cell = |v: Option<&serde_json::Value>| match v {
        None | Some(serde_json::Value::Null) => String::new(),
        v => js::string(v),
    };
    for p in &rows {
        let version = match p.get("version") {
            None | Some(serde_json::Value::Null) => "-".to_string(),
            v => cell(v),
        };
        let source = if js::truthy(p.get("managed")) {
            match p.get("source") {
                None | Some(serde_json::Value::Null) => "spawnloft".to_string(),
                v => cell(v),
            }
        } else {
            "manual".to_string()
        };
        t.push(vec![
            cell(p.get("name")),
            version,
            if js::truthy(p.get("enabled")) {
                "on".into()
            } else {
                "off".into()
            },
            source,
            cell(p.get("file")),
            text::human_bytes(p.get("size").and_then(|s| s.as_f64())),
        ]);
    }
    ctx.out.line(&text::table(&t));
    Ok(())
}
