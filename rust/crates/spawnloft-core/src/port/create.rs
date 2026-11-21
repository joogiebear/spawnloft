//! Making servers (C4): `new` (from a stored jar, a template or another server), `clone`,
//! `adopt`, `templates`, `jars`, `launchers`, `reveal` and `rebuild`, as `cmdNew`, `cmdClone`,
//! `cmdAdopt`, `cmdTemplates`, `cmdJars`, `cmdLaunchers`, `cmdReveal` and `cmdRebuild` in
//! mcctl.mjs answer them, over spawnloft-lib's `create` and `manage`.

use serde_json::{Value, json};
use std::path::Path;

use spawnloft_lib::create::{self, Made, NewOptions};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::{js, jsdate, jspath, manage, registry, text};

use super::args::Flag;
use super::lifecycle::cli;
use super::{Ctx, require_name};

/// `flags.x ?? null` as a JavaScript value.
pub fn flag_value(ctx: &Ctx<'_>, key: &str) -> Value {
    match ctx.args.get(key) {
        None => Value::Null,
        Some(Flag::Text(s)) => json!(s),
        Some(Flag::Bool(b)) => json!(b),
    }
}

fn truthy(ctx: &Ctx<'_>, key: &str) -> bool {
    ctx.args.get(key).is_some_and(Flag::truthy)
}

/// `flags.x ? Number(flags.x) : null`.
fn number_flag(ctx: &Ctx<'_>, key: &str) -> Option<f64> {
    ctx.args.get(key).filter(|f| f.truthy()).map(Flag::number)
}

/// `flags.x ?? fallback`.
fn flag_or(ctx: &Ctx<'_>, key: &str, fallback: &str) -> Value {
    match flag_value(ctx, key) {
        Value::Null => json!(fallback),
        v => v,
    }
}

fn registry_file<'a>(ctx: &'a Ctx<'_>) -> &'a Path {
    Path::new(&ctx.layout.registry_file)
}

/// The table every creating command prints under its first line.
fn made_table(made: &Made, rows: &[&str]) -> String {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let value = match *r {
                "directory:" => made.text("dir"),
                "jar:" => made.text("jar"),
                "memory:" => made.text("memory"),
                "port:" => made.port_text(),
                _ => made.rcon_port_text(),
            };
            vec![r.to_string(), value]
        })
        .collect();
    text::table(&cells)
}

/// `new` without `--modpack` and without a software flag: from `--jar`, a template or
/// `--from` another server.
pub fn new(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "new")?.to_string();
    // --modpack is its own creation path
    if ctx.args.get("modpack").is_some_and(super::args::Flag::truthy) {
        return super::pack::new_modpack(ctx, &name);
    }
    if super::fetch::new_with_software(ctx, &name)? {
        return Ok(());
    }
    let o = new_options(ctx);
    let made = create::new_instance(ctx.layout, &cli(), &name, o)?;
    print_created(ctx, &made);
    Ok(())
}

/// What `cmdNew` hands `newInstance` from its flags (a software flag then sets the jar, the
/// loader, the Minecraft version and the Java).
pub fn new_options(ctx: &Ctx<'_>) -> NewOptions {
    NewOptions {
        loader: "paper".into(),
        mc_version: None,
        template: flag_value(ctx, "template"),
        from: flag_value(ctx, "from"),
        with_worlds: truthy(ctx, "withWorlds"),
        jar: flag_value(ctx, "jar"),
        memory: Some(flag_or(ctx, "memory", "4G")),
        port: number_flag(ctx, "port"),
        rcon_port: number_flag(ctx, "rconPort"),
        accept_eula: truthy(ctx, "acceptEula"),
        // --offline lets anyone join under any name but puts an OFFLINE/INSECURE banner in
        // every server log, so it is opt-in
        online_mode: !truthy(ctx, "offline"),
        motd: flag_value(ctx, "motd"),
        java: flag_value(ctx, "java"),
    }
}

