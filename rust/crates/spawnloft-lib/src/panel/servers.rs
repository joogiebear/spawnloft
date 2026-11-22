//! The routes about servers that start no job: the list, the overview, activity, a server's
//! status reads (join, diagnose, metrics, attached databases, console, diagnostics bundle) and
//! what is done to one (start, stop, kill, restart, rename, rebuild, delete, reveal, settings,
//! command). Each is the same branch of `route()` in `ui.mjs`, in the same words.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::paths::Roots;
use crate::registry::{self, Instance};
use crate::schedule::{self, Sched};
use crate::settings::Layout;
use crate::supervisor::{self, StartOptions};
use crate::{
    activity, backup, control, create, diag_bundle, diagnose, exposure, files, java, js, jsjson, jspath,
    manage, mclogs, metrics, notify, platform, scrubber, services, text, time, util,
};

use super::Panel;
use super::http::{Reply, Request, field, has_own};
use super::routes::Routed;
use super::shared::{safe_instance, status_row};
use super::sse;

fn done(reply: Reply) -> Result<Routed, Failure> {
    Ok(Routed::Reply(reply))
}

fn registry_file(layout: &Layout) -> &Path {
    Path::new(&layout.registry_file)
}

fn roots(layout: &Layout) -> Roots {
    Roots::new(&layout.data_root)
}

/// `body.key` where JavaScript asks whether it is truthy.
fn truthy_field<'a>(body: &'a Value, key: &str) -> Result<Option<&'a Value>, Failure> {
    Ok(field(body, key)?.filter(|v| js::truthy(Some(v))))
}

/// `POST /api/scheduler/linger`.
pub fn linger(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let _ = (panel, layout);
    schedule::keep_running_logged_out()?;
    done(Reply::ok(json!({ "linger": true })))
}

/// `GET /api/instances`: every server with its status, and the newest metrics sample of each
/// running one (read from the end of its file).
pub fn list(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let _ = panel;
    let mut rows = Vec::new();
    for inst in registry::list_instances(registry_file(layout))? {
        let name = inst.name.clone();
        let row = match supervisor::status_of_instance(layout, inst.clone(), &name) {
            Ok((row, _)) => row,
            Err(_) => {
                let mut fields = inst.fields.clone();
                fields.insert("status".into(), json!("unknown"));
                Instance {
                    name: name.clone(),
                    fields,
                }
            }
        };
        let mut shown = safe_instance(&row)?;
        let latest = if row.get("status") == Some(&json!("running")) {
            metrics::latest_sample(Path::new(&layout.metrics_file(&name)), time::now_ms() as f64)
                .map_or(Value::Null, Value::Object)
        } else {
            Value::Null
        };
        if let Value::Object(m) = &mut shown {
            m.insert("latest".into(), latest);
        }
        rows.push(shown);
    }
    done(Reply::ok(Value::Array(rows)))
}

/// `activityQuery(url, server)` and `readActivity` of it: `{ entries, more }`.
fn read_activity(layout: &Layout, req: &Request, server: Option<&str>) -> (Vec<Value>, bool) {
    // `url.searchParams.get(k) || null`
    let q = |k: &str| req.q(k).filter(|v| !v.is_empty());
    // `Math.min(500, Math.max(1, Number(q('limit')) || 100))`
    let asked = q("limit").map_or(0.0, js::string_to_number);
    let limit = if asked == 0.0 || asked.is_nan() {
        100.0
    } else {
        asked
    };
    let limit = limit.clamp(1.0, 500.0);
    activity::read_activity(
        &roots(layout),
        &activity::Query {
            server: server.or(q("server")),
            since: q("since"),
            before: q("before"),
            by: q("by"),
            // a fraction keeps as many entries as its whole part and breaks at the same one
            limit: limit.floor() as usize,
        },
    )
}

/// `GET /api/activity`.
pub fn activity(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = panel;
    let (entries, more) = read_activity(layout, req, None);
    done(Reply::ok(json!({ "entries": entries, "more": more })))
}

