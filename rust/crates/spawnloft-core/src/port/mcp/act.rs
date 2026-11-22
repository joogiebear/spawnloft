//! The action tools of `mcp-tools.mjs` (undoable, marked as writes) and the destructive ones,
//! offered only with `--allow-destructive`, which describe what they would do until called with
//! `confirm: true`.

use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

use spawnloft_lib::backup::{self, Options, RestoreOptions};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::paths::Roots;
use spawnloft_lib::supervisor::{self, StartOptions};
use spawnloft_lib::upgrade::{self, Applied};
use spawnloft_lib::{activity, config_files, control, diagnose, js, plugin_actions, rcon};

use super::tools::{
    Args, Call, Out, Tool, basename, bool_arg, instance, is_running, lines, name_arg, obj, server, spread,
    text_arg,
};

const UNRECOGNISED_JAR: &str = "is not a jar SpawnLoft can update: it updates the Paper, Purpur, Folia and Advanced Slime Paper jars it downloaded itself";

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "start",
            run: start,
            failed: Some(|d| {
                d.get("started") == Some(&Value::Bool(true))
                    && d.get("ready") == Some(&Value::Bool(false))
                    && d.get("reason").is_some()
            }),
        },
        Tool {
            name: "stop",
            run: stop,
            failed: None,
        },
        Tool {
            name: "restart",
            run: restart,
            failed: Some(|d| d.get("ready") == Some(&Value::Bool(false))),
        },
        Tool {
            name: "run_command",
            run: run_command,
            failed: None,
        },
        Tool {
            name: "bot_run_scenario",
            run: super::bots::bot_run_scenario,
            failed: Some(|d| d.get("ok") == Some(&Value::Bool(false))),
        },
        Tool {
            name: "backup",
            run: backup_tool,
            failed: None,
        },
        Tool {
            name: "install_plugin",
            run: install_plugin,
            failed: None,
        },
        Tool {
            name: "update_plugin",
            run: update_plugin,
            failed: None,
        },
        Tool {
            name: "write_config_file",
            run: write_config_file,
            failed: None,
        },
        Tool {
            name: "upgrade_build",
            run: upgrade_build,
            failed: None,
        },
        Tool {
            name: "restore",
            run: restore,
            failed: Some(|d| {
                d.get("databasesSkipped")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
            }),
        },
        Tool {
            name: "kill",
            run: kill,
            failed: None,
        },
        Tool {
            name: "upgrade_minecraft",
            run: upgrade_minecraft,
            failed: None,
        },
    ]
}

