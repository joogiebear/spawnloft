//! The installer's and uninstaller's commands (C6): `repair` and `uninstall`, as `cmdRepair` and
//! `cmdUninstall` in mcctl.mjs answer them, over spawnloft-lib's `relocate` and `uninstall`.
//! `repair --quiet` is the installer's form (design 2.3 step 8): nothing printed, a line in
//! `run/handover.log`, and the exit code.

#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};

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
/// `repair --quiet`, the installer's form: everything, a failure included, goes to handover.log
/// (the installer shows no output), and a failure is exit 1.
pub fn quiet_log(message: &str) {
    let log = Log::open(Some(&Files::new(&paths::resolve_data_root()).log()), false);
    log.line(&format!("repair: {message}"));
}

pub fn repair(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let quiet = flag(ctx, "quiet");
    let checked = check_flags(ctx.args, &["json", "quiet"]).and_then(|()| {
        if ctx.args.positional.is_empty() {
            Ok(())
        } else {
            Err(Failure::usage("Usage: spawnloft repair [--json]"))
        }
    });
    if quiet && let Err(e) = &checked {
        quiet_log(e.message());
        ctx.out.set_code(1);
        return Ok(());
    }
    checked?;
    #[cfg(windows)]
    if let Some(note) = node_leftovers() {
        if quiet {
            quiet_log(note);
        } else if !flag(ctx, "json") {
            ctx.out
                .line(&format!("{}{}.", note[..1].to_uppercase(), &note[1..]));
        }
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
    if quiet {
        match result {
            Ok(r) => quiet_log(&format!(
                "rewrote {} task shim(s) and the launchers of {} server(s) for {}",
                r.shims,
                r.launchers,
                text("exe")
            )),
            Err(e) => {
                quiet_log(e.message());
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

/// What [`remove_node_leftovers`] found.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum Leftovers {
    /// Neither folder is there.
    None,
    /// Both are gone.
    Removed,
    /// A file in them could not be deleted (a node.exe still running), so they stay.
    Held,
}

/// The `resources` folder of an installed copy, from the running binary's path
/// (`<install>\resources\bin\spawnloft-core.exe`), or `None` when the binary does not sit there
/// (a build run from `rust\target`).
#[cfg(any(windows, test))]
fn resources_of(exe: &Path) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let resources = bin.parent()?;
    let named = |p: &Path, name: &str| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name));
    (named(bin, "bin") && named(resources, "resources")).then(|| resources.to_path_buf())
}

/// The `resources\runtime` (the bundled Node) and `resources\core` (the Node core) that 2.0
/// builds before C10 shipped (rust/PLAN-CORE-PORT.md sections 5.1 and 7). An update leaves what
/// the new package does not list, and the installer removes them itself unless a Node process
/// started before the update still holds its node.exe; this finishes that job. As the installer
/// does (installer.nsi SPAWNLOFT_REMOVE_NODE): every node.exe first, and when one cannot be
/// deleted both folders stay, for a later repair or install. A failed delete is never an error,
/// and nothing outside the two folders is touched.
#[cfg(any(windows, test))]
fn remove_node_leftovers(resources: &Path) -> Leftovers {
    let runtime = resources.join("runtime");
    let core = resources.join("core");
    if !runtime.exists() && !core.exists() {
        return Leftovers::None;
    }
    let mut held = false;
    for entry in std::fs::read_dir(&runtime).into_iter().flatten().flatten() {
        let exe = entry.path().join("node.exe");
        if exe.is_file() && std::fs::remove_file(&exe).is_err() {
            held = true;
        }
    }
    if !held {
        let _ = std::fs::remove_dir_all(&runtime);
        let _ = std::fs::remove_dir_all(&core);
    }
    if runtime.exists() || core.exists() {
        Leftovers::Held
    } else {
        Leftovers::Removed
    }
}

/// [`remove_node_leftovers`] beside the running binary, as the line repair logs or prints.
#[cfg(windows)]
fn node_leftovers() -> Option<&'static str> {
    let resources = resources_of(&std::env::current_exe().ok()?)?;
    match remove_node_leftovers(&resources) {
        Leftovers::None => None,
        Leftovers::Removed => {
            Some("removed resources\\runtime and resources\\core, which an older build left")
        }
        Leftovers::Held => {
            Some("resources\\runtime and resources\\core stay: a node.exe in them is still running")
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("sl-port-maint-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn only_an_installed_copy_has_a_resources_folder_to_clean() {
        let base = Path::new("C:/Users/v/AppData/Local/Programs/SpawnLoft");
        let exe = base.join("resources").join("bin").join("spawnloft-core.exe");
        assert_eq!(resources_of(&exe), Some(base.join("resources")));
        let upper = base.join("Resources").join("BIN").join("spawnloft-core.exe");
        assert_eq!(resources_of(&upper), Some(base.join("Resources")));
        for other in [
            "rust/target/release/spawnloft-core.exe",
            "resources/spawnloft-core.exe",
            "spawnloft-core.exe",
        ] {
            assert_eq!(resources_of(Path::new(other)), None, "{other}");
        }
    }

    #[test]
    fn the_old_runtime_and_core_go_and_nothing_else() {
        let resources = scratch("leftovers");
        for dir in [
            "runtime/node-24.22.3",
            "runtime/old-20261120-101500",
            "core/src",
            "bin",
        ] {
            std::fs::create_dir_all(resources.join(dir)).unwrap();
        }
        for file in [
            "runtime/runtime.json",
            "runtime/node-24.22.3/node.exe",
            "runtime/node-24.22.3/LICENSE",
            "runtime/old-20261120-101500/node.exe",
            "core/mcctl.mjs",
            "core/package.json",
            "core/src/ui.mjs",
            "bin/spawnloft-core.exe",
            "bin/spawnloft.cmd",
            "LICENSE",
        ] {
            std::fs::write(resources.join(file), "x").unwrap();
        }
        assert_eq!(remove_node_leftovers(&resources), Leftovers::Removed);
        assert!(!resources.join("runtime").exists() && !resources.join("core").exists());
        for kept in ["bin/spawnloft-core.exe", "bin/spawnloft.cmd", "LICENSE"] {
            assert!(resources.join(kept).is_file(), "{kept} was touched");
        }
        // the next repair finds nothing to do
        assert_eq!(remove_node_leftovers(&resources), Leftovers::None);
        // a core folder left alone (its runtime already gone) goes too
        std::fs::create_dir_all(resources.join("core")).unwrap();
        std::fs::write(resources.join("core/mcctl.mjs"), "x").unwrap();
        assert_eq!(remove_node_leftovers(&resources), Leftovers::Removed);
        std::fs::remove_dir_all(&resources).unwrap();
    }
}
