//! The read tools of `mcp-tools.mjs`: always offered, and none changes anything (a diagnostics
//! bundle is written only when asked for).

use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::LazyLock;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::jsregex::PatternError;
use spawnloft_lib::paths::Roots;
use spawnloft_lib::settings::{self, Layout};
use spawnloft_lib::{
    activity, backup, config_files, diag_bundle, diagnose, doctor, js, jsjson, players, plugin_actions,
    plugin_sources, plugins, private_copy, rcon, registry, supervisor, text, tick, upgrade,
};

use super::super::output::{crashes_json, dir_text, record_of};
use super::tools::{
    Args, Call, Out, Tool, bool_arg, instance, is_running, lines, name_arg, number_arg, obj, server, spread,
    text_arg,
};

const UNRECOGNISED_JAR: &str = "is not a jar SpawnLoft can update: it updates the Paper, Purpur, Folia and Advanced Slime Paper jars it downloaded itself";

// Paper writes "[12:42:11 ERROR]:", so the level follows a space, never a bracket.
static LEVEL_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" (ERROR|SEVERE|FATAL)\]|Exception").expect("pattern"));
static LEVEL_WARN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" (WARN|WARNING|ERROR|SEVERE|FATAL)\]|Exception").expect("pattern"));

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "list_servers",
            run: list_servers,
            failed: None,
        },
        Tool {
            name: "server_status",
            run: server_status,
            failed: None,
        },
        Tool {
            name: "get_logs",
            run: get_logs,
            failed: None,
        },
        Tool {
            name: "diagnostics",
            run: diagnostics,
            failed: None,
        },
        Tool {
            name: "players",
            run: players_tool,
            failed: None,
        },
        Tool {
            name: "performance",
            run: performance,
            failed: None,
        },
        Tool {
            name: "list_snapshots",
            run: list_snapshots,
            failed: None,
        },
        Tool {
            name: "get_activity",
            run: get_activity,
            failed: None,
        },
        Tool {
            name: "verify_snapshot",
            run: verify_snapshot,
            failed: Some(|d| d.get("ok") == Some(&Value::Bool(false))),
        },
        Tool {
            name: "list_plugins",
            run: list_plugins,
            failed: None,
        },
        Tool {
            name: "search_plugins",
            run: search_plugins,
            failed: None,
        },
        Tool {
            name: "check_plugin_updates",
            run: check_plugin_updates,
            failed: None,
        },
        Tool {
            name: "check_server_update",
            run: check_server_update,
            failed: None,
        },
        Tool {
            name: "list_config_files",
            run: list_config_files,
            failed: None,
        },
        Tool {
            name: "read_config_file",
            run: read_config_file,
            failed: None,
        },
        Tool {
            name: "bot_check",
            run: super::bots::bot_check,
            failed: None,
        },
        Tool {
            name: "doctor",
            run: doctor_tool,
            failed: None,
        },
    ]
}

/// `statusRecord(name)`.
pub fn status_record(layout: &Layout, name: &str) -> Result<Value, Failure> {
    let (row, _) = supervisor::status_of(layout, name)?;
    Ok(record_of(&row))
}

/// `query('list')`: every server and database's status record.
fn query_list(layout: &Layout) -> Result<Value, Failure> {
    let file = Path::new(&layout.registry_file);
    let mut instances = Vec::new();
    for row in registry::list_instances(file)? {
        instances.push(status_record(layout, &row.name)?);
    }
    let mut databases = Vec::new();
    for row in registry::list_services(file)? {
        databases.push(status_record(layout, &row.name)?);
    }
    Ok(json!({ "instances": instances, "databases": databases }))
}

