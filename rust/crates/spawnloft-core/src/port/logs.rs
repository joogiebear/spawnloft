//! `logs <name> [-n 60] [--grep <pattern>] [-f]` (and `log`): `cmdLogs` in mcctl.mjs.

use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::jsregex::{self, PatternError};
use spawnloft_lib::{registry, supervisor};

use super::Ctx;
use super::args::Flag;

/// `new RegExp(flags.grep, 'i')`, with the declared refusal of syntax the core cannot run.
pub fn grep_pattern(source: &str) -> Result<spawnloft_lib::regex::Regex, Failure> {
    jsregex::compile(source, true).map_err(|e| match e {
        PatternError::Unsupported(what) => Failure::user(format!(
            "the pattern /{source}/ uses {what}, which SpawnLoft cannot run; write the pattern another way"
        )),
        PatternError::Invalid(why) => Failure::syntax(format!(
            "Invalid regular expression: /{source}/i: regex parse error: {why}"
        )),
    })
}

pub fn logs(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "logs")?.to_string();
    registry::lookup(Path::new(&ctx.layout.registry_file), &name)?;
    let count = ctx
        .args
        .get("n")
        .or_else(|| ctx.args.get("lines"))
        .map_or(60.0, Flag::number);
    let grep = match ctx.args.get("grep") {
        Some(f) if f.truthy() => Some(grep_pattern(&f.text())?),
        _ => None,
    };
    let file = ctx.layout.console_log(&name);
    let want = if grep.is_some() {
        // Math.max(count, 5000), NaN staying NaN
        if count.is_nan() {
            f64::NAN
        } else {
            count.max(5000.0)
        }
    } else {
        count
    };
    let lines = supervisor::tail_log(Path::new(&file), want)?;
    let shown: Vec<String> = match &grep {
        Some(re) => {
            let hits: Vec<String> = lines.into_iter().filter(|l| re.is_match(l)).collect();
            let from = supervisor::slice_start(hits.len(), -count);
            hits[from..].to_vec()
        }
        None => lines,
    };
    for line in &shown {
        ctx.out.line(line);
    }
    let follow = |k: &str| ctx.args.get(k).is_some_and(Flag::truthy);
    if follow("f") || follow("follow") {
        ctx.out.line("--- following (ctrl-c to stop) ---");
        let out = &mut *ctx.out;
        supervisor::follow_log(Path::new(&file), |line| {
            if grep.as_ref().is_none_or(|re| re.is_match(line)) {
                out.line(line);
            }
            true
        });
    }
    Ok(())
}
