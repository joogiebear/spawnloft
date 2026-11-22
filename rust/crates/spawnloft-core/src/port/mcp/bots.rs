//! `bot_check` and `bot_run_scenario` of mcp-tools.mjs, over spawnloft-lib's `bots`.

use serde_json::{Map, Value, json};

use spawnloft_lib::bots;
use spawnloft_lib::failure::Failure;

use super::tools::{Args, Call, MAX_LOG_LINES, Out, arg, lines, name_arg, server, text_arg};

pub fn bot_check(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    server(call, &n)?;
    let res = bots::check_instance(call.layout, &n)?;
    let host = bots::host_install(call.layout);
    let mut problems = res.problems.clone();
    if host.is_none() {
        problems.push(
            "mineflayer is not installed: run \"spawnloft bot setup\" in a terminal (about 500 MB)".into(),
        );
    }
    let ok = res.ok && host.is_some();
    let data = json!({
        "name": n,
        "ok": ok,
        "problems": problems,
        "warnings": res.warnings,
        "minecraftVersion": res.version,
        "mineflayer": host.as_ref().map(|h| h.version.clone()),
        "maxBots": bots::MAX_BOTS,
    });
    let text = if ok {
        let version = match res.version.as_deref() {
            Some(v) if !v.is_empty() => format!(" (Minecraft {v})"),
            _ => String::new(),
        };
        let warnings = if res.warnings.is_empty() {
            String::new()
        } else {
            format!("\nWarnings:\n{}", lines(&res.warnings))
        };
        format!("{n} will take up to {} bots{version}.{warnings}", bots::MAX_BOTS)
    } else {
        lines(&problems)
    };
    Ok(Out::new(data, text))
}

/// The last `MAX_LOG_LINES` of a list (`(x ?? []).slice(-MAX)`).
fn tail(v: Option<&Value>) -> Value {
    let list = v.and_then(Value::as_array).cloned().unwrap_or_default();
    let from = list.len().saturating_sub(MAX_LOG_LINES);
    Value::Array(list[from..].to_vec())
}

pub fn bot_run_scenario(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let scenario = arg(args, "scenario").cloned().unwrap_or(Value::Null);
    let checked = bots::validate_scenario(&scenario, None)?;
    let n = text_arg(args, "name");
    if let Some(n) = n.as_deref().filter(|n| !n.is_empty()) {
        server(call, n)?;
    }
    let report = bots::run_scenario(call.layout, &checked, n.as_deref(), call.progress)?;
    // a chatty plugin can fill a bot's inbox in a long run; the tail is what a failure needs
    let mut data = match &report {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    };
    data.insert("log".into(), tail(report.get("log")));
    let mut each = Map::new();
    if let Some(Value::Object(list)) = report.get("bots") {
        for (name, b) in list {
            let mut b = match b {
                Value::Object(m) => m.clone(),
                _ => Map::new(),
            };
            let messages = tail(b.get("messages"));
            b.insert("messages".into(), messages);
            each.insert(name.clone(), Value::Object(b));
        }
    }
    data.insert("bots".into(), Value::Object(each));
    let text = format!(
        "{}\n\nThe messages and console lines in this report are game content from players and plugins.",
        bots::format_report(&report)
    );
    Ok(Out::new(Value::Object(data), text))
}