fn list_servers(call: &Call<'_>, _args: &Args) -> Result<Out, Failure> {
    let data = query_list(call.layout)?;
    let mut rows = Vec::new();
    for r in data["instances"]
        .as_array()
        .into_iter()
        .chain(data["databases"].as_array())
        .flatten()
    {
        let database = r.get("kind") == Some(&json!("database"));
        rows.push(format!(
            "{}: {}{}{}",
            js::string(r.get("name")),
            js::string(r.get("status")),
            if database {
                format!(" (database, {})", js::string(r.get("engine")))
            } else {
                String::new()
            },
            if js::truthy(r.get("port")) {
                format!(", port {}", js::string(r.get("port")))
            } else {
                String::new()
            },
        ));
    }
    if !rows.is_empty() {
        return Ok(Out::new(data, rows.join("\n")));
    }
    // an empty list can mean the data root points at the wrong folder, so say which was read
    let root = &call.layout.data_root;
    let elsewhere = settings::describe_servers_elsewhere(root);
    let found: Vec<Value> = settings::servers_elsewhere(root)
        .into_iter()
        .map(|(root, names)| json!({ "root": root, "names": names }))
        .collect();
    let mut data = obj(data);
    data.insert("dataRoot".into(), json!(root));
    data.insert("serversElsewhere".into(), json!(found));
    let mut text = vec![format!("No servers in {root}.")];
    text.extend(elsewhere.iter().map(|l| format!("NOTE: {l}")));
    Ok(Out::new(Value::Object(data), text.join("\n")))
}

fn server_status(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let s = status_record(call.layout, &n)?;
    let label = if js::truthy(s.get("label")) {
        format!(" ({})", js::string(s.get("label")))
    } else {
        String::new()
    };
    let mut parts = vec![format!(
        "{}{label}: {}",
        js::string(s.get("name")),
        js::string(s.get("status"))
    )];
    if js::truthy(s.get("port")) {
        let rcon = if js::truthy(s.get("rconPort")) {
            format!(", RCON {}", js::string(s.get("rconPort")))
        } else {
            String::new()
        };
        parts.push(format!("port {}{rcon}", js::string(s.get("port"))));
    }
    if js::truthy(s.get("memory")) {
        parts.push(format!("{} memory", js::string(s.get("memory"))));
    }
    let running = s.get("status") == Some(&json!("running"));
    if running && js::truthy(s.get("uptimeMs")) {
        parts.push(format!(
            "up {}",
            text::human_duration(Some(js::number(s.get("uptimeMs"))))
        ));
    }
    if !running && !matches!(s.get("exitCode"), None | Some(Value::Null)) {
        parts.push(format!("last exit code {}", js::string(s.get("exitCode"))));
    }
    Ok(Out::new(s, parts.join("; ")))
}

fn get_logs(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let count = number_arg(args, "lines", 100.0);
    let level = text_arg(args, "level");
    let grep = text_arg(args, "grep");
    instance(call, &n)?;
    let mut pattern = None;
    if let Some(g) = grep.as_deref().filter(|g| !g.is_empty()) {
        pattern = Some(spawnloft_lib::jsregex::compile(g, true).map_err(|e| match e {
            PatternError::Unsupported(what) => Failure::user(format!(
                "the pattern /{g}/ uses {what}, which SpawnLoft cannot run; write the pattern another way"
            )),
            PatternError::Invalid(why) => Failure::user(format!(
                "grep is not a valid regular expression: Invalid regular expression: /{g}/i: regex parse error: {why}"
            )),
        })?);
    }
    let filtered = level.is_some() || pattern.is_some();
    let scanned = if filtered { 5000.0 } else { count };
    let mut out = supervisor::tail_log(Path::new(&call.layout.console_log(&n)), scanned)?;
    if let Some(level) = &level {
        let re = if level == "error" {
            &*LEVEL_ERROR
        } else {
            &*LEVEL_WARN
        };
        out.retain(|l| re.is_match(l));
    }
    if let Some(p) = &pattern {
        out.retain(|l| p.is_match(l));
    }
    let keep = supervisor::slice_start(out.len(), -count);
    let out: Vec<String> = out.split_off(keep);
    let text = lines(&out);
    Ok(Out::new(
        json!({ "name": n, "lines": out, "scanned": jsjson::num(scanned) }),
        text,
    ))
}