/// `GET /api/overview`. The schedule comes from SpawnLoft's task file, not the system's
/// scheduler, which would be a process per question; this covers every server at once.
pub fn overview(panel: &Panel, layout: &Layout) -> Result<Routed, Failure> {
    let sched = Sched::new(&layout.data_root, &layout.run_dir, Panel::actor());
    let _ = panel;
    let data = sched.load()?;
    let tasks: Vec<Value> = Sched::tasks(&data).values().cloned().collect();
    let mut servers = Map::new();
    let mut bare: Vec<String> = Vec::new();
    for inst in registry::list_instances(registry_file(layout))? {
        let name = inst.name.as_str();
        let (auto, others) = super::backups::backup_tasks_of(&tasks, name)?;
        // the switch on the Backups page if it is on, else whatever task in Schedule backs it up
        let on = |t: &Value| t.get("enabled") != Some(&json!(false));
        let by = match auto {
            Some(a) if on(a) => Some(a),
            _ => others.first().copied().or(auto),
        };
        let kept = backup::snapshot_summary(layout, name);
        let auto_backup = match by {
            None => Value::Null,
            Some(by) => {
                let mut m = Map::new();
                m.insert("enabled".into(), json!(on(by)));
                if let Some(s) = by.get("schedule") {
                    m.insert("schedule".into(), s.clone());
                }
                let keep = by.get("action").and_then(|a| a.get("keep")).cloned();
                m.insert("keep".into(), keep.unwrap_or(Value::Null));
                Value::Object(m)
            }
        };
        // a copy of the plugins taken before an install is not the server being backed up
        if kept.newest_backup_at.is_none() {
            bare.push(name.to_string());
        }
        servers.insert(
            name.to_string(),
            json!({
                "lastBackupAt": kept.newest_backup_at.map_or(Value::Null, jsjson::num),
                "backupCount": kept.count,
                "autoBackup": auto_backup,
            }),
        );
    }
    // No archive on disk is either "never backed up" or "backed up, then deleted"; the log tells
    // which, so the page does not call a server that had eighteen backups this morning "never".
    if !bare.is_empty() {
        let names: Vec<&str> = bare.iter().map(String::as_str).collect();
        for (name, trail) in activity::backup_trails(&roots(layout), &names) {
            if let Some(Value::Object(row)) = servers.get_mut(&name) {
                row.insert("backupTrail".into(), trail.to_json());
            }
        }
    }
    let mut servers = Value::Object(servers);
    jsjson::js_order(&mut servers);
    done(Reply::ok(json!({
        "machine": { "memoryMb": (platform::total_memory() as f64 / 1_048_576.0).round() },
        "automaticAvailable": true,
        "servers": servers,
    })))
}

/// `GET /api/instances/<name>/stream`: the console as an event stream, its last 200 lines
/// first.
pub fn console_stream(panel: &Panel, layout: &Layout, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    let file = layout.console_log(name);
    let line = |l: &str| sse::event(&json!(l));
    let first: Vec<String> = supervisor::tail_log(Path::new(&file), 200.0)?
        .iter()
        .map(|l| line(l))
        .collect();
    let (send, events) = std::sync::mpsc::channel::<String>();
    let wanted = Arc::new(AtomicBool::new(true));
    let follower = Arc::clone(&wanted);
    std::thread::spawn(move || {
        supervisor::follow_log_while(
            Path::new(&file),
            || follower.load(Ordering::SeqCst),
            |l| send.send(line(l)).is_ok(),
        );
    });
    done(sse::stream(first, events, move || {
        wanted.store(false, Ordering::SeqCst)
    }))
}

/// `/api/instances/<name>/join`: where this server can be joined from. Read off this computer;
/// nothing outside is asked.
pub fn join(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    if req.method != "GET" {
        return done(Reply::method_not_allowed());
    }
    let inst = registry::lookup(registry_file(layout), name)?;
    if inst.is_database() {
        return done(Reply::not_found());
    }
    done(Reply::ok(exposure::join_info(
        &inst,
        &exposure::interfaces(),
        None,
    )))
}

