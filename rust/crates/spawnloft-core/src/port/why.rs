//! `why <name>` (and `diagnostics`): `cmdWhy` and `printFindings` in mcctl.mjs.

use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::{diagnose, registry, supervisor};

use super::Ctx;
use super::output::{diagnose_context, dir_text};

/// `printFindings(name)`: the console's known failure shapes as advice; how many there were.
pub fn print_findings(ctx: &mut Ctx<'_>, name: &str) -> Result<usize, Failure> {
    let inst = registry::lookup(Path::new(&ctx.layout.registry_file), name)?;
    let lines = supervisor::tail_log(Path::new(&ctx.layout.console_log(name)), 400.0)?;
    let findings = diagnose::diagnose(&lines, &diagnose_context(&inst));
    for f in &findings {
        ctx.out.line("");
        ctx.out.line(&format!(">> {}", f.title));
        ctx.out.line(&format!("   {}", f.advice));
    }
    Ok(findings.len())
}

pub fn why(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "why")?.to_string();
    let registry_file = Path::new(&ctx.layout.registry_file);
    let inst = registry::lookup(registry_file, &name)?;
    let found = print_findings(ctx, &name)?;
    let dir = dir_text(&inst)?;
    if found == 0 {
        ctx.out
            .line("Nothing SpawnLoft recognises in the recent console. The last lines of the log are the");
        ctx.out.line(&format!(
            "next place to look: spawnloft logs {name} -n 60 --grep \" ERROR]| WARN]|Exception\""
        ));
    }
    let (crash_dir, reports) = diagnose::crash_reports(&dir, 5)?;
    if !reports.is_empty() {
        ctx.out.line("");
        ctx.out.line(&format!(
            "Crash reports ({} newest, in {crash_dir}):",
            reports.len()
        ));
        for r in &reports {
            let d = match r.description.as_deref() {
                Some(d) if !d.is_empty() => format!("- {d}"),
                _ => String::new(),
            };
            ctx.out.line(&format!("  {}  {d}", r.file));
        }
    }
    Ok(())
}
