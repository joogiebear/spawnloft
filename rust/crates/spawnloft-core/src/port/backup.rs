//! Backups (C3): `backup` (and `snapshot`), `snapshots` (and `backups`), `restore`, `prune` and
//! `verify`: `cmdBackup` to `cmdVerify` in mcctl.mjs, over spawnloft-lib's `backup`.

use serde_json::{Value, json};
use std::path::Path;

use spawnloft_lib::backup::{self, Options, RestoreOptions, Snapshot};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::{control, js, supervisor, text, time};

use super::args::Flag;
use super::lifecycle::cli;
use super::output::json_line;
use super::{Ctx, check_flags, instance_name, require_name};

fn lookup(ctx: &Ctx<'_>, name: &str) -> Result<Instance, Failure> {
    registry::lookup(Path::new(&ctx.layout.registry_file), name)
}

/// `keepCount(value)`: only digits, at least 1.
fn keep_count(flag: &Flag) -> Result<f64, Failure> {
    match flag {
        Flag::Text(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            let n = js::string_to_number(s);
            if n >= 1.0 {
                return Ok(n);
            }
            Err(Failure::usage("--keep must be a positive whole number"))
        }
        _ => Err(Failure::usage("--keep must be a positive whole number")),
    }
}

/// A flag as the value Node keeps: text, or the `true`/`false` of a flag given bare.
fn flag_value(flag: &Flag) -> Value {
    match flag {
        Flag::Text(s) => json!(s),
        Flag::Bool(b) => json!(b),
    }
}

/// `array.join(', ')`: `null` (and `undefined`) as nothing.
fn join(list: &[Value], sep: &str) -> String {
    list.iter()
        .map(|v| match v {
            Value::Null => String::new(),
            Value::Array(a) => join(a, ","),
            v => js::string(Some(v)),
        })
        .collect::<Vec<_>>()
        .join(sep)
}

fn human(n: Option<&Value>) -> String {
    match n {
        None | Some(Value::Null) => "-".into(),
        Some(v) => text::human_bytes(Some(js::number(Some(v)))),
    }
}

