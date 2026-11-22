//! `doctor` and `diag` (C6b): `cmdDoctor` and `cmdDiag` in mcctl.mjs, over spawnloft-lib's
//! `doctor` and `diag_bundle`.

use serde_json::{Value, json};

use spawnloft_lib::failure::Failure;
use spawnloft_lib::{diag_bundle, doctor, js, jspath, scrubber};

use super::args::Flag;
use super::output::json_line;
use super::{Ctx, check_flags, instance_name};

pub fn doctor(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    // only --json is checked: the text form takes whatever follows, as the Node core does
    let json = ctx.args.get("json").is_some_and(Flag::truthy);
    if json {
        check_flags(ctx.args, &["json"])?;
        if !ctx.args.positional.is_empty() {
            return Err(Failure::usage("Usage: spawnloft doctor --json"));
        }
    }
    let report = doctor::run(ctx.layout, !json)?;
    let problems = &report.problems;

    if json {
        let data = json!({ "healthy": problems.is_empty(), "notes": report.notes, "problems": problems });
        let mut line = json_line("doctor", Some(&data), None);
        if !problems.is_empty() {
            line = envelope_with_error(
                &data,
                json!({ "code": "CHECK_FAILED", "message": format!("{} environment problem(s) found", problems.len()) }),
            );
            ctx.out.set_code(1);
        }
        ctx.out.print(&line);
        return Ok(());
    }
    ctx.out.line("Environment");
    for n in &report.notes {
        ctx.out.line(&format!("  {n}"));
    }
    ctx.out.line("");
    if problems.is_empty() {
        ctx.out.line("No problems found.");
        return Ok(());
    }
    ctx.out.line(&format!("{} problem(s):", problems.len()));
    for p in problems {
        ctx.out.line(&format!("  - {p}"));
    }
    ctx.out.set_code(1);
    Ok(())
}

/// `jsonLine('doctor', data, { error })`: the envelope of a check that ran and found problems.
fn envelope_with_error(data: &Value, error: Value) -> String {
    let env = json!({
        "schemaVersion": 1,
        "command": "doctor",
        "ok": false,
        "data": data,
        "error": error,
    });
    format!("{}\n", spawnloft_lib::jsjson::stringify(&env))
}

/// A flag Node reads with `typeof flags.x !== 'string'`: its text, or `None` for a bare flag.
fn text_flag(f: Option<&Flag>) -> Option<Option<&str>> {
    f.map(|f| match f {
        Flag::Text(s) => Some(s.as_str()),
        Flag::Bool(_) => None,
    })
}

pub fn diag(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    check_flags(ctx.args, &["lines", "out", "json", "client"])?;
    let pos = &ctx.args.positional;
    let name = if pos.is_empty() {
        None
    } else {
        Some(instance_name(pos, "diag")?.to_string())
    };
    let mut lines = diag_bundle::TAIL_LINES;
    if let Some(given) = text_flag(ctx.args.get("lines")) {
        let n = given.map_or(f64::NAN, js::string_to_number);
        if given.is_none() || !n.is_finite() || n.fract() != 0.0 || n < 1.0 {
            return Err(Failure::user("--lines must be a positive whole number"));
        }
        lines = if n > 25000.0 { 25000 } else { n as usize };
    }
    let client = match text_flag(ctx.args.get("client")) {
        None => None,
        Some(None) => return Err(Failure::user("--client needs a profile name")),
        Some(Some(c)) => Some(c.to_string()),
    };
    // `!name && !flags.client`: an empty name is no name
    if name.as_deref().is_none_or(str::is_empty) && client.as_deref().is_none_or(str::is_empty) {
        return Err(Failure::usage(
            "Usage: spawnloft diag <server> [--client <profile>] [--lines N] [--out <dir>]",
        ));
    }
    let out = match text_flag(ctx.args.get("out")) {
        None => None,
        Some(None) => {
            return Err(Failure::user("--out needs a folder, for example --out ./reports"));
        }
        Some(Some(o)) => Some(o.to_string()),
    };
    let out_dir = match out.as_deref() {
        Some(o) if !o.is_empty() => jspath::resolve(o),
        _ => jspath::join(&[
            &ctx.layout.backups_dir,
            name.as_deref().unwrap_or("client"),
            "exports",
        ]),
    };
    let scrub = scrubber::scrubber(ctx.layout, false);
    let bundle = diag_bundle::build_bundle(ctx.layout, name.as_deref(), client.as_deref(), lines, &scrub)?;
    let written = diag_bundle::write_bundle(&bundle, &out_dir)?;
    if ctx.args.get("json").is_some_and(Flag::truthy) {
        let mut data = bundle.summary_section();
        data.insert("file".into(), json!(written.file));
        ctx.out
            .print(&json_line("diag", Some(&Value::Object(data)), None));
        return Ok(());
    }
    ctx.out.line(&bundle.summarise());
    ctx.out.line(&format!("Written: {}", written.file));
    Ok(())
}