/// `activity`, `console`, `diag`, `metrics`, and `GET` of `diagnose` and `databases`, of one
/// server.
pub fn reads(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    let reply = match req.seg(3) {
        Some("activity") => server_activity(layout, req, name)?,
        Some("console") => console(layout, req, name)?,
        Some("diag") => diag(layout, req, name)?,
        Some("diagnose") => diagnose_route(layout, name)?,
        Some("metrics") => metrics_route(layout, req, name)?,
        // attached databases, without passwords
        Some("databases") => {
            if req.seg.len() != 4 {
                Reply::not_found()
            } else {
                Reply::ok(attachments(layout, name)?)
            }
        }
        _ => Reply::not_found(),
    };
    done(reply)
}

/// `services.serverAttachments(name)`: the databases a server is attached to, without passwords.
fn attachments(layout: &Layout, server: &str) -> Result<Value, Failure> {
    let mut out = Vec::new();
    for db in registry::list_services(Path::new(&layout.registry_file))? {
        let Some(a) = db.get("attachments").filter(|a| !a.is_null()).and_then(|a| {
            registry::entries_of(a)
                .into_iter()
                .find(|(k, _)| k == server)
                .map(|(_, v)| v)
        }) else {
            continue;
        };
        if !js::truthy(Some(&a)) {
            continue;
        }
        let or_null = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
        let engine = db.get("engine");
        let named = engine.and_then(Value::as_str).and_then(services::Engine::named);
        let mut one = Map::new();
        one.insert("service".into(), json!(db.name));
        one.insert("label".into(), or_null(db.get("label")));
        // a field that is not there is left out of the JSON, as `undefined` is
        let put = |one: &mut Map<String, Value>, key: &str, v: Option<Value>| {
            if let Some(v) = v {
                one.insert(key.into(), v);
            }
        };
        put(&mut one, "engine", engine.cloned());
        put(
            &mut one,
            "kind",
            named.map(|e| json!(e.kind())).or_else(|| engine.cloned()),
        );
        one.insert("external".into(), json!(js::truthy(db.get("external"))));
        one.insert("version".into(), or_null(db.get("version")));
        one.insert(
            "host".into(),
            match db.get("host") {
                None | Some(Value::Null) => json!("127.0.0.1"),
                Some(v) => v.clone(),
            },
        );
        put(&mut one, "port", db.get("port").cloned());
        put(&mut one, "database", a.get("database").cloned());
        put(&mut one, "user", a.get("user").cloned());
        one.insert("createdAt".into(), or_null(a.get("createdAt")));
        out.push(Value::Object(one));
    }
    Ok(Value::Array(out))
}

/// `handleActivity`: one server's history, plus undo for changes that kept a copy. An undo is
/// recorded too.
fn server_activity(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    if req.method == "GET" && req.seg(4).is_none() {
        let (entries, more) = read_activity(layout, req, Some(name));
        // a change whose copy has since been deleted or cleaned up cannot be undone: said, so
        // the page does not offer it
        let mut kept: Vec<(String, Vec<String>)> = Vec::new();
        let mut has = |server: &str, snapshot: &str| {
            if !kept.iter().any(|(s, _)| s == server) {
                let names = if registry::validate_name(server).is_ok() || plain_name(server) {
                    backup::snapshot_names(layout, server)
                } else {
                    Vec::new()
                };
                kept.push((server.to_string(), names));
            }
            kept.iter()
                .any(|(s, names)| s == server && names.iter().any(|n| n == snapshot))
        };
        let entries: Vec<Value> = entries
            .into_iter()
            .map(|mut e| {
                let gone = match (e.get("snapshot"), e.get("server")) {
                    (Some(snap), Some(server)) if js::truthy(Some(snap)) && js::truthy(Some(server)) => {
                        !has(&js::string(Some(server)), &js::string(Some(snap)))
                    }
                    _ => false,
                };
                if gone && let Value::Object(m) = &mut e {
                    m.insert("snapshotGone".into(), json!(true));
                }
                e
            })
            .collect();
        return Ok(Reply::ok(json!({
            "entries": entries,
            "more": more,
            "running": supervisor::is_running(layout, name)?,
        })));
    }
    if req.method == "POST" && req.seg(4) == Some("undo") {
        let body = req.json()?;
        let Some(snapshot) = truthy_field(&body, "snapshot")? else {
            return Ok(Reply::error(400, "which change?"));
        };
        let inst = registry::lookup(registry_file(layout), name)?;
        let running = supervisor::is_running(layout, name)?;
        let (restored, members) = files::undo_snapshot(
            layout,
            &Panel::actor(),
            &inst,
            &js::string(Some(snapshot)),
            running,
        )?;
        return Ok(Reply::ok(json!({ "restored": restored, "members": members })));
    }
    Ok(Reply::not_found())
}