pub fn backup(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let keep = ctx.args.get("keep").map(keep_count).transpose()?;
    let json = ctx.args.get("json") == Some(&Flag::Bool(true));
    if json {
        check_flags(ctx.args, &["json", "scope", "label", "keep", "flush"])?;
        instance_name(&ctx.args.positional, "backup")?;
        if let Some(s) = ctx.args.get("scope")
            && !matches!(s, Flag::Text(t) if backup::SCOPES.contains(&t.as_str()))
        {
            return Err(Failure::usage("Invalid backup --scope"));
        }
        if matches!(ctx.args.get("label"), Some(Flag::Bool(_))) {
            return Err(Failure::usage("--label requires a value"));
        }
        if matches!(ctx.args.get("flush"), Some(Flag::Text(_))) {
            return Err(Failure::usage("--flush does not take a value"));
        }
    }
    let name = require_name(&ctx.args.positional, "backup")?.to_string();
    let inst = lookup(ctx, &name)?;
    let scope = ctx
        .args
        .get("scope")
        .map_or_else(|| "standard".to_string(), Flag::text);
    let running = supervisor::is_running(ctx.layout, &name)?;
    let flush = ctx.args.get("flush") != Some(&Flag::Bool(false));

    // createSnapshot does the flush; this only narrates it
    if !json {
        if running && flush {
            ctx.out
                .line("Flushing world to disk (save-all), then snapshotting...");
        } else {
            ctx.out
                .line(&format!("Snapshotting \"{name}\" (scope: {scope})..."));
        }
    }
    let label = ctx.args.get("label").map_or(Value::Null, flag_value);
    let res = backup::create_snapshot(
        ctx.layout,
        &cli(),
        &inst,
        &Options {
            scope: scope.clone(),
            label,
            running,
            flush,
            ..Options::default()
        },
    )?;
    if json {
        let pruned = match keep {
            None => Vec::new(),
            Some(k) => backup::prune_snapshots(ctx.layout, &cli(), &name, k, None, None)?,
        };
        let data = json!({
            "instance": name, "path": res.file, "sizeBytes": res.size, "scope": scope,
            "members": res.members, "databases": res.databases,
            "databasesSkipped": res.databases_skipped, "skipped": res.skipped,
            "warnings": res.warnings, "mirrored": res.mirrored, "mirrorError": res.mirror_error,
            "flushed": res.flushed, "flushWarning": res.flush_warning,
            "saveOnWarning": res.save_on_warning,
            "pruned": pruned.iter().map(Snapshot::to_json).collect::<Vec<_>>(),
        });
        ctx.out.print(&json_line("backup", Some(&data), None));
        return Ok(());
    }
    ctx.out.line(&format!(
        "Wrote {} ({})",
        res.file,
        text::human_bytes(Some(res.size as f64))
    ));
    ctx.out.line(&format!("  included: {}", res.members.join(", ")));
    for d in &res.databases {
        ctx.out.line(&format!(
            "  database: {} on {} ({})",
            js::string(d.get("database")),
            js::string(d.get("service")),
            human(d.get("bytes"))
        ));
    }
    for d in &res.databases_skipped {
        ctx.out.line(&format!(
            "  WARNING: database {} on {} not included: {}",
            js::string(d.get("database")),
            js::string(d.get("service")),
            js::string(d.get("reason"))
        ));
    }
    for f in &res.skipped {
        ctx.out.line(&format!(
            "  WARNING: {f} not included: another program has it locked, usually the running server"
        ));
    }
    if let Some(w) = &res.flush_warning {
        ctx.out.line(&format!("  WARNING: {w}"));
    }
    if let Some(w) = &res.save_on_warning {
        ctx.out.line(&format!("  WARNING: {w}"));
    }
    if let Some(m) = &res.mirrored {
        ctx.out.line(&format!("  mirrored: {m}"));
    }
    if let Some(e) = &res.mirror_error {
        ctx.out.line(&format!("  WARNING: {e}"));
    }
    let tar_warnings: Vec<&String> = res
        .warnings
        .iter()
        .filter(|w| Some(*w) != res.flush_warning.as_ref() && Some(*w) != res.save_on_warning.as_ref())
        .filter(|w| {
            !res.skipped
                .iter()
                .any(|f| w.starts_with(&format!("{f} not included:")))
        })
        .filter(|w| {
            !res.databases_skipped.iter().any(|d| {
                w.starts_with(&format!(
                    "database {} on {} not included:",
                    js::string(d.get("database")),
                    js::string(d.get("service"))
                ))
            })
        })
        .collect();
    if !tar_warnings.is_empty() {
        ctx.out.line("  tar warnings (normal for a live server):");
        for w in tar_warnings {
            ctx.out.line(&format!("    {w}"));
        }
    }
    if let Some(k) = keep {
        let removed = backup::prune_snapshots(ctx.layout, &cli(), &name, k, None, None)?;
        if !removed.is_empty() {
            ctx.out.line(&format!(
                "Pruned {} old snapshot(s), keeping {}.",
                removed.len(),
                js::number_to_string(k)
            ));
        }
    }
    Ok(())
}

pub fn snapshots(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "snapshots")?.to_string();
    lookup(ctx, &name)?;
    let snaps = backup::list_snapshots(ctx.layout, &name)?;
    if snaps.is_empty() {
        ctx.out.line(&format!(
            "No snapshots for \"{name}\". Create one with: spawnloft backup {name}"
        ));
        return Ok(());
    }
    let mut rows = vec![["NAME", "SCOPE", "SIZE", "CREATED"].map(String::from).to_vec()];
    for s in &snaps {
        let created = time::iso(s.mtime_ms as i64).replacen('T', " ", 1);
        rows.push(vec![
            s.name.clone(),
            js::string(Some(&s.scope)),
            s.size_human(),
            created.chars().take(19).collect(),
        ]);
    }
    ctx.out.line(&text::table(&rows));
    Ok(())
}

