//! The installer's and uninstaller's commands (C6): `repair` and `uninstall`, as `cmdRepair` and
//! `cmdUninstall` in mcctl.mjs answer them, over spawnloft-lib's `relocate` and `uninstall`.
//! `repair --quiet` is the installer's form (design 2.3 step 8): nothing printed, a line in
//! `run/handover.log`, and the exit code.

use serde_json::{Value, json};

use spawnloft_lib::failure::Failure;
use spawnloft_lib::handover::{Files, Log};
use spawnloft_lib::schedule::Sched;
use spawnloft_lib::{paths, relocate, uninstall};

use super::args::Flag;
use super::lifecycle::cli;
use super::{Ctx, check_flags, output};

fn sched(ctx: &Ctx<'_>) -> Sched {
    Sched::new(&ctx.layout.data_root, &ctx.layout.run_dir, cli())
}

fn flag(ctx: &Ctx<'_>, name: &str) -> bool {
    ctx.args.get(name).is_some_and(Flag::truthy)
}

/// `cmdRepair`: every task shim and every server's launchers rewritten for the program running
/// this command, whether or not it looks moved. Touches no OS scheduler entry (those hold the
/// shim's path, which does not change) and no server.
pub fn repair(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    check_flags(ctx.args, &["json", "quiet"])?;
    if !ctx.args.positional.is_empty() {
        return Err(Failure::usage("Usage: spawnloft repair [--json]"));
    }
    let signature = relocate::runtime_signature();
    let marker = relocate::marker_file(ctx.layout);
    let result = relocate::repair_after_move(ctx.layout, &sched(ctx), &marker, &signature, true);
    let text = |k: &str| {
        signature
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    if flag(ctx, "quiet") {
        let log = Log::open(Some(&Files::new(&paths::resolve_data_root()).log()), false);
        match result {
            Ok(r) => log.line(&format!(
                "repair: rewrote {} task shim(s) and the launchers of {} server(s) for {}",
                r.shims,
                r.launchers,
                text("exe")
            )),
            Err(e) => {
                log.line(&format!("repair: {}", e.message()));
                ctx.out.set_code(1);
            }
        }
        return Ok(());
    }
    let r = result?;
    if flag(ctx, "json") {
        let data = json!({
            "shims": r.shims,
            "launchers": r.launchers,
            "runtime": text("exe"),
            "root": text("root"),
        });
        ctx.out.print(&output::json_line("repair", Some(&data), None));
        return Ok(());
    }
    ctx.out.line(&format!(
        "Rewrote {} task shim(s) and the launchers of {} server(s) for {}.",
        r.shims,
        r.launchers,
        text("exe")
    ));
    Ok(())
}

/// `cmdUninstall`: run by the uninstaller. Stops servers, removes scheduled tasks, and with
/// `--data` deletes what SpawnLoft created.
pub fn uninstall(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    if !flag(ctx, "yes") {
        return Err(Failure::user(
            "uninstall stops every server and removes every scheduled task; with --data it also deletes\n  \
             the servers this program created, jars, backups, templates and settings.\n  \
             Add --yes to go ahead. The desktop app's uninstaller runs this for you.",
        ));
    }
    let data = flag(ctx, "data");
    let sched = sched(ctx);
    let layout = ctx.layout;
    let res = {
        let out = &mut *ctx.out;
        uninstall::run(layout, &cli(), &sched, data, &mut |l| out.line(l))?
    };
    if !res.stopped.is_empty() {
        ctx.out.line(&format!("Stopped: {}", res.stopped.join(", ")));
    }
    ctx.out.line(if res.tasks {
        "Scheduled tasks removed."
    } else {
        "Scheduled tasks could not all be removed."
    });
    if data {
        ctx.out.line(&format!("Deleted {} item(s).", res.removed.len()));
    }
    for f in &res.failed {
        ctx.out.line(&format!("  !  {f}"));
    }
    if !res.failed.is_empty() {
        ctx.out.set_code(1);
    }
    Ok(())
}
