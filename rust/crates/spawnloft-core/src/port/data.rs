//! `data move|status|finish|rollback` (C6), as `cmdData` in mcctl.mjs answers it, over
//! spawnloft-lib's `data_move`: the data folder moved and a link left where it was.

use std::cell::RefCell;

use serde_json::{Map, Value, json};

use spawnloft_lib::data_move::{self, Plan, RealEnv};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::schedule::Sched;
use spawnloft_lib::{jsjson, text};

use super::args::Flag;
use super::lifecycle::cli;
use super::{Ctx, check_flags};

const USAGE: &str = "Usage: spawnloft data move <folder> [--yes] [--thorough] [--set-aside-private-copies] | status | finish [--yes] | rollback";

/// `n.toLocaleString()` in English: thousands grouped with commas.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn bytes(n: u64) -> String {
    text::human_bytes(Some(n as f64))
}

fn is_true(ctx: &Ctx<'_>, name: &str) -> bool {
    ctx.args.get(name) == Some(&Flag::Bool(true))
}

/// `envelope('data', data, { error })` as `cmdData` writes it: no `type`, unlike a thrown error's.
fn envelope(data: Value, error: Option<Value>) -> String {
    let mut env = Map::new();
    env.insert("schemaVersion".into(), json!(1));
    env.insert("command".into(), json!("data"));
    env.insert("ok".into(), json!(error.is_none()));
    env.insert("data".into(), data);
    if let Some(e) = error {
        env.insert("error".into(), e);
    }
    format!("{}\n", jsjson::stringify(&Value::Object(env)))
}

pub fn data(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    check_flags(ctx.args, &["json", "yes", "thorough", "setAsidePrivateCopies"])?;
    let positional = ctx.args.positional.clone();
    let (sub, args) = match positional.split_first() {
        Some((s, a)) => (Some(s.as_str()), a),
        None => (None, &[][..]),
    };
    let root = ctx.layout.data_root.clone();
    let json = is_true(ctx, "json");
    let sched = Sched::new(&ctx.layout.data_root, &ctx.layout.run_dir, cli());
    let env = RealEnv {
        layout: ctx.layout,
        sched: &sched,
    };
    match sub {
        Some("move") => {
            let [dest] = args else {
                return Err(Failure::usage(USAGE));
            };
            move_cmd(ctx, &root, dest, json, &env)
        }
        Some("status") => {
            if !args.is_empty() {
                return Err(Failure::usage(USAGE));
            }
            status(ctx, &root, json)
        }
        Some("finish") => {
            if !args.is_empty() {
                return Err(Failure::usage(USAGE));
            }
            finish(ctx, &root)
        }
        Some("rollback") => {
            if !args.is_empty() {
                return Err(Failure::usage(USAGE));
            }
            let notes = data_move::rollback_move(&root, &env)?;
            ctx.out.line("Put back. The data folder is where it was.");
            for n in notes {
                ctx.out.line(&format!("  note: {n}"));
            }
            Ok(())
        }
        _ => Err(Failure::usage(USAGE)),
    }
}

fn move_cmd(ctx: &mut Ctx<'_>, root: &str, dest: &str, json: bool, env: &RealEnv<'_>) -> Result<(), Failure> {
    let dry_run = !is_true(ctx, "yes");
    let thorough = is_true(ctx, "thorough");
    let aside = is_true(ctx, "setAsidePrivateCopies");
    let out = RefCell::new(&mut *ctx.out);
    let mut last_shown = 0i64;
    let mut on_step = |step: &str| {
        if !json {
            out.borrow_mut().line(&format!("  {step}..."));
        }
    };
    let mut on_progress = |p: spawnloft_lib::tree::Progress| {
        let now = spawnloft_lib::time::now_ms();
        if now - last_shown < 2000 {
            return;
        }
        last_shown = now;
        out.borrow_mut().line(&format!(
            "  copied {} of {} files ({} of {})",
            grouped(p.files),
            grouped(p.total_files),
            bytes(p.bytes),
            bytes(p.total_bytes)
        ));
    };
    let (plan, moved) = data_move::move_data(
        root,
        dest,
        dry_run,
        thorough,
        false,
        aside,
        &mut on_step,
        if json { None } else { Some(&mut on_progress) },
        env,
    )?;
    let out = out.into_inner();
    if json {
        let result = match &moved {
            Some(r) => json!({
                "from": r.from,
                "to": r.to,
                "mode": r.mode,
                "parked": r.parked,
                "privateAside": r.private_aside.iter().map(|(f, t)| json!({ "from": f, "to": t })).collect::<Vec<_>>(),
                "notes": r.notes,
                "seconds": jsjson::num(r.seconds),
            }),
            None => Value::Null,
        };
        let data = json!({
            "action": "move",
            "executed": moved.is_some(),
            "from": plan.from,
            "to": plan.to,
            "mode": plan.mode,
            "files": plan.stats.map(|s| s.files),
            "bytes": plan.stats.map(|s| s.bytes),
            "problems": plan.problems,
            "warnings": plan.warnings,
            "result": result,
        });
        let error = (!plan.ok).then(|| {
            json!({ "code": "CHECK_FAILED", "message": format!("{} problem(s) stop the move", plan.problems.len()) })
        });
        out.print(&envelope(data, error));
        if !plan.ok {
            out.set_code(1);
        }
        return Ok(());
    }
    let Some(r) = moved else {
        show_plan(out, &plan);
        return Ok(());
    };
    out.line("");
    out.line(&format!(
        "Moved in {}s. The data is now at {}, and {} is a link to it.",
        spawnloft_lib::js::number_to_string(r.seconds),
        r.to,
        r.from
    ));
    if let Some(parked) = &r.parked {
        out.line(&format!(
            "The original is parked at {parked}. When you have checked that everything works,"
        ));
        out.line("`spawnloft data finish` deletes it.");
    }
    for (from, to) in &r.private_aside {
        out.line(&format!("Renamed the private copy {from} to {to}."));
    }
    for n in &r.notes {
        out.line(&format!("  note: {n}"));
    }
    out.line("Open the SpawnLoft app again.");
    Ok(())
}