pub fn restore(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "restore")?.to_string();
    let inst = lookup(ctx, &name)?;
    let state = ctx.layout.state_file(&name);
    if let Some(why) = control::active_block(Path::new(&state), &name, "restoring")? {
        return Err(Failure::user(why));
    }
    let reference = ctx.args.positional.get(1).map_or("latest", String::as_str);
    let snap = backup::resolve_snapshot(ctx.layout, &name, reference)?;

    if !ctx.args.get("yes").is_some_and(Flag::truthy) {
        let dir = backup::dir_of(&inst).unwrap_or_else(|_| js::string(inst.get("dir")));
        ctx.out.line(&format!("About to restore into {dir}:"));
        ctx.out.line(&format!(
            "  snapshot: {} ({}, scope {})",
            snap.name,
            snap.size_human(),
            js::string(Some(&snap.scope))
        ));
        let members = join(&snap.member_list("snap.members.join")?, ", ");
        ctx.out.line(&format!(
            "  overwrites: {}",
            if members.is_empty() {
                "(see manifest)"
            } else {
                &members
            }
        ));
        if let Value::Array(dbs) = &snap.databases {
            for d in dbs {
                ctx.out.line(&format!(
                    "  imports:    database {} on {} (needs \"{}\" running)",
                    js::string(d.get("database")),
                    js::string(d.get("service")),
                    js::string(d.get("service"))
                ));
            }
        }
        let check = backup::check_restorable(&snap)?;
        if !check.ok {
            ctx.out
                .line("  archive:    DOES NOT READ BACK - a restore would be refused");
            for p in &check.problems {
                ctx.out.line(&format!("              {p}"));
            }
            ctx.out.line("");
            ctx.out.line(&format!(
                "Choose an older snapshot; \"spawnloft verify {name} --all\" checks every one."
            ));
            ctx.out.set_code(1);
            return Ok(());
        }
        ctx.out.line("  archive:    reads back cleanly");
        ctx.out.line("");
        ctx.out
            .line("This overwrites existing files in place. Re-run with --yes to proceed.");
        ctx.out.set_code(1);
        return Ok(());
    }
    let res = backup::restore_snapshot(ctx.layout, &cli(), &inst, &snap, RestoreOptions::default())?;
    ctx.out
        .line(&format!("Restored {} into {}", res.restored, res.into));
    for d in &res.databases.imported {
        ctx.out.line(&format!(
            "  imported database {} into {}",
            js::string(d.get("database")),
            js::string(d.get("service"))
        ));
    }
    for d in &res.databases.skipped {
        ctx.out.line(&format!(
            "  WARNING: database {} not imported: {}",
            js::string(d.get("database")),
            js::string(d.get("reason"))
        ));
    }
    if !res.databases.skipped.is_empty() {
        ctx.out.set_code(1);
    }
    Ok(())
}

pub fn prune(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "prune")?.to_string();
    lookup(ctx, &name)?;
    let keep = match ctx.args.get("keep") {
        None => 10.0,
        Some(f) => keep_count(f)?,
    };
    let removed = backup::prune_snapshots(ctx.layout, &cli(), &name, keep, None, None)?;
    ctx.out.line(&if removed.is_empty() {
        "Nothing to prune.".to_string()
    } else {
        format!(
            "Removed {} snapshot(s), keeping the newest {}.",
            removed.len(),
            js::number_to_string(keep)
        )
    });
    Ok(())
}

/// Reads snapshots back to prove they restore; exits non-zero on a failure so a scheduled run is
/// noticed.
pub fn verify(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "verify")?.to_string();
    lookup(ctx, &name)?;
    let targets = if ctx.args.get("all").is_some_and(Flag::truthy) {
        backup::list_snapshots(ctx.layout, &name)?
    } else {
        let reference = ctx.args.positional.get(1).map_or("latest", String::as_str);
        vec![backup::resolve_snapshot(ctx.layout, &name, reference)?]
    };
    if targets.is_empty() {
        return Err(Failure::user(format!(
            "no snapshots exist for \"{name}\". Create one with: spawnloft backup {name}"
        )));
    }
    let mut failed = 0;
    for target in &targets {
        let (_, has_manifest, res) = backup::verify_snapshot(ctx.layout, &name, &target.name)?;
        if res.ok {
            ctx.out.line(&format!(
                "ok    {}  ({} entries, {})",
                target.name,
                res.entries,
                text::human_bytes(Some(res.size as f64))
            ));
            if !has_manifest {
                ctx.out.line(
                    "      no manifest beside it, so only the archive itself was checked, not its coverage",
                );
            }
        } else {
            failed += 1;
            ctx.out.line(&format!("FAIL  {}", target.name));
            for p in &res.problems {
                ctx.out.line(&format!("      {p}"));
            }
        }
    }
    if targets.len() > 1 {
        ctx.out.line("");
        ctx.out.line(&if failed > 0 {
            format!("{failed} of {} snapshots FAILED verification.", targets.len())
        } else {
            format!("All {} snapshots read back whole.", targets.len())
        });
    }
    if failed > 0 {
        ctx.out.set_code(1);
    }
    Ok(())
}
