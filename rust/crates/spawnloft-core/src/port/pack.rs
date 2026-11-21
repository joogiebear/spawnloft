//! Modpacks (C5): `new --modpack` (the modpack branch of `cmdNew`) and `pack` (`cmdPack`) in
//! mcctl.mjs, over spawnloft-lib's `mrpack`.

use std::path::Path;

use serde_json::Value;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::mrpack::{self, PackOptions, Updated};
use spawnloft_lib::{js, registry, text};

use super::args::Flag;
use super::create::flag_value;
use super::lifecycle::cli;
use super::{Ctx, require_name};

/// `${value}` in a template literal.
fn t(v: Option<&Value>) -> String {
    js::string(v)
}

fn field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) => m.get(key),
        _ => None,
    }
}

/// `new <name> --modpack <id>`: the pack decides loader, Minecraft version, mods and config, so
/// the usual flags for those do not apply.
pub fn new_modpack(ctx: &mut Ctx<'_>, name: &str) -> Result<(), Failure> {
    let project = ctx.args.get("modpack").map(Flag::text).unwrap_or_default();
    let memory = match flag_value(ctx, "memory") {
        Value::Null => Value::String("4G".into()),
        v => v,
    };
    let o = PackOptions {
        memory,
        port: ctx.args.get("port").filter(|f| f.truthy()).map(Flag::number),
        online_mode: !ctx.args.get("offline").is_some_and(Flag::truthy),
    };
    let layout = ctx.layout;
    let out = &mut *ctx.out;
    let res = mrpack::create_from_modpack(layout, &cli(), name, &project, o, &mut |m| {
        out.line(&format!("  {m}"))
    })?;
    ctx.out.line("");
    ctx.out.line(&format!(
        "Created \"{}\" from {} {}",
        res.name,
        t(Some(&res.pack)),
        t(res.pack_version.as_ref())
    ));
    let files = format!(
        "{}{}",
        res.files,
        if res.skipped > 0 {
            format!(" ({} client-only skipped)", res.skipped)
        } else {
            String::new()
        }
    );
    ctx.out.line(&text::table(&[
        vec!["minecraft:".into(), t(Some(&res.mc))],
        vec![
            "loader:".into(),
            format!("{} {}", res.loader.kind, t(Some(&res.loader.version))),
        ],
        vec!["pack files:".into(), files],
        vec!["port:".into(), js::number_to_string(res.port)],
    ]));
    ctx.out.line("");
    ctx.out.line(&format!("Start it with: spawnloft start {name}"));
    ctx.out
        .line("Players need the matching client pack to join - the same pack, installed in their launcher.");
    Ok(())
}

/// `pack <name> [status|check|update --yes]`.
pub fn pack(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "pack")?.to_string();
    let inst = registry::lookup(Path::new(&ctx.layout.registry_file), &name)?;
    let sub = ctx
        .args
        .positional
        .get(1)
        .cloned()
        .unwrap_or_else(|| "status".into());

    if sub == "status" || sub == "check" {
        let Some(pack) = mrpack::pack_of(&inst) else {
            return Err(Failure::user(format!("\"{name}\" was not built from a modpack")));
        };
        // `pack.loader ?? { kind: 'fabric', version: pack.fabricLoader }`
        let (kind, version) = match field(&pack, "loader") {
            None | Some(Value::Null) => ("fabric".to_string(), t(field(&pack, "fabricLoader"))),
            Some(l) => (t(field(l, "kind")), t(field(l, "version"))),
        };
        ctx.out.line(&format!(
            "{name} runs {} {} (minecraft {}, {kind} {version})",
            t(field(&pack, "name")),
            t(field(&pack, "versionNumber")),
            t(field(&pack, "mc"))
        ));
        let info = mrpack::check_pack_update(&inst)?;
        ctx.out.line(&if info.update_available {
            format!(
                "Release {} is out. Apply with: spawnloft pack {name} update --yes",
                t(info.latest.as_ref())
            )
        } else {
            "That is the newest release.".to_string()
        });
        return Ok(());
    }

    if sub == "update" {
        if !ctx.args.get("yes").is_some_and(Flag::truthy) {
            return Err(Failure::user(
                "updating replaces the pack's own files. A standard snapshot is taken first, the worlds\n  and anything you added by hand are never touched, and players will need the matching new\n  client pack. The server must be stopped. Re-run with --yes.",
            ));
        }
        let layout = ctx.layout;
        let out = &mut *ctx.out;
        let res = mrpack::update_pack(layout, &cli(), &name, &mut |m| out.line(&format!("  {m}")))?;
        match res {
            Updated::AlreadyLatest(v) => {
                ctx.out
                    .line(&format!("Already on the newest release ({}).", t(v.as_ref())));
            }
            Updated::Done {
                from,
                to,
                mc,
                mc_changed,
                files,
                removed,
                snapshot,
            } => {
                ctx.out.line("");
                ctx.out.line(&format!(
                    "Updated to {} (from {}).",
                    t(to.as_ref()),
                    t(from.as_ref())
                ));
                ctx.out.line(&format!("  Snapshot: {snapshot}"));
                ctx.out.line(&format!(
                    "  {files} pack files laid in, {removed} old pack file(s) retired."
                ));
                if mc_changed {
                    ctx.out.line(&format!(
                        "  Minecraft moved to {} - the worlds migrate on the next start.",
                        t(Some(&mc))
                    ));
                }
                ctx.out.line("Players need the matching new client pack to join.");
            }
        }
        return Ok(());
    }

    Err(Failure::user("usage: spawnloft pack <name> [update --yes]"))
}