/// What `cmdNew` prints after a server is made.
pub fn print_created(ctx: &mut Ctx<'_>, made: &Made) {
    ctx.out.line(&format!("Created instance \"{}\"", made.name));
    ctx.out.line(&made_table(
        made,
        &["directory:", "jar:", "memory:", "port:", "rcon port:"],
    ));
    ctx.out.line("");
    if !made.eula_accepted {
        ctx.out
            .line("EULA is NOT accepted. The server will refuse to start until you either");
        ctx.out.line(&format!(
            "  set eula=true in {}",
            jspath::join(&[&made.text("dir"), "eula.txt"])
        ));
        ctx.out.line("  (see https://aka.ms/MinecraftEULA)");
    } else {
        ctx.out
            .line(&format!("Start it with: spawnloft start {}", made.name));
    }
}

pub fn clone(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let pos = &ctx.args.positional;
    let (src, dst) = match (pos.first(), pos.get(1)) {
        (Some(s), Some(d)) if !s.is_empty() && !d.is_empty() => (s.clone(), d.clone()),
        _ => {
            return Err(Failure::user(
                "clone requires a source and a destination: spawnloft clone <src> <new-name>",
            ));
        }
    };
    let memory = match flag_value(ctx, "memory") {
        // the source's own, read before anything else (an absent one is the default)
        Value::Null => registry::lookup(registry_file(ctx), &src)?.get("memory").cloned(),
        v => Some(v),
    };
    let motd = match flag_value(ctx, "motd") {
        Value::Null => json!(format!("{dst} (clone of {src})")),
        v => v,
    };
    let o = NewOptions {
        from: json!(src),
        with_worlds: truthy(ctx, "withWorlds"),
        memory,
        port: number_flag(ctx, "port"),
        // the source already accepted it
        accept_eula: ctx.args.get("acceptEula") != Some(&Flag::Bool(false)),
        motd,
        ..NewOptions::default()
    };
    let made = create::new_instance(ctx.layout, &cli(), &dst, o)?;
    let worlds = if truthy(ctx, "withWorlds") {
        " (with worlds)"
    } else {
        " (fresh worlds)"
    };
    ctx.out.line(&format!("Cloned \"{src}\" -> \"{dst}\"{worlds}"));
    ctx.out
        .line(&made_table(&made, &["directory:", "port:", "rcon port:"]));
    ctx.out.line("");
    ctx.out.line(&format!("Start it with: spawnloft start {dst}"));
    Ok(())
}

pub fn adopt(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let pos = &ctx.args.positional;
    let (name, dir) = match (pos.first(), pos.get(1)) {
        (Some(n), Some(d)) if !n.is_empty() && !d.is_empty() => (n.clone(), d.clone()),
        _ => {
            return Err(Failure::user(
                "adopt requires a name and a directory: spawnloft adopt <name> <server-dir>",
            ));
        }
    };
    let made = create::adopt_instance(
        ctx.layout,
        &cli(),
        &name,
        &dir,
        &flag_value(ctx, "jar"),
        &flag_or(ctx, "memory", "4G"),
        &flag_value(ctx, "java"),
    )?;
    ctx.out.line(&format!("Adopted \"{}\"", made.name));
    ctx.out.line(&made_table(
        &made,
        &["directory:", "jar:", "memory:", "port:", "rcon port:"],
    ));
    Ok(())
}

pub fn templates(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let pos = &ctx.args.positional;
    if pos.first().map(String::as_str) == Some("save") {
        let (inst_name, tpl) = match (pos.get(1), pos.get(2)) {
            (Some(i), Some(t)) if !i.is_empty() && !t.is_empty() => (i.clone(), t.clone()),
            _ => {
                return Err(Failure::user(
                    "usage: spawnloft templates save <instance> <template-name>",
                ));
            }
        };
        let inst = registry::lookup(registry_file(ctx), &inst_name)?;
        let dest = create::save_template(ctx.layout, &inst, &tpl, truthy(ctx, "withWorlds"))?;
        ctx.out.line(&format!("Saved template \"{tpl}\" -> {dest}"));
        return Ok(());
    }
    let tpls = create::list_templates(&ctx.layout.templates_dir)?;
    if tpls.is_empty() {
        ctx.out
            .line("No templates. Create one from an existing instance:");
        ctx.out
            .line("  spawnloft templates save <instance> <template-name>");
        return Ok(());
    }
    // String(c ?? '') per cell, `x ?? '-'` where the listing says so
    let cell = |v: Option<&Value>| match v {
        None | Some(Value::Null) => String::new(),
        other => js::string(other),
    };
    let or_dash = |v: Option<&Value>| match v {
        None | Some(Value::Null) => "-".to_string(),
        other => js::string(other),
    };
    let mut rows = vec![["NAME", "JAR", "WORLDS", "FROM"].map(String::from).to_vec()];
    for t in &tpls {
        rows.push(vec![
            cell(t.get("name")),
            or_dash(t.get("jar")),
            if js::truthy(t.get("includesWorlds")) {
                "yes"
            } else {
                "no"
            }
            .into(),
            or_dash(t.get("sourceInstance")),
        ]);
    }
    ctx.out.line(&text::table(&rows));
    Ok(())
}