/// `"...".slice(0, n)` in UTF-16 units.
fn cut16(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

fn tail(call: &Call<'_>, name: &str, count: f64) -> Result<Vec<String>, Failure> {
    supervisor::tail_log(Path::new(&call.layout.console_log(name)), count)
}

/// `startTool(n, wait, progress)`: reported every five seconds while it waits, so a client with
/// a short timeout sees it is alive.
fn start_tool(call: &Call<'_>, n: &str, wait: bool) -> Result<Out, Failure> {
    let inst = instance(call, n)?;
    (call.progress)(&format!("Starting {n}"));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let res = std::thread::scope(|s| {
        // dropped when the start returns or panics, which ends the ticker either way
        let done = done_tx;
        s.spawn(move || {
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                done_rx.recv_timeout(Duration::from_secs(5))
            {
                let last = tail(call, n, 1.0)
                    .ok()
                    .and_then(|l| l.into_iter().next())
                    .unwrap_or_default();
                (call.progress)(&cut16(&format!("Waiting for {n} to be ready: {last}"), 200));
            }
        });
        let res = supervisor::start(
            call.layout,
            &call.by,
            n,
            StartOptions {
                wait,
                timeout: 180000.0,
                ..StartOptions::default()
            },
        );
        drop(done);
        res
    })?;
    if !wait {
        return Ok(Out::new(
            json!({ "name": n, "started": true, "ready": false, "javaPid": res.java_pid }),
            format!("{n} launched; not waiting for ready."),
        ));
    }
    if res.ready {
        let line = res.ready_line.clone().unwrap_or_else(|| "undefined".into());
        return Ok(Out::new(
            json!({ "name": n, "started": true, "ready": true, "readyLine": res.ready_line }),
            format!("{n} is ready: {line}"),
        ));
    }
    let last = tail(call, n, 25.0)?;
    let findings: Vec<Value> = if inst.is_database() {
        Vec::new()
    } else {
        diagnose::diagnose(&tail(call, n, 400.0)?, &diagnose::Context::of(&inst))
            .iter()
            .map(diagnose::Finding::to_json)
            .collect()
    };
    let reason = res.reason.clone();
    let text = format!(
        "{n} did not reach ready: {}\n\nLast console lines:\n{}",
        reason
            .clone()
            .unwrap_or_else(|| "timed out after 180s (it may still be loading)".into()),
        lines(&last)
    );
    Ok(Out::new(
        json!({ "name": n, "started": true, "ready": false, "failed": res.failed,
            "reason": reason.unwrap_or_else(|| "timed out waiting for ready".into()),
            "findings": findings, "lastLines": last }),
        text,
    ))
}

fn start(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    start_tool(call, &name_arg(args), bool_arg(args, "wait", true))
}

fn stop(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    (call.progress)(&format!("Stopping {n}"));
    let res = supervisor::stop(call.layout, &call.by, &n, 90000.0)?;
    let text = if res.already_stopped {
        format!("{n} was not running.")
    } else if res.forced {
        format!("{n} did not shut down in time and was killed.")
    } else {
        format!("{n} stopped.")
    };
    let data = spread(obj(json!({ "name": n })), &Value::Object(res.detail));
    Ok(Out::new(Value::Object(data), text))
}

fn restart(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let (status, _) = supervisor::read_state(call.layout, &n)?;
    if matches!(status, control::Status::Running | control::Status::Stopping) {
        (call.progress)(&format!("Stopping {n}"));
        supervisor::stop(call.layout, &call.by, &n, 90000.0)?;
    }
    start_tool(call, &n, true)
}

fn run_command(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let command = text_arg(args, "command").unwrap_or_default();
    let inst = server(call, &n)?;
    let line = js::trim(&command);
    let line = line.strip_prefix('/').unwrap_or(line).to_string();
    let verb = spawnloft_lib::bots::command_verb(&line);
    if spawnloft_lib::bots::REFUSED_CONSOLE.contains(&verb.as_str()) {
        let why = match verb.as_str() {
            "stop" => "use the stop tool",
            "restart" => "use the restart tool",
            _ => "reloading plugins in place breaks them; use the restart tool",
        };
        return Err(Failure::user(format!(
            "\"{verb}\" is not run over RCON here: {why}"
        )));
    }
    if !is_running(call, &n)? {
        return Err(Failure::user(format!("\"{n}\" is not running")));
    }
    let opts = rcon::ExecOptions {
        retry_sent: false,
        ..rcon::ExecOptions::default()
    };
    let reply = rcon::exec(&inst, &[&line], opts)
        .map_err(|e| Failure::Internal {
            head: "Error".into(),
            message: e.message,
            code: None,
        })?
        .into_iter()
        .next()
        .unwrap_or_default();
    activity::record_by(
        &Roots::new(&call.layout.data_root),
        &call.by,
        &n,
        "command",
        Some(&line),
        None,
        true,
    );
    let text = js::trim_end(&rcon::strip_colors(&reply)).to_string();
    let shown = if text.is_empty() {
        "(no output)".to_string()
    } else {
        text.clone()
    };
    Ok(Out::new(
        json!({ "name": n, "command": line, "reply": text }),
        shown,
    ))
}

fn backup_tool(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let scope = text_arg(args, "scope").unwrap_or_else(|| "standard".into());
    let label = args.get("label").cloned().unwrap_or(Value::Null);
    let inst = instance(call, &n)?;
    (call.progress)(&format!("Snapshotting {n} ({scope})"));
    let running = is_running(call, &n)?;
    let res = backup::create_snapshot(
        call.layout,
        &call.by,
        &inst,
        &Options {
            scope: scope.clone(),
            label,
            running,
            ..Options::default()
        },
    )?;
    let warnings = match res.manifest.get("warnings") {
        None | Some(Value::Null) => json!([]),
        Some(w) => w.clone(),
    };
    let snapshot = basename(&res.file);
    let data = json!({
        "name": n, "snapshot": snapshot, "sizeBytes": res.size, "scope": scope, "members": res.members,
        "databases": res.databases, "databasesSkipped": res.databases_skipped, "skipped": res.skipped,
        "warnings": warnings, "mirrored": res.mirrored.is_some(), "mirrorError": res.mirror_error,
    });
    let mib = (res.size as f64 / 1048576.0 * 10.0 + 0.5).floor() / 10.0;
    let mut text = format!(
        "Wrote {snapshot} ({} MiB): {}",
        js::number_to_string(mib),
        res.members.join(", ")
    );
    if !res.databases_skipped.is_empty() {
        let list: Vec<String> = res
            .databases_skipped
            .iter()
            .map(|d| {
                format!(
                    "{} not included: {}",
                    js::string(d.get("database")),
                    js::string(d.get("reason"))
                )
            })
            .collect();
        text.push_str(&format!("\nWARNING: {}", list.join("; ")));
    }
    if !res.skipped.is_empty() {
        text.push_str(&format!(
            "\nWARNING: locked by another program, so not included: {}",
            res.skipped.join(", ")
        ));
    }
    if let Some(w) = res.save_on_warning.as_deref().filter(|w| !w.is_empty()) {
        text.push_str(&format!("\nWARNING: {w}"));
    }
    Ok(Out::new(data, text))
}

/// `res.snapshot ? path.basename(res.snapshot) : null`.
fn snapshot_base(res: &Value) -> Value {
    if js::truthy(res.get("snapshot")) {
        json!(basename(&js::string(res.get("snapshot"))))
    } else {
        Value::Null
    }
}

/// `[...].filter(Boolean).join('\n')`.
fn joined(parts: Vec<Option<String>>) -> String {
    parts
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A value that is text when truthy (`res.versionNote` in a `filter(Boolean)` list).
fn note(v: Option<&Value>) -> Option<String> {
    js::truthy(v).then(|| js::string(v))
}

fn install_plugin(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let id = text_arg(args, "project_id").unwrap_or_default();
    let source = text_arg(args, "source").unwrap_or_else(|| "modrinth".into());
    (call.progress)("Snapshotting plugins, then downloading");
    let inst = server(call, &n)?;
    let res = plugin_actions::install_with_snapshot(call.layout, &call.by, &inst, &id, &source, &[])?;
    let snapshot = snapshot_base(&res);
    let text = joined(vec![
        Some(format!(
            "Installed {} ({}) on {n}. It loads at the next restart.",
            js::string(res.get("installed")),
            js::string(res.get("version"))
        )),
        note(res.get("versionNote")),
        Some(if snapshot.is_null() {
            "No snapshot: this is the first plugin on the server.".into()
        } else {
            format!("Snapshot taken first: {}.", js::string(Some(&snapshot)))
        }),
    ]);
    let mut data = spread(obj(json!({ "name": n })), &res);
    data.insert("snapshot".into(), snapshot);
    Ok(Out::new(Value::Object(data), text))
}

fn update_plugin(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let file = text_arg(args, "file").unwrap_or_default();
    (call.progress)("Snapshotting plugins, then downloading");
    let inst = server(call, &n)?;
    let res = plugin_actions::update_with_snapshot(call.layout, &call.by, &inst, &file)?;
    let snapshot = snapshot_base(&res);
    let text = if js::truthy(res.get("alreadyLatest")) {
        format!(
            "{file} is already the newest build ({}).",
            js::string(res.get("version"))
        )
    } else {
        joined(vec![
            Some(format!(
                "Updated {} to {} ({}) on {n}. It loads at the next restart.",
                js::string(res.get("from")),
                js::string(res.get("updated")),
                js::string(res.get("version"))
            )),
            note(res.get("versionNote")),
            (!snapshot.is_null()).then(|| format!("Snapshot taken first: {}.", js::string(Some(&snapshot)))),
        ])
    };
    let mut data = spread(obj(json!({ "name": n })), &res);
    data.insert("snapshot".into(), snapshot);
    Ok(Out::new(Value::Object(data), text))
}

fn write_config_file(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let p = text_arg(args, "path");
    let inst = server(call, &n)?;
    let ask = config_files::WriteAsk {
        content: args.get("content").cloned(),
        old_text: args.get("old_text").cloned(),
        new_text: args.get("new_text").cloned(),
        hidden_restored: false,
    };
    let plan = config_files::plan_config_write(&inst, p.as_deref(), &ask)?;
    let mut snapshot: Option<String> = None;
    if plan.existed {
        (call.progress)(&format!("Snapshotting {}", plan.shown));
        let res = backup::create_snapshot(
            call.layout,
            &call.by,
            &inst,
            &Options {
                scope: "config".into(),
                label: json!("before-edit"),
                members: Some(vec![plan.shown.clone()]),
                flush: false,
                change_copy: true,
                ..Options::default()
            },
        )?;
        snapshot = Some(basename(&res.file));
        // The snapshot took a moment; a plugin saving its config meanwhile must not be written over.
        if !config_files::unchanged_since(&plan)? {
            return Err(Failure::user(format!(
                "{} changed while it was being snapshotted; read it again",
                plan.shown
            )));
        }
    }
    config_files::apply_config_write(&plan)?;
    activity::record_by(
        &Roots::new(&call.layout.data_root),
        &call.by,
        &n,
        if plan.existed {
            "config-edit"
        } else {
            "config-create"
        },
        Some(&plan.shown),
        snapshot.as_deref(),
        true,
    );
    let running = is_running(call, &n)?;
    let diff = config_files::summarize_change(plan.before.as_deref(), &plan.after, 40);
    let text = [
        if plan.existed {
            format!("Changed {} on {n}.", plan.shown)
        } else {
            format!("Created {} on {n}.", plan.shown)
        },
        diff.clone(),
        match &snapshot {
            Some(s) => format!("Snapshot taken first: {s} (restore puts back this one file)."),
            None => "It is a new file, so there was nothing to snapshot.".into(),
        },
        if running {
            "The server is running: the change applies when the plugin reloads its config or at the next restart. Some plugins write their config back when they stop, so check it after a restart.".into()
        } else {
            "Takes effect at the next start.".into()
        },
    ]
    .join("\n");
    Ok(Out::new(
        json!({ "name": n, "path": plan.shown, "created": !plan.existed, "snapshot": snapshot, "running": running, "diff": diff }),
        text,
    ))
}

fn upgrade_build(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let inst = server(call, &n)?;
    if upgrade::parse_server_jar(inst.get("jar")).is_none() {
        return Err(Failure::user(format!(
            "{} {UNRECOGNISED_JAR}",
            js::string(inst.get("jar"))
        )));
    }
    (call.progress)("Downloading the newest build");
    let running = is_running(call, &n)?;
    match upgrade::apply_upgrade(call.layout, &call.by, &n, None, &Value::Null, running)? {
        Applied::AlreadyCurrent { jar } => Ok(Out::new(
            json!({ "name": n, "alreadyCurrent": true, "jar": jar }),
            format!("{n} already runs the newest build ({jar})."),
        )),
        Applied::Done {
            from, to, channel, ..
        } => Ok(Out::new(
            json!({ "name": n, "from": from, "to": to, "channel": channel,
                "takesEffect": if running { "next restart" } else { "next start" } }),
            format!(
                "{n}: {} -> {to}. {}",
                js::string(Some(&from)),
                if running {
                    "Restart the server to load it."
                } else {
                    "Takes effect at the next start."
                }
            ),
        )),
    }
}

fn restore(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let reference = text_arg(args, "snapshot").unwrap_or_else(|| "latest".into());
    let yes = bool_arg(args, "confirm", false);
    let inst = instance(call, &n)?;
    if let Some(why) = control::active_block(Path::new(&call.layout.state_file(&n)), &n, "restoring")? {
        return Err(Failure::user(why));
    }
    let snap = backup::resolve_snapshot(call.layout, &n, &reference)?;
    if !yes {
        // The preview reads the archive too, so a broken one is caught before confirming.
        (call.progress)(&format!("Checking {}", snap.name));
        let check = backup::check_restorable(&snap)?;
        let imports: Vec<Value> = match &snap.databases {
            Value::Array(d) => d
                .iter()
                .map(|d| json!({ "database": d.get("database"), "service": d.get("service") }))
                .collect(),
            _ => Vec::new(),
        };
        let mut data =
            obj(json!({ "name": n, "confirmed": false, "snapshot": snap.name, "scope": snap.scope }));
        // a manifest without members leaves `overwrites` undefined, which JSON leaves out
        if !snap.members.is_null() {
            data.insert("overwrites".into(), snap.members.clone());
        }
        data.insert("imports".into(), json!(imports));
        data.insert("restorable".into(), json!(check.ok));
        data.insert("problems".into(), json!(check.problems));
        if !check.ok {
            return Ok(Out::new(
                Value::Object(data),
                format!(
                    "{} does NOT read back cleanly, so restoring it would be refused: {}. Nothing has changed. Pick an older snapshot from list_snapshots; verify_snapshot checks one.",
                    snap.name,
                    check.problems.join("; ")
                ),
            ));
        }
        let members: Vec<String> = snap
            .member_list("snap.members.join")?
            .iter()
            .map(|m| {
                if m.is_null() {
                    String::new()
                } else {
                    js::string(Some(m))
                }
            })
            .collect();
        let members = members.join(", ");
        return Ok(Out::new(
            Value::Object(data),
            format!(
                "Would restore {} into {n}, overwriting: {}. The archive reads back cleanly. Nothing has changed yet; call again with confirm: true to do it.",
                snap.name,
                if members.is_empty() {
                    "(see manifest)"
                } else {
                    &members
                }
            ),
        ));
    }
    (call.progress)(&format!("Restoring {}", snap.name));
    let res = backup::restore_snapshot(call.layout, &call.by, &inst, &snap, RestoreOptions::default())?;
    let imported = &res.databases.imported;
    let skipped = &res.databases.skipped;
    let mut text = vec![format!(
        "Restored {} into {n}. Start it to use the restored files.",
        snap.name
    )];
    if let Some(s) = &res.safety {
        text.push(format!(
            "How it was before is kept as {s}; restore that to undo this."
        ));
    }
    for d in imported {
        text.push(format!(
            "Imported database {} into {}.",
            js::string(d.get("database")),
            js::string(d.get("service"))
        ));
    }
    for d in skipped {
        text.push(format!(
            "NOT imported: database {}: {}. The dump is left in the server folder to import by hand.",
            js::string(d.get("database")),
            js::string(d.get("reason"))
        ));
    }
    Ok(Out::new(
        json!({ "name": n, "confirmed": true, "snapshot": snap.name, "restored": res.restored, "safety": res.safety,
            "databasesImported": imported, "databasesSkipped": skipped }),
        text.join("\n"),
    ))
}

fn kill(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let yes = bool_arg(args, "confirm", false);
    instance(call, &n)?;
    let (status, _) = supervisor::read_state(call.layout, &n)?;
    if !yes {
        return Ok(Out::new(
            json!({ "name": n, "confirmed": false, "status": status.as_str() }),
            format!(
                "{n} is {}. Killing it skips the world save. Nothing has changed yet; call again with confirm: true to do it, or try stop first.",
                status.as_str()
            ),
        ));
    }
    let res = supervisor::kill(call.layout, &call.by, &n)?;
    let text = if res.already_stopped {
        format!("{n} was not running; nothing was killed.")
    } else {
        format!("{n} was force-killed. Anything since its last autosave is lost.")
    };
    let data = spread(
        obj(json!({ "name": n, "confirmed": true })),
        &Value::Object(res.detail),
    );
    Ok(Out::new(Value::Object(data), text))
}

fn upgrade_minecraft(call: &Call<'_>, args: &Args) -> Result<Out, Failure> {
    let n = name_arg(args);
    let version = text_arg(args, "version").unwrap_or_default();
    let yes = bool_arg(args, "confirm", false);
    let inst = server(call, &n)?;
    let Some(current) = upgrade::parse_server_jar(inst.get("jar")) else {
        return Err(Failure::user(format!(
            "{} {UNRECOGNISED_JAR}",
            js::string(inst.get("jar"))
        )));
    };
    if version == current.version {
        return Err(Failure::user(format!(
            "{n} already runs {version}; use upgrade_build for a newer build of it"
        )));
    }
    if !yes {
        return Ok(Out::new(
            json!({ "name": n, "confirmed": false, "from": current.version, "to": version }),
            format!(
                "Would move {n} from Minecraft {} to {version}. Worlds migrate one way on the next start; a snapshot is taken first. Check that its plugins support {version}. Nothing has changed yet; call again with confirm: true to do it.",
                current.version
            ),
        ));
    }
    (call.progress)(&format!("Downloading {} {version}", current.label));
    let running = is_running(call, &n)?;
    let when = if running { "next restart" } else { "next start" };
    let applied = upgrade::apply_upgrade(call.layout, &call.by, &n, Some(&version), &Value::Null, running)?;
    // an already-current answer has no from, to or snapshot: JSON leaves the first two out
    let (from, to, snapshot) = match applied {
        Applied::Done {
            from, to, snapshot, ..
        } => (Some(from), Some(json!(to)), snapshot.map(|s| basename(&s))),
        Applied::AlreadyCurrent { .. } => (None, None, None),
    };
    let mut data = obj(json!({ "name": n, "confirmed": true }));
    if let Some(f) = &from {
        data.insert("from".into(), f.clone());
    }
    if let Some(t) = &to {
        data.insert("to".into(), t.clone());
    }
    data.insert("snapshot".into(), json!(snapshot));
    data.insert("takesEffect".into(), json!(when));
    let shown = |v: &Option<Value>| {
        v.as_ref()
            .map_or_else(|| "undefined".to_string(), |v| js::string(Some(v)))
    };
    let mut text = format!(
        "{n}: {} -> {}. The worlds migrate at the {when}.",
        shown(&from),
        shown(&to)
    );
    if let Some(s) = &snapshot {
        text.push_str(&format!(
            " The way back is the snapshot {s}, restored with restore."
        ));
    }
    Ok(Out::new(Value::Object(data), text))
}