fn show_plan(out: &mut super::output::Out, plan: &Plan) {
    out.line("Move the data folder");
    let how = if plan.mode == "rename" {
        "rename it: same drive, instant, nothing is copied"
    } else {
        "copy it, check the copy, then park the original: another drive"
    };
    let size = match plan.stats {
        Some(s) => format!("{} files, {}", grouped(s.files), bytes(s.bytes)),
        None => "-".into(),
    };
    let rows = vec![
        vec!["from:".to_string(), plan.from.clone()],
        vec!["to:".to_string(), plan.to.clone()],
        vec!["how:".to_string(), how.to_string()],
        vec!["size:".to_string(), size],
    ];
    out.line(&text::table(&rows));
    out.line("A link is left at the old path, so every path SpawnLoft has stored stays true.");
    for note in &plan.warnings {
        out.line(&format!("  note: {note}"));
    }
    if !plan.ok {
        out.line("");
        out.line("Cannot move yet:");
        for p in &plan.problems {
            out.line(&format!("  - {p}"));
        }
        out.set_code(1);
        return;
    }
    out.line("");
    out.line("Nothing was changed. Run it again with --yes to move the data.");
}

fn status(ctx: &mut Ctx<'_>, root: &str, json: bool) -> Result<(), Failure> {
    let s = data_move::move_status(root)?;
    if json {
        let data = json!({
            "action": "status",
            "root": s.root,
            "isLink": s.link.is_link,
            "target": s.link.target,
            "dangling": s.link.dangling,
            "move": s.journal,
            "leftovers": s.leftovers.iter().map(|(p, b)| json!({ "path": p, "bytes": b })).collect::<Vec<_>>(),
        });
        ctx.out
            .print(&super::output::json_line("data", Some(&data), None));
        return Ok(());
    }
    let is = if !s.link.exists {
        "missing".to_string()
    } else if s.link.is_link {
        format!("a link to {}", s.link.target.as_deref().unwrap_or("(unreadable)"))
    } else {
        "an ordinary folder".to_string()
    };
    let rows = vec![
        vec!["data folder:".to_string(), s.root.clone()],
        vec!["is:".to_string(), is],
    ];
    ctx.out.line(&text::table(&rows));
    if s.link.is_link && s.link.dangling {
        ctx.out.line("");
        ctx.out.line(&format!(
            "The link leads to {}, which is not there. If that is a drive, plug it in or restore the folder.",
            s.link.target.as_deref().unwrap_or("null")
        ));
    }
    if let Some(j) = &s.journal {
        let step = spawnloft_lib::js::string(j.get("step"));
        ctx.out.line("");
        ctx.out.line(&format!(
            "Last move: {} -> {}, {}.",
            spawnloft_lib::js::string(j.get("from")),
            spawnloft_lib::js::string(j.get("to")),
            if step == "done" {
                "finished".to_string()
            } else {
                format!("stopped at \"{step}\"")
            }
        ));
        if step != "done" {
            ctx.out.line("`spawnloft data rollback` puts everything back.");
        }
    }
    for (p, b) in &s.leftovers {
        let size = b.map(|b| format!(" ({})", bytes(b))).unwrap_or_default();
        ctx.out.line(&format!(
            "Parked original: {p}{size}; `spawnloft data finish` deletes it."
        ));
    }
    Ok(())
}

fn finish(ctx: &mut Ctx<'_>, root: &str) -> Result<(), Failure> {
    let s = data_move::move_status(root)?;
    let parked = data_move::parked_of(&s);
    if s.journal
        .as_ref()
        .is_none_or(|j| !spawnloft_lib::js::truthy(Some(j)))
    {
        return Err(Failure::user(format!("no move is recorded for {}", s.root)));
    }
    if !is_true(ctx, "yes") {
        let line = match &parked {
            Some(p) => {
                let size = s
                    .leftovers
                    .first()
                    .and_then(|(_, b)| *b)
                    .map(|b| format!(" ({})", bytes(b)))
                    .unwrap_or_default();
                format!(
                    "This deletes the original, parked at {p}{size}. The data now lives at {}.",
                    spawnloft_lib::js::string(s.journal.as_ref().and_then(|j| j.get("to")))
                )
            }
            None => "There is no parked original to delete (the move was a rename); this only clears the record of it.".into(),
        };
        ctx.out.line(&line);
        ctx.out.line("Run it again with --yes to go ahead.");
        return Ok(());
    }
    let (parked, removed) = data_move::finish_move(root)?;
    match parked {
        Some(p) => ctx.out.line(&format!("Deleted {p} ({}).", bytes(removed))),
        None => ctx.out.line("Cleared the record of the move."),
    }
    Ok(())
}