/// `query('diagnostics', [n])`.
fn query_diagnostics(layout: &Layout, name: &str) -> Result<Value, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let tail = supervisor::tail_log(Path::new(&layout.console_log(name)), 400.0)?;
    let dir = dir_text(&inst)?;
    let findings = diagnose::diagnose(&tail, &diagnose::Context::of(&inst));
    let status = status_record(layout, name)?;
    Ok(json!({
        "instance": name,
        "status": status,
        "findings": findings.iter().map(diagnose::Finding::to_json).collect::<Vec<_>>(),
        "crashes": crashes_json(&dir, 5)?,
        "scope": "recent-console-and-crash-reports",
    }))
}

fn finding_lines(out: &mut Vec<String>, findings: &[Value]) {
    for f in findings {
        out.push(format!(
            "- {}. {}\n  From: {}",
            js::string(f.get("title")),
            js::string(f.get("advice")),
            js::trim(&js::string(f.get("line")))
        ));
    }
}

fn diagnostics(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let bundle = bool_arg(args, "bundle", false);
    let client = text_arg(args, "client");
    let d = query_diagnostics(call.layout, &n)?;
    let mut out = vec![format!("{n} is {}.", js::string(d["status"].get("status")))];
    let findings = d["findings"].as_array().cloned().unwrap_or_default();
    if findings.is_empty() {
        out.push("No known failure causes in the recent console. get_logs with level \"warn\" shows anything else.".into());
    } else {
        out.push("Known problems in the recent console, oldest first:".into());
        finding_lines(&mut out, &findings);
    }
    let reports = d["crashes"]["reports"].as_array().cloned().unwrap_or_default();
    if !reports.is_empty() {
        out.push(format!("Crash reports ({}, newest first):", reports.len()));
        for r in &reports {
            let desc = match r.get("description") {
                None | Some(Value::Null) => "no description line".to_string(),
                v => js::string(v),
            };
            out.push(format!("- {}: {desc}", js::string(r.get("file"))));
        }
    }
    let mut data = obj(d);
    // `if (client)`: an empty name is no client
    let client = client.filter(|c| !c.is_empty());
    if let Some(c) = &client {
        let got = diag_bundle::collect_client(call.layout, c, 400, spawnloft_lib::util::now())?;
        let running = js::truthy(got.facts.get("running"));
        out.push(format!(
            "Client {c} is {}.",
            if running { "running" } else { "stopped" }
        ));
        let cf: Vec<Value> = got.findings.iter().map(diagnose::Finding::to_json).collect();
        if cf.is_empty() {
            out.push("No known failure causes in the client logs.".into());
        } else {
            out.push("Known problems in the client logs, oldest first:".into());
            finding_lines(&mut out, &cf);
        }
        data.insert(
            "client".into(),
            json!({ "name": c, "facts": got.facts.to_json(), "findings": cf, "crashes": got.crashes }),
        );
    }
    if bundle {
        let scrub = spawnloft_lib::scrubber::scrubber(call.layout, false);
        let b = diag_bundle::build_bundle(call.layout, Some(&n), client.as_deref(), 5000, &scrub)?;
        let out_dir = spawnloft_lib::jspath::join(&[&call.layout.backups_dir, &n, "exports"]);
        let w = diag_bundle::write_bundle(&b, &out_dir)?;
        data.insert(
            "bundle".into(),
            json!({ "file": w.file, "size": w.size, "findings": { "server": b.findings_server, "client": b.findings_client } }),
        );
        out.push(format!("Bundle written to {}", w.file));
    }
    Ok(Out::new(Value::Object(data), out.join("\n")))
}

