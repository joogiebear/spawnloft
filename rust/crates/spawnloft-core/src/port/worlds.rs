//! `worlds` (C3): `cmdWorlds` in mcctl.mjs, over spawnloft-lib's `worlds`.

use serde_json::json;
use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::{js, jspath, text, worlds};

use super::args::Flag;
use super::lifecycle::cli;
use super::{Ctx, require_name};

/// The name `import` gives a world when `--as` is not given: the source's file name without its
/// archive extension, every other character a `-` (per UTF-16 unit, as `replace` counts), at most
/// 32 of them.
fn derived_name(source: &str) -> String {
    let base = jspath::basename(source);
    let lower = base.to_ascii_lowercase();
    let stem = [".zip", ".tar.gz", ".tgz"]
        .iter()
        .find(|e| lower.ends_with(*e))
        .map(|e| &base[..base.len() - e.len()])
        .unwrap_or(&base);
    stem.encode_utf16()
        .map(|u| match char::from_u32(u as u32) {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            _ => '-',
        })
        .take(32)
        .collect()
}

pub fn worlds(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "worlds")?.to_string();
    let inst: Instance = registry::lookup(Path::new(&ctx.layout.registry_file), &name)?;
    let pos = &ctx.args.positional;
    let sub = pos.get(1).map(String::as_str).unwrap_or("list");
    let target = pos.get(2).cloned();
    match sub {
        "list" => {
            let data = worlds::list_worlds(&inst)?;
            if data.worlds.is_empty() {
                let dir = js::string(inst.get("dir"));
                ctx.out.line(&format!(
                    "No worlds in {dir}. The server generates one on first start, or: spawnloft worlds {name} import <zip-or-folder> --as <name>"
                ));
                return Ok(());
            }
            let mut rows = vec![
                ["WORLD", "ACTIVE", "DIMENSIONS", "SIZE"]
                    .map(String::from)
                    .to_vec(),
            ];
            for w in &data.worlds {
                let dims = w.dimensions.join(", ");
                rows.push(vec![
                    w.name.clone(),
                    if w.active { "yes".into() } else { String::new() },
                    if dims.is_empty() { "-".into() } else { dims },
                    w.size_human(),
                ]);
            }
            ctx.out.line(&text::table(&rows));
            Ok(())
        }
        "use" => {
            let Some(target) = target.filter(|t| !t.is_empty()) else {
                return Err(Failure::user(format!(
                    "usage: spawnloft worlds {name} use <world>"
                )));
            };
            worlds::activate_world(ctx.layout, &inst, &target)?;
            ctx.out.line(&format!(
                "{target} is now the active world. Takes effect on the next start."
            ));
            Ok(())
        }
        "import" => {
            let Some(source) = target.filter(|t| !t.is_empty()) else {
                return Err(Failure::user(format!(
                    "usage: spawnloft worlds {name} import <zip-or-folder> --as <name>"
                )));
            };
            let as_name = match ctx.args.get("as") {
                None => derived_name(&source),
                Some(Flag::Text(t)) => t.clone(),
                // validateName passes "true" and "false"; path.join then refuses a boolean
                Some(Flag::Bool(b)) => {
                    return Err(Failure::Internal {
                        head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
                        message: format!(
                            "The \"path\" argument must be of type string. {}",
                            js::received(Some(&json!(b)))
                        ),
                        code: Some("ERR_INVALID_ARG_TYPE".into()),
                    });
                }
            };
            let res = worlds::import_world(&inst, &source, &as_name)?;
            let with = if res.dimensions.is_empty() {
                String::new()
            } else {
                format!(", with {}", res.dimensions.join(" and "))
            };
            ctx.out.line(&format!(
                "Imported \"{}\" ({}{with}).",
                res.name,
                res.size_human()
            ));
            ctx.out.line(&format!(
                "Make it the active world with: spawnloft worlds {name} use {}",
                res.name
            ));
            Ok(())
        }
        "export" => {
            let target = match target {
                Some(t) => t,
                None => worlds::active_world(&inst)?,
            };
            let res = worlds::export_world(ctx.layout, &inst, &target)?;
            ctx.out.line(&format!("Exported {} to:", res.members.join(", ")));
            ctx.out.line(&format!("  {}  ({})", res.file, res.size_human()));
            Ok(())
        }
        "delete" => {
            let Some(target) = target.filter(|t| !t.is_empty()) else {
                return Err(Failure::user(format!(
                    "usage: spawnloft worlds {name} delete <world> --yes"
                )));
            };
            if !ctx.args.get("yes").is_some_and(Flag::truthy) {
                return Err(Failure::user(format!(
                    "this deletes the world \"{target}\". A copy is kept in its backups first (not past 1 GB:\n  add --no-copy for that). Re-run with --yes."
                )));
            }
            let without_copy = ctx.args.get("copy") == Some(&Flag::Bool(false));
            let res = worlds::delete_world_keeping_copy(ctx.layout, &cli(), &inst, &target, without_copy)?;
            let kept = match &res.snapshot {
                Some(s) => format!(" A copy is kept as {s}."),
                None => String::new(),
            };
            ctx.out
                .line(&format!("Deleted {}.{kept}", res.removed.join(", ")));
            Ok(())
        }
        _ => Err(Failure::user(
            "usage: spawnloft worlds <name> [use <world> | import <src> --as <name> | export [world] | delete <world> --yes]",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_import_is_named_after_its_source() {
        assert_eq!(derived_name("/x/My Map v2.zip"), "My-Map-v2");
        assert_eq!(derived_name("a.TAR.GZ"), "a");
        assert_eq!(derived_name("w.tgz"), "w");
        assert_eq!(derived_name("é😀"), "---");
        assert_eq!(derived_name(&"a".repeat(40)).len(), 32);
        assert_eq!(derived_name("folder/"), "folder");
    }
}