pub fn jars(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let pos = &ctx.args.positional;
    if pos.first().map(String::as_str) == Some("import") {
        let Some(src) = pos.get(1).filter(|s| !s.is_empty()).cloned() else {
            return Err(Failure::user(
                "usage: spawnloft jars import <path-to-jar> [--as <name>]",
            ));
        };
        let dest = create::import_jar(&ctx.layout.jars_dir, &src, &flag_value(ctx, "as"))?;
        ctx.out.line(&format!("Imported {dest}"));
        return Ok(());
    }
    let jars = create::list_jars(&ctx.layout.jars_dir)?;
    if jars.is_empty() {
        ctx.out
            .line("No jars stored. Import one with: spawnloft jars import <path-to-jar>");
        return Ok(());
    }
    let mut rows = vec![["NAME", "SIZE", "ADDED"].map(String::from).to_vec()];
    for j in &jars {
        let added = jsdate::to_iso(j.mtime_ms)
            .map(|s| s[..10].to_string())
            .unwrap_or_default();
        rows.push(vec![j.name.clone(), j.size_human(), added]);
    }
    ctx.out.line(&text::table(&rows));
    Ok(())
}

pub fn launchers(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let reg = registry_file(ctx).to_path_buf();
    // every name is looked up before anything is written
    let targets = if ctx.args.positional.is_empty() {
        registry::list_instances(&reg)?
    } else {
        ctx.args
            .positional
            .iter()
            .map(|n| registry::lookup(&reg, n))
            .collect::<Result<Vec<_>, _>>()?
    };
    for inst in &targets {
        let files = create::write_launchers(&inst.name, inst.get("dir"))?;
        ctx.out.line(&format!("{}: {}", inst.name, files.join(", ")));
    }
    ctx.out.line("");
    ctx.out
        .line("Double-click start.bat in an instance folder to run it with a console attached.");
    Ok(())
}

pub fn reveal(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "reveal")?.to_string();
    let opened = manage::reveal(ctx.layout, &name, None, None)?;
    ctx.out.line(&format!("Opening {opened}"));
    Ok(())
}

pub fn rebuild(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "rebuild")?.to_string();
    if !truthy(ctx, "yes") {
        return Err(Failure::user(format!(
            "rebuild deletes the worlds in \"{name}\". Re-run with --yes to confirm.\n  Add --wipe-plugins to reset plugins too. A snapshot is taken first unless --no-snapshot."
        )));
    }
    let res = manage::rebuild(
        ctx.layout,
        &cli(),
        &name,
        !truthy(ctx, "wipePlugins"),
        // the parser turns --no-snapshot into { snapshot: false }
        ctx.args.get("snapshot") != Some(&Flag::Bool(false)),
    )?;
    if let Some(s) = &res.snapshot {
        ctx.out.line(&format!("Snapshot: {s}"));
    }
    let removed = if res.removed.is_empty() {
        "(nothing to remove)".to_string()
    } else {
        res.removed.join(", ")
    };
    ctx.out.line(&format!("Rebuilt \"{name}\" — removed: {removed}"));
    ctx.out.line(if res.kept_plugins {
        "Plugins kept."
    } else {
        "Plugins wiped."
    });
    Ok(())
}