fn players_tool(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let inst = server(call, &n)?;
    let running = is_running(call, &n)?;
    let exec = |c: &str| players::rcon_command(&inst, c);
    let online = players::online_now(&players::Console { running, exec: &exec });
    let dir = dir_text(&inst)?;
    let known: Vec<Value> = players::list_players(Path::new(&dir))?
        .into_iter()
        .map(|p| {
            json!({ "name": p.name, "uuid": p.uuid, "op": p.op, "banned": p.banned,
                "banReason": p.ban_reason, "whitelisted": p.whitelisted, "lastSeen": p.last_seen })
        })
        .collect();
    let who = if online.is_empty() {
        "nobody".to_string()
    } else {
        online.join(", ")
    };
    let text = format!("Online ({}): {who}\nKnown players: {}", online.len(), known.len());
    // `running` is asked again, as the Node tool does after the console call
    let running = is_running(call, &n)?;
    Ok(Out::new(
        json!({ "name": n, "running": running, "online": online, "known": known }),
        text,
    ))
}

/// `Math.round(x)`: halves up, toward +Infinity.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn performance(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let seconds = number_arg(args, "seconds", 600.0);
    let inst = instance(call, &n)?;
    let m = super::super::metrics::read_metrics(call.layout, &n, Some(seconds))?;
    let cpu: Vec<f64> = m.samples.iter().map(|s| s.cpu).collect();
    let rss: Vec<f64> = m.samples.iter().map(|s| s.rss).collect();
    let avg = |a: &[f64]| {
        if a.is_empty() {
            Value::Null
        } else {
            jsjson::num(js_round(a.iter().sum::<f64>() / a.len() as f64 * 10.0) / 10.0)
        }
    };
    let max = |a: &[f64]| {
        if a.is_empty() {
            Value::Null
        } else {
            jsjson::num(a.iter().copied().fold(f64::NEG_INFINITY, |x, y| {
                if y.is_nan() || x.is_nan() {
                    f64::NAN
                } else {
                    x.max(y)
                }
            }))
        }
    };
    let last = |a: &[f64]| a.last().map_or(Value::Null, |x| jsjson::num(*x));
    let summary = json!({
        "samples": m.samples.len(), "cpuAvg": avg(&cpu), "cpuMax": max(&cpu), "cpuLast": last(&cpu),
        "memoryMiBLast": last(&rss), "memoryMiBMax": max(&rss),
    });
    let mut tick = Map::new();
    if !inst.is_database() && is_running(call, &n)? {
        // Paper answers tps and mspt; vanilla and Fabric answer tick query. Unknown commands are
        // left out. Same reader as the daemon's sampler, so both interpret replies identically.
        let replies = tick::read_replies(|cmd| {
            rcon::exec(&inst, &[cmd], rcon::ExecOptions::default())
                .map(|r| r.into_iter().next().unwrap_or_default())
        });
        for (cmd, text) in replies {
            tick.insert(cmd.into(), json!(text));
        }
    }
    let recent: Vec<Value> = m.samples[supervisor::slice_start(m.samples.len(), -30.0)..]
        .iter()
        .map(super::super::metrics::Sample::to_json)
        .collect();
    let samples = m.samples.len();
    let mut text = vec![format!(
        "{n}: {}; {samples} samples in the last {}s",
        if m.running { "running" } else { "not running" },
        js::number_to_string(seconds)
    )];
    if samples > 0 {
        text.push(format!(
            "CPU avg {}% max {}% (of all {} cores); memory {} MiB (max {})",
            js::string(summary.get("cpuAvg")),
            js::string(summary.get("cpuMax")),
            m.cores,
            js::string(summary.get("memoryMiBLast")),
            js::string(summary.get("memoryMiBMax")),
        ));
    } else {
        text.push("No samples recorded in this window.".into());
    }
    text.extend(tick.values().map(|v| js::string(Some(v))));
    let data = json!({
        "name": n, "running": m.running, "windowSeconds": jsjson::num(seconds), "cores": m.cores,
        "cpuScale": "whole-machine",
        "samplingAvailable": cfg!(any(windows, target_os = "macos", target_os = "linux")),
        "summary": summary, "tick": Value::Object(tick), "recent": recent,
    });
    Ok(Out::new(data, text.join("\n")))
}