/// `/^[A-Za-z0-9_-]{1,32}$/`: a name whose backups folder may be listed.
fn plain_name(server: &str) -> bool {
    (1..=32).contains(&server.len())
        && server
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `handleConsole`: the console exported to a file, or shared on mclo.gs.
fn console(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    registry::lookup(registry_file(layout), name)?;
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let source = layout.console_log(name);
    match req.seg(4) {
        Some("export") => {
            let out_dir = jspath::join(&[&layout.backups_dir, name, "exports"]);
            let exported = mclogs::export_console(name, Path::new(&source), Path::new(&out_dir))?;
            Ok(Reply::ok(exported.to_json()))
        }
        Some("share") => {
            let tokens = jspath::join(&[&layout.run_dir, "mclogs.json"]);
            Ok(Reply::ok(mclogs::share_console(
                name,
                Path::new(&source),
                Path::new(&tokens),
                &mclogs::post,
            )?))
        }
        _ => Ok(Reply::not_found()),
    }
}

/// `handleDiag`: a diagnostics bundle made in the server's exports folder, and its download.
fn diag(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    registry::lookup(registry_file(layout), name)?;
    let out_dir = jspath::join(&[&layout.backups_dir, name, "exports"]);
    let verb = req.seg(4);
    if req.method == "POST" && verb.is_none() {
        let scrub = scrubber::scrubber(layout, false);
        let bundle = diag_bundle::build_bundle(layout, Some(name), None, diag_bundle::TAIL_LINES, &scrub)?;
        let written = diag_bundle::write_bundle(&bundle, &out_dir)?;
        return Ok(Reply::ok(json!({
            "file": written.file,
            "size": written.size,
            "sizeHuman": text::human_bytes(Some(written.size as f64)),
            "findings": { "server": bundle.findings_server, "client": bundle.findings_client },
        })));
    }
    if req.method != "GET" || verb != Some("download") {
        return Ok(Reply::not_found());
    }
    let basename = || Reply::error(400, "file must be a basename");
    let Some(rel) = req.q("file").and_then(util::safe_relative_path) else {
        return Ok(basename());
    };
    if rel.contains('/') {
        return Ok(basename());
    }
    if !rel.ends_with(".zip") {
        return Ok(Reply::error(400, "file must end in .zip"));
    }
    let dir = jspath::resolve(&out_dir);
    let file = jspath::resolve(&jspath::join(&[&dir, &rel]));
    if !util::is_inside(Path::new(&dir), Path::new(&file)) {
        return Ok(Reply::error(400, "file is not inside the exports folder"));
    }
    let Ok(meta) = std::fs::metadata(Path::new(&file)) else {
        return Ok(Reply::not_found());
    };
    Ok(Reply::File {
        headers: vec![
            ("Content-Type".into(), "application/zip".into()),
            (
                "Content-Disposition".into(),
                format!("attachment; filename=\"{rel}\""),
            ),
        ],
        file: file.into(),
        len: meta.len(),
        done: None,
    })
}

/// `GET .../diagnose`: what the console's last lines say went wrong, and the newest crash
/// reports.
fn diagnose_route(layout: &Layout, name: &str) -> Result<Reply, Failure> {
    let inst = registry::lookup(registry_file(layout), name)?;
    let lines = supervisor::tail_log(Path::new(&layout.console_log(name)), 400.0)?;
    // the page gets the advice that names a place to click, not a command to run
    let ctx = diagnose::Context {
        panel: true,
        ..diagnose::Context::of(&inst)
    };
    let mut findings: Vec<Value> = diagnose::diagnose(&lines, &ctx)
        .iter()
        .map(|f| json!({ "id": f.id, "title": f.title, "advice": f.advice, "line": f.line }))
        .collect();
    let (dir, reports) = diagnose::crash_reports(&registry::dir_text(&inst)?, 5)?;
    // only while running (a stopped server has no port open); first, because the page shows two
    if supervisor::is_running(layout, name)?
        && let Some(exposed) = exposure::rcon_exposure(&inst, exposure::Seen::default())
    {
        let of = |k: &str| exposed.get(k).cloned();
        let mut first = Map::new();
        for k in ["id", "title", "advice"] {
            if let Some(v) = of(k) {
                first.insert(k.into(), v);
            }
        }
        first.insert("line".into(), Value::Null);
        findings.insert(0, Value::Object(first));
    }
    Ok(Reply::ok(json!({
        "findings": findings,
        "crashes": {
            "count": reports.len(),
            "newest": reports.first().map_or(Value::Null, diagnose::CrashReport::to_json),
            "dir": dir,
        },
    })))
}

/// `handleMetrics`: read from the file the daemon writes, since the panel may have started
/// after the server and CPU is a rate that needs two readings.
fn metrics_route(layout: &Layout, req: &Request, name: &str) -> Result<Reply, Failure> {
    registry::lookup(registry_file(layout), name)?;
    if req.method != "GET" {
        return Ok(Reply::method_not_allowed());
    }
    // `Number(null)` is 0, which asks for the default like any other non-positive figure
    let asked = req.q("seconds").map_or(0.0, js::string_to_number);
    // capped at what is kept
    let seconds = if asked.is_finite() && asked > 0.0 {
        asked.min(18000.0)
    } else {
        3600.0
    };
    let status = status_row(layout, name)?;
    let all = metrics::read_rows(Path::new(&layout.metrics_file(name)));
    let now_s = (time::now_ms() as f64 / 1000.0).floor();
    let cutoff = now_s - seconds;
    let at = |row: &Map<String, Value>| row.get("at").and_then(Value::as_f64).unwrap_or(f64::NAN);
    // history lets the page tell "never measured" from "nothing in this range"
    let newest = all.last().map(&at);
    let or_null = |k: &str| match status.get(k) {
        None => Value::Null,
        Some(v) => v.clone(),
    };
    Ok(Reply::ok(json!({
        "samples": all.iter().filter(|r| at(r) >= cutoff).cloned().map(Value::Object).collect::<Vec<_>>(),
        "history": {
            "count": all.len(),
            "oldest": all.first().map_or(Value::Null, |r| jsjson::num(at(r))),
            "newest": newest.map_or(Value::Null, jsjson::num),
            // how far back a range must reach to catch anything
            "staleSeconds": newest.map_or(Value::Null, |n| jsjson::num((now_s.floor() - n).max(0.0))),
        },
        "everySeconds": metrics::INTERVAL_SEC,
        "cores": platform::cpu_count().max(1),
        "running": supervisor::is_running(layout, name)?,
        "uptimeMs": or_null("uptimeMs"),
        "startedAt": or_null("startedAt"),
        "memory": or_null("memory"),
    })))
}

/// `started()`: `supervisor.start` waits for ready and reports whether it got there.
fn started(layout: &Layout, name: &str) -> Result<Reply, Failure> {
    let out = supervisor::start(layout, &Panel::actor(), name, StartOptions::default())?;
    let status = safe_instance(&status_row(layout, name)?)?;
    if out.failed {
        return Ok(Reply::json(
            500,
            json!({
                "error": format!(
                    "\"{name}\" started but stopped again: {}",
                    out.reason.as_deref().unwrap_or("undefined")
                ),
                "status": status,
            }),
        ));
    }
    if out.timed_out {
        return Ok(Reply::json(
            504,
            json!({
                "error": format!(
                    "\"{name}\" is taking longer than usual to come up. Watch the console - it may still finish."
                ),
                "status": status,
            }),
        ));
    }
    Ok(Reply::ok(status))
}

/// A `POST` to one server that no other family took.
pub fn act(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    let by = Panel::actor();
    let shown = |layout: &Layout| -> Result<Reply, Failure> {
        Ok(Reply::ok(safe_instance(&status_row(layout, name)?)?))
    };
    let reply = match req.seg(3).unwrap_or("") {
        "start" => started(layout, name)?,
        "stop" => {
            supervisor::stop(layout, &by, name, 90000.0)?;
            shown(layout)?
        }
        // The way out for a server whose daemon is gone: nothing can ask it to stop, so its
        // process is ended. Only then: a server that can be asked is stopped with `stop`, which
        // saves first.
        "kill" => {
            let (_, status) = supervisor::status_of(layout, name)?;
            if status != control::Status::Orphaned {
                return done(Reply::error(
                    409,
                    format!(
                        "\"{name}\" is not out of reach, so it does not need a force stop. Stop it the usual way."
                    ),
                ));
            }
            supervisor::kill(layout, &by, name)?;
            shown(layout)?
        }
        "restart" => {
            backup::refuse_while_restoring(layout, name, "restarting it")?;
            let _ = supervisor::stop(layout, &by, name, 90000.0);
            started(layout, name)?
        }
        "rename" => {
            let body = req.json()?;
            let Some(to) = truthy_field(&body, "to")? else {
                return done(Reply::error(400, "new name is required"));
            };
            let to = js::string(Some(to));
            let res = manage::rename(layout, &by, name, &to)?;
            // `{ name: newName, ...cfg, movedDir, tasksMoved }`: the record as it now stands
            let mut out = Map::new();
            out.insert("name".into(), json!(to));
            for (k, v) in &registry::lookup(registry_file(layout), &to)?.fields {
                if k != "name" {
                    out.insert(k.clone(), v.clone());
                }
            }
            out.insert("movedDir".into(), json!(res.moved_dir));
            out.insert("tasksMoved".into(), json!(res.tasks_moved));
            Reply::ok(Value::Object(out))
        }
        "rebuild" => {
            let body = req.json()?;
            let keep_plugins = field(&body, "keepPlugins")? != Some(&json!(false));
            let snapshot = field(&body, "snapshot")? != Some(&json!(false));
            let res = manage::rebuild(layout, &by, name, keep_plugins, snapshot)?;
            Reply::ok(json!({
                "name": name,
                "removed": res.removed,
                "keptPlugins": res.kept_plugins,
                "snapshot": res.snapshot,
            }))
        }
        "delete" => {
            let body = req.json()?;
            let purge = field(&body, "purge")? == Some(&json!(true));
            let res = manage::destroy(layout, &by, name, purge, true)?;
            Reply::ok(json!({
                "name": name,
                "purged": res.purged,
                "snapshot": res.snapshot,
                "tasksRemoved": res.tasks_removed,
            }))
        }
        "reveal" => {
            let body = req.json()?;
            let sub = truthy_field(&body, "sub")?.map(|v| js::string(Some(v)));
            let folder = truthy_field(&body, "folder")?.map(|v| js::string(Some(v)));
            let dir = manage::reveal(layout, name, sub.as_deref(), folder.as_deref())?;
            Reply::ok(json!({ "dir": dir }))
        }
        "settings" => match settings(layout, req, name)? {
            Some(refused) => refused,
            None => shown(layout)?,
        },
        "command" => {
            let body = req.json()?;
            let line = match field(&body, "line")? {
                None | Some(Value::Null) => None,
                v => Some(js::string(v)).filter(|l| !js::trim(l).is_empty()),
            };
            let Some(line) = line else {
                return done(Reply::error(400, "a command is required"));
            };
            supervisor::send_console(layout, &by, name, &line)?;
            Reply::ok(json!({ "sent": true }))
        }
        _ => Reply::not_found(),
    };
    done(reply)
}

/// `POST .../settings`: an allowlist, not a merge, so a page's typo cannot rewrite any field of
/// the record. `Some` is a refusal.
fn settings(layout: &Layout, req: &mut Request, name: &str) -> Result<Option<Reply>, Failure> {
    let body = req.json()?;
    let reg = registry_file(layout);
    let mut patch = Map::new();
    if let Some(v) = truthy_field(&body, "memory")? {
        // the parser the launcher uses, so what is accepted here will start
        let memory = js::trim(&js::string(Some(v))).to_string();
        registry::parse_memory_gb(&memory).map_err(Failure::user)?;
        patch.insert("memory".into(), json!(memory));
    }
    if let Some(v) = truthy_field(&body, "port")? {
        // range and collision check, the same as the CLI's `set`
        let n = js::number(Some(v));
        if !n.is_finite() {
            // a JSON value holds no NaN, and the message names it
            let shown = if n.is_nan() {
                "NaN"
            } else if n > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            };
            return Err(Failure::user(format!(
                "{shown} is not a port number - use 1 to 65535"
            )));
        }
        let port = registry::assert_port_usable(reg, name, &jsjson::num(n), "port")?;
        patch.insert("port".into(), json!(port));
    }
    if let Some(v) = truthy_field(&body, "jar")? {
        // the jar is placed before it is recorded: a server runs the jar in its own folder
        let jar = js::string(Some(v));
        let inst = registry::lookup(reg, name)?;
        create::place_jar(&layout.jars_dir, &registry::dir_text(&inst)?, &jar)?;
        patch.insert("jar".into(), json!(jar));
    }
    if let Some(v) = truthy_field(&body, "java")? {
        // probed before it is recorded, so a bad path fails here and not at the next start. Any
        // Java that runs is accepted whatever its version; an old one may be wanted on purpose.
        let bin = js::trim(&js::string(Some(v))).to_string();
        let state = java::probe(&bin);
        if !state.found {
            return Ok(Some(Reply::error(
                400,
                format!("{bin} could not be run: {}", state.message),
            )));
        }
        patch.insert("java".into(), json!(bin));
    }
    if has_own(&body, "autoRestart")? {
        patch.insert(
            "autoRestart".into(),
            json!(field(&body, "autoRestart")? == Some(&json!(true))),
        );
    }
    if has_own(&body, "jvmFlags")? {
        let flags = registry::clean_jvm_flags(field(&body, "jvmFlags")?.unwrap_or(&Value::Null))?;
        patch.insert("jvmFlags".into(), json!(flags));
    }
    // empty clears it; the page falls back to the name
    if has_own(&body, "label")? {
        let label = match field(&body, "label")? {
            None | Some(Value::Null) => None,
            v => util::clean_label(&js::string(v)),
        };
        patch.insert("label".into(), json!(label));
    }
    if has_own(&body, "webhook")? {
        let url = match field(&body, "webhook")? {
            None | Some(Value::Null) => String::new(),
            v => js::trim(&js::string(v)).to_string(),
        };
        if !url.is_empty() && !notify::acceptable_webhook(&url) {
            return Ok(Some(Reply::error(
                400,
                "the webhook must be an http(s) URL - paste the one Discord gives you.",
            )));
        }
        patch.insert(
            "webhook".into(),
            if url.is_empty() { Value::Null } else { json!(url) },
        );
    }
    registry::update_instance(reg, name, &patch)?;
    // the webhook is a credential; history records that it changed, not the value
    let said: Vec<String> = patch
        .iter()
        .map(|(k, v)| match k.as_str() {
            "webhook" if js::truthy(Some(v)) => "webhook set".to_string(),
            "webhook" => "webhook removed".to_string(),
            "jvmFlags" => match v.as_array() {
                Some(flags) => format!(
                    "Java arguments: {}",
                    flags
                        .iter()
                        .map(|f| js::string(Some(f)))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                None => "Java arguments back to the recommended ones".to_string(),
            },
            _ => super::server_props::setting_words(k, Some(v)),
        })
        .collect();
    if !said.is_empty() {
        activity::record_by(
            &roots(layout),
            &Panel::actor(),
            name,
            "settings",
            Some(&said.join(", ")),
            None,
            true,
        );
    }
    Ok(None)
}
