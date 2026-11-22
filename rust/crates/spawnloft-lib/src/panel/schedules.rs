//! `handleSchedules` of `ui.mjs`: a server's scheduled tasks. Every task id is checked against
//! the server in the URL, or any name with another server's task id could change that server's
//! schedule.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::paths::Roots;
use crate::platform::preview_limits;
use crate::schedule::{self, Sched};
use crate::settings::Layout;
use crate::{activity, js, registry, supervisor};

use super::Panel;
use super::backups::{background_json, put, sched, scheduler_available};
use super::http::{Reply, Request, field};
use super::routes::Routed;

/// `/api/instances/<name>/schedules...`.
pub fn route(_panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let reply = |r: Reply| Ok(Routed::Reply(r));
    registry::lookup(Path::new(&layout.registry_file), name)?;
    if !scheduler_available() {
        return reply(if req.method == "GET" {
            Reply::ok(json!({
                "available": false,
                "reason": preview_limits::SCHEDULER,
                "tasks": [],
                "runs": [],
            }))
        } else {
            Reply::error(400, preview_limits::SCHEDULER)
        });
    }
    let id = req.seg(4).map(str::to_string);
    let verb = req.seg(5).map(str::to_string);
    let s = sched(layout);

    if req.method == "GET" {
        let tasks: Vec<Value> = mine(&s, name)?.iter().map(shape).collect();
        let actions: Vec<Value> = schedule::ACTIONS
            .iter()
            .map(|(kind, label, needs)| json!({ "type": kind, "label": label, "needsRunning": needs }))
            .collect();
        return reply(Reply::ok(json!({
            "tasks": tasks,
            "runs": s.recent_runs(name, 40)?,
            "actions": actions,
            "kinds": schedule::SCHEDULE_KINDS,
            "days": schedule::DAYS,
            "running": supervisor::is_running(layout, name)?,
            "background": background_json(),
        })));
    }
    if req.method != "POST" {
        return reply(Reply::method_not_allowed());
    }
    let body = req.json()?;

    // reserved: the Backups toggle adopts an unowned task by this name, so a task of the
    // person's own with it would be adopted and then deleted by that toggle
    if let Some(n) = field(&body, "name")?
        && js::trim(&js::string(Some(n))).to_lowercase() == "automatic backup"
    {
        return reply(Reply::error(
            400,
            "\"Automatic backup\" is the name the Backups tab uses for the schedule behind its own toggle. Pick another so the two cannot be confused.",
        ));
    }
    let given = |k: &str| field(&body, k).map(Option::<&Value>::cloned);

    let Some(id) = id else {
        let mut spec = Map::new();
        spec.insert("instance".into(), json!(name));
        for k in ["name", "action", "schedule"] {
            if let Some(v) = given(k)? {
                spec.insert(k.into(), v);
            }
        }
        spec.insert(
            "enabled".into(),
            json!(given("enabled")? != Some(Value::Bool(false))),
        );
        let mut made = s.create(&Value::Object(spec))?;
        made["windows"] = Value::Null;
        return reply(Reply::ok(shape(&made)));
    };

    let Some(owned) = mine(&s, name)?
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()))
    else {
        return reply(Reply::error(
            404,
            format!("\"{name}\" has no scheduled task \"{id}\""),
        ));
    };
    let again = |s: &Sched| -> Result<Reply, Failure> {
        let task = mine(s, name)?
            .into_iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or_else(|| Failure::type_error("Cannot read properties of undefined (reading 'id')"))?;
        Ok(Reply::ok(shape(&task)))
    };

    match verb.as_deref() {
        None => {
            let keys = ["name", "action", "schedule", "enabled"];
            let mut patch = Map::new();
            for k in keys {
                if let Some(v) = given(k)? {
                    patch.insert(k.into(), v);
                }
            }
            s.update_naming(&id, &patch, &keys)?;
            reply(again(&s)?)
        }
        Some("enable") => {
            s.set_enabled(&id, given("enabled")? != Some(Value::Bool(false)))?;
            reply(again(&s)?)
        }
        Some("run") => {
            s.run_now(&id)?;
            let detail = owned.get("name").filter(|n| js::truthy(Some(n)));
            activity::record_by(
                &Roots::new(&layout.data_root),
                &Panel::actor(),
                name,
                "schedule-run",
                detail.map(|d| js::string(Some(d))).as_deref(),
                None,
                true,
            );
            // fired, not finished: the scheduler answers once it has started the task
            reply(Reply::ok(json!({ "started": true })))
        }
        Some("delete") => {
            s.remove(&id)?;
            reply(Reply::ok(json!({ "id": id, "removed": true })))
        }
        Some(_) => reply(Reply::not_found()),
    }
}

/// This server's tasks, with what the scheduler says of each.
fn mine(s: &Sched, name: &str) -> Result<Vec<Value>, Failure> {
    Ok(s.list()?
        .into_iter()
        .filter(|t| t.get("instance").and_then(Value::as_str) == Some(name))
        .collect())
}

/// One task for the page. The OS scheduler is the authority: a task it does not know is
/// `known: false`.
fn shape(t: &Value) -> Value {
    let windows = t.get("windows").filter(|w| js::truthy(Some(w)));
    let from = |k: &str| windows.and_then(|w| w.get(k)).cloned().unwrap_or(Value::Null);
    let mut m = Map::new();
    for k in ["id", "name", "action", "schedule", "enabled"] {
        put(&mut m, k, t.get(k));
    }
    m.insert("owner".into(), t.get("owner").cloned().unwrap_or(Value::Null));
    put(&mut m, "createdAt", t.get("createdAt"));
    m.insert("known".into(), json!(windows.is_some()));
    m.insert("state".into(), from("state"));
    m.insert("lastRun".into(), from("lastRun"));
    m.insert(
        "lastResult".into(),
        json!(windows.map(|w| schedule::describe_result(w.get("lastResult")))),
    );
    m.insert("nextRun".into(), from("nextRun"));
    Value::Object(m)
}