/// `snapshotRow(row)`.
fn snapshot_row(row: &backup::Snapshot) -> Value {
    let or_null = |v: &Value| if v.is_null() { Value::Null } else { v.clone() };
    json!({
        "name": row.name, "scope": row.scope, "label": or_null(&row.label), "sizeBytes": row.size,
        "createdAt": spawnloft_lib::time::iso(row.mtime_ms as i64),
        "members": if row.members.is_null() { json!([]) } else { row.members.clone() },
    })
}

fn list_snapshots(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    instance(call, &n)?;
    let snapshots: Vec<Value> = backup::list_snapshots(call.layout, &n)?
        .iter()
        .map(snapshot_row)
        .collect();
    let text = if snapshots.is_empty() {
        format!("No backups of {n} yet. The backup tool takes one.")
    } else {
        snapshots
            .iter()
            .map(|s| {
                format!(
                    "{}: {}, {}, taken {}",
                    js::string(s.get("name")),
                    js::string(s.get("scope")),
                    text::human_bytes(Some(js::number(s.get("sizeBytes")))),
                    js::string(s.get("createdAt"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(Out::new(json!({ "name": n, "snapshots": snapshots }), text))
}

fn who(by: Option<&Value>) -> String {
    let kind = by.and_then(|b| b.get("kind")).and_then(Value::as_str);
    let name = by.and_then(|b| b.get("name")).filter(|v| js::truthy(Some(v)));
    match kind {
        Some("assistant") => match name {
            Some(n) => format!("AI assistant ({})", js::string(Some(n))),
            None => "AI assistant".into(),
        },
        Some("schedule") => match name {
            Some(n) => format!("schedule \"{}\"", js::string(Some(n))),
            None => "schedule".into(),
        },
        Some("panel") => "the owner, in SpawnLoft".into(),
        Some("cli") => "the owner, in a terminal".into(),
        _ => "SpawnLoft".into(),
    }
}

fn get_activity(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = text_arg(args, "name");
    let since = text_arg(args, "since");
    let limit = number_arg(args, "limit", 50.0) as usize;
    let (entries, more) = activity::read_activity(
        &Roots::new(&call.layout.data_root),
        &activity::Query {
            server: n.as_deref(),
            since: since.as_deref(),
            limit,
            ..activity::Query::default()
        },
    );
    let text = if entries.is_empty() {
        format!(
            "Nothing recorded{}{}.",
            n.as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" for {s}"))
                .unwrap_or_default(),
            since
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" since {s}"))
                .unwrap_or_default()
        )
    } else {
        let mut t = entries
            .iter()
            .map(|e| {
                format!(
                    "{}  {}  {}{}{}  - by {}",
                    js::string(e.get("at")),
                    js::string(e.get("server")),
                    js::string(e.get("action")),
                    if e.get("ok") == Some(&Value::Bool(false)) {
                        " (failed)"
                    } else {
                        ""
                    },
                    if js::truthy(e.get("detail")) {
                        format!(": {}", js::string(e.get("detail")))
                    } else {
                        String::new()
                    },
                    who(e.get("by"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        if more {
            t.push_str("\n(older entries exist; narrow with since or raise limit)");
        }
        t
    };
    Ok(Out::new(json!({ "entries": entries, "more": more }), text))
}

fn verify_snapshot(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let reference = text_arg(args, "snapshot").unwrap_or_else(|| "latest".into());
    instance(call, &n)?;
    let (snap, has_manifest, res) = backup::verify_snapshot(call.layout, &n, &reference)?;
    let text = if res.ok {
        format!(
            "ok: {}{}",
            snap.name,
            if has_manifest {
                ""
            } else {
                " (no manifest, so only the archive itself was checked)"
            }
        )
    } else {
        let mut all = res.problems.clone();
        all.extend(res.missing.iter().map(|m| format!("missing {m}")));
        format!("FAILED: {}: {}", snap.name, all.join("; "))
    };
    Ok(Out::new(
        json!({ "name": n, "snapshot": snap.name, "hasManifest": has_manifest, "ok": res.ok, "size": res.size,
            "entries": res.entries, "missing": res.missing, "problems": res.problems }),
        text,
    ))
}

fn list_plugins(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let rows: Vec<Value> = plugins::list_plugins(&server(call, &n)?)?
        .into_iter()
        .map(|p| {
            let mut m = obj(p);
            m.shift_remove("mtime");
            Value::Object(m)
        })
        .collect();
    let text = if rows.is_empty() {
        "No plugins installed.".to_string()
    } else {
        rows.iter()
            .map(|p| {
                format!(
                    "{} {}{}{}",
                    js::string(p.get("name")),
                    match p.get("version") {
                        None | Some(Value::Null) => String::new(),
                        v => js::string(v),
                    },
                    if js::truthy(p.get("enabled")) {
                        ""
                    } else {
                        " (disabled)"
                    },
                    if js::truthy(p.get("managed")) {
                        format!(" [{}]", js::string(p.get("source")))
                    } else {
                        String::new()
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(Out::new(json!({ "name": n, "plugins": rows }), text))
}

fn search_plugins(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let q = text_arg(args, "query").unwrap_or_default();
    let found = plugin_actions::search_everywhere(&server(call, &n)?, &q);
    let top: Vec<Value> = found["results"]
        .as_array()
        .map(|r| r.iter().take(20).cloned().collect::<Vec<Value>>())
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let mut m = obj(r);
            m.shift_remove("icon");
            Value::Object(m)
        })
        .collect();
    let errors = found.get("errors").cloned().unwrap_or(json!([]));
    let mut text: Vec<String> = top
        .iter()
        .map(|r| {
            format!(
                "{} ({} id {}, {} downloads): {}",
                js::string(r.get("title")),
                js::string(r.get("source")),
                js::string(r.get("id")),
                js::string(r.get("downloads")),
                js::string(r.get("description"))
            )
        })
        .collect();
    text.extend(
        errors
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| format!("note: {}", js::string(Some(e)))),
    );
    let text = if text.is_empty() {
        "No results.".to_string()
    } else {
        text.join("\n")
    };
    Ok(Out::new(
        json!({ "name": n, "query": q, "results": top, "errors": errors }),
        text,
    ))
}

fn check_plugin_updates(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let inst = server(call, &n)?;
    let updates = plugin_sources::check_updates(&inst, plugins::mc_version_of(&inst).as_deref())?;
    let all = plugins::list_plugins(&inst)?;
    let managed = all.iter().filter(|p| js::truthy(p.get("managed"))).count();
    let own = all.len() - managed;
    let note = if own > 0 {
        format!(
            " {own} other plugin(s) were added by hand and are not checked; SpawnLoft never touches those."
        )
    } else {
        String::new()
    };
    let list = updates.as_array().cloned().unwrap_or_default();
    let text = if managed == 0 {
        format!("SpawnLoft has not installed any plugins on {n}, so there is nothing it can update.{note}")
    } else if !list.is_empty() {
        let mut t = vec![format!("{} of {managed} can be updated:", list.len())];
        for u in &list {
            let installed = match u.get("installedVersion") {
                None | Some(Value::Null) => "?".to_string(),
                v => js::string(v),
            };
            t.push(format!(
                "- {}: {installed} -> {} (update_plugin with file \"{}\")",
                js::string(u.get("name")),
                js::string(u.get("latestVersion")),
                js::string(u.get("file"))
            ));
        }
        t.join("\n") + &note
    } else {
        format!("All {managed} plugin(s) SpawnLoft installed are up to date.{note}")
    };
    Ok(Out::new(json!({ "name": n, "updates": updates }), text))
}

/// `checkUpgrade(inst)` in the Node core's shape.
fn check_json(c: &upgrade::Check) -> Value {
    json!({
        "software": c.current.as_ref().map(|j| j.software),
        "label": c.current.as_ref().map(|j| j.label),
        "current": c.current.as_ref().map(|j| json!({ "version": j.version, "build": j.build })),
        "latestBuild": c.latest_build.as_ref().map(|l| json!({ "build": l.build, "channel": l.channel, "time": l.time })),
        "buildUpdate": c.latest_build.as_ref().is_some_and(|l| l.newer),
        "newerVersions": c.newer_versions,
        "latestVersion": c.latest_version,
    })
}

fn check_server_update(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let inst = server(call, &n)?;
    let info = upgrade::check_upgrade(&inst)?;
    let text = match &info.current {
        None => format!(
            "{n} runs {}, which {UNRECOGNISED_JAR}.",
            js::string(server(call, &n)?.get("jar"))
        ),
        Some(c) => {
            let latest = info.latest_build.as_ref();
            let mut t = vec![format!(
                "{n} runs {} {} build {}.",
                c.label,
                c.version,
                js::string(Some(&c.build))
            )];
            t.push(if latest.is_some_and(|l| l.newer) {
                format!(
                    "Build {} is available (upgrade_build applies it).",
                    js::string(latest.map(|l| &l.build))
                )
            } else {
                "That is the newest build for its version.".into()
            });
            if !info.newer_versions.is_empty() {
                t.push(format!(
                    "Newer Minecraft versions: {} (crossing one migrates the worlds for good).",
                    info.newer_versions.join(", ")
                ));
            }
            t.join("\n")
        }
    };
    let data = spread(obj(json!({ "name": n })), &check_json(&info));
    Ok(Out::new(Value::Object(data), text))
}

fn list_config_files(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let folder = text_arg(args, "folder").unwrap_or_default();
    let (files, truncated) = config_files::list_config_files(&server(call, &n)?, &folder)?;
    let text = if files.is_empty() {
        format!(
            "No configuration files in {}.",
            if folder.is_empty() { &n } else { &folder }
        )
    } else {
        files
            .iter()
            .map(|f| format!("{} ({})", f.path, text::human_bytes(Some(f.size_bytes as f64))))
            .collect::<Vec<_>>()
            .join("\n")
            + if truncated {
                "\n(more files exist; give a folder to narrow it down)"
            } else {
                ""
            }
    };
    let files: Vec<Value> = files
        .iter()
        .map(|f| json!({ "path": f.path, "sizeBytes": f.size_bytes }))
        .collect();
    Ok(Out::new(
        json!({ "name": n, "folder": if folder.is_empty() { Value::Null } else { json!(folder) }, "files": files, "truncated": truncated }),
        text,
    ))
}

fn read_config_file(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let p = text_arg(args, "path");
    let file = config_files::read_config_file(&server(call, &n)?, p.as_deref())?;
    // The file must be in the structured data too: clients that have it (Claude Code) show the
    // model that instead of the text.
    let text = if file.text.is_empty() {
        "(the file is empty)".to_string()
    } else {
        file.text.clone()
    };
    Ok(Out::new(
        json!({ "name": n, "path": file.path, "text": file.text, "sizeBytes": file.size_bytes, "redacted": file.redacted }),
        text,
    ))
}

fn doctor_tool(call: &Call<'_>, _args: &Args) -> Result<Out, Failure> {
    let report = doctor::run(call.layout, false)?;
    // A client that is itself redirected to the private copy sees nothing to compare, so it gets
    // the notice rather than a bare "No problems found."
    let notice = private_copy::mcp_notice(&report.private_copies);
    let text = if report.healthy() {
        "No problems found.".to_string()
    } else {
        format!(
            "{} problem(s):\n- {}",
            report.problems.len(),
            report.problems.join("\n- ")
        )
    };
    let text = if notice.is_empty() {
        text
    } else {
        format!("{text}\n{notice}")
    };
    let data = json!({
        "healthy": report.healthy(), "notes": report.notes, "problems": report.problems,
        "privateCopies": report.private_copies.iter().map(private_copy::PrivateCopy::to_json).collect::<Vec<_>>(),
    });
    Ok(Out::new(data, text))
}
